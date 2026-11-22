// Settings · Organisation (Organisation board; spec 02 §9.1, §15.2): the current organisation's
// profile and rename, the person's organisations with switch and create, and delete with the typed
// name. Read-only without `organization.update`; delete disabled for everyone but a Super admin,
// and while the organisation is approved for Production. Every change asks for its intent.
import { type ConsoleViewer, setCurrentOrganization } from "@fin/app-contracts";
import { RouterLink, useFin } from "@fin/frame";
import { CheckIcon, PlusIcon, TrashIcon } from "@fin/icons";
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyField,
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
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { failureSentence, toldElsewhere } from "../../api/actions.ts";
import {
  createOrganisation,
  currentOrganisation,
  deleteOrganisation,
  isApproved,
  myOrganisations,
  type OrganisationRow,
  renameOrganisation,
} from "../../api/contracts/orgs.ts";
import { codeOf, failureOf, problemField } from "../../api/failures.ts";
import { useResource } from "../../api/resource.ts";
import {
  FieldsLoading,
  SectionFailure,
  SettingsSection,
  SettingsTabs,
  useSignedIn,
} from "../../components/page.tsx";
import { formatDay } from "../../format/dates.ts";
import { ORGANISATION_NAME_RULE } from "../../format/text.ts";
import { withReasonValues } from "../../step-up/reasons.ts";

type View = "create" | "delete";

export const Route = createFileRoute("/settings/organisation")({
  staticData: { frame: "app", navId: "settings", pageName: "Settings" },
  validateSearch: (search: Record<string, unknown>): { view?: View } =>
    search.view === "create" || search.view === "delete" ? { view: search.view } : {},
  pendingComponent: () => <SkeletonPage label="the organisation" rows={4} />,
  component: OrganisationPage,
});

const DESCRIPTION =
  "The legal entity Fin verifies and contracts with. Keys and the team belong to it.";

function Header() {
  return (
    <PageHeader
      title="Settings"
      description={DESCRIPTION}
      tabs={<SettingsTabs current="organisation" />}
      linkAs={RouterLink}
    />
  );
}

function statusOf(liveStatus: string): { tone: "success" | "neutral"; label: string } {
  return isApproved(liveStatus)
    ? { tone: "success", label: "Approved for Production" }
    : { tone: "neutral", label: "Sandbox · not approved for Production yet" };
}

function OrganisationPage() {
  const fin = useFin<ConsoleViewer>();
  const router = useRouter();
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const view = Route.useSearch().view;
  const orgId = signedIn?.viewer.currentOrgId ?? null;
  const org = useResource(`org:${orgId ?? ""}`, (signal) =>
    fin.api(currentOrganisation, {}, { signal }),
  );
  const orgs = useResource("orgs", (signal) => fin.api(myOrganisations, { size: 100 }, { signal }));
  const [switchFailed, setSwitchFailed] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const can = signedIn?.can ?? (() => false);

  const setView = (next: View | null) =>
    navigate({
      to: "/settings/organisation",
      search: next === null ? {} : { view: next },
      replace: true,
    });

  const switchTo = async (row: OrganisationRow) => {
    setSwitching(row.orgId);
    setSwitchFailed(false);
    try {
      await fin.api(setCurrentOrganization, { orgId: row.orgId });
      await fin.viewer.reload();
      await router.invalidate();
      await Promise.all([org.reload(), orgs.reload()]);
    } catch {
      setSwitchFailed(true);
    } finally {
      setSwitching(null);
    }
  };

  if (org.status === "error" && org.data === null) {
    return (
      <div className="flex flex-col gap-8">
        <Header />
        <SectionFailure
          size="page"
          title="Couldn’t load the organisation"
          error={org.error}
          onRetry={org.reload}
        />
      </div>
    );
  }

  const data = org.data;
  const approved = data !== null && isApproved(data.liveStatus);
  const orgColumns: TableColumn<OrganisationRow>[] = [
    {
      id: "name",
      header: "Organisation",
      cell: (row) => (
        <span className="flex items-center gap-2">
          <span className="text-text-primary">{row.name}</span>
          {row.orgId === orgId ? (
            <Badge variant="secondary" size="sm">
              Current
            </Badge>
          ) : null}
        </span>
      ),
    },
    { id: "role", header: "Your role", cell: (row) => row.roleLabel },
    {
      id: "status",
      header: "Status",
      kind: "status",
      hideBelow: "xl",
      cell: (row) => (
        <StatusBadge tone={statusOf(row.liveStatus).tone} presentation="dot">
          {isApproved(row.liveStatus) ? "Production" : "Sandbox"}
        </StatusBadge>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      kind: "actions",
      hideHeader: true,
      cell: (row) =>
        row.orgId === orgId || row.roleKnown === false ? null : (
          <Button
            variant="ghost"
            size="sm"
            loading={switching === row.orgId}
            onClick={() => switchTo(row)}
          >
            Switch
          </Button>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <Header />
      {switchFailed ? (
        <InlineAlert tone="danger" title="Couldn’t switch organisation" live="assertive">
          Try again.
        </InlineAlert>
      ) : null}

      <SettingsSection title="Profile" description="The name people see in invitations and emails.">
        {data === null ? (
          <FieldsLoading label="organisation" />
        ) : (
          <ProfileForm
            key={data.orgId}
            name={data.name}
            canRename={can("organization.update")}
            onSaved={async () => {
              await Promise.all([org.reload(), orgs.reload(), fin.viewer.reload()]);
            }}
          />
        )}
        {data === null ? null : (
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-3 text-body">
            <dt className="text-text-secondary">Organisation ID</dt>
            <dd className="m-0">
              <CopyField value={data.orgId} label="Organisation ID" />
            </dd>
            <dt className="text-text-secondary">Created</dt>
            <dd className="m-0 text-text-primary">{formatDay(data.createdAt)}</dd>
            <dt className="text-text-secondary">Your role</dt>
            <dd className="m-0 text-text-primary">{data.roleLabel}</dd>
            <dt className="text-text-secondary">Status</dt>
            <dd className="m-0">
              <StatusBadge tone={statusOf(data.liveStatus).tone}>
                {statusOf(data.liveStatus).label}
              </StatusBadge>
            </dd>
          </dl>
        )}
      </SettingsSection>

      <SettingsSection
        title="Your organisations"
        description="Each is a separate legal entity with its own team and keys."
        action={
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<PlusIcon />}
            onClick={() => setView("create")}
          >
            Create organisation
          </Button>
        }
      >
        {orgs.status === "error" && orgs.data === null ? (
          <SectionFailure
            title="Couldn’t load your organisations"
            error={orgs.error}
            onRetry={orgs.reload}
          />
        ) : (
          <Table
            caption="Your organisations"
            noun={{ singular: "organisation", plural: "organisations" }}
            columns={orgColumns}
            rows={orgs.data?.items ?? []}
            getRowId={(row) => row.orgId}
            getRowLabel={(row) => `${row.name}, ${row.roleLabel}`}
            status={orgs.data === null ? "loading" : "ready"}
            loadingRows={2}
            empty={null}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Delete organisation">
        {data === null ? (
          <FieldsLoading label="organisation" />
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className="m-0 text-body text-text-secondary">
              {approved
                ? `${data.name} is approved for Production, so it can’t be deleted here. To close it, contact Fin: balances and open transfers have to be settled first.`
                : `Deletes ${data.name} with its keys and sandbox data, and removes every member. This can’t be undone.`}
            </p>
            <Button
              variant="danger"
              size="sm"
              leadingIcon={<TrashIcon />}
              {...(!can("organization.delete")
                ? { disabledReason: "Only a Super admin can delete an organisation." }
                : approved
                  ? {
                      disabledReason: `${data.name} is approved for Production, so it can’t be deleted here.`,
                    }
                  : {})}
              onClick={() => setView("delete")}
            >
              Delete organisation
            </Button>
          </div>
        )}
      </SettingsSection>

      <CreateOrganisationDialog
        open={view === "create"}
        onClose={() => setView(null)}
        onCreated={async () => {
          await fin.viewer.reload();
          await router.invalidate();
          await Promise.all([org.reload(), orgs.reload()]);
          setView(null);
        }}
      />
      {data !== null && can("organization.delete") && !approved ? (
        <DeleteOrganisationDialog
          open={view === "delete"}
          name={data.name}
          onClose={() => setView(null)}
          onDeleted={async () => {
            await fin.viewer.reload();
            await router.navigate({ href: "/", replace: true });
          }}
        />
      ) : null}
    </div>
  );
}

function ProfileForm(props: { name: string; canRename: boolean; onSaved: () => Promise<void> }) {
  const fin = useFin<ConsoleViewer>();
  const [value, setValue] = useState(props.name);
  const [error, setError] = useState<"invalid" | "same" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const edited = value.trim() !== props.name;

  const save = async () => {
    const name = value.trim();
    if (name === props.name.trim()) {
      setError("same");
      return;
    }
    setState("saving");
    setError(null);
    setFailed(null);
    try {
      await withReasonValues("org.rename", { organisation: props.name }, () =>
        fin.api(renameOrganisation, { name }),
      );
      toast.success({
        title: "Organisation renamed",
        description: `${props.name} is now ${name}.`,
      });
      setState("saved");
      await props.onSaved();
    } catch (failure) {
      setState("idle");
      if (failureOf(failure) === "invalid") setError("invalid");
      else if (problemField(failure, "problem") === "unchanged") setError("same");
      else if (!toldElsewhere(failure)) setFailed(failureSentence(failure));
    }
  };

  if (!props.canRename) {
    return (
      <Field label="Organisation name" readOnly helper="Your role can’t rename the organisation.">
        <Input value={props.name} readOnly autoComplete="organization" />
      </Field>
    );
  }

  return (
    <form
      noValidate
      className="flex flex-col items-start gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {failed === null ? null : (
        <InlineAlert tone="danger" title="Couldn’t save the name" live="assertive">
          {failed}
        </InlineAlert>
      )}
      <Field
        label="Organisation name"
        className="w-full"
        {...(error === "invalid"
          ? { error: ORGANISATION_NAME_RULE }
          : error === "same"
            ? { error: "That’s already the organisation’s name." }
            : {})}
      >
        <Input
          value={value}
          autoComplete="organization"
          maxLength={50}
          disabled={state === "saving"}
          onValueChange={(next) => {
            setValue(next);
            setError(null);
            if (state === "saved") setState("idle");
          }}
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        loading={state === "saving"}
        disabled={!edited && state !== "saving"}
        {...(state === "saved" && !edited ? { leadingIcon: <CheckIcon /> } : {})}
      >
        {state === "saved" && !edited ? "Saved" : "Save changes"}
      </Button>
    </form>
  );
}

function CreateOrganisationDialog(props: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const fin = useFin<ConsoleViewer>();
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const value = name.trim();
    if (value === "") {
      setInvalid(true);
      return;
    }
    setBusy(true);
    setInvalid(false);
    setFailed(null);
    try {
      await withReasonValues("org.create", {}, () => fin.api(createOrganisation, { name: value }));
      toast.success({ title: "Organisation created", description: `You’re now in ${value}.` });
      setName("");
      await props.onCreated();
    } catch (error) {
      if (failureOf(error) === "invalid") setInvalid(true);
      else if (codeOf(error) === "limit_reached")
        setFailed(
          "You’re a Super admin in 10 or more organisations, so you can’t make another. Delete one you no longer need first.",
        );
      else if (!toldElsewhere(error)) setFailed(failureSentence(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      busy={busy}
      title="Create an organisation"
      description="A separate legal entity with its own team and keys. It starts in the sandbox."
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={create}>
            Create organisation
          </Button>
        </>
      }
    >
      {failed === null ? null : (
        <InlineAlert tone="danger" title="Couldn’t create the organisation" live="assertive">
          {failed}
        </InlineAlert>
      )}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Field label="Organisation name" {...(invalid ? { error: ORGANISATION_NAME_RULE } : {})}>
          <Input
            value={name}
            autoComplete="organization"
            maxLength={50}
            disabled={busy}
            onValueChange={(value) => setName(value)}
          />
        </Field>
      </form>
    </Modal>
  );
}

function DeleteOrganisationDialog(props: {
  open: boolean;
  name: string;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const fin = useFin<ConsoleViewer>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await withReasonValues("org.delete", { organisation: props.name }, () =>
        fin.api(deleteOrganisation, { confirmName: props.name }),
      );
      toast.success({ title: "Organisation deleted", description: `${props.name} was deleted.` });
      await props.onDeleted();
    } catch (error) {
      if (codeOf(error) === "approved_for_live")
        setFailed(`${props.name} is approved for Production, so it can’t be deleted here.`);
      else if (!toldElsewhere(error)) setFailed(failureSentence(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          setFailed(null);
          props.onClose();
        }
      }}
      title={`Delete ${props.name}?`}
      description="Its keys and sandbox data are deleted and every member loses access. This can’t be undone."
      confirmLabel="Delete organisation"
      tone="danger"
      confirmText={props.name}
      busy={busy}
      {...(failed === null ? {} : { error: failed })}
      onConfirm={remove}
    />
  );
}
