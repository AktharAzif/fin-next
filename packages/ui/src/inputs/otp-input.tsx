// OTPInput (spec 06 §3.3; the export's OTPInput spec) on the SDK's otp-input.
// - 6 boxes for authenticator codes, 8 for emailed ones; autocomplete="one-time-code"; paste fills
//   every box.
// - A complete code is handed on once (onComplete), however often the boxes report it.
// - After a wrong or expired code the whole code is selected again, so typing replaces it.
// - The sentence under the boxes says the status; resend has a cooldown that restarts after each
//   send and reads "Sending" while it runs.
import { OTPInputGroup, OTPInputSlot, OTPInput as SdkOTPInput } from "@ui-sdk/react/otp-input";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { TextButton } from "../foundation/button.tsx";
import { announce } from "../lib/announce.ts";
import { cn } from "../lib/cn.ts";

export type OTPStatus = "idle" | "verifying" | "invalid" | "expired" | "locked" | "success";

export type OTPInputProps = {
  /** Names the code: "Verification code". */
  label: string;
  /** Where the code went: "We sent a 6-digit code to ana@example.com." */
  description?: ReactNode;
  length?: number;
  value?: string;
  defaultValue?: string;
  onValueChange?: (code: string) => void;
  /** Every digit is in: called once per complete code. Verify it here. */
  onComplete?: (code: string) => void;
  status?: OTPStatus;
  /** With `invalid`: "2 attempts left", from the API. */
  attemptsLeft?: number;
  /** With `locked`: the API's wait, in a sentence. */
  lockedMessage?: string;
  /** Overrides the sentence for the current status. */
  message?: ReactNode;
  /** Sends a new code; while its promise runs the link reads "Sending". Omit to hide resend. */
  onResend?: () => void | Promise<void>;
  /** Seconds before another code can be sent; restarts after each resend. */
  resendCooldown?: number;
  /** Seconds left on the cooldown when the input first shows. Defaults to the cooldown. */
  initialCooldown?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  name?: string;
  className?: string;
};

/** The sentence under the boxes for each status. */
export function otpSentence(
  props: Pick<OTPInputProps, "status" | "attemptsLeft" | "lockedMessage">,
): string | null {
  switch (props.status ?? "idle") {
    case "verifying":
      return "Checking the code…";
    case "invalid": {
      const left = props.attemptsLeft;
      const tail =
        left === undefined ? "" : ` ${left} ${left === 1 ? "attempt" : "attempts"} left.`;
      return `That code isn’t right. Check it and try again.${tail}`;
    }
    case "expired":
      return "This code expired. Send a new code.";
    case "locked":
      return props.lockedMessage ?? "Too many attempts. Try again later.";
    case "success":
      return "Code accepted.";
    default:
      return null;
  }
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function OTPInput(props: OTPInputProps) {
  const length = props.length ?? 6;
  const status = props.status ?? "idle";
  const id = `otp${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const root = useRef<HTMLDivElement>(null);
  const handed = useRef<string | null>(null);
  const [cooldown, setCooldown] = useState(props.initialCooldown ?? props.resendCooldown ?? 0);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // A wrong or expired code: select all of it, so the next digits replace it; and let the same
  // code be handed on again if the person retypes it.
  useEffect(() => {
    if (status !== "invalid" && status !== "expired") return;
    handed.current = null;
    const input = root.current?.querySelector("input");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  }, [status]);

  const sentence = props.message ?? otpSentence(props);
  const spoken = typeof sentence === "string" ? sentence : null;

  // The status sentence is spoken when the status changes, errors at once.
  useEffect(() => {
    if (status === "idle" || spoken === null) return;
    announce(
      spoken,
      status === "invalid" || status === "expired" || status === "locked" ? "assertive" : "polite",
    );
  }, [status, spoken]);
  const invalid = status === "invalid" || status === "expired" || status === "locked";
  const locked = status === "locked" || status === "verifying" || props.disabled === true;
  const describedBy = [
    props.description === undefined ? null : `${id}-description`,
    sentence === null ? null : `${id}-status`,
  ]
    .filter(Boolean)
    .join(" ");

  const resend = async () => {
    if (props.onResend === undefined) return;
    setSending(true);
    try {
      await props.onResend();
      setCooldown(props.resendCooldown ?? 0);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      data-slot="fin-otp"
      data-status={status}
      className={cn("flex flex-col gap-3", props.className)}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-label-sm text-text-secondary">
          {props.label}
        </label>
        {props.description === undefined ? null : (
          <p id={`${id}-description`} className="m-0 text-body text-text-secondary">
            {props.description}
          </p>
        )}
      </div>
      <div ref={root}>
        <SdkOTPInput
          id={id}
          maxLength={length}
          pattern="digits"
          inputMode="numeric"
          autoComplete="one-time-code"
          {...(props.name === undefined ? {} : { name: props.name })}
          {...(props.value === undefined ? {} : { value: props.value })}
          {...(props.defaultValue === undefined ? {} : { defaultValue: props.defaultValue })}
          {...(props.autoFocus === true ? { autoFocus: true } : {})}
          disabled={locked}
          {...(invalid ? { "aria-invalid": true } : {})}
          {...(describedBy === "" ? {} : { "aria-describedby": describedBy })}
          onValueChange={(code) => {
            if (code.length < length) handed.current = null;
            props.onValueChange?.(code);
          }}
          onValueCommit={(code) => {
            if (code.length !== length || handed.current === code) return;
            handed.current = code;
            props.onComplete?.(code);
          }}
          className="relative inline-flex"
        >
          <OTPInputGroup className="flex gap-1.5 sm:gap-2">
            {Array.from({ length }, (_, index) => index).map((index) => (
              <OTPInputSlot
                key={`slot-${index}`}
                index={index}
                className={cn(
                  "grid h-11 w-9 place-items-center rounded-control sm:w-11 border border-border-input bg-surface-raised font-mono text-heading text-text-primary shadow-input",
                  "transition-field data-active:border-focus-ring data-active:shadow-focus",
                  invalid && "border-border-danger shadow-invalid",
                  locked && "border-transparent bg-surface-subtle text-text-disabled shadow-none",
                )}
              />
            ))}
          </OTPInputGroup>
        </SdkOTPInput>
      </div>
      {sentence === null ? null : (
        <p
          id={`${id}-status`}
          className={cn(
            "m-0 text-caption",
            invalid
              ? "text-status-danger-fg"
              : status === "success"
                ? "text-status-success-fg"
                : "text-text-tertiary",
          )}
        >
          {sentence}
        </p>
      )}
      {props.onResend === undefined ? null : (
        <p className="m-0 text-caption text-text-tertiary">
          {sending ? (
            "Sending"
          ) : cooldown > 0 ? (
            `Send a new code in ${clock(cooldown)}`
          ) : (
            <>
              Didn’t get it? <TextButton onClick={resend}>Send a new code</TextButton>
            </>
          )}
        </p>
      )}
    </div>
  );
}
