// A stand-in for Fin Admin's API half (test target only), so the Saturday journeys run against the
// built app on the static host, behind the Access stand-in, before the real admin API test server
// exists (L-SAT-07's server half and L-SAT-04's staff package are not on this lane's base). It keeps
// the contract the screens are written against: spec 02 §14.3's routes and §4.3's allowlisted realm
// endpoints, with the rules that decide what a screen shows:
//   - the front door (§2.2): the ingress proof, the Access JWT checked against the stand-in's keys
//     on every request, and the origin gate on every unsafe request (exact Origin, Sec-Fetch-Site,
//     `X-Fin-App: admin`, JSON bodies only);
//   - host-only `__Host-` cookies, the session `SameSite=Strict`;
//   - the staff gate (§6.4): no session, `pending`, `factor_step` (aal1) and `ok` (aal2), with only
//     the viewer and the enrolment code reachable below aal2;
//   - emailed codes (8 digits, 10 minutes, 3 tries) to the email sink, only for an eligible address
//     that equals the Access identity, and the same answer always;
//   - enrolment codes (§6.5), passkeys (checked as a relying party), TOTP (RFC 6238, no reuse of a
//     step), step-up intents bound to the action and its parameters (§7), and §8.5's rules, the last
//     Admin included.
// Everything lives in memory and is reset between tests through the control port; every important
// action appends an audit event the journeys can read back. When the real test server lands, the
// journeys run against it unchanged (FIN_E2E_ADMIN_API=external) and this file goes.
import { createHash, randomBytes } from "node:crypto";
import { base32Encode, decodeToken, totp, totpCounter, verifyRs256 } from "@fin/testing";
import {
  assertionChallenge,
  assertionCredentialId,
  type RegisteredPasskey,
  toBase64Url,
  verifyAssertion,
  verifyRegistration,
} from "./webauthn.ts";

// ── Configuration ────────────────────────────────────────────────────────────────────────────

export interface AdminApiOptions {
  /** The app host's origin as the browser sees it (https://admin.localhost:<port>). */
  readonly appOrigin: string;
  /** The ingress proof the static host sends as `Fin-Ingress-Proof`. */
  readonly ingressProof: string;
  /** Where the Access stand-in serves its keys, and the issuer and audience it signs. */
  readonly accessCertsUrl: string;
  readonly accessIssuer: string;
  readonly accessAudience: string;
  /** The email sink's origin (http://127.0.0.1:<port>). */
  readonly emailSink: string;
  /** The run's clock (FIN_E2E_CLOCK), in ms; the control port can move it forward. */
  readonly now: () => number;
  readonly environment: "staging" | "production" | "development";
  readonly fetch?: typeof fetch;
}

// ── Catalogue (spec 02 §8.3) ─────────────────────────────────────────────────────────────────

const READS = [
  "golive.read",
  "customers.read",
  "rfis.read",
  "organisations.read",
  "money.read",
  "audit.read",
  "staff.read",
];
const COMPLIANCE = [
  ...READS,
  "customers.reveal",
  "documents.view",
  "customers.decide",
  "rfis.manage",
  "forms.manage",
  "golive.decide",
  "views.manage",
];
const OPERATOR = [
  ...COMPLIANCE,
  "organisations.pause",
  "organisations.approvals",
  "switches.manage",
];
const ADMIN = [
  ...OPERATOR,
  "accounts.recover",
  "money.operate",
  "reasons.manage",
  "templates.manage",
  "staff.add",
  "staff.remove",
  "staff.role",
  "staff.reset_factors",
  "staffRoles.manage",
];

interface Role {
  readonly key: string;
  readonly label: string;
  readonly summary: string;
  readonly permissions: readonly string[];
}

const ROLES: readonly Role[] = [
  {
    key: "viewer",
    label: "Viewer",
    summary:
      "Sees everything in Fin Admin except personal details and documents, and changes nothing.",
    permissions: READS,
  },
  {
    key: "compliance",
    label: "Compliance",
    summary:
      "Reviews and decides customers and Production access requests, handles requests for information and forms, and sees personal details and documents.",
    permissions: COMPLIANCE,
  },
  {
    key: "operator",
    label: "Operator",
    summary:
      "Does everything Compliance does, pauses and restores Production access, changes customer approvals and uses the kill switches.",
    permissions: OPERATOR,
  },
  {
    key: "admin",
    label: "Admin",
    summary: "Does everything, including staff, staff roles, reasons and message templates.",
    permissions: ADMIN,
  },
];

const roleOf = (key: string) => ROLES.find((role) => role.key === key);

// ── State ────────────────────────────────────────────────────────────────────────────────────

interface Passkey extends RegisteredPasskey {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  lastUsedAt: number | null;
  counter: number;
}

interface Member {
  readonly id: string;
  readonly email: string;
  roleKey: string;
  status: "pending" | "active" | "removed";
  lastSignedInAt: number | null;
  passkeys: Passkey[];
  totp: { secret: string; enabled: boolean; enabledAt: number | null; lastStep: bigint } | null;
  wrongCodes: number;
}

interface Session {
  readonly id: string;
  token: string;
  readonly memberId: string;
  readonly accessSub: string;
  assurance: "aal1" | "aal2";
  readonly createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  enrolmentOpenUntil: number | null;
  stepUpFailures: number;
  lastProofAt: number | null;
  readonly device: string;
}

interface Intent {
  readonly id: string;
  readonly sessionId: string;
  readonly memberId: string;
  readonly action: string;
  readonly digest: string;
  readonly reasonKey: string;
  readonly expiresAt: number;
  provedAt: number | null;
  consumedAt: number | null;
}

interface EmailCode {
  readonly code: string;
  readonly expiresAt: number;
  tries: number;
}

interface EnrolmentCode {
  readonly id: string;
  readonly hash: string;
  readonly expiresAt: number;
  redeemedAt: number | null;
  voidedAt: number | null;
  failedTries: number;
}

interface Challenge {
  readonly kind: "get" | "create";
  readonly expiresAt: number;
  readonly sessionId: string | null;
}

export interface AuditEvent {
  /** An `aud_` ID in recording order (the audit log screen pages by it). */
  readonly id: string;
  readonly event: string;
  readonly actor: string;
  readonly target: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly at: string;
}

/** A key from the Access certs endpoint. */
type Jwk = { readonly [key: string]: unknown };

const MINUTE = 60_000;
const SESSION_COOKIE = "__Host-fin.admin_session";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * An `aud_` ID as the real log's: 10 characters of milliseconds, then the event's place in the
 * trail (so two events in one millisecond keep their order), then randomness.
 */
function auditId(ms: number, place: number): string {
  const alphabet = CROCKFORD.toLowerCase();
  const encode = (value: number, width: number) => {
    let out = "";
    let rest = value;
    for (let i = 0; i < width; i += 1) {
      out = (alphabet[rest % 32] as string) + out;
      rest = Math.floor(rest / 32);
    }
    return out;
  };
  let random = "";
  for (const byte of randomBytes(10)) random += alphabet[byte % 32];
  return `aud_${encode(ms, 10)}${encode(place, 6)}${random}`;
}

/** What the stand-in keeps that the real log writes as lines, not audit rows (spec 02 §16.4). */
const NOT_AUDIT_ROWS: ReadonlySet<string> = new Set([
  "staff.access_mismatch",
  "staff.not_listed",
  "staff.enrolment_refused",
]);

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

function digits(n: number): string {
  let out = "";
  while (out.length < n) {
    const byte = randomBytes(1)[0] as number;
    if (byte < 250) out += String(byte % 10);
  }
  return out;
}

function enrolmentCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31];
    }
  }
  return out.match(/.{4}/g)?.join("-") ?? out;
}

function normaliseEnrolment(input: string): string | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(clean) ? clean : null;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** RFC 8785-style canonical JSON for plain objects of strings (spec 02 §7.2). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function deviceOf(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "A browser";
  const os = /Mac OS X|Macintosh/.test(ua)
    ? "Mac"
    : /Windows/.test(ua)
      ? "Windows"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "a computer";
  return `${browser} on ${os}`;
}

// ── Answers ──────────────────────────────────────────────────────────────────────────────────

const PROBLEM_STATUS: Readonly<Record<string, number>> = {
  unauthenticated: 401,
  access_required: 401,
  factor_step_required: 403,
  second_factor_required: 403,
  step_up_required: 403,
  step_up_invalid: 403,
  forbidden: 403,
  outranked: 403,
  giving_refused: 403,
  invalid_origin: 403,
  access_mismatch: 403,
  not_found: 404,
  invalid: 400,
  last_top_role: 409,
  last_factor: 409,
  already_staff: 409,
  conflict: 409,
  rate_limited: 429,
  access_unavailable: 503,
};

interface Answer {
  readonly status: number;
  readonly body?: unknown;
  readonly problem?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: readonly string[];
}

function problem(code: string, extensions: Record<string, unknown> = {}): Answer {
  const status = PROBLEM_STATUS[code] ?? 500;
  return {
    status,
    problem: true,
    body: {
      type: `https://docs.localhost/errors/${code}`,
      title: code.replaceAll("_", " "),
      status,
      code,
      request_id: `req_${randomBytes(6).toString("hex")}`,
      ...extensions,
    },
    ...(code === "rate_limited" && typeof extensions.retry_after === "number"
      ? { headers: { "Retry-After": String(extensions.retry_after) } }
      : {}),
  };
}

/** The library's own refusal (`{ code, message }`). */
function library(status: number, code: string): Answer {
  return { status, body: { code, message: code.toLowerCase().replaceAll("_", " ") } };
}

const ok = (body: unknown, status = 200, cookies?: readonly string[]): Answer => ({
  status,
  body,
  ...(cookies === undefined ? {} : { cookies }),
});

function toResponse(answer: Answer): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Fin-Release": "e2e-release",
    ...(answer.headers ?? {}),
  });
  for (const cookie of answer.cookies ?? []) headers.append("Set-Cookie", cookie);
  if (answer.status === 204 || answer.body === undefined) {
    return new Response(null, { status: answer.status === 200 ? 204 : answer.status, headers });
  }
  headers.set(
    "Content-Type",
    answer.problem === true ? "application/problem+json" : "application/json",
  );
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers });
}

// ── The request ──────────────────────────────────────────────────────────────────────────────

export interface ApiRequest {
  readonly method: string;
  readonly target: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: ReadableStream<Uint8Array> | null;
}

function header(request: ApiRequest, name: string): string | undefined {
  const lower = name.toLowerCase();
  let found: string | undefined;
  for (const [key, value] of request.headers) if (key.toLowerCase() === lower) found = value;
  return found;
}

function cookie(request: ApiRequest, name: string): string | undefined {
  for (const [key, value] of request.headers) {
    if (key.toLowerCase() !== "cookie") continue;
    for (const part of value.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === name) return rest.join("=");
    }
  }
  return undefined;
}

interface Identity {
  readonly email: string;
  readonly sub: string;
}

interface Context {
  readonly request: ApiRequest;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly identity: Identity;
  readonly session: Session | null;
  readonly member: Member | null;
  readonly intentHeader: string | undefined;
}

// ── The stand-in ─────────────────────────────────────────────────────────────────────────────

export class AdminApiStandIn {
  readonly #options: AdminApiOptions;
  readonly #rpId: string;
  #offsetMs = 0;
  #keys: Jwk[] = [];
  members = new Map<string, Member>();
  sessions = new Map<string, Session>();
  ended = new Map<string, string>();
  intents = new Map<string, Intent>();
  emailCodes = new Map<string, EmailCode>();
  codeRequests = new Map<string, number[]>();
  enrolmentCodes = new Map<string, EnrolmentCode>();
  challenges = new Map<string, Challenge>();
  audit: AuditEvent[] = [];

  constructor(options: AdminApiOptions) {
    this.#options = options;
    this.#rpId = new URL(options.appOrigin).hostname;
  }

  now(): number {
    return this.#options.now() + this.#offsetMs;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error("the clock moves forward only");
    this.#offsetMs += ms;
  }

  reset(): void {
    this.members.clear();
    this.sessions.clear();
    this.ended.clear();
    this.intents.clear();
    this.emailCodes.clear();
    this.codeRequests.clear();
    this.enrolmentCodes.clear();
    this.challenges.clear();
    this.audit = [];
    this.#offsetMs = 0;
  }

  #record(
    event: string,
    actor: string,
    target: string | null,
    metadata: Record<string, unknown> = {},
  ) {
    this.audit.push({
      id: auditId(this.now(), this.audit.length),
      event,
      actor,
      target,
      metadata,
      at: new Date(this.now()).toISOString(),
    });
  }

  // ── Control (test only, on its own loopback port) ──

  /**
   * `pnpm fin task <env> staff-bootstrap`: the first Admin, pending, and the code once (§10.6). It
   * inserts or reactivates the member, so running it again for a pending address makes a new code.
   */
  bootstrap(email: string): { staffId: string; enrolmentCode: string } {
    const address = email.toLowerCase();
    const activeAdmin = [...this.members.values()].some(
      (m) => m.roleKey === "admin" && m.status === "active",
    );
    if (activeAdmin) throw new Error("an active Admin exists");
    const existing = [...this.members.values()].find((m) => m.email === address);
    if (existing !== undefined) {
      existing.roleKey = "admin";
      existing.status = "pending";
      existing.passkeys = [];
      existing.totp = null;
      this.#record("staff.bootstrapped", "operator", existing.id, { reset: true });
      return {
        staffId: existing.id,
        enrolmentCode: this.#issueCode(existing, "bootstrap", "operator"),
      };
    }
    const member: Member = {
      id: newId("stf"),
      email: address,
      roleKey: "admin",
      status: "pending",
      lastSignedInAt: null,
      passkeys: [],
      totp: null,
      wrongCodes: 0,
    };
    this.members.set(member.id, member);
    this.#record("staff.bootstrapped", "operator", member.id, { reset: false });
    return { staffId: member.id, enrolmentCode: this.#issueCode(member, "bootstrap", "operator") };
  }

  #issueCode(member: Member, reason: string, actor: string): string {
    const code = enrolmentCode();
    const id = newId("enc");
    this.enrolmentCodes.set(member.id, {
      id,
      hash: sha256(normaliseEnrolment(code) as string),
      expiresAt: this.now() + 30 * MINUTE,
      redeemedAt: null,
      voidedAt: null,
      failedTries: 0,
    });
    this.#record("staff.enrolment_code_issued", actor, id, { reason, refs: [member.id] });
    return code;
  }

  // ── The front door (§2.2) ──

  async #identity(request: ApiRequest): Promise<Identity | "missing" | "invalid"> {
    const token = header(request, "Cf-Access-Jwt-Assertion");
    if (token === undefined || token === "") return "missing";
    let decoded: ReturnType<typeof decodeToken>;
    try {
      decoded = decodeToken(token);
    } catch {
      return "invalid";
    }
    if (decoded.header.alg !== "RS256") return "invalid";
    let key = this.#keys.find((k) => k.kid === decoded.header.kid);
    if (key === undefined) {
      const answer = await (this.#options.fetch ?? fetch)(this.#options.accessCertsUrl);
      this.#keys = ((await answer.json()) as { keys: Jwk[] }).keys;
      key = this.#keys.find((k) => k.kid === decoded.header.kid);
    }
    if (key === undefined || !verifyRs256(decoded, key)) return "invalid";
    const p = decoded.payload;
    const now = Math.floor(this.now() / 1000);
    const audiences = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (
      p.iss !== this.#options.accessIssuer ||
      !audiences.includes(this.#options.accessAudience) ||
      p.type !== "app" ||
      typeof p.exp !== "number" ||
      p.exp + 60 < now ||
      typeof p.nbf !== "number" ||
      p.nbf - 60 > now ||
      typeof p.email !== "string" ||
      typeof p.sub !== "string"
    ) {
      return "invalid";
    }
    return { email: p.email.toLowerCase(), sub: p.sub };
  }

  /** The origin gate (§2.3), before any handler. */
  #originRefusal(request: ApiRequest, hasBody: boolean): string | null {
    if (request.method === "GET" || request.method === "HEAD") return null;
    if (header(request, "Origin") !== this.#options.appOrigin) return "origin";
    const site = header(request, "Sec-Fetch-Site");
    if (site !== undefined && site !== "same-origin") return "fetch_site";
    if (header(request, "X-Fin-App") !== "admin") return "app_header";
    if (hasBody) {
      const type = (header(request, "Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") return "content_type";
    }
    return null;
  }

  #cookieFor(session: Session): string {
    return `${SESSION_COOKIE}=${session.token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
  }

  #clearCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  #newSession(
    member: Member,
    identity: Identity,
    assurance: "aal1" | "aal2",
    device: string,
  ): Session {
    const now = this.now();
    const session: Session = {
      id: newId("sts"),
      token: randomBytes(24).toString("base64url"),
      memberId: member.id,
      accessSub: identity.sub,
      assurance,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + (assurance === "aal1" ? 10 * MINUTE : 60 * MINUTE),
      enrolmentOpenUntil: null,
      stepUpFailures: 0,
      lastProofAt: assurance === "aal2" ? now : null,
      device,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  /** A passkey ceremony makes a new session that replaces the old one (§11.3). */
  #replace(session: Session): Session {
    this.sessions.delete(session.token);
    session.token = randomBytes(24).toString("base64url");
    this.sessions.set(session.token, session);
    return session;
  }

  #end(session: Session, reason: string): void {
    this.sessions.delete(session.token);
    this.ended.set(session.token, reason);
  }

  async handle(request: ApiRequest): Promise<Response> {
    return toResponse(await this.#route(request));
  }

  async #route(request: ApiRequest): Promise<Answer> {
    if (header(request, "Fin-Ingress-Proof") !== this.#options.ingressProof) {
      return { status: 404, body: undefined };
    }
    const url = new URL(request.target, "https://stand-in.invalid");
    const path = url.pathname;
    if (path === "/api/health") return ok({ status: "ok" });
    if (path.startsWith("/api/monitoring/")) return { status: 204 };

    const identity = await this.#identity(request);
    if (identity === "missing" || identity === "invalid") return problem("access_required");

    const text = request.body === null ? "" : await new Response(request.body).text();
    if (text.length > 256 * 1024) return problem("invalid", { fields: [] });
    const refused = this.#originRefusal(request, text !== "");
    if (refused !== null) return problem("invalid_origin", { reason: refused });
    let body: Record<string, unknown> = {};
    if (text !== "") {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return problem("invalid", { fields: [] });
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return problem("invalid", { fields: [] });
      }
    }

    const token = cookie(request, SESSION_COOKIE);
    let session = token === undefined ? null : (this.sessions.get(token) ?? null);
    if (token !== undefined && session === null && this.ended.has(token)) {
      return {
        ...problem("unauthenticated", { reason: this.ended.get(token) }),
        cookies: [this.#clearCookie()],
      };
    }
    if (session !== null && session.expiresAt <= this.now()) {
      this.#end(session, "expired");
      return {
        ...problem("unauthenticated", { reason: "expired" }),
        cookies: [this.#clearCookie()],
      };
    }
    let member = session === null ? null : (this.members.get(session.memberId) ?? null);
    if (session !== null && member !== null) {
      // The member's address must equal the Access identity, under the same subject (§10.5).
      if (
        member.email !== identity.email ||
        session.accessSub !== identity.sub ||
        member.status === "removed"
      ) {
        this.#end(session, "signed_out");
        this.#record("staff.access_mismatch", "system", member.id);
        return { ...problem("access_mismatch"), cookies: [this.#clearCookie()] };
      }
      session.lastActiveAt = this.now();
    } else if (session !== null) {
      this.#end(session, "signed_out");
      session = null;
      member = null;
    }

    const context: Context = {
      request,
      path,
      body,
      identity,
      session,
      member,
      intentHeader: header(request, "Fin-Step-Up-Intent"),
    };
    const key = `${request.method} ${path}`;
    switch (key) {
      case "GET /api/viewer":
        return this.#viewer(context);
      case "POST /api/auth/email-otp/send-verification-otp":
        return this.#sendCode(context);
      case "POST /api/auth/sign-in/email-otp":
        return this.#signInWithCode(context);
      case "GET /api/auth/passkey/generate-authenticate-options":
        return this.#authenticateOptions(context);
      case "POST /api/auth/passkey/verify-authentication":
        return this.#verifyAuthentication(context);
      case "GET /api/auth/passkey/generate-register-options":
        return this.#registerOptions(context);
      case "POST /api/auth/passkey/verify-registration":
        return this.#verifyRegistration(context);
      case "POST /api/auth/two-factor/enable":
        return this.#enableTotp(context);
      case "POST /api/auth/two-factor/verify-totp":
        return this.#verifyTotp(context);
      case "POST /api/auth/passkey/delete-passkey":
        return this.#removeFactor(context, "passkey");
      case "POST /api/auth/two-factor/disable":
        return this.#removeFactor(context, "authenticator");
      case "POST /api/auth/sign-out":
        return this.#signOut(context);
      case "POST /api/enrolment/redeem":
        return this.#redeem(context);
    }
    if (path.startsWith("/api/auth/")) return { status: 404, body: undefined };

    // Everything else needs a working session (aal2, active): the gate (§6.4).
    const working = this.#working(context);
    if ("status" in working) return working;
    const { session: s, member: m } = working;
    if (key === "GET /api/staff") return this.#needs(m, "staff.read") ?? this.#listStaff(m);
    if (key === "GET /api/staff-roles")
      return this.#needs(m, "staff.read") ?? ok({ roles: this.#roles() });
    if (key === "POST /api/staff") return this.#addStaff(context, s, m);
    if (key === "GET /api/account") return this.#account(s, m);
    if (key === "GET /api/audit") return this.#needs(m, "audit.read") ?? this.#auditLog(url, m);
    const auditMatch = /^\/api\/audit\/([^/]+)$/.exec(path);
    if (auditMatch !== null && request.method === "GET") {
      return this.#needs(m, "audit.read") ?? this.#auditEntry(auditMatch[1] as string);
    }
    if (key === "POST /api/account/sessions/revoke-others")
      return this.#revokeOthers(context, s, m);
    const staffMatch = /^\/api\/staff\/([^/]+)(\/remove|\/enrolment-code)?$/.exec(path);
    if (staffMatch !== null) {
      const target = this.members.get(decodeURIComponent(staffMatch[1] as string));
      if (request.method === "PATCH" && staffMatch[2] === undefined) {
        return this.#changeRole(context, s, m, target);
      }
      if (request.method === "POST" && staffMatch[2] === "/remove") {
        return this.#remove(context, s, m, target);
      }
      if (request.method === "POST" && staffMatch[2] === "/enrolment-code") {
        return this.#newCode(context, s, m, target);
      }
    }
    return problem("not_found");
  }

  #working(context: Context): { session: Session; member: Member } | Answer {
    if (context.session === null || context.member === null) return problem("unauthenticated");
    if (context.session.assurance !== "aal2" || context.member.status !== "active") {
      return problem("factor_step_required", { methods: this.#methods(context.member) });
    }
    return { session: context.session, member: context.member };
  }

  // ── The audit log (spec 02 §14.3, §14.5): the trail as the screen's contract reads it ──

  #auditRow(event: AuditEvent) {
    const kind = event.actor === "operator" || event.actor === "system" ? event.actor : "staff";
    const actor = kind === "staff" ? (this.members.get(event.actor) ?? null) : null;
    const label = (id: string) => this.members.get(id)?.email ?? null;
    const { refs, ...metadata } = event.metadata as Record<string, unknown>;
    return {
      id: event.id,
      event: event.event,
      category: /^staff\.(signed|sign_in|second_factor|session)/.test(event.event)
        ? "sign_in"
        : /step_up|factor/.test(event.event)
          ? "security"
          : "staff",
      at: event.at,
      actor: {
        kind,
        id: kind === "staff" ? event.actor : null,
        via: "admin",
        email: actor?.email ?? null,
        name: null,
      },
      target: { id: event.target ?? "", label: event.target === null ? null : label(event.target) },
      refs: Array.isArray(refs)
        ? refs.map((id) => ({ id: String(id), label: label(String(id)) }))
        : [],
      organisationId: null,
      metadata,
      verification: kind === "staff" ? "session" : null,
      address: null,
      device: null,
    };
  }

  /** `GET /api/audit`: newest first, the views, the Action and Staff member filters, cursors. */
  #auditLog(url: URL, reader: Member): Answer {
    const query = url.searchParams;
    const limit = Number(query.get("limit") ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return problem("invalid", { fields: [{ path: "limit", code: "too_big" }] });
    }
    const list = (name: string) => query.get(name)?.split(",") ?? null;
    const actions = list("action");
    const actors = list("actor");
    const show = query.get("show");
    const matching = this.audit
      .filter((event) => !NOT_AUDIT_ROWS.has(event.event))
      .filter((event) => show !== "mine" || event.actor === reader.id)
      .filter((event) => show !== "rejections" || event.event === "staff.customer_rejected")
      .filter((event) => actions === null || actions.includes(event.event))
      .filter((event) => actors === null || actors.includes(event.actor))
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    const cursor = query.get("cursor");
    const before = query.get("before");
    let page: AuditEvent[];
    let older: boolean;
    let newer: boolean;
    if (before !== null) {
      const above = matching.filter((event) => event.id > before);
      page = above.slice(Math.max(0, above.length - limit));
      newer = above.length > limit;
      older = matching.some((event) => event.id <= before);
    } else {
      const below = cursor === null ? matching : matching.filter((event) => event.id < cursor);
      page = below.slice(0, limit);
      older = below.length > limit;
      newer = cursor !== null && matching.some((event) => event.id >= cursor);
    }
    const people =
      this.#needs(reader, "staff.read") === null
        ? [...this.members.values()]
            .map((member) => ({ id: member.id, email: member.email }))
            .sort((a, b) => a.email.localeCompare(b.email))
        : [];
    return ok({
      items: page.map((event) => this.#auditRow(event)),
      total: matching.length,
      totalCapped: false,
      nextCursor: older ? (page.at(-1)?.id ?? null) : null,
      previousCursor: newer ? (page[0]?.id ?? null) : null,
      people,
    });
  }

  /** `GET /api/audit/:eventId`: one row of the trail, or not found. */
  #auditEntry(id: string): Answer {
    const event = this.audit.find((row) => row.id === id && !NOT_AUDIT_ROWS.has(row.event));
    return event === undefined ? problem("not_found") : ok({ entry: this.#auditRow(event) });
  }

  #needs(member: Member, permission: string): Answer | null {
    return roleOf(member.roleKey)?.permissions.includes(permission) === true
      ? null
      : problem("forbidden", { permission });
  }

  #methods(member: Member): string[] {
    const methods: string[] = [];
    if (member.passkeys.length > 0) methods.push("passkey");
    if (member.totp?.enabled === true) methods.push("authenticator");
    return methods;
  }

  #roles() {
    return ROLES.map((role) => ({
      key: role.key,
      label: role.label,
      summary: role.summary,
      builtIn: true,
      permissions: [...role.permissions],
    }));
  }

  // ── Step-up (§7) ──

  /**
   * The intent check of an action: none named, a new intent and `step_up_required`; one named,
   * consumed if it is this session's, this action's, these parameters', proved and unexpired.
   */
  #stepUp(
    context: Context,
    session: Session,
    member: Member,
    action: string,
    reasonKey: string,
    params: Record<string, unknown>,
    options: { consume: boolean; create: boolean } = { consume: true, create: true },
  ): Answer | null {
    const digest = sha256(canonical({ realm: "staff", action, params }));
    const named = context.intentHeader;
    if (named === undefined || named === "") {
      const methods = this.#methods(member);
      if (methods.length === 0) return problem("second_factor_required");
      if (!options.create) {
        return problem("step_up_required", {
          step_up_kind: "intent",
          methods,
          reason_key: reasonKey,
        });
      }
      const intent: Intent = {
        id: newId("sti"),
        sessionId: session.id,
        memberId: member.id,
        action,
        digest,
        reasonKey,
        expiresAt: this.now() + 5 * MINUTE,
        provedAt: null,
        consumedAt: null,
      };
      this.intents.set(intent.id, intent);
      return problem("step_up_required", {
        step_up_kind: "intent",
        intent_id: intent.id,
        methods,
        reason_key: reasonKey,
        expires_at: new Date(intent.expiresAt).toISOString(),
      });
    }
    const intent = this.intents.get(named);
    const reason =
      intent === undefined || intent.sessionId !== session.id
        ? "other_session"
        : intent.action !== action
          ? "other_action"
          : intent.digest !== digest
            ? "digest"
            : intent.consumedAt !== null
              ? "used"
              : intent.expiresAt <= this.now()
                ? "expired"
                : intent.provedAt === null
                  ? "unproved"
                  : null;
    if (reason !== null) return problem("step_up_invalid", { reason });
    if (options.consume) (intent as Intent).consumedAt = this.now();
    return null;
  }

  /** A proof for the named intent (or a window), after a passing ceremony. */
  #prove(session: Session, member: Member, intentId: string | undefined, method: string): boolean {
    session.lastProofAt = this.now();
    session.stepUpFailures = 0;
    if (intentId === undefined || intentId === "") {
      this.#record("staff.step_up_passed", member.id, session.id, { method });
      return true;
    }
    const intent = this.intents.get(intentId);
    if (
      intent === undefined ||
      intent.sessionId !== session.id ||
      intent.consumedAt !== null ||
      intent.expiresAt <= this.now()
    ) {
      return false;
    }
    intent.provedAt = this.now();
    this.#record("staff.step_up_passed", member.id, session.id, { method, intentId });
    return true;
  }

  /** A refused ceremony at a step-up; the fifth ends the session (§7.7). */
  #stepUpFailed(session: Session, member: Member, method: string): boolean {
    session.stepUpFailures += 1;
    this.#record("staff.step_up_failed", member.id, session.id, { method });
    if (session.stepUpFailures < 5) return false;
    this.#end(session, "too_many_tries");
    this.#record("staff.step_up_locked", member.id, session.id);
    return true;
  }

  // ── The viewer (§14.4) ──

  #viewer({ identity, session, member }: Context): Answer {
    if (session === null || member === null) {
      return ok({ state: "signed_out", accessEmail: identity.email });
    }
    if (member.status === "pending") return ok({ state: "pending", email: member.email });
    if (session.assurance === "aal1") {
      return ok({ state: "factor_step", email: member.email, methods: this.#methods(member) });
    }
    const role = roleOf(member.roleKey);
    return ok({
      state: "ok",
      staff: {
        id: member.id,
        email: member.email,
        roleKey: member.roleKey,
        roleLabel: role?.label ?? member.roleKey,
      },
      permissions: [...(role?.permissions ?? [])],
      environment: this.#options.environment,
    });
  }

  // ── Emailed codes (§5.2, §10.5) ──

  #eligible(email: string, identity: Identity): Member | null {
    const member = [...this.members.values()].find((m) => m.email === email);
    if (member === undefined || member.status === "removed") return null;
    return member.email === identity.email ? member : null;
  }

  async #sendCode({ body, identity }: Context): Promise<Answer> {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (body.type !== "sign-in" || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) {
      return problem("invalid", { fields: [{ path: "email", code: "invalid" }] });
    }
    const hour = this.now() - 60 * MINUTE;
    const recent = (this.codeRequests.get(email) ?? []).filter((at) => at > hour);
    if (recent.length >= 5) return problem("rate_limited", { retry_after: 600 });
    this.codeRequests.set(email, [...recent, this.now()]);
    const member = this.#eligible(email, identity);
    if (member === null) {
      this.#record("staff.not_listed", "system", null);
      return ok({ success: true });
    }
    const code = digits(8);
    this.emailCodes.set(email, { code, expiresAt: this.now() + 10 * MINUTE, tries: 0 });
    await (this.#options.fetch ?? fetch)(`${this.#options.emailSink}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "Fin Admin <no-reply@example.net>",
        to: [email],
        subject: "Your Fin Admin sign-in code",
        text: `Your Fin Admin sign-in code is ${code}. It works for 10 minutes.\n`,
        template: "staff/staff-sign-in-code",
        category: "security",
      }),
    });
    return ok({ success: true });
  }

  #signInWithCode({ body, identity, request }: Context): Answer {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const otp = typeof body.otp === "string" ? body.otp : "";
    const live = this.emailCodes.get(email);
    if (live === undefined) return library(400, "INVALID_OTP");
    if (live.expiresAt <= this.now()) {
      this.emailCodes.delete(email);
      return library(400, "OTP_EXPIRED");
    }
    const member = this.#eligible(email, identity);
    if (otp !== live.code || member === null) {
      live.tries += 1;
      if (member !== null)
        this.#record("staff.sign_in_failed", "system", member.id, {
          method: "email_otp",
          reason: "wrong",
        });
      if (live.tries >= 3) {
        this.emailCodes.delete(email);
        return library(403, "TOO_MANY_ATTEMPTS");
      }
      return library(400, "INVALID_OTP");
    }
    this.emailCodes.delete(email);
    const session = this.#newSession(
      member,
      identity,
      "aal1",
      deviceOf(header(request, "User-Agent")),
    );
    this.#record("staff.second_factor_required", member.id, session.id);
    return ok({ user: { id: member.id, email: member.email } }, 200, [this.#cookieFor(session)]);
  }

  // ── Passkeys (§5.3) ──

  #challenge(kind: "get" | "create", session: Session | null): string {
    const challenge = randomBytes(32).toString("base64url");
    this.challenges.set(challenge, {
      kind,
      expiresAt: this.now() + 5 * MINUTE,
      sessionId: session?.id ?? null,
    });
    return challenge;
  }

  #takeChallenge(challenge: string | null, kind: "get" | "create"): Challenge | null {
    if (challenge === null) return null;
    const found = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (found === undefined || found.kind !== kind || found.expiresAt <= this.now()) return null;
    return found;
  }

  #authenticateOptions(context: Context): Answer {
    return ok({
      challenge: this.#challenge("get", context.session),
      rpId: this.#rpId,
      timeout: 60_000,
      userVerification: "required",
      allowCredentials: [],
    });
  }

  #verifyAuthentication(context: Context): Answer {
    const { body, identity, request } = context;
    const credential = body.response;
    const challenge = this.#takeChallenge(assertionChallenge(credential), "get");
    const credentialId = assertionCredentialId(credential);
    const owner = [...this.members.values()].find((m) =>
      m.passkeys.some((p) => p.credentialId === credentialId),
    );
    const passkey = owner?.passkeys.find((p) => p.credentialId === credentialId);
    const checked =
      challenge === null || owner === undefined || passkey === undefined
        ? { ok: false as const, reason: "unknown" }
        : verifyAssertion(credential, passkey, {
            challenge: assertionChallenge(credential) as string,
            origin: this.#options.appOrigin,
            rpId: this.#rpId,
          });
    const stepping =
      context.session !== null && context.member !== null && context.session.assurance === "aal2";

    if (!checked.ok || owner === undefined || passkey === undefined || owner.status !== "active") {
      if (stepping) {
        const locked = this.#stepUpFailed(
          context.session as Session,
          context.member as Member,
          "passkey",
        );
        if (locked)
          return {
            ...problem("unauthenticated", { reason: "too_many_tries" }),
            cookies: [this.#clearCookie()],
          };
      }
      return library(401, "PASSKEY_NOT_FOUND");
    }
    // The passkey's member must be the Access identity (§10.5), and at a step-up the session's.
    if (owner.email !== identity.email) {
      this.#record("staff.access_mismatch", "system", owner.id);
      return library(401, "PASSKEY_NOT_FOUND");
    }
    if (context.session !== null && context.member !== null && context.member.id !== owner.id) {
      // Another person's passkey (spec 02 §7.4): refused, and the session kept as it was.
      if (stepping && this.#stepUpFailed(context.session, context.member, "passkey")) {
        return {
          ...problem("unauthenticated", { reason: "too_many_tries" }),
          cookies: [this.#clearCookie()],
        };
      }
      return problem("forbidden", { reason: "other_person" });
    }
    passkey.counter = checked.counter;
    passkey.lastUsedAt = this.now();

    if (stepping) {
      const session = context.session as Session;
      if (!this.#prove(session, owner, context.intentHeader, "passkey")) {
        return problem("step_up_invalid", { reason: "unproved" });
      }
      const replaced = this.#replace(session);
      return ok({ ok: true }, 200, [this.#cookieFor(replaced)]);
    }
    if (context.session !== null) {
      // The factor step: the aal1 session is raised and replaced.
      const session = this.#replace(context.session);
      session.assurance = "aal2";
      session.lastProofAt = this.now();
      session.expiresAt = this.now() + 60 * MINUTE;
      owner.lastSignedInAt = this.now();
      this.#record("staff.signed_in", owner.id, session.id, { method: "passkey" });
      return ok({ ok: true }, 200, [this.#cookieFor(session)]);
    }
    const session = this.#newSession(
      owner,
      identity,
      "aal2",
      deviceOf(header(request, "User-Agent")),
    );
    owner.lastSignedInAt = this.now();
    this.#record("staff.signed_in", owner.id, session.id, { method: "passkey" });
    return ok({ ok: true }, 200, [this.#cookieFor(session)]);
  }

  /** Who may register a factor now: a pending member in the window, or a working one with an intent. */
  #registering(
    context: Context,
    method: "passkey" | "authenticator",
    create: boolean,
    consume: boolean,
  ): Answer | { session: Session; member: Member; first: boolean } {
    const { session, member } = context;
    if (session === null || member === null) return problem("unauthenticated");
    if (member.status === "pending") {
      if (session.enrolmentOpenUntil === null || session.enrolmentOpenUntil <= this.now()) {
        return problem("forbidden", { reason: "enrolment_code_required" });
      }
      if (method === "authenticator" && this.#options.environment === "production") {
        return problem("forbidden", { reason: "passkey_first" });
      }
      return { session, member, first: true };
    }
    if (session.assurance !== "aal2")
      return problem("factor_step_required", { methods: this.#methods(member) });
    const refused = this.#stepUp(
      context,
      session,
      member,
      "staff.factor_add",
      "add_factor",
      {},
      { create, consume },
    );
    if (refused !== null) return refused;
    return { session, member, first: false };
  }

  #registerOptions(context: Context): Answer {
    // A GET makes no intent (§2.3): the body-less POST of the registration does.
    const allowed = this.#registering(context, "passkey", false, false);
    if ("status" in allowed) return allowed;
    const { member, session } = allowed;
    return ok({
      challenge: this.#challenge("create", session),
      rp: { id: this.#rpId, name: "Fin Admin" },
      user: {
        id: toBase64Url(Buffer.from(member.id)),
        name: member.email,
        displayName: member.email,
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 60_000,
      attestation: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: member.passkeys.map((p) => ({ id: p.credentialId, type: "public-key" })),
    });
  }

  #enrolled(session: Session, member: Member, method: string): void {
    member.status = "active";
    session.assurance = "aal2";
    session.lastProofAt = this.now();
    session.expiresAt = this.now() + 60 * MINUTE;
    session.enrolmentOpenUntil = null;
    member.lastSignedInAt = this.now();
    const code = this.enrolmentCodes.get(member.id);
    this.#record("staff.factor_enrolled", member.id, member.id, {
      method,
      refs: code === undefined ? [] : [code.id],
    });
    this.#record("staff.signed_in", member.id, session.id, { method });
  }

  #verifyRegistration(context: Context): Answer {
    const credential = context.body.response;
    const allowed = this.#registering(
      context,
      "passkey",
      credential === undefined,
      credential !== undefined,
    );
    if ("status" in allowed) return allowed;
    if (credential === undefined)
      return problem("invalid", { fields: [{ path: "response", code: "required" }] });
    const { session, member, first } = allowed;
    const challenge = this.#takeChallenge(assertionChallenge(credential), "create");
    if (challenge === null || challenge.sessionId !== session.id)
      return library(400, "CHALLENGE_NOT_FOUND");
    const checked = verifyRegistration(credential, {
      challenge: assertionChallenge(credential) as string,
      origin: this.#options.appOrigin,
      rpId: this.#rpId,
    });
    if (!checked.ok) return library(400, "FAILED_TO_VERIFY_REGISTRATION");
    const passkey: Passkey = {
      ...checked.passkey,
      id: newId("pky"),
      name: session.device,
      createdAt: this.now(),
      lastUsedAt: null,
    };
    member.passkeys.push(passkey);
    let cookies: string[] = [];
    if (first) {
      const replaced = this.#replace(session);
      this.#enrolled(replaced, member, "passkey");
      cookies = [this.#cookieFor(replaced)];
    } else {
      this.#record("staff.factor_added", member.id, passkey.id, {
        method: "passkey",
        refs: [member.id],
      });
    }
    return ok({ id: passkey.id }, 200, cookies);
  }

  // ── The authenticator (§5.4) ──

  #enableTotp(context: Context): Answer {
    const allowed = this.#registering(context, "authenticator", true, true);
    if ("status" in allowed) return allowed;
    const { member } = allowed;
    if (member.totp?.enabled === true) return library(400, "TOTP_ALREADY_ENABLED");
    const secret = base32Encode(randomBytes(20));
    member.totp = { secret, enabled: false, enabledAt: null, lastStep: -1n };
    this.#record("staff.factor_setup_started", member.id, member.id, { method: "totp" });
    const label = encodeURIComponent(`Fin Admin:${member.email}`);
    return ok({
      totpURI: `otpauth://totp/${label}?secret=${secret}&issuer=Fin%20Admin&digits=6&period=30`,
    });
  }

  /** The code at this step or the one either side, never one already used. */
  #checkTotp(member: Member, code: string): boolean {
    const secret = member.totp?.secret;
    if (secret === undefined || member.totp === null) return false;
    const now = this.now();
    const step = totpCounter(now);
    for (const offset of [0n, -1n, 1n]) {
      const candidate = step + offset;
      if (candidate <= member.totp.lastStep) continue;
      if (totp(secret, Number(candidate) * 30_000) === code) {
        member.totp.lastStep = candidate;
        return true;
      }
    }
    return false;
  }

  #verifyTotp(context: Context): Answer {
    const { session, member, body } = context;
    if (session === null || member === null) return problem("unauthenticated");
    const code = typeof body.code === "string" ? body.code : "";
    if (member.totp === null) return library(400, "TOTP_NOT_ENABLED");

    if (!member.totp.enabled) {
      // Finishing a set-up: a pending member inside the window, or a working (aal2) member. The
      // factor step never finishes a set-up left unfinished elsewhere.
      if (
        member.status === "pending" &&
        (session.enrolmentOpenUntil === null || session.enrolmentOpenUntil <= this.now())
      ) {
        return problem("forbidden", { reason: "enrolment_code_required" });
      }
      if (member.status === "active" && session.assurance !== "aal2") {
        return library(400, "TOTP_NOT_ENABLED");
      }
      if (!this.#checkTotp(member, code)) return library(401, "INVALID_CODE");
      member.totp.enabled = true;
      member.totp.enabledAt = this.now();
      if (member.status === "pending") this.#enrolled(session, member, "totp");
      else this.#record("staff.factor_added", member.id, member.id, { method: "totp" });
      return ok({ ok: true });
    }

    if (session.assurance === "aal1") {
      if (member.wrongCodes >= 10) return library(429, "ACCOUNT_TEMPORARILY_LOCKED");
      if (!this.#checkTotp(member, code)) {
        member.wrongCodes += 1;
        this.#record("staff.sign_in_failed", "system", member.id, {
          method: "totp",
          reason: "wrong",
        });
        return library(401, "INVALID_CODE");
      }
      member.wrongCodes = 0;
      session.assurance = "aal2";
      session.lastProofAt = this.now();
      session.expiresAt = this.now() + 60 * MINUTE;
      member.lastSignedInAt = this.now();
      this.#record("staff.signed_in", member.id, session.id, { method: "totp" });
      return ok({ ok: true });
    }

    // A step-up: the named intent, or a window.
    if (!this.#checkTotp(member, code)) {
      if (this.#stepUpFailed(session, member, "totp")) {
        return {
          ...problem("unauthenticated", { reason: "too_many_tries" }),
          cookies: [this.#clearCookie()],
        };
      }
      return library(401, "INVALID_CODE");
    }
    if (!this.#prove(session, member, context.intentHeader, "totp")) {
      return problem("step_up_invalid", { reason: "unproved" });
    }
    return ok({ ok: true });
  }

  #removeFactor(context: Context, kind: "passkey" | "authenticator"): Answer {
    const working = this.#working(context);
    if ("status" in working) return working;
    const { session, member } = working;
    const id = typeof context.body.id === "string" ? context.body.id : "";
    if (kind === "passkey" && !member.passkeys.some((p) => p.id === id))
      return problem("not_found");
    if (kind === "authenticator" && member.totp?.enabled !== true) return problem("not_found");
    const refused = this.#stepUp(
      context,
      session,
      member,
      "staff.factor_remove",
      "remove_factor",
      kind === "passkey" ? { id } : {},
    );
    if (refused !== null) return refused;
    const left = member.passkeys.length + (member.totp?.enabled === true ? 1 : 0);
    if (left <= 1) return problem("last_factor");
    if (kind === "passkey") member.passkeys = member.passkeys.filter((p) => p.id !== id);
    else member.totp = null;
    this.#record("staff.factor_removed", member.id, kind === "passkey" ? id : member.id, {
      method: kind,
    });
    return ok({ success: true });
  }

  #signOut({ session, member }: Context): Answer {
    if (session !== null) {
      this.sessions.delete(session.token);
      if (member !== null) this.#record("staff.signed_out", member.id, session.id);
    }
    return ok({ success: true }, 200, [this.#clearCookie()]);
  }

  // ── Enrolment (§6.5) ──

  #redeem({ session, member, body }: Context): Answer {
    if (session === null || member === null) return problem("unauthenticated");
    if (member.status !== "pending") return problem("forbidden", { reason: "not_pending" });
    const given = typeof body.code === "string" ? body.code : "";
    const live = this.enrolmentCodes.get(member.id);
    const refuse = (reason: string) => {
      this.#record("staff.enrolment_refused", "system", member.id, { reason });
      return problem("forbidden", { reason });
    };
    if (live === undefined || live.voidedAt !== null) return refuse("void");
    if (live.redeemedAt !== null) return refuse("used");
    if (live.expiresAt <= this.now()) {
      live.voidedAt = this.now();
      return refuse("expired");
    }
    const normalised = normaliseEnrolment(given);
    if (normalised === null || sha256(normalised) !== live.hash) {
      live.failedTries += 1;
      if (live.failedTries >= 5) live.voidedAt = this.now();
      return refuse("wrong");
    }
    live.redeemedAt = this.now();
    session.enrolmentOpenUntil = this.now() + 10 * MINUTE;
    this.#record("staff.enrolment_code_redeemed", member.id, live.id, {
      refs: [member.id, session.id],
    });
    return ok({ windowUntil: new Date(session.enrolmentOpenUntil).toISOString() });
  }

  // ── Staff (§10.2) ──

  #row(member: Member) {
    return {
      id: member.id,
      email: member.email,
      roleKey: member.roleKey,
      roleLabel: roleOf(member.roleKey)?.label ?? member.roleKey,
      status: member.status === "pending" ? "pending" : "active",
      lastSignedInAt:
        member.lastSignedInAt === null ? null : new Date(member.lastSignedInAt).toISOString(),
      factors: this.#methods(member),
    };
  }

  #listStaff(_actor: Member): Answer {
    const staff = [...this.members.values()]
      .filter((m) => m.status !== "removed")
      .map((m) => this.#row(m));
    return ok({ staff, total: staff.length });
  }

  /** §8.5's rules, in the staff-change lock's order; null when the change may go ahead. */
  #giving(actor: Member, target: Member | null, roleKey: string | null): Answer | null {
    const actorRole = roleOf(actor.roleKey);
    const holds = (key: string) =>
      (roleOf(key)?.permissions ?? []).every((p) => actorRole?.permissions.includes(p));
    if (target !== null && target.id === actor.id)
      return problem("giving_refused", { problem: "self" });
    if (roleKey !== null) {
      if (roleOf(roleKey) === undefined)
        return problem("giving_refused", { problem: "unknown_role" });
      if (roleKey === "admin" && actor.roleKey !== "admin")
        return problem("giving_refused", { problem: "top_only" });
      if (!holds(roleKey)) return problem("giving_refused", { problem: "beyond" });
    }
    if (target !== null && !holds(target.roleKey)) return problem("outranked");
    if (target !== null && roleKey !== null && target.roleKey === roleKey) {
      return problem("giving_refused", { problem: "unchanged" });
    }
    return null;
  }

  #lastAdmin(target: Member): boolean {
    if (target.roleKey !== "admin" || target.status !== "active") return false;
    return (
      [...this.members.values()].filter((m) => m.roleKey === "admin" && m.status === "active")
        .length === 1
    );
  }

  #addStaff(context: Context, session: Session, actor: Member): Answer {
    const denied = this.#needs(actor, "staff.add");
    if (denied !== null) return denied;
    const email =
      typeof context.body.email === "string" ? context.body.email.trim().toLowerCase() : "";
    const roleKey = typeof context.body.roleKey === "string" ? context.body.roleKey : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return problem("invalid", { fields: [{ path: "email", code: "invalid" }] });
    }
    const refused = this.#giving(actor, null, roleKey);
    if (refused !== null) return refused;
    const existing = [...this.members.values()].find((m) => m.email === email);
    if (existing !== undefined && existing.status !== "removed") return problem("already_staff");
    const stepUp = this.#stepUp(context, session, actor, "staff.add", "staff.add", {
      email,
      roleKey,
    });
    if (stepUp !== null) return stepUp;
    const member: Member = existing ?? {
      id: newId("stf"),
      email,
      roleKey,
      status: "pending",
      lastSignedInAt: null,
      passkeys: [],
      totp: null,
      wrongCodes: 0,
    };
    member.roleKey = roleKey;
    member.status = "pending";
    this.members.set(member.id, member);
    this.#record("staff.member_added", actor.id, member.id, {
      roleKey,
      reactivated: existing !== undefined,
    });
    const code = this.#issueCode(member, "added", actor.id);
    const live = this.enrolmentCodes.get(member.id) as EnrolmentCode;
    return ok(
      {
        staff: this.#row(member),
        enrolmentCode: code,
        expiresAt: new Date(live.expiresAt).toISOString(),
      },
      201,
    );
  }

  #changeRole(
    context: Context,
    session: Session,
    actor: Member,
    target: Member | undefined,
  ): Answer {
    const denied = this.#needs(actor, "staff.role");
    if (denied !== null) return denied;
    if (target === undefined || target.status === "removed") return problem("not_found");
    const roleKey = typeof context.body.roleKey === "string" ? context.body.roleKey : "";
    const refused = this.#giving(actor, target, roleKey);
    if (refused !== null) return refused;
    if (this.#lastAdmin(target)) return problem("last_top_role");
    const stepUp = this.#stepUp(context, session, actor, "staff.role", "staff.role", {
      target: target.id,
      roleKey,
    });
    if (stepUp !== null) return stepUp;
    const from = target.roleKey;
    target.roleKey = roleKey;
    for (const s of [...this.sessions.values()])
      if (s.memberId === target.id) this.#end(s, "signed_out");
    this.#record("staff.role_changed", actor.id, target.id, { fromRole: from, toRole: roleKey });
    return ok({ staff: this.#row(target) });
  }

  #remove(context: Context, session: Session, actor: Member, target: Member | undefined): Answer {
    const denied = this.#needs(actor, "staff.remove");
    if (denied !== null) return denied;
    if (target === undefined || target.status === "removed") return problem("not_found");
    const refused = this.#giving(actor, target, null);
    if (refused !== null) return refused;
    if (this.#lastAdmin(target)) return problem("last_top_role");
    const stepUp = this.#stepUp(context, session, actor, "staff.remove", "staff.remove", {
      target: target.id,
    });
    if (stepUp !== null) return stepUp;
    target.status = "removed";
    target.passkeys = [];
    target.totp = null;
    this.enrolmentCodes.delete(target.id);
    for (const s of [...this.sessions.values()])
      if (s.memberId === target.id) this.#end(s, "signed_out");
    this.#record("staff.member_removed", actor.id, target.id);
    return { status: 204 };
  }

  #newCode(context: Context, session: Session, actor: Member, target: Member | undefined): Answer {
    const denied = this.#needs(actor, "staff.add");
    if (denied !== null) return denied;
    if (target === undefined || target.status !== "pending") return problem("not_found");
    const refused = this.#giving(actor, target, null);
    if (refused !== null) return refused;
    const stepUp = this.#stepUp(
      context,
      session,
      actor,
      "staff.enrolment_code",
      "staff.enrolment_code",
      { target: target.id },
    );
    if (stepUp !== null) return stepUp;
    const code = this.#issueCode(target, "reissued", actor.id);
    const live = this.enrolmentCodes.get(target.id) as EnrolmentCode;
    return ok({ enrolmentCode: code, expiresAt: new Date(live.expiresAt).toISOString() });
  }

  // ── The member's own sign-in ──

  #account(session: Session, member: Member): Answer {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return ok({
      passkeys: member.passkeys.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: iso(p.createdAt),
        lastUsedAt: iso(p.lastUsedAt),
      })),
      authenticator: {
        enabled: member.totp?.enabled === true,
        enabledAt: iso(member.totp?.enabledAt ?? null),
      },
      sessions: [...this.sessions.values()]
        .filter((s) => s.memberId === member.id)
        .map((s) => ({
          id: s.id,
          device: s.device,
          current: s.id === session.id,
          createdAt: iso(s.createdAt),
          lastActiveAt: iso(s.lastActiveAt),
        })),
    });
  }

  #revokeOthers(context: Context, session: Session, member: Member): Answer {
    const stepUp = this.#stepUp(
      context,
      session,
      member,
      "staff.sessions_revoke_others",
      "sign_out_everywhere",
      {},
    );
    if (stepUp !== null) return stepUp;
    let revoked = 0;
    for (const s of [...this.sessions.values()]) {
      if (s.memberId === member.id && s.id !== session.id) {
        this.#end(s, "signed_out");
        revoked += 1;
      }
    }
    this.#record("staff.signed_out_everywhere", member.id, member.id, { count: revoked });
    return ok({ revoked });
  }
}

/** The control port's handler: reset, bootstrap the first Admin, move the clock, read the audit. */
export async function controlHandler(api: AdminApiStandIn, request: ApiRequest): Promise<Response> {
  const path = new URL(request.target, "http://control.invalid").pathname;
  const body =
    request.body === null
      ? {}
      : ((await new Response(request.body).json().catch(() => ({}))) as Record<string, unknown>);
  if (request.method === "POST" && path === "/reset") {
    api.reset();
    return Response.json({ ok: true });
  }
  if (request.method === "POST" && path === "/bootstrap") {
    try {
      return Response.json(api.bootstrap(String(body.email ?? "")));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "refused" },
        { status: 409 },
      );
    }
  }
  if (request.method === "POST" && path === "/clock") {
    api.advance(Number(body.seconds ?? 0) * 1000);
    return Response.json({ now: new Date(api.now()).toISOString() });
  }
  if (request.method === "GET" && path === "/clock") {
    return Response.json({ now: new Date(api.now()).toISOString() });
  }
  if (request.method === "GET" && path === "/audit") return Response.json({ events: api.audit });
  return new Response(null, { status: 404 });
}
