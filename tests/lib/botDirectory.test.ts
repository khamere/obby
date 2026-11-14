import { describe, expect, it } from "vitest";
import { getVisibleBots } from "../../src/lib/botDirectory";
import type { Channel, PushBotInfo, Server } from "../../src/types";

const channel: Channel = {
  id: "room",
  name: "#room",
  serverId: "one",
  isPrivate: false,
  unreadCount: 0,
  isMentioned: false,
  messages: [],
  users: [{ id: "bot", username: "Helper", isBot: true, isOnline: true }],
};
const server: Server = {
  id: "one",
  name: "One",
  host: "irc.example.test",
  port: 6697,
  channels: [channel],
  privateChats: [],
  users: [],
  isConnected: true,
};
const registered: PushBotInfo = {
  bot_id: "registered",
  nick: "Helper",
  realname: "Registered helper",
  scope: "server",
  transport: "gateway",
  status: "active",
  online: true,
  from_config: true,
  channels: [],
  commands: [{ name: "hello" }],
};

describe("getVisibleBots", () => {
  it("deduplicates bots across shared channels without mutating membership", () => {
    const second = {
      ...channel,
      id: "two",
      name: "#two",
      users: [
        { ...channel.users[0], username: "HELPER", realname: "A helper" },
      ],
    };
    const result = getVisibleBots(
      { ...server, channels: [channel, second] },
      false,
    );
    expect(result).toEqual([
      {
        kind: "irc",
        nick: "Helper",
        realname: "A helper",
        online: true,
        channels: ["#room", "#two"],
      },
    ]);
    expect(channel.users[0].realname).toBeUndefined();
  });

  it("preserves directory commands and management provenance for a matching bot", () => {
    expect(
      getVisibleBots({ ...server, bots: { helper: registered } }, false),
    ).toEqual([{ ...registered, kind: "directory" }]);
  });

  it("does not infer bots from nicknames, offline users, or another network", () => {
    expect(
      getVisibleBots(
        {
          ...server,
          channels: [
            {
              ...channel,
              users: [
                { id: "normal", username: "SomethingBot", isOnline: true },
                {
                  id: "offline",
                  username: "OldBot",
                  isOnline: false,
                  isBot: true,
                },
              ],
            },
          ],
        },
        false,
      ),
    ).toEqual([]);
    expect(
      getVisibleBots({ ...server, id: "two", channels: [] }, false),
    ).toEqual([]);
    expect(getVisibleBots(undefined, true)).toEqual([]);
  });

  it("keeps the directory reachability rule and hides stale selected-channel entries", () => {
    const remote = {
      ...registered,
      scope: "channel" as const,
      channels: ["#elsewhere"],
    };
    const network = { ...server, channels: [], bots: { helper: remote } };
    expect(getVisibleBots(network, false)).toEqual([]);
    expect(getVisibleBots(network, true)).toEqual([
      { ...remote, kind: "directory" },
    ]);
  });
});
