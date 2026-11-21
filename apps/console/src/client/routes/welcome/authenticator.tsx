// Set up your authenticator (Authenticator board; spec 02 §5.4, §6.3): the first second factor as
// an authenticator app. The key is fetched once, typed into the app, proved with its first code,
// and then the 10 backup codes are shown once. A session past the first-factor window is asked to
// sign in by email first.
import type { ConsoleViewer } from "@fin/app-contracts";
import { RouterLink, useFin } from "@fin/frame";
import { ArrowLeftIcon } from "@fin/icons";
import { AuthCard, buttonClasses, ErrorState } from "@fin/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { totpEnable, totpVerify } from "../../api/contracts/auth.ts";
import { codeOf, failureOf, requestIdOf } from "../../api/failures.ts";
import { ceremonyApi } from "../../api/library.ts";
import { destinationAfterSignIn, withNext } from "../../auth/after-sign-in.ts";
import { AuthLoading } from "../../components/auth.tsx";
import { AuthenticatorScan, BackupCodesPanel } from "../../components/authenticator.tsx";
import { readNext } from "../../components/factor-step.tsx";
import { guardWelcome } from "../../components/welcome.ts";
import { SignInByEmail } from "../../step-up/StepUpDialog.tsx";

export const Route = createFileRoute("/welcome/authenticator")({
  staticData: { frame: "auth", navId: null, pageName: "Set up your authenticator" },
  validateSearch: readNext,
  beforeLoad: guardWelcome,
  pendingComponent: AuthLoading,
  component: AuthenticatorPage,
});

type Step =
  | { kind: "loading" }
  | { kind: "failed"; error: unknown }
  | { kind: "scan"; uri: string; codes: string[] }
  | { kind: "codes"; codes: string[] };

function AuthenticatorPage() {
  const fin = useFin<ConsoleViewer>();
  const router = useRouter();
  const next = Route.useSearch().next ?? null;
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [byEmail, setByEmail] = useState(false);
  const started = useRef(false);
  const back = withNext("/welcome/secure", next);

  const start = async () => {
    setStep({ kind: "loading" });
    try {
      const answer = await ceremonyApi()(totpEnable, {});
      setStep({ kind: "scan", uri: answer.totpURI, codes: answer.backupCodes });
    } catch (error) {
      if (codeOf(error) === "fresh_session_required") setByEmail(true);
      setStep({ kind: "failed", error });
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  });

  const done = async () => {
    const href = await destinationAfterSignIn(fin, next);
    await router.navigate({ href, replace: true });
  };

  const backLink = (
    <RouterLink href={back} className={buttonClasses("ghost", "lg")}>
      <ArrowLeftIcon />
      Back
    </RouterLink>
  );

  let body: ReactNode;
  if (step.kind === "loading") {
    return <AuthLoading />;
  }
  if (step.kind === "codes") {
    return (
      <AuthCard
        title="Save your backup codes"
        description="Each of these 10 codes signs you in once if you lose your authenticator. Keep them in a password manager."
      >
        <BackupCodesPanel codes={step.codes} onDone={() => void done()} />
      </AuthCard>
    );
  }
  if (step.kind === "failed") {
    body = (
      <ErrorState
        size="inline"
        title="Couldn’t start the set-up"
        description={
          failureOf(step.error) === "offline"
            ? "You’re offline. Check your connection and try again."
            : "Try again in a moment."
        }
        onRetry={start}
        {...(requestIdOf(step.error) === undefined
          ? {}
          : { requestId: requestIdOf(step.error) as string })}
      />
    );
  } else {
    body = (
      <AuthenticatorScan
        uri={step.uri}
        verify={async (code) => {
          await ceremonyApi()(totpVerify, { code });
        }}
        onVerified={() => setStep({ kind: "codes", codes: step.codes })}
        secondary={backLink}
      />
    );
  }

  return (
    <>
      <AuthCard
        title="Set up your authenticator"
        description="Two steps. Codes change every 30 seconds."
      >
        {body}
        {step.kind === "failed" ? <div>{backLink}</div> : null}
      </AuthCard>
      {byEmail ? (
        <SignInByEmail close={() => setByEmail(false)} next="/welcome/authenticator" />
      ) : null}
    </>
  );
}
