// Drives the developer realm and this area the way the console's API half does: library endpoints
// through `realm.handler()`, Fin's organisation actions through `realm.run()` and the guards, with
// the front door's context and a browser-like cookie jar. Secrets and keys are made at run time;
// addresses use example.com only. The console's own tests reach the same code over HTTP.
import { createHmac, randomBytes } from "node:crypto";
import {
  createPgDatabase,
  createRealm,
  newId as identityNewId,
  type LineSink,
  MemoryLineSink,
  type PgFinDatabase,
  type Realm,
  type RequestContext,
  readRealmSettings,
  systemClock,
  type UnitTx,
} from "@fin/identity";
import type { Pool } from "pg";
import { afterEach, beforeEach, expect } from "vitest";
import { CredentialRegistry } from "../src/credentials.ts";
import { createRole } from "../src/custom-roles.ts";
import {
  type ActorOptions,
  type Guarded,
  type GuardOptions,
  type OrgActor,
  personGuard,
  type RealmState,
  requireActor,
} from "../src/guard.ts";
import { newId } from "../src/ids.ts";
import { acceptInvitation, inviteMember } from "../src/invitations.ts";
import { changeMemberRole, removeMember } from "../src/members.ts";
import { createFirstOrganization } from "../src/organizations.ts";
import { createOrgs, type Orgs } from "../src/orgs.ts";
import { ORGS_ACTIONS } from "../src/step-up.ts";
import { seed, type TestDatabase } from "./db.ts";

export const ORIGIN = "https://console.example.com";
export const DOCS_ORIGIN = "https://developer.example.com";

const secret = () => randomBytes(32).toString("base64url");

/** The realm's settings as the console reads them, with secrets made for this run. */
export function realmEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    FIN_ENVIRONMENT: "test",
    FIN_PUBLIC_ORIGIN: ORIGIN,
    BETTER_AUTH_SECRETS: `2:${secret()},1:${secret()}`,
    FIN_LIMIT_KEY_1: randomBytes(32).toString("hex"),
    ...overrides,
  };
}

export interface AuditRow {
  id: string;
  event: string;
  target_id: string;
  ref_ids: string[];
  metadata: Record<string, unknown>;
  actor_kind: string;
  actor_id: string | null;
  organization_id: string | null;
  step_up_ref: string | null;
  step_up_method: string | null;
}

export interface OutboxRow {
  template: string;
  recipient: string;
  params: Record<string, unknown>;
}

export interface Answer {
  status: number;
  json: Record<string, unknown> | null;
  headers: Headers;
  setCookies: string[];
}

export class Browser {
  readonly jar = new Map<string, string>();
  readonly ip: string;
  readonly userAgent: string;
  readonly #realm: Realm;

  constructor(realm: Realm, options: { ip?: string; userAgent?: string } = {}) {
    this.#realm = realm;
    // Each browser on its own /48 of the documentation prefix, so per-network limits are its own.
    this.ip = options.ip ?? `2001:db8:${randomBytes(2).toString("hex")}::1`;
    this.userAgent =
      options.userAgent ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  }

  cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  context(): RequestContext {
    return {
      requestId: identityNewId("req", systemClock),
      clientIp: this.ip,
      userAgent: this.userAgent,
    };
  }

  request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        "user-agent": this.userAgent,
        "cf-connecting-ip": this.ip,
        ...(this.jar.size > 0 ? { cookie: this.cookieHeader() } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  absorb(cookies: readonly string[]): void {
    for (const cookie of cookies) {
      const [pair = ""] = cookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0\b/i.test(cookie) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  /** A library endpoint, through the realm's own handler. */
  async auth(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    const method = body === undefined ? "GET" : "POST";
    const response = await this.#realm.handler(
      this.request(method, `/api/auth${path}`, body, headers),
      this.context(),
    );
    const setCookies = response.headers.getSetCookie();
    this.absorb(setCookies);
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      json = null;
    }
    return { status: response.status, json, headers: response.headers, setCookies };
  }
}

/** RFC 4226 / 6238 for the authenticator steps, from the secret the set-up answered. */
export function totpCode(secret: Uint8Array, at: Date): string {
  const counter = Math.floor(at.getTime() / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", Buffer.from(secret)).update(message).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function base32Decode(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = text.replace(/=+$/, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface Harness {
  realm: Realm;
  orgs: Orgs;
  db: PgFinDatabase;
  pool: Pool;
  lines: MemoryLineSink;
  admin: Pool;
  credentials: CredentialRegistry;
  browser(options?: { ip?: string; userAgent?: string }): Browser;
  latestCode(email: string): Promise<string | null>;
  outbox(email?: string): Promise<OutboxRow[]>;
  events(filter?: { event?: string; organizationId?: string }): Promise<AuditRow[]>;
  /** The newest invitation token emailed to an address. */
  invitationToken(email: string): Promise<string | null>;
}

export async function createHarness(
  database: TestDatabase,
  options: { lines?: LineSink; credentials?: CredentialRegistry } = {},
): Promise<Harness> {
  const pool = database.login("fin_console");
  const lines = new MemoryLineSink();
  const db = createPgDatabase({ pool, clock: systemClock, release: "test", lines });
  const settings = readRealmSettings("developer", realmEnv());
  const realm = createRealm({
    settings,
    db,
    clock: systemClock,
    lines,
    docsOrigin: DOCS_ORIGIN,
    actions: [ORGS_ACTIONS],
  });
  const credentials = options.credentials ?? new CredentialRegistry();
  const orgs = createOrgs(realm, { credentials });
  return {
    realm,
    orgs,
    db,
    pool,
    lines,
    admin: database.admin,
    credentials,
    browser: (browserOptions) => new Browser(realm, browserOptions),
    async latestCode(email) {
      const result = await database.admin.query<{ code: string }>(
        `SELECT params ->> 'code' AS code FROM email_private.outbox
          WHERE recipient = $1 AND params ? 'code' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [email.toLowerCase()],
      );
      return result.rows[0]?.code ?? null;
    },
    async outbox(email) {
      const result = await database.admin.query<OutboxRow>(
        `SELECT template, recipient, params FROM email_private.outbox
          WHERE ($1::text IS NULL OR recipient = $1) ORDER BY created_at, id`,
        [email ?? null],
      );
      return result.rows;
    },
    async events(filter = {}) {
      const result = await database.admin.query<AuditRow>(
        `SELECT id, event, target_id, ref_ids, metadata, actor_kind, actor_id, organization_id,
                step_up_ref, step_up_method
           FROM audit.event
          WHERE ($1::text IS NULL OR event = $1) AND ($2::text IS NULL OR organization_id = $2)
          ORDER BY recorded_at, id`,
        [filter.event ?? null, filter.organizationId ?? null],
      );
      return result.rows;
    },
    async invitationToken(email) {
      const result = await database.admin.query<{ token: string }>(
        `SELECT params ->> 'token' AS token FROM email_private.outbox
          WHERE recipient = $1 AND template = 'orgs/invitation' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [email.toLowerCase()],
      );
      return result.rows[0]?.token ?? null;
    },
  };
}

export const unique = (label: string) => `${label}.${randomBytes(4).toString("hex")}@example.com`;

export interface SignedIn {
  email: string;
  browser: Browser;
  secret: Uint8Array | null;
  userId: string;
}

/** Asks a code and signs in with it, from this browser (an unknown address makes the account). */
async function codeSignInBody(h: Harness, browser: Browser, email: string): Promise<Answer> {
  const sent = await browser.auth("/email-otp/send-verification-otp", { email, type: "sign-in" });
  if (sent.status !== 200) throw new Error(`code request answered ${sent.status}`);
  const code = await h.latestCode(email);
  if (code === null) throw new Error("no code was queued");
  return browser.auth("/sign-in/email-otp", { email, otp: code });
}

/** Sets up and finishes an authenticator in this browser's session (the first factor). */
async function setUpAuthenticatorBody(browser: Browser): Promise<Uint8Array> {
  const enable = await browser.auth("/two-factor/enable", {});
  if (enable.status !== 200) throw new Error(`enable answered ${enable.status}`);
  const uri = String(enable.json?.totpURI);
  const key = new URL(uri).searchParams.get("secret");
  if (key === null) throw new Error("the URI has no secret");
  const secretBytes = base32Decode(key);
  const verify = await browser.auth("/two-factor/verify-totp", {
    code: totpCode(secretBytes, new Date()),
  });
  if (verify.status !== 200) throw new Error(`verify-totp answered ${verify.status}`);
  return secretBytes;
}

/** A person signed in by code, with an authenticator when `factor` is true. */
async function personBody(
  h: Harness,
  label: string,
  options: { factor?: boolean; email?: string } = {},
): Promise<SignedIn> {
  const email = options.email ?? unique(label);
  const browser = h.browser();
  const signed = await codeSignIn(h, browser, email);
  if (signed.status !== 200) throw new Error(`sign-in answered ${signed.status}`);
  const secretBytes = options.factor === false ? null : await setUpAuthenticator(browser);
  const user = await h.admin.query<{ id: string }>(
    'SELECT id FROM identity."user" WHERE email = $1',
    [email],
  );
  return { email, browser, secret: secretBytes, userId: user.rows[0]?.id as string };
}

/**
 * Proves an intent with a right authenticator code. Each TOTP step is accepted once ([SA-35]); these
 * tests are not about replay, so the person's last accepted step is forgotten first.
 */
async function proveBody(h: Harness, who: SignedIn, intentId: string): Promise<Answer> {
  if (who.secret === null) throw new Error("this person has no authenticator");
  await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
  return who.browser.auth(
    "/two-factor/verify-totp",
    { code: totpCode(who.secret, new Date()) },
    { "fin-step-up-intent": intentId },
  );
}

export type Outcome<T> =
  | { ok: true; value: T; setCookies: string[] }
  | { ok: false; error: unknown };

/** Runs an action as the console's routes do: one unit of work, the guard, then the action. */
async function asPersonBody<T>(
  h: Harness,
  who: SignedIn,
  init: { method?: string; path?: string; body?: unknown; headers?: Record<string, string> },
  options: GuardOptions,
  action: (tx: UnitTx, guarded: Guarded, state: RealmState) => Promise<T>,
): Promise<Outcome<T>> {
  const request = who.browser.request(
    init.method ?? "POST",
    init.path ?? "/api/test",
    init.body,
    init.headers,
  );
  const context = who.browser.context();
  try {
    let cookies: string[] = [];
    const value = await h.realm.run(context, async (tx, state) => {
      const guarded = await personGuard(h.realm, request, context, tx, state, options);
      cookies = guarded.setCookies;
      return action(tx, guarded, state);
    });
    who.browser.absorb(cookies);
    return { ok: true, value, setCookies: cookies };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The same with `requireActor` for an organisation named in `Fin-Organization`. */
async function asActorBody<T>(
  h: Harness,
  who: SignedIn,
  orgId: string | null,
  init: { method?: string; body?: unknown; headers?: Record<string, string> },
  options: ActorOptions,
  action: (tx: UnitTx, actor: OrgActor) => Promise<T>,
): Promise<Outcome<T>> {
  const request = who.browser.request(init.method ?? "POST", "/api/test", init.body, {
    ...(orgId === null ? {} : { "fin-organization": orgId }),
    ...init.headers,
  });
  const context = who.browser.context();
  try {
    const value = await h.realm.run(context, async (tx, state) => {
      const actor = await requireActor(h.realm, request, context, tx, state, options);
      return action(tx, actor);
    });
    return { ok: true, value, setCookies: [] };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Runs a stepped-up action the way the client does (§7.1): the first call answers
 * `step_up_required` with an intent, the person proves it, and the same request is sent once more
 * with `Fin-Step-Up-Intent`.
 */
async function withIntentBody<T>(
  h: Harness,
  who: SignedIn,
  attempt: (headers: Record<string, string>) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const first = await attempt({});
  if (first.ok) return first;
  const intentId = intentIdOf(first.error);
  if (intentId === null) return first;
  const proved = await prove(h, who, intentId);
  if (proved.status !== 200) throw new Error(`the proof answered ${proved.status}`);
  return attempt({ "fin-step-up-intent": intentId });
}

export function intentIdOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error && "extensions" in error) {
    const e = error as { code: string; extensions: Record<string, unknown> };
    if (e.code === "step_up_required" && typeof e.extensions.intent_id === "string") {
      return e.extensions.intent_id;
    }
  }
  return null;
}

/** The refusal's code (an AuthRefusal's or an OrgRefusal's), for assertions. */
export function codeOf(outcome: Outcome<unknown>): string {
  if (outcome.ok) return "ok";
  const error = outcome.error as { code?: unknown; name?: unknown };
  return typeof error.code === "string" ? error.code : String(error.name ?? "error");
}

export function extensionsOf(outcome: Outcome<unknown>): Record<string, unknown> {
  if (outcome.ok) return {};
  const error = outcome.error as { extensions?: Record<string, unknown> };
  return error.extensions ?? {};
}

/** A person with an authenticator who owns a first organisation as its Super admin. */
async function ownerWithOrganizationBody(
  h: Harness,
  label: string,
): Promise<{ who: SignedIn; orgId: string; name: string; memberId: string }> {
  const who = await person(h, label);
  const made = await asPerson(h, who, {}, { stepUp: { kind: "none" } }, (tx, g) =>
    createFirstOrganization(h.orgs, tx, g),
  );
  if (!made.ok) throw made.error;
  const member = await h.admin.query<{ id: string }>(
    "SELECT id FROM identity.member WHERE organization_id = $1 AND user_id = $2",
    [made.value.orgId, who.userId],
  );
  return {
    who,
    orgId: made.value.orgId,
    name: made.value.name,
    memberId: String(member.rows[0]?.id),
  };
}

/** Invites an address with an intent, as the actor. */
function inviteAsBody(
  h: Harness,
  actor: SignedIn,
  orgId: string,
  email: string,
  roleKey: string,
): Promise<Outcome<{ invitationId: string; expiresAt: string }>> {
  return withIntent(h, actor, (headers) =>
    asActor(
      h,
      actor,
      orgId,
      { body: { email, roleKey }, headers },
      {
        permission: "member.invite",
        lock: true,
        stepUp: { kind: "intent", action: "member.invite" },
      },
      (tx, a) => inviteMember(h.orgs, tx, a, { email, roleKey }),
    ),
  );
}

/** Accepts an invitation as the invitee (an intent once they have a factor). */
function acceptAsBody(
  h: Harness,
  invitee: SignedIn,
  invitationId: string,
): Promise<Outcome<{ orgId: string; memberId: string; roleKey: string }>> {
  return withIntent(h, invitee, (headers) =>
    asPerson(
      h,
      invitee,
      { headers },
      { stepUp: { kind: "intent_if_factor", action: "invitation.accept" } },
      (tx, g) => acceptInvitation(h.orgs, tx, g, invitationId),
    ),
  );
}

/** A member of the organisation in the role given, invited by the owner and accepted. */
async function memberOfBody(
  h: Harness,
  owner: SignedIn,
  orgId: string,
  label: string,
  roleKey: string,
  options: { factor?: boolean } = {},
): Promise<{ who: SignedIn; memberId: string }> {
  const email = unique(label);
  const invited = await inviteAs(h, owner, orgId, email, roleKey);
  if (!invited.ok) throw invited.error;
  const who = await person(h, label, { email, factor: options.factor ?? true });
  const joined = await acceptAs(h, who, invited.value.invitationId);
  if (!joined.ok) throw joined.error;
  return { who, memberId: joined.value.memberId };
}

/**
 * A member of the organisation in the role given, for a test whose subject is not how they joined:
 * a person signed in by code, with an authenticator unless `factor` is false (as `memberOf`), whose
 * membership is then written as the acceptance writes it (`inviter` as the one who invited them,
 * their session's current organisation set), as a fixture with the triggers off. It skips the
 * invitation with its intent and proof and the acceptance (with its own, once the person has a
 * factor): six of `memberOf`'s ten realm units for a person with an authenticator. No invitation
 * row, no member.invited or member.joined event and no member-joined email is written; a test that
 * reads any of those uses `memberOf`.
 */
async function seededMemberOfBody(
  h: Harness,
  inviter: SignedIn,
  orgId: string,
  label: string,
  roleKey: string,
  options: { factor?: boolean } = {},
): Promise<{ who: SignedIn; memberId: string }> {
  const who = await person(h, label, { factor: options.factor ?? true });
  const memberId = newId("mem", systemClock);
  await seed(
    h.admin,
    `WITH joined AS (
       INSERT INTO identity.member (id, organization_id, user_id, role_key, invited_by)
       VALUES ($1, $2, $3, $4, $5)
     )
     UPDATE identity.session SET current_organization_id = $2, updated_at = now()
      WHERE user_id = $3`,
    [memberId, orgId, who.userId, roleKey, inviter.userId],
  );
  return { who, memberId };
}

/**
 * A custom role in the organisation, for a test whose subject is not the role's making: its row at
 * version 1 and its permissions, as `createRole` writes them, as a fixture with the triggers off.
 * It skips the intent, its proof and the re-send: `roleAs`'s three realm units. The permissions are
 * given as `roleAs` would be given them, a set the editor accepts. No role.created event is
 * written; a test that reads it uses `roleAs`.
 */
async function seededRoleBody(
  h: Harness,
  creator: SignedIn,
  orgId: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const roleId = newId("rol", systemClock);
  await seed(
    h.admin,
    `WITH made AS (
       INSERT INTO identity.role (id, organization_id, name, description, created_by, version)
       VALUES ($1, $2, $3, '', $4, 1)
       RETURNING id
     )
     INSERT INTO identity.role_permission (role_id, permission)
     SELECT made.id, unnest($5::text[]) FROM made`,
    [roleId, orgId, name, creator.userId, permissions],
  );
  return roleId;
}

/**
 * Starts the realm and this area's actions before a file's first test, in a `beforeAll` of its own
 * after the one that makes the harness (as @fin/identity's harness does): a person signed in by
 * code and given an authenticator, their first organisation, and one invitation with its intent
 * and proof, all from an address and a browser of their own. A test process's first realm
 * requests pay once for what every later request reuses: the library's context, the code each
 * path runs (compiled on its first call), and the pools' first connections with their server
 * backends' caches. Without this the file's first test carried all of it, whatever it was about.
 * Nothing a test asserts reads this person, their organisation, their invitation or their mail.
 */
async function warmUpBody(h: Harness): Promise<void> {
  const { who, orgId } = await ownerWithOrganization(h, "warm_up");
  const invited = await inviteAs(h, who, orgId, unique("warm_up_invitee"), "admin");
  if (!invited.ok) throw invited.error;
  await h.events({ organizationId: orgId });
  await h.outbox(who.email);
}

/** Makes a custom role in the organisation with an intent, as the actor. */
async function roleAsBody(
  h: Harness,
  actor: SignedIn,
  orgId: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const made = await withIntent(h, actor, (headers) =>
    asActor(
      h,
      actor,
      orgId,
      { body: { name, description: "", permissions }, headers },
      { permission: "role.manage", lock: true, stepUp: { kind: "intent", action: "role.create" } },
      (tx, a) => createRole(h.orgs, tx, a, { name, description: "", permissions }),
    ),
  );
  if (!made.ok) throw made.error;
  return made.value.roleId;
}

/** The team-change actions with their policy options, as the console's routes declare them. */
export const ACT = {
  role: {
    permission: "member.role",
    lock: true,
    stepUp: { kind: "intent", action: "member.role" },
  },
  remove: {
    permission: "member.invite",
    lock: true,
    stepUp: { kind: "intent", action: "member.remove" },
  },
} as const satisfies Record<string, ActorOptions>;

function changeRoleAsBody(
  h: Harness,
  actor: SignedIn,
  orgId: string,
  memberId: string,
  roleKey: string,
  rollCredentials = true,
) {
  return withIntent(h, actor, (headers) =>
    asActor(
      h,
      actor,
      orgId,
      { method: "PATCH", body: { roleKey, rollCredentials }, headers },
      ACT.role,
      (tx, a) => changeMemberRole(h.orgs, tx, a, memberId, { roleKey, rollCredentials }),
    ),
  );
}

function removeAsBody(
  h: Harness,
  actor: SignedIn,
  orgId: string,
  memberId: string,
  rollCredentials = true,
) {
  return withIntent(h, actor, (headers) =>
    asActor(h, actor, orgId, { body: { rollCredentials }, headers }, ACT.remove, (tx, a) =>
      removeMember(h.orgs, tx, a, memberId, { rollCredentials }),
    ),
  );
}

// Measurement only (a throwaway branch, never merged): each db test's time split by the harness
// step it was spent in, one line per test; nested steps are counted inside their callers too.
interface Tally {
  ms: number;
  n: number;
}

const tallies = new Map<string, Tally>();
let depth = 0;
let outer = 0;
let started = 0;

async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
  const top = depth === 0;
  depth += 1;
  const t0 = performance.now();
  try {
    return await run();
  } finally {
    const ms = performance.now() - t0;
    depth -= 1;
    const tally = tallies.get(name) ?? { ms: 0, n: 0 };
    tally.ms += ms;
    tally.n += 1;
    tallies.set(name, tally);
    if (top) outer += ms;
  }
}

function timedAs<A extends unknown[], R>(
  name: string,
  run: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args) => timed(name, () => run(...args));
}

function resetTallies(): void {
  tallies.clear();
  depth = 0;
  outer = 0;
}

function report(label: string, total: number): void {
  const parts = [...tallies.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([name, t]) => `${name}=${Math.round(t.ms)}/${t.n}`)
    .join(" ");
  const sums = `total=${Math.round(total)} own=${Math.round(total - outer)}`;
  // biome-ignore lint/suspicious/noConsole: a throwaway measurement line, never merged
  console.log(`[steps] ${label} | ${sums} | ${parts}`);
  resetTallies();
}

function fileOf(): string {
  return expect.getState().testPath?.split("/").at(-1) ?? "?";
}

beforeEach(() => {
  resetTallies();
  started = performance.now();
});

afterEach(() => {
  if (!(expect.getState().testPath ?? "").includes("packages/orgs/")) return;
  report(`${fileOf()} > ${expect.getState().currentTestName}`, performance.now() - started);
});

export async function warmUp(h: Harness): Promise<void> {
  resetTallies();
  const t0 = performance.now();
  await warmUpBody(h);
  report(`${fileOf()} > warmUp`, performance.now() - t0);
}

const asPersonTimed = timedAs("asPerson", asPersonBody);
const asActorTimed = timedAs("asActor", asActorBody);
const withIntentTimed = timedAs("withIntent", withIntentBody);

export const codeSignIn = timedAs("codeSignIn", codeSignInBody);
export const setUpAuthenticator = timedAs("setUpAuthenticator", setUpAuthenticatorBody);
export const person = timedAs("person", personBody);
export const prove = timedAs("prove", proveBody);
export const asPerson = asPersonTimed as unknown as typeof asPersonBody;
export const asActor = asActorTimed as unknown as typeof asActorBody;
export const withIntent = withIntentTimed as unknown as typeof withIntentBody;
export const ownerWithOrganization = timedAs("ownerWithOrganization", ownerWithOrganizationBody);
export const inviteAs = timedAs("inviteAs", inviteAsBody);
export const acceptAs = timedAs("acceptAs", acceptAsBody);
export const memberOf = timedAs("memberOf", memberOfBody);
export const seededMemberOf = timedAs("seededMemberOf", seededMemberOfBody);
export const seededRole = timedAs("seededRole", seededRoleBody);
export const roleAs = timedAs("roleAs", roleAsBody);
export const changeRoleAs = timedAs("changeRoleAs", changeRoleAsBody);
export const removeAs = timedAs("removeAs", removeAsBody);
