// Fin Admin's catalogue, assembled from its areas' fragments (spec 02 §8.3). This file only lists
// the fragments in the role editor's order; `assembleCatalogue` checks the result as it loads.
import { assembleCatalogue } from "../../engine/assemble.ts";
import type { PermissionOf, RoleKeyOf } from "../../engine/types.ts";
import { accounts } from "./accounts.ts";
import { audit } from "./audit.ts";
import { customers } from "./customers.ts";
import { goLive } from "./go-live.ts";
import { money } from "./money.ts";
import { operations } from "./operations.ts";
import { organisations } from "./organisations.ts";
import { rfis } from "./rfis.ts";
import { admin, compliance, operator, viewer } from "./roles.ts";
import { settings } from "./settings.ts";
import { staff } from "./staff.ts";

export const staffCatalogue = assembleCatalogue({
  realm: "staff",
  groups: [
    goLive,
    customers,
    rfis,
    organisations,
    accounts,
    money,
    operations,
    audit,
    settings,
    staff,
  ],
  builtIns: [viewer, compliance, operator, admin],
  topRoleKey: "admin",
  customRolePrefix: "srl",
  movePermission: "staff.role",
});

/** One of Fin Admin's 26 permissions. Nothing else type-checks where one is asked for. */
export type StaffPermission = PermissionOf<typeof staffCatalogue>;

/** A prebuilt staff role's key. */
export type StaffRoleKey = RoleKeyOf<typeof staffCatalogue>;
