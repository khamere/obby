import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import {
  acquireVoiceClient,
  hasActiveVoiceClient,
  shutdownAllVoiceClients,
} from "../../src/lib/voice";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import { readyProcessedServers } from "../../src/store/handlers/connection";
import type { Channel, ServerConfig, User } from "../../src/types";
import {
  installLocalStorageBacking,
  lsBacking,
} from "../fixtures/localStorageBacking";

const OTHER_SERVER = "left-srv-other";
let serverId = "";
let counter = 0;
let sendRaw: ReturnType<typeof vi.spyOn>;

const member = (username: string): User =>
  ({ id: username, username, isOnline: true }) as User;

function channelOn(id: string, name = "#Lounge", users = ["me", "op"]) {
  return {
    id: `${id}-${name}`,
    name,
    isPrivate: false,
    serverId: id,
    unreadCount: 0,
    isMentioned: false,
    messages: [],
    users: users.map(member),
  } as Channel;
}

const clientServers = () =>
  (ircClient as unknown as { servers: Map<string, unknown> }).servers;
const capsDone = () =>
  (ircClient as unknown as { capNegotiationComplete: Map<string, boolean> })
    .capNegotiationComplete;

const savedEntry = (id = serverId): ServerConfig =>
  JSON.parse(lsBacking.get("savedServers") ?? "[]").find(
    (s: ServerConfig) => s.id === id,
  );

function saveEntries(entries: Partial<ServerConfig>[]) {
  lsBacking.set(
    "savedServers",
    JSON.stringify(
      entries.map((entry) => ({
        host: "irc.test",
        port: 6697,
        nickname: "me",
        channels: ["#Lounge", "#other"],
        ...entry,
      })),
    ),
  );
}

function seed({
  channels = (id: string) => [channelOn(id), channelOn(id, "#other")],
  server = {},
}: {
  channels?: (id: string) => Channel[];
  server?: Record<string, unknown>;
} = {}) {
  serverId = `left-srv-${++counter}`;
  const servers = [serverId, OTHER_SERVER].map((id) => ({
    id,
    name: "test",
    host: "irc.test",
    port: 6697,
    channels: channels(id),
    privateChats: [],
    isConnected: true,
    users: [],
    ...(id === serverId && server),
  }));
  saveEntries([{ id: serverId }, { id: OTHER_SERVER }]);
  useStore.setState({
    servers,
    messages: {},
    activeBatches: {},
    channelOrder: {},
    globalSettings: { showEvents: true, showKicks: true, showJoinsParts: true },
  } as unknown as Partial<AppState>);
  for (const id of [serverId, OTHER_SERVER]) {
    ircClient.nicks.set(id, "me");
    capsDone().set(id, true);
    clientServers().set(id, {
      id,
      channels: channels(id).map((c) => ({ ...c, users: [] })),
      capabilities: [],
    });
  }
}

const channel = (id = serverId, name = "#Lounge") =>
  useStore
    .getState()
    .servers.find((s) => s.id === id)
    ?.channels.find((c) => c.name === name) as Channel;

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

function ownJoin(username = "me", channelName = "#lounge") {
  ircClient.triggerEvent("JOIN", { serverId, username, channelName });
}

// Hands the client the line that ends registration, as every new connection does.
function welcome(id = serverId) {
  readyProcessedServers.delete(id);
  (
    ircClient as unknown as {
      handleMessage: (data: string, serverId: string) => void;
    }
  ).handleMessage(":irc.test 001 me :Welcome\r\n", id);
  (
    ircClient as unknown as { stopWebSocketPing: (serverId: string) => void }
  ).stopWebSocketPing(id);
}

describe("a channel we were removed from", () => {
  beforeEach(() => {
    installLocalStorageBacking();
    sendRaw = vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const id of [serverId, OTHER_SERVER]) {
      ircClient.nicks.delete(id);
      capsDone().delete(id);
      clientServers().delete(id);
      readyProcessedServers.delete(id);
    }
  });

  test("our own kick marks the channel as left and empties its member list", () => {
    kick("ME");
    expect(channel().leftReason).toBe("kicked");
    expect(channel().users).toEqual([]);
    expect(savedEntry().leftChannels).toEqual({ "#Lounge": "kicked" });
  });

  test("our own part seen from another session marks the channel as left", () => {
    part("me");
    expect(channel().leftReason).toBe("parted");
    expect(channel().users).toEqual([]);
    expect(savedEntry().leftChannels).toEqual({ "#Lounge": "parted" });
  });

  test("someone else leaving keeps us in the channel", () => {
    kick("op");
    part("op");
    expect(channel().leftReason).toBeUndefined();
    expect(channel().users.map((u) => u.username)).toEqual(["me"]);
    expect(savedEntry().leftChannels).toBeUndefined();
  });

  test("a kick on one server leaves the same-named channel of another alone", () => {
    kick("me");
    expect(channel(OTHER_SERVER).leftReason).toBeUndefined();
    expect(channel(OTHER_SERVER).users.map((u) => u.username)).toEqual([
      "me",
      "op",
    ]);
    expect(savedEntry(OTHER_SERVER).leftChannels).toBeUndefined();
  });

  describe("selecting a channel whose member list is empty", () => {
    beforeEach(() => {
      seed({ channels: (id) => [channelOn(id, "#Lounge", ["me"])] });
      useStore.setState((state) => ({
        ui: { ...state.ui, selectedServerId: serverId },
      }));
    });

    test("sends no JOIN after our kick", () => {
      kick("me");
      useStore.getState().selectChannel(channel().id);
      expect(sentJoins()).toEqual([]);
    });

    test("sends JOIN while nothing says we left", () => {
      part("me");
      ownJoin();
      sendRaw.mockClear();
      useStore.getState().selectChannel(channel().id);
      expect(sentJoins()).toEqual(["JOIN #Lounge"]);
    });
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
    ownJoin();
    expect(channel().leftReason).toBeUndefined();
    expect(savedEntry().leftChannels).toEqual({});
    expect(sentLines()).toEqual([
      expect.stringMatching(/^WHO #lounge %tcuhnfaro,\d+$/),
    ]);
  });

  test("our JOIN counts when the server spells our nick in another case", () => {
    kick("me");
    ownJoin("ME");
    expect(channel().leftReason).toBeUndefined();
    expect(channel().users).toEqual([]);
  });

  test("joining again a channel the client no longer tracks loads it once", () => {
    kick("me");
    (clientServers().get(serverId) as { capabilities: string[] }).capabilities =
      ["draft/chathistory"];
    ircClient.forgetChannel(serverId, "#Lounge");
    sendRaw.mockClear();
    useStore.getState().joinChannel(serverId, "#Lounge");
    expect(sentLines()).toEqual(["JOIN #Lounge"]);
    ownJoin("me", "#Lounge");
    expect(sentLines()).toEqual([
      "JOIN #Lounge",
      "CHATHISTORY LATEST #Lounge * 50",
    ]);
    ircClient.triggerEvent("CHATHISTORY_LOADING", {
      serverId,
      channelName: "#Lounge",
      isLoading: false,
    });
    expect(sentLines().slice(2)).toEqual([
      expect.stringMatching(/^WHO #Lounge %tcuhnfaro,\d+$/),
    ]);
  });

  describe("a new connection", () => {
    test("joins the saved channels we are in and passes by the one we were kicked from", () => {
      kick("me");
      sendRaw.mockClear();
      welcome();
      expect(sentJoins().length).toBeGreaterThan(0);
      expect(new Set(sentJoins())).toEqual(new Set(["JOIN #other"]));
      expect(channel().leftReason).toBe("kicked");
    });

    test("passes by a channel one of our other sessions left", () => {
      part("me");
      sendRaw.mockClear();
      welcome();
      expect(new Set(sentJoins())).toEqual(new Set(["JOIN #other"]));
    });

    test("stays out after a rejoin the server refused", () => {
      kick("me");
      useStore.getState().joinChannel(serverId, "#Lounge");
      ircClient.triggerEvent("JOIN_REFUSED", {
        serverId,
        channelName: "#Lounge",
        isThrottled: false,
        numeric: "474",
      });
      expect(channel().leftReason).toBe("kicked");
      sendRaw.mockClear();
      welcome();
      expect(new Set(sentJoins())).toEqual(new Set(["JOIN #other"]));
    });

    test("joins the channel again once the user has rejoined it", () => {
      kick("me");
      useStore.getState().joinChannel(serverId, "#Lounge");
      ownJoin();
      sendRaw.mockClear();
      welcome();
      expect(new Set(sentJoins())).toEqual(
        new Set(["JOIN #Lounge", "JOIN #other"]),
      );
    });

    test("after a page load shows the channel as left without joining it", () => {
      const reloaded = `left-srv-reloaded-${++counter}`;
      saveEntries([
        { id: reloaded, leftChannels: { "#Lounge": "kicked" } },
        { id: OTHER_SERVER },
      ]);
      useStore.setState((state) => ({
        servers: [
          { ...state.servers[0], id: reloaded, channels: [] },
          state.servers[1],
        ],
      }));
      ircClient.nicks.set(reloaded, "me");
      clientServers().set(reloaded, {
        id: reloaded,
        channels: [],
        capabilities: [],
      });
      sendRaw.mockClear();

      welcome(reloaded);

      const rows = useStore.getState().servers[0].channels;
      expect(rows.map((c) => [c.name, c.leftReason])).toEqual([
        ["#Lounge", "kicked"],
        ["#other", undefined],
      ]);
      expect(new Set(sentJoins())).toEqual(new Set(["JOIN #other"]));
      ircClient.nicks.delete(reloaded);
      clientServers().delete(reloaded);
      readyProcessedServers.delete(reloaded);
    });

    test("the user starts by hand keeps the channel as left before and after the server greets us", async () => {
      kick("me");
      useStore.setState((state) => ({
        servers: state.servers.map((s) =>
          s.id === serverId ? { ...s, isConnected: false } : s,
        ),
      }));
      vi.spyOn(ircClient, "connect").mockResolvedValue(
        clientServers().get(serverId) as never,
      );
      sendRaw.mockClear();

      await useStore
        .getState()
        .connect(
          "test",
          "irc.test",
          6697,
          "me",
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          serverId,
        );

      expect(channel().leftReason).toBe("kicked");
      expect(channel().users).toEqual([]);
      welcome();
      expect(channel().leftReason).toBe("kicked");
      expect(new Set(sentJoins())).toEqual(new Set(["JOIN #other"]));
    });

    test("after the server was removed starts with no channel marked as left", () => {
      kick("me");
      useStore.getState().deleteServer(serverId);
      useStore.setState((state) => ({
        servers: [
          {
            ...state.servers[0],
            id: serverId,
            channels: [],
          },
          ...state.servers,
        ],
      }));
      saveEntries([{ id: serverId }, { id: OTHER_SERVER }]);
      clientServers().set(serverId, {
        id: serverId,
        channels: [],
        capabilities: [],
      });

      welcome();

      expect(channel().leftReason).toBeUndefined();
      expect(sentJoins()).toContain("JOIN #Lounge");
    });

    test.each([
      ["a string", "#Lounge"],
      ["a list", ["#Lounge"]],
      ["a reason we never write", { "#Lounge": "banned" }],
      ["a name that is no channel", { Lounge: "kicked", "#a b": "parted" }],
    ])("ignores a saved mark that is %s", (_what, leftChannels) => {
      const loaded = `left-srv-loaded-${++counter}`;
      saveEntries([
        { id: loaded, leftChannels: leftChannels as never },
        { id: OTHER_SERVER },
      ]);
      useStore.setState((state) => ({
        servers: [
          { ...state.servers[0], id: loaded, channels: [] },
          state.servers[1],
        ],
      }));
      ircClient.nicks.set(loaded, "me");
      clientServers().set(loaded, {
        id: loaded,
        channels: [],
        capabilities: [],
      });
      sendRaw.mockClear();

      welcome(loaded);

      const rows = useStore.getState().servers[0].channels;
      expect(rows.map((c) => [c.name, c.leftReason])).toEqual([
        ["#Lounge", undefined],
        ["#other", undefined],
      ]);
      expect(new Set(sentJoins())).toEqual(
        new Set(["JOIN #Lounge", "JOIN #other"]),
      );
      ircClient.nicks.delete(loaded);
      clientServers().delete(loaded);
      readyProcessedServers.delete(loaded);
    });

    test("to a bouncer shows the channel as left until the bouncer joins us", () => {
      seed({ channels: () => [], server: { bouncerNetid: "1" } });
      saveEntries([
        { id: serverId, channels: [], leftChannels: { "#Lounge": "kicked" } },
        { id: OTHER_SERVER },
      ]);
      welcome();
      expect(sentJoins()).toEqual([]);
      expect(channel().leftReason).toBe("kicked");

      ownJoin();
      expect(channel().leftReason).toBeUndefined();
      expect(savedEntry().leftChannels).toEqual({});
    });
  });

  test("a join nobody asked for passes by a channel we left, and the user's join goes out", () => {
    kick("me");
    sendRaw.mockClear();
    useStore
      .getState()
      .joinChannel(serverId, "#lounge", undefined, { isAutomatic: true });
    expect(sentJoins()).toEqual([]);
    useStore.getState().joinChannel(serverId, "#lounge");
    expect(sentJoins()).toEqual(["JOIN #lounge"]);
  });

  test("our kick from the channel of a running call ends the call", () => {
    seed({ channels: (id) => [channelOn(id, "^Lounge")] });
    const call = {
      serverId,
      channel: "^Lounge",
      selfNick: "me",
      onState() {},
      onError() {},
    };
    acquireVoiceClient(call);
    expect(hasActiveVoiceClient(serverId, "^Lounge")).toBe(true);

    kick("me", "^lounge");

    expect(hasActiveVoiceClient(serverId, "^Lounge")).toBe(false);
    sendRaw.mockClear();
    expect(acquireVoiceClient(call)).toBeNull();
    expect(sentJoins()).toEqual([]);
    shutdownAllVoiceClients();
  });

  test("closing a channel we were kicked from on a bouncer parts it and forgets it", () => {
    seed({ server: { bouncerNetid: "1" } });
    kick("me");
    expect(savedEntry().leftChannels).toEqual({ "#Lounge": "kicked" });
    sendRaw.mockClear();

    useStore.getState().leaveChannel(serverId, "#lounge");

    expect(sentLines()).toEqual(["PART #lounge"]);
    expect(savedEntry().leftChannels).toEqual({});
    welcome();
    expect(channel()).toBeUndefined();
    expect(sentJoins()).not.toContain("JOIN #Lounge");
  });
});
