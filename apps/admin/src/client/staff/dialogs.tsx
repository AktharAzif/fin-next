// The Staff page's dialogs (AdminStaff board; spec 02 §10.2, §15.3, §15.4): Add staff, Change role,
// Remove from staff, a pending member's new enrolment code, and the code itself, shown once. Each
// change goes through api(), which asks the root "Confirm it's you" for the intent the server names
// and sends the change again once; the dialog's subject gives that dialog its line ("Use your second
// factor to add mei.tanaka@example.com to staff."). The server decides; these only ask and report.
import type { StaffViewerSignedIn } from "@fin/app-contracts";
import { useFin } from "@fin/frame";
import { Button, ConfirmDialog, CopyField, Field, InlineAlert, Input, Modal } from "@fin/ui";
import { useRef, useState } from "react";
import {
  addStaff,
  changeStaffRole,
  newEnrolmentCode,
  removeStaff,
  type StaffMember,
  type StaffRole,
} from "../api/contracts.ts";
import { formatEnrolmentCode, normaliseEmail } from "../auth/inputs.ts";
import { type RoleChoice, RolePicker } from "../components/RolePicker.tsx";
import { formatTimeUtc } from "../format.ts";
import { withStepUpSubject } from "../step-up/reasons.ts";
import { staffActionError } from "./messages.ts";
import { type Actor, defaultRoleKey, givingReason } from "./rules.ts";

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** An enrolment code to hand over: who it is for, the code, and until when it works. */
export interface IssuedCode {
  readonly email: string;
  readonly code: string;
  readonly expiresAt: string;
  /** "added" after Add staff, "reissued" after New enrolment code. */
  readonly reason: "added" | "reissued";
}

function choicesFor(actor: Actor, roles: readonly StaffRole[]): RoleChoice[] {
  return roles.map((role) => ({ role, disabledReason: givingReason(actor, role) }));
}

function labelOf(roles: readonly StaffRole[], key: string | null): string {
  return roles.find((role) => role.key === key)?.label ?? "";
}

function ErrorAlert({ message }: { message: string | null }) {
  if (message === null) return null;
  return <InlineAlert tone="danger" title={message} live="assertive" />;
}

export function actorOf(viewer: StaffViewerSignedIn): Actor {
  return {
    id: viewer.staff.id,
    roleKey: viewer.staff.roleKey,
    permissions: new Set(viewer.permissions),
  };
}

/** Add staff: the work email and the role, then the code once. */
export function AddStaffDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actor: Actor;
  roles: readonly StaffRole[];
  onAdded: (issued: IssuedCode, member: StaffMember) => void;
}) {
  const fin = useFin();
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState<string | null>(() =>
    defaultRoleKey(props.actor, props.roles),
  );
  const [emailError, setEmailError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setEmail("");
    setRoleKey(defaultRoleKey(props.actor, props.roles));
    setEmailError(null);
    setMessage(null);
  };

  const submit = async () => {
    const address = normaliseEmail(email);
    if (address === "") {
      setEmailError("Enter an email address.");
      emailRef.current?.focus();
      return;
    }
    if (address.length > 254 || !ADDRESS.test(address)) {
      setEmailError("Enter a work email address.");
      emailRef.current?.focus();
      return;
    }
    if (roleKey === null) {
      setMessage("Choose a role.");
      return;
    }
    setEmailError(null);
    setMessage(null);
    setBusy(true);
    try {
      const answer = await withStepUpSubject(
        { email: address, role: labelOf(props.roles, roleKey) },
        () => fin.api(addStaff, { email: address, roleKey }),
      );
      reset();
      props.onAdded(
        {
          email: answer.staff.email,
          code: answer.enrolmentCode,
          expiresAt: answer.expiresAt,
          reason: "added",
        },
        answer.staff,
      );
    } catch (error) {
      const refused = staffActionError(error, address);
      setMessage(refused.message);
      if (refused.emailError !== undefined) {
        setEmailError(refused.emailError);
        emailRef.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => {
        if (!open) reset();
        props.onOpenChange(open);
      }}
      title="Add staff"
      description="They sign in with this work email and an enrolment code you hand them."
      busy={busy}
      initialFocus={emailRef}
      footer={
        <>
          <Button variant="secondary" onClick={() => props.onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="add-staff" loading={busy}>
            Add staff
          </Button>
        </>
      }
    >
      <form
        id="add-staff"
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ErrorAlert message={message} />
        <Field label="Work email" {...(emailError === null ? {} : { error: emailError })}>
          <Input
            ref={emailRef}
            type="email"
            name="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            disabled={busy}
            onValueChange={(value) => {
              setEmail(value);
              if (emailError !== null) setEmailError(null);
            }}
          />
        </Field>
        <RolePicker
          label="Role"
          choices={choicesFor(props.actor, props.roles)}
          value={roleKey}
          onChange={setRoleKey}
          disabled={busy}
        />
      </form>
    </Modal>
  );
}

/** Change role: the member's address, the roles, and the change once confirmed. */
export function ChangeRoleDialog(props: {
  member: StaffMember | null;
  onClose: () => void;
  actor: Actor;
  roles: readonly StaffRole[];
  onChanged: (member: StaffMember) => void;
}) {
  const fin = useFin();
  const member = props.member;
  const [roleKey, setRoleKey] = useState<string | null>(member?.roleKey ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shownFor, setShownFor] = useState<string | null>(member?.id ?? null);
  if ((member?.id ?? null) !== shownFor) {
    setShownFor(member?.id ?? null);
    setRoleKey(member?.roleKey ?? null);
    setMessage(null);
  }

  const unchanged = member === null || roleKey === member.roleKey;
  const submit = async () => {
    if (member === null || roleKey === null || unchanged) return;
    setMessage(null);
    setBusy(true);
    try {
      const answer = await withStepUpSubject(
        { email: member.email, role: labelOf(props.roles, roleKey) },
        () => fin.api(changeStaffRole, { staffId: member.id, roleKey }),
      );
      props.onChanged(answer.staff);
    } catch (error) {
      setMessage(staffActionError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={member !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title="Change role"
      description={member?.email ?? ""}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="change-role"
            loading={busy}
            {...(unchanged ? { disabledReason: "Choose a different role." } : {})}
          >
            Change role
          </Button>
        </>
      }
    >
      <form
        id="change-role"
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ErrorAlert message={message} />
        <RolePicker
          label="Role"
          choices={choicesFor(props.actor, props.roles)}
          value={roleKey}
          onChange={setRoleKey}
          disabled={busy}
        />
        <p className="m-0 text-caption text-text-tertiary">
          They’re signed out of Fin Admin, and sign in again with the new role.
        </p>
      </form>
    </Modal>
  );
}

/** Remove from staff, with the Access reminder (spec 02 §10.1). */
export function RemoveDialog(props: {
  member: StaffMember | null;
  onClose: () => void;
  onRemoved: (member: StaffMember) => void;
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
      title={`Remove ${member?.email ?? ""} from staff?`}
      description="They’re signed out of Fin Admin at once. Take their address off the Access list next."
      confirmLabel="Remove from staff"
      tone="danger"
      busy={busy}
      {...(message === undefined ? {} : { error: message })}
      onConfirm={async () => {
        if (member === null) return;
        setMessage(undefined);
        setBusy(true);
        try {
          await withStepUpSubject({ email: member.email }, () =>
            fin.api(removeStaff, { staffId: member.id }),
          );
          props.onRemoved(member);
        } catch (error) {
          const refused = staffActionError(error).message;
          if (refused !== null) setMessage(refused);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/** A pending member's new code: the one they have stops working. */
export function NewCodeDialog(props: {
  member: StaffMember | null;
  onClose: () => void;
  onIssued: (issued: IssuedCode) => void;
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
      title={`Make a new enrolment code for ${member?.email ?? ""}?`}
      description="The code they have now stops working."
      confirmLabel="Make a new code"
      busy={busy}
      {...(message === undefined ? {} : { error: message })}
      onConfirm={async () => {
        if (member === null) return;
        setMessage(undefined);
        setBusy(true);
        try {
          const answer = await withStepUpSubject({ email: member.email }, () =>
            fin.api(newEnrolmentCode, { staffId: member.id }),
          );
          props.onIssued({
            email: member.email,
            code: answer.enrolmentCode,
            expiresAt: answer.expiresAt,
            reason: "reissued",
          });
        } catch (error) {
          const refused = staffActionError(error).message;
          if (refused !== null) setMessage(refused);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

/**
 * The enrolment code, shown once (spec 02 §6.5, §15.4): never by email; the Admin hands it over.
 * Closing the dialog drops it from the page for good.
 */
export function EnrolmentCodeDialog(props: { issued: IssuedCode | null; onDone: () => void }) {
  const issued = props.issued;
  const until = issued === null ? null : formatTimeUtc(issued.expiresAt);
  return (
    <Modal
      open={issued !== null}
      onOpenChange={(open) => {
        if (!open) props.onDone();
      }}
      title={issued?.reason === "reissued" ? "New enrolment code" : "Staff added"}
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
    </Modal>
  );
}
