// The console's signed-in frame (AppFrame board; spec 06 §4; shell-v2 §3): the sidebar filtered by
// the viewer's permissions and the routes that exist, the edge toggle, the header's organisation
// switcher, EnvironmentSwitch and AccountMenu, the Sandbox strip, the navigation bar and the page.
import {
  type ConsoleViewer,
  type ConsoleViewerSignedIn,
  setCurrentOrganization,
} from "@fin/app-contracts";
import {
  AccountMenu,
  AppShell,
  AppShellContent,
  EnvironmentSwitch,
  OrganisationSwitcher,
  PageNotice,
  PageSkeleton,
} from "@fin/ui/shell";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { signOut } from "../api/sign-out.ts";
import { NavigationBar } from "../motion/NavigationBar.tsx";
import { consoleNav } from "../nav/console/index.ts";
import { filterNav } from "../nav/filter.ts";
import { useSidebar } from "../prefs/sidebar.ts";
import { useTheme } from "../prefs/theme.ts";
import { useNavigationPending, usePathname, useRouteStaticData } from "../router/matches.ts";
import { RouterLink } from "../router/RouterLink.tsx";
import { useFin } from "../runtime/runtime.tsx";
import { useStore } from "../runtime/store.ts";
import { FrameContent } from "./FrameContent.tsx";
import { ReleaseNotice } from "./ReleaseNotice.tsx";

export const PRODUCTION_LOCKED = "Production unlocks when Fin approves your organisation.";

/** The console's environment: `?env=production` once Production is unlocked, else Sandbox (S6-09). */
export function consoleEnvironment(
  search: unknown,
  productionUnlocked: boolean,
): "sandbox" | "production" {
  const env =
    typeof search === "object" && search !== null
      ? (search as Record<string, unknown>).env
      : undefined;
  return productionUnlocked && env === "production" ? "production" : "sandbox";
}

function signedIn(viewer: ConsoleViewer | null): ConsoleViewerSignedIn | null {
  return viewer !== null && viewer.gate !== "factor_step" ? viewer : null;
}

export function AppFrame({ children }: { children: ReactNode }) {
  const fin = useFin<ConsoleViewer>();
  const viewer = signedIn(useStore(fin.viewer));
  const router = useRouter();
  const pathname = usePathname();
  const search = useRouterState({ select: (state) => state.location.search });
  const pending = useNavigationPending();
  const staticData = useRouteStaticData();
  const { collapsed, setCollapsed } = useSidebar();
  const { choice, setChoice } = useTheme();
  const [logOutFailed, setLogOutFailed] = useState(false);

  const membership = viewer?.memberships.find((m) => m.orgId === viewer.currentOrgId) ?? null;
  // Production stays locked until the organisation is approved (Sunday's go-live, spec 03).
  const productionUnlocked = membership?.liveStatus === "live";
  const environment = consoleEnvironment(search, productionUnlocked);
  const permissions = new Set(viewer?.permissions ?? []);
  const can = (permission: string) => permissions.has(permission);
  const tree = filterNav(consoleNav, {
    can,
    hasRoute: (path) => router.getMatchedRoutes(path)[2] !== undefined,
    environment,
    docsOrigin: fin.env.docsOrigin,
  });

  const switchEnvironment = (next: "sandbox" | "production") => {
    const url = new URL(window.location.href);
    if (next === "production") url.searchParams.set("env", "production");
    else url.searchParams.delete("env");
    void router.navigate({ href: `${url.pathname}${url.search}${url.hash}` });
  };

  const logOut = async () => {
    setLogOutFailed(false);
    const ok = await signOut({ app: "console" });
    if (!ok) setLogOutFailed(true);
  };

  const notice = (
    <>
      {logOutFailed ? (
        <PageNotice tone="danger" title="Couldn’t log you out" live="assertive">
          You’re still signed in. Try again.
        </PageNotice>
      ) : null}
      <ReleaseNotice />
    </>
  );

  return (
    <AppShell
      variant="console"
      nav={{ ...tree, currentId: staticData?.navId ?? null }}
      brand={{ href: "/", label: "Fin home" }}
      linkAs={RouterLink}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      strip={environment === "sandbox" ? "sandbox" : null}
      environment={
        viewer === null ? null : (
          <>
            <OrganisationSwitcher
              organisations={viewer.memberships
                .filter((m) => m.roleKnown)
                .map((m) => ({ id: m.orgId, name: m.name, roleLabel: m.roleLabel }))}
              currentId={viewer.currentOrgId}
              onSwitch={async (orgId) => {
                await fin.api(setCurrentOrganization, { orgId });
                await fin.viewer.reload();
                await router.invalidate();
              }}
              linkAs={RouterLink}
              createHref="/settings/organisation?view=create"
              settingsHref="/settings/organisation"
            />
            <EnvironmentSwitch
              value={environment}
              onValueChange={switchEnvironment}
              productionLocked={productionUnlocked ? null : PRODUCTION_LOCKED}
            />
          </>
        )
      }
      account={
        viewer === null ? null : (
          <AccountMenu
            name={viewer.user.name}
            email={viewer.user.email}
            roleLabel={membership?.roleLabel ?? null}
            theme={choice}
            onThemeChange={setChoice}
            securityHref="/account/security"
            linkAs={RouterLink}
            onLogOut={logOut}
          />
        )
      }
      progress={<NavigationBar pending={pending} />}
    >
      <AppShellContent notice={notice}>
        {viewer === null ? (
          <PageSkeleton label="Loading" />
        ) : (
          <FrameContent
            pathname={pathname}
            staticData={staticData}
            can={can}
            environment={environment}
          >
            {children}
          </FrameContent>
        )}
      </AppShellContent>
    </AppShell>
  );
}
