// The realm tables, read and written by Fin's own code in the request's unit of work. The
// library writes the same tables through its adapter; both run on the one bound connection.
import type { RealmName } from "./config.ts";
import type { Queryable } from "./ports/db.ts";

export const TABLES = {
  developer: {
    user: 'identity."user"',
    session: "identity.session",
    passkey: "identity.passkey",
    twoFactor: "identity.two_factor",
    assurance: "identity.assurance",
    totpStep: "identity.totp_step",
  },
  staff: {
    user: "staff.member",
    session: "staff.session",
    passkey: "staff.passkey",
    twoFactor: "staff.two_factor",
    assurance: "staff.assurance",
    totpStep: "staff.totp_step",
  },
} as const satisfies Record<RealmName, Record<string, string>>;

export type Assurance = "aal1" | "aal2";

export interface SessionRow {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  assurance: Assurance;
  createdVia: string;
  createdAt: Date;
  mailboxProvedAt: Date | null;
  trustedBrowserId: string | null;
  /**
   * Whether `trustedBrowserId` names a row that is still unrevoked and unexpired, read with the
   * session: a revoked or lapsed row leaves the column set until the sweep deletes it (§6.6).
   */
  trustedBrowserLive: boolean;
  /** The organisation the viewer is in (navigation only, never a permission). */
  currentOrganizationId: string | null;
  stepUpFailures: number;
  /** Staff realm only. */
  accessSub: string | null;
  enrolmentOpenUntil: Date | null;
}

export interface PersonRow {
  id: string;
  email: string;
  name: string;
  twoFactorEnabled: boolean;
  /** Staff realm only. */
  status: "pending" | "active" | "removed" | null;
  roleKey: string | null;
}

interface RawSession {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  absolute_expires_at: Date;
  assurance: Assurance;
  created_via: string;
  created_at: Date;
  mailbox_proved_at?: Date | null;
  trusted_browser_id?: string | null;
  trusted_browser_live?: boolean;
  current_organization_id?: string | null;
  step_up_failures: number;
  access_sub?: string | null;
  enrolment_open_until?: Date | null;
}

/** The session's columns; `$2` is the time a trusted-browser row must still be live at. */
function sessionColumns(realm: RealmName): string {
  const common =
    "s.id, s.user_id, s.token, s.expires_at, s.absolute_expires_at, s.assurance, s.created_via, s.created_at, s.step_up_failures";
  return realm === "developer"
    ? `${common}, s.mailbox_proved_at, s.trusted_browser_id, s.current_organization_id,
       EXISTS (SELECT 1 FROM identity.trusted_browser tb
                WHERE tb.id = s.trusted_browser_id AND tb.user_id = s.user_id
                  AND tb.revoked_at IS NULL AND tb.expires_at > $2) AS trusted_browser_live`
    : `${common}, s.access_sub, s.enrolment_open_until`;
}

function toSession(row: RawSession): SessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    assurance: row.assurance,
    createdVia: row.created_via,
    createdAt: row.created_at,
    mailboxProvedAt: row.mailbox_proved_at ?? null,
    trustedBrowserId: row.trusted_browser_id ?? null,
    trustedBrowserLive: row.trusted_browser_live === true,
    currentOrganizationId: row.current_organization_id ?? null,
    stepUpFailures: Number(row.step_up_failures),
    accessSub: row.access_sub ?? null,
    enrolmentOpenUntil: row.enrolment_open_until ?? null,
  };
}

async function sessionWhere(
  db: Queryable,
  realm: RealmName,
  column: "token" | "id",
  value: string,
  now: Date,
): Promise<SessionRow | null> {
  const result = await db.query<RawSession>(
    `SELECT ${sessionColumns(realm)} FROM ${TABLES[realm].session} s WHERE s.${column} = $1`,
    realm === "developer" ? [value, now] : [value],
  );
  const row = result.rows[0];
  return row === undefined ? null : toSession(row);
}

/** The session a token names, whether or not it is still live. */
export function sessionByToken(
  db: Queryable,
  realm: RealmName,
  token: string,
  now: Date,
): Promise<SessionRow | null> {
  return sessionWhere(db, realm, "token", token, now);
}

export function sessionById(
  db: Queryable,
  realm: RealmName,
  id: string,
  now: Date,
): Promise<SessionRow | null> {
  return sessionWhere(db, realm, "id", id, now);
}

export function isLive(session: SessionRow, now: Date): boolean {
  return (
    session.expiresAt.getTime() > now.getTime() &&
    session.absoluteExpiresAt.getTime() > now.getTime() &&
    session.stepUpFailures < 5
  );
}

export async function personById(
  db: Queryable,
  realm: RealmName,
  id: string,
  options: { lock?: boolean } = {},
): Promise<PersonRow | null> {
  const extra = realm === "staff" ? ", status, role_key" : "";
  const lock = options.lock === true ? " FOR UPDATE" : "";
  const result = await db.query<{
    id: string;
    email: string;
    name: string;
    two_factor_enabled: boolean;
    status?: PersonRow["status"];
    role_key?: string;
  }>(
    `SELECT id, email, name, two_factor_enabled${extra} FROM ${TABLES[realm].user} WHERE id = $1${lock}`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    twoFactorEnabled: row.two_factor_enabled,
    status: row.status ?? null,
    roleKey: row.role_key ?? null,
  };
}

export async function personByEmail(
  db: Queryable,
  realm: RealmName,
  email: string,
): Promise<PersonRow | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM ${TABLES[realm].user} WHERE email = $1`,
    [email.toLowerCase()],
  );
  const id = result.rows[0]?.id;
  return id === undefined ? null : personById(db, realm, id);
}

export interface FactorFacts {
  passkeys: number;
  authenticator: boolean;
  /** An authenticator whose set-up began but is not finished. */
  authenticatorPending: boolean;
  count: number;
}

export async function factorFacts(
  db: Queryable,
  realm: RealmName,
  userId: string,
): Promise<FactorFacts> {
  const result = await db.query<{ passkeys: number; verified: boolean | null }>(
    `SELECT (SELECT count(*)::integer FROM ${TABLES[realm].passkey} WHERE user_id = $1) AS passkeys,
            (SELECT verified FROM ${TABLES[realm].twoFactor} WHERE user_id = $1) AS verified`,
    [userId],
  );
  const row = result.rows[0];
  const passkeys = Number(row?.passkeys ?? 0);
  const authenticator = row?.verified === true;
  return {
    passkeys,
    authenticator,
    authenticatorPending: row?.verified === false,
    count: passkeys + (authenticator ? 1 : 0),
  };
}

/** Ends a session now (the sweep deletes it later), keeping why for the next request's 401. */
export async function endSession(
  db: Queryable,
  realm: RealmName,
  sessionId: string,
  now: Date,
  options: { tooManyTries?: boolean } = {},
): Promise<void> {
  if (options.tooManyTries === true) {
    await db.query(
      `UPDATE ${TABLES[realm].session} SET expires_at = LEAST($2, absolute_expires_at), step_up_failures = 5, updated_at = $2 WHERE id = $1`,
      [sessionId, now],
    );
  } else {
    await db.query(`DELETE FROM ${TABLES[realm].session} WHERE id = $1`, [sessionId]);
  }
}

/** Moves a session's expiry, never past its absolute limit. */
export async function setSessionExpiry(
  db: Queryable,
  realm: RealmName,
  sessionId: string,
  expiresAt: Date,
  now: Date,
): Promise<void> {
  await db.query(
    `UPDATE ${TABLES[realm].session} SET expires_at = LEAST($2, absolute_expires_at), updated_at = $3 WHERE id = $1`,
    [sessionId, expiresAt, now],
  );
}

export async function raiseAssurance(
  db: Queryable,
  realm: RealmName,
  sessionId: string,
  now: Date,
): Promise<void> {
  await db.query(
    `UPDATE ${TABLES[realm].session} SET assurance = 'aal2', updated_at = $2 WHERE id = $1 AND assurance <> 'aal2'`,
    [sessionId, now],
  );
}
