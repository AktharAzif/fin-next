// The role editor's rules for a custom role (spec 02 §8.4), the same in both realms. The names
// floor here is structural (length, words, invisible characters); the full `roleName` and
// `roleDescription` rules live in packages/identity/src/names.ts (§8.6), which the server passes in
// as `options.names`, so the server always runs both. Comparing a name with the built-in roles'
// and with the realm's other custom roles is this file's alone.
import { isPermission, missingNeed } from "./permissions.ts";
import { hasInvisible, withoutInvisible } from "./text.ts";
import type { Catalogue, RoleProblem } from "./types.ts";
import { UNICODE_LOOK_ALIKES } from "./unicode-look-alikes.ts";

/** At most 30 custom roles per organisation, and 30 custom staff roles. */
export const CUSTOM_ROLE_LIMIT = 30;
/** Role edits per person: 30 an hour and 100 a day. */
export const ROLE_EDIT_LIMITS = Object.freeze({ perHour: 30, perDay: 100 });
export const ROLE_NAME_MAX_LENGTH = 40;
export const ROLE_NAME_MAX_WORDS = 5;
export const ROLE_DESCRIPTION_MAX_LENGTH = 120;

/**
 * Whether no other custom role may be made when `count` exist (`409 limit_reached`). A count that
 * is not a whole number of at least zero, NaN and a count left as text included, is refused.
 */
export function customRoleLimitReached(count: number): boolean {
  return !(Number.isSafeInteger(count) && count >= 0 && count < CUSTOM_ROLE_LIMIT);
}

/**
 * The form a role's name or description is checked and stored in: NFC, trimmed, and every run of
 * white space one space. `validateRole` refuses text that is not already in this form, so what is
 * checked is what is stored.
 */
export function normaliseRoleText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ");
}

const lengthOf = (text: string) => [...text].length;

function nameFloor(name: string): boolean {
  if (name !== normaliseRoleText(name) || hasInvisible(name)) return false;
  const length = lengthOf(name);
  return (
    length >= 1 && length <= ROLE_NAME_MAX_LENGTH && name.split(" ").length <= ROLE_NAME_MAX_WORDS
  );
}

function descriptionFloor(text: string): boolean {
  if (text !== normaliseRoleText(text) || hasInvisible(text)) return false;
  return lengthOf(text) <= ROLE_DESCRIPTION_MAX_LENGTH;
}

/**
 * Reads a table of entries: one character, then what it reads as (one character or more). An
 * entry later in the rows replaces an earlier one for the same character.
 */
const table = (...rows: readonly string[]): ReadonlyMap<string, string> =>
  new Map(
    rows
      .join(" ")
      .split(" ")
      .map((entry) => {
        const [char = "", ...reads] = [...entry];
        return [char, reads.join("")];
      }),
  );

// The hand-made look-alike rows, each entry one character and its reading. They take precedence
// over the rows derived from Unicode's confusables data (src/engine/unicode-look-alikes.ts), which
// cover every other script. Exported apart from the declaration (below), for the tests.
const LOOK_ALIKE_ROWS: readonly string[] = [
  // Capitals whose lower-case forms read otherwise, made Latin capitals before lower-casing.
  "ΗH ΜM ΝN ΥY ΖZ",
  // Letters, after lower-casing, and the Latin letter each is drawn as. Cyrillic:
  "аa вb еe кk мm нh оo рp сc тt уy хx іi јj ѕs ԁd ԛq ԝw үy һh ӏl ѵv",
  // Greek:
  "αa βb εe ηn ιi κk νv οo ρp τt υu χx ωw ϳj",
  // Latin small capitals:
  "ᴀa ʙb ᴄc ᴅd ᴇe ɢg ʜh ɪi ᴊj ᴋk ʟl ᴍm ɴn ᴏo ᴘp ʀr ꜱs ᴛt ᴜu ᴠv ᴡw ʏy ᴢz",
  // Latin letters drawn as others: alpha, script g, dotless i and j, and letters with a stroke or
  // a hook, which compatibility folding leaves as they are (v with a hook is drawn as u):
  "ɑa ɡg ıi ȷj ɩi ɛe łl ƚl ɫl ɭl đd ðd ɖd ɗd øo ɵo ŧt ƭt ʈt ƀb ɓb ɨi ʉu ɇe ƶz ȥz ǥg ɠg ɍr ɽr ɾr",
  "ȼc ƈc ɉj ħh ɦh ɱm ɲn ɳn ƞn ʂs ʋu ƙk ƥp ƴy",
  // Cherokee, whose capitals lower-case to these small forms:
  "ꭺa ᏼb ꮯc ꭰd ꭼe ꮐg ꮋh ꭵi ꭻj ꮶk ꮮl ꮇm ꮲp ꭱr ꮪs ꭲt ꮩv ꮃw ꮓz",
  // Armenian:
  "ոn սu օo լl ցg հh զq",
  // Coptic alfa, drawn as A as Greek alpha is (Unicode's data does not list it):
  "ⲁa",
  // Letters drawn as punctuation: four clicks (one as a double bar, one as a double dagger) and
  // the saltillo.
  "ǀ| ǃ! ꞌ' ǁ‖ ǂ‡",
];

export { LOOK_ALIKE_ROWS };

// Each table holds Unicode's rows, then the hand-made ones, which replace them where both list a
// character.
const CAPITALS = table(...UNICODE_LOOK_ALIKES.capitals, LOOK_ALIKE_ROWS[0] ?? "");
const LOOK_ALIKES = table(...UNICODE_LOOK_ALIKES.letters, ...LOOK_ALIKE_ROWS.slice(1));
const BEFORE_FOLDING = table(...UNICODE_LOOK_ALIKES.beforeFolding);

// Digits and signs that may stand for a letter in a name, or be just what they are: "Adm1n",
// "0perator", "@dmin", "Adm!n"; and the digits, punctuation and symbols of other scripts drawn as
// Latin letters ("⍺dmin", "Admi∩").
const SIGNS = table(
  ...UNICODE_LOOK_ALIKES.signs,
  "0o 1l 2z 3e 4a 5s 6b 7t 8b 9g @a !l |l ¡i $s €e +t",
);

// Two letters drawn as one: "rn" as m, "vv" as w, "cl" as d.
const DRAWN_AS_ONE: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["m", ["r", "n"]],
  ["w", ["v", "v"]],
  ["d", ["c", "l"]],
]);

/**
 * One character of a name as it reads: a Latin letter (`reads`), a letter of no Latin reading
 * (`reads` null, which may stand for any one letter), and `optional` for a digit or sign, which
 * may stand for a letter or be passed over. A character drawn as several letters ("æ", "‖") is
 * a glyph for each.
 */
export interface Glyph {
  readonly char: string;
  readonly reads: string | null;
  readonly optional: boolean;
}

/**
 * A text's characters folded as they are read: a letter that compatibility folding would turn
 * into one drawn otherwise read first (`BEFORE_FOLDING`), then compatibility-folded (NFKD).
 */
function folded(text: string): string {
  let out = "";
  for (const char of text) out += BEFORE_FOLDING.get(char) ?? char;
  return out.normalize("NFKD");
}

/**
 * What one folded character is drawn as: a look-alike capital's reading, or else the character
 * lower-cased and each look-alike letter made what it is drawn as (Latin letters, a sign, a dot).
 */
function drawnAs(char: string): string {
  let out = "";
  for (const lower of (CAPITALS.get(char) ?? char).toLowerCase()) {
    out += LOOK_ALIKES.get(lower) ?? lower;
  }
  return out;
}

/**
 * The glyphs of a text: invisible characters removed, folded (`folded`), look-alike capitals and
 * letters made what they are drawn as, lower-cased; digits and signs drawn as letters made
 * optional glyphs; white space, punctuation, symbols, marks (accents) and modifier letters (a
 * raised apostrophe) left out, and so is a letter drawn as one ("Adminꞏ" reads as "Admin·").
 * Exported for the tests, not from the package.
 */
export function glyphsOf(text: string): Glyph[] {
  const glyphs: Glyph[] = [];
  for (const char of folded(withoutInvisible(text))) {
    for (const drawn of drawnAs(char)) {
      const sign = SIGNS.get(drawn);
      if (/^[a-z]$/.test(drawn)) {
        glyphs.push({ char: drawn, reads: drawn, optional: false });
      } else if (sign !== undefined) {
        for (const reads of sign) glyphs.push({ char: drawn, reads, optional: true });
      } else if (/^\p{L}$/u.test(drawn) && !/^\p{Lm}$/u.test(drawn)) {
        glyphs.push({ char: drawn, reads: null, optional: false });
      } else if (/^\p{N}$/u.test(drawn)) {
        glyphs.push({ char: drawn, reads: null, optional: true });
      }
    }
  }
  return glyphs;
}

/**
 * What a name reads as, letter by letter: invisible characters removed, compatibility-folded,
 * lower-cased, look-alike letters made Latin, and everything but letters dropped (spaces,
 * punctuation, digits and signs, accents, modifier letters, and letters drawn as punctuation); a
 * letter of no Latin reading stays as it is, and a final plural "s" is dropped. "Super-Admins 2!"
 * reads as "superadmin", and so does "ꓢuper ꓮdmin" in Lisu letters.
 */
export function readingOf(text: string): string {
  let out = "";
  for (const glyph of glyphsOf(text)) if (!glyph.optional) out += glyph.reads ?? glyph.char;
  return out.endsWith("s") ? out.slice(0, -1) : out;
}

// A name is at most 40 characters; text much longer is never a name, and is not read.
const READ_LIMIT = 8 * ROLE_NAME_MAX_LENGTH;
const GLYPH_LIMIT = 8 * ROLE_NAME_MAX_LENGTH;

/** I and l are drawn alike, so they are one letter here. */
const same = (a: string, b: string) => (a === "l" ? "i" : a) === (b === "l" ? "i" : b);

/**
 * Whether the glyphs spell `target` (Latin letters): each letter by a glyph that reads as it (I
 * and l alike), "m", "w" and "d" also by two glyphs drawn as one (each read as a letter is, so
 * "cI", "c1" and "c|" are "cl"), and at most one letter in four by a letter of no Latin reading;
 * digits and signs read as their letters or are passed over; and one plural "s" may follow.
 */
function spells(glyphs: readonly Glyph[], target: string): boolean {
  const letters = target.length;
  const budget = Math.floor(letters / 4);
  const seen = new Uint8Array((glyphs.length + 1) * (letters + 1) * (budget + 1) * 2);
  // `at` glyphs read, `done` letters spelt, `guesses` letters spelt by an unread letter, and
  // `plural` whether the plural "s" is read. A state seen before was a dead end.
  const from = (at: number, done: number, guesses: number, plural: number): boolean => {
    const state = ((at * (letters + 1) + done) * (budget + 1) + guesses) * 2 + plural;
    if (seen[state] === 1) return false;
    seen[state] = 1;
    const glyph = glyphs[at];
    if (glyph === undefined) return done === letters;
    if (glyph.optional && from(at + 1, done, guesses, plural)) return true;
    const want = target[done];
    if (want === undefined)
      return plural === 0 && glyph.reads === "s" && from(at + 1, done, guesses, 1);
    if (glyph.reads === null)
      return guesses < budget && from(at + 1, done + 1, guesses + 1, plural);
    if (same(glyph.reads, want) && from(at + 1, done + 1, guesses, plural)) return true;
    const pair = DRAWN_AS_ONE.get(want);
    const next = glyphs[at + 1];
    return (
      pair !== undefined &&
      next !== undefined &&
      next.reads !== null &&
      same(glyph.reads, pair[0]) &&
      same(next.reads, pair[1]) &&
      from(at + 2, done + 1, guesses, plural)
    );
  };
  return from(0, 0, 0, 0);
}

/** The Latin readings of the realm's built-in role names and keys, "admin" also as "administrator". */
function builtInReadings(cat: Catalogue): Set<string> {
  const readings = new Set<string>();
  for (const role of cat.builtIns) {
    for (const form of [role.label, role.key]) {
      const reading = readingOf(form).replace(/[^a-z]/g, "");
      if (reading === "") continue;
      readings.add(reading);
      if (reading.includes("admin")) readings.add(reading.replace("admin", "administrator"));
    }
  }
  return readings;
}

/**
 * Whether a name is, or reads as, one of the realm's built-in role names or keys (spec 02 §8.4:
 * "never a built-in's name or one that reads as one"). Case, accents, spaces, punctuation,
 * invisible characters and a plural "s" are ignored; look-alike letters of every script Unicode's
 * confusables data lists, and of Latin, read as the Latin letters they are drawn as, and a letter
 * drawn as punctuation as that punctuation; digits, signs and symbols may read as the letters they
 * are drawn as ("Adm1n", "0perator", "@dmin", "⍺dmin"); "rn", "vv" and "cl" may read as "m", "w"
 * and "d"; I and l read alike; and a letter of no Latin reading may stand for one letter in four.
 * So "Super Admin", "Admins", "Admin 2", "Аdmin" with a Cyrillic А, "ɑdmin" with a Latin alpha,
 * "ꓮꓓꓟꓲꓠ" in Lisu letters, "Adminꞏ", "Adrnin" and "AcImin" are all refused. Text longer than
 * any name may be is not read (the length rule refuses it).
 */
export function readsAsBuiltIn(cat: Catalogue, name: string): boolean {
  if (name.length > READ_LIMIT) return false;
  const glyphs = glyphsOf(name);
  if (glyphs.length === 0 || glyphs.length > GLYPH_LIMIT) return false;
  for (const reading of builtInReadings(cat)) if (spells(glyphs, reading)) return true;
  return false;
}

/**
 * The form two custom roles' names may not share (spec 02 §8.4: unique per organisation, ignoring
 * case): invisible characters removed, normalised, folded (`folded`), lower-cased, and look-alike
 * letters made what they are drawn as. Digits, spaces, punctuation and accents are kept, so
 * "Tier 1" and "Tier 2", or "Café" and "Cafe", are different names, while "Support" with a
 * Cyrillic о or a Lisu ꓢ is the same name as "Support", and "Supportꞏ" (a letter drawn as a
 * middle dot) the same as "Support·".
 */
export function roleNameKey(name: string): string {
  let key = "";
  for (const char of folded(normaliseRoleText(withoutInvisible(name)))) key += drawnAs(char);
  return key;
}

export interface RoleDraft<P extends string> {
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly P[];
}

export interface RoleCheckOptions {
  /**
   * The names of the realm's other custom roles (not the one being edited), read inside the lock,
   * for uniqueness.
   */
  readonly takenNames?: Iterable<string>;
  /** The full name rules of packages/identity/src/names.ts; the server always passes them. */
  readonly names?: {
    readonly roleName: (name: string) => boolean;
    readonly roleDescription: (description: string) => boolean;
  };
}

/**
 * Every rule a custom role's draft breaks, in a fixed order (empty when it may be saved):
 * - `name`: not 1 to 40 characters and at most 5 words, not normalised, a character that draws as
 *   nothing (src/engine/text.ts), or refused by `names.roleName`;
 * - `name_taken`: another custom role in the realm has it, ignoring case, invisible characters and
 *   look-alike letters (`roleNameKey`);
 * - `reads_as_built_in`: a built-in's name, or one that reads as one (`readsAsBuiltIn`: "Super
 *   Admin", "Admins", "Adm1n");
 * - `description`: over 120 characters, not normalised, a character that draws as nothing, or
 *   refused by `names.roleDescription` (an empty description is allowed);
 * - `empty`: no permission;
 * - `restricted`: one no custom role may hold;
 * - `beyond`: one the editor's role does not allow, or one the catalogue does not know;
 * - `missing_need`: a permission without everything it needs.
 */
export function validateRole<P extends string>(
  cat: Catalogue<P>,
  draft: RoleDraft<NoInfer<P>>,
  actorPerms: ReadonlySet<NoInfer<P>>,
  options: RoleCheckOptions = {},
): RoleProblem[] {
  const problems: RoleProblem[] = [];
  const { name, description } = draft;
  if (!nameFloor(name) || options.names?.roleName(name) === false) problems.push("name");
  const key = roleNameKey(name);
  for (const taken of options.takenNames ?? []) {
    if (roleNameKey(taken) === key) {
      problems.push("name_taken");
      break;
    }
  }
  if (readsAsBuiltIn(cat, name)) problems.push("reads_as_built_in");
  if (
    !descriptionFloor(description) ||
    (description !== "" && options.names?.roleDescription(description) === false)
  ) {
    problems.push("description");
  }
  const perms = new Set<string>(draft.permissions);
  if (perms.size === 0) problems.push("empty");
  const known = [...perms].filter((key): key is P => isPermission(cat, key));
  if (known.some((key) => cat.permissions[key].restricted)) problems.push("restricted");
  if ([...perms].some((key) => !isPermission(cat, key) || !actorPerms.has(key))) {
    problems.push("beyond");
  }
  if (missingNeed(cat, known).length > 0) problems.push("missing_need");
  return problems;
}
