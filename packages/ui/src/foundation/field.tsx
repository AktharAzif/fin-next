// Field, Input and Textarea (spec 06 §3.3; the export's Field spec). Fin's own field context: a
// native <label> (the SDK's label entry is experimental and refused), the error named before the
// helper in aria-describedby, aria-invalid on the control. The controls are the SDK's input and
// textarea; their look is the fields table: the edge, the plate and the halo say the state.
import { WarningCircleIcon } from "@fin/icons";
import { Input as SdkInput } from "@ui-sdk/react/input";
import { Textarea as SdkTextarea } from "@ui-sdk/react/textarea";
import { type ComponentProps, createContext, type ReactNode, useContext, useId } from "react";
import { cn } from "../lib/cn.ts";

type FieldState = {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  disabled: boolean;
  readOnly: boolean;
};

const FieldContext = createContext<FieldState | null>(null);

/** The field around a control, for controls built elsewhere in @fin/ui (OTPInput, Select). */
export function useField(): FieldState | null {
  return useContext(FieldContext);
}

export type FieldProps = {
  /** The visible label; every field has one. */
  label: ReactNode;
  /** One line under the control: the format, a limit, or why the field exists. */
  helper?: ReactNode;
  /** What is wrong and how to fix it, in one sentence. Marks the control invalid. */
  error?: ReactNode;
  /** Adds "(optional)"; required is the default and never carries an asterisk. */
  optional?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  /** The control's id; generated when left out. */
  id?: string;
  /** Hides the label visually but keeps it for screen readers (a toolbar search). */
  hideLabel?: boolean;
  /** Something on the label's row, at its end (a "Forgot password?" link). */
  labelAside?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function Field(props: FieldProps) {
  const generated = useId();
  const id = props.id ?? `field${generated.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;
  const hasError = props.error !== undefined && props.error !== null && props.error !== false;
  const hasHelper = props.helper !== undefined && props.helper !== null && props.helper !== false;
  const describedBy = [hasError ? errorId : null, hasHelper ? helperId : null]
    .filter(Boolean)
    .join(" ");
  const state: FieldState = {
    id,
    describedBy: describedBy === "" ? undefined : describedBy,
    invalid: hasError,
    disabled: props.disabled === true,
    readOnly: props.readOnly === true,
  };
  return (
    <div
      data-slot="fin-field"
      data-invalid={hasError ? "" : undefined}
      data-disabled={state.disabled ? "" : undefined}
      className={cn("flex flex-col gap-2", props.className)}
    >
      <div
        className={cn("flex items-baseline justify-between gap-2", props.hideLabel && "sr-only")}
      >
        <label
          htmlFor={id}
          className={cn(
            "text-label-sm text-text-secondary",
            state.disabled && "text-text-disabled",
          )}
        >
          {props.label}
          {props.optional === true ? (
            <span className="font-regular text-text-tertiary"> (optional)</span>
          ) : null}
        </label>
        {props.labelAside}
      </div>
      <FieldContext.Provider value={state}>{props.children}</FieldContext.Provider>
      {hasError ? (
        <p id={errorId} className="m-0 flex items-start gap-1.5 text-caption text-status-danger-fg">
          <WarningCircleIcon size={14} className="mt-px shrink-0" />
          <span>{props.error}</span>
        </p>
      ) : null}
      {hasHelper ? (
        <p id={helperId} className="m-0 text-caption text-text-tertiary">
          {props.helper}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL = cn(
  "w-full rounded-control border border-border-input bg-surface-raised px-3 text-body text-text-primary shadow-input",
  "transition-field placeholder:text-text-tertiary",
  "not-disabled:not-read-only:hover:border-border-input-hover",
  "focus-visible:outline-none focus:border-focus-ring focus:shadow-focus",
  "aria-invalid:border-border-danger aria-invalid:shadow-invalid aria-invalid:focus:border-border-danger aria-invalid:focus:shadow-invalid-focus",
  "read-only:border-transparent read-only:bg-surface-subtle read-only:shadow-none",
  "disabled:cursor-not-allowed disabled:border-transparent disabled:bg-surface-subtle disabled:text-text-disabled disabled:shadow-none",
);

type ControlProps<P> = Omit<P, "className" | "style"> & { className?: string };

function fieldProps(field: FieldState | null, own: { id?: string | undefined }) {
  if (field === null) return {};
  return {
    id: own.id ?? field.id,
    ...(field.describedBy === undefined ? {} : { "aria-describedby": field.describedBy }),
    ...(field.invalid ? { "aria-invalid": true as const } : {}),
    ...(field.disabled ? { disabled: true } : {}),
    ...(field.readOnly ? { readOnly: true } : {}),
  };
}

/** A one-line text control: 40px (32 compact), 6px corners, a 12px inset. */
export function Input(props: ControlProps<ComponentProps<typeof SdkInput>>) {
  const field = useField();
  const { className, ...rest } = props;
  return (
    <SdkInput
      {...rest}
      {...fieldProps(field, rest)}
      className={cn(CONTROL, "h-control-md", className)}
    />
  );
}

/** A remark: grows from 3 to 10 rows and never shows a resize grabber. */
export function Textarea(props: ControlProps<ComponentProps<typeof SdkTextarea>>) {
  const field = useField();
  const { className, ...rest } = props;
  return (
    <SdkTextarea
      autoResize
      rows={3}
      {...rest}
      {...fieldProps(field, rest)}
      className={cn(CONTROL, "min-h-20 max-h-55 resize-none py-2.5", className)}
    />
  );
}
