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
  const text = (batch: string[][]) => batch.map((parts) => parts.join(""));

  test("a code fence cut by a batch break is closed and reopened", () => {
    const paste = [["```csharp"], ...lines(15), ["};"], ["```"], ["after"]];
    const batches = chunkForMultiline(paste, {
      maxLines: 15,
      maxBytes: 5250,
    });
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(15);
      const fences = text(batch).filter((l) => l.trim().startsWith("```"));
      expect(fences.length % 2).toBe(0);
    }
    expect(text(batches[0])[0]).toBe("```csharp");
    expect(text(batches[0]).at(-1)).toBe("```");
    expect(text(batches[1])[0]).toBe("```csharp");
    expect(batches.flatMap(text).filter((l) => !l.startsWith("```"))).toEqual(
      paste.map((p) => p[0]).filter((l) => !l.startsWith("```")),
    );
  });

  test("inline ```code``` opens no fence", () => {
    const batches = chunkForMultiline([["```inline```"], ["a"], ["b"]], {
      maxLines: 3,
      maxBytes: 5250,
    });
    expect(batches.map(text)).toEqual([["```inline```", "a", "b"]]);
  });

  test("a fence marker with text after it stays inside the code block", () => {
    const paste = [["```js"], ["```text"], ...lines(4), ["```"]];
    const batches = chunkForMultiline(paste, { maxLines: 4, maxBytes: 5250 });
    for (const batch of batches.slice(1)) {
      expect(text(batch)[0]).toBe("```js");
    }
  });

  test("a long line inside a fence still fits next to the reopened fence", () => {
    const paste = [["```js"], ["a", "b"], ["```"]];
    for (const batch of chunkForMultiline(paste, {
      maxLines: 3,
      maxBytes: 5250,
    })) {
      expect(batch.flat().length).toBeLessThanOrEqual(3);
    }
    const longLine = ["aaaa", "bbbb", "cccc", "dddd"];
    for (const batch of chunkForMultiline([["```js"], longLine, ["```"]], {
      maxLines: 15,
      maxBytes: 16,
    })) {
      expect(batch.flat().join("").length).toBeLessThanOrEqual(16);
    }
  });

  test("a fence is reopened by its marker and language, never by a whole long line", () => {
    const opener = `\`\`\`js ${"x".repeat(600)}`;
    const batches = chunkForMultiline([[opener], ...lines(6), ["```"]], {
      maxLines: 4,
      maxBytes: 5250,
    });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches.slice(1)) expect(text(batch)[0]).toBe("```js");
  });

  test("a marker too long to repeat on every batch opens no fence", () => {
    const paste = [["`".repeat(200)], ...lines(6)];
    const batches = chunkForMultiline(paste, { maxLines: 4, maxBytes: 5250 });
    expect(batches.flatMap(text)).toEqual(paste.map((p) => p[0]));
  });

  // The same sequence on every run: a small generator with a fixed seed.
  const sequence = (seed: number) => {
    let state = seed;
    return (below: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % below;
    };
  };
  const sizeOf = (batch: string[][]) => ({
    lines: batch.flat().length,
    bytes:
      batch.flat().reduce((n, p) => n + new TextEncoder().encode(p).length, 0) +
      batch.length -
      1,
  });

  test("no batch passes the server's limits, with or without code fences", () => {
    const pick = sequence(7);
    const fenceLines = ["```", "```js", "~~~", "```python"];
    for (let round = 0; round < 400; round++) {
      const limits = { maxLines: 3 + pick(6), maxBytes: 12 + pick(60) };
      const paste: string[][] = [];
      for (let i = 0; i < 2 + pick(14); i++) {
        const line =
          pick(4) === 0
            ? [fenceLines[pick(fenceLines.length)]]
            : Array.from({ length: 1 + pick(3) }, () =>
                "é".repeat(1 + pick(limits.maxBytes / 2)),
              );
        if (fitsOneBatch(line, limits)) paste.push(line);
      }

      const batches = chunkForMultiline(paste, limits);

      for (const batch of batches) {
        expect(sizeOf(batch).lines).toBeLessThanOrEqual(limits.maxLines);
        expect(sizeOf(batch).bytes).toBeLessThanOrEqual(limits.maxBytes);
      }
      const sent = batches.flat().flat();
      let at = 0;
      for (const part of paste.flat()) {
        at = sent.indexOf(part, at) + 1;
        expect(at).toBeGreaterThan(0);
      }
    }
  });

  test("a paste without fences is chunked as before", () => {
    const batches = chunkForMultiline(lines(20), {
      maxLines: 15,
      maxBytes: 5250,
    });
    expect(batches.map((b) => b.length)).toEqual([15, 5]);
  });

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

describe("fitsOneBatch", () => {
  const limits = { maxLines: 2, maxBytes: 10 };

  test("counts a line's parts as lines and their bytes together", () => {
    expect(fitsOneBatch(["ééé", "éé"], limits)).toBe(true);
    expect(fitsOneBatch(["ééé", "ééé"], limits)).toBe(false);
    expect(fitsOneBatch(["a", "b", "c"], limits)).toBe(false);
    expect(fitsOneBatch(["a".repeat(600)], UNLIMITED_MULTILINE)).toBe(true);
  });
});
