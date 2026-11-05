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

// A disconnect forgets the server's questions and the pages on their way,
// so one test's catch-up never reaches the next.
const disconnect = () =>
  ircClient.triggerEvent("connectionStateChange", {
    serverId,
    connectionState: "disconnected",
  });

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
    disconnect();
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
    disconnect();
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
    disconnect();
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

  it("keeps the question until the last overlapping answer has ended", async () => {
    const { catchUpHistory, outstandingQuestion } = await import(
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
      messages: {},
    }));
    catchUpHistory(useStore, serverId);
    catchUpHistory(useStore, serverId);
    feed(":soju BATCH +a draft/chathistory-targets", ":soju BATCH -a");
    // The first answer is over; the second still counts as the wake's.
    feed(
      ":soju BATCH +b draft/chathistory-targets",
      "@batch=b :soju CHATHISTORY TARGETS #lobby 2026-10-14T18:14:46.716Z",
      ":soju BATCH -b",
    );
    expect(sent()).toContain("CHATHISTORY LATEST #lobby * 50");
    // The last answer has ended, so the next CHATHISTORY TARGETS belongs to no wake.
    expect(outstandingQuestion(serverId)).toBeUndefined();
  });

  it("asks one page for a conversation named by overlapping answers", async () => {
    const { catchUpHistory } = await import(
      "../../src/store/handlers/connection"
    );
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
            messages: [],
          },
        ],
      })),
      messages: {},
    }));
    catchUpHistory(useStore, serverId);
    catchUpHistory(useStore, serverId);
    feed(
      ":soju BATCH +a draft/chathistory-targets",
      "@batch=a :soju CHATHISTORY TARGETS alice 2026-10-14T18:14:46.716Z",
      ":soju BATCH -a",
      ":soju BATCH +b draft/chathistory-targets",
      "@batch=b :soju CHATHISTORY TARGETS alice 2026-10-14T18:14:46.716Z",
      ":soju BATCH -b",
    );
    expect(
      sent().filter((c) => c === "CHATHISTORY LATEST alice * 50"),
    ).toHaveLength(1);
    // The page was refused, so a later answer may ask again.
    feed(
      ":soju FAIL CHATHISTORY MESSAGE_ERROR LATEST alice :Something went wrong",
    );
    catchUpHistory(useStore, serverId);
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T18:15:46.716Z");
    expect(
      sent().filter((c) => c === "CHATHISTORY LATEST alice * 50"),
    ).toHaveLength(2);
  });

  it("asks again once the page has arrived", async () => {
    const { catchUpHistory } = await import(
      "../../src/store/handlers/connection"
    );
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
            messages: [],
          },
        ],
      })),
      messages: {},
    }));
    catchUpHistory(useStore, serverId);
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T18:14:46.716Z");
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T18:14:46.716Z");
    feed(":soju BATCH +p chathistory alice", ":soju BATCH -p");
    feed(":soju CHATHISTORY TARGETS alice 2026-10-14T18:15:46.716Z");
    expect(
      sent().filter((c) => c === "CHATHISTORY LATEST alice * 50"),
    ).toHaveLength(2);
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
    // An earlier test's question is past its fallback; without a wake, a
    // channel named by the server is left to its rejoin.
    vi.advanceTimersByTime(6 * 60_000);
    feed(":soju CHATHISTORY TARGETS #lobby 2026-10-14T18:14:46.716Z");
    expect(sent().some((l) => l.startsWith("CHATHISTORY LATEST #lobby"))).toBe(
      false,
    );

    catchUpHistory(useStore, serverId);
    expect(
      sent().some((l) => l.startsWith("CHATHISTORY TARGETS timestamp=")),
    ).toBe(true);
    // The answer may take longer than any fixed wait.
    vi.advanceTimersByTime(90_000);
    feed(
      ":soju BATCH +w draft/chathistory-targets",
      "@batch=w :soju CHATHISTORY TARGETS #lobby 2026-10-14T18:14:46.716Z",
      ":soju BATCH -w",
    );
    expect(sent()).toContain("CHATHISTORY LATEST #lobby * 50");
    // Once answered, a later channel report is left to its rejoin again.
    feed(":soju CHATHISTORY TARGETS #lobby 2026-10-14T18:20:00.000Z");
    expect(
      sent().filter((l) => l === "CHATHISTORY LATEST #lobby * 50"),
    ).toHaveLength(1);
  });
});
