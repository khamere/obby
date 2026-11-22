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
const DISK_PAGE = 200;
// The channel is mostly joins and quits: one line in ten is chat, and the
// last stretch before the quiet period holds no chat at all.
const OLD_LINES = 1200;
const LAST_OLD_CHAT = 1120;
const TODAY = [2000, 2001, 2002, 2003, 2004, 2005, 2006];
const TODAY_CHAT = [2000, 2001, 2006];

const timeOf = (index: number) => BASE + index * 1000;
const iso = (index: number) => new Date(timeOf(index)).toISOString();
const isChat = (index: number) =>
  TODAY_CHAT.includes(index) || (index <= LAST_OLD_CHAT && index % 10 === 0);
const oldChat = Array.from({ length: OLD_LINES }, (_, i) => i).filter(isChat);
const chatLine = (index: number) =>
  `@msgid=m${index};time=${iso(index)} :alice!u@h PRIVMSG #chan :line ${index}`;
const line = (index: number) => {
  if (isChat(index)) return chatLine(index);
  const tags = `@msgid=e${index};time=${iso(index)}`;
  if (index >= TODAY[0]) return `${tags} :op!u@h MODE #chan +v alice`;
  return index % 2
    ? `${tags} :guest${index}!u@h JOIN #chan`
    : `${tags} :guest${index - 1}!u@h QUIT :bye`;
};
const chatIds = (indexes: number[]) => indexes.map((index) => `m${index}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Gap = { from: number; to: number; lost: boolean };

// Many records for one stretch: each starts at a saved chat line and ends at
// an event line after it, with no saved line in between.
const PILED_GAPS: Gap[] = [
  [1100, 1103, 1],
  [1100, 1104, 2],
  [1100, 1105, 1],
  [1120, 1150, 4],
  [1120, 1151, 4],
  [1120, 1160, 2],
  [1120, 1190, 9],
].flatMap(([from, to, copies]) =>
  Array.from({ length: copies }, () => ({
    from: timeOf(from),
    to: timeOf(to),
    lost: false,
  })),
);

function writeGapRecords(gaps: Gap[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("obby-history");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(["gaps"], "readwrite");
      for (const gap of gaps)
        tx.objectStore("gaps").add({ server: SERVER, target: "#chan", ...gap });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function boot({
  keepsDisk = false,
  hasToday = true,
  oldestHeld = 0,
} = {}) {
  if (!keepsDisk) globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const { default: useStore } = await import("../../src/store");
  const { default: ircClient } = await import("../../src/lib/ircClient");
  const db = await import("../../src/lib/history/historyDb");
  const history = await import("../../src/store/handlers/history");
  const { messageTime } = await import("../../src/store/helpers");
  const sent: string[] = [];
  const has = [
    ...Array.from({ length: OLD_LINES }, (_, i) => i).slice(oldestHeld),
    ...(hasToday ? TODAY : []),
  ];
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
  const serve = (raw: string) => {
    const request =
      /^CHATHISTORY (LATEST|BEFORE|AFTER) #chan (?:timestamp=(\S+)|\*) (\d+)/.exec(
        raw.trim(),
      );
    if (!request) return;
    const [, subcommand, value, asked] = request;
    const limit = Number(asked);
    const at = value ? Date.parse(value) : 0;
    const picked =
      subcommand === "LATEST"
        ? has.slice(-limit)
        : subcommand === "BEFORE"
          ? has.filter((i) => timeOf(i) < at).slice(-limit)
          : has.filter((i) => timeOf(i) > at).slice(0, limit);
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
    capabilities: CAPS,
    privateChats: [],
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
        globalSettings: {
          ...state.globalSettings,
          keepHistory: true,
          showJoinsParts: false,
          showQuits: false,
        },
      }) as unknown as AppState,
  );
  feed(
    ":irc.test 005 tester CHATHISTORY=1000 MSGREFTYPES=timestamp :are supported by this server",
  );

  const shownChat = () =>
    (useStore.getState().messages[KEY] ?? []).flatMap((m) =>
      m.msgid?.startsWith("m") ? [m.msgid] : [],
    );
  const channel = () => useStore.getState().servers[0].channels[0];
  const openGaps = async () =>
    (await db.gapsFor(SERVER, "#chan")).filter((gap) => !gap.lost);
  const requests = (subcommand: string) =>
    sent.filter((raw) => raw.startsWith(`CHATHISTORY ${subcommand} `));

  const saveChatLines = async (indexes: number[]) => {
    await db.appendRows(
      indexes.map((index) => ({
        server: SERVER,
        target: "#chan",
        time: timeOf(index),
        key: `m${index}`,
        msgid: `m${index}`,
        raw: chatLine(index),
      })),
    );
  };

  const loadLatest = async () => {
    const replies = batchCounter;
    ircClient.requestChathistoryLatest(SERVER, "#chan");
    await vi.waitFor(() => expect(batchCounter).toBeGreaterThan(replies), {
      timeout: WRITE_TIMEOUT_MS,
    });
    await sleep(30);
    await db.whenHistoryIdle();
    await sleep(30);
    await db.whenHistoryIdle();
  };

  // We load older pages the way the list does at its top: one request at a
  // time, each from the oldest message on screen, while the chat offers more
  // and until three tries in a row add nothing.
  const scrollToTop = async () => {
    let quiet = 0;
    for (let step = 0; step < 100 && quiet < 3; step++) {
      if (channel().hasMoreHistory === false) break;
      const count = shownChat().length;
      const top = useStore.getState().messages[KEY]?.[0];
      await history.loadOlderMessages(
        useStore,
        SERVER,
        "#chan",
        top ? messageTime(top) : Date.now(),
      );
      await sleep(30);
      await vi.waitFor(() => expect(channel().isLoadingHistory).toBeFalsy(), {
        timeout: WRITE_TIMEOUT_MS,
      });
      await db.whenHistoryIdle();
      await sleep(30);
      quiet = shownChat().length === count ? quiet + 1 : 0;
    }
  };

  return {
    db,
    shownChat,
    channel,
    openGaps,
    requests,
    saveChatLines,
    loadLatest,
    scrollToTop,
  };
}

// A device that saved every chat line of the channel and holds a pile of gap
// records for the event-only stretches after them.
async function deviceWithPiledGaps() {
  const seed = await boot();
  await seed.saveChatLines([...oldChat, ...TODAY_CHAT]);
  await writeGapRecords(PILED_GAPS);
  await seed.db.whenHistoryIdle();
}

describe("gap records piled up over an event-only stretch", {
  timeout: 4 * WRITE_TIMEOUT_MS,
}, () => {
  it("shows the saved lines below the stretch and ends the offer of older history", async () => {
    await deviceWithPiledGaps();
    const w = await boot({ keepsDisk: true });
    await w.loadLatest();
    expect(w.shownChat()).toEqual(chatIds(TODAY_CHAT));

    await w.scrollToTop();

    expect(w.shownChat()).toEqual(chatIds([...oldChat, ...TODAY_CHAT]));
    expect(await w.openGaps()).toEqual([]);
    expect(w.channel().hasMoreHistory).toBe(false);
  });

  it("merges the pile into one record per stretch when the saved history opens", async () => {
    await deviceWithPiledGaps();
    const w = await boot({ keepsDisk: true });

    expect(
      (await w.db.gapsFor(SERVER, "#chan")).map(({ from, to, lost }) => ({
        from,
        to,
        lost,
      })),
    ).toEqual([
      { from: timeOf(1100), to: timeOf(1105), lost: false },
      { from: timeOf(1120), to: timeOf(1190), lost: false },
    ]);
  });

  it("asks the server for nothing it already saved on the next load", async () => {
    await deviceWithPiledGaps();
    const first = await boot({ keepsDisk: true });
    await first.loadLatest();
    await first.scrollToTop();
    const walked = first.requests("BEFORE").length;

    const next = await boot({ keepsDisk: true });
    await next.loadLatest();
    await next.scrollToTop();

    expect(next.shownChat()).toEqual(chatIds([...oldChat, ...TODAY_CHAT]));
    expect(next.channel().hasMoreHistory).toBe(false);
    expect(walked).toBeLessThanOrEqual(OLD_LINES / DISK_PAGE);
    expect(next.requests("BEFORE").length).toBeLessThanOrEqual(1);
  });

  it("records no second gap for a stretch that already has one", async () => {
    const seed = await boot();
    await seed.saveChatLines(oldChat);
    await seed.db.whenHistoryIdle();

    for (let load = 0; load < 3; load++) {
      const w = await boot({ keepsDisk: true, hasToday: false });
      await w.loadLatest();
      expect(await w.openGaps()).toHaveLength(1);
    }
  });

  it("ends every gap below the time the server answered with an empty page", async () => {
    const seed = await boot();
    // The server keeps lines 1000 and up; the device also holds older ones.
    const ancient = oldChat.filter((index) => index <= 100);
    const held = oldChat.filter((index) => index >= 1000);
    await seed.saveChatLines([...ancient, ...held, ...TODAY_CHAT]);
    await writeGapRecords(
      [
        [20, 25],
        [50, 55],
        [100, 995],
      ].map(([from, to]) => ({
        from: timeOf(from),
        to: timeOf(to),
        lost: false,
      })),
    );
    await seed.db.whenHistoryIdle();

    const w = await boot({ keepsDisk: true, oldestHeld: 1000 });
    await w.loadLatest();
    await w.scrollToTop();

    expect(w.shownChat()).toEqual(
      chatIds([...ancient, ...held, ...TODAY_CHAT]),
    );
    expect(await w.openGaps()).toEqual([]);
    expect(w.requests("BEFORE")).toEqual([
      `CHATHISTORY BEFORE #chan timestamp=${iso(995)} ${DISK_PAGE}`,
      `CHATHISTORY BEFORE #chan timestamp=${iso(0)} ${DISK_PAGE}`,
    ]);

    const next = await boot({ keepsDisk: true, oldestHeld: 1000 });
    await next.loadLatest();
    await next.scrollToTop();

    expect(next.requests("BEFORE")).toEqual([
      `CHATHISTORY BEFORE #chan timestamp=${iso(0)} ${DISK_PAGE}`,
    ]);
  });
});
