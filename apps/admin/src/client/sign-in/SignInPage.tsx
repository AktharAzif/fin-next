// "Sign in to Fin Admin" (AdminSignIn board; spec 02 §4.3, §5.2, §10.5): the work email, prefilled
// with the address Cloudflare Access let in, then the 8-digit code emailed to it; or a passkey alone.
// The realm answers every address the same way, so "not staff" sees the same screens as staff. A
// code session is `aal1`: the next page is the factor step, or enrolment for a pending member.
import type { StaffViewer } from "@fin/app-contracts";
import { useFin } from "@fin/frame";
import { AuthCard, Button, Field, InlineAlert, Input, OTPInput, type OTPStatus } from "@fin/ui";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  checkWorkEmail,
  EMAILED_CODE_LENGTH,
  type EmailProblem,
  isDigits,
  normaliseEmail,
} from "../auth/inputs.ts";
import { sendSignInCode, signInWithCode, usePasskey } from "../auth/library.ts";
import { codeOutcome, sendOutcome } from "../auth/outcomes.ts";
import { passkeysSupported } from "../auth/passkey.ts";
import { OrDivider } from "../components/OrDivider.tsx";
import { nextStepFor } from "./after-sign-in.ts";

const RESEND_SECONDS = 45;

type StartAlert =
  | "ended"
  | "tooManyCodes"
  | "offline"
  | "ourSide"
  | "passkeyClosed"
  | "passkeyFailed"
  | null;

type CodeAlert =
  | "resent"
  | "short"
  | "wrong"
  | "expired"
  | "locked"
  | "tooManyCodes"
  | "offline"
  | "ourSide"
  | null;

const EMAIL_ERRORS: Record<EmailProblem, string> = {
  empty: "Enter an email address.",
  notWork: "Enter a work email address.",
};

function StartAlertView({ alert }: { alert: StartAlert }) {
  switch (alert) {
    case "ended":
      return (
        <InlineAlert tone="warning" title="You were signed out. Sign in again." live="polite" />
      );
    case "tooManyCodes":
      return (
        <InlineAlert
          tone="warning"
          title="Too many codes asked for in the last hour."
          live="polite"
        >
          Try again later.
        </InlineAlert>
      );
    case "offline":
      return (
        <InlineAlert tone="danger" title="Couldn’t reach Fin." live="assertive">
          Check your connection and try again.
        </InlineAlert>
      );
    case "ourSide":
      return (
        <InlineAlert tone="danger" title="Something went wrong on our side." live="assertive">
          Try again in a moment.
        </InlineAlert>
      );
    case "passkeyClosed":
      return (
        <InlineAlert tone="info" title="The passkey prompt was closed." live="polite">
          Try again when you’re ready.
        </InlineAlert>
      );
    case "passkeyFailed":
      return (
        <InlineAlert tone="danger" title="Couldn’t sign you in with that passkey." live="assertive">
          Use an email code instead.
        </InlineAlert>
      );
    default:
      return null;
  }
}

function CodeAlertView({ alert }: { alert: CodeAlert }) {
  switch (alert) {
    case "resent":
      return <InlineAlert tone="info" title="We sent a new code." live="polite" />;
    case "short":
      return (
        <InlineAlert
          tone="danger"
          title="Enter the 8-digit code from the email."
          live="assertive"
        />
      );
    case "wrong":
      return (
        <InlineAlert tone="danger" title="That code didn’t work." live="assertive">
          Check it and try again.
        </InlineAlert>
      );
    case "expired":
      return (
        <InlineAlert tone="warning" title="That code has expired or was used." live="polite">
          Ask for a new one.
        </InlineAlert>
      );
    case "locked":
      return (
        <InlineAlert tone="warning" title="Too many wrong tries in the last hour." live="polite">
          Try again later.
        </InlineAlert>
      );
    case "tooManyCodes":
      return (
        <InlineAlert
          tone="warning"
          title="Too many codes asked for in the last hour."
          live="polite"
        >
          Try again later.
        </InlineAlert>
      );
    case "offline":
      return (
        <InlineAlert tone="danger" title="Couldn’t reach Fin." live="assertive">
          Check your connection and try again.
        </InlineAlert>
      );
    case "ourSide":
      return (
        <InlineAlert tone="danger" title="Something went wrong on our side." live="assertive">
          Try again in a moment.
        </InlineAlert>
      );
    default:
      return null;
  }
}

export function SignInPage({ ended }: { ended: boolean }) {
  const fin = useFin<StaffViewer>();
  const navigate = useNavigate();
  const initialViewer = fin.viewer.get();
  const accessEmail = initialViewer?.state === "signed_out" ? initialViewer.accessEmail : null;

  const [step, setStep] = useState<"start" | "code">("start");
  const [email, setEmail] = useState(accessEmail ?? "");
  const [emailError, setEmailError] = useState<EmailProblem | null>(null);
  const [startAlert, setStartAlert] = useState<StartAlert>(ended ? "ended" : null);
  const [sending, setSending] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [otpStatus, setOtpStatus] = useState<OTPStatus>("idle");
  const [codeAlert, setCodeAlert] = useState<CodeAlert>(null);
  const [verifying, setVerifying] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);
  const emailRef = useRef<HTMLInputElement>(null);

  const goOn = async (): Promise<boolean> => {
    let viewer: StaffViewer | null;
    try {
      viewer = await fin.viewer.reload();
    } catch {
      return false;
    }
    const next = nextStepFor(viewer);
    if (next === "/sign-in") return false;
    await navigate({ to: next, replace: true });
    return true;
  };

  const sendCode = async () => {
    const problem = checkWorkEmail(email, accessEmail);
    setEmailError(problem);
    if (problem !== null) {
      emailRef.current?.focus();
      return;
    }
    setStartAlert(null);
    setSending(true);
    const address = normaliseEmail(email);
    try {
      const outcome = sendOutcome(await sendSignInCode(address));
      if (outcome === "sent") {
        setSentTo(address);
        setCode("");
        setOtpStatus("idle");
        setCodeAlert(null);
        setCooldown(RESEND_SECONDS);
        setStep("code");
      } else if (outcome === "notWork") {
        setEmailError("notWork");
      } else {
        setStartAlert(outcome === "failed" ? "ourSide" : outcome);
      }
    } finally {
      setSending(false);
    }
  };

  const resend = async () => {
    const outcome = sendOutcome(await sendSignInCode(sentTo));
    if (outcome === "sent") {
      setCode("");
      setOtpStatus("idle");
      setCodeAlert("resent");
    } else if (outcome === "tooManyCodes") setCodeAlert("tooManyCodes");
    else setCodeAlert(outcome === "offline" ? "offline" : "ourSide");
  };

  const signIn = async (typed: string) => {
    if (verifying || codeAlert === "locked") return;
    if (!isDigits(typed, EMAILED_CODE_LENGTH)) {
      setCodeAlert("short");
      setOtpStatus("invalid");
      return;
    }
    setCodeAlert(null);
    setVerifying(true);
    setOtpStatus("verifying");
    try {
      const outcome = codeOutcome(await signInWithCode(sentTo, typed));
      if (outcome === "signedIn") {
        setOtpStatus("success");
        if (!(await goOn())) {
          setOtpStatus("idle");
          setCodeAlert("ourSide");
        }
        return;
      }
      if (outcome === "wrong") {
        setOtpStatus("invalid");
        setCodeAlert("wrong");
      } else if (outcome === "expired") {
        setOtpStatus("expired");
        setCodeAlert("expired");
      } else if (outcome === "locked") {
        setOtpStatus("idle");
        setCodeAlert("locked");
      } else {
        setOtpStatus("idle");
        setCodeAlert(outcome === "offline" ? "offline" : "ourSide");
      }
    } finally {
      setVerifying(false);
    }
  };

  const withPasskey = async () => {
    setStartAlert(null);
    setPasskeyBusy(true);
    try {
      const result = await usePasskey(null);
      if (result.kind === "done") {
        if (!(await goOn())) setStartAlert("ourSide");
        return;
      }
      if (result.kind === "ceremony") {
        setStartAlert(result.reason === "cancelled" ? "passkeyClosed" : "passkeyFailed");
        return;
      }
      const failure = result.failure;
      setStartAlert(
        failure.kind === "network" || failure.kind === "access"
          ? "offline"
          : failure.kind !== "unexpected" && failure.status === 429
            ? "tooManyCodes"
            : "passkeyFailed",
      );
    } finally {
      setPasskeyBusy(false);
    }
  };

  if (step === "code") {
    const locked = codeAlert === "locked";
    return (
      <AuthCard title="Check your email" description={`Enter the code we emailed to ${sentTo}.`}>
        <form
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void signIn(code);
          }}
        >
          <CodeAlertView alert={codeAlert} />
          <OTPInput
            label="Sign-in code"
            length={EMAILED_CODE_LENGTH}
            value={code}
            onValueChange={(next) => {
              setCode(next);
              if (otpStatus === "invalid" || otpStatus === "expired") setOtpStatus("idle");
            }}
            onComplete={(full) => void signIn(full)}
            status={otpStatus}
            {...(otpStatus === "invalid" || otpStatus === "expired" ? { message: "" } : {})}
            disabled={locked}
            autoFocus
            onResend={resend}
            resendCooldown={RESEND_SECONDS}
            initialCooldown={cooldown}
          />
          <div className="flex flex-col gap-3">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              loading={verifying}
              {...(locked
                ? { disabledReason: "Too many wrong tries in the last hour. Try again later." }
                : {})}
            >
              Sign in
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="w-full"
              onClick={() => {
                setStep("start");
                setCodeAlert(null);
                setCooldown(0);
              }}
            >
              Use another address
            </Button>
          </div>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in to Fin Admin" description="Use your Fin work email.">
      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void sendCode();
        }}
      >
        <StartAlertView alert={startAlert} />
        <Field
          label="Work email"
          {...(emailError === null ? {} : { error: EMAIL_ERRORS[emailError] })}
        >
          <Input
            ref={emailRef}
            type="email"
            name="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            onValueChange={(value) => {
              setEmail(value);
              if (emailError !== null) setEmailError(null);
            }}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={sending}>
          Email me a code
        </Button>
      </form>
      {passkeysSupported() ? (
        <>
          <OrDivider />
          {/* @pendingDesign UR-22: AdminSignIn draws Google here (stretch 5); staff sign in with a passkey alone (spec 02 §4.3). */}
          <Button
            size="lg"
            variant="secondary"
            className="w-full"
            loading={passkeyBusy}
            disabled={sending}
            onClick={withPasskey}
          >
            Sign in with a passkey
          </Button>
        </>
      ) : null}
    </AuthCard>
  );
}
