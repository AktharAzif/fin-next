// The Staff page's data: the list and the roles, read together (spec 02 §10.2, §10.7). A failure
// is the page's `failed` state (the header stays, the table says it couldn't load), never the
// route's error page; a role without `staff.read` reads nothing and the frame says why.
import type { StaffViewer } from "@fin/app-contracts";
import { type FinRuntime, isApiError } from "@fin/frame";
import { listStaff, listStaffRoles, type StaffMember, type StaffRole } from "../api/contracts.ts";

export type StaffData =
  | {
      readonly kind: "ready";
      readonly staff: readonly StaffMember[];
      readonly total: number;
      readonly roles: readonly StaffRole[];
    }
  | { readonly kind: "failed"; readonly requestId: string | null; readonly offline: boolean }
  | { readonly kind: "notAllowed" };

/** Sorted by address, as the board lists them. */
export function byEmail(staff: readonly StaffMember[]): StaffMember[] {
  return [...staff].sort((a, b) => a.email.localeCompare(b.email, "en-GB"));
}

export async function loadStaff(
  fin: Pick<FinRuntime<StaffViewer>, "api" | "viewer">,
): Promise<StaffData> {
  const viewer = fin.viewer.get();
  if (viewer?.state !== "ok" || !viewer.permissions.includes("staff.read")) {
    return { kind: "notAllowed" };
  }
  try {
    const [list, roles] = await Promise.all([
      fin.api(listStaff, { size: 100 }),
      fin.api(listStaffRoles, {}),
    ]);
    return { kind: "ready", staff: byEmail(list.staff), total: list.total, roles: roles.roles };
  } catch (error) {
    return {
      kind: "failed",
      requestId: isApiError(error) ? error.requestId : null,
      offline: isApiError(error) && error.kind === "network",
    };
  }
}
