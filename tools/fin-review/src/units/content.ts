// What a file's bytes are, checked by content and never by name alone (spec 07 §2.5). A name is
// the pull request author's to choose, and so are the bytes, so a file is excluded from the units
// only when its bytes are what docs/review/exclusions.json's globs say: an image or a font laid out
// end to end as the format its extension names, the pnpm lockfile, or a source map. Anything else
// is reviewed, or, when it cannot be, counted as a file no lens saw.
//
// An image or a font is walked from its first byte to its last, and every byte must belong to a
// structure the format defines and the walk reads: each PNG chunk with its CRC, JPEG segment, GIF
// block, RIFF chunk; an AVIF's boxes, with its item locations covering every byte of the media data;
// an ICO's images and a bitmap's header, palette and rows, end to end; a font's tables end to end.
// Only zero bytes may pad between them (where the format aligns) or after a bitmap's rows. A font's
// compressed parts are decompressed and must come out at exactly their stated lengths with every
// compressed byte read (WOFF's zlib tables and metadata, WOFF2's brotli stream and metadata, an EOT's
// XOR obfuscation undone). A layout the walk cannot read is never exempt: an AVIF image sequence, an
// EOT compressed with MicroType Express, a compressed bitmap (run-length, JPEG or PNG) or one with a
// colour profile, a font collection. So a few planted magic bytes, a valid header in front of other content,
// a length field that covers bytes no structure holds, or bytes after the format's end never pass. A
// media-named file the inventory would read as text (all valid UTF-8, no NUL in its first 8,000
// bytes) is never exempt either: real image and font data is not text, so it is reviewed as text.
//
// What this cannot do is tell a real image from a real image that also hides content in the parts a
// format leaves free: the coded data a structure holds is never decoded (the pixel data of a PNG
// IDAT, a JPEG scan, a GIF image, a WebP or AVIF bitstream, a bitmap's rows; a font table's
// contents), nor are comments, metadata and a WOFF private block. Such a file is still never a unit,
// so whatever reads or runs it (a loader, a script, a workflow step) is the reviewed code, and the
// lenses are told which media files changed (src/review/run.ts).

import { isUtf8 } from "node:buffer";
import { posix } from "node:path";
import { brotliDecompressSync, crc32, inflateSync } from "node:zlib";

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
/** WOFF2's known-table indexes of head, and of glyf and loca, whose transform version 0 means transformed. */
const WOFF2_HEAD = 1;
const WOFF2_GLYF = 10;
const WOFF2_LOCA = 11;
/** The magic number of a font's head table, at offset 12. */
const HEAD_MAGIC = 0x5f0f3cf5;
const EOT_VERSIONS: ReadonlySet<number> = new Set([0x00010000, 0x00020001, 0x00020002]);
/** BMP compressions laid out as plain rows: BI_RGB, and BI_BITFIELDS (16 or 32 bits a pixel). */
const BMP_RGB = 0;
const BMP_BITFIELDS = 3;
/** The boxes an AVIF's meta box may hold, each at most once. */
const AVIF_META_BOXES: ReadonlySet<string> = new Set(["hdlr", "pitm", "iloc", "iinf", "iprp", "iref", "idat", "dinf", "grpl"]);
const PRINTABLE_TAG_RE = /^[\x20-\x7e]{4}$/;
const MAX_SOURCE_MAP_BYTES = 64 * 1024 * 1024;
/** Most bytes a font's compressed tables or metadata may stand for; past it the font is not exempt. */
const MAX_FONT_BYTES = 64 * 1024 * 1024;

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

/**
 * True when `blocks` (start, end) cover `from` to the end of the file and nothing else: in order of
 * start, none overlapping, with fewer than `align` bytes, all zero, before each and after the last
 * (an alignment's padding). With `align` 1 they lie end to end.
 */
function tiled(bytes: Uint8Array, from: number, blocks: ReadonlyArray<readonly [number, number]>, align: number): boolean {
  let at = from;
  for (const [start, end] of [...blocks].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (start < at || start - at >= align || end < start || !zeros(bytes, at, start)) return false;
    at = end;
  }
  return at <= bytes.length && bytes.length - at < align && zeros(bytes, at, bytes.length);
}

/** True when every byte from `from` to `to` is zero. */
function zeros(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
}

/** A decoder's output and how many input bytes it took (node:zlib's `info` form). */
type Decoded = { readonly buffer: Buffer; readonly engine: { readonly bytesWritten: number } };

/**
 * `data` decompressed when it is one whole zlib or brotli stream, every byte of it read, that comes
 * out at exactly `size` bytes; null otherwise (a stream with bytes after its end, or the wrong size).
 */
function decompressed(kind: "zlib" | "brotli", data: Uint8Array, size: number): Buffer | null {
  if (size < 1 || size > MAX_FONT_BYTES || data.length === 0) return null;
  try {
    const out = (kind === "zlib" ? inflateSync(data, { info: true, maxOutputLength: size }) : brotliDecompressSync(data, { info: true, maxOutputLength: size })) as unknown as Decoded;
    return out.buffer.length === size && out.engine.bytesWritten === data.length ? out.buffer : null;
  } catch {
    return null;
  }
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

/** WebP: RIFF's size is the file's, VP8, VP8L or VP8X first, every chunk within the file (an odd one padded with a zero), and an image chunk. */
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
    if (end > bytes.length || ((size & 1) === 1 && bytes[end - 1] !== 0)) return false;
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

/** An ISOBMFF box: its type, where it starts, where its body starts and where it ends. */
interface Box {
  readonly type: string;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

/**
 * The ISOBMFF boxes laid end to end from `from` to exactly `to`, each with a printable type and its
 * size stated (a size of 0, "to the end of the file", is refused); null when they are not.
 */
function boxes(bytes: Uint8Array, from: number, to: number): Box[] | null {
  const v = view(bytes);
  const out: Box[] = [];
  let at = from;
  while (at < to) {
    if (at + 8 > to) return null;
    let size = v.getUint32(at);
    const type = ascii(bytes, at + 4, at + 8);
    if (!PRINTABLE_TAG_RE.test(type)) return null;
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return null;
      const large = v.getBigUint64(at + 8);
      if (large > BigInt(to - at)) return null;
      size = Number(large);
      header = 16;
    }
    if (size < header || at + size > to) return null;
    out.push({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
  return out;
}

/** A full box's version, when its flags hold no bit outside `flags`; null otherwise. */
function fullBoxVersion(bytes: Uint8Array, box: Box, flags = 0): number | null {
  if (box.body + 4 > box.end) return null;
  const word = view(bytes).getUint32(box.body);
  return (word & 0xffffff & ~flags) === 0 ? word >>> 24 : null;
}

/** True when `extents` lie within `regions` (which do not overlap) and leave no byte of one uncovered. */
function covers(extents: ReadonlyArray<readonly [number, number]>, regions: ReadonlyArray<readonly [number, number]>): boolean {
  const sorted = [...extents].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let next = 0;
  for (const [from, to] of [...regions].sort((a, b) => a[0] - b[0])) {
    let at = from;
    for (let extent = sorted[next]; extent !== undefined && extent[0] < to; extent = sorted[++next]) {
      if (extent[0] < from || extent[1] > to || extent[0] > at) return false;
      at = Math.max(at, extent[1]);
    }
    if (at < to) return false;
  }
  return next === sorted.length;
}

/**
 * AVIF, a still image (an image sequence is not walked here): top-level boxes end to end, a small
 * ftyp first naming avif, then one meta box and the mdat boxes, and nothing else. meta holds hdlr
 * ('pict') first, pitm, iinf, iloc and iprp, and only the other boxes an image's meta may hold, each
 * laid out in full; and iloc's extents cover every byte of each mdat (and of idat), so no byte of the
 * file lies outside a box the walk reads or an item's data.
 */
function isAvif(bytes: Uint8Array): boolean {
  const top = boxes(bytes, 0, bytes.length);
  const ftyp = top?.[0];
  if (top === null || ftyp === undefined) return false;
  // ftyp is a few brands long; a small size also keeps the file's first byte a zero.
  const size = ftyp.end - ftyp.start;
  if (ftyp.type !== "ftyp" || ftyp.body !== ftyp.start + 8 || size < 16 || size > 4096 || (size - 16) % 4 !== 0) return false;
  const brands = [ascii(bytes, ftyp.body, ftyp.body + 4)];
  for (let brand = ftyp.body + 8; brand < ftyp.end; brand += 4) brands.push(ascii(bytes, brand, brand + 4));
  if (!brands.includes("avif")) return false;
  const rest = top.slice(1);
  const metas = rest.filter((box) => box.type === "meta");
  const mdats = rest.filter((box) => box.type === "mdat");
  const meta = metas[0];
  if (meta === undefined || metas.length !== 1 || metas.length + mdats.length !== rest.length) return false;
  return avifMeta(bytes, meta, mdats);
}

/** An AVIF's meta box laid out in full, with its items' data covering every byte of `mdats` and of its idat. */
function avifMeta(bytes: Uint8Array, meta: Box, mdats: readonly Box[]): boolean {
  const v = view(bytes);
  if (fullBoxVersion(bytes, meta) !== 0) return false;
  const children = boxes(bytes, meta.body + 4, meta.end);
  if (children === null || children[0]?.type !== "hdlr") return false;
  const byType = new Map<string, Box>();
  for (const child of children) {
    if (!AVIF_META_BOXES.has(child.type) || byType.has(child.type)) return false;
    byType.set(child.type, child);
  }
  const hdlr = byType.get("hdlr");
  const pitm = byType.get("pitm");
  const iinf = byType.get("iinf");
  const iloc = byType.get("iloc");
  const iprp = byType.get("iprp");
  if (hdlr === undefined || pitm === undefined || iinf === undefined || iloc === undefined || iprp === undefined) return false;
  // hdlr: pre_defined 0, handler pict, three reserved zero words, and a name ending in a NUL.
  if (fullBoxVersion(bytes, hdlr) !== 0 || hdlr.end - hdlr.body < 25 || v.getUint32(hdlr.body + 4) !== 0 || ascii(bytes, hdlr.body + 8, hdlr.body + 12) !== "pict" || bytes[hdlr.end - 1] !== 0) return false;
  for (let reserved = hdlr.body + 12; reserved < hdlr.body + 24; reserved += 4) if (v.getUint32(reserved) !== 0) return false;
  // pitm: the primary item, one of iinf's.
  const pitmVersion = fullBoxVersion(bytes, pitm);
  if (pitmVersion === null || pitmVersion > 1 || pitm.end - pitm.body !== (pitmVersion === 0 ? 6 : 8)) return false;
  const primary = pitmVersion === 0 ? v.getUint16(pitm.body + 4) : v.getUint32(pitm.body + 4);
  const items = avifItems(bytes, iinf);
  if (items === null || !items.has(primary)) return false;
  const extents = avifExtents(bytes, iloc, items);
  if (extents === null || !avifProperties(bytes, iprp, items)) return false;
  // iref (a full box), dinf and grpl: each a list of boxes laid out in full.
  for (const [type, full] of [["iref", true], ["dinf", false], ["grpl", false]] as const) {
    const box = byType.get(type);
    if (box === undefined) continue;
    if (full && fullBoxVersion(bytes, box) === null) return false;
    if (boxes(bytes, box.body + (full ? 4 : 0), box.end) === null) return false;
  }
  const idat = byType.get("idat");
  const inFile = mdats.map((box): [number, number] => [box.body, box.end]);
  const inIdat: Array<[number, number]> = idat === undefined ? [] : [[0, idat.end - idat.body]];
  return extents.file.length + extents.idat.length > 0 && covers(extents.file, inFile) && covers(extents.idat, inIdat);
}

/** The item IDs of an iinf box whose infe entries (version 2 or 3) fill it exactly, as many as it says; null otherwise. */
function avifItems(bytes: Uint8Array, iinf: Box): Set<number> | null {
  const v = view(bytes);
  const version = fullBoxVersion(bytes, iinf);
  if (version === null || version > 1) return null;
  const countAt = iinf.body + 4;
  const listAt = countAt + (version === 0 ? 2 : 4);
  if (listAt > iinf.end) return null;
  const count = version === 0 ? v.getUint16(countAt) : v.getUint32(countAt);
  const entries = boxes(bytes, listAt, iinf.end);
  if (entries === null || count === 0 || entries.length !== count) return null;
  const ids = new Set<number>();
  for (const infe of entries) {
    // Flag 1 marks a hidden item.
    const infeVersion = infe.type === "infe" ? fullBoxVersion(bytes, infe, 1) : null;
    if (infeVersion !== 2 && infeVersion !== 3) return null;
    const idSize = infeVersion === 2 ? 2 : 4;
    // item_ID, item_protection_index, item_type, then NUL-terminated strings (the name, and a MIME item's type).
    const typeAt = infe.body + 4 + idSize + 2;
    if (typeAt + 5 > infe.end || !PRINTABLE_TAG_RE.test(ascii(bytes, typeAt, typeAt + 4)) || bytes[infe.end - 1] !== 0) return null;
    const id = idSize === 2 ? v.getUint16(infe.body + 4) : v.getUint32(infe.body + 4);
    if (ids.has(id)) return null;
    ids.add(id);
  }
  return ids;
}

/**
 * The extents of an iloc box (version 0 to 2) read to its last byte: each item one of iinf's, its
 * data in this file (data reference 0) at a file offset or in idat, every extent of stated, non-zero
 * length. Null otherwise.
 */
function avifExtents(bytes: Uint8Array, iloc: Box, items: ReadonlySet<number>): { file: Array<[number, number]>; idat: Array<[number, number]> } | null {
  const v = view(bytes);
  const version = fullBoxVersion(bytes, iloc);
  if (version === null || version > 2) return null;
  let at = iloc.body + 4;
  const read = (size: number): number | null => {
    if (size === 0) return 0;
    if (at + size > iloc.end) return null;
    let value: number;
    if (size === 2) value = v.getUint16(at);
    else if (size === 4) value = v.getUint32(at);
    else {
      const large = v.getBigUint64(at);
      if (large > BigInt(bytes.length)) return null;
      value = Number(large);
    }
    at += size;
    return value;
  };
  const sizes = read(2);
  if (sizes === null || (version === 0 && (sizes & 15) !== 0)) return null;
  const offsetSize = sizes >> 12;
  const lengthSize = (sizes >> 8) & 15;
  const baseSize = (sizes >> 4) & 15;
  const indexSize = version === 0 ? 0 : sizes & 15;
  if (![offsetSize, lengthSize, baseSize, indexSize].every((size) => size === 0 || size === 4 || size === 8)) return null;
  const count = read(version < 2 ? 2 : 4);
  if (count === null) return null;
  const file: Array<[number, number]> = [];
  const idat: Array<[number, number]> = [];
  const seen = new Set<number>();
  for (let item = 0; item < count; item++) {
    const id = read(version < 2 ? 2 : 4);
    if (id === null || !items.has(id) || seen.has(id)) return null;
    seen.add(id);
    // Construction method 0 (a file offset) or 1 (in idat), its twelve reserved bits zero.
    const method = version === 0 ? 0 : read(2);
    if ((method !== 0 && method !== 1) || read(2) !== 0) return null;
    const base = read(baseSize);
    const extents = read(2);
    if (base === null || extents === null || extents === 0) return null;
    for (let extent = 0; extent < extents; extent++) {
      if (read(indexSize) === null) return null;
      const offset = read(offsetSize);
      const length = read(lengthSize);
      if (offset === null || length === null || length === 0) return null;
      (method === 0 ? file : idat).push([base + offset, base + offset + length]);
    }
  }
  return at === iloc.end ? { file, idat } : null;
}

/** iprp: ipco first, its properties laid out in full, then ipma boxes that associate iinf's items with them. */
function avifProperties(bytes: Uint8Array, iprp: Box, items: ReadonlySet<number>): boolean {
  const children = boxes(bytes, iprp.body, iprp.end);
  const ipco = children?.[0];
  if (children === null || ipco === undefined || ipco.type !== "ipco" || children.length < 2) return false;
  const properties = boxes(bytes, ipco.body, ipco.end);
  if (properties === null || properties.length === 0) return false;
  return children.slice(1).every((ipma) => ipma.type === "ipma" && ipmaLaidOut(bytes, ipma, properties.length, items));
}

/** ipma: as many entries as it says, each an item and its property indexes (from 1; 0 for none), filling the box exactly. */
function ipmaLaidOut(bytes: Uint8Array, ipma: Box, properties: number, items: ReadonlySet<number>): boolean {
  const v = view(bytes);
  const version = fullBoxVersion(bytes, ipma, 1);
  if (version === null || version > 1 || ipma.body + 8 > ipma.end) return false;
  const wide = (v.getUint32(ipma.body) & 1) === 1;
  const idSize = version === 0 ? 2 : 4;
  const count = v.getUint32(ipma.body + 4);
  let at = ipma.body + 8;
  for (let entry = 0; entry < count; entry++) {
    if (at + idSize + 1 > ipma.end) return false;
    if (!items.has(idSize === 2 ? v.getUint16(at) : v.getUint32(at))) return false;
    const associations = bytes[at + idSize] ?? 0;
    at += idSize + 1;
    if (at + associations * (wide ? 2 : 1) > ipma.end) return false;
    for (let association = 0; association < associations; association++) {
      if ((wide ? v.getUint16(at) & 0x7fff : (bytes[at] ?? 0) & 0x7f) > properties) return false;
      at += wide ? 2 : 1;
    }
  }
  return at === ipma.end;
}

/**
 * A bitmap's layout from its info header at `base`: a known header, one plane, a known bit count,
 * plain rows (BI_RGB, or BI_BITFIELDS at 16 or 32 bits), a positive width and a non-zero height, and
 * no linked or embedded colour profile. Returns the bytes of the header with its masks and palette,
 * and of the rows (each padded to four bytes); in an ICO (`embedded`) the height counts the colour
 * rows and then the one-bit mask rows, half each. Null when the header is not such a bitmap's.
 */
function bitmapLayout(bytes: Uint8Array, base: number, embedded: boolean): { readonly header: number; readonly pixels: number } | null {
  const v = view(bytes);
  if (bytes.length < base + 12) return null;
  const headerSize = v.getUint32(base, true);
  if (!BMP_HEADER_SIZES.has(headerSize) || base + headerSize > bytes.length) return null;
  const core = headerSize === 12;
  const width = core ? v.getUint16(base + 4, true) : v.getInt32(base + 4, true);
  const height = core ? v.getUint16(base + 6, true) : v.getInt32(base + 8, true);
  const planes = v.getUint16(base + (core ? 8 : 12), true);
  const bits = v.getUint16(base + (core ? 10 : 14), true);
  if (planes !== 1 || !BMP_BIT_COUNTS.has(bits) || width <= 0 || height === 0) return null;
  const compression = core ? BMP_RGB : v.getUint32(base + 16, true);
  if (compression !== BMP_RGB && !(compression === BMP_BITFIELDS && (bits === 16 || bits === 32))) return null;
  // A V4 or V5 header's colour space: a linked ('LINK') or embedded ('MBED') profile is not walked here.
  if (headerSize >= 108 && [0x4c494e4b, 0x4d424544].includes(v.getUint32(base + 56, true))) return null;
  if (embedded && (height < 0 || height % 2 !== 0)) return null;
  const rows = embedded ? height / 2 : Math.abs(height);
  const used = core ? 0 : v.getUint32(base + 32, true);
  if (bits <= 8 && used > 1 << bits) return null;
  const colours = bits <= 8 && used === 0 ? 1 << bits : used;
  const masks = compression === BMP_BITFIELDS && headerSize === 40 ? 12 : 0;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const mask = embedded ? Math.ceil(width / 32) * 4 : 0;
  return { header: headerSize + masks + colours * (core ? 3 : 4), pixels: (stride + mask) * rows };
}

/**
 * BMP: its size field is the file's; the header, masks and palette, then the rows from the pixel
 * offset, with only zero bytes between the two and after the last row (padding some writers add).
 */
function isBmp(bytes: Uint8Array): boolean {
  const v = view(bytes);
  if (ascii(bytes, 0, 2) !== "BM" || bytes.length < 26 || v.getUint32(2, true) !== bytes.length) return false;
  const layout = bitmapLayout(bytes, 14, false);
  if (layout === null) return false;
  const pixels = v.getUint32(10, true);
  const end = pixels + layout.pixels;
  return pixels >= 14 + layout.header && end <= bytes.length && zeros(bytes, 14 + layout.header, pixels) && zeros(bytes, end, bytes.length);
}

/** A bitmap as an ICO holds it (no file header): its header, masks, palette, colour rows and mask rows, then only zero bytes. */
function isIcoBitmap(image: Uint8Array): boolean {
  const layout = bitmapLayout(image, 0, true);
  const end = layout === null ? Number.POSITIVE_INFINITY : layout.header + layout.pixels;
  return end <= image.length && zeros(image, end, image.length);
}

/** ICO: 1 to 255 images, each a PNG or a bitmap laid out in full, end to end from the directory to the end of the file. */
function isIco(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) || bytes.length < 22) return false;
  const v = view(bytes);
  const count = v.getUint16(4, true);
  const directory = 6 + 16 * count;
  if (count < 1 || count > 255 || bytes.length < directory) return false;
  const images: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i;
    const size = v.getUint32(entry + 8, true);
    const offset = v.getUint32(entry + 12, true);
    if (bytes[entry + 3] !== 0 || size === 0 || offset < directory || offset + size > bytes.length) return false;
    const image = bytes.subarray(offset, offset + size);
    if (!isPng(image) && !isIcoBitmap(image)) return false;
    images.push([offset, offset + size]);
  }
  return tiled(bytes, directory, images, 1);
}

/**
 * An sfnt font (TrueType, OpenType): 1 to 512 tables, a head table with its magic number, and the
 * tables laid out from the directory to the end of the file with only zero padding between them.
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
  const blocks: Array<[number, number]> = [];
  for (let i = 0; i < tables; i++) {
    const record = 12 + 16 * i;
    const name = ascii(bytes, record, record + 4);
    const offset = v.getUint32(record + 8);
    const length = v.getUint32(record + 12);
    if (!PRINTABLE_TAG_RE.test(name) || offset < directory || offset + length > bytes.length) return false;
    if (name === "head") {
      if (length < 54 || v.getUint32(offset + 12) !== HEAD_MAGIC) return false;
      head = true;
    }
    blocks.push([offset, offset + length]);
  }
  return head && tiled(bytes, directory, blocks, 4);
}

/**
 * WOFF: the length field is the file's; each table, inflated when stored compressed, comes out at
 * its stated length, every stored byte read (head with its magic); the metadata block inflates to its
 * stated length; and the tables, the metadata and the private block lie from the directory to the end
 * of the file with only zero padding between them.
 */
function isWoff(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 4) !== "wOFF" || bytes.length < 44) return false;
  const v = view(bytes);
  const tables = v.getUint16(12);
  const directory = 44 + 20 * tables;
  if (v.getUint32(8) !== bytes.length || tables < 1 || v.getUint16(14) !== 0 || bytes.length < directory) return false;
  const blocks: Array<[number, number]> = [];
  let total = 0;
  let head = false;
  for (let i = 0; i < tables; i++) {
    const entry = 44 + 20 * i;
    const tag = ascii(bytes, entry, entry + 4);
    const offset = v.getUint32(entry + 4);
    const stored = v.getUint32(entry + 8);
    const length = v.getUint32(entry + 12);
    total += length;
    if (!PRINTABLE_TAG_RE.test(tag) || stored > length || total > MAX_FONT_BYTES || offset < directory || offset + stored > bytes.length) return false;
    const data = bytes.subarray(offset, offset + stored);
    const table = stored === length ? data : decompressed("zlib", data, length);
    if (table === null) return false;
    if (tag === "head") {
      if (length < 54 || view(table).getUint32(12) !== HEAD_MAGIC) return false;
      head = true;
    }
    blocks.push([offset, offset + stored]);
  }
  const metaOffset = v.getUint32(24);
  const metaLength = v.getUint32(28);
  const metaOriginal = v.getUint32(32);
  if (metaOffset !== 0 || metaLength !== 0 || metaOriginal !== 0) {
    if (metaOffset + metaLength > bytes.length || decompressed("zlib", bytes.subarray(metaOffset, metaOffset + metaLength), metaOriginal) === null) return false;
    blocks.push([metaOffset, metaOffset + metaLength]);
  }
  const privateOffset = v.getUint32(36);
  const privateLength = v.getUint32(40);
  if (privateOffset !== 0 || privateLength !== 0) blocks.push([privateOffset, privateOffset + privateLength]);
  return head && tiled(bytes, directory, blocks, 4);
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

/**
 * WOFF2: the length field is the file's; the table directory; one brotli stream that decompresses,
 * every byte of it read, to exactly the tables' lengths (head, never transformed, with its magic);
 * a metadata block that decompresses to its stated length; and the stream, the metadata and the
 * private block from the directory to the end of the file with only zero padding between them.
 */
function isWoff2(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 4) !== "wOF2" || bytes.length < 48) return false;
  const v = view(bytes);
  const tables = v.getUint16(12);
  // A collection carries a second directory this walk does not read: never exempt.
  if (v.getUint32(8) !== bytes.length || tables < 1 || v.getUint16(14) !== 0 || ascii(bytes, 4, 8) === "ttcf") return false;
  let at = 48;
  let total = 0;
  let head = -1;
  for (let i = 0; i < tables; i++) {
    const flags = bytes[at];
    if (flags === undefined) return false;
    at++;
    const index = flags & 0x3f;
    let tag: string | null = null;
    if (index === 0x3f) {
      tag = ascii(bytes, at, at + 4);
      if (!PRINTABLE_TAG_RE.test(tag)) return false;
      at += 4;
    }
    const original = base128(bytes, at);
    if (original === null) return false;
    at += original.length;
    const version = flags >> 6;
    const transformed = index === WOFF2_GLYF || index === WOFF2_LOCA ? version === 0 : version !== 0;
    let size = original.value;
    if (transformed) {
      const length = base128(bytes, at);
      if (length === null) return false;
      at += length.length;
      size = length.value;
    }
    if (index === WOFF2_HEAD || tag === "head") {
      if (transformed || original.value < 54) return false;
      head = total;
    }
    total += size;
    if (total > MAX_FONT_BYTES) return false;
  }
  const streamEnd = at + v.getUint32(20);
  if (head < 0 || streamEnd > bytes.length) return false;
  const font = decompressed("brotli", bytes.subarray(at, streamEnd), total);
  if (font === null || view(font).getUint32(head + 12) !== HEAD_MAGIC) return false;
  const blocks: Array<[number, number]> = [[at, streamEnd]];
  const metaOffset = v.getUint32(28);
  const metaLength = v.getUint32(32);
  const metaOriginal = v.getUint32(36);
  if (metaOffset !== 0 || metaLength !== 0 || metaOriginal !== 0) {
    if (metaOffset + metaLength > bytes.length || decompressed("brotli", bytes.subarray(metaOffset, metaOffset + metaLength), metaOriginal) === null) return false;
    blocks.push([metaOffset, metaOffset + metaLength]);
  }
  const privateOffset = v.getUint32(40);
  const privateLength = v.getUint32(44);
  if (privateOffset !== 0 || privateLength !== 0) blocks.push([privateOffset, privateOffset + privateLength]);
  return tiled(bytes, at, blocks, 4);
}

/**
 * EOT: its fixed header, every name string in turn, and the font data ending at the file's end: an
 * sfnt, stored plain or XOR-obfuscated. MicroType Express compression is not walked here, so a
 * compressed EOT is never exempt.
 */
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
  if ((flags & 0x4) !== 0) return false;
  // XOR-obfuscated data (0x10000000) is the font with every byte XORed with 0x50.
  const data = bytes.subarray(at);
  return isSfnt((flags & 0x10000000) !== 0 ? data.map((byte) => byte ^ 0x50) : data);
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
