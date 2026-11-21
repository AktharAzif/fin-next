// The Cloudflare Access stand-in (spec 02 §19.3; ARCHITECTURE §5.5): an RS256 issuer of Access
// application tokens and the certs endpoint their verifier reads, test target only ([SA-38]).
//
// Tokens carry Access's application claims: `aud` (the application's AUD tags), `email`, `exp`,
// `iat`, `nbf`, `iss`, `type: "app"`, `identity_nonce`, `sub` and `country`, under a header with
// `alg: "RS256"` and the signing key's `kid`. The certs answer is Access's `{ keys: [JWK...] }`;
// Access also lists PEM certificates (`public_cert`, `public_certs`), which node:crypto cannot
// mint, so the stand-in leaves them out and verifiers read `keys`.
//
// Staging's Access policy allows the company domain with One-time PIN; here an allowed domain is
// a fixture domain, and "signing in" is a test asking for a token for an address.
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Handler, type Listening, listen } from "../http/node.ts";
import { decodeToken, type JsonObject, signRs256, verifyRs256 } from "./jwt.ts";

export interface AccessStandInOptions {
  /** The application's AUD tag. Tests build it at run time; it is never a real tag. */
  readonly audience: string;
  /** The `iss` claim. Defaults to the stand-in server's origin once it starts. */
  readonly issuer?: string;
  /** Address domains the policy allows (default: example.com). */
  readonly allowedDomains?: readonly string[];
  /** Token lifetime in seconds (default 24 hours, Access's default session). */
  readonly lifetimeSeconds?: number;
  /** Milliseconds since the epoch; defaults to the system clock, read per call. */
  readonly now?: () => number;
}

export interface IssueOptions {
  readonly email: string;
  /** Overrides for tests of a verifier's refusals. */
  readonly audience?: string | readonly string[];
  readonly issuer?: string;
  readonly issuedAt?: number;
  readonly notBefore?: number;
  readonly expiresAt?: number;
  readonly type?: string;
  /** The header's `kid`; a value the certs do not list makes an unknown-key token. */
  readonly kid?: string;
  /** "stranger" signs with a key the certs never list, under the current key's `kid`. */
  readonly signWith?: "current" | "stranger";
  readonly claims?: JsonObject;
}

export interface AccessIdentity {
  readonly email: string;
  readonly token: string;
}

/** What the static host needs from Access in front of an app host. */
export interface AccessGate {
  /** The identity a `CF_Authorization` token proves now, or undefined. */
  verify(token: string): AccessIdentity | undefined;
  /** Where Access sends a visitor with no valid token. */
  loginUrl(appOrigin: string, redirectPath: string): string;
}

export interface AccessJwk {
  readonly kid: string;
  readonly kty: "RSA";
  readonly alg: "RS256";
  readonly use: "sig";
  readonly n: string;
  readonly e: string;
}

interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: AccessJwk;
}

function makeKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  const n = String(exported.n);
  const e = String(exported.e);
  const kid = createHash("sha256").update(n).digest("hex");
  return { kid, privateKey, jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n, e } };
}

function uuidFrom(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

export class AccessStandIn {
  readonly audience: string;
  readonly #allowedDomains: readonly string[];
  readonly #lifetime: number;
  readonly #now: () => number;
  #issuer: string | undefined;
  #serverOrigin: string | undefined;
  #keys: SigningKey[];
  #stranger: SigningKey | undefined;
  #nonce = 0;

  constructor(options: AccessStandInOptions) {
    if (options.audience === "") throw new Error("the stand-in needs an audience");
    this.audience = options.audience;
    this.#issuer = options.issuer;
    this.#allowedDomains = (options.allowedDomains ?? ["example.com"]).map((d) => d.toLowerCase());
    this.#lifetime = options.lifetimeSeconds ?? 24 * 60 * 60;
    this.#now = options.now ?? Date.now;
    this.#keys = [makeKey()];
  }

  get issuer(): string {
    if (this.#issuer === undefined) {
      throw new Error("the stand-in has no issuer yet: pass one, or start its server first");
    }
    return this.#issuer;
  }

  /**
   * Records where the stand-in's server listens (startAccessStandIn calls this). The login page
   * is served there, and the issuer defaults to it.
   */
  attach(serverOrigin: string): void {
    this.#serverOrigin = serverOrigin;
    this.#issuer ??= serverOrigin;
  }

  /** The key that signs new tokens. */
  get currentKid(): string {
    return (this.#keys.at(-1) as SigningKey).kid;
  }

  /** True when the policy lets this address sign in. */
  allows(email: string): boolean {
    return this.#allowedDomains.includes(domainOf(email));
  }

  /** Issues an application token for `email`. Refuses an address the policy does not allow. */
  issue(options: IssueOptions): string {
    if (!this.allows(options.email)) {
      throw new Error("the Access policy does not allow this address's domain");
    }
    const now = Math.floor(this.#now() / 1000);
    const current = this.#keys.at(-1) as SigningKey;
    let signer = current;
    if (options.signWith === "stranger") {
      this.#stranger ??= makeKey();
      signer = this.#stranger;
    }
    this.#nonce += 1;
    const audience = options.audience ?? this.audience;
    const payload: JsonObject = {
      aud: typeof audience === "string" ? [audience] : [...audience],
      email: options.email,
      exp: options.expiresAt ?? now + this.#lifetime,
      iat: options.issuedAt ?? now,
      nbf: options.notBefore ?? now,
      iss: options.issuer ?? this.issuer,
      type: options.type ?? "app",
      identity_nonce: `nonce-${this.#nonce}`,
      sub: uuidFrom(options.email.toLowerCase()),
      country: "XX",
      ...options.claims,
    };
    const header = { alg: "RS256", kid: options.kid ?? current.kid, typ: "JWT" };
    return signRs256(header, payload, signer.privateKey);
  }

  /** The certs endpoint's answer: every listed key. */
  certs(): { readonly keys: readonly AccessJwk[] } {
    return { keys: this.#keys.map((key) => key.jwk) };
  }

  /** Adds a new signing key; the previous ones stay listed until retired. Returns its `kid`. */
  rotate(): string {
    const key = makeKey();
    this.#keys.push(key);
    return key.kid;
  }

  /** Stops listing a key, so tokens it signed stop verifying. */
  retire(kid: string): void {
    if (this.#keys.length === 1 && this.#keys[0]?.kid === kid) {
      throw new Error("the stand-in keeps at least one key");
    }
    this.#keys = this.#keys.filter((key) => key.kid !== kid);
  }

  /** Checks a token as Access's edge does before it lets a request through. */
  verify(token: string): AccessIdentity | undefined {
    let decoded: ReturnType<typeof decodeToken>;
    try {
      decoded = decodeToken(token);
    } catch {
      return undefined;
    }
    const { header, payload } = decoded;
    const key = this.#keys.find((candidate) => candidate.kid === header.kid);
    if (key === undefined || !verifyRs256(decoded, key.jwk as unknown as JsonObject)) {
      return undefined;
    }
    const now = Math.floor(this.#now() / 1000);
    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    const email = payload.email;
    if (
      payload.iss !== this.#issuer ||
      !audiences.includes(this.audience) ||
      payload.type !== "app" ||
      typeof payload.exp !== "number" ||
      payload.exp <= now ||
      typeof payload.nbf !== "number" ||
      payload.nbf > now ||
      typeof email !== "string" ||
      !this.allows(email)
    ) {
      return undefined;
    }
    return { email, token };
  }

  /** The stand-in's login page for an app; `startAccessStandIn` serves it. */
  loginUrl(appOrigin: string, redirectPath: string): string {
    if (this.#serverOrigin === undefined) {
      throw new Error("the stand-in's server is not running, so it has no login page");
    }
    const url = new URL("/cdn-cgi/access/login", this.#serverOrigin);
    url.searchParams.set("app", appOrigin);
    url.searchParams.set("redirect_url", redirectPath);
    return url.href;
  }

  gate(): AccessGate {
    return {
      verify: (token) => this.verify(token),
      loginUrl: (appOrigin, redirectPath) => this.loginUrl(appOrigin, redirectPath),
    };
  }
}

/** True for an http(s) origin on loopback: the only places the stand-in sends a browser. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === origin &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  );
}

/** A path a redirect may carry: one leading slash, no backslash, no scheme. */
export function isLocalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

export function accessStandInHandler(standIn: AccessStandIn): Handler {
  return async (request) => {
    const url = new URL(request.target, "http://stand-in.invalid");
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (url.pathname === "/cdn-cgi/access/certs") {
      return Response.json(standIn.certs(), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/cdn-cgi/access/login") {
      const app = url.searchParams.get("app") ?? "";
      const redirect = url.searchParams.get("redirect_url") ?? "/";
      const email = url.searchParams.get("email");
      if (!isLoopbackOrigin(app) || !isLocalPath(redirect)) {
        return new Response("the stand-in redirects only to a loopback app and a local path\n", {
          status: 400,
        });
      }
      if (email === null) {
        return new Response("Access stand-in: sign in by adding ?email=<a fixture address>\n", {
          status: 401,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (!standIn.allows(email)) {
        return new Response("Access stand-in: this address is not allowed\n", { status: 403 });
      }
      const authorized = new URL("/cdn-cgi/access/authorized", app);
      authorized.searchParams.set("token", standIn.issue({ email }));
      authorized.searchParams.set("redirect_url", redirect);
      return new Response(null, { status: 302, headers: { location: authorized.href } });
    }
    return new Response(null, { status: 404 });
  };
}

export interface RunningAccessStandIn extends Listening {
  readonly standIn: AccessStandIn;
  /** The URL verifiers read the keys from. */
  readonly certsUrl: string;
}

/** Serves the stand-in's certs and login endpoints on loopback. */
export async function startAccessStandIn(
  standIn: AccessStandIn,
  options: { readonly port?: number } = {},
): Promise<RunningAccessStandIn> {
  const listening = await listen(accessStandInHandler(standIn), {
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  standIn.attach(listening.origin);
  return {
    ...listening,
    standIn,
    certsUrl: `${listening.origin}/cdn-cgi/access/certs`,
  };
}
