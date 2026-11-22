// The Cloudflare Access check on Fin Admin's API half (spec 01 §7.7; spec 02 §2.2 step 4, §10.5;
// ARCHITECTURE §5.10). Every request carries `Cf-Access-Jwt-Assertion`, verified with Web Crypto:
// RS256 only, the key by `kid` from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
// (the issuer is built from FIN_ACCESS_TEAM, never read as a URL, [SA-38]); `iss` equals that
// origin; `aud` contains FIN_ACCESS_AUD; `exp` and `nbf` with 60 seconds of leeway; `type` is `app`;
// `email` and `sub` present. Keys are cached for at most 5 minutes; an unknown `kid` refreshes at
// most once every 30 seconds; a fetch has a 5-second timeout and fails closed (503
// `access_unavailable`, `access.keys_unavailable`). A refused token is 401 `access_required` with
// `access.jwt_refused` and its reason.
import { type Clock, UnavailableError } from "@fin/core";
import type { AccessIdentity, FinContext, FinEnv } from "@fin/server/http";
import type { Telemetry } from "@fin/server/telemetry";
import type { MiddlewareHandler } from "hono";

export const ACCESS_HEADER = "cf-access-jwt-assertion";
export const KEY_CACHE_MS = 5 * 60_000;
export const UNKNOWN_KID_REFRESH_MS = 30_000;
export const CERTS_TIMEOUT_MS = 5000;
export const LEEWAY_S = 60;

export type AccessRefusal = "missing" | "signature" | "iss" | "aud" | "expired" | "type";

export type AccessResult =
  | { ok: true; identity: AccessIdentity }
  | { ok: false; reason: AccessRefusal };

export class AccessKeysUnavailable extends UnavailableError {
  constructor() {
    super("access_unavailable", "Access's signing keys could not be read");
    this.name = "AccessKeysUnavailable";
  }
}

export interface AccessVerifierOptions {
  team: string;
  aud: string;
  clock: Clock;
  fetch?: typeof fetch;
  cacheMs?: number;
  unknownKidRefreshMs?: number;
  timeoutMs?: number;
}

interface Jwk {
  kid?: unknown;
  kty?: unknown;
  alg?: unknown;
  n?: unknown;
  e?: unknown;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function decodeSegment(segment: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return undefined;
  try {
    return new Uint8Array(Buffer.from(segment, "base64url"));
  } catch {
    return undefined;
  }
}

function decodeJson(segment: string): Record<string, unknown> | undefined {
  const bytes = decodeSegment(segment);
  if (bytes === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Access's issuer for a team, built from the name alone. */
export function accessIssuer(team: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(team)) {
    throw new TypeError("an Access team name is one DNS label");
  }
  return `https://${team}.cloudflareaccess.com`;
}

export class AccessVerifier {
  readonly issuer: string;
  private readonly aud: string;
  private readonly clock: Clock;
  private readonly send: typeof fetch;
  private readonly cacheMs: number;
  private readonly unknownKidRefreshMs: number;
  private readonly timeoutMs: number;
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private lastUnknownRefresh = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | undefined;

  constructor(options: AccessVerifierOptions) {
    this.issuer = accessIssuer(options.team);
    this.aud = options.aud;
    this.clock = options.clock;
    this.send = options.fetch ?? fetch;
    this.cacheMs = options.cacheMs ?? KEY_CACHE_MS;
    this.unknownKidRefreshMs = options.unknownKidRefreshMs ?? UNKNOWN_KID_REFRESH_MS;
    this.timeoutMs = options.timeoutMs ?? CERTS_TIMEOUT_MS;
  }

  private refresh(): Promise<void> {
    if (this.pending !== undefined) return this.pending;
    this.pending = (async () => {
      let body: { keys?: unknown };
      try {
        const response = await this.send(`${this.issuer}/cdn-cgi/access/certs`, {
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "error",
          headers: { accept: "application/json" },
        });
        if (response.status !== 200) throw new Error("status");
        body = (await response.json()) as { keys?: unknown };
      } catch {
        throw new AccessKeysUnavailable();
      }
      const next = new Map<string, CryptoKey>();
      for (const jwk of Array.isArray(body.keys) ? (body.keys as Jwk[]) : []) {
        if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
        if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
        if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
        try {
          const key = await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
          next.set(jwk.kid, key);
        } catch {
          // A key that does not import is not a key.
        }
      }
      if (next.size === 0) throw new AccessKeysUnavailable();
      this.keys = next;
      this.fetchedAt = this.clock.now();
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async keyFor(kid: string): Promise<CryptoKey | undefined> {
    const now = this.clock.now();
    if (now - this.fetchedAt >= this.cacheMs) await this.refresh();
    let key = this.keys.get(kid);
    if (
      key === undefined &&
      this.clock.now() - this.lastUnknownRefresh >= this.unknownKidRefreshMs
    ) {
      this.lastUnknownRefresh = this.clock.now();
      await this.refresh();
      key = this.keys.get(kid);
    }
    return key;
  }

  /** Verifies one token. Throws AccessKeysUnavailable when the keys cannot be read. */
  async verify(token: string | undefined): Promise<AccessResult> {
    if (token === undefined || token === "") return { ok: false, reason: "missing" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "signature" };
    const [head = "", payload = "", signature = ""] = parts;
    const header = decodeJson(head);
    const claims = decodeJson(payload);
    const sig = decodeSegment(signature);
    if (header === undefined || claims === undefined || sig === undefined) {
      return { ok: false, reason: "signature" };
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      return { ok: false, reason: "signature" };
    }
    const key = await this.keyFor(header.kid);
    if (key === undefined) return { ok: false, reason: "signature" };
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      sig,
      encoder.encode(`${head}.${payload}`),
    );
    if (!valid) return { ok: false, reason: "signature" };
    if (claims.iss !== this.issuer) return { ok: false, reason: "iss" };
    const aud = claims.aud;
    const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
    if (!audiences.includes(this.aud)) return { ok: false, reason: "aud" };
    const now = Math.floor(this.clock.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < now) {
      return { ok: false, reason: "expired" };
    }
    if (
      claims.nbf !== undefined &&
      (typeof claims.nbf !== "number" || claims.nbf - LEEWAY_S > now)
    ) {
      return { ok: false, reason: "expired" };
    }
    if (claims.type !== "app") return { ok: false, reason: "type" };
    if (typeof claims.email !== "string" || claims.email === "")
      return { ok: false, reason: "missing" };
    if (typeof claims.sub !== "string" || claims.sub === "")
      return { ok: false, reason: "missing" };
    return { ok: true, identity: { sub: claims.sub, email: claims.email } };
  }
}

export interface AccessCheckOptions {
  verifier: AccessVerifier;
  telemetry: Telemetry;
  refuse: (
    c: FinContext,
    status: 401 | 503,
    code: "access_required" | "access_unavailable",
  ) => Response;
}

/** Step 4 of Fin Admin's front door: a valid Access token on every request, before any handler. */
export function accessCheck(options: AccessCheckOptions): MiddlewareHandler<FinEnv> {
  return async (c, next) => {
    let result: AccessResult;
    try {
      result = await options.verifier.verify(c.req.header(ACCESS_HEADER));
    } catch (error) {
      if (!(error instanceof AccessKeysUnavailable)) throw error;
      options.telemetry.log("access.keys_unavailable", {}, "error");
      c.set("outcome", "error");
      c.set("reason", "access.keys_unavailable");
      return options.refuse(c, 503, "access_unavailable");
    }
    if (!result.ok) {
      options.telemetry.log("access.jwt_refused", { reason: result.reason }, "warn");
      c.set("outcome", "refused");
      c.set("reason", `access.${result.reason}`);
      return options.refuse(c, 401, "access_required");
    }
    c.set("access", result.identity);
    await next();
  };
}
