// Fin's Google provider for the developer realm (spec 02 §5.8): an OpenID Connect
// authorization-code flow with PKCE (S256), a nonce bound to the state, the exact redirect URI the
// client is registered with, `prompt=select_account`, redirect only (no ID token from the client),
// and verified addresses only. The library's own Google provider is not used: on 1.7.25 it sends
// no nonce and believes the ID token it is handed without checking its signature (UNVERIFIED as a
// risk over TLS, but the plan asks for the nonce, and Fin checks every token it trusts).
//
// No outbound call happens inside a unit of work (ARCHITECTURE principle 14: a request never holds
// a pooled database client across outbound I/O). So the realm calls `prefetch()` for
// `GET /callback/google` before it opens the request's unit: it reads the code's verifier and
// nonce from the OAuth state in a short unit of its own, exchanges the code and verifies the ID
// token with no client held, and leaves the outcome in the request state. Inside the unit the
// library's `validateAuthorizationCode` and `getUserInfo` only read that outcome, and refuse
// anything that does not match the code, the verifier and the nonce the library itself parsed.
import { createHash, type KeyObject } from "node:crypto";
import type { Clock } from "../ports/clock.ts";
import type { LineSink } from "../ports/log.ts";
import type { GoogleFailure, GoogleFlow } from "./flow.ts";
import { keysFromJwks, verifyIdToken } from "./id-token.ts";
import type { GoogleSettings } from "./settings.ts";

/** The key under which `/link-social` puts its step-up intent in the OAuth state. */
export const LINK_INTENT_KEY = "finStepUpIntent";

const SCOPES = "openid email profile";
const FETCH_TIMEOUT_MS = 8000;
const JWKS_MAX_AGE_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const CODE = /^[\x21-\x7e]{1,2048}$/;

/** The OAuth state the library keeps in a verification row (only the fields Fin reads). */
interface StoredState {
  codeVerifier: string;
  idTokenNonce: string;
  /** Server context only (never the client's `additionalData`): the link's intent. */
  linkIntentId: string | null;
}

const INTENT_ID = /^sti_[0-9a-hjkmnp-tv-z]{26}$/;

function storedState(value: string | null): StoredState | null {
  if (value === null) return null;
  try {
    const data = JSON.parse(value) as Record<string, unknown>;
    if (typeof data.codeVerifier !== "string" || typeof data.idTokenNonce !== "string") {
      return null;
    }
    const server = data.serverContext;
    const intent =
      typeof server === "object" && server !== null
        ? (server as Record<string, unknown>)[LINK_INTENT_KEY]
        : undefined;
    return {
      codeVerifier: data.codeVerifier,
      idTokenNonce: data.idTokenNonce,
      linkIntentId: typeof intent === "string" && INTENT_ID.test(intent) ? intent : null,
    };
  } catch {
    return null;
  }
}

/** The library's verification identifier for an OAuth state (pinned by the realm's tests). */
export function stateIdentifier(state: string): string {
  return `auth-state:${state}`;
}

/** The value part of a signed cookie (`<value>.<signature>`, URL-encoded), or null. */
function signedCookieValue(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    let raw: string;
    try {
      raw = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
    const dot = raw.lastIndexOf(".");
    return dot <= 0 ? null : raw.slice(0, dot);
  }
  return null;
}

export interface GoogleSignInDeps {
  readonly settings: GoogleSettings;
  readonly clock: Clock;
  readonly lines: LineSink;
  readonly realm: "developer";
  /** The state cookie's full name (`__Host-fin.state`). */
  readonly stateCookie: string;
  /** The request's Google flow (bound with the realm's request state). */
  readonly flow: () => GoogleFlow;
  readonly fetch?: typeof fetch;
}

export interface GoogleSignIn {
  /** The provider object the library's social routes call (`context.socialProviders`). */
  readonly provider: Record<string, unknown>;
  /**
   * Exchanges a callback's code and verifies its ID token, before the request's unit of work
   * opens. `readState` reads the library's verification row in a short unit of its own.
   */
  prefetch(
    request: Request,
    readState: (identifier: string) => Promise<string | null>,
  ): Promise<void>;
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

  /** POSTs the code to the token endpoint; the ID token, or null on any failure. */
  async function exchange(code: string, codeVerifier: string): Promise<string | null> {
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
      if (response.status !== 200) return null;
      const answer = (await response.json()) as Record<string, unknown>;
      return typeof answer.id_token === "string" ? answer.id_token : null;
    } catch {
      return null;
    }
  }

  async function prefetch(
    request: Request,
    readState: (identifier: string) => Promise<string | null>,
  ): Promise<void> {
    const flow = deps.flow();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code === null || state === null || !CODE.test(code) || !STATE.test(state)) return;
    // Only a browser that holds this sign-in's state cookie gets an exchange; the library checks
    // the cookie's signature itself, and refuses the callback whatever happens here.
    if (signedCookieValue(request.headers.get("cookie"), deps.stateCookie) !== state) return;
    // The library checks the state's expiry itself when it parses it in the unit.
    const stored = storedState(await readState(stateIdentifier(state)));
    if (stored === null) return;
    const base = {
      code,
      codeVerifier: stored.codeVerifier,
      linkIntentId: stored.linkIntentId,
    };
    const idToken = await exchange(code, stored.codeVerifier);
    if (idToken === null) {
      failed("token_exchange");
      flow.prefetched = { ...base, failure: "token_exchange" };
      return;
    }
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
      flow.prefetched = { ...base, failure: "jwks" };
      return;
    }
    // An address Google has not verified is a refusal of the person's account, not a failure.
    if (!result.ok && result.reason !== "email_unverified") failed(result.reason);
    flow.prefetched = { ...base, nonce: stored.idTokenNonce, idToken, result };
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
        !("idToken" in prefetched)
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
        !("idToken" in prefetched) ||
        tokens.idToken !== prefetched.idToken ||
        tokens.expectedIdTokenNonce === undefined ||
        tokens.expectedIdTokenNonce !== prefetched.nonce ||
        !prefetched.result.ok
      ) {
        return null;
      }
      const claims = prefetched.result.claims;
      flow.claims = claims;
      return {
        user: { email: claims.email, emailVerified: true, name: claims.name ?? "" },
        data: { sub: claims.sub, email: claims.email, email_verified: true },
      };
    },
  };

  return { provider, prefetch };
}
