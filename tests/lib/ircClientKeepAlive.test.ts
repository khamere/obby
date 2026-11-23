import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IRCClient } from "../../src/lib/irc/IRCClient";

const SERVER = "srv";
const PONG_TIMEOUT_MS = 10_000;
const WAKE_PONG_TIMEOUT_MS = 5_000;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static last: FakeWebSocket;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeWebSocket.last = this;
  }
  send(raw: string) {
    this.sent.push(raw);
  }
  receive(line: string) {
    this.onmessage?.({ data: `${line}\r\n` });
  }
  pings() {
    return this.sent.filter((line) => line.startsWith("PING :")).length;
  }
}

// We connect through the client so lines reach it the way a real socket delivers them.
function connectedClient() {
  const client = new IRCClient();
  void client
    .connect(
      "srv",
      "wss://irc.test",
      443,
      "me",
      undefined,
      undefined,
      undefined,
      SERVER,
    )
    .catch(() => {});
  return { client, socket: FakeWebSocket.last };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("waiting for the answer to a keep-alive PING", () => {
  it("keeps a connection whose PONG is late while other lines still arrive", () => {
    const { client, socket } = connectedClient();
    client.checkAlive(SERVER, PONG_TIMEOUT_MS);
    expect(socket.pings()).toBe(1);
    for (let elapsed = 0; elapsed < 60_000; elapsed += 2000) {
      vi.advanceTimersByTime(2000);
      socket.receive(":me!u@h PRIVMSG #a :one more line");
    }
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("drops the connection at the next check once the lines have stopped", () => {
    const { client, socket } = connectedClient();
    client.checkAlive(SERVER, PONG_TIMEOUT_MS);
    vi.advanceTimersByTime(8000);
    socket.receive(":me!u@h PRIVMSG #a :the last line");
    vi.advanceTimersByTime(60_000);
    expect(socket.close).not.toHaveBeenCalled();
    client.checkAlive(SERVER, PONG_TIMEOUT_MS);
    vi.advanceTimersByTime(PONG_TIMEOUT_MS - 1);
    expect(socket.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("drops a silent connection when the wait ends", () => {
    const { client, socket } = connectedClient();
    client.checkAlive(SERVER, PONG_TIMEOUT_MS);
    vi.advanceTimersByTime(PONG_TIMEOUT_MS - 1);
    expect(socket.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("drops a silent connection after the shorter wait of a wake check", () => {
    const { client, socket } = connectedClient();
    client.checkAlive(SERVER, WAKE_PONG_TIMEOUT_MS);
    vi.advanceTimersByTime(WAKE_PONG_TIMEOUT_MS);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("ends a wake check on the first line and gives the next one its shorter wait", () => {
    const { client, socket } = connectedClient();
    client.checkAlive(SERVER, WAKE_PONG_TIMEOUT_MS);
    vi.advanceTimersByTime(4000);
    socket.receive(":me!u@h PRIVMSG #a :a line");
    vi.advanceTimersByTime(60_000);
    expect(socket.close).not.toHaveBeenCalled();
    client.checkAlive(SERVER, WAKE_PONG_TIMEOUT_MS);
    vi.advanceTimersByTime(WAKE_PONG_TIMEOUT_MS - 1);
    expect(socket.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("ends the wait when the PONG arrives", () => {
    const { client, socket } = connectedClient();
    client.checkAlive(SERVER, PONG_TIMEOUT_MS);
    vi.advanceTimersByTime(3000);
    socket.receive(":irc.test PONG irc.test :1");
    vi.advanceTimersByTime(60_000);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("ends the wait when the PONG arrives after other lines", () => {
    const { client, socket } = connectedClient();
    client.checkAlive(SERVER, PONG_TIMEOUT_MS);
    vi.advanceTimersByTime(9000);
    socket.receive(":me!u@h PRIVMSG #a :a line");
    vi.advanceTimersByTime(9000);
    socket.receive(":irc.test PONG irc.test :1");
    vi.advanceTimersByTime(60_000);
    expect(socket.close).not.toHaveBeenCalled();
    client.checkAlive(SERVER, PONG_TIMEOUT_MS);
    expect(socket.pings()).toBe(2);
  });

  it("leaves a wait alone when lines are replayed from local history", () => {
    const { client, socket } = connectedClient();
    client.checkAlive(SERVER, PONG_TIMEOUT_MS);
    vi.advanceTimersByTime(8000);
    client.replayLines(SERVER, [":me!u@h PRIVMSG #a :a stored line"]);
    vi.advanceTimersByTime(2000);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});
