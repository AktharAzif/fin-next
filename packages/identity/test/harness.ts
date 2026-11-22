// Drives a realm the way the API half would: a Request to `realm.handler()` with the front
// door's context (the request ID, the client address, the user agent and, for staff, the Access
// identity), and a browser-like cookie jar. Secrets and keys are made at run time; addresses use
// example.com only.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { type RealmName, readRealmSettings } from "../src/config.ts";
import { base32Decode, totp } from "../src/crypto/totp.ts";
import { type Clock, systemClock } from "../src/ports/clock.ts";
import { newId } from "../src/ports/ids.ts";
import { MemoryLineSink } from "../src/ports/log.ts";
import { createPgDatabase, type PgFinDatabase } from "../src/ports/pg-database.ts";
import { createRealm, type Realm, type RealmDeps } from "../src/realm.ts";
import type { RequestContext } from "../src/request.ts";
import type { TestDatabase } from "./db.ts";
import { mark, report, timedRequest } from "./split.ts";
import { SoftAuthenticator } from "./webauthn.ts";

export const ORIGIN: Readonly<Record<RealmName, string>> = {
  developer: "https://console.example.com",
  staff: "https://admin.example.com",
};
export const DOCS_ORIGIN = "https://developer.example.com";

const secret = () => randomBytes(32).toString("base64url");

export function testEnv(realm: RealmName, overrides: Record<string, string | undefined> = {}) {
  return {
    FIN_ENVIRONMENT: "test",
    FIN_PUBLIC_ORIGIN: ORIGIN[realm],
    BETTER_AUTH_SECRETS: `2:${secret()},1:${secret()}`,
    FIN_LIMIT_KEY_1: randomBytes(32).toString("hex"),
    ...overrides,
  };
}

export interface Harness {
  realm: Realm;
  db: PgFinDatabase;
  pool: Pool;
  lines: MemoryLineSink;
  admin: Pool;
  browser(options?: BrowserOptions): Browser;
  authenticator(): SoftAuthenticator;
  /** The newest code emailed to an address (the outbox row's `code` parameter). */
  latestCode(email: string): Promise<string | null>;
  outbox(
    email?: string,
  ): Promise<{ template: string; recipient: string; params: Record<string, unknown> }[]>;
  events(filter?: { event?: string }): Promise<AuditRow[]>;
}

export interface AuditRow {
  event: string;
  target_id: string;
  ref_ids: string[];
  metadata: Record<string, unknown>;
  actor_kind: string;
  actor_id: string | null;
  step_up_ref: string | null;
}

export interface BrowserOptions {
  ip?: string;
  userAgent?: string;
  access?: { email: string; sub: string } | null;
}

export interface Answer {
  status: number;
  json: Record<string, unknown> | null;
  headers: Headers;
  setCookies: string[];
}

export class Browser {
  readonly jar = new Map<string, string>();
  readonly #h: { realm: Realm };
  readonly options: Required<BrowserOptions>;

  constructor(h: { realm: Realm }, options: BrowserOptions = {}) {
    this.#h = h;
    this.options = {
      // Each browser on its own /48 of the documentation prefix, so per-network limits are its own.
      ip: options.ip ?? `2001:db8:${randomBytes(2).toString("hex")}::1`,
      userAgent:
        options.userAgent ??
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      access: options.access ?? null,
    };
  }

  cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  context(): RequestContext {
    return {
      requestId: newId("req", systemClock),
      clientIp: this.options.ip,
      userAgent: this.options.userAgent,
      access: this.options.access,
    };
  }

  request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Request {
    const origin = this.#h.realm.settings.publicOrigin;
    const init: RequestInit = {
      method,
      headers: {
        origin,
        "user-agent": this.options.userAgent,
        "cf-connecting-ip": this.options.ip,
        ...(this.jar.size > 0 ? { cookie: this.cookieHeader() } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    return new Request(`${origin}${path}`, init);
  }

  absorb(response: Response): string[] {
    const cookies = response.headers.getSetCookie();
    for (const cookie of cookies) {
      const [pair = ""] = cookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0\b/i.test(cookie) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return cookies;
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Answer> {
    const response = await timedRequest(method, path, () =>
      this.#h.realm.handler(this.request(method, path, body, headers), this.context()),
    );
    const setCookies = this.absorb(response);
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      json = null;
    }
    return { status: response.status, json, headers: response.headers, setCookies };
  }

  get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
    return this.call("GET", path, undefined, headers);
  }

  post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    return this.call("POST", path, body, headers);
  }

  sessionToken(): string | null {
    const prefix = this.#h.realm.settings.cookiePrefix;
    const raw = this.jar.get(`${prefix}.session_token`);
    if (raw === undefined) return null;
    const decoded = decodeURIComponent(raw);
    return decoded.slice(0, decoded.lastIndexOf("."));
  }
}

export async function createHarness(
  database: TestDatabase,
  realmName: RealmName,
  options: {
    env?: Record<string, string | undefined>;
    clock?: Clock;
    deps?: Partial<RealmDeps>;
  } = {},
): Promise<Harness> {
  const role = realmName === "developer" ? "fin_console" : "fin_admin";
  const pool = database.login(role);
  const lines = new MemoryLineSink();
  const clock = options.clock ?? systemClock;
  const db = createPgDatabase({ pool, clock, release: "test", lines });
  const settings = readRealmSettings(realmName, testEnv(realmName, options.env));
  const realm = createRealm({
    settings,
    db,
    clock,
    lines,
    docsOrigin: DOCS_ORIGIN,
    ...options.deps,
  });
  const h: Harness = {
    realm,
    db,
    pool,
    lines,
    admin: database.admin,
    browser: (browserOptions) => new Browser({ realm }, browserOptions),
    authenticator: () => new SoftAuthenticator(settings.rpId, settings.publicOrigin),
    async latestCode(email) {
      const result = await database.admin.query<{ code: string }>(
        `SELECT params ->> 'code' AS code FROM email_private.outbox
          WHERE recipient = $1 AND params ? 'code' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [email.toLowerCase()],
      );
      return result.rows[0]?.code ?? null;
    },
    async outbox(email) {
      const result = await database.admin.query<{
        template: string;
        recipient: string;
        params: Record<string, unknown>;
      }>(
        `SELECT template, recipient, params FROM email_private.outbox
          WHERE ($1::text IS NULL OR recipient = $1) ORDER BY created_at, id`,
        [email ?? null],
      );
      return result.rows;
    },
    async events(filter = {}) {
      const result = await database.admin.query<AuditRow>(
        `SELECT event, target_id, ref_ids, metadata, actor_kind, actor_id, step_up_ref FROM audit.event
          WHERE ($1::text IS NULL OR event = $1) ORDER BY recorded_at, id`,
        [filter.event ?? null],
      );
      return result.rows;
    },
  };
  return h;
}

/** Asks a code and signs in with it, from this browser. */
export async function codeSignIn(h: Harness, browser: Browser, email: string): Promise<Answer> {
  const sent = await browser.post("/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  if (sent.status !== 200) throw new Error(`code request answered ${sent.status}`);
  const code = await h.latestCode(email);
  if (code === null) throw new Error("no code was queued");
  return browser.post("/api/auth/sign-in/email-otp", { email, otp: code });
}

/**
 * Starts a developer realm before a file's first test, in a `beforeAll` of its own after the one
 * that made the harness: a code sign-in and an authenticator set-up for an address of its own, from
 * a browser (and so a network) of its own, then the harness's own reads. A test process's first
 * realm requests pay once for what every later request reuses: the library's context, the code
 * each path runs (compiled on its first call), and the pools' first connections with their
 * server backends' caches. Without this the file's first test carried all of it, whatever it was
 * about. Nothing a test asserts reads this person, its rows or its lines: a test that reads every
 * row of a kind keeps its own person's, and a file with an assertion that any row of a kind the
 * warm-up writes exists (pins.db.test.ts' user.created) does not warm up.
 */
export async function warmUp(h: Harness): Promise<void> {
  if (h.realm.settings.realm !== "developer") throw new Error("warmUp starts a developer realm");
  const started = mark();
  const browser = h.browser();
  const email = `warm.up.${randomBytes(4).toString("hex")}@example.com`;
  const signedIn = await codeSignIn(h, browser, email);
  if (signedIn.status !== 200) throw new Error(`the warm-up sign-in answered ${signedIn.status}`);
  const { verify } = await setUpAuthenticator(browser);
  if (verify.status !== 200) throw new Error(`the warm-up set-up answered ${verify.status}`);
  await h.events();
  await h.outbox(email);
  report("(warm-up)", started);
}

/** The secret bytes of an `otpauth://` URI, and a code for now. */
export function totpFromUri(
  uri: string,
  at: Date = new Date(),
): { secret: Uint8Array; code: string } {
  const secretParam = new URL(uri).searchParams.get("secret");
  if (secretParam === null) throw new Error("the URI has no secret");
  const secretBytes = base32Decode(secretParam);
  return { secret: secretBytes, code: totp(secretBytes, at) };
}

/** Sets up an authenticator in this browser's session and finishes it. */
export async function setUpAuthenticator(
  browser: Browser,
  headers: Record<string, string> = {},
): Promise<{ secret: Uint8Array; backupCodes: string[]; enable: Answer; verify: Answer }> {
  const enable = await browser.post("/api/auth/two-factor/enable", {}, headers);
  if (enable.status !== 200)
    throw new Error(`enable answered ${enable.status}: ${JSON.stringify(enable.json)}`);
  const { secret: secretBytes, code } = totpFromUri(String(enable.json?.totpURI));
  const verify = await browser.post("/api/auth/two-factor/verify-totp", { code });
  return {
    secret: secretBytes,
    backupCodes: (enable.json?.backupCodes as string[] | undefined) ?? [],
    enable,
    verify,
  };
}

/** Registers a passkey in this browser's session. */
export async function registerPasskey(
  browser: Browser,
  authenticator: SoftAuthenticator,
  headers: Record<string, string> = {},
): Promise<{ options: Answer; verify: Answer }> {
  const options = await browser.get("/api/auth/passkey/generate-register-options", headers);
  if (options.status !== 200) return { options, verify: options };
  const response = authenticator.register(
    options.json as { challenge: string; user: { id: string } },
  );
  const verify = await browser.post("/api/auth/passkey/verify-registration", { response }, headers);
  return { options, verify };
}

/** Signs in (or steps up) with a passkey from this browser. */
export async function passkeyCeremony(
  browser: Browser,
  authenticator: SoftAuthenticator,
  headers: Record<string, string> = {},
  options: { counter?: number } = {},
): Promise<Answer> {
  const challenge = await browser.get("/api/auth/passkey/generate-authenticate-options");
  if (challenge.status !== 200) return challenge;
  const response = authenticator.authenticate(String(challenge.json?.challenge), options);
  return browser.post("/api/auth/passkey/verify-authentication", { response }, headers);
}
