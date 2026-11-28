import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore, {
  hasSeenMsgId,
  rememberMsgId,
  rememberMsgIds,
} from "../../src/store";
import type { Channel, Message, Server } from "../../src/types";

vi.mock("../../src/lib/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
  shouldPlayNotificationSound: () => false,
}));

// Two connections of one client to the same network: both sit in #room, so
// the network hands each of them every line under the same msgid.
const DIRECT = "direct";
const BOUNCER = "bouncer";
const NICKS = { [DIRECT]: "alice", [BOUNCER]: "bob" };

const channel = (serverId: string): Channel => ({
  id: `${serverId}-room`,
  name: "#room",
  isPrivate: false,
  serverId,
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [],
});

const server = (id: string): Server =>
  ({
    id,
    name: id,
    host: "irc.example",
    port: 6697,
    isConnected: true,
    users: [],
    channels: [channel(id)],
    privateChats: [],
    capabilities: [],
  }) as Server;

function feed(serverId: string, ...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), serverId);
}

function setNick(serverId: string, nick: string) {
  ircClient.nicks.set(serverId, nick);
  ircClient.currentUsers.set(serverId, { id: nick, username: nick } as never);
}

const rows = (serverId: string, buffer = `${serverId}-room`) =>
  useStore.getState().messages[`${serverId}-${buffer}`] ?? [];
const shown = (serverId: string) => rows(serverId).map((m) => m.content);

const pending = (
  serverId: string,
  label: string,
  content: string,
): Message => ({
  id: label,
  content,
  timestamp: new Date("2026-10-10T12:00:00Z"),
  userId: NICKS[serverId as keyof typeof NICKS],
  channelId: `${serverId}-room`,
  serverId,
  type: "message",
  reactions: [],
  replyMessage: null,
  mentioned: [],
  pendingLabel: label,
  status: "pending",
});

describe("the same msgid on two connections to one network", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    setNick(DIRECT, NICKS[DIRECT]);
    setNick(BOUNCER, NICKS[BOUNCER]);
    useStore.setState((state) => ({
      servers: [server(DIRECT), server(BOUNCER)],
      messages: {},
      mentionLog: [],
      activeBatches: {},
      processedMessageIds: new Set(),
      ui: {
        ...state.ui,
        selectedServerId: DIRECT,
        perServerSelections: {
          [DIRECT]: { selectedChannelId: null, selectedPrivateChatId: null },
        },
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const id of [DIRECT, BOUNCER]) {
      ircClient.nicks.delete(id);
      ircClient.currentUsers.delete(id);
      ircClient.activeBatches.delete(id);
    }
  });

  it("shows a channel line in both server entries, once each", () => {
    const line =
      "@time=2026-10-10T12:00:00.000Z;msgid=m1 :carol!u@h PRIVMSG #room :hello";
    feed(DIRECT, line);
    feed(BOUNCER, line);
    feed(BOUNCER, line);
    feed(DIRECT, line);

    expect(shown(DIRECT)).toEqual(["hello"]);
    expect(shown(BOUNCER)).toEqual(["hello"]);
  });

  it.each([
    ["the other connection hears it first", [DIRECT, BOUNCER]],
    ["our echo comes first", [BOUNCER, DIRECT]],
  ])("confirms our pending line when %s", (_name, order) => {
    useStore.getState().addMessage(pending(BOUNCER, "L1", "from bob"));
    const tags = "time=2026-10-10T12:00:01.000Z;msgid=m2";
    const lines = {
      [DIRECT]: `@${tags} :bob!u@h PRIVMSG #room :from bob`,
      [BOUNCER]: `@${tags};label=L1 :bob!u@h PRIVMSG #room :from bob`,
    };
    for (const id of order) feed(id, lines[id as keyof typeof lines]);

    expect(rows(BOUNCER)).toHaveLength(1);
    expect(rows(BOUNCER)[0]).toMatchObject({
      msgid: "m2",
      status: undefined,
      pendingLabel: undefined,
    });
    expect(shown(DIRECT)).toEqual(["from bob"]);
  });

  // A server puts the msgid on the batch or on each of its lines.
  it.each([
    ["the batch", "msgid=ml1;", "", ""],
    ["each line", "", "msgid=ml1;", "msgid=ml2;"],
  ])(
    "shows a multiline message with a msgid on %s in both server entries, the sender's echo included",
    (_name, onBatch, onFirst, onSecond) => {
      // The second delivery carries a later time, so only its msgids tell us we have it.
      const batch = (second: number) => [
        `@${onBatch}time=2026-10-10T12:00:0${second}.000Z :alice!u@h BATCH +b1 draft/multiline #room`,
        `@${onFirst}batch=b1 :alice!u@h PRIVMSG #room :one`,
        `@${onSecond}batch=b1 :alice!u@h PRIVMSG #room :two`,
        ":alice!u@h BATCH -b1",
      ];
      feed(BOUNCER, ...batch(2));
      feed(DIRECT, ...batch(2));
      feed(DIRECT, ...batch(3));
      feed(BOUNCER, ...batch(3));

      expect(shown(BOUNCER)).toEqual(["one\ntwo"]);
      expect(shown(DIRECT)).toEqual(["one\ntwo"]);
    },
  );

  it("shows a private message in both entries of one nick", () => {
    setNick(BOUNCER, NICKS[DIRECT]);
    const line =
      "@time=2026-10-10T12:00:03.000Z;msgid=p1 :carol!u@h PRIVMSG alice :psst";
    feed(DIRECT, line);
    feed(BOUNCER, line);
    feed(BOUNCER, line);

    const chatRows = (serverId: string) => {
      const chat = useStore
        .getState()
        .servers.find((s) => s.id === serverId)
        ?.privateChats?.find((pc) => pc.username === "carol");
      return rows(serverId, chat?.id).map((m) => m.content);
    };
    expect(chatRows(DIRECT)).toEqual(["psst"]);
    expect(chatRows(BOUNCER)).toEqual(["psst"]);
  });

  it("shows a live line on the entry that did not load it as history", () => {
    feed(
      DIRECT,
      ":server BATCH +h chathistory #room",
      "@batch=h;time=2026-10-10T12:00:04.000Z;msgid=h1 :carol!u@h PRIVMSG #room :earlier",
      ":server BATCH -h",
    );
    const live =
      "@time=2026-10-10T12:00:04.000Z;msgid=h1 :carol!u@h PRIVMSG #room :earlier";
    feed(BOUNCER, live);
    feed(DIRECT, live);

    expect(shown(DIRECT)).toEqual(["earlier"]);
    expect(shown(BOUNCER)).toEqual(["earlier"]);
  });

  it("logs a mention of both nicks once per server entry", () => {
    const line =
      "@time=2026-10-10T12:00:05.000Z;msgid=m3 :carol!u@h PRIVMSG #room :alice, bob: look";
    feed(DIRECT, line);
    feed(BOUNCER, line);
    const { mentionLog, recordMention } = useStore.getState();
    recordMention({ ...mentionLog[0], messageId: "copy" });

    expect(
      useStore.getState().mentionLog.map((m) => [m.serverId, m.msgid]),
    ).toEqual([
      [DIRECT, "m3"],
      [BOUNCER, "m3"],
    ]);
  });
});

describe("the remembered msgids", () => {
  const ids = Array.from({ length: 10_000 }, (_, i) => `m${i}`);

  it("keeps each server's msgids apart", () => {
    const set = rememberMsgIds(new Set(), DIRECT, ["a", "b"]);
    expect(hasSeenMsgId(set, DIRECT, "a")).toBe(true);
    expect(hasSeenMsgId(set, BOUNCER, "a")).toBe(false);
    expect(rememberMsgId(set, DIRECT, "b")).toBe(set);
    expect(rememberMsgId(set, BOUNCER, "b")).not.toBe(set);
  });

  it("stays capped across servers and drops the oldest first", () => {
    const full = rememberMsgIds(new Set(), DIRECT, ids);
    expect(full.size).toBe(10_000);

    const one = rememberMsgId(full, BOUNCER, "m0");
    expect(one.size).toBe(9_000);
    expect(hasSeenMsgId(one, BOUNCER, "m0")).toBe(true);
    expect(hasSeenMsgId(one, DIRECT, "m0")).toBe(false);
    expect(hasSeenMsgId(one, DIRECT, "m9999")).toBe(true);

    const many = rememberMsgIds(full, BOUNCER, ids);
    expect(many.size).toBe(9_000);
    expect(hasSeenMsgId(many, BOUNCER, "m9999")).toBe(true);
    expect(hasSeenMsgId(many, DIRECT, "m9999")).toBe(false);
  });
});
