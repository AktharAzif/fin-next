// @fin/ui: Fin's controls and surfaces on the UI SDK (spec 06 §3). Screens import controls only from
// here. Router-free: links come in through `render` or `linkAs`. The shell (AppShell, Sidebar,
// EnvironmentSwitch, AccountMenu, OrganisationSwitcher) is exported by the shells lane from
// src/shell/.

export { Enter, Swap } from "@fin/motion";
export { AuthCard, AuthFooter, AuthLayout, type AuthLayoutProps } from "./auth/auth-layout.tsx";
export {
  DropdownMenu,
  type DropdownMenuProps,
  MenuGroup,
  MenuItem,
  type MenuItemProps,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "./data/dropdown-menu.tsx";
export { CONNECTION_SENTENCE, ErrorState, type ErrorStateProps } from "./data/error-state.tsx";
export {
  formatMinor,
  Table,
  TableAmount,
  type TableColumn,
  type TableError,
  TableId,
  type TableNoun,
  TablePagination,
  type TablePaginationProps,
  type TableProps,
  type TableSort,
} from "./data/table.tsx";
export { Avatar, type AvatarProps, initials } from "./foundation/avatar.tsx";
export {
  Badge,
  type BadgeHue,
  type BadgeProps,
  badgeHues,
  StatusBadge,
  type StatusBadgeProps,
  type StatusTone,
} from "./foundation/badge.tsx";
export {
  Button,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  buttonClasses,
  IconButton,
  type IconButtonProps,
  TextButton,
} from "./foundation/button.tsx";
export { Checkbox, type CheckboxProps } from "./foundation/checkbox.tsx";
export {
  CopyField,
  type CopyFieldProps,
  lowerFirst,
  middleTruncate,
  useCopy,
} from "./foundation/copy-field.tsx";
export { Field, type FieldProps, Input, Textarea, useField } from "./foundation/field.tsx";
export {
  InlineAlert,
  type InlineAlertProps,
  type InlineAlertTone,
} from "./foundation/inline-alert.tsx";
export { Logo, type LogoProps } from "./foundation/logo.tsx";
export {
  Skeleton,
  SkeletonPage,
  SkeletonSection,
  type SkeletonShape,
  SkeletonText,
} from "./foundation/skeleton.tsx";
export { Spinner, type SpinnerProps } from "./foundation/spinner.tsx";
export { Tooltip, type TooltipProps, TooltipProvider } from "./foundation/tooltip.tsx";
export { OTPInput, type OTPInputProps, type OTPStatus, otpSentence } from "./inputs/otp-input.tsx";
export { Switch, type SwitchProps } from "./inputs/switch.tsx";
export { announce, useAnnounceOnMount } from "./lib/announce.ts";
export { type ClassValue, cn } from "./lib/cn.ts";
export {
  ACTION_FAILED,
  type FailureReporter,
  FailureReporterProvider,
  ReportFailures,
  useReportFailure,
} from "./lib/failures.tsx";
// The QR code (UR-13): the component only; its encoder is a chunk the component fetches itself.
export type { QrLevel, QrMatrix } from "./lib/qr/encode.ts";
export {
  QrCode,
  type QrCodeProps,
  type QrCodeState,
  QrCodeView,
  type QrCodeViewProps,
} from "./lib/qr/qr-code.tsx";
export {
  DocsLink,
  EmptyState,
  type EmptyStateFilter,
  type EmptyStateProps,
  type EmptyStateVariant,
} from "./overlays/empty-state.tsx";
export {
  ConfirmDialog,
  type ConfirmDialogProps,
  Modal,
  type ModalProps,
} from "./overlays/modal.tsx";
export { type Breadcrumb, PageHeader, type PageHeaderProps } from "./overlays/page-header.tsx";
export {
  SecretReveal,
  SecretRevealDialog,
  type SecretRevealProps,
  type SecretRevealStatus,
} from "./overlays/secret-reveal.tsx";
export {
  Tab,
  TabLink,
  TabLinks,
  TabPanel,
  Tabs,
  TabsList,
  type TabsProps,
} from "./overlays/tabs.tsx";
export { Toaster, type ToastMessage, type ToastTone, toast } from "./overlays/toaster.tsx";
