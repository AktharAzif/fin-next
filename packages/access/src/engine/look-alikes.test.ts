// The look-alike rows against Unicode's data: the confusables entries in
// src/test-support/confusables.ts (every entry of confusables.txt but those whose source is ASCII
// or draws as nothing) and the names of the Latin letters in src/test-support/latin-letters.ts.
// Every entry reads as its prototype is drawn, and a modifier letter drawn as punctuation may
// always be passed over; the members of each of Unicode's classes read alike; a capital reads as
// its small letter only where Unicode draws it so; a Latin letter named for another with a stroke,
// hook or curl, or a small capital, reads as that letter; every derived row is one the data asks
// for; and the rows are well formed.
import { describe, expect, it } from "vitest";
import { CONFUSABLE_ENTRIES, CONFUSABLES_VERSION } from "../test-support/confusables.ts";
import { LATIN_LETTERS, LATIN_LETTERS_VERSION } from "../test-support/latin-letters.ts";
import { glyphsOf, LOOK_ALIKE_ROWS } from "./role-editor.ts";
import { hasInvisible } from "./text.ts";
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

const LETTERS = LATIN_LETTERS.map((entry) => {
  const at = entry.indexOf(":");
  const char = String.fromCodePoint(Number.parseInt(entry.slice(0, at), 16));
  return { char, name: entry.slice(at + 1) };
});

const keysOf = (...rows: readonly string[]) =>
  rows
    .join(" ")
    .split(" ")
    .filter(Boolean)
    .map((entry) => [...entry][0] ?? "");
const OWN_CAPITALS = new Set(keysOf(...UNICODE_LOOK_ALIKES.capitals, LOOK_ALIKE_ROWS[0] ?? ""));
const UNLIKE_CAPITALS = [...UNICODE_LOOK_ALIKES.unlikeCapitals.join("")];
// Capital prototypes drawn as their small letters, which the reading takes as Latin ones: the arch
// Ո as its small ո (n), Ɛ as ɛ and Ꞓ as ꞓ (e), and three omegas and sha as w. Other capital
// prototypes (Γ, Ω, Þ, Ћ, Ք) are drawn unlike their small letters and stand for no Latin letter.
const CAPITAL_PROTOTYPES = new Set([..."ƐꞒՈШЪѠꙌ"]);

/** A source as the reading reads it, in the order it is stored, as its prototype is. */
const read = (text: string) => glyphsOf(text, "stored");

/** A reading, one token a glyph: its Latin letter, or "?" for a letter or digit of no reading. */
const tokens = (glyphs: readonly { reads: string | null }[]) => glyphs.map((g) => g.reads ?? "?");

const isLetter = (char: string) => /^\p{L}$/u.test(char);
const isModifierLetter = (char: string) => /^\p{Lm}$/u.test(char);
const isShared = (char: string) => /^[\p{Script=Common}\p{Script=Inherited}]$/u.test(char);

/**
 * How a prototype is drawn, as the reading takes it: an ASCII letter as itself, lower-cased; a
 * capital as its own row or, for CAPITAL_PROTOTYPES, its small letter, and otherwise as a letter of
 * no Latin reading; a modifier letter of one script (a small ideograph, a high dot) as a letter of
 * no Latin reading, which may also be read as nothing; any other character as the reading reads
 * it. "rn" is m, as Unicode maps m.
 */
function drawn(prototype: string): string[] {
  const out: string[] = [];
  for (const char of prototype.normalize("NFKD")) {
    if (/^[A-Za-z]$/.test(char)) out.push(char.toLowerCase());
    else if (isModifierLetter(char) && !isShared(char)) out.push("?");
    else if (
      char.toLowerCase() === char ||
      OWN_CAPITALS.has(char) ||
      CAPITAL_PROTOTYPES.has(char)
    ) {
      out.push(...tokens(read(char)));
    } else if (isLetter(char)) out.push("?");
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

/**
 * The Latin letters a text reads as, digits and signs by the letters they stand for, I and l as
 * one, "rn" as m and "cl" as d (as Unicode maps m and d): what the members of a class agree on.
 */
const latinOf = (text: string) =>
  tokens(read(text))
    .filter((t) => /^[a-z]$/.test(t))
    .join("")
    .replaceAll("rn", "m")
    .replaceAll("cl", "d")
    .replaceAll("l", "i");

const UNASSIGNED = /\p{Cn}/u;
const isAscii = (text: string) => [...text].every((c) => (c.codePointAt(0) ?? 0) < 0x80);
const withoutMarks = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "");
/** Folding decides how a character reads when it folds it to ASCII, accents aside: "ſ" is s. */
const foldedToAscii = (char: string) => {
  const folded = withoutMarks(char);
  return folded !== char && folded !== "" && isAscii(folded);
};
/** Whether compatibility folding changes a character. */
const folds = (char: string) => char.normalize("NFKD") !== char;
// Drawn as punctuation: a prototype of punctuation, symbols and the modifier letters every script
// shares (a macron, a long-vowel mark), with no letter or digit.
const drawnAsPunctuation = (prototype: string) =>
  [...prototype].every((c) => !/^[\p{L}\p{N}]$/u.test(c) || (isModifierLetter(c) && isShared(c)));

// A name that calls a letter a form of a Latin one: the letter, perhaps "WITH" a stroke, hook, curl
// or tail, in one of the hands it is written in. Turned, reversed, sideways, open and half letters
// are drawn otherwise, and are not named for the letter here.
const FORMS =
  "INSULAR|CLOSED INSULAR|SCRIPT|SIGMOID|BARRED|ANGLICANA|OLD POLISH|BROKEN|STIRRUP|SMALL";
const NAMED_FORM = new RegExp(
  `^LATIN (?:SMALL|CAPITAL) LETTER (?:(?:${FORMS}) )?([A-Z])(?: WITH .+)?$`,
);

/**
 * The Latin letter a Latin letter's name says it is drawn as: a letter "WITH" a stroke, hook, curl
 * or tail, a form of it (`FORMS`), a small capital and an archaic epigraphic letter are drawn as
 * that letter ("LATIN SMALL LETTER D WITH CURL" is d, "LATIN SMALL LETTER INSULAR R" is r, "LATIN
 * LETTER SMALL CAPITAL F" is f); any other name says nothing.
 */
function namedAs(name: string): string | null {
  const letter =
    NAMED_FORM.exec(name)?.[1] ??
    /^LATIN LETTER SMALL CAPITAL ([A-Z])(?: WITH .+)?$/.exec(name)?.[1] ??
    /^LATIN EPIGRAPHIC LETTER ARCHAIC ([A-Z])$/.exec(name)?.[1];
  return letter === undefined ? null : letter.toLowerCase();
}

const known = ENTRIES.filter((e) => !UNASSIGNED.test(e.source) && !UNASSIGNED.test(e.prototype));
// The characters Unicode's confusables data draws, or draws others as: the data decides them.
const DRAWN_BY_ENTRY = new Set(known.map((e) => e.source));
// The characters letters are drawn as, each a member of its class, with the Latin letters the
// letters drawn as it read as.
const LETTER_PROTOTYPES = new Map<string, Set<string>>();
for (const e of known) {
  if ([...e.prototype].length !== 1 || !isLetter(e.source) || isModifierLetter(e.source)) continue;
  const readings = LETTER_PROTOTYPES.get(e.prototype) ?? new Set<string>();
  const reading = latinOf(e.source);
  if (reading !== "") readings.add(reading);
  LETTER_PROTOTYPES.set(e.prototype, readings);
}
// The letters a name decides: named for a Latin letter, not drawn by an entry, and not one letters
// are drawn as that read otherwise (ε, є and ɛ are drawn as ꞓ, "C WITH BAR", and read e).
const NAMED = new Map(
  LETTERS.flatMap(({ char, name }) => {
    const as = namedAs(name);
    if (as === null || UNASSIGNED.test(char) || DRAWN_BY_ENTRY.has(char)) return [];
    const members = [...(LETTER_PROTOTYPES.get(char) ?? [])];
    if (members.some((reading) => reading !== as.replace("l", "i"))) return [];
    return [[char, as] as const];
  }),
);

describe("Unicode's confusables data (UTS #39)", () => {
  it("holds the file this runtime reads, and keeps later characters for a later runtime", () => {
    expect(ENTRIES.length).toBeGreaterThan(6600);
    expect(known.length).toBeGreaterThan(6500);
    // Every entry left out here is a character this runtime's Unicode does not yet assign.
    for (const e of ENTRIES) {
      if (!known.includes(e)) {
        expect(UNASSIGNED.test(e.source) || UNASSIGNED.test(e.prototype), e.label).toBe(true);
      }
    }
  });

  it("holds each source once, none of them ASCII or a character that draws as nothing", () => {
    const seen = new Set<string>();
    for (const e of ENTRIES) {
      expect(seen.has(e.source), e.label).toBe(false);
      seen.add(e.source);
      expect(isAscii(e.source), e.label).toBe(false);
      if (!UNASSIGNED.test(e.source)) expect(hasInvisible(e.source), e.label).toBe(false);
    }
    // A prototype is drawn as itself: it is never another entry's source.
    for (const e of ENTRIES) {
      if ([...e.prototype].length === 1) expect(seen.has(e.prototype), e.label).toBe(false);
    }
  });

  it("is not older than this runtime's Unicode, so no letter it knows is missing", () => {
    const major = (version: string) => Number.parseInt(version.split(".")[0] ?? "", 10);
    const runtime = major(process.versions.unicode ?? "");
    expect(Number.isSafeInteger(runtime)).toBe(true);
    // A newer runtime knows letters the data does not: refresh it and the derived rows.
    expect(runtime).toBeLessThanOrEqual(major(CONFUSABLES_VERSION));
    expect(UNICODE_LOOK_ALIKES.version).toBe(CONFUSABLES_VERSION);
    expect(LATIN_LETTERS_VERSION).toBe(CONFUSABLES_VERSION);
  });

  it("reads every letter, digit, sign, symbol and mark as its prototype is drawn", () => {
    const wrong: string[] = [];
    for (const e of known) {
      const glyphs = read(e.source);
      // A modifier letter drawn as punctuation may always be passed over, as punctuation is,
      // whatever folding turns it into (the letter it folds to may be read as well): every glyph
      // it reads as is optional. One drawn as a letter is held to its prototype below.
      if (isModifierLetter(e.source) && drawnAsPunctuation(e.prototype)) {
        if (glyphs.some((g) => !g.optional)) wrong.push(`${e.label}: read as ${tokens(glyphs)}`);
        continue;
      }
      // Folding decides what it folds to ASCII.
      if (foldedToAscii(e.source)) continue;
      if (drawnAsPunctuation(e.prototype)) {
        // A letter drawn as punctuation never counts as a letter of no Latin reading.
        if (glyphs.some((g) => g.reads === null && !g.optional)) wrong.push(e.label);
        continue;
      }
      const letter = isLetter(e.source);
      const want = drawn(e.prototype);
      // A digit, sign, symbol or mark drawn as a letter of no Latin reading is passed over.
      if (!letter && want.includes("?")) continue;
      if (!agrees(tokens(glyphs), want)) wrong.push(`${e.label}: ${tokens(glyphs)} for ${want}`);
      // A digit, sign, symbol or mark folding leaves as it is only stands for letters; what one
      // folds to ("℃" to "°C") reads as it is.
      if (!letter && !folds(e.source) && glyphs.some((g) => !g.optional)) {
        wrong.push(`${e.label}: not optional`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("holds a row for each modifier letter drawn as punctuation that folds to a letter", () => {
    // The data's: each modifier letter drawn as punctuation that folding turns into one letter.
    const foldsToLetter = (char: string) => {
      const folding = char.normalize("NFKD");
      return isLetter(folding) && !isModifierLetter(folding);
    };
    const asked = known
      .filter((e) => isModifierLetter(e.source) && drawnAsPunctuation(e.prototype))
      .filter((e) => foldsToLetter(e.source))
      .map((e) => hex(`${e.source}${e.prototype}`));
    const rows = UNICODE_LOOK_ALIKES.punctuationModifiers.join(" ").split(" ");
    expect(rows.map(hex).sort()).toEqual(asked.sort());
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [char = "", ...drawnAs] = [...row];
      // Its punctuation stands for no letter, so passing it over reads it as it is drawn.
      expect(read(drawnAs.join("")), hex(row)).toEqual([]);
      // Otherwise it reads as the letter it folds to reads, a glyph that may be passed over.
      const glyphs = read(char);
      const letter = read(char.normalize("NFKD"));
      expect(glyphs.length, hex(row)).toBeGreaterThan(0);
      expect(
        glyphs.every((g) => g.optional),
        hex(row),
      ).toBe(true);
      expect(
        letter.every((g) => !g.optional),
        hex(row),
      ).toBe(true);
      expect(
        glyphs.map((g) => ({ ...g, optional: false })),
        hex(row),
      ).toEqual(letter);
    }
  });

  it("reads the members of each of Unicode's classes as the same Latin letters", () => {
    const classes = new Map<string, Entry[]>();
    for (const e of known) classes.set(e.prototype, [...(classes.get(e.prototype) ?? []), e]);
    const wrong: string[] = [];
    for (const [prototype, entries] of classes) {
      const asciiPrototype = isAscii(withoutMarks(prototype));
      // The prototype is a member when it is read: ASCII, accents aside, or a letter.
      const member =
        asciiPrototype || [...prototype].some((c) => isLetter(c) && !isModifierLetter(c));
      const members = member ? [prototype] : [];
      for (const e of entries) {
        if (foldedToAscii(e.source) || isModifierLetter(e.source)) continue;
        // A digit, sign, symbol or mark stands only for an ASCII prototype's letters.
        if (!isLetter(e.source) && !asciiPrototype) continue;
        members.push(e.source);
      }
      const readings = members.map(latinOf);
      if (readings.some((r) => r !== "") && new Set(readings).size > 1) {
        wrong.push(members.map((m, i) => `${hex(m)} "${readings[i]}"`).join(", "));
      }
    }
    expect(wrong).toEqual([]);
  });

  it("reads a capital as its small letter only where Unicode draws it so", () => {
    const wrong: string[] = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const capital = String.fromCodePoint(cp);
      if (!/^[\p{Lu}\p{Lt}]$/u.test(capital) || folds(capital)) continue;
      const reading = latinOf(capital);
      if (reading === "") continue;
      // Its own entry draws it (and the tests above hold it to its prototype), it has a row of its
      // own, it is a capital prototype drawn as its small letter, or its name says the letter.
      if (DRAWN_BY_ENTRY.has(capital) || OWN_CAPITALS.has(capital)) continue;
      if (CAPITAL_PROTOTYPES.has(capital)) continue;
      if (NAMED.get(capital)?.replace("l", "i") === reading) continue;
      wrong.push(`${hex(capital)} reads "${reading}"`);
    }
    expect(wrong).toEqual([]);
  });

  it("derives no row the data does not ask for", () => {
    // A small letter's row may come from its capital's entry (Cyrillic ь reads as Ь does).
    const capitals = new Set(known.map((e) => e.source.toLowerCase()));
    const stray = [
      ...keysOf(...UNICODE_LOOK_ALIKES.beforeFolding).filter((k) => !DRAWN_BY_ENTRY.has(k)),
      ...keysOf(...UNICODE_LOOK_ALIKES.capitals).filter(
        (k) => !DRAWN_BY_ENTRY.has(k) && !NAMED.has(k),
      ),
      ...keysOf(...UNICODE_LOOK_ALIKES.signs).filter((k) => !DRAWN_BY_ENTRY.has(k)),
      ...keysOf(...UNICODE_LOOK_ALIKES.letters).filter(
        (k) => !DRAWN_BY_ENTRY.has(k) && !LETTER_PROTOTYPES.has(k) && !capitals.has(k),
      ),
      // A row from a name only for a letter the name decides.
      ...keysOf(...UNICODE_LOOK_ALIKES.named).filter((k) => !NAMED.has(k)),
      // A capital read as no Latin letter only where its small letter reads as one.
      ...UNLIKE_CAPITALS.filter(
        (k) => k.toLowerCase() === k || latinOf(k.toLowerCase()) === "" || latinOf(k) !== "",
      ),
    ];
    expect(stray.map(hex)).toEqual([]);
  });

  it("holds each derived row once, as one character and what it is drawn as", () => {
    const handMade = new Set(keysOf(...LOOK_ALIKE_ROWS));
    const everyRow = new Set<string>();
    for (const [name, rows] of Object.entries({
      beforeFolding: UNICODE_LOOK_ALIKES.beforeFolding,
      capitals: UNICODE_LOOK_ALIKES.capitals,
      letters: UNICODE_LOOK_ALIKES.letters,
      named: UNICODE_LOOK_ALIKES.named,
      punctuationModifiers: UNICODE_LOOK_ALIKES.punctuationModifiers,
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
        // What a sign stands for, and what a name says, is Latin letters only.
        if (name === "signs" || name === "named") expect(reads.join(""), what).toMatch(/^[a-z]+$/);
        // A letter is read before lower-casing only as a capital, and after it only as a letter
        // lower-casing leaves as it is.
        if (name === "letters" || name === "named") expect(char.toLowerCase(), what).toBe(char);
        if (name === "letters" || name === "named") {
          expect(everyRow.has(char), `${what} is also a letter row`).toBe(false);
          everyRow.add(char);
        }
      }
    }
    for (const char of UNLIKE_CAPITALS) {
      expect(OWN_CAPITALS.has(char), `${hex(char)} is also a capital row`).toBe(false);
      expect(char.toLowerCase(), hex(char)).not.toBe(char);
    }
    expect(new Set(UNLIKE_CAPITALS).size).toBe(UNLIKE_CAPITALS.length);
  });
});

describe("Unicode's names for the Latin letters", () => {
  it("holds every Latin letter this runtime knows that folding leaves as it is", () => {
    const held = new Set(LETTERS.map((l) => l.char));
    const missing: string[] = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      if (!/^\p{Script=Latin}$/u.test(char) || !isLetter(char) || isModifierLetter(char)) continue;
      if (!folds(char) && !held.has(char)) missing.push(hex(char));
    }
    expect(missing).toEqual([]);
    for (const { char, name } of LETTERS) {
      expect(name, hex(char)).toMatch(/^[A-Z][A-Z0-9 -]+$/);
      if (!UNASSIGNED.test(char)) expect(folds(char), name).toBe(false);
    }
  });

  it("reads a letter named for a Latin letter with a stroke, hook or curl, or a small capital, as it", () => {
    const wrong: string[] = [];
    for (const [char, as] of NAMED) {
      if (latinOf(char) !== as.replace("l", "i"))
        wrong.push(`${hex(char)} reads "${latinOf(char)}"`);
    }
    expect(wrong).toEqual([]);
    expect(NAMED.get("\u{221}")).toBe("d"); // LATIN SMALL LETTER D WITH CURL
    expect(NAMED.get("\u{a730}")).toBe("f"); // LATIN LETTER SMALL CAPITAL F
    expect(NAMED.has("\u{250}")).toBe(false); // LATIN SMALL LETTER TURNED A says nothing
    expect(NAMED.has("\u{a793}")).toBe(false); // C WITH BAR: Unicode's data draws ε as it
  });
});
