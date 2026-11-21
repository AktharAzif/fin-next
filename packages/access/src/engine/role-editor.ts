// The role editor's rules for a custom role (spec 02 §8.4), the same in both realms. The names
// floor here is structural (length, words, invisible characters); the full `roleName` and
// `roleDescription` rules live in packages/identity/src/names.ts (§8.6), which the server passes in
// as `options.names`, so the server always runs both.
import { isPermission, missingNeed } from "./permissions.ts";
import type { Catalogue, RoleProblem } from "./types.ts";

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

// Control, format (invisible and bidirectional), surrogate, private-use and unassigned characters.
const INVISIBLE = /\p{C}/u;

const lengthOf = (text: string) => [...text].length;

function nameFloor(name: string): boolean {
  if (name !== normaliseRoleText(name) || INVISIBLE.test(name)) return false;
  const length = lengthOf(name);
  return (
    length >= 1 && length <= ROLE_NAME_MAX_LENGTH && name.split(" ").length <= ROLE_NAME_MAX_WORDS
  );
}

function descriptionFloor(text: string): boolean {
  if (text !== normaliseRoleText(text) || INVISIBLE.test(text)) return false;
  return lengthOf(text) <= ROLE_DESCRIPTION_MAX_LENGTH;
}

// Letters that read as Latin ones (Cyrillic, Greek and Latin small capitals, after lower-casing),
// and the Latin letter each reads as, pair by pair.
const LOOK_ALIKE = "авеёкмнорстухіїјѕԁԛԝүɡ" + "αβεηικνορτυχω" + "ı" + "ᴀʙᴄᴅᴇɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ";
const READS_AS = [
  ...("abeekmhopctyxiijsdqwyg" + "abenikvoptuxw" + "i" + "abcdeghijklmnoprstuvwyz"),
];
const LOOK_ALIKES: ReadonlyMap<string, string> = new Map(
  Array.from(LOOK_ALIKE, (char, index) => [char, READS_AS[index] ?? char]),
);

/**
 * What a name reads as: compatibility-folded, lower-cased, look-alike letters made Latin, accents
 * and everything but letters dropped (spaces, punctuation and digits), and a final plural "s"
 * dropped. "Super Admin", "super-admins", "SUPERADMIN" and "Аdmin 2" read as built-in names.
 */
export function readingOf(text: string): string {
  let out = "";
  for (const char of text.normalize("NFKD").toLowerCase()) {
    const letter = LOOK_ALIKES.get(char) ?? char;
    if (/^\p{L}$/u.test(letter)) out += letter;
  }
  return out.endsWith("s") ? out.slice(0, -1) : out;
}

/** Whether a name is, or reads as, one of the realm's built-in role names or keys. */
export function readsAsBuiltIn(cat: Catalogue, name: string): boolean {
  const reading = readingOf(name);
  if (reading === "") return false;
  for (const role of cat.builtIns) {
    for (const form of [role.label, role.key]) {
      const builtIn = readingOf(form);
      if (reading === builtIn) return true;
      if (builtIn.includes("admin") && reading === builtIn.replace("admin", "administrator")) {
        return true;
      }
    }
  }
  return false;
}

export interface RoleDraft<P extends string> {
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly P[];
}

export interface RoleCheckOptions {
  /** The names of the realm's other custom roles (not the one being edited), for uniqueness. */
  readonly takenNames?: Iterable<string>;
  /** The full name rules of packages/identity/src/names.ts; the server always passes them. */
  readonly names?: {
    readonly roleName: (name: string) => boolean;
    readonly roleDescription: (description: string) => boolean;
  };
}

/**
 * Every rule a custom role's draft breaks, in a fixed order (empty when it may be saved):
 * - `name`: not 1 to 40 characters and at most 5 words, not normalised, an invisible character,
 *   or refused by `names.roleName`;
 * - `name_taken`: another custom role in the realm has it, ignoring case;
 * - `reads_as_built_in`: a built-in's name, or one that reads as one ("Super Admin", "Admins");
 * - `description`: over 120 characters, not normalised, an invisible character, or refused by
 *   `names.roleDescription` (an empty description is allowed);
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
  const lower = name.toLowerCase();
  for (const taken of options.takenNames ?? []) {
    if (normaliseRoleText(taken).toLowerCase() === lower) {
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
