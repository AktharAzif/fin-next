// T-SAT-10: §8.6's rules, each refusal, and the one sentence a refusal answers.
import { describe, expect, it } from "vitest";
import { checkName, NAME_RULES } from "./names.ts";

const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const CYRILLIC_I = String.fromCodePoint(0x0456);
const GREEK_NU = String.fromCodePoint(0x03bd);

describe("checkName", () => {
  it.each([
    ["Ada Lovelace"],
    ["José María Núñez"],
    ["O'Brien-Smith"],
    ["Zoë & Co."],
    ["Иван Петров"],
    ["山田 太郎"],
    ["Fin"],
    ["FIN Team"],
  ])("accepts %s", (name) => {
    expect(checkName("personName", name)).toEqual({ ok: true, value: name });
  });

  it("trims, collapses spaces and normalises to NFC", () => {
    const decomposed = "José"; // e + combining acute
    const result = checkName("personName", `  ${decomposed}   Smith  `);
    expect(result).toEqual({ ok: true, value: "José Smith" });
  });

  it.each([
    ["empty", "   "],
    ["too_long", "a".repeat(61)],
    ["too_many_words", "one two three four five six seven eight nine"],
    ["invisible", `Ada${ZWSP}Lovelace`],
    ["invisible", `Ada ${RLO}ecalevol`],
    ["characters", "Ada <script>"],
    ["web_address", "see example.com"],
    ["web_address", "https://example.org"],
    ["web_address", "www.example"],
    ["digits", "Call 0123456789"],
    ["digits", "Call 012-345-6789"],
    ["mixed_scripts", `Ad${String.fromCodePoint(0x0430)} Lovelace`],
    ["fin_lookalike", "F1n"],
    ["fin_lookalike", "Fín"],
    ["mixed_scripts", `Fi${GREEK_NU}`],
  ])("refuses %s: %s", (reason, name) => {
    const result = checkName("personName", name);
    expect(result).toMatchObject({ ok: false, reason, sentence: NAME_RULES.personName.sentence });
  });

  it("refuses Fin in letters from another script", () => {
    expect(checkName("organisationName", `F${CYRILLIC_I}n`)).toMatchObject({ ok: false });
  });

  it("uses each field's limits", () => {
    expect(checkName("organisationName", "a".repeat(50)).ok).toBe(true);
    expect(checkName("organisationName", "a".repeat(51)).ok).toBe(false);
    expect(checkName("organisationName", "a b c d e f g h")).toMatchObject({
      reason: "too_many_words",
    });
    expect(checkName("roleName", "a".repeat(41)).ok).toBe(false);
    expect(checkName("roleName", "one two three four five six")).toMatchObject({
      reason: "too_many_words",
    });
    expect(checkName("roleDescription", "")).toEqual({ ok: true, value: "" });
    expect(checkName("roleDescription", "word ".repeat(30).trim()).ok).toBe(false);
  });

  it("never echoes the refused value in its answer", () => {
    const result = checkName("personName", "visit example.com now");
    expect(JSON.stringify(result)).not.toContain("example.com");
  });
});

// A Latin modifier letter drawn as punctuation is, in a role name, the punctuation it is drawn as
// (spec 02 §8.4, the steward's ruling on F2.4): refused unless that is simple punctuation, in the
// one rule both realms' custom roles are checked by. One drawn as a raised letter stays a letter.
describe("modifier letters in a role name", () => {
  it.each([
    ["Admin\u{1dba}", "U+1DBA MODIFIER LETTER SMALL TURNED V, drawn as ^"],
    ["Admin\u{2e4}", "U+02E4 MODIFIER LETTER SMALL REVERSED GLOTTAL STOP, drawn as U+02C1"],
    ["Super\u{1dba}admin", "U+1DBA between the words"],
    ["Admin\u{2c1}", "U+02C1 MODIFIER LETTER REVERSED GLOTTAL STOP, which folding leaves"],
    ["Admin\u{1d52}", "U+1D52 MODIFIER LETTER SMALL O, drawn as the degree sign"],
    ["Admin\u{2c6}", "U+02C6 MODIFIER LETTER CIRCUMFLEX ACCENT, drawn as ^"],
    ["Admin\u{2d1}", "U+02D1 MODIFIER LETTER HALF TRIANGULAR COLON, drawn as a middle dot"],
    ["Admin\u{a71d}", "U+A71D MODIFIER LETTER RAISED EXCLAMATION MARK"],
    ["Admin\u{10782}", "U+10782, which folds to U+02D1"],
  ])("refuses %j: %s", (name) => {
    expect(checkName("roleName", name)).toMatchObject({
      ok: false,
      reason: "characters",
      sentence: NAME_RULES.roleName.sentence,
    });
  });

  it.each([
    ["Hawai\u{2bb}i support", "U+02BB MODIFIER LETTER TURNED COMMA, drawn as an apostrophe"],
    ["Partner\u{2bc}s desk", "U+02BC MODIFIER LETTER APOSTROPHE"],
    ["Tier\u{2d0} one", "U+02D0 MODIFIER LETTER TRIANGULAR COLON, drawn as a colon"],
    ["Tier\u{10781} one", "U+10781, which folds to U+02D0"],
    // MODIFIER LETTER SMALL H, J, R, W, Y, L, S and X, CAPITAL A and B: raised letters.
    ["\u{2b0}\u{2b2}\u{2b3}\u{2b7}\u{2b8}\u{2e1}\u{2e2}\u{2e3}\u{1d2c}\u{1d2e}", "raised letters"],
    ["Admin\u{2b0}", "U+02B0 MODIFIER LETTER SMALL H, a raised letter"],
    ["\u{30de}\u{30cd}\u{30fc}\u{30b8}\u{30e3}\u{30fc}", "kana's long-vowel mark, not Latin"],
  ])("accepts %j: %s", (name) => {
    expect(checkName("roleName", name)).toEqual({ ok: true, value: name });
  });

  it("leaves them as they were in a person's name", () => {
    expect(checkName("personName", "Sa\u{2bf}id")).toEqual({ ok: true, value: "Sa\u{2bf}id" });
  });
});
