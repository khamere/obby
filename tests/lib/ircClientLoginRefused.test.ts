import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { IRCClient } from "../../src/lib/irc/IRCClient";

const SERVER = "srv";

class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  send(line: string): void {
    this.sent.push(line);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }

  receive(line: string): void {
    this.onmessage?.({ data: `${line}\r\n` });
  }
}

const sockets: FakeSocket[] = [];
const latest = () => sockets[sockets.length - 1];

async function connect(client: IRCClient, login = true): Promise<void> {
  const connected = client.connect(
    "Net",
    "wss://irc.example/socket",
    443,
    "alice",
    undefined,
    login ? "alice" : undefined,
    login ? "secret" : undefined,
    SERVER,
  );
  latest().open();
  await connected;
}

// Lets the server answer the socket a retry just opened.
async function retryAfter(ms: number): Promise<boolean> {
  const before = sockets.length;
  await vi.advanceTimersByTimeAsync(ms);
  if (sockets.length === before) return false;
  latest().open();
  await vi.advanceTimersByTimeAsync(0);
  return true;
}

describe("retrying a connection the server keeps closing", () => {
  let client: IRCClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    sockets.length = 0;
    vi.stubGlobal(
      "WebSocket",
      Object.assign(
        function construct() {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
      ),
    );
    client = new IRCClient();
  });

  afterEach(() => {
    client.removeServer(SERVER);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("waits longer after each attempt that closes before the welcome", async () => {
    await connect(client);
    latest().close();
    expect(await retryAfter(2000)).toBe(true);
    latest().close();
    expect(await retryAfter(2000)).toBe(false);
    expect(await retryAfter(2000)).toBe(true);
    latest().close();
    expect(await retryAfter(4000)).toBe(false);
    expect(await retryAfter(4000)).toBe(true);
  });

  test("starts over with the short delay once the server has welcomed us", async () => {
    await connect(client);
    latest().close();
    await retryAfter(2000);
    latest().close();
    await retryAfter(4000);
    latest().receive(":irc.example 001 alice :Welcome");
    latest().close();
    expect(await retryAfter(2000)).toBe(true);
  });

  test.each([
    [":irc.example 904 * :Authentication failed", true],
    [":irc.example 464 * :Password incorrect", true],
    [":irc.example FAIL * ACCOUNT_REQUIRED :Authentication required", false],
  ])("stops retrying after %s and a close", async (line, login) => {
    const refused = vi.fn();
    client.on("loginRefused", refused);
    await connect(client, login);
    latest().receive(line);
    latest().close();

    expect(refused).toHaveBeenCalledWith({ serverId: SERVER });
    expect(client.servers.get(SERVER)?.connectionState).toBe("disconnected");
    expect(await retryAfter(600_000)).toBe(false);
    client.wakeReconnect(SERVER);
    expect(await retryAfter(600_000)).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  test("retries when the server asked for a login we never got to send", async () => {
    await connect(client);
    latest().receive(
      ":irc.example FAIL * ACCOUNT_REQUIRED :Authentication required",
    );
    latest().close();
    expect(await retryAfter(2000)).toBe(true);
  });

  test("keeps reconnecting a server that let us in as a guest after 904", async () => {
    await connect(client);
    latest().receive(":irc.example 904 alice :SASL authentication failed");
    latest().receive(":irc.example 001 alice :Welcome");
    latest().close();
    expect(await retryAfter(2000)).toBe(true);
  });

  test("tries again when the user reconnects after a refused login", async () => {
    await connect(client);
    latest().receive(":irc.example 904 * :Authentication failed");
    latest().close();
    client.disconnect(SERVER);
    await connect(client);
    latest().receive(":irc.example 001 alice :Welcome");
    latest().close();
    expect(await retryAfter(2000)).toBe(true);
  });
});
