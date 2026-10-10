import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import type { Channel, PrivateChat, User } from "../../src/types";

// A PM is only blocked when the server said the peer is offline. Servers (and
// soju-bound networks) without MONITOR never answer, so presence has to start
// as unknown and be filled in from evidence we already hold.
const serverId = "presence-srv";

function channelWith(users: User[]): Channel {
  return {
    id: "presence-chan",
    name: "#shared",
    isPrivate: false,
    serverId,
    unreadCount: 0,
    isMentioned: false,
    messages: [],
    users,
  };
}

function seed(users: User[] = [], privateChats: PrivateChat[] = []) {
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "test",
        host: "irc.test",
        port: 6697,
        channels: [channelWith(users)],
        privateChats,
        isConnected: true,
        users: [],
      },
    ],
    messages: {},
    activeBatches: {},
  } as unknown as Partial<AppState>);
  ircClient.nicks.set(serverId, "me");
}

function pm(nick: string): PrivateChat | undefined {
  return useStore
    .getState()
    .servers.find((s) => s.id === serverId)
    ?.privateChats?.find((p) => p.username.toLowerCase() === nick);
}

describe("private chat presence", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    // jsdom can't play the incoming-PM notification sound.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete(serverId);
  });

  test("a new PM with a stranger starts as unknown, not offline", () => {
    seed();
    useStore.getState().openPrivateChat(serverId, "bob");
    expect(pm("bob")).toBeDefined();
    expect(pm("bob")?.isOnline).toBeUndefined();
  });

  test("a new PM with someone in a shared channel starts online", () => {
    seed([{ id: "b", username: "bob", isOnline: true }]);
    useStore.getState().openPrivateChat(serverId, "bob");
    expect(pm("bob")?.isOnline).toBe(true);
  });

  test("full user info from the channel is still copied", () => {
    seed([
      {
        id: "b",
        username: "bob",
        isOnline: true,
        realname: "Bob",
        account: "bob",
      },
    ]);
    useStore.getState().openPrivateChat(serverId, "bob");
    expect(pm("bob")).toMatchObject({
      isOnline: true,
      realname: "Bob",
      account: "bob",
    });
  });

  test("reopening a PM marked offline corrects it from a shared channel", () => {
    seed(
      [{ id: "b", username: "bob", isOnline: true }],
      [
        {
          id: "pm-bob",
          username: "bob",
          serverId,
          unreadCount: 0,
          isMentioned: false,
          isOnline: false,
        },
      ],
    );
    useStore.getState().openPrivateChat(serverId, "bob");
    expect(pm("bob")?.isOnline).toBe(true);
  });

  test("a live message from the peer marks them online", () => {
    seed();
    ircClient.triggerEvent("USERMSG", {
      serverId,
      sender: "carol",
      target: "me",
      message: "hi",
      timestamp: new Date(),
      mtags: undefined,
    });
    expect(pm("carol")?.isOnline).toBe(true);
  });

  test("a replayed history message does not claim the peer is online", () => {
    seed();
    ircClient.triggerEvent("USERMSG", {
      serverId,
      sender: "dave",
      target: "me",
      message: "old",
      timestamp: new Date(),
      mtags: { batch: "hist1" },
    });
    expect(pm("dave")?.isOnline).not.toBe(true);
  });

  test("MONOFFLINE still marks the peer offline", () => {
    seed(
      [],
      [
        {
          id: "pm-erin",
          username: "erin",
          serverId,
          unreadCount: 0,
          isMentioned: false,
          isOnline: true,
        },
      ],
    );
    ircClient.triggerEvent("MONOFFLINE", { serverId, targets: ["erin"] });
    expect(pm("erin")?.isOnline).toBe(false);
  });
});
