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
const PM_KEY = `${SERVER}-pm-bob`;
const BASE = Date.parse("2026-01-01T12:00:00.000Z");
const WRITE_TIMEOUT_MS = 60_000;
const CAPS = ["draft/chathistory", "message-tags"];
const PAGE = 50;
// Seven lines share each millisecond, so every page of 50 ends inside a run.
const RUN = 7;

const timeOf = (index: number) => BASE + Math.floor(index / RUN) * 1000;
const iso = (index: number) => new Date(timeOf(index)).toISOString();
const line = (index: number, target: string) =>
  target === "#chan"
    ? `@msgid=m${index};time=${iso(index)} :alice!u@h PRIVMSG #chan :line ${index}`
    : `@msgid=m${index};time=${iso(index)} :${target}!u@h PRIVMSG tester :line ${index}`;
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `m${from + index}`);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);
const byNumber = (msgids: string[]) =>
  [...msgids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type World = {
  // The line numbers the server keeps, oldest first.
  has: number[];
  // The reference kinds the server pages by, as it states them in MSGREFTYPES.
  refs?: string;
  // The code the server refuses every request by msgid with, and the words after it.
  refusesMsgid?: { code: string; context: string };
};

async function boot(refs?: string, { keepHistory = true } = {}) {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const { default: useStore } = await import("../../src/store");
  const { default: ircClient } = await import("../../src/lib/ircClient");
  const db = await import("../../src/lib/history/historyDb");
  const history = await import("../../src/store/handlers/history");
  const { messageTime } = await import("../../src/store/helpers");
  const sent: string[] = [];
  const world: World = { has: [], refs };
  let batchCounter = 0;
  const client = ircClient as unknown as {
    sockets: Map<string, unknown>;
    handleMessage(data: string, serverId: string): void;
  };
  const feed = (...lines: string[]) =>
    client.handleMessage(`${lines.join("\r\n")}\r\n`, SERVER);
  const page = (indexes: number[], target = "#chan") => {
    const id = `b${++batchCounter}`;
    return [
      `:irc.test BATCH +${id} chathistory ${target}`,
      ...indexes.map((index) =>
        line(index, target).replace("@", `@batch=${id};`),
      ),
      `:irc.test BATCH -${id}`,
    ];
  };
  // The server pages the way ergo does: a time bound leaves out every line
  // at that millisecond, a msgid bound leaves out that one line, and a msgid
  // it does not know gets an empty page.
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
    return all.filter((i) => Math.abs(timeOf(i) - at) <= 3000).slice(0, limit);
  };
  const serve = (raw: string) => {
    const request =
      /^CHATHISTORY (LATEST|BEFORE|AFTER|AROUND) (\S+) (?:(timestamp|msgid)=(\S+)|\*) (\d+)/.exec(
        raw.trim(),
      );
    if (!request) return;
    const [, subcommand, target, kind, value, asked] = request;
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
    setTimeout(() => feed(...page(picked, target)), 0);
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
    capabilities: CAPS,
    privateChats: [
      {
        id: "pm-bob",
        username: "bob",
        serverId: SERVER,
        unreadCount: 0,
        isMentioned: false,
      },
    ],
    channels: [
      {
        id: "chan-1",
        name: "#chan",
        isPrivate: false,
        serverId: SERVER,
        unreadCount: 0,
        isMentioned: false,
        readMarker: new Date(BASE).toISOString(),
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
        globalSettings: { ...state.globalSettings, keepHistory },
      }) as unknown as AppState,
  );
  feed(
    `:irc.test 005 tester CHATHISTORY=${PAGE}${refs ? ` MSGREFTYPES=${refs}` : ""} :are supported by this server`,
  );

  const shown = (key = KEY) =>
    (useStore.getState().messages[key] ?? []).flatMap((m) =>
      m.msgid ? [m.msgid] : [],
    );
  const chat = (target: string) => {
    const [current] = useStore.getState().servers;
    return target === "#chan" ? current.channels[0] : current.privateChats?.[0];
  };
  const window = () => useStore.getState().historyWindows[KEY];
  const saved = async () =>
    (await db.newestEventRows(SERVER, "#chan", 5000)).map((row) => row.msgid);
  const requests = (subcommand: string) =>
    sent.filter((raw) => raw.startsWith(`CHATHISTORY ${subcommand} `));

  const loadLatest = async (target = "#chan", key = KEY) => {
    const newest = `m${world.has[world.has.length - 1]}`;
    ircClient.requestChathistoryLatest(SERVER, target);
    await vi.waitFor(() => expect(shown(key).at(-1)).toBe(newest), {
      timeout: WRITE_TIMEOUT_MS,
    });
    await db.whenHistoryIdle();
  };

  // We load older pages the way the list does on a scroll to its top: one
  // request at a time, each from the oldest message on screen, until three
  // tries in a row add nothing.
  const scrollToTop = async (target = "#chan", key = KEY) => {
    let quiet = 0;
    for (let step = 0; step < 300 && quiet < 3; step++) {
      const count = shown(key).length;
      const top = useStore.getState().messages[key]?.[0];
      await history.loadOlderMessages(
        useStore,
        SERVER,
        target,
        top ? messageTime(top) : Date.now(),
      );
      await sleep(30);
      await vi.waitFor(
        () => expect(chat(target)?.isLoadingHistory).toBeFalsy(),
        {
          timeout: WRITE_TIMEOUT_MS,
        },
      );
      await db.whenHistoryIdle();
      await sleep(30);
      quiet = shown(key).length === count ? quiet + 1 : 0;
    }
  };

  // We saved the first `count` lines live and were away for the rest.
  const receiveLive = async (count: number) => {
    feed(...range(0, count - 1).map((index) => line(index, "#chan")));
    await vi.waitFor(async () => expect(await saved()).toHaveLength(count), {
      timeout: WRITE_TIMEOUT_MS,
    });
  };

  const openOnMarker = async (index: number) => {
    useStore.setState({ messages: {} });
    expect(
      await history.showMessagesFromReadMarker(
        useStore,
        SERVER,
        "#chan",
        timeOf(index),
      ),
    ).toBe(true);
  };

  // We page newer until the window joins the present and collect every
  // message in the order it came on screen.
  const pageToPresent = async () => {
    const seen = [...shown()];
    for (let step = 0; step < 100 && window(); step++) {
      await history.loadNewerMessages(useStore, SERVER, "#chan");
      const now = shown();
      expect(new Set(now).size).toBe(now.length);
      const last = seen[seen.length - 1];
      seen.push(...now.slice(now.indexOf(last) + 1));
    }
    expect(window()).toBeUndefined();
    return seen;
  };

  return {
    useStore,
    ircClient,
    db,
    history,
    sent,
    world,
    feed,
    shown,
    saved,
    requests,
    loadLatest,
    scrollToTop,
    receiveLive,
    openOnMarker,
    pageToPresent,
  };
}

describe("history pages that end inside a millisecond", {
  timeout: 4 * WRITE_TIMEOUT_MS,
}, () => {
  describe("older pages on a server that pages by msgid", () => {
    it("shows every line of a channel once", async () => {
      const w = await boot("msgid,timestamp");
      w.world.has = range(0, 299);
      await w.loadLatest();
      expect(byNumber(w.shown())).toEqual(ids(250, 299));

      await w.scrollToTop();

      expect(byNumber(w.shown())).toEqual(ids(0, 299));
      expect(await w.saved()).toHaveLength(300);
      expect(w.requests("BEFORE").slice(0, 5)).toEqual(
        [250, 200, 150, 100, 50].map(
          (edge) => `CHATHISTORY BEFORE #chan msgid=m${edge} ${PAGE}`,
        ),
      );
    });

    it("shows every line of a private chat once", async () => {
      const w = await boot("msgid,timestamp");
      w.world.has = range(0, 299);
      await w.loadLatest("bob", PM_KEY);

      await w.scrollToTop("bob", PM_KEY);

      expect(byNumber(w.shown(PM_KEY))).toEqual(ids(0, 299));
      expect(w.requests("BEFORE")[0]).toBe(
        `CHATHISTORY BEFORE bob msgid=m250 ${PAGE}`,
      );
    });

    it("shows every line with saved history turned off", async () => {
      const w = await boot("msgid,timestamp", { keepHistory: false });
      w.world.has = range(0, 299);
      await w.loadLatest();

      await w.scrollToTop();

      expect(byNumber(w.shown())).toEqual(ids(0, 299));
      expect(w.requests("BEFORE")[0]).toBe(
        `CHATHISTORY BEFORE #chan msgid=m250 ${PAGE}`,
      );
    });

    it("asks again by time when the server no longer knows the line at the edge", async () => {
      const w = await boot("msgid,timestamp");
      w.world.has = range(0, 299);
      await w.loadLatest();
      w.world.has = range(0, 299).filter((index) => index !== 250);

      await w.scrollToTop();

      expect(w.requests("BEFORE").slice(0, 2)).toEqual([
        `CHATHISTORY BEFORE #chan msgid=m250 ${PAGE}`,
        `CHATHISTORY BEFORE #chan timestamp=${iso(250)} ${PAGE}`,
      ]);
      expect(w.shown()[0]).toBe("m0");
      expect(new Set(w.shown()).size).toBe(w.shown().length);
    });
  });

  describe("a server that lists msgid and refuses a page asked by one", () => {
    it.each([
      ["a refusal that would repeat", "INVALID_PARAMS", "BEFORE #chan"],
      ["a refusal that could pass later", "MESSAGE_ERROR", "BEFORE #chan"],
      ["a refusal that names no chat", "INVALID_MSGREFTYPE", "BEFORE"],
    ])("asks that page once by time after %s", async (_case, code, context) => {
      const w = await boot("msgid,timestamp");
      w.world.has = range(0, 299);
      await w.loadLatest();
      w.world.refusesMsgid = { code, context };

      await w.scrollToTop();

      expect(w.requests("BEFORE").slice(0, 2)).toEqual([
        `CHATHISTORY BEFORE #chan msgid=m250 ${PAGE}`,
        `CHATHISTORY BEFORE #chan timestamp=${iso(250)} ${PAGE}`,
      ]);
      expect(w.shown()).toContain("m200");
    });
  });

  describe("a server that pages by time only", () => {
    it.each([
      ["states timestamp alone", "timestamp"],
      ["states no reference kinds", undefined],
    ])("gets time references when it %s", async (_name, refs) => {
      const w = await boot(refs);
      w.world.has = range(0, 299);
      await w.loadLatest();

      await w.scrollToTop();

      expect(w.requests("BEFORE").length).toBeGreaterThan(0);
      expect(w.sent.filter((raw) => raw.includes("msgid="))).toEqual([]);
      expect(w.requests("BEFORE")[0]).toBe(
        `CHATHISTORY BEFORE #chan timestamp=${iso(250)} ${PAGE}`,
      );
      const shown = w.shown();
      expect(new Set(shown).size).toBe(shown.length);
      expect(shown).toEqual(
        [...shown].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
      );
    });
  });

  describe("catching up after time away", () => {
    // The last line we saw live, m102, sits inside a run, and the newest
    // page starts inside another, so both edges of the gap split a
    // millisecond.
    const SEEN_LIVE = 103;

    it("fills the gap behind the newest page without losing a line at either edge", async () => {
      const w = await boot("msgid,timestamp");
      await w.receiveLive(SEEN_LIVE);
      w.world.has = range(0, 403);

      await w.loadLatest();
      await vi.waitFor(
        async () => {
          expect(await w.saved()).toHaveLength(404);
          expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
        },
        { timeout: WRITE_TIMEOUT_MS },
      );

      expect(byNumber(w.shown())).toEqual(ids(0, 403));
      expect(w.requests("BEFORE")[0]).toBe(
        `CHATHISTORY BEFORE #chan msgid=m354 ${PAGE}`,
      );
      expect(
        w.requests("BEFORE").filter((raw) => raw.includes("timestamp=")),
      ).toEqual([]);
    });

    it("fills a long gap from its newer edge as the reader scrolls up", async () => {
      const w = await boot("msgid,timestamp");
      await w.receiveLive(SEEN_LIVE);
      w.world.has = range(0, 803);
      w.useStore.setState({ messages: {} });
      await w.loadLatest();
      await vi.waitFor(
        async () =>
          expect(await w.db.gapsFor(SERVER, "#chan")).toMatchObject([
            { from: timeOf(102), to: timeOf(754) },
          ]),
        { timeout: WRITE_TIMEOUT_MS },
      );

      await w.scrollToTop();

      expect(byNumber(w.shown())).toEqual(ids(0, 803));
      expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
      expect(w.requests("BEFORE")[0]).toBe(
        `CHATHISTORY BEFORE #chan msgid=m754 ${PAGE}`,
      );
    });

    it("fills a gap from its older edge as the reader pages newer", async () => {
      const w = await boot("msgid,timestamp");
      await w.receiveLive(SEEN_LIVE);
      w.world.has = range(0, 803);
      w.useStore.setState({ messages: {} });
      await w.loadLatest();
      await vi.waitFor(
        async () => expect(await w.db.gapsFor(SERVER, "#chan")).toHaveLength(1),
        { timeout: WRITE_TIMEOUT_MS },
      );
      await w.openOnMarker(60);
      const first = Number(w.shown()[0].slice(1));

      const seen = await w.pageToPresent();

      expect(byNumber(seen)).toEqual(ids(first, 803));
      expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
      expect(w.requests("AFTER")[0]).toBe(
        `CHATHISTORY AFTER #chan msgid=m102 ${PAGE}`,
      );
    });

    it("pages a gap by time on a server without msgid references", async () => {
      const w = await boot("timestamp");
      await w.receiveLive(SEEN_LIVE);
      w.world.has = range(0, 403);

      await w.loadLatest();
      await vi.waitFor(
        async () => expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]),
        { timeout: WRITE_TIMEOUT_MS },
      );

      expect(w.requests("BEFORE")[0]).toBe(
        `CHATHISTORY BEFORE #chan timestamp=${iso(354)} ${PAGE}`,
      );
      expect(w.sent.filter((raw) => raw.includes("msgid="))).toEqual([]);
      const shown = w.shown();
      expect(new Set(shown).size).toBe(shown.length);
    });
  });
});
