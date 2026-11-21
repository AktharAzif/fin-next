// The look-alike rows against Unicode's confusables data (src/engine/unicode-look-alikes.ts and
// the committed subset in src/test-support/confusables.ts): every entry of the subset reads as its
// prototype is drawn, every derived row is one an entry asks for, and the rows are well formed.
import { describe, expect, it } from "vitest";
import { CONFUSABLE_ENTRIES, CONFUSABLES_VERSION } from "../test-support/confusables.ts";
import { glyphsOf, LOOK_ALIKE_ROWS } from "./role-editor.ts";
import { UNICODE_LOOK_ALIKES } from "./unicode-look-alikes.ts";

interface Entry {
  readonly source: string;
  readonly prototype: string;
  readonly label: string;
}

const hex = (text: string) =>
  [...text].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`).join(" ");

const ENTRIES: readonly Entry[] = CONFUSABLE_ENTRIES.join(" ")
  .split(" ")
  .map((item) => {
    const [from = "", to = ""] = item.split(":");
    const source = String.fromCodePoint(Number.parseInt(from, 16));
    const prototype = String.fromCodePoint(...to.split(".").map((c) => Number.parseInt(c, 16)));
    return { source, prototype, label: `${hex(source)} -> ${hex(prototype)}` };
  });

const keysOf = (...rows: readonly string[]) =>
  rows
    .join(" ")
    .split(" ")
    .map((entry) => [...entry][0] ?? "");
const OWN_CAPITALS = new Set(keysOf(...UNICODE_LOOK_ALIKES.capitals, LOOK_ALIKE_ROWS[0] ?? ""));
// Capital prototypes drawn as their small letters, which the reading takes as Latin ones: the arch
// Ո as its small ո (n), Ɛ as ɛ (e), and three omegas and sha as w. Other capital prototypes (Γ, Ω,
// Þ, Ћ, Ք) are drawn unlike their small letters and stand for no Latin letter.
const CAPITAL_PROTOTYPES = new Set([..."ƐՈШѠꙌ"]);

/** A reading, one token a glyph: its Latin letter, or "?" for a letter or digit of no reading. */
const tokens = (glyphs: readonly { reads: string | null }[]) => glyphs.map((g) => g.reads ?? "?");

/**
 * How a prototype is drawn, as the reading takes it: an ASCII letter as itself, lower-cased; a
 * capital as its own row or, for CAPITAL_PROTOTYPES, its small letter, and otherwise as a letter of
 * no Latin reading; any other character as the reading reads it. "rn" is m, as Unicode maps m.
 */
function drawn(prototype: string): string[] {
  const out: string[] = [];
  for (const char of prototype.normalize("NFKD")) {
    if (/^[A-Za-z]$/.test(char)) out.push(char.toLowerCase());
    else if (
      char.toLowerCase() === char ||
      OWN_CAPITALS.has(char) ||
      CAPITAL_PROTOTYPES.has(char)
    ) {
      out.push(...tokens(glyphsOf(char)));
    } else if (/^\p{L}$/u.test(char)) out.push("?");
  }
  return out.join(" ").replaceAll("r n", "m").split(" ").filter(Boolean);
}

const sameLetter = (a: string, b: string) => (a === "l" ? "i" : a) === (b === "l" ? "i" : b);

/**
 * Whether a reading agrees with the wanted one: each wanted Latin letter read alike (I and l as
 * one), in order; a wanted "?" may be read as any letter, or not at all (a hamza drawn above, not
 * beside); nothing added.
 */
function agrees(got: readonly string[], want: readonly string[]): boolean {
  const seen = new Set<number>();
  const from = (i: number, j: number): boolean => {
    const w = want[i];
    if (w === undefined) return j === got.length;
    const key = i * 4096 + j;
    if (seen.has(key)) return false;
    seen.add(key);
    const g = got[j];
    if (w === "?") return from(i + 1, j) || (g !== undefined && from(i + 1, j + 1));
    return g !== undefined && g !== "?" && sameLetter(g, w) && from(i + 1, j + 1);
  };
  return from(0, 0);
}

const UNASSIGNED = /\p{Cn}/u;
// Drawn as punctuation: a prototype of punctuation, symbols and the modifier letters every script
// shares (a macron, a long-vowel mark), with no letter or digit.
const drawnAsPunctuation = (prototype: string) =>
  [...prototype].every(
    (c) =>
      !/^[\p{L}\p{N}]$/u.test(c) ||
      (/^\p{Lm}$/u.test(c) && /^[\p{Script=Common}\p{Script=Inherited}]$/u.test(c)),
  );

describe("Unicode's confusables data (UTS #39)", () => {
  const known = ENTRIES.filter((e) => !UNASSIGNED.test(e.source) && !UNASSIGNED.test(e.prototype));

  it("holds the subset this runtime reads, and keeps later characters for a later runtime", () => {
    expect(ENTRIES.length).toBeGreaterThan(1400);
    expect(known.length).toBeGreaterThan(1350);
    // Every entry left out here is a character this runtime's Unicode does not yet assign.
    for (const e of ENTRIES) {
      if (!known.includes(e)) expect(UNASSIGNED.test(e.source), e.label).toBe(true);
    }
  });

  it("is not older than this runtime's Unicode, so no letter it knows is missing", () => {
    const major = (version: string) => Number.parseInt(version.split(".")[0] ?? "", 10);
    const runtime = major(process.versions.unicode ?? "");
    expect(Number.isSafeInteger(runtime)).toBe(true);
    // A newer runtime knows letters the subset does not: refresh it and the derived rows.
    expect(runtime).toBeLessThanOrEqual(major(CONFUSABLES_VERSION));
    expect(UNICODE_LOOK_ALIKES.version).toBe(CONFUSABLES_VERSION);
  });

  it("reads every letter, digit, sign and symbol as its prototype is drawn", () => {
    const wrong: string[] = [];
    for (const e of known) {
      const glyphs = glyphsOf(e.source);
      if (drawnAsPunctuation(e.prototype)) {
        // A letter drawn as punctuation never counts as a letter of no Latin reading.
        if (glyphs.some((g) => g.reads === null && !g.optional)) wrong.push(e.label);
        continue;
      }
      const letter = /^\p{L}$/u.test(e.source);
      const want = drawn(e.prototype);
      // A digit, sign or symbol is compared on its Latin letters, and may stand for them only.
      const wanted = letter ? want : want.filter((t) => t !== "?");
      if (!agrees(tokens(glyphs), wanted)) wrong.push(`${e.label}: ${tokens(glyphs)} for ${want}`);
      if (!letter && glyphs.some((g) => !g.optional)) wrong.push(`${e.label}: not optional`);
    }
    expect(wrong).toEqual([]);
  });

  it("derives no row an entry does not ask for", () => {
    const sources = new Set(known.map((e) => e.source));
    // A small letter's row may come from its capital's entry (Cyrillic ь reads as Ь does).
    const capitals = new Set(known.map((e) => e.source.toLowerCase()));
    const stray = [
      ...keysOf(...UNICODE_LOOK_ALIKES.beforeFolding).filter((k) => !sources.has(k)),
      ...keysOf(...UNICODE_LOOK_ALIKES.capitals).filter((k) => !sources.has(k)),
      ...keysOf(...UNICODE_LOOK_ALIKES.signs).filter((k) => !sources.has(k)),
      ...keysOf(...UNICODE_LOOK_ALIKES.letters).filter((k) => !sources.has(k) && !capitals.has(k)),
    ];
    expect(stray.map(hex)).toEqual([]);
  });

  it("holds each derived row once, as one character and what it is drawn as", () => {
    const handMade = new Set(keysOf(...LOOK_ALIKE_ROWS));
    for (const [name, rows] of Object.entries({
      beforeFolding: UNICODE_LOOK_ALIKES.beforeFolding,
      capitals: UNICODE_LOOK_ALIKES.capitals,
      letters: UNICODE_LOOK_ALIKES.letters,
      signs: UNICODE_LOOK_ALIKES.signs,
    })) {
      const seen = new Set<string>();
      for (const entry of rows.join(" ").split(" ")) {
        const [char = "", ...reads] = [...entry];
        const what = `${name}: ${hex(entry)}`;
        expect(reads.length, what).toBeGreaterThan(0);
        expect(reads.join(""), what).not.toMatch(/\s/u);
        expect(char.codePointAt(0) ?? 0, what).toBeGreaterThan(0x7f);
        expect(seen.has(char), `${what} appears twice`).toBe(false);
        expect(handMade.has(char), `${what} is also a hand-made row`).toBe(false);
        seen.add(char);
        // What a sign stands for is Latin letters only.
        if (name === "signs") expect(reads.join(""), what).toMatch(/^[a-z]+$/);
      }
    }
  });
});
