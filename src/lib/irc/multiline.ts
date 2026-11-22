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

// `lines` holds one entry per logical line, already split into the parts that
// fit a single PRIVMSG, and each line fits a batch by itself (`fitsOneBatch`). A logical line's parts stay in one batch: the receiver
// concatenates them, so a batch break between them lands mid-word. The server
// counts the line break between two logical lines as a byte of the batch.
export function chunkForMultiline(
  lines: readonly (readonly string[])[],
  limits: MultilineLimits,
): string[][][] {
  const batches: string[][][] = [];
  let batch: string[][] = [];
  let lineCount = 0;
  let byteCount = 0;

  const flush = () => {
    if (batch.length === 0) return;
    batches.push(batch);
    batch = [];
    lineCount = 0;
    byteCount = 0;
  };

  for (const line of lines) {
    const bytes = line.reduce((n, part) => n + byteLength(part), 0);
    if (
      batch.length > 0 &&
      (lineCount + line.length > limits.maxLines ||
        byteCount + 1 + bytes > limits.maxBytes)
    ) {
      flush();
    }
    byteCount += bytes + (batch.length > 0 ? 1 : 0);
    batch.push([...line]);
    lineCount += line.length;
  }
  flush();
  return batches;
}
