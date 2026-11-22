// Names (spec 02 §8.6): what a person may call themselves, an organisation or a role. Letters,
// numbers and simple punctuation; no invisible or bidirectional controls, no web addresses or
// bare domains, no runs of 7 or more digits, no word mixing Latin, Cyrillic and Greek letters,
// and no "Fin" in look-alike letters. In a role name, a Latin modifier letter drawn as punctuation
// is that punctuation, so only one drawn as simple punctuation is allowed. Every refusal answers
// the field's one sentence from the inventory; the reason code is for tests and logs only, never
// shown.

export type NameKind = "personName" | "organisationName" | "roleName" | "roleDescription";

export interface NameRule {
  readonly maxChars: number;
  readonly maxWords: number | null;
  readonly sentence: string;
  /** Whether an empty value is allowed (a person may have no name yet, §5.1). */
  readonly allowEmpty: boolean;
}

export const NAME_RULES: Readonly<Record<NameKind, NameRule>> = {
  personName: {
    maxChars: 60,
    maxWords: 8,
    allowEmpty: false,
    sentence:
      "Use letters, numbers and simple punctuation, up to 60 characters and 8 words. No web addresses or phone numbers.",
  },
  organisationName: {
    maxChars: 50,
    maxWords: 7,
    allowEmpty: false,
    sentence:
      "Use letters, numbers and simple punctuation, up to 50 characters and 7 words. No web addresses or phone numbers.",
  },
  roleName: {
    maxChars: 40,
    maxWords: 5,
    allowEmpty: false,
    sentence:
      "Use letters, numbers and simple punctuation, up to 40 characters and 5 words. No web addresses or phone numbers.",
  },
  roleDescription: {
    maxChars: 120,
    maxWords: null,
    allowEmpty: true,
    sentence:
      "Use letters, numbers and simple punctuation, up to 120 characters. No web addresses or phone numbers.",
  },
};

export type NameRefusal =
  | "empty"
  | "too_long"
  | "too_many_words"
  | "characters"
  | "invisible"
  | "web_address"
  | "digits"
  | "mixed_scripts"
  | "fin_lookalike";

export type NameResult =
  | { ok: true; value: string }
  | { ok: false; reason: NameRefusal; sentence: string };

// Invisible and bidirectional controls, zero-width characters, the BOM, and other format
// characters (Unicode category Cf), plus every control character.
const INVISIBLE = new RegExp(
  `[\\p{Cc}\\p{Cf}${[0x2028, 0x2029, 0x115f, 0x1160, 0x3164, 0xffa0].map((c) => String.fromCodePoint(c)).join("")}]`,
  "u",
);
// Letters (any script), combining marks, digits, spaces and simple punctuation.
const ALLOWED = /^[\p{L}\p{M}\p{Nd} .,'’\-&()/:!?#+@]*$/u;
const WEB = /(?:https?:\/\/|www\.)|\b[\p{L}\p{Nd}-]+\.(?:[a-z]{2,24})\b/iu;
const DIGIT_RUN = /\p{Nd}{7,}/u;

const LATIN = /\p{Script=Latin}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const GREEK = /\p{Script=Greek}/u;

// In a role name, a Latin modifier letter drawn as punctuation is the punctuation it is drawn as
// (spec 02 §8.4: never a name that reads as a built-in's), so it is allowed only where that is
// simple punctuation: "Hawaiʻi" keeps its turned comma, drawn as an apostrophe, while "Adminᶺ",
// whose raised turned v is drawn as "^", is refused as "Admin^" is.
//
// Which ones, by Unicode's data alone. A Latin modifier letter is one of general category Lm whose
// script is Latin, or Common (the one every script shares) with no script extensions or Latin
// among them; the modifier letters of other scripts' words (kana's long-vowel mark, Arabic's
// tatweel, Lisu's tones) are not. One is drawn as punctuation when compatibility folding leaves it
// no other letter (no decomposition, or one to Common modifier letters only: the marks named
// MODIFIER LETTER PRIME, APOSTROPHE, REVERSED GLOTTAL STOP, CIRCUMFLEX ACCENT, TRIANGULAR COLON,
// RAISED EXCLAMATION MARK, VERTICAL TILDE and the like), or when Unicode's confusables data
// (confusables.txt 18.0.0) draws it as punctuation, symbols or Common modifier letters though
// folding makes it a letter (the last three rows below, as @fin/access's reading of a name has
// them). Every other one is the letter folding makes of it, raised or lowered, as its name says
// ("ʰ", MODIFIER LETTER SMALL H; "ᴬ", MODIFIER LETTER CAPITAL A), and stays a letter here. What
// each is drawn as is the punctuation confusables.txt 18.0.0 draws it as (the rows), or itself.
const DRAWN_AS: ReadonlyMap<string, string> = new Map([
  ["\u{2b9}", "'"], // MODIFIER LETTER PRIME
  ["\u{2ba}", "''"], // MODIFIER LETTER DOUBLE PRIME
  ["\u{2bb}", "'"], // MODIFIER LETTER TURNED COMMA
  ["\u{2bc}", "'"], // MODIFIER LETTER APOSTROPHE
  ["\u{2bd}", "'"], // MODIFIER LETTER REVERSED COMMA
  ["\u{2be}", "'"], // MODIFIER LETTER RIGHT HALF RING
  ["\u{2c6}", "^"], // MODIFIER LETTER CIRCUMFLEX ACCENT
  ["\u{2c8}", "'"], // MODIFIER LETTER VERTICAL LINE
  ["\u{2ca}", "'"], // MODIFIER LETTER ACUTE ACCENT
  ["\u{2cb}", "'"], // MODIFIER LETTER GRAVE ACCENT
  ["\u{2d0}", ":"], // MODIFIER LETTER TRIANGULAR COLON
  ["\u{2d1}", "\u{b7}"], // MODIFIER LETTER HALF TRIANGULAR COLON, drawn as a middle dot
  ["\u{2ee}", "''"], // MODIFIER LETTER DOUBLE APOSTROPHE
  ["\u{2e4}", "\u{2c1}"], // MODIFIER LETTER SMALL REVERSED GLOTTAL STOP, drawn as U+02C1
  ["\u{1d52}", "\u{b0}"], // MODIFIER LETTER SMALL O, drawn as the degree sign
  ["\u{1dba}", "^"], // MODIFIER LETTER SMALL TURNED V
]);
const MODIFIER_LETTER = /^\p{Lm}$/u;
const LATIN_OR_SHARED = /^[\p{Script_Extensions=Latin}\p{Script_Extensions=Common}]$/u;
const SHARED = /^\p{Script=Common}$/u;
// The punctuation ALLOWED allows.
const SIMPLE_PUNCTUATION = /^[.,'’\-&()/:!?#+@]+$/u;

/** What a Latin modifier letter drawn as punctuation is drawn as; null for any other character. */
function punctuationOf(char: string): string | null {
  if (!MODIFIER_LETTER.test(char) || !LATIN_OR_SHARED.test(char)) return null;
  const drawn = DRAWN_AS.get(char);
  if (drawn !== undefined) return drawn;
  const folding = [...char.normalize("NFKD")];
  if (!folding.every((c) => MODIFIER_LETTER.test(c) && SHARED.test(c))) return null;
  return folding.map((c) => DRAWN_AS.get(c) ?? c).join("");
}

/** Whether a name holds a Latin modifier letter drawn as anything but simple punctuation. */
function holdsOtherPunctuation(value: string): boolean {
  return [...value].some((char) => {
    const drawn = punctuationOf(char);
    return drawn !== null && !SIMPLE_PUNCTUATION.test(drawn);
  });
}

// Look-alikes of F, I and N from Cyrillic, Greek and other blocks, and fullwidth forms.
const FIN_SKELETON: Readonly<Record<string, string>> = {
  ғ: "f",
  ϝ: "f",
  ꜰ: "f",
  ｆ: "f",
  Ｆ: "f",
  і: "i",
  ї: "i",
  ı: "i",
  ι: "i",
  Ι: "i",
  І: "i",
  ӏ: "i",
  Ӏ: "i",
  ｉ: "i",
  Ｉ: "i",
  "1": "i",
  l: "i",
  "|": "i",
  п: "n",
  ո: "n",
  ν: "n",
  Ν: "n",
  ｎ: "n",
  Ｎ: "n",
  ɴ: "n",
};

function skeleton(word: string): string {
  const bare = word.normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC").toLowerCase();
  return [...bare].map((c) => FIN_SKELETON[c] ?? c).join("");
}

function isFinLookalike(word: string): boolean {
  if (word.normalize("NFKC").toLowerCase() === "fin") return false; // the real word is fine
  return skeleton(word) === "fin";
}

function mixesScripts(word: string): boolean {
  const scripts = [LATIN, CYRILLIC, GREEK].filter((script) => script.test(word)).length;
  return scripts > 1;
}

/** Checks a typed name. The value is trimmed, inner spaces collapsed and NFC-normalised. */
export function checkName(kind: NameKind, input: string): NameResult {
  const rule = NAME_RULES[kind];
  const refuse = (reason: NameRefusal): NameResult => ({
    ok: false,
    reason,
    sentence: rule.sentence,
  });
  if (INVISIBLE.test(input)) return refuse("invisible");
  const value = input.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (value === "") return rule.allowEmpty ? { ok: true, value } : refuse("empty");
  if ([...value].length > rule.maxChars) return refuse("too_long");
  const words = value.split(" ");
  if (rule.maxWords !== null && words.length > rule.maxWords) return refuse("too_many_words");
  if (!ALLOWED.test(value)) return refuse("characters");
  if (kind === "roleName" && holdsOtherPunctuation(value)) return refuse("characters");
  if (WEB.test(value) || value.includes("@")) return refuse("web_address");
  if (DIGIT_RUN.test(value.replace(/[\s\-().+]/gu, ""))) return refuse("digits");
  for (const word of value.split(/[\s.,'’\-&()/:!?#+]+/u)) {
    if (word === "") continue;
    if (mixesScripts(word)) return refuse("mixed_scripts");
    if (isFinLookalike(word)) return refuse("fin_lookalike");
  }
  return { ok: true, value };
}
