// Google sign-in's settings (spec 02 §5.8, EXECUTION §2.9's CR-12), read with the realm's other
// settings inside main(), never at module scope. Google is off unless FIN_FEATURE_GOOGLE is `on`,
// and it is on only with the OAuth client the owner registers for the console: its ID and secret
// (a sealed variable on `console`), its JavaScript origin the console's origin, and its redirect
// URI exactly `<FIN_PUBLIC_ORIGIN>/api/auth/callback/google`. Off, every Google path answers 404
// through the endpoint allowlist (§4.1).
//
// The staff realm has a switch of its own, FIN_FEATURE_STAFF_GOOGLE, and a client of its own: the
// company Workspace's internal client, registered for the staff host with the same JavaScript
// origin and redirect URI rule (its ID and secret in the same two variables, sealed on the staff
// API service: spec 08's secret inventory), and the Workspace's domain in FIN_GOOGLE_HOSTED_DOMAIN,
// which every ID token's `hd` claim must equal (§5.8). Each realm refuses to start with the other's
// switch on, and the developer realm with a Workspace domain set: no service holds or half-reads
// the other realm's Google settings.
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
  /** The staff realm only: the Workspace domain an ID token's `hd` claim must equal (§5.8). */
  readonly hostedDomain?: string;
}

/** Each realm's own switch (§5.8): the staff realm's is separate from the developer realm's. */
export const GOOGLE_SWITCH = {
  developer: "FIN_FEATURE_GOOGLE",
  staff: "FIN_FEATURE_STAFF_GOOGLE",
} as const satisfies Record<RealmName, string>;

/** The staff realm's Workspace domain, read from configuration, never written in the repository. */
export const GOOGLE_HOSTED_DOMAIN = "FIN_GOOGLE_HOSTED_DOMAIN";

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
/** A DNS name in lower case, with at least two labels. */
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
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

/** The staff realm's Workspace domain: required with its switch on, a DNS name, lower-cased. */
function workspaceDomain(env: Env): string {
  const domain = value(env, GOOGLE_HOSTED_DOMAIN)?.toLowerCase();
  if (domain === undefined) throw new GoogleConfigError(`${GOOGLE_HOSTED_DOMAIN} is not set`);
  if (!DOMAIN.test(domain)) throw new GoogleConfigError(`${GOOGLE_HOSTED_DOMAIN} is malformed`);
  return domain;
}

/**
 * Whether Google is on for `realm`, and its client. Returns null when it is off. Refuses a start
 * that would half-enable it: the realm's switch on without its client (and, for staff, without
 * the Workspace domain), the other realm's switch on, a Workspace domain on the developer realm,
 * or the fixture issuer outside development and test. The realm's settings also refuse it under
 * the split-host fallback (config.ts).
 */
export function readGoogleSettings(
  realm: RealmName,
  env: Env,
  environment: Environment,
  publicOrigin: string,
): GoogleSettings | null {
  const switchName = GOOGLE_SWITCH[realm];
  const switchValue = value(env, switchName) ?? "off";
  if (switchValue !== "on" && switchValue !== "off") {
    throw new GoogleConfigError(`${switchName} is on or off`);
  }
  const other = realm === "developer" ? "staff" : "developer";
  if ((value(env, GOOGLE_SWITCH[other]) ?? "off") !== "off") {
    throw new GoogleConfigError(
      `${GOOGLE_SWITCH[other]} is the ${other} realm's switch, set for the ${realm} realm`,
    );
  }
  if (realm === "developer" && value(env, GOOGLE_HOSTED_DOMAIN) !== undefined) {
    throw new GoogleConfigError(
      `${GOOGLE_HOSTED_DOMAIN} is the staff realm's Workspace domain, set for the developer realm`,
    );
  }
  const issuer = value(env, "FIN_GOOGLE_TEST_ISSUER");
  if (issuer !== undefined && environment !== "development" && environment !== "test") {
    throw new GoogleConfigError("FIN_GOOGLE_TEST_ISSUER is set outside development and test");
  }
  if (switchValue === "off") return null;
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
  const hostedDomain = realm === "staff" ? workspaceDomain(env) : undefined;
  return Object.freeze({
    clientId,
    clientSecret,
    redirectUri: `${publicOrigin}${GOOGLE_CALLBACK_PATH}`,
    endpoints: issuer === undefined ? GOOGLE_ENDPOINTS : fixtureEndpoints(testIssuer(issuer)),
    ...(hostedDomain === undefined ? {} : { hostedDomain }),
  });
}
