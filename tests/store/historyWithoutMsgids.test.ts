import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { AppState } from "../../src/store";

vi.mock("../../src/lib/notificationSounds", () => ({
  playNotificationSound: vi.fn(),
  shouldPlayNotificationSound: vi.fn(() => false),
}));

// soju's file message store replays history without msgids. The recorder
// saves none of those lines, so an older channel page fetched "for the disk"
// would never show; such servers get their older pages shown directly.
const SERVER = "srv";
const KEY = `${SERVER}-chan-1`;
const BASE = Date.parse("2026-01-01T12:00:00.000Z");
const timeOf = (index: number) => BASE + index * 1000;
const line = (index: number, batch: string) =>
  `@batch=${batch};time=${new Date(timeOf(index)).toISOString()} :alice!u@h PRIVMSG #chan :line ${index}`;

async function boot() {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  const { default: useStore } = await import("../../src/store");
  const { default: ircClient } = await import("../../src/lib/ircClient");
  const history = await import("../../src/store/handlers/history");
  const sent: string[] = [];
  const client = ircClient as unknown as {
    sockets: Map<string, unknown>;
    handleMessage(data: string, serverId: string): void;
  };
  client.sockets.set(SERVER, {
    readyState: WebSocket.OPEN,
    send: (raw: string) => sent.push(raw),
    close: () => {},
  });
  const server = {
    id: SERVER,
    name: "Bouncer",
    host: "irc.test",
    port: 6667,
    isConnected: true,
    capabilities: ["draft/chathistory", "message-tags", "batch"],
    privateChats: [],
    channels: [
      {
        id: "chan-1",
        name: "#chan",
        isPrivate: false,
        serverId: SERVER,
        unreadCount: 0,
        isMentioned: false,
        readMarker: null,
        messages: [],
        users: [],
      },
    ],
  };
  ircClient.servers.set(SERVER, { ...server, channels: [] } as never);
  ircClient.nicks.set(SERVER, "tester");
  useStore.setState({ servers: [server] } as unknown as AppState);
  const feed = (...lines: string[]) =>
    client.handleMessage(lines.join("\r\n"), SERVER);
  const shown = () => useStore.getState().messages[KEY] ?? [];
  return { useStore, history, sent, feed, shown };
}

describe("history pages without msgids", () => {
  it("shows the older page from the reply instead of waiting for the disk", async () => {
    const w = await boot();
    // The newest page, as soju sends it: times but no msgids.
    w.feed(
      ":soju BATCH +l chathistory #chan",
      ...Array.from({ length: 50 }, (_, i) => line(100 + i, "l")),
      ":soju BATCH -l",
    );
    await vi.waitFor(() => expect(w.shown()).toHaveLength(50));
    await new Promise((r) => setTimeout(r, 50));

    const asked = await w.history.loadOlderMessages(
      w.useStore,
      SERVER,
      "#chan",
      timeOf(100),
    );
    expect(asked).toBe(true);
    const request = w.sent.find((l) =>
      l.startsWith("CHATHISTORY BEFORE #chan"),
    );
    expect(request).toBeDefined();

    w.feed(
      ":soju BATCH +b chathistory #chan",
      ...Array.from({ length: 50 }, (_, i) => line(50 + i, "b")),
      ":soju BATCH -b",
    );
    await vi.waitFor(() => expect(w.shown()).toHaveLength(100));
    expect(w.shown()[0].content).toBe("line 50");
    await vi.waitFor(() =>
      expect(
        w.useStore.getState().servers[0].channels[0].isLoadingHistory,
      ).toBe(false),
    );
  });
});
