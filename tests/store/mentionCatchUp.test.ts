import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import * as mutes from "../../src/lib/mutes";
import useStore from "../../src/store";
import {
  ANSWER_TIMEOUT_MS,
  forgetSearches,
  MAX_PAGES_PER_TERM,
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

  const searches = () => sent.filter((line) => line.startsWith("SEARCH "));
  const reconnect = () => {
    ircClient.triggerEvent("connectionStateChange", {
      serverId: "s1",
      connectionState: "disconnected",
    });
  };

  beforeEach(() => {
    sent = [];
    canSearch = true;
    vi.spyOn(ircClient, "sendRaw").mockImplementation((_serverId, line) => {
      sent.push(line);
    });
    vi.spyOn(ircClient, "hasCapability").mockImplementation(
      (_serverId, cap) => cap === "soju.im/search" && canSearch,
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

  it("searches again after a long absence, from where the last search ended", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(at(7200)));
    feed(`:server MARKREAD #two timestamp=${READ_AT}`, ...emptyAnswer("s"));
    vi.setSystemTime(Date.now() + SEARCH_AGAIN_AFTER_MS);
    reconnect();
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    expect(searches()[1]).toBe(
      `SEARCH in=#two;after=${at(7200 - 60)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    );
    reconnect();
    vi.setSystemTime(Date.now() + SEARCH_AGAIN_AFTER_MS);
    // A marker past the last search is the later of the two starts.
    feed(`:server MARKREAD #two timestamp=${at(9000)}`);
    expect(searches()[2]).toContain(`after=${at(9000)};`);
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

  it("asks on both sides of a full page, whichever end the server cut", () => {
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
    expect(searches()[2]).toBe(
      `SEARCH in=#two;after=${at(1000 + SEARCH_PAGE_SIZE - 1)};text=me;limit=${SEARCH_PAGE_SIZE}`,
    );
    feed(...emptyAnswer("r"));
    expect(searches()).toHaveLength(3);
    expect(log()).toHaveLength(SEARCH_PAGE_SIZE + 1);
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

  it("ends a term whose full page does not move", () => {
    feed(`:server MARKREAD #two timestamp=${READ_AT}`);
    const sameInstant = Array.from(
      { length: SEARCH_PAGE_SIZE },
      (_, i) =>
        `@batch=s;msgid=i${i};time=${at(5)} :bob!u@h PRIVMSG #two :me ${i}`,
    );
    feed(":server BATCH +s soju.im/search", ...sameInstant, ":server BATCH -s");
    feed(...emptyAnswer("a"), ...emptyAnswer("b"));
    feed(
      ...fullPage("c", 5).map((line) =>
        line.replace(/time=[^ ]+/, `time=${at(5)}`),
      ),
    );
    expect(searches().length).toBeLessThanOrEqual(3);
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
    expect(searches()).toHaveLength(2);
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

  it("builds the search terms from the nick and the highlight words", () => {
    expect(searchTerms("Me", [" me ", "", "word"])).toEqual(["Me", "word"]);
  });
});
