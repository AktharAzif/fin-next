// SecretReveal and SecretRevealDialog (spec 06 §3.3; the export's SecretReveal spec): a secret is
// shown once. The flow is otp, generating, then ready (the secret, a block CopyField and "I've saved
// it"), or failed with Retry; masked shows only the last four characters. How and when a secret may
// be shown is the screen's rule, not this component's. Closing the dialog without saving asks first.
import { type ReactNode, useState } from "react";
import { Button } from "../foundation/button.tsx";
import { Checkbox } from "../foundation/checkbox.tsx";
import { CopyField } from "../foundation/copy-field.tsx";
import { InlineAlert } from "../foundation/inline-alert.tsx";
import { SkeletonSection } from "../foundation/skeleton.tsx";
import { cn } from "../lib/cn.ts";
import { ConfirmDialog, Modal } from "./modal.tsx";

export type SecretRevealStatus = "otp" | "generating" | "failed" | "ready" | "masked";

export type SecretRevealProps = {
  status: SecretRevealStatus;
  /** "Sandbox" or "Production": keys are per environment. */
  environment: string;
  clientId?: string;
  /** Present only in `ready`. Never kept in the client after this view. */
  secret?: string;
  /** For `masked`. */
  secretLastFour?: string;
  /** The OTP step: an OTPInput wired to the API's confirm call. */
  otp?: ReactNode;
  error?: string;
  onRetry?: () => unknown;
  onCancel?: () => void;
  onDone?: () => void;
  className?: string;
};

export function SecretReveal(props: SecretRevealProps) {
  const [saved, setSaved] = useState(false);
  return (
    <div
      data-slot="secret-reveal"
      data-status={props.status}
      className={cn("flex flex-col gap-6", props.className)}
    >
      {props.status === "otp" ? props.otp : null}
      {props.status === "generating" ? (
        <SkeletonSection label="your key" rows={2} heading={false} />
      ) : null}
      {props.status === "failed" ? (
        <InlineAlert
          tone="danger"
          title="Couldn’t create the key"
          live="assertive"
          action={
            props.onRetry === undefined ? undefined : (
              <Button variant="secondary" size="sm" onClick={() => props.onRetry?.()}>
                Try again
              </Button>
            )
          }
        >
          {props.error ?? "Check your connection and try again."}
        </InlineAlert>
      ) : null}
      {props.status === "ready" || props.status === "masked" ? (
        <div className="flex flex-col gap-4">
          {props.status === "ready" ? (
            <InlineAlert tone="highlight" title="Copy your secret now">
              You won’t be able to see it again.
            </InlineAlert>
          ) : null}
          {props.clientId === undefined ? null : (
            <CopyField
              variant="block"
              label={`${props.environment} client ID`}
              value={props.clientId}
            />
          )}
          {props.status === "ready" && props.secret !== undefined ? (
            <CopyField
              variant="block"
              label={`${props.environment} client secret`}
              value={props.secret}
            />
          ) : null}
          {props.status === "masked" ? (
            <div className="flex flex-col gap-2">
              <span className="text-label-sm text-text-secondary">{`${props.environment} client secret`}</span>
              <span className="rounded-md bg-surface-subtle px-3 py-2.5 font-mono text-mono text-text-secondary">
                {`•••• ${props.secretLastFour ?? ""}`}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {props.status === "ready" ? (
        <Checkbox
          label="I’ve saved the secret somewhere safe"
          checked={saved}
          onCheckedChange={(next) => setSaved(next === true)}
        />
      ) : null}
      {props.status === "otp" || props.status === "generating" ? null : (
        <div className="flex flex-wrap justify-end gap-2">
          {props.status === "failed" && props.onCancel !== undefined ? (
            <Button variant="secondary" onClick={props.onCancel}>
              Cancel
            </Button>
          ) : null}
          {props.status === "ready" || props.status === "masked" ? (
            <Button
              {...(props.status === "ready" && !saved
                ? { disabledReason: "Tick “I’ve saved the secret” first." }
                : {})}
              onClick={() => props.onDone?.()}
            >
              Done
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export type SecretRevealDialogProps = SecretRevealProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
};

export function SecretRevealDialog(props: SecretRevealDialogProps) {
  const { open, onOpenChange, title, ...panel } = props;
  const [asking, setAsking] = useState(false);
  const close = () => {
    onOpenChange(false);
    props.onDone?.();
  };
  return (
    <>
      <Modal
        open={open}
        title={title ?? `${props.environment} API key`}
        busy={props.status === "generating"}
        onOpenChange={(next) => {
          if (!next && props.status === "ready") {
            setAsking(true);
            return;
          }
          onOpenChange(next);
        }}
      >
        <SecretReveal {...panel} onDone={close} />
      </Modal>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Close without copying?"
        description="The secret is shown once. Without it you’ll need to create a new key."
        confirmLabel="Close without copying"
        tone="danger"
        onConfirm={() => {
          setAsking(false);
          close();
        }}
      />
    </>
  );
}
