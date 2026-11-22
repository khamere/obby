import {
  addBytes,
  awaitRequest,
  GAPS,
  META,
  ROWS,
  readBytes,
  TERMS,
} from "./idb";
import { serverTimeOf, splitTags, stripTags } from "./searchFields";
import {
  backfillChunk,
  indexRow,
  isBackfilling,
  readSavedSenders,
  rowBytes,
  startBackfill,
  unindexRow,
  withSearchColumns,
} from "./searchIndex";

export interface HistoryRow {
  id: number;
  server: string;
  target: string;
  time: number;
  key: string;
  msgid?: string;
  ref?: string;
  // The line came in a history page without a usable time from the server, so
  // the row sits at the time we received it.
  hasReceiveTime?: true;
  raw: string;
  bytes: number;
  nick?: string;
  text?: string;
  hasLink?: true;
  isOwn?: true;
  replyTo?: string;
  replyToOwn?: 1;
}

type SearchColumn =
  | "nick"
  | "text"
  | "hasLink"
  | "isOwn"
  | "replyTo"
  | "replyToOwn";

export interface HistoryGap {
  id: number;
  server: string;
  target: string;
  from: number;
  to: number;
  lost: boolean;
  // The lines a server page stopped at on each side, which name the edge
  // exactly where more lines share its millisecond.
  fromMsgid?: string;
  toMsgid?: string;
}

export type NewHistoryRow = Omit<HistoryRow, "id" | "bytes" | SearchColumn>;

const PRUNE_TARGET = 0.9;
const QUOTA_RETRY_TARGET = 0.8;
// Every other read and write waits while one step deletes its rows, at one to
// two milliseconds a row, so we keep a step near a quarter of a second.
export const PRUNE_STEP_ROWS = 150;
const PRUNE_STEP_PAUSE_MS = 50;

interface PruneStep {
  freed: number;
  remaining: number;
  ranOutOfRows: boolean;
}

interface Trim {
  limitBytes: number;
  done: Promise<void>;
}

let dbPromise: Promise<IDBDatabase> | undefined;
let chain: Promise<unknown> = Promise.resolve();
let trim: Trim | undefined;

function createV1(db: IDBDatabase) {
  const rows = db.createObjectStore(ROWS, {
    keyPath: "id",
    autoIncrement: true,
  });
  rows.createIndex("conv", ["server", "target", "time"]);
  rows.createIndex("dedupe", ["server", "target", "key"], { unique: true });
  rows.createIndex("time", "time");
  rows.createIndex("server", "server");
  rows.createIndex("ref", ["server", "ref"]);
  rows.createIndex("msgid", ["server", "target", "msgid"]);
  const gaps = db.createObjectStore(GAPS, {
    keyPath: "id",
    autoIncrement: true,
  });
  gaps.createIndex("conv", ["server", "target"]);
  db.createObjectStore(META, { keyPath: "name" });
}

function createV2(db: IDBDatabase, tx: IDBTransaction) {
  const rows = tx.objectStore(ROWS);
  rows.createIndex("nick", ["nick", "time"]);
  rows.createIndex("serverTime", ["server", "time"]);
  rows.createIndex("reply", ["server", "target", "replyTo"]);
  rows.createIndex("replyToOwn", ["replyToOwn", "time"]);
  db.createObjectStore(TERMS, { keyPath: ["term", "time", "rowId"] });
}

// Versions 1 and 2 marked a gap lost whenever the server returned a short
// page, which servers do for many reasons, so we let the server answer again.
function reopenLostGaps(tx: IDBTransaction) {
  const cursorRequest = tx.objectStore(GAPS).openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    if (cursor.value.lost) cursor.update({ ...cursor.value, lost: false });
    cursor.continue();
  };
}

function upgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number) {
  if (oldVersion < 1) createV1(db);
  if (oldVersion < 2) createV2(db, tx);
  if (oldVersion === 1) startBackfill(tx);
  if (oldVersion >= 1 && oldVersion < 3) reopenLostGaps(tx);
}

// Another tab on an older version blocks our upgrade until it closes, so we
// fail this call and open again on the next one. We close our connection when
// a newer tab asks to upgrade, and reopen on the next call.
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const forget = () => {
    if (dbPromise === opening) dbPromise = undefined;
  };
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("obby-history", 3);
    let isBlocked = false;
    open.onupgradeneeded = (event) =>
      upgrade(
        open.result,
        open.transaction as IDBTransaction,
        event.oldVersion,
      );
    open.onblocked = () => {
      isBlocked = true;
      reject(new DOMException("history database is blocked", "AbortError"));
    };
    open.onsuccess = () => {
      const db = open.result;
      if (isBlocked) return db.close();
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget;
      resolve(db);
      setTimeout(continueBackfill, 0);
    };
    open.onerror = () => reject(open.error);
  })
    .then(async (db) => {
      // The merge is a repair, so a failure leaves the records as they are.
      await mergeAllGaps(db).catch((error: unknown) =>
        console.warn("history gap merge failed", error),
      );
      return db;
    })
    .catch((error: unknown) => {
      forget();
      throw error;
    });
  dbPromise = opening;
  return opening;
}

function enqueue<T>(
  fallback: T,
  op: (db: IDBDatabase) => Promise<T>,
): Promise<T> {
  if (typeof indexedDB === "undefined") return Promise.resolve(fallback);
  const result = chain.then(openDb).then(op);
  chain = result.catch(() => undefined);
  return result;
}

export function whenHistoryIdle(): Promise<void> {
  return chain.then(() => undefined);
}

function inTx<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error);
    fn(tx).then(
      (value) => {
        result = value;
      },
      (error: unknown) => reject(error),
    );
  });
}

function walk(
  source: IDBIndex | IDBObjectStore,
  range: IDBKeyRange | undefined,
  direction: IDBCursorDirection,
  visit: (cursor: IDBCursorWithValue) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = source.openCursor(range, direction);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && visit(cursor)) cursor.continue();
      else resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

function convRange(server: string, target: string, from: number, to: number) {
  return IDBKeyRange.bound([server, target, from], [server, target, to]);
}

const wholeServer = (server: string) =>
  IDBKeyRange.bound([server], [server, []]);

function addUnlessDuplicate(
  store: IDBObjectStore,
  value: unknown,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = store.add(value);
    request.onsuccess = () => resolve(request.result as number);
    request.onerror = (event) => {
      if (request.error?.name !== "ConstraintError")
        return reject(request.error);
      event.preventDefault();
      resolve(undefined);
    };
  });
}

function insertRows(
  db: IDBDatabase,
  rows: NewHistoryRow[],
): Promise<boolean[]> {
  return inTx(db, [ROWS, TERMS, META], "readwrite", async (tx) => {
    const store = tx.objectStore(ROWS);
    const inserted: boolean[] = [];
    let added = 0;
    for (const row of rows) {
      const { record, terms } = await withSearchColumns(store, row);
      const bytes = rowBytes(record, terms);
      const id = await addUnlessDuplicate(store, { ...record, bytes });
      inserted.push(id !== undefined);
      if (id === undefined) continue;
      added += bytes;
      await indexRow(tx, record, id, terms);
    }
    await addBytes(tx, added);
    return inserted;
  });
}

function continueBackfill() {
  void enqueue(false, (db) =>
    inTx(db, [ROWS, TERMS, META], "readwrite", backfillChunk),
  ).then((hasMore) => {
    if (hasMore) setTimeout(continueBackfill, 0);
  });
}

export function readSearchIndex<T>(
  fallback: T,
  read: (
    rows: IDBObjectStore,
    terms: IDBObjectStore,
    isIndexing: boolean,
  ) => Promise<T>,
): Promise<T> {
  return enqueue(fallback, (db) =>
    inTx(db, [ROWS, TERMS, META], "readonly", async (tx) =>
      read(
        tx.objectStore(ROWS),
        tx.objectStore(TERMS),
        await isBackfilling(tx),
      ),
    ),
  );
}

function eventRows(
  db: IDBDatabase,
  range: IDBKeyRange,
  direction: IDBCursorDirection,
  limit: number,
  skip: (row: HistoryRow) => boolean = () => false,
): Promise<HistoryRow[]> {
  return inTx(db, [ROWS], "readonly", async (tx) => {
    const found: HistoryRow[] = [];
    if (limit > 0) {
      const index = tx.objectStore(ROWS).index("conv");
      await walk(index, range, direction, (cursor) => {
        const row = cursor.value as HistoryRow;
        if (row.ref === undefined && !skip(row)) found.push(row);
        return found.length < limit;
      });
    }
    return found;
  });
}

function deleteRows(tx: IDBTransaction, rows: HistoryRow[]): Promise<void> {
  const store = tx.objectStore(ROWS);
  for (const row of rows) {
    store.delete(row.id);
    unindexRow(tx, row);
  }
  return addBytes(tx, -rows.reduce((sum, row) => sum + row.bytes, 0));
}

function usageDb(db: IDBDatabase): Promise<number> {
  return inTx(db, [META], "readonly", readBytes);
}

// We drop the gaps left below the oldest row in the transaction that deletes
// the rows, so the database is whole whenever the page closes.
function pruneDb(
  db: IDBDatabase,
  targetBytes: number,
  maxRows = Number.POSITIVE_INFINITY,
): Promise<PruneStep> {
  return inTx(db, [ROWS, GAPS, META, TERMS], "readwrite", async (tx) => {
    const before = await readBytes(tx);
    let remaining = before;
    let deleted = 0;
    let ranOutOfRows = true;
    const trimmed = new Map<string, [server: string, target: string]>();
    const rows = tx.objectStore(ROWS);
    await walk(rows.index("time"), undefined, "next", (cursor) => {
      if (remaining <= targetBytes || deleted >= maxRows) {
        ranOutOfRows = false;
        return false;
      }
      const row = cursor.value as HistoryRow;
      remaining -= row.bytes;
      deleted++;
      trimmed.set(conversationOf(row), [row.server, row.target]);
      unindexRow(tx, row);
      cursor.delete();
      return true;
    });
    await awaitRequest(
      tx.objectStore(META).put({ name: "bytes", value: remaining }),
    );

    // Only a conversation we deleted from can gain a stale gap, so the full
    // pass over every gap waits for the step that ends the trim.
    const isLastStep = ranOutOfRows || remaining <= targetBytes;
    const gaps = tx.objectStore(GAPS);
    const conv = rows.index("conv");
    const candidates = isLastStep
      ? await awaitRequest<HistoryGap[]>(gaps.getAll())
      : (
          await Promise.all(
            [...trimmed.values()].map((conversation) =>
              awaitRequest<HistoryGap[]>(
                gaps.index("conv").getAll(IDBKeyRange.only(conversation)),
              ),
            ),
          )
        ).flat();
    for (const gap of candidates) {
      const range = convRange(
        gap.server,
        gap.target,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      );
      const oldest = await awaitRequest(conv.openCursor(range));
      if (!oldest || gap.to < (oldest.value as HistoryRow).time) {
        gaps.delete(gap.id);
      }
    }
    return { freed: before - remaining, remaining, ranOutOfRows };
  });
}

const conversationOf = ({ server, target }: HistoryRow | HistoryGap) =>
  `${server}\n${target}`;

export function appendRows(rows: NewHistoryRow[]): Promise<boolean[]> {
  return enqueue(
    rows.map(() => false),
    async (db) => {
      try {
        return await insertRows(db, rows);
      } catch (error) {
        const quotaExceeded =
          error instanceof DOMException && error.name === "QuotaExceededError";
        if (!quotaExceeded) throw error;
        await pruneDb(db, (await usageDb(db)) * QUOTA_RETRY_TARGET);
        return insertRows(db, rows);
      }
    },
  );
}

export function eventRowsBefore(
  server: string,
  target: string,
  beforeTime: number,
  limit: number,
): Promise<HistoryRow[]> {
  return enqueue([], async (db) =>
    (
      await eventRows(
        db,
        convRange(server, target, Number.NEGATIVE_INFINITY, beforeTime),
        "prev",
        limit,
      )
    ).reverse(),
  );
}

// Rows from afterTime on, oldest first. Rows sharing a millisecond come in id
// order, so passing the id of the last row we have resumes right after it.
export function eventRowsAfter(
  server: string,
  target: string,
  afterTime: number,
  limit: number,
  afterId?: number,
): Promise<HistoryRow[]> {
  return enqueue([], (db) =>
    eventRows(
      db,
      convRange(server, target, afterTime, Number.POSITIVE_INFINITY),
      "next",
      limit,
      (row) =>
        afterId !== undefined && row.time === afterTime && row.id <= afterId,
    ),
  );
}

export function newestEventRows(
  server: string,
  target: string,
  limit: number,
): Promise<HistoryRow[]> {
  return eventRowsBefore(server, target, Number.POSITIVE_INFINITY, limit);
}

export function rowByMsgid(
  server: string,
  target: string,
  msgid: string,
): Promise<HistoryRow | undefined> {
  return enqueue(undefined, (db) =>
    inTx(db, [ROWS], "readonly", async (tx) => {
      const rows = await awaitRequest<HistoryRow[]>(
        tx
          .objectStore(ROWS)
          .index("msgid")
          .getAll(IDBKeyRange.only([server, target, msgid])),
      );
      return rows.sort((a, b) => a.time - b.time || a.id - b.id)[0];
    }),
  );
}

// Whether each message has a saved row under one of its msgids. We stop at
// the first one that has none.
export function hasRowForEach(
  server: string,
  target: string,
  messages: string[][],
): Promise<boolean> {
  return enqueue(false, (db) =>
    inTx(db, [ROWS], "readonly", async (tx) => {
      const index = tx.objectStore(ROWS).index("msgid");
      for (const msgids of messages) {
        let isSaved = false;
        for (const msgid of msgids) {
          const count = await awaitRequest<number>(
            index.count(IDBKeyRange.only([server, target, msgid])),
          );
          if (count > 0) {
            isSaved = true;
            break;
          }
        }
        if (!isSaved) return false;
      }
      return true;
    }),
  );
}

export function refRowsFor(
  server: string,
  msgids: string[],
): Promise<HistoryRow[]> {
  return enqueue([], (db) =>
    inTx(db, [ROWS], "readonly", async (tx) => {
      const index = tx.objectStore(ROWS).index("ref");
      const found: HistoryRow[] = [];
      for (const msgid of msgids) {
        found.push(
          ...(await awaitRequest<HistoryRow[]>(
            index.getAll(IDBKeyRange.only([server, msgid])),
          )),
        );
      }
      return found.sort((a, b) => a.time - b.time || a.id - b.id);
    }),
  );
}

export function deleteMessage(
  server: string,
  target: string,
  msgid: string,
): Promise<void> {
  return enqueue(undefined, (db) =>
    inTx(db, [ROWS, META, TERMS], "readwrite", async (tx) => {
      const rows = tx.objectStore(ROWS);
      const events = await awaitRequest<HistoryRow[]>(
        rows.index("msgid").getAll(IDBKeyRange.only([server, target, msgid])),
      );
      await deleteWithReactions(tx, server, events, [msgid]);
    }),
  );
}

// A message redacted while we were away is gone from the server's history and
// no REDACT reaches us, so we drop saved messages a page skipped inside its span.
// A row at the time we received it may belong anywhere in the server's history,
// so a page that skips it says nothing about it. A saved line whose own time
// is not the row's time tells us the row is one of those.
export function deleteMessagesMissingFromPage(
  server: string,
  target: string,
  from: number,
  to: number,
  kept: string[],
): Promise<void> {
  if (to - from < 2) return Promise.resolve();
  const keptIds = new Set(kept);
  return enqueue(undefined, (db) =>
    inTx(db, [ROWS, META, TERMS], "readwrite", async (tx) => {
      const inside = await awaitRequest<HistoryRow[]>(
        tx
          .objectStore(ROWS)
          .index("conv")
          .getAll(convRange(server, target, from + 1, to - 1)),
      );
      const missing = inside.filter(
        (row) =>
          !row.ref &&
          !row.hasReceiveTime &&
          serverTimeOf(splitTags(row.raw.split("\r\n")[0]).tags) === row.time &&
          row.msgid &&
          !keptIds.has(row.msgid),
      );
      await deleteWithReactions(
        tx,
        server,
        missing,
        missing.map((row) => row.msgid ?? ""),
      );
    }),
  );
}

async function deleteWithReactions(
  tx: IDBTransaction,
  server: string,
  events: HistoryRow[],
  msgids: string[],
): Promise<void> {
  const refIndex = tx.objectStore(ROWS).index("ref");
  const doomed = new Map<number, HistoryRow>();
  for (const row of events.filter((row) => !row.ref)) doomed.set(row.id, row);
  for (const msgid of msgids) {
    const reactions = await awaitRequest<HistoryRow[]>(
      refIndex.getAll(IDBKeyRange.only([server, msgid])),
    );
    for (const reaction of reactions) doomed.set(reaction.id, reaction);
  }
  await deleteRows(tx, [...doomed.values()]);
}

export function gapsFor(server: string, target: string): Promise<HistoryGap[]> {
  return enqueue([], (db) =>
    inTx(db, [GAPS], "readonly", (tx) =>
      awaitRequest<HistoryGap[]>(
        tx
          .objectStore(GAPS)
          .index("conv")
          .getAll(IDBKeyRange.only([server, target])),
      ),
    ),
  );
}

export async function fillableGaps(): Promise<HistoryGap[]> {
  const gaps = await enqueue<HistoryGap[]>([], (db) =>
    inTx(db, [GAPS], "readonly", (tx) =>
      awaitRequest<HistoryGap[]>(tx.objectStore(GAPS).getAll()),
    ),
  );
  return gaps.filter((gap) => !gap.lost);
}

type GapMerge = { kept: HistoryGap[]; removed: number[] };

// Records for one stretch of a chat say the same thing many times over, and a
// fill closes one record at a time, so we keep a single record per stretch.
// Each record keeps its older edge, the saved line the stretch starts after,
// so a wider record is cut where another one starts inside it.
export function mergeGaps(gaps: HistoryGap[]): GapMerge {
  const kept: HistoryGap[] = [];
  for (const isLost of [false, true]) {
    const sorted = gaps
      .filter((gap) => gap.lost === isLost)
      .sort((a, b) => a.from - b.from || a.to - b.to);
    for (let start = 0; start < sorted.length; ) {
      let end = start + 1;
      let to = sorted[start].to;
      while (
        end < sorted.length &&
        (sorted[end].from < to || sorted[end].from === sorted[start].from)
      ) {
        to = Math.max(to, sorted[end].to);
        end++;
      }
      const group = sorted.slice(start, end);
      const starts = [...new Set(group.map((gap) => gap.from))];
      starts.forEach((from, index) => {
        const sameStart = group.filter((gap) => gap.from === from);
        const segmentTo = starts[index + 1] ?? to;
        const { fromMsgid } = sameStart.find((gap) => gap.fromMsgid) ?? {};
        const { toMsgid } =
          group.find((gap) => gap.to === segmentTo && gap.toMsgid) ?? {};
        const { fromMsgid: _from, toMsgid: _to, ...edges } = sameStart[0];
        kept.push({
          ...edges,
          to: segmentTo,
          ...(fromMsgid ? { fromMsgid } : {}),
          ...(toMsgid ? { toMsgid } : {}),
        });
      });
      start = end;
    }
  }
  const keptIds = new Set(kept.map((gap) => gap.id));
  return {
    kept,
    removed: gaps.filter((gap) => !keptIds.has(gap.id)).map((gap) => gap.id),
  };
}

const isSameGap = (a: HistoryGap, b: HistoryGap) =>
  a.from === b.from &&
  a.to === b.to &&
  a.fromMsgid === b.fromMsgid &&
  a.toMsgid === b.toMsgid;

async function mergeStoredGaps(store: IDBObjectStore, gaps: HistoryGap[]) {
  const byId = new Map(gaps.map((gap) => [gap.id, gap]));
  const { kept, removed } = mergeGaps(gaps);
  for (const id of removed) await awaitRequest(store.delete(id));
  for (const gap of kept) {
    const stored = byId.get(gap.id);
    if (!stored || !isSameGap(stored, gap)) await awaitRequest(store.put(gap));
  }
}

const mergeChatGaps = async (
  store: IDBObjectStore,
  server: string,
  target: string,
) =>
  mergeStoredGaps(
    store,
    await awaitRequest<HistoryGap[]>(
      store.index("conv").getAll(IDBKeyRange.only([server, target])),
    ),
  );

// Records saved before gaps were merged as they are written can overlap, so
// we merge every chat's records once when the database opens.
function mergeAllGaps(db: IDBDatabase): Promise<void> {
  return inTx(db, [GAPS], "readwrite", async (tx) => {
    const store = tx.objectStore(GAPS);
    const byChat = new Map<string, HistoryGap[]>();
    for (const gap of await awaitRequest<HistoryGap[]>(store.getAll())) {
      const chat = conversationOf(gap);
      byChat.set(chat, [...(byChat.get(chat) ?? []), gap]);
    }
    for (const gaps of byChat.values())
      if (gaps.length > 1) await mergeStoredGaps(store, gaps);
  });
}

export function addGap(gap: Omit<HistoryGap, "id">): Promise<void> {
  return enqueue(undefined, (db) =>
    inTx(db, [GAPS], "readwrite", async (tx) => {
      const gaps = tx.objectStore(GAPS);
      await awaitRequest(gaps.add(gap));
      await mergeChatGaps(gaps, gap.server, gap.target);
    }),
  );
}

export function updateGap(gap: HistoryGap): Promise<void> {
  return enqueue(undefined, (db) =>
    inTx(db, [GAPS], "readwrite", async (tx) => {
      // A trim may have removed the gap with the rows below it since the caller read it.
      const gaps = tx.objectStore(GAPS);
      if (!(await awaitRequest(gaps.get(gap.id)))) return;
      await awaitRequest(gaps.put(gap));
      await mergeChatGaps(gaps, gap.server, gap.target);
    }),
  );
}

export function deleteGap(id: number): Promise<void> {
  return enqueue(undefined, (db) =>
    inTx(db, [GAPS], "readwrite", async (tx) => {
      await awaitRequest(tx.objectStore(GAPS).delete(id));
    }),
  );
}

export function usageBytes(): Promise<number> {
  return enqueue(0, usageDb);
}

// We queue each step of the trim on its own, so reads and writes queued
// meanwhile run before the next step, and a call during a trim joins it.
export function pruneToLimit(limitBytes: number): Promise<void> {
  if (trim) {
    // The latest call carries the limit the user has set now, so a running trim follows it.
    trim.limitBytes = limitBytes;
    return trim.done;
  }
  const running: Trim = { limitBytes, done: Promise.resolve() };
  trim = running;
  running.done = trimInSteps(running);
  return running.done;
}

async function trimInSteps(running: Trim): Promise<void> {
  try {
    const startBytes = await usageBytes();
    if (startBytes <= running.limitBytes) return;
    // Rows saved between steps can outpace us, so we stop once we have freed
    // as much as the database held when we began.
    for (let freed = 0; freed < startBytes; ) {
      const step = await enqueue<PruneStep>(
        { freed: 0, remaining: 0, ranOutOfRows: true },
        (db) => pruneDb(db, running.limitBytes * PRUNE_TARGET, PRUNE_STEP_ROWS),
      );
      freed += step.freed;
      const isAtTarget = step.remaining <= running.limitBytes * PRUNE_TARGET;
      if (isAtTarget || step.ranOutOfRows) return;
      // Code that reads history in several queued operations issues the next one as the last returns, so we leave the queue free for a moment.
      await new Promise((resolve) => setTimeout(resolve, PRUNE_STEP_PAUSE_MS));
    }
  } finally {
    // We clear this in the same turn the trim decides to stop, so a call that
    // arrives right after starts a trim of its own.
    trim = undefined;
  }
}

export function savedSenders(limit = 2000): Promise<string[]> {
  return enqueue([], (db) =>
    inTx(db, [ROWS], "readonly", (tx) => readSavedSenders(tx, limit)),
  );
}

export function hasServerHistory(server: string): Promise<boolean> {
  return enqueue(false, (db) =>
    inTx(db, [ROWS], "readonly", async (tx) => {
      const count = await awaitRequest<number>(
        tx.objectStore(ROWS).index("server").count(server),
      );
      return count > 0;
    }),
  );
}

export function deleteServerHistory(server: string): Promise<void> {
  return enqueue(undefined, (db) =>
    inTx(db, [ROWS, GAPS, META, TERMS], "readwrite", async (tx) => {
      let freed = 0;
      await walk(
        tx.objectStore(ROWS).index("server"),
        IDBKeyRange.only(server),
        "next",
        (cursor) => {
          const row = cursor.value as HistoryRow;
          freed += row.bytes;
          unindexRow(tx, row);
          cursor.delete();
          return true;
        },
      );
      await addBytes(tx, -freed);
      await walk(
        tx.objectStore(GAPS).index("conv"),
        wholeServer(server),
        "next",
        (cursor) => {
          cursor.delete();
          return true;
        },
      );
      await awaitRequest(tx.objectStore(META).delete(parkedName(server)));
    }),
  );
}

const PARKED_PREFIX = "parked:";
const parkedName = (server: string) => `${PARKED_PREFIX}${server}`;

interface ParkedHistory {
  name: string;
  value: { address: string; at: number };
}

// A removed server's history waits under its old id until a server with the
// same address is added, which then takes it over.
export function parkServerHistory(
  server: string,
  address: string,
): Promise<void> {
  return enqueue(undefined, (db) =>
    inTx(db, [ROWS, META], "readwrite", async (tx) => {
      const rowCount = await awaitRequest<number>(
        tx.objectStore(ROWS).index("server").count(server),
      );
      if (rowCount === 0) return;
      await awaitRequest(
        tx.objectStore(META).put({
          name: parkedName(server),
          value: { address, at: Date.now() },
        }),
      );
    }),
  );
}

export function adoptParkedHistory(
  address: string,
  server: string,
): Promise<boolean> {
  return enqueue(false, (db) =>
    inTx(db, [ROWS, GAPS, META, TERMS], "readwrite", async (tx) => {
      const meta = tx.objectStore(META);
      const parked = (
        await awaitRequest<ParkedHistory[]>(
          meta.getAll(
            IDBKeyRange.bound(PARKED_PREFIX, `${PARKED_PREFIX}\uffff`),
          ),
        )
      )
        .filter((entry) => entry.value.address === address)
        .sort((a, b) => b.value.at - a.value.at)[0];
      if (!parked) return false;
      const from = parked.name.slice(PARKED_PREFIX.length);
      await addBytes(
        tx,
        -(await moveRows(
          tx,
          tx.objectStore(ROWS).index("server"),
          IDBKeyRange.only(from),
          (row) => ({ ...row, server }),
        )),
      );
      await walk(
        tx.objectStore(GAPS).index("conv"),
        wholeServer(from),
        "next",
        (cursor) => {
          cursor.update({ ...(cursor.value as HistoryGap), server });
          return true;
        },
      );
      await awaitRequest(meta.delete(parked.name));
      return true;
    }),
  );
}

// Moves the rows in a range to where `moved` puts them and returns the bytes
// that freed, mostly from the duplicates we dropped on the way. Search terms
// point at row ids, so only the dropped rows touch them.
function moveRows(
  tx: IDBTransaction,
  source: IDBIndex,
  range: IDBKeyRange,
  moved: (row: HistoryRow) => HistoryRow,
): Promise<number> {
  const dedupe = tx.objectStore(ROWS).index("dedupe");
  let freed = 0;
  return new Promise((resolve, reject) => {
    const request = source.openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(freed);
      const row = cursor.value as HistoryRow;
      const next = moved(row);
      const clash = dedupe.getKey([next.server, next.target, next.key]);
      clash.onsuccess = () => {
        if (clash.result === undefined) {
          freed += row.bytes - next.bytes;
          cursor.update(next);
        } else {
          freed += row.bytes;
          unindexRow(tx, row);
          cursor.delete();
        }
        cursor.continue();
      };
      clash.onerror = () => reject(clash.error);
    };
    request.onerror = () => reject(request.error);
  });
}

// A replay files each saved line under the channel the line names, so the
// lines of a renamed channel take the new name along with their row.
function withTarget(raw: string, from: string, to: string): string {
  return raw
    .split("\r\n")
    .map((line) => {
      const words = line.split(" ");
      let at = 0;
      if (words[at]?.startsWith("@")) at++;
      if (words[at]?.startsWith(":")) at++;
      at += words[at] === "BATCH" ? 3 : 1;
      if (words[at]?.toLowerCase() !== from) return line;
      words[at] = to;
      return words.join(" ");
    })
    .join("\r\n");
}

/** Files what we saved of a channel under the name the server gave it since. Rows already saved under that name belong to an earlier channel of the name, so both sets then stay where they are. */
export function moveChannelHistory(
  server: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const from = oldName.toLowerCase();
  const to = newName.toLowerCase();
  if (from === to) return Promise.resolve();
  return enqueue(undefined, (db) =>
    inTx(db, [ROWS, GAPS, META, TERMS], "readwrite", async (tx) => {
      const conversations = tx.objectStore(ROWS).index("conv");
      const whole = (target: string) =>
        convRange(
          server,
          target,
          Number.NEGATIVE_INFINITY,
          Number.POSITIVE_INFINITY,
        );
      if (await awaitRequest(conversations.count(whole(to)))) return;
      const freed = await moveRows(tx, conversations, whole(from), (row) => {
        const raw = withTarget(row.raw, from, newName);
        return {
          ...row,
          target: to,
          // A line without a msgid is told apart by its time and text, so its key follows the line it now holds.
          key: row.msgid ? row.key : `${row.time}|${stripTags(raw)}`,
          raw,
          bytes: row.bytes + raw.length - row.raw.length,
        };
      });
      await addBytes(tx, -freed);
      await walk(
        tx.objectStore(GAPS).index("conv"),
        IDBKeyRange.only([server, from]),
        "next",
        (cursor) => {
          cursor.update({ ...(cursor.value as HistoryGap), target: to });
          return true;
        },
      );
    }),
  );
}

export function clearHistory(): Promise<void> {
  return enqueue(undefined, (db) =>
    inTx(db, [ROWS, GAPS, META, TERMS], "readwrite", async (tx) => {
      await Promise.all([
        awaitRequest(tx.objectStore(ROWS).clear()),
        awaitRequest(tx.objectStore(GAPS).clear()),
        awaitRequest(tx.objectStore(META).clear()),
        awaitRequest(tx.objectStore(TERMS).clear()),
      ]);
      await Promise.all([
        awaitRequest(tx.objectStore(META).put({ name: "bytes", value: 0 })),
      ]);
    }),
  );
}
