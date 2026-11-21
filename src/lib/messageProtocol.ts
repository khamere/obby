/// <reference lib="es2022.intl" />
/**
 * IRC protocol utilities for message handling
 */

const encoder = new TextEncoder();

// We count bytes because the IRC line limit applies on the wire, where one character takes up to four.
const byteLength = (text: string): number => encoder.encode(text).length;

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
    byteLength(cluster) > limit ? Array.from(cluster) : [cluster],
  );
};

/** The number of message bytes one PRIVMSG to `target` can carry. */
const maxMessageBytes = (target: string): number =>
  512 - calculateProtocolOverhead(target);

export const exceedsLineLimit = (message: string, target: string): boolean =>
  byteLength(message) > maxMessageBytes(target);

/**
 * Helper function to split long messages while respecting IRC protocol limits
 * @param message - The message to split
 * @param target - The channel or username target
 * @param preserveBoundarySpace - When true, the parts concatenate back to
 *   the exact message, so a draft/multiline-concat join reconstructs the
 *   text with its spacing intact.  By default the parts go out as
 *   independent PRIVMSGs and the space at a split point becomes the
 *   line break.
 * @returns Array of message chunks within IRC limits
 */
export const splitLongMessage = (
  message: string,
  target = "#channel",
  preserveBoundarySpace = false,
): string[] => {
  const limit = maxMessageBytes(target);

  if (byteLength(message) <= limit) {
    return [message];
  }

  const units = splitUnits(message, limit);
  const sizes = units.map(byteLength);
  const lines: string[] = [];
  let start = 0;

  while (start < units.length) {
    let end = start;
    let bytes = 0;
    while (end < units.length && bytes + sizes[end] <= limit) {
      bytes += sizes[end];
      end++;
    }
    // We still have to send a unit that is wider than a whole line.
    if (end === start) end = start + 1;

    let next = end;
    if (end < units.length) {
      if (!preserveBoundarySpace && units[end] === " ") {
        next = end + 1;
      } else {
        const space = units.lastIndexOf(" ", end - 1);
        if (space > start) {
          end = preserveBoundarySpace ? space + 1 : space;
          next = space + 1;
        }
      }
    }

    lines.push(units.slice(start, end).join(""));
    start = next;
  }

  return lines;
};

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
