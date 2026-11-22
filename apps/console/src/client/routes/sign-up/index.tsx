// Create your Fin account (SignUp board; spec 02 §5.1): the name and work email, then an emailed
// code. The answer is the same whether or not the address has an account (an existing one is told
// by email), so the page never says which. With an invitation waiting in the cookie, the address
// field says whom it is for. With passwords on (stretch 2, §5.7) the form asks for one too; the
// server checks its rule and keeps only its hash until the address is confirmed.
import { useFin } from "@fin/frame";
import { AuthCard, Button, Field, Input } from "@fin/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { signUp } from "../../api/contracts/auth.ts";
import { waitingInvitation } from "../../api/contracts/invitations.ts";
import { commonAlert, type Failure, failureOf, invalidFields } from "../../api/failures.ts";
import {
  charactersShort,
  PASSWORD_HELPER,
  type PasswordProblem,
  passwordError,
  passwordProblemOf,
  usePasswordsOffered,
} from "../../auth/passwords.ts";
import { looksLikeEmail, rememberEmail } from "../../auth/pending.ts";
import { AlertFrom, AuthLoading, LeadLink } from "../../components/auth.tsx";
import { NAME_RULE } from "../../format/text.ts";

export const Route = createFileRoute("/sign-up/")({
  staticData: { frame: "auth", navId: null, pageName: "Create your account" },
  pendingComponent: AuthLoading,
  component: SignUpPage,
});

function SignUpPage() {
  const fin = useFin();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [nameRefused, setNameRefused] = useState(false);
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [invitedFor, setInvitedFor] = useState<string | null>(null);
  const [alert, setAlert] = useState<Failure | null>(null);
  const [creating, setCreating] = useState(false);
  const passwords = usePasswordsOffered();
  const [password, setPassword] = useState("");
  const [passwordProblem, setPasswordProblem] = useState<PasswordProblem | null>(null);

  useEffect(() => {
    let live = true;
    fin.api(waitingInvitation, {}).then(
      (invitation) => {
        if (live && invitation !== null) setInvitedFor(invitation.emailMasked);
      },
      () => {
        // No invitation waiting in this browser: the plain form.
      },
    );
    return () => {
      live = false;
    };
  }, [fin]);

  const create = async () => {
    const badName = name.trim() === "";
    const badEmail = !looksLikeEmail(email);
    const shortPassword = passwords === true && charactersShort(password) > 0;
    setNameRefused(badName);
    setEmailInvalid(badEmail);
    setPasswordProblem(shortPassword ? "short" : null);
    if (badName || badEmail || shortPassword) return;
    setCreating(true);
    setAlert(null);
    try {
      await fin.api(signUp, {
        name: name.trim(),
        email: email.trim(),
        ...(passwords === true ? { password } : {}),
      });
      rememberEmail(email.trim());
      await router.navigate({ href: "/verify-email" });
    } catch (error) {
      const failure = failureOf(error);
      const problem = passwordProblemOf(error);
      if (problem !== null) {
        setPasswordProblem(problem);
      } else if (failure === "invalid") {
        const fields = invalidFields(error);
        setNameRefused(fields.has("name"));
        setEmailInvalid(fields.has("email"));
        if (!fields.has("name") && !fields.has("email")) setAlert("ourSide");
      } else {
        setAlert(failure);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <AuthCard
      title="Create your Fin account"
      description={
        <LeadLink text="Already have one?" href="/sign-in">
          Sign in
        </LeadLink>
      }
    >
      {alert === null ? null : <AlertFrom alert={commonAlert(alert)} />}
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Field label="Full name" {...(nameRefused ? { error: NAME_RULE } : {})}>
          <Input
            name="name"
            autoComplete="name"
            maxLength={60}
            value={name}
            onValueChange={(value) => setName(value)}
            disabled={creating}
          />
        </Field>
        <Field
          label="Work email"
          {...(emailInvalid ? { error: "That email address doesn’t look right." } : {})}
          {...(invitedFor === null ? {} : { helper: `The invitation is for ${invitedFor}.` })}
        >
          <Input
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onValueChange={(value) => setEmail(value)}
            disabled={creating}
          />
        </Field>
        {passwords === true ? (
          <Field
            label="Password"
            helper={PASSWORD_HELPER}
            {...(passwordProblem === null
              ? {}
              : { error: passwordError(passwordProblem, password) })}
          >
            <Input
              type="password"
              name="password"
              autoComplete="new-password"
              value={password}
              onValueChange={(value) => {
                setPassword(value);
                if (passwordProblem !== null) setPasswordProblem(null);
              }}
              disabled={creating}
            />
          </Field>
        ) : null}
        <Button type="submit" variant="primary" size="lg" loading={creating}>
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}
