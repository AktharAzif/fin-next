// Message headers (ARCHITECTURE §9.3, §9.6; spec 08 §4.1).
//
// Cloudflare Email Sending refuses the whole send when one header is not allowed, so the adapter
// checks every header in code against Cloudflare's published rules (Email Service, "Email headers",
// read 21 Nov 2026): the allowlisted names below, or any `X-[A-Za-z0-9_-]+` name up to 100
// characters; values UTF-8, non-empty, at most 2,048 bytes, no bare CR or LF; at most 20
// allowlisted (non-X) headers; at most 16 KB in all, counted as name + 2 + value + 2. Fin adds its
// own refusals: no List-* header ([EM-05]: no List-Unsubscribe on security mail).

/** Cloudflare's allowlist of non-X headers, lower-cased. */
export const CLOUDFLARE_ALLOWED: ReadonlySet<string> = new Set([
  "in-reply-to",
  "references",
  "thread-index",
  "thread-topic",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "list-id",
  "list-archive",
  "list-help",
  "list-owner",
  "list-post",
  "list-subscribe",
  "precedence",
  "auto-submitted",
  "content-language",
  "keywords",
  "comments",
  "importance",
  "priority",
  "sensitivity",
  "organization",
  "require-recipient-valid-since",
  "expires",
  "reply-by",
  "archived-at",
  "otp-token",
]);

/** Allowed by Cloudflare, refused by Fin. */
const FIN_REFUSED = /^list-/u;

const X_NAME = /^X-[A-Za-z0-9_-]+$/u;
const ALLOWED_NAME = /^[A-Za-z0-9-]+$/u;
const MAX_NAME = 100;
const MAX_VALUE_BYTES = 2048;
const MAX_ALLOWLISTED = 20;
const MAX_TOTAL_BYTES = 16 * 1024;

export class HeaderRefused extends Error {
  readonly code = "header_refused";
  constructor(message: string) {
    super(message);
    this.name = "HeaderRefused";
  }
}

const encoder = new TextEncoder();

/** Throws HeaderRefused when a header would fail the send or breaks Fin's rules. Names only in errors. */
export function checkHeaders(headers: Readonly<Record<string, string>>): void {
  const seen = new Set<string>();
  let allowlisted = 0;
  let total = 0;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new HeaderRefused(`header named twice: ${name}`);
    seen.add(lower);
    if (name.length > MAX_NAME) throw new HeaderRefused("header name too long");
    if (lower.startsWith("x-")) {
      if (!X_NAME.test(name)) throw new HeaderRefused(`bad X- header name: ${name}`);
    } else {
      if (!ALLOWED_NAME.test(name) || !CLOUDFLARE_ALLOWED.has(lower)) {
        throw new HeaderRefused(`header not allowed: ${name}`);
      }
      if (FIN_REFUSED.test(lower)) throw new HeaderRefused(`header refused by Fin: ${name}`);
      allowlisted += 1;
    }
    const bytes = encoder.encode(value).length;
    if (value.trim() === "" || /[\r\n]/u.test(value) || bytes > MAX_VALUE_BYTES) {
      throw new HeaderRefused(`bad value for header: ${name}`);
    }
    total += encoder.encode(name).length + 2 + bytes + 2;
  }
  if (allowlisted > MAX_ALLOWLISTED) throw new HeaderRefused("too many allowlisted headers");
  if (total > MAX_TOTAL_BYTES) throw new HeaderRefused("headers too large");
}

/** Fin's three headers on every message (ARCHITECTURE §9.3). `entityRef` is new per message. */
export function finHeaders(category: string, entityRef: string): Record<string, string> {
  return {
    "Auto-Submitted": "auto-generated",
    "X-Entity-Ref-ID": entityRef,
    "X-Fin-Category": category,
  };
}
