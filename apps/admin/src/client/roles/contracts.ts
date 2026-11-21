// Fin Admin's staff roles routes as AdminRoles and AdminRoleEditor read them (spec 02 §10.7, §14.3,
// §8.4): the prebuilt and custom roles with their holders and permissions, one role with every
// group of the catalogue, and making, saving and deleting a custom role, each with an intent that
// api() asks the root "Confirm it's you" for. A custom role's key is its `srl_` ID. These read
// exactly what @fin/staff's `listStaffRoles` and `getStaffRole` answer (apps/admin's
// staff-roles.db.test.ts pins the fields), and move to packages/app-contracts/src/staff/ with the
// staff lane's contracts (spec 06 §11.3).
import { defineContract, noInput, z } from "@fin/app-contracts";

export const staffRoleRow = z.object({
  key: z.string().min(1),
  kind: z.enum(["prebuilt", "custom"]),
  /** A prebuilt role: an immutable row in code that no editor changes. */
  builtIn: z.boolean(),
  label: z.string(),
  /** A custom role's own description; '' for none and for a prebuilt role. */
  description: z.string(),
  /** One sentence: a prebuilt role's own, a custom role's description or the generated one. */
  summary: z.string(),
  topRole: z.boolean(),
  holders: z.number().int().nonnegative(),
  permissions: z.array(z.string()),
  permissionCount: z.number().int().nonnegative(),
  /** The version a save names (a stale one is `409 conflict`); null for a prebuilt role. */
  version: z.number().int().positive().nullable(),
});
export type StaffRoleRow = z.output<typeof staffRoleRow>;

/** `GET /api/staff-roles` (`staff.read`): the prebuilt roles, then the custom ones by name. */
export const staffRolesIndex = defineContract({
  name: "staffRoles.index",
  method: "GET",
  path: "/staff-roles",
  input: noInput,
  output: z.object({ roles: z.array(staffRoleRow) }),
});

/** `GET /api/staff-roles/:roleKey` (`staff.read`): one role (a prebuilt key or an `srl_` ID). */
export const staffRoleDetail = defineContract({
  name: "staffRoles.get",
  method: "GET",
  path: "/staff-roles/:roleKey",
  input: z.object({ roleKey: z.string().min(1).max(40) }),
  output: staffRoleRow,
});

const draft = {
  name: z.string().max(160),
  description: z.string().max(480),
  permissions: z.array(z.string().min(1)).max(52),
};

/** `POST /api/staff-roles` (`staffRoles.manage`, intent `staffRole.create`). */
export const createStaffRole = defineContract({
  name: "staffRoles.create",
  method: "POST",
  path: "/staff-roles",
  creates: true,
  input: z.object(draft),
  output: z.object({ roleId: z.string().min(1), version: z.number().int().positive() }),
});

/**
 * `PUT /api/staff-roles/:roleId` (`staffRoles.manage`, intent `staffRole.update`): saves a custom
 * role at the version the draft was built on; the answer is the version the save made.
 */
export const saveStaffRole = defineContract({
  name: "staffRoles.save",
  method: "PUT",
  path: "/staff-roles/:roleId",
  input: z.object({ roleId: z.string().min(1), ...draft, version: z.number().int().positive() }),
  output: z.object({ roleId: z.string().min(1), version: z.number().int().positive() }),
});

/**
 * `POST /api/staff-roles/:roleId/delete` (`staffRoles.manage`, intent `staffRole.delete`): every
 * holder moves to `moveTo`, which needs `staff.role` too.
 */
export const deleteStaffRole = defineContract({
  name: "staffRoles.delete",
  method: "POST",
  path: "/staff-roles/:roleId/delete",
  input: z.object({ roleId: z.string().min(1), moveTo: z.string().min(1).optional() }),
  output: z.object({
    roleId: z.string().min(1),
    movedTo: z.string().nullable(),
    membersMoved: z.number().int().nonnegative(),
  }),
});
