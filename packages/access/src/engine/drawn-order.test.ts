// The order a name is drawn in (src/engine/drawn-order.ts): each character's bidirectional class,
// held to this runtime's scripts, and how a line orders the characters, held to Unicode's
// conformance tests for the bidirectional algorithm (src/test-support/bidi-cases.ts).
import { describe, expect, it } from "vitest";
import { BIDI_TEST_VERSION, CHARACTER_CASES, CLASS_CASES } from "../test-support/bidi-cases.ts";
import { CONFUSABLES_VERSION } from "../test-support/confusables.ts";
import {
  BIDI_VERSION,
  type BidiClass,
  bidiClassOf,
  drawnOrder,
  levelsOf,
  reorder,
} from "./drawn-order.ts";

// The scripts written right to left: every letter of these, and of no other script, is (but the
// Arabic tatweel, a letter every script shares that joins Arabic letters).
const RIGHT_TO_LEFT_SCRIPTS = [
  "Adlam",
  "Arabic",
  "Avestan",
  "Chorasmian",
  "Cypriot",
  "Elymaic",
  "Garay",
  "Hanifi_Rohingya",
  "Hatran",
  "Hebrew",
  "Imperial_Aramaic",
  "Inscriptional_Pahlavi",
  "Inscriptional_Parthian",
  "Kharoshthi",
  "Lydian",
  "Mandaic",
  "Manichaean",
  "Mende_Kikakui",
  "Meroitic_Cursive",
  "Meroitic_Hieroglyphs",
  "Nabataean",
  "Nko",
  "Old_Hungarian",
  "Old_North_Arabian",
  "Old_Sogdian",
  "Old_South_Arabian",
  "Old_Turkic",
  "Old_Uyghur",
  "Palmyrene",
  "Phoenician",
  "Psalter_Pahlavi",
  "Samaritan",
  "Sidetic",
  "Sogdian",
  "Syriac",
  "Thaana",
  "Yezidi",
];
const RIGHT_TO_LEFT_LETTER = new RegExp(
  `^(?:${RIGHT_TO_LEFT_SCRIPTS.map((s) => `\\p{Script=${s}}`).join("|")}|\\u{640})$`,
  "u",
);

const hex = (char: string) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`;

/** Every character this runtime assigns that matches `pattern`. */
function everyChar(pattern: RegExp): string[] {
  const chars: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const char = String.fromCodePoint(cp);
    if (pattern.test(char)) chars.push(char);
  }
  return chars;
}

describe("each character's bidirectional class", () => {
  it("is right to left for every letter of a right-to-left script, and no other letter", () => {
    const wrong = everyChar(/^\p{L}$/u).filter((char) => {
      const rightToLeft = ["R", "AL"].includes(bidiClassOf(char));
      return rightToLeft !== RIGHT_TO_LEFT_LETTER.test(char);
    });
    expect(wrong.map(hex)).toEqual([]);
  });

  it("is a number's for every decimal digit, and a European one's for no letter", () => {
    const digits = new Set<BidiClass>(["EN", "AN", "R", "L"]);
    expect(everyChar(/^\p{Nd}$/u).filter((char) => !digits.has(bidiClassOf(char)))).toEqual([]);
    const numbers = new Set<BidiClass>(["EN", "AN", "ES", "ET", "CS"]);
    expect(everyChar(/^\p{L}$/u).filter((char) => numbers.has(bidiClassOf(char)))).toEqual([]);
  });

  it("is a nonspacing mark's only for marks drawn on another character, and never a spacing one", () => {
    expect(everyChar(/^\p{Mc}$/u).filter((char) => bidiClassOf(char) === "NSM")).toEqual([]);
    expect(everyChar(/^\p{L}$/u).filter((char) => bidiClassOf(char) === "NSM")).toEqual([]);
  });

  it.each([
    ["a Latin letter", "a", "L"],
    ["a Hebrew letter", "\u{5d0}", "R"],
    ["an N'Ko digit, written right to left", "\u{7c0}", "R"],
    ["an Arabic letter", "\u{627}", "AL"],
    ["a European digit", "7", "EN"],
    ["an Extended Arabic-Indic digit, a European number", "\u{6f5}", "EN"],
    ["an Arabic-Indic digit, an Arabic number", "\u{665}", "AN"],
    ["a plus, a European separator", "+", "ES"],
    ["a currency sign, a European terminator", "\u{20ac}", "ET"],
    ["a per mille sign, a European terminator", "\u{2030}", "ET"],
    ["a full stop, a common separator", ".", "CS"],
    ["a colon, a common separator", ":", "CS"],
    ["a nonspacing mark", "\u{301}", "NSM"],
    ["a spacing mark, left to right", "\u{903}", "L"],
    ["the Sinhala anusvara, a spacing mark", "\u{d82}", "L"],
    ["a space", " ", "WS"],
    ["an exclamation mark", "!", "ON"],
    ["a soft hyphen, a boundary neutral", "\u{ad}", "BN"],
    ["a right-to-left isolate", "\u{2067}", "RLI"],
  ] as const)("is right for %s", (_what, char, type) => {
    expect(bidiClassOf(char)).toBe(type);
  });

  it("is read from Unicode's data of the version the look-alike rows are", () => {
    expect(BIDI_VERSION).toBe(CONFUSABLES_VERSION);
    expect(BIDI_TEST_VERSION).toBe(CONFUSABLES_VERSION);
  });
});

// A character of each class, for the class cases.
const OF_CLASS: Readonly<Record<string, string>> = {
  l: "a",
  r: "\u{5d0}",
  a: "\u{627}",
  e: "1",
  s: "+",
  t: "$",
  n: "\u{661}",
  c: ",",
  m: "\u{300}",
  w: " ",
  o: "!",
};

describe("Unicode's conformance tests (UAX #9)", () => {
  it("resolves every class case's levels as BidiTest.txt does", () => {
    const wrong: string[] = [];
    let cases = 0;
    for (const row of CLASS_CASES) {
      const [head = "", list = ""] = row.split(":");
      const line = head[0] === "l" ? "ltr" : "rtl";
      const want = [...head.slice(1)].map(Number);
      for (const sequence of list.split(" ")) {
        cases++;
        const text = [...sequence].map((type) => OF_CLASS[type]).join("");
        const levels = levelsOf(text, line);
        if (levels.join(" ") !== want.join(" ")) wrong.push(`${line} ${sequence}: ${levels}`);
      }
    }
    expect(cases).toBe(2926);
    expect(wrong).toEqual([]);
  });

  it("resolves every character case's levels and order as BidiCharacterTest.txt does", () => {
    const wrong: string[] = [];
    for (const row of CHARACTER_CASES) {
      const [points = "", direction = "", paragraph = "", levels = "", order = ""] = row.split(";");
      const text = points
        .split(" ")
        .map((point) => String.fromCodePoint(Number.parseInt(point, 16)))
        .join("");
      const ltr = direction === "0" || (direction === "2" && paragraph === "0");
      const resolved = levelsOf(text, ltr ? "ltr" : "rtl");
      const kept = resolved.flatMap((level, i) => (level === null ? [] : [{ level, i }]));
      const drawn = reorder(kept.map(({ level }) => level)).map((k) => kept[k]?.i);
      const got = `${resolved.map((level) => level ?? "x").join(" ")};${drawn.join(" ")}`;
      if (got !== `${levels};${order}`) wrong.push(`${row} -> ${got}`);
    }
    expect(CHARACTER_CASES).toHaveLength(129);
    expect(wrong).toEqual([]);
  });
});

describe("the order a text is drawn in", () => {
  // Arabic heh (drawn as o), N'Ko ta (drawn as t), Arabic alef (drawn as l), Hebrew tet (drawn as
  // v), Arabic-Indic digits one, five and seven (drawn as l, o and v), and other right-to-left
  // letters.
  const heh = "\u{647}";
  const ta = "\u{7e0}";
  const alef = "\u{627}";
  const tet = "\u{5d8}";
  const beh = "\u{628}";
  const one = "\u{661}";
  const five = "\u{665}";
  const seven = "\u{667}";

  it.each([
    ["left-to-right text as it is", "Admin 2!", "ltr", "Admin 2!"],
    [
      "a run of right-to-left letters reversed",
      `Administra${heh}${ta}r`,
      "ltr",
      `Administra${ta}${heh}r`,
    ],
    ["two runs, each reversed", `${alef}${tet}ewer`, "ltr", `${tet}${alef}ewer`],
    ["a final run", `Po${alef}${heh}`, "ltr", `Po${heh}${alef}`],
    ["white space inside a run, reversed with it", `a${heh} ${beh}b`, "ltr", `a${beh} ${heh}b`],
    ["white space between runs of each direction, left in place", `${heh} b`, "ltr", `${heh} b`],
    ["a mark kept on its letter", `a${heh}\u{64e}${beh}`, "ltr", `a${beh}${heh}\u{64e}`],
    ["digits in a run, in their own order", `${heh}12${beh}`, "ltr", `${beh}12${heh}`],
    ["digits after Latin letters, left to right", `a${heh}b12`, "ltr", `a${heh}b12`],
    // A separator between two digits joins them into one number (rule W4).
    ["a decimal point inside a number", `${heh}4.7`, "ltr", `4.7${heh}`],
    ["a comma inside a number", `Oper${heh}4,7r`, "ltr", `Oper4,7${heh}r`],
    ["a colon inside a number", `Oper${heh}4:7r`, "ltr", `Oper4:7${heh}r`],
    // A terminator beside a European digit belongs to its number (rule W5), unless an Arabic
    // letter before the digit makes it an Arabic number (rule W2).
    ["a currency sign before a number", `${tet}$7`, "ltr", `$7${tet}`],
    ["a currency sign before a number after an Arabic letter", `${heh}$7`, "ltr", `7$${heh}`],
    ["a currency sign after a number", `V${tet}1\u{20ac}er`, "ltr", `V1\u{20ac}${tet}er`],
    // Arabic-Indic digits are Arabic numbers, drawn right to left of a right-to-left letter
    // beside them even after Latin text, and two of them swap across a neutral.
    [
      "an Arabic number before a right-to-left letter",
      `Opera${five}${ta}r`,
      "ltr",
      `Opera${ta}${five}r`,
    ],
    ["an Arabic number at the start of a line", `${one}${tet}ewer`, "ltr", `${tet}${one}ewer`],
    ["two Arabic numbers across a space", `${one} ${seven}ewer`, "ltr", `${seven} ${one}ewer`],
    [
      "an Arabic number after a right-to-left letter",
      `Ad${one}\u{10c21}n`,
      "ltr",
      `Ad\u{10c21}${one}n`,
    ],
    // A spacing mark is written left to right: it breaks a right-to-left run.
    [
      "a spacing mark between right-to-left letters",
      `${heh}\u{903}${ta}`,
      "ltr",
      `${heh}\u{903}${ta}`,
    ],
    [
      "right-to-left letters on a right-to-left line",
      `${alef}${tet}ewer`,
      "rtl",
      `ewer${tet}${alef}`,
    ],
    ["Latin letters on a right-to-left line", "Team", "rtl", "Team"],
    ["final punctuation on a right-to-left line", "Team!", "rtl", "!Team"],
  ] as const)("%s", (_what, text, line, drawn) => {
    expect(drawnOrder(text, line)).toBe(drawn);
  });

  // Heavy by design: two million characters drawn in each direction, so that a step holding the
  // whole text on the call stack would exhaust it. That is about 1.7 s of CPU alone (2 to 3 s of
  // wall time), linear in the text, and it took 27 to 32 s inside a loaded `pnpm check`, so it has
  // a minute. A quadratic step would take hours here, and still fails.
  it("draws text of any length", () => {
    const text = `${heh}a`.repeat(1_000_000);
    expect(drawnOrder(text, "ltr")).toBe(text);
    expect(drawnOrder(text, "rtl")).toHaveLength(text.length);
  }, 60_000);

  it("keeps every character", () => {
    const text = `Pa${heh}\u{64e}${ta} 12 ${alef}!b4.7${one}\u{903}$`;
    for (const line of ["ltr", "rtl"] as const) {
      expect([...drawnOrder(text, line)].sort()).toEqual([...text].sort());
    }
  });
});
