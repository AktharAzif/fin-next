// The schemas the route policy names. Bodies are strict objects (an unknown field is refused);
// refusals name the field and the problem, never the value (§14.1).
import { REASON_CODE, SWITCH_NAME } from "@fin/staff";
import { z } from "zod";

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`));

export const noParams = z.strictObject({});
export const noBody = z.strictObject({});

export const staffIdParams = z.strictObject({ staffId: id("stf") });
export const sessionIdParams = z.strictObject({ sessionId: id("sts") });
export const roleKeyParams = z.strictObject({
  roleKey: z.string().regex(/^(viewer|compliance|operator|admin|srl_[0-9a-hjkmnp-tv-z]{26})$/),
});
export const switchNameParams = z.strictObject({
  switchName: z.string().max(96).regex(SWITCH_NAME),
});

/** A role key as a body carries it; an unknown one is the giving rules' `unknown_role`. */
export const roleKey = z.string().min(1).max(40);

/** An address: at most 254 characters, lower-cased by the route (§10.2). */
export const address = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);

export const paging = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  size: z.coerce.number().int().min(1).max(100).default(25),
});

export const addStaffBody = z.strictObject({ email: address, roleKey });
export const changeRoleBody = z.strictObject({ roleKey });
export const redeemBody = z.strictObject({ code: z.string().min(16).max(24) });
export const switchBody = z.strictObject({
  state: z.enum(["on", "off"]),
  reasonCode: z.string().regex(REASON_CODE),
});
