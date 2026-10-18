import { useSyncExternalStore } from "react";

// Muting, kept in this browser. A muted server is silent: no sound, no
// desktop notification and no red dot from anything in it. A muted chat is
// silent too, except that a message mentioning us in a muted *channel* still
// notifies unless the mute was made with `mentions` (a muted DM never does).
// Mutes either last until a given time or until the user unmutes.

export type ChatKind = "channel" | "dm";

interface MuteEntry {
  // epoch ms when the mute ends; null = until unmuted
  until: number | null;
}

interface ChatMuteEntry extends MuteEntry {
  kind: ChatKind;
  // channel only: true also silences messages that mention us
  mentions?: boolean;
}

interface MuteState {
  servers: Record<string, MuteEntry>;
  // keyed by `${serverId}/${chatId}`; channel and PM ids are deterministic
  // (serverId + name), so keys stay valid across reloads
  chats: Record<string, ChatMuteEntry>;
}

const STORAGE_KEY = "obby.mutes";

let state: MuteState = { servers: {}, chats: {} };
let loaded = false;
const listeners = new Set<() => void>();

function chatKey(serverId: string, chatId: string): string {
  return `${serverId}/${chatId}`;
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
  chatId: string,
  kind: ChatKind,
  until: number | null,
  mentions = false,
): void {
  load();
  save({
    ...state,
    chats: {
      ...state.chats,
      [chatKey(serverId, chatId)]: { until, kind, mentions },
    },
  });
}

/** Change whether an active channel mute also silences mentions. */
export function setChatMuteMentions(
  serverId: string,
  chatId: string,
  mentions: boolean,
): void {
  const entry = chatMute(serverId, chatId);
  if (!entry) return;
  save({
    ...state,
    chats: {
      ...state.chats,
      [chatKey(serverId, chatId)]: { ...entry, mentions },
    },
  });
}

export function unmuteChat(serverId: string, chatId: string): void {
  load();
  const { [chatKey(serverId, chatId)]: _, ...chats } = state.chats;
  save({ ...state, chats });
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

export function chatMute(
  serverId: string,
  chatId: string,
  now: number = Date.now(),
): ChatMuteEntry | undefined {
  load();
  const entry = state.chats[chatKey(serverId, chatId)];
  return active(entry, now) ? entry : undefined;
}

export function isServerMuted(serverId: string, now?: number): boolean {
  return !!serverMute(serverId, now);
}

/**
 * Whether a notification (sound, desktop notification, red dot) for a
 * message in this chat should be suppressed.
 */
export function isSilenced(
  serverId: string | undefined,
  chatId: string | undefined,
  mentionsMe: boolean,
  now: number = Date.now(),
): boolean {
  if (!serverId) return false;
  if (isServerMuted(serverId, now)) return true;
  if (!chatId) return false;
  const mute = chatMute(serverId, chatId, now);
  if (!mute) return false;
  return mute.kind === "dm" || !mentionsMe || !!mute.mentions;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): MuteState {
  load();
  return state;
}

/** Re-renders when mutes change (expiry is checked by the reader). */
export function useMutes(): MuteState {
  return useSyncExternalStore(subscribe, snapshot);
}

// test hook
export function resetMutesForTests(): void {
  state = { servers: {}, chats: {} };
  loaded = false;
}
