// @fin/ui/shell: the app shell's components (spec 06 §3.3's shell group, §4): AppShell with the
// sidebar, the edge toggle and the phone sheet; the header's EnvironmentSwitch, organisation
// switcher and account menus; Fin Admin's deployment badge; the signed-out layout; the frame's page
// states. Router-free: links come in through `linkAs`. @fin/frame composes them into AppFrame,
// AdminFrame and AuthFrame; screens never render a shell themselves.
export {
  AccountMenu,
  type AccountMenuProps,
  initials,
  type ShellThemeChoice,
  StaffMenu,
  type StaffMenuProps,
} from "./AccountMenu.tsx";
export { AppShell, AppShellContent, type AppShellLayout, type AppShellProps } from "./AppShell.tsx";
export { AuthLayout, type AuthLayoutProps } from "./AuthLayout.tsx";
export { FinLockup, FinMark } from "./brand.tsx";
export { DeploymentBadge, deploymentLabel } from "./DeploymentBadge.tsx";
export { EdgeToggle, type EdgeToggleProps } from "./EdgeToggle.tsx";
export {
  EnvironmentSwitch,
  type EnvironmentSwitchProps,
  type ShellEnvironment,
} from "./EnvironmentSwitch.tsx";
export { Glyph, NavGlyph } from "./Glyph.tsx";
export { type ShellGlyphName, type ShellNavGlyphName, shellGlyphs } from "./glyph-data.ts";
export {
  type OrganisationOption,
  OrganisationSwitcher,
  type OrganisationSwitcherProps,
} from "./OrganisationSwitcher.tsx";
export {
  type PageAction,
  PageColumn,
  PageHeading,
  PageNotice,
  PageProblem,
  PageSkeleton,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "./PageState.tsx";
export { PhoneNavSheet, type PhoneNavSheetProps } from "./PhoneNavSheet.tsx";
export {
  PlainLink,
  type ShellLink,
  type ShellLinkProps,
  Sidebar,
  type SidebarBrand,
  type SidebarGroup,
  type SidebarItem,
  type SidebarMode,
  type SidebarNav,
  type SidebarProps,
} from "./Sidebar.tsx";
export { currentShellWidth, type ShellWidth, useShellWidth } from "./width.ts";
