import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ircClient from "../../src/lib/ircClient";

// The channel list starts with a header line (321) that carries no data,
// so it never reaches the server log.
const SERVER = "list-srv";

describe("RPL_LISTSTART", () => {
  let replies: unknown[];
  let saved: Record<string, unknown[]>;

  beforeEach(() => {
    const c = ircClient as unknown as {
      eventCallbacks: Record<string, unknown[]>;
    };
    saved = c.eventCallbacks;
    c.eventCallbacks = {};
    replies = [];
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
  });

  it("is not shown as a server reply", () => {
    (
      ircClient as unknown as {
        handleMessage(data: string, serverId: string): void;
      }
    ).handleMessage(":irc.test 321 me Channel :Users  Name", SERVER);
    expect(replies).toEqual([]);
  });
});
