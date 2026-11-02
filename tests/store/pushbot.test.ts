import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ircClient from "../../src/lib/ircClient";
import useStore from "../../src/store";
import {
  queryBotCommands,
  queryUncachedBotsInChannel,
} from "../../src/store/handlers/pushbot";

function setupServer() {
  useStore.setState({
    servers: [
      {
        id: "srv-1",
        name: "TestServer",
        host: "irc.example.com",
        port: 6667,
        channels: [
          {
            id: "chan-1",
            name: "#bots",
            topic: "",
            users: [
              {
                id: "Weather",
                username: "Weather",
                isOnline: true,
                isBot: true,
              },
            ],
            messages: [],
            isPrivate: false,
            serverId: "srv-1",
            unreadCount: 0,
            isMentioned: false,
            modes: "",
          },
        ],
        privateChats: [],
        isConnected: true,
        users: [],
      },
    ],
  });
}

function encodeBotCmds(commands: unknown): string {
  const json = JSON.stringify({ commands });
  return Buffer.from(json, "utf8").toString("base64");
}

describe("bot discovery requests", () => {
  let now = Date.now();
  beforeEach(() => {
    setupServer();
    now += 600_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(ircClient, "isSocketOpen").mockReturnValue(true);
    vi.spyOn(ircClient, "hasCapability").mockReturnValue(true);
    vi.spyOn(ircClient, "sendRaw").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not probe ordinary users or new JOINs", () => {
    ircClient.triggerEvent("JOIN", {
      serverId: "srv-1",
      username: "Visitor",
      channelName: "#bots",
    });
    queryBotCommands("srv-1", "Visitor");
    expect(
      vi
        .mocked(ircClient.sendRaw)
        .mock.calls.filter(([, line]) => line.includes("bot-cmds-query")),
    ).toEqual([]);
  });

  it("queries a confirmed +B bot after WHO but does not repeatedly probe silent bots", () => {
    ircClient.triggerEvent("WHO_END", { serverId: "srv-1", mask: "#bots" });
    queryUncachedBotsInChannel("srv-1", "#bots");
    queryBotCommands("srv-1", "WEATHER", true);
    expect(ircClient.sendRaw).toHaveBeenCalledTimes(1);
    expect(ircClient.sendRaw).toHaveBeenCalledWith(
      "srv-1",
      "@+draft/bot-cmds-query TAGMSG Weather",
    );
    now += 300_000;
    queryBotCommands("srv-1", "Weather", true);
    expect(ircClient.sendRaw).toHaveBeenCalledTimes(2);
  });

  it("waits for message-tags and an open connection", () => {
    vi.mocked(ircClient.hasCapability).mockReturnValue(false);
    queryBotCommands("srv-1", "Weather");
    vi.mocked(ircClient.hasCapability).mockReturnValue(true);
    vi.mocked(ircClient.isSocketOpen).mockReturnValue(false);
    queryBotCommands("srv-1", "Weather");
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
  });

  it("keeps cached commands until explicitly refreshed and scopes attempts per network", () => {
    useStore.setState((state) => ({
      servers: state.servers.map((server) => ({
        ...server,
        botCommands: { weather: [{ name: "forecast" }] },
      })),
    }));
    queryBotCommands("srv-1", "Weather");
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
    queryBotCommands("srv-1", "Weather", true);
    useStore.setState((state) => ({
      servers: [...state.servers, { ...state.servers[0], id: "srv-2" }],
    }));
    queryBotCommands("srv-2", "Weather", true);
    expect(ircClient.sendRaw).toHaveBeenCalledTimes(2);
  });

  it("discovers a shared-channel user when WHOIS confirms its bot flag", () => {
    useStore.setState((state) => ({
      servers: state.servers.map((server) => ({
        ...server,
        channels: server.channels.map((channel) => ({
          ...channel,
          users: channel.users.map((user) => ({ ...user, isBot: false })),
        })),
      })),
    }));
    queryBotCommands("srv-1", "Weather");
    expect(ircClient.sendRaw).not.toHaveBeenCalled();
    ircClient.triggerEvent("WHOIS_BOT", {
      serverId: "srv-1",
      nick: "me",
      target: "Weather",
      message: "is a bot",
    });
    expect(ircClient.sendRaw).toHaveBeenCalledTimes(1);
  });
});

describe("pushbot store handler", () => {
  beforeEach(() => {
    setupServer();
  });

  it("caches commands when TAGMSG carries +draft/bot-cmds", () => {
    ircClient.triggerEvent("TAGMSG", {
      serverId: "srv-1",
      sender: "Weather",
      channelName: "ourNick",
      mtags: {
        "+draft/bot-cmds": encodeBotCmds([
          {
            name: "forecast",
            description: "Look up the weather",
            contexts: ["public", "pm"],
          },
        ]),
      },
      timestamp: new Date(),
    });

    const server = useStore.getState().servers[0];
    expect(server.botCommands).toBeDefined();
    expect(server.botCommands?.weather).toEqual([
      {
        name: "forecast",
        description: "Look up the weather",
        contexts: ["public", "pm"],
      },
    ]);
  });

  it("invalidates the cache on +draft/bot-cmds-changed", () => {
    useStore.setState((s) => ({
      servers: s.servers.map((srv) => ({
        ...srv,
        botCommands: { weather: [{ name: "forecast" }] },
      })),
    }));

    ircClient.triggerEvent("TAGMSG", {
      serverId: "srv-1",
      sender: "Weather",
      channelName: "ourNick",
      mtags: { "+draft/bot-cmds-changed": "1" },
      timestamp: new Date(),
    });

    const server = useStore.getState().servers[0];
    expect(server.botCommands?.weather).toBeUndefined();
  });

  it("ignores TAGMSGs without bot-cmds tags", () => {
    ircClient.triggerEvent("TAGMSG", {
      serverId: "srv-1",
      sender: "Weather",
      channelName: "#general",
      mtags: { "+typing": "active" },
      timestamp: new Date(),
    });
    const server = useStore.getState().servers[0];
    expect(server.botCommands).toBeUndefined();
  });

  // ─── obby.world/channel-bots ──────────────────────────────────────

  function encodeBotInfo(info: object): string {
    return Buffer.from(JSON.stringify(info), "utf8").toString("base64");
  }

  it("populates server.bots on obby.world/bot-info 'add'", () => {
    ircClient.triggerEvent("TAGMSG", {
      serverId: "srv-1",
      sender: "obby.example.com",
      channelName: "ourNick",
      mtags: {
        "obby.world/bot-info": encodeBotInfo({
          event: "add",
          bot_id: "pb1",
          nick: "weather",
          realname: "Weather Bot",
          scope: "channel",
          transport: "gateway",
          status: "active",
          online: true,
          from_config: true,
          channels: ["#weather"],
          commands: [{ name: "forecast" }],
        }),
      },
      timestamp: new Date(),
    });
    const server = useStore.getState().servers[0];
    expect(server.bots?.weather?.nick).toBe("weather");
    expect(server.bots?.weather?.online).toBe(true);
    // also fills botCommands for the slash popover
    expect(server.botCommands?.weather?.[0]?.name).toBe("forecast");
  });

  it("removes server.bots[nick] on obby.world/bot-info 'remove'", () => {
    useStore.setState((s) => ({
      servers: s.servers.map((srv) => ({
        ...srv,
        bots: {
          weather: {
            bot_id: "pb1",
            nick: "weather",
            realname: "Weather Bot",
            scope: "channel",
            transport: "gateway",
            status: "active",
            online: true,
            from_config: true,
            channels: [],
            commands: [],
          },
        },
        botCommands: { weather: [{ name: "forecast" }] },
      })),
    }));

    ircClient.triggerEvent("TAGMSG", {
      serverId: "srv-1",
      sender: "obby.example.com",
      channelName: "ourNick",
      mtags: {
        "obby.world/bot-info": encodeBotInfo({
          event: "remove",
          nick: "weather",
          bot_id: "pb1",
          realname: "",
          scope: "channel",
          transport: "gateway",
          status: "deleted",
          online: false,
          from_config: false,
          channels: [],
          commands: [],
        }),
      },
      timestamp: new Date(),
    });
    const server = useStore.getState().servers[0];
    expect(server.bots?.weather).toBeUndefined();
    expect(server.botCommands?.weather).toBeUndefined();
  });
});
