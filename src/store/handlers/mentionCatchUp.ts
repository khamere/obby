import type { StoreApi } from "zustand";
import {
  applyBridgeRules,
  getCompiledBridgeRules,
} from "../../lib/bridgeRules";
import { isUserIgnored } from "../../lib/ignoreUtils";
import type { SearchResult } from "../../lib/irc/IRCClient";
import ircClient from "../../lib/ircClient";
import { isSilenced } from "../../lib/mutes";
import { upstreamHostForServer } from "../../lib/networkHost";
import { checkForMention } from "../../lib/notifications";
import type { AppState } from "../index";
import type { MentionEntry } from "../mentionLog";

// History arrives a page at a time, so we ask a server that can search for
// the unread lines that name the user, however far back they are.

export const SEARCH_PAGE_SIZE = 100;
// A channel that mentions the user more often than this fills the inbox on
// its own.
export const MAX_PAGES_PER_TERM = 3;
export const ANSWER_TIMEOUT_MS = 30_000;
// A reconnect this soon after a search is covered by the history catch-up.
export const SEARCH_AGAIN_AFTER_MS = 10 * 60_000;
// Server and local clocks differ, so a later search overlaps the earlier one.
const CLOCK_MARGIN_MS = 60_000;

interface Question {
  channelName: string;
  // Only lines after the read marker are unread.
  readAt: string;
  after: string;
  before?: string;
  term: string;
  page: number;
}

interface ServerQueue {
  waiting: Question[];
  asked?: Question;
  timer?: ReturnType<typeof setTimeout>;
  // Channels whose marker this connection has already reported.
  reported: Set<string>;
  isStopped: boolean;
}

const queues = new Map<string, ServerQueue>();
// When each channel was last searched, which outlives a reconnect.
const searchedAt = new Map<string, number>();

const channelKey = (serverId: string, channelName: string) =>
  `${serverId}\u0000${channelName.toLowerCase()}`;

function queueFor(serverId: string): ServerQueue {
  let queue = queues.get(serverId);
  if (!queue) {
    queue = { waiting: [], reported: new Set(), isStopped: false };
    queues.set(serverId, queue);
  }
  return queue;
}

function dropQueue(serverId: string): void {
  clearTimeout(queues.get(serverId)?.timer);
  queues.delete(serverId);
}

export function searchTerms(nick: string, customMentions: string[]): string[] {
  const terms = new Map<string, string>();
  for (const term of [nick, ...customMentions]) {
    const trimmed = term.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !terms.has(key)) terms.set(key, trimmed);
  }
  return [...terms.values()];
}

function askNext(serverId: string): void {
  const queue = queues.get(serverId);
  if (!queue || queue.asked || queue.isStopped) return;
  const next = queue.waiting.shift();
  if (!next) return;
  const isSent = ircClient.search(serverId, {
    in: next.channelName,
    after: next.after,
    ...(next.before ? { before: next.before } : {}),
    text: next.term,
    limit: String(SEARCH_PAGE_SIZE),
  });
  if (!isSent) {
    dropQueue(serverId);
    return;
  }
  queue.asked = next;
  queue.timer = setTimeout(() => giveUp(serverId), ANSWER_TIMEOUT_MS);
}

// An answer names no question, so once one is overdue we can no longer tell
// whose answer the next batch is, and we stop asking on this connection.
function giveUp(serverId: string): void {
  const queue = queues.get(serverId);
  if (!queue) return;
  queue.waiting = [];
  queue.asked = undefined;
  queue.isStopped = true;
}

function finish(serverId: string): void {
  const queue = queues.get(serverId);
  if (!queue?.asked) return;
  clearTimeout(queue.timer);
  const { channelName } = queue.asked;
  queue.asked = undefined;
  if (!queue.waiting.some((q) => q.channelName === channelName))
    searchedAt.set(channelKey(serverId, channelName), Date.now());
  askNext(serverId);
}

export function mentionsAmong(
  state: AppState,
  serverId: string,
  question: Pick<Question, "channelName" | "readAt">,
  results: SearchResult[],
): MentionEntry[] {
  const me = ircClient.getCurrentUser(serverId);
  const channel = state.servers
    .find((s) => s.id === serverId)
    ?.channels.find(
      (c) => c.name.toLowerCase() === question.channelName.toLowerCase(),
    );
  if (!me || !channel) return [];
  const settings = state.globalSettings;
  const unreadFrom = Date.parse(question.readAt);
  // The user may have read on while the question waited its turn.
  const readUpTo = channel.readMarker
    ? Date.parse(channel.readMarker)
    : unreadFrom;
  const rules = settings.bridgedUsers ? getCompiledBridgeRules() : null;
  const host = upstreamHostForServer(state, serverId);
  const isIgnored = (nick: string) =>
    isUserIgnored(nick, undefined, undefined, settings.ignoreList);
  const isMuted = isSilenced(serverId, channel.id, true);
  const mentions: MentionEntry[] = [];
  for (const result of results) {
    if (result.target.toLowerCase() !== channel.name.toLowerCase()) continue;
    const time = result.timestamp.getTime();
    if (!(time > unreadFrom)) continue;
    // A bridge speaks for someone else, and the mention is filed under them.
    const bridged = rules
      ? applyBridgeRules(
          rules,
          host,
          channel.name,
          result.sender,
          result.message,
        )
      : null;
    const sender = bridged?.kind === "bot" ? bridged.nick : result.sender;
    const content = bridged?.kind === "bot" ? bridged.text : result.message;
    if (isIgnored(result.sender) || isIgnored(sender)) continue;
    if (result.sender.toLowerCase() === me.username.toLowerCase()) continue;
    if (!checkForMention(content, me, settings)) continue;
    const timestamp = result.timestamp.toISOString();
    const msgid = result.mtags?.msgid;
    mentions.push({
      messageId: msgid ?? `search-${channel.id}-${timestamp}-${sender}`,
      msgid,
      serverId,
      channelId: channel.id,
      channelName: channel.name,
      sender,
      content,
      timestamp,
      seen: isMuted || time <= readUpTo,
    });
  }
  return mentions;
}

// A full page has more matches on one side of it, and servers differ on
// which: some answer with the oldest matches and some with the newest. We
// ask both ways, and the side with nothing answers with an empty page.
export function pagesAfter(
  question: Question,
  results: SearchResult[],
): Question[] {
  if (results.length < SEARCH_PAGE_SIZE) return [];
  if (question.page >= MAX_PAGES_PER_TERM) return [];
  const times = results.map((r) => r.timestamp.getTime());
  const oldest = new Date(Math.min(...times)).toISOString();
  const newest = new Date(Math.max(...times)).toISOString();
  const page = question.page + 1;
  const pages: Question[] = [];
  if (oldest > question.after && oldest !== question.before)
    pages.push({ ...question, before: oldest, page });
  if (newest > question.after && (!question.before || newest < question.before))
    pages.push({ ...question, after: newest, page });
  return pages;
}

export function registerMentionCatchUpHandlers(
  store: StoreApi<AppState>,
): void {
  ircClient.on("MARKREAD", ({ serverId, target, timestamp }) => {
    if (!ircClient.hasCapability(serverId, "soju.im/search")) return;
    if (!ircClient.isChannel(serverId, target)) return;
    const me = ircClient.getCurrentUser(serverId);
    if (!me) return;
    const queue = queueFor(serverId);
    // The first marker of a connection says where the user left off; later
    // ones follow their reading, and what arrives then arrives live.
    const key = target.toLowerCase();
    if (queue.reported.has(key)) return;
    queue.reported.add(key);
    // A channel without a marker has never been read, and its backlog
    // counts as read from the moment the user first opens it.
    if (timestamp === null) return;
    const lastSearch = searchedAt.get(channelKey(serverId, target));
    let after = timestamp;
    if (lastSearch !== undefined) {
      if (Date.now() - lastSearch < SEARCH_AGAIN_AFTER_MS) return;
      const overlap = new Date(lastSearch - CLOCK_MARGIN_MS).toISOString();
      if (overlap > after) after = overlap;
    }
    const terms = searchTerms(
      me.username,
      store.getState().globalSettings.customMentions,
    );
    for (const term of terms)
      queue.waiting.push({
        channelName: target,
        readAt: timestamp,
        after,
        term,
        page: 1,
      });
    askNext(serverId);
  });

  ircClient.on("SEARCH_RESULTS", ({ serverId, results }) => {
    const queue = queues.get(serverId);
    const question = queue?.asked;
    if (!queue || !question) return;
    const mentions = mentionsAmong(
      store.getState(),
      serverId,
      question,
      results,
    );
    for (const mention of mentions) store.getState().recordMention(mention);
    queue.waiting.unshift(...pagesAfter(question, results));
    finish(serverId);
  });

  ircClient.on("SEARCH_FAIL", ({ serverId }) => finish(serverId));

  ircClient.on("connectionStateChange", ({ serverId, connectionState }) => {
    if (connectionState !== "connected") dropQueue(serverId);
  });
}

// Tests start from a client that has never searched.
export function forgetSearches(): void {
  for (const serverId of [...queues.keys()]) dropQueue(serverId);
  searchedAt.clear();
}
