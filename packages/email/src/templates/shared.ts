// Fixed words and small helpers the templates share. Owned by L-SAT-05; each area's templates live
// in their own folder (spec 08 §4.4).
import type { Box, Link } from "../classes.ts";
import { formatTime } from "../params.ts";

export const MINUTE_MS = 60_000;

/** The developer realm's one link for account changes. */
export const ACCOUNT_SECURITY: Link = Object.freeze({
  label: "Review your account security",
  host: "console",
  path: "/account/security",
});

export const TEAM: Link = Object.freeze({
  label: "Open your team",
  host: "console",
  path: "/settings/team",
});

export const STAFF: Link = Object.freeze({
  label: "Open Staff in Fin Admin",
  host: "admin",
  path: "/staff",
});

export const NOT_YOU_DEVELOPER =
  "If this wasn't you, review your account security now and tell your team's Super admin.";

export const NOT_YOU_STAFF = "If this wasn't you, tell another Fin Admin straight away.";

export const IGNORE_CODE =
  "If you didn't ask for this, you can ignore this email. Nobody can use your account without the code.";

/** A labelled box holding a time, written one way. */
export function timeBox(label: string, iso: string): Box {
  return { label, value: formatTime(iso) };
}

/** The fragment of a code link: the address and the code, read by the page, never sent to a server. */
export function codeFragment(recipient: string, code: string): string {
  return `#e=${encodeURIComponent(recipient)}&c=${encodeURIComponent(code)}`;
}

/** Boxes with the absent entries dropped. */
export function boxes(...items: (Box | undefined)[]): Box[] {
  return items.filter((b): b is Box => b !== undefined);
}
