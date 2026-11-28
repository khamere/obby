import { beforeEach, describe, expect, it } from "vitest";
import useStore from "../../src/store";
import type { Channel, Message, PrivateChat, Server } from "../../src/types";

const line = (id: string, extra: Partial<Message> = {}) =>
  ({
    id,
    type: "message",
    content: id,
    timestamp: new Date("2026-01-01T12:00:00.000Z"),
    userId: "alice",
    channelId: "c1",
    serverId: "s1",
    ...extra,
  }) as Message;

const channel = (id: string) =>
  ({ id, name: `#${id}`, users: [], hasMoreHistory: true }) as never as Channel;
const privateChat = (id: string) =>
  ({ id, username: id, hasMoreHistory: true }) as never as PrivateChat;

// The window shows nothing newer than this, and every seeded line is older.
const WINDOW_END = Date.parse("2026-01-01T13:00:00.000Z");
const later = new Date("2026-01-01T14:00:00.000Z");
const sent = line("p", { status: "pending", pendingLabel: "l1" });
const elsewhere = [line("m3")];

function seed(aside: Message[] = []) {
  useStore.setState({
    servers: [
      {
        id: "s1",
        name: "net",
        channels: [channel("c1"), channel("c2")],
        privateChats: [privateChat("p1"), privateChat("p2")],
      } as never as Server,
    ],
    messages: {
      "s1-c1": [line("m1"), line("m2"), sent],
      "s1-c2": elsewhere,
      "s1-p1": [line("m4")],
      "s1-server-notices": [line("n1")],
    },
    historyWindows: {
      "s1-c1": { until: WINDOW_END, present: aside },
    },
  });
}

describe("clearing a chat's view", () => {
  beforeEach(() => seed());

  it("leaves a channel showing only the line still waiting for its echo", () => {
    const before = useStore.getState();

    before.clearChatView("s1", "c1");

    const state = useStore.getState();
    expect(state.messages["s1-c1"]).toEqual([sent]);
    expect(state.historyWindows).toEqual({});
    const [c1, c2] = state.servers[0].channels;
    expect(c1.hasMoreHistory).toBe(false);
    expect(c2).toBe(before.servers[0].channels[1]);
    expect(state.messages["s1-c2"]).toBe(elsewhere);
  });

  it("keeps a waiting line the history window was holding aside", () => {
    const aside = line("q", {
      status: "pending",
      pendingLabel: "l2",
      timestamp: later,
    });
    seed([line("m9", { timestamp: later }), aside]);

    useStore.getState().clearChatView("s1", "c1");

    expect(useStore.getState().messages["s1-c1"]).toEqual([aside, sent]);
  });

  it("stops a private chat from offering older history", () => {
    const before = useStore.getState();

    before.clearChatView("s1", "p1");

    const state = useStore.getState();
    expect(state.messages["s1-p1"]).toEqual([]);
    const [p1, p2] = state.servers[0].privateChats ?? [];
    expect(p1.hasMoreHistory).toBe(false);
    expect(p2).toBe(before.servers[0].privateChats?.[1]);
    expect(state.servers[0].channels).toEqual(before.servers[0].channels);
  });

  it("empties the server notices and touches no chat", () => {
    const before = useStore.getState();

    before.clearChatView("s1", "server-notices");

    const state = useStore.getState();
    expect(state.messages["s1-server-notices"]).toEqual([]);
    expect(state.servers).toBe(before.servers);
  });
});
