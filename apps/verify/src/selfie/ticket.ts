// The selfie ticket (FW-C20, spec 03 §2.6, SD3-03). Verify opens the selfie host as
// `https://selfie.<zone>/s#<sft id>.<secret>`, so the one-time ticket never reaches Cloudflare, a log
// or a Referer. This module is the selfie entry's first import after the stylesheet and the console
// guard (Fin's own code, which never reads the address): as it loads, it reads the fragment and at
// once replaces the history entry with the bare path, so the ticket
// leaves the address bar and the history before any other code runs, the same way verify's link
// token does. The ticket then lives only here until the page posts it to
// `POST /api/selfie/session` (L-SUN-06's flow) and takes it, once.

/** `sft_` with 26 Crockford base32 characters, a dot, and the 32-byte secret in base64url. */
const TICKET = /^sft_[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}\.[A-Za-z0-9_-]{43}$/;
const SELFIE_PATH = "/s";

let captured: string | null = null;

/**
 * Reads and clears the fragment. Exported for tests; the module calls it once as it loads. The
 * history entry loses its fragment whatever it held; only a well-formed ticket on `/s` is kept.
 */
export function captureSelfieTicket(
  location: Pick<Location, "hash" | "pathname">,
  history: Pick<History, "replaceState">,
): string | null {
  if (location.hash.length <= 1) return null;
  const fragment = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  const path = location.pathname.replace(/\/+$/, "") || "/";
  return path === SELFIE_PATH && TICKET.test(fragment) ? fragment : null;
}

if (typeof window !== "undefined") captured = captureSelfieTicket(window.location, window.history);

/** The ticket the page was opened with, once; null when there was none or it was already taken. */
export function takeSelfieTicket(): string | null {
  const ticket = captured;
  captured = null;
  return ticket;
}
