// The emailed-code page, shared by "Check your email" (SignInCode, /sign-in/code) and "Confirm your
// email" (VerifyEmail, /verify-email) (spec 02 §5.1, §5.2). The address comes from the page that
// sent the code (memory only), or from a link's fragment, which is read once and removed from the
// address bar. A link opened in the browser that asked for the code shows one button to press
// (never a sign-in by itself, so a mail scanner cannot use it); in any other browser the link's
// values are dropped and the person types their own address and code (S2-39). Codes are 8 digits,
// sent again after 45 seconds.
import type { ConsoleViewer } from "@fin/app-contracts";
import { useFin } from "@fin/frame";
import { AuthCard, Button, Field, InlineAlert, Input, OTPInput, type OTPStatus } from "@fin/ui";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  codeLink,
  EMAIL_CODE_LENGTH,
  sendSignInCode,
  signInWithCode,
} from "../api/contracts/auth.ts";
import { commonAlert, type Failure, failureOf } from "../api/failures.ts";
import { ceremonyApi } from "../api/library.ts";
import { destinationAfterSignIn } from "../auth/after-sign-in.ts";
import { type CodeLink, parseCodeLink, takeFragment } from "../auth/fragment.ts";
import { forgetEmail, looksLikeEmail, pendingEmail, rememberEmail } from "../auth/pending.ts";
import { AlertFrom, AuthLoading, QuietLink } from "./auth.tsx";

export const RESEND_SECONDS = 45;

export interface CodeEntryCopy {
  title: string;
  /** The line under the title when the address is known. */
  withAddress: (email: ReactNode) => ReactNode;
  /** The line when it is not (a reload, or a link from another browser). */
  withoutAddress: string;
  codeLabel: string;
  submit: string;
  footnote: string;
  /** The link opened in the asking browser: its title, line and button. */
  link: { title: string; line: (email: ReactNode) => ReactNode; submit: string };
  /** The link opened elsewhere. */
  elsewhere: { body: string };
  /** Where "Use a different email" goes. */
  restartHref: string;
}

type Mode =
  | { kind: "checking" }
  | { kind: "waiting"; email: string }
  | { kind: "noAddress"; elsewhere: boolean }
  | { kind: "link"; link: CodeLink };

type Alert = null | "wrongCode" | "linkExpired" | "tooManyEmails" | Failure;

/** What the page starts with: a link's values, the remembered address, or neither. */
export function initialMode(hash: string, remembered: string | null): Mode {
  const link = parseCodeLink(hash);
  if (link !== null) return { kind: "checking" };
  if (remembered !== null && remembered !== "") return { kind: "waiting", email: remembered };
  return { kind: "noAddress", elsewhere: false };
}

function codeAlert(alert: Alert) {
  switch (alert) {
    case null:
      return null;
    case "wrongCode":
      return (
        <InlineAlert tone="danger" title="That code didn’t work." live="assertive">
          Check the latest email from Fin, or send a new one. Codes expire, and three wrong tries
          cancel one.
        </InlineAlert>
      );
    case "linkExpired":
      return (
        <InlineAlert
          tone="warning"
          title="This link has expired or was already used."
          live="polite"
        >
          Send a new one to continue.
        </InlineAlert>
      );
    case "tooManyEmails":
      return (
        <InlineAlert
          tone="warning"
          title="Too many emails were sent to this address. Try again later."
          live="polite"
        />
      );
    default:
      return <AlertFrom alert={commonAlert(alert)} />;
  }
}

export function CodeEntry({ copy, next }: { copy: CodeEntryCopy; next: string | null }) {
  const fin = useFin<ConsoleViewer>();
  const router = useRouter();
  const fragment = useRef<string | null>(null);
  if (fragment.current === null) fragment.current = takeFragment();
  const [mode, setMode] = useState<Mode>(() => initialMode(fragment.current ?? "", pendingEmail()));
  const [email, setEmail] = useState("");
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [code, setCode] = useState("");
  const [alert, setAlert] = useState<Alert>(null);
  const [status, setStatus] = useState<OTPStatus>("idle");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // A link: ask whether this browser asked its code; only then offer the one-press sign-in.
  useEffect(() => {
    const link = parseCodeLink(fragment.current ?? "");
    if (link === null) return;
    let live = true;
    void ceremonyApi()(codeLink, { email: link.email }).then(
      (answer) => {
        if (!live) return;
        setMode(answer.asking ? { kind: "link", link } : { kind: "noAddress", elsewhere: true });
      },
      (error: unknown) => {
        if (!live) return;
        setMode({ kind: "noAddress", elsewhere: false });
        setAlert(failureOf(error));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const address = mode.kind === "waiting" ? mode.email : email.trim();

  const failed = (error: unknown) => {
    const failure = failureOf(error);
    if (failure === "wrongCode" || failure === "usedUp") {
      setAlert("wrongCode");
      setStatus("invalid");
    } else if (failure === "expired") {
      setAlert("linkExpired");
      setStatus("expired");
    } else {
      setAlert(failure);
      setStatus("idle");
    }
    setAttempt((n) => n + 1);
  };

  const submit = async (otp: string, to: string) => {
    if (busy) return;
    if (!looksLikeEmail(to)) {
      setEmailInvalid(true);
      return;
    }
    setEmailInvalid(false);
    setBusy(true);
    setAlert(null);
    setStatus("verifying");
    try {
      await ceremonyApi()(signInWithCode, { email: to, otp });
      forgetEmail();
      setStatus("success");
      const href = await destinationAfterSignIn(fin, next);
      await router.navigate({ href, replace: true });
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!looksLikeEmail(address)) {
      setEmailInvalid(true);
      return;
    }
    setAlert(null);
    try {
      await ceremonyApi()(sendSignInCode, { email: address, type: "sign-in" });
      rememberEmail(address);
      setStatus("idle");
    } catch (error) {
      const failure = failureOf(error);
      setAlert(failure === "rateLimited" ? "tooManyEmails" : failure);
    }
  };

  if (mode.kind === "checking") return <AuthLoading />;

  if (mode.kind === "link") {
    return (
      <AuthCard
        title={copy.link.title}
        description={copy.link.line(<Strong>{mode.link.email}</Strong>)}
      >
        {codeAlert(alert)}
        <Button
          variant="primary"
          size="lg"
          autoFocus
          loading={busy}
          onClick={() => submit(mode.link.code, mode.link.email)}
        >
          {copy.link.submit}
        </Button>
        <p className="m-0 text-body text-text-secondary">
          <QuietLink href={copy.restartHref}>Use a different email</QuietLink>
        </p>
      </AuthCard>
    );
  }

  const known = mode.kind === "waiting";
  return (
    <AuthCard
      title={copy.title}
      description={known ? copy.withAddress(<Strong>{mode.email}</Strong>) : copy.withoutAddress}
    >
      {mode.kind === "noAddress" && mode.elsewhere ? (
        <InlineAlert
          tone="warning"
          title="This link was opened in a different browser from the one that asked for it."
        >
          {copy.elsewhere.body}
        </InlineAlert>
      ) : null}
      {codeAlert(alert)}
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.length === EMAIL_CODE_LENGTH) void submit(code, address);
        }}
      >
        {known ? null : (
          <Field
            label="Work email"
            {...(emailInvalid ? { error: "That email address doesn’t look right." } : {})}
          >
            <Input
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onValueChange={(value) => setEmail(value)}
              disabled={busy}
            />
          </Field>
        )}
        <OTPInput
          key={`otp-${attempt}`}
          label={copy.codeLabel}
          length={EMAIL_CODE_LENGTH}
          autoFocus={known}
          status={status === "success" ? "verifying" : status}
          onValueChange={(value) => {
            setCode(value);
            if (status === "invalid" || status === "expired") setStatus("idle");
          }}
          onComplete={(value) => {
            if (known) void submit(value, address);
          }}
          onResend={resend}
          resendCooldown={RESEND_SECONDS}
          {...(known ? {} : { initialCooldown: 0 })}
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy}
          {...(code.length === EMAIL_CODE_LENGTH
            ? {}
            : { disabledReason: `Enter all ${EMAIL_CODE_LENGTH} digits first.` })}
        >
          {copy.submit}
        </Button>
      </form>
      <div className="flex flex-col gap-2">
        <p className="m-0 text-body text-text-secondary">
          <QuietLink href={copy.restartHref}>Use a different email</QuietLink>
        </p>
        <p className="m-0 text-caption text-text-tertiary">{copy.footnote}</p>
      </div>
    </AuthCard>
  );
}

function Strong({ children }: { children: ReactNode }) {
  return <span className="font-medium text-text-primary">{children}</span>;
}
