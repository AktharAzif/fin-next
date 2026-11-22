// `migrate --task audit-note` (spec 08 §3.4, D08-04): writes the operator event a registered `pnpm fin`
// run ends with, when the database is reachable: a credential rotated, the escrow opened, or a task
// completed outside the database. The run registration in the ops bucket is the record otherwise.
import { recordAudit } from "@fin/audit";
import { z } from "zod";
import { defineTask } from "./types.ts";

const family = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);

const params = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("operator.credential_rotated"),
    family,
    version: z.number().int().min(1),
    services: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,62}$/)).max(20),
    overlapEnds: z.iso.date().nullable(),
  }),
  z.strictObject({
    event: z.literal("operator.escrow_opened"),
    family,
    version: z.number().int().min(1),
    incidentRef: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  }),
  z.strictObject({
    event: z.literal("operator.task_completed"),
    task: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    rowsChanged: z.number().int().min(0),
  }),
]);

export const auditNote = defineTask({
  name: "audit-note",
  params,
  recordsItself: true,
  async run(tx, p, context) {
    const actor = { kind: "operator", id: context.runId, via: "operator" } as const;
    let id: string;
    if (p.event === "operator.credential_rotated") {
      id = await recordAudit(tx, {
        event: p.event,
        actor,
        target: p.family,
        metadata: {
          family: p.family,
          version: p.version,
          services: p.services,
          overlapEnds: p.overlapEnds,
        },
      });
    } else if (p.event === "operator.escrow_opened") {
      id = await recordAudit(tx, {
        event: p.event,
        actor,
        target: p.family,
        metadata: { family: p.family, version: p.version, incidentRef: p.incidentRef },
      });
    } else {
      id = await recordAudit(tx, {
        event: p.event,
        actor,
        target: p.task,
        metadata: { task: p.task, rowsChanged: p.rowsChanged, release: context.release },
      });
    }
    return { rowsChanged: 1, ids: { auditEventId: id } };
  },
});
