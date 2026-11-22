/// <reference lib="es2022.intl" />
import { describe, expect, test } from "vitest";
import {
  byteLength,
  calculateProtocolOverhead,
  exceedsLineLimit,
  splitLongMessage,
  splitToBytes,
} from "../../src/lib/messageProtocol";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const hasLoneSurrogate = (text: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    text,
  );
const graphemeCount = (text: string) =>
  Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
  ).length;

const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
const FLAG = "\u{1F1EF}\u{1F1F5}";
const WAVE = "\u{1F44B}\u{1F3FD}";

const SAMPLES: Record<string, string> = {
  ascii: "the quick brown fox jumps over the lazy dog ".repeat(30).trim(),
  cyrillic: "привет ".repeat(120).trim(),
  cyrillicOneWord: "д".repeat(700),
  greek: "καλημέρα κόσμε ".repeat(80).trim(),
  arabic: "مرحبا بالعالم ".repeat(80).trim(),
  cjkOneWord: "漢字仮名交じり文".repeat(80),
  cjkWords: "日本語のテキスト 中文文本 한국어 ".repeat(40).trim(),
  emojiOneWord: "\u{1F600}".repeat(400),
  emojiWords: `EMO ${"\u{1F600}".repeat(300)} END`,
  clusters: `${FAMILY}${FLAG}${WAVE}`.repeat(60),
  combining: "éäô ".repeat(200).trim(),
  mixed: `start ${"ñ".repeat(300)} mid ${"字".repeat(200)} ${FAMILY.repeat(30)} end`,
  doubleSpaces: "слово  слово   ".repeat(80),
  leadingSpace: ` ${"д".repeat(500)}`,
  longUrl: `see https://example.org/${"a".repeat(900)} for details`,
};

const TARGETS = ["#chan", "#канал-с-длинным-именем", "somenick"];

describe("splitLongMessage", () => {
  test("returns a message that fits as one part", () => {
    expect(splitLongMessage("hello world", "#chan")).toEqual(["hello world"]);
    expect(splitLongMessage("hello world", "#chan", true)).toEqual([
      "hello world",
    ]);
  });

  test("splits text that fits by character count but not by byte count", () => {
    const text = "д".repeat(350);
    const limit = 512 - calculateProtocolOverhead("#chan");
    expect(text.length).toBeLessThan(limit);

    const parts = splitLongMessage(text, "#chan");

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(limit);
    expect(parts.join("")).toBe(text);
  });

  for (const target of TARGETS) {
    const limit = 512 - calculateProtocolOverhead(target);

    for (const [name, text] of Object.entries(SAMPLES)) {
      test(`concat parts of ${name} for ${target} rebuild the text within the byte budget`, () => {
        const parts = splitLongMessage(text, target, true);

        expect(parts.join("")).toBe(text);
        for (const part of parts) {
          expect(part.length).toBeGreaterThan(0);
          expect(bytes(part)).toBeLessThanOrEqual(limit);
          expect(hasLoneSurrogate(part)).toBe(false);
        }
        expect(parts.reduce((n, part) => n + graphemeCount(part), 0)).toBe(
          graphemeCount(text),
        );
      });

      test(`separate lines of ${name} for ${target} stay within the byte budget and lose only the spaces at a break`, () => {
        const parts = splitLongMessage(text, target);

        for (const part of parts) {
          expect(part.length).toBeGreaterThan(0);
          if (!part.startsWith("https://"))
            expect(bytes(part)).toBeLessThanOrEqual(limit);
          expect(hasLoneSurrogate(part)).toBe(false);
        }
        let read = 0;
        for (const part of parts) {
          const at = text.indexOf(part, read);
          expect(text.slice(read, at).trim()).toBe("");
          read = at + part.length;
        }
        expect(text.slice(read).trim()).toBe("");
        for (const part of parts) expect(part.endsWith(" ")).toBe(false);
        for (const part of parts.slice(1))
          expect(part.startsWith(" ")).toBe(false);
      });
    }
  }

  test("breaks at a space when one is available", () => {
    const text = "привет ".repeat(120).trim();

    for (const part of splitLongMessage(text, "#chan")) {
      expect(part).toMatch(/^привет( привет)*$/);
    }
    const concat = splitLongMessage(text, "#chan", true);
    for (const part of concat.slice(0, -1)) {
      expect(part).toMatch(/^(привет )+$/);
    }
  });

  test("adds no space inside a word that is broken across concat parts", () => {
    const url = `https://example.org/${"a".repeat(900)}`;

    const parts = splitLongMessage(url, "#chan", true);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(url);
  });

  test("keeps an emoji sequence whole", () => {
    const parts = splitLongMessage(FAMILY.repeat(60), "#chan", true);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length % FAMILY.length).toBe(0);
    }
  });

  test("breaks a single cluster larger than a line between code points", () => {
    const text = `a${"́".repeat(600)}`;
    const limit = 512 - calculateProtocolOverhead("#chan");

    const parts = splitLongMessage(text, "#chan", true);

    expect(parts.join("")).toBe(text);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(limit);
  });

  test("sends no line of only spaces after a split", () => {
    const limit = 512 - calculateProtocolOverhead("#chan");
    const word = "x".repeat(limit);

    expect(splitLongMessage(`${word}  `, "#chan")).toEqual([word]);
    expect(splitLongMessage(`${word}   ${word}  `, "#chan")).toEqual([
      word,
      word,
    ]);
    expect(splitLongMessage(`one   ${word}`, "#chan")).toEqual(["one", word]);
  });

  test("keeps the spaces at a split in the concat parts", () => {
    const limit = 512 - calculateProtocolOverhead("#chan");
    const text = `${"x".repeat(limit)}  `;

    const parts = splitLongMessage(text, "#chan", true);

    expect(parts.join("")).toBe(text);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(limit);
  });

  test("counts the target in bytes", () => {
    expect(calculateProtocolOverhead("#канал")).toBe(
      calculateProtocolOverhead("#chan") + bytes("#канал") - bytes("#chan"),
    );
  });
});

describe("byteLength", () => {
  test("counts what the encoder writes, lone surrogates included", () => {
    for (const text of [
      "",
      "plain",
      "é",
      "д",
      "字",
      "\u{1F600}",
      FAMILY,
      "a\uD83Db",
      "\uDE00a",
      "\uD83D",
      "\u07FF\u0800\uFFFF",
    ])
      expect(byteLength(text)).toBe(bytes(text));
  });
});

describe("exceedsLineLimit", () => {
  test("measures the text in bytes", () => {
    const limit = 512 - calculateProtocolOverhead("#chan");

    expect(exceedsLineLimit("a".repeat(limit), "#chan")).toBe(false);
    expect(exceedsLineLimit("a".repeat(limit + 1), "#chan")).toBe(true);
    expect(exceedsLineLimit("д".repeat(350), "#chan")).toBe(true);
    expect(exceedsLineLimit("\u{1F600}".repeat(100), "#chan")).toBe(true);
    expect(exceedsLineLimit("д".repeat(100), "#chan")).toBe(false);
  });
});

describe("splitToBytes", () => {
  const link = `https://files.example/${"a".repeat(60)}.png`;

  test("returns a line that fits as one part", () => {
    expect(splitToBytes(`photo ${link}`, 100)).toEqual([`photo ${link}`]);
  });

  test("counts the budget in bytes", () => {
    expect(splitToBytes("ééééé ééééé", 12)).toEqual(["ééééé", "ééééé"]);
    expect(splitToBytes("aaaaa aaaaa", 12)).toEqual(["aaaaa aaaaa"]);
  });

  test("moves a link that fits a line whole to the next line", () => {
    expect(splitToBytes(`a photo of it ${link} done`, 95)).toEqual([
      "a photo of it",
      `${link} done`,
    ]);
    expect(splitToBytes(`(${link}), and \x0304${link}\x0f`, 95)).toEqual([
      `(${link}), and`,
      `\x0304${link}\x0f`,
    ]);
  });

  test("cuts a link wider than a line so every part fits", () => {
    const parts = splitToBytes(`photo ${link} done`, 40);

    expect(parts[0]).toBe("photo");
    expect(parts.slice(1).join("").replace(/ /g, "")).toBe(`${link}done`);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(40);
  });

  test("cuts a word wider than a line that holds a link so every part fits", () => {
    for (const word of [
      `${"x".repeat(300)}www.a.b`,
      `漢字仮名交じり文${link}漢字仮名交じり文`.repeat(4),
    ]) {
      const parts = splitToBytes(word, 40);

      expect(parts.join("")).toBe(word);
      for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(40);
    }
  });

  test("sends no part of only tabs or spaces", () => {
    const word = "x".repeat(40);

    expect(splitToBytes(`${word} \t\t `, 40)).toEqual([word]);
    expect(splitToBytes(`   ${word}`, 40)).toEqual([word]);
    expect(splitToBytes(`${word}   ${word} \t`, 40)).toEqual([word, word]);
  });

  // A fixed seed gives the same texts on every run.
  test("returns no part wider than the budget for any mix of scripts and links", () => {
    let seed = 0x2f6e2b1;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const pieces = [
      "a",
      "word",
      "x".repeat(70),
      "д",
      "привет",
      "漢字",
      "仮名交じり文".repeat(9),
      "\u{1F600}",
      FAMILY,
      FLAG,
      WAVE,
      "e\u0301",
      " ",
      "  ",
      "\t",
      "\x0304",
      "\x02",
      "(",
      ").",
      "www.a.b",
      "https://example.org/path?q=1",
      link,
      `https://example.org/${"a".repeat(200)}`,
      "ircs://irc.example/#chan",
    ];
    const links = pieces.filter((piece) => /^(https|ircs):/.test(piece));

    for (let run = 0; run < 400; run++) {
      const text = Array.from(
        { length: 1 + random(40) },
        () => pieces[random(pieces.length)],
      ).join(random(3) === 0 ? " " : "");
      const maxBytes = 8 + random(400);

      const concat = splitToBytes(text, maxBytes, true);
      expect(concat.join("")).toBe(text);
      for (const part of concat)
        expect(bytes(part)).toBeLessThanOrEqual(maxBytes);

      const separate = splitToBytes(text, maxBytes);
      for (const part of separate)
        expect(bytes(part)).toBeLessThanOrEqual(maxBytes);
      if (bytes(text) > maxBytes) {
        expect(separate.join("").replace(/ /g, "")).toBe(
          text.replace(/ /g, "").replace(/^\t+$/, ""),
        );
        for (const part of separate) expect(part.trim()).not.toBe("");
      }
      for (const word of text.split(" "))
        if (links.includes(word) && bytes(word) <= maxBytes)
          expect(separate.some((part) => part.includes(word))).toBe(true);
    }
  });

  test("cuts a word wider than a line that is no link so every part fits", () => {
    const word = "д".repeat(60);

    const parts = splitToBytes(`photo ${word} done`, 40);

    expect(parts[0]).toBe("photo");
    expect(parts.slice(1).join("")).toBe(`${word}done`);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(40);
  });

  test("splits a link across concat parts that join back into it", () => {
    const parts = splitToBytes(`photo ${link} done`, 40, true);

    expect(parts.join("")).toBe(`photo ${link} done`);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(40);
  });

  test("the parts of a concat join back into the exact line", () => {
    const line = ` two  spaces ${link}  and a tail `;

    const parts = splitToBytes(line, 20, true);

    expect(parts.join("")).toBe(line);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(20);
  });
});
