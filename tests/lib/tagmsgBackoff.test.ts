import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";

// A network without message-tags behind a forwarding bouncer answers every
// TAGMSG with "Unknown command". That line is not shown, and no more go out.
const SERVER = "tag-srv";

function connect() {
  const sent: string[] = [];
  (ircClient as unknown as { sockets: Map<string, unknown> }).sockets.set(
    SERVER,
    {
      readyState: WebSocket.OPEN,
      send: (raw: string) => sent.push(raw),
      close: () => {},
    },
  );
  ircClient.servers.set(SERVER, {
    id: SERVER,
    name: SERVER,
    host: "irc.test",
    port: 6697,
    isConnected: true,
    capabilities: ["message-tags"],
    channels: [],
    privateChats: [],
    users: [],
  } as never);
  ircClient.nicks.set(SERVER, "me");
  useStore.setState({
    servers: [
      {
        id: SERVER,
        name: SERVER,
        host: "irc.test",
        port: 6697,
        isConnected: true,
        users: [],
        channels: [],
        privateChats: [],
        capabilities: ["message-tags"],
      },
    ] as never,
    messages: {},
  });
  return sent;
}
const feed = (...lines: string[]) =>
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), SERVER);
const notices = () =>
  (useStore.getState().messages[`${SERVER}-server-notices`] ?? []).map(
    (m) => m.content,
  );

describe("TAGMSG back-off", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.disconnect(SERVER);
    ircClient.servers.delete(SERVER);
    ircClient.nicks.delete(SERVER);
  });

  it("stops sending TAGMSG after the server calls it unknown, quietly", () => {
    const sent = connect();
    ircClient.sendRaw(SERVER, "@+typing=active TAGMSG #chan");
    expect(sent).toContain("@+typing=active TAGMSG #chan");
    feed(":irc.test 421 me TAGMSG :Unknown command");
    expect(notices()).toEqual([]);
    ircClient.sendRaw(SERVER, "@+typing=paused TAGMSG #chan");
    ircClient.sendRaw(SERVER, "PRIVMSG #chan :still fine");
    expect(sent.filter((l) => l.includes("TAGMSG"))).toHaveLength(1);
    expect(sent).toContain("PRIVMSG #chan :still fine");
  });

  it("still shows an unknown command the user typed", () => {
    connect();
    feed(":irc.test 421 me FOO :Unknown command");
    expect(notices()).toEqual(["FOO Unknown command"]);
  });
});
