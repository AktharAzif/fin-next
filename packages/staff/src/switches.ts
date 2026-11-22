// The kill switches from Fin Admin (spec 02 §14.3, S2-27; ARCHITECTURE §15.1; OP-01): staff holding
// `switches.manage` read every switch and set or clear one with an intent bound to the switch, the
// new state and the preset reason. The change goes through `ops.set_switch()` (P0-E), which refuses
// any caller but Fin Admin acting as a staff member or the operator's task; the event
// (`switch.set` or `switch.cleared`), its revocation-journal entry and `staff-switch-changed` to
// every Admin are written in the same transaction, which the guard on ops.kill_switch requires.
import type { StaffDeps } from "./deps.ts";
import { activeAdminAddresses } from "./email.ts";
import { StaffRefusal } from "./errors.ts";
import type { UnitTx } from "./ports.ts";
import type { StaffActor } from "./require-staff.ts";

export const SWITCH_NAME = /^[a-z][a-z_]*(:[a-z0-9][a-z0-9_-]{0,62})?$/;

export interface SwitchRow {
  name: string;
  state: "on" | "off";
  reasonCode: string | null;
  changedBy: { kind: string; id: string | null } | null;
  changedAt: string;
}

interface RawSwitch {
  name: string;
  state: "on" | "off";
  reason_code: string | null;
  changed_by_kind: string | null;
  changed_by_id: string | null;
  changed_at: Date;
}

function toSwitch(row: RawSwitch): SwitchRow {
  return {
    name: row.name,
    state: row.state,
    reasonCode: row.reason_code,
    changedBy:
      row.changed_by_kind === null ? null : { kind: row.changed_by_kind, id: row.changed_by_id },
    changedAt: row.changed_at.toISOString(),
  };
}

/** `GET /api/switches`: each switch's state, who set it and when. */
export async function listSwitches(tx: UnitTx): Promise<SwitchRow[]> {
  const result = await tx.query<RawSwitch>(
    `SELECT name, state, reason_code, changed_by_kind, changed_by_id, changed_at
       FROM ops.kill_switch ORDER BY name`,
  );
  return result.rows.map(toSwitch);
}

/** `POST /api/switches/:switchName`: sets (`on`, the work stops) or clears (`off`) one switch. */
export async function setSwitch(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  name: string,
  input: { state: "on" | "off"; reasonCode: string },
): Promise<SwitchRow> {
  if (!SWITCH_NAME.test(name)) throw new StaffRefusal("not_found", "switch.unknown");
  const current = await tx.query<{ state: "on" | "off" }>(
    "SELECT state FROM ops.kill_switch WHERE name = $1",
    [name],
  );
  const state = current.rows[0]?.state;
  if (state === undefined) throw new StaffRefusal("not_found", "switch.unknown");
  if (state === input.state) {
    throw new StaffRefusal("conflict", "switch.unchanged", { reason: "unchanged" });
  }
  const stepUp = await who.stepUp(tx, {
    action: "switch.set",
    target: name,
    body: { state: input.state, reasonCode: input.reasonCode },
  });
  await tx.query("SELECT ops.set_switch($1, $2, $3, $4::jsonb)", [
    name,
    input.state,
    input.reasonCode,
    JSON.stringify({ kind: "staff", id: who.staffId }),
  ]);
  const event = input.state === "on" ? "switch.set" : "switch.cleared";
  await deps.audit(tx, {
    event,
    actor: { ...who.actor, stepUp },
    target: name,
    metadata: { reasonCode: input.reasonCode },
    request: who.request,
  });
  const time = deps.clock.now().toISOString();
  for (const admin of await activeAdminAddresses(tx)) {
    await deps.notify(tx, {
      template: "staff/staff-switch-changed",
      to: admin.email,
      params: { switch: name, state: input.state, time },
    });
  }
  deps.lines.write(event, "warn", {
    switch: name,
    reasonCode: input.reasonCode,
    staffId: who.staffId,
  });
  const after = await tx.query<RawSwitch>(
    `SELECT name, state, reason_code, changed_by_kind, changed_by_id, changed_at
       FROM ops.kill_switch WHERE name = $1`,
    [name],
  );
  return toSwitch(after.rows[0] as RawSwitch);
}
