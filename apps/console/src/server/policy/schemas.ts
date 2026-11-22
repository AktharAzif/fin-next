// The schemas the console's route policy shares (spec 02 §14.1). Bodies and queries are strict: an
// unknown field is refused (`400 invalid`, with the field's path and a code, never its value). Typed
// names are bounded here and checked against the name rules (spec 02 §8.6) by the action, which
// answers the rule's reason.
import * as z from "zod";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((v) => EMAIL.test(v), { message: "email" });

export const typedName = z.string().max(200);

export const roleKey = z.string().regex(/^([a-z][a-z_]{0,31}|rol_[0-9a-hjkmnp-tv-z]{26})$/);

export const orgId = z.string().regex(/^org_[0-9a-hjkmnp-tv-z]{26}$/);

export const permissionKeys = z.array(z.string().regex(/^[a-z][a-zA-Z]*\.[a-z][a-z_]*$/)).max(64);

/** Paging on app lists (§14.1): `page` from 1, `size` 25 by default and at most 100. */
export const paging = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  size: z.coerce.number().int().min(1).max(100).default(25),
};

export const pageQuery = z.strictObject(paging);

export const empty = z.strictObject({});

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
