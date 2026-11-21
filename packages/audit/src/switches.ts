// The automatic money trips (ARCHITECTURE §15.1, spec 04 §31): ops.trip_switch() sets the switch on and
// records switch.tripped itself, in the caller's transaction; this wrapper gives it the unit's ID and
// release, writes the journal entry the event declares (switch_set, spec 08 §3.10), and writes the
// `switch.tripped` security line. A refusal by the database writes `audit.write_failed` like any
// audit failure, and a string Postgres could not store is refused before any SQL, as recordAudit
// refuses one (AuditMetadataError).
import type { UnitTx } from "@fin/db";
import { eventSpec, rethrowAuditFailure, writeJournalEntry } from "./record.ts";
import { assertStorableText } from "./shapes.ts";

export type TripReason =
  | "idempotency_mismatch"
  | "sent_after_end"
  | "orphan_payout"
  | "reconciliation_break";

export interface Trip {
  /** `live_money` or `provider_instance:<instance>`. */
  name: "live_money" | `provider_instance:${string}`;
  reasonCode: TripReason;
  /** The transfer or break that caused it. */
  ref: string | null;
  via: "reconciliation" | "job";
}

export async function tripSwitch(tx: UnitTx, trip: Trip): Promise<string> {
  const spec = eventSpec("switch.tripped");
  assertStorableText(
    { name: trip.name, ref: trip.ref, requestId: tx.context.requestId ?? null },
    "trip",
  );
  const id = tx.ids.newId("aud");
  try {
    await tx.query("SELECT ops.trip_switch($1, $2, $3, $4, $5, $6, $7)", [
      trip.name,
      trip.reasonCode,
      trip.ref,
      trip.via,
      id,
      tx.context.release,
      tx.context.requestId ?? null,
    ]);
  } catch (error) {
    rethrowAuditFailure(tx, "switch.tripped", error);
  }
  await writeJournalEntry(tx, spec, {
    event: "switch.tripped",
    eventId: id,
    metadata: { reasonCode: trip.reasonCode, ref: trip.ref },
  });
  tx.context.log.write({
    event: "switch.tripped",
    level: "warn",
    fields: { switch: trip.name, reasonCode: trip.reasonCode },
  });
  return id;
}
