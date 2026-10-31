// draft/read-marker: cache the per-target marker on the matching
// Channel / PrivateChat in the Zustand store.  The marker is what the
// rest of the UI uses to decide which messages to count as unread,
// and what to clear notifications for.
//
// Channel matches: the target case-insensitively equals the channel
// name.
// PrivateChat matches: the target case-insensitively equals the
// other participant's username.

import type { StoreApi } from "zustand";
import ircClient from "../../lib/ircClient";
import type { Message } from "../../types";
import type { AppState } from "../index";

function eqIC(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// A marker at or past the newest loaded message means another of the user's
// sessions has read everything here, so this one's badges are stale.
function readsEverything(
  messages: Message[] | undefined,
  timestamp: string | null,
): boolean {
  if (!timestamp) return false;
  const marker = new Date(timestamp).getTime();
  if (Number.isNaN(marker)) return false;
  return !(messages ?? []).some(
    (m) =>
      (m.type === "message" || m.type === undefined) &&
      new Date(m.timestamp).getTime() > marker,
  );
}

const READ = { unreadCount: 0, mentionCount: 0, isMentioned: false };

export function registerReadMarkerHandlers(store: StoreApi<AppState>): void {
  ircClient.on("MARKREAD", ({ serverId, target, timestamp }) => {
    store.setState((state) => {
      let touched = false;
      const updatedServers = state.servers.map((server) => {
        if (server.id !== serverId) return server;
        let serverTouched = false;

        const channels = server.channels.map((channel) => {
          if (!eqIC(channel.name, target)) return channel;
          const read =
            (channel.unreadCount > 0 || channel.isMentioned) &&
            readsEverything(
              state.messages[`${serverId}-${channel.id}`],
              timestamp,
            );
          if (channel.readMarker === timestamp && !read) return channel;
          serverTouched = true;
          return {
            ...channel,
            readMarker: timestamp,
            ...(read ? READ : {}),
          };
        });

        const privateChats = (server.privateChats || []).map((pc) => {
          if (!eqIC(pc.username, target)) return pc;
          const same = pc.readMarker === timestamp;
          const read =
            (pc.unreadCount > 0 || pc.isMentioned) &&
            readsEverything(state.messages[`${serverId}-${pc.id}`], timestamp);
          if (same && pc.readMarkerFetched && !read) return pc;
          serverTouched = true;
          return {
            ...pc,
            readMarker: timestamp,
            readMarkerFetched: true,
            ...(read ? READ : {}),
          };
        });

        if (!serverTouched) return server;
        touched = true;
        return { ...server, channels, privateChats };
      });

      if (!touched) return {};
      return { servers: updatedServers };
    });
  });
}
