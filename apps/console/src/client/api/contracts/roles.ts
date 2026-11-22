// Roles (spec 02 §8.4, §14.2): the built-in and custom roles with their holders and permission
// counts, one role with its permissions, and create, save and delete, each with an intent. A
// custom role's key is its `rol_` ID. The client's reading of §14.2 until L-SAT-03's
// app-contracts fragment carries them; unknown fields are kept.
import { defineContract, noInput, z } from "@fin/app-contracts";

export const roleRow = z.looseObject({
  roleKey: z.string().min(1),
  /** The custom role's ID (`rol_…`); null for a built-in role. */
  roleId: z.string().nullable(),
  label: z.string(),
  description: z.string().nullable().optional(),
  builtIn: z.boolean(),
  permissionCount: z.number().int().nonnegative(),
  holders: z.number().int().nonnegative(),
  /**
   * Who holds the role, by member ID: what a deletion names back as the holders it moves. A list
   * without it names none, which the server answers with a conflict when anyone holds the role.
   */
  holderIds: z.array(z.string()).optional(),
  /** Pending invitations that give this role. */
  invitations: z.number().int().nonnegative().optional(),
  /** The role's permissions, when the answer lists them (the pickers' "can do more than you"). */
  permissions: z.array(z.string()).optional(),
});
export type RoleRow = z.output<typeof roleRow>;

export const roles = defineContract({
  name: "roles.list",
  method: "GET",
  path: "/roles",
  organization: true,
  input: noInput,
  output: z.looseObject({ roles: z.array(roleRow) }),
});

export const roleDetail = defineContract({
  name: "roles.get",
  method: "GET",
  path: "/roles/:roleKey",
  organization: true,
  input: z.object({ roleKey: z.string().min(1) }),
  output: z.looseObject({
    roleKey: z.string().min(1),
    roleId: z.string().nullable(),
    label: z.string(),
    description: z.string().nullable().optional(),
    builtIn: z.boolean(),
    permissions: z.array(z.string()),
    /** The optimistic version a save sends back (a stale one is `409 conflict`). */
    version: z.number().int().nonnegative().nullable(),
    holders: z.number().int().nonnegative(),
    holderNames: z.array(z.string()).optional(),
  }),
});
export type RoleDetail = z.output<(typeof roleDetail)["output"]>;

const draft = {
  name: z.string().max(200),
  description: z.string().max(400),
  permissions: z.array(z.string().min(1)),
};

export const createRole = defineContract({
  name: "roles.create",
  method: "POST",
  path: "/roles",
  organization: true,
  creates: true,
  input: z.object(draft),
  output: z.looseObject({ roleId: z.string().min(1) }),
});

/**
 * Saves a custom role at the version the draft was built on (a stale one is `409 conflict`). The
 * answer is the version the save made: the editor's next save builds on it, never on a version a
 * reload brought in while the draft held changes of its own.
 */
export const saveRole = defineContract({
  name: "roles.save",
  method: "PUT",
  path: "/roles/:roleId",
  organization: true,
  input: z.object({ roleId: z.string().min(1), ...draft, version: z.number().int().nonnegative() }),
  output: z.looseObject({ version: z.number().int().nonnegative() }),
});

/**
 * Deletes a custom role, moving its holders and pending invitations to `moveTo`. `holders` are the
 * holders the page showed (the row's `holderIds`), which the intent binds: when they are not the
 * role's holders now, the answer is `409 conflict` and nobody moves.
 */
export const deleteRole = defineContract({
  name: "roles.delete",
  method: "POST",
  path: "/roles/:roleId/delete",
  organization: true,
  input: z.object({
    roleId: z.string().min(1),
    moveTo: z.string().min(1).optional(),
    holders: z.array(z.string().min(1)),
  }),
  output: z.unknown(),
});
