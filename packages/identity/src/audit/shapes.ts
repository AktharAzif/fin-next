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
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/i;
const LONG_DIGITS = /\d{9,}/;

const AT = 0x40;
const DOT = 0x2e;
const COLON = 0x3a;
const SLASH = 0x2f;
const QUESTION = 0x3f;
const HASH = 0x23;

/** Whether a UTF-16 unit is one `\s` matches: white space or a line terminator. */
export function isSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

const isLetter = (code: number) => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
/** A unit `\w` matches (no `u` flag): a pattern's `\b` falls between one of these and any other. */
const isWord = (code: number) => isLetter(code) || isDigit(code) || code === 0x5f;
/** A unit a URL scheme may hold after its first letter: `[a-z0-9+.-]`, either case. */
const inScheme = (code: number) =>
  isLetter(code) || isDigit(code) || code === 0x2b || code === DOT || code === 0x2d;

/**
 * Whether the text holds an email address's shape: what `/[^\s@]+@[^\s@]+\.[^\s@]+/` finds. That
 * is an "@" with a unit before it that is neither white space nor "@", followed by a run of such
 * units that holds a "." with at least one unit of the run on each side. One forward pass reads
 * each UTF-16 unit once, never with a pattern, so the work is linear whatever the text.
 */
export function hasEmailShape(text: string): boolean {
  let prev = -1; // the unit before this one; -1 at the start
  let inDomain = false; // reading the run after an "@" that has a local unit before it
  let domainLength = 0; // the run's units read so far
  let dot = false; // the run holds a "." after its first unit: one more unit of the run completes it
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (inDomain) {
      if (code !== AT && !isSpace(code)) {
        if (dot) return true;
        if (code === DOT && domainLength > 0) dot = true;
        domainLength += 1;
        prev = code;
        continue;
      }
      inDomain = false;
    }
    if (code === AT && prev !== -1 && prev !== AT && !isSpace(prev)) {
      inDomain = true;
      domainLength = 0;
      dot = false;
    }
    prev = code;
  }
  return false;
}

/**
 * Whether the text holds a URL with a query: what `/\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*\?/i` finds.
 * That is a scheme (a letter at a word boundary, then letters, digits, "+", "." or "-"), "://",
 * then a "?" before any white space or "#". One forward pass reads each UTF-16 unit once, never
 * with a pattern, so the work is linear whatever the text.
 */
export function hasUrlWithQuery(text: string): boolean {
  let prev = -1; // the unit before this one; -1 at the start
  let scheme = false; // the run of scheme units that ends at prev holds a scheme's first letter
  let slashes = -1; // after a scheme's ":", the "/" read since (0 or 1); -1 when none is due
  let searching = false; // after "://", no white space, "?" or "#" read since
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (searching) {
      if (code === QUESTION) return true;
      if (code === HASH || isSpace(code)) searching = false;
    }
    if (slashes >= 0) {
      slashes = code === SLASH ? slashes + 1 : -1;
      if (slashes === 2) {
        searching = true;
        slashes = -1;
      }
    } else if (code === COLON && scheme) {
      slashes = 0;
    }
    scheme = inScheme(code) && (scheme || (isLetter(code) && !(prev !== -1 && isWord(prev))));
    prev = code;
  }
  return false;
}
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
  if (hasEmailShape(value)) return "email";
  if (hasUrlWithQuery(value)) return "url_query";
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
