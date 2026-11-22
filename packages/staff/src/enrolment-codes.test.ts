// T-SAT-12 (spec 02 §6.5, [SA-29]): the enrolment code's format, its normalisation and its hash.
import { createHash } from "node:crypto";
import { HIDDEN_VALUE, param } from "@fin/email";
import { describe, expect, it } from "vitest";
import {
  CROCKFORD,
  generateEnrolmentCode,
  hashEnrolmentCode,
  normaliseEnrolmentCode,
} from "./enrolment-codes.ts";

describe("enrolment codes", () => {
  it("are 16 Crockford base32 characters in four groups of four", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateEnrolmentCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
      for (const char of code.replace(/-/g, "")) expect(CROCKFORD).toContain(char);
    }
  });

  it("carry 80 random bits: a thousand codes never repeat and use the whole alphabet", () => {
    const codes = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const code = generateEnrolmentCode();
      codes.add(code);
      for (const char of code.replace(/-/g, "")) chars.add(char);
    }
    expect(codes.size).toBe(1000);
    expect(chars.size).toBe(32);
  });

  // A code with no group of four mixing a letter and a digit (about one plain draw in 340) is also
  // an ordinary name's shape, which the email's name fields show; every code Fin Admin issues has
  // such a group, so one passed into a name by mistake is hidden in every form (SA-29, T08-23).
  // Heavy by design: 20,000 codes in four forms through three name fields, 240,000 parses, already
  // checked in plain code. About 0.25 s alone; it took up to 4.7 s inside a loaded `pnpm check`,
  // so it has 20.
  it("always have a group mixing a letter and a digit, so every name field hides them", () => {
    const codes = Array.from({ length: 20_000 }, generateEnrolmentCode);
    const unmixed = codes.filter(
      (code) => !code.split("-").some((group) => /\d/.test(group) && /[A-Z]/.test(group)),
    );
    expect(unmixed).toEqual([]);
    const shown: string[] = [];
    for (const code of codes) {
      const groups = code.split("-");
      for (const form of [code, groups.join(" "), groups.join(""), code.toLowerCase()]) {
        for (const field of ["personName", "orgName", "roleLabel"] as const) {
          if (param[field].parse(form) !== HIDDEN_VALUE) shown.push(`${field}: ${form}`);
        }
      }
    }
    expect(shown).toEqual([]);
  }, 20_000);

  it("read as typed: any case, spaces and hyphens, I and L as 1, O as 0", () => {
    const code = "AB1C-DE0F-GH2J-KM3N";
    expect(normaliseEnrolmentCode(code)).toBe("AB1CDE0FGH2JKM3N");
    expect(normaliseEnrolmentCode("ab1c de0f gh2j km3n")).toBe("AB1CDE0FGH2JKM3N");
    expect(normaliseEnrolmentCode("ABlC-DEOF-GH2J-KM3N")).toBe("AB1CDE0FGH2JKM3N");
    expect(normaliseEnrolmentCode("ABIC-DEOF-GH2J-KM3N")).toBe("AB1CDE0FGH2JKM3N");
    for (const bad of [
      "",
      "AB1C-DE0F-GH2J",
      "AB1C-DE0F-GH2J-KM3N-P",
      "AB1C-DE0F-GH2J-KM3U",
      "AB1C/DE0F/GH2J/KM3N",
    ]) {
      expect(normaliseEnrolmentCode(bad), bad).toBeNull();
    }
  });

  it("are stored as the SHA-256 of the normalised code, which the operator's half computes too", () => {
    const code = generateEnrolmentCode();
    const expected = createHash("sha256").update(code.replace(/-/g, ""), "utf8").digest();
    expect(hashEnrolmentCode(code).equals(expected)).toBe(true);
    expect(hashEnrolmentCode(code.toLowerCase()).equals(expected)).toBe(true);
    expect(hashEnrolmentCode(code)).toHaveLength(32);
    expect(() => hashEnrolmentCode("not a code")).toThrow(TypeError);
  });
});
