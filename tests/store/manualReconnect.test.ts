import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import { saveLeftReason } from "../../src/lib/leftChannels";
import type { AppState } from "../../src/store";
import useStore from "../../src/store";
import { _resetWhoReplyBatcher } from "../../src/store/whoReplyBatcher";
import type { Channel, Message, Server } from "../../src/types";
import {
  installLocalStorageBacking,
  lsBacking,
} from "../fixtures/localStorageBacking";

// A reconnect the user asks for goes through the store's connect, which gets
// back the server object the client has kept since the first connection.
const serverId = "manual-srv";
const channelNames = ["#one", "#two"];

type ClientInternals = {
  servers: Map<string, Server>;
  sockets: Map<string, unknown>;
  handleMessage: (data: string, serverId: string) => void;
};
const client = ircClient as unknown as ClientInternals;

let sent: string[] = [];

function openSocket() {
  return {
    readyState: WebSocket.OPEN,
    send: (line: string) => sent.push(line),
    close() {},
  };
}

function receive(...lines: string[]) {
  client.handleMessage(lines.map((line) => `${line}\r\n`).join(""), serverId);
}

function server(): Server {
  const found = useStore.getState().servers.find((s) => s.id === serverId);
  if (!found) throw new Error("server missing");
  return found;
}

function channel(name: string): Channel {
  const found = server().channels.find((c) => c.name === name);
  if (!found) throw new Error(`${name} missing`);
  return found;
}

function linesStarting(prefix: string): string[] {
  return sent.filter((line) => line.startsWith(prefix));
}

function capsAndWelcome() {
  receive(
    ":irc.test CAP * ACK :draft/chathistory batch",
    ":irc.test 001 me :Welcome",
  );
}

function ownJoin(name: string) {
  receive(`:me!u@h JOIN ${name}`);
}

function historyReply(name: string, tag: string, texts: string[]) {
  receive(
    `:irc.test BATCH +${tag} chathistory ${name}`,
    ...texts.map(
      (text, i) =>
        `@batch=${tag};msgid=${tag}-${i};time=2026-01-01T00:00:0${i}.000Z :bob!u@h PRIVMSG ${name} :${text}`,
    ),
    `:irc.test BATCH -${tag}`,
  );
}

function membersReply(name: string, nicks: string[]) {
  const request = linesStarting(`WHO ${name} `).at(-1);
  const token = request?.split(",")[1];
  receive(
    ...nicks.map(
      (nick) => `:irc.test 354 me ${token} ${name} u h ${nick} H 0 0 :${nick}`,
    ),
    `:irc.test 315 me ${name} :End of WHO list`,
  );
}

function texts(name: string): string[] {
  const key = `${serverId}-${channel(name).id}`;
  return (useStore.getState().messages[key] ?? [])
    .filter((m: Message) => m.type === "message")
    .map((m: Message) => m.content);
}

function memberNames(name: string): string[] {
  return channel(name)
    .users.map((u) => u.username)
    .sort();
}

// The first connection: we join both channels, load their history and members.
function connectAndJoin() {
  client.servers.set(serverId, {
    id: serverId,
    name: "test",
    host: "irc.test",
    port: 443,
    channels: [],
    privateChats: [],
    isConnected: true,
    connectionState: "connected",
    users: [],
    capabilities: [],
  });
  client.sockets.set(serverId, openSocket());
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "test",
        host: "irc.test",
        port: 443,
        channels: [],
        privateChats: [],
        isConnected: true,
        connectionState: "connected",
        users: [],
        capabilities: [],
      },
    ],
    messages: {},
    activeBatches: {},
  } as unknown as Partial<AppState>);
  capsAndWelcome();
  for (const name of channelNames) {
    useStore.getState().joinChannel(serverId, name);
    ownJoin(name);
    historyReply(name, `first${name.slice(1)}`, ["before the reconnect"]);
    membersReply(name, ["me", "bob"]);
  }
}

// The client's connect as the store sees it: the server object it has kept, on a new open socket.
function resolveKeptServer() {
  return vi.spyOn(ircClient, "connect").mockImplementation(async () => {
    const kept = client.servers.get(serverId);
    if (!kept) throw new Error("the client kept no server");
    client.sockets.set(serverId, openSocket());
    kept.capabilities = [];
    kept.isConnected = true;
    kept.connectionState = "connected";
    ircClient.triggerEvent("connectionStateChange", {
      serverId,
      connectionState: "connected",
    });
    return kept;
  });
}

async function afterReadyTimers() {
  await vi.advanceTimersByTimeAsync(100);
}

describe("a reconnect the user asks for", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    installLocalStorageBacking();
    lsBacking.set(
      "savedServers",
      JSON.stringify([
        {
          id: serverId,
          name: "test",
          host: "wss://irc.test",
          port: 443,
          nickname: "me",
          channels: [],
          saslEnabled: false,
        },
      ]),
    );
    sent = [];
    _resetWhoReplyBatcher();
    vi.spyOn(console, "error").mockImplementation(() => {});
    connectAndJoin();
    await afterReadyTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetWhoReplyBatcher();
    client.servers.delete(serverId);
    client.sockets.delete(serverId);
    ircClient.nicks.delete(serverId);
  });

  test("the first connection leaves both channels loaded", () => {
    for (const name of channelNames) {
      expect(channel(name).isLoadingHistory).toBe(false);
      expect(memberNames(name)).toEqual(["bob", "me"]);
      expect(texts(name)).toEqual(["before the reconnect"]);
    }
  });

  test.each([
    ["from a live connection", false],
    ["after the user disconnected", true],
  ])(
    "%s asks every channel for its members and the messages we missed",
    async (_, isDisconnectedFirst) => {
      resolveKeptServer();
      if (isDisconnectedFirst) useStore.getState().disconnect(serverId);
      sent = [];

      await useStore.getState().reconnectServer(serverId);
      capsAndWelcome();
      await afterReadyTimers();
      for (const name of channelNames) ownJoin(name);

      for (const name of channelNames) {
        expect(linesStarting(`CHATHISTORY LATEST ${name} `)).toHaveLength(1);
        expect(channel(name).isLoadingHistory).toBe(true);
        historyReply(name, `again${name.slice(1)}`, [
          "before the reconnect",
          "while we were away",
        ]);
        expect(linesStarting(`WHO ${name} `)).toEqual([
          expect.stringMatching(`^WHO ${name} %tcuhnfaro,\\d{1,3}$`),
        ]);
        membersReply(name, ["me", "carol"]);

        expect(channel(name).isLoadingHistory).toBe(false);
        expect(memberNames(name)).toEqual(["carol", "me"]);
        expect(texts(name)).toContain("before the reconnect");
        expect(texts(name)).toContain("while we were away");
      }
    },
  );

  test("the rows keep what this session put on them", async () => {
    resolveKeptServer();
    const readMarker = "2025-12-31T00:00:00.000Z";
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        privateChats: [
          {
            id: "pm-bob",
            username: "bob",
            serverId,
            unreadCount: 0,
            isMentioned: false,
            readMarker,
            readMarkerFetched: true,
          },
        ],
        channels: s.channels.map((c) =>
          c.name === "#one" ? { ...c, topic: "the topic", readMarker } : c,
        ),
      })),
    }));
    expect(channel("#one").unreadCount).toBe(1);

    await useStore.getState().reconnectServer(serverId);

    expect(channel("#one")).toMatchObject({
      topic: "the topic",
      readMarker,
      unreadCount: 1,
    });
    expect(texts("#one")).toEqual(["before the reconnect"]);
    expect(memberNames("#one")).toEqual(["bob", "me"]);
    expect(server().privateChats).toMatchObject([
      { username: "bob", readMarker },
    ]);
  });

  test("a channel we were removed from stays marked and is left alone", async () => {
    resolveKeptServer();
    saveLeftReason(serverId, "#two", "kicked");
    useStore.setState((state) => ({
      servers: state.servers.map((s) => ({
        ...s,
        channels: s.channels.map((c) =>
          c.name === "#two" ? { ...c, leftReason: "kicked", users: [] } : c,
        ),
      })),
    }));
    sent = [];

    await useStore.getState().reconnectServer(serverId);
    capsAndWelcome();
    await afterReadyTimers();

    expect(channel("#two").leftReason).toBe("kicked");
    expect(channel("#two").isLoadingHistory).toBeFalsy();
    expect(linesStarting("JOIN #two")).toEqual([]);
    expect(linesStarting("CHATHISTORY LATEST #two")).toEqual([]);
    expect(texts("#two")).toEqual(["before the reconnect"]);
  });
});
