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
import { newestMessageTime } from "../helpers";
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
const MAX_TIMEOUTS_IN_A_ROW = 2;
// Servers differ on whether a bound includes its own instant, and some keep
// time to the second, so the next page overlaps the last by this much.
export const EDGE_OVERLAP_MS = 1000;

interface Question {
  channelName: string;
  // Only lines after the read marker are unread.
  readAt: string;
  // The bounds as sent, and the edges of the pages they came from.
  after?: string;
  before?: string;
  afterEdge?: string;
  beforeEdge?: string;
  term: string;
  // What the pages of one word in one channel have used up between them.
  budget: { requests: number; pagesWithMentions: number; isSwept: boolean };
  // A bound set exactly on the edge, after a full page that did not move.
  isStrictAfter?: boolean;
  isStrictBefore?: boolean;
  // The newest matches, asked once a word has used up its pages.
  isSweep?: boolean;
  isLastSweepPage?: boolean;
  label?: string;
}

interface ServerQueue {
  waiting: Question[];
  asked?: Question;
  timer?: ReturnType<typeof setTimeout>;
  // Channels whose marker this connection has already reported.
  reported: Set<string>;
  // Channels with an unanswered question, which the next connection asks in full.
  refused: Set<string>;
  // Channels searched before, waiting for their history to say what is new.
  awaitingHistory: Map<string, { channelName: string; readAt: string }>;
  // Channels whose history this connection has already loaded.
  historyLoaded: Set<string>;
  // The newest line of each channel's history replies as the server sent
  // them, which includes lines the chat leaves out.
  newestInHistory: Map<string, number>;
  historyBatches: Map<string, string>;
  timeoutsInARow: number;
  isStopped: boolean;
}

const queues = new Map<string, ServerQueue>();
// The server time each channel has been searched up to, which outlives a
// reconnect.
const searchedUpTo = new Map<string, number>();

const channelKey = (serverId: string, channelName: string) =>
  `${serverId}\u0000${channelName.toLowerCase()}`;

function queueFor(serverId: string): ServerQueue {
  let queue = queues.get(serverId);
  if (!queue) {
    queue = {
      waiting: [],
      reported: new Set(),
      refused: new Set(),
      awaitingHistory: new Map(),
      historyLoaded: new Set(),
      newestInHistory: new Map(),
      historyBatches: new Map(),
      timeoutsInARow: 0,
      isStopped: false,
    };
    queues.set(serverId, queue);
  }
  return queue;
}

function dropQueue(serverId: string): void {
  clearTimeout(queues.get(serverId)?.timer);
  queues.delete(serverId);
  ircClient.forgetSearches(serverId);
}

// A server that searches by words refuses a word without a letter or digit,
// while one that searches by substring finds it.
const isWordSearchable = (term: string) => /[\p{L}\p{N}]/u.test(term);

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

function findChannel(state: AppState, serverId: string, channelName: string) {
  return state.servers
    .find((s) => s.id === serverId)
    ?.channels.find((c) => c.name.toLowerCase() === channelName.toLowerCase());
}

function newestLoaded(
  state: AppState,
  serverId: string,
  channelName: string,
): number | undefined {
  const channel = findChannel(state, serverId, channelName);
  return channel
    ? newestMessageTime(state, `${serverId}-${channel.id}`)
    : undefined;
}

function askNext(store: StoreApi<AppState>, serverId: string): void {
  const queue = queues.get(serverId);
  if (!queue || queue.asked || queue.isStopped) return;
  // The server may have withdrawn labels since the question was queued.
  if (!canSearch(serverId)) {
    dropQueue(serverId);
    return;
  }
  // Pages asked on both sides share one budget, which a sibling may have
  // used up since this one was queued.
  let next = queue.waiting.shift();
  while (next && !next.isSweep && isSpent(next.budget))
    next = queue.waiting.shift();
  if (!next) return;
  const label = makeLabel();
  const isSent = ircClient.search(
    serverId,
    {
      in: next.channelName,
      ...(next.after ? { after: next.after } : {}),
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
  queue.timer = setTimeout(() => onOverdue(store, serverId), ANSWER_TIMEOUT_MS);
}

// A late answer is told apart by its label, so one slow search costs only
// itself; a second in a row says the server has stopped answering.
function onOverdue(store: StoreApi<AppState>, serverId: string): void {
  const queue = queues.get(serverId);
  if (!queue?.asked) return;
  queue.timeoutsInARow += 1;
  if (queue.timeoutsInARow < MAX_TIMEOUTS_IN_A_ROW) {
    finish(store, serverId, false);
    return;
  }
  queue.waiting = [];
  queue.asked = undefined;
  queue.isStopped = true;
}

function finish(
  store: StoreApi<AppState>,
  serverId: string,
  isAnswered: boolean,
): void {
  const queue = queues.get(serverId);
  if (!queue?.asked) return;
  clearTimeout(queue.timer);
  const { channelName } = queue.asked;
  queue.asked = undefined;
  const key = channelName.toLowerCase();
  if (!isAnswered) queue.refused.add(key);
  const isLastQuestion = !queue.waiting.some(
    (q) => q.channelName === channelName && (q.isSweep || !isSpent(q.budget)),
  );
  if (isLastQuestion && !queue.refused.has(key)) {
    // The search saw every line the server held by now, and the newest line
    // we hold is the latest of those we can name in the server's own time.
    const newest = newestLoaded(store.getState(), serverId, channelName);
    if (newest !== undefined)
      searchedUpTo.set(channelKey(serverId, channelName), newest);
  }
  askNext(store, serverId);
}

export function mentionsAmong(
  state: AppState,
  serverId: string,
  question: Pick<Question, "channelName" | "readAt">,
  results: SearchResult[],
): MentionEntry[] {
  const me = ircClient.getCurrentUser(serverId);
  const channel = findChannel(state, serverId, question.channelName);
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

const shifted = (iso: string, byMs: number) =>
  new Date(Date.parse(iso) + byMs).toISOString();

// A page can have more matches on either side of it: servers differ on
// whether they answer with the oldest or the newest. We ask both ways, and
// a side is done when its page brings no line past the edge we asked from.
export function pagesAfter(
  question: Question,
  results: SearchResult[],
): Question[] {
  if (results.length === 0 || question.isSweep) return [];
  if (isSpent(question.budget)) return [];
  const times = results.map((r) => r.timestamp.getTime());
  const oldest = new Date(Math.min(...times)).toISOString();
  const newest = new Date(Math.max(...times)).toISOString();
  const { label: _label, ...next } = question;
  const lowerEdge = question.afterEdge ?? question.readAt;
  const pages: Question[] = [];
  if (oldest > lowerEdge && oldest !== question.beforeEdge)
    pages.push({
      ...next,
      before: shifted(oldest, EDGE_OVERLAP_MS),
      beforeEdge: oldest,
      isStrictBefore: false,
    });
  if (
    newest > lowerEdge &&
    (!question.beforeEdge || newest < question.beforeEdge)
  )
    pages.push({
      ...next,
      after: shifted(newest, -EDGE_OVERLAP_MS),
      afterEdge: newest,
      isStrictAfter: false,
    });
  if (pages.length > 0 || results.length < SEARCH_PAGE_SIZE) return pages;
  // A full page that did not move may be one instant holding more lines than
  // a page, with other lines hidden behind it, so we step past that instant.
  if (question.afterEdge === newest && !question.isStrictAfter)
    pages.push({ ...next, after: newest, isStrictAfter: true });
  if (question.beforeEdge === oldest && !question.isStrictBefore)
    pages.push({ ...next, before: oldest, isStrictBefore: true });
  return pages;
}

// A server that pages from the oldest match may have spent the budget before
// reaching the newest ones, which are the ones the inbox keeps.
function sweepAfter(question: Question, results: SearchResult[]): Question[] {
  const { budget } = question;
  if (results.length === 0) return [];
  const { label: _label, after: _after, before: _before, ...rest } = question;
  const sweep = { ...rest, afterEdge: undefined, beforeEdge: undefined };
  // The inbox holds two pages, so a full first page is followed by the one
  // before it.
  if (question.isSweep) {
    if (question.isLastSweepPage || results.length < SEARCH_PAGE_SIZE)
      return [];
    const oldest = Math.min(...results.map((r) => r.timestamp.getTime()));
    return [
      {
        ...sweep,
        before: new Date(oldest + EDGE_OVERLAP_MS).toISOString(),
        isLastSweepPage: true,
      },
    ];
  }
  if (budget.isSwept || !isSpent(budget)) return [];
  budget.isSwept = true;
  return [{ ...sweep, isSweep: true }];
}

const isPlaced = (result: SearchResult) =>
  result.hasServerTime && !Number.isNaN(result.timestamp.getTime());

// An answer names its question only through its label, so a server has to
// return labels for us to search it at all.
const canSearch = (serverId: string) =>
  ircClient.hasCapability(serverId, "soju.im/search") &&
  ircClient.hasCapability(serverId, "labeled-response");

const answersAsked = (asked: Question, label: string | undefined) =>
  asked.label === label;

function enqueue(
  store: StoreApi<AppState>,
  serverId: string,
  channelName: string,
  readAt: string,
  from: string,
): void {
  const me = ircClient.getCurrentUser(serverId);
  if (!me) return;
  const horizon = new Date(Date.now() - MAX_LOOKBACK_MS).toISOString();
  const after = horizon > from ? horizon : from;
  const terms = searchTerms(
    me.username,
    store.getState().globalSettings.customMentions,
  );
  const queue = queueFor(serverId);
  for (const term of terms)
    queue.waiting.push({
      channelName,
      readAt,
      after,
      afterEdge: after,
      term,
      budget: { requests: 0, pagesWithMentions: 0, isSwept: false },
    });
  askNext(store, serverId);
}

export function registerMentionCatchUpHandlers(
  store: StoreApi<AppState>,
): void {
  ircClient.on("MARKREAD", ({ serverId, target, timestamp }) => {
    if (!canSearch(serverId)) return;
    if (!ircClient.isChannel(serverId, target)) return;
    const queue = queueFor(serverId);
    // The first marker of a connection says where the user left off; later
    // ones follow their reading, and what arrives then arrives live.
    const key = target.toLowerCase();
    if (queue.reported.has(key)) return;
    queue.reported.add(key);
    // A channel without a marker has never been read, and its backlog
    // counts as read from the moment the user first opens it.
    if (timestamp === null) return;
    const searched = searchedUpTo.get(channelKey(serverId, target));
    if (searched === undefined) {
      enqueue(store, serverId, target, timestamp, timestamp);
      return;
    }
    // A channel searched before needs asking again only when its history
    // brings lines newer than that search saw.
    const hasHistory = ircClient.hasCapability(serverId, "draft/chathistory");
    // A later history page may still bring what this one did not.
    if (hasHistory)
      queue.awaitingHistory.set(key, {
        channelName: target,
        readAt: timestamp,
      });
    if (!hasHistory || queue.historyLoaded.has(key))
      searchWhatIsNew(serverId, target, timestamp, hasHistory);
  });

  // Whether a channel has anything the earlier search did not see is told by
  // its history, where the server has one.
  const searchWhatIsNew = (
    serverId: string,
    channelName: string,
    readAt: string,
    hasHistory: boolean,
  ) => {
    const searched = searchedUpTo.get(channelKey(serverId, channelName));
    if (searched === undefined) return;
    const queue = queueFor(serverId);
    const key = channelName.toLowerCase();
    if (hasHistory) {
      const loaded = newestLoaded(store.getState(), serverId, channelName);
      const sent = queue.newestInHistory.get(key);
      if (Math.max(loaded ?? 0, sent ?? 0) <= searched) return;
    }
    queue.awaitingHistory.delete(key);
    const edge = new Date(searched).toISOString();
    if (readAt >= edge) enqueue(store, serverId, channelName, readAt, readAt);
    // The line the earlier search ended on may share its instant with one
    // that came later, so we start a little before it.
    else
      enqueue(
        store,
        serverId,
        channelName,
        readAt,
        shifted(edge, -EDGE_OVERLAP_MS),
      );
  };

  ircClient.on("parsedLine", ({ serverId, command, parv, mtags }) => {
    if (command === "BATCH") {
      const ref = parv[0] ?? "";
      if (ref.startsWith("-"))
        queues.get(serverId)?.historyBatches.delete(ref.slice(1));
      // History may come before the marker that makes us look at it.
      else if (parv[1] === "chathistory" && parv[2] && canSearch(serverId))
        queueFor(serverId).historyBatches.set(
          ref.slice(1),
          parv[2].toLowerCase(),
        );
      return;
    }
    const queue = queues.get(serverId);
    if (!queue) return;
    const channel = mtags?.batch
      ? queue.historyBatches.get(mtags.batch)
      : undefined;
    const time = Date.parse(mtags?.time ?? "");
    if (!channel || Number.isNaN(time)) return;
    if (time > (queue.newestInHistory.get(channel) ?? 0))
      queue.newestInHistory.set(channel, time);
  });

  ircClient.on(
    "CHATHISTORY_LOADING",
    ({ serverId, channelName, isLoading }) => {
      if (isLoading || !canSearch(serverId)) return;
      const queue = queueFor(serverId);
      const key = channelName.toLowerCase();
      // The marker and the history come in either order.
      queue.historyLoaded.add(key);
      const waiting = queue.awaitingHistory.get(key);
      if (!waiting) return;
      searchWhatIsNew(serverId, waiting.channelName, waiting.readAt, true);
    },
  );

  ircClient.on("SEARCH_RESULTS", ({ serverId, results, label }) => {
    const queue = queues.get(serverId);
    const question = queue?.asked;
    if (!queue || !question || !answersAsked(question, label)) return;
    queue.timeoutsInARow = 0;
    const placed = results.filter(isPlaced);
    const mentions = mentionsAmong(
      store.getState(),
      serverId,
      question,
      placed,
    );
    // A page that only repeats the edge of the last one brings nothing new.
    const logBefore = store.getState().mentionLog;
    for (const mention of mentions) store.getState().recordMention(mention);
    if (store.getState().mentionLog !== logBefore)
      question.budget.pagesWithMentions += 1;
    queue.waiting.unshift(
      ...pagesAfter(question, placed),
      ...sweepAfter(question, placed),
    );
    finish(store, serverId, true);
  });

  ircClient.on("SEARCH_FAIL", ({ serverId, mtags }) => {
    const queue = queues.get(serverId);
    if (!queue?.asked || !answersAsked(queue.asked, mtags?.label)) return;
    queue.timeoutsInARow = 0;
    // A word the server cannot search for has nothing to be found by it.
    finish(store, serverId, !isWordSearchable(queue.asked.term));
  });

  ircClient.on("connectionStateChange", ({ serverId, connectionState }) => {
    if (connectionState !== "connected") dropQueue(serverId);
  });
}

// Tests start from a client that has never searched.
export function forgetSearches(): void {
  for (const serverId of [...queues.keys()]) dropQueue(serverId);
  searchedUpTo.clear();
}
