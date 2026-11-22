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

  fail(): void {
    this.readyState = WebSocket.CLOSED;
    this.onerror?.(new Error("unreachable"));
  }

  receive(line: string): void {
    this.onmessage?.({ data: `${line}\r\n` });
  }
}

const sockets: FakeSocket[] = [];
const latest = () => sockets[sockets.length - 1];

const dial = (client: IRCClient, login = true) =>
  client.connect(
    "Net",
    "wss://irc.example/socket",
    443,
    "alice",
    undefined,
    login ? "alice" : undefined,
    login ? "secret" : undefined,
    SERVER,
  );

async function connect(client: IRCClient, login = true): Promise<void> {
  const connected = dial(client, login);
  latest().open();
  await connected;
}

async function failToConnect(client: IRCClient): Promise<void> {
  const connected = dial(client);
  latest().fail();
  await expect(connected).rejects.toThrow();
}

// The retry due after this wait finds the server unreachable.
async function failRetryAfter(ms: number): Promise<void> {
  const before = sockets.length;
  await vi.advanceTimersByTimeAsync(ms);
  expect(sockets).toHaveLength(before + 1);
  latest().fail();
  await vi.advanceTimersByTimeAsync(0);
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

  test("retries as usual on the connection the user opens after a refused login", async () => {
    await connect(client);
    latest().receive(":irc.example 904 * :Authentication failed");
    latest().close();
    client.disconnect(SERVER);
    await connect(client);
    latest().close();
    expect(await retryAfter(2000)).toBe(true);
  });

  test("stops when the saved login is gone and the server only takes accounts", async () => {
    await connect(client);
    client.setSaslEnabled(SERVER, false);
    latest().receive(
      ":irc.example FAIL * ACCOUNT_REQUIRED :Authentication required",
    );
    latest().close();
    expect(await retryAfter(600_000)).toBe(false);
  });

  test("a wake keeps the wait for a server that closed before its welcome", async () => {
    await connect(client);
    latest().close();
    await retryAfter(2000);
    latest().close();
    client.wakeReconnect(SERVER);
    expect(await retryAfter(3999)).toBe(false);
    expect(await retryAfter(1)).toBe(true);
  });

  test("a wake retries at once a server that had welcomed us", async () => {
    await connect(client);
    latest().receive(":irc.example 001 alice :Welcome");
    latest().close();
    const before = sockets.length;
    client.wakeReconnect(SERVER);
    expect(sockets).toHaveLength(before + 1);
  });

  test("a wake leaves a server we closed ourselves alone", async () => {
    await connect(client);
    latest().receive(":irc.example 001 alice :Welcome");
    client.disconnect(SERVER);
    const before = sockets.length;
    client.wakeReconnect(SERVER);
    expect(await retryAfter(600_000)).toBe(false);
    expect(sockets).toHaveLength(before);
    expect(client.getConnectTarget(SERVER)).toBeUndefined();
  });

  test("a wake redials at once a server no attempt has reached yet", async () => {
    await failToConnect(client);
    client.wakeReconnect(SERVER);
    await failRetryAfter(2000);
    await failRetryAfter(4000);
    await vi.advanceTimersByTimeAsync(5000);
    const before = sockets.length;
    client.wakeReconnect(SERVER);
    expect(sockets).toHaveLength(before + 1);
  });

  test("a wake redials at once a welcomed server whose retries could not connect", async () => {
    await connect(client);
    latest().receive(":irc.example 001 alice :Welcome");
    latest().close();
    await failRetryAfter(2000);
    await failRetryAfter(4000);
    const before = sockets.length;
    client.wakeReconnect(SERVER);
    expect(sockets).toHaveLength(before + 1);
  });

  test("stops when a server that welcomed us earlier refuses the login on a reconnect", async () => {
    const refused = vi.fn();
    client.on("loginRefused", refused);
    await connect(client);
    latest().receive(":irc.example 001 alice :Welcome");
    latest().close();
    expect(await retryAfter(2000)).toBe(true);
    latest().receive(":irc.example 904 * :Authentication failed");
    latest().close();
    expect(refused).toHaveBeenCalledWith({ serverId: SERVER });
    expect(await retryAfter(600_000)).toBe(false);
  });

  test("keeps reconnecting when a login fails on a connection the server had welcomed", async () => {
    await connect(client);
    latest().receive(":irc.example 001 alice :Welcome");
    latest().receive(":irc.example 904 alice :SASL authentication failed");
    latest().close();
    expect(await retryAfter(2000)).toBe(true);
  });

  test("a refusal ends with its connection when a new one replaces it", async () => {
    await connect(client);
    latest().receive(":irc.example 904 * :Authentication failed");
    await connect(client);
    latest().close();
    expect(await retryAfter(2000)).toBe(true);
  });

  test("a wake retries a server the user reconnected after a refusal and could not reach", async () => {
    await connect(client);
    latest().receive(":irc.example 904 * :Authentication failed");
    latest().close();
    client.disconnect(SERVER);
    await failToConnect(client);
    client.wakeReconnect(SERVER);
    expect(await retryAfter(2000)).toBe(true);
  });

  test("a wake redials at once a server that welcomed us after turning us away", async () => {
    await connect(client);
    latest().close();
    expect(await retryAfter(2000)).toBe(true);
    latest().receive(":irc.example 001 alice :Welcome");
    latest().close();
    const before = sockets.length;
    client.wakeReconnect(SERVER);
    expect(sockets).toHaveLength(before + 1);
  });

  test("a wake redials at once a server the user reconnected after it turned us away", async () => {
    await connect(client);
    latest().close();
    client.disconnect(SERVER);
    await failToConnect(client);
    client.wakeReconnect(SERVER);
    await failRetryAfter(2000);
    await vi.advanceTimersByTimeAsync(3000);
    const before = sockets.length;
    client.wakeReconnect(SERVER);
    expect(sockets).toHaveLength(before + 1);
  });
});
