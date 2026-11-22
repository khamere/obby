import { describe, expect, test } from "vitest";
import {
  chunkForMultiline,
  fitsOneBatch,
  parseMultilineLimits,
  UNLIMITED_MULTILINE,
} from "../../../src/lib/irc/multiline";

describe("parseMultilineLimits", () => {
  test("reads what obbyircd advertises", () => {
    expect(parseMultilineLimits("max-bytes=5250,max-lines=15")).toEqual({
      maxBytes: 5250,
      maxLines: 15,
    });
  });

  test("a capability with no value states no limit", () => {
    expect(parseMultilineLimits(undefined)).toEqual(UNLIMITED_MULTILINE);
    expect(parseMultilineLimits("")).toEqual(UNLIMITED_MULTILINE);
  });

  test("an unreadable limit is ignored rather than believed", () => {
    expect(parseMultilineLimits("max-lines=nope,max-bytes=4096")).toEqual({
      maxLines: Number.POSITIVE_INFINITY,
      maxBytes: 4096,
    });
  });
});

describe("chunkForMultiline", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => [`l${i}`]);

  test("a paste past the line cap goes out as several batches", () => {
    const batches = chunkForMultiline(lines(20), {
      maxLines: 15,
      maxBytes: Number.POSITIVE_INFINITY,
    });
    expect(batches.map((b) => b.length)).toEqual([15, 5]);
  });

  test("a line's parts stay in one batch, so concat never breaks", () => {
    const batches = chunkForMultiline([...lines(14), ["a", "b", "c"]], {
      maxLines: 15,
      maxBytes: Number.POSITIVE_INFINITY,
    });
    expect(batches.map((b) => b.length)).toEqual([14, 1]);
    expect(batches[1][0]).toEqual(["a", "b", "c"]);
  });

  test("the byte ceiling closes a batch too", () => {
    const batches = chunkForMultiline([["x".repeat(60)], ["y".repeat(60)]], {
      maxLines: 15,
      maxBytes: 100,
    });
    expect(batches).toHaveLength(2);
  });

  // Twelve lines of 4,086 bytes are 4,097 with the eleven breaks between them.
  test("the breaks between lines count against the byte ceiling", () => {
    const body = [...Array(11).fill(["x".repeat(340)]), ["x".repeat(346)]];
    const limits = { maxLines: 100, maxBytes: 4096 };

    expect(chunkForMultiline(body, limits).map((b) => b.length)).toEqual([
      11, 1,
    ]);
    body[11] = ["x".repeat(345)];
    expect(chunkForMultiline(body, limits)).toHaveLength(1);
  });

  test("the parts of one line add no break between them", () => {
    const batches = chunkForMultiline([["x".repeat(50), "y".repeat(50)]], {
      maxLines: 15,
      maxBytes: 100,
    });
    expect(batches).toHaveLength(1);
  });

  test("no limits means one batch", () => {
    expect(chunkForMultiline(lines(40), UNLIMITED_MULTILINE)).toHaveLength(1);
  });
});

describe("fitsOneBatch", () => {
  const limits = { maxLines: 2, maxBytes: 10 };

  test("counts a line's parts as lines and their bytes together", () => {
    expect(fitsOneBatch(["ééé", "éé"], limits)).toBe(true);
    expect(fitsOneBatch(["ééé", "ééé"], limits)).toBe(false);
    expect(fitsOneBatch(["a", "b", "c"], limits)).toBe(false);
    expect(fitsOneBatch(["a".repeat(600)], UNLIMITED_MULTILINE)).toBe(true);
  });
});
