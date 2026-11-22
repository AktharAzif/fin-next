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
