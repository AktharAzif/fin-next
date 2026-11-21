// Rule 5 of spec 07 §2.8 (S7-17): a finding's free text (title, claim, scenario, testShouldFail) is
// scanned for text addressed to a reviewer or a model, with the patterns of
// docs/review/injection-patterns.json. A match replaces that field with a fixed placeholder and
// marks the finding `injectionSuspect`; the finding itself stays, with its paths, lines and quotes.
// Applied before a sceptic, a second look, a later lens (a prior blocker) or a person sees the
// finding, and to a refutation's reason before a second look sees it.

import { isJsonObject } from "../json.ts";

export const WITHHELD = "[withheld: text addressed to a reviewer]";
export const FREE_TEXT_FIELDS = ["title", "claim", "scenario", "testShouldFail"] as const;
const MAX_PATTERN_LENGTH = 300;

/** Validates injection-patterns.json; each problem is pushed onto `problems`. */
export function parseInjectionPatterns(value: unknown, problems: string[]): RegExp[] {
  const out: RegExp[] = [];
  if (!isJsonObject(value)) {
    if (value !== undefined) problems.push("injection-patterns.json must be an object");
    return out;
  }
  for (const key of Object.keys(value)) if (!["version", "note", "patterns"].includes(key)) problems.push(`injection-patterns.json has unknown key ${JSON.stringify(key)}`);
  if (value["version"] !== 1) problems.push("injection-patterns.json version must be 1");
  const patterns = value["patterns"];
  if (!Array.isArray(patterns) || patterns.length === 0) {
    problems.push("injection-patterns.json patterns must be a non-empty array");
    return out;
  }
  patterns.forEach((pattern, index) => {
    if (typeof pattern !== "string" || pattern === "" || pattern.length > MAX_PATTERN_LENGTH) {
      problems.push(`injection-patterns.json patterns[${index}] must be a string of 1 to ${MAX_PATTERN_LENGTH} characters`);
      return;
    }
    try {
      out.push(new RegExp(pattern, "iu"));
    } catch {
      problems.push(`injection-patterns.json patterns[${index}] is not a regular expression`);
    }
  });
  return out;
}

/** True when `text` holds a phrase addressed to a reviewer or a model. */
export function addressesReviewer(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** `text`, or the placeholder when it addresses a reviewer or a model. */
export function filterText(text: string, patterns: readonly RegExp[]): string {
  return addressesReviewer(text, patterns) ? WITHHELD : text;
}

/**
 * A copy of a finding (or of any candidate object) with each free-text field that addresses a
 * reviewer replaced by the placeholder, and `injectionSuspect: true` when any was. A value that is
 * not an object is returned as it is.
 */
export function filterFreeText<T>(finding: T, patterns: readonly RegExp[]): { finding: T; suspect: boolean } {
  if (!isJsonObject(finding)) return { finding, suspect: false };
  const copy: Record<string, unknown> = { ...finding };
  let suspect = false;
  for (const field of FREE_TEXT_FIELDS) {
    const text = copy[field];
    if (typeof text === "string" && addressesReviewer(text, patterns)) {
      copy[field] = WITHHELD;
      suspect = true;
    }
  }
  if (suspect) copy["injectionSuspect"] = true;
  return { finding: copy as T, suspect };
}
