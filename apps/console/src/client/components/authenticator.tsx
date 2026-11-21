// The authenticator set-up and the backup codes (Authenticator board; spec 02 §5.4), shared by
// /welcome/authenticator and Account security's dialog. `/two-factor/enable` answers the
// `otpauth://` URI once with the 10 backup codes; the URI is drawn as a QR code in the browser
// (@fin/ui's QrCode, UR-13: SVG elements, never an image or a third-party service) beside the key
// in groups of four for manual entry, which stays whatever the QR code does; the first right code
// turns the app on; then the codes are shown once, to copy or download, and never again.
import { CheckIcon, CopyIcon, DownloadSimpleIcon } from "@fin/icons";
import { Button, Checkbox, InlineAlert, OTPInput, type OTPStatus, QrCode, useCopy } from "@fin/ui";
import { type ReactNode, useState } from "react";
import { TOTP_CODE_LENGTH } from "../api/contracts/auth.ts";
import { commonAlert, failureOf } from "../api/failures.ts";
import { AlertFrom } from "./auth.tsx";

/** The base32 secret of an `otpauth://` URI, upper case, or null. */
export function secretOf(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "otpauth:") return null;
    const secret = (url.searchParams.get("secret") ?? "").replace(/[\s=]/g, "").toUpperCase();
    return /^[A-Z2-7]+$/.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

/** "JBSWY3DPEHPK3PXP" as "JBSW Y3DP EHPK 3PXP": groups of four for typing. */
export function groupKey(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(" ");
}

/** The text of `fin-backup-codes.txt`. */
export function backupCodesText(codes: readonly string[]): string {
  return [
    "Fin backup codes",
    "Each code signs you in once if you lose your authenticator app.",
    "",
    ...codes,
    "",
  ].join("\n");
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function CopyButton(props: { value: string; label: string; copiedLabel?: string }) {
  const { state, copy } = useCopy(props.value);
  return (
    <Button
      variant="secondary"
      size="sm"
      leadingIcon={state === "copied" ? <CheckIcon /> : <CopyIcon />}
      onClick={copy}
    >
      {state === "copied" ? (props.copiedLabel ?? "Copied") : props.label}
    </Button>
  );
}

export interface AuthenticatorScanProps {
  uri: string;
  /** Sends the code (`/two-factor/verify-totp`); throws the api() error when it fails. */
  verify: (code: string) => Promise<void>;
  /** Called once the code was right and the app is on. */
  onVerified: () => void;
  /** The footer's other action ("Back", "Cancel"). */
  secondary?: ReactNode;
}

/** Step one and two: the key, and the code it shows. */
export function AuthenticatorScan(props: AuthenticatorScanProps) {
  const secret = secretOf(props.uri);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<OTPStatus>("idle");
  const [alert, setAlert] = useState<null | "wrongCode" | ReturnType<typeof failureOf>>(null);
  const [attempt, setAttempt] = useState(0);

  const verify = async (value: string) => {
    if (value.length !== TOTP_CODE_LENGTH || status === "verifying") return;
    setStatus("verifying");
    setAlert(null);
    try {
      await props.verify(value);
      setStatus("success");
      props.onVerified();
    } catch (error) {
      const failure = failureOf(error);
      setAlert(failure === "wrongCode" ? "wrongCode" : failure);
      setStatus(failure === "wrongCode" ? "invalid" : "idle");
      setAttempt((n) => n + 1);
    }
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void verify(code);
      }}
    >
      {alert === "wrongCode" ? (
        <InlineAlert tone="danger" title="That code isn’t right." live="assertive">
          Codes change every 30 seconds. Check your device’s clock.
        </InlineAlert>
      ) : alert === null ? null : (
        <AlertFrom alert={commonAlert(alert)} />
      )}
      <section aria-labelledby="authenticator-key" className="flex flex-col gap-3">
        <h2 id="authenticator-key" className="m-0 text-label text-text-primary">
          1. Scan this with your authenticator app
        </h2>
        {secret === null ? (
          <InlineAlert tone="danger" title="Couldn’t read the key">
            Start again to get a new one.
          </InlineAlert>
        ) : (
          // The key sits beside the QR code, and wraps under it where the well is narrow.
          <div className="flex flex-wrap items-center gap-4 rounded-md bg-surface-subtle p-4">
            <QrCode value={props.uri} label="QR code for your authenticator app" />
            <div className="flex min-w-0 shrink grow basis-44 flex-col gap-2">
              <p className="m-0 text-body text-text-secondary">
                Can’t scan? Type this key instead.
              </p>
              {/* Wraps between the groups of four, never inside one, so each group reads whole. */}
              <p
                data-testid="authenticator-key"
                className="m-0 font-mono text-mono text-text-primary"
              >
                {groupKey(secret)}
              </p>
              <div className="pt-1">
                <CopyButton value={secret} label="Copy key" />
              </div>
            </div>
          </div>
        )}
      </section>
      <OTPInput
        key={`setup-${attempt}`}
        label="2. Enter the 6-digit code it shows"
        length={TOTP_CODE_LENGTH}
        status={status === "success" ? "verifying" : status}
        onValueChange={(value) => {
          setCode(value);
          if (status === "invalid") setStatus("idle");
        }}
        onComplete={(value) => void verify(value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={status === "verifying" || status === "success"}
          disabled={secret === null}
        >
          Verify and turn on
        </Button>
        {props.secondary}
      </div>
    </form>
  );
}

/** The backup codes, shown once: copy, download, tick, done. */
export function BackupCodesPanel(props: {
  codes: readonly string[];
  onDone: () => void;
  doneLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <ul
          aria-label="Backup codes"
          className="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-2 rounded-md bg-surface-subtle p-4 font-mono text-mono text-text-primary"
        >
          {props.codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={props.codes.join("\n")} label="Copy codes" />
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<DownloadSimpleIcon />}
            onClick={() => download("fin-backup-codes.txt", backupCodesText(props.codes))}
          >
            Download .txt
          </Button>
        </div>
      </div>
      <Checkbox
        label="I saved these codes somewhere safe"
        checked={saved}
        onCheckedChange={(checked) => setSaved(checked === true)}
      />
      <div className="flex flex-col gap-3">
        <Button
          variant="primary"
          size="lg"
          {...(saved ? {} : { disabledReason: "Tick “I saved these codes somewhere safe” first." })}
          onClick={props.onDone}
        >
          {props.doneLabel ?? "Done"}
        </Button>
        <p className="m-0 text-caption text-text-tertiary">
          This is the only time Fin shows these codes. Generating new ones cancels them.
        </p>
      </div>
    </div>
  );
}
