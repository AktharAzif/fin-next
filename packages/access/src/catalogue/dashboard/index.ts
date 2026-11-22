// The dashboard catalogue, assembled from its areas' fragments (spec 02 §8.2). This file only lists
// the fragments in the role editor's order; `assembleCatalogue` checks the result as it loads.
import { assembleCatalogue } from "../../engine/assemble.ts";
import type { PermissionOf, RoleKeyOf } from "../../engine/types.ts";
import { apiKeys } from "./api-keys.ts";
import { auditLog } from "./audit-log.ts";
import { customers } from "./customers.ts";
import { goLive } from "./go-live.ts";
import { money } from "./money.ts";
import { organisation } from "./organisation.ts";
import { admin, superAdmin } from "./roles.ts";
import { simulator } from "./simulator.ts";
import { team } from "./team.ts";
import { webhooks } from "./webhooks.ts";

export const dashboardCatalogue = assembleCatalogue({
  realm: "dashboard",
  groups: [customers, simulator, money, webhooks, apiKeys, team, auditLog, organisation, goLive],
  builtIns: [superAdmin, admin],
  topRoleKey: "super_admin",
  customRolePrefix: "rol",
  movePermission: "member.role",
});

/** One of the dashboard's 26 permissions. Nothing else type-checks where one is asked for. */
export type DashboardPermission = PermissionOf<typeof dashboardCatalogue>;

/** A built-in dashboard role's key. */
export type DashboardRoleKey = RoleKeyOf<typeof dashboardCatalogue>;
