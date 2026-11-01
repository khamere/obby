import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import type { Server } from "../../src/types";

// Server Notices as a classic status window: numerics Obby has no handler
// for show there, the MOTD is fetched on bouncer networks, and a "no MOTD"
// reply shows only as an answer to our own /motd.
const serverId = "s1";

function seed(extra: Partial<Server> = {}) {
  ircClient.nicks.set(serverId, "me");
  useStore.setState({
    servers: [
      {
        id: serverId,
        name: "net",
        host: "irc.test",
        port: 6697,
        isConnected: true,
        users: [],
        channels: [],
        privateChats: [],
        capabilities: [],
        ...extra,
      } as unknown as Server,
    ],
    messages: {},
    activeBatches: {},
    processedMessageIds: new Set(),
  });
}

function feed(...lines: string[]) {
  (
    ircClient as unknown as {
      handleMessage(data: string, serverId: string): void;
    }
  ).handleMessage(lines.join("\r\n"), serverId);
}

const notices = () =>
  (useStore.getState().messages[`${serverId}-server-notices`] ?? []).map(
    (m) => m.content,
  );

describe("server replies in Server Notices", () => {
  beforeEach(() => {
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
    seed();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ircClient.nicks.delete(serverId);
    useStore.setState((s) => ({
      globalSettings: { ...s.globalSettings, showServerReplies: true },
    }));
  });

  it("shows numerics without a handler, without our nick", () => {
    feed(
      ":irc.test 251 me :There are 12 users and 3 invisible on 1 servers",
      ":irc.test 255 me :I have 15 clients and 0 servers",
    );
    expect(notices()).toEqual([
      "There are 12 users and 3 invisible on 1 servers",
      "I have 15 clients and 0 servers",
    ]);
  });

  it("keeps routine end-of-list replies out", () => {
    feed(":irc.test 366 me #chan :End of /NAMES list.");
    expect(notices()).toEqual([]);
  });

  it("stays quiet when the setting is off", () => {
    useStore.setState((s) => ({
      globalSettings: { ...s.globalSettings, showServerReplies: false },
    }));
    feed(":irc.test 251 me :There are 12 users");
    expect(notices()).toEqual([]);
  });

  it("shows a no-MOTD reply only as an answer to our own request", () => {
    // soju's unsolicited one on connect
    feed(":bouncer 422 me :Use /motd to read the message of the day");
    expect(notices()).toEqual([]);
    ircClient.requestMotd(serverId);
    feed(":irc.test 422 me :MOTD File is missing");
    expect(notices()).toEqual(["MOTD File is missing"]);
    // and not twice
    feed(":irc.test 422 me :MOTD File is missing");
    expect(notices()).toHaveLength(1);
  });

  it("asks a bouncer network for its MOTD when the bouncer says to use /motd", () => {
    seed({ bouncerNetid: "42", bouncerServerId: "parent" });
    feed(":bouncer 422 me :Use /motd to read the message of the day");
    expect(ircClient.sendRaw).toHaveBeenCalledWith(serverId, "MOTD");
    expect(notices()).toEqual([]);
    // the network's own answer is what shows
    feed(":irc.test 422 me :MOTD File is missing");
    expect(notices()).toEqual(["MOTD File is missing"]);
    // and a second unsolicited one on the same connection asks no more
    feed(":bouncer 422 me :Use /motd to read the message of the day");
    expect(vi.mocked(ircClient.sendRaw)).toHaveBeenCalledTimes(1);
  });

  it("leaves a plain network's no-MOTD line alone", () => {
    feed(":irc.test 422 me :MOTD File is missing");
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });
});
