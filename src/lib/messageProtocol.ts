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
const splitGraphemes = (text: string, limit: number): string[] => {
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

const FORMAT_CODE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: IRC formatting codes
  /(\x04(?:[0-9A-Fa-f]{6}(?:,[0-9A-Fa-f]{6})?)?|\x03(?:\d{1,2}(?:,\d{1,2})?)?|[\x02\x1D\x1F\x1E\x16\x11\x0F])/;
const FORMAT_CODES = new RegExp(FORMAT_CODE, "g");
const RESET = "\x0F";

const isFormatCode = (unit: string): boolean =>
  "\x02\x03\x04\x0F\x11\x16\x1D\x1E\x1F".includes(unit[0]);

// A formatting code with its colour digits is one unit, so a cut never lands inside it.
const splitUnits = (text: string, limit: number): string[] => {
  const units = text
    .split(FORMAT_CODE)
    .flatMap((piece, index) =>
      index % 2 ? [piece] : splitGraphemes(piece, limit),
    );
  // The codes that close the text stay with its last character, so no part holds codes alone.
  let tail = units.length;
  while (tail > 0 && isFormatCode(units[tail - 1])) tail--;
  const last = units.slice(tail - 1).join("");
  if (tail > 0 && tail < units.length && byteLength(last) <= limit)
    units.splice(tail - 1, units.length, last);
  return units;
};

/** The formatting a reader has switched on at one point of a line. */
interface OpenFormat {
  toggles: string;
  /** The last colour code that set a background, and the foreground-only code after it. */
  ground: string;
  ink: string;
}

const NO_FORMAT: OpenFormat = { toggles: "", ground: "", ink: "" };

const applyFormatCode = (open: OpenFormat, code: string): OpenFormat => {
  if (code === RESET) return NO_FORMAT;
  if (code[0] !== "\x03" && code[0] !== "\x04")
    return {
      ...open,
      toggles: open.toggles.includes(code)
        ? open.toggles.replace(code, "")
        : open.toggles + code,
    };
  if (code.length === 1) return { ...open, ground: "", ink: "" };
  // We write two digits so a number that starts the next part stays text.
  const colour =
    code[0] === "\x03"
      ? code.replace(/\d+/g, (digits) => digits.padStart(2, "0"))
      : code;
  return colour.includes(",")
    ? { ...open, ground: colour, ink: "" }
    : { ...open, ink: colour };
};

// Clients differ on whether a foreground-only code keeps the background, so we replay both codes.
// The reader of a concat still has the earlier codes open, so there we reset before we re-open.
const reopenFormat = (
  open: OpenFormat,
  nextUnit: string,
  joined: boolean,
): string => {
  // Two bold toggles keep a comma that starts the part from reading as a background colour.
  const guard =
    open.ink && !open.toggles && nextUnit.startsWith(",") ? "\x02\x02" : "";
  const codes = open.ground + open.ink + open.toggles + guard;
  return codes && joined ? RESET + codes : codes;
};

const LINK_START = /(?:https?|ircs?):\/\/|www\./i;

// A reader who joins the parts follows a link only while no code interrupts its address.
const cutsLink = (units: readonly string[], cut: number): boolean => {
  if (units[cut] === " ") return false;
  let wordStart = cut;
  while (wordStart > 0 && units[wordStart - 1] !== " ") wordStart--;
  return LINK_START.test(units.slice(wordStart, cut).join(""));
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
 * With `keepSpaces` the parts concatenate back to the line, as the
 * receiver of a draft/multiline-concat joins them. By default each part is a
 * message of its own, so the spaces at a split point become the line break.
 * A word that fits a part, a link included, is never cut.
 * Each part is a line of its own to a reader without draft/multiline, so a
 * part starts with the formatting codes that are open where it begins. A
 * `keepSpaces` part that begins inside a link starts with the link's own
 * bytes, so the joined address stays one link.
 */
export const splitToBytes = (
  line: string,
  maxBytes: number,
  keepSpaces = false,
): string[] => {
  if (byteLength(line) <= maxBytes) return [line];
  return cutToBytes(line, maxBytes, keepSpaces);
};

const cutToBytes = (
  text: string,
  maxBytes: number,
  keepSpaces: boolean,
): string[] => {
  const units = splitUnits(text, maxBytes);
  const parts: string[] = [];
  let open = NO_FORMAT;
  let start = 0;

  while (start < units.length) {
    let prefix = reopenFormat(open, units[start], keepSpaces);
    if (prefix && keepSpaces && cutsLink(units, start)) prefix = "";
    let end = start;
    let bytes = prefix.length;
    let lastSpace = -1;
    while (end < units.length) {
      const size = byteLength(units[end]);
      if (bytes + size > maxBytes) break;
      if (units[end] === " " && end > start) lastSpace = end;
      bytes += size;
      end++;
    }
    // We still have to send a unit that is wider than a whole part, and it goes out bare when the codes leave it no room.
    if (end === start) {
      end = start + 1;
      prefix = "";
    }

    let next = end;
    const breaksInsideWord = end < units.length && units[end] !== " ";
    if (keepSpaces) {
      if (end < units.length && lastSpace !== -1) {
        end = lastSpace + 1;
        next = end;
      }
      parts.push(prefix + units.slice(start, end).join(""));
    } else {
      if (breaksInsideWord && lastSpace !== -1) {
        end = lastSpace;
        next = lastSpace + 1;
      }
      while (end > start && units[end - 1] === " ") end--;
      while (next < units.length && units[next] === " ") next++;
      const part = units.slice(start, end).join("");
      if (part.replace(FORMAT_CODES, "").trim()) parts.push(prefix + part);
    }
    for (const unit of units.slice(start, next))
      if (isFormatCode(unit)) open = applyFormatCode(open, unit);
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

const ctcpAction = (text: string): string => `\u0001ACTION ${text}\u0001`;

/** Splits an action into the complete CTCP ACTION messages one PRIVMSG to `target` can carry each. */
export const splitAction = (action: string, target: string): string[] =>
  splitToBytes(
    action,
    maxMessageBytes(target) - byteLength(ctcpAction("")),
  ).map(ctcpAction);

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
