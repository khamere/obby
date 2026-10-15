import type { NickPalette } from "../lib/chatLook";
import type { MediaVisibilityLevel } from "../lib/mediaUtils";
import type {
  FontPreset,
  LineSpacing,
  MessageDensity,
} from "../lib/typography";

export type layoutColumn = "serverList" | "chatView" | "memberList";
export type { MediaVisibilityLevel };

export interface ConnectionDetails {
  name: string;
  host: string;
  port: string;
  nickname: string;
  useWebSocket?: boolean;
  ui?: {
    disableServerConnectionInfo?: boolean;
    hideServerInfo?: boolean;
    hideClose?: boolean;
    title?: string;
    lockWebSocket?: boolean;
  };
}

export type SavedMetadata = Record<
  string,
  Record<string, Record<string, { value: string; visibility: string }>>
>;

export type PinnedPrivateChatsMap = Record<
  string,
  Array<{ username: string; order: number }>
>;

export type ChannelOrderMap = Record<string, string[]>;

// serverId -> lowercased nick -> ISO time the user closed that private chat.
export type ClosedPrivateChatsMap = Record<string, Record<string, string>>;

export interface GlobalSettings {
  // Theme (see lib/theme)
  theme: string;
  accentColor: string;
  customTheme: string;
  // Chat look (see lib/chatLook)
  nickPalette: NickPalette;
  chatBackground: string;
  chatBackgroundOpacity: number;
  // Typography (see lib/typography)
  fontFamily: FontPreset;
  fontFamilyCustom: string;
  chatFontFamily: FontPreset;
  chatFontFamilyCustom: string;
  fontSize: number;
  lineSpacing: LineSpacing;
  messageDensity: MessageDensity;
  enableNotifications: boolean;
  notificationSound: string;
  enableNotificationSounds: boolean;
  notificationVolume: number;
  enableHighlights: boolean;
  sendTypingNotifications: boolean;
  showEvents: boolean;
  showNickChanges: boolean;
  showJoinsParts: boolean;
  showQuits: boolean;
  showKicks: boolean;
  customMentions: string[];
  ignoreList: string[];
  nickname: string;
  accountName: string;
  accountPassword: string;
  enableMultilineInput: boolean;
  multilineOnShiftEnter: boolean;
  autoFallbackToSingleLine: boolean;
  mediaVisibilityLevel: MediaVisibilityLevel;
  enableMarkdownRendering: boolean;
  coloredNicknames: boolean;
  awayMessage: string;
  quitMessage: string;
}

export interface UISelections {
  selectedServerId: string | null;
  perServerSelections: Record<
    string,
    {
      selectedChannelId: string | null;
      selectedChannelName?: string | null;
      selectedPrivateChatId: string | null;
      selectedPrivateChatUsername?: string | null;
    }
  >;
  sidebarPreferences?: {
    channelList: { isVisible: boolean; width: number };
    memberList: { isVisible: boolean; width: number };
  };
  lastSelection?: {
    serverHost: string;
    channelName: string | null;
    privateChatUsername: string | null;
  };
}
