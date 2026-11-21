// Button and IconButton (spec 06 §3.3; the export's Button spec) on the SDK's button.
// - A press that returns a Promise keeps the button pending: aria-busy, aria-disabled and
//   data-pending from the SDK, a spinner in the leading slot, the label kept, presses ignored.
// - `loading` does the same for work the button did not start (a form's submit).
// - `disabledReason` keeps the button focusable (aria-disabled) and makes the reason its
//   description and tooltip, so keyboard and screen-reader users can find out why.
// - A press that throws is reported through ReportFailures and says "That didn't work. Try again."
// - Router links go through `render` (the SDK stops a disabled or pending link from navigating).
import { Button as SdkButton } from "@ui-sdk/react/button";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { ACTION_FAILED, runReported, useReportFailure } from "../lib/failures.tsx";
import { toast } from "../overlays/toaster.tsx";
import { Spinner } from "./spinner.tsx";
import { Tooltip } from "./tooltip.tsx";

type SdkButtonProps = ComponentProps<typeof SdkButton>;

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

type BaseProps = Omit<SdkButtonProps, "className" | "children" | "disabled" | "style"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Busy with work the button did not start: spinner, label kept, presses ignored, focus kept. */
  loading?: boolean;
  disabled?: boolean;
  /** One sentence saying why the action is unavailable and how to fix it. */
  disabledReason?: string;
  /** IDs (never personal data) to send with a failure report. */
  reportIds?: Readonly<Record<string, string>>;
  className?: string;
};

export type ButtonProps = BaseProps & {
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  children: ReactNode;
};

const BASE = cn(
  "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2",
  "whitespace-nowrap rounded-control text-label transition-press focus-visible:outline-focus",
  "not-data-disabled:not-data-pending:not-data-loading:active:scale-press",
  "data-disabled:cursor-not-allowed data-loading:cursor-progress data-pending:cursor-progress",
);

const VARIANTS: Record<ButtonVariant, string> = {
  primary: cn(
    "bg-action-primary text-on-action-primary not-data-disabled:hover:bg-action-primary-hover",
    "data-disabled:not-data-loading:bg-surface-subtle data-disabled:not-data-loading:text-text-disabled",
  ),
  secondary: cn(
    "bg-surface-raised text-text-primary shadow-button not-data-disabled:hover:shadow-button-hover",
    "data-disabled:not-data-loading:text-text-disabled",
  ),
  ghost: cn(
    "bg-transparent text-text-primary not-data-disabled:hover:bg-fill-hover",
    "data-disabled:not-data-loading:text-text-disabled",
  ),
  danger: cn(
    "bg-danger-solid text-on-danger-solid not-data-disabled:hover:bg-danger-solid-hover",
    "data-disabled:not-data-loading:bg-surface-subtle data-disabled:not-data-loading:text-text-disabled",
  ),
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-control-sm gap-1.5 px-3",
  md: "h-control-md px-4",
  lg: "h-control-lg px-5",
};

/** The class string a Button draws with, for a link styled as a button outside a Button. */
export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md"): string {
  return cn(BASE, VARIANTS[variant], SIZES[size]);
}

type InnerProps = BaseProps & {
  renderContent: (pending: boolean) => ReactNode;
  shape: string;
};

function ButtonInner(props: InnerProps): ReactElement {
  const {
    variant = "primary",
    size = "md",
    loading = false,
    disabled = false,
    disabledReason,
    reportIds,
    className,
    renderContent,
    shape,
    onClick,
    ...rest
  } = props;
  const report = useReportFailure();
  const unavailable = disabled || loading || disabledReason !== undefined;
  return (
    <SdkButton
      {...rest}
      disabled={unavailable}
      focusableWhenDisabled={loading || disabledReason !== undefined}
      {...(loading ? { "aria-busy": true, "data-loading": "" } : {})}
      {...(onClick === undefined
        ? {}
        : {
            onClick: (event, details) =>
              runReported(
                () => onClick(event, details),
                report,
                reportIds ?? {},
                () => toast.error(ACTION_FAILED),
              ),
          })}
      className={cn(BASE, VARIANTS[variant], shape, className)}
    >
      {(state) => renderContent(loading || state.pending)}
    </SdkButton>
  );
}

export function Button(props: ButtonProps): ReactElement {
  const { leadingIcon, trailingIcon, children, ...rest } = props;
  const reason = props.disabledReason;
  const button = (
    <ButtonInner
      {...rest}
      shape={SIZES[props.size ?? "md"]}
      renderContent={(pending) => (
        <>
          {pending ? <Spinner /> : leadingIcon}
          {children}
          {trailingIcon}
        </>
      )}
    />
  );
  if (reason === undefined) return button;
  return (
    <Tooltip content={reason} type="description">
      {button}
    </Tooltip>
  );
}

export type IconButtonSize = "xs" | "sm" | "md" | "lg";

export type IconButtonProps = Omit<BaseProps, "size" | "variant" | "aria-label"> & {
  /** The accessible name. Required: an icon alone says nothing to a screen reader. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  /** xs is 24 by 24, the target minimum (the sidebar's edge toggle, UR-02); sm 32, md 40, lg 48. */
  size?: IconButtonSize;
  /**
   * The tooltip. Defaults to the label, which then names the button. Pass other text (a full ID)
   * to describe it, or `false` where the label is already visible beside it.
   */
  tooltip?: ReactNode | false;
  tooltipSide?: "top" | "right" | "bottom" | "left";
};

const SQUARES: Record<IconButtonSize, string> = {
  xs: "size-target-min p-0",
  sm: "size-control-sm p-0",
  md: "size-control-md p-0",
  lg: "size-control-lg p-0",
};

export function IconButton(props: IconButtonProps): ReactElement {
  const { label, icon, tooltip, tooltipSide, variant = "ghost", size = "md", ...rest } = props;
  const reason = props.disabledReason;
  const text = reason ?? (tooltip === undefined ? label : tooltip);
  const namedByTooltip = reason === undefined && tooltip === undefined;
  const button = (
    <ButtonInner
      {...rest}
      variant={variant}
      {...(namedByTooltip ? {} : { "aria-label": label })}
      shape={SQUARES[size]}
      renderContent={(pending) => (pending ? <Spinner /> : icon)}
    />
  );
  if (text === false) return button;
  return (
    <Tooltip
      content={text}
      type={namedByTooltip ? "label" : "description"}
      {...(tooltipSide === undefined ? {} : { side: tooltipSide })}
    >
      {button}
    </Tooltip>
  );
}

/** A small underlined text action inside a sentence, such as Retry or Resend code. */
export function TextButton(
  props: Omit<SdkButtonProps, "className" | "children"> & {
    className?: string;
    children: ReactNode;
  },
): ReactElement {
  const { className, children, ...rest } = props;
  return (
    <SdkButton
      {...rest}
      className={cn(
        "inline cursor-pointer rounded-xs bg-transparent p-0 text-label-sm text-text-primary underline decoration-border-strong underline-offset-4",
        "not-data-disabled:hover:decoration-text-primary focus-visible:outline-focus",
        "data-disabled:cursor-not-allowed data-disabled:text-text-disabled data-pending:cursor-progress",
        className,
      )}
    >
      {children}
    </SdkButton>
  );
}
