// The entry's boot sequence (spec 06 §2.3), shared by the three apps' `src/client/main.tsx`:
//   1. the app's stylesheet is imported first, by main.tsx itself, then `@fin/frame/report`, whose
//      scrubbing console guard is in place before any library loads; startApp installs the guard
//      again (a no-op once it is there) and sends uncaught errors to the report seam from here on;
//   2. `GET /env.json` and `GET /api/viewer` start at once, in parallel;
//   3. env.json is checked with the one schema; if it fails, or the viewer cannot be read, the page
//      shows "Couldn't load Fin" with Try again, and nothing else renders;
//   4. the router is created with the runtime in its context; the root route's guard decides the
//      first navigation from the viewer (401 on an `app` route goes to `/sign-in?next=`);
//   5. React's first render replaces the static boot skeleton; React's own failure handlers report
//      through the seam rather than printing the error whole;
//   6. the root sets `data-ready` once the first route has resolved;
//   7. after the first paint: one reload on a failed chunk.
// Until the first render, the static skeleton from index.html stays on screen.
import type { AppContract, AppName, ContractOutput } from "@fin/app-contracts";
import { CONNECTION_SENTENCE, ErrorState, ReportFailures, toast } from "@fin/ui";
import { type AnyRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { createApiClient } from "../api/client.ts";
import { loadEnv } from "../env/env.ts";
import { createReleaseWatch, installPreloadErrorReload } from "../release/release.ts";
import { installConsoleGuard } from "../report/console-guard.ts";
import {
  installGlobalErrorReporting,
  reactFailureHandlers,
  reportBrowserError,
} from "../report/report.ts";
import type { FrameKind } from "../router/static-data.ts";
import { type FinRouterContext, type FinRuntime, FinRuntimeProvider } from "../runtime/runtime.tsx";
import { createStore } from "../runtime/store.ts";
import { createViewerStore, fetchViewer } from "../runtime/viewer.ts";
import { createStepUpController } from "../step-up/step-up.tsx";
import { frameApiHooks } from "./api-hooks.ts";
import { routeMatcher } from "./root.tsx";

export interface StartOptions<C extends AppContract> {
  app: AppName;
  /** The app's viewer contract (`consoleViewer`, `staffViewer`); null for verify. */
  viewer: C | null;
  /** The frame of a path no route matches: `app` for the console and Fin Admin, `auth` for verify. */
  fallbackFrame: FrameKind;
  createRouter: (context: FinRouterContext<ContractOutput<C>>) => AnyRouter;
  /** The element React renders into; `#root` by default. */
  container?: HTMLElement;
}

/** The frame's `error` state at boot: "Couldn't load Fin" with Try again, and nothing else. */
function BootFailure() {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-dvh items-start justify-center bg-bg px-4 pt-24 text-body text-text-primary outline-none"
    >
      <ErrorState
        size="page"
        title="Couldn’t load Fin"
        description={CONNECTION_SENTENCE}
        onRetry={() => window.location.reload()}
      />
    </main>
  );
}

/**
 * A newer release is live (a response's `Fin-Release` differs from env.json's): say so once, with
 * Reload as the one action. The page keeps working; the next navigation to a missing chunk reloads
 * by itself (installPreloadErrorReload).
 */
export function showReleaseToast(): void {
  toast.info({
    title: "Fin was updated",
    description: "Reload to get the latest version.",
    action: {
      label: "Reload",
      altText: "Reload the page to get the latest version.",
      onAction: () => window.location.reload(),
    },
  });
}

export async function startApp<C extends AppContract>(options: StartOptions<C>): Promise<void> {
  type Viewer = ContractOutput<C>;
  installConsoleGuard();
  installGlobalErrorReporting();
  const container = options.container ?? document.getElementById("root");
  if (container === null) throw new Error("index.html has no #root");

  let currentOrganization: () => string | null = () => null;
  const client = createApiClient({
    app: options.app,
    manualRedirect: options.app === "admin",
    organization: () => currentOrganization(),
  });
  const viewerContract = options.viewer;
  const loadViewer = (): Promise<Viewer | null> =>
    viewerContract === null ? Promise.resolve(null) : fetchViewer(client.api, viewerContract);

  const [envResult, viewerResult] = await Promise.all([
    loadEnv(),
    loadViewer().then(
      (viewer) => ({ ok: true as const, viewer }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);

  const reactRoot = createRoot(container, reactFailureHandlers());
  if (!envResult.ok || !viewerResult.ok) {
    if (!viewerResult.ok) reportBrowserError(viewerResult.error, { stage: "boot.viewer" });
    reactRoot.render(
      <ReportFailures report={reportBrowserError}>
        <BootFailure />
      </ReportFailures>,
    );
    document.body.setAttribute("data-ready", "");
    return;
  }

  const viewer = createViewerStore<Viewer>(viewerResult.viewer, loadViewer);
  if (options.app === "console") {
    currentOrganization = () => {
      const value = viewer.get() as { currentOrgId?: unknown } | null;
      return typeof value?.currentOrgId === "string" ? value.currentOrgId : null;
    };
  }
  let matches: (pathname: string) => boolean = () => false;
  const runtime: FinRuntime<Viewer> = {
    app: options.app,
    env: envResult.env,
    api: client.api,
    configureApi: client.configure,
    viewer,
    stepUp: createStepUpController(),
    newRelease: createStore<string | null>(null),
    routeExists: (pathname) => matches(pathname),
  };
  const router = options.createRouter({ fin: runtime });
  matches = routeMatcher(router);

  client.configure(
    frameApiHooks({
      app: options.app,
      router,
      fallbackFrame: options.fallbackFrame,
      viewer,
      stepUp: runtime.stepUp,
      release: createReleaseWatch(envResult.env.release, (release) => {
        runtime.newRelease.set(release);
        showReleaseToast();
      }),
      reload: () => window.location.reload(),
      report: reportBrowserError,
    }),
  );

  reactRoot.render(
    <FinRuntimeProvider runtime={runtime as FinRuntime}>
      <RouterProvider router={router} />
    </FinRuntimeProvider>,
  );

  requestAnimationFrame(() => {
    installPreloadErrorReload();
  });
}
