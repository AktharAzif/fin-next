// The shapes a line printed in the browser may hold that must never reach the console: spec 08
// §5.4's table, the rows a page can meet (addresses, tokens and keys, cookies, query strings and
// fragments, ID-bearing path segments). The servers' full list lives in @fin/core's scrub-shapes
// (P0-D); this is the browser's copy of its subset until that package, Web APIs only, is on main,
// when the guard imports it instead. Applied in order; each pattern carries the g and u flags.

const SHAPES: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[private-key]"],
  [/fin_(?:test|live)_[A-Za-z0-9_]{16,}/gu, "[api-key]"],
  [/whsec_[A-Za-z0-9+/=_-]{24,}/gu, "[secret]"],
  [/eyJ[A-Za-z0-9+/_-]{8,}={0,2}(?:\.[A-Za-z0-9_-]{4,}={0,2}){0,2}/gu, "[token]"],
  [/bearer\s+[A-Za-z0-9._~+/=_-]{8,}/giu, "Bearer [secret]"],
  [/__(?:Host|Secure)-[A-Za-z0-9._-]+=[^;\s]+/gu, "[cookie]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[email]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[ip]"],
  // A query string, and a long fragment (an invitation's token travels in the fragment, S2-15).
  [/\?[^\s"'#]*/gu, "?[query]"],
  [/#[A-Za-z0-9._~%+/=-]{16,}/gu, "#[fragment]"],
  // Verify's hosted paths carry a link token; any long base64url segment is an ID or a token.
  [/\/(?:c|p|a|s|i)\/[A-Za-z0-9_-]{16,}/gu, "/[segment]"],
  [/\/(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}/gu, "/[segment]"],
];

/** `text` with every shape above replaced by its token. */
export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, token] of SHAPES) out = out.replace(pattern, token);
  return out;
}
