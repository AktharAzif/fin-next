// @fin/frame: what each web app's root uses (spec 06 §2, §4, §5; ARCHITECTURE §3.4). Screens import
// RouterLink, the route states, `api()`'s types and `useFin()` from here; the frames, the boot
// sequence and the root are wired once per app by its `main.tsx`, `router.ts` and `__root.tsx`.
export {
  type Api,
  type ApiClient,
  type ApiConfig,
  type ApiHooks,
  type ApiOptions,
  createApiClient,
  DEFAULT_TIMEOUT_MS,
  type StepUpProof,
} from "./api/client.ts";
export { ApiError, type ApiErrorKind, isApiError, isUnreachable } from "./api/errors.ts";
export { buildRequest, parseRetryAfter } from "./api/request.ts";
export { signOut } from "./api/sign-out.ts";
export { adminGate, consoleGate } from "./boot/gates.ts";
export {
  FinRoot,
  type FinRootProps,
  guardAdmin,
  guardConsole,
  routeMatcher,
} from "./boot/root.tsx";
export { type StartOptions, startApp } from "./boot/start.tsx";
export {
  ENVIRONMENTS,
  type Environment,
  type EnvResult,
  envSchema,
  type FinEnv,
  isOrigin,
  loadEnv,
} from "./env/env.ts";
export { AdminFrame } from "./frames/AdminFrame.tsx";
export { AppFrame, consoleEnvironment, PRODUCTION_LOCKED } from "./frames/AppFrame.tsx";
export { AuthFrame } from "./frames/AuthFrame.tsx";
export { FrameContent, routeAllowed } from "./frames/FrameContent.tsx";
export { Enter, type EnterProps } from "./motion/Enter.tsx";
export {
  NAVIGATION_BAR_FADE_MS,
  NavigationBar,
  type NavigationBarProps,
} from "./motion/NavigationBar.tsx";
export { adminNav } from "./nav/admin/index.ts";
export { consoleNav } from "./nav/console/index.ts";
export { allNavItems, filterNav } from "./nav/filter.ts";
export type {
  NavContext,
  NavGroup,
  NavGroupDef,
  NavItem,
  NavItemDef,
  NavTree,
  NavTreeDef,
} from "./nav/types.ts";
export { currentSidebar, type SidebarState, setSidebar, useSidebar } from "./prefs/sidebar.ts";
export { PREF_KEYS, type PrefKey, readPref, writePref } from "./prefs/storage.ts";
export {
  applyTheme,
  currentTheme,
  currentThemeChoice,
  isThemeChoice,
  type ResolvedTheme,
  resolveTheme,
  setThemeChoice,
  THEME_CHOICES,
  type ThemeChoice,
  useTheme,
} from "./prefs/theme.ts";
export { createReleaseWatch, installPreloadErrorReload, RELOAD_FLAG } from "./release/release.ts";
export {
  installGlobalErrorReporting,
  pendingReports,
  REPORT_QUEUE_LIMIT,
  type ReportIds,
  type ReportSink,
  reportBrowserError,
  setReportSink,
} from "./report/report.ts";
export { FrameSwitch, type FrameSwitchProps } from "./router/FrameSwitch.tsx";
export {
  deepestStaticData,
  useNavigationPending,
  usePathname,
  useRouteStaticData,
} from "./router/matches.ts";
export { safeNext, signInHref } from "./router/next.ts";
export { isRouterHref, RouterLink, type RouterLinkProps } from "./router/RouterLink.tsx";
export { type FinStaticData, type FrameKind, readStaticData } from "./router/static-data.ts";
export { documentTitle, type TitleInput } from "./router/titles.ts";
export {
  type FinRouterContext,
  type FinRuntime,
  FinRuntimeProvider,
  useFin,
} from "./runtime/runtime.tsx";
export { createStore, type Store, useStore } from "./runtime/store.ts";
export { createViewerStore, fetchViewer, type ViewerStore } from "./runtime/viewer.ts";
export { RouteError, RouteNotAllowed, RouteNotFound, RoutePending } from "./states/RouteStates.tsx";
export {
  createStepUpController,
  type StepUpContentProps,
  type StepUpController,
  StepUpHost,
  type StepUpState,
  type StepUpStatus,
} from "./step-up/step-up.tsx";
