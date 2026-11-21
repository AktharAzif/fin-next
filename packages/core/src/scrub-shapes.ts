// The shapes the scrubbers remove (spec 08 §5.4; AC-P0-12, AC-P0-40), one constant each, applied in
// the order of SHAPES. Every pattern carries the g and u flags; those spec 08 marks (i) add i.
//
// Where this file differs from spec 08 §5.4's table (each recorded in the pull request):
//   - IPV6 takes each whole run of hex digits and colons that holds a colon, so the engine cannot
//     back off to a shorter run that is kept, and removes it when it is address-shaped: it holds
//     `::` or eight groups or more, whatever stands beside it. So an RFC 3339 time ("09:48:23") or
//     a MAC address is never mistaken for an address, while "ip:<address>", "<address>:443" (as
//     Node writes a host and port) and an address run together with a word are removed. A run of
//     one group or none with a letter beside it is a scope operator ("std::vector") and is kept;
//   - IPV4 is bounded by digits, not by word boundaries, so a letter or `_` beside an address does
//     not keep it ("ip_<address>"). DIGITS keeps the table's `\b`: digits inside a word belong to
//     a digest (the release, on every line) or an ID;
//   - EMAIL starts only where a run of local-part characters starts, so a long run with no `@`
//     costs one pass, not one pass per character (the unanchored form is quadratic);
//   - TOKEN_JSON also takes `+`, `/` and `=`, so a tunnel token (standard base64 of JSON) is removed
//     whole, not cut at its first `+`;
//   - LONG_SEGMENT removes a path segment of 24 or more base64url characters, whatever follows it,
//     only when it holds a digit or both cases, so a route template such as
//     "/passkey/generate-authenticate-options" survives while IDs, tokens and keys in paths do not;
//   - ID_PATH keeps its one-letter route ("/c/[segment]"), which identifies no one;
//   - CLOUDFLARE_TOKEN also takes the user-token prefix `cfut_`, BASIC_AUTH and ACCESS_COOKIE are
//     added beside the bearer and cookie rows, FIN_KEY_LIKE catches a malformed Fin key, and
//     BEARER also takes `_`, which base64url tokens carry;
//   - PRIVATE_KEY's block with no END line runs to the next block's BEGIN or the end of the text:
//     a key cut short is still key material;
//   - an open part that the next match's own start would satisfy stops there, so a long run of
//     starts with no end is read once, not once per start (the table's forms are quadratic on
//     one): a cookie's name stops at the next `__Host-` or `__Secure-`, a Postgres password at the
//     next `postgres://` and a key's body at the next BEGIN, and HEARTBEAT_URL finds
//     `betterstack` in its host by a lookahead, which accepts exactly the hosts the table's two
//     open runs around the word accept.
//
// Every pattern is linear in its input: what each repeated part takes ends where its next part
// must start or where the next match's start is, and a test scrubs 1 MB of an adversarial input
// for every shape (scrub.test.ts).

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

export const PRIVATE_KEY: Shape = {
  name: "private-key",
  pattern:
    /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----)[\s\S])*(?:-----END [A-Z ]*PRIVATE KEY-----)?/gu,
  token: "[private-key]",
};

export const AGE_IDENTITY: Shape = {
  name: "age-identity",
  pattern: /AGE-SECRET-KEY-1[0-9A-Z]{58}/gu,
  token: "[private-key]",
};

export const FIN_API_KEY: Shape = {
  name: "fin-api-key",
  pattern: /fin_(?:test|live)_(?:sk|rk)_[0-9A-Z]{10}[0-9A-Za-z]{38}/gu,
  token: "[api-key]",
};

export const FIN_KEY_LIKE: Shape = {
  name: "fin-key-like",
  pattern: /fin_(?:test|live)_[A-Za-z0-9_]{16,}/gu,
  token: "[api-key]",
};

export const WEBHOOK_SECRET: Shape = {
  name: "webhook-secret",
  pattern: /whsec_[A-Za-z0-9+/=_-]{24,}/gu,
  token: "[secret]",
};

export const CLOUDFLARE_TOKEN: Shape = {
  name: "cloudflare-token",
  pattern: /cf[au]t_[A-Za-z0-9_-]{20,}/gu,
  token: "[token]",
};

/** A JWT (an Access token among them) or a tunnel token: base64 of a JSON object. */
export const TOKEN_JSON: Shape = {
  name: "jwt-or-tunnel-token",
  pattern: /eyJ[A-Za-z0-9+/_-]{8,}={0,2}(?:\.[A-Za-z0-9_-]{4,}={0,2}){0,2}/gu,
  token: "[token]",
};

export const HEARTBEAT_URL: Shape = {
  name: "heartbeat-url",
  // The host is the one run of host characters after `https://`: it must hold `betterstack` (the
  // lookahead) and end in `.com`, each found by one pass over the run.
  pattern:
    /https:\/\/(?=[a-z0-9.-]*betterstack)[a-z0-9.-]*\.com\/api\/v[0-9]+\/(?:heartbeat|incoming-webhook)\/[A-Za-z0-9]+/giu,
  token: "[heartbeat-url]",
};

export const DSN: Shape = {
  name: "dsn",
  pattern: /https:\/\/[A-Za-z0-9]+@[A-Za-z0-9.-]+\/[0-9A-Za-z]+/gu,
  token: "[dsn]",
};

export const POSTGRES_URL: Shape = {
  name: "postgres-url",
  // The password stops at the next `postgres://`, which no password holds (a `/` in one is
  // percent-encoded), so URLs with no `@` are read once.
  pattern: /postgres(?:ql)?:\/\/[^:/\s]+:(?:(?!postgres(?:ql)?:\/\/)[^@\s])+@/gu,
  token: "postgres://[login]:[secret]@",
};

export const BEARER: Shape = {
  name: "bearer",
  pattern: /bearer\s+[A-Za-z0-9._~+/=_-]{8,}/giu,
  token: "Bearer [secret]",
};

export const BASIC_AUTH: Shape = {
  name: "basic-auth",
  pattern: /basic\s+[A-Za-z0-9+/]{8,}={0,2}/giu,
  token: "Basic [secret]",
};

export const COOKIE_PAIR: Shape = {
  name: "cookie",
  // The name stops at the next `__Host-` or `__Secure-` (whose own pair is then matched), so a run
  // of prefixes with no `=` is read once.
  pattern: /__(?:Host|Secure)-(?:(?!__(?:Host|Secure)-)[A-Za-z0-9._-])+=[^;\s]+/gu,
  token: "[cookie]",
};

export const ACCESS_COOKIE: Shape = {
  name: "access-cookie",
  pattern: /CF_(?:Authorization|Binding|AppSession)=[^;\s]+/gu,
  token: "[cookie]",
};

export const INGRESS_PROOF: Shape = {
  name: "ingress-proof",
  pattern: /fin-ingress-proof:\s*\S+/giu,
  token: "Fin-Ingress-Proof: [secret]",
};

export const EMAIL: Shape = {
  name: "email",
  pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
  token: "[email]",
};

export const IPV4: Shape = {
  name: "ipv4",
  // Bounded by digits rather than by word boundaries: "ip_<address>" and "<address>in" lose it.
  pattern: /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/gu,
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

export const IPV6: Shape = {
  name: "ipv6",
  // The whole run of hex digits and colons holding a colon, with its zone: the lookbehind starts it
  // at the run's first character and the greedy parts end it at the run's last, so there is no
  // shorter candidate to back off to; ipv6Token decides.
  pattern: /(?<![0-9A-Fa-f:])[0-9A-Fa-f]*:[0-9A-Fa-f:]*(?:%[0-9A-Za-z]+)?/gu,
  token: ipv6Token,
};

export const QUERY_STRING: Shape = {
  name: "query-string",
  pattern: /\?[^\s"'#]*/gu,
  token: "?[query]",
};

export const ID_PATH: Shape = {
  name: "id-path",
  pattern: /\/(c|p|a|s|i)\/[A-Za-z0-9_-]{16,}/gu,
  token: "/$1/[segment]",
};

export const LONG_SEGMENT: Shape = {
  name: "long-segment",
  // Whatever follows the run (`/`, `?`, `:`, `=`, `.`, a quote): a segment is any run after a `/`.
  pattern: /\/([A-Za-z0-9_-]{24,})/gu,
  token: (match, { groups: [segment = ""] }) =>
    /[0-9]/.test(segment) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment))
      ? "/[segment]"
      : match,
};

export const DIGITS: Shape = {
  name: "digits",
  pattern: /\b\d{9,}\b/gu,
  token: "[digits]",
};

export const CODE: Shape = {
  name: "code",
  pattern: /(code|otp|pin)\W{0,3}\d{6,8}/giu,
  token: "$1 [code]",
};

/** Every shape, in the order the scrubbers apply them. */
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
 * Field names whose values are withheld, compared case-insensitively with `_` and `-` removed
 * (spec 08 §5.4). The list alone decides: a key ending in `Id` (`keyId`, `orgId`) is kept because
 * no name here but `taxid` ends in "id", and a tax ID is withheld in every spelling (`taxId`,
 * `tax_id`).
 */
export const WITHHELD_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "firstname",
  "lastname",
  "fullname",
  "displayname",
  "holdername",
  "email",
  "emailaddress",
  "phone",
  "address",
  "street",
  "postcode",
  "zip",
  "dob",
  "dateofbirth",
  "ip",
  "ipaddress",
  "clientip",
  "useragent",
  "password",
  "secret",
  "token",
  "code",
  "otp",
  "cookie",
  "authorization",
  "apikey",
  "key",
  "accountnumber",
  "iban",
  "taxid",
  "ssn",
  "note",
  "message",
  "body",
  "query",
  "querystring",
  "url",
  "headers",
  "details",
  "answers",
]);
