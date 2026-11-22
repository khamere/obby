import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import * as mutes from "../../src/lib/mutes";
import useStore from "../../src/store";
import {
  ANSWER_TIMEOUT_MS,
  forgetSearches,
  MAX_LOOKBACK_MS,
  MAX_PAGES_PER_TERM,
  MAX_REQUESTS_PER_TERM,
  SEARCH_AGAIN_AFTER_MS,
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

function feed(...lines: string[]) {
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

  const searches = () => sent.filter((line) => line.startsWith("SEARCH "));
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
    hasLabels = false;
    vi.spyOn(ircClient, "sendRaw").mockImplementation((_serverId, line) => {
      sent.push(line);
    });
    vi.spyOn(ircClient, "hasCapability").mockImplementation(
      (_serverId, cap) =>
        (cap === "soju.im/search" && canSearch) ||
        (cap === "labeled-response" && hasLabels),
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
          channels: [channel("c1", "#one"), channel("c2", "#two")],
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

  it("asks for the lines after the read marker that name the user", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()).toEqual([
      `SEARCH in=#two;after=${READ_AT};text=me;limit=${SEARCH_PAGE_SIZE}`,
    ]);
  });

  it("files the answers in the mention log and keeps them out of the chat", () => {
    feed(
      `:server MARKREAD #two timestamp=${READ_AT}`,
      ":server BATCH +s soju.im/search",
      "@batch=s;msgid=a;time=2026-01-01T12:05:00.000Z :bob!u@h PRIVMSG #two :hey me, look",
      "@batch=s;msgid=b;time=2026-01-01T12:06:00.000Z :bob!u@h PRIVMSG #two :some of them agree",
      "@batch=s;msgid=c;time=2026-01-01T12:07:00.000Z :me!u@h PRIVMSG #two :me talking about me",
      "@batch=s;msgid=d;time=2026-01-01T11:00:00.000Z :bob!u@h PRIVMSG #two :me, long ago",
      "@batch=s;msgid=e;time=2026-01-01T12:08:00.000Z :bob!u@h NOTICE #two :me in a notice",
      ":server BATCH -s",
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
        timestamp: "2026-01-01T12:05:00.000Z",
        seen: false,
      },
    ]);
    expect(messages()).toEqual([]);
    expect(useStore.getState().servers[0].channels[1].unreadCount).toBe(0);
  });

  const fullPage = (id: string, firstSecond: number) => [
    `:server BATCH +${id} soju.im/search`,
    ...Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => {
      const time = at(firstSecond + i);
      return `@batch=${id};msgid=${id}${i};time=${time} :bob!u@h PRIVMSG #two :me ${i}`;
    }),
    `:server BATCH -${id}`,
  ];
  const at = (second: number) =>
    new Date(Date.parse(READ_AT) + second * 1000).toISOString();
  const emptyAnswer = (id: string) => [
    `:server BATCH +${id} soju.im/search`,
    `:server BATCH -${id}`,
  ];

  it("asks once per connection", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...emptyAnswer("s"));
    feed(`:server MARKREAD #two timestamp=${at(3600)}`);
    expect(searches()).toHaveLength(1);
  });

  it("leaves a quick reconnect to the history catch-up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(at(7200)));
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...emptyAnswer("s"));
    vi.setSystemTime(Date.now() + SEARCH_AGAIN_AFTER_MS - 1000);
    reconnect();
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()).toHaveLength(1);
  });

  it("searches again after a long absence, from the read marker", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(at(7200)));
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...emptyAnswer("s"));
    vi.setSystemTime(Date.now() + SEARCH_AGAIN_AFTER_MS);
    reconnect();
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    // The bound is the server's own time, whatever our clock says.
    expect(searches()[1]).toBe(
      `SEARCH in=#two;after=${READ_AT};text=me;limit=${SEARCH_PAGE_SIZE}`,
    );
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
      `SEARCH in=#two;after=${READ_AT};before=${at(1000)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    );
    feed(
      ":server BATCH +q soju.im/search",
      `@batch=q;msgid=older;time=${at(10)} :bob!u@h PRIVMSG #two :me, much earlier`,
      ":server BATCH -q",
    );
    expect(log()[0].msgid).toBe("older");
    // A short page may still have neighbours, so both its sides are asked.
    expect(searches().slice(2)).toEqual([
      `SEARCH in=#two;after=${READ_AT};before=${at(10)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    ]);
    feed(...emptyAnswer("r1"));
    expect(searches()[3]).toBe(
      `SEARCH in=#two;after=${at(10)};before=${at(1000)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    );
    feed(...emptyAnswer("r2"));
    expect(searches()[4]).toBe(
      `SEARCH in=#two;after=${at(1000 + SEARCH_PAGE_SIZE - 1)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    );
    feed(...emptyAnswer("r3"));
    expect(searches()).toHaveLength(5);
    expect(log()).toHaveLength(SEARCH_PAGE_SIZE + 1);
  });

  it("keeps asking after a page shorter than the limit", () => {
    feed(
      `:server MARKREAD #two timestamp=${READ_AT}`,
      ":server BATCH +s soju.im/search",
      `@batch=s;msgid=a;time=${at(50)} :bob!u@h PRIVMSG #two :me: first half`,
      ":server BATCH -s",
    );
    expect(searches().slice(1)).toEqual([
      `SEARCH in=#two;after=${READ_AT};before=${at(50)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    ]);
    feed(...emptyAnswer("e1"));
    expect(searches()[2]).toBe(
      `SEARCH in=#two;after=${at(50)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    );
    feed(
      ":server BATCH +t soju.im/search",
      `@batch=t;msgid=b;time=${at(80)} :bob!u@h PRIVMSG #two :me: second half`,
      ":server BATCH -t",
    );
    expect(log().map((m) => m.msgid)).toEqual(["a", "b"]);
  });

  it("pages past a notice without filing it", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    feed(
      ":server BATCH +s soju.im/search",
      `@batch=s;msgid=n;time=${at(40)} :bob!u@h NOTICE #two :me in a notice`,
      ":server BATCH -s",
    );
    expect(log()).toEqual([]);
    expect(messages()).toEqual([]);
    expect(searches()[1]).toBe(
      `SEARCH in=#two;after=${READ_AT};before=${at(40)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    );
  });

  it("stops after a few full pages", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    // Each answer is the newest page of what is left, older every time.
    for (let page = 0; page < MAX_PAGES_PER_TERM + 2; page++) {
      feed(...fullPage(`n${page}`, 5000 - page * 200));
      // The side after the page has nothing left.
      feed(...emptyAnswer(`e${page}`));
    }
    const older = searches().filter((line) => line.includes("before="));
    expect(older.length).toBeLessThanOrEqual(MAX_PAGES_PER_TERM * 2);
    expect(log().length).toBeLessThanOrEqual(
      MAX_PAGES_PER_TERM * SEARCH_PAGE_SIZE,
    );
    const asked = searches().length;
    feed(...emptyAnswer("z"));
    expect(searches()).toHaveLength(asked);
  });

  it("ends a side whose page does not move", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    const sameInstant = (id: string) => [
      `:server BATCH +${id} soju.im/search`,
      ...Array.from(
        { length: SEARCH_PAGE_SIZE },
        (_, i) =>
          `@batch=${id};msgid=${id}${i};time=${at(5)} :bob!u@h PRIVMSG #two :me ${i}`,
      ),
      `:server BATCH -${id}`,
    ];
    feed(...sameInstant("s"));
    expect(searches().slice(1)).toEqual([
      `SEARCH in=#two;after=${READ_AT};before=${at(5)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    ]);
    feed(...emptyAnswer("a"));
    expect(searches()[2]).toBe(
      `SEARCH in=#two;after=${at(5)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    );
    // The same page again as the answer to the pending question: nothing moved.
    feed(...sameInstant("t"));
    expect(searches()).toHaveLength(3);
  });

  it("keeps paging past pages the server matched more loosely than we do", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    const loose = (id: string, firstSecond: number) => [
      `:server BATCH +${id} soju.im/search`,
      ...Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => {
        const time = at(firstSecond + i);
        return `@batch=${id};msgid=${id}${i};time=${time} :bob!u@h PRIVMSG #two :some of them ${i}`;
      }),
      `:server BATCH -${id}`,
    ];
    // An oldest-first server: four full pages of lines that only hold the nick inside a word.
    for (let page = 0; page < 4; page++) {
      feed(...loose(`l${page}`, 100 + page * 100));
      feed(...emptyAnswer(`b${page}`));
    }
    expect(log()).toEqual([]);
    feed(
      ":server BATCH +real soju.im/search",
      `@batch=real;msgid=real;time=${at(600)} :bob!u@h PRIVMSG #two :me: ping`,
      ":server BATCH -real",
    );
    expect(log().map((m) => m.msgid)).toEqual(["real"]);
  });

  it("stops a word that keeps matching loosely", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    for (let page = 0; page < 30; page++)
      feed(
        `:server BATCH +l${page} soju.im/search`,
        `@batch=l${page};msgid=l${page};time=${at(100 + page)} :bob!u@h PRIVMSG #two :some of them`,
        `:server BATCH -l${page}`,
      );
    expect(searches()).toHaveLength(MAX_REQUESTS_PER_TERM);
  });

  it("does not start further back than the lookback limit", () => {
    const old = new Date(Date.now() - 2 * MAX_LOOKBACK_MS).toISOString();
    feed(`:server MARKREAD #two timestamp=${old}`);
    const horizon = new Date(Date.now() - MAX_LOOKBACK_MS).toISOString();
    expect(searches()).toEqual([
      `SEARCH in=#two;after=${horizon};text=me;limit=${SEARCH_PAGE_SIZE}`,
    ]);
  });

  it("skips a line with a broken time and keeps the queue going", () => {
    feed(
      `:server MARKREAD #one timestamp=${READ_AT}`,
      `:server MARKREAD #two timestamp=${READ_AT}`,
      ":server BATCH +s soju.im/search",
      "@batch=s;msgid=b;time=not-a-time :bob!u@h PRIVMSG #one :me: broken time",
      ":server BATCH -s",
    );
    expect(log()).toEqual([]);
    expect(searches().at(-1)).toContain("in=#two;");
  });

  it("gives two lines without msgid at one instant their own ids", () => {
    feed(
      `:server MARKREAD #two timestamp=${READ_AT}`,
      ":server BATCH +s soju.im/search",
      `@batch=s;time=${at(5)} :bob!u@h PRIVMSG #two :me: one`,
      `@batch=s;time=${at(5)} :bob!u@h PRIVMSG #two :me: two`,
      ":server BATCH -s",
    );
    expect(new Set(log().map((m) => m.messageId)).size).toBe(2);
  });

  describe("on a server that returns labels", () => {
    const labelOf = (line: string) => /^@label=(\S+) /.exec(line)?.[1];

    beforeEach(() => {
      hasLabels = true;
      sent = [];
    });

    it("takes only the answer that carries the label of its question", () => {
      feed(
        `:server MARKREAD #one timestamp=${READ_AT}`,
        `:server MARKREAD #two timestamp=${READ_AT}`,
      );
      const asked = sent.filter((line) => line.includes(" SEARCH "));
      expect(asked).toHaveLength(1);
      const label = labelOf(asked[0]);
      expect(label).toBeTruthy();
      // A search typed by hand answers without our label and is left alone.
      feed(
        ":server BATCH +m soju.im/search",
        `@batch=m;msgid=x;time=${at(5)} :bob!u@h PRIVMSG #one :me: from a manual search`,
        ":server BATCH -m",
      );
      expect(log()).toEqual([]);
      expect(sent.filter((line) => line.includes(" SEARCH "))).toHaveLength(1);
      feed(
        `@label=${label} :server BATCH +o labeled-response`,
        "@batch=o :server BATCH +s soju.im/search",
        `@batch=s;msgid=a;time=${at(6)} :bob!u@h PRIVMSG #one :me: ours`,
        ":server BATCH -s",
        ":server BATCH -o",
      );
      expect(log().map((m) => m.msgid)).toEqual(["a"]);
    });

    it("reads a label set on the search batch itself and on a refusal", () => {
      feed(
        `:server MARKREAD #one timestamp=${READ_AT}`,
        `:server MARKREAD #two timestamp=${READ_AT}`,
      );
      const first = labelOf(sent.filter((l) => l.includes(" SEARCH "))[0]);
      feed(
        `@label=${first} :server BATCH +s soju.im/search`,
        `@batch=s;msgid=a;time=${at(6)} :bob!u@h PRIVMSG #one :me: ours`,
        ":server BATCH -s",
      );
      expect(log().map((m) => m.msgid)).toEqual(["a"]);
      const before = sent.filter((l) => l.includes(" SEARCH ")).length;
      feed(":server FAIL SEARCH INTERNAL_ERROR :not ours");
      expect(sent.filter((l) => l.includes(" SEARCH "))).toHaveLength(before);
      const pending = labelOf(
        sent.filter((l) => l.includes(" SEARCH ")).at(-1) ?? "",
      );
      feed(`@label=${pending} :server FAIL SEARCH INTERNAL_ERROR :ours`);
      expect(sent.filter((l) => l.includes(" SEARCH ")).length).toBe(
        before + 1,
      );
    });
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

  it("searches a refused channel in full on the next connection", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(at(7200)));
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    feed(":server FAIL SEARCH INTERNAL_ERROR :The search could not be run");
    reconnect();
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()[1]).toBe(
      `SEARCH in=#two;after=${READ_AT};text=me;limit=${SEARCH_PAGE_SIZE}`,
    );
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
      ":server BATCH +s soju.im/search",
      `@batch=s;msgid=a;time=${at(5)} :relay!u@h PRIVMSG #two :Me> me: note to self`,
      `@batch=s;msgid=b;time=${at(6)} :relay!u@h PRIVMSG #two :carol> me: ping from the site`,
      ":server BATCH -s",
    );
    expect(log().map((m) => [m.sender, m.content])).toEqual([
      ["carol", "me: ping from the site"],
    ]);
  });

  it("stops asking on a connection whose answer is overdue", () => {
    vi.useFakeTimers();
    feed(
      `:server MARKREAD #one timestamp=${READ_AT}`,
      `:server MARKREAD #two timestamp=${READ_AT}`,
    );
    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS + 1000);
    expect(searches()).toHaveLength(1);
    // The late answer belongs to no question we could still name.
    feed(
      ":server BATCH +s soju.im/search",
      `@batch=s;msgid=a;time=${at(5)} :bob!u@h PRIVMSG #two :me, late`,
      ":server BATCH -s",
    );
    expect(log()).toEqual([]);
    expect(searches()).toHaveLength(1);
    reconnect();
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()).toHaveLength(2);
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
      ":server BATCH +s soju.im/search",
      `@batch=s;msgid=a;time=${at(5)} :bob!u@h PRIVMSG #Two :me: ping`,
      ":server BATCH -s",
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
      ":server BATCH +s soju.im/search",
      `@batch=s;msgid=a;time=${at(30)} :bob!u@h PRIVMSG #two :me, read already`,
      `@batch=s;msgid=b;time=${at(90)} :bob!u@h PRIVMSG #two :me, still unread`,
      ":server BATCH -s",
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
      ":server BATCH +s soju.im/search",
      `@batch=s;msgid=a;time=${at(5)} :bob!u@h PRIVMSG #two :me: ping`,
      ":server BATCH -s",
    );
    expect(log().map((m) => m.seen)).toEqual([true]);
  });

  it("leaves out ignored senders and keeps a line without msgid once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(at(7200)));
    useStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, ignoreList: ["troll!*@*"] },
    }));
    const answer = [
      ":server BATCH +s soju.im/search",
      `@batch=s;time=${at(5)} :troll!u@h PRIVMSG #two :me me me`,
      `@batch=s;time=${at(6)} :bob!u@h PRIVMSG #two :me: ping`,
      ":server BATCH -s",
    ];
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...answer);
    reconnect();
    forgetSearches();
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...answer);
    expect(log().map((m) => [m.sender, m.content])).toEqual([
      ["bob", "me: ping"],
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
      ":server BATCH +s soju.im/search",
      `@batch=s;msgid=a;time=${at(300)} :bob!u@h PRIVMSG #two :me, earlier`,
      ":server BATCH -s",
    );
    expect(log().map((m) => m.msgid)).toEqual(["a", "live"]);
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

  it("builds the search terms from the nick and the highlight words", () => {
    expect(searchTerms("Me", [" me ", "", "word"])).toEqual(["Me", "word"]);
  });
});
