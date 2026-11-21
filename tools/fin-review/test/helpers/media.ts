// Minimal, well-formed image and font files for the units tests: each is laid out end to end as
// its format, so a test can show what the engine exempts and, by changing a byte, what it does not.
// `planted` builds the opposite: a format's header whose length fields cover bytes of any kind.

import { brotliCompressSync, crc32, deflateSync } from "node:zlib";

function u16be(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

function u32be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function u32le(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]);
}

/** A 1x1 greyscale PNG: signature, IHDR, IDAT, IEND (with `extra` chunks before IEND). */
export function png(extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.concat([u32be(1), u32be(1), Buffer.from([8, 0, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))),
    ...extra,
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG's segments: SOI, APP0, SOF0, SOS with entropy-coded data (a stuffed 0xFF and a restart), EOI. */
export function jpeg(): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), u16be(16), Buffer.from("JFIF\0", "latin1"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
  const sof0 = Buffer.concat([Buffer.from([0xff, 0xc0]), u16be(11), Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])]);
  const sos = Buffer.concat([Buffer.from([0xff, 0xda]), u16be(8), Buffer.from([1, 1, 0, 0, 63, 0])]);
  const data = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, sos, data, Buffer.from([0xff, 0xd9])]);
}

/** A 1x1 GIF89a: screen descriptor, a two-colour table, a graphic control extension, one image, the trailer. */
export function gif(): Buffer {
  return Buffer.concat([
    Buffer.from("GIF89a", "latin1"),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0]),
    Buffer.from([0, 0, 0, 0xff, 0xff, 0xff]),
    Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([2, 2, 0x44, 0x01, 0]),
    Buffer.from([0x3b]),
  ]);
}

/** A lossless WebP: RIFF, its size, WEBP, one VP8L chunk (odd, so padded). */
export function webp(): Buffer {
  const chunk = Buffer.concat([Buffer.from("VP8L", "latin1"), u32le(5), Buffer.from([0x2f, 0, 0, 0, 0]), Buffer.from([0])]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(4 + chunk.length), Buffer.from("WEBP", "latin1"), chunk]);
}

function box(type: string, data: Buffer): Buffer {
  return Buffer.concat([u32be(8 + data.length), Buffer.from(type, "latin1"), data]);
}

/** An ISOBMFF full box: version, zero flags, then `data`. */
function fullBox(type: string, version: number, data: Buffer): Buffer {
  return box(type, Buffer.concat([Buffer.from([version, 0, 0, 0]), data]));
}

/**
 * An AVIF still image: ftyp (avif, compatible mif1), meta (hdlr pict, pitm, iloc, iinf with one
 * av01 item, iprp with ispe), and mdat holding the item's data, which iloc's one extent covers.
 */
export function avif(data: Buffer = Buffer.from([0x12, 0x00, 0x0a, 0x0b])): Buffer {
  const ftyp = box("ftyp", Buffer.from("avif\0\0\0\0avifmif1", "latin1"));
  const hdlr = fullBox("hdlr", 0, Buffer.concat([u32be(0), Buffer.from("pict", "latin1"), Buffer.alloc(12), Buffer.from("Picture\0", "latin1")]));
  const pitm = fullBox("pitm", 0, u16be(1));
  const iinf = fullBox("iinf", 0, Buffer.concat([u16be(1), fullBox("infe", 2, Buffer.concat([u16be(1), u16be(0), Buffer.from("av01Color\0", "latin1")]))]));
  const ipco = box("ipco", fullBox("ispe", 0, Buffer.concat([u32be(1), u32be(1)])));
  const iprp = box("iprp", Buffer.concat([ipco, fullBox("ipma", 0, Buffer.concat([u32be(1), u16be(1), Buffer.from([1, 0x81])]))]));
  // iloc version 0: four-byte offsets and lengths, no base offset; item 1, one extent.
  const iloc = (offset: number): Buffer => fullBox("iloc", 0, Buffer.concat([u16be(0x4400), u16be(1), u16be(1), u16be(0), u16be(1), u32be(offset), u32be(data.length)]));
  const meta = (offset: number): Buffer => fullBox("meta", 0, Buffer.concat([hdlr, pitm, iloc(offset), iinf, iprp]));
  const before = ftyp.length + meta(0).length;
  return Buffer.concat([ftyp, meta(before + 8), box("mdat", data)]);
}

/** A 1x1 24-bit BMP: file header, BITMAPINFOHEADER, one padded row. */
export function bmp(): Buffer {
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(1, 4);
  info.writeInt32LE(1, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(24, 14);
  const pixels = Buffer.from([0, 0, 0xff, 0]);
  const header = Buffer.concat([Buffer.from("BM", "latin1"), u32le(14 + 40 + pixels.length), Buffer.alloc(4), u32le(54)]);
  return Buffer.concat([header, info, pixels]);
}

/** A 3x2 8-bit BMP with a four-colour palette: rows of 3 bytes, each padded to 4. */
export function bmp8(): Buffer {
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(3, 4);
  info.writeInt32LE(2, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(8, 14);
  info.writeUInt32LE(4, 32);
  const palette = Buffer.from([0, 0, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0, 0xff, 0, 0, 0xff, 0, 0]);
  const pixels = Buffer.from([0, 1, 2, 0, 3, 2, 1, 0]);
  const offset = 14 + 40 + palette.length;
  const header = Buffer.concat([Buffer.from("BM", "latin1"), u32le(offset + pixels.length), Buffer.alloc(4), u32le(offset)]);
  return Buffer.concat([header, info, palette, pixels]);
}

/** A 1x1 32-bit bitmap as an ICO holds it: no file header, the height doubled, the colour row, then the mask row. */
export function icoBitmap(): Buffer {
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(1, 4);
  info.writeInt32LE(2, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  return Buffer.concat([info, Buffer.from([0x10, 0x20, 0x30, 0xff]), Buffer.alloc(4)]);
}

/** An ICO holding `images` (default: one PNG), one after another past the directory. */
export function ico(images: Buffer[] = [png()]): Buffer {
  const directory = 6 + 16 * images.length;
  const entries: Buffer[] = [];
  let offset = directory;
  for (const image of images) {
    entries.push(Buffer.concat([Buffer.from([1, 1, 0, 0, 1, 0, 32, 0]), u32le(image.length), u32le(offset)]));
    offset += image.length;
  }
  return Buffer.concat([Buffer.from([0, 0, 1, 0, images.length, 0]), ...entries, ...images]);
}

/** A font's head table: 54 bytes, version 1.0 and its magic number. */
export function headTable(): Buffer {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  return head;
}

/** A TrueType font with one table, head, carrying its magic number. */
export function ttf(): Buffer {
  const head = headTable();
  const directory = Buffer.concat([u32be(0x00010000), u16be(1), u16be(16), u16be(0), u16be(0), Buffer.from("head", "latin1"), u32be(0), u32be(28), u32be(head.length)]);
  return Buffer.concat([directory, padded(head)]);
}

/**
 * A WOFF with one table, head, stored as it is or zlib-compressed (or as `table`'s bytes), and
 * optionally an extended metadata block (zlib-compressed XML) and a private block, each on a
 * four-byte boundary.
 */
export function woff(options: { compressed?: boolean; table?: Buffer; metadata?: string; private?: Buffer } = {}): Buffer {
  const head = headTable();
  const table = options.table ?? (options.compressed === true ? deflateSync(head, { level: 9 }) : head);
  const header = Buffer.alloc(44);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(12 + 16 + 56, 16);
  const blocks: Buffer[] = [padded(table)];
  let at = 64 + padded(table).length;
  if (options.metadata !== undefined) {
    const metadata = deflateSync(Buffer.from(options.metadata, "utf8"));
    header.writeUInt32BE(at, 24);
    header.writeUInt32BE(metadata.length, 28);
    header.writeUInt32BE(Buffer.byteLength(options.metadata, "utf8"), 32);
    blocks.push(padded(metadata));
    at += padded(metadata).length;
  }
  if (options.private !== undefined) {
    header.writeUInt32BE(at, 36);
    header.writeUInt32BE(options.private.length, 40);
    blocks.push(options.private);
    at += options.private.length;
  }
  header.writeUInt32BE(at, 8);
  const entry = Buffer.concat([Buffer.from("head", "latin1"), u32be(64), u32be(table.length), u32be(head.length), u32be(0)]);
  return Buffer.concat([header, entry, ...blocks]);
}

/** A WOFF2 with one known table, head (with its magic), as one brotli stream. */
export function woff2(): Buffer {
  const stream = brotliCompressSync(headTable());
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(12 + 16 + 56, 16);
  header.writeUInt32BE(stream.length, 20);
  const body = Buffer.concat([Buffer.from([0x01, 54]), stream]);
  header.writeUInt32BE(48 + body.length, 8);
  return Buffer.concat([header, body]);
}

/** An EOT (version 1.0) with four empty names and a TrueType font as its data, plain or XOR-obfuscated. */
export function eot(options: { xor?: boolean } = {}): Buffer {
  const font = options.xor === true ? Buffer.from(ttf().map((byte) => byte ^ 0x50)) : ttf();
  const header = Buffer.alloc(80);
  const names = Buffer.alloc(16);
  const total = header.length + names.length + font.length;
  header.writeUInt32LE(total, 0);
  header.writeUInt32LE(font.length, 4);
  header.writeUInt32LE(0x00010000, 8);
  if (options.xor === true) header.writeUInt32LE(0x10000000, 12);
  header.writeUInt16LE(0x504c, 34);
  return Buffer.concat([header, names, font]);
}

/**
 * For each format whose walk once left bytes unread, a header whose length fields cover `payload`:
 * each starts as an image or a font, and none is one.
 */
export function planted(payload: Buffer): Record<string, Buffer> {
  // AVIF: ftyp, an empty meta box, and an mdat of size 0, which runs to the end of the file.
  const avifRunOn = Buffer.concat([box("ftyp", Buffer.from("avif\0\0\0\0", "latin1")), box("meta", Buffer.alloc(0)), u32be(0), Buffer.from("mdat", "latin1"), payload]);
  // WOFF: one four-byte table (the payload's first bytes), and the length field set to the file's.
  const woffHeader = Buffer.alloc(44);
  woffHeader.write("wOFF", 0, "latin1");
  woffHeader.writeUInt32BE(0x00010000, 4);
  woffHeader.writeUInt32BE(64 + payload.length, 8);
  woffHeader.writeUInt16BE(1, 12);
  const woffTail = Buffer.concat([woffHeader, Buffer.from("head", "latin1"), u32be(64), u32be(4), u32be(4), u32be(0), payload]);
  // WOFF2: one table, and a compressed size that covers the payload.
  const woff2Header = Buffer.alloc(48);
  woff2Header.write("wOF2", 0, "latin1");
  woff2Header.writeUInt32BE(0x00010000, 4);
  woff2Header.writeUInt32BE(50 + payload.length, 8);
  woff2Header.writeUInt16BE(1, 12);
  woff2Header.writeUInt32BE(payload.length, 20);
  const woff2Opaque = Buffer.concat([woff2Header, Buffer.from([0x01, 54]), payload]);
  // EOT: font data marked compressed or XOR-obfuscated.
  const eotFlagged = (flags: number): Buffer => {
    const header = Buffer.alloc(80);
    header.writeUInt32LE(96 + payload.length, 0);
    header.writeUInt32LE(payload.length, 4);
    header.writeUInt32LE(0x00010000, 8);
    header.writeUInt32LE(flags, 12);
    header.writeUInt16LE(0x504c, 34);
    return Buffer.concat([header, Buffer.alloc(16), payload]);
  };
  // sfnt: the head table placed after a gap that holds the payload.
  const gap = padded(payload);
  const head = headTable();
  const sfntGap = Buffer.concat([u32be(0x00010000), u16be(1), u16be(16), u16be(0), u16be(0), Buffer.from("head", "latin1"), u32be(0), u32be(28 + gap.length), u32be(head.length), gap, padded(head)]);
  // ICO: one PNG placed after a gap that holds the payload; and a bitmap entry that is an info header and the payload.
  const image = png();
  const icoGap = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.from([1, 1, 0, 0, 1, 0, 32, 0]), u32le(image.length), u32le(22 + payload.length), payload, image]);
  const bitmap = Buffer.concat([icoBitmap().subarray(0, 40), payload]);
  const icoBitmapRunOn = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.from([1, 1, 0, 0, 1, 0, 32, 0]), u32le(bitmap.length), u32le(22), bitmap]);
  // BMP: a 1x1 header whose size field is the file's, and the payload as its pixels.
  const bmpRunOn = Buffer.concat([bmp().subarray(0, 54), payload]);
  bmpRunOn.writeUInt32LE(bmpRunOn.length, 2);
  return {
    "run-on.avif": avifRunOn,
    "tail.woff": woffTail,
    "opaque.woff2": woff2Opaque,
    "compressed.eot": eotFlagged(0x4),
    "obfuscated.eot": eotFlagged(0x10000000),
    "gap.ttf": sfntGap,
    "gap.ico": icoGap,
    "bitmap.ico": icoBitmapRunOn,
    "run-on.bmp": bmpRunOn,
  };
}
