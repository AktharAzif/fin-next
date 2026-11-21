// The parameter vocabulary every template's strict Zod object is built from (spec 08 §4.1; spec 02
// §17.1): Fin's IDs, plus only the display values a template names (`code`, `orgName`, `roleLabel`,
// `personName`, `device`, `time`, `count`, `mode`, `rail`, `accountLast4`).
//
// No display value may carry a secret (T08-23, T-SAT-41): an API key, a webhook secret, a
// Cloudflare token, a JWT, an enrolment code, a backup code, a link token or an address. A value
// Fin builds itself (`displayText`) is refused when it holds one of those shapes, and `enqueue()`
// checks the params against the template before the row is written, so a caller that passes one by
// mistake has its enqueue (and so its action) refused rather than its secret mailed.
//
// A value someone else chooses is different: a person's, a team's or a role's name (whatever spec
// 02 §8.6's name rule stored), and a device label built from the browser's user agent. If such a
// value could refuse the notice, it could refuse the action too: a member could block their own
// removal with a chosen display name, and a session's user agent could block the session's end. So
// those fields never refuse a string: one that is not a clean label, or that holds a secret shape,
// is replaced by `HIDDEN_VALUE` when it is parsed, so neither the outbox nor any email carries it.
// Names are checked against `NAME_SECRET_SHAPES`, which hold the codes in the forms Fin and the
// library print them, so a code passed into a name by mistake is hidden, never mailed (T08-23); an
// ordinary name in a code's shape ("Tier1-Admin", "ACME2025PAYMENTS") is hidden too, which costs
// only that name's showing in the notice.
import { z } from "zod";

export interface SecretShape {
  readonly name: string;
  readonly pattern: RegExp;
}

/** The secret shapes no display value may hold. */
export const SECRET_SHAPES: readonly SecretShape[] = Object.freeze([
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

const CROCKFORD = "0-9A-HJKMNP-TV-Za-hjkmnp-tv-z";
const CROCKFORD_UPPER = "0-9A-HJKMNP-TV-Z";
const CROCKFORD_LOWER = "0-9a-hjkmnp-tv-z";

/**
 * The secret shapes a name is checked against, and hidden on: the prefixed keys and tokens, a whole
 * JWT, a private key, an address, a web address, a run of 7 or more digits (spec 02 §8.6 refuses
 * the last three too), and the enrolment and backup codes in the forms Fin and the library print
 * them, which always mix letters and digits (T08-23: no template carries a code, spec 08 §4.1).
 * Left out, as names of their own: a long letters-and-digits run that mixes cases or is not a
 * code's length, a 5-5 pair without a digit, and four words of four letters with no group mixing a
 * letter and a digit ("Web3Infrastructure", "McKay-Jones", "Acme Bank Card 2025").
 */
export const NAME_SECRET_SHAPES: readonly SecretShape[] = Object.freeze([
  { name: "fin-api-key", pattern: /fin_(?:test|live)_[A-Za-z0-9_]{8,}/u },
  { name: "webhook-secret", pattern: /whsec_[A-Za-z0-9+/=_-]{8,}/u },
  { name: "cloudflare-token", pattern: /cf[au]t_[A-Za-z0-9_-]{8,}/u },
  // A JWT's header and the start of its payload ("eyJ...eyJ"), so "MoneyJarCompany" is a name.
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]*/u },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  // An enrolment code run together: 16 Crockford characters of one case holding a letter and a
  // digit, as Fin prints it ("Acme2025Payments", which mixes cases, is a name).
  {
    name: "enrolment-code",
    pattern: new RegExp(
      `\\b(?=[0-9A-Za-z]{16}\\b)(?=[A-Za-z]{0,15}\\d)(?=\\d{0,15}[A-Za-z])(?:[${CROCKFORD_UPPER}]{16}|[${CROCKFORD_LOWER}]{16})\\b`,
      "u",
    ),
  },
  // Four groups of four, one of which mixes a letter and a digit (a code's groups almost always do;
  // "Acme Bank Card 2025" has no such group).
  {
    name: "enrolment-code",
    pattern: new RegExp(
      `\\b(?=[0-9A-Za-z -]{19}\\b)(?=(?:[0-9A-Za-z]{4}[- ]){0,3}[0-9A-Za-z]{0,2}(?:[A-Za-z]\\d|\\d[A-Za-z]))[${CROCKFORD}]{4}([- ])[${CROCKFORD}]{4}\\1[${CROCKFORD}]{4}\\1[${CROCKFORD}]{4}\\b`,
      "u",
    ),
  },
  // A backup code holding a digit; a 5-5 pair of letters is a double-barrelled name.
  {
    name: "backup-code",
    pattern: /\b(?=[A-Za-z0-9-]{11}\b)(?=[A-Za-z-]{0,10}\d)[A-Za-z0-9]{5}-[A-Za-z0-9]{5}\b/u,
  },
  { name: "email", pattern: /[^\s@]+@[^\s@]+\.[^\s@]+/u },
  { name: "url", pattern: /\b(?:https?:\/\/|www\.)/iu },
  { name: "digits", pattern: /\d{7,}/u },
]);

/**
 * What a name or a device label's box shows in place of a value that is not a clean label or that
 * holds a secret shape. It is itself a clean label for every such field.
 */
export const HIDDEN_VALUE = "(not shown)";

function firstShape(shapes: readonly SecretShape[], value: string): string | undefined {
  for (const shape of shapes) if (shape.pattern.test(value)) return shape.name;
  return undefined;
}

/** The first secret shape a value holds, or undefined. */
export function secretShapeIn(value: string): string | undefined {
  return firstShape(SECRET_SHAPES, value);
}

/**
 * The first secret shape a name holds, or undefined. `packages/identity`'s name rule (spec 02 §8.6)
 * may refuse these when a name is entered; the email does not depend on it, since a name field hides
 * such a value rather than refusing the notice.
 */
export function nameSecretShapeIn(value: string): string | undefined {
  return firstShape(NAME_SECRET_SHAPES, value);
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

/**
 * Whether a value is a clean label: 1 to `max` characters, trimmed, well-formed (no lone surrogate,
 * which Postgres's jsonb refuses) and with no control character.
 */
function isCleanLabel(value: string, max: number): boolean {
  return (
    value.length >= 1 &&
    value.length <= max &&
    value.trim() === value &&
    value.isWellFormed() &&
    !isControl(value)
  );
}

/** A display value Fin builds itself: a clean label with no secret shape, or refused. */
export function displayText(max: number) {
  return z
    .string()
    .refine((v) => isCleanLabel(v, max), { message: "a bounded, trimmed, single-line value" })
    .refine((v) => secretShapeIn(v) === undefined, { message: "a secret shape is refused" });
}

/**
 * A value someone else chooses: any string is accepted, and one that is not a clean label or that
 * holds one of the shapes is replaced by `HIDDEN_VALUE`, so it never refuses the notice.
 */
function chosenText(max: number, shapeIn: (value: string) => string | undefined) {
  return z
    .string()
    .transform((v) => (isCleanLabel(v, max) && shapeIn(v) === undefined ? v : HIDDEN_VALUE));
}

/** A stored name (spec 02 §8.6): hidden, never refused, when it holds a `NAME_SECRET_SHAPES` shape. */
export function nameText(max: number) {
  return chosenText(max, nameSecretShapeIn);
}

/** A device label built from a user agent: hidden, never refused, when it holds any secret shape. */
export function deviceText(max: number) {
  return chosenText(max, secretShapeIn);
}

/** Fin's IDs: `<prefix>_<26 Crockford base32>` (ARCHITECTURE §6.2). */
export function finId(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`, "u"));
}

export const param = Object.freeze({
  /** An 8-digit emailed code (spec 02 §5.2). Nothing else is ever a code in an email. */
  code: z.string().regex(/^\d{8}$/u),
  personName: nameText(60),
  orgName: nameText(50),
  roleLabel: nameText(40),
  /** A device label such as "Safari on macOS", built by the caller from the user agent. */
  device: deviceText(80),
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
