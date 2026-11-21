// The parameter vocabulary every template's strict Zod object is built from (spec 08 §4.1; spec 02
// §17.1): Fin's IDs, plus only the display values a template names (`code`, `orgName`, `roleLabel`,
// `personName`, `device`, `time`, `count`, `mode`, `rail`, `accountLast4`).
//
// No display value may carry a secret (T08-23, T-SAT-41): an API key, a webhook secret, a
// Cloudflare token, a JWT, an enrolment code, a backup code, a link token or an address. Each
// string is refused when it holds one of those shapes, so a caller that passes one by mistake has
// its enqueue refused rather than its secret mailed.
import { z } from "zod";

/** The secret shapes no display value may hold. */
export const SECRET_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] =
  Object.freeze([
    { name: "fin-api-key", pattern: /fin_(?:test|live)_[A-Za-z0-9_]{8,}/u },
    { name: "webhook-secret", pattern: /whsec_[A-Za-z0-9+/=_-]{8,}/u },
    { name: "cloudflare-token", pattern: /cf[au]t_[A-Za-z0-9_-]{8,}/u },
    { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]{8,}/u },
    { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
    // A staff enrolment code: 16 Crockford base32 characters (spec 02 §6.5), run together, or in
    // four groups of four holding a digit (so four short words are not mistaken for one).
    { name: "enrolment-code", pattern: /\b[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{16}\b/u },
    {
      name: "enrolment-code",
      pattern:
        /\b(?=[0-9A-Za-z -]{19}\b)(?=[A-Za-z -]{0,18}\d)[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4}([- ])[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4}\1[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4}\1[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4}\b/u,
    },
    // A backup code as the library prints it: two groups of five, holding a digit or a case change
    // inside a group (so a double-barrelled name such as "Smith-Jones" is not refused).
    {
      name: "backup-code",
      pattern:
        /\b(?=[A-Za-z0-9-]{11}\b)(?=[A-Za-z-]{0,10}\d|[A-Za-z0-9-]{0,9}[a-z][A-Z])[A-Za-z0-9]{5}-[A-Za-z0-9]{5}\b/u,
    },
    // Any long run that mixes letters and digits: a token, a key or a secret of some other shape.
    {
      name: "token-like",
      pattern: /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}/u,
    },
    { name: "email", pattern: /[^\s@]+@[^\s@]+\.[^\s@]+/u },
    { name: "url", pattern: /\b(?:https?:\/\/|www\.)/iu },
    { name: "digits", pattern: /\d{7,}/u },
  ]);

/** The first secret shape a value holds, or undefined. */
export function secretShapeIn(value: string): string | undefined {
  for (const shape of SECRET_SHAPES) if (shape.pattern.test(value)) return shape.name;
  return undefined;
}

// Invisible, bidirectional and other control characters (spec 02 §8.6 refuses them in names).
const CONTROL_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

function isControl(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (CONTROL_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return true;
  }
  return false;
}

/** A typed display value: bounded, single-line, no control characters, no secret shape. */
export function displayText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !isControl(v), { message: "control characters are refused" })
    .refine((v) => v.trim() === v && v.trim().length > 0, { message: "untrimmed text is refused" })
    .refine((v) => secretShapeIn(v) === undefined, { message: "a secret shape is refused" });
}

/** Fin's IDs: `<prefix>_<26 Crockford base32>` (ARCHITECTURE §6.2). */
export function finId(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`, "u"));
}

export const param = Object.freeze({
  /** An 8-digit emailed code (spec 02 §5.2). Nothing else is ever a code in an email. */
  code: z.string().regex(/^\d{8}$/u),
  personName: displayText(60),
  orgName: displayText(50),
  roleLabel: displayText(40),
  /** A device label such as "Safari on macOS", built by the caller from the user agent. */
  device: displayText(80),
  /** An instant, rendered in UTC by the layout. */
  time: z.iso.datetime({ offset: false }),
  count: z.number().int().min(0).max(1_000_000),
  mode: z.enum(["sandbox", "live"]),
  rail: z.enum(["ach", "fedwire"]),
  accountLast4: z.string().regex(/^\d{4}$/u),
  userId: finId("usr"),
  orgId: finId("org"),
  staffId: finId("stf"),
  invitationId: finId("inv"),
  roleId: finId("rol"),
  /** The invitation's link token: the one link token a developer template may carry (T08-23). */
  // It is random base64url, so only the named secret shapes are refused, not "token-like".
  invitationToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,64}$/u)
    .refine((v) => !/^(?:fin_|whsec_|cf[au]t_|eyJ)/u.test(v), {
      message: "a secret shape is refused",
    }),
  /** A commit SHA. */
  release: z.string().regex(/^[0-9a-f]{7,40}$/u),
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "21 Nov 2026, 10:05 UTC", the one way a time is written in an email. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}
