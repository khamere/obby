import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextMemberRequestNumber } from "../../src/lib/irc/utils";
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
    token: ourToken(),
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

// The number our latest member request carried, which the server repeats in every row of its answer.
function ourToken(): string | undefined {
  return whoLines()
    .flatMap((line) => / %tcuhnfaro,(\d+)$/.exec(line)?.[1] ?? [])
    .at(-1);
}

function memberRequest(name = channelName) {
  return [expect.stringMatching(`^WHO ${name} %tcuhnfaro,\\d{1,3}$`)];
}

function whoxRow(nick: string, flags = "H", name = channelName) {
  return `:irc.test 354 me ${ourToken()} ${name} u h ${nick} ${flags} 0 0 :${nick}`;
}

function typedWhoxRow(nick: string, flags = "H", token = "") {
  return `:irc.test 354 me ${token}${channelName} u h ${nick} ${flags} 0 0 :${nick}`;
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

    expect(whoLines()).toEqual(memberRequest(channelName.toLowerCase()));
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
    expect(whoLines()).toEqual(memberRequest());
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
      expect(whoLines()).toEqual(memberRequest());
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

  // The server reads these the same way, and we send whatever the user types.
  const typedRequests = [
    "WHO #Lounge o",
    "WHO  #Lounge o",
    "WHO #Lounge o #Lounge",
    "WHO #Lounge %cuhnfaro",
    "who #lounge",
  ];

  test.each(typedRequests)(
    "a typed '%s' sent just before our request keeps our answer from removing anyone",
    (typed) => {
      seed([user("me", "@"), user("bob"), user("carol")]);

      ircClient.sendRaw(serverId, typed);
      ownJoin();
      receive(whoxRow("me", "H@"), endOfWho());
      expect(members()).toEqual(["@me", "bob", "carol"]);

      receive(whoxRow("dave"), endOfWho());
      expect(members()).toEqual(["@me", "bob", "carol", "dave"]);
    },
  );

  test.each(typedRequests)(
    "a typed '%s' sent while our answer is on its way keeps it from removing anyone",
    (typed) => {
      seed([user("me", "@"), user("bob"), user("carol")]);

      ownJoin();
      receive(whoxRow("me", "H@"));
      ircClient.sendRaw(serverId, typed);
      receive(whoRow("me", "H*@"), typedWhoxRow("me", "H*@"), endOfWho());
      expect(members()).toEqual(["@me", "bob", "carol"]);

      receive(whoxRow("dave"), endOfWho());
      expect(members()).toEqual(["@me", "bob", "carol", "dave"]);
    },
  );

  test("the join after an answer that removed nobody asks again, and that answer replaces the list", () => {
    vi.useFakeTimers();
    try {
      seed([user("me"), user("bob"), user("carol")]);

      ownJoin();
      ircClient.sendRaw(serverId, `WHO ${channelName}`);
      receive(whoxRow("me"), endOfWho());
      expect(members()).toEqual(["bob", "carol", "me"]);

      vi.advanceTimersByTime(11_000);
      ownJoin();
      expect(whoLines()).toHaveLength(3);
      receive(whoxRow("me"), whoxRow("bob"), endOfWho());
      expect(members()).toEqual(["bob", "me"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a typed request sent well before ours leaves our answer to replace the list", () => {
    vi.useFakeTimers();
    try {
      seed([user("me"), user("bob"), user("carol")]);

      ircClient.sendRaw(serverId, `WHO ${channelName} o`);
      vi.advanceTimersByTime(11_000);
      ownJoin();
      receive(whoxRow("me"), whoxRow("bob"), endOfWho());

      expect(members()).toEqual(["bob", "me"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a request about one person leaves our answer to replace the list", () => {
    seed([user("me"), user("bob"), user("carol")]);

    ircClient.sendRaw(serverId, "WHO bob %cuhnfrao");
    ownJoin();
    ircClient.sendRaw(serverId, "WHO carol %cuhnfrao");
    receive(whoxRow("me"), whoxRow("bob"), endOfWho());

    expect(members()).toEqual(["bob", "me"]);
  });

  test("our requests for two channels each replace their own list", () => {
    const second = "#Annex";
    const row = (name: string, users: User[]) => ({
      id: name,
      name,
      isPrivate: false,
      serverId,
      unreadCount: 0,
      isMentioned: false,
      messages: [],
      users,
    });
    seedChannels([
      row(channelName, [user("me"), user("bob")]),
      row(second, [user("me"), user("carol")]),
    ]);

    ownJoin();
    const first = whoxRow("me");
    ircClient.triggerEvent("JOIN", {
      serverId,
      username: "me",
      channelName: second,
    });
    receive(first, endOfWho(), whoxRow("me", "H", second), endOfWho(second));

    const lists = useStore
      .getState()
      .servers[0].channels.map((c) => c.users.map((u) => u.username));
    expect(lists).toEqual([["me"], ["me"]]);
  });

  test("a typed request on its own removes nobody", () => {
    seed([user("me", "@"), user("bob"), user("carol")]);

    ircClient.sendRaw(serverId, `WHO ${channelName} o`);
    receive(whoRow("me", "H*@"), endOfWho());

    expect(members()).toEqual(["@me", "bob", "carol"]);
  });

  test("a reply without our number, as a server without numbered replies sends it, adds members and removes nobody", () => {
    seed([user("me"), user("bob")]);

    ownJoin();
    receive(whoRow("me"), whoRow("dave", "H@"), endOfWho());

    expect(members()).toEqual(["@dave", "bob", "me"]);
  });

  test.each([
    ["someone we had listed", [user("me"), user("bob"), user("carol")]],
    ["someone who joined while we were away", [user("me"), user("bob")]],
  ])(
    "a nick taken over by %s while the reply is on its way stays with its new holder",
    (_, cached) => {
      seed(cached);

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
    },
  );

  test("a reply that spells the channel in another case still replaces the list", () => {
    seed([user("me"), user("bob")]);

    ownJoin();
    const spelled = channelName.toUpperCase();
    receive(whoxRow("me", "H", spelled), whoxRow("dave", "H@", spelled));
    receive(endOfWho(spelled));

    expect(members()).toEqual(["@dave", "me"]);
  });

  test("a reply without our number that spells the channel in another case still adds its members", () => {
    seed([user("me"), user("bob")]);

    const spelled = channelName.toUpperCase();
    receive(whoRow("dave", "H@", spelled), endOfWho(spelled));

    expect(members()).toEqual(["@dave", "bob", "me"]);
  });

  test("a request that got no answer is asked again, and the second answer alone replaces the list", () => {
    vi.useFakeTimers();
    try {
      seed([user("me", "@"), user("bob")]);

      ownJoin();
      const lost = Number(ourToken());
      expect(lost).toBeGreaterThanOrEqual(100);
      vi.advanceTimersByTime(61_000);
      ownJoin();
      expect(whoLines()).toHaveLength(2);
      expect(Number(ourToken())).toBe(lost === 999 ? 100 : lost + 1);

      receive(whoxRow("me", "H@"), whoxRow("dave"), endOfWho());
      expect(members()).toEqual(["@me", "dave"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an answer that starts after its request was given up removes nobody", () => {
    vi.useFakeTimers();
    try {
      seed([user("me"), user("bob")]);

      ownJoin();
      const late = [whoxRow("me"), endOfWho()];
      vi.advanceTimersByTime(61_000);
      receive(...late);

      expect(members()).toEqual(["bob", "me"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an answer that keeps arriving stays open however long it takes", () => {
    vi.useFakeTimers();
    try {
      seed([user("me"), user("bob")]);

      ownJoin();
      receive(whoxRow("me"));
      vi.advanceTimersByTime(40_000);
      receive(whoxRow("dave"));
      vi.advanceTimersByTime(40_000);
      ownJoin();
      expect(whoLines()).toHaveLength(1);
      receive(whoxRow("erin"), endOfWho());

      expect(members()).toEqual(["dave", "erin", "me"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an answer that stops arriving is given up, removes nobody later, and is asked again", () => {
    vi.useFakeTimers();
    try {
      seed([user("me"), user("bob")]);

      ownJoin();
      receive(whoxRow("me"));
      const late = [whoxRow("dave"), endOfWho()];
      vi.advanceTimersByTime(61_000);
      receive(...late);
      expect(members()).toEqual(["bob", "dave", "me"]);

      ownJoin();
      expect(whoLines()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a new connection of the same server starts its numbers afresh", () => {
    seed([user("me"), user("bob")]);
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    const open = () => ({ readyState: WebSocket.OPEN, send() {} });

    clientSockets().set(serverId, open());
    ircClient.requestMembers(serverId, channelName);
    ircClient.requestMembers(serverId, channelName);
    clientSockets().set(serverId, open());
    ircClient.requestMembers(serverId, channelName);

    expect(whoLines().map((line) => line.split(",")[1])).toEqual([
      "100",
      "101",
      "550",
    ]);
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
    whoEnd();
    expect(members()).toEqual(["bob", "me"]);

    otherJoin("dave");
    whoReply("me");
    whoEnd();

    expect(members()).toEqual(["bob", "dave", "me"]);
  });

  test("a reply the bouncer aborts removes nobody, and the next join asks again", () => {
    seed([user("me"), user("bob"), user("carol")]);

    ownJoin();
    receive(whoxRow("me"), `:irc.test 315 me ${channelName} :Command aborted`);
    expect(members()).toEqual(["bob", "carol", "me"]);

    ownJoin();
    expect(whoLines()).toHaveLength(2);
    receive(whoxRow("me"), whoxRow("bob"), endOfWho());

    expect(members()).toEqual(["bob", "me"]);
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

  test("a reply cut off by a dropped connection removes nobody when a typed request ends on the next one", () => {
    seed([user("me"), user("bob")]);

    ownJoin();
    receive(whoxRow("me"));
    const cutOff = whoxRow("me");
    setConnection("disconnected");
    setConnection("connected");
    ircClient.sendRaw(serverId, `WHO  ${channelName} o`);
    receive(cutOff, whoRow("me", "H*"), endOfWho());

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
      expect(whoLines()).toEqual(memberRequest());
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

describe("the number our member request carries", () => {
  test("starts anywhere from 100 to 999 on a connection", () => {
    expect(nextMemberRequestNumber(undefined, () => 0)).toBe(100);
    expect(nextMemberRequestNumber(undefined, () => 0.5)).toBe(550);
    expect(nextMemberRequestNumber(undefined, () => 0.9999)).toBe(999);
  });

  test("counts up and returns to 100 after 999", () => {
    expect(nextMemberRequestNumber(100)).toBe(101);
    expect(nextMemberRequestNumber(998)).toBe(999);
    expect(nextMemberRequestNumber(999)).toBe(100);
  });
});
