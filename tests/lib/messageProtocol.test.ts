/// <reference lib="es2022.intl" />
import { describe, expect, test } from "vitest";
import {
  calculateProtocolOverhead,
  exceedsLineLimit,
  splitLongMessage,
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

      test(`separate lines of ${name} for ${target} stay within the byte budget and lose only break spaces`, () => {
        const parts = splitLongMessage(text, target);

        for (const part of parts) {
          expect(part.length).toBeGreaterThan(0);
          expect(bytes(part)).toBeLessThanOrEqual(limit);
          expect(hasLoneSurrogate(part)).toBe(false);
        }
        expect(parts.join("").replace(/ /g, "")).toBe(text.replace(/ /g, ""));
        const droppedSpaces = text.length - parts.join("").length;
        expect(droppedSpaces).toBeGreaterThanOrEqual(0);
        expect(droppedSpaces).toBeLessThan(parts.length);
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

  test("counts the target in bytes", () => {
    expect(calculateProtocolOverhead("#канал")).toBe(
      calculateProtocolOverhead("#chan") + bytes("#канал") - bytes("#chan"),
    );
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
