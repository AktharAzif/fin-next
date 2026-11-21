// Custom staff roles: making, changing and deleting them (spec 02 §10.7, §14.3, §8.4; stretch 3).
// The read routes (`GET /api/staff-roles`, `GET /api/staff-roles/:roleKey`) are must-have and sit
// in staff.ts. Each write needs `staffRoles.manage` (Admin-only) and an intent bound as the
// dashboard's role routes bind theirs (§7.6), and counts the person's role-edit allowance.
// Bodies are strict; the lengths here only bound the request, and the editor's own rules (the
// access engine's `validateRole` with the identity package's name rules) answer a name or a
// description that breaks them with its field and problem.
import { z } from "zod";
import { noParams } from "./schemas.ts";
import { definePolicies } from "./types.ts";

export const roleIdParams = z.strictObject({
  roleId: z.string().regex(/^srl_[0-9a-hjkmnp-tv-z]{26}$/),
});

const draft = {
  name: z.string().max(160),
  description: z.string().max(480).default(""),
  /** Permission keys; one the catalogue does not know is the giving rules' `beyond`. */
  permissions: z.array(z.string().min(1).max(64)).max(52),
};

export const createStaffRoleBody = z.strictObject(draft);
export const saveStaffRoleBody = z.strictObject({
  ...draft,
  version: z.number().int().min(1).max(2_147_483_647),
});
/** Where the role's holders move: a prebuilt key or a custom role's ID; none when nobody holds it. */
export const deleteStaffRoleBody = z.strictObject({ moveTo: z.string().min(1).max(40).optional() });

export const STAFF_ROLE_POLICIES = definePolicies([
  {
    id: "staff_roles.create",
    method: "POST",
    path: "/api/staff-roles",
    guard: "requireStaff",
    permission: "staffRoles.manage",
    scope: "staff",
    stepUp: "intent",
    action: "staffRole.create",
    bind: ["name", "description", "permissions"],
    assurance: "aal2_or_working",
    params: noParams,
    query: null,
    body: createStaffRoleBody,
    limits: ["step_up_intents", "staff_role_edit"],
    audit: ["staff.role_created"],
    secret: false,
  },
  {
    id: "staff_roles.update",
    method: "PUT",
    path: "/api/staff-roles/:roleId",
    guard: "requireStaff",
    permission: "staffRoles.manage",
    scope: "staff",
    stepUp: "intent",
    action: "staffRole.update",
    bind: ["name", "description", "permissions", "version"],
    assurance: "aal2_or_working",
    params: roleIdParams,
    query: null,
    body: saveStaffRoleBody,
    limits: ["step_up_intents", "staff_role_edit"],
    audit: ["staff.role_updated"],
    secret: false,
  },
  {
    id: "staff_roles.delete",
    method: "POST",
    path: "/api/staff-roles/:roleId/delete",
    guard: "requireStaff",
    permission: "staffRoles.manage",
    scope: "staff",
    stepUp: "intent",
    action: "staffRole.delete",
    bind: ["moveTo"],
    assurance: "aal2_or_working",
    params: roleIdParams,
    query: null,
    body: deleteStaffRoleBody,
    limits: ["step_up_intents", "staff_role_edit"],
    audit: ["staff.role_deleted", "staff.role_changed"],
    secret: false,
  },
] as const);
