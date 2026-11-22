// Where a Google round trip may send the browser back to (spec 02 §2.3): `callbackURL`,
// `errorCallbackURL` and `newUserCallbackURL` must each be a path that starts with exactly one `/`
// and is one of the console's pages for this flow, or the same as an absolute URL on
// FIN_PUBLIC_ORIGIN; anything else is refused with `400 invalid` before the library sees it. The
// query may carry only `next` (a local path, which the page checks against its routes again,
// FW-C09) and `via=google`. Each accepted value is rewritten as an absolute URL on the origin.

export type GoogleRedirectField = "callbackURL" | "errorCallbackURL" | "newUserCallbackURL";

/** The console's pages each flow may come back to. */
export const GOOGLE_RETURN_PAGES = {
  signIn: ["/sign-in", "/sign-up"],
  link: ["/account/security"],
} as const;

const MAX_LENGTH = 2048;
const QUERY_KEYS = new Set(["next", "via"]);

/** A path a page may go on to after signing in: one leading `/`, nothing a browser rewrites. */
export function isLocalPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_LENGTH) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || char === "\\") return false;
  }
  if (/%(?:[01][0-9a-f]|7f|5c)/i.test(path)) return false;
  let url: URL;
  try {
    url = new URL(path, "https://fin.invalid");
  } catch {
    return false;
  }
  if (url.origin !== "https://fin.invalid" || url.pathname.startsWith("//")) return false;
  return url.pathname !== "/api" && !url.pathname.startsWith("/api/");
}

/**
 * The absolute URL for a redirect target, or null when the rule refuses it. `pages` are the
 * paths this flow may return to.
 */
export function googleReturnUrl(
  value: unknown,
  publicOrigin: string,
  pages: readonly string[],
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return null;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || char === "\\") return null;
  }
  const relative = value.startsWith("/");
  if (relative && value.startsWith("//")) return null;
  if (!relative && !value.startsWith(`${publicOrigin}/`)) return null;
  let url: URL;
  try {
    url = new URL(value, publicOrigin);
  } catch {
    return null;
  }
  if (url.origin !== publicOrigin || url.hash !== "" || url.username !== "") return null;
  if (!pages.includes(url.pathname)) return null;
  for (const [key, field] of url.searchParams) {
    if (!QUERY_KEYS.has(key)) return null;
    if (key === "via" && field !== "google") return null;
    if (key === "next" && !isLocalPath(field)) return null;
  }
  if (url.searchParams.getAll("next").length > 1 || url.searchParams.getAll("via").length > 1) {
    return null;
  }
  return `${publicOrigin}${url.pathname}${url.search}`;
}
