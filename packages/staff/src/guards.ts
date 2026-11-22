// The staff area's audit guard registrations (spec 02 §13.8, [AU-02]) for the tables this package
// creates, in packages/db's `defineGuards` shape (the registration file is
// packages/db/src/guards/staff.ts once it is assembled there). The `_staff_fin` migration installs
// exactly these; guards.test.ts compares the two and guards.db.test.ts proves each refuses a
// commit without its event. The staff realm's sign-in tables (staff.member, staff.session, ...)
// are guarded by @fin/identity's `_identity_guards`.
export interface StaffGuard {
  readonly table: string;
  readonly ops: readonly string[];
  readonly keyColumn: string;
  readonly events: readonly string[];
}

const ROLE_EVENTS = ["staff.role_created", "staff.role_updated", "staff.role_deleted"] as const;

export const STAFF_GUARDS: readonly StaffGuard[] = [
  {
    table: "staff.role",
    ops: ["INSERT", "UPDATE", "DELETE"],
    keyColumn: "id",
    events: ROLE_EVENTS,
  },
  // A permission row a role's cascade deletes is covered by that delete's event, which names the role.
  {
    table: "staff.role_permission",
    ops: ["INSERT", "DELETE"],
    keyColumn: "role_id",
    events: ROLE_EVENTS,
  },
];

/** The migration statement for a registration. */
export function guardSql(guard: StaffGuard): string {
  const list = (items: readonly string[]) => `ARRAY[${items.map((i) => `'${i}'`).join(", ")}]`;
  return `SELECT audit.install_guard('${guard.table}'::regclass, ${list(guard.ops)}, '${guard.keyColumn}', ${list(guard.events)});`;
}
