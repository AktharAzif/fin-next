// The key check at the edge (spec 05 §2.1 steps 12 to 17, §4.7; ARCHITECTURE §7.7; [SA-19]). Pure:
// the edge passes in the bearer, the key record its one statement read, the peppers, the time and
// the caller's address, and gets back the key or the reason it was refused. The reason goes into the
// `request` line as `keyReason`; the answer never says which: every refusal is the same 401 body
// apart from its request ID. There is no positive cache, so a revocation stops a key on the next
// request.
//
// - The body is hashed even when the record is missing, so an unknown key's timing is close to a
//   wrong one's.
// - A record missing any field reads as unknown; any non-null `revoked_at` is revoked; an unreadable
//   `expires_at` is expired; a rolled key past its overlap is expired; a chain naming a pepper the
//   edge does not hold refuses the key (`pepper_missing`, which alerts).
import type { Keyring } from "@fin/crypto";
import { allowlistAllows } from "./allowlist.ts";
import {
  checksumOf,
  type KeyKind,
  type KeyMode,
  otherDeploymentSalt,
  type ParsedKey,
  parseKey,
} from "./format.ts";
import { decoyCompare, matchesStored, PepperMissingError } from "./hash.ts";
import { isScope, type Scope } from "./scopes.ts";

export type KeyReason =
  | "missing"
  | "malformed"
  | "checksum"
  | "other_deployment"
  | "unknown"
  | "revoked"
  | "expired"
  | "ip_not_allowed"
  | "pepper_missing";

/** The `Authorization` header's bearer: `Bearer <key>`, exactly one space, nothing else. */
export function bearerOf(header: string | undefined | null): string | null {
  if (header === undefined || header === null || header === "") return null;
  const match = /^Bearer ([^\s]{1,200})$/.exec(header);
  return match?.[1] ?? "";
}

export type Precheck = { ok: true; key: ParsedKey } | { ok: false; reason: KeyReason };

/** Steps 13: present, the shape, and the checksum under this deployment's salt. No I/O. */
export function precheck(header: string | undefined | null, salt: string): Precheck {
  const raw = bearerOf(header);
  if (raw === null) return { ok: false, reason: "missing" };
  const key = parseKey(raw);
  if (key === null) return { ok: false, reason: "malformed" };
  if (checksumOf(key.body, salt) !== key.checksum) {
    return {
      ok: false,
      reason: otherDeploymentSalt(raw, salt) === null ? "checksum" : "other_deployment",
    };
  }
  return { ok: true, key };
}

/** The view's row (spec 05 §4.9's `keys.key_lookup`), as node-postgres reads it. */
export interface KeyRecord {
  id: unknown;
  organization_id: unknown;
  mode: unknown;
  kind: unknown;
  scopes: unknown;
  ip_allowlist: unknown;
  hash: unknown;
  pepper_versions: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  rolling_until: unknown;
  org_live_status: unknown;
}

export type OrgLiveStatus = "not_enabled" | "enabled" | "paused";

/** A key that passed the check. */
export interface VerifiedKey {
  id: string;
  organizationId: string;
  mode: KeyMode;
  kind: KeyKind;
  scopes: Scope[];
  orgLiveStatus: OrgLiveStatus;
}

export type Judgement = { ok: true; key: VerifiedKey } | { ok: false; reason: KeyReason };

function isDateOrNull(value: unknown): value is Date | null {
  return value === null || value instanceof Date;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
}

/** pg reads `cidr[]` as a string such as `{203.0.113.0/24,2001:db8::/32}` when no parser is set. */
function cidrArray(value: unknown): string[] | null {
  const list = stringArray(value);
  if (list !== null) return list;
  if (typeof value !== "string" || !/^\{.*\}$/.test(value)) return null;
  const inner = value.slice(1, -1);
  return inner === "" ? [] : inner.split(",").map((s) => s.replace(/^"|"$/g, ""));
}

function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.map((v) => (typeof v === "string" ? Number(v) : v));
  return out.every((v) => Number.isInteger(v) && (v as number) > 0) ? (out as number[]) : null;
}

interface CleanRecord {
  id: string;
  organizationId: string;
  mode: KeyMode;
  kind: KeyKind;
  scopes: Scope[];
  ipAllowlist: string[];
  hash: Uint8Array;
  pepperVersions: number[];
  expiresAt: Date | null;
  revokedAt: unknown;
  rollingUntil: Date | null;
  orgLiveStatus: OrgLiveStatus;
}

/** The record with every field read, or null when any field is missing or of the wrong shape. */
function clean(record: KeyRecord): CleanRecord | null {
  const scopes = stringArray(record.scopes);
  const ipAllowlist = cidrArray(record.ip_allowlist);
  const pepperVersions = numberArray(record.pepper_versions);
  if (
    typeof record.id !== "string" ||
    typeof record.organization_id !== "string" ||
    (record.mode !== "test" && record.mode !== "live") ||
    (record.kind !== "sk" && record.kind !== "rk") ||
    scopes === null ||
    !scopes.every(isScope) ||
    ipAllowlist === null ||
    !(record.hash instanceof Uint8Array) ||
    pepperVersions === null ||
    pepperVersions.length === 0 ||
    !isDateOrNull(record.rolling_until) ||
    (record.org_live_status !== "not_enabled" &&
      record.org_live_status !== "enabled" &&
      record.org_live_status !== "paused")
  ) {
    return null;
  }
  return {
    id: record.id,
    organizationId: record.organization_id,
    mode: record.mode,
    kind: record.kind,
    scopes: scopes as Scope[],
    ipAllowlist,
    hash: record.hash,
    pepperVersions,
    // Read below: an unreadable expiry counts as expired, not as unknown.
    expiresAt: record.expires_at instanceof Date ? record.expires_at : null,
    revokedAt: record.revoked_at,
    rollingUntil: record.rolling_until,
    orgLiveStatus: record.org_live_status,
  };
}

function expired(raw: unknown, now: number): boolean {
  if (raw === null) return false;
  if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) return true;
  return raw.getTime() <= now;
}

/**
 * Step 16: the constant-time compare across the key's pepper chain, then revoked, expired (its own
 * expiry, or the end of a roll's overlap) and the address allowlist. `record` is null for an
 * unknown key.
 */
export function judgeKey(input: {
  key: ParsedKey;
  record: KeyRecord | null;
  peppers: Keyring;
  now: number;
  clientIp: string | undefined;
}): Judgement {
  const { key, peppers, now } = input;
  const record = input.record === null ? null : clean(input.record);
  if (record === null || record.id !== key.id) {
    decoyCompare(peppers, key.body);
    return { ok: false, reason: "unknown" };
  }
  let matches: boolean;
  try {
    matches = matchesStored(peppers, key.body, record.hash, record.pepperVersions);
  } catch (error) {
    if (error instanceof PepperMissingError) return { ok: false, reason: "pepper_missing" };
    throw error;
  }
  // The hash covers the whole body, so a mode or kind that differs from the record cannot match;
  // the record's own fields are checked as well, so a damaged row is never trusted.
  if (!matches || record.mode !== key.mode || record.kind !== key.kind) {
    return { ok: false, reason: "unknown" };
  }
  if (record.revokedAt !== null && record.revokedAt !== undefined) {
    return { ok: false, reason: "revoked" };
  }
  if (expired(input.record?.expires_at ?? null, now)) return { ok: false, reason: "expired" };
  if (record.rollingUntil !== null && record.rollingUntil.getTime() <= now) {
    return { ok: false, reason: "expired" };
  }
  if (!allowlistAllows(record.ipAllowlist, input.clientIp)) {
    return { ok: false, reason: "ip_not_allowed" };
  }
  return {
    ok: true,
    key: {
      id: record.id,
      organizationId: record.organizationId,
      mode: record.mode,
      kind: record.kind,
      scopes: record.scopes,
      orgLiveStatus: record.orgLiveStatus,
    },
  };
}

export type LiveRefusal = "live_not_enabled" | "live_paused" | "temporarily_unavailable";

/**
 * Step 17, a Production key only: the organisation is not live (403 live_not_enabled), is paused
 * (403 live_paused), or the `live_keys` switch is on (503 temporarily_unavailable). A Sandbox key is
 * never affected.
 */
export function liveGate(key: VerifiedKey, liveKeysSwitchOn: boolean): LiveRefusal | null {
  if (key.mode !== "live") return null;
  if (key.orgLiveStatus === "not_enabled") return "live_not_enabled";
  if (key.orgLiveStatus === "paused") return "live_paused";
  if (liveKeysSwitchOn) return "temporarily_unavailable";
  return null;
}
