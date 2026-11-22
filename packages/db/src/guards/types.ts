// Audit guard registrations (spec 08 §3.5). Each area declares its guarded tables in
// packages/db/src/guards/<area>.ts, owned by the area's lane; the area's migration calls
// audit.install_guard with the same values, and the guard test (T08-06) compares every registration
// with pg_trigger and proves each refuses a commit without its event.

export type GuardOperation = "INSERT" | "DELETE" | "UPDATE" | `UPDATE OF ${string}`;

export interface GuardRegistration {
  /** Schema-qualified: `ops.kill_switch`. */
  table: string;
  ops: readonly GuardOperation[];
  /** The column whose value an accepted event must carry in `target_id`, `ref_ids` or `step_up_ref`. */
  keyColumn: string;
  /** Accepted event names; `*` accepts any event naming the key. */
  events: readonly string[];
}

export function defineGuards<const T extends readonly GuardRegistration[]>(guards: T): T {
  for (const guard of guards) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(guard.table)) {
      throw new TypeError(`guard table ${guard.table} is not schema-qualified`);
    }
    if (guard.ops.length === 0 || guard.events.length === 0) {
      throw new TypeError(`guard on ${guard.table} needs operations and events`);
    }
    for (const op of guard.ops) {
      if (!/^(INSERT|DELETE|UPDATE|UPDATE OF [a-z_][a-z0-9_]*(, [a-z_][a-z0-9_]*)*)$/.test(op)) {
        throw new TypeError(`guard on ${guard.table} has a bad operation`);
      }
    }
    for (const event of guard.events) {
      if (event !== "*" && !/^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$/.test(event)) {
        throw new TypeError(`guard on ${guard.table} names a bad event`);
      }
    }
  }
  return guards;
}
