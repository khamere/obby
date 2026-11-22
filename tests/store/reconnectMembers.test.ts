import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import { _resetWhoReplyBatcher } from "../../src/store/whoReplyBatcher";
import type { Channel, User } from "../../src/types";
import { installLocalStorageBacking } from "../fixtures/localStorageBacking";

// What the server says after we come back replaces what we remembered from
// before: who is in the channel, and with which status.
const serverId = "members-srv";
const channelName = "#Lounge";

function user(username: string, status = ""): User {
  return { id: username, username, isOnline: true, status };
}

type ClientServers = { servers: Map<string, unknown> };

function seed(users: User[], overrides: Partial<Channel> = {}) {
  seedChannels([
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
  ]);
}

function seedChannels(channels: Channel[]) {
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "test",
        host: "irc.test",
        port: 6697,
        channels,
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

function clientSockets() {
  return (ircClient as unknown as { sockets: Map<string, unknown> }).sockets;
}

// Hands the client lines as the server sends them.
function receive(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage: (data: string, serverId: string) => void;
    }
  ).handleMessage(lines.map((line) => `${line}\r\n`).join(""), serverId);
}

function whoxRow(nick: string, flags = "H", name = channelName) {
  return `:irc.test 354 me ${name} u h ${nick} ${flags} 0 0 :${nick}`;
}

function whoRow(nick: string, flags = "H", name = channelName) {
  return `:irc.test 352 me ${name} u h irc.test ${nick} ${flags} :0 ${nick}`;
}

function endOfWho(name = channelName) {
  return `:irc.test 315 me ${name} :End of WHO list`;
}

function otherJoin(username: string) {
  ircClient.triggerEvent("JOIN", { serverId, username, channelName });
}

function whoEnd() {
  ircClient.triggerEvent("WHO_END", { serverId, mask: channelName });
}

describe("member list after coming back to a channel", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw");
    clientSockets().set(serverId, { readyState: WebSocket.OPEN, send() {} });
    _resetWhoReplyBatcher();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetWhoReplyBatcher();
    clientSockets().delete(serverId);
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

  test("our first join on a server with history sends one member request, when the history load ends", () => {
    installLocalStorageBacking();
    const clientServers = (ircClient as unknown as ClientServers).servers;
    clientServers.set(serverId, {
      id: serverId,
      channels: [],
      capabilities: ["draft/chathistory"],
    });
    try {
      seedChannels([]);

      useStore.getState().joinChannel(serverId, channelName);
      ownJoin();
      expect(whoLines()).toEqual([]);

      ircClient.triggerEvent("CHATHISTORY_LOADING", {
        serverId,
        channelName,
        isLoading: false,
      });
      expect(whoLines()).toEqual([`WHO ${channelName} %cuhnfaro`]);
    } finally {
      clientServers.delete(serverId);
    }
  });

  test("the finished reply removes who left and updates who changed status", () => {
    seed([user("me", "@"), user("bob"), user("Carol", "@")]);

    ownJoin();
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

      ownJoin();
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

    ownJoin();
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

  test("someone who joins while the reply is on its way stays in the list", () => {
    seed([user("me"), user("bob")]);

    ownJoin();
    otherJoin("erin");
    whoReply("me");
    whoReply("bob");
    otherJoin("dave");
    whoEnd();

    expect(members()).toEqual(["bob", "dave", "erin", "me"]);
  });

  test("someone who leaves while the reply is on its way stays out of the list", () => {
    seed([user("me"), user("bob"), user("carol"), user("dave")]);

    ownJoin();
    ircClient.triggerEvent("PART", {
      serverId,
      username: "bob",
      channelName,
    });
    whoReply("me");
    whoReply("bob");
    whoReply("carol");
    whoReply("dave");
    ircClient.triggerEvent("QUIT", {
      serverId,
      username: "carol",
      reason: "",
    });
    ircClient.triggerEvent("KICK", {
      serverId,
      mtags: undefined,
      username: "me",
      target: "dave",
      channelName,
      reason: "",
    });
    whoEnd();

    expect(members()).toEqual(["me"]);
  });

  test("someone who leaves and joins again while the reply is on its way is listed", () => {
    seed([user("me"), user("bob")]);

    ownJoin();
    whoReply("me");
    ircClient.triggerEvent("PART", {
      serverId,
      username: "bob",
      channelName,
    });
    otherJoin("bob");
    whoEnd();

    expect(members()).toEqual(["bob", "me"]);
  });

  test("a nick changed while the reply is on its way is listed under the new nick", () => {
    seed([user("me"), user("bob")]);

    ownJoin();
    whoReply("me");
    whoReply("bob");
    ircClient.triggerEvent("NICK", {
      serverId,
      mtags: undefined,
      oldNick: "bob",
      newNick: "robert",
    });
    ircClient.triggerEvent("NICK", {
      serverId,
      mtags: undefined,
      oldNick: "carol",
      newNick: "caroline",
    });
    whoReply("carol", "@");
    whoEnd();

    expect(members()).toEqual(["@caroline", "me", "robert"]);
  });

  test("a typed request sent before ours keeps its own reply, and ours still replaces the list", () => {
    seed([user("me", "@"), user("bob"), user("carol")]);

    ircClient.sendRaw(serverId, `WHO ${channelName} o`);
    ownJoin();
    receive(whoRow("me", "H*@"), endOfWho());
    expect(members()).toEqual(["@me", "bob", "carol"]);

    receive(whoxRow("me", "H@"), whoxRow("bob"), endOfWho());
    expect(members()).toEqual(["@me", "bob"]);
  });

  test("a typed request sent before ours that names nobody leaves ours to replace the list", () => {
    seed([user("me"), user("bob"), user("carol")]);

    ircClient.sendRaw(serverId, `WHO ${channelName} o`);
    ownJoin();
    receive(endOfWho());
    receive(whoxRow("me"), whoxRow("bob"), endOfWho());

    expect(members()).toEqual(["bob", "me"]);
  });

  test("a typed request sent after ours removes nobody", () => {
    seed([user("me", "@"), user("bob"), user("carol")]);

    ownJoin();
    ircClient.sendRaw(serverId, `WHO ${channelName} o`);
    receive(whoxRow("me", "H@"), whoxRow("bob"), whoxRow("dave"), endOfWho());
    expect(members()).toEqual(["@me", "bob", "dave"]);

    receive(whoRow("me", "H*@"), endOfWho());
    expect(members()).toEqual(["@me", "bob", "dave"]);
  });

  test("a typed request on its own removes nobody", () => {
    seed([user("me", "@"), user("bob"), user("carol")]);

    ircClient.sendRaw(serverId, `WHO ${channelName} o`);
    receive(whoRow("me", "H*@"), endOfWho());

    expect(members()).toEqual(["@me", "bob", "carol"]);
  });

  test("a nick taken over while the reply is on its way stays with its new holder", () => {
    seed([user("me"), user("bob"), user("carol")]);

    ownJoin();
    ircClient.triggerEvent("QUIT", { serverId, username: "bob", reason: "" });
    ircClient.triggerEvent("NICK", {
      serverId,
      mtags: undefined,
      oldNick: "carol",
      newNick: "bob",
    });
    receive(whoxRow("me"), whoxRow("bob"), endOfWho());

    expect(members()).toEqual(["bob", "me"]);
  });

  test("a reply that spells the channel in another case still replaces the list", () => {
    seed([user("me"), user("bob")]);

    ownJoin();
    const spelled = channelName.toUpperCase();
    receive(whoRow("me", "H", spelled), whoRow("dave", "H@", spelled));
    receive(endOfWho(spelled));

    expect(members()).toEqual(["@dave", "me"]);
  });

  test("a request whose reply never ended replaces nothing later and is asked again", () => {
    vi.useFakeTimers();
    try {
      seed([user("me", "@"), user("bob")]);

      ownJoin();
      vi.advanceTimersByTime(61_000);
      ownJoin();
      expect(whoLines()).toHaveLength(2);

      receive(whoRow("me", "H*@"), endOfWho());
      expect(members()).toEqual(["@me", "bob"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("our join asks for the channel's own metadata along with its members", () => {
    seed([user("me"), user("bob")]);
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        capabilities: ["draft/metadata-2"],
      })),
    }));
    const metadataGet = vi
      .spyOn(ircClient, "metadataGet")
      .mockImplementation(() => {});

    setConnection("disconnected");
    setConnection("connected");
    ownJoin();

    expect(metadataGet.mock.calls).toEqual([
      [serverId, channelName.toLowerCase(), ["avatar", "display-name"]],
    ]);
  });

  test("a second reply on the same request removes nobody", () => {
    seed([user("me"), user("bob"), user("carol")]);

    ownJoin();
    whoReply("me");
    whoReply("bob");
    whoReply("carol");
    whoEnd();
    whoReply("me");
    whoEnd();

    expect(members()).toEqual(["bob", "carol", "me"]);
  });

  test("a reply cut off by a dropped connection leaves nothing for the next one", () => {
    vi.useFakeTimers();
    try {
      seed([user("me"), user("bob")]);

      ownJoin();
      whoReply("me");
      whoReply("bob");
      vi.advanceTimersByTime(100);
      whoReply("carol");
      setConnection("disconnected");
      vi.advanceTimersByTime(2000);
      expect(members()).toEqual(["bob", "me"]);

      setConnection("connected");
      ownJoin();
      whoReply("me");
      whoEnd();

      expect(members()).toEqual(["me"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a reply cut off by a dropped connection removes nobody when a typed request ends", () => {
    seed([user("me"), user("bob")]);

    ownJoin();
    whoReply("me");
    setConnection("disconnected");
    setConnection("connected");
    whoReply("me");
    whoEnd();

    expect(members()).toEqual(["bob", "me"]);
  });

  describe("on a server that keeps no history", () => {
    beforeEach(() => {
      installLocalStorageBacking();
      (ircClient as unknown as ClientServers).servers.set(serverId, {
        id: serverId,
        channels: [],
        capabilities: [],
      });
    });
    afterEach(() => {
      (ircClient as unknown as ClientServers).servers.delete(serverId);
    });

    test("each successful join sends one member request, also when the first reply never came", () => {
      seedChannels([]);

      useStore.getState().joinChannel(serverId, channelName);
      ownJoin();
      expect(whoLines()).toEqual([`WHO ${channelName} %cuhnfaro`]);
      expect(channel().users).toEqual([]);

      setConnection("disconnected");
      setConnection("connected");
      useStore.getState().joinChannel(serverId, channelName);
      ownJoin();

      expect(whoLines()).toHaveLength(2);
    });

    test("a join that needed the key sends one member request", () => {
      seed([user("me"), user("bob")], { needsKey: true });

      ownJoin();

      expect(whoLines()).toHaveLength(1);
      expect(channel().needsKey).toBe(false);
    });
  });
});
