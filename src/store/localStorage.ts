import type { ServerConfig } from "../types";
import type {
  ChannelOrderMap,
  ClosedPrivateChatsMap,
  GlobalSettings,
  PinnedPrivateChatsMap,
  SavedMetadata,
  UISelections,
} from "./types";

const KEYS = {
  SERVERS: "savedServers",
  METADATA: "serverMetadata",
  OWN_METADATA: "ownUserMetadata",
  SETTINGS: "globalSettings",
  CHANNEL_ORDER: "channelOrder",
  PINNED_PMS: "pinnedPrivateChats",
  CLOSED_PMS: "closedPrivateChats",
  UI_SELECTION: "uiSelections",
  MIGRATION_VERSION: "migrationVersion",
  BOUNCER_GROUP_ACCENTS: "bouncerGroupAccents",
} as const;

export const ownMetadata = {
  load: (): SavedMetadata => {
    try {
      return JSON.parse(localStorage.getItem(KEYS.OWN_METADATA) || "{}");
    } catch {
      return {};
    }
  },
  save: (data: SavedMetadata) => {
    try {
      localStorage.setItem(KEYS.OWN_METADATA, JSON.stringify(data));
    } catch {
      // storage full or disabled
    }
  },
  saveKey: (
    serverId: string,
    nick: string,
    key: string,
    value: string | undefined,
    visibility?: string,
  ) => {
    try {
      const data = ownMetadata.load();
      if (!data[serverId]) data[serverId] = {};
      const targetNick = nick || "*";
      const existingNick =
        Object.keys(data[serverId]).find(
          (k) => k.toLowerCase() === targetNick.toLowerCase(),
        ) || targetNick;
      if (!data[serverId][existingNick]) data[serverId][existingNick] = {};
      if (value !== undefined && value !== "") {
        data[serverId][existingNick][key] = {
          value,
          visibility: visibility || "",
        };
      } else {
        delete data[serverId][existingNick][key];
      }
      ownMetadata.save(data);

      // Keep in-memory cache in sync
      if (!metadataCache[serverId]) metadataCache[serverId] = {};
      if (!metadataCache[serverId][existingNick]) {
        metadataCache[serverId][existingNick] = {};
      }
      if (value !== undefined && value !== "") {
        metadataCache[serverId][existingNick][key] = {
          value,
          visibility: visibility || "",
        };
      } else {
        delete metadataCache[serverId][existingNick][key];
      }
    } catch {
      // storage error
    }
  },
  getForServer: (
    serverId: string,
    nick?: string,
  ): Record<string, { value: string; visibility?: string }> => {
    const data = ownMetadata.load();
    const serverData = data[serverId];
    if (!serverData) return {};
    if (nick) {
      const match = Object.keys(serverData).find(
        (k) => k.toLowerCase() === nick.toLowerCase(),
      );
      if (match && serverData[match]) return serverData[match];
    }
    const entries = Object.values(serverData);
    if (entries.length > 0) return entries[0];
    return {};
  },
};

export const bouncerGroupAccents = {
  load: (): Record<string, string> => {
    try {
      return JSON.parse(
        localStorage.getItem(KEYS.BOUNCER_GROUP_ACCENTS) || "{}",
      );
    } catch {
      return {};
    }
  },
  save: (map: Record<string, string>) => {
    localStorage.setItem(KEYS.BOUNCER_GROUP_ACCENTS, JSON.stringify(map));
  },
};

export const servers = {
  load: (): ServerConfig[] => {
    const data = JSON.parse(localStorage.getItem(KEYS.SERVERS) || "[]");
    return [...data].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  },

  save: (servers: ServerConfig[]) => {
    localStorage.setItem(KEYS.SERVERS, JSON.stringify(servers));
  },
};

// In-memory metadata cache for channel members. We intentionally do NOT persist
// other users' metadata across page reloads (avoiding stale entries / churn).
// But we DO initialize with own user metadata so the user's own avatar and profile
// survive page reload.
try {
  localStorage.removeItem(KEYS.METADATA);
} catch {
  // private-window or storage-disabled -- not fatal
}
let metadataCache: SavedMetadata = ownMetadata.load();
export const metadata = {
  load: (): SavedMetadata => metadataCache,
  save: (data: SavedMetadata) => {
    metadataCache = data;
  },
};

export const settings = {
  load: (): Partial<GlobalSettings> => {
    try {
      const raw = JSON.parse(
        localStorage.getItem(KEYS.SETTINGS) || "{}",
      ) as Record<string, unknown>;

      // Migrate old 3-boolean format to the single level enum.
      // Most-permissive flag wins so existing preferences are preserved.
      if (!("mediaVisibilityLevel" in raw)) {
        raw.mediaVisibilityLevel = raw.showExternalContent
          ? 3
          : raw.showTrustedSourcesMedia
            ? 2
            : raw.showSafeMedia === false
              ? 0
              : 1;
        delete raw.showSafeMedia;
        delete raw.showTrustedSourcesMedia;
        delete raw.showExternalContent;
      }

      // Migrate legacy enableNotifications: false (from when no UI toggle existed)
      if (localStorage.getItem("obby.notificationsDefaultV1") !== "1") {
        raw.enableNotifications = true;
        localStorage.setItem("obby.notificationsDefaultV1", "1");
      }

      return raw as Partial<GlobalSettings>;
    } catch {
      return {};
    }
  },

  save: (data: GlobalSettings) => {
    localStorage.setItem(KEYS.SETTINGS, JSON.stringify(data));
  },
};

export const channelOrder = {
  load: (): ChannelOrderMap => {
    return JSON.parse(localStorage.getItem(KEYS.CHANNEL_ORDER) || "{}");
  },

  save: (data: ChannelOrderMap) => {
    localStorage.setItem(KEYS.CHANNEL_ORDER, JSON.stringify(data));
  },
};

export const pinnedChats = {
  load: (): PinnedPrivateChatsMap => {
    try {
      return JSON.parse(localStorage.getItem(KEYS.PINNED_PMS) || "{}");
    } catch {
      return {};
    }
  },

  save: (data: PinnedPrivateChatsMap) => {
    localStorage.setItem(KEYS.PINNED_PMS, JSON.stringify(data));
  },
};

// Private chats the user closed, with the time of the close. CHATHISTORY
// TARGETS keeps listing a conversation forever, so this is what stops a
// closed chat from coming back on the next reload until there is newer
// activity.
export const closedChats = {
  load: (): ClosedPrivateChatsMap => {
    try {
      return JSON.parse(localStorage.getItem(KEYS.CLOSED_PMS) || "{}");
    } catch {
      return {};
    }
  },

  save: (data: ClosedPrivateChatsMap) => {
    localStorage.setItem(KEYS.CLOSED_PMS, JSON.stringify(data));
  },

  closedAt: (serverId: string, username: string): string | undefined =>
    closedChats.load()[serverId]?.[username.toLowerCase()],

  record: (serverId: string, username: string, closedAt: Date) => {
    const data = closedChats.load();
    data[serverId] = {
      ...(data[serverId] ?? {}),
      [username.toLowerCase()]: closedAt.toISOString(),
    };
    closedChats.save(data);
  },

  forget: (serverId: string, username: string) => {
    const data = closedChats.load();
    if (!data[serverId]?.[username.toLowerCase()]) return;
    delete data[serverId][username.toLowerCase()];
    closedChats.save(data);
  },
};

export const uiSelections = {
  load: (): UISelections => {
    try {
      const saved = localStorage.getItem(KEYS.UI_SELECTION);
      if (!saved) {
        return { selectedServerId: null, perServerSelections: {} };
      }
      return JSON.parse(saved);
    } catch {
      return { selectedServerId: null, perServerSelections: {} };
    }
  },

  save: (data: UISelections) => {
    localStorage.setItem(KEYS.UI_SELECTION, JSON.stringify(data));
  },
};

export const migrationVersion = {
  get: (): number => {
    return Number.parseInt(
      localStorage.getItem(KEYS.MIGRATION_VERSION) || "0",
      10,
    );
  },

  set: (version: number) => {
    localStorage.setItem(KEYS.MIGRATION_VERSION, version.toString());
  },
};

export type {
  ChannelOrderMap,
  GlobalSettings,
  PinnedPrivateChatsMap,
  SavedMetadata,
  UISelections,
};
export { KEYS };
