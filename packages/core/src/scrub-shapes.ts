// The shapes the scrubbers remove (spec 08 §5.4; AC-P0-12, AC-P0-40), one constant each, applied in
// the order of SHAPES. Every pattern carries the g and u flags; those spec 08 marks (i) add i.
//
// Where this file differs from spec 08 §5.4's table (each recorded in the pull request):
//   - IPV6 takes every run of hex groups and colons and removes it when it is address-shaped: it
//     holds `::` or eight groups or more. So an RFC 3339 time ("09:48:23") or a MAC address is never
//     mistaken for an address, while an address beside a `:` ("ip:<address>", "<address>:443", as
//     Node writes a host and port) is still removed;
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
//     BEARER also takes `_`, which base64url tokens carry.
//
// Every pattern is linear in its input: a test scrubs 256 KB of each adversarial shape.

export interface Shape {
  readonly name: string;
  readonly pattern: RegExp;
  /** The replacement: a string with `$n` references, or a function of the match. */
  readonly token: string | ((match: string, ...groups: string[]) => string);
}

export const PRIVATE_KEY: Shape = {
  name: "private-key",
  pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
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
  pattern:
    /https:\/\/[a-z0-9.-]*betterstack[a-z0-9.-]*\.com\/api\/v[0-9]+\/(?:heartbeat|incoming-webhook)\/[A-Za-z0-9]+/giu,
  token: "[heartbeat-url]",
};

export const DSN: Shape = {
  name: "dsn",
  pattern: /https:\/\/[A-Za-z0-9]+@[A-Za-z0-9.-]+\/[0-9A-Za-z]+/gu,
  token: "[dsn]",
};

export const POSTGRES_URL: Shape = {
  name: "postgres-url",
  pattern: /postgres(?:ql)?:\/\/[^:/\s]+:[^@\s]+@/gu,
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
  pattern: /__(?:Host|Secure)-[A-Za-z0-9._-]+=[^;\s]+/gu,
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
  pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
  token: "[ip]",
};

const H = "[0-9A-Fa-f]{1,4}";

/**
 * Whether a run of hex groups and colons is an IPv6 address: it compresses with `::`, or it has
 * eight groups (seven colons) or more. A shorter run with single colons is a time, a ratio or a MAC
 * address and is kept. A longer run is removed whole: "<address>:443" (as Node writes a host and
 * port) and "<hex label>:<address>" cannot be told apart, so no group of either is left.
 */
function ipv6Token(match: string): string {
  const address = match.replace(/%[0-9A-Za-z]+$/u, "");
  return address.includes("::") || address.split(":").length >= 8 ? "[ip]" : match;
}

export const IPV6: Shape = {
  name: "ipv6",
  // A candidate starts where no letter or digit is before it (a `:` may be, as in "ip:<address>")
  // and ends where no letter or digit follows; ipv6Token decides whether it is an address.
  pattern: new RegExp(
    `(?<![0-9A-Za-z])(?:${H}(?::{1,2}${H})+(?:::)?|${H}::|::(?:${H}(?::{1,2}${H})*)?)(?:%[0-9A-Za-z]+)?(?![0-9A-Za-z])`,
    "gu",
  ),
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
  token: (match, segment = "") =>
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
 * (spec 08 §5.4). A key ending in `Id` or `_id` is never withheld.
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
