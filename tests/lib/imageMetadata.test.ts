import { describe, expect, test } from "vitest";
import {
  canStripMetadata,
  stripImageFile,
  stripImageMetadata,
} from "../../src/lib/imageMetadata";

// ---- byte builders -----------------------------------------------------------

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const u32be = (n: number) =>
  Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u32le = (n: number) =>
  Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const u16be = (n: number) => Uint8Array.of((n >>> 8) & 255, n & 255);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const includes = (hay: Uint8Array, needle: Uint8Array) =>
  hex(hay).includes(hex(needle));

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
// CRC is not validated by the stripper, so a fixed one keeps the builders short.
const pngChunk = (type: string, data: Uint8Array) =>
  cat(u32be(data.length), ascii(type), data, u32be(0xdeadbeef));
const IHDR = pngChunk(
  "IHDR",
  Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0),
);
const IDAT = pngChunk("IDAT", Uint8Array.of(1, 2, 3, 4, 5));
const IEND = pngChunk("IEND", new Uint8Array(0));

const jpegSeg = (marker: number, payload: Uint8Array) =>
  cat(Uint8Array.of(0xff, marker), u16be(payload.length + 2), payload);
const SOI = Uint8Array.of(0xff, 0xd8);
const APP0 = jpegSeg(
  0xe0,
  cat(ascii("JFIF\0"), Uint8Array.of(1, 1, 0, 0, 1, 0, 1, 0, 0)),
);
const DQT = jpegSeg(0xdb, Uint8Array.of(0, 1, 1, 1));
const SOF0 = jpegSeg(0xc0, Uint8Array.of(8, 0, 1, 0, 1, 1, 1, 0x11, 0));
// Scan header followed by entropy-coded data up to EOI.
const SOS_AND_DATA = cat(
  jpegSeg(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)),
  Uint8Array.of(0x12, 0x34, 0xff, 0x00, 0x56),
  Uint8Array.of(0xff, 0xd9),
);
// Little-endian TIFF with Make="Cam" (0x010f) and Orientation (0x0112).
const exifPayload = (orientation: number) => {
  const tiff = cat(
    ascii("II"),
    Uint8Array.of(0x2a, 0),
    u32le(8),
    Uint8Array.of(2, 0),
    // Make, ASCII, count 4, value offset 34 (after the IFD)
    Uint8Array.of(0x0f, 0x01, 2, 0),
    u32le(4),
    u32le(8 + 2 + 24 + 4),
    // Orientation, SHORT, count 1, inline value
    Uint8Array.of(0x12, 0x01, 3, 0),
    u32le(1),
    Uint8Array.of(orientation, 0, 0, 0),
    u32le(0),
    ascii("Cam\0"),
  );
  return cat(ascii("Exif\0\0"), tiff);
};

const webpChunk = (type: string, data: Uint8Array) =>
  cat(
    ascii(type),
    u32le(data.length),
    data,
    data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0),
  );
const webp = (...chunks: Uint8Array[]) => {
  const body = cat(ascii("WEBP"), ...chunks);
  return cat(ascii("RIFF"), u32le(body.length), body);
};
// VP8X flags: bit 3 = EXIF, bit 2 = XMP, bit 4 = alpha.
const vp8x = (flags: number) =>
  webpChunk("VP8X", Uint8Array.of(flags, 0, 0, 0, 0, 0, 0, 0, 0, 0));
const VP8 = webpChunk("VP8 ", Uint8Array.of(9, 8, 7));

// ---- PNG ---------------------------------------------------------------------

describe("stripImageMetadata: PNG", () => {
  test("drops text, time and exif chunks and keeps the image chunks", () => {
    const input = cat(
      PNG_SIG,
      IHDR,
      pngChunk("tEXt", ascii("Screen\0eDP-1")),
      pngChunk("iTXt", ascii("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>")),
      pngChunk("zTXt", ascii("Comment\0\0zz")),
      pngChunk("tIME", new Uint8Array(7)),
      pngChunk("eXIf", exifPayload(1).subarray(6)),
      IDAT,
      IEND,
    );
    const out = stripImageMetadata(input, "image/png");
    expect(out).not.toBeNull();
    expect(out).toEqual(cat(PNG_SIG, IHDR, IDAT, IEND));
  });

  test("keeps colour chunks the viewer needs", () => {
    const iccp = pngChunk("iCCP", ascii("sRGB\0\0icc"));
    const phys = pngChunk("pHYs", new Uint8Array(9));
    const srgb = pngChunk("sRGB", Uint8Array.of(0));
    const input = cat(PNG_SIG, IHDR, iccp, phys, srgb, IDAT, IEND);
    expect(stripImageMetadata(input, "image/png")).toEqual(input);
  });

  test("rejects a truncated chunk instead of guessing", () => {
    const input = cat(PNG_SIG, IHDR, u32be(500), ascii("tEXt"), ascii("abc"));
    expect(() => stripImageMetadata(input, "image/png")).toThrow();
  });
});

// ---- JPEG --------------------------------------------------------------------

describe("stripImageMetadata: JPEG", () => {
  test("drops EXIF, XMP, IPTC and comment segments", () => {
    const input = cat(
      SOI,
      APP0,
      jpegSeg(0xe1, exifPayload(1)),
      jpegSeg(
        0xe1,
        cat(ascii("http://ns.adobe.com/xap/1.0/\0"), ascii("<x:xmpmeta/>")),
      ),
      jpegSeg(0xed, cat(ascii("Photoshop 3.0\0"), ascii("8BIM"))),
      jpegSeg(0xfe, ascii("a comment")),
      DQT,
      SOF0,
      SOS_AND_DATA,
    );
    const out = stripImageMetadata(input, "image/jpeg");
    expect(out).toEqual(cat(SOI, APP0, DQT, SOF0, SOS_AND_DATA));
  });

  test("keeps the ICC profile and Adobe segments", () => {
    const icc = jpegSeg(
      0xe2,
      cat(ascii("ICC_PROFILE\0"), Uint8Array.of(1, 1, 9, 9)),
    );
    const adobe = jpegSeg(
      0xee,
      cat(ascii("Adobe"), Uint8Array.of(0, 100, 0, 0, 0, 0, 1)),
    );
    const input = cat(SOI, APP0, icc, adobe, DQT, SOF0, SOS_AND_DATA);
    expect(stripImageMetadata(input, "image/jpeg")).toEqual(input);
  });

  test("keeps a non-default orientation as the only EXIF tag", () => {
    const input = cat(
      SOI,
      APP0,
      jpegSeg(0xe1, exifPayload(6)),
      DQT,
      SOF0,
      SOS_AND_DATA,
    );
    const out = stripImageMetadata(input, "image/jpeg");
    expect(out).not.toBeNull();
    const o = out as Uint8Array;
    expect(includes(o, ascii("Cam"))).toBe(false);
    expect(includes(o, ascii("Exif\0\0"))).toBe(true);
    expect(o.length).toBeLessThan(input.length);
    // Round trip: stripping again changes nothing and still reports orientation 6.
    expect(stripImageMetadata(o, "image/jpeg")).toEqual(o);
    const exifAt = hex(o).indexOf(hex(ascii("Exif\0\0"))) / 2;
    const tiff = o.subarray(exifAt + 6);
    const le = tiff[0] === 0x49;
    const ifd = le ? tiff[4] | (tiff[5] << 8) : (tiff[6] << 8) | tiff[7];
    const count = le
      ? tiff[ifd] | (tiff[ifd + 1] << 8)
      : (tiff[ifd] << 8) | tiff[ifd + 1];
    expect(count).toBe(1);
    const tag = le
      ? tiff[ifd + 2] | (tiff[ifd + 3] << 8)
      : (tiff[ifd + 2] << 8) | tiff[ifd + 3];
    expect(tag).toBe(0x0112);
    const value = le
      ? tiff[ifd + 10] | (tiff[ifd + 11] << 8)
      : (tiff[ifd + 10] << 8) | tiff[ifd + 11];
    expect(value).toBe(6);
  });

  test("does not touch bytes after the scan starts", () => {
    // A marker-like sequence inside the entropy data must survive untouched.
    const input = cat(SOI, APP0, DQT, SOF0, SOS_AND_DATA);
    expect(stripImageMetadata(input, "image/jpeg")).toEqual(input);
  });

  test("drops anything after the end-of-image marker", () => {
    // Trailers after EOI hide embedded videos, GPS blobs or arbitrary data.
    const input = cat(
      SOI,
      APP0,
      DQT,
      SOF0,
      SOS_AND_DATA,
      ascii("ftypmp42 trailer"),
    );
    expect(stripImageMetadata(input, "image/jpeg")).toEqual(
      cat(SOI, APP0, DQT, SOF0, SOS_AND_DATA),
    );
  });

  test("filters segments between the scans of a progressive JPEG", () => {
    const scan = (data: Uint8Array) =>
      cat(jpegSeg(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)), data);
    const entropy = Uint8Array.of(0x12, 0xff, 0x00, 0xff, 0xd0, 0x34);
    const input = cat(
      SOI,
      APP0,
      DQT,
      SOF0,
      scan(entropy),
      jpegSeg(0xfe, ascii("late comment")),
      jpegSeg(0xe1, exifPayload(1)),
      DQT,
      scan(entropy),
      Uint8Array.of(0xff, 0xd9),
    );
    expect(stripImageMetadata(input, "image/jpeg")).toEqual(
      cat(
        SOI,
        APP0,
        DQT,
        SOF0,
        scan(entropy),
        DQT,
        scan(entropy),
        Uint8Array.of(0xff, 0xd9),
      ),
    );
  });

  test("rejects a segment that runs past the end", () => {
    const input = cat(
      SOI,
      Uint8Array.of(0xff, 0xe1),
      u16be(9000),
      ascii("Exif"),
    );
    expect(() => stripImageMetadata(input, "image/jpeg")).toThrow();
  });
});

// ---- WebP --------------------------------------------------------------------

describe("stripImageMetadata: WebP", () => {
  test("drops EXIF and XMP chunks, clears the VP8X flags and fixes the RIFF size", () => {
    const input = webp(
      vp8x(0x08 | 0x04 | 0x10),
      VP8,
      webpChunk("EXIF", exifPayload(1).subarray(6)),
      webpChunk("XMP ", ascii("<x:xmpmeta/>")),
    );
    const out = stripImageMetadata(input, "image/webp");
    expect(out).toEqual(webp(vp8x(0x10), VP8));
  });

  test("leaves a simple WebP without metadata alone", () => {
    const input = webp(VP8);
    expect(stripImageMetadata(input, "image/webp")).toEqual(input);
  });
});

// ---- other types -------------------------------------------------------------

describe("stripImageMetadata: other", () => {
  test("returns null for types it cannot handle", () => {
    expect(stripImageMetadata(ascii("GIF89a...."), "image/gif")).toBeNull();
    expect(stripImageMetadata(ascii("....ftypmp42"), "video/mp4")).toBeNull();
  });

  test("goes by the bytes when the declared type lies", () => {
    const png = cat(PNG_SIG, IHDR, pngChunk("tEXt", ascii("k\0v")), IDAT, IEND);
    expect(stripImageMetadata(png, "application/octet-stream")).toEqual(
      cat(PNG_SIG, IHDR, IDAT, IEND),
    );
  });

  test("canStripMetadata names the supported image types", () => {
    expect(canStripMetadata("image/png")).toBe(true);
    expect(canStripMetadata("image/jpeg")).toBe(true);
    expect(canStripMetadata("image/webp")).toBe(true);
    expect(canStripMetadata("image/gif")).toBe(false);
    expect(canStripMetadata("video/webm")).toBe(false);
  });
});

// ---- File wrapper ------------------------------------------------------------

// jsdom's File has no arrayBuffer(); FileReader works in both.
const fileBytes = (file: File) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });

describe("stripImageFile", () => {
  test("returns a new File with the same name and type, minus the metadata", async () => {
    const bytes = cat(
      PNG_SIG,
      IHDR,
      pngChunk("tEXt", ascii("Screen\0eDP-1")),
      IDAT,
      IEND,
    );
    const file = new File([bytes], "shot.png", { type: "image/png" });
    const out = await stripImageFile(file);
    expect(out).not.toBe(file);
    expect(out.name).toBe("shot.png");
    expect(out.type).toBe("image/png");
    expect(await fileBytes(out)).toEqual(cat(PNG_SIG, IHDR, IDAT, IEND));
  });

  test("hands back the same File when there is nothing to remove", async () => {
    const file = new File([cat(PNG_SIG, IHDR, IDAT, IEND)], "a.png", {
      type: "image/png",
    });
    expect(await stripImageFile(file)).toBe(file);
  });

  test("goes by the bytes when a File's declared type lies", async () => {
    const bytes = cat(
      PNG_SIG,
      IHDR,
      pngChunk("tEXt", ascii("k\0v")),
      IDAT,
      IEND,
    );
    const file = new File([bytes], "shot.gif", { type: "image/gif" });
    const out = await stripImageFile(file);
    expect(await fileBytes(out)).toEqual(cat(PNG_SIG, IHDR, IDAT, IEND));
  });

  test("hands back the same File for a type it does not handle", async () => {
    const file = new File([ascii("GIF89a")], "a.gif", { type: "image/gif" });
    expect(await stripImageFile(file)).toBe(file);
  });
});
