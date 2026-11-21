// The shapes a line printed in the browser must never hold: every row of spec 08 §5.4's table, in
// the order the scrubbers apply them. This is a copy of @fin/core's scrub-shapes (P0-D), with the
// refinements recorded there, until that package (Web APIs only) is on main; the console guard then
// imports `@fin/core/scrub` instead, and test/scrub.test.ts, one case per row, runs against it.
// Every row is kept, not a subset a page is thought to meet: what a library prints is not known in
// advance, and a missing row is a value that reaches the console.
//
// Where the patterns differ from spec 08 §5.4's table (as @fin/core records them):
//   - IPV6 takes every run of hex groups and colons and removes it when it is address-shaped: it
//     holds `::` or has eight groups or more. A time ("09:48:23") or a MAC address is kept, and an
//     address beside a `:` ("ip:<address>", "<address>:443") is still removed;
//   - EMAIL starts only where a run of local-part characters starts, so a long run with no `@`
//     costs one pass, not one pass per character (the unanchored form is quadratic);
//   - TOKEN_JSON also takes `+`, `/` and `=`, so a tunnel token (standard base64) goes whole;
//   - LONG_SEGMENT removes a path segment of 24 or more base64url characters when it holds a digit
//     or both cases, so a route template ("/passkey/generate-authenticate-options") survives;
//   - ID_PATH keeps its one-letter route ("/c/[segment]"), which identifies no one;
//   - CLOUDFLARE_TOKEN also takes `cfut_`; BASIC_AUTH, ACCESS_COOKIE and FIN_KEY_LIKE are added
//     beside the bearer, cookie and API-key rows; BEARER also takes `_`.
//
// Every pattern is linear in its input (a test scrubs 256 KB of each adversarial run), and the
// lookbehinds are within the build's browser target (Vite's baseline: Safari 16.4 and later).

export interface Shape {
  readonly name: string;
  readonly pattern: RegExp;
  /** The replacement: a string with `$n` references, or a function of the match. */
  readonly token: string | ((match: string, ...groups: string[]) => string);
}

const PRIVATE_KEY: Shape = {
  name: "private-key",
  pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
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
  pattern:
    /https:\/\/[a-z0-9.-]*betterstack[a-z0-9.-]*\.com\/api\/v[0-9]+\/(?:heartbeat|incoming-webhook)\/[A-Za-z0-9]+/giu,
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
  pattern: /postgres(?:ql)?:\/\/[^:/\s]+:[^@\s]+@/gu,
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
  pattern: /__(?:Host|Secure)-[A-Za-z0-9._-]+=[^;\s]+/gu,
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

const EMAIL: Shape = {
  name: "email",
  pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
  token: "[email]",
};

const IPV4: Shape = {
  name: "ipv4",
  pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
  token: "[ip]",
};

const H = "[0-9A-Fa-f]{1,4}";

/**
 * Whether a run of hex groups and colons is an IPv6 address: it compresses with `::`, or it has
 * eight groups (seven colons) or more. A shorter run with single colons is a time, a ratio or a MAC
 * address and is kept. A longer run is removed whole: "<address>:443" and "<hex label>:<address>"
 * cannot be told apart, so no group of either is left.
 */
function ipv6Token(match: string): string {
  const address = match.replace(/%[0-9A-Za-z]+$/u, "");
  return address.includes("::") || address.split(":").length >= 8 ? "[ip]" : match;
}

const IPV6: Shape = {
  name: "ipv6",
  // A candidate starts where no letter or digit is before it (a `:` may be, as in "ip:<address>")
  // and ends where no letter or digit follows; ipv6Token decides whether it is an address.
  pattern: new RegExp(
    `(?<![0-9A-Za-z])(?:${H}(?::{1,2}${H})+(?:::)?|${H}::|::(?:${H}(?::{1,2}${H})*)?)(?:%[0-9A-Za-z]+)?(?![0-9A-Za-z])`,
    "gu",
  ),
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
  token: (match, segment = "") =>
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

/** Every shape, in the order the scrubbers apply them (@fin/core's order). */
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

function applyShape(text: string, shape: Shape): string {
  shape.pattern.lastIndex = 0;
  const token = shape.token;
  return typeof token === "string"
    ? text.replace(shape.pattern, token)
    : text.replace(shape.pattern, (match: string, ...rest: unknown[]) =>
        token(match, ...rest.filter((part): part is string => typeof part === "string")),
      );
}

/** `text` with every shape above replaced by its token. */
export function scrubText(text: string): string {
  let out = text;
  for (const shape of SHAPES) out = applyShape(out, shape);
  return out;
}
