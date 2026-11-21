// What the two factor-step pages share (TwoFactor and BackupCode boards; spec 02 §5.4, §6.2): the
// guard that keeps them for a session at the factor step, the passkey ceremony, where to go once a
// factor passed, and the dialogs that end the step (too many wrong codes, too slow, paused). A right
// code or passkey raises the session to `aal2`; the page then reads the viewer again.
import type { ConsoleViewer } from "@fin/app-contracts";
import { type FinRouterContext, signInHref, signOut, useFin } from "@fin/frame";
import { FingerprintIcon } from "@fin/icons";
import { Button, InlineAlert, Modal } from "@fin/ui";
import { redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { commonAlert, type Failure, failureOf } from "../api/failures.ts";
import { ceremonyApi } from "../api/library.ts";
import { destinationAfterSignIn, stepFor } from "../auth/after-sign-in.ts";
import { authenticateWithPasskey, isCeremonyError } from "../auth/webauthn.ts";
import { AlertFrom } from "./auth.tsx";

/**
 * Leaves a part-finished sign-in for a fresh one: the session at the factor step is ended first
 * (the sign-in page would send it straight back), then the page loads `/sign-in` afresh.
 */
export async function startOver(): Promise<void> {
  const ended = await signOut({ app: "console" });
  if (!ended) window.location.assign("/sign-in");
}

/** Only a session at the factor step stays; everyone else goes where their gate says. */
export function guardFactorStep({
  context,
  search,
}: {
  context: FinRouterContext<ConsoleViewer>;
  search: { next?: string };
}): void {
  const viewer = context.fin.viewer.get();
  const next = search.next ?? null;
  let href: string | null = null;
  if (viewer === null) {
    href = signInHref({ pathname: "/", search: "" }, context.fin.routeExists);
  } else if (viewer.gate !== "factor_step") {
    const step = stepFor(viewer, next, context.fin.routeExists);
    href = step.kind === "go" ? step.href : "/";
  }
  if (href !== null) {
    throw redirect({ href, replace: true } as unknown as Parameters<typeof redirect>[0]);
  }
}

/** Whether the viewer allows the "Trust this browser" box (absent at the factor step: no). */
export function canTrust(viewer: ConsoleViewer | null): boolean {
  if (viewer === null) return false;
  return "canTrustBrowser" in viewer && viewer.canTrustBrowser === true;
}

export function readNext(search: Record<string, unknown>): { next?: string } {
  return typeof search.next === "string" && search.next !== "" ? { next: search.next } : {};
}

export type StepDialog = null | "usedUp" | "timedOut" | "paused";

export type StepAlert =
  | null
  | "wrongCode"
  | "noPasskey"
  | "passkeyFailed"
  | "passkeyRemoved"
  | "noCodes"
  | Failure;

/** The factor-step state a page holds: the alert, the dialog, the passkey and the finish. */
export function useFactorStep(next: string | null) {
  const fin = useFin<ConsoleViewer>();
  const router = useRouter();
  const [alert, setAlert] = useState<StepAlert>(null);
  const [dialog, setDialog] = useState<StepDialog>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const finish = async () => {
    const href = await destinationAfterSignIn(fin, next);
    await router.navigate({ href, replace: true });
  };

  /** A failed code or call: the alert, or the dialog that ends the step. */
  const failed = (error: unknown): Failure => {
    const failure = failureOf(error);
    if (failure === "signedOut") setDialog("timedOut");
    else if (failure === "paused") setDialog("paused");
    else if (failure === "rateLimited" || failure === "usedUp") setDialog("usedUp");
    else if (failure === "wrongCode") setAlert("wrongCode");
    else setAlert(failure);
    return failure;
  };

  const tryPasskey = async () => {
    setPasskeyBusy(true);
    setAlert(null);
    try {
      await authenticateWithPasskey(ceremonyApi());
      await finish();
    } catch (error) {
      if (isCeremonyError(error, "cancelled") || isCeremonyError(error, "aborted"))
        setAlert("noPasskey");
      else if (isCeremonyError(error)) setAlert("passkeyFailed");
      else {
        const failure = failureOf(error);
        if (failure === "passkeyRemoved") setAlert("passkeyRemoved");
        else if (failure === "passkeyRefused" || failure === "wrongCode") setAlert("passkeyFailed");
        else failed(error);
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  return { fin, alert, setAlert, dialog, setDialog, passkeyBusy, tryPasskey, finish, failed };
}

/** The alert a factor-step page draws for anything but a wrong code (each page words its own). */
export function stepAlert(alert: StepAlert, passkeyRemovedLine: string) {
  switch (alert) {
    case null:
    case "wrongCode":
    case "noCodes":
      return null;
    case "noPasskey":
      return (
        <InlineAlert tone="info" title="No passkey was used." live="polite">
          Try again, or choose another way.
        </InlineAlert>
      );
    case "passkeyFailed":
    case "passkeyRefused":
      return (
        <InlineAlert tone="danger" title="That passkey didn’t work." live="assertive">
          Try again, or choose another way.
        </InlineAlert>
      );
    case "passkeyRemoved":
      return (
        <InlineAlert
          tone="danger"
          title="That passkey was removed from your account."
          live="assertive"
        >
          {passkeyRemovedLine}
        </InlineAlert>
      );
    default:
      return <AlertFrom alert={commonAlert(alert)} />;
  }
}

/** The dialogs that end the factor step: sign in again for a fresh prompt. */
export function StepDialogs(props: {
  dialog: StepDialog;
  onClose: () => void;
  onPasskey?: (() => void) | undefined;
}) {
  if (props.dialog === null) return null;
  const again = (
    <>
      <Button variant="secondary" onClick={props.onClose}>
        Not now
      </Button>
      <Button variant="primary" onClick={startOver}>
        Sign in again
      </Button>
    </>
  );
  if (props.dialog === "paused") {
    return (
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
        title="Your authenticator and backup codes are paused for an hour"
        description="Too many wrong codes were entered. Use a passkey instead."
        footer={
          props.onPasskey === undefined ? (
            <Button variant="secondary" onClick={props.onClose}>
              Close
            </Button>
          ) : (
            <Button
              variant="primary"
              leadingIcon={<FingerprintIcon />}
              onClick={() => {
                props.onClose();
                props.onPasskey?.();
              }}
            >
              Use my passkey
            </Button>
          )
        }
      />
    );
  }
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={props.dialog === "usedUp" ? "Too many wrong codes" : "That took too long"}
      description="Sign in again to get a fresh prompt."
      footer={again}
    />
  );
}
