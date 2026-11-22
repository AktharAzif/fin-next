// Google sign-in's settings (spec 02 §5.8, EXECUTION §2.9's CR-12), read with the realm's other
// settings inside main(), never at module scope. Google is off unless FIN_FEATURE_GOOGLE is `on`,
// and it is on only with the OAuth client the owner registers for the console: its ID and secret
// (a sealed variable on `console`), its JavaScript origin the console's origin, and its redirect
// URI exactly `<FIN_PUBLIC_ORIGIN>/api/auth/callback/google`. Off, every Google path answers 404
// through the endpoint allowlist (§4.1).
//
// The provider's endpoints are Google's own, fixed here. Only in development and test may
// FIN_GOOGLE_TEST_ISSUER point them at the fixture provider (packages/testing/src/oauth); a
// staging or production process refuses to start with it set.
import type { Environment, RealmName } from "../config.ts";

export class GoogleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleConfigError";
  }
}

/** Where the OpenID provider answers. */
export interface GoogleEndpoints {
  /** The `iss` values an ID token may carry. */
  readonly issuers: readonly string[];
  readonly authorization: string;
  readonly token: string;
  readonly jwks: string;
}

export interface GoogleSettings {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Exactly `<publicOrigin>/api/auth/callback/google`, as the client is registered. */
  readonly redirectUri: string;
  readonly endpoints: GoogleEndpoints;
}

/** Google's own endpoints (its discovery document, read 21 Nov 2026). */
export const GOOGLE_ENDPOINTS: GoogleEndpoints = Object.freeze({
  issuers: Object.freeze(["https://accounts.google.com", "accounts.google.com"]),
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
});

/** The fixture provider's endpoints under its issuer (development and test only). */
export function fixtureEndpoints(issuer: string): GoogleEndpoints {
  return Object.freeze({
    issuers: Object.freeze([issuer]),
    authorization: `${issuer}/authorize`,
    token: `${issuer}/token`,
    jwks: `${issuer}/jwks`,
  });
}

export const GOOGLE_CALLBACK_PATH = "/api/auth/callback/google";

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,199}$/;
const CLIENT_SECRET = /^[\x21-\x7e]{16,256}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The fixture issuer: an origin, http only on loopback. */
function testIssuer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GoogleConfigError("FIN_GOOGLE_TEST_ISSUER is not a URL");
  }
  if (url.origin !== raw.replace(/\/$/, "") || url.username !== "" || url.password !== "") {
    throw new GoogleConfigError("FIN_GOOGLE_TEST_ISSUER must be an origin only");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new GoogleConfigError("FIN_GOOGLE_TEST_ISSUER must be https, or http on loopback");
  }
  return url.origin;
}

/**
 * Whether Google is on, and its client. Returns null when it is off. Refuses a start that would
 * half-enable it: the switch on without the client, the fixture issuer outside development and
 * test, or the staff realm (its Workspace client and checks are not built, §5.8). The realm's
 * settings also refuse it under the split-host fallback (config.ts).
 */
export function readGoogleSettings(
  realm: RealmName,
  env: Env,
  environment: Environment,
  publicOrigin: string,
): GoogleSettings | null {
  const switchValue = value(env, "FIN_FEATURE_GOOGLE") ?? "off";
  if (switchValue !== "on" && switchValue !== "off") {
    throw new GoogleConfigError("FIN_FEATURE_GOOGLE is on or off");
  }
  const issuer = value(env, "FIN_GOOGLE_TEST_ISSUER");
  if (issuer !== undefined && environment !== "development" && environment !== "test") {
    throw new GoogleConfigError("FIN_GOOGLE_TEST_ISSUER is set outside development and test");
  }
  if (switchValue === "off") return null;
  if (realm === "staff") {
    throw new GoogleConfigError(
      "FIN_FEATURE_GOOGLE is on for the staff realm, whose Workspace client is not built",
    );
  }
  const clientId = value(env, "FIN_GOOGLE_CLIENT_ID");
  if (clientId === undefined) throw new GoogleConfigError("FIN_GOOGLE_CLIENT_ID is not set");
  if (!CLIENT_ID.test(clientId)) throw new GoogleConfigError("FIN_GOOGLE_CLIENT_ID is malformed");
  const clientSecret = value(env, "FIN_GOOGLE_CLIENT_SECRET");
  if (clientSecret === undefined) {
    throw new GoogleConfigError("FIN_GOOGLE_CLIENT_SECRET is not set");
  }
  if (!CLIENT_SECRET.test(clientSecret)) {
    throw new GoogleConfigError("FIN_GOOGLE_CLIENT_SECRET is malformed");
  }
  return Object.freeze({
    clientId,
    clientSecret,
    redirectUri: `${publicOrigin}${GOOGLE_CALLBACK_PATH}`,
    endpoints: issuer === undefined ? GOOGLE_ENDPOINTS : fixtureEndpoints(testIssuer(issuer)),
  });
}
