// "Reset second factors" on the Staff page (AdminStaff, states `resetFactors` and `resetCodeShown`;
// spec 02 §10.2, §10.4, §15.3, §15.4, [SA-14]): for a member who has lost every factor. The row's
// control, the confirmation (danger: their passkeys and authenticator go and they are signed out at
// once), "Confirm it's you" for the intent the server names (its line: "Use your second factor to
// reset mei.tanaka@example.com’s second factors."), then the new enrolment code, shown once, to hand
// over in person. The server decides; this asks, reports, and reads the list again afterwards.
//
// @pendingDesign UR-26: the board does not draw the reset yet; composed from the kit's ConfirmDialog,
// Modal, InlineAlert and CopyField as the board's other enrolment-code dialogs are.
import type { StaffViewer } from "@fin/app-contracts";
import { useFin } from "@fin/frame";
import { Button, ConfirmDialog, CopyField, InlineAlert, Modal, toast } from "@fin/ui";
import { useRouter } from "@tanstack/react-router";
import { type ReactElement, type ReactNode, useState } from "react";
import type { StaffMember } from "../../../api/contracts.ts";
import { formatEnrolmentCode } from "../../../auth/inputs.ts";
import { formatTimeUtc } from "../../../format.ts";
import { actorOf } from "../../../staff/dialogs.tsx";
import type { StaffData } from "../../../staff/load.ts";
import { withStepUpSubject } from "../../../step-up/reasons.ts";
import { resetStaffFactors } from "./contract.ts";
import { resetError } from "./messages.ts";
import { resetControl } from "./rules.ts";

/** The new enrolment code after a reset: who it is for, the code, and until when it works. */
export interface ResetIssued {
  readonly email: string;
  readonly code: string;
  readonly expiresAt: string;
}

export const RESET_CONFIRM =
  "They’re signed out of Fin Admin at once, and their passkeys and authenticator app stop working. You get a new enrolment code to hand them.";

/** The row's control: "Reset factors", or nothing for a pending member with no second factor yet. */
export function ResetFactorsButton(props: {
  member: StaffMember;
  /** From resetControl: undefined draws nothing, null is enabled, a string is why not. */
  reason: string | null | undefined;
  onOpen: (member: StaffMember) => void;
}) {
  if (props.reason === undefined) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`Reset factors for ${props.member.email}`}
      {...(props.reason === null ? {} : { disabledReason: props.reason })}
      onClick={() => props.onOpen(props.member)}
    >
      Reset factors
    </Button>
  );
}

/** The confirmation, then the request (with "Confirm it's you"); the dialog says any refusal. */
export function ResetFactorsDialog(props: {
  member: StaffMember | null;
  onClose: () => void;
  onReset: (issued: ResetIssued) => void;
  /** The list on screen is out of date (the member went, or changed): read it again. */
  onStale: () => void;
}) {
  const fin = useFin();
  const member = props.member;
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [shownFor, setShownFor] = useState<string | null>(member?.id ?? null);
  if ((member?.id ?? null) !== shownFor) {
    setShownFor(member?.id ?? null);
    setMessage(undefined);
  }

  return (
    <ConfirmDialog
      open={member !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={`Reset ${member?.email ?? ""}’s second factors?`}
      description={RESET_CONFIRM}
      confirmLabel="Reset second factors"
      tone="danger"
      busy={busy}
      {...(message === undefined ? {} : { error: message })}
      onConfirm={async () => {
        if (member === null) return;
        setMessage(undefined);
        setBusy(true);
        try {
          const answer = await withStepUpSubject({ email: member.email }, () =>
            fin.api(resetStaffFactors, { staffId: member.id }),
          );
          props.onReset({
            email: member.email,
            code: answer.enrolmentCode,
            expiresAt: answer.expiresAt,
          });
        } catch (error) {
          const refused = resetError(error);
          if (refused.message !== null) setMessage(refused.message);
          if (refused.stale) props.onStale();
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/**
 * The new enrolment code, shown once (spec 02 §6.5, §15.4): never by email; the Admin hands it over.
 * Closing the dialog drops it from the page for good.
 */
export function ResetCodeDialog(props: { issued: ResetIssued | null; onDone: () => void }) {
  const issued = props.issued;
  const until = issued === null ? null : formatTimeUtc(issued.expiresAt);
  return (
    <Modal
      open={issued !== null}
      onOpenChange={(open) => {
        if (!open) props.onDone();
      }}
      title="Second factors reset"
      description={`Hand this code to ${issued?.email ?? ""} yourself. It works once, for 30 minutes.`}
      footer={
        <Button variant="primary" onClick={props.onDone}>
          Done
        </Button>
      }
    >
      <InlineAlert tone="highlight" title="Copy the code now">
        You won’t be able to see it again.{until === null ? "" : ` It works until ${until}.`}
      </InlineAlert>
      {issued === null ? null : (
        <CopyField
          variant="block"
          label="Enrolment code"
          value={formatEnrolmentCode(issued.code)}
        />
      )}
      <p className="m-0 text-caption text-text-tertiary">
        They’re signed out of Fin Admin, and they and every Admin are emailed.
      </p>
    </Modal>
  );
}

/**
 * The reset wired into the Staff page: the row control for StaffPage's `rowAction`, and the two
 * dialogs. The code dialog is drawn whatever the list's state: the code is shown once, and a list
 * that cannot load after the reset must not take it off the screen.
 */
export function useFactorReset(data: StaffData): {
  rowAction: ((member: StaffMember) => ReactNode) | undefined;
  dialogs: ReactElement;
} {
  const fin = useFin<StaffViewer>();
  const router = useRouter();
  const [resetting, setResetting] = useState<StaffMember | null>(null);
  const [issued, setIssued] = useState<ResetIssued | null>(null);
  const viewer = fin.viewer.get();
  const reload = () => {
    void router.invalidate();
  };

  const rowAction =
    viewer?.state === "ok" && data.kind === "ready"
      ? (member: StaffMember) => (
          <ResetFactorsButton
            member={member}
            reason={resetControl(actorOf(viewer), member, data.staff, data.roles)}
            onOpen={setResetting}
          />
        )
      : undefined;

  const dialogs = (
    <>
      <ResetFactorsDialog
        member={resetting}
        onClose={() => setResetting(null)}
        onReset={(code) => {
          setResetting(null);
          setIssued(code);
          reload();
        }}
        onStale={reload}
      />
      <ResetCodeDialog
        issued={issued}
        onDone={() => {
          const done = issued;
          setIssued(null);
          if (done !== null) {
            toast.success({
              title: "Second factors reset",
              description: `${done.email} sets up a second factor again with the code you handed them.`,
            });
          }
        }}
      />
    </>
  );
  return { rowAction, dialogs };
}
