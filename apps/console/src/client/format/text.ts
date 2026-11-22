// Sentences more than one board uses: the name rules' refusals (spec 02 §8.6, the inventory's
// wording) and the role lists' counts.
import { dashboardCatalogue } from "@fin/access";

export const NAME_RULE =
  "Use letters, numbers and simple punctuation, up to 60 characters and 8 words. No web addresses or phone numbers.";

export const ORGANISATION_NAME_RULE =
  "Use letters, numbers and simple punctuation, up to 50 characters and 7 words. No web addresses or phone numbers.";

/** "No one yet", "1 person", "3 people". */
export function holdersText(count: number): string {
  if (count === 0) return "No one yet";
  return count === 1 ? "1 person" : `${count} people`;
}

/** "All 26 permissions", "15 of 26 permissions". */
export function permissionsText(count: number, total = dashboardCatalogue.keys.length): string {
  return count >= total ? `All ${total} permissions` : `${count} of ${total} permissions`;
}

/** "an Admin", "a Developer". */
export function withArticle(label: string): string {
  return /^[aeiou]/i.test(label) ? `an ${label}` : `a ${label}`;
}

/** The role editor's address for a role. */
export function roleHref(roleKey: string): string {
  return `/settings/roles/${encodeURIComponent(roleKey)}`;
}
