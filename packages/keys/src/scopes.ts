// Kinds and scopes (spec 05 §4.4; spec 02 §12.2; ARCHITECTURE §7.6, §7.7). A key never does more
// than its maker's role: a restricted key (`rk`) needs the permissions behind each of its scopes; a
// full-access key (`sk`) needs every scope's permissions for its mode, plus webhooks.manage,
// webhooks.roll_secret and webhooks.redeliver, plus sandbox.reset for a Sandbox key. Making a
// Sandbox key needs apiKey.sandbox, a Production key apiKey.live. The Sandbox-only scopes cannot be
// put on a Production key, and an unknown scope is refused. The unused `quotes:write` of the old
// product is not carried ([MO-16]). Pure: no I/O, so the permission engine and the edge read it.
import type { DashboardPermission } from "@fin/access";
import type { KeyKind, KeyMode } from "./format.ts";

export const SCOPES = [
  "customers:read",
  "customers:write",
  "events:read",
  "money:read",
  "money:write",
  "beneficiaries:write",
  "sandbox:simulate",
  "sandbox:deposit",
] as const;

export type Scope = (typeof SCOPES)[number];

/** The scopes only a Sandbox key may carry. */
export const SANDBOX_ONLY_SCOPES: readonly Scope[] = Object.freeze([
  "sandbox:simulate",
  "sandbox:deposit",
]);

/** The scopes a money route opens; a live key with any of them must carry an allowlist ([MO-20]). */
export const MONEY_SCOPES: readonly Scope[] = Object.freeze(["money:write", "beneficiaries:write"]);

/** What the maker must hold for each scope (spec 05 §4.4's table). */
export const KEY_SCOPE_NEEDS: Readonly<Record<Scope, readonly DashboardPermission[]>> =
  Object.freeze({
    "customers:read": ["customers.read"],
    "customers:write": [
      "customers.read",
      "customers.create",
      "customers.restart",
      "customers.delete",
    ],
    "events:read": ["webhooks.read"],
    "money:read": ["customers.read", "money.read"],
    "money:write": ["customers.read", "money.read", "money.transfer"],
    "beneficiaries:write": ["customers.read", "money.read", "money.beneficiaries"],
    "sandbox:simulate": ["customers.read", "simulator.use"],
    "sandbox:deposit": ["customers.read", "simulator.use", "money.read", "money.simulate"],
  });

/** What a full-access key needs beyond its mode's scopes (spec 05 §4.4). */
export const FULL_ACCESS_NEEDS: Readonly<Record<KeyMode, readonly DashboardPermission[]>> =
  Object.freeze({
    test: ["webhooks.manage", "webhooks.roll_secret", "webhooks.redeliver", "sandbox.reset"],
    live: ["webhooks.manage", "webhooks.roll_secret", "webhooks.redeliver"],
  });

/** The permission that makes, rolls, edits or revokes a key of this mode. */
export function managePermission(mode: KeyMode): DashboardPermission {
  return mode === "test" ? "apiKey.sandbox" : "apiKey.live";
}

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** The scopes a key of this mode may carry. */
export function scopesAllowedFor(mode: KeyMode): readonly Scope[] {
  return mode === "test" ? SCOPES : SCOPES.filter((s) => !SANDBOX_ONLY_SCOPES.includes(s));
}

/** Every permission a key of this mode, kind and scopes needs its maker to hold. */
export function permissionsNeeded(
  mode: KeyMode,
  kind: KeyKind,
  scopes: readonly Scope[],
): DashboardPermission[] {
  const out = new Set<DashboardPermission>([managePermission(mode)]);
  const covered = kind === "sk" ? scopesAllowedFor(mode) : scopes;
  for (const scope of covered) for (const p of KEY_SCOPE_NEEDS[scope]) out.add(p);
  if (kind === "sk") for (const p of FULL_ACCESS_NEEDS[mode]) out.add(p);
  return [...out].sort();
}

export type ScopeProblem =
  | { problem: "unknown_scope"; scope: string }
  | { problem: "sandbox_scope_on_live"; scope: Scope }
  | { problem: "duplicate_scope"; scope: Scope }
  | { problem: "no_scope" }
  | { problem: "scopes_on_full_access" };

/**
 * Checks a key's requested scopes against its mode and kind: a restricted key names at least one
 * known, distinct scope its mode allows; a full-access key names none (it opens every route of its
 * mode, and its stored scopes are empty). Returns the scopes in catalogue order, or the problem.
 */
export function checkScopes(
  mode: KeyMode,
  kind: KeyKind,
  requested: readonly string[],
): { ok: true; scopes: Scope[] } | ({ ok: false } & ScopeProblem) {
  if (kind === "sk") {
    return requested.length === 0
      ? { ok: true, scopes: [] }
      : { ok: false, problem: "scopes_on_full_access" };
  }
  if (requested.length === 0) return { ok: false, problem: "no_scope" };
  const seen = new Set<Scope>();
  for (const value of requested) {
    if (!isScope(value)) return { ok: false, problem: "unknown_scope", scope: value };
    if (seen.has(value)) return { ok: false, problem: "duplicate_scope", scope: value };
    if (!scopesAllowedFor(mode).includes(value)) {
      return { ok: false, problem: "sandbox_scope_on_live", scope: value };
    }
    seen.add(value);
  }
  return { ok: true, scopes: SCOPES.filter((s) => seen.has(s)) };
}

/** The permissions the maker lacks for this key, empty when the key is within their role. */
export function missingPermissions(
  held: ReadonlySet<string>,
  mode: KeyMode,
  kind: KeyKind,
  scopes: readonly Scope[],
): DashboardPermission[] {
  return permissionsNeeded(mode, kind, scopes).filter((p) => !held.has(p));
}

/** What a role may make in a mode: whether it may make keys at all, full access, and which scopes. */
export interface MakeableKeys {
  manage: boolean;
  fullAccess: boolean;
  scopes: Scope[];
}

export function makeableFor(held: ReadonlySet<string>, mode: KeyMode): MakeableKeys {
  const manage = held.has(managePermission(mode));
  return {
    manage,
    fullAccess: manage && missingPermissions(held, mode, "sk", []).length === 0,
    scopes: manage
      ? scopesAllowedFor(mode).filter((s) => KEY_SCOPE_NEEDS[s].every((p) => held.has(p)))
      : [],
  };
}

/** "Full access", or "Restricted · n scopes" (spec 05 §4.1's display). */
export function accessLabel(kind: KeyKind, scopeCount: number): string {
  if (kind === "sk") return "Full access";
  return `Restricted · ${scopeCount} ${scopeCount === 1 ? "scope" : "scopes"}`;
}
