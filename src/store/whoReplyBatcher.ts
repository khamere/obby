// Coalesces 352/354 WHO replies so the member list renders once, not
// once per user. Both WHO_REPLY (RFC 1459 RPL_WHOREPLY) and WHOX_REPLY
// (RPL_WHOSPCRPL, /WHO ... %xxx) arrive one per user. On a big channel
// that's hundreds of immediate `store.setState`s, each remapping every
// server/channel/user -- React re-renders the MemberList that many
// times and the user sees the list tick in one nick at a time.
//
// Pattern: each incoming reply pushes a pending update into a per-
// (serverId, channelName) buffer. A short idle timer (FLUSH_IDLE_MS)
// flushes the entire buffer in one setState. An optional hard ceiling
// flushes anyway so very slow servers don't appear stalled.

import type { StoreApi } from "zustand";
import ircClient from "../lib/ircClient";
import type { User } from "../types";
import { resolveUserMetadata, setUserAway } from "./helpers";
import type { AppState } from "./index";
import * as storage from "./localStorage";

// 60 ms: long enough for a single WHO burst to coalesce on common
// networks, short enough that the perceived "loading" is brief.
const FLUSH_IDLE_MS = 60;
// 1000 ms: hard ceiling so a trickling WHO (slow server, link
// degradation) still produces visible progress.
const FLUSH_MAX_MS = 1000;

export interface BufferedWhoEntry {
  nick: string;
  username?: string;
  host?: string;
  realname?: string;
  flags?: string;
  account?: string | null; // null === explicit "0" / no account
  isAway?: boolean;
  isBot?: boolean;
  isIrcOp?: boolean;
  status?: string; // channel prefix flags like "@", "%", etc.
}

interface ChannelBucket {
  serverId: string;
  channel: string;
  byNick: Map<string, BufferedWhoEntry>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  ceilingTimer: ReturnType<typeof setTimeout> | undefined;
}

const buckets = new Map<string, ChannelBucket>();

// Only the answer to our own request for every member, on the connection that sent it, says who is in the channel, so we track that request from the moment we send it until its answer ends.
interface MemberRefresh {
  serverId: string;
  channel: string;
  // Everyone the answer named or we saw join since we asked.
  present: Set<string>;
  // Everyone we saw leave since we asked, whom a row written before they left may still name.
  gone: Set<string>;
  // Nick changes since we asked, old to new, for rows written before the change.
  renamed: Map<string, string>;
}

const refreshes = new Map<string, MemberRefresh>();

function key(serverId: string, channel: string): string {
  return `${serverId}|${channel.toLowerCase()}`;
}

function refreshesFor(serverId: string, channel?: string): MemberRefresh[] {
  if (channel !== undefined) {
    const refresh = refreshes.get(key(serverId, channel));
    return refresh ? [refresh] : [];
  }
  return [...refreshes.values()].filter((r) => r.serverId === serverId);
}

export function beginMemberRefresh(serverId: string, channel: string): void {
  const k = key(serverId, channel);
  // The server answers requests in the order we sent them, so the first answer to end belongs to the request already open.
  if (refreshes.has(k)) return;
  refreshes.set(k, {
    serverId,
    channel,
    present: new Set(),
    gone: new Set(),
    renamed: new Map(),
  });
}

export function isMemberRefreshPending(
  serverId: string,
  channel: string,
): boolean {
  return refreshes.has(key(serverId, channel));
}

// The server takes its snapshot of the channel at some point after we ask, so a join, departure or nick change we see while the answer is open is newer than any row of it.
export function noteMemberJoined(
  serverId: string,
  channel: string,
  nick: string,
): void {
  const lowered = nick.toLowerCase();
  for (const refresh of refreshesFor(serverId, channel)) {
    refresh.present.add(lowered);
    refresh.gone.delete(lowered);
    refresh.renamed.delete(lowered);
  }
}

// A quit names no channel, so it reaches us with the channel left out.
export function noteMemberLeft(
  serverId: string,
  channel: string | undefined,
  nick: string,
): void {
  const lowered = nick.toLowerCase();
  for (const refresh of refreshesFor(serverId, channel)) {
    refresh.present.delete(lowered);
    refresh.gone.add(lowered);
    buckets.get(key(refresh.serverId, refresh.channel))?.byNick.delete(lowered);
  }
}

export function noteMemberRenamed(
  serverId: string,
  oldNick: string,
  newNick: string,
): void {
  const from = oldNick.toLowerCase();
  const to = newNick.toLowerCase();
  if (from === to) return;
  for (const refresh of refreshesFor(serverId)) {
    for (const [earlier, current] of refresh.renamed)
      if (current === from) refresh.renamed.set(earlier, to);
    refresh.renamed.set(from, to);
    refresh.renamed.delete(to);
    if (refresh.present.delete(from)) refresh.present.add(to);
    const rows = buckets.get(key(refresh.serverId, refresh.channel))?.byNick;
    const row = rows?.get(from);
    if (!rows || !row) continue;
    rows.delete(from);
    rows.set(to, { ...row, nick: newNick });
  }
}

export function forgetWhoReplies(serverId: string): void {
  for (const [k, refresh] of refreshes)
    if (refresh.serverId === serverId) refreshes.delete(k);
  for (const [k, bucket] of buckets) {
    if (bucket.serverId !== serverId) continue;
    clearTimeout(bucket.idleTimer);
    clearTimeout(bucket.ceilingTimer);
    buckets.delete(k);
  }
}

function applyBucket(store: StoreApi<AppState>, bucket: ChannelBucket): void {
  if (bucket.idleTimer) {
    clearTimeout(bucket.idleTimer);
    bucket.idleTimer = undefined;
  }
  if (bucket.ceilingTimer) {
    clearTimeout(bucket.ceilingTimer);
    bucket.ceilingTimer = undefined;
  }
  buckets.delete(key(bucket.serverId, bucket.channel));
  if (bucket.byNick.size === 0) return;

  store.setState((state) => {
    const updatedServers = state.servers.map((s) => {
      if (s.id !== bucket.serverId) return s;

      const serverMetadata = storage.metadata.load()[s.id];
      const updatedChannels = s.channels.map((ch) => {
        if (ch.name.toLowerCase() !== bucket.channel.toLowerCase()) return ch;
        const usersByNick = new Map(
          ch.users.map((u) => [u.username.toLowerCase(), u] as const),
        );
        for (const entry of bucket.byNick.values()) {
          const existing = usersByNick.get(entry.nick.toLowerCase());
          if (existing) {
            usersByNick.set(
              entry.nick.toLowerCase(),
              mergeUser(existing, entry),
            );
          } else {
            usersByNick.set(entry.nick.toLowerCase(), {
              ...entryToUser(entry),
              metadata: resolveUserMetadata(
                entry.nick,
                serverMetadata,
                s.channels,
                ch.name,
              ),
            });
          }
        }
        return { ...ch, users: Array.from(usersByNick.values()) };
      });

      // Mirror to private chats (PM tab metadata such as realname,
      // account, online/away status).
      const updatedPrivateChats = (s.privateChats || []).map((pm) => {
        const entry = bucket.byNick.get(pm.username.toLowerCase());
        if (!entry) return pm;
        return {
          ...pm,
          username: entry.nick, // case correction
          realname: entry.realname ?? pm.realname,
          account: entry.account ?? pm.account,
          isOnline: true,
          isAway: entry.isAway ?? pm.isAway,
          isBot: (pm.isBot || entry.isBot) ?? pm.isBot,
          isIrcOp: entry.isIrcOp ?? pm.isIrcOp,
        };
      });

      const ownNick = ircClient.getNick(s.id);
      const ownEntry = ownNick && bucket.byNick.get(ownNick.toLowerCase());
      const updated = {
        ...s,
        channels: updatedChannels,
        privateChats: updatedPrivateChats,
      };
      if (!ownEntry || ownEntry.isAway === undefined) return updated;
      return setUserAway(
        updated,
        ownNick,
        ownEntry.isAway,
        ownEntry.isAway ? s.awayMessage : undefined,
        ownNick,
      );
    });

    return { servers: updatedServers };
  });
}

function mergeUser(prev: User, entry: BufferedWhoEntry): User {
  return {
    ...prev,
    username: entry.nick, // server-authoritative casing
    hostname: entry.host ?? prev.hostname,
    realname: entry.realname ?? prev.realname,
    account: entry.account ?? prev.account,
    isOnline: true,
    isAway: entry.isAway ?? prev.isAway,
    isBot: entry.isBot ?? prev.isBot,
    isIrcOp: entry.isIrcOp ?? prev.isIrcOp,
    status: entry.status ?? prev.status,
  };
}

function entryToUser(entry: BufferedWhoEntry): User {
  return {
    id: entry.nick,
    username: entry.nick,
    hostname: entry.host,
    realname: entry.realname,
    avatar: undefined,
    isOnline: true,
    isAway: !!entry.isAway,
    isBot: !!entry.isBot,
    isIrcOp: !!entry.isIrcOp,
    status: entry.status,
    account: entry.account ?? undefined,
    metadata: {},
  };
}

export function bufferWhoReply(
  store: StoreApi<AppState>,
  serverId: string,
  channel: string,
  row: BufferedWhoEntry,
): void {
  const k = key(serverId, channel);
  const refresh = refreshes.get(k);
  const entry = refresh ? currentMember(refresh, row) : row;
  if (!entry) return;
  refresh?.present.add(entry.nick.toLowerCase());
  const existing = buckets.get(k);
  const bucket: ChannelBucket = existing ?? {
    serverId,
    channel,
    byNick: new Map(),
    idleTimer: undefined,
    ceilingTimer: undefined,
  };
  if (!existing) {
    buckets.set(k, bucket);
    bucket.ceilingTimer = setTimeout(
      () => applyBucket(store, bucket),
      FLUSH_MAX_MS,
    );
  }
  // Last-write-wins per nick within a burst (the most recent WHO line
  // for a given user is the authoritative one).
  bucket.byNick.set(entry.nick.toLowerCase(), entry);
  if (bucket.idleTimer) clearTimeout(bucket.idleTimer);
  bucket.idleTimer = setTimeout(
    () => applyBucket(store, bucket),
    FLUSH_IDLE_MS,
  );
}

// A row describes the channel as it was when the server wrote it, so we read it under the nick its member has now and skip it for a member who has left since.
function currentMember(
  refresh: MemberRefresh,
  row: BufferedWhoEntry,
): BufferedWhoEntry | undefined {
  const nick = refresh.renamed.get(row.nick.toLowerCase()) ?? row.nick;
  if (refresh.gone.has(nick.toLowerCase())) return undefined;
  return nick === row.nick ? row : { ...row, nick };
}

export function flushWhoReplies(
  store: StoreApi<AppState>,
  serverId: string,
  channel: string,
): void {
  const bucket = buckets.get(key(serverId, channel));
  if (bucket) applyBucket(store, bucket);
}

// The server lists every member only to someone inside the channel, so the end of our own request drops the members its answer left out when that answer names us, and the end of any other reply only adds what it brought.
export function finishWhoReplies(
  store: StoreApi<AppState>,
  serverId: string,
  channel: string,
): void {
  flushWhoReplies(store, serverId, channel);
  const k = key(serverId, channel);
  const present = refreshes.get(k)?.present;
  refreshes.delete(k);
  const ownNick = ircClient.getNick(serverId)?.toLowerCase();
  if (!present || !ownNick || !present.has(ownNick)) return;
  const isPresent = (user: User) => present.has(user.username.toLowerCase());

  store.setState((state) => ({
    servers: state.servers.map((s) => {
      if (s.id !== serverId) return s;
      return {
        ...s,
        channels: s.channels.map((ch) =>
          ch.name.toLowerCase() !== channel.toLowerCase() ||
          ch.users.every(isPresent)
            ? ch
            : { ...ch, users: ch.users.filter(isPresent) },
        ),
      };
    }),
  }));
}

// Test-only helpers.
export function _resetWhoReplyBatcher(): void {
  refreshes.clear();
  for (const b of buckets.values()) {
    if (b.idleTimer) clearTimeout(b.idleTimer);
    if (b.ceilingTimer) clearTimeout(b.ceilingTimer);
  }
  buckets.clear();
}

export function _peekWhoReplyBatcher(serverId: string, channel: string) {
  return buckets.get(key(serverId, channel));
}
