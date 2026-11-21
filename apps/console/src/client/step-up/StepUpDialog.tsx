// The root StepUp dialog, "Confirm it's you" (StepUp board; spec 02 §7.1 to §7.5, §15.5): the
// console's content for the frame's StepUpHost. It leads with the passkey when the browser can use
// one and the answer offers it, then the authenticator code, then a backup code. Each ceremony
// carries `Fin-Step-Up-Intent` (nothing for a window) through a ceremony client, so a wrong code is
// told apart from a lost session; once it passes, the frame re-sends the action once. The dialog's
// two notices ("Add a second factor first", "Sign in by email to add a second factor") ask for no
// proof. The checks are the server's: this dialog only runs the ceremony it is asked for.
import type { ConsoleViewer, StepUpRequired } from "@fin/app-contracts";
import { RouterLink, type StepUpContentProps, useFin, useStore } from "@fin/frame";
import { FingerprintIcon } from "@fin/icons";
import {
  Button,
  buttonClasses,
  Field,
  InlineAlert,
  Input,
  Modal,
  OTPInput,
  type OTPStatus,
} from "@fin/ui";
import { useRouter } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import {
  backupCodeVerify,
  sendSignInCode,
  TOTP_CODE_LENGTH,
  totpVerify,
} from "../api/contracts/auth.ts";
import { commonAlert, type Failure, failureOf } from "../api/failures.ts";
import { ceremonyApi } from "../api/library.ts";
import { rememberEmail } from "../auth/pending.ts";
import { authenticateWithPasskey, isCeremonyError, passkeysSupported } from "../auth/webauthn.ts";
import { reasonLine } from "./reasons.ts";

type Mode = "code" | "backup";

type Alert =
  | null
  | "wrongCode"
  | "wrongBackup"
  | "passkeyFailed"
  | "noPasskeyUsed"
  | "paused"
  | "noPasskeySupport"
  | Exclude<Failure, "wrongCode" | "paused">;

/** The sign-in page's message after the fifth wrong try ended the session (spec 02 §7.7). */
export const SIGNED_OUT_TRIES = "/sign-in?error=too_many_tries";

function Divider() {
  return (
    <div className="flex items-center gap-3 text-caption text-text-tertiary" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function ProofDialog({
  required,
  status,
  prove,
  close,
}: {
  required: StepUpRequired;
  status: "asking" | "sending" | "invalid" | "failed";
  prove: (intentId: string | null) => void;
  close: () => void;
}) {
  // The line is fixed when the dialog opens: the page's values are its own (spec 02 §15.5).
  const line = useMemo(() => reasonLine(required.reason_key), [required.reason_key]);
  const passkey = required.methods.includes("passkey") && passkeysSupported();
  const hasCode = required.methods.includes("authenticator");
  const hasBackup = required.methods.includes("backup_code");
  const [mode, setMode] = useState<Mode>(hasCode ? "code" : "backup");
  const [alert, setAlert] = useState<Alert>(
    required.methods.includes("passkey") && !passkeysSupported() && !hasCode && !hasBackup
      ? "noPasskeySupport"
      : null,
  );
  const [busy, setBusy] = useState<"passkey" | "code" | "backup" | null>(null);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState("");
  const [attempt, setAttempt] = useState(0);
  const backupRef = useRef<HTMLInputElement>(null);
  const intentId = required.step_up_kind === "intent" ? (required.intent_id ?? null) : null;
  const sending = status === "sending";
  const paused = alert === "paused";

  const fail = (error: unknown, wrong: "wrongCode" | "wrongBackup") => {
    const failure = failureOf(error);
    if (failure === "signedOut") {
      // The fifth wrong try ended the session: a full load, so nothing signed-in stays in memory.
      window.location.assign(SIGNED_OUT_TRIES);
      return;
    }
    if (failure === "wrongCode" || failure === "usedUp") setAlert(wrong);
    else if (failure === "paused") setAlert("paused");
    else if (failure === "passkeyRefused" || failure === "passkeyRemoved")
      setAlert("passkeyFailed");
    else setAlert(failure);
    setAttempt((n) => n + 1);
  };

  const tryPasskey = async () => {
    setBusy("passkey");
    setAlert(null);
    try {
      await authenticateWithPasskey(ceremonyApi(intentId));
      prove(intentId);
    } catch (error) {
      if (isCeremonyError(error, "cancelled") || isCeremonyError(error, "aborted"))
        setAlert("noPasskeyUsed");
      else if (isCeremonyError(error)) setAlert("passkeyFailed");
      else fail(error, "wrongCode");
    } finally {
      setBusy(null);
    }
  };

  const verifyCode = async (value: string) => {
    if (value.length !== TOTP_CODE_LENGTH || busy !== null) return;
    setBusy("code");
    setAlert(null);
    try {
      await ceremonyApi(intentId)(totpVerify, { code: value });
      prove(intentId);
    } catch (error) {
      fail(error, "wrongCode");
    } finally {
      setBusy(null);
    }
  };

  const verifyBackup = async () => {
    const value = backup.trim();
    if (value === "" || busy !== null) return;
    setBusy("backup");
    setAlert(null);
    try {
      await ceremonyApi(intentId)(backupCodeVerify, { code: value });
      prove(intentId);
    } catch (error) {
      fail(error, "wrongBackup");
      backupRef.current?.select();
    } finally {
      setBusy(null);
    }
  };

  const otpStatus: OTPStatus =
    busy === "code" ? "verifying" : alert === "wrongCode" ? "invalid" : "idle";

  const outcome =
    status === "invalid" ? (
      <InlineAlert tone="danger" title="That didn’t work. Try again." live="assertive">
        Close this and do it again.
      </InlineAlert>
    ) : status === "failed" ? (
      <InlineAlert tone="danger" title="That didn’t go through." live="assertive">
        Close this and try again.
      </InlineAlert>
    ) : null;

  const shared =
    alert === null ||
    alert === "wrongCode" ||
    alert === "wrongBackup" ||
    alert === "paused" ? null : alert === "passkeyFailed" ? (
      <InlineAlert tone="danger" title="That passkey didn’t work." live="assertive">
        Try again, or choose another way.
      </InlineAlert>
    ) : alert === "noPasskeyUsed" ? (
      <InlineAlert tone="info" title="No passkey was used." live="polite">
        Try again, or choose another way.
      </InlineAlert>
    ) : alert === "noPasskeySupport" ? (
      <InlineAlert tone="info" title="This browser can’t use passkeys." live="polite">
        Use your authenticator app or a backup code instead.
      </InlineAlert>
    ) : (
      <InlineAlert {...commonAlert(alert)} />
    );

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      busy={busy !== null || sending}
      title="Confirm it’s you"
      description={line}
      footer={
        <Button variant="secondary" disabled={busy !== null || sending} onClick={close}>
          {outcome === null ? "Cancel" : "Close"}
        </Button>
      }
    >
      {outcome ?? (
        <>
          {shared}
          {passkey ? (
            <Button
              variant="primary"
              leadingIcon={<FingerprintIcon />}
              loading={busy === "passkey"}
              disabled={sending || (busy !== null && busy !== "passkey")}
              onClick={tryPasskey}
            >
              Use your passkey
            </Button>
          ) : null}
          {passkey && (hasCode || hasBackup) ? <Divider /> : null}
          {mode === "code" && hasCode ? (
            <div className="flex flex-col gap-4">
              {alert === "wrongCode" ? (
                <InlineAlert tone="danger" title="That code isn’t right." live="assertive">
                  Codes change every 30 seconds. Check your device’s clock.
                </InlineAlert>
              ) : null}
              {paused ? (
                <InlineAlert
                  tone="warning"
                  title="Your authenticator and backup codes are paused for an hour."
                  live="polite"
                >
                  Too many wrong codes were entered. Use a passkey instead.
                </InlineAlert>
              ) : null}
              <OTPInput
                key={`code-${attempt}`}
                label="Authenticator code"
                length={TOTP_CODE_LENGTH}
                autoFocus={!passkey}
                status={otpStatus}
                disabled={paused || sending}
                onValueChange={setCode}
                onComplete={(value) => void verifyCode(value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={passkey ? "secondary" : "primary"}
                  loading={busy === "code"}
                  disabled={sending || (busy !== null && busy !== "code")}
                  {...(paused
                    ? {
                        disabledReason:
                          "Your authenticator and backup codes are paused for an hour.",
                      }
                    : {})}
                  onClick={() => verifyCode(code)}
                >
                  Verify code
                </Button>
                {hasBackup ? (
                  <Button
                    variant="ghost"
                    disabled={sending || busy !== null}
                    {...(paused
                      ? {
                          disabledReason:
                            "Your authenticator and backup codes are paused for an hour.",
                        }
                      : {})}
                    onClick={() => {
                      setMode("backup");
                      setAlert(null);
                    }}
                  >
                    Enter a backup code
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {mode === "backup" && hasBackup ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void verifyBackup();
              }}
            >
              {alert === "wrongBackup" ? (
                <InlineAlert tone="danger" title="That backup code isn’t right." live="assertive">
                  Each code works once.
                </InlineAlert>
              ) : null}
              {paused ? (
                <InlineAlert
                  tone="warning"
                  title="Your authenticator and backup codes are paused for an hour."
                  live="polite"
                >
                  Too many wrong codes were entered. Use a passkey instead.
                </InlineAlert>
              ) : null}
              <Field label="Backup code">
                <Input
                  ref={backupRef}
                  value={backup}
                  onValueChange={(value) => setBackup(value)}
                  autoComplete="one-time-code"
                  spellCheck={false}
                  className="font-mono text-mono"
                  disabled={paused || sending}
                  {...(alert === "wrongBackup" ? { "aria-invalid": true } : {})}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  variant={passkey ? "secondary" : "primary"}
                  loading={busy === "backup"}
                  disabled={sending || (busy !== null && busy !== "backup") || paused}
                >
                  Verify backup code
                </Button>
                {hasCode ? (
                  <Button
                    variant="ghost"
                    disabled={sending || busy !== null}
                    onClick={() => {
                      setMode("code");
                      setAlert(null);
                    }}
                  >
                    Use my authenticator app
                  </Button>
                ) : null}
              </div>
            </form>
          ) : null}
        </>
      )}
    </Modal>
  );
}

function SetUpFirst({ close }: { close: () => void }) {
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Add a second factor first"
      description="This needs a passkey or an authenticator app on your account. It takes a minute."
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Not now
          </Button>
          <RouterLink
            href="/account/security"
            className={buttonClasses("primary", "md")}
            onClick={close}
          >
            Open Account security
          </RouterLink>
        </>
      }
    />
  );
}

export function SignInByEmail({ close, next }: { close: () => void; next: string }) {
  const fin = useFin<ConsoleViewer>();
  const viewer = useStore(fin.viewer);
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const email = viewer !== null && viewer.gate !== "factor_step" ? viewer.user.email : null;

  const send = async () => {
    if (email === null) return;
    setSending(true);
    setFailed(false);
    try {
      await ceremonyApi()(sendSignInCode, { email, type: "sign-in" });
      rememberEmail(email);
      close();
      await router.navigate({ href: `/sign-in/code?${new URLSearchParams({ next }).toString()}` });
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      busy={sending}
      title="Sign in by email to add a second factor"
      description="A first second factor can be added in the 15 minutes after you sign in by email."
      footer={
        <>
          <Button variant="secondary" disabled={sending} onClick={close}>
            Not now
          </Button>
          <Button variant="primary" loading={sending} onClick={send}>
            Email me a sign-in link
          </Button>
        </>
      }
    >
      {failed ? (
        <InlineAlert tone="danger" title="The email couldn’t be sent." live="assertive">
          Try again.
        </InlineAlert>
      ) : undefined}
    </Modal>
  );
}

export function StepUpDialog({ state, prove, close }: StepUpContentProps) {
  if (state.kind === "notice") {
    return state.notice === "second_factor_required" ? (
      <SetUpFirst close={close} />
    ) : (
      <SignInByEmail close={close} next="/account/security" />
    );
  }
  return (
    <ProofDialog
      key={state.required.intent_id ?? state.required.reason_key}
      required={state.required}
      status={state.status}
      prove={prove}
      close={close}
    />
  );
}
