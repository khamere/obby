// draft/multiline caps a batch by line count and by total bytes, and a server
// refuses an oversized batch whole rather than trimming it (obbyircd answers
// `FAIL BATCH MULTILINE_MAX_LINES`, and the message reaches nobody), so a long
// paste is split across batches before it goes out.

import { byteLength } from "../messageProtocol";

export interface MultilineLimits {
  maxLines: number;
  maxBytes: number;
}

export const UNLIMITED_MULTILINE: MultilineLimits = {
  maxLines: Number.POSITIVE_INFINITY,
  maxBytes: Number.POSITIVE_INFINITY,
};

// The cap value looks like `max-bytes=5250,max-lines=15`.
export function parseMultilineLimits(
  capValue: string | undefined,
): MultilineLimits {
  if (!capValue) return UNLIMITED_MULTILINE;
  const limits = { ...UNLIMITED_MULTILINE };
  for (const token of capValue.split(",")) {
    const [key, raw] = token.split("=", 2);
    const value = Number.parseInt(raw ?? "", 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (key === "max-lines") limits.maxLines = value;
    if (key === "max-bytes") limits.maxBytes = value;
  }
  return limits;
}

// A batch holds a line whole or not at all: its parts count as lines of the
// batch and their bytes add up against the byte ceiling.
export function fitsOneBatch(
  parts: readonly string[],
  limits: MultilineLimits,
): boolean {
  return (
    parts.length <= limits.maxLines &&
    parts.reduce((n, part) => n + byteLength(part), 0) <= limits.maxBytes
  );
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const MAX_FENCE_MARKER = 32;
const MAX_FENCE_WORD = 32;

function closingFence(open: string): string {
  return /^(`+|~+)/.exec(open)?.[1] ?? "```";
}

// We repeat a fence at the top of every later batch, so we keep its marker and language word and leave the rest of its line behind.
function reopeningFence(marker: string, info: string): string {
  const word = [...(info.trim().split(/\s/, 1)[0] ?? "")];
  return marker + word.slice(0, MAX_FENCE_WORD).join("");
}

// Returns the fence still open after `text`, given the one open before it.
// A backtick fence has no backtick in its info string, so ```code``` stays
// inline code.
function fenceAfter(text: string, open: string | null): string | null {
  if (!open) {
    const opener = FENCE_OPEN.exec(text);
    const isFence =
      opener &&
      opener[1].length <= MAX_FENCE_MARKER &&
      (opener[1][0] === "~" || !opener[2].includes("`"));
    return isFence ? reopeningFence(opener[1], opener[2]) : null;
  }
  const marker = FENCE_CLOSE.exec(text)?.[1];
  const closer = closingFence(open);
  const closes =
    marker && marker[0] === closer[0] && marker.length >= closer.length;
  return closes ? null : open;
}

const bytesOf = (parts: readonly string[]) =>
  parts.reduce((n, part) => n + byteLength(part), 0);

// `lines` holds one entry per logical line, already split into the parts that
// fit a single PRIVMSG. A logical line's parts stay in one batch: the receiver
// concatenates them, so a batch break between them lands mid-word.
// Each batch arrives as its own message, so a batch that ends inside a code
// fence closes it and the next one reopens it, which keeps every message
// valid markdown on its own.
// The server counts the break between two lines of a batch as a byte.
export function chunkForMultiline(
  lines: readonly (readonly string[])[],
  limits: MultilineLimits,
): string[][][] {
  const batches: string[][][] = [];
  let batch: string[][] = [];
  let lineCount = 0;
  let byteCount = 0;
  let fence: string | null = null;
  const carriesFences = limits.maxLines > 2;

  const add = (part: readonly string[]) => {
    byteCount += bytesOf(part) + (batch.length > 0 ? 1 : 0);
    batch.push([...part]);
    lineCount += part.length;
  };

  const close = (closer?: string) => {
    if (batch.length === 0) return;
    if (closer) batch.push([closer]);
    batches.push(batch);
    batch = [];
    lineCount = 0;
    byteCount = 0;
  };

  for (const line of lines) {
    const next = fenceAfter(line.join(""), fence);
    const before = carriesFences ? fence : null;
    const after = carriesFences ? next : null;
    const around = before ?? after;
    // A reopened fence and its closer share the batch with each piece.
    const pieceLimits = around
      ? {
          maxLines: limits.maxLines - 2,
          maxBytes: Math.max(
            1,
            limits.maxBytes -
              byteLength(around) -
              byteLength(closingFence(around)) -
              2,
          ),
        }
      : limits;
    const pieces = splitToFit(line, pieceLimits);
    pieces.forEach((piece, index) => {
      // The fence that is open right after this piece needs room for its closing line in the same batch.
      const stillOpen = index === pieces.length - 1 ? after : before;
      const closer = stillOpen ? closingFence(stillOpen) : null;
      const neededLines = piece.length + (closer ? 1 : 0);
      const neededBytes =
        bytesOf(piece) + (closer ? byteLength(closer) + 1 : 0);
      const fitsBehind = (usedLines: number, usedBytes: number) =>
        usedLines + neededLines <= limits.maxLines &&
        usedBytes + (usedLines > 0 ? 1 : 0) + neededBytes <= limits.maxBytes;

      if (batch.length > 0 && !fitsBehind(lineCount, byteCount))
        close(before ? closingFence(before) : undefined);
      if (batch.length === 0) {
        const opener = before ? [before] : [];
        if (!fitsBehind(opener.length, bytesOf(opener))) {
          // A piece that leaves no room for the fence lines goes out as a batch of its own, since a batch past the limits reaches nobody.
          batches.push([[...piece]]);
          return;
        }
        if (before) add(opener);
      }
      add(piece);
    });
    fence = next;
  }
  close();
  return batches;
}

// A line whose own parts fill more than one batch is broken across batches: two
// messages beat one the server refuses.
function splitToFit(
  line: readonly string[],
  limits: MultilineLimits,
): (readonly string[])[] {
  const out: (readonly string[])[] = [];
  let piece: string[] = [];
  let bytes = 0;
  for (const part of line) {
    const partBytes = byteLength(part);
    if (
      piece.length > 0 &&
      (piece.length + 1 > limits.maxLines ||
        bytes + partBytes > limits.maxBytes)
    ) {
      out.push(piece);
      piece = [];
      bytes = 0;
    }
    piece.push(part);
    bytes += partBytes;
  }
  if (piece.length > 0) out.push(piece);
  return out;
}
