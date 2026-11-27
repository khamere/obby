import * as storage from "../store/localStorage";
import type { Channel } from "../types";
import { cannotBeChannelName } from "./ircUtils";

export type LeftReason = NonNullable<Channel["leftReason"]>;

// We read the saved marks of a server once and answer from memory after that, so asking costs nothing where storage is slow or closed to us.
const leftChannels = new Map<string, Record<string, LeftReason>>();

// Storage can hold anything a restored backup or an older build wrote, and we read it before the server names its channel prefixes, so we keep every entry with a name a server could hold and a reason we know.
function savedLeftChannels(serverId: string): Record<string, LeftReason> {
  let saved: unknown;
  try {
    saved = storage.servers.load().find((s) => s.id === serverId)?.leftChannels;
  } catch {
    return {};
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(
    Object.entries(saved).filter(
      ([name, leftReason]) =>
        name !== "" &&
        !cannotBeChannelName(name) &&
        (leftReason === "kicked" || leftReason === "parted"),
    ),
  );
}

/** Drops what we hold for a server that is gone, so a server added again under the same id starts with what storage says. */
export function forgetLeftChannels(serverId: string): void {
  leftChannels.delete(serverId);
}

/** The channels of one server we still show but are out of, by the name we show. */
export function leftChannelsOf(serverId: string): Record<string, LeftReason> {
  let known = leftChannels.get(serverId);
  if (!known) {
    known = savedLeftChannels(serverId);
    leftChannels.set(serverId, known);
  }
  return known;
}

/** Why we are out of a channel, or undefined when nothing says we left it. */
export function leftReasonOf(
  serverId: string,
  channelName: string,
): LeftReason | undefined {
  return leftChannelsOf(serverId)[savedNameOf(serverId, channelName)];
}

// Servers compare channel names without case, so we look a channel up under whichever spelling we saved.
function savedNameOf(serverId: string, channelName: string): string {
  const lowered = channelName.toLowerCase();
  return (
    Object.keys(leftChannelsOf(serverId)).find(
      (name) => name.toLowerCase() === lowered,
    ) ?? channelName
  );
}

// The mark goes into the saved server entry, so a reload and a reconnect both stay out of the channel.
export function saveLeftReason(
  serverId: string,
  channelName: string,
  leftReason: LeftReason | undefined,
): void {
  const key = savedNameOf(serverId, channelName);
  if (leftChannelsOf(serverId)[key] === leftReason) return;
  const { [key]: _previous, ...others } = leftChannelsOf(serverId);
  const updated = leftReason ? { ...others, [key]: leftReason } : others;
  leftChannels.set(serverId, updated);
  try {
    const savedServers = storage.servers.load();
    const savedServer = savedServers.find((s) => s.id === serverId);
    if (!savedServer) return;
    savedServer.leftChannels = updated;
    storage.servers.save(savedServers);
  } catch {
    // Storage is full or closed to us, and the mark still holds until the page reloads.
  }
}
