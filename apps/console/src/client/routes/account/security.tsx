// Account security (AccountSecurity board; spec 02 §14.2, §15.2): the person's own name, sign-in
// methods, sessions, trusted browsers and recent activity, the same in every organisation. Every
// change asks for its step-up (the name a window, the rest an intent, §7.6), which the root StepUp
// dialog runs; the line names the thing from this page's own state (§15.5).
import type { ConsoleViewer } from "@fin/app-contracts";
import { RouterLink, useFin } from "@fin/frame";
import { FingerprintIcon, SignOutIcon } from "@fin/icons";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  InlineAlert,
  Input,
  Modal,
  PageHeader,
  SkeletonPage,
  StatusBadge,
  Table,
  type TableColumn,
  toast,
} from "@fin/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { toastFailure } from "../../api/actions.ts";
import {
  accountActivity,
  accountSecurity,
  accountSessions,
  forgetTrustedBrowser,
  type PasskeyRow,
  renameSelf,
  revokeOtherSessions,
  revokeSession,
  type SessionRow,
  type TrustedBrowserRow,
} from "../../api/contracts/account.ts";
import type { AuditRow } from "../../api/contracts/audit.ts";
import {
  backupCodesGenerate,
  passkeyDelete,
  passkeyVerifyRegistration,
  totpDisable,
  totpEnable,
  totpVerify,
} from "../../api/contracts/auth.ts";
import { codeOf, failureOf } from "../../api/failures.ts";
import { ceremonyApi, libraryApi } from "../../api/library.ts";
import { useResource } from "../../api/resource.ts";
import { reactToGate, withIntent } from "../../api/step-up.ts";
import { describe, sentenceText } from "../../audit/sentences.ts";
import { isCeremonyError, passkeysSupported, registerPasskey } from "../../auth/webauthn.ts";
import { AuditSentence, AuditWhere, VerifiedChip } from "../../components/audit.tsx";
import { AuthenticatorScan, BackupCodesPanel } from "../../components/authenticator.tsx";
import {
  FieldsLoading,
  SectionFailure,
  SettingsSection,
  useSignedIn,
} from "../../components/page.tsx";
import { formatDay, formatShort } from "../../format/dates.ts";
import { NAME_RULE } from "../../format/text.ts";
import { withReasonValues } from "../../step-up/reasons.ts";

export const Route = createFileRoute("/account/security")({
  staticData: { frame: "app", navId: null, pageName: "Account security" },
  pendingComponent: () => <SkeletonPage label="your sign-in methods" rows={5} />,
  component: AccountSecurityPage,
});

const DESCRIPTION =
  "How you sign in to Fin, and where you’re signed in. These are yours: they apply in every organisation you belong to.";

type Dialog =
  | null
  | { kind: "setup"; uri: string; codes: string[] }
  | { kind: "codes"; codes: string[]; fresh: boolean }
  | { kind: "turnOff" }
  | { kind: "newCodes" };

function AccountSecurityPage() {
  const fin = useFin<ConsoleViewer>();
  const router = useRouter();
  const signedIn = useSignedIn();
  const security = useResource("security", (signal) => fin.api(accountSecurity, {}, { signal }));
  const sessions = useResource("sessions", (signal) =>
    fin.api(accountSessions, { size: 100 }, { signal }),
  );
  const activity = useResource("activity", (signal) =>
    fin.api(accountActivity, { size: 25 }, { signal }),
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const library = libraryApi(fin, router);

  const refresh = async () => {
    await Promise.all([security.reload(), fin.viewer.reload(), activity.reload()]);
  };

  const run = async (key: string, work: () => Promise<void>, failure: string) => {
    setBusy(key);
    try {
      await work();
    } catch (error) {
      toastFailure(error, failure);
    } finally {
      setBusy(null);
    }
  };

  const data = security.data;
  const hasFactor = data !== null && (data.passkeys.length > 0 || data.authenticator);

  const addPasskey = () =>
    run(
      "passkey.add",
      async () => {
        try {
          await withReasonValues({}, () =>
            withIntent(fin.stepUp, {
              // With a factor, this call makes the intent; without one, the first-factor rule.
              ask: async () => {
                if (hasFactor) await ceremonyApi()(passkeyVerifyRegistration, {});
                await registerPasskey(ceremonyApi());
              },
              proved: (intentId) => registerPasskey(ceremonyApi(intentId)),
              settlesAsDone: (error) => isCeremonyError(error),
            }),
          );
          toast.success("Passkey added");
          await refresh();
        } catch (error) {
          if (isCeremonyError(error)) {
            toast.info({
              title: "No passkey was added",
              description: "Try again when you’re ready.",
            });
            return;
          }
          if (
            reactToGate(fin.stepUp, error, () => void router.navigate({ href: "/welcome/secure" }))
          )
            return;
          throw error;
        }
      },
      "Couldn’t add the passkey",
    );

  const removePasskey = (passkey: PasskeyRow) =>
    run(
      `passkey.remove.${passkey.id}`,
      async () => {
        try {
          await withReasonValues({ name: passkey.name }, () =>
            library(passkeyDelete, { id: passkey.id }),
          );
        } catch (error) {
          if (codeOf(error) === "last_factor") {
            toast.error({
              title: "Couldn’t remove the passkey",
              description: "Keep another way to sign in first.",
            });
            return;
          }
          throw error;
        }
        toast.success("Passkey removed");
        await refresh();
      },
      "Couldn’t remove the passkey",
    );

  const setUpAuthenticator = () =>
    run(
      "totp.enable",
      async () => {
        const answer = await withReasonValues({}, () => library(totpEnable, {}));
        setDialog({ kind: "setup", uri: answer.totpURI, codes: answer.backupCodes });
      },
      "Couldn’t start the set-up",
    );

  const turnOff = () =>
    run(
      "totp.disable",
      async () => {
        try {
          await withReasonValues({}, () => library(totpDisable, {}));
        } catch (error) {
          if (codeOf(error) === "last_factor") {
            setDialog(null);
            toast.error({
              title: "Couldn’t turn off the authenticator app",
              description: "Keep another way to sign in first.",
            });
            return;
          }
          throw error;
        }
        setDialog(null);
        toast.success("Authenticator app turned off");
        await refresh();
      },
      "Couldn’t turn off the authenticator app",
    );

  const newCodes = () =>
    run(
      "codes.new",
      async () => {
        const answer = await withReasonValues({}, () => library(backupCodesGenerate, {}));
        setDialog({ kind: "codes", codes: answer.backupCodes, fresh: false });
        void refresh();
      },
      "Couldn’t make new backup codes",
    );

  if (security.status === "error" && data === null) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Account security" description={DESCRIPTION} linkAs={RouterLink} />
        <SectionFailure
          size="page"
          title="Couldn’t load your sign-in methods"
          error={security.error}
          onRetry={security.reload}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Account security" description={DESCRIPTION} linkAs={RouterLink} />
      {data?.noSecondFactor === true ? (
        <InlineAlert tone="warning" title="You have no second factor yet.">
          Add a passkey or an authenticator app. You need one to manage organisations and before
          going to Production.
        </InlineAlert>
      ) : null}

      <NameSection
        loading={data === null}
        name={data?.name ?? signedIn?.viewer.user.name ?? ""}
        onSaved={refresh}
      />

      <SettingsSection
        title="Your sign-in methods"
        action={
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<FingerprintIcon />}
            loading={busy === "passkey.add"}
            {...(passkeysSupported()
              ? {}
              : { disabledReason: "This browser can’t add a passkey." })}
            onClick={addPasskey}
          >
            Add a passkey
          </Button>
        }
      >
        <MethodsTable
          loading={data === null}
          passkeys={data?.passkeys ?? []}
          authenticator={data?.authenticator ?? false}
          backupCodesLeft={data?.backupCodesLeft ?? null}
          busy={busy}
          onRemove={removePasskey}
          onSetUp={setUpAuthenticator}
          onTurnOff={() => setDialog({ kind: "turnOff" })}
          onNewCodes={() => setDialog({ kind: "newCodes" })}
        />
      </SettingsSection>

      <SessionsSection
        sessions={sessions.data?.items ?? null}
        status={sessions.status}
        error={sessions.error}
        onRetry={sessions.reload}
        onChanged={async () => {
          await Promise.all([sessions.reload(), activity.reload()]);
        }}
      />

      {data !== null && (data.trustedBrowsers.length > 0 || signedIn?.viewer.canTrustBrowser) ? (
        <TrustedBrowsersSection browsers={data.trustedBrowsers} onChanged={refresh} />
      ) : null}

      <ActivitySection
        rows={activity.data?.items ?? null}
        status={activity.status}
        error={activity.error}
        onRetry={activity.reload}
        you={signedIn?.viewer.user.id ?? null}
      />

      {dialog?.kind === "setup" ? (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          title="Set up your authenticator"
          description="Two steps. Codes change every 30 seconds."
        >
          <AuthenticatorScan
            uri={dialog.uri}
            verify={async (code) => {
              await ceremonyApi()(totpVerify, { code });
            }}
            onVerified={() => {
              setDialog({ kind: "codes", codes: dialog.codes, fresh: true });
              void refresh();
            }}
          />
        </Modal>
      ) : null}
      {dialog?.kind === "codes" ? (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          title={dialog.fresh ? "Save your backup codes" : "Save your new backup codes"}
          description={
            dialog.fresh
              ? "Each of these 10 codes signs you in once if you lose your authenticator. Keep them in a password manager."
              : "This is the only time Fin shows them."
          }
        >
          <BackupCodesPanel codes={dialog.codes} onDone={() => setDialog(null)} />
        </Modal>
      ) : null}
      <ConfirmDialog
        open={dialog?.kind === "turnOff"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Turn off the authenticator app?"
        description="Its codes and your backup codes stop working. Keep a passkey so sensitive actions still work."
        confirmLabel="Turn off"
        tone="danger"
        busy={busy === "totp.disable"}
        onConfirm={turnOff}
      />
      <ConfirmDialog
        open={dialog?.kind === "newCodes"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Generate new backup codes?"
        description="The old codes stop working at once."
        confirmLabel="Generate new codes"
        busy={busy === "codes.new"}
        onConfirm={newCodes}
      />
    </div>
  );
}

function NameSection(props: { loading: boolean; name: string; onSaved: () => Promise<void> }) {
  const fin = useFin<ConsoleViewer>();
  const [value, setValue] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [saving, setSaving] = useState(false);
  const shown = value ?? props.name;
  const noName = props.name.trim() === "";

  const save = async () => {
    setSaving(true);
    setRefused(false);
    try {
      await withReasonValues({}, () => fin.api(renameSelf, { name: shown.trim() }));
      toast.success("Name saved");
      setValue(null);
      await props.onSaved();
    } catch (error) {
      if (failureOf(error) === "invalid") setRefused(true);
      else toastFailure(error, "Couldn’t save your name");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Your name">
      {props.loading ? (
        <FieldsLoading label="your name" />
      ) : (
        <form
          noValidate
          className="flex flex-col items-start gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field
            label="Full name"
            className="w-full"
            helper={
              noName
                ? "Your account has no name yet. It is shown to your team and in the audit log."
                : "Shown to your team and in the audit log."
            }
            {...(refused ? { error: NAME_RULE } : {})}
          >
            <Input
              autoComplete="name"
              maxLength={60}
              value={shown}
              onValueChange={(next) => setValue(next)}
              disabled={saving}
            />
          </Field>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            loading={saving}
            disabled={shown.trim() === "" || shown.trim() === props.name.trim()}
          >
            Save name
          </Button>
        </form>
      )}
    </SettingsSection>
  );
}

interface MethodRow {
  id: string;
  label: string;
  status: string;
  tone: "success" | "neutral" | "warning";
  action: ReactNode;
}

function MethodsTable(props: {
  loading: boolean;
  passkeys: PasskeyRow[];
  authenticator: boolean;
  backupCodesLeft: number | null;
  busy: string | null;
  onRemove: (passkey: PasskeyRow) => void;
  onSetUp: () => void;
  onTurnOff: () => void;
  onNewCodes: () => void;
}) {
  const rows: MethodRow[] = [
    ...props.passkeys.map((passkey) => ({
      id: passkey.id,
      label: `Passkey · ${passkey.name}`,
      status: `Added ${formatDay(passkey.createdAt)}`,
      tone: "success" as const,
      action: (
        <Button
          variant="ghost"
          size="sm"
          loading={props.busy === `passkey.remove.${passkey.id}`}
          onClick={() => props.onRemove(passkey)}
        >
          Remove
        </Button>
      ),
    })),
    {
      id: "authenticator",
      label: "Authenticator app",
      status: props.authenticator ? "On" : "Off",
      tone: props.authenticator ? ("success" as const) : ("neutral" as const),
      action: props.authenticator ? (
        <Button variant="secondary" size="sm" onClick={props.onTurnOff}>
          Turn off
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          loading={props.busy === "totp.enable"}
          onClick={props.onSetUp}
        >
          Set up
        </Button>
      ),
    },
    ...(props.authenticator && props.backupCodesLeft !== null
      ? [
          {
            id: "backup-codes",
            label: "Backup codes",
            status: `${props.backupCodesLeft} of 10 left`,
            tone: props.backupCodesLeft <= 2 ? ("warning" as const) : ("success" as const),
            action: (
              <Button variant="secondary" size="sm" onClick={props.onNewCodes}>
                Regenerate
              </Button>
            ),
          },
        ]
      : []),
  ];
  const columns: TableColumn<MethodRow>[] = [
    { id: "method", header: "Method", cell: (row) => row.label },
    {
      id: "status",
      header: "Status",
      kind: "status",
      cell: (row) => (
        <StatusBadge tone={row.tone} presentation="dot">
          {row.status}
        </StatusBadge>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      kind: "actions",
      hideHeader: true,
      cell: (row) => row.action,
    },
  ];
  return (
    <Table
      caption="Your sign-in methods"
      noun={{ singular: "method", plural: "methods" }}
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      getRowLabel={(row) => `${row.label}, ${row.status}`}
      status={props.loading ? "loading" : "ready"}
      loadingRows={3}
      empty={null}
    />
  );
}

function SessionsSection(props: {
  sessions: SessionRow[] | null;
  status: string;
  error: unknown;
  onRetry: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const fin = useFin<ConsoleViewer>();
  const [busy, setBusy] = useState<string | null>(null);
  const others = (props.sessions ?? []).filter((session) => !session.current);

  const signOutOne = async (session: SessionRow) => {
    setBusy(session.id);
    try {
      await withReasonValues({ device: session.device }, () =>
        fin.api(revokeSession, { sessionId: session.id }),
      );
      toast.success(`Signed out ${session.device}`);
      await props.onChanged();
    } catch (error) {
      toastFailure(error, `Couldn’t sign out ${session.device}`);
    } finally {
      setBusy(null);
    }
  };

  const signOutOthers = async () => {
    setBusy("others");
    try {
      await withReasonValues({}, () => fin.api(revokeOtherSessions, {}));
      toast.success("Signed out everywhere else");
      await props.onChanged();
    } catch (error) {
      toastFailure(error, "Couldn’t sign out your other devices");
    } finally {
      setBusy(null);
    }
  };

  const columns: TableColumn<SessionRow>[] = [
    {
      id: "device",
      header: "Device",
      cell: (session) => (
        <div className="flex flex-col py-1.5">
          <span className="text-text-primary">{session.device}</span>
          {session.ipAddress === null ? null : (
            <span className="text-caption text-text-tertiary tabular-nums">
              {session.ipAddress}
            </span>
          )}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      kind: "status",
      cell: (session) =>
        session.current ? (
          <StatusBadge tone="success" presentation="dot">
            This device
          </StatusBadge>
        ) : (
          <span className="text-text-secondary">Signed in {formatShort(session.createdAt)}</span>
        ),
    },
    {
      id: "actions",
      header: "Actions",
      kind: "actions",
      hideHeader: true,
      cell: (session) =>
        session.current ? null : (
          <Button
            variant="ghost"
            size="sm"
            loading={busy === session.id}
            onClick={() => signOutOne(session)}
          >
            Sign out
          </Button>
        ),
    },
  ];

  return (
    <SettingsSection
      title="Where you’re signed in"
      action={
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<SignOutIcon />}
          loading={busy === "others"}
          {...(props.sessions !== null && others.length === 0
            ? { disabledReason: "You’re signed in on this device only." }
            : {})}
          onClick={signOutOthers}
        >
          Sign out everywhere else
        </Button>
      }
    >
      {props.status === "error" && props.sessions === null ? (
        <SectionFailure
          title="Couldn’t load where you’re signed in"
          error={props.error}
          onRetry={props.onRetry}
        />
      ) : (
        <Table
          caption="Where you’re signed in"
          noun={{ singular: "session", plural: "sessions" }}
          columns={columns}
          rows={props.sessions ?? []}
          getRowId={(session) => session.id}
          getRowLabel={(session) => session.device}
          status={props.sessions === null ? "loading" : "ready"}
          loadingRows={2}
          empty={null}
        />
      )}
    </SettingsSection>
  );
}

function TrustedBrowsersSection(props: {
  browsers: TrustedBrowserRow[];
  onChanged: () => Promise<void>;
}) {
  const fin = useFin<ConsoleViewer>();
  const [busy, setBusy] = useState<string | null>(null);
  const forget = async (browser: TrustedBrowserRow) => {
    setBusy(browser.id);
    try {
      await withReasonValues({ browser: browser.device }, () =>
        fin.api(forgetTrustedBrowser, { browserId: browser.id }),
      );
      toast.success(`Fin no longer trusts ${browser.device}`);
      await props.onChanged();
    } catch (error) {
      toastFailure(error, "Couldn’t forget the browser");
    } finally {
      setBusy(null);
    }
  };
  const columns: TableColumn<TrustedBrowserRow>[] = [
    { id: "browser", header: "Browser", cell: (browser) => browser.device },
    {
      id: "until",
      header: "Trusted until",
      kind: "date",
      cell: (browser) => formatDay(browser.expiresAt),
    },
    {
      id: "actions",
      header: "Actions",
      kind: "actions",
      hideHeader: true,
      cell: (browser) => (
        <Button
          variant="ghost"
          size="sm"
          loading={busy === browser.id}
          onClick={() => forget(browser)}
        >
          Forget this browser
        </Button>
      ),
    },
  ];
  return (
    <SettingsSection
      title="Trusted browsers"
      description="These browsers skip the authenticator code at sign-in for 30 days. Anything sensitive still asks for it."
    >
      <Table
        caption="Trusted browsers"
        noun={{ singular: "browser", plural: "browsers" }}
        columns={columns}
        rows={props.browsers}
        getRowId={(browser) => browser.id}
        getRowLabel={(browser) => browser.device}
        empty={<EmptyState variant="section" title="No browser is trusted." />}
      />
    </SettingsSection>
  );
}

function ActivitySection(props: {
  rows: AuditRow[] | null;
  status: string;
  error: unknown;
  onRetry: () => Promise<void>;
  you: string | null;
}) {
  const columns: TableColumn<AuditRow>[] = [
    {
      id: "event",
      header: "Event",
      cell: (row) => (
        <div className="flex flex-col py-1.5">
          <AuditSentence row={row} you={props.you} />
          <AuditWhere row={row} />
        </div>
      ),
    },
    {
      id: "verified",
      header: "Verified by",
      width: "md",
      cell: (row) => <VerifiedChip verification={row.verification} />,
    },
    {
      id: "when",
      header: "Time (UTC)",
      kind: "date",
      width: "md",
      cell: (row) => formatShort(row.at),
    },
  ];
  return (
    <SettingsSection
      title="Recent activity"
      description="Sign-ins and changes to how you sign in. Only you can see this."
    >
      {props.status === "error" && props.rows === null ? (
        <SectionFailure
          title="Couldn’t load your recent activity"
          error={props.error}
          onRetry={props.onRetry}
        />
      ) : (
        <Table
          caption="Recent activity"
          noun={{ singular: "event", plural: "events" }}
          columns={columns}
          rows={props.rows ?? []}
          getRowId={(row) => row.id}
          getRowLabel={(row) => sentenceText(describe(row, props.you))}
          status={props.rows === null ? "loading" : "ready"}
          loadingRows={5}
          empty={
            <EmptyState
              variant="section"
              title="Nothing yet. Sign-ins and changes show here as they happen."
            />
          }
        />
      )}
    </SettingsSection>
  );
}
