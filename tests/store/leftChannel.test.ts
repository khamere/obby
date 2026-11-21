import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import type { Channel, User } from "../../src/types";

const OTHER_SERVER = "left-srv-other";
let serverId = "";
let counter = 0;
let sendRaw: ReturnType<typeof vi.spyOn>;

const member = (username: string): User =>
  ({ id: username, username, isOnline: true }) as User;

function channelOn(id: string): Channel {
  return {
    id: `${id}-chan`,
    name: "#Lounge",
    isPrivate: false,
    serverId: id,
    unreadCount: 0,
    isMentioned: false,
    messages: [],
    users: [member("me"), member("op")],
  };
}

const clientServers = () =>
  (ircClient as unknown as { servers: Map<string, unknown> }).servers;
const capsDone = () =>
  (ircClient as unknown as { capNegotiationComplete: Map<string, boolean> })
    .capNegotiationComplete;

function seed() {
  serverId = `left-srv-${++counter}`;
  const servers = [serverId, OTHER_SERVER].map((id) => ({
    id,
    name: "test",
    host: "irc.test",
    port: 6697,
    channels: [channelOn(id)],
    privateChats: [],
    isConnected: true,
    users: [],
  }));
  useStore.setState({
    servers,
    messages: {},
    activeBatches: {},
    globalSettings: { showEvents: true, showKicks: true, showJoinsParts: true },
  } as unknown as Partial<AppState>);
  for (const id of [serverId, OTHER_SERVER]) {
    ircClient.nicks.set(id, "me");
    capsDone().set(id, true);
    clientServers().set(id, {
      id,
      channels: [{ ...channelOn(id), users: [] }],
      capabilities: [],
    });
  }
}

const channel = (id = serverId) =>
  useStore.getState().servers.find((s) => s.id === id)?.channels[0] as Channel;

const sentLines = () =>
  sendRaw.mock.calls.map((call: unknown[]) => call[1] as string);
const sentJoins = () =>
  sentLines().filter((line: string) => line.startsWith("JOIN"));

function kick(target: string, channelName = "#lounge") {
  ircClient.triggerEvent("KICK", {
    serverId,
    mtags: undefined,
    username: "op",
    target,
    channelName,
    reason: "out",
  });
}

function part(username: string) {
  ircClient.triggerEvent("PART", {
    serverId,
    username,
    channelName: "#lounge",
  });
}

describe("a channel we were removed from", () => {
  beforeEach(() => {
    sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const id of [serverId, OTHER_SERVER]) {
      ircClient.nicks.delete(id);
      capsDone().delete(id);
      clientServers().delete(id);
    }
  });

  test("our own kick marks the channel as left and empties its member list", () => {
    kick("ME");
    expect(channel().leftReason).toBe("kicked");
    expect(channel().users).toEqual([]);
  });

  test("our own part seen from another session marks the channel as left", () => {
    part("me");
    expect(channel().leftReason).toBe("parted");
    expect(channel().users).toEqual([]);
  });

  test("someone else leaving keeps us in the channel", () => {
    kick("op");
    part("op");
    expect(channel().leftReason).toBeUndefined();
    expect(channel().users.map((u) => u.username)).toEqual(["me"]);
  });

  test("a kick on one server leaves the same-named channel of another alone", () => {
    kick("me");
    expect(channel(OTHER_SERVER).leftReason).toBeUndefined();
  });

  test("selecting a channel we left sends no JOIN", () => {
    kick("me");
    useStore.getState().selectChannel(channel().id);
    expect(sentJoins()).toEqual([]);
  });

  test("typing and sending in a channel send no JOIN", () => {
    ircClient.sendTyping(serverId, "#Lounge", true);
    ircClient.sendMessage(serverId, channel().id, "hello");
    ircClient.sendTyping(serverId, "#Lounge", false);
    expect(sentJoins()).toEqual([]);
    expect(sentLines()).toEqual([
      "@+typing=active TAGMSG #Lounge",
      "PRIVMSG #Lounge :hello",
      "@+typing=done TAGMSG #Lounge",
    ]);
  });

  test("joining again is what sends the JOIN", () => {
    kick("me");
    useStore.getState().joinChannel(serverId, "#Lounge");
    expect(sentJoins()).toEqual(["JOIN #Lounge"]);
  });

  test("our JOIN puts us back and asks the server for the members", () => {
    kick("me");
    sendRaw.mockClear();
    ircClient.triggerEvent("JOIN", {
      serverId,
      username: "me",
      channelName: "#lounge",
    });
    expect(channel().leftReason).toBeUndefined();
    expect(sentLines()).toEqual(["WHO #lounge %cuhnfaro"]);
  });

  test("joining again a channel the client no longer tracks loads it once", () => {
    kick("me");
    (clientServers().get(serverId) as { capabilities: string[] }).capabilities =
      ["draft/chathistory"];
    ircClient.forgetChannel(serverId, "#Lounge");
    sendRaw.mockClear();
    useStore.getState().joinChannel(serverId, "#Lounge");
    expect(sentLines()).toEqual(["JOIN #Lounge"]);
    ircClient.triggerEvent("JOIN", {
      serverId,
      username: "me",
      channelName: "#Lounge",
    });
    expect(sentLines()).toEqual([
      "JOIN #Lounge",
      "CHATHISTORY LATEST #Lounge * 50",
      "WHO #Lounge %cuhnfaro",
    ]);
  });

  test("closing a channel we left still parts it, so a bouncer drops it too", () => {
    kick("me");
    sendRaw.mockClear();
    useStore.getState().leaveChannel(serverId, "#lounge");
    expect(sentLines()).toEqual(["PART #lounge"]);
    expect(
      useStore.getState().servers.find((s) => s.id === serverId)?.channels,
    ).toEqual([]);
  });
});
