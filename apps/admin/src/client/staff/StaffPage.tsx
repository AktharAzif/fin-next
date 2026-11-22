// Staff (AdminStaff board; spec 02 §10.2, §15.3): who can use Fin Admin, their roles and when they
// last signed in, and the four prebuilt roles. An Admin adds someone (with "Confirm it's you" and
// the enrolment code shown once), changes a role, removes someone, or makes a pending member a new
// code. What a role cannot do is drawn disabled with the reason; the last Admin stays.
import type { StaffViewer } from "@fin/app-contracts";
import { RouterLink, useFin } from "@fin/frame";
import { PlusIcon } from "@fin/icons";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Skeleton,
  Table,
  type TableColumn,
  toast,
} from "@fin/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { StaffMember, StaffRole } from "../api/contracts.ts";
import { formatUtc } from "../format.ts";
import { StaffTabs } from "../roles/StaffTabs.tsx";
import {
  AddStaffDialog,
  actorOf,
  ChangeRoleDialog,
  EnrolmentCodeDialog,
  type IssuedCode,
  NewCodeDialog,
  RemoveDialog,
} from "./dialogs.tsx";
import type { StaffData } from "./load.ts";
import { type Actor, addReason, rowControls } from "./rules.ts";

export const STAFF_DESCRIPTION =
  "Who can use Fin Admin and what they may do. Cloudflare Access decides who can reach it.";

/** "Last signed in": a time, or "Not yet" before the first sign-in. */
export function lastSignedIn(member: StaffMember): string {
  if (member.lastSignedInAt === null) return "Not yet";
  return formatUtc(member.lastSignedInAt) ?? "Not yet";
}

function RolesCard({ roles }: { roles: readonly StaffRole[] }) {
  return (
    <section aria-labelledby="staff-roles" className="flex max-w-190 flex-col gap-4">
      <h2 id="staff-roles" className="m-0 text-heading text-text-primary">
        Roles
      </h2>
      {/* @pendingDesign UR-23: the board's DetailList, composed from tokens until @fin/ui has it. */}
      <dl className="m-0 flex flex-col divide-y divide-border border-y border-border">
        {roles.map((role) => (
          <div key={role.key} className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-6">
            <dt className="text-label text-text-primary">{role.label}</dt>
            <dd className="m-0 text-body text-text-secondary">{role.summary}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RolesSkeleton() {
  return (
    <div aria-hidden="true" className="flex max-w-190 flex-col gap-4">
      <Skeleton shape="block" className="h-6 w-24" />
      {["viewer", "compliance", "operator", "admin"].map((key) => (
        <Skeleton key={key} className="h-4 w-full" />
      ))}
    </div>
  );
}

const STAFF_NOUN = { singular: "member of staff", plural: "staff" } as const;

function columns(
  actor: Actor,
  staff: readonly StaffMember[],
  roles: readonly StaffRole[],
  open: {
    changeRole: (member: StaffMember) => void;
    remove: (member: StaffMember) => void;
    newCode: (member: StaffMember) => void;
  },
): TableColumn<StaffMember>[] {
  return [
    {
      id: "email",
      header: "Email",
      width: "auto",
      cell: (member) => (
        <div className="flex min-w-0 flex-col items-start py-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-label text-text-primary">{member.email}</span>
            {member.id === actor.id ? (
              <Badge variant="secondary" size="sm">
                You
              </Badge>
            ) : null}
          </span>
          {member.status === "pending" ? (
            <span className="text-caption text-text-tertiary">Hasn’t signed in yet</span>
          ) : null}
        </div>
      ),
    },
    { id: "role", header: "Role", width: "md", cell: (member) => member.roleLabel },
    {
      id: "last",
      header: "Last signed in",
      kind: "date",
      width: "lg",
      cell: (member) => lastSignedIn(member),
    },
    {
      id: "actions",
      header: "Actions",
      hideHeader: true,
      kind: "actions",
      width: "xl",
      cell: (member) => {
        const controls = rowControls(actor, member, staff, roles);
        return (
          <span className="flex items-center justify-end gap-2">
            {controls.newCode === undefined ? null : (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`New enrolment code for ${member.email}`}
                {...(controls.newCode === null ? {} : { disabledReason: controls.newCode })}
                onClick={() => open.newCode(member)}
              >
                New code
              </Button>
            )}
            <Button
              size="sm"
              aria-label={`Change role of ${member.email}`}
              {...(controls.changeRole === null ? {} : { disabledReason: controls.changeRole })}
              onClick={() => open.changeRole(member)}
            >
              Change role
            </Button>
            <Button
              size="sm"
              aria-label={`Remove ${member.email}`}
              {...(controls.remove === null ? {} : { disabledReason: controls.remove })}
              onClick={() => open.remove(member)}
            >
              Remove
            </Button>
          </span>
        );
      },
    },
  ];
}

/** The page before its first answer: the header, the table's loading rows and the Roles card. */
export function StaffSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Staff"
        description={STAFF_DESCRIPTION}
        tabs={<StaffTabs current="staff" />}
        linkAs={RouterLink}
      />
      <div className="flex flex-col gap-16">
        <Table
          caption="Staff list"
          noun={STAFF_NOUN}
          columns={[
            { id: "email", header: "Email", cell: () => null },
            { id: "role", header: "Role", width: "md", cell: () => null },
            { id: "last", header: "Last signed in", kind: "date", width: "lg", cell: () => null },
          ]}
          rows={[]}
          getRowId={() => ""}
          getRowLabel={() => ""}
          status="loading"
          loadingRows={4}
          empty={null}
        />
        <RolesSkeleton />
      </div>
    </div>
  );
}

export function StaffPage({
  data,
  openAdd,
  onAddClosed,
}: {
  data: StaffData;
  /** `?view=add`: the Add staff dialog open on arrival. */
  openAdd: boolean;
  onAddClosed: () => void;
}) {
  const fin = useFin<StaffViewer>();
  const router = useRouter();
  const viewer = fin.viewer.get();
  const [adding, setAdding] = useState(openAdd);
  const [changing, setChanging] = useState<StaffMember | null>(null);
  const [removing, setRemoving] = useState<StaffMember | null>(null);
  const [reissuing, setReissuing] = useState<StaffMember | null>(null);
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [retrying, setRetrying] = useState(false);

  if (viewer?.state !== "ok" || data.kind === "notAllowed") return null;
  const actor = actorOf(viewer);
  const reload = () => router.invalidate();

  const cannotAdd = addReason(actor);
  const header = (
    <PageHeader
      title="Staff"
      description={STAFF_DESCRIPTION}
      tabs={<StaffTabs current="staff" />}
      linkAs={RouterLink}
      {...(data.kind === "ready"
        ? {
            primaryAction: (
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<PlusIcon />}
                {...(cannotAdd === null ? {} : { disabledReason: cannotAdd })}
                onClick={() => setAdding(true)}
              >
                Add staff
              </Button>
            ),
          }
        : {})}
    />
  );

  const body =
    data.kind === "failed" ? (
      <Table
        caption="Staff list"
        noun={STAFF_NOUN}
        columns={[
          { id: "email", header: "Email", cell: () => null },
          { id: "role", header: "Role", width: "md", cell: () => null },
          { id: "last", header: "Last signed in", kind: "date", width: "lg", cell: () => null },
        ]}
        rows={[]}
        getRowId={() => ""}
        getRowLabel={() => ""}
        status="error"
        error={{
          title: "Couldn’t load staff",
          // A load changes nothing, and it may follow a change that went through: it says neither.
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
    ) : (
      <div className="flex flex-col gap-16">
        <Table
          caption="Staff list"
          noun={STAFF_NOUN}
          columns={columns(actor, data.staff, data.roles, {
            changeRole: setChanging,
            remove: setRemoving,
            newCode: setReissuing,
          })}
          rows={data.staff}
          getRowId={(member) => member.id}
          getRowLabel={(member) =>
            `${member.email}, ${member.roleLabel}, last signed in ${lastSignedIn(member)}`
          }
          status="ready"
          empty={
            <EmptyState
              variant="section"
              title="No staff yet"
              description="Add someone to give them Fin Admin."
            />
          }
        />
        <RolesCard roles={data.roles} />
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      {header}
      {body}

      {data.kind === "ready" ? (
        <>
          <AddStaffDialog
            open={adding}
            onOpenChange={(open) => {
              setAdding(open);
              if (!open) onAddClosed();
            }}
            actor={actor}
            roles={data.roles}
            onStale={reload}
            onAdded={(code) => {
              setAdding(false);
              onAddClosed();
              setIssued(code);
              void reload();
            }}
          />
          <ChangeRoleDialog
            member={changing}
            onClose={() => setChanging(null)}
            actor={actor}
            roles={data.roles}
            onStale={reload}
            onChanged={(member) => {
              setChanging(null);
              toast.success({
                title: "Role changed",
                description: `${member.email} is now ${member.roleLabel}. They sign in again to use it.`,
              });
              void reload();
            }}
          />
          <RemoveDialog
            member={removing}
            onClose={() => setRemoving(null)}
            onStale={reload}
            onRemoved={(member) => {
              setRemoving(null);
              toast.success({
                title: "Removed from staff",
                description: `${member.email} can’t use Fin Admin any more. Take their address off the Access list too.`,
              });
              void reload();
            }}
          />
          <NewCodeDialog
            member={reissuing}
            onClose={() => setReissuing(null)}
            onStale={reload}
            onIssued={(code) => {
              setReissuing(null);
              setIssued(code);
            }}
          />
        </>
      ) : null}
      {/* Drawn whatever the list's state: the code is shown once, and a list that cannot load
          after the change must not take it off the screen (spec 02 §6.5, §10.2). */}
      <EnrolmentCodeDialog
        issued={issued}
        onDone={() => {
          const done = issued;
          setIssued(null);
          if (done?.reason === "added") {
            toast.success({
              title: "Staff added",
              description: `${done.email} signs in with the code you handed them. Every Admin is emailed.`,
            });
          }
        }}
      />
    </div>
  );
}
