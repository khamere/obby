import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import * as mutes from "../../src/lib/mutes";
import useStore from "../../src/store";
import {
  ANSWER_TIMEOUT_MS,
  EDGE_OVERLAP_MS,
  forgetSearches,
  MAX_LOOKBACK_MS,
  MAX_PAGES_PER_TERM,
  MAX_REQUESTS_PER_TERM,
  SEARCH_PAGE_SIZE,
  searchTerms,
} from "../../src/store/handlers/mentionCatchUp";
import type { Channel, Server } from "../../src/types";

vi.mock("../../src/lib/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
  shouldPlayNotificationSound: () => false,
}));

const READ_AT = "2026-01-01T12:00:00.000Z";

const channel = (id: string, name: string): Channel => ({
  id,
  name,
  isPrivate: false,
  serverId: "s1",
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [],
});

function feedRaw(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), "s1");
}

const log = () => useStore.getState().mentionLog;
const messages = () => Object.values(useStore.getState().messages).flat();

describe("mention catch-up by server search", () => {
  let sent: string[];
  let canSearch: boolean;
  let hasLabels: boolean;
  let hasHistory: boolean;

  const SEARCH_LINE = /^@label=(\S+) (SEARCH .*)$/;
  // The searches sent so far, without their labels.
  const searches = () =>
    sent.flatMap((line) => SEARCH_LINE.exec(line)?.[2] ?? []);
  const labels = () =>
    sent.flatMap((line) => SEARCH_LINE.exec(line)?.[1] ?? []);
  // The server answers the search that is out, under its label.
  const feed = (...lines: string[]) => {
    for (const line of lines) {
      const isAnswer =
        /^:server BATCH \+\S+ soju\.im\/search$/.test(line) ||
        line.startsWith(":server FAIL SEARCH ");
      feedRaw(isAnswer ? `@label=${labels().at(-1)} ${line}` : line);
    }
  };
  const reconnect = () => {
    ircClient.triggerEvent("connectionStateChange", {
      serverId: "s1",
      connectionState: "disconnected",
    });
  };

  beforeEach(() => {
    // The marker in these tests is recent, well inside the lookback limit.
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(READ_AT) + 7_200_000);
    sent = [];
    canSearch = true;
    hasLabels = true;
    hasHistory = false;
    vi.spyOn(ircClient, "sendRaw").mockImplementation((_serverId, line) => {
      sent.push(line);
    });
    vi.spyOn(ircClient, "hasCapability").mockImplementation(
      (_serverId, cap) =>
        (cap === "soju.im/search" && canSearch) ||
        (cap === "labeled-response" && hasLabels) ||
        (cap === "draft/chathistory" && hasHistory),
    );
    vi.spyOn(ircClient, "getCurrentUser").mockReturnValue({
      id: "u1",
      username: "me",
    } as never);
    ircClient.nicks.set("s1", "me");
    useStore.setState((state) => ({
      servers: [
        {
          id: "s1",
          name: "Test",
          host: "irc.example",
          port: 6697,
          isConnected: true,
          users: [],
          channels: [
            channel("c1", "#one"),
            channel("c2", "#two"),
            channel("c3", "#three"),
          ],
          privateChats: [],
          capabilities: ["soju.im/search", "draft/read-marker"],
        } as Server,
      ],
      messages: {},
      mentionLog: [],
      activeBatches: {},
      processedMessageIds: new Set(),
      globalSettings: {
        ...state.globalSettings,
        customMentions: [],
        ignoreList: [],
      },
      ui: {
        ...state.ui,
        selectedServerId: "s1",
        perServerSelections: {
          s1: { selectedChannelId: "c1", selectedPrivateChatId: null },
        },
      },
    }));
    forgetSearches();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    ircClient.nicks.delete("s1");
  });

  const at = (second: number) =>
    new Date(Date.parse(READ_AT) + second * 1000).toISOString();
  const overlap = EDGE_OVERLAP_MS / 1000;
  const search = (bounds: string) =>
    `SEARCH in=#two;${bounds}text=me;limit=${SEARCH_PAGE_SIZE}`;
  const answer = (id: string, ...lines: string[]) => [
    `:server BATCH +${id} soju.im/search`,
    ...lines.map((line) => `@batch=${id};${line}`),
    `:server BATCH -${id}`,
  ];
  const emptyAnswer = (id: string) => answer(id);
  const hit = (msgid: string, second: number, text = "me: ping") =>
    `msgid=${msgid};time=${at(second)} :bob!u@h PRIVMSG #two :${text}`;
  const fullPage = (id: string, firstSecond: number, text = "me") =>
    answer(
      id,
      ...Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) =>
        hit(`${id}${i}`, firstSecond + i, `${text} ${i}`),
      ),
    );
  // A line the client holds for #two, as its history would have loaded it.
  const hold = (second: number) =>
    useStore.setState((state) => ({
      messages: {
        ...state.messages,
        "s1-c2": [
          ...(state.messages["s1-c2"] ?? []),
          {
            id: `held-${second}`,
            msgid: `held-${second}`,
            type: "message",
            content: "a line",
            timestamp: new Date(at(second)),
            userId: "bob",
            channelId: "c2",
            serverId: "s1",
            reactions: [],
            replyMessage: null,
            mentioned: [],
            tags: { time: at(second) },
          } as never,
        ],
      },
    }));
  const historyLoaded = () =>
    ircClient.triggerEvent("CHATHISTORY_LOADING", {
      serverId: "s1",
      channelName: "#two",
      isLoading: false,
    });

  it("asks for the lines after the read marker that name the user", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()).toEqual([search(`after=${READ_AT};`)]);
  });

  it("files the answers in the mention log and keeps them out of the chat", () => {
    feed(
      `:server MARKREAD #two timestamp=${READ_AT}`,
      ...answer(
        "s",
        hit("a", 300, "hey me, look"),
        hit("b", 360, "some of them agree"),
        `msgid=c;time=${at(420)} :me!u@h PRIVMSG #two :me talking about me`,
        hit("d", -3600, "me, long ago"),
        `msgid=e;time=${at(480)} :bob!u@h NOTICE #two :me in a notice`,
      ),
    );
    expect(log()).toEqual([
      {
        messageId: "a",
        msgid: "a",
        serverId: "s1",
        channelId: "c2",
        channelName: "#two",
        sender: "bob",
        content: "hey me, look",
        timestamp: at(300),
        seen: false,
      },
    ]);
    expect(messages()).toEqual([]);
    expect(useStore.getState().servers[0].channels[1].unreadCount).toBe(0);
  });

  it("asks once per connection", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...emptyAnswer("s"));
    feed(`:server MARKREAD #two timestamp=${at(3600)}`);
    expect(searches()).toHaveLength(1);
  });

  describe("on a later connection", () => {
    beforeEach(() => {
      hasHistory = true;
      hold(100);
      feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...emptyAnswer("s"));
      reconnect();
      sent = [];
    });

    it("waits for the channel's history and skips a channel with nothing new", () => {
      feed(`:server MARKREAD #two timestamp=${READ_AT}`);
      expect(searches()).toEqual([]);
      historyLoaded();
      expect(searches()).toEqual([]);
    });

    it("searches from the last line the earlier search saw when history brings newer ones", () => {
      feed(`:server MARKREAD #two timestamp=${READ_AT}`);
      hold(500);
      historyLoaded();
      // The bound is a line's own server time, whatever our clock says.
      expect(searches()).toEqual([search(`after=${at(100 - overlap)};`)]);
      historyLoaded();
      expect(searches()).toHaveLength(1);
    });

    it("starts at the read marker when the user has read past the earlier search", () => {
      feed(`:server MARKREAD #two timestamp=${at(300)}`);
      hold(500);
      historyLoaded();
      expect(searches()).toEqual([search(`after=${at(300)};`)]);
    });

    it("searches at once on a server without history", () => {
      hasHistory = false;
      feed(`:server MARKREAD #two timestamp=${READ_AT}`);
      expect(searches()).toEqual([search(`after=${at(100 - overlap)};`)]);
    });

    it("acts on a marker that comes after the channel's history", () => {
      hold(500);
      historyLoaded();
      expect(searches()).toEqual([]);
      feed(`:server MARKREAD #two timestamp=${READ_AT}`);
      expect(searches()).toEqual([search(`after=${at(100 - overlap)};`)]);
    });

    it("counts a history reply that came before the marker, lines the chat leaves out included", () => {
      feed(
        ":server BATCH +h chathistory #two",
        `@batch=h;msgid=n1;time=${at(700)} :announcer!u@h NOTICE #two :a notice, not a chat line`,
        ":server BATCH -h",
      );
      historyLoaded();
      feed(`:server MARKREAD #two timestamp=${READ_AT}`);
      expect(searches()).toEqual([search(`after=${at(100 - overlap)};`)]);
    });

    it("looks again when a later history page brings the new lines", () => {
      feed(`:server MARKREAD #two timestamp=${READ_AT}`);
      // A page of older lines ends first and says nothing new.
      historyLoaded();
      expect(searches()).toEqual([]);
      hold(500);
      historyLoaded();
      expect(searches()).toHaveLength(1);
    });

    it("counts history lines the chat leaves out as new activity", () => {
      feed(
        `:server MARKREAD #two timestamp=${READ_AT}`,
        ":server BATCH +h chathistory #two",
        `@batch=h;msgid=n1;time=${at(700)} :announcer!u@h NOTICE #two :a notice, not a chat line`,
        ":server BATCH -h",
      );
      historyLoaded();
      expect(searches()).toEqual([search(`after=${at(100 - overlap)};`)]);
    });
  });

  it("searches in full again when the earlier search had no loaded line to go by", () => {
    hasHistory = true;
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...emptyAnswer("s"));
    reconnect();
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()).toEqual([
      search(`after=${READ_AT};`),
      search(`after=${READ_AT};`),
    ]);
  });

  it("searches a refused channel in full on the next connection", () => {
    hasHistory = true;
    hold(100);
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    feed(":server FAIL SEARCH INTERNAL_ERROR :The search could not be run");
    reconnect();
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()[1]).toBe(search(`after=${READ_AT};`));
  });

  it("asks one question at a time, one per highlight word", () => {
    useStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        customMentions: ["release day", "ME"],
      },
    }));
    feed(
      `:server MARKREAD #one timestamp=${READ_AT}`,
      `:server MARKREAD #two timestamp=${READ_AT}`,
    );
    expect(searches()).toEqual([
      `SEARCH in=#one;after=${READ_AT};text=me;limit=${SEARCH_PAGE_SIZE}`,
    ]);
    feed(...emptyAnswer("1"));
    expect(searches()[1]).toBe(
      `SEARCH in=#one;after=${READ_AT};text=release\\sday;limit=${SEARCH_PAGE_SIZE}`,
    );
    feed(...emptyAnswer("2"), ...emptyAnswer("3"));
    expect(searches().map((line) => line.split(";")[0])).toEqual([
      "SEARCH in=#one",
      "SEARCH in=#one",
      "SEARCH in=#two",
      "SEARCH in=#two",
    ]);
  });

  it("asks on both sides of a page, whichever end the server cut", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    // A server that answers with the newest matches leaves the older ones.
    feed(...fullPage("p", 1000));
    expect(log()).toHaveLength(SEARCH_PAGE_SIZE);
    expect(searches()[1]).toBe(
      search(`after=${READ_AT};before=${at(1000 + overlap)};`),
    );
    feed(...answer("q", hit("older", 10, "me, much earlier")));
    expect(log()[0].msgid).toBe("older");
    // A short page may still have neighbours, so both its sides are asked.
    expect(searches()[2]).toBe(
      search(`after=${READ_AT};before=${at(10 + overlap)};`),
    );
    feed(...emptyAnswer("r1"));
    expect(searches()[3]).toBe(
      search(`after=${at(10 - overlap)};before=${at(1000 + overlap)};`),
    );
    feed(...emptyAnswer("r2"));
    expect(searches()[4]).toBe(
      search(`after=${at(1000 + SEARCH_PAGE_SIZE - 1 - overlap)};`),
    );
    feed(...emptyAnswer("r3"));
    expect(searches()).toHaveLength(5);
    expect(log()).toHaveLength(SEARCH_PAGE_SIZE + 1);
  });

  it("overlaps the edge of a page, so a second line at that instant is found", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    // Some servers keep time to the second, so the overlap is at least that.
    expect(EDGE_OVERLAP_MS).toBeGreaterThanOrEqual(1000);
    feed(...answer("s", hit("a", 50, "me: first")));
    feed(...emptyAnswer("e"));
    expect(searches()[2]).toBe(search(`after=${at(50 - overlap)};`));
    // The server sends the edge line again along with its neighbour.
    feed(...answer("t", hit("a", 50, "me: first"), hit("b", 50, "me: second")));
    expect(log().map((m) => m.msgid)).toEqual(["a", "b"]);
    // Nothing lies past the edge, so that side is done.
    expect(searches()).toHaveLength(3);
  });

  it("pages past a notice without filing it", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    feed(
      ...answer(
        "s",
        `msgid=n;time=${at(40)} :bob!u@h NOTICE #two :me in a notice`,
      ),
    );
    expect(log()).toEqual([]);
    expect(messages()).toEqual([]);
    expect(searches()[1]).toBe(
      search(`after=${READ_AT};before=${at(40 + overlap)};`),
    );
  });

  it("stops after a few pages of mentions and asks once for the newest", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    // Each answer is the page before the last one, as the request asked.
    for (let page = 0; page < MAX_PAGES_PER_TERM; page++) {
      const first = 5000 - page * 200;
      expect(searches().at(-1)).toBe(
        page === 0
          ? search(`after=${READ_AT};`)
          : search(`after=${READ_AT};before=${at(first + 200 + overlap)};`),
      );
      feed(...fullPage(`n${page}`, first));
    }
    expect(log()).toHaveLength(200);
    // The pages are used up: one request for the newest matches, and no
    // fourth page on either side.
    expect(searches()).toHaveLength(MAX_PAGES_PER_TERM + 1);
    expect(searches().at(-1)).toBe(search(""));
    feed(...answer("z", hit("newest", 6000)));
    expect(log().at(-1)?.msgid).toBe("newest");
    expect(searches()).toHaveLength(MAX_PAGES_PER_TERM + 1);
  });

  it("steps past an instant that holds more lines than a page", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    const sameInstant = (id: string) =>
      answer(
        id,
        ...Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) =>
          hit(`i${i}`, 5, `some of them ${i}`),
        ),
      );
    feed(...sameInstant("s"));
    expect(searches()[1]).toBe(
      search(`after=${READ_AT};before=${at(5 + overlap)};`),
    );
    // The same full page again: the overlap did not get past the instant,
    // so the bound goes exactly on it, once.
    feed(...sameInstant("t"));
    expect(searches()[2]).toBe(search(`after=${READ_AT};before=${at(5)};`));
    feed(...emptyAnswer("e"));
    expect(searches()[3]).toBe(search(`after=${at(5 - overlap)};`));
    feed(...sameInstant("u"));
    expect(searches()[4]).toBe(search(`after=${at(5)};`));
    feed(...answer("v", hit("beyond", 9)));
    expect(log().map((m) => m.msgid)).toEqual(["beyond"]);
  });

  it("steps past each of two full instants in a row", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    const instant = (id: string, second: number) =>
      answer(
        id,
        ...Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) =>
          hit(`${second}-${i}`, second, `some of them ${i}`),
        ),
      );
    // An oldest-first server: the page, its 'before' side, then onward.
    feed(...instant("a1", 5), ...emptyAnswer("b1"));
    feed(...instant("a2", 5));
    expect(searches().at(-1)).toBe(search(`after=${at(5)};`));
    feed(...instant("a3", 7), ...emptyAnswer("b2"));
    feed(...instant("a4", 7));
    expect(searches().at(-1)).toBe(search(`after=${at(7)};`));
    feed(...answer("a5", hit("beyond", 9)));
    expect(log().map((m) => m.msgid)).toEqual(["beyond"]);
  });

  it("ends a side that brings nothing past its edge", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    feed(...answer("s", hit("a", 50)));
    // Each side answers with the edge line alone.
    feed(...answer("t", hit("a", 50)));
    feed(...answer("u", hit("a", 50)));
    expect(searches()).toHaveLength(3);
  });

  it("keeps paging past pages the server matched more loosely than we do", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    // An oldest-first server: four full pages of lines that only hold the nick inside a word.
    for (let page = 0; page < 4; page++) {
      feed(...fullPage(`l${page}`, 100 + page * 100, "some of them"));
      feed(...emptyAnswer(`b${page}`));
    }
    expect(log()).toEqual([]);
    feed(...answer("real", hit("real", 600)));
    expect(log().map((m) => m.msgid)).toEqual(["real"]);
  });

  it("stops a word that keeps matching loosely and asks once for the newest", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    for (let page = 0; page < 30; page++)
      feed(
        ...answer(`l${page}`, hit(`l${page}`, 100 + page * 10, "some of them")),
      );
    expect(searches()).toHaveLength(MAX_REQUESTS_PER_TERM + 1);
    expect(searches().at(-1)).toBe(search(""));
  });

  it("does not start further back than the lookback limit", () => {
    const old = new Date(Date.now() - 2 * MAX_LOOKBACK_MS).toISOString();
    feed(`:server MARKREAD #two timestamp=${old}`);
    const horizon = new Date(Date.now() - MAX_LOOKBACK_MS).toISOString();
    expect(searches()).toEqual([search(`after=${horizon};`)]);
  });

  it("skips a line without the server's time or with a broken one, and keeps the queue going", () => {
    feed(
      `:server MARKREAD #one timestamp=${READ_AT}`,
      `:server MARKREAD #two timestamp=${READ_AT}`,
      ":server BATCH +s soju.im/search",
      "@batch=s;msgid=a :bob!u@h PRIVMSG #one :me: no time at all",
      "@batch=s;msgid=b;time=not-a-time :bob!u@h PRIVMSG #one :me: broken time",
      ":server BATCH -s",
    );
    expect(log()).toEqual([]);
    expect(searches().at(-1)).toContain("in=#two;");
  });

  it("gives two lines without msgid at one instant their own ids", () => {
    feed(
      `:server MARKREAD #two timestamp=${READ_AT}`,
      ...answer(
        "s",
        `time=${at(5)} :bob!u@h PRIVMSG #two :me: one`,
        `time=${at(5)} :bob!u@h PRIVMSG #two :me: two`,
      ),
    );
    expect(new Set(log().map((m) => m.messageId)).size).toBe(2);
  });

  it("takes a refusal of a word the server cannot search for as an answer", () => {
    hasHistory = true;
    hold(100);
    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, customMentions: ["[]"] },
    }));
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...emptyAnswer("s"));
    expect(searches()[1]).toBe(
      `SEARCH in=#two;after=${READ_AT};text=[];limit=${SEARCH_PAGE_SIZE}`,
    );
    feed(":server FAIL SEARCH INTERNAL_ERROR :The search could not be run");
    reconnect();
    // The channel counts as searched, so the next connection waits for its history.
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()).toHaveLength(2);
  });

  it("covers the inbox with the newest matches once a word has used up its pages", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    // An oldest-first server: three full pages of mentions from the old end.
    for (let page = 0; page < MAX_PAGES_PER_TERM; page++) {
      feed(...fullPage(`o${page}`, 100 + page * 100));
      if (page < MAX_PAGES_PER_TERM - 1) feed(...emptyAnswer(`b${page}`));
    }
    expect(searches().at(-1)).toBe(search(""));
    feed(...fullPage("w", 9000));
    expect(searches().at(-1)).toBe(search(`before=${at(9000 + overlap)};`));
    const asked = searches().length;
    feed(...fullPage("x", 8900));
    expect(searches()).toHaveLength(asked);
    expect(log().at(-1)?.msgid).toBe("w99");
    expect(log()[0].msgid).toBe("x0");
  });

  it("records a channel as searched when a spent word leaves a page unasked", () => {
    hasHistory = true;
    hold(100);
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    for (let page = 0; page < MAX_PAGES_PER_TERM; page++)
      feed(...fullPage(`n${page}`, 5000 - page * 200));
    feed(...emptyAnswer("sweep"));
    reconnect();
    sent = [];
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()).toEqual([]);
  });

  it("moves on when the server refuses", () => {
    feed(
      `:server MARKREAD #one timestamp=${READ_AT}`,
      `:server MARKREAD #two timestamp=${READ_AT}`,
    );
    expect(searches()).toHaveLength(1);
    feed(":server FAIL SEARCH INTERNAL_ERROR :The search could not be run");
    expect(searches()).toHaveLength(2);
  });

  it("stops asking when the server withdraws labels while questions wait", () => {
    feed(
      `:server MARKREAD #one timestamp=${READ_AT}`,
      `:server MARKREAD #two timestamp=${READ_AT}`,
    );
    expect(searches()).toHaveLength(1);
    hasLabels = false;
    feed(...emptyAnswer("s"));
    expect(searches()).toHaveLength(1);
    expect(sent.filter((line) => line.includes("SEARCH "))).toHaveLength(1);
  });

  it("stays quiet on a server that returns no labels", () => {
    hasLabels = false;
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(sent.filter((line) => line.includes("SEARCH "))).toEqual([]);
  });

  it("stays quiet without the capability, a marker or a channel", () => {
    feed(
      ":server MARKREAD #two *",
      `:server MARKREAD bob timestamp=${READ_AT}`,
    );
    canSearch = false;
    feed(`:server MARKREAD #one timestamp=${READ_AT}`);
    expect(searches()).toEqual([]);
  });

  it("skips a channel whose first marker says it was never read", () => {
    feed(":server MARKREAD #two *");
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()).toEqual([]);
  });

  it("matches channel names whatever their case", () => {
    feed(
      `:server MARKREAD #TWO timestamp=${READ_AT}`,
      ...answer("s", `msgid=a;time=${at(5)} :bob!u@h PRIVMSG #Two :me: ping`),
    );
    expect(log().map((m) => [m.channelId, m.channelName])).toEqual([
      ["c2", "#two"],
    ]);
  });

  it("files a mention as seen when the user has read past it meanwhile", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    // The marker moves on while the question is out.
    feed(`:server MARKREAD #two timestamp=${at(60)}`);
    feed(
      ...answer(
        "s",
        hit("a", 30, "me, read already"),
        hit("b", 90, "me, still unread"),
      ),
    );
    expect(log().map((m) => [m.msgid, m.seen])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("files a mention from a muted channel as seen", () => {
    vi.spyOn(mutes, "isSilenced").mockReturnValue(true);
    feed(
      `:server MARKREAD #two timestamp=${READ_AT}`,
      ...answer("s", hit("a", 5)),
    );
    expect(log().map((m) => m.seen)).toEqual([true]);
  });

  it("leaves out our own words relayed by a bridge", async () => {
    const bridgeRules = await import("../../src/lib/bridgeRules");
    vi.spyOn(bridgeRules, "applyBridgeRules").mockImplementation(
      (_rules, _host, _channel, sender, text) =>
        sender === "relay"
          ? ({
              kind: "bot",
              nick: text.split("> ")[0],
              text: text.split("> ")[1],
            } as never)
          : null,
    );
    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, bridgedUsers: true },
    }));
    feed(
      `:server MARKREAD #two timestamp=${READ_AT}`,
      ...answer(
        "s",
        `msgid=a;time=${at(5)} :relay!u@h PRIVMSG #two :Me> me: note to self`,
        `msgid=b;time=${at(6)} :relay!u@h PRIVMSG #two :carol> me: ping from the site`,
      ),
    );
    expect(log().map((m) => [m.sender, m.content])).toEqual([
      ["carol", "me: ping from the site"],
    ]);
  });

  it("leaves out ignored senders and keeps a line without msgid once", () => {
    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, ignoreList: ["troll!*@*"] },
    }));
    const lines = answer(
      "s",
      `time=${at(5)} :troll!u@h PRIVMSG #two :me me me`,
      `time=${at(6)} :bob!u@h PRIVMSG #two :me: ping`,
    );
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...lines);
    reconnect();
    forgetSearches();
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...lines);
    expect(log().map((m) => [m.sender, m.content])).toEqual([
      ["bob", "me: ping"],
    ]);
  });

  it("keeps a line without msgid once whatever the case of its sender", () => {
    const entry = {
      messageId: "x",
      serverId: "s1",
      channelId: "c2",
      channelName: "#two",
      sender: "Bob",
      content: "me: ping",
      timestamp: at(5),
      seen: false,
    };
    useStore.getState().recordMention(entry);
    useStore.getState().recordMention({ ...entry, sender: "bob" });
    useStore.getState().recordMention({ ...entry, content: "Me: ping" });
    expect(log().map((m) => [m.sender, m.content])).toEqual([
      ["Bob", "me: ping"],
      ["Bob", "Me: ping"],
    ]);
  });

  it("keeps the log in the order the lines were said", () => {
    useStore.getState().recordMention({
      messageId: "live",
      msgid: "live",
      serverId: "s1",
      channelId: "c2",
      channelName: "#two",
      sender: "bob",
      content: "me, just now",
      timestamp: at(1800),
      seen: false,
    });
    feed(
      `:server MARKREAD #two timestamp=${READ_AT}`,
      ...answer("s", hit("a", 300, "me, earlier")),
    );
    expect(log().map((m) => m.msgid)).toEqual(["a", "live"]);
  });

  describe("answers and their labels", () => {
    it("leaves an answer without our label to the chat and keeps the question open", () => {
      feed(
        `:server MARKREAD #one timestamp=${READ_AT}`,
        `:server MARKREAD #two timestamp=${READ_AT}`,
      );
      expect(searches()).toHaveLength(1);
      // A search typed by hand answers without our label: its lines reach the
      // chat as they always did.
      feedRaw(
        ":server BATCH +m soju.im/search",
        `@batch=m;msgid=x;time=${at(5)} :bob!u@h PRIVMSG #one :from a manual search`,
        ":server BATCH -m",
      );
      expect(messages().map((m) => m.msgid)).toEqual(["x"]);
      expect(searches()).toHaveLength(1);
      feedRaw(
        `@label=${labels()[0]} :server BATCH +o labeled-response`,
        "@batch=o :server BATCH +s soju.im/search",
        `@batch=s;msgid=a;time=${at(6)} :bob!u@h PRIVMSG #one :me: ours`,
        ":server BATCH -s",
        ":server BATCH -o",
      );
      expect(log().map((m) => m.msgid)).toEqual(["a"]);
      expect(messages().map((m) => m.msgid)).toEqual(["x"]);
    });

    it("leaves a hand-typed search alone when it answers before our own", () => {
      // The user's search went out first, and ours follows before its answer.
      feed(`:server MARKREAD #one timestamp=${READ_AT}`);
      feedRaw(
        ":server BATCH +m soju.im/search",
        `@batch=m;msgid=x;time=${at(5)} :bob!u@h PRIVMSG #one :from a manual search`,
        ":server BATCH -m",
      );
      expect(messages().map((m) => m.msgid)).toEqual(["x"]);
      feed(
        ...answer("s", `msgid=a;time=${at(6)} :bob!u@h PRIVMSG #one :me: ours`),
      );
      expect(log().map((m) => m.msgid)).toEqual(["a"]);
    });

    it("reads a label set on the search batch itself and takes only our refusals", () => {
      feed(
        `:server MARKREAD #one timestamp=${READ_AT}`,
        `:server MARKREAD #two timestamp=${READ_AT}`,
      );
      const asked = searches().length;
      feedRaw(":server FAIL SEARCH INTERNAL_ERROR :not ours");
      expect(searches()).toHaveLength(asked);
      feed(":server FAIL SEARCH INTERNAL_ERROR :ours");
      expect(searches()).toHaveLength(asked + 1);
    });

    it("goes on after one overdue answer and stops after two in a row", () => {
      feed(
        `:server MARKREAD #one timestamp=${READ_AT}`,
        `:server MARKREAD #two timestamp=${READ_AT}`,
        `:server MARKREAD #three timestamp=${READ_AT}`,
      );
      const first = labels()[0];
      vi.advanceTimersByTime(ANSWER_TIMEOUT_MS + 1000);
      expect(searches()).toHaveLength(2);
      // The late answer to the first question is told apart by its label,
      // and stays out of the chat too.
      feedRaw(
        `@label=${first} :server BATCH +s soju.im/search`,
        `@batch=s;msgid=late;time=${at(6)} :bob!u@h PRIVMSG #two :me: late`,
        ":server BATCH -s",
      );
      expect(log()).toEqual([]);
      expect(messages()).toEqual([]);
      expect(searches()).toHaveLength(2);
      vi.advanceTimersByTime(ANSWER_TIMEOUT_MS + 1000);
      expect(searches()).toHaveLength(2);
      reconnect();
      feed(`:server MARKREAD #two timestamp=${READ_AT}`);
      expect(searches()).toHaveLength(3);
    });
  });

  it("builds the search terms from the nick and the highlight words a server can look for", () => {
    expect(searchTerms("Me", [" me ", "", "word", "[]"])).toEqual([
      "Me",
      "word",
      "[]",
    ]);
  });
});
