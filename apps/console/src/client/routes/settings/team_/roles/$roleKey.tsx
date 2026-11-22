// A role's old address under Team ([UI-07], spec 06 §7.1): the editor is under Roles.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/team_/roles/$roleKey")({
  staticData: { frame: "app", navId: "settings", pageName: "Settings" },
  beforeLoad: ({ params, location }) => {
    throw redirect({
      href: `/settings/roles/${encodeURIComponent(params.roleKey)}${location.searchStr}`,
      replace: true,
    } as unknown as Parameters<typeof redirect>[0]);
  },
});
