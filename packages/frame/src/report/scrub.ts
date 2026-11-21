// The shapes a line printed in the browser must never hold: every row of spec 08 §5.4's table, in
// the order the scrubbers apply them, then the browser's own rows. SHAPES is a copy of @fin/core's
// scrub-shapes (P0-D), with the refinements recorded there, until that package (Web APIs only) is
// on main; the console guard then imports `@fin/core/scrub`, still applies BROWSER_SHAPES after
// it, and test/scrub.test.ts, one case per row, runs against it. Every row is kept, not a subset a
// page is thought to meet: what a library prints is not known in advance, and a missing row is a
// value that reaches the console.
//
// Where the patterns differ from spec 08 §5.4's table (as @fin/core records them, but for EMAIL):
//   - IPV6 takes each whole run of hex digits and colons that holds a colon and removes it when it
//     is address-shaped: it holds `::` or eight groups or more, whatever stands beside it. A time
//     ("09:48:23") or a MAC address is kept, while "ip:<address>", "<address>:443", an address
//     after a percent escape ("%20<address>") and one run together with a word are removed. A run
//     of one group or none beside a name's character is a scope operator ("std::vector"), kept;
//   - IPV4 is bounded by digits, not by word boundaries, so a letter, a `_` or a percent escape
//     beside an address does not keep it. DIGITS keeps the table's `\b`;
//   - EMAIL reads each run of address characters that holds an `@` once, and finds the addresses
//     in it from each `@` and its domain, the local part reaching back to the start of the run or
//     to the end of the address before it. It removes what the table's row removes, the second of
//     two addresses joined by `%2C`, `+`, `-` or `_` among them, in linear time (the row as written
//     is quadratic on a long run with no `@`). @fin/core's row still starts only where a run
//     starts, which misses that second address, and needs the same change;
//   - TOKEN_JSON also takes `+`, `/` and `=`, so a tunnel token (standard base64) goes whole;
//   - LONG_SEGMENT removes a path segment of 24 or more base64url characters when it holds a digit
//     or both cases, so a route template ("/passkey/generate-authenticate-options") survives;
//   - ID_PATH keeps its one-letter route ("/c/[segment]"), which identifies no one;
//   - CLOUDFLARE_TOKEN also takes `cfut_`; BASIC_AUTH, ACCESS_COOKIE and FIN_KEY_LIKE are added
//     beside the bearer, cookie and API-key rows; BEARER also takes `_`;
//   - PRIVATE_KEY's block with no END line runs to the next block's BEGIN or the end of the text:
//     a key cut short is still key material;
//   - an open part that the next match's own start would satisfy stops there, so a long run of
//     starts with no end is read once, not once per start: a cookie's name stops at the next
//     `__Host-` or `__Secure-`, a Postgres password at the next `postgres://` and a key's body at
//     the next BEGIN, and HEARTBEAT_URL finds `betterstack` in its host by a lookahead, which
//     accepts exactly the hosts the table's two open runs around the word accept.
//
// BROWSER_SHAPES holds FRAGMENT. A server never receives a URL's fragment, so @fin/core has no such
// row, but the fragment is where Fin's links carry their tokens and codes, and the browser is where
// those exist: an invitation's `#t=`, the sign-in link's `#e=…&c=`, verify's `/c#`, `/p#` and
// `/a#`, and selfie's `/s#` (spec 02 §5.2 and §9.3, spec 03 §2.5).
//
// Every pattern is linear in its input (a test scrubs 1 MB of an adversarial run for every shape),
// and the lookbehinds are within the build's browser target (Vite's baseline: Safari 16.4 and later).

/** Where a match stands, for a replacement that depends on what is beside it. */
export interface ShapeMatch {
  /** The capture groups in order; "" for one that took no part. */
  readonly groups: readonly string[];
  /** Where the match starts in the text. */
  readonly offset: number;
  /** The whole text being scrubbed. */
  readonly input: string;
}

export interface Shape {
  readonly name: string;
  readonly pattern: RegExp;
  /** The replacement: a string with `$n` references, or a function of the match. */
  readonly token: string | ((match: string, at: ShapeMatch) => string);
}

const PRIVATE_KEY: Shape = {
  name: "private-key",
  pattern:
    /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----)[\s\S])*(?:-----END [A-Z ]*PRIVATE KEY-----)?/gu,
  token: "[private-key]",
};

const AGE_IDENTITY: Shape = {
  name: "age-identity",
  pattern: /AGE-SECRET-KEY-1[0-9A-Z]{58}/gu,
  token: "[private-key]",
};

const FIN_API_KEY: Shape = {
  name: "fin-api-key",
  pattern: /fin_(?:test|live)_(?:sk|rk)_[0-9A-Z]{10}[0-9A-Za-z]{38}/gu,
  token: "[api-key]",
};

const FIN_KEY_LIKE: Shape = {
  name: "fin-key-like",
  pattern: /fin_(?:test|live)_[A-Za-z0-9_]{16,}/gu,
  token: "[api-key]",
};

const WEBHOOK_SECRET: Shape = {
  name: "webhook-secret",
  pattern: /whsec_[A-Za-z0-9+/=_-]{24,}/gu,
  token: "[secret]",
};

const CLOUDFLARE_TOKEN: Shape = {
  name: "cloudflare-token",
  pattern: /cf[au]t_[A-Za-z0-9_-]{20,}/gu,
  token: "[token]",
};

/** A JWT (an Access token among them) or a tunnel token: base64 of a JSON object. */
const TOKEN_JSON: Shape = {
  name: "jwt-or-tunnel-token",
  pattern: /eyJ[A-Za-z0-9+/_-]{8,}={0,2}(?:\.[A-Za-z0-9_-]{4,}={0,2}){0,2}/gu,
  token: "[token]",
};

const HEARTBEAT_URL: Shape = {
  name: "heartbeat-url",
  // The host is the one run of host characters after `https://`: it must hold `betterstack` (the
  // lookahead) and end in `.com`, each found by one pass over the run.
  pattern:
    /https:\/\/(?=[a-z0-9.-]*betterstack)[a-z0-9.-]*\.com\/api\/v[0-9]+\/(?:heartbeat|incoming-webhook)\/[A-Za-z0-9]+/giu,
  token: "[heartbeat-url]",
};

/** An error reporter's DSN, the browser's relay placeholder among them. */
const DSN: Shape = {
  name: "dsn",
  pattern: /https:\/\/[A-Za-z0-9]+@[A-Za-z0-9.-]+\/[0-9A-Za-z]+/gu,
  token: "[dsn]",
};

const POSTGRES_URL: Shape = {
  name: "postgres-url",
  // The password stops at the next `postgres://`, which no password holds (a `/` in one is
  // percent-encoded), so URLs with no `@` are read once.
  pattern: /postgres(?:ql)?:\/\/[^:/\s]+:(?:(?!postgres(?:ql)?:\/\/)[^@\s])+@/gu,
  token: "postgres://[login]:[secret]@",
};

const BEARER: Shape = {
  name: "bearer",
  pattern: /bearer\s+[A-Za-z0-9._~+/=_-]{8,}/giu,
  token: "Bearer [secret]",
};

const BASIC_AUTH: Shape = {
  name: "basic-auth",
  pattern: /basic\s+[A-Za-z0-9+/]{8,}={0,2}/giu,
  token: "Basic [secret]",
};

const COOKIE_PAIR: Shape = {
  name: "cookie",
  // The name stops at the next `__Host-` or `__Secure-` (whose own pair is then matched), so a run
  // of prefixes with no `=` is read once.
  pattern: /__(?:Host|Secure)-(?:(?!__(?:Host|Secure)-)[A-Za-z0-9._-])+=[^;\s]+/gu,
  token: "[cookie]",
};

/** Cloudflare Access's cookies, which Fin Admin's pages sit behind. */
const ACCESS_COOKIE: Shape = {
  name: "access-cookie",
  pattern: /CF_(?:Authorization|Binding|AppSession)=[^;\s]+/gu,
  token: "[cookie]",
};

const INGRESS_PROOF: Shape = {
  name: "ingress-proof",
  pattern: /fin-ingress-proof:\s*\S+/giu,
  token: "Fin-Ingress-Proof: [secret]",
};

/** A character of an address's local part, as the table's row writes it. */
const LOCAL_PART = /[A-Za-z0-9._%+-]/u;

/** An `@` and its domain, as the table's row writes them. */
const AT_DOMAIN = /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;

/**
 * The addresses in one run of address characters, each made `[email]`. From each `@` and its
 * domain, the local part reaches back over local-part characters to the start of the run or to
 * the end of the address before it: where the table's row, read left to right, starts its match.
 * An `@` with nothing before it is kept, as the row keeps it. Each step back crosses a character
 * no other step crosses, so the run is read a bounded number of times.
 */
function emailToken(run: string): string {
  let out = "";
  let copied = 0;
  for (const at of run.matchAll(AT_DOMAIN)) {
    let start = at.index;
    while (start > copied && LOCAL_PART.test(run.charAt(start - 1))) start -= 1;
    if (start === at.index) continue;
    out += `${run.slice(copied, start)}[email]`;
    copied = at.index + at[0].length;
  }
  return out + run.slice(copied);
}

const EMAIL: Shape = {
  name: "email",
  // The whole run of address characters and `@`s that holds an `@`: the lookbehind starts it at
  // the run's first character and the greedy parts end it at its last, so it is read once;
  // emailToken finds the addresses in it.
  pattern: /(?<![A-Za-z0-9._%+@-])[A-Za-z0-9._%+-]*@[A-Za-z0-9._%+@-]*/gu,
  token: (run) => emailToken(run),
};

const IPV4: Shape = {
  name: "ipv4",
  // Bounded by digits rather than by word boundaries: "ip_<address>" and "<address>in" lose it. A
  // percent escape's digits are not the address's ("%2010.1.2.3" is an encoded space before one).
  pattern: /(?:(?<!\d)|(?<=%[0-9A-Fa-f]{2}))(?:\d{1,3}\.){3}\d{1,3}(?!\d)/gu,
  token: "[ip]",
};

/** A character of a name: beside `::` it makes a scope operator ("std::vector"). */
const NAME_CHARACTER = /^[\p{L}\p{N}_$]$/u;

/**
 * How many colons at one end of a run stay outside the address: a lone one is a label's or a
 * port's ("ip:<address>", "<address>: reset"), and of three or more one does, the `::` after it
 * being the address's ("ip:::1").
 */
function colonsOutside(colons: number): number {
  return colons === 1 || colons >= 3 ? 1 : 0;
}

/** The colons at the start of a run, or at its end: counted, since /:+$/ is quadratic on "::…:a". */
function colonsAtEnd(run: string, end: "start" | "end"): number {
  const at = (count: number): number => (end === "start" ? count : run.length - 1 - count);
  let count = 0;
  while (count < run.length && run.charAt(at(count)) === ":") count++;
  return count;
}

/**
 * Decides a run of hex digits and colons (and its zone). It is an IPv6 address when it compresses
 * with `::` or has eight groups or more; a shorter run with single colons is a time, a ratio or a
 * MAC address and is kept. An address is removed whole, whatever stands beside it, with a colon
 * kept outside at either end: a letter beside it, or a hex letter or a port inside its run
 * ("<address>:443", which "<hex label>:<address>" cannot be told from), never saves a group of it.
 * Only a run of one group or none beside a name's character is kept, as a scope operator
 * ("Foo::Bar", "Array::new"): no such address identifies anyone.
 */
function ipv6Token(match: string, at: ShapeMatch): string {
  const zone = match.indexOf("%");
  const run = zone === -1 ? match : match.slice(0, zone);
  const leading = colonsAtEnd(run, "start");
  if (leading === run.length && run !== "::") return match;
  const trailing = colonsAtEnd(run, "end");
  const head = leading === run.length ? 0 : colonsOutside(leading);
  const tail = leading === run.length ? 0 : colonsOutside(trailing);
  const address = run.slice(head, run.length - tail);
  const groups = address.split(":").filter((group) => group !== "").length;
  if (!address.includes("::") && groups < 8) return match;
  if (groups <= 1) {
    const before = head === 0 ? at.input.charAt(at.offset - 1) : "";
    const after = tail === 0 && zone === -1 ? at.input.charAt(at.offset + match.length) : "";
    if (NAME_CHARACTER.test(before) || NAME_CHARACTER.test(after)) return match;
  }
  return `${":".repeat(head)}[ip]${":".repeat(tail)}`;
}

const IPV6: Shape = {
  name: "ipv6",
  // The whole run of hex digits and colons holding a colon: the lookbehind starts it at the run's
  // first character and the greedy parts end it at the run's last, so there is no shorter
  // candidate to back off to; ipv6Token decides. A zone joins the run only where no letter, digit
  // or colon follows it: a run that is kept is returned with its zone, so a zone that ran on into
  // more hex digits and colons ("%20<address>", "%eth0:<address>") would keep the address it took
  // the start of. A zone's letters and digits hold no colon, so taken this way it hides nothing.
  pattern: /(?<![0-9A-Fa-f:])[0-9A-Fa-f]*:[0-9A-Fa-f:]*(?:%[0-9A-Za-z]+(?![0-9A-Za-z:]))?/gu,
  token: ipv6Token,
};

const QUERY_STRING: Shape = {
  name: "query-string",
  pattern: /\?[^\s"'#]*/gu,
  token: "?[query]",
};

/** Verify's hosted paths (`/c/`, `/p/`, `/a/`, selfie's `/s/`, an invitation's `/i/`). */
const ID_PATH: Shape = {
  name: "id-path",
  pattern: /\/(c|p|a|s|i)\/[A-Za-z0-9_-]{16,}/gu,
  token: "/$1/[segment]",
};

const LONG_SEGMENT: Shape = {
  name: "long-segment",
  // Whatever follows the run (`/`, `?`, `:`, `=`, `.`, a quote): a segment is any run after a `/`.
  pattern: /\/([A-Za-z0-9_-]{24,})/gu,
  token: (match, { groups: [segment = ""] }) =>
    /[0-9]/.test(segment) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment))
      ? "/[segment]"
      : match,
};

/** An account or phone number, a card number: any run of nine digits or more. */
const DIGITS: Shape = {
  name: "digits",
  pattern: /\b\d{9,}\b/gu,
  token: "[digits]",
};

/** A sign-in, step-up or backup code beside its word. */
const CODE: Shape = {
  name: "code",
  pattern: /(code|otp|pin)\W{0,3}\d{6,8}/giu,
  token: "$1 [code]",
};

/** Every row of spec 08 §5.4, in the order the scrubbers apply them (@fin/core's order). */
export const SHAPES: readonly Shape[] = Object.freeze([
  PRIVATE_KEY,
  AGE_IDENTITY,
  FIN_API_KEY,
  FIN_KEY_LIKE,
  WEBHOOK_SECRET,
  CLOUDFLARE_TOKEN,
  TOKEN_JSON,
  HEARTBEAT_URL,
  DSN,
  POSTGRES_URL,
  BEARER,
  BASIC_AUTH,
  COOKIE_PAIR,
  ACCESS_COOKIE,
  INGRESS_PROOF,
  EMAIL,
  IPV4,
  IPV6,
  QUERY_STRING,
  ID_PATH,
  LONG_SEGMENT,
  DIGITS,
  CODE,
]);

/**
 * A URL's fragment of 16 characters or more, or one holding a `=`: a link token, or a code beside
 * its key (`#c=12345678`). It runs after SHAPES, and takes the tokens they leave (`[email]`) with
 * the rest, so a fragment is removed whole whatever the rows before it found in it. A short
 * fragment with no `=` (`#root`, `#42`, a colour) is kept.
 */
const FRAGMENT: Shape = {
  name: "fragment",
  pattern: /#[A-Za-z0-9._~%+/=&:@?!$,;*[\]-]*/gu,
  token: (match) => (match.length > 16 || match.includes("=") ? "#[fragment]" : match),
};

/** The rows only the browser needs, applied after SHAPES. */
export const BROWSER_SHAPES: readonly Shape[] = Object.freeze([FRAGMENT]);

function applyShape(text: string, shape: Shape): string {
  shape.pattern.lastIndex = 0;
  const token = shape.token;
  if (typeof token === "string") return text.replace(shape.pattern, token);
  return text.replace(shape.pattern, (match: string, ...rest: unknown[]) => {
    // After the match come the groups (a string, or undefined for one that took no part), then
    // the offset, the whole text and, with named groups, an object of them.
    const offset = rest.findIndex((item) => typeof item === "number");
    return token(match, {
      groups: rest.slice(0, offset).map((group) => (typeof group === "string" ? group : "")),
      offset: rest[offset] as number,
      input: rest[offset + 1] as string,
    });
  });
}

/** `text` with every shape above replaced by its token: SHAPES, then BROWSER_SHAPES. */
export function scrubText(text: string): string {
  let out = text;
  for (const shape of SHAPES) out = applyShape(out, shape);
  for (const shape of BROWSER_SHAPES) out = applyShape(out, shape);
  return out;
}
