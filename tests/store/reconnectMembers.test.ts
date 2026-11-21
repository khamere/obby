import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import { _resetWhoReplyBatcher } from "../../src/store/whoReplyBatcher";
import type { Channel, User } from "../../src/types";

// What the server says after we come back replaces what we remembered from
// before: who is in the channel, and with which status.
const serverId = "members-srv";
const channelName = "#Lounge";

function user(username: string, status = ""): User {
  return { id: username, username, isOnline: true, status };
}

function seed(users: User[], overrides: Partial<Channel> = {}) {
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "test",
        host: "irc.test",
        port: 6697,
        channels: [
          {
            id: "members-chan",
            name: channelName,
            isPrivate: false,
            serverId,
            unreadCount: 0,
            isMentioned: false,
            messages: [],
            users,
            ...overrides,
          },
        ],
        privateChats: [],
        isConnected: true,
        connectionState: "connected",
        capabilities: ["draft/chathistory"],
        users: [],
      },
    ],
    messages: {},
    activeBatches: {},
  } as unknown as Partial<AppState>);
  ircClient.nicks.set(serverId, "me");
}

function channel(): Channel {
  const found = useStore
    .getState()
    .servers.find((s) => s.id === serverId)
    ?.channels.find((c) => c.name === channelName);
  if (!found) throw new Error("channel missing");
  return found;
}

function members(): string[] {
  return channel()
    .users.map((u) => `${u.status ?? ""}${u.username}`)
    .sort();
}

function whoLines(): string[] {
  return vi
    .mocked(ircClient.sendRaw)
    .mock.calls.map(([, line]) => line)
    .filter((line) => line.startsWith("WHO "));
}

function setConnection(connectionState: "connected" | "disconnected") {
  ircClient.triggerEvent("connectionStateChange", {
    serverId,
    connectionState,
  });
}

function ownJoin() {
  ircClient.triggerEvent("JOIN", {
    serverId,
    username: "me",
    channelName: channelName.toLowerCase(),
  });
}

function whoReply(nick: string, opLevel = "") {
  ircClient.triggerEvent("WHOX_REPLY", {
    serverId,
    channel: channelName,
    username: "u",
    host: "h",
    nick,
    account: "0",
    flags: `H${opLevel}`,
    realname: nick,
    isAway: false,
    opLevel,
  });
}

function whoEnd() {
  ircClient.triggerEvent("WHO_END", { serverId, mask: channelName });
}

describe("member list after coming back to a channel", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    _resetWhoReplyBatcher();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetWhoReplyBatcher();
    ircClient.nicks.delete(serverId);
  });

  test("our join after a reconnect asks the server who is in the channel", () => {
    seed([user("me", "@"), user("bob"), user("carol", "@")]);

    setConnection("disconnected");
    expect(whoLines()).toEqual([]);
    setConnection("connected");
    ownJoin();

    expect(whoLines()).toEqual([`WHO ${channelName.toLowerCase()} %cuhnfaro`]);
    expect(channel().needsWhoRequest).toBe(false);
  });

  test("a history load that the dropped connection ends sends no member request", () => {
    seed([user("me"), user("bob")], { isLoadingHistory: true });

    setConnection("disconnected");
    ircClient.triggerEvent("CHATHISTORY_LOADING", {
      serverId,
      channelName,
      isLoading: false,
    });

    expect(whoLines()).toEqual([]);
    expect(channel().needsWhoRequest).toBe(true);
  });

  test("our join during a history load leaves the member request to the end of that load", () => {
    seed([user("me"), user("bob")], { isLoadingHistory: true });

    ownJoin();
    expect(whoLines()).toEqual([]);

    ircClient.triggerEvent("CHATHISTORY_LOADING", {
      serverId,
      channelName,
      isLoading: false,
    });
    expect(whoLines()).toEqual([`WHO ${channelName} %cuhnfaro`]);
  });

  test("our first join of a channel sends no second member request", () => {
    seed([], { needsWhoRequest: false });

    ownJoin();

    expect(whoLines()).toEqual([]);
  });

  test("the finished reply removes who left and updates who changed status", () => {
    seed([user("me", "@"), user("bob"), user("Carol", "@")]);

    whoReply("me");
    whoReply("BOB", "@");
    whoReply("dave");
    whoEnd();

    expect(members()).toEqual(["@BOB", "dave", "me"]);
  });

  test("a reply that arrives in several parts still keeps everyone it named", () => {
    vi.useFakeTimers();
    try {
      seed([user("me"), user("bob"), user("carol")]);

      whoReply("me");
      whoReply("bob");
      vi.advanceTimersByTime(100);
      whoReply("dave");
      whoEnd();

      expect(members()).toEqual(["bob", "dave", "me"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a reply that does not name us removes nobody", () => {
    seed([user("me"), user("bob"), user("carol")]);

    whoReply("bob");
    whoEnd();

    expect(members()).toEqual(["bob", "carol", "me"]);
  });

  test("rejoining after a kick puts us back in the list", () => {
    seed([user("me"), user("bob", "@")]);

    ircClient.triggerEvent("KICK", {
      serverId,
      mtags: undefined,
      username: "bob",
      target: "me",
      channelName,
      reason: "",
    });
    expect(members()).toEqual(["@bob"]);

    ownJoin();
    expect(whoLines()).toHaveLength(1);
    whoReply("bob", "@");
    whoReply("me");
    whoEnd();

    expect(members()).toEqual(["@bob", "me"]);
  });
});
