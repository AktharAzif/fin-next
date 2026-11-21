// @fin/ui/shell: the app shell (spec 06 §3.3's shell group, §4), built on @fin/ui's own controls:
// AppShell with the sidebar, the edge toggle and the phone sheet; the header's EnvironmentSwitch,
// organisation switcher and account menus; Fin Admin's deployment badge. Router-free: links come in
// through `linkAs`. @fin/frame composes them into AppFrame and AdminFrame; screens never render a
// shell themselves. (AuthLayout and AuthCard are @fin/ui's, from its main entry.)
export {
  AccountMenu,
  type AccountMenuProps,
  nameFromEmail,
  type ShellThemeChoice,
  StaffMenu,
  type StaffMenuProps,
} from "./AccountMenu.tsx";
export { AppShell, AppShellContent, type AppShellLayout, type AppShellProps } from "./AppShell.tsx";
export { DeploymentBadge, deploymentLabel } from "./DeploymentBadge.tsx";
export { EdgeToggle, type EdgeToggleProps } from "./EdgeToggle.tsx";
export {
  EnvironmentSwitch,
  type EnvironmentSwitchProps,
  type ShellEnvironment,
} from "./EnvironmentSwitch.tsx";
export {
  type OrganisationOption,
  OrganisationSwitcher,
  type OrganisationSwitcherProps,
} from "./OrganisationSwitcher.tsx";
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
