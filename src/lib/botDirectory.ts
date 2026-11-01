import type { PushBotInfo, Server } from "../types";

export type BotDirectoryEntry =
  | (PushBotInfo & { kind: "directory" })
  | {
      kind: "irc";
      nick: string;
      realname: string;
      online: boolean;
      channels: string[];
    };

export function getVisibleBots(
  server: Server | undefined,
  isOper: boolean,
): BotDirectoryEntry[] {
  if (!server) return [];
  const joinedChannels = new Set(
    server.channels.map((channel) => channel.name.toLowerCase()),
  );
  const bots = new Map<string, BotDirectoryEntry>();
  for (const bot of Object.values(server.bots ?? {})) {
    if (
      isOper ||
      bot.scope === "server" ||
      bot.channels?.some((channel) => joinedChannels.has(channel.toLowerCase()))
    ) {
      bots.set(bot.nick.toLowerCase(), { ...bot, kind: "directory" });
    }
  }
  // Derive ordinary bots from live membership so PART/QUIT cannot leave a registry entry behind.
  if (server.isConnected) {
    for (const channel of server.channels) {
      for (const user of channel.users) {
        if (!user.isBot || !user.isOnline) continue;
        const key = user.username.toLowerCase();
        const existing = bots.get(key);
        if (existing?.kind === "directory") continue;
        if (existing) {
          if (!existing.channels.includes(channel.name)) {
            existing.channels.push(channel.name);
          }
          existing.realname ||= user.realname ?? "";
        } else {
          bots.set(key, {
            kind: "irc",
            nick: user.username,
            realname: user.realname ?? "",
            online: true,
            channels: [channel.name],
          });
        }
      }
    }
  }
  return [...bots.values()].sort((a, b) => a.nick.localeCompare(b.nick));
}
