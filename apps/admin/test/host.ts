// Fin Admin's API half for tests: the shared host (packages/web-host) with this app's hooks, the
// test Access stand-in (@fin/testing, [SA-38]) behind the real Access verifier, and a client that
// sends what the connector and a browser on the admin host send: the ingress proof from the
// connector's address, the Access token, the exact Origin, `Sec-Fetch-Site: same-origin`,
// `X-Fin-App: admin` and JSON bodies. Imported only by *.test.ts files.

import { Readiness } from "@fin/server/health";
import { ConnectorPeers } from "@fin/server/ingress";
import { capture, randomProof } from "@fin/server/testing";
import { AccessStandIn } from "@fin/testing";
import { AccessVerifier, createApiHost } from "@fin/web-host";
import type { StaffHarness } from "../../../packages/staff/test/index.ts";
import {
  ADMIN_ORIGIN,
  DOCS_ORIGIN,
  SoftAuthenticator,
} from "../../../packages/staff/test/index.ts";
import { adminHooks } from "../src/server/app.ts";

export const TEAM = "fin-test-team";
export const CONNECTOR = "2001:db8::c1";
const HOST = new URL(ADMIN_ORIGIN).host;

export interface Reply {
  status: number;
  json: Record<string, unknown> | null;
  headers: Headers;
}

export interface AdminHost {
  standIn: AccessStandIn;
  captured: ReturnType<typeof capture>;
  client(email: string | null): AdminClient;
}

export class AdminClient {
  readonly jar = new Map<string, string>();
  readonly #host: ReturnType<typeof createApiHost>;
  readonly #proof: string;
  readonly #standIn: AccessStandIn;
  readonly ip = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}::9`;
  /** The address Access signed this browser in as (null: no Access token at all). */
  email: string | null;
  /** Overrides the Access token sent (a forged or foreign one). */
  token: string | null = null;

  constructor(
    host: ReturnType<typeof createApiHost>,
    proof: string,
    standIn: AccessStandIn,
    email: string | null,
  ) {
    this.#host = host;
    this.#proof = proof;
    this.#standIn = standIn;
    this.email = email;
  }

  async send(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const all: Record<string, string> = {
      host: HOST,
      "fin-ingress-proof": this.#proof,
      "cf-connecting-ip": this.ip,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      origin: ADMIN_ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-fin-app": "admin",
      ...(text === undefined ? {} : { "content-type": "application/json" }),
      ...(text === undefined ? {} : { "content-length": String(Buffer.byteLength(text)) }),
      ...(this.jar.size > 0
        ? { cookie: [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") }
        : {}),
    };
    const token =
      this.token ?? (this.email === null ? null : this.#standIn.issue({ email: this.email }));
    if (token !== null) all["cf-access-jwt-assertion"] = token;
    Object.assign(all, headers);
    for (const [name, value] of Object.entries(all)) if (value === "") delete all[name];
    const response = await this.#host.request(
      `${ADMIN_ORIGIN}${path}`,
      { method, headers: all, ...(text === undefined ? {} : { body: text }) },
      { incoming: { socket: { remoteAddress: CONNECTOR }, url: path } } as never,
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0\b/i.test(cookie) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const raw = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      json = null;
    }
    return { status: response.status, json, headers: response.headers };
  }

  get(path: string, headers?: Record<string, string>) {
    return this.send("GET", path, undefined, headers);
  }

  post(path: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.send("POST", path, body, headers);
  }

  patch(path: string, body: unknown, headers?: Record<string, string>) {
    return this.send("PATCH", path, body, headers);
  }

  /** Asks a staff sign-in code for the Access address and signs in with it (aal1). */
  async signInByCode(latestCode: (email: string) => Promise<string | null>): Promise<Reply> {
    const email = this.email as string;
    const sent = await this.post("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    if (sent.status !== 200) throw new Error(`code request: ${sent.status}`);
    const code = await latestCode(email);
    if (code === null) throw new Error("no code was queued");
    return this.post("/api/auth/sign-in/email-otp", { email, otp: code });
  }

  /** A passkey ceremony, proving `intentId` when given (a step-up) or signing in. */
  async passkey(authenticator: SoftAuthenticator, intentId?: string): Promise<Reply> {
    const options = await this.get("/api/auth/passkey/generate-authenticate-options");
    if (options.status !== 200) return options;
    const response = authenticator.authenticate(String(options.json?.challenge));
    return this.post(
      "/api/auth/passkey/verify-authentication",
      { response },
      intentId === undefined ? {} : { "fin-step-up-intent": intentId },
    );
  }

  /** Sends a stepped-up request: asks for the intent, proves it with a passkey, re-sends once. */
  async stepped(
    authenticator: SoftAuthenticator,
    method: string,
    path: string,
    body: unknown = {},
  ): Promise<Reply> {
    const first = await this.send(method, path, body);
    if (first.status !== 403 || first.json?.code !== "step_up_required") return first;
    const intent = String(first.json.intent_id);
    const proved = await this.passkey(authenticator, intent);
    if (proved.status !== 200) throw new Error(`step-up ceremony: ${proved.status}`);
    return this.send(method, path, body, { "fin-step-up-intent": intent });
  }
}

export interface HostMember {
  staffId: string;
  email: string;
  client: AdminClient;
  authenticator: SoftAuthenticator;
}

/**
 * A member at aal2 through the API half: seeded pending with a code, signed in by an emailed
 * code, the enrolment code redeemed, a passkey registered as the first factor.
 */
export async function enrolThroughHost(
  h: StaffHarness,
  host: AdminHost,
  email: string,
  roleKey: string,
): Promise<HostMember> {
  const staffId = await h.seedMember(email, roleKey, "pending");
  const code = await h.issueCode(staffId);
  const client = host.client(email);
  const signedIn = await client.signInByCode((address) => h.latestCode(address));
  if (signedIn.status !== 200) throw new Error(`sign-in: ${signedIn.status}`);
  const redeemed = await client.post("/api/enrolment/redeem", { code });
  if (redeemed.status !== 200) throw new Error(`redeem: ${redeemed.status}`);
  const authenticator = new SoftAuthenticator(HOST, ADMIN_ORIGIN);
  const options = await client.get("/api/auth/passkey/generate-register-options");
  if (options.status !== 200) throw new Error(`register options: ${options.status}`);
  const response = authenticator.register(
    options.json as { challenge: string; user: { id: string } },
  );
  const verified = await client.post("/api/auth/passkey/verify-registration", { response });
  if (verified.status !== 200) throw new Error(`registration: ${verified.status}`);
  return { staffId, email, client, authenticator };
}

/** A pending member signed in by code: an aal1 session that reaches only enrolment. */
export async function pendingThroughHost(
  h: StaffHarness,
  host: AdminHost,
  email: string,
): Promise<AdminClient> {
  await h.seedMember(email, "viewer", "pending");
  const client = host.client(email);
  const signedIn = await client.signInByCode((address) => h.latestCode(address));
  if (signedIn.status !== 200) throw new Error(`sign-in: ${signedIn.status}`);
  return client;
}

export async function createAdminHost(h: StaffHarness): Promise<AdminHost> {
  const captured = capture({ service: "admin" });
  const aud = randomProof()
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 32)
    .toLowerCase();
  const standIn = new AccessStandIn({
    audience: aud,
    issuer: `https://${TEAM}.cloudflareaccess.com`,
    now: () => captured.clock.now(),
  });
  const certs = (async (url: string | URL | Request) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target !== `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(standIn.certs()), { status: 200 });
  }) as typeof fetch;
  const peers = new ConnectorPeers({
    services: ["cloudflared-admin"],
    resolver: { resolveAll: async () => [{ address: CONNECTOR, family: 6 }] },
    clock: captured.clock,
  });
  await peers.start();
  peers.stop();
  const proof = randomProof();
  const host = createApiHost({
    app: "admin",
    environment: "ci",
    release: "0123456789abcdef0123456789abcdef01234567",
    docsOrigin: DOCS_ORIGIN,
    ingress: {
      origins: { admin: ADMIN_ORIGIN },
      connectorServices: ["cloudflared-admin"],
      proofs: { admin: [proof] },
    },
    telemetry: captured.telemetry,
    reporter: captured.reporter,
    clock: captured.clock,
    readiness: new Readiness(),
    peers,
    accessVerifier: new AccessVerifier({ team: TEAM, aud, clock: captured.clock, fetch: certs }),
    ...adminHooks(h.deps, DOCS_ORIGIN),
  });
  return {
    standIn,
    captured,
    client: (email) => new AdminClient(host, proof, standIn, email),
  };
}
