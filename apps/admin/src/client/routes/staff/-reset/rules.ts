// Whether a row of the Staff list offers "Reset second factors", and why not (spec 02 §8.5, §8.7,
// §10.2, §10.8). This only mirrors the server: it checks `staff.reset_factors` (Admin-only), the
// intent, who may act on whom and the last Admin inside the staff-change lock on every request, and
// refuses whatever this says. A control the role cannot use is drawn disabled with its reason.
import type { StaffMember, StaffRole } from "../../../api/contracts.ts";
import {
  type Actor,
  isLastActiveAdmin,
  LAST_ADMIN,
  NO_PERMISSION,
  OUTRANKED,
} from "../../../staff/rules.ts";

export const RESET_PERMISSION = "staff.reset_factors";

export const OWN_RESET = "You can’t reset your own second factors.";

function holds(actor: Actor, role: StaffRole | undefined): boolean {
  // A role this page does not know is the server's to judge; it refuses an outranked target.
  if (role === undefined) return true;
  return role.permissions.every((permission) => actor.permissions.has(permission));
}

/**
 * The row's reset control: `undefined` when the row has none (a pending member has no second factor
 * yet, and "New code" is theirs), `null` when it is enabled, else the reason it is disabled.
 */
export function resetControl(
  actor: Actor,
  member: StaffMember,
  staff: readonly StaffMember[],
  roles: readonly StaffRole[],
): string | null | undefined {
  if (member.status !== "active") return undefined;
  if (!actor.permissions.has(RESET_PERMISSION)) return NO_PERMISSION;
  if (member.id === actor.id) return OWN_RESET;
  if (isLastActiveAdmin(member, staff)) return LAST_ADMIN;
  if (
    !holds(
      actor,
      roles.find((role) => role.key === member.roleKey),
    )
  ) {
    return OUTRANKED;
  }
  return null;
}
