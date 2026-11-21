// `/staff/roles` (AdminRoles, a Roles tab on Staff; spec 02 S2-16, spec 06 §7.2): `staff.read`. The
// loader reads every role; its own skeleton draws while it loads (FW-C11).
import { createFileRoute } from "@tanstack/react-router";
import { loadRoles } from "../../../roles/load.ts";
import { RolesPage, RolesSkeleton } from "../../../roles/RolesPage.tsx";

export const Route = createFileRoute("/staff/roles/")({
  staticData: { frame: "app", navId: "staff", pageName: "Staff", needs: ["staff.read"] },
  loader: ({ context }) => loadRoles(context.fin),
  pendingComponent: RolesSkeleton,
  component: RolesRoute,
});

function RolesRoute() {
  return <RolesPage data={Route.useLoaderData()} />;
}
