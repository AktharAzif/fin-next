// The edge's key check lines (spec 05 §2.1 steps 15 to 19, §3.7, §4.7 and §10.2), written by
// apps/edge/src/keycheck.ts beside each request's own `request` line (platform.ts). The check
// fails closed: a statement that fails answers 503 `temporarily_unavailable` and alerts, never a
// pass. The alerts that watch these lines are in alerts/edge.json.
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "key.lookup_failed",
    kind: "failure",
    level: "error",
    writtenBy:
      "the edge's key check when step 15's one statement fails or does not read (packages/keys' lookup: the key record from keys.key_lookup, the address's refused-key window from ops.rate_window and the live_keys switch); `code` is the error's SQLSTATE or Node code, or its name. The request answers 503",
    fields: { code: "string" },
    // Spec 05 §3.7: the windows fail closed and alert rate-limiter-failing. Step 15's statement
    // reads the refused-key window with the key record, so its failure is that alert's too.
    alerts: ["rate-limiter-failing"],
  },
  {
    event: "rate_limiter.failed",
    kind: "failure",
    level: "error",
    writtenBy:
      "the edge's key check when a window's count in ops.rate_window fails or does not read (spec 05 §3.7): `policy` refused_keys for a refused key's address window, key for a working key's own; `code` as on key.lookup_failed. The request answers 503",
    fields: { code: "string", policy: "string" },
    alerts: ["rate-limiter-failing"],
  },
  {
    event: "key.pepper_missing",
    kind: "failure",
    level: "error",
    writtenBy:
      "the edge's key check when a key's pepper chain names an API_KEY_PEPPER_<n> the edge does not hold (spec 05 §4.7): the key is refused with the same 401 as any refused key, keyReason pepper_missing on the request line",
    fields: { keyId: "string" },
    alerts: ["pepper-missing"],
  },
];
