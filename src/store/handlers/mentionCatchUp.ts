import type { StoreApi } from "zustand";
import {
  applyBridgeRules,
  getCompiledBridgeRules,
} from "../../lib/bridgeRules";
import { isUserIgnored } from "../../lib/ignoreUtils";
import type { SearchResult } from "../../lib/irc/IRCClient";
import ircClient from "../../lib/ircClient";
import { makeLabel } from "../../lib/labeledResponse";
import { isSilenced } from "../../lib/mutes";
import { upstreamHostForServer } from "../../lib/networkHost";
import { checkForMention } from "../../lib/notifications";
import type { AppState } from "../index";
import type { MentionEntry } from "../mentionLog";

// History arrives a page at a time, so we ask a server that can search for
// the unread lines that name the user, however far back they are.

export const SEARCH_PAGE_SIZE = 100;
// A channel that mentions the user on more pages than this fills the inbox
// on its own.
export const MAX_PAGES_PER_TERM = 3;
// A server may match more loosely than we do, so pages without a mention get
// a larger budget of their own.
export const MAX_REQUESTS_PER_TERM = 12;
// A server may stop scanning after a long stretch without a match, so we do
// not start further back than this.
export const MAX_LOOKBACK_MS = 90 * 24 * 60 * 60_000;
export const ANSWER_TIMEOUT_MS = 30_000;
// A reconnect this soon after a search is covered by the history catch-up.
export const SEARCH_AGAIN_AFTER_MS = 10 * 60_000;

interface Question {
  channelName: string;
  // Only lines after the read marker are unread.
  readAt: string;
  after: string;
  before?: string;
  term: string;
  // What the pages of one word in one channel have used up between them.
  budget: { requests: number; pagesWithMentions: number };
  label?: string;
}

interface ServerQueue {
  waiting: Question[];
  asked?: Question;
  timer?: ReturnType<typeof setTimeout>;
  // Channels whose marker this connection has already reported.
  reported: Set<string>;
  // Channels with a refused question, which the next connection asks again.
  refused: Set<string>;
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
    queue = {
      waiting: [],
      reported: new Set(),
      refused: new Set(),
      isStopped: false,
    };
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

const isSpent = (budget: Question["budget"]) =>
  budget.pagesWithMentions >= MAX_PAGES_PER_TERM ||
  budget.requests >= MAX_REQUESTS_PER_TERM;

function askNext(serverId: string): void {
  const queue = queues.get(serverId);
  if (!queue || queue.asked || queue.isStopped) return;
  // Pages asked on both sides share one budget, which a sibling may have
  // used up since this one was queued.
  let next = queue.waiting.shift();
  while (next && isSpent(next.budget)) next = queue.waiting.shift();
  if (!next) return;
  const label = ircClient.hasCapability(serverId, "labeled-response")
    ? makeLabel()
    : undefined;
  const isSent = ircClient.search(
    serverId,
    {
      in: next.channelName,
      after: next.after,
      ...(next.before ? { before: next.before } : {}),
      text: next.term,
      limit: String(SEARCH_PAGE_SIZE),
    },
    label,
  );
  if (!isSent) {
    dropQueue(serverId);
    return;
  }
  next.budget.requests += 1;
  queue.asked = { ...next, label };
  queue.timer = setTimeout(() => giveUp(serverId), ANSWER_TIMEOUT_MS);
}

// A server without labels names no question in its answer, so once one is
// overdue we can no longer tell whose answer the next batch is, and we stop
// asking on this connection.
function giveUp(serverId: string): void {
  const queue = queues.get(serverId);
  if (!queue) return;
  queue.waiting = [];
  queue.asked = undefined;
  queue.isStopped = true;
}

function finish(serverId: string, isAnswered: boolean): void {
  const queue = queues.get(serverId);
  if (!queue?.asked) return;
  clearTimeout(queue.timer);
  const { channelName } = queue.asked;
  queue.asked = undefined;
  const key = channelName.toLowerCase();
  if (!isAnswered) queue.refused.add(key);
  const isLastQuestion = !queue.waiting.some(
    (q) => q.channelName === channelName,
  );
  if (isLastQuestion && !queue.refused.has(key))
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
    // A notice counts toward the page and never as a mention.
    if (result.command !== "PRIVMSG") continue;
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
    // Our own words relayed by a bridge are not a ping either.
    const myNick = me.username.toLowerCase();
    if (result.sender.toLowerCase() === myNick) continue;
    if (sender.toLowerCase() === myNick) continue;
    if (!checkForMention(content, me, settings)) continue;
    const timestamp = result.timestamp.toISOString();
    const msgid = result.mtags?.msgid;
    mentions.push({
      messageId:
        msgid ?? `search-${channel.id}-${timestamp}-${sender}-${content}`,
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

// A page can have more matches on either side of it: servers differ on
// whether they answer with the oldest or the newest. We ask both ways, and
// the side with nothing answers with an empty page.
export function pagesAfter(
  question: Question,
  results: SearchResult[],
): Question[] {
  // A server may answer with fewer lines than we asked for, so only an empty
  // page says there is nothing more on that side.
  if (results.length === 0) return [];
  if (isSpent(question.budget)) return [];
  const times = results.map((r) => r.timestamp.getTime());
  const oldest = new Date(Math.min(...times)).toISOString();
  const newest = new Date(Math.max(...times)).toISOString();
  const { label: _label, ...next } = question;
  const pages: Question[] = [];
  if (oldest > question.after && oldest !== question.before)
    pages.push({ ...next, before: oldest });
  if (newest > question.after && (!question.before || newest < question.before))
    pages.push({ ...next, after: newest });
  return pages;
}

// A line without a usable time from the server can be neither placed in the
// unread stretch nor used as the edge of the next page.
const hasServerTime = (result: SearchResult) =>
  !Number.isNaN(Date.parse(result.mtags?.time ?? ""));

// With labels on, an answer to a search someone typed by hand carries another
// label or none, and is not ours.
const answersAsked = (asked: Question, label: string | undefined) =>
  asked.label === undefined || asked.label === label;

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
    if (
      lastSearch !== undefined &&
      Date.now() - lastSearch < SEARCH_AGAIN_AFTER_MS
    )
      return;
    const terms = searchTerms(
      me.username,
      store.getState().globalSettings.customMentions,
    );
    const horizon = new Date(Date.now() - MAX_LOOKBACK_MS).toISOString();
    for (const term of terms)
      queue.waiting.push({
        channelName: target,
        readAt: timestamp,
        after: horizon > timestamp ? horizon : timestamp,
        term,
        budget: { requests: 0, pagesWithMentions: 0 },
      });
    askNext(serverId);
  });

  ircClient.on("SEARCH_RESULTS", ({ serverId, results, label }) => {
    const queue = queues.get(serverId);
    const question = queue?.asked;
    if (!queue || !question || !answersAsked(question, label)) return;
    const timed = results.filter(hasServerTime);
    const mentions = mentionsAmong(store.getState(), serverId, question, timed);
    for (const mention of mentions) store.getState().recordMention(mention);
    if (mentions.length > 0) question.budget.pagesWithMentions += 1;
    queue.waiting.unshift(...pagesAfter(question, timed));
    finish(serverId, true);
  });

  ircClient.on("SEARCH_FAIL", ({ serverId, mtags }) => {
    const question = queues.get(serverId)?.asked;
    if (question && answersAsked(question, mtags?.label))
      finish(serverId, false);
  });

  ircClient.on("connectionStateChange", ({ serverId, connectionState }) => {
    if (connectionState !== "connected") dropQueue(serverId);
  });
}

// Tests start from a client that has never searched.
export function forgetSearches(): void {
  for (const serverId of [...queues.keys()]) dropQueue(serverId);
  searchedAt.clear();
}
