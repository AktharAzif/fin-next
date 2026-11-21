// The order a name is drawn in (src/engine/drawn-order.ts): which characters are written right to
// left, held to this runtime's scripts, and how a line reorders them.
import { describe, expect, it } from "vitest";
import { CONFUSABLES_VERSION } from "../test-support/confusables.ts";
import { drawnOrder, isRightToLeft, RIGHT_TO_LEFT_VERSION } from "./drawn-order.ts";

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

describe("which characters are written right to left", () => {
  it("is every letter of a right-to-left script, and no other letter", () => {
    const wrong: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      if (!/^\p{L}$/u.test(char)) continue;
      if (isRightToLeft(char) !== RIGHT_TO_LEFT_LETTER.test(char)) wrong.push(hex(char));
    }
    expect(wrong).toEqual([]);
  });

  it("knows the digits, signs and marks of right-to-left scripts", () => {
    expect(isRightToLeft("\u{7c0}")).toBe(true); // NKO DIGIT ZERO
    expect(isRightToLeft("\u{5be}")).toBe(true); // HEBREW PUNCTUATION MAQAF
    expect(isRightToLeft("\u{660}")).toBe(false); // ARABIC-INDIC DIGIT ZERO, a number
    expect(isRightToLeft("0")).toBe(false);
    expect(isRightToLeft("-")).toBe(false);
  });

  it("is read from Unicode's data of the version the look-alike rows are", () => {
    expect(RIGHT_TO_LEFT_VERSION).toBe(CONFUSABLES_VERSION);
  });
});

describe("the order a text is drawn in", () => {
  // Arabic heh (drawn as o), N'Ko ta (drawn as t), Arabic alef (drawn as l) and Hebrew tet (drawn
  // as v), and other right-to-left letters.
  const heh = "\u{647}";
  const ta = "\u{7e0}";
  const alef = "\u{627}";
  const tet = "\u{5d8}";
  const beh = "\u{628}";

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

  it("keeps every character", () => {
    const text = `Pa${heh}\u{64e}${ta} 12 ${alef}!b`;
    for (const line of ["ltr", "rtl"] as const) {
      expect([...drawnOrder(text, line)].sort()).toEqual([...text].sort());
    }
  });
});
