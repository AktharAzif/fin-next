// The role editor's rules for a custom role (spec 02 §8.4), the same in both realms. The names
// floor here is structural (length, words, invisible characters); the full `roleName` and
// `roleDescription` rules live in packages/identity/src/names.ts (§8.6), which the server passes in
// as `options.names`, so the server always runs both. Comparing a name with the built-in roles'
// and with the realm's other custom roles is this file's alone.
import { drawnOrder } from "./drawn-order.ts";
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
  // Capitals whose lower-case forms read otherwise, made Latin capitals before lower-casing; and
  // Coptic Alfa, drawn as A as Greek Alpha is (Unicode's data does not list it).
  "ΗH ΜM ΝN ΥY ΖZ ⲀA",
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
// character. A capital Unicode does not draw as its small letter reads as no Latin letter
// (`UNLIKE_CAPITALS`): Greek Γ is not y, though γ is.
const CAPITALS = table(...UNICODE_LOOK_ALIKES.capitals, LOOK_ALIKE_ROWS[0] ?? "");
const LOOK_ALIKES = table(
  ...UNICODE_LOOK_ALIKES.named,
  ...UNICODE_LOOK_ALIKES.letters,
  ...LOOK_ALIKE_ROWS.slice(1),
);
const UNLIKE_CAPITALS: ReadonlySet<string> = new Set(UNICODE_LOOK_ALIKES.unlikeCapitals.join(""));
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
 * may stand for a letter or be passed over. A letter that is not an ASCII one once folded is
 * `free`: whatever it reads as, it may also stand for any one letter, as a letter of no reading
 * may, so a row that reads it only ever adds to what is refused. A character drawn as several
 * letters ("æ", "‖") is a glyph for each.
 */
export interface Glyph {
  readonly char: string;
  readonly reads: string | null;
  readonly optional: boolean;
  readonly free: boolean;
}

/**
 * The order a name is read in: as stored, or as drawn on a left-to-right or a right-to-left line
 * (src/engine/drawn-order.ts, by Unicode's bidirectional algorithm), where a run of right-to-left
 * letters, and an Arabic-Indic number beside one, is drawn reversed. A name is compared in each,
 * so neither the order it is kept in nor the line it is shown on hides a name.
 */
export type ReadingOrder = "stored" | "ltr" | "rtl";
const READING_ORDERS: readonly ReadingOrder[] = ["stored", "ltr", "rtl"];

/**
 * A text's characters folded as they are read: a character that compatibility folding would turn
 * into one drawn otherwise read first (`BEFORE_FOLDING`), then compatibility-folded (NFKD), then
 * put in the reading order.
 */
function folded(text: string, order: ReadingOrder): string {
  let out = "";
  for (const char of text) out += BEFORE_FOLDING.get(char) ?? char;
  const folding = out.normalize("NFKD");
  return order === "stored" ? folding : drawnOrder(folding, order);
}

/**
 * What one folded character's small letter is drawn as: the character lower-cased and each
 * look-alike letter made what it is drawn as (Latin letters, a sign, a dot).
 */
function smallDrawnAs(char: string): string {
  let out = "";
  for (const lower of char.toLowerCase()) out += LOOK_ALIKES.get(lower) ?? lower;
  return out;
}

/**
 * What one folded character is drawn as, for reading a name against the built-ins' names: a
 * look-alike capital's reading; a capital Unicode draws unlike its small letter as that small
 * letter, read as no Latin letter; or else what its small letter is drawn as (`smallDrawnAs`).
 */
function drawnAs(char: string): string {
  const capital = CAPITALS.get(char);
  if (capital !== undefined) return smallDrawnAs(capital);
  return UNLIKE_CAPITALS.has(char) ? char.toLowerCase() : smallDrawnAs(char);
}

const isFreeLetter = (char: string) => /^\p{L}$/u.test(char) && !/^[A-Za-z]$/.test(char);

/**
 * The glyphs of a text in a reading order (as drawn on a left-to-right line unless another is
 * named): invisible characters removed, folded (`folded`), look-alike capitals and letters made
 * what they are drawn as, lower-cased; digits and signs drawn as letters made optional glyphs;
 * white space, punctuation, symbols, marks (accents) and modifier letters (a raised apostrophe)
 * left out, and so is a letter drawn as one ("Adminꞏ" reads as "Admin·"). Exported for the
 * tests, not from the package.
 */
export function glyphsOf(text: string, order: ReadingOrder = "ltr"): Glyph[] {
  const glyphs: Glyph[] = [];
  for (const char of folded(withoutInvisible(text), order)) {
    const free = isFreeLetter(char);
    for (const drawn of drawnAs(char)) {
      const sign = SIGNS.get(drawn);
      if (/^[a-z]$/.test(drawn)) {
        glyphs.push({ char: drawn, reads: drawn, optional: false, free });
      } else if (sign !== undefined) {
        for (const reads of sign) glyphs.push({ char: drawn, reads, optional: true, free: false });
      } else if (/^\p{L}$/u.test(drawn) && !/^\p{Lm}$/u.test(drawn)) {
        glyphs.push({ char: drawn, reads: null, optional: false, free: true });
      } else if (/^\p{N}$/u.test(drawn)) {
        glyphs.push({ char: drawn, reads: null, optional: true, free: false });
      }
    }
  }
  return glyphs;
}

/**
 * What a name reads as, letter by letter, as drawn on a left-to-right line: invisible characters
 * removed, compatibility-folded, lower-cased, look-alike letters made Latin, and everything but
 * letters dropped (spaces, punctuation, digits and signs, accents, modifier letters, and letters
 * drawn as punctuation); a letter of no Latin reading stays as it is, and a final plural "s" is
 * dropped. "Super-Admins 2!" reads as "superadmin", and so does "ꓢuper ꓮdmin" in Lisu letters.
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
 * "cI", "c1" and "c|" are "cl"), and at most one letter in four by a letter of no Latin reading
 * or a free one (`Glyph.free`) read as another letter; digits and signs read as their letters or
 * are passed over; and one plural "s" may follow.
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
    if (glyph.free && guesses < budget && from(at + 1, done + 1, guesses + 1, plural)) return true;
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
 * and "d"; I and l read alike; a letter of no Latin reading, or one not an ASCII letter read as
 * another, may stand for one letter in four; and the name is read as stored and as drawn on either
 * kind of line, so right-to-left letters are read in the order they are seen. So "Super Admin",
 * "Admins", "Admin 2", "Аdmin" with a Cyrillic А, "ɑdmin" with a Latin alpha, "ꓮꓓꓟꓲꓠ" in Lisu
 * letters, "Adminꞏ", "Adrnin" and "AcImin" are all refused. Text longer than any name may be is
 * not read (the length rule refuses it).
 */
export function readsAsBuiltIn(cat: Catalogue, name: string): boolean {
  if (name.length > READ_LIMIT) return false;
  const readings = builtInReadings(cat);
  const read = new Set<string>();
  for (const order of READING_ORDERS) {
    const glyphs = glyphsOf(name, order);
    if (glyphs.length === 0 || glyphs.length > GLYPH_LIMIT) return false;
    const seen = JSON.stringify(glyphs);
    if (read.has(seen)) continue;
    read.add(seen);
    for (const reading of readings) if (spells(glyphs, reading)) return true;
  }
  return false;
}

/**
 * What each character of a name may be drawn as in a reading order, for comparing two names, case
 * ignored: invisible characters removed, normalised, folded (`folded`), and each character read as
 * its small letter is drawn (`smallDrawnAs`); a small letter whose capital has another small letter
 * (final ς, whose capital is Σ, as σ's is; ß, whose capitals are SS) also as that one is, as
 * Unicode's case folding reads it; and a capital drawn as a Latin capital its small letter is not
 * (Greek Η, drawn as H though η is drawn as n) also as that capital is. A capital Unicode draws
 * unlike its small letter (Greek Γ) reads as its small letter here, since the names are compared
 * ignoring case. The first reading of each character makes the name's key (`roleNameKey`).
 */
function readingsIn(name: string, order: ReadingOrder): (readonly string[])[] {
  const readings: (readonly string[])[] = [];
  for (const char of folded(normaliseRoleText(withoutInvisible(name)), order)) {
    const capital = CAPITALS.get(char);
    const forms = new Set([smallDrawnAs(char), smallDrawnAs(char.toUpperCase())]);
    if (capital !== undefined) forms.add(smallDrawnAs(capital));
    readings.push([...forms]);
  }
  return readings;
}

/**
 * Whether two names' characters, each read as one of its readings (`readingsIn`), can make the same
 * text. Each state is the characters of each name read and the text one has read past the other; a
 * state seen before was a dead end.
 */
function readAlike(a: readonly (readonly string[])[], b: readonly (readonly string[])[]): boolean {
  const seen = new Set<string>();
  const states: [number, number, string, string][] = [[0, 0, "", ""]];
  for (let state = states.pop(); state !== undefined; state = states.pop()) {
    const [i, j, readA, readB] = state;
    const common = Math.min(readA.length, readB.length);
    if (readA.slice(0, common) !== readB.slice(0, common)) continue;
    const aheadA = readA.slice(common);
    const aheadB = readB.slice(common);
    const key = `${i} ${j} ${aheadA === "" ? `b${aheadB}` : `a${aheadA}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (aheadA === "" && i < a.length) {
      for (const reading of a[i] ?? []) states.push([i + 1, j, reading, aheadB]);
    } else if (aheadB === "" && j < b.length) {
      for (const reading of b[j] ?? []) states.push([i, j + 1, aheadA, reading]);
    } else if (aheadA === "" && aheadB === "" && i === a.length && j === b.length) {
      return true;
    }
  }
  return false;
}

/**
 * A name's key, case ignored, as drawn on a left-to-right line: invisible characters removed,
 * normalised, folded (`folded`), lower-cased, and look-alike letters made what they are drawn as.
 * Digits, spaces, punctuation and accents are kept, so "Tier 1" and "Tier 2", or "Café" and
 * "Cafe", are different names, while "Support" with a Cyrillic о or a Lisu ꓢ is the same name as
 * "Support", "Supportꞏ" (a letter drawn as a middle dot) the same as "Support·", and "Группа" the
 * same as "группа". Two names with one key are the same name (spec 02 §8.4: unique per
 * organisation, ignoring case); `validateRole` also reads a capital drawn as a Latin capital its
 * small letter is not as that capital, so "Ηelp" with a Greek Eta is the same name as "ηelp" and as
 * "Help", and compares the names in every reading order.
 */
export function roleNameKey(name: string): string {
  return keyOf(readingsIn(name, "ltr"));
}

/** The key of a name's readings: the first reading of each character. */
const keyOf = (readings: readonly (readonly string[])[]) =>
  readings.map((reading) => reading[0] ?? "").join("");

/**
 * Whether two names are the same name (`name_taken`): alike in one reading order, each character
 * read as one of its readings (`readingsIn`). A name longer than any name may be is not compared
 * (the length rule refuses it), and a taken name that long is compared by its keys alone.
 */
function sameName(name: string, other: string): boolean {
  if (name.length > READ_LIMIT) return false;
  return READING_ORDERS.some((order) => {
    const a = readingsIn(name, order);
    const b = readingsIn(other, order);
    if (keyOf(a) === keyOf(b)) return true;
    return other.length <= READ_LIMIT && readAlike(a, b);
  });
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
 * - `name_taken`: another custom role in the realm has it, ignoring case in every script, invisible
 *   characters and look-alike letters (`roleNameKey`, `readingsIn`), stored alike or drawn alike on
 *   either kind of line;
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
  for (const taken of options.takenNames ?? []) {
    if (sameName(name, taken)) {
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
