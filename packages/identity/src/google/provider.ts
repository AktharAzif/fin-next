// Fin's Google provider for the developer realm (spec 02 §5.8): an OpenID Connect
// authorization-code flow with PKCE (S256), a nonce bound to the state, the exact redirect URI the
// client is registered with, `prompt=select_account`, redirect only (no ID token from the client),
// and verified addresses only. The library's own Google provider is not used: on 1.7.25 it sends
// no nonce and believes the ID token it is handed without checking its signature (UNVERIFIED as a
// risk over TLS, but the plan asks for the nonce, and Fin checks every token it trusts).
//
// No outbound call happens inside a unit of work (ARCHITECTURE principle 14: a request never holds
// a pooled database client across outbound I/O). So the realm calls `prefetch()` for
// `GET /callback/google` before it opens the request's unit, and the prefetch exchanges a code
// only for the browser that started the sign-in, once (state.ts): the state cookie must carry the
// state under the realm's signature, and then, in a short unit of its own, the network's exchange
// allowance is counted (§5.6) and the stored state, unexpired, is claimed for this request. It
// exchanges the code and verifies the ID token with no client held, and leaves the outcome in the
// request state: a verified token, a failure of Fin or the provider (lined here), or a refusal of
// what the client sent, its own authorization request included (flow.ts says which is which).
// Inside the unit the library's `validateAuthorizationCode` and `getUserInfo` only read that
// outcome, and refuse anything that does not match the code, the verifier and the nonce the
// library itself parsed.
//
// The staff realm uses the same provider with its Workspace client (staff.ts): the authorization
// request also names the Workspace domain (`hd`, a hint to the account chooser; the ID token's
// `hd` claim is what is checked), and the library is told never to make a member from a profile.
import { createHash, type KeyObject } from "node:crypto";
import type { RealmName } from "../config.ts";
import type { Clock } from "../ports/clock.ts";
import type { LineSink } from "../ports/log.ts";
import { type GoogleFailure, type GoogleFlow, isClientRefusal } from "./flow.ts";
import { keysFromJwks, verifyIdToken } from "./id-token.ts";
import type { GoogleSettings } from "./settings.ts";
import { type StateClaim, verifiedCookieValue } from "./state.ts";

const SCOPES = "openid email profile";
const FETCH_TIMEOUT_MS = 8000;
const JWKS_MAX_AGE_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const CODE = /^[\x21-\x7e]{1,2048}$/;

export interface GoogleSignInDeps {
  readonly settings: GoogleSettings;
  readonly clock: Clock;
  readonly lines: LineSink;
  readonly realm: RealmName;
  /** The state cookie's full name (`__Host-fin.state`, `__Host-fin-admin.state`). */
  readonly stateCookie: string;
  /** The secret the library signs the state cookie with: the realm's newest. */
  readonly stateSecret: string;
  /** The request's Google flow (bound with the realm's request state). */
  readonly flow: () => GoogleFlow;
  readonly fetch?: typeof fetch;
}

/** A callback the realm answers itself, before its unit of work: the exchange limit refused it. */
export interface PrefetchRefusal {
  readonly retryAfter: number;
}

export interface GoogleSignIn {
  /** The provider object the library's social routes call (`context.socialProviders`). */
  readonly provider: Record<string, unknown>;
  /**
   * Exchanges a callback's code and verifies its ID token, before the request's unit of work
   * opens. `claim` counts the network's exchange allowance and claims the state, in a short unit
   * of its own. Answers the refusal the realm sends instead of running the library, or null.
   */
  prefetch(
    request: Request,
    claim: (state: string) => Promise<StateClaim>,
  ): Promise<PrefetchRefusal | null>;
}

/** What the token endpoint answered. */
type Exchange =
  | { readonly kind: "token"; readonly idToken: string }
  | { readonly kind: "refused"; readonly refusal: "invalid_code" | "scope" }
  | { readonly kind: "failed" };

/**
 * The token endpoint's errors (with 400) about the grant: the code, which the client sends, and
 * the authorization request it was issued for, which passes through the client's browser.
 * `invalid_grant` (RFC 6749 §5.2: a code made up, used or expired, or issued for another sign-in,
 * redirect URI, client or PKCE challenge), `invalid_request` (what a provider may answer to a
 * verifier for a code whose request carried no challenge, the client having removed it) and
 * Google's `redirect_uri_mismatch` (a code issued for another of the client's redirect URIs). Fin
 * builds the rest of the token request from its settings, and its unit test pins it. Fin's own
 * credentials or configuration refused (`invalid_client`, `unauthorized_client`,
 * `unsupported_grant_type`, a 401) and any other answer are failures.
 */
const GRANT_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_request",
  "redirect_uri_mismatch",
]);

/** Whether a token answer's granted scope (RFC 6749 §5.1, space-delimited) names `openid`. */
function grantsOpenId(scope: unknown): boolean {
  return typeof scope === "string" && scope.split(" ").includes("openid");
}

/** The `error` of a token endpoint's error answer (RFC 6749 §5.2), or null. */
async function tokenError(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const error = (body as Record<string, unknown>).error;
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}

export function createGoogleSignIn(deps: GoogleSignInDeps): GoogleSignIn {
  const { settings } = deps;
  const doFetch = deps.fetch ?? fetch;
  let jwks: { keys: Map<string, KeyObject>; fetchedAt: number } | null = null;

  const failed = (reason: GoogleFailure): void => {
    deps.lines.write("auth.google_failed", "warn", { realm: deps.realm, reason });
  };

  async function fetchKeys(): Promise<Map<string, KeyObject> | null> {
    try {
      const response = await doFetch(settings.endpoints.jwks, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status !== 200) return null;
      const keys = keysFromJwks(await response.json());
      return keys.size === 0 ? null : keys;
    } catch {
      return null;
    }
  }

  /** A signing key by `kid`: the cached set while fresh, refetched for a new `kid` at most once a minute. */
  async function keyFor(kid: string): Promise<KeyObject | null | "unavailable"> {
    const now = deps.clock.now().getTime();
    const fresh = jwks !== null && now - jwks.fetchedAt < JWKS_MAX_AGE_MS;
    const cached = fresh ? jwks?.keys.get(kid) : undefined;
    if (cached !== undefined) return cached;
    if (jwks !== null && fresh && now - jwks.fetchedAt < JWKS_MIN_REFETCH_MS) return null;
    const keys = await fetchKeys();
    if (keys === null) return jwks?.keys.get(kid) ?? "unavailable";
    jwks = { keys, fetchedAt: now };
    return keys.get(kid) ?? null;
  }

  /**
   * POSTs the code to the token endpoint. A grant error (GRANT_ERRORS) is the client's doing: a
   * refusal. So is a token answer without an ID token, unless the provider says it granted
   * `openid`: the client can take the identity scopes out of its request. Any other error, an
   * unreadable answer or a timeout is a failure on Fin's side or the provider's.
   */
  async function exchange(code: string, codeVerifier: string): Promise<Exchange> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: settings.redirectUri,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
    });
    try {
      const response = await doFetch(settings.endpoints.token, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 200) {
        const answer: unknown = await response.json();
        if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
          return { kind: "failed" };
        }
        const fields = answer as Record<string, unknown>;
        if (typeof fields.id_token === "string") return { kind: "token", idToken: fields.id_token };
        // A token answer (RFC 6749 §5.1: it carries an access token) without an ID token: the
        // request asked for none, unless the provider says it granted `openid` and sent none.
        return typeof fields.access_token === "string" && !grantsOpenId(fields.scope)
          ? { kind: "refused", refusal: "scope" }
          : { kind: "failed" };
      }
      if (response.status === 400 && GRANT_ERRORS.has((await tokenError(response)) ?? "")) {
        return { kind: "refused", refusal: "invalid_code" };
      }
      return { kind: "failed" };
    } catch {
      return { kind: "failed" };
    }
  }

  async function prefetch(
    request: Request,
    claim: (state: string) => Promise<StateClaim>,
  ): Promise<PrefetchRefusal | null> {
    const flow = deps.flow();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code === null || state === null || !CODE.test(code) || !STATE.test(state)) return null;
    // Only the browser that started this sign-in gets an exchange: its state cookie must carry
    // this state under the realm's own signature. Anything else never reaches the database here;
    // the library refuses it in the unit (`state_mismatch`).
    const cookie = request.headers.get("cookie");
    if (verifiedCookieValue(cookie, deps.stateCookie, deps.stateSecret) !== state) return null;
    const claimed = await claim(state);
    switch (claimed.kind) {
      case "limited":
        return { retryAfter: claimed.retryAfter };
      case "none":
        // Unknown or expired: nothing to exchange, and the library refuses it in the unit.
        return null;
      case "spent":
        // Another callback holds this state's one exchange; the callback's before-hook refuses
        // this one before the library could consume the state under it.
        flow.spentState = { errorURL: claimed.stored.errorURL };
        return null;
      case "claimed":
        break;
    }
    const stored = claimed.stored;
    const base = {
      code,
      codeVerifier: stored.codeVerifier,
      linkIntentId: stored.linkIntentId,
    };
    const exchanged = await exchange(code, stored.codeVerifier);
    if (exchanged.kind === "refused") {
      // The after-hook lines the refusal (`auth.google_refused`).
      flow.prefetched = { ...base, kind: "refused", refusal: exchanged.refusal };
      return null;
    }
    if (exchanged.kind === "failed") {
      failed("token_exchange");
      flow.prefetched = { ...base, kind: "failed", failure: "token_exchange" };
      return null;
    }
    const idToken = exchanged.idToken;
    let unavailable = false;
    const result = await verifyIdToken(
      idToken,
      {
        issuers: settings.endpoints.issuers,
        clientId: settings.clientId,
        nonce: stored.idTokenNonce,
        now: deps.clock.now().getTime(),
      },
      async (kid) => {
        const key = await keyFor(kid);
        if (key === "unavailable") {
          unavailable = true;
          return null;
        }
        return key;
      },
    );
    if (unavailable) {
      failed("jwks");
      flow.prefetched = { ...base, kind: "failed", failure: "jwks" };
      return null;
    }
    if (result.ok) {
      flow.prefetched = {
        ...base,
        kind: "token",
        nonce: stored.idTokenNonce,
        idToken,
        claims: result.claims,
      };
      return null;
    }
    if (isClientRefusal(result.reason)) {
      // A nonce, scope or address the client's own request (or the person's account) caused: the
      // after-hook lines the refusal.
      flow.prefetched = { ...base, kind: "refused", refusal: result.reason };
      return null;
    }
    failed(result.reason);
    flow.prefetched = { ...base, kind: "failed", failure: result.reason };
    return null;
  }

  const provider = {
    id: "google",
    name: "Google",
    // The library mints a nonce for the redirect, keeps it in the state, and hands it back to
    // getUserInfo as `expectedIdTokenNonce`.
    requiresIdTokenNonce: true,
    options: {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      redirectURI: settings.redirectUri,
      prompt: "select_account",
      disableIdTokenSignIn: true,
      overrideUserInfoOnSignIn: false,
      requireEmailVerification: false,
      // Staff rows are made only by Fin's staff routes (§10.2): never a sign-up through Google.
      ...(deps.realm === "staff" ? { disableSignUp: true } : {}),
    },
    accountSubject: ({ profile }: { profile: { sub?: unknown } }) => {
      if (typeof profile.sub !== "string" || profile.sub === "") {
        throw new Error("identity: a Google profile without a subject");
      }
      return profile.sub;
    },
    createAuthorizationURL(input: {
      state: string;
      codeVerifier: string;
      redirectURI: string;
      idTokenNonce?: string;
    }): URL {
      if (input.idTokenNonce === undefined || input.idTokenNonce === "") {
        throw new Error("identity: a Google sign-in without a nonce");
      }
      if (input.redirectURI !== settings.redirectUri) {
        // The library computes the callback from its base URL; it must be the registered one.
        throw new Error("identity: the Google callback is not the registered redirect URI");
      }
      const url = new URL(settings.endpoints.authorization);
      const challenge = createHash("sha256")
        .update(input.codeVerifier, "ascii")
        .digest("base64url");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", settings.clientId);
      url.searchParams.set("redirect_uri", settings.redirectUri);
      url.searchParams.set("scope", SCOPES);
      url.searchParams.set("state", input.state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("nonce", input.idTokenNonce);
      url.searchParams.set("prompt", "select_account");
      if (settings.hostedDomain !== undefined) url.searchParams.set("hd", settings.hostedDomain);
      return url;
    },
    async validateAuthorizationCode(input: {
      code: string;
      codeVerifier?: string;
      redirectURI: string;
    }) {
      const prefetched = deps.flow().prefetched;
      if (
        prefetched === null ||
        prefetched.code !== input.code ||
        prefetched.codeVerifier !== input.codeVerifier ||
        input.redirectURI !== settings.redirectUri ||
        prefetched.kind !== "token"
      ) {
        return null;
      }
      // Only the ID token: no access or refresh token is kept or handed out (§4.2).
      return { idToken: prefetched.idToken, tokenType: "Bearer" };
    },
    async getUserInfo(tokens: { idToken?: string; expectedIdTokenNonce?: string }) {
      const flow = deps.flow();
      const prefetched = flow.prefetched;
      if (
        prefetched === null ||
        prefetched.kind !== "token" ||
        tokens.idToken !== prefetched.idToken ||
        tokens.expectedIdTokenNonce === undefined ||
        tokens.expectedIdTokenNonce !== prefetched.nonce
      ) {
        return null;
      }
      const claims = prefetched.claims;
      flow.claims = claims;
      return {
        user: { email: claims.email, emailVerified: true, name: claims.name ?? "" },
        data: { sub: claims.sub, email: claims.email, email_verified: true },
      };
    },
  };

  return { provider, prefetch };
}
