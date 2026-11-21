// The `next` of a sign-in redirect (FW-C09, spec 06 §2.3 step 4): kept only when it is a path on
// this app that starts with a single `/` and matches a route. Anything else (another origin, a
// protocol-relative or backslashed path, a path under /api, a control character) is dropped, so a
// link can never send a person off the app after they sign in.

const MAX_NEXT_LENGTH = 2048;

/**
 * The safe `next`, or null. `matches(pathname)` says whether the app has a route for the path.
 */
export function safeNext(value: unknown, matches: (pathname: string) => boolean): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NEXT_LENGTH)
    return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // Control characters, spaces and backslashes are what browsers rewrite into other origins.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return null;
  }
  let url: URL;
  try {
    url = new URL(value, "https://fin.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://fin.invalid") return null;
  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/")) return null;
  if (!matches(path)) return null;
  return `${path}${url.search}${url.hash}`;
}

/**
 * `/sign-in?next=<path>` for the current location, keeping only a safe path. `signedOut` adds
 * `error=signed_out`, so the sign-in page says "You were signed out." after a session ended mid-use.
 */
export function signInHref(
  location: { pathname: string; search: string },
  matches: (pathname: string) => boolean,
  options: { signedOut?: boolean; signInPath?: string } = {},
): string {
  const signInPath = options.signInPath ?? "/sign-in";
  const params = new URLSearchParams();
  const next = safeNext(`${location.pathname}${location.search}`, matches);
  if (next !== null && next !== "/" && next !== signInPath) params.set("next", next);
  if (options.signedOut === true) params.set("error", "signed_out");
  const query = params.toString();
  return query === "" ? signInPath : `${signInPath}?${query}`;
}
