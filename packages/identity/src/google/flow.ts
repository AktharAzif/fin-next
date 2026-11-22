// A Google round trip's part of the realm's request state (request.ts): what the realm learned
// before the unit of work opened, and what the library made inside it.
import type { GoogleClaims, IdTokenRefusal, IdTokenResult } from "./id-token.ts";

/** Why a Google sign-in failed on Fin's side or the provider's (`auth.google_failed`). */
export type GoogleFailure = "token_exchange" | "jwks" | IdTokenRefusal;

interface Exchanged {
  readonly code: string;
  readonly codeVerifier: string;
  /** The step-up intent a link carries in the OAuth state's server context. */
  readonly linkIntentId: string | null;
}

/** What the realm learned about a callback before its unit of work opened. */
export type Prefetched =
  /** The provider answered an ID token, verified (or refused) against this sign-in. */
  | (Exchanged & {
      readonly kind: "token";
      readonly nonce: string;
      readonly idToken: string;
      readonly result: IdTokenResult;
    })
  /** Fin or the provider failed: the exchange, the keys (lined as `auth.google_failed`). */
  | (Exchanged & { readonly kind: "failed"; readonly failure: GoogleFailure })
  /**
   * The provider refused the code (`invalid_grant`: made up, used, expired or not this sign-in's):
   * the client's doing, a refusal and not a failure.
   */
  | (Exchanged & { readonly kind: "refused" });

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
