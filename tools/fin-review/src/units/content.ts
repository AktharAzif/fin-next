// What a file's bytes are, checked by content and never by name alone (spec 07 §2.5). A name is
// the pull request author's to choose, and so are the bytes, so a file is excluded from the units
// only when its bytes are what docs/review/exclusions.json's globs say: an image or a font laid out
// end to end as the format its extension names, the pnpm lockfile, or a source map. Anything else
// is reviewed, or, when it cannot be, counted as a file no lens saw.
//
// An image or a font is walked from its first byte to its last: every chunk, box, block, segment
// or table the format defines, each within the file, the walk ending exactly at the file's end
// (PNG's chunk CRCs included). A few planted magic bytes, a valid header in front of other content,
// or bytes left over after the format ends never pass. A media-named file the inventory would read
// as text (all valid UTF-8, no NUL in its first 8,000 bytes) is never exempt either: real image and
// font data is not text, so such a file is reviewed as text.
//
// What this cannot do is tell a real image from a real image that also hides text in its free-form
// parts (a comment, a metadata chunk, the pixel data itself). Such a file is still never a unit,
// so whatever reads or runs it (a loader, a script, a workflow step) is the reviewed code, and the
// lenses are told which media files changed (src/review/run.ts).

import { isUtf8 } from "node:buffer";
import { posix } from "node:path";
import { crc32 } from "node:zlib";

export type ContentKind = "image" | "font" | "lockfile" | "sourcemap";
export type MediaFormat = "png" | "jpeg" | "gif" | "webp" | "avif" | "ico" | "bmp" | "sfnt" | "woff" | "woff2" | "eot";

/** The formats each extension of exclusions.json may hold, and whether that is an image or a font. */
const EXTENSION_FORMATS: ReadonlyMap<string, { readonly kind: "image" | "font"; readonly formats: readonly MediaFormat[] }> = new Map([
  ["png", { kind: "image", formats: ["png"] }],
  ["jpg", { kind: "image", formats: ["jpeg"] }],
  ["jpeg", { kind: "image", formats: ["jpeg"] }],
  ["gif", { kind: "image", formats: ["gif"] }],
  ["webp", { kind: "image", formats: ["webp"] }],
  ["avif", { kind: "image", formats: ["avif"] }],
  ["ico", { kind: "image", formats: ["ico"] }],
  ["bmp", { kind: "image", formats: ["bmp"] }],
  ["ttf", { kind: "font", formats: ["sfnt"] }],
  ["otf", { kind: "font", formats: ["sfnt"] }],
  ["woff", { kind: "font", formats: ["woff"] }],
  ["woff2", { kind: "font", formats: ["woff2"] }],
  ["eot", { kind: "font", formats: ["eot"] }],
] as const);
const IMAGE_FORMATS: ReadonlySet<MediaFormat> = new Set(["png", "jpeg", "gif", "webp", "avif", "ico", "bmp"]);
const BMP_HEADER_SIZES: ReadonlySet<number> = new Set([12, 40, 52, 56, 108, 124]);
const BMP_BIT_COUNTS: ReadonlySet<number> = new Set([1, 4, 8, 16, 24, 32]);
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** JPEG's start-of-frame markers (every SOFn but DHT C4, JPG C8 and DAC CC). */
const JPEG_FRAMES: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** WOFF2's known-table indexes of glyf and loca, whose transform version 0 means transformed. */
const WOFF2_GLYF = 10;
const WOFF2_LOCA = 11;
const EOT_VERSIONS: ReadonlySet<number> = new Set([0x00010000, 0x00020001, 0x00020002]);
const PRINTABLE_TAG_RE = /^[\x20-\x7e]{4}$/;
const MAX_SOURCE_MAP_BYTES = 64 * 1024 * 1024;

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((value, index) => bytes[at + index] === value);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  if (bytes.length < to) return "";
  let out = "";
  for (let i = from; i < to; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** PNG: the signature, IHDR first, every chunk within the file with its CRC, IDAT, and IEND last at the end. */
function isPng(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, PNG_SIGNATURE)) return false;
  const v = view(bytes);
  let at = 8;
  let first = true;
  let data = false;
  while (at + 12 <= bytes.length) {
    const length = v.getUint32(at);
    if (length > 0x7fffffff || at + 12 + length > bytes.length) return false;
    const type = ascii(bytes, at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== v.getUint32(at + 8 + length)) return false;
    if (first && (type !== "IHDR" || length !== 13 || v.getUint32(at + 8) === 0 || v.getUint32(at + 12) === 0)) return false;
    if (!first && type === "IHDR") return false;
    if (type === "IDAT") data = true;
    first = false;
    at += 12 + length;
    if (type === "IEND") return length === 0 && data && at === bytes.length;
  }
  return false;
}

/** JPEG: SOI, then segments (and the entropy-coded data after each SOS), a frame and a scan, and EOI at the end. */
function isJpeg(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0xff, 0xd8])) return false;
  const v = view(bytes);
  let at = 2;
  let frame = false;
  let scan = false;
  for (;;) {
    if (bytes[at] !== 0xff) return false;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at];
    if (marker === undefined) return false;
    at++;
    if (marker === 0xd9) return frame && scan && at === bytes.length;
    // A stuffed zero, a second SOI, a restart or TEM outside entropy-coded data is no segment.
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (at + 2 > bytes.length) return false;
    const length = v.getUint16(at);
    if (length < 2 || at + length > bytes.length) return false;
    if (JPEG_FRAMES.has(marker)) frame = true;
    at += length;
    if (marker !== 0xda) continue;
    if (!frame) return false;
    scan = true;
    // Entropy-coded data runs to the next marker: 0xFF then a byte that is neither a stuffed zero
    // nor a restart marker (fill bytes 0xFF may come first).
    for (;;) {
      const byte = bytes[at];
      if (byte === undefined) return false;
      if (byte !== 0xff) {
        at++;
        continue;
      }
      const next = bytes[at + 1];
      if (next === undefined) return false;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        at += 2;
        continue;
      }
      if (next === 0xff) {
        at++;
        continue;
      }
      break;
    }
  }
}

/** GIF: header, screen descriptor, colour tables, every block and sub-block, one image or more, and the trailer at the end. */
function isGif(bytes: Uint8Array): boolean {
  const header = ascii(bytes, 0, 6);
  if ((header !== "GIF87a" && header !== "GIF89a") || bytes.length < 14) return false;
  const screen = bytes[10] ?? 0;
  let at = 13 + ((screen & 0x80) !== 0 ? 3 * (1 << ((screen & 7) + 1)) : 0);
  const subBlocks = (): boolean => {
    for (;;) {
      const size = bytes[at];
      if (size === undefined) return false;
      at += 1 + size;
      if (size === 0) return true;
    }
  };
  let image = false;
  for (;;) {
    const kind = bytes[at];
    if (kind === undefined) return false;
    at++;
    if (kind === 0x3b) return image && at === bytes.length;
    if (kind === 0x2c) {
      if (at + 10 > bytes.length) return false;
      const local = bytes[at + 8] ?? 0;
      at += 9 + ((local & 0x80) !== 0 ? 3 * (1 << ((local & 7) + 1)) : 0);
      const minimumCodeSize = bytes[at];
      if (minimumCodeSize === undefined || minimumCodeSize < 2 || minimumCodeSize > 8) return false;
      at++;
      if (!subBlocks()) return false;
      image = true;
    } else if (kind === 0x21) {
      if (at >= bytes.length) return false;
      at++;
      if (!subBlocks()) return false;
    } else return false;
  }
}

/** WebP: RIFF's size is the file's, VP8, VP8L or VP8X first, every chunk within the file, and an image chunk. */
function isWebp(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP" || bytes.length < 20) return false;
  const v = view(bytes);
  if (v.getUint32(4, true) !== bytes.length - 8) return false;
  let at = 12;
  let first = true;
  let image = false;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return false;
    const type = ascii(bytes, at, at + 4);
    if (!PRINTABLE_TAG_RE.test(type)) return false;
    const size = v.getUint32(at + 4, true);
    const end = at + 8 + size + (size & 1);
    if (end > bytes.length) return false;
    if (first && type !== "VP8 " && type !== "VP8L" && type !== "VP8X") return false;
    if (type === "VP8 ") {
      if (size < 10 || !startsWith(bytes, [0x9d, 0x01, 0x2a], at + 11)) return false;
      image = true;
    } else if (type === "VP8L") {
      if (size < 5 || bytes[at + 8] !== 0x2f) return false;
      image = true;
    } else if (type === "ANMF") image = true;
    first = false;
    at = end;
  }
  return image && at === bytes.length;
}

/** AVIF: top-level boxes end to end, a small ftyp first naming avif or avis, and a meta box. */
function isAvif(bytes: Uint8Array): boolean {
  const v = view(bytes);
  let at = 0;
  let first = true;
  let meta = false;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return false;
    let size = v.getUint32(at);
    const type = ascii(bytes, at + 4, at + 8);
    if (!PRINTABLE_TAG_RE.test(type)) return false;
    let header = 8;
    if (size === 1) {
      if (at + 16 > bytes.length) return false;
      const large = v.getBigUint64(at + 8);
      if (large > BigInt(bytes.length - at)) return false;
      size = Number(large);
      header = 16;
    } else if (size === 0) size = bytes.length - at;
    if (size < header || at + size > bytes.length) return false;
    if (first) {
      // ftyp is a few brands long; a small size also keeps the file's first byte a zero.
      if (type !== "ftyp" || header !== 8 || size < 16 || size > 4096 || (size - 16) % 4 !== 0) return false;
      const brands = [ascii(bytes, at + 8, at + 12)];
      for (let brand = at + 16; brand < at + size; brand += 4) brands.push(ascii(bytes, brand, brand + 4));
      if (!brands.includes("avif") && !brands.includes("avis")) return false;
    }
    if (type === "meta") meta = true;
    first = false;
    at += size;
  }
  return !first && meta && at === bytes.length;
}

/** BMP: its size field is the file's, a known header, one plane, a known bit count, and the pixels within the file. */
function isBmp(bytes: Uint8Array, embedded = false): boolean {
  const v = view(bytes);
  // In an ICO the file header is left out: the image starts at the info header.
  const base = embedded ? 0 : 14;
  if (!embedded && (ascii(bytes, 0, 2) !== "BM" || bytes.length < 26 || v.getUint32(2, true) !== bytes.length)) return false;
  if (bytes.length < base + 12) return false;
  const headerSize = v.getUint32(base, true);
  if (!BMP_HEADER_SIZES.has(headerSize) || base + headerSize > bytes.length) return false;
  const core = headerSize === 12;
  const planes = v.getUint16(base + (core ? 8 : 12), true);
  const bits = v.getUint16(base + (core ? 10 : 14), true);
  if (planes !== 1 || !BMP_BIT_COUNTS.has(bits)) return false;
  if (embedded) return true;
  const pixels = v.getUint32(10, true);
  return pixels >= base + headerSize && pixels < bytes.length;
}

/** ICO: 1 to 255 images, each entry within the file past the directory, each image a PNG or a bitmap, the last one ending the file. */
function isIco(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) || bytes.length < 22) return false;
  const v = view(bytes);
  const count = v.getUint16(4, true);
  const directory = 6 + 16 * count;
  if (count < 1 || count > 255 || bytes.length < directory) return false;
  let end = directory;
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i;
    const size = v.getUint32(entry + 8, true);
    const offset = v.getUint32(entry + 12, true);
    if (bytes[entry + 3] !== 0 || size === 0 || offset < directory || offset + size > bytes.length) return false;
    const image = bytes.subarray(offset, offset + size);
    if (!isPng(image) && !isBmp(image, true)) return false;
    end = Math.max(end, offset + size);
  }
  return end === bytes.length;
}

/** Up to three zero bytes of padding from `end` to the end of the file, and nothing else. */
function paddedEnd(bytes: Uint8Array, end: number): boolean {
  if (end > bytes.length || bytes.length - end > 3) return false;
  for (let i = end; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}

/**
 * An sfnt font (TrueType, OpenType): 1 to 512 tables, each within the file past the directory, a
 * head table with its magic number, and the file ending with the last table (and its padding).
 */
function isSfnt(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const tag = ascii(bytes, 0, 4);
  if (tag !== "OTTO" && tag !== "true" && !startsWith(bytes, [0x00, 0x01, 0x00, 0x00])) return false;
  const v = view(bytes);
  const tables = v.getUint16(4);
  const directory = 12 + 16 * tables;
  if (tables < 1 || tables > 512 || bytes.length < directory) return false;
  let head = false;
  let end = directory;
  for (let i = 0; i < tables; i++) {
    const record = 12 + 16 * i;
    const name = ascii(bytes, record, record + 4);
    const offset = v.getUint32(record + 8);
    const length = v.getUint32(record + 12);
    if (!PRINTABLE_TAG_RE.test(name) || offset < directory || offset + length > bytes.length) return false;
    if (name === "head") {
      if (length < 54 || v.getUint32(offset + 12) !== 0x5f0f3cf5) return false;
      head = true;
    }
    end = Math.max(end, offset + length);
  }
  return head && paddedEnd(bytes, end);
}

/** WOFF: the length field is the file's, and every table, metadata and private block lies within it past the directory. */
function isWoff(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 4) !== "wOFF" || bytes.length < 44) return false;
  const v = view(bytes);
  const tables = v.getUint16(12);
  const directory = 44 + 20 * tables;
  if (v.getUint32(8) !== bytes.length || tables < 1 || v.getUint16(14) !== 0 || bytes.length < directory) return false;
  for (let i = 0; i < tables; i++) {
    const entry = 44 + 20 * i;
    const offset = v.getUint32(entry + 4);
    const compressed = v.getUint32(entry + 8);
    const original = v.getUint32(entry + 12);
    if (!PRINTABLE_TAG_RE.test(ascii(bytes, entry, entry + 4)) || offset % 4 !== 0 || offset < directory || compressed > original || offset + compressed > bytes.length) return false;
  }
  for (const field of [24, 36]) {
    const offset = v.getUint32(field);
    const length = v.getUint32(field + 4);
    if (offset !== 0 && (offset < directory || offset + length > bytes.length)) return false;
  }
  return true;
}

/** A WOFF2 UIntBase128 at `at`: its value and length, or null when it is not one. */
function base128(bytes: Uint8Array, at: number): { value: number; length: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = bytes[at + i];
    if (byte === undefined || (i === 0 && byte === 0x80) || value > 0x1ffffff) return null;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, length: i + 1 };
  }
  return null;
}

/** WOFF2: the length field is the file's, the table directory, then the compressed data, metadata and private blocks in order, within the file. */
function isWoff2(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 4) !== "wOF2" || bytes.length < 48) return false;
  const v = view(bytes);
  const tables = v.getUint16(12);
  // A collection carries a second directory this walk does not read: never exempt.
  if (v.getUint32(8) !== bytes.length || tables < 1 || v.getUint16(14) !== 0 || ascii(bytes, 4, 8) === "ttcf") return false;
  let at = 48;
  for (let i = 0; i < tables; i++) {
    const flags = bytes[at];
    if (flags === undefined) return false;
    at++;
    const index = flags & 0x3f;
    if (index === 0x3f) {
      if (!PRINTABLE_TAG_RE.test(ascii(bytes, at, at + 4))) return false;
      at += 4;
    }
    const original = base128(bytes, at);
    if (original === null) return false;
    at += original.length;
    const version = flags >> 6;
    const transformed = index === WOFF2_GLYF || index === WOFF2_LOCA ? version === 0 : version !== 0;
    if (transformed) {
      const length = base128(bytes, at);
      if (length === null) return false;
      at += length.length;
    }
  }
  let end = at + v.getUint32(20);
  if (end > bytes.length) return false;
  for (const field of [28, 40]) {
    const offset = v.getUint32(field);
    const length = v.getUint32(field + 4);
    if (offset === 0) continue;
    if (offset < end || offset % 4 !== 0 || offset - end > 3 || offset + length > bytes.length) return false;
    end = offset + length;
  }
  return paddedEnd(bytes, end);
}

/** EOT: its fixed header, every name string in turn, and the font data ending at the file's end (an sfnt when stored plain). */
function isEot(bytes: Uint8Array): boolean {
  if (bytes.length < 82) return false;
  const v = view(bytes);
  const version = v.getUint32(8, true);
  const fontDataSize = v.getUint32(4, true);
  if (v.getUint32(0, true) !== bytes.length || !EOT_VERSIONS.has(version) || v.getUint16(34, true) !== 0x504c) return false;
  for (let reserved = 64; reserved < 80; reserved += 2) if (v.getUint16(reserved, true) !== 0) return false;
  // From Padding1 on: four names (family, style, version, full), each a zero padding, a size and its bytes.
  let at = 80;
  /** Padding (zero), a size and that many bytes. */
  const field = (): boolean => {
    if (at + 4 > bytes.length || v.getUint16(at, true) !== 0) return false;
    at += 4 + v.getUint16(at + 2, true);
    return at <= bytes.length;
  };
  for (let name = 0; name < 4; name++) if (!field()) return false;
  if (version !== 0x00010000 && !field()) return false;
  if (version === 0x00020002) {
    at += 8;
    if (!field()) return false;
    if (at + 8 > bytes.length) return false;
    const eudcSize = v.getUint32(at + 4, true);
    at += 8 + eudcSize;
  }
  if (at + fontDataSize !== bytes.length) return false;
  const flags = v.getUint32(12, true);
  // Compressed (0x4) or XOR-obfuscated (0x10000000) data is not readable as an sfnt here.
  if ((flags & 0x4) === 0 && (flags & 0x10000000) === 0) return isSfnt(bytes.subarray(at));
  return true;
}

const FORMAT_CHECKS: ReadonlyArray<readonly [MediaFormat, (bytes: Uint8Array) => boolean]> = [
  ["png", isPng],
  ["jpeg", isJpeg],
  ["gif", isGif],
  ["webp", isWebp],
  ["avif", isAvif],
  ["ico", isIco],
  ["bmp", isBmp],
  ["sfnt", isSfnt],
  ["woff", isWoff],
  ["woff2", isWoff2],
  ["eot", isEot],
];

/** The image or font format `bytes` are laid out as, end to end; null when none. */
export function mediaFormat(bytes: Uint8Array): MediaFormat | null {
  for (const [format, check] of FORMAT_CHECKS) if (check(bytes)) return format;
  return null;
}

/** "image" or "font" when the bytes are laid out end to end as one of the formats exclusions.json names; else null. */
export function mediaKind(bytes: Uint8Array): "image" | "font" | null {
  const format = mediaFormat(bytes);
  return format === null ? null : IMAGE_FORMATS.has(format) ? "image" : "font";
}

/**
 * The media a file's first bytes merely look like (a format's magic), for the report of a binary
 * file only. It decides nothing: an exclusion takes the name and the whole layout (verifiedExclusion).
 */
export function looksLikeMedia(bytes: Uint8Array): "image" | "font" | null {
  const laidOut = mediaKind(bytes);
  if (laidOut !== null) return laidOut;
  const tag = ascii(bytes, 0, 4);
  if (startsWith(bytes, PNG_SIGNATURE) || startsWith(bytes, [0xff, 0xd8, 0xff]) || tag === "GIF8" || (tag === "RIFF" && ascii(bytes, 8, 12) === "WEBP")) return "image";
  if (ascii(bytes, 4, 8) === "ftyp" || startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) || ascii(bytes, 0, 2) === "BM") return "image";
  if (tag === "OTTO" || tag === "true" || tag === "wOFF" || tag === "wOF2" || startsWith(bytes, [0x00, 0x01, 0x00, 0x00])) return "font";
  return null;
}

function isLockfile(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 64)).toString("utf8");
  return /^(?:﻿)?lockfileVersion: /.test(head);
}

function isSourceMap(bytes: Uint8Array): boolean {
  if (bytes.length > MAX_SOURCE_MAP_BYTES) return false;
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const map = value as Record<string, unknown>;
    return map["version"] === 3 && typeof map["mappings"] === "string";
  } catch {
    return false;
  }
}

/**
 * The kind of content `path`'s name claims, when the bytes are that kind: an image or font
 * extension whose bytes are laid out end to end as the format that extension names (and are not
 * what the inventory reads as text), `pnpm-lock.yaml` that starts as a pnpm lockfile, a `.map` that is a source
 * map. Null otherwise, so an excluded name alone never hides a file.
 */
export function verifiedExclusion(path: string, bytes: Uint8Array): ContentKind | null {
  const base = posix.basename(path);
  const dot = base.lastIndexOf(".");
  const extension = dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
  const media = EXTENSION_FORMATS.get(extension);
  if (media !== undefined) {
    // Bytes the inventory would read as text (all valid UTF-8, no NUL where git looks) are reviewed as text.
    if (isUtf8(bytes) && !bytes.subarray(0, 8000).includes(0)) return null;
    const format = mediaFormat(bytes);
    return format !== null && media.formats.includes(format) ? media.kind : null;
  }
  if (base === "pnpm-lock.yaml") return isLockfile(bytes) ? "lockfile" : null;
  if (extension === "map") return isSourceMap(bytes) ? "sourcemap" : null;
  return null;
}
