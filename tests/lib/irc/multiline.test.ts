import { describe, expect, test } from "vitest";
import {
  chunkForMultiline,
  parseMultilineLimits,
  splitAtSpaces,
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

  test("a line longer than a whole batch is split rather than dropped", () => {
    const batches = chunkForMultiline([["a", "b", "c", "d", "e"]], {
      maxLines: 2,
      maxBytes: Number.POSITIVE_INFINITY,
    });
    expect(batches.flat()).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  test("a line past the byte ceiling is split, not sent over budget", () => {
    const parts = Array.from({ length: 6 }, () => "z".repeat(50));
    const batches = chunkForMultiline([parts], {
      maxLines: 15,
      maxBytes: 120,
    });
    const bytes = batches.map((b) =>
      b.flat().reduce((n, p) => n + p.length, 0),
    );
    expect(Math.max(...bytes)).toBeLessThanOrEqual(120);
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

describe("splitAtSpaces", () => {
  const link = `https://files.example/${"a".repeat(60)}.png`;

  test("a line that fits is one part", () => {
    expect(splitAtSpaces(`photo ${link}`, 100, false)).toEqual([
      `photo ${link}`,
    ]);
  });

  test("a link wider than a line stays whole on a line of its own", () => {
    expect(splitAtSpaces(`photo ${link} done`, 40, false)).toEqual([
      "photo",
      link,
      "done",
    ]);
  });

  test("the parts of a concat join back into the exact line", () => {
    const line = ` two  spaces ${link}  and a tail `;
    const parts = splitAtSpaces(line, 20, true);

    expect(parts.length).toBeGreaterThan(2);
    expect(parts).toContain(`${link}  `);
    expect(parts.join("")).toBe(line);
  });

  test("the budget is counted in bytes", () => {
    expect(splitAtSpaces("ééééé ééééé", 12, false)).toEqual(["ééééé", "ééééé"]);
    expect(splitAtSpaces("aaaaa aaaaa", 12, false)).toEqual(["aaaaa aaaaa"]);
  });
});
