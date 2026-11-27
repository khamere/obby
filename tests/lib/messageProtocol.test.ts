/// <reference lib="es2022.intl" />
import { describe, expect, test } from "vitest";
import {
  byteLength,
  calculateProtocolOverhead,
  exceedsLineLimit,
  splitAction,
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

describe("splitToBytes with formatting codes", () => {
  interface Look {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikethrough: boolean;
    reverse: boolean;
    monospace: boolean;
    fg: string;
    bg: string;
  }
  const plain: Look = {
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    reverse: false,
    monospace: false,
    fg: "",
    bg: "",
  };
  const toggles: Record<string, keyof Omit<Look, "fg" | "bg">> = {
    "\x02": "bold",
    "\x1D": "italic",
    "\x1F": "underline",
    "\x1E": "strikethrough",
    "\x16": "reverse",
    "\x11": "monospace",
  };
  const codes =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: IRC formatting codes
    /(\x04(?:[0-9A-Fa-f]{6}(?:,[0-9A-Fa-f]{6})?)?|\x03(?:\d{1,2}(?:,\d{1,2})?)?|[\x02\x1D\x1F\x1E\x16\x11\x0F])/;

  /**
   * Every visible character of one message with the look a reader gives it.
   * `keepsBackground` picks between the two ways clients read a colour code
   * that names no background.
   */
  const render = (message: string, keepsBackground: boolean): string[] => {
    let look = plain;
    const seen: string[] = [];
    message.split(codes).forEach((piece, index) => {
      if (index % 2 === 0) {
        for (const char of piece)
          if (char !== " ") seen.push(`${char}${JSON.stringify(look)}`);
      } else if (piece === "\x0F") look = plain;
      else if (toggles[piece])
        look = { ...look, [toggles[piece]]: !look[toggles[piece]] };
      else {
        const hex = piece[0] === "\x04";
        const [fg = "", bg] = piece.slice(1).split(",");
        const name = (colour: string) =>
          hex ? `#${colour.toLowerCase()}` : String(Number(colour));
        look = {
          ...look,
          fg: fg && name(fg),
          bg: bg ? name(bg) : fg && keepsBackground ? look.bg : "",
        };
      }
    });
    return seen;
  };
  const renderEach = (messages: string[], keepsBackground: boolean) =>
    messages.flatMap((message) => render(message, keepsBackground));

  test("starts every part with the colour and style of the whole text", () => {
    expect(splitToBytes("\x0304\x02aaaa bbbb cccc\x02", 12)).toEqual([
      "\x0304\x02aaaa",
      "\x0304\x02bbbb",
      "\x0304\x02cccc\x02",
    ]);
  });

  test("resets before it re-opens the codes in a part the reader joins to the one before", () => {
    const parts = splitToBytes("\x0304\x02aaaa bbbb cccc\x02", 12, true);

    expect(parts).toEqual([
      "\x0304\x02aaaa ",
      "\x0F\x0304\x02bbbb ",
      "\x0F\x0304\x02cccc\x02",
    ]);
    expect(render(parts.join(""), true)).toEqual(
      render("\x0304\x02aaaa bbbb cccc\x02", true),
    );
  });

  test("carries a style that opens inside the text into the next part only while it is open", () => {
    expect(splitToBytes("aaaa \x1Dbbbb cccc\x1D dddd eeee", 10)).toEqual([
      "aaaa \x1Dbbbb",
      "\x1Dcccc\x1D",
      "dddd eeee",
    ]);
    expect(splitToBytes("\x02\x1Faaaa\x0F bbbbbbbb cccc", 10)).toEqual([
      "\x02\x1Faaaa\x0F",
      "bbbbbbbb",
      "cccc",
    ]);
  });

  test("counts the codes it re-opens toward the budget", () => {
    const text = `\x0304\x02\x1F${"word ".repeat(200)}\x1F\x02`;

    for (const keepSpaces of [false, true]) {
      const parts = splitToBytes(text, 100, keepSpaces);

      expect(parts.length).toBeGreaterThan(10);
      for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(100);
      const opened = keepSpaces ? "\x0F\x0304\x02\x1F" : "\x0304\x02\x1F";
      for (const part of parts.slice(1))
        expect(part.startsWith(opened)).toBe(true);
    }
  });

  test.each([
    ["a colour", "\x0304,05"],
    ["a hex colour", "\x04FF0000,00FF00"],
  ])("keeps %s code and its digits in one part", (_, code) => {
    const text = `${"a".repeat(20)}${code}bbbbbbbb`;

    for (let limit = 21; limit < 20 + code.length; limit++) {
      const parts = splitToBytes(text, limit);

      expect(parts[0]).toBe("a".repeat(20));
      expect(parts[1].startsWith(`${code}b`)).toBe(true);
    }
  });

  test("writes a re-opened colour so the text after it stays text", () => {
    expect(splitToBytes("\x034aaaa 5555", 8)).toEqual([
      "\x034aaaa",
      "\x03045555",
    ]);
    expect(splitToBytes("\x0304aaaa ,5bb", 9)).toEqual([
      "\x0304aaaa",
      "\x0304\x02\x02,5bb",
    ]);
  });

  test("re-opens a background with the foreground set after it", () => {
    expect(splitToBytes("\x0304,05aaaa \x0307bbbb cccc", 16)).toEqual([
      "\x0304,05aaaa",
      "\x0304,05\x0307bbbb",
      "\x0304,05\x0307cccc",
    ]);
  });

  test("sends no part of only formatting codes", () => {
    expect(splitToBytes(`\x02${"a".repeat(11)}\x02`, 12)).toEqual([
      "\x02aaaaaaaaaa",
      "\x02a\x02",
    ]);
    expect(splitToBytes(`\x02${"a".repeat(11)}\x02`, 12, true)).toEqual([
      "\x02aaaaaaaaaa",
      "\x0F\x02a\x02",
    ]);
    expect(splitToBytes(`\x02${"a".repeat(12)} \x02`, 13)).toEqual([
      `\x02${"a".repeat(12)}`,
    ]);
  });

  test("sends a character that fills a part without the codes that would push it over", () => {
    expect(bytes(FAMILY)).toBe(25);
    expect(splitToBytes(`\x0304\x02aaaa ${FAMILY} bbbb`, 25)).toEqual([
      "\x0304\x02aaaa",
      FAMILY,
      "\x0304\x02bbbb",
    ]);
  });

  // A fixed seed gives the same texts on every run.
  test("gives every character the look it has in the unsplit text, for any mix of codes", () => {
    let seed = 0x51f0c0de;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const pieces = [
      "a",
      "word",
      "x".repeat(70),
      "привет",
      "漢字",
      FAMILY,
      " ",
      "  ",
      ",",
      "7",
      "12,3",
      "\x02",
      "\x1D",
      "\x1F",
      "\x1E",
      "\x16",
      "\x11",
      "\x0F",
      "\x03",
      "\x034",
      "\x0304",
      "\x0312,1",
      "\x0307,08",
      "\x04",
      "\x04FF8800",
      "\x04ff8800,0000AA",
    ];

    const closers = ["", "\x02", "\x1F\x02", "\x1D\x0F", " \x02"];

    for (let run = 0; run < 600; run++) {
      const body = Array.from(
        { length: 1 + random(60) },
        () => pieces[random(pieces.length)],
      ).join(random(3) === 0 ? " " : "");
      const text = `${body}z${closers[random(closers.length)]}`;
      const maxBytes = 64 + random(340);

      for (const keepsBackground of [true, false]) {
        const whole = render(text, keepsBackground);

        const concat = splitToBytes(text, maxBytes, true);
        expect(render(concat.join(""), keepsBackground)).toEqual(whole);
        expect(renderEach(concat, keepsBackground)).toEqual(whole);

        expect(
          renderEach(splitToBytes(text, maxBytes), keepsBackground),
        ).toEqual(whole);
      }
      for (const part of [
        ...splitToBytes(text, maxBytes, true),
        ...splitToBytes(text, maxBytes),
      ])
        expect(bytes(part)).toBeLessThanOrEqual(maxBytes);
    }
  });

  test("splits each part of an action into a complete action that re-opens the style", () => {
    const messages = splitAction(`\x02${"waves ".repeat(120)}\x02`, "#chan");

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.startsWith("\u0001ACTION \x02waves")).toBe(true);
      expect(message.endsWith("\u0001")).toBe(true);
      expect(bytes(message)).toBeLessThanOrEqual(
        512 - calculateProtocolOverhead("#chan"),
      );
    }
  });
});

describe("splitAction", () => {
  // A line to #chan carries 378 bytes, and the CTCP ACTION wrapper takes 9 of them.
  const lineBytes = 512 - calculateProtocolOverhead("#chan");
  const actionBytes = lineBytes - 9;
  const text = (message: string) =>
    message.startsWith("\u0001ACTION ") && message.endsWith("\u0001")
      ? message.slice(8, -1)
      : undefined;

  test("wraps an action that fits as one message", () => {
    expect(splitAction("waves \u{1F600}", "#chan")).toEqual([
      "\u0001ACTION waves \u{1F600}\u0001",
    ]);
  });

  test("counts the wrapper toward the line", () => {
    expect(splitAction("a".repeat(actionBytes), "#chan")).toEqual([
      `\u0001ACTION ${"a".repeat(actionBytes)}\u0001`,
    ]);
    expect(splitAction("a".repeat(actionBytes + 1), "#chan")).toEqual([
      `\u0001ACTION ${"a".repeat(actionBytes)}\u0001`,
      "\u0001ACTION a\u0001",
    ]);
  });

  test("ends a message before a character that would cross the limit", () => {
    expect(
      splitAction(`${"a".repeat(actionBytes - 1)}\u{1F600}b`, "#chan"),
    ).toEqual([
      `\u0001ACTION ${"a".repeat(actionBytes - 1)}\u0001`,
      "\u0001ACTION \u{1F600}b\u0001",
    ]);
  });

  test.each([
    ["CJK", "漢字仮名".repeat(75)],
    ["emoji", "\u{1F600}".repeat(200)],
    [
      "a mix of one- to four-byte characters",
      "aé漢\u{1F600}\u{1F600}".repeat(45),
    ],
    ["clusters", `${FAMILY}${FLAG}${WAVE}`.repeat(60)],
  ])("cuts %s between characters into complete actions", (_, action) => {
    const messages = splitAction(action, "#chan");

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(text(message)).toBeTruthy();
      expect(bytes(message)).toBeLessThanOrEqual(lineBytes);
      expect(hasLoneSurrogate(message)).toBe(false);
    }
    expect(messages.map(text).join("")).toBe(action);
    expect(
      messages.map(text).reduce((n, t) => n + graphemeCount(t ?? ""), 0),
    ).toBe(graphemeCount(action));
  });

  test("leaves room for a longer target", () => {
    const target = `#${"c".repeat(40)}`;
    const limit = 512 - calculateProtocolOverhead(target);

    for (const message of splitAction("漢".repeat(300), target))
      expect(bytes(message)).toBeLessThanOrEqual(limit);
  });
});
