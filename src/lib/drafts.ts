import { useSyncExternalStore } from "react";
import * as storage from "../store/localStorage";
import type { SavedDrafts } from "../store/types";

// Unsent message text, kept per chat. Every draft lives in memory for the
// session; the ones that may sit in plain text on this device are also
// written to local storage, so a reload or a restart brings them back. A chat
// is its saved server plus its name in lower case, since a chat id is made
// from the name as first seen.

export const DRAFT_SAVE_DELAY_MS = 500;
export const DRAFT_MAX_LENGTH = 10_000;
export const DRAFT_MAX_COUNT = 50;
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DraftEntry {
  text: string;
  // epoch ms of the last edit
  at: number;
}

/** Whether a chat's text may sit on disk. The name arrives in lower case. */
export type DraftGate = (
  serverId: string,
  name: string,
  text: string,
) => boolean;

type DraftMap = Map<string, Map<string, DraftEntry>>;
/** Per server and chat: the entry to store, or null to remove the stored one. */
export type DraftChanges = Map<string, Map<string, DraftEntry | null>>;

// Chat names come from the network, so we hold them in maps and build the
// stored object from entries: a nick may be spelled like an object property.
function toMap(saved: SavedDrafts): DraftMap {
  return new Map(
    Object.entries(saved).map(([serverId, chats]) => [
      serverId,
      new Map(Object.entries(chats)),
    ]),
  );
}

function toSaved(drafts: DraftMap): SavedDrafts {
  return Object.fromEntries(
    [...drafts]
      .filter(([, chats]) => chats.size > 0)
      .map(([serverId, chats]) => [serverId, Object.fromEntries(chats)]),
  );
}

function isSame(a: DraftMap, b: DraftMap): boolean {
  const count = (drafts: DraftMap) =>
    [...drafts.values()].reduce((sum, chats) => sum + chats.size, 0);
  if (count(a) !== count(b)) return false;
  for (const [serverId, chats] of a)
    for (const [name, entry] of chats) {
      const other = b.get(serverId)?.get(name);
      if (other?.text !== entry.text || other.at !== entry.at) return false;
    }
  return true;
}

function filterDrafts(
  drafts: DraftMap,
  keep: (serverId: string, name: string, entry: DraftEntry) => boolean,
): DraftMap {
  return new Map(
    [...drafts].map(([serverId, chats]) => [
      serverId,
      new Map([...chats].filter(([name, e]) => keep(serverId, name, e))),
    ]),
  );
}

// Every command stays off disk: a list of the ones that carry a password
// would miss a channel key or a bot's own login.
export function isStorableDraftText(text: string): boolean {
  return (
    text.trim() !== "" &&
    text.length <= DRAFT_MAX_LENGTH &&
    !text.trimStart().startsWith("/")
  );
}

/** The stored drafts worth loading: `serverIds` null keeps every server. */
export function pruneDrafts(
  saved: SavedDrafts,
  serverIds: ReadonlySet<string> | null,
  now: number,
): SavedDrafts {
  return toSaved(
    filterDrafts(
      toMap(saved),
      (serverId, _name, entry) =>
        (serverIds === null || serverIds.has(serverId)) &&
        now - entry.at <= DRAFT_MAX_AGE_MS &&
        isStorableDraftText(entry.text),
    ),
  );
}

/** What storage holds after our changes: nothing a rule refuses, and the newest drafts when there are too many. */
export function mergeDrafts(
  saved: SavedDrafts,
  changes: DraftChanges,
  mayStore: DraftGate,
): SavedDrafts {
  const merged = toMap(saved);
  for (const [serverId, chats] of changes) {
    const target = merged.get(serverId) ?? new Map<string, DraftEntry>();
    merged.set(serverId, target);
    for (const [name, entry] of chats) {
      if (entry) target.set(name, entry);
      else target.delete(name);
    }
  }
  const allowed = filterDrafts(
    merged,
    (serverId, name, entry) =>
      isStorableDraftText(entry.text) && mayStore(serverId, name, entry.text),
  );
  const newest = new Set(
    [...allowed.values()]
      .flatMap((chats) => [...chats.values()])
      .sort((a, b) => b.at - a.at)
      .slice(0, DRAFT_MAX_COUNT),
  );
  return toSaved(filterDrafts(allowed, (_s, _n, entry) => newest.has(entry)));
}

let memory: DraftMap = new Map();
// The chats edited since our last write, each with whether its text was
// allowed on disk at that edit. Text typed while its chat was refused stays
// in memory even when the chat is allowed again before the write.
const changed = new Map<string, Map<string, boolean>>();
// Nothing is read or written until the app hands us its rules.
let gate: DraftGate | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function stopTimer(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

function markChanged(serverId: string, name: string, mayWrite: boolean): void {
  const marks = changed.get(serverId) ?? new Map<string, boolean>();
  changed.set(serverId, marks);
  marks.set(name, mayWrite);
}

/** Loads the stored drafts that are still wanted and allowed, and removes the rest from storage. */
export function startDrafts(mayStore: DraftGate, now: number = Date.now()) {
  gate = mayStore;
  stopTimer();
  changed.clear();
  const saved = storage.drafts.load();
  let serverIds: Set<string> | null;
  try {
    serverIds = new Set(storage.servers.load().map((server) => server.id));
  } catch {
    serverIds = null;
  }
  const kept = mergeDrafts(
    pruneDrafts(saved, serverIds, now),
    new Map(),
    mayStore,
  );
  memory = toMap(kept);
  if (!isSame(memory, toMap(saved))) storage.drafts.save(kept);
  notify();
}

export function getDraft(serverId: string, name: string): string {
  return memory.get(serverId)?.get(name.toLowerCase())?.text ?? "";
}

export function setDraft(
  serverId: string,
  name: string,
  text: string,
  now: number = Date.now(),
): void {
  const key = name.toLowerCase();
  const held = memory.get(serverId)?.get(key);
  if (text.trim() === "") {
    if (!held) return;
    memory.get(serverId)?.delete(key);
    markChanged(serverId, key, false);
    // A sent or emptied draft leaves storage in the same step, so a reload right after never brings it back.
    flushDrafts();
    notify();
    return;
  }
  if (held?.text === text) return;
  const chats = memory.get(serverId) ?? new Map<string, DraftEntry>();
  memory.set(serverId, chats);
  chats.set(key, { text, at: now });
  markChanged(
    serverId,
    key,
    isStorableDraftText(text) && (gate?.(serverId, key, text) ?? false),
  );
  stopTimer();
  timer = setTimeout(flushDrafts, DRAFT_SAVE_DELAY_MS);
  if (!held) notify();
}

/** Writes the chats we edited into what storage holds now, so another tab's drafts stay. */
export function flushDrafts(): void {
  stopTimer();
  if (!gate) return;
  const saved = storage.drafts.load();
  const changes: DraftChanges = new Map(
    [...changed].map(([serverId, marks]) => [
      serverId,
      new Map(
        [...marks].map(([name, mayWrite]) => [
          name,
          (mayWrite && memory.get(serverId)?.get(name)) || null,
        ]),
      ),
    ]),
  );
  const next = mergeDrafts(saved, changes, gate);
  if (isSame(toMap(next), toMap(saved)) || storage.drafts.save(next))
    changed.clear();
}

// A draft follows its chat through a nick change or a channel rename and
// replaces a draft under the new name. The stored entry is only renamed, so
// text that was kept off disk under the old name stays off disk.
export function moveDraft(
  serverId: string,
  oldName: string,
  newName: string,
): void {
  const from = oldName.toLowerCase();
  const to = newName.toLowerCase();
  const chats = memory.get(serverId);
  const entry = chats?.get(from);
  if (from === to || !chats || !entry) return;
  flushDrafts();
  chats.delete(from);
  chats.set(to, entry);
  changed.get(serverId)?.delete(to);
  const saved = toMap(storage.drafts.load());
  const stored = saved.get(serverId);
  const moved = stored?.get(from);
  if (stored && (moved || stored.has(to))) {
    stored.delete(from);
    if (moved && gate?.(serverId, to, moved.text)) stored.set(to, moved);
    else stored.delete(to);
    storage.drafts.save(toSaved(saved));
  }
  notify();
}

export function forgetServerDrafts(serverId: string): void {
  memory.delete(serverId);
  changed.delete(serverId);
  const saved = toMap(storage.drafts.load());
  if (saved.delete(serverId)) storage.drafts.save(toSaved(saved));
  notify();
}

function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the chat holds unsent text in this session, stored or not. */
export function useHasDraft(serverId: string, name: string): boolean {
  return useSyncExternalStore(
    subscribeDrafts,
    () => getDraft(serverId, name) !== "",
  );
}

// test hook
export function resetDraftsForTests(): void {
  memory = new Map();
  changed.clear();
  stopTimer();
  gate = null;
  notify();
}
