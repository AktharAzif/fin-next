// The ID token check of Google sign-in (spec 02 §5.8; OpenID Connect Core §3.1.3.7), written on
// node:crypto alone. The token comes straight from the token endpoint over TLS, and is still
// verified in full before anything in it is believed: the RS256 signature under a key the
// provider's JWKS lists by `kid`, the issuer, the audience (and `azp` when there are several),
// the expiry and issue time with a small allowance for clock skew, a nonce equal to the one this
// sign-in sent, a subject, and an address the provider says it verified. Anything else, or
// anything unreadable, is a refusal with a bounded reason; the token's contents never reach a log.
import { createPublicKey, type KeyObject, verify } from "node:crypto";

/**
 * Why an ID token was refused (§18.1). Which of these is a failure of Fin or the provider
 * (`auth.google_failed`) and which a refusal a client can cause (`auth.google_refused`) is decided
 * in flow.ts.
 */
export type IdTokenRefusal =
  | "too_long"
  | "malformed"
  | "algorithm"
  | "unknown_key"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "issued_at"
  | "nonce"
  | "subject"
  | "email"
  | "email_unverified";

/** The claims Fin reads from a verified token. */
export interface GoogleClaims {
  readonly sub: string;
  /** Lower-cased. */
  readonly email: string;
  readonly emailVerified: true;
  /** The profile name, when the provider sent one (checked by the caller before use). */
  readonly name: string | null;
  readonly issuedAt: number;
  /**
   * The Workspace domain (`hd`), lower-cased, present only when the account belongs to one; the
   * staff realm requires its own (§5.8).
   */
  readonly hostedDomain?: string;
}

export type IdTokenResult =
  | { readonly ok: true; readonly claims: GoogleClaims }
  | { readonly ok: false; readonly reason: IdTokenRefusal };

export interface IdTokenExpectations {
  readonly issuers: readonly string[];
  readonly clientId: string;
  /** The nonce this sign-in sent in its authorization request. */
  readonly nonce: string;
  /** Milliseconds since the epoch, from the injected clock. */
  readonly now: number;
}

/** Looks up a public key by `kid`; null when the provider lists none with that ID. */
export type KeyLookup = (kid: string) => Promise<KeyObject | null>;

/** Seconds of clock skew allowed either way. */
export const CLOCK_SKEW_SECONDS = 60;
/** An ID token older than this is refused, whatever its expiry says. */
export const MAX_TOKEN_AGE_SECONDS = 3600;
/**
 * The longest answer parsed as an ID token at all. A longer one is refused unread, as `malformed`
 * (a failure): it is far past anything a nonce carried in an authorization URL can make a token.
 */
export const MAX_TOKEN_READ = 64 * 1024;
/**
 * Fin's bound on an ID token, applied only once the token is proved the provider's for this client
 * now (signature, issuer, audience, times), so that `too_long`, a refusal a client can cause with a
 * long nonce, is never recorded for an answer that is not the provider's.
 */
export const MAX_TOKEN_LENGTH = 8192;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

function decodePart(part: string): Record<string, unknown> | null {
  if (!BASE64URL.test(part)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function refuse(reason: IdTokenRefusal): IdTokenResult {
  return { ok: false, reason };
}

/** The `kid` of a token's header, or null when the header is unreadable. */
export function tokenKeyId(token: string): string | null {
  const header = decodePart(token.split(".")[0] ?? "");
  return header !== null && typeof header.kid === "string" && header.kid !== "" ? header.kid : null;
}

function audienceOk(claims: Record<string, unknown>, clientId: string): boolean {
  const aud = claims.aud;
  if (typeof aud === "string") {
    if (aud !== clientId) return false;
  } else if (Array.isArray(aud)) {
    if (!aud.every((a) => typeof a === "string") || !aud.includes(clientId)) return false;
    // With more than one audience, the authorised party must be this client (OIDC §3.1.3.7).
    if (aud.length > 1 && claims.azp !== clientId) return false;
  } else {
    return false;
  }
  return claims.azp === undefined || claims.azp === clientId;
}

export async function verifyIdToken(
  token: string,
  expect: IdTokenExpectations,
  keyFor: KeyLookup,
): Promise<IdTokenResult> {
  // Nothing past the read cap is parsed; it cannot be a token the provider made for any sign-in.
  if (token.length === 0 || token.length > MAX_TOKEN_READ) return refuse("malformed");
  const parts = token.split(".");
  if (parts.length !== 3) return refuse("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodePart(headerPart);
  const claims = decodePart(payloadPart);
  if (header === null || claims === null) return refuse("malformed");
  // Only RS256, as Google signs: never `none`, never an HMAC keyed by something public.
  if (header.alg !== "RS256" || header.crit !== undefined) return refuse("algorithm");
  if (!BASE64URL.test(signaturePart)) return refuse("malformed");
  if (typeof header.kid !== "string" || header.kid === "") return refuse("unknown_key");
  const key = await keyFor(header.kid);
  if (key === null) return refuse("unknown_key");
  const signed = verify(
    "sha256",
    Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
    key,
    Buffer.from(signaturePart, "base64url"),
  );
  if (!signed) return refuse("signature");

  if (typeof claims.iss !== "string" || !expect.issuers.includes(claims.iss)) {
    return refuse("issuer");
  }
  if (!audienceOk(claims, expect.clientId)) return refuse("audience");
  const nowSeconds = Math.floor(expect.now / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    return refuse("expired");
  }
  if (
    typeof claims.iat !== "number" ||
    claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    nowSeconds - claims.iat > MAX_TOKEN_AGE_SECONDS
  ) {
    return refuse("issued_at");
  }
  // Fin's bound, now that the token is the provider's for this client: the provider's own tokens
  // are far shorter, and the one part a client can make long is the nonce it puts in its
  // authorization request.
  if (token.length > MAX_TOKEN_LENGTH) return refuse("too_long");
  if (typeof claims.nonce !== "string" || claims.nonce === "" || claims.nonce !== expect.nonce) {
    return refuse("nonce");
  }
  if (typeof claims.sub !== "string" || claims.sub === "" || claims.sub.length > 255) {
    return refuse("subject");
  }
  if (typeof claims.email !== "string") return refuse("email");
  const email = claims.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return refuse("email");
  // Verified addresses only (§5.8). Google sends a boolean; a string "true" is read as one.
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    return refuse("email_unverified");
  }
  const name = typeof claims.name === "string" && claims.name.trim() !== "" ? claims.name : null;
  const hd = typeof claims.hd === "string" ? claims.hd.trim().toLowerCase() : "";
  return {
    ok: true,
    claims: {
      sub: claims.sub,
      email,
      emailVerified: true,
      name,
      issuedAt: claims.iat,
      ...(hd === "" ? {} : { hostedDomain: hd }),
    },
  };
}

/** A JWKS answer's RSA signing keys by `kid`; anything else in it is skipped. */
export function keysFromJwks(body: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  if (typeof body !== "object" || body === null) return keys;
  const list = (body as { keys?: unknown }).keys;
  if (!Array.isArray(list)) return keys;
  for (const entry of list.slice(0, 32)) {
    if (typeof entry !== "object" || entry === null) continue;
    const jwk = entry as Record<string, unknown>;
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || jwk.kid === "") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    try {
      const key = createPublicKey({
        key: { kty: "RSA", n: jwk.n, e: jwk.e },
        format: "jwk",
      });
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
      keys.set(jwk.kid, key);
    } catch {
      // An unreadable key is no key.
    }
  }
  return keys;
}
