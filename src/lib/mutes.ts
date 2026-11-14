import { useSyncExternalStore } from "react";
import { generateDeterministicId } from "../store/helpers";

// Muting, kept in this browser. A muted server or chat is silent: no sound,
// no notification and no red dot from anything in it, mentions included; a
// mention from a muted channel is kept in the inbox, already seen. Mutes
// either last until a given time or until the user unmutes.

export type ChatKind = "channel" | "dm";

/** A chat as a mute sees it: its kind and its name, in any spelling. */
export interface ChatRef {
  id?: string;
  kind: ChatKind;
  name: string;
}

interface MuteEntry {
  // epoch ms when the mute ends; null = until unmuted
  until: number | null;
}

interface ChatMuteEntry extends MuteEntry {
  kind: ChatKind;
  // The chat's name as last seen, for the background side. An entry without
  // one sits under its chat id, waiting for that chat to be loaded.
  name?: string;
  // Older mutes carried a flag for mentions; every mute covers them now.
  mentions?: boolean;
}

interface MuteState {
  servers: Record<string, MuteEntry>;
  // keyed by `${serverId}/${kind}:${name}` with the name in lower case. A
  // chat id is made from the name as first seen, so the same conversation
  // gets another id when it comes back under another spelling, while its
  // name still compares equal.
  chats: Record<string, ChatMuteEntry>;
}

interface LoadedServer {
  id: string;
  channels: { id: string; name: string }[];
  privateChats?: { id: string; username: string }[];
}

const STORAGE_KEY = "obby.mutes";

let state: MuteState = { servers: {}, chats: {} };
let loaded = false;
const listeners = new Set<() => void>();

// We name a chat id through the servers the app has loaded. The store hands
// them in, since it imports this module.
let loadedServers: () => LoadedServer[] = () => [];

export function setMuteChatSource(source: () => LoadedServer[]): void {
  loadedServers = source;
}

function nameKey(serverId: string, chat: ChatRef): string {
  return `${serverId}/${chat.kind}:${chat.name.toLowerCase()}`;
}

function idKey(serverId: string, chatId: string): string {
  return `${serverId}/${chatId}`;
}

function chatsOf(server: LoadedServer): (ChatRef & { id: string })[] {
  return [
    ...server.channels.map(({ id, name }) => ({
      id,
      kind: "channel" as const,
      name,
    })),
    ...(server.privateChats ?? []).map(({ id, username }) => ({
      id,
      kind: "dm" as const,
      name: username,
    })),
  ];
}

// The keys a chat's mute can sit under: its name, and its id for an entry
// that has no name yet.
function keysOf(serverId: string, chat: string | ChatRef): string[] {
  const id = typeof chat === "string" ? chat : chat.id;
  const server =
    typeof chat === "string"
      ? loadedServers().find((s) => s.id === serverId)
      : undefined;
  const ref =
    typeof chat === "string"
      ? server && chatsOf(server).find((c) => c.id === chat)
      : chat;
  return [
    ...(ref ? [nameKey(serverId, ref)] : []),
    ...(id ? [idKey(serverId, id)] : []),
  ];
}

function without<T>(map: Record<string, T>, keys: string[]): Record<string, T> {
  return Object.fromEntries(
    Object.entries(map).filter(([key]) => !keys.includes(key)),
  );
}

function active(entry: MuteEntry | undefined, now: number): boolean {
  return !!entry && (entry.until === null || entry.until > now);
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MuteState>;
      state = { servers: parsed.servers ?? {}, chats: parsed.chats ?? {} };
    }
  } catch {
    state = { servers: {}, chats: {} };
  }
}

function save(next: MuteState): void {
  const now = Date.now();
  // drop expired mutes so storage doesn't grow forever
  const prune = <T extends MuteEntry>(map: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(map).filter(([, entry]) => active(entry, now)),
    );
  state = { servers: prune(next.servers), chats: prune(next.chats) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage disabled: the mute still applies for this session
  }
  for (const l of listeners) l();
}

/** `until`: epoch ms, or null for "until I unmute". */
export function muteServer(serverId: string, until: number | null): void {
  load();
  save({ ...state, servers: { ...state.servers, [serverId]: { until } } });
}

export function unmuteServer(serverId: string): void {
  load();
  const { [serverId]: _, ...servers } = state.servers;
  save({ ...state, servers });
}

export function muteChat(
  serverId: string,
  chat: ChatRef,
  until: number | null,
): void {
  load();
  save({
    ...state,
    chats: {
      ...without(state.chats, keysOf(serverId, chat)),
      [nameKey(serverId, chat)]: { until, kind: chat.kind, name: chat.name },
    },
  });
}

/** `chat`: the chat itself, or the id of one that is loaded. */
export function unmuteChat(serverId: string, chat: string | ChatRef): void {
  load();
  save({ ...state, chats: without(state.chats, keysOf(serverId, chat)) });
}

// We move a mute along with a nick change, so the person stays muted under
// the new nick.
export function moveChatMute(
  serverId: string,
  kind: ChatKind,
  oldName: string,
  newName: string,
): void {
  load();
  const from = nameKey(serverId, { kind, name: oldName });
  const entry = state.chats[from];
  if (!entry) return;
  save({
    ...state,
    chats: {
      ...without(state.chats, [from]),
      [nameKey(serverId, { kind, name: newName })]: { ...entry, name: newName },
    },
  });
}

// We move an entry under a chat id to the chat's name as soon as that chat
// is loaded. The id may be the one the chat gets under the lower-case
// spelling of its name, so we look for that one too.
export function adoptIdKeyedMutes(): void {
  load();
  const unnamed = Object.entries(state.chats)
    .filter(([, entry]) => entry.name === undefined)
    .map(([key]) => key);
  if (unnamed.length === 0) return;
  let chats = state.chats;
  for (const server of loadedServers()) {
    if (!unnamed.some((key) => key.startsWith(`${server.id}/`))) continue;
    for (const chat of chatsOf(server)) {
      const ids = [
        chat.id,
        generateDeterministicId(server.id, chat.name),
        generateDeterministicId(server.id, chat.name.toLowerCase()),
      ];
      for (const key of ids.map((id) => idKey(server.id, id))) {
        const entry = chats[key];
        if (!entry || entry.name !== undefined) continue;
        const named = nameKey(server.id, chat);
        chats = {
          [named]: { ...entry, kind: chat.kind, name: chat.name },
          ...without(chats, [key]),
        };
      }
    }
  }
  if (chats !== state.chats) save({ ...state, chats });
}

/** The mute on a server, if active: `until` is epoch ms or null (forever). */
export function serverMute(
  serverId: string,
  now: number = Date.now(),
): MuteEntry | undefined {
  load();
  const entry = state.servers[serverId];
  return active(entry, now) ? entry : undefined;
}

/** `chat`: the chat itself, or the id of one that is loaded. */
export function chatMute(
  serverId: string,
  chat: string | ChatRef,
  now: number = Date.now(),
): ChatMuteEntry | undefined {
  load();
  return keysOf(serverId, chat)
    .map((key) => state.chats[key])
    .find((entry) => active(entry, now));
}

export function isServerMuted(serverId: string, now?: number): boolean {
  return !!serverMute(serverId, now);
}

/**
 * Whether a notification (sound, desktop notification, red dot) for a
 * message in this chat should be suppressed. A mention changes nothing: a
 * mute is a mute.
 */
export function isSilenced(
  serverId: string | undefined,
  chat: string | ChatRef | undefined,
  _mentionsMe: boolean,
  now: number = Date.now(),
): boolean {
  if (!serverId) return false;
  if (isServerMuted(serverId, now)) return true;
  if (!chat) return false;
  return !!chatMute(serverId, chat, now);
}

export function subscribeMutes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A chat, by name, whose notifications are off until `until` (null: until unmuted);
 *  the name `*` stands for the whole server. */
export interface Silence {
  chat: string;
  until: number | null;
}

// The native side and the push worker notify while the page is closed, so
// they get the mutes as chat names, since ids mean nothing to them. They get
// every mute, since they also notify for chats the page has not loaded.
export function silencesFor(
  server: {
    id: string;
    channels: { id: string; name: string }[];
    privateChats: { id: string; username: string }[];
  },
  now: number = Date.now(),
): Silence[] {
  load();
  const silences: Silence[] = [];
  const whole = serverMute(server.id, now);
  if (whole) silences.push({ chat: "*", until: whole.until });
  const nameOf = new Map<string, string>();
  for (const channel of server.channels) nameOf.set(channel.id, channel.name);
  for (const chat of server.privateChats) nameOf.set(chat.id, chat.username);
  const prefix = `${server.id}/`;
  for (const [key, entry] of Object.entries(state.chats)) {
    if (!key.startsWith(prefix) || !active(entry, now)) continue;
    const name = entry.name ?? nameOf.get(key.slice(prefix.length));
    if (name) silences.push({ chat: name, until: entry.until });
  }
  return silences;
}

/** When the earliest timed mute runs out, so a view can refresh then. */
export function nextMuteExpiry(now: number = Date.now()): number | undefined {
  load();
  let next: number | undefined;
  for (const entry of [
    ...Object.values(state.servers),
    ...Object.values(state.chats),
  ]) {
    if (!active(entry, now) || entry.until === null) continue;
    if (next === undefined || entry.until < next) next = entry.until;
  }
  return next;
}

function snapshot(): MuteState {
  load();
  return state;
}

/** Re-renders when mutes change (expiry is checked by the reader). */
export function useMutes(): MuteState {
  return useSyncExternalStore(subscribeMutes, snapshot);
}

// test hook
export function resetMutesForTests(): void {
  state = { servers: {}, chats: {} };
  loaded = false;
}
