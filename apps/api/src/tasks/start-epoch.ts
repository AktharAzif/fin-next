// `migrate --task audit-start-epoch` (spec 08 §3.9): starts a new audit epoch after a restore, a failover
// with lost commits or a staging reset, linked to the previous head's hash, with the marker the operator
// wrote to the ops bucket first. audit.start_epoch() chains what is left of the old epoch, then records
// audit.epoch_started as the new epoch's first row. Production refuses a reset twice: here, before the
// database is asked, and in audit.start_epoch(), which also refuses any start whose environment is not
// the one the bootstrap recorded (FA012).
import { z } from "zod";
import { defineTask } from "./types.ts";

export class StartEpochRefused extends Error {
  override readonly name = "StartEpochRefused";
}

export const startEpoch = defineTask({
  name: "audit-start-epoch",
  params: z.strictObject({
    reason: z.enum(["restore", "reset", "failover"]),
    previousHeadHash: z.string().regex(/^[0-9a-f]{64}$/),
    markerKey: z.string().regex(/^ops\/(restore|reset|failover)\/[A-Za-z0-9._-]{1,120}\.json$/),
  }),
  async run(tx, p, context) {
    if (p.reason === "reset" && context.environment === "production") {
      throw new StartEpochRefused("production refuses an audit reset");
    }
    if (!p.markerKey.startsWith(`ops/${p.reason}/`)) {
      throw new StartEpochRefused("the marker key must sit under the reason's prefix");
    }
    const eventId = tx.ids.newId("aud");
    const result = await tx.query<{ epoch: number }>(
      "SELECT audit.start_epoch($1, $2, $3, $4, $5, $6, $7) AS epoch",
      [
        p.reason,
        Buffer.from(p.previousHeadHash, "hex"),
        p.markerKey,
        eventId,
        context.runId,
        context.release,
        context.environment,
      ],
    );
    const epoch = result.rows[0]?.epoch ?? 0;
    return { rowsChanged: 3, ids: { epoch, auditEventId: eventId } };
  },
});
