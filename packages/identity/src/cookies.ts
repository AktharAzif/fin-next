// Fin's own cookies (spec 02 §2.4, [SA-43]): host-only `__Host-` cookies, `Secure`,
// `HttpOnly`, `Path=/`, no `Domain`, `SameSite=Lax` (only the library's session cookie is
// Strict). Each holds a random 32-byte token; the database keeps only its keyed hash.
import type { RealmName } from "./config.ts";

export type FinCookie =
  | "code_browser"
  | "sign_up_browser"
  | "known_browser"
  | "trusted_browser"
  | "invitation";

/** Max-Age per cookie and realm; a cookie a realm does not set is absent. */
export const FIN_COOKIE_MAX_AGE: Readonly<Record<RealmName, Partial<Record<FinCookie, number>>>> = {
  developer: {
    code_browser: 86_400,
    sign_up_browser: 86_400,
    known_browser: 31_536_000,
    trusted_browser: 2_592_000,
    invitation: 86_400,
  },
  staff: {
    code_browser: 600,
  },
};

export function cookiePrefixOf(realm: RealmName): "__Host-fin" | "__Host-fin-admin" {
  return realm === "developer" ? "__Host-fin" : "__Host-fin-admin";
}

export function finCookieName(realm: RealmName, cookie: FinCookie): string {
  return `${cookiePrefixOf(realm)}.${cookie}`;
}

export interface CookieAttributes {
  maxAge: number;
  path: "/";
  secure: true;
  httpOnly: true;
  sameSite: "lax";
}

export function finCookieAttributes(realm: RealmName, cookie: FinCookie): CookieAttributes {
  const maxAge = FIN_COOKIE_MAX_AGE[realm][cookie];
  if (maxAge === undefined) throw new Error(`the ${realm} realm sets no ${cookie} cookie`);
  return { maxAge, path: "/", secure: true, httpOnly: true, sameSite: "lax" };
}

/** A `Set-Cookie` value for one of Fin's cookies; `value: null` expires it. */
export function serializeFinCookie(
  realm: RealmName,
  cookie: FinCookie,
  value: string | null,
): string {
  const attributes = finCookieAttributes(realm, cookie);
  if (value !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new Error("a Fin cookie value is a base64url token");
  }
  const maxAge = value === null ? 0 : attributes.maxAge;
  return `${finCookieName(realm, cookie)}=${value ?? ""}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** Reads one cookie's value from a Cookie header. */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
