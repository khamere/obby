// Removes metadata from images before they leave the browser.
//
// Screenshots and photos carry more than pixels: EXIF (camera, GPS, time),
// XMP, IPTC, comments and, for desktop screenshots, text chunks naming the
// monitor and window position. This strips those containers from PNG, JPEG
// and WebP by walking each format's own structure and leaving out the chunks
// or segments that only hold metadata. Pixels are never re-encoded, so the
// image looks the same and colour information (ICC profiles) is kept.
//
// JPEG is the one format where metadata changes how the picture is shown:
// phone photos store their rotation in the EXIF Orientation tag. That tag is
// kept, alone, in a minimal EXIF block when it is not the default.
//
// Parsers throw on malformed input rather than guess; the caller decides
// whether to fail the upload or send the file as-is.

const STRIPPABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Whether this MIME type is one the stripper understands. */
export function canStripMetadata(mime: string): boolean {
  return STRIPPABLE.has(mime.toLowerCase());
}

/**
 * Returns the image with its metadata removed, or null when the bytes are not
 * a format this handles. The format is detected from the bytes, not from the
 * declared type. Throws when the file is structurally broken.
 */
export function stripImageMetadata(
  bytes: Uint8Array,
  _declaredType: string,
): Uint8Array | null {
  if (isPng(bytes)) return stripPng(bytes);
  if (isJpeg(bytes)) return stripJpeg(bytes);
  if (isWebp(bytes)) return stripWebp(bytes);
  return null;
}

/**
 * Strips a File. Resolves with the same File when its bytes are not a handled
 * format or nothing was removed, otherwise with a new File of the same name
 * and type. The format is read from the bytes, so a PNG under a wrong
 * extension is still stripped; only files whose declared type says they are
 * not an image at all are skipped without being read.
 */
export async function stripImageFile(file: File): Promise<File> {
  if (!mayBeImage(file.type)) return file;
  const bytes = await readBytes(file);
  const out = stripImageMetadata(bytes, file.type);
  if (!out || sameBytes(out, bytes)) return file;
  return new File([out as BlobPart], file.name, { type: file.type });
}

function mayBeImage(type: string): boolean {
  const t = type.toLowerCase();
  return t === "" || t === "application/octet-stream" || t.startsWith("image/");
}

function readBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function")
    return file.arrayBuffer().then((buf) => new Uint8Array(buf));
  // Older WebKit and jsdom have no Blob.arrayBuffer.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// ---- shared ------------------------------------------------------------------

class Builder {
  private parts: Uint8Array[] = [];
  private size = 0;
  push(part: Uint8Array): void {
    this.parts.push(part);
    this.size += part.length;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

function startsWith(b: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++)
    if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function u32be(b: Uint8Array, at: number): number {
  return (
    ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
  );
}
function u32le(b: Uint8Array, at: number): number {
  return (
    ((b[at + 3] << 24) | (b[at + 2] << 16) | (b[at + 1] << 8) | b[at]) >>> 0
  );
}
function u16be(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}
function u16le(b: Uint8Array, at: number): number {
  return (b[at + 1] << 8) | b[at];
}

// ---- PNG ---------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Chunks that only carry metadata. Everything else (IHDR, PLTE, IDAT, iCCP,
// sRGB, gAMA, pHYs, acTL/fcTL/fdAT for APNG, ...) is kept.
const PNG_METADATA_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function isPng(b: Uint8Array): boolean {
  return (
    b.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((v, i) => b[i] === v)
  );
}

function stripPng(b: Uint8Array): Uint8Array {
  const out = new Builder();
  out.push(b.subarray(0, 8));
  let at = 8;
  for (;;) {
    if (at + 8 > b.length) throw new Error("PNG ends inside a chunk header");
    const length = u32be(b, at);
    const end = at + 12 + length;
    if (end > b.length)
      throw new Error("PNG chunk runs past the end of the file");
    const type = fourcc(b, at + 4);
    if (!PNG_METADATA_CHUNKS.has(type)) out.push(b.subarray(at, end));
    at = end;
    // Anything after IEND is not part of the image; it goes too.
    if (type === "IEND") return out.bytes();
  }
}

// ---- JPEG --------------------------------------------------------------------

const JPEG_APP1 = 0xe1;
const JPEG_APP2 = 0xe2;
const JPEG_APP14 = 0xee;
const JPEG_COM = 0xfe;
const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;
const EXIF_ORIENTATION_TAG = 0x0112;

function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isStandaloneMarker(marker: number): boolean {
  // SOI, EOI, RSTn and TEM have no length field.
  return (
    marker === 0xd8 ||
    marker === JPEG_EOI ||
    (marker >= 0xd0 && marker <= 0xd7) ||
    marker === 0x01
  );
}

function stripJpeg(b: Uint8Array): Uint8Array {
  const out = new Builder();
  out.push(b.subarray(0, 2));
  let at = 2;
  while (at < b.length) {
    if (b[at] !== 0xff)
      throw new Error("JPEG segment does not start with a marker");
    // Fill bytes before a marker are allowed.
    while (at < b.length && b[at] === 0xff) at++;
    if (at >= b.length) throw new Error("JPEG ends inside a marker");
    const marker = b[at];
    const markerStart = at - 1;
    at++;
    if (marker === JPEG_EOI) {
      // Anything after the end of image (trailers with embedded videos, GPS
      // blobs or arbitrary data) is not part of the picture; it goes too.
      out.push(b.subarray(markerStart, at));
      return out.bytes();
    }
    if (isStandaloneMarker(marker)) {
      out.push(b.subarray(markerStart, at));
      continue;
    }
    if (at + 2 > b.length) throw new Error("JPEG ends inside a segment length");
    const length = u16be(b, at);
    if (length < 2) throw new Error("JPEG segment length is too short");
    const end = at + length;
    if (end > b.length)
      throw new Error("JPEG segment runs past the end of the file");
    const payloadAt = at + 2;
    const segment = b.subarray(markerStart, end);
    at = end;

    if (marker === JPEG_SOS) {
      // The scan header is followed by entropy-coded data, in which 0xFF is
      // always escaped as FF00 or followed by a restart marker. The data runs
      // to the next real marker, and segments between scans (progressive
      // JPEG) are filtered like the ones before the first scan.
      let scanEnd = end;
      while (scanEnd < b.length) {
        if (b[scanEnd] !== 0xff) {
          scanEnd++;
          continue;
        }
        const next = b[scanEnd + 1];
        if (next === undefined) throw new Error("JPEG ends inside a marker");
        if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
          scanEnd += next === 0xff ? 1 : 2;
          continue;
        }
        break;
      }
      out.push(b.subarray(markerStart, scanEnd));
      at = scanEnd;
      continue;
    }
    if (marker === JPEG_APP1) {
      if (startsWith(b, payloadAt, "Exif\0\0")) {
        const orientation = exifOrientation(b.subarray(payloadAt + 6, end));
        if (orientation > 1) out.push(minimalExifSegment(orientation));
      }
      // XMP and anything else in APP1 is dropped.
      continue;
    }
    if (marker === JPEG_APP2) {
      // Colour profile stays; FlashPix, MPF and other APP2 payloads do not.
      if (startsWith(b, payloadAt, "ICC_PROFILE\0")) out.push(segment);
      continue;
    }
    if (marker === JPEG_APP14) {
      // Adobe segment carries the colour transform; it is needed to decode.
      out.push(segment);
      continue;
    }
    if ((marker >= 0xe3 && marker <= 0xef) || marker === JPEG_COM) {
      // APP3..APP13, APP15 (IPTC, Photoshop, Ducky, ...) and comments.
      continue;
    }
    out.push(segment);
  }
  throw new Error("JPEG has no end-of-image marker");
}

/**
 * Reads the Orientation tag out of a TIFF-structured EXIF block. Anything
 * malformed reads as 1 (the default), which makes the whole block droppable.
 */
function exifOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return 1;
  const u16 = le ? u16le : u16be;
  const u32 = le ? u32le : u32be;
  if (u16(tiff, 2) !== 0x2a) return 1;
  const ifd = u32(tiff, 4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(tiff, ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 1;
    if (u16(tiff, entry) !== EXIF_ORIENTATION_TAG) continue;
    const type = u16(tiff, entry + 2);
    const n = u32(tiff, entry + 4);
    if (type !== 3 || n !== 1) return 1;
    const value = u16(tiff, entry + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/** An APP1 segment whose EXIF holds only the Orientation tag. */
function minimalExifSegment(orientation: number): Uint8Array {
  const payload = Uint8Array.of(
    // "Exif\0\0"
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00,
    // TIFF header: little endian, magic 42, IFD0 at offset 8
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00,
    // one entry
    0x01,
    0x00,
    // tag 0x0112, type SHORT, count 1, value
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    // no next IFD
    0x00,
    0x00,
    0x00,
    0x00,
  );
  const length = payload.length + 2;
  return Uint8Array.of(0xff, JPEG_APP1, length >> 8, length & 0xff, ...payload);
}

// ---- WebP --------------------------------------------------------------------

const WEBP_METADATA_CHUNKS = new Set(["EXIF", "XMP "]);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

function isWebp(b: Uint8Array): boolean {
  return b.length >= 12 && startsWith(b, 0, "RIFF") && startsWith(b, 8, "WEBP");
}

function stripWebp(b: Uint8Array): Uint8Array {
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd > b.length)
    throw new Error("WebP RIFF size runs past the end of the file");
  const chunks: Uint8Array[] = [];
  let at = 12;
  while (at < riffEnd) {
    if (at + 8 > riffEnd) throw new Error("WebP ends inside a chunk header");
    const type = fourcc(b, at);
    const size = u32le(b, at + 4);
    const end = at + 8 + size + (size % 2);
    if (at + 8 + size > riffEnd)
      throw new Error("WebP chunk runs past the end of the file");
    if (!WEBP_METADATA_CHUNKS.has(type)) {
      const chunk = b.slice(at, Math.min(end, riffEnd));
      // The extended header advertises EXIF/XMP chunks; say they are gone.
      if (type === "VP8X" && size >= 1)
        chunk[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      chunks.push(chunk);
    }
    at = end;
  }
  const bodySize = 4 + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Builder();
  out.push(
    Uint8Array.of(
      0x52,
      0x49,
      0x46,
      0x46,
      bodySize & 0xff,
      (bodySize >>> 8) & 0xff,
      (bodySize >>> 16) & 0xff,
      (bodySize >>> 24) & 0xff,
      0x57,
      0x45,
      0x42,
      0x50,
    ),
  );
  for (const c of chunks) out.push(c);
  return out.bytes();
}
