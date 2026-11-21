// The API keys area's audit events (spec 05 §4.10, the owner of these names; spec 02 §16.5; spec 08
// §3.4's catalogue, D08-33). Category `api_keys`, scope `organisation`. Metadata is IDs, enums, counts
// and field names only, in snake_case as spec 05 §4.10 writes it: never a key's name, its prefix, its
// secret or an address in its allowlist. The target is the key's 10-character ID (a label, not a
// three-letter prefix), and a roll refs the new key so the new row's insert passes its audit guard.
//
// This file imports only zod and ../define.ts, so packages/keys reads the same schemas for its
// console adapter without loading the rest of packages/audit.
import { z } from "zod";
import { defineEvents } from "../define.ts";

const keyId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{10}$/);
const userId = z.string().regex(/^usr_[0-9a-hjkmnp-tv-z]{26}$/);
const mode = z.enum(["test", "live"]);
const scope = z.enum([
  "customers:read",
  "customers:write",
  "events:read",
  "money:read",
  "money:write",
  "beneficiaries:write",
  "sandbox:simulate",
  "sandbox:deposit",
]);
const count = z.int().min(0).max(1_000);
const instant = z.iso.datetime({ offset: false });
const revokedReason = z.enum([
  "member",
  "maker_removed",
  "sent_in_clear",
  "leaked_public",
  "organisation_deleted",
]);
const exposureSource = z.enum(["plain_http", "secret_scanning"]);
const changedField = z.enum(["name", "scopes", "expires_at", "ip_allowlist"]);

export const events = defineEvents("api-keys", {
  "api_key.created": {
    category: "api_keys",
    scope: "organisation",
    roles: ["fin_console"],
    actors: ["user"],
    target: "api_key",
    metadata: z
      .object({
        key_id: keyId,
        mode,
        kind: z.enum(["sk", "rk"]),
        scopes: z.array(scope).max(8),
        expires_at: instant.nullable(),
        allowlist_count: count,
        shown_to: userId,
      })
      .strict(),
  },
  "api_key.updated": {
    category: "api_keys",
    scope: "organisation",
    roles: ["fin_console"],
    actors: ["user"],
    target: "api_key",
    metadata: z
      .object({
        key_id: keyId,
        changed: z.array(changedField).min(1).max(4),
        scopes_removed: z.array(scope).max(8),
        expiry_shortened: z.boolean(),
        allowlist_count: count,
      })
      .strict(),
  },
  "api_key.rolled": {
    category: "api_keys",
    scope: "organisation",
    roles: ["fin_console"],
    actors: ["user", "system"],
    target: "api_key",
    metadata: z
      .object({
        key_id: keyId,
        new_key_id: keyId,
        overlap: z.enum(["now", "1h", "24h"]),
        // Who was shown the new key's secret; null when nobody was (a roll because its maker left).
        shown_to: userId.nullable(),
      })
      .strict(),
    journal: { kind: "key_rolled" },
  },
  "api_key.revoked": {
    category: "api_keys",
    scope: "organisation",
    roles: ["fin_console", "fin_api"],
    actors: ["user", "system"],
    target: "api_key",
    metadata: z
      .object({
        key_id: keyId,
        reason: revokedReason,
        source: exposureSource.nullable(),
      })
      .strict(),
    journal: { kind: "key_revoked" },
  },
  "api_key.exposed": {
    category: "api_keys",
    scope: "organisation",
    roles: ["fin_api"],
    actors: ["system"],
    target: "api_key",
    metadata: z.object({ key_id: keyId, source: exposureSource }).strict(),
  },
});
