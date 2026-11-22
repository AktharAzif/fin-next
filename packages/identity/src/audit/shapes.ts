// The personal-data shapes no audit metadata value may carry (spec 08 §3.3 and §5.4: an email
// address, an IP address, a token or key shape, a URL with a query, a run of nine or more
// digits). IDs (`usr_...`) and ISO timestamps are allowed: they are what metadata is made of.
// packages/core's scrubber owns the full list (P0-D); this is the subset audit metadata needs.

/**
 * The most characters a metadata string holds: `audit.record` refuses a longer one (spec 08 §3.3,
 * FA004). Every pattern below runs only on a string this long or shorter (at most twice as many
 * UTF-16 units), so its work is bounded whatever the value; a longer one is refused before any
 * pattern runs.
 */
export const MAX_METADATA_TEXT = 200;

/** Whether a string holds more characters (code points, as Postgres counts them) than metadata may. */
function tooLong(text: string): boolean {
  if (text.length <= MAX_METADATA_TEXT) return false;
  if (text.length > 2 * MAX_METADATA_TEXT) return true;
  let characters = 0;
  for (const _character of text) characters += 1;
  return characters > MAX_METADATA_TEXT;
}

const ID = /^[a-z]{3}_[0-9a-hjkmnp-tv-z]{26}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Matches where `[^\s@]+@[^\s@]+\.[^\s@]+` does (a match of either holds one of the other), but
// starts only at a character just before an "@", so a long run with no "@" is read once.
const EMAIL = /[^\s@]@[^\s@]+\.[^\s@]/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/i;
const URL_WITH_QUERY = /\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*\?/i;
const LONG_DIGITS = /\d{9,}/;
// A token- or key-shaped run: 24 or more URL-safe characters with both letters and digits.
const TOKEN = /[A-Za-z0-9_-]{24,}/;

export type PersonalShape = "email" | "ip" | "url_query" | "digits" | "token";

/**
 * The personal shape in a metadata string, or null. A string longer than MAX_METADATA_TEXT throws
 * RangeError before any pattern runs.
 */
export function personalShapeOf(value: string): PersonalShape | null {
  if (tooLong(value)) {
    throw new RangeError(`a metadata string holds at most ${MAX_METADATA_TEXT} characters`);
  }
  if (ID.test(value) || ISO_TIME.test(value)) return null;
  if (EMAIL.test(value)) return "email";
  if (URL_WITH_QUERY.test(value)) return "url_query";
  if (IPV4.test(value) || IPV6.test(value)) return "ip";
  if (LONG_DIGITS.test(value)) return "digits";
  for (const match of value.matchAll(new RegExp(TOKEN, "g"))) {
    const run = match[0];
    if (/[A-Za-z]/.test(run) && /\d/.test(run) && !ID.test(run)) return "token";
  }
  return null;
}

export class AuditMetadataError extends Error {
  readonly key: string;
  readonly shape: PersonalShape | "schema";
  constructor(key: string, shape: PersonalShape | "schema") {
    // The key and the kind of problem only, never the value.
    super(`audit metadata refused at ${key}: ${shape}`);
    this.name = "AuditMetadataError";
    this.key = key;
    this.shape = shape;
  }
}

/**
 * Throws AuditMetadataError on the first string value with a personal shape, or longer than the
 * database stores (as "schema", what `audit.record` would refuse it as).
 */
export function assertNoPersonalShapes(metadata: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(metadata)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== "string") continue;
      if (tooLong(item)) throw new AuditMetadataError(key, "schema");
      const shape = personalShapeOf(item);
      if (shape !== null) throw new AuditMetadataError(key, shape);
    }
  }
}
