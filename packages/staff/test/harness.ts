// Drives the staff realm the way Fin Admin's API half does, on the real platform (platform.mjs):
// requests to `realm.handler()` for /api/auth/*, and Fin's own staff routes run in `realm.run()`
// with the front door's context (the request ID, the client address, the user agent and the
// verified Access identity). Browsers keep a cookie jar. Secrets, keys and codes are made at run
// time; addresses use example.com only.
import { randomBytes } from "node:crypto";
import {
  type Clock,
  createPgDatabase,
  createRealm,
  MemoryLineSink,
  type PgFinDatabase,
  type Realm,
  type RequestContext,
  readRealmSettings,
  systemClock,
} from "@fin/identity";
import pg, { type Pool } from "pg";
// A test helper of @fin/identity's (not exported by its package): the software authenticator.
import { SoftAuthenticator } from "../../identity/test/webauthn.ts";
import { STAFF_ACTIONS } from "../src/actions.ts";
import { createStaffDeps, type StaffDeps } from "../src/deps.ts";
import { generateEnrolmentCode, hashEnrolmentCode } from "../src/enrolment-codes.ts";
import { newId } from "../src/ids.ts";
import { redeemCode } from "../src/members.ts";
import type { UnitTx } from "../src/ports.ts";
import { requireStaff } from "../src/require-staff.ts";
import { createStaffPlatform, type PlatformClient, type StaffPlatform } from "./platform.mjs";

export { DROP_TIMEOUT_MS } from "./platform.mjs";
export { SoftAuthenticator };

export const ADMIN_ORIGIN = "https://admin.example.com";
export const DOCS_ORIGIN = "https://developer.example.com";

const secret = () => randomBytes(32).toString("base64url");

/** The staff realm's environment for tests (the realm reads `test`; the server reads `ci`). */
export function staffRealmEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    FIN_ENVIRONMENT: "test",
    FIN_PUBLIC_ORIGIN: ADMIN_ORIGIN,
    BETTER_AUTH_SECRETS: `2:${secret()},1:${secret()}`,
    FIN_LIMIT_KEY_1: randomBytes(32).toString("hex"),
    ...overrides,
  };
}

export interface AccessIdentity {
  email: string;
  sub: string;
}

export function accessFor(email: string): AccessIdentity {
  return { email, sub: `sub-${email.replace(/[^a-z0-9]/g, "-")}` };
}

export interface Answer {
  status: number;
  json: Record<string, unknown> | null;
  headers: Headers;
}

export class Browser {
  readonly jar = new Map<string, string>();
  access: AccessIdentity | null;
  readonly ip: string;
  readonly userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  readonly #realm: Realm;

  constructor(realm: Realm, access: AccessIdentity | null) {
    this.#realm = realm;
    this.access = access;
    // Each browser on its own /48 of the documentation prefix, so per-network limits are its own.
    this.ip = `2001:db8:${randomBytes(2).toString("hex")}::1`;
  }

  context(): RequestContext {
    return {
      requestId: newId("req", systemClock),
      clientIp: this.ip,
      userAgent: this.userAgent,
      access: this.access,
    };
  }

  request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = {
      method,
      headers: {
        origin: ADMIN_ORIGIN,
        "user-agent": this.userAgent,
        ...(this.jar.size > 0
          ? { cookie: [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") }
          : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    return new Request(`${ADMIN_ORIGIN}${path}`, init);
  }

  absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0\b/i.test(cookie) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  /** A request to the realm's /api/auth/* handler. */
  async auth(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Answer> {
    const response = await this.#realm.handler(
      this.request(method, `/api/auth${path}`, body, headers),
      this.context(),
    );
    this.absorb(response);
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      json = null;
    }
    return { status: response.status, json, headers: response.headers };
  }

  sessionToken(): string | null {
    const raw = this.jar.get("__Host-fin-admin.session_token");
    if (raw === undefined) return null;
    const decoded = decodeURIComponent(raw);
    return decoded.slice(0, decoded.lastIndexOf("."));
  }
}

export interface StaffHarness {
  platform: StaffPlatform;
  realm: Realm;
  deps: StaffDeps;
  db: PgFinDatabase;
  lines: MemoryLineSink;
  admin: PlatformClient;
  pools: Pool[];
  browser(access?: AccessIdentity | null): Browser;
  login(login: string, max?: number): Pool;
  /** Seeds a member row with the guards off (fixtures only). */
  seedMember(
    email: string,
    roleKey: string,
    status: "pending" | "active" | "removed",
  ): Promise<string>;
  /** Runs fixture SQL as the superuser with triggers (the audit guards) off. */
  fixture(text: string, values?: readonly unknown[]): Promise<void>;
  /**
   * Seeds a custom staff role with the guards off (the routes that write them are stretch 3);
   * returns its `srl_` ID.
   */
  seedCustomRole(name: string, permissions: readonly string[]): Promise<string>;
  /** Issues an enrolment code with the operator as actor; returns the code. */
  issueCode(memberId: string): Promise<string>;
  /** The newest sign-in code emailed to an address. */
  latestCode(email: string): Promise<string | null>;
  /** A pending member that signs in by code and redeems the code: an aal1 session. */
  pendingSession(email: string, roleKey: string): Promise<{ staffId: string; browser: Browser }>;
  /** An active member at aal2 with a passkey, through the real ceremonies. */
  enrolled(
    email: string,
    roleKey: string,
  ): Promise<{ staffId: string; browser: Browser; authenticator: SoftAuthenticator }>;
  /** Proves an intent with a passkey ceremony in this browser (the session is replaced). */
  prove(browser: Browser, authenticator: SoftAuthenticator, intentId: string): Promise<Answer>;
  /** Runs a staff route's work as the API half does: in the realm's unit of work. */
  route<T>(
    browser: Browser,
    request: { method: string; path: string; body?: unknown; intent?: string },
    fn: (tx: UnitTx, request: Request, context: RequestContext) => Promise<T>,
  ): Promise<T>;
  events(event?: string): Promise<AuditRow[]>;
  outbox(
    template?: string,
  ): Promise<{ template: string; recipient: string; params: Record<string, unknown> }[]>;
  close(): Promise<void>;
}

export interface AuditRow {
  id: string;
  event: string;
  target_id: string;
  ref_ids: string[];
  metadata: Record<string, unknown>;
  actor_kind: string;
  actor_id: string | null;
  actor_via: string;
  step_up_kind: string | null;
  step_up_ref: string | null;
  request_id: string | null;
  db_login: string;
}

export const unique = (label: string) => `${label}.${randomBytes(4).toString("hex")}@example.com`;

export async function createStaffHarness(
  prefix: string,
  options: { env?: Record<string, string | undefined>; clock?: Clock } = {},
): Promise<StaffHarness> {
  const platform = await createStaffPlatform(prefix);
  const admin = await platform.superuser();
  const pools: Pool[] = [];
  const login = (name: string, max = 6) => {
    const pool = new pg.Pool({
      host: platform.host,
      port: platform.port,
      database: platform.name,
      user: name,
      password: platform.password(name),
      max,
      application_name: "staff-tests",
    });
    pool.on("error", () => undefined);
    pools.push(pool);
    return pool;
  };
  const clock = options.clock ?? systemClock;
  const lines = new MemoryLineSink();
  const db = createPgDatabase({ pool: login("fin_admin_a"), clock, release: "test", lines });
  const settings = readRealmSettings("staff", staffRealmEnv(options.env));
  const realm = createRealm({
    settings,
    db,
    clock,
    lines,
    docsOrigin: DOCS_ORIGIN,
    actions: [STAFF_ACTIONS],
  });
  const deps = createStaffDeps({ realm, clock, lines, environment: settings.environment });

  const h: StaffHarness = {
    platform,
    realm,
    deps,
    db,
    lines,
    admin,
    pools,
    login,
    browser: (access = null) => new Browser(realm, access),
    async seedMember(email, roleKey, status) {
      const id = newId("stf", clock);
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(
          `INSERT INTO staff.member (id, email, role_key, status, added_by, factor_enrolled_at, removed_at)
           VALUES ($1, $2, $3, $4, 'operator',
                   CASE WHEN $4 = 'active' THEN now() END, CASE WHEN $4 = 'removed' THEN now() END)`,
          [id, email, roleKey, status],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      return id;
    },
    async fixture(text, values = []) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(text, values);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    },
    async seedCustomRole(name, permissions) {
      const id = newId("stf", clock).replace(/^stf_/, "srl_");
      const creator = newId("stf", clock);
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(
          "INSERT INTO staff.role (id, name, description, created_by) VALUES ($1, $2, '', $3)",
          [id, name, creator],
        );
        for (const permission of permissions) {
          await admin.query(
            "INSERT INTO staff.role_permission (role_id, permission) VALUES ($1, $2)",
            [id, permission],
          );
        }
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      return id;
    },
    async issueCode(memberId) {
      const code = generateEnrolmentCode();
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(
          `UPDATE staff.enrolment_code SET voided_at = now()
            WHERE member_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL`,
          [memberId],
        );
        await admin.query(
          `INSERT INTO staff.enrolment_code (id, member_id, code_hash, reason, issued_by, issued_at, expires_at)
           VALUES ($1, $2, $3, 'added', 'operator', now(), now() + interval '30 minutes')`,
          [newId("enc", clock), memberId, hashEnrolmentCode(code)],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      return code;
    },
    async latestCode(email) {
      const result = await admin.query<{ code: string }>(
        `SELECT params ->> 'code' AS code FROM email_private.outbox
          WHERE recipient = $1 AND params ? 'code' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [email.toLowerCase()],
      );
      return result.rows[0]?.code ?? null;
    },
    async pendingSession(email, roleKey) {
      const staffId = await h.seedMember(email, roleKey, "pending");
      const code = await h.issueCode(staffId);
      const browser = h.browser(accessFor(email));
      await signInByCode(h, browser, email);
      const redeemed = await h.route(
        browser,
        { method: "POST", path: "/api/enrolment/redeem", body: { code } },
        async (tx, request, context) => {
          const who = await requireStaff(realm, request, context, { reach: ["pending"] });
          return redeemCode(deps, tx, who, code);
        },
      );
      if (!redeemed.ok) throw new Error(`the enrolment code was refused: ${redeemed.reason}`);
      return { staffId, browser };
    },
    async enrolled(email, roleKey) {
      const { staffId, browser } = await h.pendingSession(email, roleKey);
      const authenticator = new SoftAuthenticator(settings.rpId, settings.publicOrigin);
      const options = await browser.auth("GET", "/passkey/generate-register-options");
      if (options.status !== 200) throw new Error(`register options: ${options.status}`);
      const response = authenticator.register(
        options.json as { challenge: string; user: { id: string } },
      );
      const verified = await browser.auth("POST", "/passkey/verify-registration", { response });
      if (verified.status !== 200) {
        throw new Error(`registration: ${verified.status} ${JSON.stringify(verified.json)}`);
      }
      return { staffId, browser, authenticator };
    },
    async prove(browser, authenticator, intentId) {
      const challenge = await browser.auth("GET", "/passkey/generate-authenticate-options");
      if (challenge.status !== 200) return challenge;
      const response = authenticator.authenticate(String(challenge.json?.challenge));
      return browser.auth(
        "POST",
        "/passkey/verify-authentication",
        { response },
        { "fin-step-up-intent": intentId },
      );
    },
    async route(browser, request, fn) {
      const headers: Record<string, string> = { "x-fin-app": "admin" };
      if (request.intent !== undefined) headers["fin-step-up-intent"] = request.intent;
      const req = browser.request(request.method, request.path, request.body, headers);
      const context = browser.context();
      return realm.run(context, (tx) => fn(tx, req, context));
    },
    async events(event) {
      const result = await admin.query<AuditRow>(
        `SELECT id, event, target_id, ref_ids, metadata, actor_kind, actor_id, actor_via, step_up_kind,
                step_up_ref, request_id, db_login
           FROM audit.event WHERE ($1::text IS NULL OR event = $1) ORDER BY recorded_at, id`,
        [event ?? null],
      );
      return result.rows;
    },
    async outbox(template) {
      const result = await admin.query<{
        template: string;
        recipient: string;
        params: Record<string, unknown>;
      }>(
        `SELECT template, recipient, params FROM email_private.outbox
          WHERE ($1::text IS NULL OR template = $1) ORDER BY created_at, id`,
        [template ?? null],
      );
      return result.rows;
    },
    async close() {
      await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
      await admin.end().catch(() => undefined);
      await platform.drop();
    },
  };
  return h;
}

/**
 * Runs a stepped-up staff route the way the client does (§7.1): the first try answers
 * `step_up_required` with an intent, a passkey ceremony proves it, and the request is sent again
 * once with the intent. Any other refusal of the first try is thrown as it came.
 */
export async function stepped<T>(
  h: StaffHarness,
  browser: Browser,
  authenticator: SoftAuthenticator,
  request: { method: string; path: string; body?: unknown },
  fn: (tx: UnitTx, request: Request, context: RequestContext) => Promise<T>,
): Promise<T> {
  let intent: string;
  try {
    await h.route(browser, request, fn);
    throw new Error("the route asked for no intent");
  } catch (error) {
    const extensions = error as { code?: string; extensions?: { intent_id?: string } };
    if (extensions.code !== "step_up_required" || extensions.extensions?.intent_id === undefined) {
      throw error;
    }
    intent = extensions.extensions.intent_id;
  }
  const proved = await h.prove(browser, authenticator, intent);
  if (proved.status !== 200) throw new Error(`the ceremony answered ${proved.status}`);
  return h.route(browser, { ...request, intent }, fn);
}

/** The refusal a route threw, as `{ code, extensions }`, or a marker when it did not refuse. */
export async function refusalOf(run: Promise<unknown>): Promise<{
  code: string;
  extensions: Record<string, unknown>;
}> {
  try {
    await run;
  } catch (error) {
    const e = error as { code?: unknown; extensions?: Record<string, unknown> };
    if (typeof e.code === "string") return { code: e.code, extensions: e.extensions ?? {} };
    throw error;
  }
  return { code: "none", extensions: {} };
}

/** Asks a sign-in code and signs in with it, from this browser (an aal1 staff session). */
export async function signInByCode(
  h: StaffHarness,
  browser: Browser,
  email: string,
): Promise<Answer> {
  const sent = await browser.auth("POST", "/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  if (sent.status !== 200) throw new Error(`code request answered ${sent.status}`);
  const code = await h.latestCode(email);
  if (code === null) throw new Error("no code was queued");
  const signedIn = await browser.auth("POST", "/sign-in/email-otp", { email, otp: code });
  if (signedIn.status !== 200) {
    throw new Error(`code sign-in answered ${signedIn.status}: ${JSON.stringify(signedIn.json)}`);
  }
  return signedIn;
}
