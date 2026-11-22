// A Google round trip's part of the realm's request state (request.ts): what the realm learned
// before the unit of work opened, and what the library made inside it.
//
// What a round trip's outcome means for monitoring is decided here, once (spec 02 §18.1, §18.2):
//
//   - a failure (`auth.google_failed`, which `google-sign-in-failing` watches) is something Fin or
//     the provider did: the token endpoint unreachable, too slow, failing or unreadable, Fin's own
//     client refused there, the provider's keys unavailable, or an ID token that is not the
//     provider's for this client now (its form, algorithm, key, signature, issuer, audience,
//     times or subject);
//   - a refusal (`auth.google_refused`, panelled, not alerted) is anything a client can cause. It
//     sends the callback's code itself, and its authorization request passes through its browser,
//     where it can change any of it before the provider sees it: the nonce, the scopes, the PKCE
//     challenge, the redirect URI. So a code the provider will not exchange for this sign-in, an
//     answer without an ID token to a request that asked for none, and an ID token whose nonce is
//     not this sign-in's, that carries no usable address, or that a long nonce pushed past Fin's
//     bound are refusals, as is an address the provider has not verified. Each of these is read
//     only from a token already proved the provider's for this client now (id-token.ts checks the
//     signature, issuer, audience and times first), so no answer that is not one is a refusal.
import type { GoogleClaims, IdTokenRefusal } from "./id-token.ts";

/** The ID token refusals a client (or the person's own account) can cause. */
type ClientTokenRefusal = "too_long" | "nonce" | "email" | "email_unverified";

const CLIENT_TOKEN_REFUSALS: ReadonlySet<IdTokenRefusal> = new Set<ClientTokenRefusal>([
  "too_long",
  "nonce",
  "email",
  "email_unverified",
]);

/** Why a Google sign-in failed on Fin's side or the provider's (`auth.google_failed`). */
export type GoogleFailure = "token_exchange" | "jwks" | Exclude<IdTokenRefusal, ClientTokenRefusal>;

/**
 * Why a round trip was refused although Fin and the provider worked (`auth.google_refused`): the
 * provider would not exchange the code for this sign-in (`invalid_code`), the request asked for no
 * ID token (`scope`), or the ID token is not one this sign-in can use.
 */
export type GoogleRefusal = "invalid_code" | "scope" | ClientTokenRefusal;

/** Whether an ID token's refusal is one a client can cause (a refusal), rather than a failure. */
export function isClientRefusal(reason: IdTokenRefusal): reason is ClientTokenRefusal {
  return CLIENT_TOKEN_REFUSALS.has(reason);
}

/**
 * The `?error=` a refused round trip takes back to the page (the console reads it): an address
 * the provider has not verified, or none, says so; anything else is a round trip that did not
 * finish, which trying again fixes. Never `google_failed`, which says Google sign-in is not working.
 */
export function refusalPageError(refusal: GoogleRefusal): string {
  switch (refusal) {
    case "email_unverified":
      return "email_unverified";
    case "email":
      return "email_not_found";
    default:
      return "invalid_code";
  }
}

interface Exchanged {
  readonly code: string;
  readonly codeVerifier: string;
  /** The step-up intent a link carries in the OAuth state's server context. */
  readonly linkIntentId: string | null;
}

/** What the realm learned about a callback before its unit of work opened. */
export type Prefetched =
  /** The provider answered an ID token that verified for this sign-in. */
  | (Exchanged & {
      readonly kind: "token";
      readonly nonce: string;
      readonly idToken: string;
      readonly claims: GoogleClaims;
    })
  /** Fin or the provider failed (lined as `auth.google_failed` when it was prefetched). */
  | (Exchanged & { readonly kind: "failed"; readonly failure: GoogleFailure })
  /** The client's round trip was refused (the callback's after-hook lines it). */
  | (Exchanged & { readonly kind: "refused"; readonly refusal: GoogleRefusal });

export interface GoogleFlow {
  prefetched: Prefetched | null;
  /**
   * Set when another callback already claimed this state's exchange, with the state's error page.
   * The callback's before-hook answers it, so the library never consumes the state the claim holds.
   */
  spentState: { errorURL: string | null } | null;
  /** The claims of the token the library accepted in this request. */
  claims: GoogleClaims | null;
  /** The Google accounts (by subject) the library is making in this request, and for whom. */
  creatingAccounts: { sub: string; userId: string }[];
  /** True while the library makes a person from a Google profile in this request. */
  creatingUser: boolean;
  /** The account `/unlink-account` removes, read before the library deletes it. */
  unlinking: { id: string; userId: string } | null;
  /** Fin's code for a refused callback's `?error=`, when it has a better one than the library's. */
  redirectError: string | null;
}

export function newGoogleFlow(): GoogleFlow {
  return {
    prefetched: null,
    spentState: null,
    claims: null,
    creatingAccounts: [],
    creatingUser: false,
    unlinking: null,
    redirectError: null,
  };
}
