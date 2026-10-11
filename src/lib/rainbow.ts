/// <reference lib="es2022.intl" />
import { stripIrcFormatting } from "./messageFormatter";
import { calculateProtocolOverhead } from "./messageProtocol";

const colors = ["04", "07", "08", "09", "11", "12", "06"];
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function rainbowText(text: string): string {
  let index = 0;
  // Strip pasted formatting and protocol controls before adding our own colors.
  const plain = stripIrcFormatting(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: IRC protocol formatting codes
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
  if (!plain.trim()) return "";
  return `${Array.from(graphemes.segment(plain), ({ segment }) => {
    if (/^\s+$/u.test(segment)) return segment;
    const color = colors[index++ % colors.length];
    // Two bold toggles stop IRC parsers treating a comma as a background color.
    return `\x03${color}${segment.startsWith(",") ? "\x02\x02" : ""}${segment}`;
  }).join("")}\x0f`;
}

/** Keep each color and its grapheme together when the IRC line limit is reached. */
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
    const segments = Array.from(
      graphemes.segment(part.slice(color.length)),
      (s) => s.segment,
    );
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
