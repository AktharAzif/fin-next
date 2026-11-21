// A key's name (spec 02 §12.3's `keyName` rule, the ApiKeyCreate board's "nameRule" state): 1 to 60
// characters of letters, numbers, spaces and simple punctuation, trimmed and in Unicode NFC. A name
// appears in emails, so it may not look like a web or email address (a dot between two words reads
// as a domain: "use a dash instead, such as payments-prod"), hold a run of 7 or more digits, a key's
// own shape, or any invisible or bidirectional control. Every refusal answers one sentence.

export const KEY_NAME_MAX = 60;

export const KEY_NAME_SENTENCE =
  "Use letters, numbers and simple punctuation, up to 60 characters. A key’s name appears in emails, so it can’t look like a web or email address: use a dash instead of a dot, such as payments-prod.";

export type KeyNameRefusal =
  | "empty"
  | "too_long"
  | "characters"
  | "invisible"
  | "web_address"
  | "digits"
  | "key_shape";

const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const ALLOWED = /^[\p{L}\p{M}\p{Nd} ,'’\-_&()/:!?#+.]*$/u;
// A dot between two letters or digits ("ledger.sync", "acme.com"), an @, or a scheme.
const WEB = /(?:https?:\/\/|www\.)|[\p{L}\p{Nd}]\.[\p{L}\p{Nd}]|@/iu;
const DIGIT_RUN = /\p{Nd}{7,}/u;
const KEY_SHAPE = /fin_(?:test|live)_/iu;

export type KeyNameResult =
  | { ok: true; value: string }
  | { ok: false; reason: KeyNameRefusal; sentence: string };

export function checkKeyName(raw: unknown): KeyNameResult {
  const refuse = (reason: KeyNameRefusal): KeyNameResult => ({
    ok: false,
    reason,
    sentence: KEY_NAME_SENTENCE,
  });
  if (typeof raw !== "string") return refuse("empty");
  const value = raw.normalize("NFC").trim();
  if (value === "") return refuse("empty");
  if (Array.from(value).length > KEY_NAME_MAX) return refuse("too_long");
  if (INVISIBLE.test(value) || !value.isWellFormed()) return refuse("invisible");
  if (KEY_SHAPE.test(value)) return refuse("key_shape");
  if (WEB.test(value)) return refuse("web_address");
  if (!ALLOWED.test(value)) return refuse("characters");
  if (DIGIT_RUN.test(value)) return refuse("digits");
  return { ok: true, value };
}
