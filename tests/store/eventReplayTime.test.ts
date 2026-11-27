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
              { id: "u1", username: "brindle", isOnline: true, status: "" },
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
    target: "brindle",
    reason: "bye for now",
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
    expect(members()).toContain("brindle");
  });

  test("a live KICK uses the server time and removes the user", () => {
    kick({ time: HIST_TIME });

    const kicks = lines("kick");
    expect(kicks).toHaveLength(1);
    expect(new Date(kicks[0].timestamp).toISOString()).toBe(HIST_TIME);
    expect(members()).not.toContain("brindle");
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
    // Replayed TOPICs carry a msgid and are held until the batch ends; the
    // next reconnect replays the same one in a new batch.
    const replay = { batch: "hist1", time: HIST_TIME, msgid: "topic-1" };
    const batches = useStore.getState().activeBatches;
    topic(replay);
    expect(lines("system")).toHaveLength(0);
    ircClient.triggerEvent("BATCH_END", { serverId, batchId: "hist1" });
    useStore.setState({ activeBatches: batches });
    topic(replay);
    ircClient.triggerEvent("BATCH_END", { serverId, batchId: "hist1" });

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
        username: "brindle",
        reason: "bye",
        batchTag: "hist1",
        time: "2026-10-20T07:23:00.000Z",
      });
    }
    expect(lines("join")).toHaveLength(1);
    expect(lines("part")).toHaveLength(1);
    expect(lines("quit")).toHaveLength(1);
  });

  // The history a server keeps holds the QUIT of each connection of ours that
  // ended and the JOIN of the one that replaced it. The JOIN is left out, so
  // the QUIT alone would read as if we had gone and never come back.
  function quit(username: string, batchTag?: string) {
    ircClient.triggerEvent("QUIT", {
      serverId,
      username,
      reason: "Quit: bye",
      batchTag,
      time: "2026-10-20T07:23:00.000Z",
    });
  }

  test("our own QUIT from history posts no quit line", () => {
    quit("me", "hist1");
    expect(lines("quit")).toHaveLength(0);
  });

  test("our own QUIT from history is ours in any letter case", () => {
    quit("ME", "hist1");
    expect(lines("quit")).toHaveLength(0);
  });

  test("our own JOIN from history is ours in any letter case", () => {
    for (const username of ["me", "ME"]) {
      ircClient.triggerEvent("JOIN", {
        serverId,
        username,
        channelName: "#help",
        batchTag: "hist1",
        time: HIST_TIME,
      });
    }
    expect(lines("join")).toHaveLength(0);
  });

  test("another user's QUIT beside ours in history is still shown", () => {
    quit("me", "hist1");
    quit("brindle", "hist1");
    expect(lines("quit").map((m) => m.userId)).toEqual(["brindle"]);
  });

  test("our own QUIT that arrives live is still shown", () => {
    ircClient.nicks.set(serverId, "brindle");
    quit("brindle");
    expect(lines("quit").map((m) => m.userId)).toEqual(["brindle"]);
  });

  test("a history page that spans our reconnect shows no line about us", () => {
    useStore.setState({ activeBatches: {} });
    const page = [
      ":irc.test BATCH +7 chathistory #help",
      "@batch=7;msgid=a;time=2026-10-20T07:20:00.000Z :me!~u@host JOIN #help * me",
      "@batch=7;msgid=b;time=2026-10-20T07:21:00.000Z :me!~u@host QUIT :Quit: bye",
      "@batch=7;msgid=c;time=2026-10-20T07:21:02.000Z :me!~u@host JOIN #help * me",
      "@batch=7;msgid=d;time=2026-10-20T07:22:00.000Z :bob!~u@host QUIT :Quit: bye",
      ":irc.test BATCH -7",
    ];
    (
      ircClient as unknown as {
        handleMessage(data: string, serverId: string): void;
      }
    ).handleMessage(`${page.join("\r\n")}\r\n`, serverId);

    expect(lines("join")).toHaveLength(0);
    expect(lines("quit").map((m) => m.userId)).toEqual(["bob"]);
  });

  // The nick we hold now may have belonged to someone who renamed away from
  // it. Their replayed NICK is about them, so it must leave our nick alone
  // and their later QUIT must still be told apart from ours.
  test("a NICK replayed from history leaves our own nick as it is", () => {
    useStore.setState({ activeBatches: {} });
    const page = [
      ":irc.test BATCH +8 chathistory #help",
      "@batch=8;msgid=e;time=2026-10-20T07:20:00.000Z :me!~u@host NICK elsewhere",
      "@batch=8;msgid=f;time=2026-10-20T07:21:00.000Z :elsewhere!~u@host QUIT :Quit: bye",
      "@batch=8;msgid=g;time=2026-10-20T07:22:00.000Z :me!~u@host QUIT :Quit: bye",
      ":irc.test BATCH -8",
    ];
    (
      ircClient as unknown as {
        handleMessage(data: string, serverId: string): void;
      }
    ).handleMessage(`${page.join("\r\n")}\r\n`, serverId);

    expect(ircClient.getNick(serverId)).toBe("me");
    expect(lines("quit").map((m) => m.userId)).toEqual(["elsewhere"]);
  });

  test("a NICK that arrives live still changes our own nick", () => {
    (
      ircClient as unknown as {
        handleMessage(data: string, serverId: string): void;
      }
    ).handleMessage(":me!~u@host NICK elsewhere\r\n", serverId);

    expect(ircClient.getNick(serverId)).toBe("elsewhere");
  });
});
