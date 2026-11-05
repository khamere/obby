import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import type { Message, Server } from "../../src/types";

const serverId = "s1";

function seed(capabilities: string[] = ["draft/chathistory"]) {
  ircClient.nicks.set(serverId, "me");
  const server = {
    id: serverId,
    name: "soju",
    host: "bouncer.test",
    port: 6697,
    isConnected: true,
    users: [],
    channels: [],
    privateChats: [],
    capabilities,
  } as unknown as Server;
  // The client answers chathistory questions from its own server record.
  ircClient.servers.set(serverId, { ...server } as never);
  useStore.setState({
    servers: [server],
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
    ircClient.servers.delete(serverId);
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
    ircClient.servers.delete(serverId);
  });

  it("reopens an unpinned private chat for a nick target", () => {
    // MONITOR goes out only once ISUPPORT has shown the server has it.
    feed(
      ":soju 005 me MONITOR=100 :are supported by this server",
      ":soju 376 me :End of /MOTD command.",
    );
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T18:14:42.492Z");
    vi.runOnlyPendingTimers();
    expect(pms()).toEqual([{ username: "alice", isPinned: false }]);
    // Its history is loaded when the chat is opened on screen.
    expect(sent()).toContain("MONITOR + alice");
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

  it("fetches the latest page of an open private chat that has newer activity", () => {
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        privateChats: [
          {
            id: "pm-alice",
            username: "alice",
            serverId,
            unreadCount: 0,
            isMentioned: false,
            isPinned: true,
          },
        ],
      })),
      messages: {
        [`${serverId}-pm-alice`]: [
          {
            id: "m1",
            msgid: "m1",
            type: "message",
            content: "hi",
            timestamp: new Date("2026-10-14T10:00:00.000Z"),
            userId: "me",
            channelId: "pm-alice",
            serverId,
            reactions: [],
            replyMessage: null,
            mentioned: [],
          },
        ],
      },
    }));
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T18:14:42.492Z");
    vi.runOnlyPendingTimers();
    expect(sent()).toContain("CHATHISTORY LATEST alice * 50");
    expect(pms()).toEqual([{ username: "alice", isPinned: true }]);
  });

  it("leaves an open private chat alone when nothing newer happened", () => {
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        privateChats: [
          {
            id: "pm-alice",
            username: "alice",
            serverId,
            unreadCount: 0,
            isMentioned: false,
            isPinned: true,
          },
        ],
      })),
      messages: {
        [`${serverId}-pm-alice`]: [
          {
            id: "m1",
            msgid: "m1",
            type: "message",
            content: "hi",
            timestamp: new Date("2026-10-14T19:00:00.000Z"),
            userId: "alice",
            channelId: "pm-alice",
            serverId,
            reactions: [],
            replyMessage: null,
            mentioned: [],
          },
        ],
      },
    }));
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T18:14:42.492Z");
    vi.runOnlyPendingTimers();
    expect(sent().some((l) => l.startsWith("CHATHISTORY LATEST"))).toBe(false);
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

describe("catching up after a wake", () => {
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
    ircClient.servers.delete(serverId);
  });

  it("measures the answer against the messages from before the question", async () => {
    const { catchUpHistory } = await import(
      "../../src/store/handlers/connection"
    );
    const line = (id: string, at: string): Message => ({
      id,
      msgid: id,
      type: "message",
      content: id,
      timestamp: new Date(at),
      userId: "alice",
      channelId: "pm-alice",
      serverId,
      reactions: [],
      replyMessage: null,
      mentioned: [],
    });
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        privateChats: [
          {
            id: "pm-alice",
            username: "alice",
            serverId,
            unreadCount: 0,
            isMentioned: false,
            isPinned: true,
          },
        ],
      })),
      messages: {
        [`${serverId}-pm-alice`]: [line("old", "2026-10-14T10:00:00.000Z")],
      },
    }));
    catchUpHistory(useStore, serverId);
    // A line arrives live while the answer is on its way.
    useStore.setState((state) => ({
      messages: {
        [`${serverId}-pm-alice`]: [
          ...(state.messages[`${serverId}-pm-alice`] ?? []),
          line("live", "2026-10-14T18:14:42.492Z"),
        ],
      },
    }));
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T18:14:42.492Z");
    expect(sent()).toContain("CHATHISTORY LATEST alice * 50");
  });

  it("tells channels from private chats by the server's channel types", () => {
    feed(":soju 005 me CHANTYPES=#~ :are supported by this server");
    feed(":soju CHATHISTORY TARGETS ~ops 2026-10-14T18:14:46.716Z");
    vi.runOnlyPendingTimers();
    expect(pms()).toEqual([]);
  });

  it("asks for a day of activity and refreshes channels that fell behind", async () => {
    const { catchUpHistory } = await import(
      "../../src/store/handlers/connection"
    );
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        channels: [
          {
            id: "ch-lobby",
            name: "#lobby",
            serverId,
            unreadCount: 0,
            isMentioned: false,
            messages: [],
            users: [],
            topic: "",
            isPrivate: false,
          },
        ],
      })),
      messages: {
        [`${serverId}-ch-lobby`]: [
          {
            id: "m1",
            msgid: "m1",
            type: "message",
            content: "old",
            timestamp: new Date("2026-10-14T10:00:00.000Z"),
            userId: "bob",
            channelId: "ch-lobby",
            serverId,
            reactions: [],
            replyMessage: null,
            mentioned: [],
          },
        ],
      },
    }));
    // An earlier wake's window is over; without a wake, a channel named by
    // the server is left to its rejoin.
    vi.advanceTimersByTime(31_000);
    feed(":soju CHATHISTORY TARGETS #lobby 2026-10-14T18:14:46.716Z");
    expect(sent().some((l) => l.startsWith("CHATHISTORY LATEST #lobby"))).toBe(
      false,
    );

    catchUpHistory(useStore, serverId);
    expect(
      sent().some((l) => l.startsWith("CHATHISTORY TARGETS timestamp=")),
    ).toBe(true);
    feed(":soju CHATHISTORY TARGETS #lobby 2026-10-14T18:14:46.716Z");
    expect(sent()).toContain("CHATHISTORY LATEST #lobby * 50");
  });
});
