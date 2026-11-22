// The link token (FW-C21, spec 03 §2.5, spec 06 §7.3). A hosted link carries it only in the
// fragment (`/c#<token>`, `/p#<token>`, `/a#<token>`), so it never reaches Cloudflare, a log or a
// Referer. This module is the entry's first import after the stylesheet and the console guard (Fin's
// own code, which never reads the address): as it loads, it reads the fragment and at once replaces
// the history entry with the bare path, so the token leaves the address bar and the history before
// any other code runs. The token then lives only here until the
// entry posts it to `POST /api/link/open` (L-SUN-06's flow) and takes it, once.

/** 32 Crockford base32 characters (160 bits): the only shape a link token has. */
const TOKEN = /^[0-9A-HJKMNP-TV-Z]{32}$/;
const LINK_PATHS = new Set(["/c", "/p", "/a"]);

let captured: string | null = null;

/**
 * Reads and clears the fragment. Exported for tests; the module calls it once as it loads. The
 * history entry loses its fragment whatever it held; only a well-formed token on a link path is
 * kept.
 */
export function captureLinkToken(
  location: Pick<Location, "hash" | "pathname">,
  history: Pick<History, "replaceState">,
): string | null {
  if (location.hash.length <= 1) return null;
  // Crockford base32 reads either case.
  const fragment = location.hash.slice(1).toUpperCase();
  history.replaceState(null, "", location.pathname);
  const path = location.pathname.replace(/\/+$/, "") || "/";
  return LINK_PATHS.has(path) && TOKEN.test(fragment) ? fragment : null;
}

if (typeof window !== "undefined") captured = captureLinkToken(window.location, window.history);

/** The token the page was opened with, once; null when there was none or it was already taken. */
export function takeLinkToken(): string | null {
  const token = captured;
  captured = null;
  return token;
}
