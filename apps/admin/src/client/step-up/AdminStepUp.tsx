// "Confirm it's you" (AdminStepUp board; spec 02 §7.4, §7.5, §15.3): the root dialog that proves
// the intent or window an answer asked for, with the passkey first and then the authenticator's
// code, whichever of them the member has and this browser can use. After the proof the dialog
// waits while api() sends the action again once; "That didn't work. Try again." ends it with Close
// only, never a loop. Five wrong tries end the session (spec 02 §7.7): the dialog says so and the
// only way on is to sign in again. A limit (`429`) leaves the session alive: the dialog says to
// try again later, and Cancel stays.
import type { StepUpContentProps } from "@fin/frame";
import { useStore } from "@fin/frame";
import { Button, InlineAlert, Modal, OTPInput, type OTPStatus } from "@fin/ui";
import { useEffect, useState } from "react";
import { AUTHENTICATOR_CODE_LENGTH, isDigits } from "../auth/inputs.ts";
import { usePasskey, verifyAuthenticatorCode } from "../auth/library.ts";
import { factorOutcome } from "../auth/outcomes.ts";
import { passkeysSupported } from "../auth/passkey.ts";
import { signInAgain } from "../auth/sign-in-again.ts";
import { OrDivider } from "../components/OrDivider.tsx";
import { reasonSentence, stepUpSubject } from "./reasons.ts";

type Alert =
  | "passkeyClosed"
  | "passkeyFailed"
  | "short"
  | "limited"
  | "tooMany"
  | "signedOut"
  | "offline"
  | "ourSide"
  | null;

const ALERTS: Record<
  Exclude<Alert, null>,
  { tone: "info" | "danger" | "warning"; title: string; body?: string }
> = {
  passkeyClosed: {
    tone: "info",
    title: "The passkey prompt was closed.",
    body: "Try again when you’re ready.",
  },
  passkeyFailed: {
    tone: "danger",
    title: "That passkey didn’t work.",
    body: "Use a passkey of your own Fin Admin sign-in, or your authenticator app.",
  },
  short: { tone: "danger", title: "Enter the 6-digit code from your authenticator app." },
  limited: { tone: "warning", title: "Too many wrong tries.", body: "Try again later." },
  // The realm has already ended the session (spec 02 §7.7's sentence).
  tooMany: { tone: "danger", title: "You were signed out after too many wrong tries." },
  signedOut: { tone: "warning", title: "You were signed out. Sign in again." },
  offline: {
    tone: "danger",
    title: "Couldn’t reach Fin.",
    body: "Check your connection and try again.",
  },
  ourSide: {
    tone: "danger",
    title: "Something went wrong on our side.",
    body: "Try again in a moment.",
  },
};

export function AdminStepUp({ state, prove, close }: StepUpContentProps) {
  const subject = useStore(stepUpSubject());
  const [alert, setAlert] = useState<Alert>(null);
  const [code, setCode] = useState("");
  const [otpStatus, setOtpStatus] = useState<OTPStatus>("idle");
  const [busy, setBusy] = useState<"passkey" | "code" | null>(null);
  const [codesLimited, setCodesLimited] = useState(false);

  const proof = state.kind === "proof" ? state : null;
  const status = proof?.status ?? null;
  // A re-send that failed for a reason of its own: the screen behind says what happened.
  useEffect(() => {
    if (status === "failed") close();
  }, [status, close]);

  if (state.kind === "notice") {
    const title =
      state.notice === "second_factor_required"
        ? "Add a second factor first"
        : "Sign in by email to add a second factor";
    return (
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={title}
        description="Fin Admin needs a passkey or an authenticator app before it can confirm it’s you."
        footer={
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        }
      />
    );
  }

  const required = state.required;
  const intentId = required.step_up_kind === "intent" ? (required.intent_id ?? null) : null;
  const canPasskey = required.methods.includes("passkey");
  const passkeyHere = canPasskey && passkeysSupported();
  const canApp = required.methods.includes("authenticator");
  const sending = status === "sending";
  const invalid = status === "invalid";
  // The session is gone: "Sign in again" is the only way on.
  const ended = alert === "tooMany" || alert === "signedOut";
  const locked = ended || invalid || sending;
  // A limit or the realm's lockout stops codes for now; the session, and the passkey, live on.
  const codeLocked = locked || codesLimited;

  const afterFailure = (outcome: ReturnType<typeof factorOutcome>) => {
    if (outcome === "wrong") {
      setOtpStatus("invalid");
      setAlert(null);
    } else if (outcome === "limited") {
      setCodesLimited(true);
      setAlert("limited");
    } else if (outcome === "tooManyTries") setAlert("tooMany");
    else if (outcome === "signedOut") setAlert("signedOut");
    else if (outcome === "offline") setAlert("offline");
    else setAlert("ourSide");
  };

  const withPasskey = async () => {
    setAlert(null);
    setBusy("passkey");
    try {
      const result = await usePasskey(intentId);
      if (result.kind === "done") {
        prove(intentId);
        return;
      }
      if (result.kind === "ceremony") {
        setAlert(result.reason === "cancelled" ? "passkeyClosed" : "passkeyFailed");
        return;
      }
      const outcome = factorOutcome(result.failure);
      if (outcome === "wrong" || outcome === "failed") setAlert("passkeyFailed");
      else afterFailure(outcome);
    } finally {
      setBusy(null);
    }
  };

  const withCode = async (typed: string) => {
    if (busy !== null || codeLocked) return;
    if (!isDigits(typed, AUTHENTICATOR_CODE_LENGTH)) {
      setAlert("short");
      setOtpStatus("invalid");
      return;
    }
    setAlert(null);
    setBusy("code");
    setOtpStatus("verifying");
    try {
      const answer = await verifyAuthenticatorCode(typed, intentId);
      const outcome = factorOutcome(answer);
      if (outcome === "done") {
        setOtpStatus("success");
        prove(intentId);
        return;
      }
      setOtpStatus("idle");
      afterFailure(outcome);
    } finally {
      setBusy(null);
    }
  };

  const description = reasonSentence(required.reason_key, subject);
  const shown = alert === null ? null : ALERTS[alert];

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (open || sending) return;
        // With the session gone, closing the dialog leads where "Sign in again" does.
        if (ended) signInAgain();
        else close();
      }}
      busy={sending || busy !== null}
      title="Confirm it’s you"
      description={description}
      footer={
        ended ? (
          <Button variant="primary" onClick={signInAgain}>
            Sign in again
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={close}
            {...(sending ? { disabledReason: "Wait for this to finish." } : {})}
          >
            {invalid ? "Close" : "Cancel"}
          </Button>
        )
      }
    >
      {invalid ? (
        <InlineAlert tone="danger" title="That didn’t work. Try again." live="assertive" />
      ) : null}
      {shown === null ? null : (
        <InlineAlert
          tone={shown.tone}
          title={shown.title}
          live={shown.tone === "danger" ? "assertive" : "polite"}
        >
          {shown.body}
        </InlineAlert>
      )}
      {canPasskey && !passkeyHere && canApp ? (
        <InlineAlert tone="warning" title="This browser can’t use passkeys." live="polite">
          Use your authenticator app.
        </InlineAlert>
      ) : null}
      {passkeyHere ? (
        <Button
          variant="primary"
          className="w-full"
          loading={busy === "passkey" || (sending && otpStatus !== "success")}
          disabled={locked || busy === "code"}
          onClick={withPasskey}
        >
          Use my passkey
        </Button>
      ) : null}
      {passkeyHere && canApp ? <OrDivider /> : null}
      {canApp ? (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void withCode(code);
          }}
        >
          <OTPInput
            label="Authenticator code"
            length={AUTHENTICATOR_CODE_LENGTH}
            value={code}
            onValueChange={(next) => {
              setCode(next);
              if (otpStatus === "invalid") setOtpStatus("idle");
              if (alert === "short") setAlert(null);
            }}
            onComplete={(full) => void withCode(full)}
            status={otpStatus}
            disabled={codeLocked || busy === "passkey"}
            autoFocus={!passkeyHere}
          />
          <Button
            type="submit"
            variant={passkeyHere ? "secondary" : "primary"}
            className="w-full"
            loading={busy === "code" || (sending && otpStatus === "success")}
            disabled={codeLocked || busy === "passkey"}
          >
            Confirm
          </Button>
        </form>
      ) : null}
      {!passkeyHere && !canApp ? (
        <InlineAlert tone="warning" title="This browser can’t use passkeys." live="polite">
          Open Fin Admin in a browser that can, or ask an Admin to reset your second factors.
        </InlineAlert>
      ) : null}
    </Modal>
  );
}
