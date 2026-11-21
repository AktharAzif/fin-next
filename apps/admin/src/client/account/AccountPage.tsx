// "Your sign-in" (AdminAccount board; spec 02 §14.3, §6.7, §11.4): the member's second factors and
// sessions. Adding or removing a factor and signing out other sessions each take "Confirm it's you"
// with an intent the realm names; the last factor stays. Sunday's spill block owns the rest of the
// board (spec 06 §7.2); Saturday's journey needs the factors.
import type { StaffViewer } from "@fin/app-contracts";
import { RouterLink, signOut, useFin } from "@fin/frame";
import { PlusIcon, SignOutIcon } from "@fin/icons";
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyField,
  ErrorState,
  InlineAlert,
  Modal,
  OTPInput,
  type OTPStatus,
  PageHeader,
  Skeleton,
  Table,
  type TableColumn,
  toast,
} from "@fin/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { type AccountSession, signOutOtherSessions } from "../api/contracts.ts";
import type { AuthFailure } from "../auth/http.ts";
import { AUTHENTICATOR_CODE_LENGTH, groupsOfFour, isDigits, totpKeyOf } from "../auth/inputs.ts";
import {
  addPasskey,
  askPasskeyIntent,
  enableAuthenticator,
  type PasskeyOutcome,
  removePasskey,
  totpUriOf,
  turnOffAuthenticator,
  verifyAuthenticatorCode,
} from "../auth/library.ts";
import { factorOutcome, sessionEnded } from "../auth/outcomes.ts";
import { passkeysSupported } from "../auth/passkey.ts";
import { signInAgain } from "../auth/sign-in-again.ts";
import { type Attempt, attemptOf, withStepUp } from "../auth/step-up.ts";
import { formatUtc } from "../format.ts";
import { OUR_SIDE, staffActionError, TRY_AGAIN, UNREACHABLE } from "../staff/messages.ts";
import { withStepUpSubject } from "../step-up/reasons.ts";
import { type AccountData, type FactorRow, factorRows, removeFactorReason } from "./load.ts";

function passkeyAttempt(outcome: PasskeyOutcome): Attempt<unknown> {
  if (outcome.kind === "done") return { ok: true, value: outcome.data };
  if (outcome.kind === "ceremony") return { ok: false, stopped: outcome.reason };
  return { ok: false, failure: outcome.failure };
}

const LIMITED = "Too many tries in a short time. Try again in a moment.";

/**
 * Shows what a refused factor change says. An ended session says nothing here and loads sign-in:
 * these calls go to the realm directly, past api()'s own handling of a 401.
 */
function showFactorError(failure: AuthFailure, show: (message: string) => void): void {
  if (sessionEnded(failure)) signInAgain();
  else show(factorError(failure));
}

/** What a refused factor change says. */
function factorError(failure: AuthFailure): string {
  if (failure.kind === "network" || failure.kind === "access") return UNREACHABLE;
  const code =
    failure.kind === "problem"
      ? failure.problem.code
      : failure.kind === "library"
        ? failure.code
        : null;
  if (code === "last_factor") return "Keep another way to sign in first.";
  if (code === "step_up_invalid") return TRY_AGAIN;
  if (code === "rate_limited" || code === "ACCOUNT_TEMPORARILY_LOCKED") return LIMITED;
  return OUR_SIDE;
}

function when(iso: string | null): string {
  return iso === null ? "Not yet" : (formatUtc(iso) ?? "Not yet");
}

export function AccountSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Your sign-in" linkAs={RouterLink} />
      <div aria-busy="true" className="flex flex-col gap-16">
        <p role="status" className="sr-only">
          Loading your sign-in
        </p>
        {["factors", "sessions"].map((key) => (
          <div key={key} aria-hidden="true" className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <Skeleton shape="block" className="h-6 w-40" />
              <Skeleton shape="control" className="w-28" />
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Add an authenticator app: the key once, then the first code it shows. */
function AuthenticatorDialog(props: {
  secret: string | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<OTPStatus>("idle");
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const turnOn = async (typed: string) => {
    if (busy) return;
    if (!isDigits(typed, AUTHENTICATOR_CODE_LENGTH)) {
      setStatus("invalid");
      setAlert("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setAlert(null);
    setBusy(true);
    setStatus("verifying");
    try {
      const outcome = factorOutcome(await verifyAuthenticatorCode(typed, null));
      if (outcome === "done") {
        setStatus("success");
        setCode("");
        props.onAdded();
        return;
      }
      setStatus(outcome === "wrong" ? "invalid" : "idle");
      if (outcome === "signedOut" || outcome === "tooManyTries") signInAgain();
      else if (outcome === "limited") setAlert(LIMITED);
      else if (outcome === "offline") setAlert(UNREACHABLE);
      else if (outcome !== "wrong") setAlert(OUR_SIDE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={props.secret !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCode("");
          setStatus("idle");
          setAlert(null);
          props.onClose();
        }
      }}
      title="Add an authenticator app"
      description="Add this key to your authenticator app, then enter the code it shows."
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="add-authenticator" loading={busy}>
            Turn it on
          </Button>
        </>
      }
    >
      {alert === null ? null : <InlineAlert tone="danger" title={alert} live="assertive" />}
      {props.secret === null ? null : (
        <CopyField variant="block" label="Key" value={groupsOfFour(props.secret)} />
      )}
      <form
        id="add-authenticator"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void turnOn(code);
        }}
      >
        <OTPInput
          label="Code from the app"
          length={AUTHENTICATOR_CODE_LENGTH}
          value={code}
          onValueChange={(next) => {
            setCode(next);
            if (status === "invalid") setStatus("idle");
          }}
          onComplete={(full) => void turnOn(full)}
          status={status}
        />
      </form>
    </Modal>
  );
}

export function AccountPage({ data }: { data: AccountData }) {
  const fin = useFin<StaffViewer>();
  const router = useRouter();
  const viewer = fin.viewer.get();
  const [factorAlert, setFactorAlert] = useState<string | null>(null);
  const [sessionAlert, setSessionAlert] = useState<string | null>(null);
  const [adding, setAdding] = useState<"passkey" | "authenticator" | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState<FactorRow | null>(null);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const reload = () => router.invalidate();

  if (viewer?.state !== "ok") return null;
  const header = (
    <PageHeader
      title="Your sign-in"
      description={`${viewer.staff.email} · ${viewer.staff.roleLabel}`}
      linkAs={RouterLink}
    />
  );

  // The authenticator's key is shown once: the dialog stays at the same place in the tree whatever
  // the page's data, so a reload that fails while it is open never takes the key off the screen.
  const authenticatorDialog = (
    <AuthenticatorDialog
      secret={secret}
      onClose={() => setSecret(null)}
      onAdded={() => {
        setSecret(null);
        toast.success("Authenticator app added");
        void reload();
      }}
    />
  );

  if (data.kind === "failed") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <ErrorState
          size="page"
          headingLevel={2}
          title="Couldn’t load your sign-in"
          // A load changes nothing, and it may follow a change that went through: it says neither.
          description={
            data.offline
              ? "Check your connection and try again."
              : "Something went wrong on our side. Try again in a moment."
          }
          retrying={retrying}
          onRetry={async () => {
            setRetrying(true);
            try {
              await reload();
            } finally {
              setRetrying(false);
            }
          }}
          {...(data.requestId === null ? {} : { requestId: data.requestId })}
        />
        {authenticatorDialog}
      </div>
    );
  }

  const rows = factorRows(data.account);
  const lastFactor = removeFactorReason(rows);
  const others = data.account.sessions.filter((session) => !session.current);

  const addOnePasskey = async () => {
    setFactorAlert(null);
    setAdding("passkey");
    try {
      const result = await withStepUpSubject({ factor: "passkey" }, () =>
        withStepUp(
          fin.stepUp,
          async (intentId) => passkeyAttempt(await addPasskey(intentId)),
          () => askPasskeyIntent(),
        ),
      );
      if (result.ok) {
        toast.success("Passkey added");
        await reload();
      } else if ("stopped" in result) {
        toast.error({
          title: "Couldn’t add a passkey",
          description:
            result.stopped === "cancelled"
              ? "The passkey prompt was closed. Try again when you’re ready."
              : "This browser couldn’t make a passkey. Try another browser.",
        });
      } else if ("failure" in result) {
        showFactorError(result.failure, setFactorAlert);
      }
    } finally {
      setAdding(null);
    }
  };

  const startAuthenticator = async () => {
    setFactorAlert(null);
    setAdding("authenticator");
    try {
      const result = await withStepUpSubject({ factor: "authenticator" }, () =>
        withStepUp(fin.stepUp, async (intentId) => attemptOf(await enableAuthenticator(intentId))),
      );
      if (result.ok) {
        const uri = totpUriOf(result.value);
        const key = uri === null ? null : totpKeyOf(uri);
        if (key === null) setFactorAlert(OUR_SIDE);
        else setSecret(key);
      } else if ("failure" in result) {
        showFactorError(result.failure, setFactorAlert);
      }
    } finally {
      setAdding(null);
    }
  };

  const remove = async () => {
    const row = removing;
    if (row === null) return;
    setRemoveError(undefined);
    setRemoveBusy(true);
    try {
      const subject =
        row.kind === "passkey"
          ? { factor: "passkey", name: row.name }
          : { factor: "authenticator" };
      const result = await withStepUpSubject(subject, () =>
        withStepUp(fin.stepUp, async (intentId) =>
          attemptOf(
            row.kind === "passkey"
              ? await removePasskey(row.id, intentId)
              : await turnOffAuthenticator(intentId),
          ),
        ),
      );
      if (result.ok) {
        setRemoving(null);
        toast.success(row.kind === "passkey" ? "Passkey removed" : "Authenticator app removed");
        await reload();
      } else if ("failure" in result) {
        showFactorError(result.failure, setRemoveError);
      }
    } finally {
      setRemoveBusy(false);
    }
  };

  const signOutOthers = async () => {
    setSessionAlert(null);
    try {
      const answer = await withStepUpSubject({}, () => fin.api(signOutOtherSessions, {}));
      toast.success({
        title: "Signed out everywhere else",
        description:
          answer.revoked === 1
            ? "1 other session ended."
            : `${answer.revoked} other sessions ended.`,
      });
      await reload();
    } catch (error) {
      setSessionAlert(staffActionError(error).message);
    }
  };

  const factorColumns: TableColumn<FactorRow>[] = [
    {
      id: "name",
      header: "Second factor",
      width: "auto",
      cell: (row) => (
        <span className="flex min-w-0 flex-col py-2">
          <span className="truncate text-label text-text-primary">{row.name}</span>
          <span className="text-caption text-text-tertiary">
            {row.kind === "passkey" ? "Passkey" : "Codes from an app"}
          </span>
        </span>
      ),
    },
    { id: "added", header: "Added", kind: "date", width: "lg", cell: (row) => when(row.addedAt) },
    {
      id: "used",
      header: "Last used",
      kind: "date",
      width: "lg",
      cell: (row) => (row.kind === "passkey" ? when(row.lastUsedAt) : "—"),
    },
    {
      id: "actions",
      header: "Actions",
      hideHeader: true,
      kind: "actions",
      width: "md",
      cell: (row) => (
        <span className="flex justify-end">
          <Button
            size="sm"
            aria-label={`Remove ${row.name}`}
            {...(lastFactor === null ? {} : { disabledReason: lastFactor })}
            onClick={() => {
              setRemoveError(undefined);
              setRemoving(row);
            }}
          >
            Remove
          </Button>
        </span>
      ),
    },
  ];

  const sessionColumns: TableColumn<AccountSession>[] = [
    {
      id: "device",
      header: "Browser",
      width: "auto",
      cell: (session) => (
        <span className="flex min-w-0 items-center gap-2 py-2">
          <span className="truncate text-label text-text-primary">{session.device}</span>
          {session.current ? (
            <Badge variant="secondary" size="sm">
              This browser
            </Badge>
          ) : null}
        </span>
      ),
    },
    { id: "since", header: "Signed in", kind: "date", width: "lg", cell: (s) => when(s.createdAt) },
    {
      id: "active",
      header: "Last active",
      kind: "date",
      width: "lg",
      cell: (s) => when(s.lastActiveAt),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {header}
      <div className="flex flex-col gap-16">
        <section aria-labelledby="factors-title" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="factors-title" className="m-0 text-heading text-text-primary">
              Second factors
            </h2>
            <div className="flex gap-2">
              {data.account.authenticator.enabled ? null : (
                <Button
                  size="sm"
                  loading={adding === "authenticator"}
                  disabled={adding === "passkey"}
                  onClick={startAuthenticator}
                >
                  Add an authenticator app
                </Button>
              )}
              <Button
                size="sm"
                leadingIcon={<PlusIcon />}
                loading={adding === "passkey"}
                {...(passkeysSupported()
                  ? {}
                  : { disabledReason: "This browser can’t make a passkey. Try another browser." })}
                disabled={adding === "authenticator"}
                onClick={addOnePasskey}
              >
                Add a passkey
              </Button>
            </div>
          </div>
          {factorAlert === null ? null : (
            <InlineAlert tone="danger" title={factorAlert} live="assertive" />
          )}
          <Table
            caption="Second factors"
            noun={{ singular: "second factor", plural: "second factors" }}
            columns={factorColumns}
            rows={rows}
            getRowId={(row) => row.id}
            getRowLabel={(row) => `${row.name}, added ${when(row.addedAt)}`}
            status="ready"
            empty={null}
          />
        </section>

        <section aria-labelledby="sessions-title" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="sessions-title" className="m-0 text-heading text-text-primary">
              Sessions
            </h2>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<SignOutIcon />}
                onClick={async () => {
                  if (!(await signOut({ app: "admin" }))) setSessionAlert(OUR_SIDE);
                }}
              >
                Sign out
              </Button>
              {others.length === 0 ? null : (
                <Button size="sm" onClick={signOutOthers}>
                  Sign out everywhere else
                </Button>
              )}
            </div>
          </div>
          {sessionAlert === null ? null : (
            <InlineAlert tone="danger" title={sessionAlert} live="assertive" />
          )}
          <Table
            caption="Sessions"
            noun={{ singular: "session", plural: "sessions" }}
            columns={sessionColumns}
            rows={data.account.sessions}
            getRowId={(session) => session.id}
            getRowLabel={(session) =>
              `${session.device}, last active ${when(session.lastActiveAt)}`
            }
            status="ready"
            empty={null}
          />
        </section>
      </div>

      {authenticatorDialog}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={
          removing?.kind === "authenticator"
            ? "Remove the authenticator app?"
            : `Remove the passkey ${removing?.name ?? ""}?`
        }
        description="It stops signing you in to Fin Admin. Your other second factor still does."
        confirmLabel="Remove"
        tone="danger"
        busy={removeBusy}
        {...(removeError === undefined ? {} : { error: removeError })}
        onConfirm={remove}
      />
    </div>
  );
}
