// Settings · Team (Team board; spec 02 §9.2 to §9.4, §15.2, §15.2.1): members with search, the
// "No access" rows, invitations, and invite, change role, remove, and an invitation's change,
// resend and delete, each with its intent. What the role cannot do is disabled with the reason;
// the server checks every rule again inside its team-change lock. "See changes in the audit log"
// and a member's "View in audit log" show only with `auditLog.read`.
import type { ConsoleViewer } from "@fin/app-contracts";
import { RouterLink, useFin } from "@fin/frame";
import { DotsThreeIcon, MagnifyingGlassIcon, UserPlusIcon } from "@fin/icons";
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  EmptyState,
  Field,
  IconButton,
  InlineAlert,
  Input,
  MenuItem,
  MenuSeparator,
  Modal,
  PageHeader,
  StatusBadge,
  Table,
  type TableColumn,
  toast,
} from "@fin/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { failureSentence, toastFailure, toldElsewhere } from "../../api/actions.ts";
import { roles as rolesContract } from "../../api/contracts/roles.ts";
import {
  type CredentialRow,
  cancelInvitation,
  changeInvitation,
  changeMemberRole,
  type InvitationRow,
  inviteMember,
  type MemberRow,
  memberCredentials,
  removeMember,
  resendInvitation,
  team,
} from "../../api/contracts/team.ts";
import { codeOf, failureOf, problemField } from "../../api/failures.ts";
import { useResource } from "../../api/resource.ts";
import { looksLikeEmail } from "../../auth/pending.ts";
import {
  Block,
  QuietArrowLink,
  ROLE_REASON,
  SectionFailure,
  SettingsTabs,
  useSignedIn,
} from "../../components/page.tsx";
import { firstGivable, type RoleChoice, RolePicker, roleChoices } from "../../components/roles.tsx";
import { formatDay } from "../../format/dates.ts";
import { withReasonValues } from "../../step-up/reasons.ts";

type View = "invite";

export const Route = createFileRoute("/settings/team")({
  staticData: { frame: "app", navId: "settings", pageName: "Settings", needs: ["member.read"] },
  validateSearch: (search: Record<string, unknown>): { view?: View; q?: string } => ({
    ...(search.view === "invite" ? { view: "invite" as const } : {}),
    ...(typeof search.q === "string" && search.q !== "" ? { q: search.q.slice(0, 200) } : {}),
  }),
  pendingComponent: TeamLoading,
  component: TeamPage,
});

const DESCRIPTION =
  "Each person’s role decides what they can do. Anyone with Production access must use a second factor.";

function TeamLoading() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Settings"
        description={DESCRIPTION}
        tabs={<SettingsTabs current="team" />}
        linkAs={RouterLink}
      />
      <Table
        caption="Members"
        noun={{ singular: "member", plural: "members" }}
        columns={[{ id: "member", header: "Member", cell: () => null }]}
        rows={[]}
        getRowId={() => ""}
        getRowLabel={() => ""}
        status="loading"
        loadingRows={6}
        empty={null}
      />
    </div>
  );
}

const SECOND_FACTOR: Readonly<
  Record<MemberRow["secondFactor"], { label: string; tone: "success" | "warning" }>
> = {
  passkey: { label: "Passkey", tone: "success" },
  authenticator: { label: "Authenticator app", tone: "success" },
  both: { label: "Passkey and authenticator app", tone: "success" },
  none: { label: "No second factor", tone: "warning" },
};

function invitationStatus(row: InvitationRow): {
  label: string;
  tone: "info" | "neutral";
  when: string;
} {
  switch (row.status) {
    case "pending":
      return { label: "Pending", tone: "info", when: `Expires ${formatDay(row.expiresAt)}` };
    case "expired":
      return { label: "Expired", tone: "neutral", when: `Expired ${formatDay(row.expiresAt)}` };
    case "declined":
      return {
        label: "Declined",
        tone: "neutral",
        when: `Declined ${formatDay(row.answeredAt ?? row.expiresAt)}`,
      };
    case "accepted":
      return { label: "Accepted", tone: "neutral", when: formatDay(row.answeredAt) };
    default:
      return { label: "Deleted", tone: "neutral", when: formatDay(row.answeredAt) };
  }
}

type Dialog =
  | null
  | { kind: "role"; member: MemberRow }
  | { kind: "remove"; member: MemberRow }
  | { kind: "invitationRole"; invitation: InvitationRow };

function TeamPage() {
  const fin = useFin<ConsoleViewer>();
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const search = Route.useSearch();
  const orgId = signedIn?.viewer.currentOrgId ?? "";
  const [query, setQuery] = useState(search.q ?? "");
  const q = search.q ?? "";
  const data = useResource(`team:${orgId}:${q}`, (signal) =>
    fin.api(team, q === "" ? { size: 100 } : { q, size: 100 }, { signal }),
  );
  const roleList = useResource(`roles:${orgId}`, (signal) =>
    fin.api(rolesContract, {}, { signal }),
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const can = signedIn?.can ?? (() => false);
  const canInvite = can("member.invite");
  const canChangeRole = can("member.role");
  const auditLink = can("auditLog.read");
  const actor = {
    roleKey: signedIn?.membership?.roleKey ?? "",
    permissions: signedIn?.viewer.permissions ?? [],
  };

  // The search is in the URL, so Back returns to it; typing settles for 300 ms first.
  useEffect(() => {
    const value = query.trim();
    if (value === q) return;
    const timer = setTimeout(() => {
      void navigate({
        to: "/settings/team",
        search: value === "" ? {} : { q: value },
        replace: true,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, q, navigate]);

  const setInviteOpen = (open: boolean) =>
    navigate({
      to: "/settings/team",
      search: { ...(q === "" ? {} : { q }), ...(open ? { view: "invite" as const } : {}) },
      replace: true,
    });

  const reload = () => data.reload();

  const invitationAction = async (
    invitation: InvitationRow,
    action: "resend" | "delete",
  ): Promise<void> => {
    // The menu item shows its own progress while this runs.
    try {
      await withReasonValues({ email: invitation.email }, () =>
        action === "resend"
          ? fin.api(resendInvitation, { invitationId: invitation.invitationId })
          : fin.api(cancelInvitation, { invitationId: invitation.invitationId }),
      );
      toast.success(
        action === "resend"
          ? `Invitation sent again to ${invitation.email}`
          : `Invitation for ${invitation.email} deleted`,
      );
      await reload();
    } catch (error) {
      toastFailure(
        error,
        action === "resend"
          ? "Couldn’t send the invitation again"
          : "Couldn’t delete the invitation",
      );
    }
  };

  const members = (data.data?.members ?? []).filter((m) => m.roleKnown);
  const noAccess = (data.data?.members ?? []).filter((m) => !m.roleKnown);
  const invitations = data.data?.invitations ?? [];

  const memberMenu = (member: MemberRow) => {
    if (member.isYou) return null;
    const items = [
      canChangeRole ? (
        <MenuItem key="role" onSelect={() => setDialog({ kind: "role", member })}>
          Change role
        </MenuItem>
      ) : null,
      canInvite ? (
        <MenuItem key="remove" destructive onSelect={() => setDialog({ kind: "remove", member })}>
          Remove from organisation
        </MenuItem>
      ) : null,
    ].filter((item) => item !== null);
    if (items.length === 0 && !auditLink) return null;
    return (
      <DropdownMenu
        align="end"
        trigger={
          <IconButton
            size="sm"
            label={`Actions for ${member.name || member.email}`}
            icon={<DotsThreeIcon />}
          />
        }
      >
        {items}
        {auditLink ? (
          <>
            {items.length > 0 ? <MenuSeparator /> : null}
            <MenuItem
              href={`/audit-log?${new URLSearchParams({ target: member.memberId }).toString()}`}
            >
              View in audit log
            </MenuItem>
          </>
        ) : null}
      </DropdownMenu>
    );
  };

  const memberColumns: TableColumn<MemberRow>[] = [
    {
      id: "member",
      header: "Member",
      cell: (member) => (
        <div className="flex items-center gap-3 py-1.5">
          <Avatar name={member.name} email={member.email} size={32} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-text-primary">
              {member.name === "" ? member.email : member.name}
              {member.isYou ? <span className="text-text-tertiary"> · you</span> : null}
            </span>
            <span className="truncate text-caption text-text-tertiary">{member.email}</span>
          </div>
        </div>
      ),
    },
    {
      id: "role",
      header: "Role",
      width: "md",
      cell: (member) => <Badge>{member.roleLabel}</Badge>,
    },
    {
      id: "factor",
      header: "Second factor",
      kind: "status",
      width: "lg",
      hideBelow: "xl",
      cell: (member) => (
        <StatusBadge tone={SECOND_FACTOR[member.secondFactor].tone} presentation="dot">
          {SECOND_FACTOR[member.secondFactor].label}
        </StatusBadge>
      ),
    },
    {
      id: "joined",
      header: "Joined",
      kind: "date",
      width: "md",
      cell: (member) => formatDay(member.joinedAt),
    },
    {
      id: "actions",
      header: "Actions",
      kind: "actions",
      width: "xs",
      hideHeader: true,
      cell: memberMenu,
    },
  ];

  const noAccessColumns: TableColumn<MemberRow>[] = [
    memberColumns[0] as TableColumn<MemberRow>,
    {
      id: "stored",
      header: "Stored role",
      width: "md",
      cell: (member) => <span className="font-mono text-mono">{member.roleKey}</span>,
    },
    memberColumns[4] as TableColumn<MemberRow>,
  ];

  const invitationColumns: TableColumn<InvitationRow>[] = [
    { id: "email", header: "Email", cell: (row) => row.email },
    { id: "role", header: "Role", width: "md", cell: (row) => row.roleLabel },
    {
      id: "status",
      header: "Status",
      kind: "status",
      width: "sm",
      cell: (row) => (
        <StatusBadge tone={invitationStatus(row).tone}>{invitationStatus(row).label}</StatusBadge>
      ),
    },
    {
      id: "expires",
      header: "Expires",
      kind: "date",
      width: "md",
      hideBelow: "xl",
      cell: (row) => invitationStatus(row).when,
    },
    {
      id: "actions",
      header: "Actions",
      kind: "actions",
      width: "xs",
      hideHeader: true,
      cell: (row) =>
        !canInvite ? null : (
          <DropdownMenu
            align="end"
            trigger={
              <IconButton
                size="sm"
                label={`Actions for the invitation to ${row.email}`}
                icon={<DotsThreeIcon />}
              />
            }
          >
            {row.status === "pending" ? (
              <>
                <MenuItem onSelect={() => setDialog({ kind: "invitationRole", invitation: row })}>
                  Change role
                </MenuItem>
                <MenuItem onSelect={() => invitationAction(row, "resend")}>Resend</MenuItem>
                <MenuSeparator />
              </>
            ) : null}
            <MenuItem destructive onSelect={() => invitationAction(row, "delete")}>
              Delete
            </MenuItem>
          </DropdownMenu>
        ),
    },
  ];

  const inviteButton = (
    <Button
      variant="primary"
      leadingIcon={<UserPlusIcon />}
      {...(canInvite ? {} : { disabledReason: ROLE_REASON })}
      onClick={() => setInviteOpen(true)}
    >
      Invite teammate
    </Button>
  );

  const choicesFor = (currentRoleKey?: string): RoleChoice[] =>
    roleChoices(roleList.data?.roles ?? [], actor, currentRoleKey);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Settings"
        description={DESCRIPTION}
        primaryAction={inviteButton}
        tabs={<SettingsTabs current="team" />}
        linkAs={RouterLink}
      />
      {data.status === "error" && data.data === null ? (
        <SectionFailure title="Couldn’t load the team" error={data.error} onRetry={reload} />
      ) : (
        <>
          <Block
            title="Members"
            {...(data.data === null ? {} : { count: data.data.membersTotal })}
            aside={
              auditLink ? (
                <QuietArrowLink href="/audit-log?type=team">
                  See changes in the audit log
                </QuietArrowLink>
              ) : undefined
            }
          >
            <Table
              caption="Members"
              noun={{ singular: "member", plural: "members" }}
              columns={memberColumns}
              rows={members}
              getRowId={(member) => member.memberId}
              getRowLabel={(member) =>
                `${member.name === "" ? member.email : member.name}, ${member.roleLabel}`
              }
              status={
                data.status === "loading"
                  ? "loading"
                  : data.status === "refreshing"
                    ? "refreshing"
                    : data.status === "error"
                      ? "error"
                      : "ready"
              }
              error={{ onRetry: reload }}
              loadingRows={6}
              toolbar={
                <div className="flex max-w-80 items-center">
                  <Field label="Search members" hideLabel className="w-full">
                    <div className="relative">
                      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-tertiary">
                        <MagnifyingGlassIcon />
                      </span>
                      <Input
                        type="search"
                        value={query}
                        placeholder="Search by name or email"
                        className="pl-9"
                        onValueChange={(value) => setQuery(value)}
                      />
                    </div>
                  </Field>
                </div>
              }
              empty={
                <EmptyState
                  variant="no-results"
                  title="No one matches"
                  description={`Nothing for “${q}” among the members.`}
                  onClearFilters={() => setQuery("")}
                />
              }
            />
          </Block>
          {noAccess.length > 0 ? (
            <Block
              title="No access"
              count={noAccess.length}
              description="Their stored role isn’t one Fin recognises, so it allows nothing. Give them a role, or remove them."
            >
              <Table
                caption="No access"
                noun={{ singular: "member", plural: "members" }}
                columns={noAccessColumns}
                rows={noAccess}
                getRowId={(member) => member.memberId}
                getRowLabel={(member) => member.name || member.email}
                empty={null}
              />
            </Block>
          ) : null}
          {invitations.length > 0 ? (
            <Block
              title="Invitations"
              count={invitations.length}
              description="Invites expire in 7 days."
            >
              <Table
                caption="Invitations"
                noun={{ singular: "invitation", plural: "invitations" }}
                columns={invitationColumns}
                rows={invitations}
                getRowId={(row) => row.invitationId}
                getRowLabel={(row) =>
                  `${row.email}, ${row.roleLabel}, ${invitationStatus(row).label}`
                }
                empty={null}
              />
            </Block>
          ) : null}
        </>
      )}

      <InviteDialog
        open={search.view === "invite" && canInvite}
        choices={choicesFor()}
        onClose={() => setInviteOpen(false)}
        onSent={async () => {
          await setInviteOpen(false);
          await reload();
        }}
      />
      {dialog?.kind === "role" ? (
        <ChangeRoleDialog
          member={dialog.member}
          choices={choicesFor(dialog.member.roleKey)}
          onClose={() => setDialog(null)}
          onChanged={async () => {
            setDialog(null);
            await reload();
          }}
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <RemoveDialog
          member={dialog.member}
          organisation={signedIn?.membership?.name ?? "the organisation"}
          onClose={() => setDialog(null)}
          onRemoved={async () => {
            setDialog(null);
            await reload();
          }}
        />
      ) : null}
      {dialog?.kind === "invitationRole" ? (
        <InvitationRoleDialog
          invitation={dialog.invitation}
          choices={choicesFor(dialog.invitation.roleKey)}
          onClose={() => setDialog(null)}
          onChanged={async () => {
            setDialog(null);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** The refusal of a role change or an invitation, in one sentence. */
function roleRefusal(error: unknown): string {
  const code = codeOf(error);
  if (code === "outranked")
    return "Their role can do more than yours, so you can’t change it. Ask a Super admin.";
  if (code === "giving_refused") {
    const problem = problemField(error, "problem");
    if (problem === "top_only") return "Only a Super admin can make someone a Super admin.";
    if (problem === "self") return "You can’t change your own role.";
    if (problem === "unchanged") return "They already have that role.";
    return "That role can do more than yours, so you can’t give it.";
  }
  if (code === "last_top_role")
    return "Every organisation needs a Super admin. Make someone else one first.";
  if (code === "already_member") return "That person is already a member.";
  return failureSentence(error);
}

function InviteDialog(props: {
  open: boolean;
  choices: RoleChoice[];
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const fin = useFin<ConsoleViewer>();
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = roleKey ?? firstGivable(props.choices);

  const send = async () => {
    const address = email.trim().toLowerCase();
    if (!looksLikeEmail(address)) {
      setEmailError("That email address doesn’t look right.");
      return;
    }
    if (chosen === null) return;
    setBusy(true);
    setEmailError(null);
    setFailed(null);
    try {
      await withReasonValues({ email: address }, () =>
        fin.api(inviteMember, { email: address, roleKey: chosen }),
      );
      toast.success(`Invitation sent to ${address}`);
      setEmail("");
      setRoleKey(null);
      await props.onSent();
    } catch (error) {
      if (codeOf(error) === "already_member") setEmailError("That person is already a member.");
      else if (failureOf(error) === "invalid")
        setEmailError("That email address doesn’t look right.");
      else if (codeOf(error) === "limit_reached")
        setFailed("Too many invitations are waiting. Delete some first, or try again tomorrow.");
      else if (!toldElsewhere(error)) setFailed(roleRefusal(error));
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
      title="Invite a teammate"
      description="Invites expire in 7 days."
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            {...(chosen === null ? { disabledReason: "There is no role you can give." } : {})}
            onClick={send}
          >
            Send invite
          </Button>
        </>
      }
    >
      {failed === null ? null : (
        <InlineAlert tone="danger" title="The invitation wasn’t sent" live="assertive">
          {failed}
        </InlineAlert>
      )}
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Field label="Work email" {...(emailError === null ? {} : { error: emailError })}>
          <Input
            type="email"
            value={email}
            placeholder="name@company.com"
            autoComplete="off"
            disabled={busy}
            onValueChange={(value) => setEmail(value)}
          />
        </Field>
        <RolePicker
          label="Role"
          choices={props.choices}
          value={chosen}
          onChange={setRoleKey}
          disabled={busy}
        />
      </form>
    </Modal>
  );
}

/** What the member made or saw that is rolled with the change, and the "Roll them" box. */
function useCredentials(member: MemberRow) {
  const fin = useFin<ConsoleViewer>();
  const list = useResource(`credentials:${member.memberId}`, (signal) =>
    fin.api(memberCredentials, { memberId: member.memberId }, { signal }),
  );
  const [roll, setRoll] = useState(true);
  return { items: list.data?.items ?? [], roll, setRoll };
}

function CredentialsNotice(props: {
  items: CredentialRow[];
  roll: boolean;
  setRoll: (roll: boolean) => void;
  name: string;
}) {
  if (props.items.length === 0) return null;
  const now = props.items.filter((item) => item.rollsNow !== false);
  const later = props.items.filter((item) => item.rollsNow === false);
  return (
    <div className="flex flex-col gap-3">
      <InlineAlert
        tone="warning"
        title={`${props.name} made or saw ${props.items.length} ${props.items.length === 1 ? "credential" : "credentials"} that still ${props.items.length === 1 ? "works" : "work"}.`}
      >
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {props.items.map((item) => (
            <li key={item.id}>
              {item.kind === "api_key" ? "API key" : "Signing secret"}: {item.label}
            </li>
          ))}
        </ul>
        {later.length > 0 && props.roll ? (
          <p className="m-0 mt-2">
            {now.length > 0
              ? "Some are rolled at once; the rest keep working for an hour and your Super admins are told."
              : "They keep working for an hour after they’re rolled, and your Super admins are told."}
          </p>
        ) : null}
      </InlineAlert>
      <Checkbox
        label="Roll them"
        description="Make new ones so what they know stops working."
        checked={props.roll}
        onCheckedChange={(checked) => props.setRoll(checked === true)}
      />
    </div>
  );
}

function ChangeRoleDialog(props: {
  member: MemberRow;
  choices: RoleChoice[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const fin = useFin<ConsoleViewer>();
  const credentials = useCredentials(props.member);
  const [roleKey, setRoleKey] = useState<string>(props.member.roleKey);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = props.member.name === "" ? props.member.email : props.member.name;
  const label = props.choices.find((choice) => choice.roleKey === roleKey)?.label ?? roleKey;

  const save = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await withReasonValues({ name, role: label }, () =>
        fin.api(changeMemberRole, {
          memberId: props.member.memberId,
          roleKey,
          rollCredentials: credentials.roll,
        }),
      );
      toast.success(`${name}’s role is now ${label}`);
      await props.onChanged();
    } catch (error) {
      if (!toldElsewhere(error)) setFailed(roleRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      busy={busy}
      title={`Change ${name}’s role`}
      description={props.member.email}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={roleKey === props.member.roleKey}
            onClick={save}
          >
            Save
          </Button>
        </>
      }
    >
      {failed === null ? null : (
        <InlineAlert tone="danger" title="The role didn’t change" live="assertive">
          {failed}
        </InlineAlert>
      )}
      <RolePicker
        label="Role"
        choices={props.choices}
        value={roleKey}
        onChange={setRoleKey}
        disabled={busy}
      />
      <CredentialsNotice {...credentials} name={name} />
    </Modal>
  );
}

function RemoveDialog(props: {
  member: MemberRow;
  organisation: string;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const fin = useFin<ConsoleViewer>();
  const credentials = useCredentials(props.member);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = props.member.name === "" ? props.member.email : props.member.name;

  const remove = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await withReasonValues({ name }, () =>
        fin.api(removeMember, {
          memberId: props.member.memberId,
          rollCredentials: credentials.roll,
        }),
      );
      toast.success(`${name} was removed`);
      await props.onRemoved();
    } catch (error) {
      if (!toldElsewhere(error)) setFailed(roleRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      busy={busy}
      title={`Remove ${name}?`}
      description={`They lose access to ${props.organisation} at once. You can invite them again.`}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={remove}>
            Remove
          </Button>
        </>
      }
    >
      {failed === null ? null : (
        <InlineAlert tone="danger" title={`Couldn’t remove ${name}`} live="assertive">
          {failed}
        </InlineAlert>
      )}
      <CredentialsNotice {...credentials} name={name} />
    </Modal>
  );
}

function InvitationRoleDialog(props: {
  invitation: InvitationRow;
  choices: RoleChoice[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const fin = useFin<ConsoleViewer>();
  const [roleKey, setRoleKey] = useState<string>(props.invitation.roleKey);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await withReasonValues({ email: props.invitation.email }, () =>
        fin.api(changeInvitation, { invitationId: props.invitation.invitationId, roleKey }),
      );
      toast.success(`The invitation for ${props.invitation.email} was changed`);
      await props.onChanged();
    } catch (error) {
      if (!toldElsewhere(error)) setFailed(roleRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      busy={busy}
      title={`Change the invitation for ${props.invitation.email}`}
      description="The old link stops working, and a new one is sent."
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={roleKey === props.invitation.roleKey}
            onClick={save}
          >
            Save
          </Button>
        </>
      }
    >
      {failed === null ? null : (
        <InlineAlert tone="danger" title="The invitation didn’t change" live="assertive">
          {failed}
        </InlineAlert>
      )}
      <RolePicker
        label="Role"
        choices={props.choices}
        value={roleKey}
        onChange={setRoleKey}
        disabled={busy}
      />
    </Modal>
  );
}
