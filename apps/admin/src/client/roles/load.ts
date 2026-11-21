// The data of AdminRoles and AdminRoleEditor (spec 02 §10.7, §15.3). A failure is the page's own
// `failed` state (the header stays, the section says it couldn't load), never the route's error
// page; a role without `staff.read` reads nothing and the frame says why; a role key that names
// nothing is the editor's `notFound` state, which never says whether it existed.
import type { StaffViewer } from "@fin/app-contracts";
import { type FinRuntime, isApiError } from "@fin/frame";
import { type StaffRoleRow, staffRoleDetail, staffRolesIndex } from "./contracts.ts";

type Fin = Pick<FinRuntime<StaffViewer>, "api" | "viewer">;

export interface Failed {
  readonly kind: "failed";
  readonly requestId: string | null;
  readonly offline: boolean;
}

export type RolesData =
  | { readonly kind: "ready"; readonly roles: readonly StaffRoleRow[] }
  | Failed
  | { readonly kind: "notAllowed" };

export type EditorData =
  | {
      readonly kind: "ready";
      /** The role edited, or the one a new role starts from (`?from=`); null for a blank one. */
      readonly role: StaffRoleRow | null;
      readonly roles: readonly StaffRoleRow[];
    }
  | { readonly kind: "notFound" }
  | Failed
  | { readonly kind: "notAllowed" };

function failed(error: unknown): Failed {
  return {
    kind: "failed",
    requestId: isApiError(error) ? error.requestId : null,
    offline: isApiError(error) && error.kind === "network",
  };
}

function canRead(fin: Fin): boolean {
  const viewer = fin.viewer.get();
  return viewer?.state === "ok" && viewer.permissions.includes("staff.read");
}

/** AdminRoles: every role, the prebuilt first. */
export async function loadRoles(fin: Fin): Promise<RolesData> {
  if (!canRead(fin)) return { kind: "notAllowed" };
  try {
    const answer = await fin.api(staffRolesIndex, {});
    return { kind: "ready", roles: answer.roles };
  } catch (error) {
    return failed(error);
  }
}

/** The key a path may name: a prebuilt role's or a custom role's `srl_` ID. */
const ROLE_KEY = /^(viewer|compliance|operator|admin|srl_[0-9a-hjkmnp-tv-z]{26})$/;

/**
 * AdminRoleEditor: the role a path names (`new` for a new one, from `from` when duplicating) and
 * every role's name, so the editor can say a name is taken before the server does.
 */
export async function loadRoleEditor(
  fin: Fin,
  roleKey: string,
  from: string | undefined,
): Promise<EditorData> {
  if (!canRead(fin)) return { kind: "notAllowed" };
  const source = roleKey === "new" ? (from ?? null) : roleKey;
  // A key that cannot name a role is not asked for: it is not found.
  if (source !== null && !ROLE_KEY.test(source)) {
    return roleKey === "new" ? loadRoleEditor(fin, "new", undefined) : { kind: "notFound" };
  }
  try {
    const [role, list] = await Promise.all([
      source === null ? Promise.resolve(null) : fin.api(staffRoleDetail, { roleKey: source }),
      fin.api(staffRolesIndex, {}),
    ]);
    return { kind: "ready", role, roles: list.roles };
  } catch (error) {
    if (isApiError(error) && error.code === "not_found") {
      // A duplicate of a role that has gone starts blank; an edit of one is not found.
      return roleKey === "new" ? loadRoleEditor(fin, "new", undefined) : { kind: "notFound" };
    }
    return failed(error);
  }
}
