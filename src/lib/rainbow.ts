/// <reference lib="es2022.intl" />
import { stripIrcFormatting } from "./messageFormatter";
import { calculateProtocolOverhead } from "./messageProtocol";

const colors = ["04", "07", "08", "09", "11", "12", "06"];
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Characters RFC 2812 allows in a nickname, as matched by nickHighlight.
const NICK_TOKEN_RX = /[A-Za-z0-9[\]\\`^{}|_-]+/g;

/**
 * Colors each grapheme in turn. A word in `nicknames` gets one color for the
 * whole word, so mentions and nick highlighting still find it on the
 * receiving side.
 */
export function rainbowText(
  text: string,
  nicknames: readonly string[] = [],
): string {
  let index = 0;
  // Strip pasted formatting and protocol controls before adding our own colors.
  const plain = stripIrcFormatting(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: IRC protocol formatting codes
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
  if (!plain.trim()) return "";
  const nicks = new Set(nicknames.map((n) => n.toLowerCase()));
  // Two bold toggles stop IRC parsers treating a leading comma as a
  // background color, and keep a nick from touching the color's digits.
  const paint = (segment: string, guard: boolean) =>
    `\x03${colors[index++ % colors.length]}${guard ? "\x02\x02" : ""}${segment}`;
  const paintText = (part: string) =>
    Array.from(graphemes.segment(part), ({ segment }) =>
      /^\s+$/u.test(segment)
        ? segment
        : paint(segment, segment.startsWith(",")),
    ).join("");
  let out = "";
  let last = 0;
  for (const m of plain.matchAll(NICK_TOKEN_RX)) {
    if (m[0].length < 2 || !nicks.has(m[0].toLowerCase())) continue;
    out += paintText(plain.slice(last, m.index)) + paint(m[0], true);
    last = m.index + m[0].length;
  }
  return `${out}${paintText(plain.slice(last))}\x0f`;
}

/** Keep each color and its grapheme or nick together when the IRC line limit is reached. */
export function splitRainbowMessage(
  text: string,
  target = "#channel",
): string[] {
  const limit = 512 - calculateProtocolOverhead(target);
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  const units: string[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: IRC protocol formatting codes
  for (const part of text.split(/(?=\x03\d{2})/)) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: IRC protocol formatting codes
    const color = part.match(/^\x03\d{2}(?:\x02\x02)?/)?.[0] ?? "";
    // A colored run is one grapheme or one whole nick, then any whitespace.
    const [, word = "", space = ""] =
      part.slice(color.length).match(/^(.*?)(\s*)$/su) ?? [];
    const segments = [
      ...(word.length > 0 ? [word] : []),
      ...Array.from(graphemes.segment(space), (s) => s.segment),
    ];
    if (segments.length) segments[0] = color + segments[0];
    units.push(...segments);
  }
  for (const unit of units) {
    const size = encoder.encode(unit).length;
    if (bytes + size > limit && chunk) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    // Pathological combining sequences must still fit on the wire.
    if (size > limit) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: IRC protocol formatting codes
      const color = unit.match(/^\x03\d{2}(?:\x02\x02)?/)?.[0] ?? "";
      for (const point of unit.slice(color.length)) {
        const pointBytes = encoder.encode(point).length;
        if (bytes + pointBytes + color.length > limit && chunk) {
          chunks.push(chunk);
          chunk = "";
          bytes = 0;
        }
        if (!chunk) {
          chunk = color;
          bytes = color.length;
        }
        chunk += point;
        bytes += pointBytes;
      }
      continue;
    }
    chunk += unit;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
