import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import type { Server } from "../../src/types";

const serverId = "s1";

function seed(capabilities: string[] = ["draft/chathistory"]) {
  ircClient.nicks.set(serverId, "me");
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "soju",
        host: "bouncer.test",
        port: 6697,
        isConnected: true,
        users: [],
        channels: [],
        privateChats: [],
        capabilities,
      } as unknown as Server,
    ],
    messages: {},
    activeBatches: {},
    processedMessageIds: new Set(),
  });
}

function register() {
  ircClient.triggerEvent("ready", {
    serverId,
    serverName: "soju",
    nickname: "me",
  });
}

function feed(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), serverId);
}

const sent = () =>
  (ircClient.sendRaw as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter((c) => c[0] === serverId)
    .map((c) => c[1] as string);

const pms = () =>
  (useStore.getState().servers[0].privateChats ?? []).map((pc) => ({
    username: pc.username,
    isPinned: !!pc.isPinned,
  }));

describe("CHATHISTORY TARGETS on connect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    ircClient.nicks.delete(serverId);
  });

  it("asks the server which conversations had recent activity", () => {
    register();
    vi.runOnlyPendingTimers();
    const targets = sent().filter((l) => l.startsWith("CHATHISTORY TARGETS"));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatch(
      /^CHATHISTORY TARGETS timestamp=\d{4}-\d\d-\d\dT\S+Z timestamp=\d{4}-\d\d-\d\dT\S+Z \d+$/,
    );
  });

  it("does not ask when the server lacks draft/chathistory", () => {
    seed([]);
    register();
    vi.runOnlyPendingTimers();
    expect(sent().some((l) => l.startsWith("CHATHISTORY TARGETS"))).toBe(false);
  });
});

describe("CHATHISTORY TARGETS replies", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    ircClient.nicks.delete(serverId);
  });

  it("reopens an unpinned private chat for a nick target and fetches its history", () => {
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T18:14:42.492Z");
    vi.runOnlyPendingTimers();
    expect(pms()).toEqual([{ username: "alice", isPinned: false }]);
    expect(sent()).toContain("CHATHISTORY LATEST alice * 50");
  });

  it("ignores channel targets and our own nick", () => {
    feed(
      ":soju CHATHISTORY TARGETS #lobby 2026-10-14T18:14:46.716Z",
      ":soju CHATHISTORY TARGETS &local 2026-10-14T18:14:46.716Z",
      ":soju CHATHISTORY TARGETS me 2026-10-14T18:14:46.716Z",
    );
    vi.runOnlyPendingTimers();
    expect(pms()).toEqual([]);
  });

  it("handles targets delivered inside a draft/chathistory-targets batch", () => {
    feed(
      ":soju BATCH +t draft/chathistory-targets",
      "@batch=t :soju CHATHISTORY TARGETS bob 2026-10-14T18:14:42.492Z",
      "@batch=t :soju CHATHISTORY TARGETS #lobby 2026-10-14T18:14:46.716Z",
      ":soju BATCH -t",
    );
    vi.runOnlyPendingTimers();
    expect(pms()).toEqual([{ username: "bob", isPinned: false }]);
  });

  it("does not duplicate or re-pin an existing private chat", () => {
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        privateChats: [
          {
            id: "alice",
            username: "Alice",
            serverId,
            unreadCount: 0,
            isMentioned: false,
            isPinned: true,
          },
        ],
      })),
    }));
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T18:14:42.492Z");
    vi.runOnlyPendingTimers();
    expect(pms()).toEqual([{ username: "Alice", isPinned: true }]);
  });
});
