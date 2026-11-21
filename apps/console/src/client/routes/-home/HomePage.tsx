// The Home board's heading: "Welcome, {first name}" ("Welcome" before the person gave a name) and
// the environment sentence for the current organisation.
import type { ConsoleViewer } from "@fin/app-contracts";
import { RouterLink, useFin, useStore } from "@fin/frame";
import { PageHeader } from "@fin/ui";

export function welcomeTitle(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first === "" ? "Welcome" : `Welcome, ${first}`;
}

export function HomePage() {
  const fin = useFin<ConsoleViewer>();
  const viewer = useStore(fin.viewer);
  if (viewer === null || viewer.gate === "factor_step") return null;
  const organisation = viewer.memberships.find((m) => m.orgId === viewer.currentOrgId);
  return (
    <PageHeader
      title={welcomeTitle(viewer.user.name)}
      {...(organisation === undefined
        ? {}
        : {
            description: `You’re in the Sandbox for ${organisation.name}. Nothing here moves real money.`,
          })}
      linkAs={RouterLink}
    />
  );
}
