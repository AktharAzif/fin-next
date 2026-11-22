// Reset your password (ResetPassword board; spec 02 §5.7, stretch 2): the work email, then an emailed
// link whose code works once, for 15 minutes, in this browser only. The page says the same for
// every address, so nobody can use it to check who uses Fin. A new link can be asked 45 seconds
// after the last. With passwords off the page does not exist.
import { AuthCard, Button, Field, InlineAlert, Input } from "@fin/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { requestPasswordReset } from "../../api/contracts/passwords.ts";
import { commonAlert, type Failure, failureOf } from "../../api/failures.ts";
import { ceremonyApi } from "../../api/library.ts";
import { usePasswordsOffered } from "../../auth/passwords.ts";
import { looksLikeEmail, pendingEmail, rememberEmail } from "../../auth/pending.ts";
import { AlertFrom, AuthLoading, QuietLink } from "../../components/auth.tsx";
import { countdownLabel, NoPasswords, RESEND_SECONDS } from "../-passwords/ResetParts.tsx";

export const Route = createFileRoute("/reset-password/")({
  staticData: { frame: "auth", navId: null, pageName: "Reset your password" },
  pendingComponent: AuthLoading,
  component: ResetPasswordPage,
});

type Alert = null | "tooManyEmails" | Failure;

function alertFor(alert: Alert) {
  if (alert === null) return null;
  if (alert === "tooManyEmails") {
    return (
      <InlineAlert
        tone="warning"
        title="Too many emails were sent to this address. Try again later."
        live="polite"
      />
    );
  }
  return <AlertFrom alert={commonAlert(alert)} />;
}

function ResetPasswordPage() {
  const passwords = usePasswordsOffered();
  const [email, setEmail] = useState(() => pendingEmail() ?? "");
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [alert, setAlert] = useState<Alert>(null);
  const [sending, setSending] = useState(false);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const send = async (address: string) => {
    if (sending) return;
    if (!looksLikeEmail(address)) {
      setEmailInvalid(true);
      return;
    }
    setEmailInvalid(false);
    setSending(true);
    setAlert(null);
    try {
      await ceremonyApi()(requestPasswordReset, { email: address });
      rememberEmail(address);
      setSentTo(address);
      setWait(RESEND_SECONDS);
    } catch (error) {
      const failure = failureOf(error);
      if (failure === "invalid") setEmailInvalid(true);
      else setAlert(failure === "rateLimited" ? "tooManyEmails" : failure);
    } finally {
      setSending(false);
    }
  };

  if (passwords === null) return <AuthLoading />;
  if (!passwords) return <NoPasswords />;

  if (sentTo !== null) {
    return (
      <AuthCard
        title="Check your email"
        description={
          <>
            If <span className="font-medium text-text-primary">{sentTo}</span> has a Fin account, we
            sent a link to reset its password. The link works once and expires in 15 minutes.
          </>
        }
      >
        {alertFor(alert)}
        <div className="flex flex-col gap-3">
          <Button
            size="lg"
            loading={sending}
            {...(wait > 0 ? { disabledReason: "Wait a moment before asking again." } : {})}
            onClick={() => void send(sentTo)}
          >
            {wait > 0 ? `Send a new link in ${countdownLabel(wait)}` : "Send a new link"}
          </Button>
          <p className="m-0 text-body text-text-secondary">
            <QuietLink href="/sign-in">Back to sign in</QuietLink>
          </p>
        </div>
        <p className="m-0 text-caption text-text-tertiary">
          We show this message whether or not the email has an account, so nobody can use this page
          to check who uses Fin.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description="Enter your work email and we’ll send you a link to choose a new one."
    >
      {alertFor(alert)}
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void send(email.trim());
        }}
      >
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
            disabled={sending}
          />
        </Field>
        <div className="flex flex-col gap-3">
          <Button type="submit" variant="primary" size="lg" loading={sending}>
            Send reset link
          </Button>
          <p className="m-0 text-body text-text-secondary">
            <QuietLink href="/sign-in">Back to sign in</QuietLink>
          </p>
        </div>
      </form>
      <p className="m-0 text-caption text-text-tertiary">
        Signed up with Google or a passkey? You may not have a password, and can keep signing in
        that way.
      </p>
    </AuthCard>
  );
}
