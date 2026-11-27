import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HistoryRow,
  NewHistoryRow,
} from "../../../src/lib/history/historyDb";

type HistoryDb = typeof import("../../../src/lib/history/historyDb");

let db: HistoryDb;

function row(overrides: Partial<NewHistoryRow> = {}): NewHistoryRow {
  return {
    server: "s1",
    target: "#a",
    time: 1000,
    key: "k",
    raw: "x".repeat(36),
    ...overrides,
  };
}

const ROW_BYTES = 36 + 64;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  db = await import("../../../src/lib/history/historyDb");
});

describe("appendRows", () => {
  it("reports inserted rows and skips duplicates without double counting bytes", async () => {
    expect(await db.appendRows([row({ key: "a" }), row({ key: "b" })])).toEqual(
      [true, true],
    );
    expect(await db.usageBytes()).toBe(2 * ROW_BYTES);

    const result = await db.appendRows([
      row({ key: "a", raw: "different" }),
      row({ key: "c" }),
    ]);
    expect(result).toEqual([false, true]);
    expect(await db.usageBytes()).toBe(3 * ROW_BYTES);
    const rows = await db.newestEventRows("s1", "#a", 10);
    expect(rows.find((r) => r.key === "a")?.raw).toBe("x".repeat(36));
  });

  it("allows the same key in another conversation", async () => {
    expect(
      await db.appendRows([
        row(),
        row({ target: "#b" }),
        row({ server: "s2" }),
      ]),
    ).toEqual([true, true, true]);
  });
});

describe("event rows", () => {
  beforeEach(async () => {
    await db.appendRows([
      row({ key: "1", time: 1, msgid: "m1" }),
      row({ key: "2", time: 2, msgid: "m2" }),
      row({ key: "3", time: 3, msgid: "m3" }),
      row({ key: "3b", time: 3, msgid: "m3b" }),
      row({ key: "r", time: 3, ref: "m1" }),
      row({ key: "4", time: 4, msgid: "m4" }),
      row({ key: "other", time: 2, target: "#b" }),
    ]);
  });

  it("pages oldest-first, newest rows within the limit, ties by insertion", async () => {
    const page = await db.eventRowsBefore("s1", "#a", 3, 3);
    expect(page.map((r) => r.key)).toEqual(["2", "3", "3b"]);

    const older = await db.eventRowsBefore("s1", "#a", 2, 10);
    expect(older.map((r) => r.key)).toEqual(["1", "2"]);
  });

  it("excludes ref rows", async () => {
    const all = await db.newestEventRows("s1", "#a", 10);
    expect(all.map((r) => r.key)).toEqual(["1", "2", "3", "3b", "4"]);
  });

  it("returns the newest row", async () => {
    expect((await db.newestEventRows("s1", "#a", 1)).map((r) => r.key)).toEqual(
      ["4"],
    );
    expect(await db.newestEventRows("s1", "#none", 1)).toEqual([]);
  });

  it("pages newer rows oldest-first and resumes inside a shared millisecond", async () => {
    await db.appendRows([
      row({ key: "3c", time: 3, msgid: "m3c" }),
      row({ key: "3d", time: 3 }),
    ]);

    const first = await db.eventRowsAfter("s1", "#a", 2, 2);
    expect(first.map((r) => r.key)).toEqual(["2", "3"]);

    const last = first[first.length - 1];
    const next = await db.eventRowsAfter("s1", "#a", last.time, 2, last.id);
    expect(next.map((r) => r.key)).toEqual(["3b", "3c"]);

    const rest = await db.eventRowsAfter(
      "s1",
      "#a",
      next[1].time,
      10,
      next[1].id,
    );
    expect(rest.map((r) => r.key)).toEqual(["3d", "4"]);
  });
});

describe("refRowsFor", () => {
  it("returns ref rows for the given msgids oldest-first, from any target", async () => {
    await db.appendRows([
      row({ key: "m1", msgid: "m1", time: 1 }),
      row({ key: "r2", ref: "m2", time: 5 }),
      row({ key: "r1", ref: "m1", time: 3 }),
      row({ key: "r1b", ref: "m1", time: 4, target: "#b" }),
      row({ key: "r3", ref: "m3", time: 2 }),
      row({ key: "r1x", ref: "m1", time: 2, server: "s2" }),
    ]);
    const rows = await db.refRowsFor("s1", ["m1", "m2"]);
    expect(rows.map((r) => r.key)).toEqual(["r1", "r1b", "r2"]);
    expect(await db.refRowsFor("s1", [])).toEqual([]);
  });
});

describe("hasRowForEach", () => {
  beforeEach(async () => {
    await db.appendRows([
      row({ key: "a", msgid: "a" }),
      row({ key: "b", msgid: "b" }),
      row({ key: "c", msgid: "c", target: "#other" }),
    ]);
  });

  it("is true when every message has a row under one of its msgids", async () => {
    expect(await db.hasRowForEach("s1", "#a", [["a"], ["x", "b"]])).toBe(true);
    expect(await db.hasRowForEach("s1", "#a", [])).toBe(true);
  });

  it("is false when a message has no row in this chat", async () => {
    expect(await db.hasRowForEach("s1", "#a", [["a"], ["c"]])).toBe(false);
    expect(await db.hasRowForEach("s1", "#a", [["a"], []])).toBe(false);
  });
});

describe("deleteMessage", () => {
  it("removes the message and its reactions and lowers bytes", async () => {
    await db.appendRows([
      row({ key: "m1", msgid: "m1", time: 1 }),
      row({ key: "m2", msgid: "m2", time: 2 }),
      row({ key: "r1", ref: "m1", time: 3 }),
      row({ key: "r1b", ref: "m1", time: 4, target: "#b" }),
      row({ key: "r2", ref: "m2", time: 5 }),
    ]);
    expect(await db.usageBytes()).toBe(5 * ROW_BYTES);

    await db.deleteMessage("s1", "#a", "m1");

    expect(
      (await db.newestEventRows("s1", "#a", 10)).map((r) => r.key),
    ).toEqual(["m2"]);
    expect(await db.refRowsFor("s1", ["m1"])).toEqual([]);
    expect((await db.refRowsFor("s1", ["m2"])).length).toBe(1);
    expect(await db.usageBytes()).toBe(2 * ROW_BYTES);
  });

  it("keeps same-msgid rows in other conversations", async () => {
    await db.appendRows([
      row({ key: "a", msgid: "m1" }),
      row({ key: "b", msgid: "m1", target: "#b" }),
    ]);
    await db.deleteMessage("s1", "#a", "m1");
    expect(await db.newestEventRows("s1", "#b", 10)).toHaveLength(1);
  });
});

describe("gaps for one stretch", () => {
  const gap = { server: "s1", target: "#a", lost: false };
  const edges = async (target = "#a") =>
    (await db.gapsFor("s1", target)).map(({ from, to, lost }) => ({
      from,
      to,
      lost,
    }));

  it("keeps one record when the same stretch is added again", async () => {
    await db.addGap({ ...gap, from: 10, to: 20 });
    await db.addGap({ ...gap, from: 10, to: 20 });

    expect(await edges()).toEqual([{ from: 10, to: 20, lost: false }]);
  });

  it("extends the record when the stretch is added again with a later end", async () => {
    await db.addGap({ ...gap, from: 10, to: 20, fromMsgid: "a" });
    const [first] = await db.gapsFor("s1", "#a");
    await db.addGap({ ...gap, from: 10, to: 30, toMsgid: "z" });

    expect(await db.gapsFor("s1", "#a")).toEqual([
      { ...gap, id: first.id, from: 10, to: 30, fromMsgid: "a", toMsgid: "z" },
    ]);
  });

  it("cuts a wider record where another one starts inside it", async () => {
    await db.addGap({ ...gap, from: 10, to: 40 });
    await db.addGap({ ...gap, from: 20, to: 30 });

    expect(await edges()).toEqual([
      { from: 10, to: 20, lost: false },
      { from: 20, to: 40, lost: false },
    ]);
  });

  it("keeps records apart that only touch, that are in other chats, or that differ in being lost", async () => {
    await db.addGap({ ...gap, from: 10, to: 20 });
    await db.addGap({ ...gap, from: 20, to: 30 });
    await db.addGap({ ...gap, from: 10, to: 20, lost: true });
    await db.addGap({ ...gap, target: "#b", from: 10, to: 20 });

    expect(await edges()).toHaveLength(3);
    expect(await edges("#b")).toHaveLength(1);
  });

  it("merges two records when an update makes them overlap", async () => {
    await db.addGap({ ...gap, from: 10, to: 20 });
    await db.addGap({ ...gap, from: 10, to: 20, lost: true });
    const open = (await db.gapsFor("s1", "#a")).find((g) => !g.lost);

    if (open) await db.updateGap({ ...open, lost: true });

    expect(await edges()).toEqual([{ from: 10, to: 20, lost: true }]);
  });

  const reopenWith = async (records: object[]) => {
    await db.gapsFor("s1", "#a");
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("obby-history");
      open.onsuccess = () => {
        const tx = open.result.transaction(["gaps"], "readwrite");
        for (const record of records) tx.objectStore("gaps").add(record);
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    vi.resetModules();
    db = await import("../../../src/lib/history/historyDb");
  };

  it("keeps the id of the record saved first when records for one stretch merge", async () => {
    await reopenWith([
      { ...gap, from: 10, to: 30 },
      { ...gap, from: 10, to: 20 },
    ]);

    const merged = await db.gapsFor("s1", "#a");
    expect(merged).toMatchObject([{ from: 10, to: 30 }]);
    await reopenWith([{ ...gap, from: 10, to: 15 }]);
    expect(await db.gapsFor("s1", "#a")).toEqual(merged);
  });

  it("keeps a record that does not say whether it is lost, as an open one", async () => {
    const { lost: _, ...unmarked } = gap;
    await reopenWith([
      { ...unmarked, from: 10, to: 20 },
      { ...gap, from: 10, to: 30 },
      { ...unmarked, from: 50, to: 60 },
    ]);

    expect(await db.gapsFor("s1", "#a")).toMatchObject([
      { from: 10, to: 30 },
      { from: 50, to: 60 },
    ]);
  });

  it("merges the records already saved when the database opens", async () => {
    await db.gapsFor("s1", "#a");
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("obby-history");
      open.onsuccess = () => {
        const tx = open.result.transaction(["gaps"], "readwrite");
        for (const to of [20, 20, 25, 30, 30, 30])
          tx.objectStore("gaps").add({ ...gap, from: 10, to });
        tx.objectStore("gaps").add({ ...gap, from: 50, to: 60 });
        tx.objectStore("gaps").add({ ...gap, target: "#b", from: 10, to: 20 });
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    vi.resetModules();
    db = await import("../../../src/lib/history/historyDb");

    expect(await edges()).toEqual([
      { from: 10, to: 30, lost: false },
      { from: 50, to: 60, lost: false },
    ]);
    expect(await edges("#b")).toEqual([{ from: 10, to: 20, lost: false }]);
  });
});

describe("gaps", () => {
  it("adds, updates, lists and deletes", async () => {
    await db.addGap({
      server: "s1",
      target: "#a",
      from: 1,
      to: 2,
      lost: false,
    });
    await db.addGap({
      server: "s1",
      target: "#b",
      from: 1,
      to: 2,
      lost: false,
    });
    const [gap] = await db.gapsFor("s1", "#a");
    expect(gap).toMatchObject({ from: 1, to: 2, lost: false });
    expect(typeof gap.id).toBe("number");

    await db.updateGap({ ...gap, lost: true, to: 9 });
    expect(await db.gapsFor("s1", "#a")).toEqual([
      { ...gap, lost: true, to: 9 },
    ]);

    await db.deleteGap(gap.id);
    expect(await db.gapsFor("s1", "#a")).toEqual([]);
    expect(await db.gapsFor("s1", "#b")).toHaveLength(1);
  });

  it("stores a stretch once, however often a connection computes it", async () => {
    const gap = { server: "s1", target: "#a", from: 10, to: 20, lost: false };
    await db.addGap(gap);
    await db.addGap(gap);
    await db.addGap({ ...gap, to: 18 });
    expect(await db.gapsFor("s1", "#a")).toHaveLength(1);
  });
});

describe("pruneToLimit", () => {
  it("does nothing under the limit", async () => {
    await db.appendRows([row({ key: "a" }), row({ key: "b", time: 2 })]);
    await db.pruneToLimit(10 * ROW_BYTES);
    expect(await db.usageBytes()).toBe(2 * ROW_BYTES);
  });

  it("deletes oldest rows first down to 90% of the limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ key: `k${i}`, time: i + 1, target: i % 2 ? "#a" : "#b" }),
    );
    await db.appendRows(rows);
    await db.pruneToLimit(8 * ROW_BYTES);

    // 90% of 8 rows is 7.2 rows, so 7 rows remain: the newest.
    expect(await db.usageBytes()).toBe(7 * ROW_BYTES);
    const remaining = [
      ...(await db.newestEventRows("s1", "#a", 20)),
      ...(await db.newestEventRows("s1", "#b", 20)),
    ].map((r) => r.time);
    expect(remaining.sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it("drops gaps older than the oldest remaining row and gaps of emptied conversations", async () => {
    await db.appendRows([
      row({ key: "a1", time: 1 }),
      row({ key: "a2", time: 10 }),
      row({ key: "a3", time: 11 }),
      row({ key: "b1", time: 2, target: "#b" }),
    ]);
    const gap = { server: "s1", target: "#a", lost: false };
    await db.addGap({ ...gap, from: 0, to: 5 });
    await db.addGap({ ...gap, from: 12, to: 13 });
    await db.addGap({ ...gap, target: "#b", from: 0, to: 1 });

    await db.pruneToLimit(3 * ROW_BYTES);

    expect(await db.usageBytes()).toBe(2 * ROW_BYTES);
    expect(await db.gapsFor("s1", "#a")).toMatchObject([{ from: 12, to: 13 }]);
    expect(await db.gapsFor("s1", "#b")).toEqual([]);
  });
});

describe("pruneToLimit in steps", () => {
  const STEPS = 4;
  let total: number;

  const line = (i: number) =>
    row({
      key: `k${i}`,
      time: i + 1,
      target: i % 3 ? "#a" : "#b",
      raw: `@msgid=m${i} :alice!u@h PRIVMSG #a :word${i} shared ${"y".repeat(i % 7)}`,
    });

  const allRows = async () =>
    [
      ...(await db.newestEventRows("s1", "#a", 10_000)),
      ...(await db.newestEventRows("s1", "#b", 10_000)),
      ...(await db.newestEventRows("s1", "#new", 10_000)),
    ].sort((a, b) => a.time - b.time);

  function storedTerms(): Promise<{ rowId: number }[]> {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("obby-history");
      open.onsuccess = () => {
        const request = open.result
          .transaction("terms")
          .objectStore("terms")
          .getAll();
        request.onsuccess = () => {
          open.result.close();
          resolve(request.result);
        };
      };
      open.onerror = () => reject(open.error);
    });
  }

  const sumBytes = (rows: { bytes: number }[]) =>
    rows.reduce((sum, r) => sum + r.bytes, 0);

  // What one pass over the oldest rows leaves: the newest rows that fit.
  function keptBySinglePass<T extends { bytes: number }>(
    oldestFirst: T[],
    targetBytes: number,
  ): T[] {
    let usage = sumBytes(oldestFirst);
    let firstKept = 0;
    while (usage > targetBytes && firstKept < oldestFirst.length)
      usage -= oldestFirst[firstKept++].bytes;
    return oldestFirst.slice(firstKept);
  }

  beforeEach(async () => {
    total = db.PRUNE_STEP_ROWS * STEPS;
    await db.appendRows(Array.from({ length: total }, (_, i) => line(i)));
  });

  it("lets a read queued during the trim finish before the trim does", async () => {
    const before = await db.usageBytes();
    const target = (before / 4) * 0.9;
    let isTrimDone = false;
    const trim = db.pruneToLimit(before / 4).then(() => {
      isTrimDone = true;
    });
    await db.usageBytes();
    const usageMidway = await db.usageBytes();

    expect(isTrimDone).toBe(false);
    expect(usageMidway).toBeLessThan(before);
    expect(usageMidway).toBeGreaterThan(target);
    await trim;
    expect(await db.usageBytes()).toBeLessThanOrEqual(target);
  });

  it("deletes at most one step of rows before a queued read runs", async () => {
    const countRows = async () =>
      (await db.newestEventRows("s1", "#a", 10_000)).length;
    const before = await countRows();
    const trim = db.pruneToLimit(1);
    await db.usageBytes();
    const midway = await countRows();
    await trim;

    expect(midway).toBeLessThan(before);
    expect(before - midway).toBeLessThanOrEqual(db.PRUNE_STEP_ROWS);
    expect(await allRows()).toEqual([]);
  });

  it("ends where a single pass over the oldest rows would", async () => {
    const before = await allRows();
    const limit = sumBytes(before) / 4;
    const expected = keptBySinglePass(before, limit * 0.9);
    expect(before.length - expected.length).toBeGreaterThan(
      2 * db.PRUNE_STEP_ROWS,
    );
    const oldestKept = expected[0].time;
    const gap = { server: "s1", target: "#a", lost: false };
    await db.addGap({ ...gap, from: 0, to: oldestKept - 1 });
    await db.addGap({ ...gap, from: oldestKept, to: oldestKept + 5 });
    await db.addGap({ ...gap, target: "#gone", from: 0, to: total });

    await db.pruneToLimit(limit);

    expect(await allRows()).toEqual(expected);
    expect(await db.usageBytes()).toBe(sumBytes(expected));
    const keptIds = new Set(expected.map((r) => r.id));
    const terms = await storedTerms();
    expect(terms.length).toBeGreaterThan(expected.length);
    expect(terms.filter((term) => !keptIds.has(term.rowId))).toEqual([]);
    expect(await db.fillableGaps()).toMatchObject([
      { target: "#a", from: oldestKept, to: oldestKept + 5 },
    ]);
  });

  it("runs one trim for overlapping calls", async () => {
    const before = await allRows();
    const limit = sumBytes(before) / 2;
    const expected = keptBySinglePass(before, limit * 0.9);

    const first = db.pruneToLimit(limit);
    const second = db.pruneToLimit(limit);
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(await allRows()).toEqual(expected);
    expect(await db.usageBytes()).toBe(sumBytes(expected));
  });

  it("starts a new trim once the running one has finished", async () => {
    const before = await allRows();
    await db.pruneToLimit(sumBytes(before) / 2);
    const limit = sumBytes(before) / 4;
    await db.pruneToLimit(limit);

    expect(await allRows()).toEqual(keptBySinglePass(before, limit * 0.9));
  });

  it("follows the limit asked for last while it runs", async () => {
    const before = await allRows();
    const lower = sumBytes(before) / 4;

    const first = db.pruneToLimit(sumBytes(before) / 2);
    await Promise.all([first, db.pruneToLimit(lower)]);

    expect(await allRows()).toEqual(keptBySinglePass(before, lower * 0.9));
  });

  it("stops early when the limit is raised while it runs", async () => {
    const before = await allRows();
    const lower = sumBytes(before) / 4;

    const trim = db.pruneToLimit(lower);
    await db.usageBytes();
    await db.usageBytes();
    void db.pruneToLimit(sumBytes(before) * 2);
    await trim;

    const after = await allRows();
    expect(after.length).toBeGreaterThan(
      keptBySinglePass(before, lower * 0.9).length,
    );
    expect(await db.usageBytes()).toBe(sumBytes(after));
  });

  it("lets reads issued one after another through between two steps", async () => {
    const before = await allRows();
    const trim = db.pruneToLimit(sumBytes(before) / 4);
    await db.usageBytes();
    const atFirstRead = (await allRows()).length;
    for (let read = 0; read < 4; read++) await db.usageBytes();
    const atLastRead = (await allRows()).length;
    await trim;

    expect(atFirstRead).toBeLessThan(before.length);
    expect(atFirstRead - atLastRead).toBeLessThanOrEqual(db.PRUNE_STEP_ROWS);
  });

  it("keeps and counts rows appended between steps", async () => {
    const before = await allRows();
    const limit = sumBytes(before) / 4;
    const fresh = Array.from({ length: 5 }, (_, i) =>
      row({ key: `new${i}`, time: total + 10 + i, target: "#new" }),
    );

    const trim = db.pruneToLimit(limit);
    await db.usageBytes();
    await db.usageBytes();
    expect((await allRows()).length).toBeLessThan(before.length);
    expect(await db.appendRows(fresh)).toEqual(fresh.map(() => true));
    await trim;

    const after = await allRows();
    expect(after.slice(-5).map((r) => r.key)).toEqual(fresh.map((r) => r.key));
    expect(await db.usageBytes()).toBe(sumBytes(after));
    expect(sumBytes(after)).toBeLessThanOrEqual(limit * 0.9);
    expect(sumBytes(after) + after[0].bytes).toBeGreaterThan(limit * 0.9);
  });

  it("stops when rows arrive as fast as it deletes them", async () => {
    const before = await db.usageBytes();
    let next = total;
    let isTrimDone = false;
    const trim = db.pruneToLimit(before / 2).then(() => {
      isTrimDone = true;
    });
    for (let batches = 0; !isTrimDone; batches++) {
      expect(batches).toBeLessThan(10 * STEPS);
      await db.appendRows(
        Array.from({ length: db.PRUNE_STEP_ROWS }, () => line(next++)),
      );
    }
    await trim;

    expect(await db.usageBytes()).toBe(sumBytes(await allRows()));
  });

  it("touches nothing when usage is within the limit", async () => {
    const before = await allRows();
    await db.addGap({
      server: "s1",
      target: "#gone",
      from: 0,
      to: 1,
      lost: false,
    });

    await db.pruneToLimit(sumBytes(before));

    expect(await allRows()).toEqual(before);
    expect(await db.usageBytes()).toBe(sumBytes(before));
    expect(await db.fillableGaps()).toHaveLength(1);
  });

  it("removes a gap in the same step that deletes the rows below it", async () => {
    await db.addGap({
      server: "s1",
      target: "#a",
      from: 0,
      to: 1,
      lost: false,
    });
    const trim = db.pruneToLimit(1);
    await db.usageBytes();
    const gapsMidway = await db.gapsFor("s1", "#a");
    const rowsMidway = await db.newestEventRows("s1", "#a", 10_000);
    await trim;

    expect(rowsMidway.length).toBeGreaterThan(0);
    expect(gapsMidway).toEqual([]);
  });
});

describe("deleteServerHistory", () => {
  it("removes only that server's rows and gaps", async () => {
    await db.appendRows([
      row({ key: "a" }),
      row({ key: "b", target: "#b" }),
      row({ key: "c", server: "s2" }),
    ]);
    await db.addGap({
      server: "s1",
      target: "#a",
      from: 1,
      to: 2,
      lost: false,
    });
    await db.addGap({
      server: "s2",
      target: "#a",
      from: 1,
      to: 2,
      lost: false,
    });

    await db.deleteServerHistory("s1");

    expect(await db.newestEventRows("s1", "#a", 10)).toEqual([]);
    expect(await db.newestEventRows("s1", "#b", 10)).toEqual([]);
    expect(await db.newestEventRows("s2", "#a", 10)).toHaveLength(1);
    expect(await db.gapsFor("s1", "#a")).toEqual([]);
    expect(await db.gapsFor("s2", "#a")).toHaveLength(1);
    expect(await db.usageBytes()).toBe(ROW_BYTES);
  });
});

describe("moveChannelHistory", () => {
  const line = (target: string, text: string) =>
    `@msgid=${text};time=2026-01-01T12:00:00.000Z :al!u@h PRIVMSG ${target} :${text} in #Old`;

  it("files a channel's rows and gaps under its new name", async () => {
    const multiline = [
      "@msgid=m;time=2026-01-01T12:00:02.000Z :al!u@h BATCH +b1 draft/multiline #Old",
      "@batch=b1 :al!u@h PRIVMSG #Old :one",
      "@batch=b1 :al!u@h PRIVMSG #old :two",
      "BATCH -b1",
    ].join("\r\n");
    await db.appendRows([
      row({ target: "#old", key: "a", time: 1, raw: line("#Old", "a") }),
      row({ target: "#old", key: "m", time: 2, raw: multiline }),
      row({
        target: "#old",
        key: "r",
        time: 3,
        ref: "a",
        raw: "@msgid=r;+draft/react=x;+draft/reply=a :al!u@h TAGMSG #old",
      }),
      row({ target: "#older", key: "o", raw: line("#older", "o") }),
      row({ server: "s2", target: "#old", key: "x", raw: line("#old", "x") }),
    ]);
    await db.addGap({
      server: "s1",
      target: "#old",
      from: 1,
      to: 2,
      lost: false,
    });
    const before = await db.usageBytes();

    await db.moveChannelHistory("s1", "#OLD", "#Newer");

    expect(await db.newestEventRows("s1", "#old", 10)).toEqual([]);
    const moved = await db.newestEventRows("s1", "#newer", 10);
    expect(moved.map((r) => r.raw)).toEqual([
      line("#Newer", "a"),
      multiline.replaceAll(/#old/gi, "#Newer"),
    ]);
    expect((await db.refRowsFor("s1", ["a"])).map((r) => r.raw)).toEqual([
      "@msgid=r;+draft/react=x;+draft/reply=a :al!u@h TAGMSG #Newer",
    ]);
    expect(await db.gapsFor("s1", "#old")).toEqual([]);
    expect(await db.gapsFor("s1", "#newer")).toHaveLength(1);
    expect(await db.newestEventRows("s1", "#older", 10)).toHaveLength(1);
    expect(await db.newestEventRows("s2", "#old", 10)).toHaveLength(1);
    expect(await db.usageBytes()).toBe(before + 2 * 5);
  });

  it("leaves both names alone when the new one already holds rows", async () => {
    await db.appendRows([
      row({ target: "#old", key: "a", time: 1 }),
      row({ target: "#old", key: "b", time: 2 }),
      row({ target: "#new", key: "a", time: 1 }),
    ]);
    await db.addGap({
      server: "s1",
      target: "#old",
      from: 1,
      to: 2,
      lost: false,
    });

    await db.moveChannelHistory("s1", "#old", "#new");

    const keys = async (target: string) =>
      (await db.newestEventRows("s1", target, 10)).map((r) => r.key);
    expect(await keys("#old")).toEqual(["a", "b"]);
    expect(await keys("#new")).toEqual(["a"]);
    expect(await db.gapsFor("s1", "#old")).toHaveLength(1);
    expect(await db.usageBytes()).toBe(3 * ROW_BYTES);
  });

  it("keys a moved line without a msgid by the line it now holds", async () => {
    const said = (target: string) =>
      `@time=1970-01-01T00:00:01.000Z :al!u@h PRIVMSG ${target} :hello`;
    const keyOf = (target: string) => `1000|:al!u@h PRIVMSG ${target} :hello`;
    await db.appendRows([
      row({ target: "#old", key: keyOf("#old"), raw: said("#old") }),
    ]);

    await db.moveChannelHistory("s1", "#old", "#new");

    expect(
      await db.appendRows([
        row({ target: "#new", key: keyOf("#new"), raw: said("#new") }),
      ]),
    ).toEqual([false]);
    expect(await db.newestEventRows("s1", "#new", 10)).toHaveLength(1);
  });

  it("leaves the rows alone when only the letter case changes", async () => {
    await db.appendRows([row({ target: "#old", raw: line("#old", "a") })]);
    await db.moveChannelHistory("s1", "#old", "#OLD");
    const [kept] = await db.newestEventRows("s1", "#old", 10);
    expect(kept.raw).toBe(line("#old", "a"));
  });
});

describe("clearHistory", () => {
  it("empties everything and resets usage", async () => {
    await db.appendRows([row()]);
    await db.addGap({
      server: "s1",
      target: "#a",
      from: 1,
      to: 2,
      lost: false,
    });
    await db.clearHistory();
    expect(await db.usageBytes()).toBe(0);
    expect(await db.newestEventRows("s1", "#a", 10)).toEqual([]);
    expect(await db.gapsFor("s1", "#a")).toEqual([]);
  });
});

describe("ordering", () => {
  it("runs back to back calls in call order", async () => {
    const first = db.appendRows([row({ key: "a" })]);
    const read = db.newestEventRows("s1", "#a", 10);
    const second = db.appendRows([row({ key: "b", time: 2000 })]);
    const readAgain = db.newestEventRows("s1", "#a", 10);
    const cleared = db.clearHistory();
    const readEmpty = db.newestEventRows("s1", "#a", 10);

    await Promise.all([first, second, cleared]);
    expect((await read).map((r) => r.key)).toEqual(["a"]);
    expect((await readAgain).map((r) => r.key)).toEqual(["a", "b"]);
    expect(await readEmpty).toEqual([]);
  });

  it("keeps the chain alive after a failing operation", async () => {
    await expect(
      db.appendRows([{ ...row(), raw: (() => 1) as unknown as string }]),
    ).rejects.toBeDefined();
    expect(await db.appendRows([row()])).toEqual([true]);
  });
});

describe("orderRowsAtPageEdge", () => {
  const msgidsAt = async (time: number) =>
    (await db.newestEventRows("s1", "#a", 50))
      .filter((r) => r.time === time)
      .map((r) => r.msgid);
  const said = (msgid: string, time = 1000) =>
    row({ key: msgid, msgid, time, raw: `:n!u@h PRIVMSG #a :${msgid}` });

  it("moves the rows we held behind an older page that ends in their millisecond", async () => {
    await db.appendRows([said("m3"), said("m4"), said("m5", 2000)]);
    await db.appendRows([said("m0", 500), said("m1"), said("m2")]);
    expect(await msgidsAt(1000)).toEqual(["m3", "m4", "m1", "m2"]);
    const bytes = await db.usageBytes();

    await db.orderRowsAtPageEdge(
      "s1",
      "#a",
      1000,
      ["m0", "m1", "m2"],
      "behind",
    );

    expect(await msgidsAt(1000)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(await db.usageBytes()).toBe(bytes);
    expect(
      (await db.newestEventRows("s1", "#a", 50)).map((r) => r.msgid),
    ).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
  });

  it("puts the page's own rows in the page's order where we held some of them", async () => {
    await db.appendRows([said("m2"), said("m4")]);
    await db.appendRows([said("m0", 500), said("m1"), said("m3")]);

    await db.orderRowsAtPageEdge(
      "s1",
      "#a",
      1000,
      ["m0", "m1", "m2", "m3"],
      "behind",
    );

    expect(await msgidsAt(1000)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("keeps the rows we held ahead of a newer page that starts in their millisecond", async () => {
    await db.appendRows([said("m4"), said("m5", 2000)]);
    await db.appendRows([said("m1"), said("m2")]);
    await db.appendRows([said("m3")]);

    await db.orderRowsAtPageEdge("s1", "#a", 1000, ["m3", "m4", "m5"], "ahead");

    expect(await msgidsAt(1000)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("leaves rows that are in order as they are, reactions included", async () => {
    await db.appendRows([
      said("m1"),
      said("m2"),
      row({ key: "r1", time: 1000, ref: "m1", raw: "reaction" }),
    ]);
    const before = await db.newestEventRows("s1", "#a", 50);

    await db.orderRowsAtPageEdge("s1", "#a", 1000, ["m1"], "behind");

    expect(await db.newestEventRows("s1", "#a", 50)).toEqual(before);
    expect(await db.refRowsFor("s1", ["m1"])).toHaveLength(1);
  });

  it("keeps a moved row findable by its text", async () => {
    const { searchMessages } = await import(
      "../../../src/lib/history/historySearch"
    );
    await db.appendRows([said("m3")]);
    await db.appendRows([said("m1")]);

    await db.orderRowsAtPageEdge("s1", "#a", 1000, ["m1"], "behind");

    const page = await searchMessages(
      { text: "m3", scope: { kind: "everywhere" } },
      { ownNicks: {} },
    );
    expect(page.hits.map((hit) => hit.msgid)).toEqual(["m3"]);
  });

  it("puts an older page of one millisecond right ahead of the line it was asked from", async () => {
    await db.appendRows([said("m0", 500), said("m1"), said("m2")]);
    await db.appendRows([said("m5"), said("m6")]);
    await db.appendRows([said("m3"), said("m4")]);
    expect(await msgidsAt(1000)).toEqual(["m1", "m2", "m5", "m6", "m3", "m4"]);

    await db.orderRowsAtPageEdge("s1", "#a", 1000, ["m3", "m4"], undefined, {
      msgid: "m5",
      kind: "before",
    });

    expect(await msgidsAt(1000)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("puts a newer page of one millisecond right behind the line it was asked from", async () => {
    await db.appendRows([said("m1"), said("m2")]);
    await db.appendRows([said("m5"), said("m6")]);
    await db.appendRows([said("m3"), said("m4")]);

    await db.orderRowsAtPageEdge("s1", "#a", 1000, ["m3", "m4"], undefined, {
      msgid: "m2",
      kind: "after",
    });

    expect(await msgidsAt(1000)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("leaves a page of one millisecond where it landed when we do not hold the line it was asked from", async () => {
    await db.appendRows([said("m5"), said("m6")]);
    await db.appendRows([said("m3"), said("m4")]);
    const before = await db.newestEventRows("s1", "#a", 50);

    await db.orderRowsAtPageEdge("s1", "#a", 1000, ["m3", "m4"], undefined, {
      msgid: "gone",
      kind: "before",
    });

    expect(await db.newestEventRows("s1", "#a", 50)).toEqual(before);
  });

  it("puts a newer page of one millisecond ahead of the rows it leaves out when it was asked from a line at an earlier time", async () => {
    await db.appendRows([said("m0", 500), said("m3"), said("m4")]);
    await db.appendRows([said("m1"), said("m2")]);
    expect(await msgidsAt(1000)).toEqual(["m3", "m4", "m1", "m2"]);

    await db.orderRowsAtPageEdge("s1", "#a", 1000, ["m1", "m2"], "behind", {
      msgid: "m0",
      kind: "after",
    });

    expect(await msgidsAt(1000)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("puts an older page of one millisecond behind the rows it leaves out when it was asked from a line at a later time", async () => {
    await db.appendRows([said("m1"), said("m4"), said("m5", 2000)]);
    await db.appendRows([said("m2"), said("m3")]);
    expect(await msgidsAt(1000)).toEqual(["m1", "m4", "m2", "m3"]);

    await db.orderRowsAtPageEdge(
      "s1",
      "#a",
      1000,
      ["m2", "m3", "m4"],
      "ahead",
      { msgid: "m5", kind: "before" },
    );

    expect(await msgidsAt(1000)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("leaves a reaction as it was saved when the rows around it move", async () => {
    await db.appendRows([
      said("m3"),
      row({ key: "r1", time: 1000, ref: "m3", raw: "reaction" }),
    ]);
    await db.appendRows([said("m1")]);
    const reactions = await db.refRowsFor("s1", ["m3"]);
    expect(reactions).toHaveLength(1);

    await db.orderRowsAtPageEdge("s1", "#a", 1000, ["m1"], "behind");

    expect(await msgidsAt(1000)).toEqual(["m1", "m3"]);
    expect(await db.refRowsFor("s1", ["m3"])).toEqual(reactions);
  });

  it("leaves a row without a msgid where it is when the page was asked from no line", async () => {
    await db.appendRows([
      row({ key: "own", raw: ":me!u@h PRIVMSG #a :sent without an echo" }),
    ]);
    await db.appendRows([said("m1"), said("m2")]);
    const before = await db.newestEventRows("s1", "#a", 50);

    await db.orderRowsAtPageEdge("s1", "#a", 1000, ["m1", "m2"], undefined);

    expect(await db.newestEventRows("s1", "#a", 50)).toEqual(before);
  });

  describe("what a move keeps", () => {
    type Posting = { term: string; time: number; rowId: number };
    const readAll = async () => {
      const opened = indexedDB.open("obby-history");
      const raw = await new Promise<IDBDatabase>((resolve, reject) => {
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => reject(opened.error);
      });
      const tx = raw.transaction(["rows", "terms"], "readonly");
      const all = <T>(name: string) =>
        new Promise<T[]>((resolve) => {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result as T[]);
        });
      const rows = await all<HistoryRow>("rows");
      const terms = await all<Posting>("terms");
      raw.close();
      return { rows, terms };
    };
    // Every saved row without its id, and the words each one is found by.
    const snapshot = async () => {
      const { rows, terms } = await readAll();
      const byId = new Map(rows.map((r) => [r.id, r]));
      return {
        rows: rows.map(({ id: _, ...rest }) => JSON.stringify(rest)).sort(),
        terms: terms
          .map((t) => `${byId.get(t.rowId)?.key} ${t.term} ${t.time}`)
          .sort(),
        orphans: terms.filter((t) => !byId.has(t.rowId)).length,
      };
    };
    const seed = async () => {
      await db.appendRows([
        said("m0", 500),
        said("m1"),
        row({ key: "r1", time: 1000, ref: "m5", raw: "reaction" }),
      ]);
      await db.appendRows(
        ["m5", "m6", "m7", "m8"].map((msgid) =>
          row({
            key: msgid,
            msgid,
            raw: `@msgid=${msgid} :n!u@h PRIVMSG #a :word${msgid} shared text`,
          }),
        ),
      );
      await db.appendRows([
        said("m9", 2000),
        said("m2"),
        said("m3"),
        said("m4"),
      ]);
    };
    const move = () =>
      db.orderRowsAtPageEdge("s1", "#a", 1000, ["m2", "m3", "m4"], undefined, {
        msgid: "m5",
        kind: "before",
      });

    it("keeps every row, every search term and the byte count through a move", async () => {
      await seed();
      const before = await snapshot();
      const bytes = await db.usageBytes();
      expect(before.rows).toHaveLength(11);
      expect(before.terms.length).toBeGreaterThan(11);

      await move();

      expect(await msgidsAt(1000)).toEqual([
        "m1",
        "m2",
        "m3",
        "m4",
        "m5",
        "m6",
        "m7",
        "m8",
      ]);
      expect(await snapshot()).toEqual({ ...before, orphans: 0 });
      expect(await db.usageBytes()).toBe(bytes);
      expect(await db.refRowsFor("s1", ["m5"])).toHaveLength(1);
    });

    it("keeps every row and search term when a step of the move fails", async () => {
      await seed();
      const before = await snapshot();
      const order = await msgidsAt(1000);
      const add = IDBObjectStore.prototype.add;
      let calls = 0;
      IDBObjectStore.prototype.add = function (...args) {
        if (++calls === 3) throw new Error("add failed");
        return add.apply(this, args);
      };

      try {
        await expect(move()).rejects.toBeDefined();
      } finally {
        IDBObjectStore.prototype.add = add;
      }

      expect(calls).toBeGreaterThanOrEqual(3);
      expect(await snapshot()).toEqual(before);
      expect(await msgidsAt(1000)).toEqual(order);
      expect(await db.appendRows([said("m10", 3000)])).toEqual([true]);
    });
  });
});

describe("other tabs", () => {
  it("closes for a newer tab and reopens on the next call", async () => {
    await db.appendRows([row({ key: "a" })]);

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("obby-history");
      request.onblocked = () => reject(new Error("blocked"));
      request.onsuccess = () => resolve();
    });

    expect(await db.appendRows([row({ key: "b" })])).toEqual([true]);
    expect(
      (await db.newestEventRows("s1", "#a", 10)).map((r) => r.key),
    ).toEqual(["b"]);
  });

  it("fails while an older tab blocks the upgrade, then opens", async () => {
    const older = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("obby-history", 1);
      open.onupgradeneeded = () => {
        const rows = open.result.createObjectStore("rows", {
          keyPath: "id",
          autoIncrement: true,
        });
        rows.createIndex("conv", ["server", "target", "time"]);
        rows.createIndex("dedupe", ["server", "target", "key"], {
          unique: true,
        });
        rows.createIndex("time", "time");
        rows.createIndex("server", "server");
        rows.createIndex("ref", ["server", "ref"]);
        rows.createIndex("msgid", ["server", "target", "msgid"]);
        open.result
          .createObjectStore("gaps", { keyPath: "id", autoIncrement: true })
          .createIndex("conv", ["server", "target"]);
        open.result.createObjectStore("meta", { keyPath: "name" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });

    await expect(db.usageBytes()).rejects.toThrow("blocked");
    older.close();

    expect(await db.appendRows([row()])).toEqual([true]);
  });
});

// The database as an older release left it, with one gap that release
// marked lost.
async function openOlderRelease(version: 1 | 2) {
  await db.usageBytes();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("obby-history");
    request.onblocked = () => reject(new Error("blocked"));
    request.onsuccess = () => resolve();
  });
  const older = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("obby-history", version);
    open.onupgradeneeded = () => {
      const rows = open.result.createObjectStore("rows", {
        keyPath: "id",
        autoIncrement: true,
      });
      rows.createIndex("conv", ["server", "target", "time"]);
      rows.createIndex("dedupe", ["server", "target", "key"], {
        unique: true,
      });
      rows.createIndex("time", "time");
      rows.createIndex("server", "server");
      rows.createIndex("ref", ["server", "ref"]);
      rows.createIndex("msgid", ["server", "target", "msgid"]);
      const gaps = open.result.createObjectStore("gaps", {
        keyPath: "id",
        autoIncrement: true,
      });
      gaps.createIndex("conv", ["server", "target"]);
      gaps.add({ server: "s1", target: "#a", from: 1, to: 2, lost: true });
      open.result.createObjectStore("meta", { keyPath: "name" });
      if (version === 2) {
        rows.createIndex("nick", ["nick", "time"]);
        rows.createIndex("serverTime", ["server", "time"]);
        rows.createIndex("reply", ["server", "target", "replyTo"]);
        rows.createIndex("replyToOwn", ["replyToOwn", "time"]);
        open.result.createObjectStore("terms", {
          keyPath: ["term", "time", "rowId"],
        });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  older.close();
}

describe("upgrade", () => {
  it.each([1, 2] as const)(
    "reopens gaps that version %i marked lost",
    async (version) => {
      await openOlderRelease(version);

      expect(await db.fillableGaps()).toEqual([
        expect.objectContaining({ server: "s1", target: "#a", lost: false }),
      ]);
    },
  );
});

describe("without indexedDB", () => {
  it("resolves to empty results", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: removing the global for this case
    (globalThis as any).indexedDB = undefined;
    vi.resetModules();
    const bare = await import("../../../src/lib/history/historyDb");
    expect(await bare.appendRows([row()])).toEqual([false]);
    expect(await bare.newestEventRows("s1", "#a", 5)).toEqual([]);
    expect(await bare.usageBytes()).toBe(0);
    await expect(bare.clearHistory()).resolves.toBeUndefined();
  });
});
