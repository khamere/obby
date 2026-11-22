/// <reference lib="es2022.intl" />
/**
 * IRC protocol utilities for message handling
 */

// We count bytes because the IRC line limit applies on the wire, where one character takes up to four.
export const byteLength = (text: string): number => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
};

const graphemes =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

// We keep a flag, a skin-toned emoji or an accented letter in one line so it reaches the reader whole.
const splitUnits = (text: string, limit: number): string[] => {
  const clusters = graphemes
    ? Array.from(graphemes.segment(text), (s) => s.segment)
    : Array.from(text);
  return clusters.flatMap((cluster) =>
    // A UTF-16 unit takes three bytes at most, so a short cluster needs no count.
    cluster.length * 3 > limit && byteLength(cluster) > limit
      ? Array.from(cluster)
      : [cluster],
  );
};

/** The number of message bytes one PRIVMSG to `target` can carry. */
export const maxMessageBytes = (target: string): number =>
  512 - calculateProtocolOverhead(target);

export const exceedsLineLimit = (message: string, target: string): boolean =>
  byteLength(message) > maxMessageBytes(target);

/** Cuts one line into parts of at most `maxBytes`, given the line and whether its parts are joined again. */
export type LineSplitter = (
  line: string,
  maxBytes: number,
  keepSpaces: boolean,
) => string[];

/**
 * Splits a line into parts of at most `maxBytes` UTF-8 bytes, at a space
 * where the part holds one and between characters where it holds none.
 * With `keepSpaces` the parts concatenate back to the exact line, as the
 * receiver of a draft/multiline-concat joins them. By default each part is a
 * message of its own, so the spaces at a split point become the line break.
 */
export const splitToBytes = (
  line: string,
  maxBytes: number,
  keepSpaces = false,
): string[] => {
  if (byteLength(line) <= maxBytes) return [line];

  const units = splitUnits(line, maxBytes);
  const parts: string[] = [];
  let start = 0;

  while (start < units.length) {
    let end = start;
    let bytes = 0;
    let lastSpace = -1;
    while (end < units.length) {
      const size = byteLength(units[end]);
      if (bytes + size > maxBytes) break;
      if (units[end] === " " && end > start) lastSpace = end;
      bytes += size;
      end++;
    }
    // We still have to send a unit that is wider than a whole part.
    if (end === start) end = start + 1;

    let next = end;
    const breaksInsideWord = end < units.length && units[end] !== " ";
    if (keepSpaces) {
      if (end < units.length && lastSpace !== -1) {
        end = lastSpace + 1;
        next = end;
      }
      parts.push(units.slice(start, end).join(""));
    } else {
      if (breaksInsideWord && lastSpace !== -1) {
        end = lastSpace;
        next = lastSpace + 1;
      }
      while (end > start && units[end - 1] === " ") end--;
      while (next < units.length && units[next] === " ") next++;
      const part = units.slice(start, end).join("");
      if (part.trim()) parts.push(part);
    }
    start = next;
  }

  return parts;
};

/**
 * Splits a message into the parts one PRIVMSG to `target` can carry.
 * @param preserveBoundarySpace - see `keepSpaces` of `splitToBytes`
 */
export const splitLongMessage = (
  message: string,
  target = "#channel",
  preserveBoundarySpace = false,
): string[] =>
  splitToBytes(message, maxMessageBytes(target), preserveBoundarySpace);

/**
 * Calculate protocol overhead for a given target
 * @param target - The channel or username
 * @returns The number of bytes used by protocol overhead
 */
export const calculateProtocolOverhead = (target: string): number => {
  const maxNickLength = 20;
  const maxUserLength = 20;
  const maxHostLength = 63;

  return (
    1 + // ':'
    maxNickLength +
    1 + // '!'
    maxUserLength +
    1 + // '@'
    maxHostLength +
    1 + // ' '
    7 + // 'PRIVMSG'
    1 + // ' '
    byteLength(target) +
    2 + // ' :'
    2 + // '\r\n'
    10
  ); // safety buffer
};

/**
 * Generate a unique batch ID for multiline messages
 * @returns A unique batch identifier
 */
export const createBatchId = (): string => {
  return `ml-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};
