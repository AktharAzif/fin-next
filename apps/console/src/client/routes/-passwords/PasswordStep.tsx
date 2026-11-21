// The SignIn board's password step (spec 02 §5.7, stretch 2): "Enter your password" for the address
// the person typed, with "Forgot password?", "Email me a sign-in link instead", and the board's
// alerts. A right password makes a session at the first factor's gate: a person with a factor goes
// on to the factor step (`/sign-in/two-factor`), as after an emailed code. The answers are the same
// for every address, so the page never says whether one has an account.
import { RouterLink } from "@fin/frame";
import { AuthCard, Button, Field, InlineAlert, Input, TextButton } from "@fin/ui";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { sendSignInCode } from "../../api/contracts/auth.ts";
import { signInWithPassword } from "../../api/contracts/passwords.ts";
import { codeOf, commonAlert, type Failure, failureOf } from "../../api/failures.ts";
import { ceremonyApi } from "../../api/library.ts";
import { withNext } from "../../auth/after-sign-in.ts";
import { isPasswordPaused } from "../../auth/passwords.ts";
import { rememberEmail } from "../../auth/pending.ts";
import { AlertFrom, TEXT_LINK } from "../../components/auth.tsx";

type Alert =
  | null
  | "wrongPassword"
  | "tooManyTries"
  | "didntWork"
  | "passwordPaused"
  | "pausedLinkRefused"
  | "tooManyEmails"
  | Failure;

export interface PasswordStepProps {
  email: string;
  next: string | null;
  /** Back to the start, keeping the address ("Change"). */
  onChange: () => void;
  /** Signed in: the caller reads the viewer and goes where its gate says. */
  onSignedIn: () => Promise<void>;
}

function alertFor(alert: Alert, emailLink: () => void, sending: boolean) {
  switch (alert) {
    case null:
      return null;
    case "wrongPassword":
      return (
        <InlineAlert tone="danger" title="That email and password don’t match." live="assertive">
          Try again, or email yourself a sign-in link.
        </InlineAlert>
      );
    case "tooManyTries":
      return (
        <InlineAlert
          tone="warning"
          title="Too many attempts. Try again in a few minutes."
          live="polite"
        >
          You can still use a passkey or a sign-in link.
        </InlineAlert>
      );
    case "didntWork":
      return (
        <InlineAlert tone="danger" title="That didn’t work." live="assertive">
          Try again in a moment.
        </InlineAlert>
      );
    case "passwordPaused":
      return (
        <InlineAlert
          tone="warning"
          title="Too many wrong passwords. Try again later."
          live="polite"
          action={
            <Button variant="secondary" size="sm" loading={sending} onClick={emailLink}>
              Email me a sign-in link
            </Button>
          }
        >
          You can still use a passkey or a sign-in link.
        </InlineAlert>
      );
    case "pausedLinkRefused":
      return (
        <InlineAlert
          tone="warning"
          title="No sign-in link was sent. Try again later."
          live="polite"
        >
          Password sign-in is paused too. You can still use a passkey.
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

export function PasswordStep(props: PasswordStepProps) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [alert, setAlert] = useState<Alert>(null);
  const [busy, setBusy] = useState<"signIn" | "link" | null>(null);
  const paused = useRef(false);

  const signIn = async () => {
    if (busy !== null) return;
    if (password === "") {
      setAlert("wrongPassword");
      return;
    }
    setBusy("signIn");
    setAlert(null);
    try {
      await ceremonyApi()(signInWithPassword, { email: props.email, password });
      await props.onSignedIn();
    } catch (error) {
      setPassword("");
      if (isPasswordPaused(error)) {
        paused.current = true;
        setAlert("passwordPaused");
      } else if (codeOf(error) === "INVALID_EMAIL_OR_PASSWORD") {
        setAlert("wrongPassword");
      } else if (codeOf(error) === "PASSWORD_TOO_LONG") {
        setAlert("wrongPassword");
      } else if (codeOf(error) === "unavailable") {
        setAlert("didntWork");
      } else {
        const failure = failureOf(error);
        setAlert(failure === "rateLimited" ? "tooManyTries" : failure);
      }
    } finally {
      setBusy(null);
    }
  };

  const emailLink = async () => {
    if (busy !== null) return;
    setBusy("link");
    setAlert(null);
    try {
      await ceremonyApi()(sendSignInCode, { email: props.email, type: "sign-in" });
      rememberEmail(props.email);
      await router.navigate({ href: withNext("/sign-in/code", props.next) });
    } catch (error) {
      const failure = failureOf(error);
      if (failure === "rateLimited") {
        setAlert(paused.current ? "pausedLinkRefused" : "tooManyEmails");
      } else {
        setAlert(failure);
      }
    } finally {
      setBusy(null);
    }
  };

  const confirmEmail = async () => {
    rememberEmail(props.email);
    await router.navigate({ href: "/verify-email" });
  };

  return (
    <AuthCard
      title="Enter your password"
      description={
        <>
          {props.email} · <TextButton onClick={props.onChange}>Change</TextButton>
        </>
      }
    >
      {alertFor(alert, () => void emailLink(), busy === "link")}
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void signIn();
        }}
      >
        {/* The address the password goes with, for password managers; not a control. */}
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={props.email}
          readOnly
          hidden
        />
        <Field
          label="Password"
          labelAside={
            <RouterLink
              href="/reset-password"
              className={TEXT_LINK}
              onClick={() => rememberEmail(props.email)}
            >
              Forgot password?
            </RouterLink>
          }
        >
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onValueChange={(value) => setPassword(value)}
            disabled={busy === "signIn"}
          />
        </Field>
        <div className="flex flex-col gap-3">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy === "signIn"}
            {...(busy === "link" ? { disabledReason: "Sending a sign-in link." } : {})}
          >
            Sign in
          </Button>
          <Button
            variant="ghost"
            size="lg"
            loading={busy === "link"}
            {...(busy === "signIn" ? { disabledReason: "Signing in." } : {})}
            onClick={() => void emailLink()}
          >
            Email me a sign-in link instead
          </Button>
          {alert === "wrongPassword" ? (
            <Button variant="ghost" size="lg" onClick={() => void confirmEmail()}>
              Just signed up? Confirm your email
            </Button>
          ) : null}
        </div>
      </form>
    </AuthCard>
  );
}
