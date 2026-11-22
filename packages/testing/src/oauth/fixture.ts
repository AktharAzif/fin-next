// A fixture OpenID provider for Google sign-in's tests (spec 02 §5.8, §19.3; EXECUTION S-02: "the
// Google round trip ... proven in Playwright against a mock identity provider"), test target only
// ([SA-38]). It answers as Google's endpoints do for an authorization-code flow with PKCE:
//
//   GET  /authorize   checks the client, the exact redirect URI, `response_type=code`, a scope, a
//                     state, an S256 code challenge and a nonce, then signs in the chosen account
//                     (or shows an account chooser, as `prompt=select_account` does) and redirects
//                     back with a single-use code;
//   POST /token       authenticates the client (client_secret_post or Basic), checks the code, the
//                     same redirect URI and the PKCE verifier, and answers the scope it granted
//                     and, for an identity scope (`openid`, `email` or `profile`), an RS256 ID
//                     token carrying the nonce, with the address only for `email` and the name
//                     only for `profile`, as Google's token endpoint answers;
//   GET  /jwks        lists the signing keys;
//   /control/*        lets Node-side test code choose the next account and read what was asked.
//
// The authorization request passes through the browser, so a test may change any of it before it
// reaches the fixture (its nonce, its scopes, its challenge), as a client can at Google. Each
// refusal a client must handle can also be planted (`tamperNext`): a wrong nonce, audience or
// issuer, an expired or old token, a bad signature, an unverified address, `alg: none`, an
// unknown key, or a provider error at the token endpoint. Nothing here is ever deployed; the import
// rules keep @fin/testing out of deployable code.
import { createHash, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { base64url, type JsonObject, signRs256, unsignedToken } from "../access/jwt.ts";
import { type HostRequest, type Listening, listen } from "../http/node.ts";

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The exact redirect URIs the client registered (compared as strings, as Google does). */
  readonly redirectUris: readonly string[];
}

export interface FixtureAccount {
  /** The stable subject (`sub`). */
  readonly sub: string;
  readonly email: string;
  /** Defaults to true. */
  readonly emailVerified?: boolean;
  readonly name?: string;
  /** A Workspace domain, for the `hd` claim. */
  readonly hd?: string;
}

export type Tamper =
  | "nonce"
  | "audience"
  | "issuer"
  | "expired"
  | "issued_long_ago"
  | "signature"
  | "unverified"
  | "alg_none"
  | "unknown_kid"
  | "token_error";

export interface OAuthFixtureOptions {
  /** Milliseconds since the epoch; defaults to the system clock, read per call. */
  readonly now?: () => number;
  /** The issuer; defaults to the server's origin once it starts. */
  readonly issuer?: string;
  /** Seconds a code lives (default 60). */
  readonly codeLifetimeSeconds?: number;
}

/** An authorization request as the fixture received it. */
export interface RecordedAuthorization {
  readonly params: Readonly<Record<string, string>>;
  readonly outcome: "code" | "chooser" | "denied" | "refused";
}

/** A token request as the fixture answered it. */
export interface RecordedExchange {
  readonly clientId: string | null;
  readonly redirectUri: string | null;
  readonly pkce: boolean;
  readonly outcome: "issued" | "refused";
  readonly error?: string;
}

interface Pending {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly state: string;
  readonly scope: string;
  readonly expiresAt: number;
}

interface IssuedCode extends Pending {
  readonly account: FixtureAccount;
  readonly tamper: Tamper | null;
  used: boolean;
}

interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: JsonObject;
}

function makeKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  const n = String(exported.n);
  const e = String(exported.e);
  const kid = createHash("sha256").update(n).digest("hex").slice(0, 32);
  return { kid, privateKey, jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n, e } };
}

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** The scopes for which Google's token endpoint answers an ID token. */
const IDENTITY_SCOPES = new Set(["openid", "email", "profile"]);

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function tokenError(error: string, status = 400): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A cancelled sign-in, as Google sends it back: the code, its own sentence, and the state. */
function denied(state: string): Record<string, string> {
  return { error: "access_denied", error_description: "The person cancelled the sign-in", state };
}

function redirectTo(redirectUri: string, params: Record<string, string>): Response {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return new Response(null, {
    status: 302,
    headers: { location: target.href, "cache-control": "no-store" },
  });
}

export class OAuthFixture {
  readonly #clients = new Map<string, OAuthClient>();
  readonly #accounts = new Map<string, FixtureAccount>();
  readonly #codes = new Map<string, IssuedCode>();
  readonly #pending = new Map<string, Pending>();
  readonly #now: () => number;
  readonly #codeLifetime: number;
  readonly #key: SigningKey;
  #stranger: SigningKey | undefined;
  #issuer: string | undefined;
  #next: FixtureAccount | "deny" | null = null;
  #tamper: Tamper | null = null;
  readonly authorizations: RecordedAuthorization[] = [];
  readonly exchanges: RecordedExchange[] = [];

  constructor(options: OAuthFixtureOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#issuer = options.issuer;
    this.#codeLifetime = options.codeLifetimeSeconds ?? 60;
    this.#key = makeKey();
  }

  get issuer(): string {
    if (this.#issuer === undefined) {
      throw new Error("the fixture has no issuer yet: pass one, or start its server first");
    }
    return this.#issuer;
  }

  /** Records where the server listens; the issuer defaults to it. */
  attach(origin: string): void {
    this.#issuer ??= origin;
  }

  registerClient(client: OAuthClient): void {
    if (client.clientSecret.length < 16) throw new Error("a client secret is at least 16 chars");
    this.#clients.set(client.clientId, client);
  }

  /** An account the chooser lists. */
  addAccount(account: FixtureAccount): void {
    this.#accounts.set(account.sub, account);
  }

  /**
   * The account the next authorization signs in as at once, as when a person has one Google
   * account; `"deny"` makes the person cancel (`error=access_denied`). Without one, the chooser.
   */
  chooseNext(choice: FixtureAccount | "deny" | null): void {
    this.#next = choice;
  }

  /** Plants a fault in the next token answer. */
  tamperNext(tamper: Tamper | null): void {
    this.#tamper = tamper;
  }

  /** The public keys, as `GET /jwks` answers. */
  jwks(): { keys: JsonObject[] } {
    return { keys: [this.#key.jwk] };
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/authorize") return this.#authorize(url);
    if (request.method === "POST" && url.pathname === "/authorize/choose") {
      return this.#choose(await request.formData());
    }
    if (request.method === "POST" && url.pathname === "/token") return this.#token(request);
    if (request.method === "GET" && url.pathname === "/jwks") {
      return Response.json(this.jwks(), { headers: { "cache-control": "public, max-age=300" } });
    }
    if (url.pathname.startsWith("/control/")) return this.#control(request, url);
    return text(404, "not found");
  }

  #checkAuthorization(
    url: URL,
  ): { ok: true; pending: Pending } | { ok: false; response: Response } {
    const p = url.searchParams;
    const refuse = (body: string) => {
      this.authorizations.push({ params: Object.fromEntries(p), outcome: "refused" });
      return { ok: false as const, response: text(400, body) };
    };
    const client = this.#clients.get(p.get("client_id") ?? "");
    if (client === undefined) return refuse("unknown client_id");
    const redirectUri = p.get("redirect_uri") ?? "";
    if (!client.redirectUris.includes(redirectUri)) return refuse("redirect_uri_mismatch");
    if (p.get("response_type") !== "code") return refuse("unsupported_response_type");
    // Any scope, as Google takes one without `openid`; the token answer then says what it granted.
    const scopes = (p.get("scope") ?? "").split(" ").filter((s) => s !== "");
    if (scopes.length === 0) return refuse("a scope is required");
    const state = p.get("state") ?? "";
    if (state === "") return refuse("a state is required");
    const challenge = p.get("code_challenge") ?? "";
    if (p.get("code_challenge_method") !== "S256" || !CODE_CHALLENGE.test(challenge)) {
      return refuse("an S256 code_challenge is required");
    }
    const nonce = p.get("nonce") ?? "";
    if (nonce === "") return refuse("a nonce is required");
    return {
      ok: true,
      pending: {
        clientId: client.clientId,
        redirectUri,
        codeChallenge: challenge,
        nonce,
        state,
        scope: scopes.join(" "),
        expiresAt: this.#now() + 10 * 60_000,
      },
    };
  }

  #issueCode(pending: Pending, account: FixtureAccount): Response {
    const code = base64url(randomBytes(32));
    this.#codes.set(code, {
      ...pending,
      expiresAt: this.#now() + this.#codeLifetime * 1000,
      account,
      tamper: this.#tamper,
      used: false,
    });
    this.#tamper = null;
    return redirectTo(pending.redirectUri, { code, state: pending.state });
  }

  #authorize(url: URL): Response {
    const checked = this.#checkAuthorization(url);
    if (!checked.ok) return checked.response;
    const { pending } = checked;
    const params = Object.fromEntries(url.searchParams);
    const next = this.#next;
    if (next === "deny") {
      this.#next = null;
      this.authorizations.push({ params, outcome: "denied" });
      return redirectTo(pending.redirectUri, denied(pending.state));
    }
    if (next !== null) {
      this.#next = null;
      this.authorizations.push({ params, outcome: "code" });
      return this.#issueCode(pending, next);
    }
    this.authorizations.push({ params, outcome: "chooser" });
    const request = base64url(randomBytes(16));
    this.#pending.set(request, pending);
    const accounts = [...this.#accounts.values()]
      .map(
        (a) =>
          `<li><button type="submit" name="sub" value="${escapeHtml(a.sub)}">${escapeHtml(a.email)}</button></li>`,
      )
      .join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Choose an account</title></head>
<body><main><h1>Choose an account</h1><p>to continue to the fixture client</p>
<form method="post" action="/authorize/choose"><input type="hidden" name="request" value="${request}">
<ul>${accounts}</ul><button type="submit" name="cancel" value="1">Cancel</button></form></main></body></html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; form-action 'self'",
      },
    });
  }

  #choose(form: FormData): Response {
    const pending = this.#pending.get(String(form.get("request") ?? ""));
    if (pending === undefined) return text(400, "unknown or used authorization request");
    this.#pending.delete(String(form.get("request")));
    if (form.get("cancel") !== null) {
      return redirectTo(pending.redirectUri, denied(pending.state));
    }
    const account = this.#accounts.get(String(form.get("sub") ?? ""));
    if (account === undefined) return text(400, "unknown account");
    return this.#issueCode(pending, account);
  }

  #clientOf(request: Request, form: URLSearchParams): OAuthClient | null {
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(request.headers.get("authorization") ?? "");
    if (basic?.[1] !== undefined) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon > 0) {
        id = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      }
    }
    const client = this.#clients.get(id ?? "");
    return client !== undefined && client.clientSecret === secret ? client : null;
  }

  async #token(request: Request): Promise<Response> {
    const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim();
    if (type !== "application/x-www-form-urlencoded") return tokenError("invalid_request");
    const form = new URLSearchParams(await request.text());
    const record = (outcome: "issued" | "refused", error?: string): void => {
      this.exchanges.push({
        clientId: form.get("client_id"),
        redirectUri: form.get("redirect_uri"),
        pkce: form.get("code_verifier") !== null,
        outcome,
        ...(error === undefined ? {} : { error }),
      });
    };
    const client = this.#clientOf(request, form);
    if (client === null) {
      record("refused", "invalid_client");
      return tokenError("invalid_client", 401);
    }
    if (form.get("grant_type") !== "authorization_code") {
      record("refused", "unsupported_grant_type");
      return tokenError("unsupported_grant_type");
    }
    const code = this.#codes.get(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const refuse = (error: string) => {
      record("refused", error);
      return tokenError(error);
    };
    if (code === undefined || code.used || code.expiresAt <= this.#now()) {
      return refuse("invalid_grant");
    }
    // A code works once, even when the exchange then fails.
    code.used = true;
    if (code.clientId !== client.clientId) return refuse("invalid_grant");
    if (form.get("redirect_uri") !== code.redirectUri) return refuse("invalid_grant");
    if (!VERIFIER.test(verifier)) return refuse("invalid_grant");
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    if (challenge !== code.codeChallenge) return refuse("invalid_grant");
    if (code.tamper === "token_error") return refuse("server_error");
    record("issued");
    const scopes = code.scope.split(" ");
    return Response.json(
      {
        access_token: base64url(randomBytes(24)),
        token_type: "Bearer",
        expires_in: 3599,
        scope: code.scope,
        // Google answers an ID token only for an identity scope.
        ...(scopes.some((s) => IDENTITY_SCOPES.has(s)) ? { id_token: this.#idToken(code) } : {}),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  #idToken(code: IssuedCode): string {
    const now = Math.floor(this.#now() / 1000);
    const { account, tamper } = code;
    const scopes = code.scope.split(" ");
    const claims: Record<string, unknown> = {
      iss: tamper === "issuer" ? "https://issuer.example.org" : this.issuer,
      azp: code.clientId,
      aud: tamper === "audience" ? "another-client.example.org" : code.clientId,
      sub: account.sub,
      nonce: tamper === "nonce" ? base64url(randomBytes(16)) : code.nonce,
      iat: tamper === "issued_long_ago" ? now - 7200 : now,
      exp: tamper === "expired" ? now - 600 : now + 3600,
    };
    // The address only for the `email` scope, the profile only for `profile`, as Google sends them.
    if (scopes.includes("email")) {
      claims.email = account.email;
      claims.email_verified = tamper === "unverified" ? false : (account.emailVerified ?? true);
    }
    if (scopes.includes("profile") && account.name !== undefined) claims.name = account.name;
    if (account.hd !== undefined) claims.hd = account.hd;
    if (tamper === "alg_none") return unsignedToken({ alg: "none", typ: "JWT" }, claims);
    let signer = this.#key;
    if (tamper === "signature") {
      this.#stranger ??= makeKey();
      signer = this.#stranger;
    }
    const kid = tamper === "unknown_kid" ? "kid-not-listed" : this.#key.kid;
    return signRs256({ alg: "RS256", kid, typ: "JWT" }, claims, signer.privateKey);
  }

  async #control(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET" && url.pathname === "/control/requests") {
      return Response.json({ authorizations: this.authorizations, exchanges: this.exchanges });
    }
    if (request.method !== "POST") return text(405, "method not allowed");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) return text(400, "a JSON body is required");
    if (url.pathname === "/control/accounts") {
      this.addAccount(body as unknown as FixtureAccount);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/control/next") {
      const choice = body.choice;
      this.chooseNext(
        choice === "deny" ? "deny" : choice === null ? null : (choice as FixtureAccount),
      );
      return Response.json({ ok: true });
    }
    if (url.pathname === "/control/tamper") {
      this.tamperNext((body.tamper ?? null) as Tamper | null);
      return Response.json({ ok: true });
    }
    return text(404, "not found");
  }
}

/** The fixture's requests as Web requests, for the harness's listener. */
function toRequest(origin: string, request: HostRequest): Request {
  const headers = new Headers();
  for (const [name, value] of request.headers) headers.append(name, value);
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
  return new Request(new URL(request.target, origin), {
    method: request.method,
    headers,
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  } as RequestInit);
}

export interface RunningOAuthFixture extends Listening {
  readonly fixture: OAuthFixture;
}

/** Serves the fixture on loopback over plain http (Node and a browser both reach it there). */
export async function startOAuthFixture(
  fixture: OAuthFixture,
  options: { readonly port?: number } = {},
): Promise<RunningOAuthFixture> {
  let origin = "http://127.0.0.1";
  const listening = await listen((request) => fixture.handle(toRequest(origin, request)), {
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  origin = listening.origin;
  fixture.attach(listening.origin);
  return { ...listening, fixture };
}
