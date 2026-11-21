// Minimal, well-formed image and font files for the units tests: each is laid out end to end as
// its format, so a test can show what the engine exempts and, by changing a byte, what it does not.

import { crc32, deflateSync } from "node:zlib";

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

/** An AVIF's top-level boxes: ftyp (avif, compatible mif1), meta, mdat. */
export function avif(): Buffer {
  return Buffer.concat([box("ftyp", Buffer.from("avif\0\0\0\0mif1", "latin1")), box("meta", Buffer.alloc(4)), box("mdat", Buffer.from([1, 2, 3, 4]))]);
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

/** An ICO holding one PNG image. */
export function ico(): Buffer {
  const image = png();
  const directory = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.from([1, 1, 0, 0, 1, 0, 32, 0]), u32le(image.length), u32le(22)]);
  return Buffer.concat([directory, image]);
}

/** A TrueType font with one table, head, carrying its magic number. */
export function ttf(): Buffer {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  const directory = Buffer.concat([u32be(0x00010000), u16be(1), u16be(16), u16be(0), u16be(0), Buffer.from("head", "latin1"), u32be(0), u32be(28), u32be(head.length)]);
  return Buffer.concat([directory, head, Buffer.alloc(2)]);
}

/** A WOFF with one table stored as it is. */
export function woff(): Buffer {
  const table = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.alloc(44);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(44 + 20 + table.length, 8);
  header.writeUInt16BE(1, 12);
  const entry = Buffer.concat([Buffer.from("head", "latin1"), u32be(64), u32be(table.length), u32be(table.length), u32be(0)]);
  return Buffer.concat([header, entry, table]);
}

/** A WOFF2 with one known table (head) and four bytes of compressed data. */
export function woff2(): Buffer {
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(48 + 2 + 4, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(4, 20);
  return Buffer.concat([header, Buffer.from([0x01, 54]), Buffer.from([9, 9, 9, 9])]);
}

/** An EOT (version 1.0) with four empty names and a plain TrueType font as its data. */
export function eot(): Buffer {
  const font = ttf();
  const header = Buffer.alloc(80);
  const names = Buffer.alloc(16);
  const total = header.length + names.length + font.length;
  header.writeUInt32LE(total, 0);
  header.writeUInt32LE(font.length, 4);
  header.writeUInt32LE(0x00010000, 8);
  header.writeUInt16LE(0x504c, 34);
  return Buffer.concat([header, names, font]);
}
