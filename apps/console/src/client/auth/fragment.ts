// Values carried in a link's fragment (spec 02 §5.2, §9.3): `#e=<email>&c=<code>` on a sign-in or
// confirm link, `#t=<token>` on an invitation. The fragment never reaches a server or a log line;
// the page reads it once, removes it from the address bar with history.replaceState (so it is not
// in the history, a bookmark or a screenshot of the address), and keeps the values in memory only.

export interface CodeLink {
  email: string;
  code: string;
}

/** The address and code of a sign-in or confirm link, or null when the fragment holds none. */
export function parseCodeLink(hash: string): CodeLink | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const email = (params.get("e") ?? "").trim();
  const code = (params.get("c") ?? "").trim();
  if (email === "" || email.length > 254 || !email.includes("@")) return null;
  if (!/^\d{8}$/.test(code)) return null;
  return { email, code };
}

/** An invitation link's token (base64url, 32 random bytes), or null. */
export function parseInvitationToken(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = (params.get("t") ?? "").trim();
  return /^[A-Za-z0-9_-]{16,256}$/.test(token) ? token : null;
}

/** Reads the current fragment and removes it from the address bar, keeping the path and query. */
export function takeFragment(): string {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash;
  if (hash === "" || hash === "#") return "";
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}`);
  return hash;
}
