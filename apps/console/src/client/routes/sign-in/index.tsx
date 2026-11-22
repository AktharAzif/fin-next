// Sign in (SignIn board; spec 02 §5.2, §5.3, §15.2): the passkey button and the email field's
// passkey autofill first, then the work email, which sends an emailed code and opens the code
// page. `?error=` says why the person is here (signed out, or after too many wrong tries); `?next=`
// is kept, if it is a path of this app, for after the sign-in. "Continue with Google" shows only
// when Google is on (stretch 5, §5.8); its round trip comes back here with `?via=google`, or with
// the refusal in `?error=`. Passwords are stretch 2, not built here.
import type { ConsoleViewer } from "@fin/app-contracts";
import { useFin } from "@fin/frame";
import { FingerprintIcon } from "@fin/icons";
import { AuthCard, Button, Field, InlineAlert, Input } from "@fin/ui";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { sendSignInCode } from "../../api/contracts/auth.ts";
import { commonAlert, type Failure, failureOf } from "../../api/failures.ts";
import { ceremonyApi } from "../../api/library.ts";
import { destinationAfterSignIn, stepFor, withNext } from "../../auth/after-sign-in.ts";
import { looksLikeEmail, rememberEmail } from "../../auth/pending.ts";
import {
  authenticateWithPasskey,
  autofillSupported,
  cancelPasskeyCeremony,
  isCeremonyError,
  passkeysSupported,
} from "../../auth/webauthn.ts";
import { AlertFrom, AuthLoading, LeadLink, OrRule } from "../../components/auth.tsx";
import { GoogleButton, GoogleRefusal } from "../-google/GoogleButton.tsx";
import { type GoogleError, isGoogleError } from "../-google/google.ts";

const ERRORS = ["signed_out", "too_many_tries"] as const;

export interface SignInSearch {
  next?: string;
  error?: (typeof ERRORS)[number] | GoogleError;
  /** Back from Google's round trip, signed in (stretch 5). */
  via?: "google";
}

function readSignInSearch(search: Record<string, unknown>): SignInSearch {
  const out: SignInSearch = {};
  if (typeof search.next === "string" && search.next !== "") out.next = search.next;
  if (typeof search.error === "string" && (ERRORS as readonly string[]).includes(search.error)) {
    out.error = search.error as (typeof ERRORS)[number];
  } else if (isGoogleError(search.error)) {
    out.error = search.error;
  }
  if (search.via === "google") out.via = "google";
  return out;
}

type Alert =
  | null
  | "signedOut"
  | "signedOutTries"
  | "noPasskey"
  | "passkeyFailed"
  | "passkeyRemoved"
  | "tooManyEmails"
  | Failure;

export const Route = createFileRoute("/sign-in/")({
  staticData: { frame: "auth", navId: null, pageName: "Sign in" },
  validateSearch: readSignInSearch,
  // Someone already signed in goes on: to the factor step, Protect your account, or the page.
  beforeLoad: ({ context, search }) => {
    const viewer = context.fin.viewer.get() as ConsoleViewer | null;
    if (viewer === null) return;
    const step = stepFor(viewer, search.next ?? null, context.fin.routeExists);
    if (step.kind === "go") {
      throw redirect({ href: step.href, replace: true } as unknown as Parameters<
        typeof redirect
      >[0]);
    }
  },
  pendingComponent: AuthLoading,
  component: SignInPage,
});

function alertFor(alert: Alert) {
  switch (alert) {
    case null:
      return null;
    case "signedOut":
      return (
        <InlineAlert tone="info" title="You were signed out." live="polite">
          Sign in to pick up where you left off.
        </InlineAlert>
      );
    case "signedOutTries":
      return (
        <InlineAlert
          tone="warning"
          title="You were signed out after too many wrong tries."
          live="polite"
        >
          Sign in again to continue.
        </InlineAlert>
      );
    case "noPasskey":
      return (
        <InlineAlert tone="info" title="No passkey was used." live="polite">
          Try again, or continue with your email.
        </InlineAlert>
      );
    case "passkeyFailed":
    case "passkeyRefused":
      return (
        <InlineAlert tone="danger" title="That passkey didn’t work." live="assertive">
          Try again, or continue with your email.
        </InlineAlert>
      );
    case "passkeyRemoved":
      return (
        <InlineAlert tone="danger" title="That passkey was removed from Fin." live="assertive">
          Delete it from your password manager, and continue with your email.
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

function SignInPage() {
  const fin = useFin<ConsoleViewer>();
  const router = useRouter();
  const search = Route.useSearch();
  const next = search.next ?? null;
  const [alert, setAlert] = useState<Alert>(
    search.error === "too_many_tries"
      ? "signedOutTries"
      : search.error === "signed_out"
        ? "signedOut"
        : null,
  );
  const [email, setEmail] = useState("");
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [busy, setBusy] = useState<"passkey" | "email" | null>(null);
  const supported = passkeysSupported();
  const mounted = useRef(true);
  const googleError = isGoogleError(search.error) ? search.error : null;
  // Back from Google signed in, with no page to go to yet (no organisation): finish here.
  const [finishingGoogle, setFinishingGoogle] = useState(
    search.via === "google" && fin.viewer.get() !== null,
  );

  const finish = async () => {
    const href = await destinationAfterSignIn(fin, next);
    await router.navigate({ href, replace: true });
  };

  useEffect(() => {
    if (!finishingGoogle) return;
    finish().catch((error: unknown) => {
      if (!mounted.current) return;
      setFinishingGoogle(false);
      setAlert(failureOf(error));
    });
  }, []);

  const passkeyFailure = (error: unknown) => {
    if (isCeremonyError(error, "aborted")) return;
    if (isCeremonyError(error, "cancelled")) setAlert("noPasskey");
    else if (isCeremonyError(error)) setAlert("passkeyFailed");
    else {
      const failure = failureOf(error);
      setAlert(failure === "wrongCode" ? "passkeyFailed" : failure);
    }
  };

  // Conditional UI: a saved passkey offered in the email field's autofill signs in at once. Until
  // the person picks one, nothing the autofill request meets is theirs to hear about.
  useEffect(() => {
    mounted.current = true;
    let live = true;
    let chosen = false;
    void (async () => {
      if (!supported || !(await autofillSupported()) || !live) return;
      try {
        await authenticateWithPasskey(ceremonyApi(), {
          autofill: true,
          onChosen: () => {
            chosen = true;
          },
        });
        if (live) await finish();
      } catch (error) {
        if (live && chosen) passkeyFailure(error);
      }
    })();
    return () => {
      live = false;
      mounted.current = false;
      cancelPasskeyCeremony();
    };
  }, []);

  const withPasskey = async () => {
    setBusy("passkey");
    setAlert(null);
    try {
      await authenticateWithPasskey(ceremonyApi());
      await finish();
    } catch (error) {
      passkeyFailure(error);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const withEmail = async () => {
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setEmailInvalid(true);
      return;
    }
    setEmailInvalid(false);
    setBusy("email");
    setAlert(null);
    try {
      await ceremonyApi()(sendSignInCode, { email: address, type: "sign-in" });
      rememberEmail(address);
      await router.navigate({ href: withNext("/sign-in/code", next) });
    } catch (error) {
      const failure = failureOf(error);
      setAlert(failure === "rateLimited" ? "tooManyEmails" : failure);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  if (finishingGoogle) return <AuthLoading />;

  return (
    <AuthCard
      title="Sign in to Fin"
      description={
        <LeadLink text="New to Fin?" href={withNext("/sign-up", next)}>
          Create an account
        </LeadLink>
      }
    >
      {alertFor(alert)}
      {alert === null && googleError !== null ? <GoogleRefusal error={googleError} /> : null}
      {supported ? (
        <>
          <Button
            variant="secondary"
            size="lg"
            leadingIcon={<FingerprintIcon />}
            loading={busy === "passkey"}
            disabled={busy === "email"}
            onClick={withPasskey}
          >
            Sign in with a passkey
          </Button>
          <GoogleButton
            page="/sign-in"
            next={next}
            disabled={busy !== null}
            onFailure={(failure) => setAlert(failure)}
          />
          <OrRule />
        </>
      ) : (
        <GoogleButton
          page="/sign-in"
          next={next}
          disabled={busy !== null}
          rule
          onFailure={(failure) => setAlert(failure)}
        />
      )}
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void withEmail();
        }}
      >
        <Field
          label="Work email"
          {...(emailInvalid ? { error: "That email address doesn’t look right." } : {})}
        >
          <Input
            type="email"
            name="email"
            autoComplete="username webauthn"
            value={email}
            onValueChange={(value) => setEmail(value)}
            disabled={busy === "email"}
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy === "email"}
          disabled={busy === "passkey"}
        >
          Continue
        </Button>
      </form>
    </AuthCard>
  );
}
