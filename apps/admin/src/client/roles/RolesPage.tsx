// Staff · Roles (AdminRoles, a new board mirroring the dashboard's Roles with the staff catalogue;
// spec 02 §10.7, §15.3, S2-16): the four prebuilt roles and the custom staff roles, with who holds
// each and how much it allows; duplicate, and delete with the role its holders move to. Read-only
// without `staffRoles.manage` (an Admin-only permission); moving people needs `staff.role` too.
// The server decides every change; this page only asks and reports. A deletion names the holders
// the dialog counted, and a refusal that shows the list is out of date reads it again first, so
// the dialog always counts and offers what is there now.
//
// @pendingDesign UR-16: AdminRoles has no board yet ([UI-04]); this is composed from @fin/ui's
// controls and tokens after the dashboard's Roles board, and enters the state manifest as `new`.
import type { StaffViewer } from "@fin/app-contracts";
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
  Table,
  type TableColumn,
  toast,
} from "@fin/ui";
import { useRouter } from "@tanstack/react-router";
import { type ReactElement, type ReactNode, useState } from "react";
import { type RoleChoice, RolePicker } from "../components/RolePicker.tsx";
import { type Actor, givingReason } from "../staff/rules.ts";
import { withStepUpSubject } from "../step-up/reasons.ts";
import { deleteStaffRole, type StaffRoleRow } from "./contracts.ts";
import {
  actorOf,
  duplicateHref,
  holdersText,
  MANAGE,
  MOVE,
  NO_MANAGE,
  permissionsText,
  READ_ONLY_NOTICE,
  roleHref,
  STAFF_PAGE_DESCRIPTION,
} from "./editor.ts";
import type { RolesData } from "./load.ts";
import { CANT_MOVE, GONE, roleActionError } from "./messages.ts";
import { StaffTabs } from "./StaffTabs.tsx";

const ROLE_NOUN = { singular: "role", plural: "roles" } as const;

function header(primaryAction?: ReactElement) {
  return (
    <PageHeader
      title="Staff"
      description={STAFF_PAGE_DESCRIPTION}
      tabs={<StaffTabs current="roles" />}
      linkAs={RouterLink}
      {...(primaryAction === undefined ? {} : { primaryAction })}
    />
  );
}

const SKELETON_COLUMNS: TableColumn<StaffRoleRow>[] = [
  { id: "role", header: "Role", cell: () => null },
  { id: "people", header: "People", width: "md", cell: () => null },
  { id: "permissions", header: "Permissions", width: "lg", cell: () => null },
];

/** The page before its first answer: the header and both tables' loading rows. */
export function RolesSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      {header()}
      {["Prebuilt roles", "Custom roles"].map((caption) => (
        <Table
          key={caption}
          caption={caption}
          noun={ROLE_NOUN}
          columns={SKELETON_COLUMNS}
          rows={[]}
          getRowId={() => ""}
          getRowLabel={() => ""}
          status="loading"
          loadingRows={caption === "Prebuilt roles" ? 4 : 2}
          empty={null}
        />
      ))}
    </div>
  );
}

function Section(props: {
  id: string;
  title: string;
  description: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={props.id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={props.id} className="m-0 text-heading text-text-primary">
          {props.title}
          {props.count === undefined ? null : (
            <span className="ml-2 text-body text-text-tertiary">{props.count}</span>
          )}
        </h2>
        <p className="m-0 text-body text-text-secondary">{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

export function RolesPage({ data }: { data: RolesData }) {
  const fin = useFin<StaffViewer>();
  const router = useRouter();
  const viewer = fin.viewer.get();
  // The role being deleted, by key: the dialog always draws the row as the list has it now.
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  if (viewer?.state !== "ok" || data.kind === "notAllowed") return null;
  const actor = actorOf(viewer);
  const manage = actor.permissions.has(MANAGE);
  const reload = () => router.invalidate();

  const newRole = manage ? (
    <RouterLink href="/staff/roles/new" className={buttonClasses("primary", "sm")}>
      <PlusIcon />
      New role
    </RouterLink>
  ) : (
    <Button variant="primary" size="sm" leadingIcon={<PlusIcon />} disabledReason={NO_MANAGE}>
      New role
    </Button>
  );

  if (data.kind === "failed") {
    return (
      <div className="flex flex-col gap-8">
        {header(newRole)}
        <Table
          caption="Staff roles"
          noun={ROLE_NOUN}
          columns={SKELETON_COLUMNS}
          rows={[]}
          getRowId={() => ""}
          getRowLabel={() => ""}
          status="error"
          error={{
            title: "Couldn’t load the roles",
            description: data.offline
              ? "Check your connection and try again."
              : "Something went wrong on our side. Try again in a moment.",
            retrying,
            onRetry: async () => {
              setRetrying(true);
              try {
                await reload();
              } finally {
                setRetrying(false);
              }
            },
            ...(data.requestId === null ? {} : { requestId: data.requestId }),
          }}
          empty={null}
        />
      </div>
    );
  }

  const prebuilt = data.roles.filter((role) => role.builtIn);
  const custom = data.roles.filter((role) => !role.builtIn);
  const deleting =
    deletingKey === null ? null : (custom.find((role) => role.key === deletingKey) ?? null);
  const columns: TableColumn<StaffRoleRow>[] = [
    {
      id: "role",
      header: "Role",
      cell: (role) => (
        <div className="flex flex-col py-1.5">
          <RouterLink
            href={roleHref(role.key)}
            data-row-link=""
            className="rounded-xs text-label text-text-primary no-underline focus-visible:outline-focus"
          >
            {role.label}
          </RouterLink>
          <span className="text-caption text-text-tertiary">{role.summary}</span>
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
            <MenuItem href={duplicateHref(role.key)}>Duplicate</MenuItem>
            {role.builtIn ? null : (
              <>
                <MenuSeparator />
                <MenuItem destructive onSelect={() => setDeletingKey(role.key)}>
                  Delete role
                </MenuItem>
              </>
            )}
          </DropdownMenu>
        ),
    },
  ];

  const table = (caption: string, rows: readonly StaffRoleRow[], empty: ReactNode) => (
    <Table
      caption={caption}
      noun={ROLE_NOUN}
      columns={columns}
      rows={rows}
      getRowId={(role) => role.key}
      getRowLabel={(role) => `${role.label}, ${holdersText(role.holders)}`}
      getRowHref={(role) => roleHref(role.key)}
      status="ready"
      empty={empty}
    />
  );

  return (
    <div className="flex flex-col gap-8">
      {header(newRole)}
      {manage ? null : <InlineAlert tone="info" title={READ_ONLY_NOTICE} />}
      <Section
        id="roles-prebuilt"
        title="Prebuilt"
        count={prebuilt.length}
        description={
          manage
            ? "Prebuilt roles can’t be changed. Duplicate one to start a role of your own."
            : "Prebuilt roles can’t be changed."
        }
      >
        {table("Prebuilt roles", prebuilt, null)}
      </Section>
      <Section
        id="roles-custom"
        title="Custom roles"
        count={custom.length}
        description="Roles your Admins made. A custom role never holds what only the Admin role can do."
      >
        {table(
          "Custom roles",
          custom,
          <EmptyState
            variant="first-use"
            title="No custom roles yet"
            description="Start one from nothing, or duplicate a prebuilt role."
            {...(manage
              ? {
                  action: (
                    <RouterLink
                      href="/staff/roles/new"
                      className={buttonClasses("secondary", "sm")}
                    >
                      New role
                    </RouterLink>
                  ),
                }
              : {})}
          />,
        )}
      </Section>
      {deleting === null ? null : (
        <DeleteRoleDialog
          key={deleting.key}
          role={deleting}
          roles={data.roles}
          actor={actor}
          onClose={() => setDeletingKey(null)}
          onStale={reload}
          onGone={async () => {
            setDeletingKey(null);
            await reload();
            toast.info({ title: `${deleting.label} no longer exists`, description: GONE });
          }}
          onDeleted={async () => {
            setDeletingKey(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

/** The roles a deleted role's holders may move to, each with why it cannot be picked. */
export function moveChoices(
  role: StaffRoleRow,
  roles: readonly StaffRoleRow[],
  actor: Actor,
): RoleChoice[] {
  return roles
    .filter((other) => other.key !== role.key)
    .map((other) => ({ role: other, disabledReason: givingReason(actor, other) }));
}

/**
 * The deletion's body: where its holders move, and the holders the dialog counted (the row's
 * `holderIds`), which the server binds, so it never moves anyone given the role since.
 */
export function deletionInput(role: StaffRoleRow, moveTo: string | null) {
  return {
    roleId: role.key,
    holders: [...role.holderIds],
    ...(role.holders > 0 && moveTo !== null ? { moveTo } : {}),
  };
}

function DeleteRoleDialog(props: {
  role: StaffRoleRow;
  roles: readonly StaffRoleRow[];
  actor: Actor;
  onClose: () => void;
  /** Reads the list again: who holds the role, or the roles to move to, changed meanwhile. */
  onStale: () => Promise<void>;
  /** The role no longer exists: closes the dialog, reads the list again and says so. */
  onGone: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const fin = useFin<StaffViewer>();
  const { role, actor } = props;
  const choices = moveChoices(role, props.roles, actor);
  // Where they move is the Admin's own pick: nothing is chosen for them (least privilege).
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const holders = role.holders;
  const moves = holders > 0;
  const blocked = moves && !actor.permissions.has(MOVE);
  const chosen = choices.find((c) => c.role.key === moveTo && c.disabledReason === null) ?? null;

  const description = moves
    ? `${holdersText(holders)} ${holders === 1 ? "has" : "have"} this role. Pick the role they move to. They sign in again to use it.`
    : "Nobody has this role. You can’t undo this.";

  const remove = async () => {
    if (moves && chosen === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const answer = await withStepUpSubject({ role: role.label }, () =>
        fin.api(deleteStaffRole, deletionInput(role, chosen?.role.key ?? null)),
      );
      toast.success({
        title: `${role.label} was deleted`,
        ...(answer.membersMoved > 0 && chosen !== null
          ? { description: `${holdersText(answer.membersMoved)} moved to ${chosen.role.label}.` }
          : {}),
      });
      await props.onDeleted();
    } catch (error) {
      const refused = roleActionError(error, "delete");
      if (refused.stale === "gone") {
        await props.onGone();
        return;
      }
      // The list is read again first, so the count, the picker and the sentence agree.
      if (refused.stale === "list") await props.onStale();
      setMessage(refused.message);
    } finally {
      setBusy(false);
    }
  };

  const noPick = moves && chosen === null ? "Pick the role they move to first." : null;
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      busy={busy}
      title={`Delete ${role.label}?`}
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
              {...(noPick === null ? {} : { disabledReason: noPick })}
              onClick={remove}
            >
              Delete role
            </Button>
          </>
        )
      }
    >
      {message === null ? null : (
        <InlineAlert
          tone="danger"
          title="The role wasn’t deleted, and nobody moved"
          live="assertive"
        >
          {message}
        </InlineAlert>
      )}
      {blocked ? (
        <InlineAlert tone="info" title={CANT_MOVE} />
      ) : moves ? (
        <RolePicker
          label="Move them to"
          choices={choices}
          value={chosen?.role.key ?? null}
          onChange={setMoveTo}
          disabled={busy}
        />
      ) : null}
    </Modal>
  );
}
