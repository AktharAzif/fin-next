// OTPInput (spec 06 §3.3; the export's OTPInput spec) on the SDK's otp-input.
// - 6 boxes for authenticator codes, 8 for emailed ones; autocomplete="one-time-code"; paste fills
//   every box.
// - A complete code is handed on once (onComplete), however often the boxes report it.
// - After a wrong or expired code the whole code is selected again, so typing replaces it. That
//   happens on a change into those statuses only, where the person is (after a code they handed
//   on, or with focus in the input): one that mounts expired, or a code that expires while they
//   are elsewhere on the page, leaves focus alone.
// - The sentence under the boxes says the status; resend has a cooldown that restarts after each
//   send and reads "Sending" while it runs. The resend control stays in place throughout
//   (disabled but focusable), so keyboard focus is never dropped; the cooldown is announced when
//   it starts (after a resend, or as the input mounts with one running) and when it ends (spec 06
//   §9), and only then: the control's name stays "Send a new code" while the clock beside it
//   ticks, plain text outside any live region that can be read but is never spoken as it changes;
//   a resend that fails is reported and says so.
// - The boxes shrink to fit a narrow column: 8 of them fit 288px (a 320px phone, AC-UI-28).
import { OTPInputGroup, OTPInputSlot, OTPInput as SdkOTPInput } from "@ui-sdk/react/otp-input";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { TextButton } from "../foundation/button.tsx";
import { announce } from "../lib/announce.ts";
import { cn } from "../lib/cn.ts";
import { ACTION_FAILED, runReported, useReportFailure } from "../lib/failures.tsx";
import { toast } from "../overlays/toaster.tsx";

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
  const previousStatus = useRef(status);
  const report = useReportFailure();
  const [cooldown, setCooldown] = useState(props.initialCooldown ?? props.resendCooldown ?? 0);
  const [sending, setSending] = useState(false);
  const resendable = props.onResend !== undefined;

  // An input that mounts with the cooldown running (a code was just sent) says the wait once, as
  // a resend says its own start.
  const startSaid = useRef(false);
  useEffect(() => {
    if (startSaid.current) return;
    startSaid.current = true;
    if (resendable && cooldown > 0) {
      announce(`You can send a new code in ${Math.ceil(cooldown)} seconds.`);
    }
  }, [resendable, cooldown]);

  // One tick a second; the end of a countdown is announced (its start is, after a resend).
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => {
      const next = Math.max(0, cooldown - 1);
      if (next === 0 && resendable) announce("You can send a new code now.");
      setCooldown(next);
    }, 1000);
    return () => clearTimeout(timer);
  }, [cooldown, resendable]);

  // A change into a wrong or expired code: select all of it, so the next digits replace it; and
  // let the same code be handed on again if the person retypes it. Only on a change, and only
  // where the person is (they handed on a code, or focus is already in the input): an input that
  // mounts in one of those statuses, or a code that expires while they are elsewhere on the page,
  // must not take focus from the page (or scroll to itself).
  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = status;
    if (before === status || (status !== "invalid" && status !== "expired")) return;
    const here =
      handed.current !== null || (root.current?.contains(document.activeElement) ?? false);
    handed.current = null;
    const input = root.current?.querySelector("input");
    if (here && input instanceof HTMLInputElement) {
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

  // A failed resend is reported and says "That didn't work. Try again."; the control is offered
  // again. A sent one starts the cooldown, and says so.
  const resend = async () => {
    const onResend = props.onResend;
    if (onResend === undefined) return;
    setSending(true);
    try {
      await runReported(
        () => onResend(),
        report,
        {},
        () => toast.error(ACTION_FAILED),
      );
    } catch {
      return;
    } finally {
      setSending(false);
    }
    const seconds = Math.max(0, Math.ceil(props.resendCooldown ?? 0));
    setCooldown(seconds);
    announce(
      seconds > 0 ? `Code sent. You can send a new code in ${seconds} seconds.` : "Code sent.",
    );
  };
  const waiting = cooldown > 0;

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
          className="relative inline-flex max-w-full"
        >
          {/* 36px boxes on phones and 44px from 640px, each shrinking when the column is narrower
              than all of them: 8 boxes fit 288px. */}
          <OTPInputGroup className="flex min-w-0 max-w-full gap-1.5 sm:gap-2">
            {Array.from({ length }, (_, index) => index).map((index) => (
              <OTPInputSlot
                key={`slot-${index}`}
                index={index}
                className={cn(
                  "grid h-11 w-9 min-w-0 shrink place-items-center rounded-control sm:w-11 border border-border-input bg-surface-raised font-mono text-heading text-text-primary shadow-input",
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
      {resendable ? (
        <p data-slot="fin-otp-resend" className="m-0 text-caption text-text-tertiary">
          {sending || waiting ? null : "Didn’t get it? "}
          {/* The control's name comes from its text, and focus can sit on it for the whole
              cooldown: a name that changed every second would have the countdown read out every
              second. So its text stays "Send a new code", and the clock is beside it: plain text,
              in no live region and named by nothing, so it is never spoken as it ticks but can
              be read (announce() says the start and the end). */}
          <TextButton
            disabled={sending || waiting}
            focusableWhenDisabled
            {...(sending ? { "aria-busy": true } : {})}
            onClick={resend}
            className="data-disabled:cursor-default data-disabled:text-text-tertiary data-disabled:no-underline"
          >
            {sending ? "Sending" : "Send a new code"}
          </TextButton>
          {waiting && !sending ? (
            <span data-slot="fin-otp-clock">{` in ${clock(cooldown)}`}</span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
