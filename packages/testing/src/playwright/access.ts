// Signing in through the Access stand-in in front of Fin Admin, as the owner does through Access
// on staging (spec 02 §19.4 T-SAT-70): the stand-in's login issues a token for a fixture address,
// the app host's `/cdn-cgi/access/authorized` sets `CF_Authorization`, and the browser lands on the
// path it asked for.
import type { Page } from "@playwright/test";

export interface AccessSignIn {
  /** The stand-in's origin (http://127.0.0.1:<ACCESS_STAND_IN_PORT> in a journey run). */
  readonly standInOrigin: string;
  /** The Fin Admin static host's origin. */
  readonly appOrigin: string;
  readonly email: string;
  /** Where to land after Access (default "/"). */
  readonly path?: string;
}

export function accessLoginUrl({ standInOrigin, appOrigin, email, path }: AccessSignIn): string {
  const url = new URL("/cdn-cgi/access/login", standInOrigin);
  url.searchParams.set("app", appOrigin);
  url.searchParams.set("redirect_url", path ?? "/");
  url.searchParams.set("email", email);
  return url.href;
}

/** Passes Access as `email` and returns once the app's page has loaded. */
export async function signInThroughAccess(page: Page, signIn: AccessSignIn): Promise<void> {
  await page.goto(accessLoginUrl(signIn));
  const landed = new URL(page.url());
  if (landed.origin !== new URL(signIn.appOrigin).origin) {
    throw new Error("Access did not let the browser through to the app");
  }
}
