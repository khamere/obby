import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { IRCClient } from "../../src/lib/ircClient";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(...lines: string[]): void {
    for (const line of lines) {
      this.onmessage?.(new MessageEvent("message", { data: `${line}\r\n` }));
    }
  }

  requests(): string[] {
    return this.sent.filter((line) => line.startsWith("CAP REQ"));
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

const serverId = "cap-srv";

describe("capability negotiation", () => {
  let client: IRCClient;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    client = new IRCClient();
  });
  afterEach(() => {
    client.removeServer(serverId);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function connect(sasl = false): Promise<MockWebSocket> {
    const socket = new MockWebSocket();
    sockets.push(socket);
    const connected = client.connect(
      "Net",
      "wss://irc.example/socket",
      443,
      "alice",
      undefined,
      sasl ? "alice" : undefined,
      sasl ? "secret" : undefined,
      serverId,
    );
    socket.open();
    await connected;
    return socket;
  }

  async function reconnect(dropped: MockWebSocket): Promise<MockWebSocket> {
    const socket = new MockWebSocket();
    sockets.push(socket);
    dropped.close();
    await vi.advanceTimersByTimeAsync(3001);
    socket.open();
    await Promise.resolve();
    return socket;
  }

  describe("after a reconnect", () => {
    test("requests only what the new connection lists, not what CAP NEW added before", async () => {
      const first = await connect();
      first.receive(
        ":irc.example CAP * LS :batch server-time",
        ":irc.example CAP alice ACK :batch server-time",
        ":irc.example 001 alice :Welcome",
        ":irc.example CAP alice NEW :draft/event-playback sasl=PLAIN",
      );
      expect(first.requests()).toEqual([
        "CAP REQ :batch server-time",
        "CAP REQ :draft/event-playback",
      ]);

      const second = await reconnect(first);
      second.receive(":irc.example CAP * LS :batch server-time");
      expect(second.requests()).toEqual(["CAP REQ :batch server-time"]);
    });

    test("forgets a capability list the old connection never finished", async () => {
      const first = await connect();
      first.receive(":irc.example CAP * LS * :batch draft/chathistory");

      const second = await reconnect(first);
      second.receive(":irc.example CAP * LS :batch server-time");
      expect(second.requests()).toEqual(["CAP REQ :batch server-time"]);
    });

    test("waits for the new connection's own answers before ending negotiation", async () => {
      const first = await connect();
      first.receive(":irc.example CAP * LS :batch server-time");

      const second = await reconnect(first);
      second.receive(":irc.example CAP * LS :batch server-time");
      // The first connection asked 3 s ago; its 5 s wait must not end this one.
      await vi.advanceTimersByTimeAsync(2500);
      expect(second.sent).not.toContain("CAP END");
      await vi.advanceTimersByTimeAsync(3000);
      expect(second.sent).toContain("CAP END");
    });
  });

  describe("a refused request", () => {
    test("is retried in smaller pieces until only the refused cap is left out", async () => {
      const socket = await connect();
      socket.receive(
        ":irc.example CAP * LS :batch server-time echo-message message-tags",
        ":irc.example CAP * NAK :batch server-time echo-message message-tags",
      );
      expect(socket.requests().slice(1)).toEqual([
        "CAP REQ :batch server-time",
        "CAP REQ :echo-message message-tags",
      ]);
      expect(socket.sent).not.toContain("CAP END");

      socket.receive(
        ":irc.example CAP * ACK :batch server-time",
        ":irc.example CAP * NAK :echo-message message-tags",
      );
      expect(socket.requests().slice(3)).toEqual([
        "CAP REQ :echo-message",
        "CAP REQ :message-tags",
      ]);
      expect(socket.sent).not.toContain("CAP END");

      socket.receive(
        ":irc.example CAP * NAK :echo-message",
        ":irc.example CAP * ACK :message-tags",
      );
      expect(socket.requests()).toHaveLength(5);
      expect(socket.sent.slice(socket.sent.indexOf("CAP END"))).toEqual([
        "CAP END",
        "NICK alice",
        "USER alice 0 * :alice",
      ]);
      expect(client.servers.get(serverId)?.capabilities).toEqual([
        "batch",
        "server-time",
        "message-tags",
      ]);
    });

    test("ends negotiation and registers when its only cap is refused", async () => {
      const socket = await connect();
      socket.receive(
        ":irc.example CAP * LS :batch",
        ":irc.example CAP * NAK :batch",
      );
      expect(socket.requests()).toEqual(["CAP REQ :batch"]);
      expect(socket.sent.slice(socket.sent.indexOf("CAP END"))).toEqual([
        "CAP END",
        "NICK alice",
        "USER alice 0 * :alice",
      ]);
    });

    test("leaves the end of negotiation to SASL once sasl is enabled", async () => {
      const socket = await connect(true);
      socket.receive(
        ":irc.example CAP * LS :sasl=PLAIN batch",
        ":irc.example CAP * NAK :sasl batch",
        ":irc.example CAP * ACK :sasl",
        ":irc.example CAP * NAK :batch",
      );
      expect(socket.requests()).toEqual([
        "CAP REQ :sasl batch",
        "CAP REQ :sasl",
        "CAP REQ :batch",
      ]);
      expect(socket.sent).not.toContain("CAP END");

      socket.receive(":irc.example 903 alice :SASL authentication successful");
      expect(socket.sent.filter((line) => line === "CAP END")).toHaveLength(1);
    });

    test("holds ISUPPORT back until the capability for it is enabled", async () => {
      const socket = await connect();
      socket.receive(
        ":irc.example CAP * LS :batch draft/extended-isupport",
        ":irc.example CAP * NAK :batch draft/extended-isupport",
      );
      expect(socket.sent).not.toContain("ISUPPORT");

      socket.receive(
        ":irc.example CAP * NAK :batch",
        ":irc.example CAP * ACK :draft/extended-isupport",
      );
      expect(socket.sent.slice(socket.sent.indexOf("ISUPPORT"))).toEqual([
        "ISUPPORT",
        "CAP END",
        "NICK alice",
        "USER alice 0 * :alice",
      ]);
    });

    test("sends nothing more when it comes after registration", async () => {
      const socket = await connect();
      socket.receive(
        ":irc.example CAP * LS :batch",
        ":irc.example CAP alice ACK :batch",
        ":irc.example 001 alice :Welcome",
        ":irc.example CAP alice NEW :draft/event-playback",
      );
      const before = socket.sent.length;
      socket.receive(":irc.example CAP alice NAK :draft/event-playback");
      expect(socket.sent.slice(before)).toEqual([]);
    });
  });
});
