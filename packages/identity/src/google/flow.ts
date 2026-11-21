// A Google round trip's part of the realm's request state (request.ts): what the realm learned
// before the unit of work opened, and what the library made inside it.
import type { GoogleClaims, IdTokenRefusal, IdTokenResult } from "./id-token.ts";

/** Why a Google sign-in failed on Fin's side or the provider's (`auth.google_failed`). */
export type GoogleFailure = "token_exchange" | "jwks" | IdTokenRefusal;

/** What the realm learned about a callback before its unit of work opened. */
export type Prefetched =
  | {
      readonly code: string;
      readonly codeVerifier: string;
      readonly nonce: string;
      readonly idToken: string;
      readonly result: IdTokenResult;
      /** The step-up intent a link carries in the OAuth state's server context. */
      readonly linkIntentId: string | null;
    }
  | {
      readonly code: string;
      readonly codeVerifier: string;
      readonly failure: GoogleFailure;
      readonly linkIntentId: string | null;
    };

export interface GoogleFlow {
  prefetched: Prefetched | null;
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
    claims: null,
    creatingAccounts: [],
    creatingUser: false,
    unlinking: null,
    redirectError: null,
  };
}
