// Roles' old address under Team ([UI-07], spec 06 §7.1): Roles is its own Settings tab.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/team_/roles/")({
  staticData: { frame: "app", navId: "settings", pageName: "Settings" },
  beforeLoad: () => {
    throw redirect({ href: "/settings/roles", replace: true } as unknown as Parameters<
      typeof redirect
    >[0]);
  },
});
