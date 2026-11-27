import type { StoreApi } from "zustand";
import { e2eeSessionKey, isEncryptionEngaged } from "../../lib/e2ee/session";
import {
  addGap,
  adoptParkedHistory,
  appendRows,
  deleteGap,
  deleteMessage,
  deleteMessagesMissingFromPage,
  deleteServerHistory,
  eventRowsAfter,
  eventRowsBefore,
  fillableGaps,
  gapsFor,
  type HistoryGap,
  type HistoryRow,
  hasRowForEach,
  hasServerHistory,
  type NewHistoryRow,
  newestEventRows,
  orderRowsAtPageEdge,
  parkServerHistory,
  pruneToLimit,
  refRowsFor,
  rowByMsgid,
  savedSenders,
  updateGap,
} from "../../lib/history/historyDb";
import {
  buildReplayLines,
  decideAfterForwardFill,
  decideAfterGapFill,
  decideAfterLatest,
  HISTORY_GAP_CODE,
  HISTORY_PAGE_SIZE,
  type HistoryAction,
  type HistoryPage,
  HistoryRecorder,
  LOCAL_BATCH_PREFIX,
  LOCAL_HISTORY_TAG,
  planLoadMore,
} from "../../lib/history/historyLines";
import {
  isInScope,
  type SearchCandidate,
  type SearchOptions,
  searchCandidates,
  searchMessages,
} from "../../lib/history/historySearch";
import {
  containsLink,
  plainText,
  searchFieldsOf,
} from "../../lib/history/searchFields";
import ircClient from "../../lib/ircClient";
import { parseMessageTags } from "../../lib/ircUtils";
import type {
  SearchPage,
  SearchQuery,
  SearchScope,
} from "../../lib/search/searchTypes";
import type { Channel, Message, Server } from "../../types";
import {
  compareMessageOrder,
  type HistoryPagePlace,
  MAX_MESSAGES_PER_CHANNEL,
  messageTime,
  normalizeHost,
  serverSupportsChathistory,
} from "../helpers";
import type { AppState } from "../index";
import * as storage from "../localStorage";

export const BYTES_PER_MB = 1_000_000;
const PRUNE_EVERY_WRITES = 200;
const MAX_AUTO_FILL_PAGES = 10;
// Servers throttle CHATHISTORY (obbyircd allows about one command a second
// after a short burst), so we keep one page in flight, pace the rest and stop
// after a bounded amount of history.
const SEARCH_FILL_MAX_LINES = 2000;
const SEARCH_FILL_PACE_MS = 1000;
const SEARCH_FILL_TIMEOUT_MS = 20_000;

type GapFill = {
  gap?: HistoryGap;
  pagesLeft?: number;
  isDiskOnly?: boolean;
  onSettled?: (isSaved: boolean, page?: HistoryPage) => void;
};

// `msgid` is the line a request named and `msgidTime` its time, and `before`
// the time an older page was asked from.
type PendingRequest =
  | { kind: "latest"; newestStored: Promise<HistoryRow | undefined> }
  | {
      kind: "before" | "after" | "around";
      fill?: GapFill;
      msgid?: string;
      msgidTime?: number;
      before?: number;
    };

const recorders = new Map<string, HistoryRecorder>();
const pendingRequests = new Map<string, PendingRequest[]>();
// Servers whose history pages carry no msgids (soju's file store). The
// recorder cannot match such lines back by msgid, so it saves none of them,
// and an older channel page fetched for the disk would never show. Those
// servers get their older pages shown straight from the reply instead.
const historyWithoutMsgids = new Set<string>();
// Consecutive older pages that put nothing on screen (joins, typing notices),
// per conversation, so we keep paging back without looping forever.
const hiddenPagesInARow = new Map<string, number>();
const MAX_HIDDEN_PAGES_IN_A_ROW = 10;
// The gap a BEFORE request is about to fill. We attach it when the line
// actually leaves, so a request the socket dropped never claims a reply.
let nextGapFill: GapFill | undefined;
let nextMsgidTime: number | undefined;
let nextBefore: number | undefined;
// Where the rows being replayed lie against the chat, while their lines pass through the handlers.
let replayPlace: HistoryPagePlace | undefined;

// Two requests for the same gap ask for the same page, and the second reply,
// all duplicates, would close the gap, so we keep one request per gap.
function isGapBeingFilled(serverId: string, target: string, gapId: number) {
  return (pendingRequests.get(conversationKey(serverId, target)) ?? []).some(
    (request) => request.kind !== "latest" && request.fill?.gap?.id === gapId,
  );
}

export function isServerPageComing(serverId: string, target: string): boolean {
  return (pendingRequests.get(conversationKey(serverId, target)) ?? []).some(
    (request) => request.kind === "latest" || !request.fill?.isDiskOnly,
  );
}

// Where the page a batch carries lies against the lines the chat holds. The
// newest page of the server, like saved rows we replay as a newer page, lies
// behind every line it leaves out, and an older page asked from a line ends
// right before that line.
export function historyPagePlace(
  serverId: string,
  target: string,
  batchId: string,
): HistoryPagePlace | undefined {
  if (batchId.startsWith(LOCAL_BATCH_PREFIX)) return replayPlace;
  const [request] =
    pendingRequests.get(conversationKey(serverId, target)) ?? [];
  if (request?.kind === "latest") return "newest";
  return request?.kind === "before" && request.msgid
    ? { before: request.msgid }
    : undefined;
}

function requestPageBefore(
  serverId: string,
  target: string,
  before: number,
  fill: GapFill | undefined,
  showLoading = true,
  msgid?: string,
): boolean {
  if (fill?.gap && isGapBeingFilled(serverId, target, fill.gap.id))
    return false;
  nextGapFill = fill;
  nextMsgidTime = msgid === undefined ? undefined : before;
  nextBefore = before;
  const isSent = ircClient.requestChathistoryBefore(
    serverId,
    target,
    new Date(before).toISOString(),
    { showLoading, isDiskOnly: fill?.isDiskOnly, msgid },
  );
  nextGapFill = undefined;
  nextMsgidTime = undefined;
  nextBefore = undefined;
  return isSent;
}

function requestPageAfter(
  serverId: string,
  target: string,
  subcommand: "AFTER" | "AROUND",
  time: number,
  fill: GapFill | undefined,
  msgid?: string,
): boolean {
  nextGapFill = fill;
  nextMsgidTime = msgid === undefined ? undefined : time;
  const isSent = ircClient.requestChathistoryAt(
    serverId,
    target,
    subcommand,
    new Date(time).toISOString(),
    { isDiskOnly: subcommand === "AFTER", msgid },
  );
  nextGapFill = undefined;
  nextMsgidTime = undefined;
  return isSent;
}

// A server answers a msgid it no longer holds with an empty page, the same
// answer as the end of its history, so we ask that page again by time.
function askAgainByTime(
  serverId: string,
  target: string,
  request: Exclude<PendingRequest, { kind: "latest" }>,
  time: number,
): boolean {
  return request.kind === "before"
    ? requestPageBefore(serverId, target, time, request.fill, false)
    : requestPageAfter(serverId, target, "AFTER", time, request.fill);
}

// The msgid a gap carries for one of its edges, on a server that pages by
// msgid and only while the edge still sits at the time we ask from.
function gapEdgeMsgid(
  gap: HistoryGap | undefined,
  edge: "from" | "to",
  time: number,
): string | undefined {
  if (!gap || gap[edge] !== time || !ircClient.canPageByMsgid(gap.server))
    return undefined;
  return edge === "from" ? gap.fromMsgid : gap.toMsgid;
}

// A gap narrowed to one millisecond still misses lines of it, and gaps are
// read by their times, so we fetch the rest at once, from the line the last
// page stopped at, before anything else reads the gap.
function askForRestOfMillisecond(
  serverId: string,
  target: string,
  gap: HistoryGap,
  edge: "from" | "to",
  fill: GapFill,
): boolean {
  const msgid = gapEdgeMsgid(gap, edge, gap[edge]);
  if (gap.from < gap.to || gap.lost || !msgid) return false;
  return edge === "to"
    ? requestPageBefore(serverId, target, gap.to, fill, false, msgid)
    : requestPageAfter(serverId, target, "AFTER", gap.from, fill, msgid);
}

function shownOldestMsgid(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  time: number,
): string | undefined {
  const conversation = findConversation(store, serverId, target);
  const oldest =
    conversation && store.getState().messages[conversation.key]?.[0];
  return oldest && messageTime(oldest) === time ? oldest.msgid : undefined;
}

// The line an older page starts from when no gap names it: a line we hold at
// that time, saved or on screen. A page asked from a line that is not the
// first of its millisecond repeats lines we hold, and those are dropped.
async function heldMsgidAt(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  time: number,
): Promise<string | undefined> {
  if (!ircClient.canPageByMsgid(serverId)) return undefined;
  const [row] = await eventRowsAfter(serverId, target.toLowerCase(), time, 1);
  if (row?.time === time && row.msgid) return row.msgid;
  return shownOldestMsgid(store, serverId, target, time);
}

const shownConversations = new Set<string>();
let writesSincePrune = 0;
let replayCounter = 0;
let registeredStore: StoreApi<AppState> | undefined;

// Removed and re-added servers find their parked history by this address.
// Bouncer networks share the bouncer's host and port, so theirs adds the netid.
function serverAddress(
  server: Pick<Server, "host" | "port" | "bouncerNetid">,
): string {
  const address = `${normalizeHost(server.host).toLowerCase()}:${server.port}`;
  return server.bouncerNetid ? `${address}/${server.bouncerNetid}` : address;
}

// We add the login to the address, so two accounts on one network never take each other's history.
function serverLoginAddress(
  server: Pick<
    Server,
    "id" | "host" | "port" | "bouncerNetid" | "bouncerServerId"
  >,
): string {
  const configId = server.bouncerServerId ?? server.id;
  const config = storage.servers.load().find((c) => c.id === configId);
  const login = (
    config?.saslAccountName ||
    config?.nickname ||
    ""
  ).toLowerCase();
  return `${serverAddress(server)}#${login}`;
}

// We fall back to the bare address for history parked before logins were part of it.
async function adoptHistoryForServer(server: Server): Promise<void> {
  if (await adoptParkedHistory(serverLoginAddress(server), server.id)) return;
  await adoptParkedHistory(serverAddress(server), server.id);
}

function loadedCandidates(
  state: AppState,
  ownNicks: Record<string, string>,
): SearchCandidate[] {
  return state.servers.flatMap((server) => {
    const own = ownNicks[server.id]?.toLowerCase();
    const chats = [
      ...server.channels.map((c) => ({ id: c.id, target: c.name })),
      ...(server.privateChats ?? []).map((pc) => ({
        id: pc.id,
        target: pc.username,
      })),
    ];
    return chats.flatMap(({ id, target }) =>
      (state.messages[`${server.id}-${id}`] ?? [])
        .filter((m) => m.type === "message" || m.type === "notice")
        .map((m) => {
          const text = plainText(m.content);
          return {
            serverId: server.id,
            target: target.toLowerCase(),
            time: new Date(m.timestamp).getTime(),
            nick: m.userId,
            text,
            ...(m.msgid ? { msgid: m.msgid } : {}),
            hasLink: containsLink(text),
            isOwn: m.userId.toLowerCase() === own,
            repliesToOwn: !!own && m.replyMessage?.userId.toLowerCase() === own,
          };
        }),
    );
  });
}

// With history off we search the messages loaded in this session.
export function searchSavedMessages(
  store: StoreApi<AppState>,
  query: SearchQuery,
  opts: Omit<SearchOptions, "ownNicks"> = {},
): Promise<SearchPage> {
  const state = store.getState();
  const ownNicks: Record<string, string> = {};
  for (const server of state.servers) {
    const nick = ircClient.getNick(server.id);
    if (nick) ownNicks[server.id] = nick;
  }
  return isEnabled(store)
    ? searchMessages(query, { ...opts, ownNicks })
    : Promise.resolve(
        searchCandidates(loadedCandidates(state, ownNicks), query, {
          ...opts,
          ownNicks,
        }),
      );
}

export function listSavedSenders(
  store: StoreApi<AppState> | undefined = registeredStore,
): Promise<string[]> {
  if (!store || isEnabled(store)) return savedSenders();
  const nicks = loadedCandidates(store.getState(), {}).map((candidate) =>
    candidate.nick.toLowerCase(),
  );
  return Promise.resolve([...new Set(nicks)].filter(Boolean).sort());
}

export interface SavedMessage {
  nick: string;
  text: string;
  time: number;
}

// The saved copy of a message, for a reply whose original is not loaded.
export async function findSavedMessage(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  msgid: string,
): Promise<SavedMessage | null> {
  if (!isEnabled(store)) return null;
  let row: HistoryRow | undefined;
  try {
    row = await rowByMsgid(serverId, target.toLowerCase(), msgid);
  } catch (error) {
    // A database another tab holds open counts as no saved copy, so the
    // server can still be asked.
    console.warn("saved history unavailable", error);
    return null;
  }
  if (!row || row.ref !== undefined) return null;
  // The row's own nick column is lowercased for search; the line keeps the
  // casing the person uses.
  const { nick, text } = searchFieldsOf(row.raw);
  if (!nick) return null;
  return { nick, text, time: row.time };
}

export async function hasSavedChat(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
): Promise<boolean> {
  if (!isEnabled(store)) return false;
  return (await newestEventRows(serverId, target.toLowerCase(), 1)).length > 0;
}

export function hasSavedHistory(serverId: string): Promise<boolean> {
  return hasServerHistory(serverId);
}

export function settleSavedHistory(
  server: Parameters<typeof serverLoginAddress>[0],
  shouldDelete: boolean,
): Promise<void> {
  return shouldDelete
    ? deleteServerHistory(server.id)
    : parkServerHistory(server.id, serverLoginAddress(server));
}

const conversationKey = (serverId: string, target: string) =>
  `${serverId}\n${target.toLowerCase()}`;

function recorderFor(
  store: StoreApi<AppState>,
  serverId: string,
): HistoryRecorder {
  let recorder = recorders.get(serverId);
  if (!recorder) {
    const isKnown = store.getState().servers.some((s) => s.id === serverId);
    recorder = new HistoryRecorder(serverId, {
      ownNick: () => ircClient.getNick(serverId),
      hasChathistory: () =>
        serverSupportsChathistory(store.getState(), serverId),
      chantypes: () => ircClient.chantypes(serverId),
      isOpenConversation: (target) =>
        findConversation(store, serverId, target) !== undefined,
      isEncryptedPm: (nick) =>
        isEncryptionEngaged(
          store.getState().e2eeSessions[e2eeSessionKey(serverId, nick)],
        ),
      now: () => Date.now(),
    });
    if (isKnown) recorders.set(serverId, recorder);
  }
  return recorder;
}

function isEnabled(store: StoreApi<AppState>): boolean {
  return store.getState().globalSettings.keepHistory !== false;
}

async function saveRows(store: StoreApi<AppState>, rows: NewHistoryRow[]) {
  const inserted = await appendRows(rows);
  writesSincePrune += rows.length;
  if (writesSincePrune >= PRUNE_EVERY_WRITES) {
    writesSincePrune = 0;
    // The trim runs in the background, so the rows we just saved go on to
    // the chat without waiting for it.
    pruneToLimit(
      store.getState().globalSettings.historyLimitMb * BYTES_PER_MB,
    ).catch((error: unknown) => console.warn("history trim failed", error));
  }
  return inserted;
}

// A page fetched around a time can land apart from the rows we had, or inside
// a gap, so we replace the gaps it overlaps with one on each side whose edge
// row is new to us. The result says whether the page ends on a new line
// beside rows we hold in the same millisecond, which no gap between two times covers.
async function addIslandGaps(
  server: string,
  target: string,
  page: HistoryPage,
  inserted: boolean[],
): Promise<boolean> {
  if (page.oldest === undefined || page.newest === undefined) return false;
  for (const gap of await gapsFor(server, target))
    if (gap.from < page.newest && gap.to > page.oldest) await deleteGap(gap.id);
  const [older] = await eventRowsBefore(server, target, page.oldest - 1, 1);
  if (older && inserted[0])
    await addGap({
      server,
      target,
      from: older.time,
      to: page.oldest,
      lost: false,
      ...(page.oldestMsgid ? { toMsgid: page.oldestMsgid } : {}),
    });
  const [newer] = await eventRowsAfter(server, target, page.newest + 1, 1);
  if (newer && inserted[inserted.length - 1])
    await addGap({
      server,
      target,
      from: page.newest,
      to: newer.time,
      lost: false,
      ...(page.newestMsgid ? { fromMsgid: page.newestMsgid } : {}),
    });
  return (
    inserted[inserted.length - 1] === true &&
    holdsLineBesidePage(server, target, page.newest, page.msgids)
  );
}

async function holdsLineBesidePage(
  server: string,
  target: string,
  time: number,
  pageMsgids: string[],
): Promise<boolean> {
  const inPage = new Set(pageMsgids);
  const rows = await eventRowsAfter(server, target, time, inPage.size + 1);
  return rows.some(
    (row) => row.time === time && !(row.msgid && inPage.has(row.msgid)),
  );
}

// Lines can be missing between a page and rows we hold in the millisecond it
// ends in. Where the server pages from a msgid we record that gap, which joins
// a wider one starting at the same line, and fill it from the page's last
// line. A time names the whole millisecond and could never move such a gap's
// edge, so elsewhere we ask once from the millisecond before and keep no record.
async function fetchLinesBesidePage(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  page: HistoryPage,
) {
  const { newest, newestMsgid } = page;
  if (newest === undefined) return;
  if (!newestMsgid || !ircClient.canPageByMsgid(serverId)) {
    await fetchPageToDisk(serverId, target, "AFTER", newest - 1);
    return;
  }
  await addGap({
    server: serverId,
    target,
    from: newest,
    to: newest,
    lost: false,
    fromMsgid: newestMsgid,
  });
  const gap = (await gapsFor(serverId, target)).find(
    (saved) => !saved.lost && saved.from === newest,
  );
  if (gap)
    await fetchForwardToDisk(store, serverId, target, newest, gap).isSaved;
}

// No time reads a gap of one millisecond and the request sent on finding it can fail, so we ask for its lines again after each newest page and before a chat opens on its read marker.
async function askAgainForMillisecondGaps(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
) {
  for (const gap of await gapsFor(serverId, target))
    if (gap.from === gap.to && gapEdgeMsgid(gap, "from", gap.from) && !gap.lost)
      await fetchForwardToDisk(store, serverId, target, gap.from, gap).isSaved;
}

// A refusal that never passes would repeat after every newest page, so we drop the gap of one millisecond it answered.
async function dropRefusedMillisecondGap(
  serverId: string,
  target: string,
  started: HistoryGap | undefined,
) {
  const gap = findFilledGap(
    await gapsFor(serverId, target.toLowerCase()),
    started,
  );
  if (gap && !gap.lost && gap.from === gap.to) await deleteGap(gap.id);
}

// Records for one stretch merge into a single one, so the record a fill
// started from may be gone while another record of the same stretch remains.
export function findFilledGap(
  gaps: HistoryGap[],
  started: HistoryGap | undefined,
): HistoryGap | undefined {
  if (!started) return undefined;
  return (
    gaps.find((gap) => gap.id === started.id) ??
    gaps.find((gap) => gap.from === started.from && gap.to === started.to)
  );
}

async function saveHistoryPage(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  rows: NewHistoryRow[],
  redacts: string[],
  page: HistoryPage,
) {
  const key = serverId;
  const request = pendingRequests
    .get(conversationKey(serverId, target))
    ?.shift();
  if (
    request &&
    request.kind !== "latest" &&
    request.msgidTime !== undefined &&
    page.size === 0
  ) {
    if (!askAgainByTime(serverId, target, request, request.msgidTime))
      request.fill?.onSettled?.(false);
    return;
  }
  const inserted = rows.length ? await saveRows(store, rows) : [];
  if (page.oldest !== undefined && inserted.some((wasNew) => wasNew)) {
    const { oldest, newest = oldest, msgids } = page;
    const anchor =
      (request?.kind === "before" || request?.kind === "after") &&
      request.msgid !== undefined
        ? { msgid: request.msgid, kind: request.kind }
        : undefined;
    // A page that runs on into rows we hold meets them in a millisecond between its edges, which then holds a new row beside one we had.
    const heldTimes = new Set(
      rows.filter((_, at) => !inserted[at]).map((row) => row.time),
    );
    const metInside = new Set(
      rows
        .filter((row, at) => inserted[at] && heldTimes.has(row.time))
        .map((row) => row.time)
        .filter((time) => time > oldest && time < newest),
    );
    // A page inside one millisecond has no second edge to tell its side, so we place it by the line it was asked from: asked from an earlier time the page starts that millisecond, and asked from a later time it ends it.
    const askedFrom =
      request?.kind === "latest" ? undefined : request?.msgidTime;
    const heldInOneMs =
      request?.kind === "after" && askedFrom !== undefined && askedFrom < oldest
        ? "behind"
        : request?.kind === "before" &&
            askedFrom !== undefined &&
            askedFrom > newest
          ? "ahead"
          : undefined;
    // A move that fails leaves every row as it was saved, so the page goes on to settle its gaps and its request.
    try {
      for (const time of oldest === newest ? [] : [oldest, ...metInside])
        await orderRowsAtPageEdge(key, target, time, msgids, "ahead", anchor);
      await orderRowsAtPageEdge(
        key,
        target,
        newest,
        msgids,
        oldest !== newest ? "behind" : heldInOneMs,
        anchor,
      );
    } catch (error) {
      console.warn("history order failed", error);
    }
  }
  const canPageByMsgid = ircClient.canPageByMsgid(serverId);
  if (page.size > 0) {
    if (page.msgids.length === 0) historyWithoutMsgids.add(key);
    else historyWithoutMsgids.delete(key);
  }
  for (const msgid of redacts) await deleteMessage(key, target, msgid);
  if (page.oldest !== undefined && page.newest !== undefined)
    await deleteMessagesMissingFromPage(
      key,
      target,
      page.oldest,
      page.newest,
      page.msgids,
    );
  if (request?.kind === "before" && request.before !== undefined)
    await settleGapsBelow(key, target, request.before, page, request.fill?.gap);
  if (request?.kind === "latest") {
    const newestStored = await request.newestStored;
    const decision = decideAfterLatest({
      newestStoredTime: newestStored?.time,
      page,
    });
    if (decision.kind === "add") {
      const { from, to } = decision;
      await addGap({
        server: key,
        target,
        from,
        to,
        lost: false,
        ...(newestStored?.msgid ? { fromMsgid: newestStored.msgid } : {}),
        ...(page.oldestMsgid ? { toMsgid: page.oldestMsgid } : {}),
      });
      const [gap] = (await gapsFor(key, target)).filter(
        (g) => !g.lost && g.from === from && g.to >= to,
      );
      if (gap) settleGap(store, serverId, target, gap, MAX_AUTO_FILL_PAGES);
    }
    void askAgainForMillisecondGaps(store, serverId, target);
  } else if (request?.kind === "around") {
    if (await addIslandGaps(key, target, page, inserted))
      await fetchLinesBesidePage(store, serverId, target, page);
    request.fill?.onSettled?.(true);
  } else if (request?.kind === "after" && request.fill) {
    const filled = findFilledGap(await gapsFor(key, target), request.fill.gap);
    const decision =
      filled &&
      decideAfterForwardFill({
        gap: filled,
        page,
        inserted,
        canResumeFromEdge: canPageByMsgid && !!page.newestMsgid,
      });
    if (filled && decision?.kind === "close") await deleteGap(filled.id);
    else if (filled && decision?.kind === "shrink") {
      const gap = {
        ...filled,
        from: decision.from,
        fromMsgid: page.newestMsgid,
      };
      await updateGap(gap);
      if (askForRestOfMillisecond(serverId, target, gap, "from", request.fill))
        return;
    }
    request.fill.onSettled?.(true);
  } else if (request?.kind === "before" && request.fill) {
    const { pagesLeft } = request.fill;
    // We decide on the gap as saved now, since another fill may have moved it.
    const filled = findFilledGap(await gapsFor(key, target), request.fill.gap);
    const decision =
      filled &&
      decideAfterGapFill({
        gap: filled,
        page,
        inserted,
        canResumeFromEdge: canPageByMsgid && !!page.oldestMsgid,
      });
    if (filled && decision?.kind === "close") {
      await deleteGap(filled.id);
    } else if (filled && decision?.kind === "shrink") {
      const gap = {
        ...filled,
        to: decision.to,
        lost: decision.lost,
        toMsgid: page.size > 0 ? page.oldestMsgid : filled.toMsgid,
      };
      await updateGap(gap);
      if (askForRestOfMillisecond(serverId, target, gap, "to", request.fill))
        return;
      if (pagesLeft !== undefined)
        settleGap(store, serverId, target, gap, pagesLeft);
    }
    request.fill.onSettled?.(true, page);
  } else if (request?.kind === "before" && !request.fill) {
    // A shown page with only lines the chat does not display (our own join
    // from the bouncer's log, say) leaves the oldest message where it was
    // and the "more above" placeholders in place, so we ask for the page
    // behind it until something shows or the history ends.
    const conversation = findConversation(store, serverId, target);
    const shownOldest = conversation
      ? store.getState().messages[conversation.key]?.[0]
      : undefined;
    const isHidden =
      page.size > 0 &&
      page.oldest !== undefined &&
      (!shownOldest || messageTime(shownOldest) > page.oldest);
    const hiddenKey = conversationKey(serverId, target);
    const hidden = isHidden ? (hiddenPagesInARow.get(hiddenKey) ?? 0) + 1 : 0;
    hiddenPagesInARow.set(hiddenKey, hidden);
    if (
      isHidden &&
      hidden <= MAX_HIDDEN_PAGES_IN_A_ROW &&
      page.oldest !== undefined &&
      requestPageBefore(
        serverId,
        target,
        page.oldest,
        undefined,
        false,
        page.oldestMsgid,
      )
    )
      return;
  }
  await refreshHasMore(store, serverId, target, page.size > 0);
}

// A page holds every line the server has from its oldest line up to the time we asked from, and an empty one ends the server's history, so we settle each gap below that time.
async function settleGapsBelow(
  server: string,
  target: string,
  before: number,
  page: HistoryPage,
  filling: HistoryGap | undefined,
) {
  const { oldest } = page;
  if (page.size > 0 && oldest === undefined) return;
  for (const gap of await gapsFor(server, target)) {
    if (gap.lost || gap.id === filling?.id || gap.to > before) continue;
    if (oldest === undefined) await updateGap({ ...gap, lost: true });
    else if (gap.from >= oldest) await deleteGap(gap.id);
    else if (gap.to > oldest)
      await updateGap({ ...gap, to: oldest, toMsgid: page.oldestMsgid });
  }
}

// We decide load more for a chat from every source: the server may have an
// older page, our disk has rows older than the oldest message on screen, or a
// gap the server can still fill waits above it.
async function refreshHasMore(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  serverMayHaveMore: boolean,
  canServerFillGaps = true,
) {
  const conversation = findConversation(store, serverId, target);
  if (!conversation) return;
  const oldest = store.getState().messages[conversation.key]?.[0];
  const isOlderThanOldestShown = (gap: HistoryGap) =>
    !oldest || gap.from < messageTime(oldest);
  // With local history off we load older pages from the server alone, so saved rows and gaps offer nothing.
  const hasMore =
    serverMayHaveMore ||
    (isEnabled(store) &&
      ((await olderDiskRows(store, serverId, target, 1)).length > 0 ||
        (canServerFillGaps &&
          (await gapsServerCanFill(store, serverId, target)).some(
            isOlderThanOldestShown,
          ))));
  updateChat(store, serverId, conversation.channelId, {
    hasMoreHistory: hasMore,
  });
}

type HistoryOffer = Pick<Channel, "hasMoreHistory" | "historyRefusedAt">;

function updateChat(
  store: StoreApi<AppState>,
  serverId: string,
  chatId: string,
  update: HistoryOffer,
) {
  store.setState((state) => ({
    servers: state.servers.map((server) =>
      server.id !== serverId
        ? server
        : {
            ...server,
            channels: server.channels.map((c) =>
              c.id === chatId ? { ...c, ...update } : c,
            ),
            privateChats: server.privateChats?.map((pc) =>
              pc.id === chatId ? { ...pc, ...update } : pc,
            ),
          },
    ),
  }));
}

// A request refused with one of these fails the same way when sent again. Any
// other refusal, like a storage error or a rate limit, can pass on a later try.
const FINAL_REFUSALS = new Set([
  "INVALID_TARGET",
  "INVALID_PARAMS",
  "INVALID_MSGREFTYPE",
  "NEED_MORE_PARAMS",
  "UNKNOWN_COMMAND",
]);

// Some servers name only the subcommand in a refusal, or nothing at all, so
// we take it for the one chat that waits for a reply it can be for.
function onlyChatAwaiting(
  serverId: string,
  subcommand: string | undefined,
): string | undefined {
  const kind = subcommand?.toLowerCase();
  const waiting = [...pendingRequests]
    .filter(
      ([key, [request]]) =>
        key.startsWith(`${serverId}\n`) &&
        request &&
        (!kind || request.kind === kind),
    )
    .map(([key]) => key.slice(serverId.length + 1));
  return waiting.length === 1 ? waiting[0] : undefined;
}

// We show a chat as loading only while it waits for a LATEST or a BEFORE page, so a refusal of one of these ends no chat's loading.
const SUBCOMMANDS_WITHOUT_LOADING = new Set([
  "AFTER",
  "AROUND",
  "BETWEEN",
  "TARGETS",
]);

// With local history off we track no request and only a reply ends a chat's loading, so a refusal we can match to no chat settles each chat that is loading.
function chatsLoadingUntracked(
  store: StoreApi<AppState>,
  serverId: string,
  subcommand: string | undefined,
): string[] {
  if (isEnabled(store)) return [];
  if (SUBCOMMANDS_WITHOUT_LOADING.has(subcommand?.toUpperCase() ?? ""))
    return [];
  const server = store.getState().servers.find((s) => s.id === serverId);
  return [
    ...(server?.channels ?? [])
      .filter((channel) => channel.isLoadingHistory)
      .map((channel) => channel.name),
    ...(server?.privateChats ?? [])
      .filter((chat) => chat.isLoadingHistory)
      .map((chat) => chat.username),
  ];
}

// A final refusal ends the offer of older history, apart from pages we can
// still read from disk. After any other refusal the offer stands as it was,
// and a refusal that can be for an older page is marked so the list can ask
// for that page again.
function settleRefusedOffer(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  isFinal: boolean,
  subcommand: string | undefined,
) {
  const conversation = findConversation(store, serverId, target);
  if (!conversation) return;
  setLoading(serverId, target, false);
  if (isFinal) {
    void refreshHasMore(store, serverId, target, false, false);
    return;
  }
  const server = store.getState().servers.find((s) => s.id === serverId);
  const chat =
    server?.channels.find((c) => c.id === conversation.channelId) ??
    server?.privateChats?.find((pc) => pc.id === conversation.channelId);
  if (!subcommand || subcommand.toUpperCase() === "BEFORE")
    updateChat(store, serverId, conversation.channelId, {
      historyRefusedAt: Date.now(),
    });
  void refreshHasMore(store, serverId, target, chat?.hasMoreHistory === true);
}

async function gapsServerCanFill(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
): Promise<HistoryGap[]> {
  if (!serverSupportsChathistory(store.getState(), serverId)) return [];
  return (await gapsFor(serverId, target.toLowerCase())).filter(
    (gap) => !gap.lost,
  );
}

// We read saved rows only down to the nearest gap the server can still fill,
// so the messages on screen never run across a hole without a way to fill it.
async function rowsAboveGap(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  time: number,
  rows: HistoryRow[],
): Promise<HistoryRow[]> {
  const [gap] = (await gapsServerCanFill(store, serverId, target))
    .filter((g) => g.to <= time)
    .sort((a, b) => b.to - a.to);
  return gap ? rows.filter((row) => row.time >= gap.to) : rows;
}

type OlderEdge = {
  time: number;
  readCount: number;
  isRead: (row: HistoryRow) => boolean;
};

// A replayed page can hold only hidden rows (from ignored users), which leaves
// the oldest message on screen as it was, so we remember how far back we read.
const readBackTo = new Map<
  string,
  { oldestShownId: string | undefined; time: number; rowIds: Set<number> }
>();

function readBackEdge(
  store: StoreApi<AppState>,
  key: string,
): OlderEdge | undefined {
  const readBack = readBackTo.get(key);
  if (readBack?.oldestShownId !== store.getState().messages[key]?.[0]?.id)
    return undefined;
  return (
    readBack && {
      time: readBack.time,
      readCount: readBack.rowIds.size,
      isRead: (row) => readBack.rowIds.has(row.id),
    }
  );
}

// Where the next older page starts. Messages can share a millisecond, so we
// read past its rows that are on screen or were read back already, and skip
// them.
function olderEdge(
  store: StoreApi<AppState>,
  key: string,
): OlderEdge | undefined {
  const readBack = readBackEdge(store, key);
  const messages = store.getState().messages[key] ?? [];
  if (messages.length === 0) return readBack;
  const oldest = messageTime(messages[0]);
  if (readBack && readBack.time < oldest) return readBack;
  const sameMs = messages.filter((m) => messageTime(m) === oldest);
  const shown = new Set(
    sameMs.flatMap((m) => [m.msgid, ...(m.multilineMessageIds ?? [])]),
  );
  return {
    time: oldest,
    readCount: sameMs.length + (readBack?.readCount ?? 0),
    isRead: (row) =>
      (!!row.msgid && shown.has(row.msgid)) || !!readBack?.isRead(row),
  };
}

function forgetRemovedReadBacks(state: AppState) {
  const keys = new Set(
    state.servers.flatMap((server) =>
      [...server.channels, ...(server.privateChats ?? [])].map(
        (chat) => `${server.id}-${chat.id}`,
      ),
    ),
  );
  for (const key of readBackTo.keys())
    if (!keys.has(key)) readBackTo.delete(key);
}

function rememberReadBack(
  store: StoreApi<AppState>,
  key: string,
  rows: HistoryRow[],
) {
  const time = rows[0].time;
  const previous = readBackTo.get(key);
  const rowIds = new Set(
    rows.filter((row) => row.time === time).map((row) => row.id),
  );
  if (previous?.time === time) for (const id of previous.rowIds) rowIds.add(id);
  readBackTo.set(key, {
    oldestShownId: store.getState().messages[key]?.[0]?.id,
    time,
    rowIds,
  });
}

// Rows on disk older than the oldest message on screen.
async function olderDiskRows(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  limit: number,
): Promise<HistoryRow[]> {
  const conversation = findConversation(store, serverId, target);
  const edge = conversation && olderEdge(store, conversation.key);
  if (!edge)
    return rowsAboveGap(
      store,
      serverId,
      target,
      Number.POSITIVE_INFINITY,
      await newestEventRows(serverId, target.toLowerCase(), limit),
    );
  const rows = await eventRowsBefore(
    serverId,
    target.toLowerCase(),
    edge.time,
    limit + edge.readCount,
  );
  return rowsAboveGap(
    store,
    serverId,
    target,
    edge.time,
    rows.filter((row) => !edge.isRead(row)).slice(-limit),
  );
}

// A gap inside the present is invisible, so we fill it from the server at once
// and mark what the server no longer has. A gap above it waits for load more.
function settleGap(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  gap: HistoryGap,
  pagesLeft: number,
) {
  const conversation = findConversation(store, serverId, target);
  if (!conversation) return;
  const state = store.getState();
  const window = state.historyWindows[conversation.key];
  const present = window?.present ?? state.messages[conversation.key] ?? [];
  if (!present.some((message) => messageTime(message) <= gap.from)) return;
  // A page or a marker for this gap would show inside a window opened after
  // it, so the gap waits there for the reader to return to the present.
  const isBehindWindow = window !== undefined && window.until > gap.from;
  if (gap.lost) {
    if (!isBehindWindow)
      showMissingMarker(store, serverId, conversation.channelId, gap);
    return;
  }
  if (pagesLeft === 0 || isBehindWindow) {
    void showOnlyAfterGap(store, serverId, target, gap, !isBehindWindow);
    return;
  }
  requestPageBefore(
    serverId,
    target,
    gap.to,
    { gap, pagesLeft: pagesLeft - 1 },
    false,
    gapEdgeMsgid(gap, "to", gap.to),
  );
}

// A gap longer than we fill at once goes above the messages on screen, where
// load more fills it as the reader scrolls up to it. Scrolling on brings the
// messages before it back from disk, so when one of them is not saved there
// (a whisper, say) they all stay and we mark the gap.
async function showOnlyAfterGap(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  gap: HistoryGap,
  canMark: boolean,
) {
  const conversation = findConversation(store, serverId, target);
  if (!conversation) return;
  const { key } = conversation;
  const isAfterGap = (message: Message) => messageTime(message) >= gap.to;
  const state = store.getState();
  const said = (state.historyWindows[key]?.present ?? state.messages[key] ?? [])
    .filter((message) => !isAfterGap(message))
    .filter(
      (message) => message.type === "message" || message.type === "notice",
    );
  const isEverySaved = await hasRowForEach(
    serverId,
    target.toLowerCase(),
    said.map((message) =>
      [message.msgid, ...(message.multilineMessageIds ?? [])].filter(
        (msgid) => msgid !== undefined,
      ),
    ),
  );
  if (!isEverySaved) {
    if (canMark)
      showMissingMarker(store, serverId, conversation.channelId, gap);
    return;
  }
  store.setState((state) => {
    const window = state.historyWindows[key];
    return window
      ? {
          historyWindows: {
            ...state.historyWindows,
            [key]: { ...window, present: window.present.filter(isAfterGap) },
          },
        }
      : {
          messages: {
            ...state.messages,
            [key]: (state.messages[key] ?? []).filter(isAfterGap),
          },
        };
  });
}

export function findConversation(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
) {
  const server = store.getState().servers.find((s) => s.id === serverId);
  const lower = target.toLowerCase();
  const id =
    server?.channels.find((c) => c.name.toLowerCase() === lower)?.id ??
    server?.privateChats?.find((pc) => pc.username.toLowerCase() === lower)?.id;
  return id ? { channelId: id, key: `${serverId}-${id}` } : undefined;
}

function showMissingMarker(
  store: StoreApi<AppState>,
  serverId: string,
  channelId: string,
  gap: HistoryGap,
) {
  store.getState().addMessage({
    id: `history-gap-${gap.id ?? gap.from}`,
    type: "system",
    content: "",
    tags: { [LOCAL_HISTORY_TAG]: HISTORY_GAP_CODE },
    timestamp: new Date(gap.from + 1),
    userId: "",
    channelId,
    serverId,
    reactions: [],
    replyMessage: null,
    mentioned: [],
  });
}

function persistHistoryAction(
  store: StoreApi<AppState>,
  serverId: string,
  action: HistoryAction,
) {
  switch (action.type) {
    case "rows":
      return saveRows(store, action.rows);
    case "redact":
      return deleteMessage(serverId, action.target, action.msgid);
    case "history-batch":
      return saveHistoryPage(
        store,
        serverId,
        action.target,
        action.rows,
        action.redacts,
        action.page,
      );
  }
}

function trackOutgoing(
  store: StoreApi<AppState>,
  serverId: string,
  line: string,
) {
  const request = /^CHATHISTORY (LATEST|BEFORE|AFTER|AROUND) (\S+)/.exec(line);
  if (request) {
    const target = request[2].toLowerCase();
    const queue = pendingRequests.get(conversationKey(serverId, target)) ?? [];
    const kind = request[1].toLowerCase() as "before" | "after" | "around";
    const [, msgid] = /^CHATHISTORY \S+ \S+ msgid=(\S+)/.exec(line) ?? [];
    queue.push(
      request[1] === "LATEST"
        ? {
            kind: "latest",
            newestStored: newestEventRows(serverId, target, 1).then(
              ([row]) => row,
            ),
          }
        : {
            kind,
            fill: nextGapFill,
            ...(msgid ? { msgid, msgidTime: nextMsgidTime } : {}),
            ...(kind === "before" ? { before: nextBefore } : {}),
          },
    );
    pendingRequests.set(conversationKey(serverId, target), queue);
    return;
  }
  // Without echo-message the server never sends our own lines back, so we
  // record what we sent as if it had.
  const sent = /^(?:(@\S+) )?(PRIVMSG (\S+) :(.*))$/.exec(line);
  if (sent && !ircClient.hasCapability(serverId, "echo-message")) {
    const nick = ircClient.getNick(serverId);
    if (!nick) return;
    const [, tags, rest, target, text] = sent;
    const source = `${nick}!${nick}@local`;
    for (const action of recorderFor(store, serverId).feed({
      line: `${tags ? `${tags} ` : ""}:${source} ${rest}`,
      command: "PRIVMSG",
      source,
      parv: [target, text],
      mtags: tags ? parseMessageTags(tags) : undefined,
    }))
      void persistHistoryAction(store, serverId, action);
  }
}

export function registerHistoryHandlers(store: StoreApi<AppState>): void {
  registeredStore = store;
  ircClient.on("parsedLine", ({ serverId, ...parsed }) => {
    if (!isEnabled(store)) return;
    for (const action of recorderFor(store, serverId).feed(parsed))
      void persistHistoryAction(store, serverId, action);
  });

  store.subscribe((state, previous) => {
    const update = moveArrivalsToPresent(store.getState());
    if (update) store.setState(update);
    if (state.globalSettings.ignoreList !== previous.globalSettings.ignoreList)
      readBackTo.clear();
    else if (readBackTo.size > 0 && state.servers !== previous.servers)
      forgetRemovedReadBacks(state);
  });

  ircClient.on("rawLine", ({ serverId, direction, line, afterWaiting }) => {
    if (direction !== "tx") return;
    const said = /^(?:@\S+ )?PRIVMSG (\S+) :/.exec(line);
    // A line that waited leaves long after the user sent it, so it leaves the view where they have moved since.
    if (said && !afterWaiting) showPresent(store, serverId, said[1]);
    if (isEnabled(store)) trackOutgoing(store, serverId, line);
  });

  // A line that has to wait is sent from the chat the user is in now, so that chat returns to the present as for a line that leaves at once.
  ircClient.on("lineQueued", ({ serverId, line }) => {
    const said = /^(?:@\S+ )?PRIVMSG (\S+) :/.exec(line);
    if (said) showPresent(store, serverId, said[1]);
  });

  ircClient.on("BATCH_START", ({ serverId, batchId, type, parameters }) => {
    const target = parameters?.[0];
    if (type !== "chathistory" || !target) return;
    if (batchId.startsWith(LOCAL_BATCH_PREFIX)) return;
    const [request] =
      pendingRequests.get(conversationKey(serverId, target)) ?? [];
    if (request && request.kind !== "latest" && request.fill?.isDiskOnly)
      ircClient.markDiskOnlyBatch(serverId, batchId);
  });

  // A refused CHATHISTORY opens no batch, so we drop its request here or the
  // next reply would be matched to it.
  const onRefusal = (serverId: string, code: string, context: string[]) => {
    const [subcommand] = context;
    const target =
      context.find(
        (part) => pendingRequests.get(conversationKey(serverId, part))?.length,
      ) ?? onlyChatAwaiting(serverId, subcommand);
    const refused =
      context.find((part) => findConversation(store, serverId, part)) ?? target;
    const request = target
      ? pendingRequests.get(conversationKey(serverId, target))?.shift()
      : undefined;
    // A server can list msgid among its references and still refuse a page asked by one, so we ask that page once by time before we read anything into the refusal.
    if (
      target &&
      request &&
      request.kind !== "latest" &&
      request.msgidTime !== undefined &&
      askAgainByTime(serverId, target, request, request.msgidTime)
    )
      return;
    const settled = refused
      ? [refused]
      : chatsLoadingUntracked(store, serverId, subcommand);
    // We cannot tell which of several chats a refusal is for, so each keeps its offer and can ask again.
    const isFinal = FINAL_REFUSALS.has(code) && settled.length === 1;
    for (const chat of settled)
      settleRefusedOffer(store, serverId, chat, isFinal, subcommand);
    if (target && request?.kind === "after" && FINAL_REFUSALS.has(code))
      void dropRefusedMillisecondGap(serverId, target, request.fill?.gap);
    if (request && request.kind !== "latest") request.fill?.onSettled?.(false);
  };
  ircClient.on("FAIL", ({ serverId, command, code, context }) => {
    if (command === "CHATHISTORY") onRefusal(serverId, code, context);
  });
  // A server can answer a history request as an unknown command, which we take for a refusal that names no chat.
  ircClient.on("CHATHISTORY_UNKNOWN", ({ serverId }) =>
    onRefusal(serverId, "UNKNOWN_COMMAND", []),
  );

  ircClient.on("connectionStateChange", ({ serverId, connectionState }) => {
    if (connectionState === "connected") {
      const server =
        store.getState().servers.find((s) => s.id === serverId) ??
        ircClient.servers.get(serverId);
      if (server) void adoptHistoryForServer(server);
      return;
    }
    ircClient.clearDiskOnlyBatches(serverId);
    // A request the closed socket dropped never answers, so the next page after a reconnect starts its own.
    for (const key of forwardFetches.keys())
      if (key.startsWith(`${serverId}\n`)) forwardFetches.delete(key);
    for (const [key, queue] of pendingRequests) {
      if (!key.startsWith(`${serverId}\n`)) continue;
      for (const request of queue)
        if (request.kind !== "latest") request.fill?.onSettled?.(false);
      pendingRequests.delete(key);
      setLoading(serverId, key.slice(serverId.length + 1), false);
    }
  });
}

async function searchableGaps(
  store: StoreApi<AppState>,
  scope: SearchScope,
): Promise<HistoryGap[]> {
  const state = store.getState();
  return (await fillableGaps())
    .filter(
      (gap) =>
        isInScope(scope, gap.server, gap.target.toLowerCase()) &&
        state.servers.some((s) => s.id === gap.server && s.isConnected) &&
        serverSupportsChathistory(state, gap.server) &&
        findConversation(store, gap.server, gap.target) !== undefined,
    )
    .sort((a, b) => b.to - a.to);
}

// We stop waiting at the timeout but keep the request queued, so a late reply
// still goes to disk and fills its gap.
function fetchGapPage(gap: HistoryGap): Promise<boolean> {
  return new Promise((resolve) => {
    const fill: GapFill = { gap, isDiskOnly: true };
    const timer = window.setTimeout(
      () => resolve(false),
      SEARCH_FILL_TIMEOUT_MS,
    );
    fill.onSettled = (isSaved) => {
      window.clearTimeout(timer);
      resolve(isSaved);
    };
    const msgid = gapEdgeMsgid(gap, "to", gap.to);
    if (!requestPageBefore(gap.server, gap.target, gap.to, fill, false, msgid))
      fill.onSettled(false);
  });
}

function fetchPageToDisk(
  serverId: string,
  target: string,
  subcommand: "AFTER" | "AROUND",
  time: number,
  gap?: HistoryGap,
): Promise<boolean> {
  return new Promise((resolve) => {
    const fill: GapFill = { gap, isDiskOnly: true };
    const timer = window.setTimeout(
      () => resolve(false),
      SEARCH_FILL_TIMEOUT_MS,
    );
    fill.onSettled = (isSaved) => {
      window.clearTimeout(timer);
      resolve(isSaved);
    };
    const msgid =
      subcommand === "AFTER" ? gapEdgeMsgid(gap, "from", time) : undefined;
    if (!requestPageAfter(serverId, target, subcommand, time, fill, msgid))
      fill.onSettled(false);
  });
}

type ForwardFetch = { isSent: Promise<void>; isSaved: Promise<boolean> };
const forwardFetches = new Map<string, ForwardFetch>();

// Paging newer and reading ahead of it ask for the same page past a gap's
// older edge, so a conversation shares the one request that is in flight.
function fetchForwardToDisk(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  time: number,
  gap: HistoryGap,
): ForwardFetch {
  const key = conversationKey(serverId, target);
  const inFlight = forwardFetches.get(key);
  if (inFlight) return inFlight;
  let markSent = () => {};
  const isSent = new Promise<void>((resolve) => {
    markSent = resolve;
  });
  const fetch: ForwardFetch = { isSent, isSaved: Promise.resolve(false) };
  forwardFetches.set(key, fetch);
  fetch.isSaved = (async () => {
    // A page that landed since the caller read the gap has moved its older edge, and asking from the old one would return rows we hold.
    const current = (await gapsServerCanFill(store, serverId, target)).find(
      (saved) => saved.id === gap.id,
    );
    if (!current) return true;
    // A disconnect dropped this fetch, or an earlier request for the gap is still queued, and a second copy of a page would be read as its answer.
    if (forwardFetches.get(key) !== fetch) return false;
    if (isGapBeingFilled(serverId, target, current.id)) return false;
    const page = fetchPageToDisk(
      serverId,
      target,
      "AFTER",
      Math.max(time, current.from),
      current,
    );
    markSent();
    return page;
  })().finally(() => {
    markSent();
    if (forwardFetches.get(key) === fetch) forwardFetches.delete(key);
  });
  return fetch;
}

// A notification can name a message older than the pages we loaded, so we ask
// the server for the page around it before we jump there.
export async function saveMessagesAround(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  time: number,
): Promise<boolean> {
  if (!isEnabled(store)) return false;
  const lower = target.toLowerCase();
  const isSaved = async () =>
    (await eventRowsBefore(serverId, lower, time, 1))[0]?.time === time;
  if (await isSaved()) return true;
  if (!serverSupportsChathistory(store.getState(), serverId)) return false;
  await fetchPageToDisk(serverId, target, "AROUND", time);
  return isSaved();
}

// A chat opens on its read marker: from the rows we saved when they cover it,
// otherwise from a page the server sends around it. A marker older than what
// the server keeps opens on the oldest message it still has after it.
export async function showMessagesFromReadMarker(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  marker: number,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!isEnabled(store)) return false;
  const lower = target.toLowerCase();
  await askAgainForMillisecondGaps(store, serverId, lower);
  const [lastRead] = await eventRowsBefore(serverId, lower, marker + 1, 1);
  const isMarkerInGap = (await gapsFor(serverId, lower)).some(
    (gap) => gap.from < marker && marker < gap.to,
  );
  const isSaved = lastRead?.time === marker && !isMarkerInGap;
  if (!isSaved && serverSupportsChathistory(store.getState(), serverId))
    await fetchPageToDisk(serverId, target, "AROUND", marker);
  const [firstUnread] = await eventRowsAfter(serverId, lower, marker, 1);
  if (!firstUnread) return false;
  const shown = await showSavedMessagesAround(
    store,
    serverId,
    target,
    firstUnread.time,
    isCurrent,
  );
  if (shown !== "loaded" || !isCurrent()) return false;
  // The last read message is gone from both the server and this device, so
  // we say messages before the first unread one may be missing.
  const [stillSaved] = await eventRowsBefore(serverId, lower, marker + 1, 1);
  const conversation = findConversation(store, serverId, target);
  if (stillSaved?.time !== marker && conversation)
    showMissingMarker(store, serverId, conversation.channelId, {
      id: -firstUnread.time,
      server: serverId,
      target: lower,
      from: firstUnread.time - 2,
      to: firstUnread.time,
      lost: true,
    });
  return true;
}

// While a search pane is open we fetch what the server still has for the gaps
// in its scope, newest gap first, and report the gaps left after every page
// so the results can refresh.
export function fillGapsForSearch(
  store: StoreApi<AppState>,
  scope: SearchScope,
  onProgress: (
    gaps: HistoryGap[],
    isFetching: boolean,
    pagesFetched: number,
  ) => void,
): () => void {
  let isCancelled = false;
  let pagesFetched = 0;
  let linesAsked = 0;
  const report = (gaps: HistoryGap[], isFetching: boolean) => {
    if (!isCancelled) onProgress(gaps, isFetching, pagesFetched);
  };
  void (async () => {
    if (!isEnabled(store)) return report([], false);
    while (linesAsked < SEARCH_FILL_MAX_LINES) {
      const gaps = await searchableGaps(store, scope);
      if (gaps.length === 0 || isCancelled) return report(gaps, false);
      report(gaps, true);
      if (pagesFetched > 0)
        await new Promise((r) => setTimeout(r, SEARCH_FILL_PACE_MS));
      if (isCancelled) return;
      if (!(await fetchGapPage(gaps[0]))) break;
      pagesFetched += 1;
      linesAsked += ircClient.chathistoryPageSize(gaps[0].server, true);
    }
    report(await searchableGaps(store, scope), false);
  })();
  return () => {
    isCancelled = true;
  };
}

// Our disk is the only source on a server without history, and for private
// chats on servers that keep channel history only, so we show its newest page
// the first time such a chat is opened in this session.
export function showSavedHistory(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
): void {
  const key = conversationKey(serverId, target);
  if (
    !isEnabled(store) ||
    (ircClient.isChannel(serverId, target) &&
      serverSupportsChathistory(store.getState(), serverId))
  )
    return;
  if (shownConversations.has(key)) return;
  shownConversations.add(key);
  void replayNewestPage(store, serverId, target);
}

function setLoading(serverId: string, target: string, isLoading: boolean) {
  ircClient.triggerEvent("CHATHISTORY_LOADING", {
    serverId,
    channelName: target,
    isLoading,
  });
}

async function replayRows(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  rows: HistoryRow[],
  beforeReplay: () => boolean = () => true,
  place?: HistoryPagePlace,
) {
  const msgids = rows.flatMap((row) => (row.msgid ? [row.msgid] : []));
  const reactions = msgids.length ? await refRowsFor(serverId, msgids) : [];
  if (!beforeReplay()) return;
  const ordered = [...rows, ...reactions].sort((a, b) => a.time - b.time);
  replayCounter += 1;
  const nick = ircClient.getNick(serverId);
  replayPlace = place;
  try {
    ircClient.replayLines(
      serverId,
      buildReplayLines(
        target,
        ordered,
        `${LOCAL_BATCH_PREFIX}${replayCounter}`,
        nick ? `${nick}!${nick}@local` : undefined,
      ),
    );
  } finally {
    replayPlace = undefined;
  }
  if (rows.length) {
    const oldest = rows[0].time;
    const newest = rows[rows.length - 1].time;
    await showLostGaps(
      store,
      serverId,
      target,
      (gap) => gap.from >= oldest && gap.from <= newest,
    );
  }
  await refreshHasMore(
    store,
    serverId,
    target,
    serverSupportsChathistory(store.getState(), serverId),
  );
}

async function showLostGaps(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  isShown: (gap: HistoryGap) => boolean,
) {
  const conversation = findConversation(store, serverId, target);
  if (!conversation) return;
  for (const gap of await gapsFor(serverId, target.toLowerCase()))
    if (gap.lost && isShown(gap))
      showMissingMarker(store, serverId, conversation.channelId, gap);
}

async function replayOlderDiskPage(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
): Promise<number> {
  const conversation = findConversation(store, serverId, target);
  const rows = await olderDiskRows(store, serverId, target, HISTORY_PAGE_SIZE);
  if (!conversation || rows.length === 0) return 0;
  const oldestShown = () =>
    store.getState().messages[conversation.key]?.[0]?.id;
  const wasOldest = oldestShown();
  await replayRows(store, serverId, target, rows);
  rememberReadBack(store, conversation.key, rows);
  // Nothing on the page showed, so we keep reading back until something does
  // or the history ends.
  if (oldestShown() === wasOldest)
    await loadOlderMessages(store, serverId, target, rows[0].time);
  return rows.length;
}

async function replayNewestPage(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
) {
  const rows = await newestEventRows(
    serverId,
    target.toLowerCase(),
    HISTORY_PAGE_SIZE,
  );
  if (rows.length) await replayRows(store, serverId, target, rows);
}

// A channel's older page goes to disk first and the list reads it back from
// there, so scrolling shows history through one path. Private chats skip
// this: we never save encrypted or services messages, which would vanish.
function diskFirstFill(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  oldestTime: number,
  gap: HistoryGap | undefined,
): GapFill {
  return {
    gap,
    isDiskOnly: true,
    onSettled: (isSaved, page) => {
      void (async () => {
        if (isSaved && (await replayOlderDiskPage(store, serverId, target)))
          return;
        // The page had lines but none we could save, so the server does not
        // send msgids: ask for the same page again, this time to be shown.
        if (page && page.size > 0 && historyWithoutMsgids.has(serverId)) {
          if (!requestPageBefore(serverId, target, oldestTime, gap && { gap }))
            setLoading(serverId, target, false);
          return;
        }
        // A page of lines we never show, like typing notices, can have history behind it.
        if (isSaved && page?.oldest !== undefined && page.oldest < oldestTime) {
          await loadOlderMessages(store, serverId, target, page.oldest);
          return;
        }
        setLoading(serverId, target, false);
        await showLostGaps(
          store,
          serverId,
          target,
          (lost) => lost.from < oldestTime,
        );
      })();
    },
  };
}

export async function loadOlderMessages(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  oldestTime: number,
): Promise<boolean> {
  const serverHasChathistory = serverSupportsChathistory(
    store.getState(),
    serverId,
  );
  // Nothing ends a load asked of a closed connection, so we ask the server only while connected.
  const isConnected = () =>
    store.getState().servers.some((s) => s.id === serverId && s.isConnected);
  if (!isEnabled(store)) {
    if (!serverHasChathistory || !isConnected()) return false;
    ircClient.requestChathistoryBefore(
      serverId,
      target,
      new Date(oldestTime).toISOString(),
      { msgid: shownOldestMsgid(store, serverId, target, oldestTime) },
    );
    return true;
  }
  setLoading(serverId, target, true);
  try {
    const conversation = findConversation(store, serverId, target);
    const readBack = conversation && readBackEdge(store, conversation.key);
    const before = Math.min(oldestTime, readBack?.time ?? oldestTime);
    const [olderRow] = await olderDiskRows(store, serverId, target, 1);
    const plan = planLoadMore({
      oldestTime: before,
      newestOlderRowTime: olderRow?.time,
      gaps: await gapsFor(serverId, target.toLowerCase()),
      hasChathistory: serverHasChathistory,
    });
    if (plan.kind === "disk") {
      if (await replayOlderDiskPage(store, serverId, target)) return true;
      setLoading(serverId, target, false);
      return false;
    }
    if (plan.kind === "server") {
      const msgid = plan.gap
        ? gapEdgeMsgid(plan.gap, "to", plan.before)
        : await heldMsgidAt(store, serverId, target, plan.before);
      const isSent =
        isConnected() &&
        requestPageBefore(
          serverId,
          target,
          plan.before,
          ircClient.isChannel(serverId, target) &&
            !historyWithoutMsgids.has(serverId)
            ? diskFirstFill(store, serverId, target, before, plan.gap)
            : plan.gap && { gap: plan.gap },
          true,
          msgid,
        );
      if (!isSent) setLoading(serverId, target, false);
      return isSent;
    }
    await refreshHasMore(store, serverId, target, false);
    setLoading(serverId, target, false);
    return false;
  } catch (error) {
    setLoading(serverId, target, false);
    throw error;
  }
}

const WINDOW_ROWS = 50;

async function nextGapAfter(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  time: number,
): Promise<HistoryGap | undefined> {
  return (await gapsServerCanFill(store, serverId, target))
    .filter((gap) => gap.to > time)
    .sort((a, b) => a.from - b.from)[0];
}
const WINDOW_KEEP_MESSAGES = 300;
let jumpCounter = 0;

export type SavedJump = "loaded" | "not-saved" | "not-found";

// We show a message that is not loaded inside a window of the saved rows
// around it, so a jump costs the same at any depth. When the rows after it
// already reach the newest saved one, the window joins the present instead.
export async function showSavedMessagesAround(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  time: number,
  isCurrentJump: () => boolean = () => true,
): Promise<SavedJump> {
  if (!isEnabled(store)) return "not-saved";
  const lower = target.toLowerCase();
  const before = await rowsAboveGap(
    store,
    serverId,
    lower,
    time,
    await eventRowsBefore(serverId, lower, time, WINDOW_ROWS),
  );
  const last = before[before.length - 1];
  const hole = await nextGapAfter(store, serverId, lower, time);
  const after = (
    await eventRowsAfter(
      serverId,
      lower,
      last?.time ?? time,
      WINDOW_ROWS,
      last?.id,
    )
  ).filter((row) => !hole || row.time <= hole.from);
  const rows = [...before, ...after];
  if (!rows.some((row) => row.time === time)) return "not-saved";
  const conversation = findConversation(store, serverId, target);
  if (!conversation) return "not-found";
  if (after.length < WINDOW_ROWS && !hole) {
    await replayRows(store, serverId, target, rows, () => {
      if (!isCurrentJump()) return false;
      showPresent(store, serverId, target);
      return true;
    });
    return "loaded";
  }
  const newest = rows[rows.length - 1];
  const jumpId = ++jumpCounter;
  await replayRows(store, serverId, target, rows, () => {
    if (!isCurrentJump()) return false;
    store.setState((state) => ({
      messages: { ...state.messages, [conversation.key]: [] },
      historyWindows: {
        ...state.historyWindows,
        [conversation.key]: {
          until: newest.time,
          untilRowId: newest.id,
          present:
            state.historyWindows[conversation.key]?.present ??
            state.messages[conversation.key] ??
            [],
          jumpId,
        },
      },
    }));
    return true;
  });
  return "loaded";
}

// A short page means the window has reached the newest saved row.
export async function loadNewerMessages(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
): Promise<void> {
  const conversation = findConversation(store, serverId, target);
  const window =
    conversation && store.getState().historyWindows[conversation.key];
  if (!conversation || !window) return;
  const shown = new Set(
    (store.getState().messages[conversation.key] ?? [])
      .filter((m) => messageTime(m) === window.until)
      .flatMap((m) => [m.msgid, ...(m.multilineMessageIds ?? [])]),
  );
  // A gap above the window holds messages only the server has, so we read
  // our rows up to it and then fetch forward from its older edge.
  const hole = await nextGapAfter(
    store,
    serverId,
    target.toLowerCase(),
    window.until,
  );
  const rows = (
    await eventRowsAfter(
      serverId,
      target.toLowerCase(),
      window.until,
      WINDOW_ROWS + shown.size,
      window.untilRowId,
    )
  )
    .filter((row) => !row.msgid || !shown.has(row.msgid))
    .filter((row) => !hole || row.time <= hole.from)
    .slice(0, WINDOW_ROWS);
  const isSameWindow = () => {
    const current = store.getState().historyWindows[conversation.key];
    return current?.until === window.until && current.jumpId === window.jumpId;
  };
  if (rows.length === 0 && hole) {
    if (
      serverSupportsChathistory(store.getState(), serverId) &&
      (await fetchForwardToDisk(
        store,
        serverId,
        target,
        Math.max(window.until, hole.from),
        hole,
      ).isSaved) &&
      isSameWindow()
    )
      await loadNewerMessages(store, serverId, target);
    return;
  }
  const newest = rows[rows.length - 1];
  let isShown = false;
  const showInWindow = () => {
    const current = store.getState().historyWindows[conversation.key];
    if (!current || !isSameWindow()) return false;
    store.setState((state) => ({
      historyWindows: {
        ...state.historyWindows,
        [conversation.key]: {
          ...current,
          until: newest.time,
          untilRowId: newest.id,
        },
      },
    }));
    isShown = true;
    return true;
  };
  if (rows.length < WINDOW_ROWS && !hole) {
    if (!isSameWindow()) return;
    // The last saved rows land while the window still stands, so the reader keeps their place when it joins the present.
    if (newest) {
      await replayRows(store, serverId, target, rows, showInWindow, "newest");
      const current = store.getState().historyWindows[conversation.key];
      if (
        !isShown ||
        current?.until !== newest.time ||
        current.jumpId !== window.jumpId
      )
        return;
    }
    joinWindowToPresent(store, conversation.key);
    if (serverSupportsChathistory(store.getState(), serverId))
      ircClient.requestChathistoryLatest(serverId, target);
    return;
  }
  await replayRows(store, serverId, target, rows, showInWindow, "newest");
  if (dropOldestInWindow(store, conversation.key))
    await refreshHasMore(store, serverId, target, false);
  if (isShown && hole)
    await readAheadOfGap(store, serverId, target, newest, hole);
}

// A page from the server takes a round trip, so we fetch the one past the gap
// while the last saved rows before it are still being read.
async function readAheadOfGap(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
  newest: HistoryRow,
  gap: HistoryGap,
) {
  const left = (
    await eventRowsAfter(
      serverId,
      target.toLowerCase(),
      newest.time,
      WINDOW_ROWS,
      newest.id,
    )
  ).filter((row) => row.time <= gap.from);
  if (left.length >= WINDOW_ROWS) return;
  await fetchForwardToDisk(
    store,
    serverId,
    target,
    Math.max(newest.time, gap.from),
    gap,
  ).isSent;
}

// We cap a window at WINDOW_KEEP_MESSAGES while paging newer, and the chat list
// corrects its scroll position for the dropped rows.
function dropOldestInWindow(store: StoreApi<AppState>, key: string): boolean {
  const { messages, historyWindows } = store.getState();
  const shown = messages[key] ?? [];
  if (!historyWindows[key] || shown.length <= WINDOW_KEEP_MESSAGES)
    return false;
  store.setState((state) => ({
    messages: {
      ...state.messages,
      [key]: (state.messages[key] ?? []).slice(-WINDOW_KEEP_MESSAGES),
    },
  }));
  return true;
}

// On a chathistory server we ask for the newest page as on join, so messages
// only the server has come back too.
export function showPresent(
  store: StoreApi<AppState>,
  serverId: string,
  target: string,
): void {
  const conversation = findConversation(store, serverId, target);
  const window =
    conversation && store.getState().historyWindows[conversation.key];
  if (!conversation || !window) return;
  store.setState((state) => {
    const { [conversation.key]: _, ...others } = state.historyWindows;
    return {
      historyWindows: others,
      messages: { ...state.messages, [conversation.key]: window.present },
    };
  });
  if (serverSupportsChathistory(store.getState(), serverId))
    ircClient.requestChathistoryLatest(serverId, target);
  else if (window.present.length === 0 && isEnabled(store))
    void replayNewestPage(store, serverId, target);
}

// A window paged down to the present joins it below, so the rows on screen stay.
function joinWindowToPresent(store: StoreApi<AppState>, key: string) {
  store.setState((state) => {
    const window = state.historyWindows[key];
    if (!window) return {};
    const { [key]: _, ...others } = state.historyWindows;
    return {
      historyWindows: others,
      messages: {
        ...state.messages,
        [key]: joinPresent(state.messages[key] ?? [], window.present),
      },
    };
  });
}

// Without a message id, the sender, time and text tell us it is the same row.
function joinPresent(present: Message[], arrived: Message[]): Message[] {
  const known = new Set(present.flatMap((m) => [m.id, m.msgid]));
  const isKnown = (m: Message) =>
    known.has(m.id) ||
    (m.msgid
      ? known.has(m.msgid)
      : present.some(
          (p) =>
            p.userId === m.userId &&
            p.content === m.content &&
            messageTime(p) === messageTime(m),
        ));
  return [...present, ...arrived.filter((m) => !isKnown(m))]
    .sort(compareMessageOrder)
    .slice(-MAX_MESSAGES_PER_CHANNEL);
}

// A chat showing the past keeps nothing newer than its window on screen, so
// we move whatever arrives into the present it shows again on return.
function moveArrivalsToPresent(state: AppState): Partial<AppState> | null {
  let { messages, historyWindows } = state;
  for (const [key, window] of Object.entries(state.historyWindows)) {
    const shown = state.messages[key] ?? [];
    const newest = shown[shown.length - 1];
    if (!newest || messageTime(newest) <= window.until) continue;
    messages = {
      ...messages,
      [key]: shown.filter((m) => messageTime(m) <= window.until),
    };
    historyWindows = {
      ...historyWindows,
      [key]: {
        ...window,
        present: joinPresent(
          window.present,
          shown.filter((m) => messageTime(m) > window.until),
        ),
      },
    };
  }
  return messages === state.messages ? null : { messages, historyWindows };
}
