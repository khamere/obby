import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ircClient from "../../src/lib/ircClient";

// A refused PRIVMSG comes back as ERR_CANNOTSENDTOCHAN, on its own or inside
// the labeled-response batch of the send it answers.
const SERVER = "refuse-srv";

const feed = (...lines: string[]) =>
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), SERVER);

describe("ERR_CANNOTSENDTOCHAN", () => {
  let refused: unknown[];
  let saved: Record<string, unknown[]>;

  beforeEach(() => {
    const c = ircClient as unknown as {
      eventCallbacks: Record<string, unknown[]>;
    };
    saved = c.eventCallbacks;
    c.eventCallbacks = {};
    refused = [];
    ircClient.on("SEND_REFUSED", (e) => refused.push(e));
    ircClient.servers.set(SERVER, {
      id: SERVER,
      name: SERVER,
      host: "irc.test",
      port: 6697,
      isConnected: true,
      capabilities: ["labeled-response", "batch"],
      channels: [],
      privateChats: [],
      users: [],
    } as never);
    ircClient.nicks.set(SERVER, "me");
  });

  afterEach(() => {
    (
      ircClient as unknown as { eventCallbacks: Record<string, unknown[]> }
    ).eventCallbacks = saved;
    ircClient.servers.delete(SERVER);
  });

  it("reports the target and the server's reason", () => {
    feed(":irc.test 404 me #chan :Cannot send to channel (+m)");
    expect(refused).toEqual([
      expect.objectContaining({
        serverId: SERVER,
        target: "#chan",
        reason: "Cannot send to channel (+m)",
        label: undefined,
      }),
    ]);
  });

  it("carries the label of the send it answers", () => {
    feed(
      "@label=abc :irc.test BATCH +b1 labeled-response",
      "@batch=b1 :irc.test 404 me #chan :Cannot send to channel",
      ":irc.test BATCH -b1",
    );
    expect(refused).toEqual([
      expect.objectContaining({ target: "#chan", label: "abc" }),
    ]);
  });
});

describe("recent sends", () => {
  it("remembers a PRIVMSG to a target once, and only for a short while", () => {
    const sent: string[] = [];
    (ircClient as unknown as { sockets: Map<string, unknown> }).sockets.set(
      "send-srv",
      {
        readyState: WebSocket.OPEN,
        send: (l: string) => sent.push(l),
        close: () => {},
      },
    );
    ircClient.sendRaw("send-srv", "@label=x PRIVMSG #Chan :hi");
    ircClient.sendRaw("send-srv", "TAGMSG #chan");
    expect(ircClient.takeRecentSend("send-srv", "#chan")).toBe(true);
    expect(ircClient.takeRecentSend("send-srv", "#chan")).toBe(false);
    (ircClient as unknown as { sockets: Map<string, unknown> }).sockets.delete(
      "send-srv",
    );
  });
});
