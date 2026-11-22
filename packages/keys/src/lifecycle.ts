// The key lifecycle (spec 05 §4.6; spec 02 §12.2, §12.3; ARCHITECTURE §7.7), called by the console's
// API half inside one unit of work per request, after `requireActor` has read the session, the
// membership and the role's permissions now. Each action checks the permission for the key's mode,
// then its own rules (the actor's role bounds a key they make, roll or re-point with an allowlist
// change; scopes only narrow, expiry only shortens, at most 50 working keys), and only then calls
// `confirm`, which asks for or consumes the step-up intent bound to the action and its fields (spec
// 02 §7.1: nobody proves a factor for something they cannot do). Then the change, its audit event and
// the `api-keys/key-changed` notice to every member, in the same transaction: a notice that cannot be
// queued refuses the change ([SA-41]).
//
// A key's maker (`created_by`) is whoever made it: the creator, the member who rolled it (rolling
// makes a key, within the roller's role, and only the roller is shown the secret), or the person
// whose removal or demotion of a member rolled it (nobody is shown that secret). So the "maker lacks
// permissions" flag clears once someone whose role holds the key rolls it, and a leaving member's
// keys are the ones they made or were shown, never a successor someone else rolled.
//
// Times are the database's (`now()`), so replicas never disagree about an expiry or an overlap. The
// secret is returned once, to the create or roll answer, and never stored, logged or audited.
import type { Keyring } from "@fin/crypto";
import { normaliseAllowlist } from "./allowlist.ts";
import { createRecordKeyAudit, type KeyAuditActor, type RecordKeyAudit } from "./audit.ts";
import { createEnqueueKeyEmail, type EnqueueKeyEmail } from "./email.ts";
import { invalidField, KeyRefusal } from "./errors.ts";
import { type KeyKind, type KeyMode, keyPrefix } from "./format.ts";
import { newKey, newKeyId, type RandomBytes, systemRandom } from "./generate.ts";
import { hashForStorage } from "./hash.ts";
import { checkKeyName } from "./names.ts";
import {
  accessLabel,
  checkScopes,
  isScope,
  type MakeableKeys,
  MONEY_SCOPES,
  makeableFor,
  managePermission,
  missingPermissions,
  type Scope,
} from "./scopes.ts";
import type { DateClock, KeysLines, KeysTx } from "./tx.ts";

/** At most this many working keys per organisation; a rolling old key is not counted. */
export const WORKING_KEY_LIMIT = 50;

export const EXPIRY_CHOICES = ["30d", "90d", "1y", "never"] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];
const EXPIRY_INTERVAL: Readonly<Record<Exclude<ExpiryChoice, "never">, string>> = {
  "30d": "30 days",
  "90d": "90 days",
  "1y": "1 year",
};

/** How long a rolled key keeps working ([SA-20]); never past its own expiry. */
export const OVERLAPS = ["now", "1h", "24h"] as const;
export type Overlap = (typeof OVERLAPS)[number];
const OVERLAP_INTERVAL: Readonly<Record<Overlap, string>> = {
  now: "0 seconds",
  "1h": "1 hour",
  "24h": "24 hours",
};

export type KeyStatus = "active" | "rolling" | "expired" | "revoked";

export interface Keys {
  readonly clock: DateClock;
  readonly peppers: Keyring;
  readonly salt: string;
  readonly lines: KeysLines;
  readonly audit: RecordKeyAudit;
  readonly email: EnqueueKeyEmail;
  readonly random: RandomBytes;
}

export function createKeys(options: {
  clock: DateClock;
  peppers: Keyring;
  salt: string;
  lines: KeysLines;
  random?: RandomBytes;
  audit?: RecordKeyAudit;
  email?: EnqueueKeyEmail;
}): Keys {
  return {
    clock: options.clock,
    peppers: options.peppers,
    salt: options.salt,
    lines: options.lines,
    audit: options.audit ?? createRecordKeyAudit(options),
    email: options.email ?? createEnqueueKeyEmail(options),
    random: options.random ?? systemRandom,
  };
}

/** Who acts, as `requireActor` read them on this request. */
export interface KeyActor {
  userId: string;
  organizationId: string;
  organizationName: string;
  /** The organisation's live status; only `approved` lets a Production key be made. */
  organizationLiveStatus: string;
  permissions: ReadonlySet<string>;
  /** The audit actor; `confirm` adds the proved step-up to it. */
  audit: KeyAuditActor;
  context?: { clientIp: string | null; userAgent: string | null };
  /** Asks for, or checks and consumes, the route's step-up intent (spec 02 §7.1). */
  confirm(binding: {
    body: Readonly<Record<string, unknown>>;
    target: string | null;
  }): Promise<void>;
}

export interface KeyView {
  keyId: string;
  name: string;
  /** `fin_<mode>_<kind>_<id>`: what the page shows, never the secret. */
  prefix: string;
  mode: KeyMode;
  kind: KeyKind;
  /** "Full access" or "Restricted · n scopes". */
  access: string;
  scopes: Scope[];
  ipAllowlist: string[];
  status: KeyStatus;
  createdAt: string;
  createdBy: { userId: string; name: string };
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  rollingUntil: string | null;
  replacedBy: string | null;
  lastUsedAt: string | null;
  flags: {
    /** Its maker no longer holds the permissions behind its scopes (spec 02 §9.4). */
    makerLacksPermissions: boolean;
    /** Nobody was shown its secret: it replaced a key when its maker left (S2-42). */
    secretUnseen: boolean;
  };
}

interface KeyRow {
  id: string;
  organization_id: string;
  mode: KeyMode;
  kind: KeyKind;
  name: string;
  scopes: string[];
  ip_allowlist: string[];
  created_by: string;
  maker_name: string | null;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  replaced_by: string | null;
  rolling_until: Date | null;
  last_used_at: Date | null;
  seen_by: string[];
  status: KeyStatus;
  total?: string | number;
}

const STATUS_SQL = `CASE
    WHEN k.revoked_at IS NOT NULL THEN 'revoked'
    WHEN k.expires_at IS NOT NULL AND k.expires_at <= now() THEN 'expired'
    WHEN k.rolling_until IS NOT NULL AND k.rolling_until <= now() THEN 'expired'
    WHEN k.rolling_until IS NOT NULL THEN 'rolling'
    ELSE 'active' END`;

const KEY_COLUMNS = `k.id, k.organization_id, k.mode, k.kind, k.name, k.scopes,
  k.ip_allowlist::text[] AS ip_allowlist, k.created_by, u.name AS maker_name, k.created_at,
  k.expires_at, k.revoked_at, k.revoked_reason, k.replaced_by, k.rolling_until, k.last_used_at,
  k.seen_by, ${STATUS_SQL} AS status`;

/** A working key: not revoked, not expired, and not an old key in (or past) a roll's overlap. */
const WORKING_SQL = `k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
  AND k.rolling_until IS NULL`;

/**
 * A key the edge still accepts: a working key, or an old key still inside a roll's overlap (the edge
 * refuses it only once `rolling_until` passes, verify.ts). What a leaving member knows is listed by
 * this, not by WORKING_SQL, so a key in a 24-hour overlap is never left out.
 */
const ACCEPTED_SQL = `k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
  AND (k.rolling_until IS NULL OR k.rolling_until > now())`;

/** A person's user ID, as `created_by` holds it. */
const USER_ID = /^usr_[0-9a-hjkmnp-tv-z]{26}$/;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function viewOf(row: KeyRow, makerLacks: boolean): KeyView {
  const scopes = row.scopes.filter(isScope);
  return {
    keyId: row.id,
    name: row.name,
    prefix: keyPrefix(row.mode, row.kind, row.id),
    mode: row.mode,
    kind: row.kind,
    access: accessLabel(row.kind, scopes.length),
    scopes,
    ipAllowlist: row.ip_allowlist,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    createdBy: { userId: row.created_by, name: row.maker_name ?? "" },
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    revokedReason: row.revoked_reason,
    rollingUntil: iso(row.rolling_until),
    replacedBy: row.replaced_by,
    lastUsedAt: iso(row.last_used_at),
    flags: { makerLacksPermissions: makerLacks, secretUnseen: row.seen_by.length === 0 },
  };
}

async function keyRow(
  tx: KeysTx,
  organizationId: string,
  keyId: string,
  lock: boolean,
): Promise<KeyRow | null> {
  const result = await tx.query<KeyRow>(
    `SELECT ${KEY_COLUMNS}
       FROM keys.api_key k LEFT JOIN identity."user" u ON u.id = k.created_by
      WHERE k.id = $1 AND k.organization_id = $2${lock ? " FOR UPDATE OF k" : ""}`,
    [keyId, organizationId],
  );
  return result.rows[0] ?? null;
}

async function requireKey(tx: KeysTx, actor: KeyActor, keyId: string): Promise<KeyRow> {
  const row = await keyRow(tx, actor.organizationId, keyId, true);
  // Another organisation's key answers as an unknown one.
  if (row === null) throw new KeyRefusal("not_found", "keys.not_found");
  return row;
}

function requireManage(actor: KeyActor, mode: KeyMode): void {
  const permission = managePermission(mode);
  if (!actor.permissions.has(permission)) {
    throw new KeyRefusal("forbidden", "policy.permission", { permission });
  }
}

/** The key is within the actor's role ([SA-34]: no key does more than its maker's role). */
function requireWithinRole(
  actor: KeyActor,
  mode: KeyMode,
  kind: KeyKind,
  scopes: readonly Scope[],
) {
  const missing = missingPermissions(actor.permissions, mode, kind, scopes);
  if (missing.length > 0) {
    throw new KeyRefusal("forbidden", "keys.beyond_role", {
      permission: missing.join(" "),
      reason: "beyond_role",
    });
  }
}

function checkName(raw: unknown): string {
  const name = checkKeyName(raw);
  if (!name.ok) throw invalidField("name", name.reason);
  return name.value;
}

function checkAllowlist(entries: readonly string[]): string[] {
  const allowlist = normaliseAllowlist(entries);
  if (!allowlist.ok) {
    throw invalidField(
      allowlist.problem === "too_many" ? "ipAllowlist" : `ipAllowlist.${allowlist.index}`,
      allowlist.problem,
    );
  }
  return allowlist.ranges;
}

/** [MO-20]: a live key with a money scope (or full access) carries an address allowlist. */
function checkLiveMoney(mode: KeyMode, kind: KeyKind, scopes: readonly Scope[], ranges: string[]) {
  const money = kind === "sk" || scopes.some((s) => MONEY_SCOPES.includes(s));
  if (mode === "live" && money && ranges.length === 0) {
    throw invalidField("ipAllowlist", "required_for_money");
  }
}

async function workingCount(tx: KeysTx, organizationId: string): Promise<number> {
  const result = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM keys.api_key k WHERE k.organization_id = $1 AND ${WORKING_SQL}`,
    [organizationId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Every member's address, for the notice every member gets (ARCHITECTURE §7.7). */
async function memberAddresses(tx: KeysTx, organizationId: string): Promise<string[]> {
  const result = await tx.query<{ email: string }>(
    `SELECT u.email FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 ORDER BY u.email`,
    [organizationId],
  );
  return result.rows.map((r) => r.email);
}

async function notifyMembers(
  keys: Keys,
  tx: KeysTx,
  organization: { id: string; name: string },
  key: { id: string; name: string; mode: KeyMode },
  change: "created" | "edited" | "rolled" | "revoked",
  newKeyId?: string,
): Promise<number> {
  const addresses = await memberAddresses(tx, organization.id);
  for (const to of addresses) {
    await keys.email(tx, {
      template: "api-keys/key-changed",
      to,
      params: {
        orgId: organization.id,
        keyId: key.id,
        change,
        mode: key.mode === "live" ? "live" : "sandbox",
        orgName: organization.name,
        keyName: key.name,
        ...(newKeyId === undefined ? {} : { newKeyId }),
      },
    });
  }
  return addresses.length;
}

/** A key ID no row holds: drawn again on the (50-bit) chance it exists. */
async function freshKeyId(keys: Keys, tx: KeysTx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newKeyId(keys.random);
    const taken = await tx.query("SELECT 1 FROM keys.api_key WHERE id = $1", [id]);
    if (taken.rows.length === 0) return id;
  }
  throw new Error("keys: no free key ID after five draws");
}

interface Insert {
  organizationId: string;
  mode: KeyMode;
  kind: KeyKind;
  name: string;
  scopes: readonly Scope[];
  ipAllowlist: readonly string[];
  createdBy: string;
  /** SQL for the expiry: an interval from now, the old key's expiry, or none. */
  expires: { interval: string } | { at: Date | null };
  seenBy: readonly string[];
}

async function insertKey(
  keys: Keys,
  tx: KeysTx,
  input: Insert,
): Promise<{ id: string; secret: string }> {
  const id = await freshKeyId(keys, tx);
  const made = newKey(input.mode, input.kind, keys.salt, keys.random, id);
  const stored = hashForStorage(keys.peppers, made.body);
  const expiry = "interval" in input.expires ? input.expires.interval : null;
  const expiresAt = "at" in input.expires ? input.expires.at : null;
  await tx.query(
    `INSERT INTO keys.api_key (id, organization_id, mode, kind, name, scopes, ip_allowlist, hash,
       pepper_versions, created_by, created_at, updated_at, expires_at, seen_by)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::cidr[], $8, $9::smallint[], $10, now(), now(),
       CASE WHEN $11::interval IS NOT NULL THEN now() + $11::interval ELSE $12::timestamptz END,
       $13::text[])`,
    [
      id,
      input.organizationId,
      input.mode,
      input.kind,
      input.name,
      [...input.scopes],
      [...input.ipAllowlist],
      Buffer.from(stored.hash),
      stored.pepperVersions,
      input.createdBy,
      expiry,
      expiresAt,
      [...input.seenBy],
    ],
  );
  return { id, secret: made.key };
}

/** What a role may make, by mode, for the page (it never decides: the server checks each action). */
export interface KeyAbilities {
  test: MakeableKeys;
  live: MakeableKeys & { approved: boolean };
}

export function abilitiesOf(
  actor: Pick<KeyActor, "permissions" | "organizationLiveStatus">,
): KeyAbilities {
  return {
    test: makeableFor(actor.permissions, "test"),
    live: {
      ...makeableFor(actor.permissions, "live"),
      approved: actor.organizationLiveStatus === "approved",
    },
  };
}

export interface KeyList {
  keys: KeyView[];
  total: number;
  page: number;
  size: number;
  working: number;
  limit: number;
  can: KeyAbilities;
}

/**
 * The API keys page's list for one mode, a page at a time (spec 02 §12.3): name, prefix and key ID,
 * kind and scopes, expiry, last used (to the minute), maker and the flags. Keys the edge still
 * accepts (active, and rolling until the overlap ends) come first, then the ones that ended
 * (revoked, expired, rolled away), each group newest first: ended rows are never deleted and every
 * roll adds one, so a long-lived key never sinks behind them. `total` counts every row, for paging.
 * `makerPermissions` gives each maker's permissions in the organisation now, or null for one who
 * left.
 */
export async function listKeys(
  tx: KeysTx,
  actor: Pick<KeyActor, "organizationId" | "permissions" | "organizationLiveStatus">,
  query: { mode: KeyMode; page: number; size: number },
  makerPermissions: (userIds: string[]) => Promise<ReadonlyMap<string, ReadonlySet<string> | null>>,
): Promise<KeyList> {
  const result = await tx.query<KeyRow>(
    `SELECT ${KEY_COLUMNS}, count(*) OVER () AS total
       FROM keys.api_key k LEFT JOIN identity."user" u ON u.id = k.created_by
      WHERE k.organization_id = $1 AND k.mode = $2
      ORDER BY CASE WHEN ${ACCEPTED_SQL} THEN 0 ELSE 1 END, k.created_at DESC, k.id DESC
      LIMIT $3 OFFSET $4`,
    [actor.organizationId, query.mode, query.size, (query.page - 1) * query.size],
  );
  const makers = await makerPermissions([...new Set(result.rows.map((r) => r.created_by))]);
  const keys = result.rows.map((row) => {
    const held = makers.get(row.created_by) ?? null;
    const scopes = row.scopes.filter(isScope);
    const lacks = held === null || missingPermissions(held, row.mode, row.kind, scopes).length > 0;
    return viewOf(row, lacks);
  });
  return {
    keys,
    total: Number(result.rows[0]?.total ?? 0),
    page: query.page,
    size: query.size,
    working: await workingCount(tx, actor.organizationId),
    limit: WORKING_KEY_LIMIT,
    can: abilitiesOf(actor),
  };
}

export interface CreateInput {
  name: string;
  mode: KeyMode;
  kind: KeyKind;
  scopes: readonly string[];
  ipAllowlist: readonly string[];
  expiresIn: ExpiryChoice;
}

export interface MadeKey {
  /** The whole key, shown once. */
  secret: string;
  key: KeyView;
}

export async function createKey(
  keys: Keys,
  tx: KeysTx,
  actor: KeyActor,
  input: CreateInput,
): Promise<MadeKey> {
  requireManage(actor, input.mode);
  if (input.mode === "live" && actor.organizationLiveStatus !== "approved") {
    throw new KeyRefusal("forbidden", "keys.live_not_enabled", { reason: "live_not_enabled" });
  }
  const name = checkName(input.name);
  const scopes = checkScopes(input.mode, input.kind, input.scopes);
  if (!scopes.ok) throw invalidField("scopes", scopes.problem);
  requireWithinRole(actor, input.mode, input.kind, scopes.scopes);
  const ranges = checkAllowlist(input.ipAllowlist);
  checkLiveMoney(input.mode, input.kind, scopes.scopes, ranges);
  if (!(EXPIRY_CHOICES as readonly string[]).includes(input.expiresIn)) {
    throw invalidField("expiresIn", "invalid_value");
  }
  if ((await workingCount(tx, actor.organizationId)) >= WORKING_KEY_LIMIT) {
    throw new KeyRefusal("limit_reached", "keys.limit", { limit: WORKING_KEY_LIMIT });
  }
  await actor.confirm({ body: { ...input }, target: null });

  const made = await insertKey(keys, tx, {
    organizationId: actor.organizationId,
    mode: input.mode,
    kind: input.kind,
    name,
    scopes: scopes.scopes,
    ipAllowlist: ranges,
    createdBy: actor.userId,
    expires:
      input.expiresIn === "never" ? { at: null } : { interval: EXPIRY_INTERVAL[input.expiresIn] },
    seenBy: [actor.userId],
  });
  const row = (await keyRow(tx, actor.organizationId, made.id, false)) as KeyRow;
  await keys.audit(tx, {
    event: "api_key.created",
    actor: actor.audit,
    target: made.id,
    organizationId: actor.organizationId,
    mode: input.mode,
    metadata: {
      key_id: made.id,
      mode: input.mode,
      kind: input.kind,
      scopes: scopes.scopes,
      expires_at: iso(row.expires_at),
      allowlist_count: ranges.length,
      shown_to: actor.userId,
    },
    ...(actor.context === undefined ? {} : { context: actor.context }),
  });
  await notifyMembers(
    keys,
    tx,
    { id: actor.organizationId, name: actor.organizationName },
    { id: made.id, name, mode: input.mode },
    "created",
  );
  return { secret: made.secret, key: viewOf(row, false) };
}

export interface UpdateInput {
  name?: string | undefined;
  scopes?: readonly string[] | undefined;
  expiresAt?: string | undefined;
  ipAllowlist?: readonly string[] | undefined;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * An edit (spec 05 §4.6): the name; scopes only narrowed; expiry only shortened; the allowlist
 * changed. Every edit, a name alone included, takes the `key.update` intent, is audited and emailed.
 * Narrowing, shortening and renaming need only the mode's permission, which may revoke the key
 * outright anyway; an allowlist change can widen where the key works, so it also needs a role that
 * holds everything the key, as edited, can do, as a roll does.
 */
export async function updateKey(
  keys: Keys,
  tx: KeysTx,
  actor: KeyActor,
  keyId: string,
  input: UpdateInput,
): Promise<KeyView> {
  const row = await requireKey(tx, actor, keyId);
  requireManage(actor, row.mode);
  if (row.status !== "active")
    throw new KeyRefusal("conflict", "keys.not_active", { reason: "not_active" });
  const current = row.scopes.filter(isScope);
  const changed: ("name" | "scopes" | "expires_at" | "ip_allowlist")[] = [];
  let name = row.name;
  if (input.name !== undefined) {
    name = checkName(input.name);
    if (name !== row.name) changed.push("name");
  }
  let scopes: Scope[] = current;
  if (input.scopes !== undefined) {
    const checked = checkScopes(row.mode, row.kind, input.scopes);
    if (!checked.ok) throw invalidField("scopes", checked.problem);
    if (!checked.scopes.every((s) => current.includes(s)))
      throw invalidField("scopes", "not_narrower");
    scopes = checked.scopes;
    if (!sameList(scopes, current)) changed.push("scopes");
  }
  let expiresAt = row.expires_at;
  if (input.expiresAt !== undefined) {
    const at = new Date(input.expiresAt);
    if (Number.isNaN(at.getTime())) throw invalidField("expiresAt", "invalid_format");
    if (at.getTime() <= keys.clock.now().getTime()) throw invalidField("expiresAt", "in_the_past");
    if (row.expires_at !== null && at.getTime() > row.expires_at.getTime()) {
      throw invalidField("expiresAt", "not_shorter");
    }
    if (row.expires_at === null || at.getTime() !== row.expires_at.getTime()) {
      expiresAt = at;
      changed.push("expires_at");
    }
  }
  let ranges = row.ip_allowlist;
  if (input.ipAllowlist !== undefined) {
    ranges = checkAllowlist(input.ipAllowlist);
    if (!sameList([...ranges].sort(), [...row.ip_allowlist].sort())) changed.push("ip_allowlist");
  }
  // For a live money key the allowlist is [MO-20]'s control: nobody re-points it who could not
  // make the key.
  if (changed.includes("ip_allowlist")) requireWithinRole(actor, row.mode, row.kind, scopes);
  checkLiveMoney(row.mode, row.kind, scopes, ranges);
  if (changed.length === 0) throw invalidField("body", "no_change");
  await actor.confirm({ body: { ...input }, target: keyId });

  await tx.query(
    `UPDATE keys.api_key
        SET name = $3, scopes = $4::text[], expires_at = $5, ip_allowlist = $6::cidr[], updated_at = now()
      WHERE id = $1 AND organization_id = $2`,
    [keyId, actor.organizationId, name, scopes, expiresAt, ranges],
  );
  await keys.audit(tx, {
    event: "api_key.updated",
    actor: actor.audit,
    target: keyId,
    organizationId: actor.organizationId,
    mode: row.mode,
    metadata: {
      key_id: keyId,
      changed,
      scopes_removed: current.filter((s) => !scopes.includes(s)),
      expiry_shortened: changed.includes("expires_at"),
      allowlist_count: ranges.length,
    },
    ...(actor.context === undefined ? {} : { context: actor.context }),
  });
  await notifyMembers(
    keys,
    tx,
    { id: actor.organizationId, name: actor.organizationName },
    { id: keyId, name, mode: row.mode },
    "edited",
  );
  const after = (await keyRow(tx, actor.organizationId, keyId, false)) as KeyRow;
  return viewOf(after, false);
}

/**
 * Replaces a key: the new one copies its access and life, and is made by `maker`; the old one works
 * until the overlap ends.
 */
async function replace(
  keys: Keys,
  tx: KeysTx,
  row: KeyRow,
  overlap: Overlap,
  maker: string,
  shownTo: string | null,
): Promise<{ id: string; secret: string }> {
  const made = await insertKey(keys, tx, {
    organizationId: row.organization_id,
    mode: row.mode,
    kind: row.kind,
    name: row.name,
    scopes: row.scopes.filter(isScope),
    ipAllowlist: row.ip_allowlist,
    createdBy: maker,
    expires: { at: row.expires_at },
    seenBy: shownTo === null ? [] : [shownTo],
  });
  await tx.query(
    `UPDATE keys.api_key
        SET replaced_by = $3,
            rolling_until = LEAST(now() + $4::interval, coalesce(expires_at, 'infinity'::timestamptz)),
            updated_at = now()
      WHERE id = $1 AND organization_id = $2`,
    [row.id, row.organization_id, made.id, OVERLAP_INTERVAL[overlap]],
  );
  return made;
}

export interface RolledKey extends MadeKey {
  /** The old key, now rolling (or ended, with no overlap). */
  replaced: KeyView;
}

/**
 * A roll (spec 05 §4.6, [SA-20]): a new key with the same scopes, allowlist and expiry, shown once;
 * the old key keeps working for `overlap` (now, 1 hour or 24 hours), never past its own expiry.
 * Rolling makes a key, so the roller's role must hold everything the key can do, and the roller is
 * the new key's maker.
 */
export async function rollKey(
  keys: Keys,
  tx: KeysTx,
  actor: KeyActor,
  keyId: string,
  input: { overlap: Overlap },
): Promise<RolledKey> {
  const row = await requireKey(tx, actor, keyId);
  requireManage(actor, row.mode);
  if (row.status !== "active" || row.replaced_by !== null) {
    throw new KeyRefusal("conflict", "keys.not_active", { reason: "not_active" });
  }
  requireWithinRole(actor, row.mode, row.kind, row.scopes.filter(isScope));
  if (!(OVERLAPS as readonly string[]).includes(input.overlap)) {
    throw invalidField("overlap", "invalid_value");
  }
  await actor.confirm({ body: { ...input }, target: keyId });

  const made = await replace(keys, tx, row, input.overlap, actor.userId, actor.userId);
  await keys.audit(tx, {
    event: "api_key.rolled",
    actor: actor.audit,
    target: keyId,
    refs: [made.id],
    organizationId: actor.organizationId,
    mode: row.mode,
    metadata: {
      key_id: keyId,
      new_key_id: made.id,
      overlap: input.overlap,
      shown_to: actor.userId,
    },
    ...(actor.context === undefined ? {} : { context: actor.context }),
  });
  await notifyMembers(
    keys,
    tx,
    { id: actor.organizationId, name: actor.organizationName },
    { id: keyId, name: row.name, mode: row.mode },
    "rolled",
    made.id,
  );
  const fresh = (await keyRow(tx, actor.organizationId, made.id, false)) as KeyRow;
  const old = (await keyRow(tx, actor.organizationId, keyId, false)) as KeyRow;
  return { secret: made.secret, key: viewOf(fresh, false), replaced: viewOf(old, false) };
}

/** A revocation (spec 02 §12.3): immediate; the edge refuses the key on its next request. */
export async function revokeKey(
  keys: Keys,
  tx: KeysTx,
  actor: KeyActor,
  keyId: string,
): Promise<KeyView> {
  const row = await requireKey(tx, actor, keyId);
  requireManage(actor, row.mode);
  if (row.revoked_at !== null) throw new KeyRefusal("already_done", "keys.already_revoked");
  await actor.confirm({ body: {}, target: keyId });

  await tx.query(
    `UPDATE keys.api_key SET revoked_at = now(), revoked_reason = 'member', updated_at = now()
      WHERE id = $1 AND organization_id = $2`,
    [keyId, actor.organizationId],
  );
  await keys.audit(tx, {
    event: "api_key.revoked",
    actor: actor.audit,
    target: keyId,
    organizationId: actor.organizationId,
    mode: row.mode,
    metadata: { key_id: keyId, reason: "member", source: null },
    ...(actor.context === undefined ? {} : { context: actor.context }),
  });
  await notifyMembers(
    keys,
    tx,
    { id: actor.organizationId, name: actor.organizationName },
    { id: keyId, name: row.name, mode: row.mode },
    "revoked",
  );
  const after = (await keyRow(tx, actor.organizationId, keyId, false)) as KeyRow;
  return viewOf(after, false);
}

/**
 * A key a member made or was shown that the edge still accepts, an old key inside a roll's overlap
 * included, for the Remove and Change role dialogs ([SA-33]).
 */
export interface MemberKey {
  id: string;
  mode: KeyMode;
  label: string;
  made: boolean;
  seen: boolean;
}

export async function keysOfMember(
  tx: KeysTx,
  organizationId: string,
  userId: string,
): Promise<MemberKey[]> {
  const result = await tx.query<{
    id: string;
    mode: KeyMode;
    kind: KeyKind;
    name: string;
    made: boolean;
    seen: boolean;
  }>(
    `SELECT k.id, k.mode, k.kind, k.name, k.created_by = $2 AS made, $2 = ANY (k.seen_by) AS seen
       FROM keys.api_key k
      WHERE k.organization_id = $1 AND (k.created_by = $2 OR $2 = ANY (k.seen_by)) AND ${ACCEPTED_SQL}
      ORDER BY k.created_at, k.id`,
    [organizationId, userId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    label: `${r.mode === "live" ? "Production" : "Sandbox"} key ${keyPrefix(r.mode, r.kind, r.id)}`,
    made: r.made,
    seen: r.seen,
  }));
}

/**
 * Rolls the keys a leaving or demoted member made or saw, in the removal's transaction (spec 02
 * §9.4, S2-42): at once, or with a 1-hour overlap when the actor may not roll them. A working key is
 * replaced; nobody is shown the new secret, so the new key carries the "secret unseen" flag until
 * someone rolls it, and its maker is the person whose act rolled it. An old key still inside a
 * roll's overlap (which the member may hold: they made it, or rolled it themselves just before)
 * already has its replacement, so its overlap is cut to end at once or within the hour, never
 * later than it would have, as is any other key the edge accepts that names a replacement; it is
 * audited and emailed as a roll to that same replacement. Keys that ended, or whose overlap already
 * ends within the hour, are left as they are. Answers how many keys it changed.
 */
export async function rollForMember(
  keys: Keys,
  tx: KeysTx,
  organization: { id: string; name: string },
  ids: readonly string[],
  overlap: "now" | "1h",
  actor: KeyAuditActor,
): Promise<number> {
  let rolled = 0;
  for (const id of ids) {
    const row = await keyRow(tx, organization.id, id, true);
    if (row === null) continue;
    let replacement: string;
    if (row.status === "active" && row.replaced_by === null) {
      const maker =
        actor.kind === "user" && actor.id !== null && USER_ID.test(actor.id)
          ? actor.id
          : row.created_by;
      replacement = (await replace(keys, tx, row, overlap, maker, null)).id;
    } else if ((row.status === "rolling" || row.status === "active") && row.replaced_by !== null) {
      // An active key naming a replacement has no overlap at all: no action writes one (a roll
      // sets both together), but the table allows it, and the edge accepts it with no end.
      const cut = await tx.query<{ id: string }>(
        `UPDATE keys.api_key
            SET rolling_until = now() + $3::interval, updated_at = now()
          WHERE id = $1 AND organization_id = $2
            AND (rolling_until IS NULL OR rolling_until > now() + $3::interval)
          RETURNING id`,
        [id, organization.id, OVERLAP_INTERVAL[overlap]],
      );
      if (cut.rows.length === 0) continue;
      replacement = row.replaced_by;
    } else {
      continue;
    }
    await keys.audit(tx, {
      event: "api_key.rolled",
      actor,
      target: id,
      refs: [replacement],
      organizationId: organization.id,
      mode: row.mode,
      metadata: { key_id: id, new_key_id: replacement, overlap, shown_to: null },
    });
    await notifyMembers(
      keys,
      tx,
      organization,
      { id, name: row.name, mode: row.mode },
      "rolled",
      replacement,
    );
    rolled += 1;
  }
  return rolled;
}
