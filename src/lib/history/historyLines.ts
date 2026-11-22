import { classifyInbound } from "../e2ee/classify";
import { E2EE_TAG } from "../e2ee/protocol";
import type { ParsedLine } from "../irc/IRCClient";
import { isChannelTarget } from "../ircUtils";
import type { HistoryGap, HistoryRow, NewHistoryRow } from "./historyDb";
import { OWN_LINE_TAG, stripTags, trailingOf } from "./searchFields";

export const LOCAL_BATCH_PREFIX = "obby-local-";
export const LOCAL_HISTORY_TAG = "obby-local";
export const HISTORY_GAP_CODE = "gap";
export const HISTORY_PAGE_SIZE = 100;

// Replayed rows may have scrolled out of memory while their msgid is still
// remembered, so a replay skips the seen-msgid check and relies on the merge.
export const isLocalReplay = (
  mtags: Record<string, string> | undefined,
): boolean => !!mtags?.batch?.startsWith(LOCAL_BATCH_PREFIX);

const REACTION_TAGS = ["+draft/react", "+draft/unreact", "+react", "+unreact"];
const DROPPED_TAGS = ["batch", "label"];
const WHISPER_TAGS = ["+channel-context", "+draft/channel-context"];
const SERVICES_NICKS = new Set(["q", "x", "global"]);
const CREDENTIAL_COMMAND =
  /^(identify|register|ghost|recover|regain|release|login|auth|authenticate|pass|oper|set\s+pass(word)?)\b/i;

// Services and server PMs carry passwords and account traffic, so they are
// never conversations we keep.
export function isServicesNick(nick: string): boolean {
  const lower = nick.toLowerCase();
  return lower.endsWith("serv") || SERVICES_NICKS.has(lower);
}

export type { ParsedLine };

export interface RecorderEnv {
  ownNick: () => string | undefined;
  isOpenConversation: (target: string) => boolean;
  hasChathistory: () => boolean;
  chantypes: () => string;
  isEncryptedPm: (nick: string) => boolean;
  now: () => number;
}

export type HistoryAction =
  | { type: "rows"; rows: NewHistoryRow[] }
  | { type: "redact"; target: string; msgid: string }
  | {
      type: "history-batch";
      target: string;
      rows: NewHistoryRow[];
      redacts: string[];
      page: HistoryPage;
    };

// Everything a server page held, stored or not, so page fullness and gap
// edges count the joins and parts we leave off disk. The edges come from the
// server's own times only, since a line we had to time ourselves says nothing
// about the stretch of history the page covers.
export interface HistoryPage {
  size: number;
  oldest: number | undefined;
  newest: number | undefined;
  msgids: string[];
}

interface OpenBatch {
  type: string;
  params: string[];
  source: string;
  mtags: Record<string, string> | undefined;
  hasReceiveTime: boolean;
  startLine: string;
  lines: string[];
  rows: NewHistoryRow[];
  redacts: string[];
  size: number;
  oldest: number | undefined;
  newest: number | undefined;
  msgids: string[];
}

const nickOf = (source: string) => source.split("!")[0];

const isTimeTag = (tag: string) => tag.split("=")[0] === "time";

// A replay reads the time from the saved line, so the line carries one time
// tag that says what the row's own time says.
function withRowTime(tags: string[], time: number): string[] {
  const timeTags = tags.filter(isTimeTag);
  const isRowTime =
    timeTags.length === 1 &&
    Date.parse(timeTags[0].slice("time=".length)) === time;
  return isRowTime
    ? tags
    : [
        ...tags.filter((tag) => !isTimeTag(tag)),
        `time=${new Date(time).toISOString()}`,
      ];
}

function splitTags(line: string): { tags: string[]; rest: string } {
  if (!line.startsWith("@")) return { tags: [], rest: line };
  const space = line.indexOf(" ");
  return {
    tags: line.slice(1, space).split(";").filter(Boolean),
    rest: line.slice(space + 1),
  };
}

// We rewrite the raw tag string so escaped tag values stay byte-identical.
export function normalizeLine(
  line: string,
  time: number,
  isOwn = false,
): string {
  const { tags: lineTags, rest } = splitTags(line);
  const tags = withRowTime(
    lineTags.filter((tag) => !DROPPED_TAGS.includes(tag.split("=")[0])),
    time,
  );
  if (isOwn) tags.push(`${OWN_LINE_TAG}=1`);
  return `@${tags.join(";")} ${rest}`;
}

// A saved line can hold a time that is no date, or more than one time, next
// to the time we filed its row under, and the row's time is the one we show.
function withSavedTime(line: string, time: number): string {
  const { tags, rest } = splitTags(line);
  const timed = withRowTime(tags, time);
  return timed === tags ? line : `@${timed.join(";")} ${rest}`;
}

// Our nick may differ between sessions, so a replayed line we sent shows the
// nick we have now.
function withCurrentSource(line: string, ownSource: string): string {
  const space = line.indexOf(" ");
  if (
    !line.startsWith("@") ||
    !line.slice(1, space).split(";").includes(`${OWN_LINE_TAG}=1`)
  )
    return line;
  const rest = line.slice(space + 1);
  return rest.startsWith(":")
    ? `${line.slice(0, space)} :${ownSource}${rest.slice(rest.indexOf(" "))}`
    : line;
}

export function withReplayTags(line: string, batchId: string): string {
  const extra = `batch=${batchId};${LOCAL_HISTORY_TAG}=1`;
  return line.startsWith("@")
    ? `@${extra};${line.slice(1)}`
    : `@${extra} ${line}`;
}

function lineTime(mtags: Record<string, string> | undefined, now: number) {
  const parsed = mtags?.time ? Date.parse(mtags.time) : Number.NaN;
  return Number.isNaN(parsed) ? now : parsed;
}

export class HistoryRecorder {
  private batches = new Map<string, OpenBatch>();
  private replayBatches = new Set<string>();

  constructor(
    private serverId: string,
    private env: RecorderEnv,
  ) {}

  feed(parsed: ParsedLine): HistoryAction[] {
    const { command, parv, mtags } = parsed;
    const batchId = mtags?.batch;
    if (command === "BATCH") {
      return this.isReplayBatchLine(parv[0] ?? "", batchId)
        ? []
        : this.feedBatch(parsed);
    }
    if (isLocalReplay(mtags) || (batchId && this.replayBatches.has(batchId)))
      return [];

    const outer = batchId ? this.batches.get(batchId) : undefined;
    if (outer && isMultiline(outer.type)) {
      outer.lines.push(parsed.line);
      return [];
    }
    // A search answer holds scattered old lines, and saving them would make
    // the stretches between them look like history we already have.
    if (outer?.type === "soju.im/search") return [];
    if (outer?.type === "chathistory") countPageItem(outer, parsed);
    const historyTarget =
      outer?.type === "chathistory" ? outer.params[0] : undefined;

    if (command === "REDACT") {
      const target = this.conversationOf(parsed, parv[0], historyTarget);
      if (!target || !parv[1]) return [];
      // A redaction inside a history page waits for the page's rows, which
      // we only write when the page ends.
      if (outer?.type === "chathistory") {
        outer.redacts.push(parv[1]);
        return [];
      }
      return [{ type: "redact", target, msgid: parv[1] }];
    }

    const rows = this.rowsFor(parsed, historyTarget);
    if (outer?.type === "chathistory") {
      outer.rows.push(...rows);
      return [];
    }
    return rows.length ? [{ type: "rows", rows }] : [];
  }

  // A replay batch and every batch opened inside it are ours, including the
  // multiline batches of stored rows, so none of their lines are recorded.
  private isReplayBatchLine(ref: string, outerId: string | undefined) {
    const id = ref.slice(1);
    if (ref.startsWith("-")) return this.replayBatches.delete(id);
    const isOurs =
      id.startsWith(LOCAL_BATCH_PREFIX) ||
      (!!outerId && this.replayBatches.has(outerId));
    if (isOurs) this.replayBatches.add(id);
    return isOurs;
  }

  private feedBatch(parsed: ParsedLine): HistoryAction[] {
    const ref = parsed.parv[0] ?? "";
    const id = ref.slice(1);
    if (ref.startsWith("+")) {
      const outerId = parsed.mtags?.batch;
      const outer = outerId ? this.batches.get(outerId) : undefined;
      if (outer?.type === "chathistory") countPageItem(outer, parsed);
      this.batches.set(id, {
        type: parsed.parv[1] ?? "",
        params: parsed.parv.slice(2),
        source: parsed.source,
        mtags: parsed.mtags,
        hasReceiveTime: !!parsed.hasReceiveTime,
        startLine: parsed.line,
        lines: [],
        rows: [],
        redacts: [],
        size: 0,
        oldest: undefined,
        newest: undefined,
        msgids: [],
      });
      if (outer && isMultiline(outer.type)) outer.lines.push(parsed.line);
      return [];
    }

    const batch = this.batches.get(id);
    this.batches.delete(id);
    if (!batch) return [];

    if (batch.type === "chathistory") {
      const target = batch.params[0];
      return target
        ? [
            {
              type: "history-batch",
              target: target.toLowerCase(),
              rows: batch.rows,
              redacts: batch.redacts,
              page: {
                size: batch.size,
                oldest: batch.oldest,
                newest: batch.newest,
                msgids: batch.msgids,
              },
            },
          ]
        : [];
    }
    if (!isMultiline(batch.type)) return [];

    const outerId = batch.mtags?.batch;
    const outer = outerId ? this.batches.get(outerId) : undefined;
    const historyTarget =
      outer?.type === "chathistory" ? outer.params[0] : undefined;
    const row = this.multilineRow(batch, parsed.line, historyTarget);
    if (!row) return [];
    if (outer?.type === "chathistory") {
      outer.rows.push(row);
      return [];
    }
    return [{ type: "rows", rows: [row] }];
  }

  private multilineRow(
    batch: OpenBatch,
    endLine: string,
    historyTarget: string | undefined,
  ): NewHistoryRow | undefined {
    const body = batch.lines.map(trailingOf).join("");
    const target = this.conversationOf(batch, batch.params[0], historyTarget);
    if (!target || !this.isStorable(batch.mtags, body, target, batch.source))
      return;
    const time = lineTime(batch.mtags, this.env.now());
    const raw = [
      normalizeLine(batch.startLine, time, this.isOwn(batch.source)),
      ...batch.lines,
      endLine,
    ].join("\r\n");
    return this.row(target, time, batch.mtags, raw, {
      hasReceiveTime: !!historyTarget && batch.hasReceiveTime,
    });
  }

  private rowsFor(
    parsed: ParsedLine,
    historyTarget: string | undefined,
  ): NewHistoryRow[] {
    const { command, parv, mtags, source } = parsed;
    const time = lineTime(mtags, this.env.now());
    const raw = normalizeLine(parsed.line, time, this.isOwn(source));
    const make = (target: string, ref?: string) =>
      this.row(target, time, mtags, raw, {
        ref,
        hasReceiveTime: !!historyTarget && !!parsed.hasReceiveTime,
      });

    // We keep conversation content only. Membership and channel-state events
    // are most of the volume and add nothing to scrollback or search.
    switch (command) {
      case "PRIVMSG":
      case "NOTICE": {
        const text = parv[1] ?? "";
        if (text.startsWith("\x01") && !text.startsWith("\x01ACTION"))
          return [];
        if (command === "NOTICE" && !historyTarget && !this.isChannel(parv[0]))
          return [];
        const target = this.conversationOf(parsed, parv[0], historyTarget);
        return target && this.isStorable(mtags, text, target, source)
          ? [make(target)]
          : [];
      }
      case "TAGMSG": {
        if (!REACTION_TAGS.some((tag) => mtags?.[tag] !== undefined)) return [];
        if (mtags?.[E2EE_TAG] !== undefined) return [];
        const ref = mtags?.["+draft/reply"] ?? mtags?.["+reply"];
        const target = this.conversationOf(parsed, parv[0], historyTarget);
        return target && ref && this.isStorable(mtags, "", target, source)
          ? [make(target, ref)]
          : [];
      }
      default:
        return [];
    }
  }

  // A private conversation is keyed by the other party, whichever side sent.
  private conversationOf(
    parsed: Pick<ParsedLine, "source">,
    target: string | undefined,
    historyTarget: string | undefined,
  ): string | undefined {
    if (historyTarget) return historyTarget.toLowerCase();
    if (!target) return;
    if (this.isChannel(target)) return target.toLowerCase();
    const sender = nickOf(parsed.source);
    const own = this.env.ownNick();
    const other =
      own && sender.toLowerCase() === own.toLowerCase() ? target : sender;
    return other.toLowerCase();
  }

  private isChannel(target: string | undefined): boolean {
    return isChannelTarget(target, this.env.chantypes());
  }

  // A chathistory server matches our rows back only by msgid, so we skip
  // lines without one there.
  private isStorable(
    mtags: Record<string, string> | undefined,
    body: string,
    target: string,
    source: string,
  ): boolean {
    if (this.env.hasChathistory() && !mtags?.msgid) return false;
    if (WHISPER_TAGS.some((tag) => mtags?.[tag] !== undefined)) return false;
    if (
      classifyInbound({ mtags, body: body || undefined }).scheme !== "plaintext"
    )
      return false;
    if (!this.env.isOpenConversation(target)) return false;
    if (this.isChannel(target)) return true;
    const isFromServer = !source.includes("!");
    return (
      !isFromServer &&
      !isServicesNick(target) &&
      !isServicesNick(nickOf(source)) &&
      !CREDENTIAL_COMMAND.test(body.trim()) &&
      !this.env.isEncryptedPm(target)
    );
  }

  private isOwn(source: string): boolean {
    const own = this.env.ownNick();
    return !!own && nickOf(source).toLowerCase() === own.toLowerCase();
  }

  private row(
    target: string,
    time: number,
    mtags: Record<string, string> | undefined,
    raw: string,
    { ref, hasReceiveTime }: { ref?: string; hasReceiveTime?: boolean } = {},
  ): NewHistoryRow {
    const msgid = mtags?.msgid;
    return {
      server: this.serverId,
      target,
      time,
      key: msgid ?? `${time}|${stripTags(raw)}`,
      ...(msgid ? { msgid } : {}),
      ...(ref ? { ref } : {}),
      ...(hasReceiveTime ? { hasReceiveTime: true as const } : {}),
      raw,
    };
  }
}

function countPageItem(
  batch: OpenBatch,
  { mtags, hasReceiveTime }: Pick<ParsedLine, "mtags" | "hasReceiveTime">,
) {
  batch.size += 1;
  if (mtags?.msgid) batch.msgids.push(mtags.msgid);
  const time =
    mtags?.time && !hasReceiveTime ? Date.parse(mtags.time) : Number.NaN;
  if (Number.isNaN(time)) return;
  if (batch.oldest === undefined || time < batch.oldest) batch.oldest = time;
  if (batch.newest === undefined || time > batch.newest) batch.newest = time;
}

function isMultiline(type: string) {
  return type === "draft/multiline" || type === "multiline";
}

// Wraps stored rows in a chathistory batch so the normal handlers rebuild
// messages, reactions and replies without touching live state.
export function buildReplayLines(
  target: string,
  rows: Pick<HistoryRow, "raw" | "time">[],
  batchId: string,
  ownSource?: string,
): string[] {
  const lines = [`BATCH +${batchId} chathistory ${target}`];
  for (const row of rows) {
    const [first, ...rest] = row.raw.split("\r\n");
    const timed = withSavedTime(first, row.time);
    const line = ownSource ? withCurrentSource(timed, ownSource) : timed;
    lines.push(withReplayTags(line, batchId), ...rest);
  }
  lines.push(`BATCH -${batchId}`);
  return lines;
}

type LoadMorePlan =
  | { kind: "disk" }
  | { kind: "server"; gap?: HistoryGap; before: number }
  | { kind: "none" };

// We prefer a gap the server can still fill, then our disk, then the server.
// A gap counts once its lower edge is below what is on screen, since server
// event lines can sit older than the gap's upper edge.
export function planLoadMore(input: {
  oldestTime: number;
  newestOlderRowTime: number | undefined;
  gaps: HistoryGap[];
  hasChathistory: boolean;
}): LoadMorePlan {
  const { oldestTime, newestOlderRowTime, gaps, hasChathistory } = input;
  const gap = gaps
    .filter((g) => !g.lost && g.from < oldestTime)
    .sort((a, b) => b.to - a.to)[0];
  const isDiskAboveGap =
    newestOlderRowTime !== undefined && (!gap || newestOlderRowTime > gap.from);
  if (gap && hasChathistory && !isDiskAboveGap)
    return { kind: "server", gap, before: Math.min(gap.to, oldestTime) };
  if (newestOlderRowTime !== undefined) return { kind: "disk" };
  return hasChathistory
    ? { kind: "server", before: oldestTime }
    : { kind: "none" };
}

type GapDecision = { kind: "none" } | { kind: "add"; from: number; to: number };

// After the newest page from the server: when it starts after the newest row
// we had when we asked, the messages in between are not on disk.
export function decideAfterLatest(input: {
  newestStoredTime: number | undefined;
  page: Pick<HistoryPage, "size" | "oldest">;
}): GapDecision {
  const { newestStoredTime, page } = input;
  if (newestStoredTime === undefined || page.oldest === undefined)
    return { kind: "none" };
  if (page.oldest <= newestStoredTime) return { kind: "none" };
  return { kind: "add", from: newestStoredTime, to: page.oldest };
}

// After a page fetched forward into a gap from its older edge: it closes once
// the page reaches rows we already had, otherwise its older edge moves up.
export function decideAfterForwardFill(input: {
  gap: HistoryGap;
  page: Pick<HistoryPage, "oldest" | "newest">;
  inserted: boolean[];
}): { kind: "close" } | { kind: "keep" } | { kind: "shrink"; from: number } {
  const { gap, page, inserted } = input;
  if (page.newest === undefined || page.newest >= gap.to)
    return { kind: "close" };
  // A page asked from an edge the gap has moved past starts with rows we hold, which says nothing about the far side.
  const startsBeforeGap = page.oldest !== undefined && page.oldest <= gap.from;
  if (startsBeforeGap && page.newest <= gap.from) return { kind: "keep" };
  if (!startsBeforeGap && inserted.some((wasNew) => !wasNew))
    return { kind: "close" };
  return { kind: "shrink", from: page.newest };
}

type GapFillDecision =
  | { kind: "close" }
  | { kind: "shrink"; to: number; lost: boolean };

// After a server page fetched into a gap: it closes once the page reaches
// rows we already had, and it is lost once the server returns nothing older.
// Servers may return fewer messages than asked (a multiline message can count
// as several), so we treat only an empty page as the end of their history.
export function decideAfterGapFill(input: {
  gap: HistoryGap;
  page: Pick<HistoryPage, "size" | "oldest">;
  inserted: boolean[];
}): GapFillDecision {
  const { gap, page, inserted } = input;
  if (inserted.some((wasNew) => !wasNew)) return { kind: "close" };
  if (page.oldest === undefined)
    return { kind: "shrink", to: gap.to, lost: true };
  if (page.oldest <= gap.from) return { kind: "close" };
  return { kind: "shrink", to: page.oldest, lost: false };
}
