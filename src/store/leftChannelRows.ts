import ircClient from "../lib/ircClient";
import { leftChannelsOf } from "../lib/leftChannels";
import type { Channel } from "../types";
import { generateDeterministicId } from "./helpers";

/** The channels of a server with every one we are out of shown as left: a row we hold is marked, and a missing one is put back for the user to rejoin. */
export function withLeftChannels(
  serverId: string,
  channels: Channel[],
): Channel[] {
  const leftChannels = Object.entries(leftChannelsOf(serverId)).filter(
    ([name]) => ircClient.isChannel(serverId, name),
  );
  if (leftChannels.length === 0) return channels;
  const leftReasons = new Map(
    leftChannels.map(([name, leftReason]) => [name.toLowerCase(), leftReason]),
  );
  const shown = new Set(channels.map((c) => c.name.toLowerCase()));
  const marked = channels.map((c) => {
    const leftReason = leftReasons.get(c.name.toLowerCase());
    return leftReason && c.leftReason !== leftReason
      ? { ...c, leftReason, users: [], isLoadingHistory: false }
      : c;
  });
  const restored: Channel[] = leftChannels
    .filter(([name]) => !shown.has(name.toLowerCase()))
    .map(([name, leftReason]) => ({
      id: generateDeterministicId(serverId, name),
      name,
      isPrivate: false,
      serverId,
      unreadCount: 0,
      isMentioned: false,
      messages: [],
      users: [],
      leftReason,
    }));
  return [...marked, ...restored];
}
