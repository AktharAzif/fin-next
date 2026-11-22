// The Audit log's old address ([UI-07], spec 06 §7.1): it moved out of Settings into the sidebar.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/audit-log")({
  staticData: { frame: "app", navId: "audit-log", pageName: "Audit log" },
  beforeLoad: ({ location }) => {
    throw redirect({
      href: `/audit-log${location.searchStr}`,
      replace: true,
    } as unknown as Parameters<typeof redirect>[0]);
  },
});
