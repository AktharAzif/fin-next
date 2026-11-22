// "Confirm it's you" and "Add a second factor" (AdminSecondFactor board; spec 02 §6.4, §6.5, §10.3).
// No Fin Admin session works without a second factor:
//   - a member with a factor shows it: the passkey first, then the authenticator's code;
//   - a pending member (no factor yet) first enters the enrolment code the Admin who added them
//     handed over, which opens a 10-minute window, then adds a passkey or, outside production, an
//     authenticator app. There is no way past it: "Back to sign in" signs out.
import type { StaffViewer } from "@fin/app-contracts";
import { signOut, useFin } from "@fin/frame";
import {
  AuthCard,
  Button,
  CopyField,
  Field,
  InlineAlert,
  Input,
  OTPInput,
  type OTPStatus,
  TextButton,
} from "@fin/ui";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { redeemEnrolmentCode } from "../api/contracts.ts";
import type { AuthFailure } from "../auth/http.ts";
import {
  AUTHENTICATOR_CODE_LENGTH,
  groupsOfFour,
  isDigits,
  normaliseEnrolmentCode,
  totpKeyOf,
} from "../auth/inputs.ts";
import {
  addPasskey,
  enableAuthenticator,
  totpUriOf,
  usePasskey,
  verifyAuthenticatorCode,
} from "../auth/library.ts";
import {
  type EnrolmentOutcome,
  enrolmentOutcome,
  enrolmentWindowClosed,
  type FactorOutcome,
  factorOutcome,
  isLimit,
  sessionEnded,
} from "../auth/outcomes.ts";
import { passkeysSupported } from "../auth/passkey.ts";
import { signInAgain } from "../auth/sign-in-again.ts";
import { OrDivider } from "../components/OrDivider.tsx";
import { nextStepFor } from "./after-sign-in.ts";

type Notice = { tone: "info" | "warning" | "danger"; title: string; body?: string } | null;

const CLOSED: Notice = {
  tone: "info",
  title: "The passkey prompt was closed.",
  body: "Try again when you’re ready.",
};
const OFFLINE: Notice = {
  tone: "danger",
  title: "Couldn’t reach Fin.",
  body: "Check your connection and try again.",
};
const OUR_SIDE: Notice = {
  tone: "danger",
  title: "Something went wrong on our side.",
  body: "Try again in a moment.",
};
const SHORT: Notice = {
  tone: "danger",
  title: "Enter the 6-digit code from your authenticator app.",
};
/** A limit or the realm's lockout (spec 02 §5.4): the session lives on, so nothing says sign-out. */
const LIMITED: Notice = {
  tone: "warning",
  title: "Too many wrong tries.",
  body: "Try again later.",
};
const LIMITED_REASON = "Too many wrong tries. Try again later.";
/** The realm ended the session after too many wrong tries (spec 02 §7.7). */
const ENDED: Notice = {
  tone: "danger",
  title: "You were signed out after too many wrong tries.",
  body: "Fin Admin takes you back to sign in.",
};

function NoticeView({ notice }: { notice: Notice }) {
  if (notice === null) return null;
  return (
    <InlineAlert
      tone={notice.tone}
      title={notice.title}
      live={notice.tone === "danger" ? "assertive" : "polite"}
    >
      {notice.body}
    </InlineAlert>
  );
}

function BackToSignIn() {
  return (
    <p className="m-0 text-center text-body text-text-secondary">
      <TextButton
        onClick={async () => {
          if (!(await signOut({ app: "admin" }))) window.location.assign("/sign-in");
        }}
      >
        Back to sign in
      </TextButton>
    </p>
  );
}

/** Reads the viewer again after a factor and goes where it now belongs. */
function useGoOn(): () => Promise<boolean> {
  const fin = useFin<StaffViewer>();
  const navigate = useNavigate();
  return async () => {
    let viewer: StaffViewer | null;
    try {
      viewer = await fin.viewer.reload();
    } catch {
      return false;
    }
    if (viewer?.state !== "ok") return false;
    await navigate({ to: nextStepFor(viewer), replace: true });
    return true;
  };
}

function CardFrame(props: { title: string; description: string; children: ReactNode }) {
  return (
    <AuthCard title={props.title} description={props.description}>
      {props.children}
      <BackToSignIn />
    </AuthCard>
  );
}

/** The factor step: an `aal1` session of a member who has a factor. */
function ConfirmStep({ email, methods }: { email: string; methods: readonly string[] }) {
  const goOn = useGoOn();
  const hasPasskey = methods.includes("passkey");
  const hasApp = methods.includes("authenticator");
  const passkeyHere = hasPasskey && passkeysSupported();
  const [notice, setNotice] = useState<Notice>(
    hasPasskey && !passkeyHere && hasApp
      ? {
          tone: "warning",
          title: "This browser can’t use passkeys.",
          body: "Use your authenticator app.",
        }
      : null,
  );
  const [busy, setBusy] = useState<"passkey" | "code" | null>(null);
  // The session ended after too many wrong tries: nothing more can be sent.
  const [ended, setEnded] = useState(false);
  // A limit or the realm's lockout on codes: the session lives on and the passkey still works.
  const [limited, setLimited] = useState(false);
  const [code, setCode] = useState("");
  const [otpStatus, setOtpStatus] = useState<OTPStatus>("idle");

  /** What a refusal other than a wrong code means at the factor step. */
  const refused = (outcome: FactorOutcome): void => {
    if (outcome === "tooManyTries") {
      setEnded(true);
      setNotice(ENDED);
      // The realm ended the session (spec 02 §7.7); sign-in loads again shortly, as the board says.
      window.setTimeout(signInAgain, 4000);
    } else if (outcome === "signedOut") signInAgain();
    else if (outcome === "limited") {
      setLimited(true);
      setNotice(LIMITED);
    } else if (outcome === "offline") setNotice(OFFLINE);
    else if (outcome === "failed") setNotice(OUR_SIDE);
  };

  const afterCode = async (answer: Awaited<ReturnType<typeof verifyAuthenticatorCode>>) => {
    const outcome = factorOutcome(answer);
    if (outcome === "done") {
      setOtpStatus("success");
      if (!(await goOn())) {
        setOtpStatus("idle");
        setNotice(OUR_SIDE);
      }
      return;
    }
    setOtpStatus(outcome === "wrong" ? "invalid" : "idle");
    refused(outcome);
  };

  const withCode = async (typed: string) => {
    if (busy !== null || ended || limited) return;
    if (!isDigits(typed, AUTHENTICATOR_CODE_LENGTH)) {
      setNotice(SHORT);
      setOtpStatus("invalid");
      return;
    }
    setNotice(null);
    setBusy("code");
    setOtpStatus("verifying");
    try {
      await afterCode(await verifyAuthenticatorCode(typed, null));
    } finally {
      setBusy(null);
    }
  };

  const withPasskey = async () => {
    setNotice(null);
    setBusy("passkey");
    try {
      const result = await usePasskey(null);
      if (result.kind === "done") {
        if (!(await goOn())) setNotice(OUR_SIDE);
        return;
      }
      if (result.kind === "ceremony") {
        setNotice(
          result.reason === "cancelled"
            ? CLOSED
            : {
                tone: "warning",
                title: "There’s no passkey to use.",
                body: hasApp ? "Use your authenticator app." : "Try the passkey on another device.",
              },
        );
        return;
      }
      const outcome = factorOutcome(result.failure);
      if (outcome === "wrong" || outcome === "failed") {
        setNotice({
          tone: "danger",
          title: "That passkey didn’t work.",
          body: hasApp ? "Try again, or use your authenticator app." : "Try again.",
        });
      } else refused(outcome);
    } finally {
      setBusy(null);
    }
  };

  return (
    <CardFrame title="Confirm it’s you" description={`Signing in as ${email}.`}>
      <NoticeView notice={notice} />
      {passkeyHere ? (
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          loading={busy === "passkey"}
          disabled={ended || busy === "code"}
          onClick={withPasskey}
        >
          Use my passkey
        </Button>
      ) : null}
      {passkeyHere && hasApp ? <OrDivider /> : null}
      {hasApp ? (
        <form
          className="flex flex-col gap-5"
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
            }}
            onComplete={(full) => void withCode(full)}
            status={otpStatus}
            disabled={ended || limited || busy === "passkey"}
            autoFocus={!passkeyHere}
          />
          <Button
            type="submit"
            variant={passkeyHere ? "secondary" : "primary"}
            size="lg"
            className="w-full"
            loading={busy === "code"}
            disabled={ended || busy === "passkey"}
            {...(limited && !ended ? { disabledReason: LIMITED_REASON } : {})}
          >
            Verify and continue
          </Button>
        </form>
      ) : null}
      {!passkeyHere && !hasApp ? (
        <InlineAlert tone="warning" title="This browser can’t use passkeys." live="polite">
          Open Fin Admin in a browser that can, or ask an Admin to reset your second factors.
        </InlineAlert>
      ) : null}
    </CardFrame>
  );
}

const ENROLMENT_ERRORS: Record<Exclude<EnrolmentOutcome, "signedOut">, string> = {
  wrong: "That code didn’t work. Check it and try again.",
  expired: "That code has expired. Ask the Admin who added you for a new one.",
  used: "That code can’t be used again. Ask the Admin who added you for a new one.",
  tooMany: "Too many wrong tries. Ask the Admin who added you for a new code.",
  offline: "Couldn’t reach Fin. Check your connection and try again.",
  failed: "Something went wrong on our side. Try again in a moment.",
};

/** A pending member's first step: the enrolment code ([SA-29]). */
function EnrolmentCodeStep({
  onRedeemed,
  windowClosed,
}: {
  onRedeemed: () => void;
  windowClosed: boolean;
}) {
  const fin = useFin<StaffViewer>();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const redeem = async () => {
    const code = normaliseEnrolmentCode(value);
    if (code === null) {
      setError("Enter the 16-character code, like ABCD-EFGH-JKMN-PQRS.");
      input.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await fin.api(redeemEnrolmentCode, { code });
      onRedeemed();
    } catch (failure) {
      const outcome = enrolmentOutcome(failure);
      // The session's 10 minutes are shorter than the code's 30: a new code would not help.
      if (outcome === "signedOut") return signInAgain();
      setError(ENROLMENT_ERRORS[outcome]);
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardFrame
      title="Enter your enrolment code"
      description="The Admin who added you gave you a code. It works once, for 30 minutes."
    >
      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void redeem();
        }}
      >
        {windowClosed ? (
          <InlineAlert
            tone="warning"
            title="Your 10 minutes to add a second factor ran out."
            live="polite"
          >
            Ask the Admin who added you for a new enrolment code.
          </InlineAlert>
        ) : null}
        <Field
          label="Enrolment code"
          helper="16 letters and numbers. Dashes and spaces don’t matter."
          {...(error === null ? {} : { error })}
        >
          <Input
            ref={input}
            name="enrolment-code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            className="font-mono"
            value={value}
            onValueChange={(next) => {
              setValue(next);
              if (error !== null) setError(null);
            }}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Continue
        </Button>
      </form>
    </CardFrame>
  );
}

/** A pending member inside the enrolment window: add the first factor. */
function SetupStep({ onWindowClosed }: { onWindowClosed: () => void }) {
  const fin = useFin<StaffViewer>();
  const goOn = useGoOn();
  const allowApp = fin.env.environment !== "production";
  const passkeyHere = passkeysSupported();
  const [view, setView] = useState<"choose" | "app">("choose");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<"passkey" | "app" | "code" | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [otpStatus, setOtpStatus] = useState<OTPStatus>("idle");

  const finish = async () => {
    if (!(await goOn())) setNotice(OUR_SIDE);
  };

  /**
   * A refused set-up call: the enrolment window closed (the code step comes again), the session
   * ended (sign in again; spec 02 §6.4, §11.1), a limit, or no answer.
   */
  const refusedBy = (failure: AuthFailure): void => {
    if (enrolmentWindowClosed(failure)) onWindowClosed();
    else if (sessionEnded(failure)) signInAgain();
    else if (isLimit(failure)) setNotice(LIMITED);
    else setNotice(failure.kind === "network" || failure.kind === "access" ? OFFLINE : OUR_SIDE);
  };

  const withPasskey = async () => {
    setNotice(null);
    setBusy("passkey");
    try {
      const result = await addPasskey(null);
      if (result.kind === "done") return await finish();
      if (result.kind === "ceremony") {
        setNotice(
          result.reason === "cancelled"
            ? CLOSED
            : result.reason === "unsupported"
              ? {
                  tone: "warning",
                  title: "This browser can’t make a passkey.",
                  body: "Use an authenticator app, or another browser.",
                }
              : { tone: "danger", title: "Couldn’t add a passkey.", body: "Try again." },
        );
        return;
      }
      refusedBy(result.failure);
    } finally {
      setBusy(null);
    }
  };

  const startApp = async () => {
    setNotice(null);
    setBusy("app");
    try {
      const answer = await enableAuthenticator(null);
      const uri = answer.ok ? totpUriOf(answer.data) : null;
      const secret = uri === null ? null : totpKeyOf(uri);
      if (secret !== null) {
        setKey(secret);
        setView("app");
        return;
      }
      if (answer.ok) setNotice(OUR_SIDE);
      else refusedBy(answer);
    } finally {
      setBusy(null);
    }
  };

  const turnOn = async (typed: string) => {
    if (busy !== null) return;
    if (!isDigits(typed, AUTHENTICATOR_CODE_LENGTH)) {
      setNotice(SHORT);
      setOtpStatus("invalid");
      return;
    }
    setNotice(null);
    setBusy("code");
    setOtpStatus("verifying");
    try {
      const answer = await verifyAuthenticatorCode(typed, null);
      const outcome = factorOutcome(answer);
      if (outcome === "done") {
        setOtpStatus("success");
        return await finish();
      }
      setOtpStatus(outcome === "wrong" ? "invalid" : "idle");
      if (outcome !== "wrong" && !answer.ok) refusedBy(answer);
    } finally {
      setBusy(null);
    }
  };

  if (view === "app" && key !== null) {
    return (
      <CardFrame
        title="Add a second factor"
        description="Add this key to your authenticator app, then enter the code it shows."
      >
        <NoticeView notice={notice} />
        <CopyField variant="block" label="Key" value={groupsOfFour(key)} />
        <form
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void turnOn(code);
          }}
        >
          <OTPInput
            label="Code from the app"
            length={AUTHENTICATOR_CODE_LENGTH}
            value={code}
            onValueChange={(next) => {
              setCode(next);
              if (otpStatus === "invalid") setOtpStatus("idle");
            }}
            onComplete={(full) => void turnOn(full)}
            status={otpStatus}
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy === "code"}
          >
            Turn it on
          </Button>
        </form>
      </CardFrame>
    );
  }

  return (
    <CardFrame
      title="Add a second factor"
      description={
        allowApp
          ? "Fin Admin needs a passkey or an authenticator app for each sign-in. Add one now."
          : "Fin Admin needs a passkey for each sign-in. Add one now."
      }
    >
      <NoticeView notice={notice} />
      <div className="flex flex-col gap-3">
        {passkeyHere ? (
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy === "passkey"}
            disabled={busy === "app"}
            onClick={withPasskey}
          >
            Add a passkey
          </Button>
        ) : (
          <InlineAlert tone="warning" title="This browser can’t make a passkey." live="polite">
            {allowApp
              ? "Use an authenticator app, or another browser."
              : "Open Fin Admin in a browser that can."}
          </InlineAlert>
        )}
        {allowApp ? (
          <Button
            size="lg"
            variant={passkeyHere ? "secondary" : "primary"}
            className="w-full"
            loading={busy === "app"}
            disabled={busy === "passkey"}
            onClick={startApp}
          >
            Use an authenticator app
          </Button>
        ) : null}
      </div>
    </CardFrame>
  );
}

/** A pending member: the code, then the first factor. */
function EnrolmentFlow() {
  const [step, setStep] = useState<"code" | "setup">("code");
  const [closed, setClosed] = useState(false);
  if (step === "setup") {
    return (
      <SetupStep
        onWindowClosed={() => {
          setClosed(true);
          setStep("code");
        }}
      />
    );
  }
  return <EnrolmentCodeStep windowClosed={closed} onRedeemed={() => setStep("setup")} />;
}

export function FactorPage() {
  const fin = useFin<StaffViewer>();
  const viewer = fin.viewer.get();
  if (viewer?.state === "factor_step") {
    return <ConfirmStep email={viewer.email} methods={viewer.methods} />;
  }
  if (viewer?.state === "pending") return <EnrolmentFlow />;
  // The route's guard sends every other viewer elsewhere before this draws.
  return null;
}
