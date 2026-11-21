// Fin Admin's signed-in frame (AdminFrame board; spec 06 §4.3; shell-v2 §6): its own sidebar (the
// review lists and the Settings group), the edge toggle 16px from the top, no strip, no organisation
// switcher and no EnvironmentSwitch. The header shows the deployment as a badge and the staff menu
// (email, role and how they signed in; Your sign-in; Log out). Fin Admin follows the system theme.
import type { StaffViewer, StaffViewerSignedIn } from "@fin/app-contracts";
import { NavigationBar } from "@fin/motion";
import { InlineAlert } from "@fin/ui";
import { AppShell, AppShellContent, DeploymentBadge, StaffMenu } from "@fin/ui/shell";
import { type ReactNode, useState } from "react";
import { signOut } from "../api/sign-out.ts";
import { adminNav } from "../nav/admin/index.ts";
import { filterNav } from "../nav/filter.ts";
import { useSidebar } from "../prefs/sidebar.ts";
import {
  useAnyRouter,
  useNavigationPending,
  usePathname,
  useRouteStaticData,
} from "../router/matches.ts";
import { RouterLink } from "../router/RouterLink.tsx";
import { useFin } from "../runtime/runtime.tsx";
import { useStore } from "../runtime/store.ts";
import { RoutePending } from "../states/RouteStates.tsx";
import { FrameContent } from "./FrameContent.tsx";
import { NAVIGATION_BAR } from "./navigation-bar.ts";

function signedIn(viewer: StaffViewer | null): StaffViewerSignedIn | null {
  return viewer !== null && viewer.state === "ok" ? viewer : null;
}

export function AdminFrame({ children }: { children: ReactNode }) {
  const fin = useFin<StaffViewer>();
  const viewer = signedIn(useStore(fin.viewer));
  const router = useAnyRouter();
  const pathname = usePathname();
  const pending = useNavigationPending();
  const staticData = useRouteStaticData();
  const { collapsed, setCollapsed } = useSidebar();
  const [logOutFailed, setLogOutFailed] = useState(false);

  const permissions = new Set(viewer?.permissions ?? []);
  const can = (permission: string) => permissions.has(permission);
  const tree = filterNav(adminNav, {
    can,
    hasRoute: (path) => router.getMatchedRoutes(path)[2] !== undefined,
    environment: "production",
  });
  // Behind Cloudflare Access on staging and production; the development stand-in elsewhere.
  const signIn = viewer?.environment === "development" ? "development" : "access";

  return (
    <AppShell
      variant="admin"
      nav={{ ...tree, currentId: staticData?.navId ?? null }}
      // Fin Admin's home is `/`, which opens the first list the role can see whose screen exists.
      brand={{ href: "/", label: "Fin Admin", caption: "Fin Admin" }}
      linkAs={RouterLink}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      environment={viewer === null ? null : <DeploymentBadge environment={viewer.environment} />}
      account={
        viewer === null ? null : (
          <StaffMenu
            email={viewer.staff.email}
            roleLabel={viewer.staff.roleLabel}
            signIn={signIn}
            accountHref="/account"
            linkAs={RouterLink}
            onLogOut={async () => {
              setLogOutFailed(false);
              if (!(await signOut({ app: "admin" }))) setLogOutFailed(true);
            }}
          />
        )
      }
      progress={<NavigationBar pending={pending} className={NAVIGATION_BAR} />}
    >
      <AppShellContent
        notice={
          logOutFailed ? (
            <InlineAlert tone="danger" title="Couldn’t log you out" live="assertive">
              You’re still signed in. Try again.
            </InlineAlert>
          ) : null
        }
      >
        {viewer === null ? (
          <RoutePending />
        ) : (
          <FrameContent
            pathname={pathname}
            staticData={staticData}
            can={can}
            environment="production"
          >
            {children}
          </FrameContent>
        )}
      </AppShellContent>
    </AppShell>
  );
}
