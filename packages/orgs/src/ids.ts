// IDs for the rows this area writes (ARCHITECTURE §6.2): `<prefix>_<26 Crockford base32>`, made
// from the injected clock inside a request, never at module scope. The algorithm is @fin/core's.
// `aud` (audit events) and `jrn` (revocation-journal entries) are made by packages/identity and
// packages/audit too but are not yet in @fin/core's ID_PREFIXES; adding them is recorded for P0-D.
import { isId as coreIsId, newId as coreNewId, type IdPrefix } from "@fin/core";

/** The clock the identity realm runs on (its `now()` answers a Date). */
export interface DateClock {
  now(): Date;
}

export type OrgsIdPrefix = "org" | "mem" | "inv" | "rol" | "sti" | "eml" | "aud" | "jrn";

export function newId(prefix: OrgsIdPrefix, clock: DateClock): string {
  return coreNewId(prefix as IdPrefix, { now: () => clock.now().getTime() });
}

/** Whether `value` is an ID of `prefix`; a path ID of any other shape is answered as not found. */
export function isId(value: unknown, prefix: "org" | "mem" | "inv" | "rol"): value is string {
  return coreIsId(value, prefix);
}
