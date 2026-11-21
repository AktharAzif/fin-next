// "Log out" (spec 06 §2.5, §4.3; FW-C14). A body-less POST to the auth library's sign-out route,
// with the app header the origin gate checks and no content type. Success hides the page and ends
// with a full document load of `/sign-in`, so nothing of the signed-in app stays in memory, and the
// document the back-forward cache may keep is already hidden (Back shows no personal data, FW-S4).
// The hide is the back-forward guard's own lock (boot/bfcache.ts), so dialogs and toasts are hidden
// too, and the one guard that lifts the lock decides on a restore: the same viewer shows the page
// again, anyone else reloads it first. A failure leaves the person signed in and the frame says so
// ("Couldn't log you out", AppFrame `logOutFailed`).
import type { AppName } from "@fin/app-contracts";
import { LOCK_ATTRIBUTE } from "../boot/bfcache.ts";

export interface SignOutOptions {
  app: AppName;
  fetch?: typeof fetch;
  /** Hides the page before it is left. Injected for tests; the default sets the guard's lock. */
  hide?: () => void;
  /** Where to go after: `/sign-in`. Injected for tests; the default is a full document load. */
  assign?: (path: string) => void;
}

/** Sets the back-forward guard's lock on <html>; only the guard's passing recheck lifts it. */
function lockPage(): void {
  document.documentElement.setAttribute(LOCK_ATTRIBUTE, "");
}

export async function signOut(options: SignOutOptions): Promise<boolean> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  let ok = false;
  try {
    const response = await fetchImpl("/api/auth/sign-out", {
      method: "POST",
      headers: { Accept: "application/json", "X-Fin-App": options.app },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    ok = response.ok;
  } catch {
    ok = false;
  }
  if (ok) {
    (options.hide ?? lockPage)();
    (options.assign ?? ((path: string) => window.location.assign(path)))("/sign-in");
  }
  return ok;
}
