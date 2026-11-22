// Choose a new password (NewPassword board; spec 02 §5.7, stretch 2). The emailed link carries the
// address and the code in its fragment (`#e=<email>&c=<code>`), never in a path or query: the page
// reads it once, removes it from the address bar and keeps both in memory only. It first asks
// whether this browser asked for that reset; the code works only there ("This link can't be used
// here" anywhere else). Saving signs the person out everywhere, then signs this browser in with
// the new password, on to the factor step when they have a factor.
import type { ConsoleViewer } from "@fin/app-contracts";
import { useFin } from "@fin/frame";
import { AuthCard, Button, Field, InlineAlert, Input } from "@fin/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { resetCodeLink, resetPassword, signInWithPassword } from "../../api/contracts/passwords.ts";
import { codeOf, commonAlert, type Failure, failureOf } from "../../api/failures.ts";
import { ceremonyApi } from "../../api/library.ts";
import { destinationAfterSignIn } from "../../auth/after-sign-in.ts";
import { type CodeLink, parseCodeLink, takeFragment } from "../../auth/fragment.ts";
import {
  charactersShort,
  PASSWORD_HELPER,
  type PasswordProblem,
  passwordError,
  passwordProblemOf,
  usePasswordsOffered,
} from "../../auth/passwords.ts";
import { forgetEmail, rememberEmail } from "../../auth/pending.ts";
import { AlertFrom, AuthLoading } from "../../components/auth.tsx";
import { NoPasswords } from "../-passwords/ResetParts.tsx";

export const Route = createFileRoute("/reset-password/new")({
  staticData: { frame: "auth", navId: null, pageName: "Choose a new password" },
  pendingComponent: AuthLoading,
  component: NewPasswordPage,
});

type Mode =
  | { kind: "checking"; link: CodeLink }
  | { kind: "form"; link: CodeLink }
  | { kind: "unusable"; link: CodeLink | null }
  | { kind: "elsewhere"; link: CodeLink };

type Alert = null | "codeFailed" | "tooManyTries" | Failure;

const CODE_FAILED = new Set(["INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS", "USER_NOT_FOUND"]);

function alertFor(alert: Alert) {
  switch (alert) {
    case null:
      return null;
    case "codeFailed":
      return (
        <InlineAlert tone="danger" title="That code didn’t work." live="assertive">
          Check the latest email from Fin, or send a new one. Codes expire, and three wrong tries
          cancel one.
        </InlineAlert>
      );
    case "tooManyTries":
      return (
        <InlineAlert
          tone="warning"
          title="Too many attempts. Try again in a few minutes."
          live="polite"
        />
      );
    default:
      return <AlertFrom alert={commonAlert(alert)} />;
  }
}

function NewPasswordPage() {
  const fin = useFin<ConsoleViewer>();
  const router = useRouter();
  const passwords = usePasswordsOffered();
  const fragment = useRef<string | null>(null);
  if (fragment.current === null) fragment.current = takeFragment();
  const [mode, setMode] = useState<Mode>(() => {
    const link = parseCodeLink(fragment.current ?? "");
    return link === null ? { kind: "unusable", link: null } : { kind: "checking", link };
  });
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<PasswordProblem | null>(null);
  const [alert, setAlert] = useState<Alert>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mode.kind !== "checking") return;
    const link = mode.link;
    let live = true;
    void ceremonyApi()(resetCodeLink, { email: link.email }).then(
      (answer) => {
        if (!live) return;
        if (answer.state === "asking") setMode({ kind: "form", link });
        else if (answer.state === "elsewhere") setMode({ kind: "elsewhere", link });
        else setMode({ kind: "unusable", link });
      },
      (error: unknown) => {
        if (!live) return;
        // The check could not be made: the form, and the server decides at "Save".
        setMode({ kind: "form", link });
        setAlert(failureOf(error));
      },
    );
    return () => {
      live = false;
    };
  }, [mode]);

  const sendNewLink = async (link: CodeLink | null) => {
    if (link !== null) rememberEmail(link.email);
    await router.navigate({ href: "/reset-password" });
  };

  const save = async (link: CodeLink) => {
    if (saving) return;
    if (charactersShort(password) > 0) {
      setProblem("short");
      return;
    }
    setSaving(true);
    setAlert(null);
    try {
      await ceremonyApi()(resetPassword, { email: link.email, otp: link.code, password });
    } catch (error) {
      setSaving(false);
      const named = passwordProblemOf(error);
      const code = codeOf(error);
      if (named !== null) setProblem(named);
      else if (code !== null && CODE_FAILED.has(code)) setAlert("codeFailed");
      else {
        const failure = failureOf(error);
        setAlert(failure === "rateLimited" ? "tooManyTries" : failure);
      }
      return;
    }
    // Saved: every session ended. Sign this browser in with the new password.
    forgetEmail();
    try {
      await ceremonyApi()(signInWithPassword, { email: link.email, password });
      const href = await destinationAfterSignIn(fin, null);
      await router.navigate({ href, replace: true });
    } catch {
      // The password is saved; signing in is left to the sign-in page.
      await router.navigate({ href: "/sign-in", replace: true });
    }
  };

  if (passwords === null || mode.kind === "checking") return <AuthLoading />;
  if (!passwords) return <NoPasswords />;

  if (mode.kind === "unusable") {
    return (
      <AuthCard
        title="This link can’t be used"
        description="It has expired, was already used, or was opened without its code."
      >
        <Button variant="primary" size="lg" onClick={() => void sendNewLink(mode.link)}>
          Send a new link
        </Button>
      </AuthCard>
    );
  }

  if (mode.kind === "elsewhere") {
    return (
      <AuthCard title="This link can’t be used here">
        <InlineAlert
          tone="warning"
          title="This link was opened in a different browser from the one that asked for it."
        >
          Open it there, or send a new link from this browser.
        </InlineAlert>
        <Button variant="primary" size="lg" onClick={() => void sendNewLink(mode.link)}>
          Send a new link
        </Button>
      </AuthCard>
    );
  }

  const link = mode.link;
  return (
    <AuthCard
      title="Choose a new password"
      description={
        <>
          For <span className="font-medium text-text-primary">{link.email}</span>.
        </>
      }
    >
      {alertFor(alert)}
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save(link);
        }}
      >
        {/* The address the new password goes with, for password managers; not a control. */}
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={link.email}
          readOnly
          hidden
        />
        <Field
          label="New password"
          helper={PASSWORD_HELPER}
          {...(problem === null ? {} : { error: passwordError(problem, password) })}
        >
          <Input
            type="password"
            name="new-password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onValueChange={(value) => {
              setPassword(value);
              if (problem !== null) setProblem(null);
            }}
            disabled={saving}
          />
        </Field>
        <InlineAlert tone="info" title="Saving signs you out on every other device." />
        <Button type="submit" variant="primary" size="lg" loading={saving}>
          Save and sign in
        </Button>
      </form>
    </AuthCard>
  );
}
