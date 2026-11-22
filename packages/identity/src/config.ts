// A realm's settings, read once from the process environment inside main() (never at module
// scope) and refused at start-up when anything is off (spec 02 §2.6, §3.2, §3.3; [SA-43];
// T-SAT-03). Code names hosts by role; the real hostnames arrive only through
// FIN_PUBLIC_ORIGIN (and FIN_API_ORIGIN under the split-host fallback) at deploy time.
import type { LimitKey } from "./crypto/keyed.ts";
import {
  GOOGLE_SWITCH,
  GoogleConfigError,
  type GoogleSettings,
  readGoogleSettings,
} from "./google/settings.ts";

export type RealmName = "developer" | "staff";
export type Environment = "development" | "test" | "staging" | "production";

/** The host role each realm serves (the owner's decision of 21 Nov: code uses host roles). */
export const REALM_HOST_ROLE = { developer: "console", staff: "admin" } as const satisfies Record<
  RealmName,
  string
>;

export interface RealmSecret {
  version: number;
  value: string;
}

export interface RealmSettings {
  realm: RealmName;
  environment: Environment;
  /** The app's own origin, e.g. `https://console.<zone>`; the page and, by default, the API. */
  publicOrigin: string;
  /** Set only under the split-host fallback (§2.6): the API host's origin. */
  apiOrigin: string | null;
  /** The passkey relying party: always the page's host, never the API host. */
  rpId: string;
  rpName: string;
  appName: string;
  totpIssuer: string;
  cookiePrefix: "__Host-fin" | "__Host-fin-admin";
  /** Newest first; the newest signs and encrypts, the rest only decrypt. */
  secrets: readonly RealmSecret[];
  limitKeys: readonly LimitKey[];
  features: { passwords: boolean; google: boolean };
  /** Google sign-in's client and provider when it is on (§5.8), else null. */
  google: GoogleSettings | null;
}

export class RealmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealmConfigError";
  }
}

/**
 * Environment variables the library reads by itself that would change what Fin configured: a
 * service refuses to start when any is set (spec 02 §2.6 names BETTER_AUTH_TRUSTED_ORIGINS; the
 * others would add a legacy secret or a base URL behind Fin's back).
 */
export const REFUSED_ENV = [
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "BETTER_AUTH_SECRET",
  "AUTH_SECRET",
  "BETTER_AUTH_URL",
] as const;

const ENVIRONMENTS: readonly Environment[] = ["development", "test", "staging", "production"];

function requireValue(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new RealmConfigError(`${name} is not set`);
  return value.trim();
}

/** Validates an origin: scheme, host and optional port only; https outside development. */
export function parseOrigin(name: string, value: string, environment: Environment): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RealmConfigError(`${name} is not a URL`);
  }
  if (url.origin === "null" || `${url.origin}` !== value.replace(/\/$/, "")) {
    throw new RealmConfigError(`${name} must be an origin only, with no path, query or fragment`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new RealmConfigError(`${name} must not carry credentials`);
  }
  if (url.protocol !== "https:" && !(environment === "development" && url.protocol === "http:")) {
    throw new RealmConfigError(`${name} must be https outside development`);
  }
  return url;
}

/** `BETTER_AUTH_SECRETS`: `"<version>:<value>,<version>:<value>"`, newest first. */
export function parseSecrets(raw: string): RealmSecret[] {
  const secrets = raw.split(",").map((entry, index) => {
    const colon = entry.indexOf(":");
    if (colon <= 0) {
      throw new RealmConfigError(`BETTER_AUTH_SECRETS entry ${index + 1} is not <version>:<value>`);
    }
    const versionText = entry.slice(0, colon).trim();
    const value = entry.slice(colon + 1).trim();
    if (!/^\d{1,6}$/.test(versionText)) {
      throw new RealmConfigError(`BETTER_AUTH_SECRETS entry ${index + 1} has a bad version`);
    }
    if (Buffer.byteLength(value, "utf8") < 32) {
      throw new RealmConfigError(
        `BETTER_AUTH_SECRETS version ${versionText} is shorter than 32 bytes`,
      );
    }
    if (new Set(value).size < 16) {
      throw new RealmConfigError(`BETTER_AUTH_SECRETS version ${versionText} looks low-entropy`);
    }
    return { version: Number(versionText), value };
  });
  for (let i = 1; i < secrets.length; i += 1) {
    if ((secrets[i] as RealmSecret).version >= (secrets[i - 1] as RealmSecret).version) {
      throw new RealmConfigError("BETTER_AUTH_SECRETS must list each version once, newest first");
    }
  }
  return secrets;
}

/** FIN_LIMIT_KEY_<n>: base64url or hex of at least 32 bytes each. */
export function parseLimitKeys(env: Readonly<Record<string, string | undefined>>): LimitKey[] {
  const keys: LimitKey[] = [];
  for (const [name, value] of Object.entries(env)) {
    const match = /^FIN_LIMIT_KEY_(\d{1,4})$/.exec(name);
    if (match === null || value === undefined) continue;
    const text = value.trim();
    const bytes =
      /^[0-9a-f]+$/i.test(text) && text.length % 2 === 0
        ? Buffer.from(text, "hex")
        : Buffer.from(text, "base64url");
    if (bytes.byteLength < 32) throw new RealmConfigError(`${name} is shorter than 32 bytes`);
    keys.push({ version: Number(match[1]), key: new Uint8Array(bytes) });
  }
  if (keys.length === 0) throw new RealmConfigError("no FIN_LIMIT_KEY_<n> is set");
  return keys.sort((a, b) => b.version - a.version);
}

export function totpIssuerFor(realm: RealmName, environment: Environment): string {
  const base = realm === "developer" ? "Fin" : "Fin Admin";
  return environment === "production" ? base : `${base} (${environment})`;
}

/**
 * Reads a realm's settings. `env` is the process environment, passed in by main(); nothing here
 * reads `process.env` itself.
 */
export function readRealmSettings(
  realm: RealmName,
  env: Readonly<Record<string, string | undefined>>,
): RealmSettings {
  for (const name of REFUSED_ENV) {
    if (env[name] !== undefined) {
      throw new RealmConfigError(`${name} is set; Fin configures the realm itself and refuses it`);
    }
  }
  const environmentText = requireValue(env, "FIN_ENVIRONMENT");
  if (!ENVIRONMENTS.includes(environmentText as Environment)) {
    throw new RealmConfigError("FIN_ENVIRONMENT is not a known environment");
  }
  const environment = environmentText as Environment;
  const publicUrl = parseOrigin(
    "FIN_PUBLIC_ORIGIN",
    requireValue(env, "FIN_PUBLIC_ORIGIN"),
    environment,
  );
  const apiRaw = env.FIN_API_ORIGIN?.trim();
  const apiUrl =
    apiRaw === undefined || apiRaw === ""
      ? null
      : parseOrigin("FIN_API_ORIGIN", apiRaw, environment);
  if (apiUrl !== null && apiUrl.origin === publicUrl.origin) {
    throw new RealmConfigError("FIN_API_ORIGIN equals FIN_PUBLIC_ORIGIN; leave it unset instead");
  }
  if (env.FIN_FEATURE_PASSWORDS === "on") {
    // Stretch item 2 (spec 02 §1.2) is not built: refusing beats a half-built path.
    throw new RealmConfigError("passwords are not built in this release");
  }
  // Stretch item 5 (§5.8): off unless the realm's own switch is on with its OAuth client (CR-12).
  let google: GoogleSettings | null;
  try {
    google = readGoogleSettings(realm, env, environment, publicUrl.origin);
  } catch (error) {
    if (error instanceof GoogleConfigError) throw new RealmConfigError(error.message);
    throw error;
  }
  if (google !== null && apiUrl !== null) {
    // The client's redirect URI is on FIN_PUBLIC_ORIGIN, while the library would build its
    // callback on the API host: every Google start would fail. One origin only (S-01).
    throw new RealmConfigError(
      `${GOOGLE_SWITCH[realm]} is on with FIN_API_ORIGIN set; Google runs only on the app's own origin`,
    );
  }
  const features = { passwords: false, google: google !== null };
  return {
    realm,
    environment,
    publicOrigin: publicUrl.origin,
    apiOrigin: apiUrl?.origin ?? null,
    rpId: publicUrl.hostname,
    rpName: realm === "developer" ? "Fin" : "Fin Admin",
    appName: realm === "developer" ? "Fin" : "Fin Admin",
    totpIssuer: totpIssuerFor(realm, environment),
    cookiePrefix: realm === "developer" ? "__Host-fin" : "__Host-fin-admin",
    secrets: parseSecrets(requireValue(env, "BETTER_AUTH_SECRETS")),
    limitKeys: parseLimitKeys(env),
    features,
    google,
  };
}

/** The origins Better Auth must trust: exactly the app's (and the API host's when split). */
export function expectedTrustedOrigins(settings: RealmSettings): string[] {
  return settings.apiOrigin === null
    ? [settings.publicOrigin]
    : [settings.apiOrigin, settings.publicOrigin];
}
