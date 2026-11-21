// Canonical hashes of the configuration the watcher compares with the last registered run. The
// same functions run in `pnpm fin rules apply` and `pnpm fin access apply` (which record the
// hashes) and in the watcher (which recomputes them every minute), so both sides agree by
// construction. Web Crypto only, so they run in the Worker and in Node alike.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted at every depth, so equal values always hash equally. */
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

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The fields of a rule that define what it does (never its ID, version or timestamps). */
const RULE_FIELDS = [
  "ref",
  "description",
  "expression",
  "action",
  "action_parameters",
  "enabled",
  "ratelimit",
] as const;

/** The hash of a phase entrypoint's rules, in order. An absent entrypoint hashes as []. */
export async function rulesetHash(rules: readonly unknown[]): Promise<string> {
  const picked = rules.map((rule) => {
    const r = isRecord(rule) ? rule : {};
    return Object.fromEntries(RULE_FIELDS.filter((f) => r[f] !== undefined).map((f) => [f, r[f]]));
  });
  return sha256Hex(canonicalJson(picked));
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

/** The hash of an Access application's policies, ordered by precedence then name. */
export async function accessPolicyHash(policies: readonly unknown[]): Promise<string> {
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
