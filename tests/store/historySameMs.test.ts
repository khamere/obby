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

const inRuns = (index: number) => BASE + Math.floor(index / RUN) * 1000;
// The time the server gives each line, which a test can change after boot.
let timeOf = inRuns;
const iso = (index: number) => new Date(timeOf(index)).toISOString();
const line = (index: number, target: string) =>
  target === "#chan"
    ? `@msgid=m${index};time=${iso(index)} :alice!u@h PRIVMSG #chan :line ${index}`
    : `@msgid=m${index};time=${iso(index)} :${target}!u@h PRIVMSG tester :line ${index}`;
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `m${from + index}`);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);
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
  timeOf = inRuns;
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
  // What the database holds for the channel: each row in read-back order
  // with the words it is found by, the words left without a row, and the
  // bytes its rows add up to.
  const savedIndex = async () => {
    await db.whenHistoryIdle();
    const opened = indexedDB.open("obby-history");
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    const tx = raw.transaction(["rows", "terms"], "readonly");
    const all = <T>(source: IDBObjectStore | IDBIndex) =>
      new Promise<T[]>((resolve) => {
        const request = source.getAll();
        request.onsuccess = () => resolve(request.result as T[]);
      });
    const rows = await all<{
      id: number;
      time: number;
      msgid?: string;
      bytes: number;
    }>(tx.objectStore("rows").index("conv"));
    const terms = await all<{ term: string; time: number; rowId: number }>(
      tx.objectStore("terms"),
    );
    raw.close();
    const wordsOf = (row: { id: number; time: number }) =>
      terms
        .filter((t) => t.rowId === row.id && t.time === row.time)
        .map((t) => t.term)
        .sort();
    const rowIds = new Set(rows.map((row) => row.id));
    return {
      rows: rows.map((row) => [row.msgid, ...wordsOf(row)].join(" ")),
      orphans: terms.filter((t) => !rowIds.has(t.rowId)).length,
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    };
  };

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
    savedIndex,
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
    it("shows every line of a channel once and in order", async () => {
      const w = await boot("msgid,timestamp");
      w.world.has = range(0, 299);
      await w.loadLatest();
      expect(w.shown()).toEqual(ids(250, 299));

      await w.scrollToTop();

      expect(w.shown()).toEqual(ids(0, 299));
      expect(await w.saved()).toHaveLength(300);
      expect(w.requests("BEFORE").slice(0, 5)).toEqual(
        [250, 200, 150, 100, 50].map(
          (edge) => `CHATHISTORY BEFORE #chan msgid=m${edge} ${PAGE}`,
        ),
      );
    });

    it("shows every line of a private chat once and in order", async () => {
      const w = await boot("msgid,timestamp");
      w.world.has = range(0, 299);
      await w.loadLatest("bob", PM_KEY);

      await w.scrollToTop("bob", PM_KEY);

      expect(w.shown(PM_KEY)).toEqual(ids(0, 299));
      expect(w.requests("BEFORE")[0]).toBe(
        `CHATHISTORY BEFORE bob msgid=m250 ${PAGE}`,
      );
    });

    it("shows every line with saved history turned off", async () => {
      const w = await boot("msgid,timestamp", { keepHistory: false });
      w.world.has = range(0, 299);
      await w.loadLatest();

      await w.scrollToTop();

      expect(w.shown()).toEqual(ids(0, 299));
      expect(w.requests("BEFORE")[0]).toBe(
        `CHATHISTORY BEFORE #chan msgid=m250 ${PAGE}`,
      );
    });

    it("keeps the order on screen when the newest page comes again with saved history turned off", async () => {
      const w = await boot("msgid,timestamp", { keepHistory: false });
      // Every line shares one millisecond.
      timeOf = () => BASE;
      w.world.has = range(0, 299);
      await w.loadLatest();
      await w.history.loadOlderMessages(w.useStore, SERVER, "#chan", BASE);
      await vi.waitFor(() => expect(w.shown()).toEqual(ids(200, 299)), {
        timeout: WRITE_TIMEOUT_MS,
      });

      w.world.has = range(0, 300);
      await w.loadLatest();

      expect(w.shown()).toEqual(ids(200, 300));
    });

    it("settles an older page and keeps its rows when they could not be put in order", async () => {
      const w = await boot("msgid,timestamp");
      w.world.has = range(0, 299);
      await w.loadLatest();
      const move = vi
        .spyOn(w.db, "orderRowsAtPageEdge")
        .mockRejectedValue(new Error("the move failed"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await w.scrollToTop();

        expect(move).toHaveBeenCalled();
        expect(w.shown()).toEqual(ids(0, 299));
        expect((await w.saved()).sort()).toEqual(ids(0, 299).sort());
      } finally {
        warn.mockRestore();
        move.mockRestore();
      }
    });

    it("shows the saved lines in the server's order when they are read back from disk", async () => {
      const w = await boot("msgid,timestamp");
      w.world.has = range(0, 299);
      await w.loadLatest();
      await w.scrollToTop();
      expect(w.shown()).toEqual(ids(0, 299));

      w.useStore.setState({ messages: {} });
      w.sent.length = 0;
      await w.loadLatest();
      await w.scrollToTop();

      expect(w.shown()).toEqual(ids(0, 299));
    });

    it("reads a run longer than several pages back from disk in the server's order", async () => {
      const w = await boot("msgid,timestamp");
      // m100 to m299 share one millisecond.
      timeOf = (index) => (index < 100 ? BASE : BASE + 1000);
      w.world.has = range(0, 299);
      await w.loadLatest();
      await w.scrollToTop();
      expect(w.shown()).toEqual(ids(0, 299));
      expect(await w.saved()).toEqual(ids(0, 299));

      w.useStore.setState({ messages: {} });
      await w.loadLatest();
      await w.scrollToTop();

      expect(w.shown()).toEqual(ids(0, 299));
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

    it("leaves the rows we hold ahead of an older page that shares their millisecond and names no line", async () => {
      const w = await boot("timestamp");
      // m0 came earlier, and m1 to m59 share one millisecond.
      timeOf = (index) => (index === 0 ? BASE : BASE + 1000);
      await w.receiveLive(10);
      w.world.has = range(0, 59);

      w.ircClient.requestChathistoryBefore(
        SERVER,
        "#chan",
        new Date(BASE + 2000).toISOString(),
      );
      await vi.waitFor(async () => expect(await w.saved()).toHaveLength(60), {
        timeout: WRITE_TIMEOUT_MS,
      });
      await sleep(50);
      await w.db.whenHistoryIdle();

      expect(w.requests("BEFORE")).toEqual([
        `CHATHISTORY BEFORE #chan timestamp=${new Date(BASE + 2000).toISOString()} ${PAGE}`,
      ]);
      expect(w.shown()).toEqual(ids(0, 59));
      expect(await w.saved()).toEqual(ids(0, 59));
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

      expect(w.shown()).toEqual(ids(0, 403));
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

      expect(w.shown()).toEqual(ids(0, 803));
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

      expect(seen).toEqual(ids(first, 803));
      expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
      expect(w.requests("AFTER")[0]).toBe(
        `CHATHISTORY AFTER #chan msgid=m102 ${PAGE}`,
      );
    });

    it("keeps the server's order, every row and its search words when a page fetched forward meets the newest page inside one of its milliseconds", async () => {
      const w = await boot("msgid,timestamp");
      // m752 to m756 share a millisecond of their own. The newest page starts
      // at m754 and the last page fetched forward, m750 to m799, runs through it.
      timeOf = (index) =>
        index >= 752 && index <= 756 ? inRuns(751) + 500 : inRuns(index);
      await w.receiveLive(100);
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

      expect(w.requests("AFTER").at(-1)).toBe(
        `CHATHISTORY AFTER #chan msgid=m749 ${PAGE}`,
      );
      expect(seen).toEqual(ids(first, 803));
      expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
      const index = await w.savedIndex();
      expect(index.rows).toEqual(
        range(0, 803).map((line) =>
          line < 10 ? `m${line} line` : `m${line} ${line} line`,
        ),
      );
      expect(index.orphans).toBe(0);
      expect(index.bytes).toBe(await w.db.usageBytes());

      w.useStore.setState({ messages: {} });
      await w.loadLatest();
      await w.scrollToTop();

      expect(w.shown()).toEqual(ids(0, 803));
    });

    it("keeps the server's order on screen and on disk when the gap lies inside a run longer than a page", async () => {
      const w = await boot("msgid,timestamp");
      // m0 came earlier, and m1 to m130 share one millisecond.
      timeOf = (index) => (index === 0 ? BASE : BASE + 1000);
      await w.receiveLive(1);
      w.world.has = range(0, 130);

      await w.loadLatest();
      await vi.waitFor(
        async () => {
          expect(await w.saved()).toHaveLength(131);
          expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
        },
        { timeout: WRITE_TIMEOUT_MS },
      );
      await w.db.whenHistoryIdle();

      expect(w.requests("BEFORE")).toEqual([
        `CHATHISTORY BEFORE #chan msgid=m81 ${PAGE}`,
        `CHATHISTORY BEFORE #chan msgid=m31 ${PAGE}`,
      ]);
      expect(w.shown()).toEqual(ids(0, 130));
      expect(await w.saved()).toEqual(ids(0, 130));

      w.useStore.setState({ messages: {} });
      await w.loadLatest();
      await w.scrollToTop();

      expect(w.shown()).toEqual(ids(0, 130));
    });

    it("puts a page fetched forward ahead of the newest page when both lie in one millisecond behind the line it was asked from", async () => {
      const w = await boot("msgid,timestamp");
      // m0 to m99 came a second apart, and m100 to m219 share one millisecond.
      timeOf = (index) => BASE + Math.min(index, 100) * 1000;
      await w.receiveLive(100);
      w.world.has = range(0, 219);
      w.useStore.setState({ messages: {} });
      await w.loadLatest();
      await vi.waitFor(
        async () => expect(await w.db.gapsFor(SERVER, "#chan")).toHaveLength(1),
        { timeout: WRITE_TIMEOUT_MS },
      );
      await w.openOnMarker(60);
      const first = Number(w.shown()[0].slice(1));

      const seen = await w.pageToPresent();

      expect(w.requests("AFTER")).toEqual([
        `CHATHISTORY AFTER #chan msgid=m99 ${PAGE}`,
        `CHATHISTORY AFTER #chan msgid=m149 ${PAGE}`,
      ]);
      expect(seen).toEqual(ids(first, 219));
      expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
      const index = await w.savedIndex();
      expect(index.rows).toEqual(
        range(0, 219).map((line) =>
          line < 10 ? `m${line} line` : `m${line} ${line} line`,
        ),
      );
      expect(index.orphans).toBe(0);
      expect(index.bytes).toBe(await w.db.usageBytes());

      w.useStore.setState({ messages: {} });
      await w.loadLatest();
      await w.scrollToTop();

      expect(w.shown()).toEqual(ids(0, 219));
    });

    it("puts an older page behind the lines it leaves out when it lies in one millisecond ahead of the line it was asked from", async () => {
      const w = await boot("msgid,timestamp");
      // m0 to m119 share one millisecond, and each later line has its own.
      timeOf = (index) => BASE + 1000 + Math.max(index - 119, 0) * 1000;
      // We saw two lines of that millisecond live, m5 and then m110.
      w.feed(line(5, "#chan"), line(110, "#chan"));
      await vi.waitFor(async () => expect(await w.saved()).toHaveLength(2), {
        timeout: WRITE_TIMEOUT_MS,
      });
      w.world.has = range(0, 169);

      await w.loadLatest();
      // The page before m120, m70 to m119, repeats m110 and so closes the gap.
      await vi.waitFor(
        async () => {
          expect(await w.saved()).toHaveLength(101);
          expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
        },
        { timeout: WRITE_TIMEOUT_MS },
      );
      await sleep(50);
      await w.db.whenHistoryIdle();

      expect(w.requests("BEFORE")).toEqual([
        `CHATHISTORY BEFORE #chan msgid=m120 ${PAGE}`,
      ]);
      expect(w.shown()).toEqual(["m5", ...ids(70, 169)]);
      expect(await w.saved()).toEqual(["m5", ...ids(70, 169)]);
    });

    it("leaves the saved rows alone when a page repeats lines we hold", async () => {
      const w = await boot("msgid,timestamp");
      w.world.has = range(0, 299);
      await w.loadLatest();
      const move = vi.spyOn(w.db, "orderRowsAtPageEdge");

      try {
        w.ircClient.requestChathistoryLatest(SERVER, "#chan");
        await vi.waitFor(() => expect(w.requests("LATEST")).toHaveLength(2));
        await sleep(50);
        await w.db.whenHistoryIdle();

        expect(move).not.toHaveBeenCalled();
        expect(await w.saved()).toEqual(ids(250, 299));
      } finally {
        move.mockRestore();
      }
    });

    it("puts a newest page behind the one line we hold when all of them share a millisecond", async () => {
      const w = await boot("msgid,timestamp");
      timeOf = () => BASE + 1000;
      await w.receiveLive(1);
      w.world.has = range(0, 50);

      await w.loadLatest();

      expect(w.shown()).toEqual(ids(0, 50));
      expect(await w.saved()).toEqual(ids(0, 50));
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

  describe("paging newer through saved lines that share a millisecond", () => {
    it("puts each page read back from disk behind the lines on screen once all of them share the millisecond", async () => {
      const w = await boot("msgid,timestamp");
      // m0 to m9 came earlier, and every later line shares one millisecond.
      timeOf = (index) => (index < 10 ? BASE : BASE + 1000);
      await w.receiveLive(380);
      w.world.has = range(0, 379);
      await w.openOnMarker(0);
      expect(w.shown()).toEqual(ids(0, 59));

      const seen = await w.pageToPresent();

      expect(seen).toEqual(ids(0, 379));
      const shown = w.shown();
      expect(shown).toEqual(ids(380 - shown.length, 379));
      expect(w.requests("AFTER")).toEqual([]);
    });
  });
});
