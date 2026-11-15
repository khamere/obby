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
const CAPS = ["draft/chathistory", "message-tags"];

const timeOf = (index: number) => BASE + index * 1000;
const iso = (index: number) => new Date(timeOf(index)).toISOString();
const line = (index: number, target = "#chan") =>
  `@msgid=m${index};time=${iso(index)} :alice!u@h PRIVMSG ${target} :line ${index}`;
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `m${from + index}`);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

type Script = {
  // The line numbers the server keeps, which it serves when set.
  has?: number[];
  maxLines: number;
  answer?: (subcommand: string, at: number | undefined) => number[] | undefined;
};

async function boot(isupport?: number) {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const { default: useStore } = await import("../../src/store");
  const { default: ircClient } = await import("../../src/lib/ircClient");
  const db = await import("../../src/lib/history/historyDb");
  const history = await import("../../src/store/handlers/history");
  const { jumpToMessage } = await import("../../src/lib/jumpToMessage");
  const sent: string[] = [];
  const script: Script = { maxLines: Number.POSITIVE_INFINITY };
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
  const serve = (raw: string) => {
    const request =
      /^CHATHISTORY (LATEST|BEFORE|AFTER|AROUND) (\S+) (?:timestamp=(\S+)|\*) (\d+)/.exec(
        raw.trim(),
      );
    if (!request) return;
    const [, subcommand, target, stamp, asked] = request;
    const at = stamp ? Date.parse(stamp) : undefined;
    const limit = Math.min(Number(asked), script.maxLines);
    const scripted = script.answer?.(subcommand, at);
    const has = script.has;
    if (!scripted && !has) return;
    const pick = () => {
      if (scripted) return scripted;
      const all = has ?? [];
      if (subcommand === "LATEST" || at === undefined) return all.slice(-limit);
      if (subcommand === "BEFORE")
        return all.filter((i) => timeOf(i) < at).slice(-limit);
      if (subcommand === "AFTER")
        return all.filter((i) => timeOf(i) > at).slice(0, limit);
      return all
        .filter((i) => Math.abs(timeOf(i) - at) <= (limit / 2) * 1000)
        .slice(0, limit);
    };
    setTimeout(() => feed(...page(pick(), target)), 0);
  };
  client.sockets.set(SERVER, {
    readyState: WebSocket.OPEN,
    send: (raw: string) => {
      sent.push(raw);
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
  useStore.setState({ servers: [server] } as unknown as AppState);
  if (isupport !== undefined)
    feed(
      `:irc.test 005 tester CHATHISTORY=${isupport} :are supported by this server`,
    );

  const shown = () =>
    (useStore.getState().messages[KEY] ?? []).flatMap((m) =>
      m.msgid ? [m.msgid] : [],
    );
  const window = () => useStore.getState().historyWindows[KEY];
  const savedCount = async () =>
    (await db.newestEventRows(SERVER, "#chan", 5000)).length;
  const requests = (subcommand: string) =>
    sent.filter((raw) => raw.startsWith(`CHATHISTORY ${subcommand} `));

  // We saved the first `saved` lines live, slept, and the newest page on
  // reconnect starts at `latestFrom`, which leaves the lines in between only
  // on the server.
  const wake = async (latestFrom: number, saved = 100) => {
    feed(...range(0, saved - 1).map((index) => line(index)));
    await vi.waitFor(async () => expect(await savedCount()).toBe(saved), {
      timeout: WRITE_TIMEOUT_MS,
    });
    useStore.setState({ messages: {} });
    ircClient.requestChathistoryLatest(SERVER, "#chan");
    feed(...page(range(latestFrom, latestFrom + 49)));
    await vi.waitFor(
      async () =>
        expect(await db.gapsFor(SERVER, "#chan")).toMatchObject([
          { from: timeOf(saved - 1), to: timeOf(latestFrom) },
        ]),
      { timeout: WRITE_TIMEOUT_MS },
    );
    sent.length = 0;
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
  const jumpTo = (index: number) =>
    jumpToMessage({
      serverId: SERVER,
      target: "#chan",
      time: timeOf(index),
      msgid: `m${index}`,
      nick: "alice",
      text: `line ${index}`,
    });
  const pageNewer = () => history.loadNewerMessages(useStore, SERVER, "#chan");

  // We page newer until the window joins the present and collect every
  // message in the order it came on screen.
  const pageToPresent = async () => {
    const seen = [...shown()];
    for (let step = 0; step < 100 && window(); step++) {
      await pageNewer();
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
    script,
    feed,
    page,
    shown,
    window,
    savedCount,
    requests,
    wake,
    openOnMarker,
    jumpTo,
    pageNewer,
    pageToPresent,
  };
}

describe("history paging steps", { timeout: 2 * WRITE_TIMEOUT_MS }, () => {
  describe("page size", () => {
    // The line each kind of request carries for a server stating `isupport`.
    async function requestLines(isupport?: number) {
      const w = await boot(isupport);
      await w.wake(500);

      w.ircClient.requestChathistoryLatest(SERVER, "#chan");
      const latest = w.sent.at(-1);
      w.feed(...w.page(range(500, 549)));

      w.useStore.setState((state) => ({
        messages: {
          ...state.messages,
          [KEY]: (state.messages[KEY] ?? []).filter((m) => m.msgid),
        },
      }));
      const older = w.history.loadOlderMessages(
        w.useStore,
        SERVER,
        "#chan",
        timeOf(500),
      );
      await vi.waitFor(() => expect(w.requests("BEFORE")).toHaveLength(1));
      const diskBefore = w.requests("BEFORE").at(-1);
      // The page fetched forward waits for this one, since both fill the same gap.
      w.feed(...w.page(range(300, 499)));
      await older;
      await vi.waitFor(
        async () =>
          expect(await w.db.gapsFor(SERVER, "#chan")).toMatchObject([
            { to: timeOf(300) },
          ]),
        { timeout: WRITE_TIMEOUT_MS },
      );

      await w.history.loadOlderMessages(w.useStore, SERVER, "bob", timeOf(500));
      const shownBefore = w.requests("BEFORE").at(-1);

      await w.openOnMarker(99);
      void w.pageNewer();
      await vi.waitFor(() => expect(w.requests("AFTER")).toHaveLength(1));
      const after = w.requests("AFTER")[0];

      void w.history.saveMessagesAround(
        w.useStore,
        SERVER,
        "#chan",
        timeOf(200),
      );
      await vi.waitFor(() => expect(w.requests("AROUND")).toHaveLength(1));
      const around = w.requests("AROUND")[0];

      return { latest, after, diskBefore, shownBefore, around };
    }

    it("asks for 200 lines for pages fetched to disk when the server allows 1000", async () => {
      expect(await requestLines(1000)).toEqual({
        latest: "CHATHISTORY LATEST #chan * 50",
        after: `CHATHISTORY AFTER #chan timestamp=${iso(99)} 200`,
        diskBefore: `CHATHISTORY BEFORE #chan timestamp=${iso(500)} 200`,
        shownBefore: `CHATHISTORY BEFORE bob timestamp=${iso(500)} 50`,
        around: `CHATHISTORY AROUND #chan timestamp=${iso(200)} 50`,
      });
    });

    it("asks for the server's own limit when it is below 200", async () => {
      expect(await requestLines(30)).toEqual({
        latest: "CHATHISTORY LATEST #chan * 30",
        after: `CHATHISTORY AFTER #chan timestamp=${iso(99)} 30`,
        diskBefore: `CHATHISTORY BEFORE #chan timestamp=${iso(500)} 30`,
        shownBefore: `CHATHISTORY BEFORE bob timestamp=${iso(500)} 30`,
        around: `CHATHISTORY AROUND #chan timestamp=${iso(200)} 30`,
      });
    });

    it("asks for 50 lines when the server states no limit", async () => {
      const unstated = {
        latest: "CHATHISTORY LATEST #chan * 50",
        after: `CHATHISTORY AFTER #chan timestamp=${iso(99)} 50`,
        diskBefore: `CHATHISTORY BEFORE #chan timestamp=${iso(500)} 50`,
        shownBefore: `CHATHISTORY BEFORE bob timestamp=${iso(500)} 50`,
        around: `CHATHISTORY AROUND #chan timestamp=${iso(200)} 50`,
      };
      expect(await requestLines()).toEqual(unstated);
      expect(await requestLines(0)).toEqual(unstated);
    });
  });

  it("crosses a 1000-line gap in at most 6 requests and shows every line once, in order", async () => {
    const w = await boot(1000);
    await w.wake(1100);
    w.script.has = range(0, 1149);
    await w.openOnMarker(99);

    const seen = await w.pageToPresent();

    expect(seen).toEqual(ids(50, 1149));
    expect(w.requests("AFTER").length).toBeLessThanOrEqual(6);
    expect(new Set(w.requests("AFTER")).size).toBe(w.requests("AFTER").length);
    expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
  });

  it("fetches the next page while the last saved rows before the gap are on screen", async () => {
    const w = await boot(1000);
    await w.wake(500);
    await w.jumpTo(10);
    expect(w.shown()).toEqual(ids(0, 60));

    await w.pageNewer();

    expect(w.shown()).toEqual(ids(0, 99));
    expect(w.requests("AFTER")).toEqual([
      `CHATHISTORY AFTER #chan timestamp=${iso(99)} 200`,
    ]);

    const waiting = w.pageNewer();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.requests("AFTER")).toHaveLength(1);

    w.feed(...w.page(range(100, 299)));
    await waiting;
    expect(w.shown()).toEqual(ids(0, 149));
    expect(w.requests("AFTER")).toHaveLength(1);
  });

  it("fetches ahead when a step ends a few rows before the gap", async () => {
    const w = await boot(1000);
    await w.wake(500, 120);
    await w.jumpTo(10);
    expect(w.shown()).toEqual(ids(0, 60));

    await w.pageNewer();

    expect(w.shown()).toEqual(ids(0, 110));
    expect(w.requests("AFTER")).toEqual([
      `CHATHISTORY AFTER #chan timestamp=${iso(119)} 200`,
    ]);
  });

  it.each([0, 1, 2, 3, 5, 8, 12, 20])(
    "asks past the gap's current edge when a page lands %i ms into a step",
    async (DELAY) => {
      const w = await boot(1000);
      await w.wake(500, 120);
      await w.jumpTo(10);
      await w.pageNewer();
      expect(w.requests("AFTER")).toHaveLength(1);

      const step = w.pageNewer();
      await new Promise((resolve) => setTimeout(resolve, DELAY));
      w.feed(...w.page(range(120, 319)));
      await step;
      w.script.has = range(0, 549);
      const seen = await w.pageToPresent();

      expect(seen).toEqual(ids(0, 549));
      const edges = w.requests("AFTER").map((raw) => raw.split(" ")[3]);
      expect(new Set(edges).size).toBe(edges.length);
    },
  );

  it("fetches ahead again only when less than one step of saved rows is left", async () => {
    const w = await boot(1000);
    await w.wake(500);
    w.script.has = range(0, 549);
    await w.jumpTo(10);

    await w.pageNewer();
    await w.pageNewer();
    await vi.waitFor(async () => expect(await w.savedCount()).toBe(350), {
      timeout: WRITE_TIMEOUT_MS,
    });
    expect(w.shown().at(-1)).toBe("m149");

    await w.pageNewer();
    await w.pageNewer();
    expect(w.shown().at(-1)).toBe("m249");
    expect(w.requests("AFTER")).toHaveLength(1);

    await w.pageNewer();
    expect(w.shown().at(-1)).toBe("m299");
    expect(w.requests("AFTER")).toEqual([
      `CHATHISTORY AFTER #chan timestamp=${iso(99)} 200`,
      `CHATHISTORY AFTER #chan timestamp=${iso(299)} 200`,
    ]);
  });

  it("leaves a window that replaced the old one untouched when the page fetched ahead lands", async () => {
    const w = await boot(1000);
    await w.wake(700, 300);
    await w.jumpTo(210);
    await w.pageNewer();
    expect(w.shown()).toEqual(ids(161, 299));
    expect(w.requests("AFTER")).toHaveLength(1);
    const waiting = w.pageNewer();

    await w.jumpTo(20);
    const replaced = w.window();
    expect(w.shown()).toEqual(ids(0, 70));

    w.feed(...w.page(range(300, 499)));
    await waiting;
    await vi.waitFor(async () => expect(await w.savedCount()).toBe(550), {
      timeout: WRITE_TIMEOUT_MS,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(w.window()).toBe(replaced);
    expect(w.shown()).toEqual(ids(0, 70));
    expect(w.requests("AFTER")).toHaveLength(1);
  });

  it("leaves the present untouched when the page fetched ahead lands after the window closed", async () => {
    const w = await boot(1000);
    await w.wake(500);
    await w.jumpTo(10);
    await w.pageNewer();
    expect(w.requests("AFTER")).toHaveLength(1);

    w.history.showPresent(w.useStore, SERVER, "#chan");
    const present = w.shown();
    expect(present).toEqual(ids(500, 549));

    // The reply to the fetch ahead comes first, then the newest page we asked for on return.
    w.feed(...w.page(range(100, 299)), ...w.page(range(500, 549)));
    await vi.waitFor(async () => expect(await w.savedCount()).toBe(350), {
      timeout: WRITE_TIMEOUT_MS,
    });

    expect(w.window()).toBeUndefined();
    expect(w.shown()).toEqual(present);
  });

  it("stops a search fill after 2000 lines asked of the server", async () => {
    const w = await boot(1000);
    await w.wake(5000);
    w.script.has = range(0, 5049);
    let isDone = false;

    const cancel = w.history.fillGapsForSearch(
      w.useStore,
      { kind: "chat", serverId: SERVER, target: "#chan" },
      (_gaps, isFetching) => {
        isDone = !isFetching;
      },
    );
    await vi.waitFor(() => expect(isDone).toBe(true), {
      timeout: 30_000,
      interval: 250,
    });
    cancel();

    const asked = w.requests("BEFORE");
    expect(asked).toHaveLength(10);
    expect(asked.every((raw) => raw.endsWith(" 200"))).toBe(true);
  }, 40_000);

  it("keeps going when the server sends fewer lines than asked", async () => {
    const w = await boot(1000);
    await w.wake(200);
    w.script.has = range(0, 249);
    w.script.maxLines = 30;
    await w.openOnMarker(99);

    const seen = await w.pageToPresent();

    expect(seen).toEqual(ids(50, 249));
    expect(w.requests("AFTER")).toHaveLength(4);
    expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
  });

  it("closes the gap when the server has nothing after its older edge", async () => {
    const w = await boot(1000);
    await w.wake(500);
    w.script.has = [...range(0, 99), ...range(500, 549)];
    w.script.answer = (subcommand) => (subcommand === "AFTER" ? [] : undefined);
    await w.openOnMarker(99);

    const seen = await w.pageToPresent();

    expect(seen).toEqual([...ids(50, 99), ...ids(500, 549)]);
    expect(w.requests("AFTER")).toEqual([
      `CHATHISTORY AFTER #chan timestamp=${iso(99)} 200`,
    ]);
    expect(await w.db.gapsFor(SERVER, "#chan")).toEqual([]);
  });
});
