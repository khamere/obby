import { beforeEach, describe, expect, test, vi } from "vitest";
import { IRCClient } from "../../src/lib/ircClient";
import { parseMessageTags } from "../../src/lib/ircUtils";
import type { Server } from "../../src/types";

// Mock WebSocket class
class MockWebSocket extends EventTarget {
  public readyState: number = WebSocket.CONNECTING;
  public bufferedAmount = 0;
  public extensions = "";
  public protocol = "";
  public binaryType: BinaryType = "blob";
  public url: string;
  public sentMessages: string[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
  }

  send(message: string): void {
    this.sentMessages.push(message);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent("close"));
    }
  }

  // Helper methods for testing
  simulateOpen(): void {
    this.readyState = WebSocket.OPEN;
    if (this.onopen) {
      this.onopen(new Event("open"));
    }
  }

  simulateMessage(data: string): void {
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data }));
    }
  }

  simulateError(error: Error): void {
    if (this.onerror) {
      this.onerror(new Event("error"));
    }
  }
}

// vitest 4 rejects `mockReturnValue` on a mock invoked with `new`; a plain
// function that returns a prebuilt instance is the supported replacement.
function returnsSocket(socket: MockWebSocket): () => WebSocket {
  function construct() {
    return socket;
  }
  return construct as unknown as () => WebSocket;
}

// Mock WebSocket globally
const MockWebSocketSpy = vi.fn();
vi.stubGlobal("WebSocket", MockWebSocketSpy);

describe("IRCClient", () => {
  let client: IRCClient;

  beforeEach(() => {
    client = new IRCClient();
    vi.clearAllMocks();
    MockWebSocketSpy.mockClear();
  });

  describe("connect", () => {
    test("disconnecting a socket that is still connecting closes it without throwing", () => {
      const socket = new MockWebSocket("wss://soju.example/socket");
      socket.readyState = MockWebSocket.CONNECTING;
      // A real WebSocket rejects send() until it's open. (The global
      // WebSocket is stubbed here, so use the mock's own constants.)
      socket.send = (message: string) => {
        if (socket.readyState !== MockWebSocket.OPEN) {
          throw new Error("InvalidStateError");
        }
        socket.sentMessages.push(message);
      };
      MockWebSocketSpy.mockImplementationOnce(returnsSocket(socket));
      void client.connect(
        "Net",
        "wss://soju.example/socket",
        443,
        "alice",
        undefined,
        undefined,
        undefined,
        "connecting",
      );
      expect(socket.readyState).toBe(MockWebSocket.CONNECTING);
      expect(() => client.disconnect("connecting")).not.toThrow();
      socket.readyState = MockWebSocket.CLOSED;
      expect(client.servers.get("connecting")?.connectionState).toBe(
        "disconnected",
      );
      expect(socket.sentMessages.some((m) => m.startsWith("QUIT"))).toBe(false);
      client.removeServer("connecting");
    });

    test("a late error or close from a replaced socket leaves the new connection alone", async () => {
      vi.useFakeTimers();
      const first = new MockWebSocket("wss://soju.example/socket");
      const second = new MockWebSocket("wss://soju.example/socket");
      MockWebSocketSpy.mockImplementationOnce(returnsSocket(first));
      MockWebSocketSpy.mockImplementationOnce(returnsSocket(second));
      try {
        const firstConnect = client.connect(
          "Net",
          "wss://soju.example/socket",
          443,
          "alice",
          undefined,
          undefined,
          undefined,
          "replaced",
        );
        first.simulateOpen();
        await firstConnect;
        client.disconnect("replaced");
        const secondConnect = client.connect(
          "Net",
          "wss://soju.example/socket",
          443,
          "alice",
          undefined,
          undefined,
          undefined,
          "replaced",
        );
        second.simulateOpen();
        await secondConnect;

        first.simulateError(new Error("late"));
        first.onclose?.(new CloseEvent("close"));
        await vi.advanceTimersByTimeAsync(3001);

        expect(client.servers.get("replaced")?.isConnected).toBe(true);
        expect(MockWebSocketSpy).toHaveBeenCalledTimes(2);
        client.sendRaw("replaced", "PING :still-here");
        expect(second.sentMessages).toContain("PING :still-here");
      } finally {
        client.removeServer("replaced");
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    test("an open socket still gets QUIT on disconnect", async () => {
      const socket = new MockWebSocket("wss://soju.example/socket");
      MockWebSocketSpy.mockImplementationOnce(returnsSocket(socket));
      const connected = client.connect(
        "Net",
        "wss://soju.example/socket",
        443,
        "alice",
        undefined,
        undefined,
        undefined,
        "open",
      );
      socket.simulateOpen();
      socket.readyState = MockWebSocket.OPEN;
      await connected;
      client.disconnect("open", "bye");
      expect(socket.sentMessages).toContain("QUIT :bye");
      client.removeServer("open");
    });

    test("removing a child clears its binding and does not schedule a reconnect", async () => {
      vi.useFakeTimers();
      try {
        const first = new MockWebSocket("wss://soju.example/socket");
        const second = new MockWebSocket("wss://soju.example/socket");
        MockWebSocketSpy.mockImplementationOnce(returnsSocket(first));
        MockWebSocketSpy.mockImplementationOnce(returnsSocket(second));
        client.setPendingBouncerBind("child", "42");
        const firstConnect = client.connect(
          "Garnet Net",
          "wss://soju.example/socket",
          443,
          "alice",
          undefined,
          undefined,
          undefined,
          "child",
        );
        first.simulateOpen();
        await firstConnect;
        client.sendCapEnd("child");
        client.removeServer("child");
        await vi.advanceTimersByTimeAsync(3001);
        expect(MockWebSocketSpy).toHaveBeenCalledTimes(1);
        const nextConnect = client.connect(
          "Control",
          "wss://soju.example/socket",
          443,
          "alice",
          undefined,
          undefined,
          undefined,
          "child",
        );
        second.simulateOpen();
        await nextConnect;
        client.sendCapEnd("child");
        expect(second.sentMessages).not.toContain("BOUNCER BIND 42");
      } finally {
        client.removeServer("child");
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    test("rebinds the same Soju network after an automatic reconnect", async () => {
      vi.useFakeTimers();
      const first = new MockWebSocket("wss://soju.example/socket");
      const second = new MockWebSocket("wss://soju.example/socket");
      MockWebSocketSpy.mockImplementationOnce(returnsSocket(first));
      MockWebSocketSpy.mockImplementationOnce(returnsSocket(second));
      try {
        client.setPendingBouncerBind("child", "42");
        const connected = client.connect(
          "Garnet Net",
          "wss://soju.example/socket",
          443,
          "alice",
          undefined,
          undefined,
          undefined,
          "child",
        );
        first.simulateOpen();
        await connected;
        client.sendCapEnd("child");
        first.close();
        await vi.advanceTimersByTimeAsync(3001);
        second.simulateOpen();
        await Promise.resolve();
        client.sendCapEnd("child");
        client.sendCapEnd("child");
        expect(
          second.sentMessages.filter((line) => line.startsWith("BOUNCER BIND")),
        ).toEqual(["BOUNCER BIND 42"]);
        expect(second.sentMessages.indexOf("BOUNCER BIND 42")).toBeLessThan(
          second.sentMessages.indexOf("CAP END"),
        );
      } finally {
        client.removeServer("child");
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    test("should connect to IRC server successfully", async () => {
      const mockSocket = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket));

      const connectionPromise = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );

      // Simulate successful connection
      mockSocket.simulateOpen();

      const server = await connectionPromise;

      expect(server).toBeDefined();
      expect(server.name).toBe("Test Server");
      expect(server.isConnected).toBe(true);

      // Verify sent messages
      expect(mockSocket.sentMessages).toContain("CAP LS 302");
    });

    test("asks for its nick only once capabilities and SASL are done", async () => {
      const mockSocket = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket));
      const connecting = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );
      mockSocket.simulateOpen();
      await connecting;
      expect(mockSocket.sentMessages.some((m) => m.startsWith("NICK"))).toBe(
        false,
      );

      mockSocket.simulateMessage(":irc.example.com CAP * LS :multi-prefix\r\n");
      mockSocket.simulateMessage(
        ":irc.example.com CAP * ACK :multi-prefix\r\n",
      );
      const sent = mockSocket.sentMessages;
      const capEnd = sent.indexOf("CAP END");
      expect(capEnd).toBeGreaterThan(-1);
      expect(sent.slice(capEnd + 1)).toEqual([
        "NICK testuser",
        "USER testuser 0 * :testuser",
      ]);
    });

    test("leaves a drop on a live connection to the reconnect path", async () => {
      const mockSocket = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket));
      const connectionPromise = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );
      mockSocket.simulateOpen();
      await connectionPromise;
      const onServerError = vi.fn();
      client.on("serverError", onServerError);

      mockSocket.onerror?.(new Event("error"));

      expect(onServerError).not.toHaveBeenCalled();
    });

    test.skip("should handle connection errors", async () => {
      vi.useFakeTimers();

      const mockSocket = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket));

      const connectionPromise = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );

      // Trigger the error synchronously after the promise is set up
      if (mockSocket.onerror) {
        mockSocket.onerror(new Event("error"));
      }

      // Expect the promise to reject
      await expect(connectionPromise).rejects.toThrow(/Failed to connect/);

      vi.useRealTimers();
    });

    test("should return existing server when connecting to same host/port", async () => {
      // First connection
      const mockSocket1 = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket1));

      const firstConnectionPromise = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );

      mockSocket1.simulateOpen();
      const firstServer = await firstConnectionPromise;

      expect(firstServer).toBeDefined();
      expect(firstServer.name).toBe("Test Server");
      expect(firstServer.isConnected).toBe(true);
      expect(mockSocket1.sentMessages).toContain("CAP LS 302");
      expect(MockWebSocketSpy).toHaveBeenCalledTimes(1);

      // Second connection to same host/port should return existing server
      const secondConnectionPromise = client.connect(
        "Test Server 2",
        "irc.example.com",
        443,
        "testuser2", // Different nickname
      );

      const secondServer = await secondConnectionPromise;

      // Should return the same server instance
      expect(secondServer).toBe(firstServer);
      expect(secondServer.id).toBe(firstServer.id);

      // Should not have created a new WebSocket
      expect(MockWebSocketSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("message handling", () => {
    test("should handle PRIVMSG correctly", async () => {
      const mockSocket = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket));

      const connectionPromise = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );

      mockSocket.simulateOpen();
      const server = await connectionPromise;

      // Set up event listener
      let receivedMessage: unknown;
      const messagePromise = new Promise<void>((resolve) => {
        client.on("CHANMSG", (msg) => {
          receivedMessage = msg;
          resolve();
        });
      });

      // Simulate receiving a PRIVMSG
      mockSocket.simulateMessage(
        "@time=2023-01-01T12:00:00.000Z :nick!user@host PRIVMSG #channel :Hello, world!\r\n",
      );

      await messagePromise;

      expect(receivedMessage).toEqual({
        serverId: server.id,
        mtags: expect.any(Object),
        sender: "nick",
        channelName: "#channel",
        message: "Hello, world!",
        timestamp: expect.any(Date),
      });
    });

    test("should parse MODE messages", async () => {
      const mockSocket = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket));

      const connectionPromise = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );

      mockSocket.simulateOpen();
      const server = await connectionPromise;

      // Set up event listener for MODE
      let receivedMode: unknown;
      const modePromise = new Promise<void>((resolve) => {
        client.on("MODE", (mode) => {
          receivedMode = mode;
          resolve();
        });
      });

      // Simulate receiving a MODE message for channel
      mockSocket.simulateMessage(
        ":ircuser!user@host MODE #testchannel +o nickname\r\n",
      );

      await modePromise;

      expect(receivedMode).toEqual({
        serverId: server.id,
        mtags: { time: expect.any(String) },
        sender: "ircuser",
        target: "#testchannel",
        modestring: "+o",
        modeargs: ["nickname"],
      });
    });

    test("should parse MODE messages with multiple modes", async () => {
      const mockSocket = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket));

      const connectionPromise = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );

      mockSocket.simulateOpen();
      const server = await connectionPromise;

      // Set up event listener for MODE
      let receivedMode: unknown;
      const modePromise = new Promise<void>((resolve) => {
        client.on("MODE", (mode) => {
          receivedMode = mode;
          resolve();
        });
      });

      // Simulate receiving a MODE message with multiple modes
      mockSocket.simulateMessage(
        ":ircuser!user@host MODE #testchannel +ov-v nickname1 nickname2 nickname3\r\n",
      );

      await modePromise;

      expect(receivedMode).toEqual({
        serverId: server.id,
        mtags: { time: expect.any(String) },
        sender: "ircuser",
        target: "#testchannel",
        modestring: "+ov-v",
        modeargs: ["nickname1", "nickname2", "nickname3"],
      });
    });

    test("should parse MODE messages for users", async () => {
      const mockSocket = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket));

      const connectionPromise = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );

      mockSocket.simulateOpen();
      const server = await connectionPromise;

      // Set up event listener for MODE
      let receivedMode: unknown;
      const modePromise = new Promise<void>((resolve) => {
        client.on("MODE", (mode) => {
          receivedMode = mode;
          resolve();
        });
      });

      // Simulate receiving a MODE message for user
      mockSocket.simulateMessage(":testuser!user@host MODE testuser +i\r\n");

      await modePromise;

      expect(receivedMode).toEqual({
        serverId: server.id,
        mtags: { time: expect.any(String) },
        sender: "testuser",
        target: "testuser",
        modestring: "+i",
        modeargs: [],
      });
    });
  });

  describe("channel operations", () => {
    let mockSocket: MockWebSocket;
    let server: Server;

    beforeEach(async () => {
      mockSocket = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket));

      const connectionPromise = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );

      mockSocket.simulateOpen();
      server = await connectionPromise;
    });

    test.each([
      ["a line feed", "PRIVMSG #a :one\nPRIVMSG #b :two"],
      ["a carriage return", "PRIVMSG #a :one\rPRIVMSG #b :two"],
      ["a NUL", "PRIVMSG #a :one\u0000PRIVMSG #b :two"],
      ["a trailing line end", "PRIVMSG #a :one\r\n"],
    ])("sends one line when a command holds %s", (_, command) => {
      const lines: string[] = [];
      client.on("rawLine", ({ direction, line }) => {
        if (direction === "tx") lines.push(line);
      });

      client.sendRaw(server.id, command);

      expect(mockSocket.sentMessages.at(-1)).toBe("PRIVMSG #a :one");
      expect(lines.at(-1)).toBe("PRIVMSG #a :one");
      expect(mockSocket.sentMessages.join("")).not.toContain("#b");
    });

    test("keeps a channel name inside the whisper tags", () => {
      client.sendWhisper(server.id, "bob", "#a;b", "hi");

      expect(mockSocket.sentMessages.at(-1)).toBe(
        "@+channel-context=#a\\:b;+draft/channel-context=#a\\:b PRIVMSG bob :hi",
      );
    });

    describe("a message with line breaks and a reply", () => {
      const text = "see this\nand that https://files.example/a.png";
      const replyTags = (line: string) =>
        parseMessageTags(line.slice(0, line.indexOf(" ")));
      const sentBy = (send: () => void) => {
        const before = mockSocket.sentMessages.length;
        send();
        return mockSocket.sentMessages.slice(before);
      };

      test("goes out as one batch that carries every line", () => {
        server.capabilities = ["draft/multiline"];

        const sent = sentBy(() =>
          client.sendText(server.id, "#a", text, { replyTo: "id;1 x" }),
        );

        expect(sent).toHaveLength(4);
        const batch = /BATCH \+(\S+) draft\/multiline #a$/.exec(sent[0])?.[1];
        expect(replyTags(sent[0])).toEqual({
          "+reply": "id;1 x",
          "+draft/reply": "id;1 x",
        });
        expect(sent.slice(1)).toEqual([
          `@batch=${batch} PRIVMSG #a :see this`,
          `@batch=${batch} PRIVMSG #a :and that https://files.example/a.png`,
          `BATCH -${batch}`,
        ]);
      });

      test("goes out line by line on a server without batches", () => {
        const sent = sentBy(() =>
          client.sendText(server.id, "#a", text, { replyTo: "id;1 x" }),
        );

        expect(sent.map((line) => line.slice(line.indexOf(" ") + 1))).toEqual([
          "PRIVMSG #a :see this",
          "PRIVMSG #a :and that https://files.example/a.png",
        ]);
        for (const line of sent)
          expect(replyTags(line)).toEqual({
            "+reply": "id;1 x",
            "+draft/reply": "id;1 x",
          });
      });

      test("goes out as one line when the lines are joined", () => {
        const sent = sentBy(() =>
          client.sendText(server.id, "#a", text, { joinLines: true }),
        );

        expect(sent).toEqual([
          "PRIVMSG #a :see this and that https://files.example/a.png",
        ]);
      });

      // A relayed line to #a carries 381 bytes at most by our count.
      const lineBytes = 381;
      const longLink = `https://files.example/${"a".repeat(373)}.png`;
      const utf8 = new TextEncoder();
      const payload = (line: string) => line.slice(line.indexOf(" :") + 2);
      const payloadBytes = (line: string) => utf8.encode(payload(line)).length;
      const privmsgs = (sent: string[]) =>
        sent.filter((line) => line.includes("PRIVMSG #a :"));

      test("sends a caption and its link as the one line they fit", () => {
        const sent = sentBy(() =>
          client.sendText(server.id, "#a", "photo https://files.example/a.png"),
        );

        expect(sent).toEqual(["PRIVMSG #a :photo https://files.example/a.png"]);
      });

      test("keeps a long link whole on a server without batches", () => {
        const sent = sentBy(() =>
          client.sendText(server.id, "#a", `photo ${longLink}`),
        );

        expect(sent).toEqual(["PRIVMSG #a :photo", `PRIVMSG #a :${longLink}`]);
      });

      test("joins a link wider than a line back together inside a batch", () => {
        server.capabilities = ["draft/multiline"];

        const sent = sentBy(() =>
          client.sendText(server.id, "#a", `see\nphoto ${longLink}`),
        );

        const batch = /BATCH \+(\S+) /.exec(sent[0])?.[1];
        const inner = sent.slice(1, -1);
        expect(inner[0]).toBe(`@batch=${batch} PRIVMSG #a :see`);
        expect(inner[1]).toBe(`@batch=${batch} PRIVMSG #a :photo `);
        for (const line of inner.slice(2))
          expect(
            line.startsWith(`@batch=${batch};draft/multiline-concat `),
          ).toBe(true);
        expect(inner.slice(1).map(payload).join("")).toContain(longLink);
        expect(inner.slice(1).map(payload).join("")).toBe(`photo ${longLink}`);
        for (const line of inner)
          expect(payloadBytes(line)).toBeLessThanOrEqual(lineBytes);
      });

      describe("on a server whose batch holds fewer bytes than a line", () => {
        const cyrillic = "д".repeat(200);

        beforeEach(() => {
          server.capabilities = ["draft/multiline"];
          server.capabilityValues = {
            "draft/multiline": "max-bytes=256,max-lines=10",
          };
        });

        test("sends a line no batch can hold as separate messages", () => {
          const sent = sentBy(() =>
            client.sendMultiline(server.id, "#a", [cyrillic], "@+reply=m1 "),
          );

          expect(sent.some((line) => line.includes("BATCH"))).toBe(false);
          expect(sent.length).toBeGreaterThan(1);
          expect(sent.map(payload).join("")).toBe(cyrillic);
          for (const line of sent) {
            expect(line.startsWith("@+reply=m1 PRIVMSG #a :")).toBe(true);
            expect(payloadBytes(line)).toBeLessThanOrEqual(lineBytes);
          }
        });

        test("keeps the lines around it in their batches and in order", () => {
          const sent = sentBy(() =>
            client.sendText(
              server.id,
              "#a",
              `before\n${cyrillic}\nafter\nlast`,
            ),
          );

          expect(
            privmsgs(sent).map(payload).join("\n").replace(/д\nд/g, "дд"),
          ).toBe(`before\n${cyrillic}\nafter\nlast`);
          expect(sent[0]).toMatch(/^BATCH \+\S+ draft\/multiline #a$/);
          expect(sent[1]).toMatch(/^@batch=\S+ PRIVMSG #a :before$/);
          expect(sent[2]).toMatch(/^BATCH -/);
          expect(sent[3].startsWith("PRIVMSG #a :д")).toBe(true);
          expect(sent.at(-3)).toMatch(/^@batch=\S+ PRIVMSG #a :after$/);
          expect(sent.at(-2)).toMatch(/^@batch=\S+ PRIVMSG #a :last$/);
        });

        test("keeps a long link whole in a line no batch can hold", () => {
          const sent = sentBy(() =>
            client.sendText(server.id, "#a", `see\nphoto ${longLink} done`),
          );

          expect(privmsgs(sent).map(payload)).toEqual([
            "see",
            "photo",
            longLink,
            "done",
          ]);
          expect(sent[3]).toBe("PRIVMSG #a :photo");
          expect(sent[4]).toBe(`PRIVMSG #a :${longLink}`);
        });

        test("puts no more bytes in any batch than the server allows", () => {
          const lines = Array.from({ length: 8 }, (_, i) =>
            `${i} ${"слово ".repeat(15)}`.trim(),
          );

          const sent = sentBy(() =>
            client.sendMultiline(server.id, "#a", lines),
          );

          let batchBytes = 0;
          for (const line of sent) {
            if (line.startsWith("BATCH +")) batchBytes = 0;
            else if (line.startsWith("@batch=")) {
              batchBytes += payloadBytes(line);
              expect(batchBytes).toBeLessThanOrEqual(256);
            }
          }
          expect(privmsgs(sent).map(payload)).toEqual(lines);
        });
      });

      test("sends a line with more parts than a batch has lines as separate messages", () => {
        server.capabilities = ["draft/multiline"];
        server.capabilityValues = { "draft/multiline": "max-lines=2" };
        const text = "слово ".repeat(200).trim();

        const sent = sentBy(() =>
          client.sendMultiline(server.id, "#a", [text]),
        );

        expect(sent.some((line) => line.includes("BATCH"))).toBe(false);
        expect(sent.map(payload).join(" ")).toBe(text);
        for (const line of sent)
          expect(payloadBytes(line)).toBeLessThanOrEqual(lineBytes);
      });

      test("keeps a single line as one tagged message", () => {
        const sent = sentBy(() =>
          client.sendText(server.id, "#a", "hello", { replyTo: "abc" }),
        );

        expect(sent).toEqual([
          "@+reply=abc;+draft/reply=abc PRIVMSG #a :hello",
        ]);
      });
    });

    test("should send LIST command", () => {
      client.listChannels(server.id);
      expect(mockSocket.sentMessages).toContain("LIST");
    });

    test("should handle LIST responses", () => {
      const listChannelPromise = new Promise<void>((resolve) => {
        client.on("LIST_CHANNEL", (data) => {
          expect(data.channel).toBe("#testchannel");
          expect(data.userCount).toBe(42);
          expect(data.topic).toBe("Test topic");
          resolve();
        });
      });

      mockSocket.simulateMessage("322 * #testchannel 42 :Test topic\r\n");
      return listChannelPromise;
    });

    test("should handle LIST end", () => {
      const listEndPromise = new Promise<void>((resolve) => {
        client.on("LIST_END", (data) => {
          expect(data.serverId).toBe(server.id);
          resolve();
        });
      });

      mockSocket.simulateMessage("323 * :End of LIST\r\n");
      return listEndPromise;
    });

    test("should send RENAME command", () => {
      client.renameChannel(
        server.id,
        "#oldname",
        "#newname",
        "Channel renamed",
      );
      expect(mockSocket.sentMessages).toContain(
        "RENAME #oldname #newname :Channel renamed",
      );
    });

    test("should send RENAME command without reason", () => {
      client.renameChannel(server.id, "#oldname", "#newname");
      expect(mockSocket.sentMessages).toContain("RENAME #oldname #newname");
    });

    test("should handle RENAME response", () => {
      const renamePromise = new Promise<void>((resolve) => {
        client.on("RENAME", (data) => {
          expect(data.oldName).toBe("#oldchannel");
          expect(data.newName).toBe("#newchannel");
          expect(data.reason).toBe("Channel renamed");
          resolve();
        });
      });

      mockSocket.simulateMessage(
        ":server RENAME #oldchannel #newchannel :Channel renamed\r\n",
      );
      return renamePromise;
    });

    test("should send SETNAME command", () => {
      client.setName(server.id, "New Real Name");
      expect(mockSocket.sentMessages).toContain("SETNAME :New Real Name");
    });

    test("should handle SETNAME response", () => {
      const setnamePromise = new Promise<void>((resolve) => {
        client.on("SETNAME", (data) => {
          expect(data.user).toBe("testuser");
          expect(data.realname).toBe("New Real Name");
          resolve();
        });
      });

      mockSocket.simulateMessage(
        ":testuser!user@host SETNAME :New Real Name\r\n",
      );
      return setnamePromise;
    });
  });

  describe("draft/authtoken", () => {
    let mockSocket: MockWebSocket;
    let server: Server;

    beforeEach(async () => {
      mockSocket = new MockWebSocket("ws://irc.example.com:443");
      MockWebSocketSpy.mockImplementation(returnsSocket(mockSocket));
      const connectionPromise = client.connect(
        "Test Server",
        "irc.example.com",
        443,
        "testuser",
      );
      mockSocket.simulateOpen();
      server = await connectionPromise;
    });

    test("requestToken sends TOKEN GENERATE", () => {
      client.requestToken(server.id, "filehost");
      expect(mockSocket.sentMessages).toContain("TOKEN GENERATE filehost");
    });

    test("requestToken with scope appends scope", () => {
      client.requestToken(server.id, "filehost", "channel:#foo");
      expect(mockSocket.sentMessages).toContain(
        "TOKEN GENERATE filehost channel:#foo",
      );
    });

    test("parses TOKEN GENERATE reply", async () => {
      const got = new Promise<{ service: string; url: string; token: string }>(
        (resolve) => {
          client.on("TOKEN_GENERATE", (data) => {
            resolve({
              service: data.service,
              url: data.url,
              token: data.token,
            });
          });
        },
      );
      mockSocket.simulateMessage(
        ":irc.example.com TOKEN GENERATE filehost https://files.example.com :abc123\r\n",
      );
      const out = await got;
      expect(out.service).toBe("filehost");
      expect(out.url).toBe("https://files.example.com");
      expect(out.token).toBe("abc123");
    });
  });
});
