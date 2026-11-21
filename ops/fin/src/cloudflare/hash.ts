// The configuration hashes a registered run records for the watcher (spec 01 §7.11): one per rule
// set phase (`rulesetHashes`) and one for the Access application's policies (`accessPolicyHash`).
// The watcher recomputes them every minute and alerts on any difference, so these functions must
// give exactly what `ops/watcher/src/hash.ts` gives: the same picked fields, the same canonical
// JSON (keys sorted at every depth, undefined keys dropped, undefined as null) and SHA-256 in hex.
// ops/fin cannot import the watcher (Node built-ins and relative imports only, and the watcher is
// Web APIs only), so the test pins both to the same vectors.
//
// A phase's recorded hash covers fin-next's own rules only, those whose ref starts `fin_next_`
// (spec 01 §7.6, BD-11): the shared zone also holds the other product's rules ([FD-09]), whose
// changes must neither raise fin-next's alert nor hide a change to fin-next's. That is the
// watcher's `finRulesetHash`.
//
// The hashes go only into the private run record (run.done in the run log), never to stdout or
// stderr: a hash whose only unknown input is a private value (a rate threshold, a staff address)
// can be brute-forced offline from a public job log.

import { createHash } from "node:crypto";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const RULE_FIELDS = [
  "ref",
  "description",
  "expression",
  "action",
  "action_parameters",
  "enabled",
  "ratelimit",
] as const;

/** The hash of the given rules, in order, whoever owns them. An absent entrypoint hashes as []. */
export function rulesetHash(rules: readonly unknown[]): string {
  const picked = rules.map((rule) => {
    const r = isRecord(rule) ? rule : {};
    return Object.fromEntries(RULE_FIELDS.filter((f) => r[f] !== undefined).map((f) => [f, r[f]]));
  });
  return sha256Hex(canonicalJson(picked));
}

/** Every rule fin-next writes carries a ref with this prefix (BD-11). */
export const FIN_RULE_PREFIX = "fin_next_";

/** Whether a rule is one of fin-next's own (its ref starts `fin_next_`). */
export function isFinRule(rule: unknown): boolean {
  return isRecord(rule) && typeof rule.ref === "string" && rule.ref.startsWith(FIN_RULE_PREFIX);
}

/** The hash `zone apply` records and the watcher compares: fin-next's own rules of a phase. */
export function finRulesetHash(rules: readonly unknown[]): string {
  return rulesetHash(rules.filter(isFinRule));
}

const POLICY_FIELDS = [
  "name",
  "decision",
  "include",
  "exclude",
  "require",
  "precedence",
  "session_duration",
  "isolation_required",
  "approval_required",
  "purpose_justification_required",
  "mfa_config",
] as const;

/** The hash of an Access application's policies, ordered by precedence, then name. */
export function accessPolicyHash(policies: readonly unknown[]): string {
  const picked = policies
    .map((policy) => {
      const p = isRecord(policy) ? policy : {};
      return Object.fromEntries(
        POLICY_FIELDS.filter((f) => p[f] !== undefined).map((f) => [f, p[f]]),
      );
    })
    .sort((a, b) => {
      const pa = Number(a.precedence ?? 0);
      const pb = Number(b.precedence ?? 0);
      return pa !== pb ? pa - pb : String(a.name ?? "").localeCompare(String(b.name ?? ""));
    });
  return sha256Hex(canonicalJson(picked));
}
