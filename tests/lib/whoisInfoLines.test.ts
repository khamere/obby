import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";

// A WHOIS answer is made of several free-text numerics (307 registered
// nick, 313 operator, 310 helpop, 338 actual host). They belong to the
// profile with the other WHOIS lines, not to the server log.
const SERVER = "whois-srv";

const feed = (...lines: string[]) =>
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), SERVER);

describe("free-text WHOIS numerics", () => {
  let special: unknown[];
  let replies: unknown[];
  let saved: Record<string, unknown[]>;

  beforeEach(() => {
    const c = ircClient as unknown as {
      eventCallbacks: Record<string, unknown[]>;
    };
    saved = c.eventCallbacks;
    c.eventCallbacks = {};
    special = [];
    replies = [];
    ircClient.on("WHOIS_SPECIAL", (e) => special.push(e));
    ircClient.on("SERVER_REPLY", (e) => replies.push(e));
    ircClient.servers.set(SERVER, {
      id: SERVER,
      name: SERVER,
      host: "irc.test",
      port: 6697,
      isConnected: true,
      capabilities: [],
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
    vi.restoreAllMocks();
  });

  it("files them with the profile instead of the server log", () => {
    feed(
      ":irc.test 307 me Sora :is a registered nick",
      ":irc.test 313 me Sora :is an IRC Operator",
      ":irc.test 310 me Sora :is available for help",
      ":irc.test 338 me Sora :is actually using host",
    );
    expect(replies).toEqual([]);
    expect(special).toEqual([
      expect.objectContaining({
        nick: "Sora",
        message: "is a registered nick",
      }),
      expect.objectContaining({ nick: "Sora", message: "is an IRC Operator" }),
      expect.objectContaining({
        nick: "Sora",
        message: "is available for help",
      }),
      expect.objectContaining({
        nick: "Sora",
        message: "is actually using host",
      }),
    ]);
  });
});
