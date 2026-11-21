// Protect your account (ProtectAccount board; spec 02 §5.1 step 3, §6.2, §6.3): the first second
// factor, passkey first. A person held for want of one (privileged anywhere, [SA-05]) gets no
// "Skip for now" and is told why; the server holds them at this gate regardless. The first factor
// is added under the first-factor rule (a session that proved the mailbox in the last 15 minutes),
// so a stale session is asked to sign in by email first.
import type { ConsoleViewer } from "@fin/app-contracts";
import { RouterLink, safeNext, useFin, useStore } from "@fin/frame";
import { DeviceMobileIcon, FingerprintIcon } from "@fin/icons";
import { AuthCard, InlineAlert } from "@fin/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { codeOf, commonAlert, type Failure, failureOf } from "../../api/failures.ts";
import { ceremonyApi } from "../../api/library.ts";
import { destinationAfterSignIn, withNext } from "../../auth/after-sign-in.ts";
import { isCeremonyError, passkeysSupported, registerPasskey } from "../../auth/webauthn.ts";
import { AlertFrom, AuthLoading, TEXT_LINK } from "../../components/auth.tsx";
import { readNext } from "../../components/factor-step.tsx";
import { OptionButton, OptionLink } from "../../components/OptionCard.tsx";
import { guardWelcome } from "../../components/welcome.ts";
import { SignInByEmail } from "../../step-up/StepUpDialog.tsx";

export const Route = createFileRoute("/welcome/secure")({
  staticData: { frame: "auth", navId: null, pageName: "Protect your account" },
  validateSearch: readNext,
  beforeLoad: guardWelcome,
  pendingComponent: AuthLoading,
  component: ProtectAccountPage,
});

type Alert = null | "noPasskey" | "passkeyFailed" | "noPasskeySupport" | Failure;

function ProtectAccountPage() {
  const fin = useFin<ConsoleViewer>();
  const router = useRouter();
  const viewer = useStore(fin.viewer);
  const next = Route.useSearch().next ?? null;
  const supported = passkeysSupported();
  const [alert, setAlert] = useState<Alert>(supported ? null : "noPasskeySupport");
  const [adding, setAdding] = useState(false);
  const [byEmail, setByEmail] = useState(false);
  const canSkip = viewer !== null && viewer.gate !== "factor_step" && viewer.canSkipProtect;

  const addPasskey = async () => {
    setAdding(true);
    setAlert(null);
    try {
      await registerPasskey(ceremonyApi());
      const href = await destinationAfterSignIn(fin, next);
      await router.navigate({ href, replace: true });
    } catch (error) {
      if (isCeremonyError(error, "cancelled") || isCeremonyError(error, "aborted"))
        setAlert("noPasskey");
      else if (isCeremonyError(error)) setAlert("passkeyFailed");
      else if (codeOf(error) === "fresh_session_required") setByEmail(true);
      else {
        const failure = failureOf(error);
        setAlert(failure === "passkeyRefused" ? "passkeyFailed" : failure);
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <AuthCard
        title="Protect your account"
        description="Add a second way to prove it’s you. You need one to create or delete an organisation, and before going to Production."
      >
        {canSkip ? null : (
          <InlineAlert tone="info" title="Your role needs a second factor.">
            You’re a Super admin or Admin of an organisation, so Fin asks for one before anything
            else. It takes a minute.
          </InlineAlert>
        )}
        {alert === null ? null : alert === "noPasskey" ? (
          <InlineAlert tone="info" title="No passkey was added." live="polite">
            Try again, or use an authenticator app instead.
          </InlineAlert>
        ) : alert === "passkeyFailed" ? (
          <InlineAlert tone="danger" title="That passkey didn’t work." live="assertive">
            Try again, or use an authenticator app instead.
          </InlineAlert>
        ) : alert === "noPasskeySupport" ? (
          <InlineAlert tone="info" title="This browser can’t add a passkey." live="polite">
            Use an authenticator app instead, or open Fin in a browser that supports passkeys.
          </InlineAlert>
        ) : (
          <AlertFrom alert={commonAlert(alert)} />
        )}
        <div className="flex flex-col gap-3">
          {supported ? (
            <OptionButton
              icon={<FingerprintIcon />}
              title="Add a passkey"
              badge="Recommended"
              busy={adding}
              onClick={() => void addPasskey()}
            >
              Face ID, Touch ID, Windows Hello or a security key. Nothing to type, and it can’t be
              phished.
            </OptionButton>
          ) : null}
          <OptionLink
            icon={<DeviceMobileIcon />}
            title="Use an authenticator app"
            href={withNext("/welcome/authenticator", next)}
          >
            6-digit codes from an app such as 1Password, Authy or Google Authenticator.
          </OptionLink>
        </div>
        <div className="flex flex-col items-center gap-2 text-center">
          {canSkip ? (
            <RouterLink href={safeNext(next, fin.routeExists) ?? "/"} className={TEXT_LINK}>
              Skip for now
            </RouterLink>
          ) : null}
          <p className="m-0 text-caption text-text-tertiary">
            You can add both later from your account menu, under Account security.
          </p>
        </div>
      </AuthCard>
      {byEmail ? <SignInByEmail close={() => setByEmail(false)} next="/welcome/secure" /> : null}
    </>
  );
}
