import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import type { AppState } from "../../src/store";
import useStore, { serverSupportsMultiline } from "../../src/store";
import {
  serverSupportsChathistory,
  serverTracksReadMarker,
} from "../../src/store/helpers";
import type { Channel, Server } from "../../src/types";
import { installLocalStorageBacking } from "../fixtures/localStorageBacking";

// The server we come back to can offer less than the one we left: it was
// restarted with another configuration, or a bouncer's upstream changed.
class MockWebSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(...lines: string[]): void {
    for (const line of lines) {
      this.onmessage?.(new MessageEvent("message", { data: `${line}\r\n` }));
    }
  }

  linesStarting(prefix: string): string[] {
    return this.sent.filter((line) => line.startsWith(prefix));
  }
}

const sockets: MockWebSocket[] = [];
function nextSocket() {
  const socket = sockets.shift();
  if (!socket) throw new Error("no socket queued");
  return socket;
}
vi.stubGlobal(
  "WebSocket",
  Object.assign(vi.fn(nextSocket), {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  }),
);

const serverId = "caps-srv";
const FULL =
  "batch draft/chathistory draft/multiline draft/read-marker server-time";
const LESS = "batch server-time";

function storeServer(): Server {
  const found = useStore.getState().servers.find((s) => s.id === serverId);
  if (!found) throw new Error("server missing");
  return found;
}

const storeCapabilities = () => [...(storeServer().capabilities ?? [])].sort();

function clientCapabilities(): string[] {
  const kept = (
    ircClient as unknown as { servers: Map<string, Server> }
  ).servers.get(serverId);
  return [...(kept?.capabilities ?? [])].sort();
}

function channel(name: string): Channel {
  const found = storeServer().channels.find((c) => c.name === name);
  if (!found) throw new Error(`${name} missing`);
  return found;
}

function negotiate(socket: MockWebSocket, capabilities: string) {
  socket.receive(
    `:irc.example CAP * LS :${capabilities}`,
    `:irc.example CAP * ACK :${capabilities}`,
    ":irc.example 900 alice alice!u@h alice :You are now logged in as alice",
    ":irc.example 001 alice :Welcome",
  );
}

async function connect(capabilities: string): Promise<MockWebSocket> {
  const socket = new MockWebSocket();
  sockets.push(socket);
  const connected = ircClient.connect(
    "Net",
    "wss://irc.example/socket",
    443,
    "alice",
    undefined,
    undefined,
    undefined,
    serverId,
  );
  socket.open();
  await connected;
  negotiate(socket, capabilities);
  return socket;
}

// The link drops and the client dials again on its own, which never passes through the store's connect.
async function reconnect(
  dropped: MockWebSocket,
  capabilities: string,
): Promise<MockWebSocket> {
  const socket = new MockWebSocket();
  sockets.push(socket);
  dropped.close();
  await vi.advanceTimersByTimeAsync(3001);
  socket.open();
  await Promise.resolve();
  negotiate(socket, capabilities);
  return socket;
}

describe("capabilities after the client reconnects on its own", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installLocalStorageBacking();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    sockets.length = 0;
    useStore.setState({
      servers: [
        {
          id: serverId,
          name: "Net",
          host: "irc.example",
          port: 443,
          channels: [],
          privateChats: [],
          isConnected: false,
          connectionState: "connecting",
          users: [],
        },
      ],
      messages: {},
      activeBatches: {},
    } as unknown as Partial<AppState>);
  });

  afterEach(() => {
    ircClient.removeServer(serverId);
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    useStore.setState({ servers: [] });
  });

  test("the store enables what the first connection acknowledged", async () => {
    await connect(FULL);

    expect(storeCapabilities()).toEqual(FULL.split(" "));
    expect(storeCapabilities()).toEqual(clientCapabilities());
  });

  test("the store enables only what the new connection acknowledged", async () => {
    const first = await connect(FULL);
    await reconnect(first, LESS);

    expect(storeCapabilities()).toEqual(LESS.split(" "));
    expect(storeCapabilities()).toEqual(clientCapabilities());
    const state = useStore.getState();
    expect(serverSupportsChathistory(state, serverId)).toBe(false);
    expect(serverSupportsMultiline(serverId)).toBe(false);
    expect(serverTracksReadMarker(state, serverId)).toBe(false);
  });

  test("the store keeps what the new connection acknowledged again", async () => {
    const first = await connect(FULL);
    await reconnect(first, FULL);

    expect(storeCapabilities()).toEqual(FULL.split(" "));
    const state = useStore.getState();
    expect(serverSupportsChathistory(state, serverId)).toBe(true);
    expect(serverTracksReadMarker(state, serverId)).toBe(true);
  });

  test("we ask a server that lost its history for no conversation list", async () => {
    const first = await connect(FULL);
    await vi.advanceTimersByTimeAsync(100);
    expect(first.linesStarting("CHATHISTORY TARGETS ")).toHaveLength(1);

    const second = await reconnect(first, LESS);
    await vi.advanceTimersByTimeAsync(100);

    expect(second.linesStarting("CHATHISTORY ")).toEqual([]);
  });

  test("a channel another session of ours joins waits for no history from a server that lost it", async () => {
    const first = await connect(FULL);
    const second = await reconnect(first, LESS);

    second.receive(":alice!u@h JOIN #late");

    expect(second.linesStarting("CHATHISTORY ")).toEqual([]);
    expect(second.linesStarting("WHO #late ")).toHaveLength(1);
    expect(channel("#late").isLoadingHistory).toBe(false);
    expect(channel("#late").hasMoreHistory).toBe(false);
  });

  test("a channel another session of ours joins loads its history from a server that kept it", async () => {
    const first = await connect(FULL);
    const second = await reconnect(first, FULL);

    second.receive(":alice!u@h JOIN #late");

    expect(second.linesStarting("CHATHISTORY LATEST #late ")).toHaveLength(1);
    expect(channel("#late").isLoadingHistory).toBe(true);
  });
});
