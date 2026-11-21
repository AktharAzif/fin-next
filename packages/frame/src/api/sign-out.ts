// "Log out" (spec 06 §2.5, §4.3; FW-C14). A body-less POST to the auth library's sign-out route,
// with the app header the origin gate checks and no content type. Success hides the page and ends
// with a full document load of `/sign-in`, so nothing of the signed-in app stays in memory, and the
// document the back-forward cache may keep is already hidden (Back shows no personal data, FW-S4;
// the root's guard checks the session again before revealing it). A failure leaves the person
// signed in and the frame says so ("Couldn't log you out", AppFrame `logOutFailed`).
import type { AppName } from "@fin/app-contracts";

export interface SignOutOptions {
  app: AppName;
  fetch?: typeof fetch;
  /** Hides the page before it is left. Injected for tests; the default hides `#root`. */
  hide?: () => void;
  /** Where to go after: `/sign-in`. Injected for tests; the default is a full document load. */
  assign?: (path: string) => void;
}

function hideRoot(): void {
  const root = document.getElementById("root");
  if (root !== null) root.hidden = true;
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
    (options.hide ?? hideRoot)();
    (options.assign ?? ((path: string) => window.location.assign(path)))("/sign-in");
  }
  return ok;
}
