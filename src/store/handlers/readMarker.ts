import type { StoreApi } from "zustand";
import ircClient from "../../lib/ircClient";
import { isSilenced } from "../../lib/mutes";
import { closeChatNotification } from "../../lib/notifications";
import type { Channel, PrivateChat, Server } from "../../types";
import {
  countUnread,
  getViewedSelection,
  newestMessageTime,
  serverTracksReadMarker,
  type UnreadCounts,
} from "../helpers";
import type { AppState } from "../index";
import { markMentionsSeen } from "../mentionLog";
import { findConversation } from "./history";

// We wait for a burst of messages to settle before telling the server, so a
// busy channel costs one MARKREAD a second at most.
const MARK_READ_DELAY_MS = 1000;

// We learn which capabilities a server has only once it welcomes us, so we
// start local markers from then on.
const registeredAt = new Map<string, string>();

// We keep each chat's newest read until the server names it or a later one.
const unsentMarkers = new Map<string, string>();
// We send a waiting marker once per connection, whatever the server answers.
const resentMarkers = new Map<string, Set<string>>();

const NOTHING_UNREAD: UnreadCounts = {
  unreadCount: 0,
  mentionCount: 0,
  isMentioned: false,
};

type Chat = Channel | PrivateChat;

const eqIC = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const chatKey = (serverId: string, chat: Chat) => `${serverId}-${chat.id}`;
const targetOf = (chat: Chat) => ("name" in chat ? chat.name : chat.username);

// An undefined marker is one we have not heard yet, and `*` (null) on a
// private chat means the user has read none of it.
function readUpTo(chat: Chat): number | undefined {
  if (chat.readMarker === undefined) return undefined;
  return chat.readMarker === null
    ? Number.NEGATIVE_INFINITY
    : Date.parse(chat.readMarker);
}

function mapChats(
  servers: Server[],
  serverId: string,
  update: <T extends Chat>(chat: T, isPrivate: boolean) => T,
): Server[] {
  const updated = servers.map((server) => {
    if (server.id !== serverId) return server;
    const channels = server.channels.map((c) => update(c, false));
    const privateChats = server.privateChats?.map((pc) => update(pc, true));
    const isSame =
      channels.every((c, i) => c === server.channels[i]) &&
      (privateChats ?? []).every((pc, i) => pc === server.privateChats?.[i]);
    return isSame ? server : { ...server, channels, privateChats };
  });
  return updated.every((server, i) => server === servers[i])
    ? servers
    : updated;
}

function setReadMarker(
  store: StoreApi<AppState>,
  serverId: string,
  chatId: string,
  readMarker: string,
) {
  store.setState((state) => ({
    servers: mapChats(state.servers, serverId, (chat) =>
      chat.id === chatId && chat.readMarker !== readMarker
        ? { ...chat, readMarker }
        : chat,
    ),
  }));
}

function findChat(state: AppState, serverId: string, chatId: string) {
  const server = state.servers.find((s) => s.id === serverId);
  return (
    server?.channels.find((c) => c.id === chatId) ??
    server?.privateChats?.find((pc) => pc.id === chatId)
  );
}

const isRegistered = (state: AppState, serverId: string) =>
  !!state.servers.find((s) => s.id === serverId)?.isRegistered;

// On a server without read markers we keep the marker for this session only.
export function markChatRead(
  store: StoreApi<AppState>,
  serverId: string,
  chatId: string,
): void {
  const state = store.getState();
  const chat = findChat(state, serverId, chatId);
  if (!chat) return;
  const tracks = serverTracksReadMarker(state, serverId);
  // Until the server tells us the stored marker, ours could only replace it.
  if (tracks && chat.readMarker === undefined) return;
  const newest = newestMessageTime(state, chatKey(serverId, chat));
  if (newest === undefined) return;
  if ((readUpTo(chat) ?? Number.NEGATIVE_INFINITY) >= newest) return;
  const marker = new Date(newest).toISOString();
  setReadMarker(store, serverId, chatId, marker);
  closeChatNotification(serverId, targetOf(chat));
  if (!tracks) return;
  const key = chatKey(serverId, chat);
  unsentMarkers.set(key, marker);
  if (!isRegistered(state, serverId)) return;
  resentMarkers.set(
    serverId,
    (resentMarkers.get(serverId) ?? new Set<string>()).add(key),
  );
  ircClient.markreadSet(serverId, targetOf(chat), marker);
}

// Every chat with unread lines, on every server: the "Read all" button.
export function markAllChatsRead(store: StoreApi<AppState>): void {
  for (const server of store.getState().servers) {
    for (const chat of [...server.channels, ...(server.privateChats ?? [])]) {
      if (chat.unreadCount > 0 || chat.isMentioned)
        markChatRead(store, server.id, chat.id);
    }
  }
}

function viewedChat(state: AppState) {
  const serverId = state.ui.selectedServerId;
  if (!serverId) return undefined;
  const { selectedChannelId, selectedPrivateChatId } =
    getViewedSelection(state);
  const chatId = selectedChannelId ?? selectedPrivateChatId;
  const chat = chatId ? findChat(state, serverId, chatId) : undefined;
  return chat ? { serverId, chat, key: chatKey(serverId, chat) } : undefined;
}

function sameCounts(chat: Chat, counts: UnreadCounts) {
  return (
    chat.unreadCount === counts.unreadCount &&
    (chat.mentionCount ?? 0) === counts.mentionCount &&
    !!chat.isMentioned === counts.isMentioned
  );
}

const chatInView = (state: AppState) =>
  state.ui.isChatAwayFromPresent ? undefined : viewedChat(state)?.key;

// Unread counts follow from the marker and the messages we hold, so we work
// them out again whenever either changes. The chat the user watches at the
// bottom stays read while its marker waits to go out.
function withUnreadCounts(
  state: AppState,
  previous: AppState,
): Server[] | undefined {
  const inView = chatInView(state);
  const wasInView = chatInView(previous);
  if (
    state.servers === previous.servers &&
    state.messages === previous.messages &&
    state.historyWindows === previous.historyWindows &&
    inView === wasInView
  )
    return undefined;
  let servers = state.servers;
  for (const server of state.servers) {
    const before = previous.servers.find((s) => s.id === server.id);
    servers = mapChats(servers, server.id, (chat, isPrivate) => {
      const key = chatKey(server.id, chat);
      const old = isPrivate
        ? before?.privateChats?.find((pc) => pc.id === chat.id)
        : before?.channels.find((c) => c.id === chat.id);
      if (
        old?.readMarker === chat.readMarker &&
        state.messages[key] === previous.messages[key] &&
        state.historyWindows[key] === previous.historyWindows[key] &&
        (key === inView) === (key === wasInView)
      )
        return chat;
      const after = key === inView ? undefined : readUpTo(chat);
      const messages = [
        ...(state.messages[key] ?? []),
        ...(state.historyWindows[key]?.present ?? []),
      ];
      const counts =
        after === undefined || messages.length === 0
          ? NOTHING_UNREAD
          : countUnread(
              messages,
              after,
              ircClient.getNick(server.id),
              isPrivate,
            );
      // A muted chat or server keeps its unread count but raises no mention.
      const silenced =
        counts.isMentioned && isSilenced(server.id, chat.id, true);
      const shown = silenced
        ? { ...counts, mentionCount: 0, isMentioned: false }
        : counts;
      return sameCounts(chat, shown) ? chat : { ...chat, ...shown };
    });
  }
  return servers === state.servers ? undefined : servers;
}

// A server without read markers gives us none to start from, so we count what
// arrived since it welcomed us. A private chat's marker comes only when asked,
// so we ask once per chat on each connection.
function startMissingMarkers(store: StoreApi<AppState>) {
  for (const server of store.getState().servers) {
    const since = registeredAt.get(server.id);
    if (!since) continue;
    if (serverTracksReadMarker(store.getState(), server.id)) {
      askPrivateMarkers(store, server.id);
      continue;
    }
    for (const { id } of [...server.channels, ...(server.privateChats ?? [])]) {
      const chat = findChat(store.getState(), server.id, id);
      if (chat && chat.readMarker == null)
        setReadMarker(store, server.id, chat.id, since);
    }
  }
}

// We flag every chat in one update, since each update runs the subscriber.
function askPrivateMarkers(store: StoreApi<AppState>, serverId: string) {
  const server = store.getState().servers.find((s) => s.id === serverId);
  const pending = (server?.privateChats ?? []).filter(
    (pc) => !pc.readMarkerFetched,
  );
  if (pending.length === 0) return;
  store.setState((state) => ({
    servers: mapChats(state.servers, serverId, (chat) =>
      "username" in chat && !chat.readMarkerFetched
        ? { ...chat, readMarkerFetched: true }
        : chat,
    ),
  }));
  for (const pc of pending) ircClient.markreadGet(serverId, pc.username);
}

// A bouncer keeps channel markers itself, so we ask once it welcomes us.
function askWaitingChannelMarkers(store: StoreApi<AppState>, serverId: string) {
  const state = store.getState();
  const server = state.servers.find((s) => s.id === serverId);
  if (!server?.bouncerServerId || !serverTracksReadMarker(state, serverId))
    return;
  for (const channel of server.channels)
    if (unsentMarkers.has(chatKey(serverId, channel)))
      ircClient.markreadGet(serverId, channel.name);
}

const READ = { unreadCount: 0, mentionCount: 0, isMentioned: false };

const OPENS_MULTILINE = /^(?:@\S+ )?BATCH \+(\S+) draft\/multiline (\S+)/;
const CLOSES_BATCH = /^BATCH -(\S+)/;
const IS_BATCHED = /^@(?:[^ ]*;)?batch=/;
const SENDS_MESSAGE = /^(?:@\S+ )?PRIVMSG (\S+) :/;
const openMultilineTargets = new Map<string, string>();

// A server refuses every other command inside an open multiline batch, so a batch names its chat once it has closed.
function sentMessageTarget(serverId: string, line: string): string | undefined {
  const opened = OPENS_MULTILINE.exec(line);
  if (opened) {
    openMultilineTargets.set(`${serverId} ${opened[1]}`, opened[2]);
    return undefined;
  }
  const closed = CLOSES_BATCH.exec(line);
  if (closed) {
    const batch = `${serverId} ${closed[1]}`;
    const target = openMultilineTargets.get(batch);
    openMultilineTargets.delete(batch);
    return target;
  }
  if (IS_BATCHED.test(line)) return undefined;
  return SENDS_MESSAGE.exec(line)?.[1];
}

export function registerReadMarkerHandlers(store: StoreApi<AppState>): void {
  ircClient.on("MARKREAD", ({ serverId, target, timestamp }) => {
    let toSend: string | undefined;
    store.setState((state) => ({
      servers: mapChats(state.servers, serverId, (chat, isPrivate) => {
        if (!eqIC(targetOf(chat), target)) return chat;
        const key = chatKey(serverId, chat);
        const unsent = unsentMarkers.get(key);
        // An older answer left before ours arrived, so the chat stays read.
        const isWaiting =
          unsent !== undefined &&
          (timestamp === null || Date.parse(unsent) > Date.parse(timestamp));
        if (!isWaiting) unsentMarkers.delete(key);
        const resent = resentMarkers.get(serverId) ?? new Set<string>();
        if (isWaiting && !resent.has(key)) {
          resentMarkers.set(serverId, resent.add(key));
          toSend = unsent;
        }
        if (!isPrivate) {
          // A channel the user never read has no marker on the server, so we
          // count what arrives from now on, leave its backlog read and store
          // that start on the server, so the next session counts from there.
          const readMarker = isWaiting
            ? unsent
            : (timestamp ?? chat.readMarker ?? new Date().toISOString());
          if (timestamp === null && !isWaiting) toSend = readMarker;
          return chat.readMarker === readMarker
            ? chat
            : { ...chat, readMarker };
        }
        const readMarker = isWaiting ? unsent : timestamp;
        return chat.readMarker === readMarker &&
          "username" in chat &&
          chat.readMarkerFetched
          ? chat
          : { ...chat, readMarker, readMarkerFetched: true };
      }),
    }));
    const state = store.getState();
    if (toSend && serverTracksReadMarker(state, serverId))
      ircClient.markreadSet(serverId, target, toSend);
    const server = state.servers.find((s) => s.id === serverId);
    const chat = [
      ...(server?.channels ?? []),
      ...(server?.privateChats ?? []),
    ].find((c) => eqIC(targetOf(c), target));
    // Only a read marker clears a notification, and only once the messages it
    // covers are here, since history after a launch arrives after the marker.
    const isRead =
      timestamp !== null &&
      !!chat &&
      chat.unreadCount === 0 &&
      newestMessageTime(state, chatKey(serverId, chat)) !== undefined;
    if (isRead) closeChatNotification(serverId, target);
    // Reading a channel on another device moves the marker here too, and a
    // mention under the marker has been seen wherever it was read. The inbox
    // keeps mentions of channels we have since left, so we go by name.
    if (timestamp !== null && ircClient.isChannel(serverId, target)) {
      const readAt = Date.parse(timestamp);
      store.setState((current) => ({
        mentionLog: markMentionsSeen(
          current.mentionLog,
          (m) =>
            m.serverId === serverId &&
            eqIC(m.channelName, target) &&
            Date.parse(m.timestamp) <= readAt,
        ),
      }));
    }
  });

  // Our copy can be stale after a drop or a logout, so we ask for each again.
  const askPrivateMarkersAgain = (serverId: string) =>
    store.setState((state) => ({
      servers: mapChats(state.servers, serverId, (chat) =>
        "username" in chat && chat.readMarkerFetched
          ? { ...chat, readMarkerFetched: false }
          : chat,
      ),
    }));
  ircClient.on("LOGGED_OUT", ({ serverId }) =>
    askPrivateMarkersAgain(serverId),
  );

  const setRefused = (serverId: string, readMarkerRefused: boolean) =>
    store.setState((state) => ({
      servers: state.servers.map((server) =>
        server.id === serverId &&
        !!server.readMarkerRefused !== readMarkerRefused
          ? { ...server, readMarkerRefused }
          : server,
      ),
    }));
  // A server can refuse markers, e.g. without an account, so we stop asking on
  // that connection after its first FAIL.
  ircClient.on("MARKREAD_FAIL", ({ serverId }) => setRefused(serverId, true));
  ircClient.on("connectionStateChange", ({ serverId, connectionState }) => {
    if (connectionState === "connected") return setRefused(serverId, false);
    registeredAt.delete(serverId);
    resentMarkers.delete(serverId);
    for (const batch of openMultilineTargets.keys())
      if (batch.startsWith(`${serverId} `)) openMultilineTargets.delete(batch);
    askPrivateMarkersAgain(serverId);
  });
  // We take the time from the server's welcome when it sends one, so a local
  // clock ahead of the server cannot hide the first messages.
  ircClient.on("parsedLine", ({ serverId, command, mtags }) => {
    if (command !== "001") return;
    registeredAt.set(serverId, mtags?.time ?? new Date().toISOString());
    startMissingMarkers(store);
    askWaitingChannelMarkers(store, serverId);
  });
  // Markers need an account, so a login after the welcome is when we first
  // learn where the user left off.
  ircClient.on("LOGGED_IN", ({ serverId }) => {
    const state = store.getState();
    const server = state.servers.find((s) => s.id === serverId);
    if (!server || !registeredAt.has(serverId)) return;
    if (!serverTracksReadMarker(state, serverId)) return;
    for (const channel of server.channels)
      ircClient.markreadGet(serverId, channel.name);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  // We tell the server how far the user has read whenever they look at a
  // chat, which clears the unread state on their other clients.
  const markViewedChatRead = () => {
    const state = store.getState();
    const viewed = viewedChat(state);
    if (viewed && !state.ui.isChatAwayFromPresent)
      markChatRead(store, viewed.serverId, viewed.chat.id);
  };
  const scheduleMarkRead = () => {
    clearTimeout(timer);
    timer = setTimeout(markViewedChatRead, MARK_READ_DELAY_MS);
  };

  store.subscribe((state, previous) => {
    const servers = withUnreadCounts(state, previous);
    if (servers) store.setState({ servers });
    startMissingMarkers(store);
    const viewed = viewedChat(state);
    const wasViewed = viewedChat(previous);
    // The user saw the chat they are leaving up to where they were, so we
    // mark it now; a pending timer would mark the next chat instead.
    if (
      wasViewed &&
      wasViewed.key !== viewed?.key &&
      !previous.ui.isChatAwayFromPresent
    )
      markChatRead(store, wasViewed.serverId, wasViewed.chat.id);
    if (!viewed) return;
    if (
      wasViewed?.key !== viewed.key ||
      wasViewed?.chat.readMarker !== viewed.chat.readMarker ||
      state.ui.isChatAwayFromPresent !== previous.ui.isChatAwayFromPresent ||
      state.messages[viewed.key] !== previous.messages[viewed.key] ||
      state.historyWindows[viewed.key] !== previous.historyWindows[viewed.key]
    )
      scheduleMarkRead();
  });

  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", scheduleMarkRead);

  // Sending a message means the user has read the chat, so we mark it read
  // at once, even when they switch away or scroll up right after.
  // A line that waited leaves long after the user sent it, when they may be reading elsewhere, so it marks nothing.
  ircClient.on("rawLine", ({ serverId, direction, line, afterWaiting }) => {
    if (direction !== "tx") return;
    const target = sentMessageTarget(serverId, line);
    if (afterWaiting) return;
    const chat = target && findConversation(store, serverId, target);
    if (chat) markChatRead(store, serverId, chat.channelId);
  });
  // The user has read the chat when they send, also when the line has to wait before it leaves.
  ircClient.on("lineQueued", ({ serverId, line }) => {
    const target = sentMessageTarget(serverId, line);
    const chat = target && findConversation(store, serverId, target);
    if (chat) markChatRead(store, serverId, chat.channelId);
  });
}
