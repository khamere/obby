import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { AppState } from "../../src/store";

vi.mock("../../src/lib/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
  shouldPlayNotificationSound: vi.fn(() => false),
}));

const SERVER = "srv";
const KEY = `${SERVER}-chan-1`;
const BASE = Date.parse("2026-01-01T12:00:00.000Z");
const WRITE_TIMEOUT_MS = 60_000;
const PAGE = 50;
// Lines 0 to 59 are a second apart and the reader has read up to the last
// of them. Every later line is one burst the server stamped into a single
// millisecond.
const SPACED = 60;
const LAST_READ = SPACED - 1;
const BURST_TIME = BASE + 600_000;

const timeOf = (index: number) =>
  index < SPACED ? BASE + index * 1000 : BURST_TIME;
const iso = (time: number) => new Date(time).toISOString();
const line = (index: number) =>
  `@msgid=m${index};time=${iso(timeOf(index))} :alice!u@h PRIVMSG #chan :line ${index}`;
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `m${from + index}`);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);
const byNumber = (msgids: (string | undefined)[]) =>
  [...msgids].sort((a, b) => Number(a?.slice(1)) - Number(b?.slice(1)));

type World = {
  // The line numbers the server keeps, oldest first.
  has: number[];
  // The code the server refuses every request by msgid with, and the words after it.
  refusesMsgid?: { code: string; context: string };
};

async function boot(refs: string) {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const { default: useStore } = await import("../../src/store");
  const { default: ircClient } = await import("../../src/lib/ircClient");
  const db = await import("../../src/lib/history/historyDb");
  const history = await import("../../src/store/handlers/history");
  const sent: string[] = [];
  const world: World = { has: [] };
  let batchCounter = 0;
  const client = ircClient as unknown as {
    sockets: Map<string, unknown>;
    handleMessage(data: string, serverId: string): void;
  };
  const feed = (...lines: string[]) =>
    client.handleMessage(`${lines.join("\r\n")}\r\n`, SERVER);
  const page = (indexes: number[]) => {
    const id = `b${++batchCounter}`;
    return [
      `:irc.test BATCH +${id} chathistory #chan`,
      ...indexes.map((index) => line(index).replace("@", `@batch=${id};`)),
      `:irc.test BATCH -${id}`,
    ];
  };
  // The server pages the way ergo does: a time bound leaves out every line
  // at that millisecond, a msgid bound leaves out that one line, and a page
  // around a time holds half its lines up to that time and half after it.
  const pick = (
    subcommand: string,
    kind: string | undefined,
    value: string | undefined,
    limit: number,
  ) => {
    const all = world.has;
    if (subcommand === "LATEST" || !kind || !value) return all.slice(-limit);
    if (kind === "msgid") {
      const at = all.indexOf(Number(value.slice(1)));
      if (at < 0) return [];
      return subcommand === "BEFORE"
        ? all.slice(Math.max(0, at - limit), at)
        : all.slice(at + 1, at + 1 + limit);
    }
    const at = Date.parse(value);
    if (subcommand === "BEFORE")
      return all.filter((i) => timeOf(i) < at).slice(-limit);
    if (subcommand === "AFTER")
      return all.filter((i) => timeOf(i) > at).slice(0, limit);
    return [
      ...all.filter((i) => timeOf(i) <= at).slice(-limit / 2),
      ...all.filter((i) => timeOf(i) > at).slice(0, limit / 2),
    ];
  };
  const serve = (raw: string) => {
    const request =
      /^CHATHISTORY (LATEST|BEFORE|AFTER|AROUND) \S+ (?:(timestamp|msgid)=(\S+)|\*) (\d+)/.exec(
        raw.trim(),
      );
    if (!request) return;
    const [, subcommand, kind, value, asked] = request;
    if (kind === "msgid" && world.refusesMsgid) {
      const { code, context } = world.refusesMsgid;
      setTimeout(
        () =>
          feed(
            `:irc.test FAIL CHATHISTORY ${code} ${context} :Cannot page from that message`,
          ),
        0,
      );
      return;
    }
    const picked = pick(subcommand, kind, value, Number(asked));
    setTimeout(() => feed(...page(picked)), 0);
  };
  client.sockets.set(SERVER, {
    readyState: WebSocket.OPEN,
    send: (raw: string) => {
      sent.push(raw.trim());
      serve(raw);
    },
    close: () => {},
  });
  const server = {
    id: SERVER,
    name: "TestNet",
    host: "irc.test",
    port: 6667,
    isConnected: true,
    capabilities: ["draft/chathistory", "message-tags"],
    privateChats: [],
    channels: [
      {
        id: "chan-1",
        name: "#chan",
        isPrivate: false,
        serverId: SERVER,
        unreadCount: 0,
        isMentioned: false,
        readMarker: iso(timeOf(LAST_READ)),
        messages: [],
        users: [],
      },
    ],
  };
  ircClient.servers.set(SERVER, { ...server, channels: [] } as never);
  ircClient.nicks.set(SERVER, "tester");
  useStore.setState(
    (state) =>
      ({
        servers: [server],
        globalSettings: { ...state.globalSettings, keepHistory: true },
      }) as unknown as AppState,
  );
  feed(
    `:irc.test 005 tester CHATHISTORY=${PAGE} MSGREFTYPES=${refs} :are supported by this server`,
  );

  const shown = () =>
    (useStore.getState().messages[KEY] ?? []).flatMap((m) =>
      m.msgid ? [m.msgid] : [],
    );
  const saved = async () =>
    byNumber(
      (await db.newestEventRows(SERVER, "#chan", 5000)).map((row) => row.msgid),
    );
  const gaps = () => db.gapsFor(SERVER, "#chan");
  const requests = (subcommand: string) =>
    sent.filter((raw) => raw.startsWith(`CHATHISTORY ${subcommand} `));

  // We saved the first `count` lines live on this device.
  const receiveLive = async (count: number) => {
    feed(...range(0, count - 1).map(line));
    await vi.waitFor(async () => expect(await saved()).toHaveLength(count), {
      timeout: WRITE_TIMEOUT_MS,
    });
  };

  // The reader comes back the way a reload does: the chat is empty, the
  // newest page loads, and the chat opens on the read marker.
  const comeBack = async () => {
    useStore.setState({ messages: {} });
    const newest = `m${world.has[world.has.length - 1]}`;
    ircClient.requestChathistoryLatest(SERVER, "#chan");
    await vi.waitFor(() => expect(shown()).toContain(newest), {
      timeout: WRITE_TIMEOUT_MS,
    });
    await db.whenHistoryIdle();
    return history.showMessagesFromReadMarker(
      useStore,
      SERVER,
      "#chan",
      timeOf(LAST_READ),
    );
  };

  // We page newer until the window joins the present.
  const pageToPresent = async () => {
    const window = () => useStore.getState().historyWindows[KEY];
    for (let step = 0; step < 100 && window(); step++)
      await history.loadNewerMessages(useStore, SERVER, "#chan");
    expect(window()).toBeUndefined();
    await db.whenHistoryIdle();
  };

  return {
    world,
    sent,
    shown,
    saved,
    gaps,
    requests,
    receiveLive,
    comeBack,
    pageToPresent,
  };
}

describe("a page around the read marker that ends in the millisecond the newest page starts in", {
  timeout: 4 * WRITE_TIMEOUT_MS,
}, () => {
  // The newest page holds m100 to m149 and the page around the marker ends
  // on m84, so m85 to m99 sit between two pages of one millisecond.
  const BURST_END = 149;

  it("fetches the lines between the two pages on a device that holds older lines", async () => {
    const w = await boot("msgid,timestamp");
    await w.receiveLive(26);
    w.world.has = range(0, BURST_END);

    expect(await w.comeBack()).toBe(true);

    expect(await w.saved()).toEqual([...ids(0, 25), ...ids(35, BURST_END)]);
    expect(await w.gaps()).toMatchObject([
      { from: timeOf(25), to: timeOf(35), lost: false },
    ]);
    expect(w.requests("AROUND")).toEqual([
      `CHATHISTORY AROUND #chan timestamp=${iso(timeOf(LAST_READ))} ${PAGE}`,
    ]);
    expect(w.requests("AFTER")).toEqual([
      `CHATHISTORY AFTER #chan msgid=m84 ${PAGE}`,
    ]);

    await w.pageToPresent();

    expect(byNumber(w.shown())).toEqual(ids(35, BURST_END));
  });

  it("fetches the lines between the two pages on a device that holds no line of the chat", async () => {
    const w = await boot("msgid,timestamp");
    w.world.has = range(0, BURST_END);

    expect(await w.comeBack()).toBe(true);

    expect(await w.saved()).toEqual(ids(35, BURST_END));
    expect(await w.gaps()).toEqual([]);
    expect(w.requests("AFTER")).toEqual([
      `CHATHISTORY AFTER #chan msgid=m84 ${PAGE}`,
    ]);

    await w.pageToPresent();

    expect(byNumber(w.shown())).toEqual(ids(35, BURST_END));
  });

  it("keeps asking from the last line it got until it reaches the newest page", async () => {
    const w = await boot("msgid,timestamp");
    // The newest page starts at m210, so 125 lines sit between the pages.
    w.world.has = range(0, 259);

    expect(await w.comeBack()).toBe(true);

    expect(await w.saved()).toEqual(ids(35, 259));
    expect(await w.gaps()).toEqual([]);
    expect(w.requests("AFTER")).toEqual(
      [84, 134, 184].map(
        (edge) => `CHATHISTORY AFTER #chan msgid=m${edge} ${PAGE}`,
      ),
    );
  });

  it("leaves no gap behind when the server refuses the line the page ended on", async () => {
    const w = await boot("msgid,timestamp");
    w.world.has = range(0, BURST_END);
    w.world.refusesMsgid = { code: "INVALID_PARAMS", context: "AFTER #chan" };

    expect(await w.comeBack()).toBe(true);

    expect(w.requests("AFTER")).toEqual([
      `CHATHISTORY AFTER #chan msgid=m84 ${PAGE}`,
      `CHATHISTORY AFTER #chan timestamp=${iso(BURST_TIME)} ${PAGE}`,
    ]);
    expect(await w.gaps()).toEqual([]);
    expect(await w.saved()).toEqual([...ids(35, 84), ...ids(100, BURST_END)]);
  });

  it("records no gap inside the millisecond on a server that pages by time only", async () => {
    const w = await boot("timestamp");
    await w.receiveLive(26);
    w.world.has = range(0, BURST_END);

    expect(await w.comeBack()).toBe(true);

    expect(w.sent.filter((raw) => raw.includes("msgid="))).toEqual([]);
    expect(w.requests("AFTER")).toEqual([]);
    expect(await w.gaps()).toMatchObject([
      { from: timeOf(25), to: timeOf(35), lost: false },
    ]);
    expect(await w.saved()).toEqual([
      ...ids(0, 25),
      ...ids(35, 84),
      ...ids(100, BURST_END),
    ]);
  });
});
