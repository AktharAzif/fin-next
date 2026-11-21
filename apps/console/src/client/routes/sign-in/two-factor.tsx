// Sign in · second factor (TwoFactor board; spec 02 §5.4, §6.2): an emailed-code sign-in of a
// person with a factor stops here at `aal1`. The authenticator code, or the passkey (`?with=passkey`,
// or when the passkey is the only method), or a backup code on its own page. "Trust this browser
// for 30 days" is offered only when the viewer says the person may trust one ([SA-31]).
import { useStore } from "@fin/frame";
import { FingerprintIcon } from "@fin/icons";
import {
  AuthCard,
  Button,
  Checkbox,
  InlineAlert,
  OTPInput,
  type OTPStatus,
  TextButton,
} from "@fin/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { TOTP_CODE_LENGTH, totpVerify } from "../../api/contracts/auth.ts";
import { ceremonyApi } from "../../api/library.ts";
import { withNext } from "../../auth/after-sign-in.ts";
import { passkeysSupported } from "../../auth/webauthn.ts";
import { AuthLoading, QuietLink } from "../../components/auth.tsx";
import {
  canTrust,
  guardFactorStep,
  StepDialogs,
  startOver,
  stepAlert,
  useFactorStep,
} from "../../components/factor-step.tsx";

export const Route = createFileRoute("/sign-in/two-factor")({
  staticData: { frame: "auth", navId: null, pageName: "Confirm it’s you" },
  validateSearch: (search: Record<string, unknown>): { next?: string; with?: "passkey" } => ({
    ...(typeof search.next === "string" && search.next !== "" ? { next: search.next } : {}),
    ...(search.with === "passkey" ? { with: "passkey" as const } : {}),
  }),
  beforeLoad: guardFactorStep,
  pendingComponent: AuthLoading,
  component: TwoFactorPage,
});

function TwoFactorPage() {
  const search = Route.useSearch();
  const next = search.next ?? null;
  const step = useFactorStep(next);
  const viewer = useStore(step.fin.viewer);
  const methods = viewer !== null && viewer.gate === "factor_step" ? viewer.methods : [];
  const hasPasskey = methods.includes("passkey") && passkeysSupported();
  const hasCode = methods.includes("authenticator");
  const hasBackup = methods.includes("backup_code");
  const passkeyOnly = hasPasskey && (search.with === "passkey" || !hasCode);
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const verify = async (value: string) => {
    if (value.length !== TOTP_CODE_LENGTH || verifying) return;
    setVerifying(true);
    step.setAlert(null);
    try {
      await ceremonyApi()(totpVerify, {
        code: value,
        ...(trust && canTrust(viewer) ? { trustDevice: true } : {}),
      });
      await step.finish();
    } catch (error) {
      step.failed(error);
      setAttempt((n) => n + 1);
    } finally {
      setVerifying(false);
    }
  };

  const dialogs = (
    <StepDialogs
      dialog={step.dialog}
      onClose={() => step.setDialog(null)}
      onPasskey={hasPasskey ? step.tryPasskey : undefined}
    />
  );

  if (passkeyOnly) {
    return (
      <>
        <AuthCard title="Confirm it’s you" description="Use your passkey to finish signing in.">
          {step.alert === "noPasskey" ? (
            <InlineAlert tone="info" title="No passkey was used." live="polite">
              Try again, or go back to sign in.
            </InlineAlert>
          ) : (
            stepAlert(step.alert, "Delete it from your password manager, and choose another way.")
          )}
          <Button
            variant="primary"
            size="lg"
            leadingIcon={<FingerprintIcon />}
            loading={step.passkeyBusy}
            onClick={step.tryPasskey}
          >
            Use my passkey
          </Button>
          <p className="m-0 text-body text-text-secondary">
            {hasCode ? (
              <QuietLink href={withNext("/sign-in/two-factor", next)}>
                Use my authenticator app
              </QuietLink>
            ) : (
              <TextButton onClick={startOver}>Back to sign in</TextButton>
            )}
          </p>
        </AuthCard>
        {dialogs}
      </>
    );
  }

  const status: OTPStatus = verifying
    ? "verifying"
    : step.alert === "wrongCode"
      ? "invalid"
      : "idle";

  return (
    <>
      <AuthCard
        title="Confirm it’s you"
        description="Enter the 6-digit code from your authenticator app."
      >
        {step.alert === "wrongCode" ? (
          <InlineAlert tone="danger" title="That code isn’t right." live="assertive">
            Codes change every 30 seconds. Check your device’s clock.
          </InlineAlert>
        ) : (
          stepAlert(step.alert, "Delete it from your password manager, and choose another way.")
        )}
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void verify(code);
          }}
        >
          <OTPInput
            key={`totp-${attempt}`}
            label="Authenticator code"
            length={TOTP_CODE_LENGTH}
            autoFocus
            status={status}
            onValueChange={setCode}
            onComplete={(value) => void verify(value)}
          />
          {canTrust(viewer) ? (
            <Checkbox
              label="Trust this browser for 30 days"
              checked={trust}
              onCheckedChange={(checked) => setTrust(checked === true)}
            />
          ) : null}
          <Button type="submit" variant="primary" size="lg" loading={verifying}>
            Verify and continue
          </Button>
        </form>
        {hasPasskey || hasBackup ? (
          <div className="flex flex-col gap-3 border-t border-border pt-5">
            <p className="m-0 text-label-sm text-text-secondary">Other ways to confirm</p>
            <div className="flex flex-wrap items-center gap-3">
              {hasPasskey ? (
                <Button
                  variant="ghost"
                  leadingIcon={<FingerprintIcon />}
                  loading={step.passkeyBusy}
                  onClick={step.tryPasskey}
                >
                  Use my passkey instead
                </Button>
              ) : null}
              {hasBackup ? (
                <QuietLink href={withNext("/sign-in/backup-code", next)}>
                  Enter a backup code
                </QuietLink>
              ) : null}
            </div>
          </div>
        ) : null}
      </AuthCard>
      {dialogs}
    </>
  );
}
