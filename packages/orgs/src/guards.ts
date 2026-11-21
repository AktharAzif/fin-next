// The audit-guard registrations of the organisation tables (spec 02 §13.8, [AU-02], R9): a commit
// that changes a guarded row without an audit row in the same transaction naming the row's key is
// refused (FA010, `database.audit_guard`). The migration `_orgs_guards` installs exactly these
// through `audit.install_guard`; guards.db.test.ts compares them with pg_trigger and proves each.
//
// Spec 02 §20.1 places the registrations in packages/db/src/guards/orgs.ts; this lane owns
// packages/orgs/** only, so they live here and move there with the identity lane's.
//
// Each registration is its own deferred trigger, and every trigger on an operation must pass, so
// two registrations on one operation would each have to be met. §13.8's table lists the bulk path of
// an organisation's deletion as a second registration keyed by `organization_id`; installed as written,
// a deletion with any member could never commit. So (the lane's recorded decision):
//   - a membership's DELETE is guarded once, keyed by `organization_id`, accepting `member.removed`
//     (whose refs carry the organisation) and `organization.deleted`;
//   - a custom role's rows accept `organization.deleted`, whose refs carry every custom role of the
//     organisation (at most 30, within the 32 refs an event may carry);
//   - an invitation's status is guarded per row only: a deletion writes one
//     `member.invitation_cancelled` (reason `organisation_deleted`) per pending invitation (at most 25).

export interface GuardRegistration {
  readonly table: string;
  readonly ops: readonly string[];
  readonly keyColumn: string;
  readonly events: readonly string[];
}

/** An event no login can record: a registration that names only it refuses every such change. */
export const NEVER = "guard.never_allowed";

export const ORGS_GUARDS: readonly GuardRegistration[] = [
  {
    table: "identity.organization",
    ops: ["INSERT", "UPDATE OF name, deleted_at"],
    keyColumn: "id",
    events: ["organization.created", "organization.updated", "organization.deleted"],
  },
  {
    table: "identity.organization",
    ops: ["UPDATE OF created_by"],
    keyColumn: "id",
    events: [NEVER],
  },
  {
    table: "identity.member",
    ops: ["INSERT", "UPDATE OF role_key"],
    keyColumn: "id",
    events: ["member.joined", "member.role_changed", "organization.created"],
  },
  {
    table: "identity.member",
    ops: ["DELETE"],
    keyColumn: "organization_id",
    events: ["member.removed", "organization.deleted"],
  },
  {
    table: "identity.member",
    ops: ["UPDATE OF organization_id, user_id"],
    keyColumn: "id",
    events: [NEVER],
  },
  {
    table: "identity.invitation",
    ops: ["INSERT", "UPDATE OF role_key, status, token_hash"],
    keyColumn: "id",
    events: [
      "member.invited",
      "member.invitation_changed",
      "member.invitation_resent",
      "member.invitation_cancelled",
      "member.invitation_declined",
      "member.joined",
    ],
  },
  {
    table: "identity.invitation",
    ops: ["UPDATE OF organization_id, email, invited_by"],
    keyColumn: "id",
    events: [NEVER],
  },
  {
    table: "identity.role",
    ops: ["INSERT", "UPDATE", "DELETE"],
    keyColumn: "id",
    events: ["role.created", "role.updated", "role.deleted", "organization.deleted"],
  },
  {
    table: "identity.role_permission",
    ops: ["INSERT", "DELETE"],
    keyColumn: "role_id",
    events: ["role.created", "role.updated", "role.deleted", "organization.deleted"],
  },
];

function quote(value: string): string {
  if (!/^[a-z_.,* ]+$/i.test(value)) throw new Error(`guard value ${value} is not plain`);
  return `'${value}'`;
}

/** The migration's statements for the registrations, one `audit.install_guard` call each. */
export function guardSql(guards: readonly GuardRegistration[] = ORGS_GUARDS): string[] {
  return guards.map(
    (g) =>
      `SELECT audit.install_guard(${quote(g.table)}::regclass, ARRAY[${g.ops.map(quote).join(", ")}], ${quote(g.keyColumn)}, ARRAY[${g.events.map(quote).join(", ")}]);`,
  );
}
