// Settings · Roles (Roles board; spec 02 §8.4, §15.2, §15.2.1): the built-in roles and the
// organisation's own, with who holds each and how much it allows; duplicate, and delete with the
// role its holders and invitations move to. Read-only without `role.manage`; moving people needs
// `member.role` as well. "See changes in the audit log" shows only with `auditLog.read`.
import type { ConsoleViewer } from "@fin/app-contracts";
import { RouterLink, useFin } from "@fin/frame";
import { DotsThreeIcon, PlusIcon } from "@fin/icons";
import {
  Button,
  buttonClasses,
  DropdownMenu,
  EmptyState,
  IconButton,
  InlineAlert,
  MenuItem,
  MenuSeparator,
  Modal,
  PageHeader,
  SkeletonPage,
  Table,
  type TableColumn,
  toast,
} from "@fin/ui";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { toldElsewhere } from "../../../api/actions.ts";
import { deleteRole, type RoleRow, roles as rolesContract } from "../../../api/contracts/roles.ts";
import { useResource } from "../../../api/resource.ts";
import {
  Block,
  QuietArrowLink,
  ROLE_REASON,
  SectionFailure,
  SettingsTabs,
  useSignedIn,
} from "../../../components/page.tsx";
import {
  canGiveAny,
  pickedRole,
  RolePicker,
  roleChoices,
  roleSummary,
  whyNoRole,
} from "../../../components/roles.tsx";
import { holdersText, permissionsText, roleHref } from "../../../format/text.ts";
import { withReasonValues } from "../../../step-up/reasons.ts";

export const Route = createFileRoute("/settings/roles/")({
  staticData: { frame: "app", navId: "settings", pageName: "Settings", needs: ["member.read"] },
  pendingComponent: () => <SkeletonPage label="the roles" rows={5} />,
  component: RolesPage,
});

const DESCRIPTION =
  "Each person’s role decides what they can do. Anyone with Production access must use a second factor.";

function RolesPage() {
  const fin = useFin<ConsoleViewer>();
  const signedIn = useSignedIn();
  const orgId = signedIn?.viewer.currentOrgId ?? "";
  const list = useResource(`roles:${orgId}`, (signal) => fin.api(rolesContract, {}, { signal }));
  const [deleting, setDeleting] = useState<RoleRow | null>(null);
  const can = signedIn?.can ?? (() => false);
  const manage = can("role.manage");
  const auditLink = can("auditLog.read");
  const all = list.data?.roles ?? [];
  const builtIn = all.filter((role) => role.builtIn);
  const own = all.filter((role) => !role.builtIn);

  const columns: TableColumn<RoleRow>[] = [
    {
      id: "role",
      header: "Role",
      cell: (role) => (
        <div className="flex flex-col py-1.5">
          <RouterLink
            href={roleHref(role.roleKey)}
            data-row-link=""
            className="rounded-xs text-label text-text-primary no-underline focus-visible:outline-focus"
          >
            {role.label}
          </RouterLink>
          <span className="text-caption text-text-tertiary">{roleSummary(role)}</span>
        </div>
      ),
    },
    { id: "people", header: "People", width: "md", cell: (role) => holdersText(role.holders) },
    {
      id: "permissions",
      header: "Permissions",
      width: "lg",
      hideBelow: "xl",
      cell: (role) => permissionsText(role.permissionCount),
    },
    {
      id: "actions",
      header: "Actions",
      kind: "actions",
      width: "xs",
      hideHeader: true,
      cell: (role) =>
        !manage ? null : (
          <DropdownMenu
            align="end"
            trigger={
              <IconButton size="sm" label={`More for ${role.label}`} icon={<DotsThreeIcon />} />
            }
          >
            <MenuItem
              href={`/settings/roles/new?${new URLSearchParams({ from: role.roleKey }).toString()}`}
            >
              Duplicate
            </MenuItem>
            {role.builtIn ? null : (
              <>
                <MenuSeparator />
                <MenuItem destructive onSelect={() => setDeleting(role)}>
                  Delete role
                </MenuItem>
              </>
            )}
          </DropdownMenu>
        ),
    },
  ];

  const table = (caption: string, rows: RoleRow[], empty: ReactNode) => (
    <Table
      caption={caption}
      noun={{ singular: "role", plural: "roles" }}
      columns={columns}
      rows={rows}
      getRowId={(role) => role.roleKey}
      getRowLabel={(role) => `${role.label}, ${holdersText(role.holders)}`}
      getRowHref={(role) => roleHref(role.roleKey)}
      status={
        list.data === null ? "loading" : list.status === "refreshing" ? "refreshing" : "ready"
      }
      loadingRows={caption === "Built-in roles" ? 2 : 3}
      empty={empty}
    />
  );

  const newRole = manage ? (
    <RouterLink href="/settings/roles/new" className={buttonClasses("primary", "md")}>
      <PlusIcon />
      New role
    </RouterLink>
  ) : (
    <Button variant="primary" leadingIcon={<PlusIcon />} disabledReason={ROLE_REASON}>
      New role
    </Button>
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Settings"
        description={DESCRIPTION}
        primaryAction={newRole}
        tabs={<SettingsTabs current="roles" />}
        linkAs={RouterLink}
      />
      {manage ? null : (
        <InlineAlert
          tone="info"
          title="You can see the roles. Changing them needs Create and change roles."
        />
      )}
      {list.status === "error" && list.data === null ? (
        <SectionFailure title="Couldn’t load the roles" error={list.error} onRetry={list.reload} />
      ) : (
        <>
          <Block
            title="Built in"
            {...(list.data === null ? {} : { count: builtIn.length })}
            description={
              manage
                ? "Built-in roles can’t be changed. Duplicate one to start a role of your own."
                : "Built-in roles can’t be changed."
            }
            aside={
              auditLink ? (
                <QuietArrowLink href="/audit-log?type=team&targetKind=role">
                  See changes in the audit log
                </QuietArrowLink>
              ) : undefined
            }
          >
            {table("Built-in roles", builtIn, null)}
          </Block>
          <Block title="Your roles" {...(list.data === null ? {} : { count: own.length })}>
            {table(
              "Your roles",
              own,
              <EmptyState
                variant="first-use"
                title="No roles of your own yet"
                description="Start one from nothing, or duplicate a built-in role."
                {...(manage
                  ? {
                      action: (
                        <RouterLink
                          href="/settings/roles/new"
                          className={buttonClasses("secondary", "sm")}
                        >
                          New role
                        </RouterLink>
                      ),
                    }
                  : {})}
              />,
            )}
          </Block>
        </>
      )}
      {deleting === null ? null : (
        <DeleteRoleDialog
          role={deleting}
          roles={all}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            await list.reload();
          }}
        />
      )}
    </div>
  );
}

function DeleteRoleDialog(props: {
  role: RoleRow;
  roles: RoleRow[];
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const fin = useFin<ConsoleViewer>();
  const signedIn = useSignedIn();
  const choices = roleChoices(
    props.roles.filter((role) => role.roleKey !== props.role.roleKey),
    {
      roleKey: signedIn?.membership?.roleKey ?? "",
      permissions: signedIn?.viewer.permissions ?? [],
    },
  );
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const holders = props.role.holders;
  const invitations = props.role.invitations ?? 0;
  const moves = holders > 0 || invitations > 0;
  const blocked = holders > 0 && signedIn?.can("member.role") !== true;
  // Where they move is the person's own pick: nothing is chosen for them (least privilege).
  const chosen = pickedRole(choices, moveTo);
  const noRole = moves ? whyNoRole(choices, moveTo) : null;
  const chosenLabel = choices.find((choice) => choice.roleKey === chosen)?.label ?? "";

  const description =
    holders > 0
      ? `${holdersText(holders)} ${holders === 1 ? "has" : "have"} this role. Pick the role they move to.`
      : invitations > 0
        ? "Invitations waiting for an answer give this role. Pick the role they give instead."
        : "Nobody has this role. You can’t undo this.";

  const remove = async () => {
    if (moves && chosen === null) return;
    setBusy(true);
    setFailed(false);
    try {
      await withReasonValues("role.delete", { role: props.role.label }, () =>
        fin.api(deleteRole, {
          roleId: props.role.roleId ?? props.role.roleKey,
          ...(moves && chosen !== null ? { moveTo: chosen } : {}),
        }),
      );
      toast.success({
        title: `${props.role.label} was deleted`,
        ...(moves && chosenLabel !== "" ? { description: `They are now ${chosenLabel}.` } : {}),
      });
      await props.onDeleted();
    } catch (error) {
      if (!toldElsewhere(error)) setFailed(true);
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
      title={`Delete ${props.role.label}?`}
      description={description}
      footer={
        blocked ? (
          <Button variant="secondary" onClick={props.onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              {...(noRole === null
                ? {}
                : {
                    disabledReason: canGiveAny(choices)
                      ? noRole
                      : "There is no role you can move them to.",
                  })}
              onClick={remove}
            >
              Delete role
            </Button>
          </>
        )
      }
    >
      {failed ? (
        <InlineAlert
          tone="danger"
          title="The role wasn’t deleted, and nobody moved"
          live="assertive"
        >
          Try again.
        </InlineAlert>
      ) : null}
      {blocked ? (
        <InlineAlert tone="info" title="You can’t move people to another role.">
          Ask someone who can change people’s roles.
        </InlineAlert>
      ) : moves ? (
        <RolePicker
          label="Move them to"
          choices={choices}
          value={chosen}
          onChange={setMoveTo}
          disabled={busy}
        />
      ) : null}
    </Modal>
  );
}
