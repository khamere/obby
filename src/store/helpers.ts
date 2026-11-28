import { v5 as uuidv5 } from "uuid";
import type { Channel, Message, Server, ServerConfig, User } from "../types";
import type { AppState } from "./index";
import type { HistoryWindow } from "./types";

export function findServerUser(
  server: Server | undefined,
  nick: string,
): User | undefined {
  const lower = nick.toLowerCase();
  for (const channel of server?.channels ?? []) {
    const user = channel.users.find((u) => u.username.toLowerCase() === lower);
    if (user) return user;
  }
  return undefined;
}

// Our own away state lives on the server and on our channel entries, so we write both together.
export function setUserAway(
  server: Server,
  nick: string | undefined,
  isAway: boolean,
  awayMessage: string | undefined,
  ownNick: string | undefined,
): Server {
  if (!nick) return server;
  const lowerNick = nick.toLowerCase();
  let hasChanged = false;
  const channels = server.channels.map((channel) => {
    const index = channel.users.findIndex(
      (user) => user.username.toLowerCase() === lowerNick,
    );
    const user = channel.users[index];
    if (!user || (user.isAway === isAway && user.awayMessage === awayMessage))
      return channel;
    hasChanged = true;
    const users = [...channel.users];
    users[index] = { ...user, isAway, awayMessage };
    return { ...channel, users };
  });
  const isOwn = lowerNick === ownNick?.toLowerCase();
  if (isOwn && (server.isAway !== isAway || server.awayMessage !== awayMessage))
    return { ...server, channels, isAway, awayMessage };
  return hasChanged ? { ...server, channels } : server;
}

// Namespace UUID for generating deterministic channel/chat IDs
export const CHANNEL_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Generate a deterministic UUID for a channel or private chat
 * based on the server ID and channel/chat name
 */
export function generateDeterministicId(
  serverId: string,
  name: string,
): string {
  return uuidv5(`${serverId}:${name}`, CHANNEL_NAMESPACE);
}

/**
 * Normalize host for comparison (extract hostname from URL or return as-is)
 */
export type LoginState =
  | "connecting"
  | "failed"
  | "loggedIn"
  | "guest"
  | "offline";

export function getLoginState(server: Server | undefined): LoginState {
  if (
    server?.connectionState === "connecting" ||
    (server?.isConnected && !server.isRegistered)
  )
    return "connecting";
  if (!server?.isConnected) return server?.loginRefused ? "failed" : "offline";
  if (server.saslFailed) return "failed";
  return server.account ? "loggedIn" : "guest";
}

// The socket opens before the server has logged us in, so a server counts as connecting until it has.
export function isServerConnecting(server: Server | undefined): boolean {
  return (
    getLoginState(server) === "connecting" ||
    server?.connectionState === "reconnecting"
  );
}

export function normalizeHost(host: string): string {
  if (host.includes("://")) {
    // Extract hostname from URL format
    const withoutProtocol = host.replace(/^(irc|ircs|wss):\/\//, "");
    return withoutProtocol.split(":")[0]; // Get just hostname, strip port if present
  }
  return host;
}

/**
 * Ensure host is in URL format
 */
export function ensureUrlFormat(host: string, port: number): string {
  if (host.includes("://")) {
    return host; // Already in URL format
  }
  // Convert old hostname-only format to URL — always wss://
  return `wss://${host}:${port}`;
}

// A saved login belongs to one address, so we check that a connection dials the address this config holds.
export function dialsSavedAddress(
  target: { host: string; port: number } | undefined,
  config: Pick<ServerConfig, "host" | "port">,
): boolean {
  return (
    target?.host === ensureUrlFormat(config.host, config.port) &&
    target.port === config.port
  );
}

export const MAX_MESSAGES_PER_CHANNEL = 1500;

export const messageTime = (message: Message) =>
  new Date(message.timestamp).getTime();

// A line waiting for its echo has no server time yet, so we keep it below
// every line the server stamped, in the order we sent it.
export function compareMessageOrder(a: Message, b: Message): number {
  const isPendingA = a.status === "pending";
  const isPendingB = b.status === "pending";
  if (isPendingA !== isPendingB) return isPendingA ? 1 : -1;
  if (isPendingA) return 0;
  return messageTime(a) - messageTime(b);
}

// Where a history page lies against the lines we hold, as its request tells:
// right before the line the request named, or behind every line we hold.
export type HistoryPagePlace = { before: string } | "newest";

// A history page holds the server's lines in the server's order, which their
// times cannot give back once several lines share a millisecond. So the page
// keeps its own order, and a line we hold that the page leaves out goes ahead
// of it or behind it by where the page lies, or by where the line's time falls
// against the page's edges when the request does not tell.
export function mergeHistoryPage(
  existing: Message[],
  page: Message[],
  place?: HistoryPagePlace,
): { merged: Message[]; added: Message[] } {
  const byMsgid = new Map(
    existing.flatMap((m) => (m.msgid ? [[m.msgid, m] as const] : [])),
  );
  const held = new Set<Message>();
  const added: Message[] = [];
  const run = page.flatMap((m) => {
    const time = messageTime(m);
    // Two lines the server gave different ids are two lines, however alike they are, so we match by sender, text and time only when one of them has no id.
    const copy =
      (m.msgid ? byMsgid.get(m.msgid) : undefined) ??
      existing.find(
        (e) =>
          !(e.msgid && m.msgid) &&
          e.content === m.content &&
          e.userId === m.userId &&
          messageTime(e) === time,
      );
    if (!copy) {
      added.push(m);
      return [m];
    }
    if (held.has(copy)) return [];
    held.add(copy);
    return [copy];
  });
  // A page that brings nothing new tells us nothing about the lines it leaves out, so those stay where they are and only the lines it names take its order.
  if (added.length === 0) {
    const named = run[Symbol.iterator]();
    return {
      merged: existing
        .map((m) => (held.has(m) ? (named.next().value ?? m) : m))
        .sort(compareMessageOrder),
      added,
    };
  }
  const times = page.map(messageTime);
  const oldest = Math.min(...times);
  const newest = Math.max(...times);
  const others = existing.filter((m) => !held.has(m));
  const anchor = typeof place === "object" ? place.before : undefined;
  const anchorAt = anchor ? existing.findIndex((m) => hasMsgid(m, anchor)) : -1;
  // A page inside one millisecond that repeats lines we hold starts where the first of them is, so we split our lines there the way we do at the line a request named.
  const splitAt =
    anchorAt < 0 && oldest === newest
      ? existing.findIndex((m) => held.has(m))
      : anchorAt;
  const aheadOfSplit = new Set(existing.slice(0, Math.max(splitAt, 0)));
  // A page inside one millisecond has a single edge time, so without its place a line we hold there counts as older when we hold messages before that time.
  // We count messages only, since the joins and parts a page carries reach the chat ahead of it.
  const isOlderAtEdge =
    oldest === newest &&
    (place === "newest" ||
      others.some((m) => isChatMessage(m) && messageTime(m) < newest));
  const isBeforePage = (m: Message) => {
    if (splitAt >= 0) return aheadOfSplit.has(m);
    const time = messageTime(m);
    return time < newest || (time === newest && isOlderAtEdge);
  };
  return {
    merged: [
      ...others.filter(isBeforePage),
      ...run,
      ...others.filter((m) => !isBeforePage(m)),
    ].sort(compareMessageOrder),
    added,
  };
}

export const isChatMessage = (message: Message) =>
  message.type === "message" || message.type === undefined;

// The newest message we hold for a chat, counting live messages a history
// window is keeping aside.
export function newestMessageTime(
  state: AppState,
  key: string,
): number | undefined {
  const messages = state.historyWindows[key]?.present ?? state.messages[key];
  let newest: number | undefined;
  for (const message of messages ?? []) {
    if (message.status) continue;
    // Our own lines keep their send time, so we read the server's from the echo.
    const time = message.tags?.time
      ? Date.parse(message.tags.time)
      : messageTime(message);
    if (isChatMessage(message) && !Number.isNaN(time))
      newest = newest === undefined ? time : Math.max(newest, time);
  }
  return newest;
}

// The message a "New messages" line goes above: the first message from someone
// else that is newer than the read marker.
export function firstUnreadMessageId(
  messages: Message[],
  readUpTo: number,
  ownNick: string | undefined,
): string | undefined {
  return messages.find((message) => isUnread(message, readUpTo, ownNick))?.id;
}

export const isOwnMessage = (message: Message, ownNick: string | undefined) =>
  !!ownNick && message.userId.toLowerCase() === ownNick.toLowerCase();

const isUnread = (message: Message, readUpTo: number, ownNick?: string) =>
  isChatMessage(message) &&
  messageTime(message) > readUpTo &&
  !isOwnMessage(message, ownNick);

export type UnreadCounts = {
  unreadCount: number;
  mentionCount: number;
  isMentioned: boolean;
};

// Unread messages are the ones from someone else newer than the read marker.
// Every private message is addressed to the user, so each one is a mention.
export function countUnread(
  messages: Message[],
  readUpTo: number,
  ownNick: string | undefined,
  isPrivate: boolean,
): UnreadCounts {
  const counted = new Set<string>();
  let unreadCount = 0;
  let mentionCount = 0;
  for (const message of messages) {
    const id = message.msgid ?? message.id;
    if (counted.has(id) || !isUnread(message, readUpTo, ownNick)) continue;
    counted.add(id);
    unreadCount += 1;
    if (
      isPrivate ||
      message.mentioned.length > 0 ||
      (!!message.replyMessage && isOwnMessage(message.replyMessage, ownNick))
    )
      mentionCount += 1;
  }
  return { unreadCount, mentionCount, isMentioned: mentionCount > 0 };
}

export function serverTracksReadMarker(
  state: AppState,
  serverId: string,
): boolean {
  const server = state.servers.find((s) => s.id === serverId);
  return (
    !!server?.capabilities?.includes("draft/read-marker") &&
    !!server.account &&
    !server.readMarkerRefused
  );
}

const replaceAt = <T>(list: T[], index: number, item: T): T[] =>
  list.map((existing, i) => (i === index ? item : existing));

// A detached chat keeps its newest messages in the window's present, so we
// look there too. `update` returns null to leave the message as it is.
// A redacted message keeps who removed it as a code, and the row translates it.
export const REDACTED_BY_TAG = "obby-redacted-by";

const MAX_REACTION_LENGTH = 64;

// A reaction is an emoji or a few short words that another client chose, so we
// keep only text that reads as one chip: spaces between the words, and no line
// breaks or control characters.
export const isReactionValue = (value: string): boolean =>
  value.length > 0 &&
  value.length <= MAX_REACTION_LENGTH &&
  !/^ | $|[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

// Nicks compare without case, so a reaction stays ours when only the case of
// our nick changes.
export const isReactionBy = (
  reaction: { userId: string },
  nick: string | undefined,
): boolean =>
  nick !== undefined && reaction.userId.toLowerCase() === nick.toLowerCase();

export function withReaction(
  message: Message,
  emoji: string,
  userId: string,
): Message | null {
  return !isReactionValue(emoji) ||
    message.reactions.some((r) => r.emoji === emoji && isReactionBy(r, userId))
    ? null
    : { ...message, reactions: [...message.reactions, { emoji, userId }] };
}

export function withoutReaction(
  message: Message,
  emoji: string,
  userId: string,
): Message | null {
  const reactions = message.reactions.filter(
    (r) => !(r.emoji === emoji && isReactionBy(r, userId)),
  );
  return reactions.length === message.reactions.length
    ? null
    : { ...message, reactions };
}

// A multiline message answers to its own msgid and to each of its lines' msgids.
export function hasMsgid(message: Message, msgid: string): boolean {
  return (
    message.msgid === msgid || !!message.multilineMessageIds?.includes(msgid)
  );
}

// Replayed history (server CHATHISTORY or our local replay) updates what was
// said, never live state such as typing, presence, notifications or bot runs.
export function isHistoryEvent(
  state: Pick<AppState, "activeBatches">,
  serverId: string,
  mtags: Record<string, string> | undefined,
): boolean {
  const batchId = mtags?.batch;
  return (
    !!batchId &&
    state.activeBatches[serverId]?.[batchId]?.type === "chathistory"
  );
}

export function redactedMessage(original: Message, sender: string): Message {
  return {
    id: original.id,
    msgid: original.msgid,
    content: "",
    timestamp: original.timestamp,
    userId: "system",
    channelId: original.channelId,
    serverId: original.serverId,
    type: "system",
    reactions: [],
    replyMessage: null,
    mentioned: [],
    tags: {
      ...original.tags,
      [REDACTED_BY_TAG]: original.userId === sender ? "sender" : "staff",
    },
  };
}

export function updateMessageByMsgid(
  state: Pick<AppState, "messages" | "historyWindows">,
  key: string,
  msgid: string,
  update: (message: Message) => Message | null,
): Partial<AppState> {
  const shown = state.messages[key] ?? [];
  const index = shown.findIndex((m) => hasMsgid(m, msgid));
  if (index >= 0) {
    const next = update(shown[index]);
    return next
      ? {
          messages: { ...state.messages, [key]: replaceAt(shown, index, next) },
        }
      : {};
  }
  const window = state.historyWindows[key];
  const presentIndex =
    window?.present.findIndex((m) => hasMsgid(m, msgid)) ?? -1;
  if (!window || presentIndex < 0) return {};
  const next = update(window.present[presentIndex]);
  if (!next) return {};
  return {
    historyWindows: {
      ...state.historyWindows,
      [key]: {
        ...window,
        present: replaceAt(window.present, presentIndex, next),
      },
    },
  };
}

// Older messages past the cap would push themselves straight out again, so we
// drop the newest end instead and keep it as the present of a history window.
export function capMergedMessages(
  existing: Message[],
  merged: Message[],
  window: HistoryWindow | undefined,
  place?: HistoryPagePlace,
): { messages: Message[]; window?: HistoryWindow } {
  // A page can put older lines ahead of ours inside our oldest millisecond, so we tell an older page by the line it puts first, unless it was asked as the newest page.
  const isOlder =
    place !== "newest" &&
    existing.length > 0 &&
    merged[0] !== existing[0] &&
    messageTime(merged[0]) <= messageTime(existing[0]);
  if (merged.length <= MAX_MESSAGES_PER_CHANNEL || (!isOlder && window))
    return { messages: merged };
  if (!isOlder) return { messages: merged.slice(-MAX_MESSAGES_PER_CHANNEL) };
  const kept = merged.slice(0, MAX_MESSAGES_PER_CHANNEL);
  return {
    messages: kept,
    window: {
      ...window,
      until: messageTime(kept[kept.length - 1]),
      untilRowId: undefined,
      present: window?.present ?? existing,
    },
  };
}

// ============================================================================
// Batch Event Types
// ============================================================================

export interface JoinBatchEvent {
  type: "JOIN";
  data: {
    serverId: string;
    username: string;
    channelName: string;
    account?: string; // From extended-join
    realname?: string; // From extended-join
  };
}

export interface QuitBatchEvent {
  type: "QUIT";
  data: {
    serverId: string;
    username: string;
    reason: string;
  };
}

export interface PartBatchEvent {
  type: "PART";
  data: {
    serverId: string;
    username: string;
    channelName: string;
    reason?: string;
  };
}

export type BatchEvent = JoinBatchEvent | QuitBatchEvent | PartBatchEvent;

export interface BatchInfo {
  type: string;
  parameters?: string[];
  events: BatchEvent[];
  startTime: Date;
}

// ============================================================================
// Per-Server Selection Helpers
// ============================================================================

/**
 * Get the selected channel and private chat for a specific server
 */
export function getServerSelection(
  state: Pick<AppState, "ui">,
  serverId: string,
) {
  return (
    state.ui.perServerSelections[serverId] || {
      selectedChannelId: null,
      selectedPrivateChatId: null,
    }
  );
}

/**
 * Set the selected channel and private chat for a specific server
 */
export function setServerSelection(
  state: AppState,
  serverId: string,
  selection: {
    selectedChannelId: string | null;
    selectedChannelName?: string | null;
    selectedPrivateChatId: string | null;
    selectedPrivateChatUsername?: string | null;
  },
) {
  return {
    ...state.ui.perServerSelections,
    [serverId]: selection,
  };
}

/**
 * Get the current selection for the currently selected server
 */
export function getCurrentSelection(state: AppState) {
  if (!state.ui.selectedServerId) {
    return {
      selectedChannelId: null,
      selectedPrivateChatId: null,
    };
  }
  return getServerSelection(state, state.ui.selectedServerId);
}

// A phone shows one app at a time, so a visible app there has the user's eyes,
// while a desktop window also needs focus.
export function isAppInFront(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined")
    return true;
  if (document.visibilityState !== "visible") return false;
  return (
    document.hasFocus() ||
    window.matchMedia?.("(pointer: coarse)").matches === true
  );
}

// The chat the user is looking at right now: selected, with the app in front
// and, on a phone, the chat column showing. Messages anywhere else are unread.
export function getViewedSelection(state: AppState) {
  const isInView =
    state.ui.isAppFocused !== false &&
    (!state.ui.isNarrowView || state.ui.mobileViewActiveColumn === "chatView");
  return isInView
    ? getCurrentSelection(state)
    : { selectedChannelId: null, selectedPrivateChatId: null };
}

// ============================================================================
// Server Capability Helpers (pure versions)
// ============================================================================

/**
 * Check if a server supports metadata capability
 */
export function serverSupportsMetadata(
  state: AppState,
  serverId: string,
): boolean {
  const server = state.servers.find((s) => s.id === serverId);
  const supports =
    server?.capabilities?.some(
      (cap) => cap === "draft/metadata-2" || cap.startsWith("draft/metadata"),
    ) ?? false;
  return supports;
}

export function serverSupportsChathistory(
  state: AppState,
  serverId: string,
): boolean {
  return !!state.servers
    .find((s) => s.id === serverId)
    ?.capabilities?.includes("draft/chathistory");
}

/**
 * Check if a server supports multiline capability
 */
export function serverSupportsMultiline(
  state: AppState,
  serverId: string,
): boolean {
  const server = state.servers.find((s) => s.id === serverId);
  const supports = server?.capabilities?.includes("draft/multiline") ?? false;
  return supports;
}

// ============================================================================
// User Metadata Resolution
// ============================================================================

type UserMetadata = NonNullable<User["metadata"]>;

/**
 * Resolve cached metadata for a user: localStorage wins, cross-channel is fallback.
 * Both the NAMES and live-JOIN paths use this so avatar data is available immediately.
 */
export function resolveUserMetadata(
  username: string,
  serverMetadata: Record<string, UserMetadata> | undefined,
  channels: Channel[],
  excludeChannelName?: string,
): UserMetadata {
  const lc = username.toLowerCase();
  if (serverMetadata) {
    const matchingKey = Object.keys(serverMetadata).find(
      (k) => k.toLowerCase() === lc,
    );
    if (matchingKey && Object.keys(serverMetadata[matchingKey]).length > 0) {
      return { ...serverMetadata[matchingKey] };
    }
  }
  const exclude = excludeChannelName?.toLowerCase();
  for (const ch of channels) {
    if (exclude && ch.name.toLowerCase() === exclude) continue;
    const existing = ch.users.find((u) => u.username.toLowerCase() === lc);
    if (existing?.metadata && Object.keys(existing.metadata).length > 0) {
      return { ...existing.metadata };
    }
  }
  return {};
}

// ============================================================================
// Reply Message Resolution (pure version)
// ============================================================================

/**
 * Resolve a reply message from message tags
 * @param mtags Message tags from IRC message
 * @param serverId Server ID for context
 * @param channelId Channel ID for context
 * @param messages Array of messages to search through
 * @returns The referenced message or null if not found
 */
export function resolveReplyMessage(
  mtags: Record<string, string> | undefined,
  serverId: string,
  channelId: string,
  messages: Message[],
): Message | null {
  return findReplyTarget(
    (mtags?.["+reply"] ?? mtags?.["+draft/reply"])?.trim() || null,
    messages,
  );
}

/**
 * Find the message a reply points at, for callers that already hold the id
 * rather than the tags it arrived in.
 */
export function findReplyTarget(
  replyId: string | null | undefined,
  messages: Message[],
): Message | null {
  if (!replyId) {
    return null;
  }

  return (
    messages.find(
      (message) =>
        message.msgid === replyId ||
        message.multilineMessageIds?.includes(replyId),
    ) ?? null
  );
}
