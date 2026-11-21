// Every guard of the image and font walks is pinned by a test (spec 07 §2.5): with any one guard
// of src/units/content.ts taken out (helpers/mutants.ts: every condition of every `if`, each arm of
// a ternary, each check a helper takes as an argument, a call that moves the walk kept), some shape
// of helpers/media.ts's `planted` or `textShaped` is exempt, so units.test.ts fails. The guards
// whose removal lets nothing more through are listed below, each with the reason; the list must
// match exactly, so a guard added without a shape, or a listed guard that comes to matter, fails
// here.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TOOL_ROOT } from "./helpers/cli.ts";
import { oneCheckShapes } from "./helpers/media.ts";
import { guardMutants } from "./helpers/mutants.ts";
import type { Mutant } from "./helpers/mutants.ts";

/**
 * The guards no shape can hold, by key (helpers/mutants.ts), each with why: another check refuses
 * every layout it refuses (so taking it out changes nothing), or, for the two bounds on work at the
 * end, a shape would build and inflate more than 64 MiB in every run.
 */
const NO_EFFECT: Readonly<Record<string, string>> = {
  "startsWith: bytes.length < at + prefix.length": "a byte past the end is undefined, which equals no byte of a prefix",
  "ascii: bytes.length < to": "past the end it reads NULs, and every caller compares the result with a printable tag, which a NUL never matches",
  "tiled: end < start": "every block is an offset and an unsigned length, so it never ends before it starts",
  "tiled: at <= bytes.length": "every caller refuses a block that ends past the file before it calls tiled",
  "decompressed: size < 1": "node:zlib throws for a maxOutputLength below 1, which returns null as this check does",
  "decompressed: data.length === 0": "node:zlib throws for an empty stream, which returns null as this check does",
  "isPng: length > 0x7fffffff": "the next check refuses a chunk past the file's end, so this differs only in a file of 2 GiB or more, where the chunk still lies in the file with its CRC",
  "isJpeg: marker === undefined": "isJpegSegment refuses an undefined marker",
  "isJpeg: frame": "a scan is required at EOI, and a scan before any frame is refused, so a scan means a frame",
  "isJpeg: at + length > bytes.length": "the walk then stands past the file's end, where the next marker, or the scan's data, is undefined and refused",
  "isJpeg: next === undefined": "the walk then reads the 0xFF as a marker with nothing after it, which `marker === undefined` refuses",
  "isGif: bytes.length < 14": "the first block is read at byte 13 or later, past the end of a shorter file, which `kind === undefined` refuses",
  "isGif: kind === undefined": "an undefined block type is none of the three the walk reads, so its last branch refuses it",
  "isGif: at + 10 > bytes.length": "the code size is then read past the end, which `minimumCodeSize === undefined` refuses",
  "isGif: minimumCodeSize === undefined": "the sub-blocks after it are then read past the end, which `size === undefined` refuses",
  "isGif: label === undefined": "GIF_LABELS holds no undefined label",
  "isGif: !subBlocks()": "the sub-blocks fail only once they run past the file's end, where the next block's type is undefined, which `kind === undefined` refuses",
  "isGif: !subBlocks() #2": "the sub-blocks fail only once they run past the file's end, where the next block's type is undefined, which `kind === undefined` refuses",
  "isWebp: bytes.length < 20": "a chunk header takes bytes 12 to 20, so a shorter file has no image or is refused at its first chunk",
  "isWebp: end > bytes.length": "the walk then ends past the file's end, which `at === bytes.length` refuses",
  "isWebp: at === bytes.length": "each chunk ends within the file, so the loop ends exactly at its end",
  "boxes: !PRINTABLE_TAG_RE.test(type)": "every box a walk reads is then matched against types it knows, all printable",
  "boxes: large > BigInt(to - at)": "the next check refuses a size past `to`",
  "boxes: size === 1": "a size field of 1 then stays the box's size, below its 8-byte header, which `size < header` refuses",
  "isAvif: top === null": "ftyp is then undefined, which the next check refuses",
  "isAvif: (size - 16) % 4 !== 0": "the last brand then takes 1 to 3 bytes of the next box's size, whose first byte is a NUL (not printable) for any box under 512 MiB",
  "isAvif: meta === undefined": "`metas.length !== 1` refuses a file with no meta",
  "avifMeta: hdlr === undefined": "meta's first child must be hdlr, so hdlr is always there",
  "avifMeta: hdlr.end - hdlr.body < 25": "with no name the name check refuses, since the name's NUL must be the box's last byte",
  "avifReferences: reference.body + idSize + 2 > reference.end": "the length check after it needs at least that many bytes",
  "avifDataReferences: dref === undefined": "one child is required, so dref is always that child",
  "avifDataReferences: dref.body + 8 > dref.end": "the entry list is then empty, which no count above zero matches",
  "avifGroups: group.body + 12 > group.end": "the length check after it needs at least 12 bytes",
  "avifItems: listAt > iinf.end": "the entry list is then empty, which no count matches (a count of zero is refused)",
  "avifItems: count === 0": "with no items, the primary item is none of them",
  "avifItems: typeAt + 5 > infe.end": "no string then follows the type, which the string count refuses",
  "avifExtents: at + size > iloc.end": "the walk then ends past iloc's end, which its last check refuses",
  "avifExtents: sizes === null": "the count after it is then read past iloc's end too, which refuses",
  "avifExtents: count === null": "with no count there are no items, and a file with no extents is refused",
  "avifExtents: id === null": "no item has a null ID",
  "avifProperties: children === null": "ipco is then undefined, which the next check refuses",
  "avifProperty: size >= 5": "the size it must then equal is at least 5",
  "avifProperty: after !== null": "`box.end - null` is the box's end, past byte 64 of any AVIF (ftyp, meta's header and hdlr come first), so the bound refuses it",
  "ipmaLaidOut: ipma.body + 8 > ipma.end": "the walk then ends past ipma's end, which its last check refuses",
  "ipmaLaidOut: at + idSize + 1 > ipma.end": "the walk then ends past ipma's end, which its last check refuses",
  "ipmaLaidOut: at + associations * (wide ? 2 : 1) > ipma.end": "the walk then ends past ipma's end, which its last check refuses",
  "ipmaLaidOut: at + associations * (wide ? 2 : 1) > ipma.end [when wide]": "the walk then ends past ipma's end, which its last check refuses",
  "ipmaLaidOut: at + associations * (wide ? 2 : 1) > ipma.end [unless wide]": "the walk then ends past ipma's end, which its last check refuses",
  "isBmp: bytes.length < 26": "bitmapLayout refuses a header shorter than 12 bytes from byte 14",
  "isIco: bytes.length < 22": "one directory entry takes the file to 22 bytes, which `bytes.length < directory` refuses",
  "isIco: count < 1": "with no images the file must end at byte 6, which `bytes.length < 22` refuses",
  "isIco: bytes.length < directory": "an image must start at or after the directory's end, past the file's end, which `offset + size > bytes.length` refuses",
  "isIco: size === 0": "an empty image is neither a PNG nor a bitmap",
  "isIco: offset < directory": "tiled refuses an image that starts before the directory's end",
  "isIco: offset + size > bytes.length": "tiled refuses an image that ends past the file",
  "isSfnt: tables < 1": "a font with no tables has no head table",
  "isSfnt: offset < directory": "tiled refuses a table that starts before the directory's end",
  "isSfnt: offset + length > bytes.length": "tiled refuses a table that ends past the file",
  "isWoff: tables < 1": "a font with no tables has no head table",
  "isWoff: offset < directory": "tiled refuses a table that starts before the directory's end",
  "isWoff: offset + stored > bytes.length": "tiled refuses a table that ends past the file",
  "isWoff: metaOffset + metaLength > bytes.length": "tiled refuses metadata that ends past the file",
  "base128: byte === undefined": "the stream then starts past the end, which `streamEnd > bytes.length` refuses",
  "isWoff2: tables < 1": "with no tables there is no head, which `head < 0` refuses",
  "isWoff2: flags === undefined": "the table's length is then read past the end, which base128 refuses",
  "isWoff2: total > MAX_FONT_BYTES": "decompressed refuses a size above MAX_FONT_BYTES, and total is the size it is given",
  "isWoff2: streamEnd > bytes.length": "tiled refuses a stream that ends past the file",
  "isWoff2: metaOffset + metaLength > bytes.length": "tiled refuses metadata that ends past the file",
  "isEot: at <= bytes.length": "the next field, or the font data's size check, then refuses a position past the end",
  "isEot: !field(0)":
    "a signature field that fails leaves the position where it was, so its padding and size are then read as the EUDC flags, which must be zero, and neither can fail while both are",
  "verifiedExclusion: format !== null": "no extension's formats include null",
  // Bounds on work, not on which bytes are read: past them a font is refused before it is inflated.
  "decompressed: size > MAX_FONT_BYTES": "a bound on work: a shape would build and inflate a stream of more than 64 MiB in every run",
  "isWoff: total > MAX_FONT_BYTES": "a bound on work (each compressed table is bounded by decompressed, this bounds their sum): a shape would inflate more than 64 MiB in every run",
};

/**
 * The shapes of `oneCheckShapes` that only a walk that never ends holds (a hang names no shape), each
 * with the guard whose removal makes it run on.
 */
const HANGS: Readonly<Record<string, string>> = {
  "scan-unterminated.jpg": "isJpeg: byte === undefined, the end of the file inside a scan",
};

/**
 * The CPU time past which a mutant's run is a walk that never ends (one run takes well under a second
 * of it). CPU time, not wall time, which a busy machine stretches without the run doing more.
 */
const CPU_LIMIT_MICROSECONDS = 5_000_000;

/**
 * The check each mutant runs, as units.test.ts asserts it: every planted shape is no format and not
 * exempt (a walk that throws on one names it), every text-shaped file is not exempt, no bytes at all
 * are no format, and every exempt shape stays exempt as what its name says. It prints "unchanged"
 * when all of that holds, and what broke otherwise. A watchdog thread kills it once it has used
 * CPU_LIMIT_MICROSECONDS of CPU time.
 */
const CHECK = `import { Worker } from "node:worker_threads";
import * as content from "./content.ts";
import { FONT_NAME_RE, exemptShapes, misnamed, planted, textShaped } from "../media.ts";
new Worker("const { cpuUsage, kill, pid } = process; setInterval(() => { const used = cpuUsage(); if (used.user + used.system > ${CPU_LIMIT_MICROSECONDS}) kill(pid, 'SIGKILL'); }, 50);", { eval: true }).unref();
const payload = Buffer.from("\\0#!/bin/sh\\necho MARKER-PAYLOAD\\n");
const broken = [];
for (const [name, bytes] of Object.entries(planted(payload))) {
  try {
    if (content.mediaFormat(bytes) !== null || content.verifiedExclusion("assets/" + name, bytes) !== null) broken.push("passes " + name);
  } catch {
    broken.push("throws " + name);
  }
}
for (const [name, bytes] of Object.entries({ ...textShaped(), ...misnamed() })) {
  if (content.mediaFormat(bytes) === null || content.verifiedExclusion("assets/" + name, bytes) !== null) broken.push("passes " + name);
}
if (content.mediaFormat(Buffer.alloc(0)) !== null) broken.push("passes no bytes");
for (const [name, bytes] of Object.entries(exemptShapes())) {
  if (content.verifiedExclusion("assets/" + name, bytes) !== (FONT_NAME_RE.test(name) ? "font" : "image")) broken.push("refuses " + name);
}
process.stdout.write(broken.length === 0 ? "unchanged" : broken.join(" "));
`;

/**
 * What one mutant does to the shapes: "unchanged" (the guard is not pinned), what it broke, or how it
 * failed (a crash or a hang also fails the tests). The wall-clock timeout only backs up the watchdog.
 */
function runMutant(dir: string, mutant: Mutant, index: number): Promise<string> {
  const own = join(dir, `m${index}`);
  mkdirSync(own);
  writeFileSync(join(own, "content.ts"), mutant.source);
  writeFileSync(join(own, "check.ts"), CHECK);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(own, "check.ts")], { stdio: ["ignore", "pipe", "ignore"], timeout: 300_000 });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => resolve(signal !== null ? `hangs (${signal})` : code !== 0 ? `crashes (${code})` : out));
  });
}

describe("the guards of the image and font walks (spec 07 §2.5)", () => {
  it("taking out any one guard of content.ts makes a planted shape exempt (or the walk throw or never end), except the guards listed as having no effect", async () => {
    const source = readFileSync(join(TOOL_ROOT, "src", "units", "content.ts"), "utf8");
    const mutants = guardMutants(source);
    const keys = new Set(mutants.map((mutant) => mutant.key));
    // The enumerator reads the guards the findings named, so a layout it cannot read fails here: plain
    // refusals and acceptances, each arm of a ternary in a condition or inside a guard, the conditions
    // of a braced block of checks and of a flag, a check of what a position-moving read returns (the
    // read kept), and each check a helper takes as an argument.
    for (const key of [
      "avifGroups: !items.has(v.getUint32(at))",
      "avifReferences: !items.has(id(at))",
      "covers: extent[0] > at",
      "isWoff: tiled(bytes, directory, blocks, 4)",
      "isWoff2: tiled(bytes, at, blocks, 4)",
      "verifiedExclusion: isUtf8(bytes)",
      "cString: at - from <= max",
      "bitmapLayout: used > 1 << bits",
      "bitmapLayout: used !== 0",
      "avifMeta: pitm.end - pitm.body !== (pitmVersion === 0 ? 6 : 8) [unless pitmVersion === 0]",
      "avifProperty: size === ((first & 1) === 1 ? 13 : 7) [when (first & 1) === 1]",
      'avifItems: strings !== (itemType === "uri " ? 2 : 1) [when itemType === "uri "]',
      "ipmaLaidOut: (wide ? v.getUint16(at) & 0x7fff : (bytes[at] ?? 0) & 0x7f) > properties [when wide]",
      "avifExtents: read(2) !== 0",
      "isWoff: metaOffset !== 0",
      "isWoff: metaLength !== 0",
      "isWoff: metaOriginal !== 0",
      "isWoff2: metaOffset !== 0",
      "isWoff2: metaLength !== 0",
      "isWoff2: metaOriginal !== 0",
      'isPng: type === "IDAT"',
      "isGif: size === 0",
      "isEot: !field(EOT_MAX_NAME)",
      "avifMeta: fullBoxVersion(bytes, meta) [every flag of meta]",
      "avifMeta: fullBoxVersion(bytes, hdlr) [every flag of hdlr]",
      "avifMeta: fullBoxVersion(bytes, pitm) [every flag of pitm]",
      "avifReferences: fullBoxVersion(bytes, iref) [every flag of iref]",
      "avifDataReferences: fullBoxVersion(bytes, dref) [every flag of dref]",
      "avifDataReferences: fullBoxVersion(bytes, entry, 1) [every flag of entry]",
      "avifGroups: fullBoxVersion(bytes, group) [every flag of group]",
      "avifItems: fullBoxVersion(bytes, iinf) [every flag of iinf]",
      "avifItems: fullBoxVersion(bytes, infe, 1) [every flag of infe]",
      "avifExtents: fullBoxVersion(bytes, iloc) [every flag of iloc]",
      "avifProperty: fullBoxVersion(bytes, box) [every flag of box] #3",
      "ipmaLaidOut: fullBoxVersion(bytes, ipma, 1) [every flag of ipma]",
      "isEot: field(EOT_MAX_ROOT) [no bound]",
      "isIco: tiled(bytes, directory, images, 1) [any zero padding]",
    ]) {
      assert.ok(keys.has(key), key);
    }
    assert.ok(mutants.length >= 460, `${mutants.length} guards`);
    // A layout the reader cannot classify fails rather than being skipped.
    assert.throws(() => guardMutants(`function isX(bytes: Uint8Array): boolean {\n  if (bytes.length > 4) bytes.reverse();\n  return true;\n}\n`), /an if whose statement the reader cannot classify/);
    assert.throws(() => guardMutants(`function isX(bytes: Uint8Array, limit: number): boolean {\n  return bytes.length < limit;\n}\n`), /takes limit, a check the reader does not take out/);
    for (const key of Object.keys(NO_EFFECT)) assert.ok(keys.has(key), `listed as having no effect but not a guard: ${key}`);

    const dir = mkdtempSync(join(tmpdir(), "fin-review-guards-"));
    try {
      copyFileSync(join(TOOL_ROOT, "test", "helpers", "media.ts"), join(dir, "media.ts"));
      // The check holds for content.ts as it is, so a failure below is the guard's, not the harness's.
      assert.equal(await runMutant(dir, { key: "none", line: 0, source }, mutants.length), "unchanged");
      const outcomes: string[] = new Array<string>(mutants.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (let index = next++; index < mutants.length; index = next++) {
          const mutant = mutants[index];
          if (mutant !== undefined) outcomes[index] = await runMutant(dir, mutant, index);
        }
      };
      // Half the machine, so the suite's other files (some of which time what they do) keep the rest.
      await Promise.all(Array.from({ length: Math.max(1, Math.floor(availableParallelism() / 2)) }, worker));
      const unpinned = mutants.filter((_, index) => outcomes[index] === "unchanged").map((mutant) => `${mutant.line} ${mutant.key}`);
      const listed = mutants.filter((mutant) => mutant.key in NO_EFFECT).map((mutant) => `${mutant.line} ${mutant.key}`);
      const notListed = unpinned.filter((entry) => !listed.includes(entry));
      const pinned = listed.filter((entry) => !unpinned.includes(entry));
      assert.deepEqual(unpinned, listed, `guards no test pins:\n${notListed.join("\n")}\nlisted as having no effect, but pinned:\n${pinned.join("\n")}`);
      // And the other way: each shape that stands for one check passes (or makes the walk throw) with
      // some one guard taken out. A shape that fails two checks no single guard holds passes with
      // none, so it fails here rather than standing in for a check it does not pin.
      const freed = new Set(outcomes.flatMap((outcome) => [...outcome.matchAll(/\b(?:passes|throws) (\S+)/g)].map((match) => match[1] ?? "")));
      assert.deepEqual(
        oneCheckShapes().filter((name) => !freed.has(name) && !(name in HANGS)),
        [],
        "shapes no single guard holds",
      );
      for (const name of Object.keys(HANGS)) assert.ok(!freed.has(name) && oneCheckShapes().includes(name), `listed as held only by a hang: ${name}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
