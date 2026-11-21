// fin-font-metrics 1.0.0: builds fonts.css from the font files in fonts/ (spec 06 §3.2). `pnpm
// --filter @fin/tokens fonts` (scripts/write-fonts.ts) writes fonts.css; test/fonts.test.ts fails
// unless the committed fonts.css is, as a whole and byte for byte, what this builds from the
// committed font files. Web APIs only: the WOFF2 table data is Brotli, read with
// DecompressionStream.
//
// WHAT IT WRITES, and nothing else: a header comment naming the tool; one @font-face per file, in
// file-name order; then, for each variable font (today Inter), a one-line comment naming the tool
// and the file, and the metric-matched fallback face that keeps the layout still while it loads.
// Every value is read from the file's own tables or is a constant written here:
//
//   each file's face   value                                     read from
//   font-family        "<family>", less a trailing weight word   name table: ID 16, else ID 1
//                      (Thin to Black); "<family> Variable" for  fvar (a wght axis)
//                      a variable font
//   font-style         italic, else normal                       OS/2 fsSelection bit 0
//   font-weight        "<min> <max>" of the wght axis, else the  fvar; OS/2 usWeightClass
//                      weight class
//   font-display       swap                                      constant
//   src                url("./fonts/<file>") format("woff2")     the file's name
//
//   the fallback face  value                                     read from
//   font-family        "<family> Fallback"                       name table
//   src                local("Arial"), local("Liberation Sans")  constant
//   size-adjust        A(font) / A(Arial)                        cmap, hmtx, head; ARIAL
//   ascent-override    ascent / unitsPerEm / size-adjust         OS/2 typo metrics when
//   descent-override   |descent| / unitsPerEm / size-adjust      USE_TYPO_METRICS is set, else
//   line-gap-override  lineGap / unitsPerEm / size-adjust        hhea; head
//
// A(f) is f's average advance of a to z in ems, weighted by LETTER_FREQUENCY; Arial's metrics are
// the published ones in ARIAL. Each percentage is rounded to two decimals.

export const TOOL = "fin-font-metrics 1.0.0";

/** What a face needs from a font's tables. Lengths are in font units. */
export type FontMetrics = {
  family: string;
  unitsPerEm: number;
  /** The vertical metrics browsers lay text out with: OS/2's typo ones under USE_TYPO_METRICS, else hhea's. */
  ascent: number;
  descent: number;
  lineGap: number;
  /** The advance widths of a to z (hmtx, through cmap). */
  widths: Record<string, number>;
  weight: number;
  /** The wght axis of a variable font, else null. */
  weightRange: [number, number] | null;
  italic: boolean;
};

/**
 * Arial's metrics as its own head and hhea tables publish them (Arial 7.00, as Windows and macOS
 * ship it), and its advance widths of a to z, which are Helvetica's published widths (Adobe's
 * core-font AFM, in 1000ths of an em) in Arial's 2048 units: the fallback every system the
 * canvases target has.
 */
export const ARIAL: Pick<
  FontMetrics,
  "family" | "unitsPerEm" | "ascent" | "descent" | "lineGap" | "widths"
> = {
  family: "Arial",
  unitsPerEm: 2048,
  ascent: 1854,
  descent: -434,
  lineGap: 67,
  widths: {
    a: 1139,
    b: 1139,
    c: 1024,
    d: 1139,
    e: 1139,
    f: 569,
    g: 1139,
    h: 1139,
    i: 455,
    j: 455,
    k: 1024,
    l: 455,
    m: 1706,
    n: 1139,
    o: 1139,
    p: 1139,
    q: 1139,
    r: 682,
    s: 1024,
    t: 569,
    u: 1139,
    v: 1024,
    w: 1479,
    x: 1024,
    y: 1024,
    z: 1024,
  },
};

/**
 * How often each letter stands in English text, in per cent of letters (the common table, as in
 * Wikipedia's "Letter frequency"): the weights of the average advance both fonts are matched on.
 */
const LETTER_FREQUENCY: Record<string, number> = {
  a: 8.2,
  b: 1.5,
  c: 2.8,
  d: 4.3,
  e: 12.7,
  f: 2.2,
  g: 2.0,
  h: 6.1,
  i: 7.0,
  j: 0.15,
  k: 0.77,
  l: 4.0,
  m: 2.4,
  n: 6.7,
  o: 7.5,
  p: 1.9,
  q: 0.095,
  r: 6.0,
  s: 6.3,
  t: 9.1,
  u: 2.8,
  v: 0.98,
  w: 2.4,
  x: 0.15,
  y: 2.0,
  z: 0.074,
};

/** The frequency-weighted average advance of a to z, in ems. */
export function averageAdvance(font: Pick<FontMetrics, "unitsPerEm" | "widths">): number {
  let sum = 0;
  let weights = 0;
  for (const [letter, weight] of Object.entries(LETTER_FREQUENCY)) {
    const width = font.widths[letter];
    if (width === undefined) throw new Error(`font: no advance for ${letter}`);
    sum += width * weight;
    weights += weight;
  }
  return sum / weights / font.unitsPerEm;
}

// WOFF2's known table tags, by the index a table directory entry's flags may name (WOFF2 §5.1);
// 63 means the tag follows the flags.
const KNOWN_TAGS = [
  ...["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf"],
  ...["loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT"],
  ...["VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT"],
  ...["CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar"],
  ...["fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd"],
  ...["prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"],
];

// Node 26 (and current browsers) decompress Brotli; the DOM types still list only gzip and deflate.
const BROTLI = "brotli" as CompressionFormat;

async function brotli(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream(BROTLI));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The tables of a WOFF2 file (untransformed ones only, which is all this reads), or of an sfnt. */
async function tables(bytes: Uint8Array): Promise<Map<string, DataView>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, DataView>();
  const signature = view.getUint32(0);
  if (signature === 0x774f4632) {
    const count = view.getUint16(12);
    const compressedLength = view.getUint32(20);
    let at = 48;
    const base128 = () => {
      let value = 0;
      for (let i = 0; i < 5; i++) {
        const byte = view.getUint8(at++);
        value = value * 128 + (byte & 0x7f);
        if ((byte & 0x80) === 0) return value;
      }
      throw new Error("woff2: a UIntBase128 longer than 5 bytes");
    };
    const entries: { tag: string; length: number; transformed: boolean }[] = [];
    for (let i = 0; i < count; i++) {
      const flags = view.getUint8(at++);
      let tag = KNOWN_TAGS[flags & 0x3f] ?? "";
      if ((flags & 0x3f) === 63) {
        tag = String.fromCharCode(...bytes.subarray(at, at + 4));
        at += 4;
      }
      const version = flags >> 6;
      const original = base128();
      // glyf and loca are transformed unless their version is 3; any other table only when it is not 0.
      const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
      entries.push({ tag, length: transformed ? base128() : original, transformed });
    }
    const data = await brotli(bytes.subarray(at, at + compressedLength));
    let offset = 0;
    for (const entry of entries) {
      if (!entry.transformed) {
        out.set(entry.tag, new DataView(data.buffer, data.byteOffset + offset, entry.length));
      }
      offset += entry.length;
    }
    return out;
  }
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    out.set(
      tag,
      new DataView(
        bytes.buffer,
        bytes.byteOffset + view.getUint32(record + 8),
        view.getUint32(record + 12),
      ),
    );
  }
  return out;
}

function table(all: Map<string, DataView>, tag: string): DataView {
  const found = all.get(tag);
  if (found === undefined) throw new Error(`font: no ${tag} table`);
  return found;
}

/** The family a name table gives: the typographic family (16), else the family (1). */
function familyName(name: DataView): string {
  const count = name.getUint16(2);
  const strings = name.getUint16(4);
  const found = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    const platform = name.getUint16(record);
    const id = name.getUint16(record + 6);
    if (platform !== 3 || (id !== 1 && id !== 16)) continue;
    const length = name.getUint16(record + 8);
    const offset = strings + name.getUint16(record + 10);
    let text = "";
    for (let j = 0; j < length; j += 2) text += String.fromCharCode(name.getUint16(offset + j));
    found.set(id, text);
  }
  const family = found.get(16) ?? found.get(1);
  if (family === undefined) throw new Error("font: no family name");
  return family;
}

/** The wght axis of an fvar table, as [min, max], or null. */
function weightAxis(fvar: DataView | undefined): [number, number] | null {
  if (fvar === undefined) return null;
  const axesAt = fvar.getUint16(4);
  const axes = fvar.getUint16(8);
  const size = fvar.getUint16(10);
  for (let i = 0; i < axes; i++) {
    const axis = axesAt + i * size;
    if (fvar.getUint32(axis) !== 0x77676874) continue;
    return [fvar.getInt32(axis + 4) / 65536, fvar.getInt32(axis + 12) / 65536];
  }
  return null;
}

/** The glyph a code point maps to, from a cmap's Unicode subtable (format 4 or 12), or 0. */
function glyphMapper(cmap: DataView): (codePoint: number) => number {
  const count = cmap.getUint16(2);
  let best: { offset: number; format: number } | null = null;
  for (let i = 0; i < count; i++) {
    const record = 4 + i * 8;
    const platform = cmap.getUint16(record);
    const encoding = cmap.getUint16(record + 2);
    const offset = cmap.getUint32(record + 4);
    const format = cmap.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && (format === 4 || format === 12) && (best === null || format > best.format)) {
      best = { offset, format };
    }
  }
  if (best === null) throw new Error("font: no Unicode cmap subtable of format 4 or 12");
  const { offset, format } = best;
  if (format === 12) {
    const groups = cmap.getUint32(offset + 12);
    return (codePoint) => {
      for (let i = 0; i < groups; i++) {
        const group = offset + 16 + i * 12;
        const start = cmap.getUint32(group);
        if (codePoint >= start && codePoint <= cmap.getUint32(group + 4)) {
          return cmap.getUint32(group + 8) + codePoint - start;
        }
      }
      return 0;
    };
  }
  const segments = cmap.getUint16(offset + 6) / 2;
  const ends = offset + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  return (codePoint) => {
    for (let i = 0; i < segments; i++) {
      if (codePoint > cmap.getUint16(ends + i * 2)) continue;
      const start = cmap.getUint16(starts + i * 2);
      if (codePoint < start) return 0;
      const delta = cmap.getInt16(deltas + i * 2);
      const range = cmap.getUint16(ranges + i * 2);
      if (range === 0) return (codePoint + delta) & 0xffff;
      const at = ranges + i * 2 + range + (codePoint - start) * 2;
      const glyph = cmap.getUint16(at);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

/** The advance widths of a to z, through cmap and hmtx. */
function letterWidths(all: Map<string, DataView>): Record<string, number> {
  const glyph = glyphMapper(table(all, "cmap"));
  const hmtx = table(all, "hmtx");
  const metrics = table(all, "hhea").getUint16(34);
  const out: Record<string, number> = {};
  for (let code = 0x61; code <= 0x7a; code++) {
    const id = glyph(code);
    if (id === 0) throw new Error(`font: no glyph for ${String.fromCharCode(code)}`);
    out[String.fromCharCode(code)] = hmtx.getUint16(Math.min(id, metrics - 1) * 4);
  }
  return out;
}

/** The metrics of a WOFF2 (or sfnt) font file. */
export async function readFont(bytes: Uint8Array): Promise<FontMetrics> {
  const all = await tables(bytes);
  const head = table(all, "head");
  const hhea = table(all, "hhea");
  const os2 = table(all, "OS/2");
  const fsSelection = os2.getUint16(62);
  const typo = (fsSelection & 0x80) !== 0;
  return {
    family: familyName(table(all, "name")),
    unitsPerEm: head.getUint16(18),
    ascent: typo ? os2.getInt16(68) : hhea.getInt16(4),
    descent: typo ? os2.getInt16(70) : hhea.getInt16(6),
    lineGap: typo ? os2.getInt16(72) : hhea.getInt16(8),
    widths: letterWidths(all),
    weight: os2.getUint16(4),
    weightRange: weightAxis(all.get("fvar")),
    italic: (fsSelection & 0x01) !== 0,
  };
}

const percent = (value: number) => `${(Math.round(value * 10000) / 100).toFixed(2)}%`;

/**
 * The overrides that make `fallback` take the room `font` takes: size-adjust scales the
 * fallback's average advance of a to z (weighted by English letter frequency) to the font's; the
 * ascent, descent and line gap are the font's, in the adjusted size.
 */
export function fallbackOverrides(
  font: FontMetrics,
  fallback: typeof ARIAL,
): Record<"size-adjust" | "ascent-override" | "descent-override" | "line-gap-override", string> {
  const adjust = averageAdvance(font) / averageAdvance(fallback);
  return {
    "size-adjust": percent(adjust),
    "ascent-override": percent(font.ascent / font.unitsPerEm / adjust),
    "descent-override": percent(Math.abs(font.descent) / font.unitsPerEm / adjust),
    "line-gap-override": percent(font.lineGap / font.unitsPerEm / adjust),
  };
}

const WEIGHT_WORDS = /\s+(?:Thin|ExtraLight|Light|Regular|Medium|SemiBold|Bold|ExtraBold|Black)$/;

/**
 * The family a face is declared under: the font's own family without a weight word (Fira Mono
 * Medium is Fira Mono at 500), and a variable font's as "<family> Variable", the name the tokens'
 * stacks put first so the whole axis is used.
 */
export function faceFamily(font: FontMetrics): string {
  const family = font.family.replace(WEIGHT_WORDS, "");
  return font.weightRange === null ? family : `${family} Variable`;
}

/** The family of the metric-matched fallback for a sans family, as the tokens' stacks name it. */
const fallbackFamily = (family: string) => `${family} Fallback`;

/**
 * fonts.css for the given files of fonts/ (name and bytes): a face per file, in name order, then
 * the metric-matched fallback of each variable face. A file that is no font throws.
 */
export async function buildFonts(files: { name: string; bytes: Uint8Array }[]): Promise<string> {
  const faces: string[] = [];
  const fallbacks: string[] = [];
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const font = await readFont(file.bytes);
    const weight =
      font.weightRange === null
        ? String(font.weight)
        : `${font.weightRange[0]} ${font.weightRange[1]}`;
    faces.push(
      [
        "@font-face {",
        `  font-family: "${faceFamily(font)}";`,
        `  font-style: ${font.italic ? "italic" : "normal"};`,
        `  font-weight: ${weight};`,
        "  font-display: swap;",
        `  src: url("./fonts/${file.name}") format("woff2");`,
        "}",
        "",
      ].join("\n"),
    );
    if (font.weightRange !== null) {
      const overrides = fallbackOverrides(font, ARIAL);
      fallbacks.push(
        [
          `/* ${font.family}'s room, in Arial: ${TOOL}, from ${file.name} and Arial's metrics. */`,
          "@font-face {",
          `  font-family: "${fallbackFamily(font.family)}";`,
          '  src: local("Arial"), local("Liberation Sans");',
          ...Object.entries(overrides).map(([name, value]) => `  ${name}: ${value};`),
          "}",
          "",
        ].join("\n"),
      );
    }
  }
  return [
    "/*",
    ` * @fin/tokens fonts.css: generated by ${TOOL} (scripts/fonts.ts) from the files in`,
    " * fonts/ (spec 06 §3.2). Do not edit it by hand: run `pnpm --filter @fin/tokens fonts`;",
    " * test/fonts.test.ts fails when it is stale. Each face's family, weight and style come from",
    " * its file's name, fvar and OS/2 tables; the fallback's size-adjust and overrides from Inter's",
    " * head, hhea, OS/2, cmap and hmtx tables against Arial's (Liberation Sans has Arial's metrics).",
    " * Inter and Fira Mono are under the SIL Open Font License 1.1 (fonts/OFL.txt). Relative URLs:",
    " * Vite emits the files hashed, on the app's own origin.",
    " */",
    "",
    faces.join("\n"),
    fallbacks.join("\n"),
  ].join("\n");
}
