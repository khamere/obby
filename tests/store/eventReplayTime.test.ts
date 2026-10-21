import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";

// A bouncer with draft/event-playback replays KICK and TOPIC through
// chathistory on every reconnect. They must show at the server's time, once,
// and a replayed KICK must not remove anyone from the live member list.
let serverId = "";
let counter = 0;
const HIST_TIME = "2026-10-20T07:21:00.000Z";

function seed() {
  serverId = `replay-srv-${++counter}`;
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "test",
        host: "irc.test",
        port: 6697,
        channels: [
          {
            id: `${serverId}-chan`,
            name: "#help",
            isPrivate: false,
            serverId,
            unreadCount: 0,
            isMentioned: false,
            messages: [],
            users: [
              { id: "u1", username: "tryz", isOnline: true, status: "" },
              { id: "u2", username: "op", isOnline: true, status: "@" },
            ],
          },
        ],
        privateChats: [],
        isConnected: true,
        users: [],
      },
    ],
    messages: {},
    activeBatches: {
      [serverId]: {
        hist1: {
          type: "chathistory",
          parameters: ["#help"],
          events: [],
          startTime: new Date(),
        },
      },
    },
    globalSettings: { showEvents: true, showKicks: true },
  } as unknown as Partial<AppState>);
}

function lines(type: string) {
  return (
    useStore.getState().messages[`${serverId}-${serverId}-chan`] ?? []
  ).filter((m) => m.type === type);
}

function members(): string[] {
  return useStore
    .getState()
    .servers[0].channels[0].users.map((u) => u.username);
}

function kick(mtags?: Record<string, string>) {
  ircClient.triggerEvent("KICK", {
    serverId,
    mtags,
    username: "op",
    channelName: "#help",
    target: "tryz",
    reason: "MUhahaha",
  });
}

function topic(mtags?: Record<string, string>) {
  ircClient.triggerEvent("TOPIC", {
    serverId,
    mtags,
    channelName: "#help",
    topic: "If you do not require help please stay out or leave!",
    sender: "op",
  });
}

describe("KICK replayed from chathistory", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed();
  });
  afterEach(() => vi.restoreAllMocks());

  test("is shown once at its own time and leaves the member list alone", () => {
    const replay = { batch: "hist1", time: HIST_TIME };
    kick(replay);
    kick(replay); // replayed again on the next reconnect

    const kicks = lines("kick");
    expect(kicks).toHaveLength(1);
    expect(new Date(kicks[0].timestamp).toISOString()).toBe(HIST_TIME);
    expect(kicks[0].fromHistory).toBe(true);
    expect(members()).toContain("tryz");
  });

  test("a live KICK uses the server time and removes the user", () => {
    kick({ time: HIST_TIME });

    const kicks = lines("kick");
    expect(kicks).toHaveLength(1);
    expect(new Date(kicks[0].timestamp).toISOString()).toBe(HIST_TIME);
    expect(members()).not.toContain("tryz");
  });

  test("a live KICK without a time tag is stamped now", () => {
    const before = Date.now();
    kick();
    const ts = new Date(lines("kick")[0].timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
  });
});

describe("TOPIC replayed from chathistory", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed();
  });
  afterEach(() => vi.restoreAllMocks());

  test("is shown once at its own time and does not overwrite the live topic", () => {
    useStore.setState((s) => ({
      servers: s.servers.map((srv) => ({
        ...srv,
        channels: srv.channels.map((c) => ({ ...c, topic: "current topic" })),
      })),
    }));
    const replay = { batch: "hist1", time: HIST_TIME };
    topic(replay);
    topic(replay);

    const topics = lines("system");
    expect(topics).toHaveLength(1);
    expect(new Date(topics[0].timestamp).toISOString()).toBe(HIST_TIME);
    expect(useStore.getState().servers[0].channels[0].topic).toBe(
      "current topic",
    );
  });

  test("a live TOPIC uses the server time and sets the topic", () => {
    topic({ time: HIST_TIME });

    const topics = lines("system");
    expect(topics).toHaveLength(1);
    expect(new Date(topics[0].timestamp).toISOString()).toBe(HIST_TIME);
    expect(useStore.getState().servers[0].channels[0].topic).toBe(
      "If you do not require help please stay out or leave!",
    );
  });
});

describe("JOIN, PART and QUIT replayed from chathistory", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed();
    useStore.setState({
      globalSettings: {
        showEvents: true,
        showJoinsParts: true,
        showQuits: true,
      },
    } as unknown as Partial<AppState>);
    ircClient.nicks.set(serverId, "me");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete(serverId);
  });

  test("are shown once each across two deliveries", () => {
    for (let i = 0; i < 2; i++) {
      ircClient.triggerEvent("JOIN", {
        serverId,
        username: "bob",
        channelName: "#help",
        batchTag: "hist1",
        time: HIST_TIME,
      });
      ircClient.triggerEvent("PART", {
        serverId,
        username: "bob",
        channelName: "#help",
        reason: "",
        batchTag: "hist1",
        time: "2026-10-20T07:22:00.000Z",
      });
      ircClient.triggerEvent("QUIT", {
        serverId,
        username: "tryz",
        reason: "bye",
        batchTag: "hist1",
        time: "2026-10-20T07:23:00.000Z",
      });
    }
    expect(lines("join")).toHaveLength(1);
    expect(lines("part")).toHaveLength(1);
    expect(lines("quit")).toHaveLength(1);
  });
});
