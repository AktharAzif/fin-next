// `/staff/roles/$roleKey` (AdminRoleEditor; spec 02 §10.7, spec 06 §7.2): `staff.read` to see a role,
// `staffRoles.manage` to change one. `new` opens a new role, and `?from=` duplicates one. The
// loader reads the role and every role's name; its own skeleton draws while they load (FW-C11).
import { createFileRoute } from "@tanstack/react-router";
import { loadRoleEditor } from "../../../roles/load.ts";
import { RoleEditorPage, RoleEditorSkeleton } from "../../../roles/RoleEditorPage.tsx";

interface EditorSearch {
  from?: string;
}

export const Route = createFileRoute("/staff/roles/$roleKey")({
  staticData: { frame: "app", navId: "staff", pageName: "Staff", needs: ["staff.read"] },
  validateSearch: (search: Record<string, unknown>): EditorSearch =>
    typeof search.from === "string" && search.from !== "" ? { from: search.from.slice(0, 40) } : {},
  loaderDeps: ({ search }) => ({ from: search.from }),
  loader: ({ context, params, deps }) => loadRoleEditor(context.fin, params.roleKey, deps.from),
  pendingComponent: RoleEditorSkeleton,
  component: RoleEditorRoute,
});

function RoleEditorRoute() {
  const data = Route.useLoaderData();
  const { roleKey } = Route.useParams();
  const { from } = Route.useSearch();
  return <RoleEditorPage data={data} roleKey={roleKey} from={from} />;
}
