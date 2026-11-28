import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IRCClient } from "../../src/lib/irc/IRCClient";

const SERVER = "srv";

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
  receive(raw: string) {
    this.onmessage?.({ data: `${raw}\r\n` });
  }
  // The lines of the test itself, without the handshake the client writes when the socket opens.
  said() {
    return this.sent.filter((line) => !/^(?:CAP|QUIT) /.test(line));
  }
}

function connect(client: IRCClient) {
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
  const socket = FakeWebSocket.last;
  socket.onopen?.();
  return socket;
}

function connectedClient() {
  const client = new IRCClient();
  const socket = connect(client);
  const notSent: string[][] = [];
  const queueEvents: string[] = [];
  client.on("linesNotSent", ({ lines }) => notSent.push(lines));
  client.on("sendQueue", ({ serverId }) => queueEvents.push(serverId));
  return { client, socket, notSent, queueEvents };
}

const line = (index: number, target = "#c") => `PRIVMSG ${target} :l${index}`;
const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => line(from + i));

function say(client: IRCClient, count: number, first = 1) {
  for (const each of lines(first, first + count - 1))
    client.sendRaw(SERVER, each);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the pace of plain messages", () => {
  it("writes a send of five lines at once and arms nothing", () => {
    const { client, socket, queueEvents } = connectedClient();
    const timers = vi.getTimerCount();
    say(client, 5);
    expect(socket.said()).toEqual(lines(1, 5));
    expect(vi.getTimerCount()).toBe(timers);
    expect(queueEvents).toEqual([]);
  });

  it("writes five lines at once and then one every two seconds, in the order sent", () => {
    const { client, socket } = connectedClient();
    say(client, 12);
    expect(socket.said()).toEqual(lines(1, 5));
    vi.advanceTimersByTime(1999);
    expect(socket.said()).toHaveLength(5);
    vi.advanceTimersByTime(1);
    expect(socket.said()).toHaveLength(6);
    vi.advanceTimersByTime(12_000);
    expect(socket.said()).toEqual(lines(1, 12));
  });

  it("keeps one order for every chat of the connection", () => {
    const { client, socket } = connectedClient();
    const sent = [
      ...Array.from({ length: 7 }, (_, i) => line(i + 1, "#a")),
      line(8, "#b"),
      line(9, "bob"),
    ];
    for (const each of sent) client.sendRaw(SERVER, each);
    vi.advanceTimersByTime(5999);
    expect(socket.said()).not.toContain(line(8, "#b"));
    vi.advanceTimersByTime(1);
    expect(socket.said().at(-1)).toBe(line(8, "#b"));
    vi.advanceTimersByTime(2000);
    expect(socket.said()).toEqual(sent);
  });

  it("gives back one line of the burst for every two idle seconds", () => {
    const { client, socket } = connectedClient();
    say(client, 5);
    vi.advanceTimersByTime(4000);
    say(client, 3, 6);
    expect(socket.said()).toEqual(lines(1, 7));
    vi.advanceTimersByTime(1999);
    expect(socket.said()).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(socket.said()).toEqual(lines(1, 8));
  });

  it("gives back the whole burst after ten idle seconds", () => {
    const { client, socket } = connectedClient();
    say(client, 5);
    vi.advanceTimersByTime(10_000);
    say(client, 5, 6);
    expect(socket.said()).toEqual(lines(1, 10));
  });

  it("writes everything that is not a plain message at once and leaves the schedule alone", () => {
    const { client, socket } = connectedClient();
    say(client, 8);
    const free = [
      "PING :1",
      "JOIN #b",
      "MARKREAD #c",
      "@+obby.world/e2ee=AAAA PRIVMSG bob :?obe2ee:",
      "PRIVMSG bob :?OTR:AAAA.",
    ];
    for (const each of free) client.sendRaw(SERVER, each);
    expect(socket.said()).toEqual([...lines(1, 5), ...free]);
    expect(client.waitingLines(SERVER)).toEqual({ waiting: 3, total: 3 });
    vi.advanceTimersByTime(2000);
    expect(socket.said().at(-1)).toBe(line(6));
    vi.advanceTimersByTime(4000);
    expect(socket.said().slice(-3)).toEqual(lines(6, 8));
  });

  it("sends no typing notice while lines wait, and still says when typing ends", () => {
    const { client, socket } = connectedClient();
    say(client, 6);
    client.sendTyping(SERVER, "#c", true);
    expect(socket.said()).toEqual(lines(1, 5));
    client.sendTyping(SERVER, "#c", false);
    expect(socket.said().at(-1)).toBe("@+typing=done TAGMSG #c");
    vi.advanceTimersByTime(2000);
    client.sendTyping(SERVER, "#c", true);
    expect(socket.said().at(-1)).toBe("@+typing=active TAGMSG #c");
  });
});

describe("a multiline batch and the pace", () => {
  function multilineClient() {
    const connected = connectedClient();
    const server = connected.client.servers.get(SERVER);
    if (!server) throw new Error("no server");
    server.capabilities = ["draft/multiline"];
    server.capabilityValues = {
      "draft/multiline": "max-bytes=40000,max-lines=100",
    };
    return connected;
  }

  it("writes a batch at once and charges nothing for it", () => {
    const { client, socket, queueEvents } = multilineClient();
    client.sendMultiline(
      SERVER,
      "#c",
      Array.from({ length: 20 }, (_, i) => `m${i}`),
    );
    expect(socket.said()).toHaveLength(22);
    client.sendRaw(SERVER, line(1));
    expect(socket.said().at(-1)).toBe(line(1));
    expect(queueEvents).toEqual([]);
  });

  it("keeps a batch whole and behind the lines that wait", () => {
    const { client, socket } = multilineClient();
    say(client, 6);
    client.sendMultiline(SERVER, "#c", ["m1", "m2", "m3"]);
    expect(socket.said()).toEqual(lines(1, 5));
    vi.advanceTimersByTime(2000);
    const after = socket.said().slice(5);
    expect(after[0]).toBe(line(6));
    expect(after[1]).toMatch(/^BATCH \+\S+ draft\/multiline #c$/);
    expect(after.slice(2, 5)).toEqual([
      expect.stringMatching(/^@batch=\S+ PRIVMSG #c :m1$/),
      expect.stringMatching(/^@batch=\S+ PRIVMSG #c :m2$/),
      expect.stringMatching(/^@batch=\S+ PRIVMSG #c :m3$/),
    ]);
    expect(after[5]).toMatch(/^BATCH -\S+$/);
    expect(after).toHaveLength(6);
    expect(client.hasWaitingLines(SERVER)).toBe(false);
  });
});

describe("lines that still wait when the connection goes", () => {
  it("reports them once when the socket closes and writes nothing more", () => {
    const { client, socket, notSent } = connectedClient();
    vi.spyOn(console, "error").mockImplementation(() => {});
    say(client, 20);
    vi.advanceTimersByTime(5000);
    expect(socket.said()).toHaveLength(7);
    socket.onclose?.();
    expect(notSent).toEqual([lines(8, 20)]);
    expect(client.waitingLines(SERVER)).toEqual({ waiting: 0, total: 0 });
    client.disconnect(SERVER);
    const timers = vi.getTimerCount();
    vi.advanceTimersByTime(60_000);
    expect(socket.said()).toHaveLength(7);
    expect(notSent).toHaveLength(1);
    expect(timers).toBe(0);
  });

  it("reports them when a new socket replaces the old one, and replays nothing", async () => {
    const { client, socket: first, notSent } = connectedClient();
    say(client, 20);
    await vi.advanceTimersByTimeAsync(0);
    const second = connect(client);
    expect(second).not.toBe(first);
    expect(notSent).toEqual([lines(6, 20)]);
    vi.advanceTimersByTime(60_000);
    expect(first.said()).toEqual(lines(1, 5));
    expect(second.said().filter((each) => / :l\d+$/.test(each))).toEqual([]);
    client.sendRaw(SERVER, "PRIVMSG #c :fresh");
    expect(second.said().at(-1)).toBe("PRIVMSG #c :fresh");
  });

  it("reports them at once when the user disconnects", () => {
    const { client, socket, notSent } = connectedClient();
    say(client, 9);
    client.disconnect(SERVER);
    expect(notSent).toEqual([lines(6, 9)]);
    expect(socket.sent.at(-1)).toMatch(/^QUIT :/);
    vi.advanceTimersByTime(60_000);
    expect(socket.sent.at(-1)).toMatch(/^QUIT :/);
  });

  it("reports them at the next turn when the socket died without a close event", () => {
    const { client, socket, notSent } = connectedClient();
    say(client, 10);
    socket.readyState = 3;
    vi.advanceTimersByTime(2000);
    expect(socket.said()).toEqual(lines(1, 5));
    expect(notSent).toEqual([lines(6, 10)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops them on Cancel, keeps the connection and keeps the clock", () => {
    const { client, socket, notSent } = connectedClient();
    say(client, 20);
    vi.advanceTimersByTime(1000);
    client.cancelWaitingLines(SERVER);
    expect(notSent).toEqual([lines(6, 20)]);
    expect(socket.close).not.toHaveBeenCalled();
    expect(client.hasWaitingLines(SERVER)).toBe(false);
    client.sendRaw(SERVER, "PRIVMSG #c :after");
    vi.advanceTimersByTime(999);
    expect(socket.said()).toEqual(lines(1, 5));
    vi.advanceTimersByTime(1);
    expect(socket.said().at(-1)).toBe("PRIVMSG #c :after");
  });

  it("writes the dropped lines into the raw log", () => {
    const { client } = connectedClient();
    const info: string[] = [];
    client.on("rawLine", ({ direction, line: logged }) => {
      if (direction === "info") info.push(logged);
    });
    say(client, 7);
    client.cancelWaitingLines(SERVER);
    expect(info).toEqual([
      `** dropped TX (not sent): ${line(6)}`,
      `** dropped TX (not sent): ${line(7)}`,
    ]);
  });
});

describe("the send clock on an unsteady timer", () => {
  it("writes at most one burst when its timer fires late", () => {
    const { client, socket } = connectedClient();
    say(client, 30);
    vi.setSystemTime(60_000);
    vi.advanceTimersByTime(2000);
    expect(socket.said()).toEqual(lines(1, 10));
    vi.advanceTimersByTime(1999);
    expect(socket.said()).toHaveLength(10);
    vi.advanceTimersByTime(1);
    expect(socket.said()).toHaveLength(11);
  });

  it("holds a line for one pace, no longer, after the clock is set back", () => {
    vi.setSystemTime(100_000);
    const { client, socket } = connectedClient();
    say(client, 5);
    vi.setSystemTime(0);
    client.sendRaw(SERVER, line(6));
    vi.advanceTimersByTime(1999);
    expect(socket.said()).toHaveLength(5);
    vi.advanceTimersByTime(1);
    expect(socket.said()).toEqual(lines(1, 6));
  });

  it("sends the next line on time after a listener threw on the one before", () => {
    const { client, socket } = connectedClient();
    say(client, 7);
    let shouldThrow = true;
    client.on("rawLine", ({ direction }) => {
      if (direction === "tx" && shouldThrow) {
        shouldThrow = false;
        throw new Error("listener failed");
      }
    });
    expect(() => vi.advanceTimersByTime(2000)).toThrow("listener failed");
    expect(socket.said()).toEqual(lines(1, 6));
    vi.advanceTimersByTime(2000);
    expect(socket.said()).toEqual(lines(1, 7));
  });
});

describe("what the rest of the app is told", () => {
  it("logs a line when it is written and marks the ones that waited", () => {
    const { client } = connectedClient();
    const tx: { line: string; afterWaiting?: boolean }[] = [];
    client.on("rawLine", ({ direction, line: logged, afterWaiting }) => {
      if (direction === "tx") tx.push({ line: logged, afterWaiting });
    });
    say(client, 5);
    client.sendRaw(SERVER, "PRIVMSG #late :l6");
    expect(tx.map((each) => each.afterWaiting)).toEqual(
      Array(5).fill(undefined),
    );
    expect(client.takeRecentSend(SERVER, "#late")).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(tx).toHaveLength(6);
    expect(tx[5]).toEqual({ line: "PRIVMSG #late :l6", afterWaiting: true });
    expect(client.takeRecentSend(SERVER, "#late")).toBe(true);
  });

  it("counts the lines that wait and announces each change", () => {
    const { client, queueEvents } = connectedClient();
    say(client, 12);
    expect(client.waitingLines(SERVER)).toEqual({ waiting: 7, total: 7 });
    expect(client.hasWaitingLines(SERVER)).toBe(true);
    expect(queueEvents).toHaveLength(7);
    vi.advanceTimersByTime(2000);
    expect(client.waitingLines(SERVER)).toEqual({ waiting: 6, total: 7 });
    expect(queueEvents).toHaveLength(8);
    vi.advanceTimersByTime(12_000);
    expect(client.waitingLines(SERVER)).toEqual({ waiting: 0, total: 0 });
    expect(client.hasWaitingLines(SERVER)).toBe(false);
    expect(queueEvents).toHaveLength(14);
  });

  it("tells whether lines wait for one chat, whatever the case of its name", () => {
    const { client } = connectedClient();
    say(client, 5);
    client.sendRaw(SERVER, line(6, "#Other"));
    expect(client.hasWaitingLines(SERVER, "#other")).toBe(true);
    expect(client.hasWaitingLines(SERVER, "#c")).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(client.hasWaitingLines(SERVER, "#other")).toBe(false);
  });

  it("drops a message with a NUL as before and queues nothing", () => {
    const { client, socket } = connectedClient();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const info: string[] = [];
    client.on("rawLine", ({ direction, line: logged }) => {
      if (direction === "info") info.push(logged);
    });
    say(client, 5);
    client.sendRaw(SERVER, "PRIVMSG #c :bad\0line");
    expect(info).toHaveLength(1);
    expect(info[0]).toContain("dropped TX (line break or NUL)");
    expect(client.hasWaitingLines(SERVER)).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(socket.said()).toEqual(lines(1, 5));
  });

  it("drops a message for a closed socket as before and queues nothing", () => {
    const { client, socket } = connectedClient();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const info: string[] = [];
    client.on("rawLine", ({ direction, line: logged }) => {
      if (direction === "info") info.push(logged);
    });
    socket.readyState = 3;
    const timers = vi.getTimerCount();
    say(client, 8);
    expect(info).toEqual(
      lines(1, 8).map((each) => `** dropped TX (socket not open): ${each}`),
    );
    expect(vi.getTimerCount()).toBe(timers);
    expect(client.waitingLines(SERVER)).toEqual({ waiting: 0, total: 0 });
    expect(socket.said()).toEqual([]);
  });
});

describe("a line the user sends while others wait", () => {
  it("is announced when it joins the wait, since it leaves later", () => {
    const { client } = connectedClient();
    const queued: string[] = [];
    client.on("lineQueued", ({ line: waiting }) => queued.push(waiting));
    say(client, 5);
    client.sendRaw(SERVER, "JOIN #b");
    expect(queued).toEqual([]);
    say(client, 2, 6);
    expect(queued).toEqual(lines(6, 7));
    vi.advanceTimersByTime(4000);
    expect(queued).toEqual(lines(6, 7));
  });

  it("is announced for every line of a batch that waits behind others", () => {
    const { client } = connectedClient();
    const server = client.servers.get(SERVER);
    if (!server) throw new Error("no server");
    server.capabilities = ["draft/multiline"];
    server.capabilityValues = {
      "draft/multiline": "max-bytes=40000,max-lines=100",
    };
    const queued: string[] = [];
    say(client, 6);
    client.on("lineQueued", ({ line: waiting }) => queued.push(waiting));
    client.sendMultiline(SERVER, "#c", ["m1", "m2"]);
    expect(queued).toEqual([
      expect.stringMatching(/^BATCH \+\S+ draft\/multiline #c$/),
      expect.stringMatching(/^@batch=\S+ PRIVMSG #c :m1$/),
      expect.stringMatching(/^@batch=\S+ PRIVMSG #c :m2$/),
      expect.stringMatching(/^BATCH -\S+$/),
    ]);
  });
});

describe("lines that wait for someone who changes nick", () => {
  it("leave for the new nick, and the other lines keep their receiver", () => {
    const { client, socket } = connectedClient();
    say(client, 5);
    const waiting = [line(6, "Bob"), line(7, "#c"), line(8, "bob")];
    for (const each of waiting) client.sendRaw(SERVER, each);
    socket.receive(":Bob!u@h NICK Robert");
    vi.advanceTimersByTime(6000);
    expect(socket.said().slice(5)).toEqual([
      line(6, "Robert"),
      line(7, "#c"),
      line(8, "Robert"),
    ]);
  });

  it("keep their receiver when the nick change is one replayed from history", () => {
    const { client, socket } = connectedClient();
    say(client, 5);
    client.sendRaw(SERVER, line(6, "Bob"));
    socket.receive("@batch=hist :Bob!u@h NICK Robert");
    vi.advanceTimersByTime(2000);
    expect(socket.said().at(-1)).toBe(line(6, "Bob"));
  });

  it("are reported under the new nick when they are dropped", () => {
    const { client, socket, notSent } = connectedClient();
    say(client, 5);
    client.sendRaw(SERVER, line(6, "Bob"));
    socket.receive(":Bob!u@h NICK Robert");
    client.cancelWaitingLines(SERVER);
    expect(notSent).toEqual([[line(6, "Robert")]]);
  });
});

describe("lines that wait for a channel that is renamed", () => {
  it("leave for the new name, and the other lines keep their receiver", () => {
    const { client, socket } = connectedClient();
    say(client, 5);
    for (const each of [line(6, "#Old"), line(7, "#c"), line(8, "#old")])
      client.sendRaw(SERVER, each);
    client.renameKnownChannel(SERVER, "#old", "#new");
    vi.advanceTimersByTime(6000);
    expect(socket.said().slice(5)).toEqual([
      line(6, "#new"),
      line(7, "#c"),
      line(8, "#new"),
    ]);
  });
});
