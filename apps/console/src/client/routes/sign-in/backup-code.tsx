// Sign in · backup code (BackupCode board; spec 02 §5.4): one of the 10 codes saved when the
// authenticator was set up; each works once. A person with no backup codes is told so and offered
// the passkey.
import { useStore } from "@fin/frame";
import { FingerprintIcon } from "@fin/icons";
import { AuthCard, Button, Field, InlineAlert, Input } from "@fin/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { backupCodeVerify } from "../../api/contracts/auth.ts";
import { ceremonyApi } from "../../api/library.ts";
import { withNext } from "../../auth/after-sign-in.ts";
import { guardFactorStep, readNext } from "../../auth/guards.ts";
import { passkeysSupported } from "../../auth/webauthn.ts";
import { AuthLoading, QuietLink } from "../../components/auth.tsx";
import { StepDialogs, stepAlert, useFactorStep } from "../../components/factor-step.tsx";

export const Route = createFileRoute("/sign-in/backup-code")({
  staticData: { frame: "auth", navId: null, pageName: "Enter a backup code" },
  validateSearch: readNext,
  beforeLoad: guardFactorStep,
  pendingComponent: AuthLoading,
  component: BackupCodePage,
});

function BackupCodePage() {
  const next = Route.useSearch().next ?? null;
  const step = useFactorStep(next);
  const viewer = useStore(step.fin.viewer);
  const methods = viewer !== null && viewer.gate === "factor_step" ? viewer.methods : [];
  const hasPasskey = methods.includes("passkey") && passkeysSupported();
  const hasCode = methods.includes("authenticator");
  const noCodes = !methods.includes("backup_code");
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const verify = async () => {
    const value = code.trim();
    if (value === "" || verifying) return;
    setVerifying(true);
    step.setAlert(null);
    try {
      await ceremonyApi()(backupCodeVerify, { code: value });
      await step.finish();
    } catch (error) {
      step.failed(error);
      input.current?.select();
    } finally {
      setVerifying(false);
    }
  };

  return (
    <>
      <AuthCard
        title="Enter a backup code"
        description="Use one of the 10 codes you saved when you set up your second factor. Each one works once."
      >
        {noCodes ? (
          <InlineAlert tone="info" title="This account has no backup codes." live="polite">
            They come with an authenticator app. Use your passkey instead.
          </InlineAlert>
        ) : null}
        {step.alert === "wrongCode" ? (
          <InlineAlert tone="danger" title="That backup code isn’t right." live="assertive">
            Each code works once.
          </InlineAlert>
        ) : (
          stepAlert(step.alert, "Delete it from your password manager, and choose another way.")
        )}
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
        >
          <Field label="Backup code">
            <Input
              ref={input}
              name="backup-code"
              autoComplete="one-time-code"
              spellCheck={false}
              className="font-mono text-mono"
              value={code}
              onValueChange={(value) => setCode(value)}
              disabled={noCodes || verifying}
              {...(step.alert === "wrongCode" ? { "aria-invalid": true } : {})}
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={verifying} disabled={noCodes}>
            Verify and continue
          </Button>
        </form>
        {hasCode || hasPasskey ? (
          <div className="flex flex-col gap-3 border-t border-border pt-5">
            <p className="m-0 text-label-sm text-text-secondary">Other ways to confirm</p>
            <div className="flex flex-wrap items-center gap-3">
              {hasCode ? (
                <QuietLink href={withNext("/sign-in/two-factor", next)}>
                  Use my authenticator app
                </QuietLink>
              ) : null}
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
            </div>
          </div>
        ) : null}
      </AuthCard>
      <StepDialogs
        dialog={step.dialog}
        onClose={() => step.setDialog(null)}
        onPasskey={hasPasskey ? step.tryPasskey : undefined}
      />
    </>
  );
}
