import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";

// MONITOR goes out only to servers that advertise it, and that is known
// from ISUPPORT, which arrives after the welcome: requests made before the
// registration burst ends wait for it.
const SERVER = "mon-srv";

function connect(serverId: string) {
  const sent: string[] = [];
  (ircClient as unknown as { sockets: Map<string, unknown> }).sockets.set(
    serverId,
    {
      readyState: WebSocket.OPEN,
      send: (raw: string) => sent.push(raw),
      close: () => {},
    },
  );
  ircClient.servers.set(serverId, {
    id: serverId,
    name: serverId,
    host: "irc.test",
    port: 6697,
    isConnected: true,
    capabilities: [],
    channels: [],
    privateChats: [],
    users: [],
  } as never);
  ircClient.nicks.set(serverId, "me");
  return sent;
}
const feed = (serverId: string, ...lines: string[]) =>
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), serverId);

describe("MONITOR gating", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
  afterEach(() => {
    vi.restoreAllMocks();
    for (const id of [SERVER, `${SERVER}-2`]) {
      ircClient.disconnect(id);
      ircClient.servers.delete(id);
      ircClient.nicks.delete(id);
    }
  });

  it("waits for the registration burst, then monitors where the server supports it", () => {
    const sent = connect(SERVER);
    feed(SERVER, ":irc.test 001 me :Welcome");
    ircClient.monitorAdd(SERVER, ["alice"]);
    expect(sent.some((l) => l.startsWith("MONITOR"))).toBe(false);
    feed(
      SERVER,
      ":irc.test 005 me MONITOR=100 CHANTYPES=# :are supported by this server",
      ":irc.test 376 me :End of /MOTD command.",
    );
    expect(sent).toContain("MONITOR + alice");
    ircClient.monitorAdd(SERVER, ["bob"]);
    expect(sent).toContain("MONITOR + bob");
  });

  it("never sends MONITOR to a server without it", () => {
    const id = `${SERVER}-2`;
    const sent = connect(id);
    feed(id, ":bouncer 001 me :Welcome to soju");
    ircClient.monitorAdd(id, ["alice"]);
    feed(
      id,
      ":bouncer 005 me CHANTYPES=# :are supported by this server",
      ":bouncer 422 me :Use /motd to read the message of the day",
    );
    ircClient.monitorAdd(id, ["carol"]);
    expect(sent.filter((l) => l.startsWith("MONITOR"))).toEqual([]);
  });
});
