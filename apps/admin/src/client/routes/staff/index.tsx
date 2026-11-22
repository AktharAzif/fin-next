// `/staff` (AdminStaff; spec 06 §7.2): `staff.read`; `?view=add` opens Add staff. The loader reads
// the list and the roles together; its own skeleton draws while they load (FW-C11).
import { createFileRoute } from "@tanstack/react-router";
import { loadStaff } from "../../staff/load.ts";
import { StaffPage, StaffSkeleton } from "../../staff/StaffPage.tsx";

interface StaffSearch {
  view?: "add";
}

export const Route = createFileRoute("/staff/")({
  staticData: { frame: "app", navId: "staff", pageName: "Staff", needs: ["staff.read"] },
  validateSearch: (search: Record<string, unknown>): StaffSearch =>
    search.view === "add" ? { view: "add" } : {},
  loader: ({ context }) => loadStaff(context.fin),
  pendingComponent: StaffSkeleton,
  component: StaffRoute,
});

function StaffRoute() {
  const data = Route.useLoaderData();
  const { view } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <StaffPage
      data={data}
      openAdd={view === "add"}
      onAddClosed={() => {
        if (view === "add") void navigate({ search: {}, replace: true });
      }}
    />
  );
}
