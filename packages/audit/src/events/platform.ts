// The platform's own events (spec 08 §3.4, fragment `platform.ts`, lane P0-E).
import { z } from "zod";
import { defineEvents } from "../define.ts";

const journalKindCounts = z.array(z.string().regex(/^[a-z_]+:\d{1,9}$/)).max(50);

export const events = defineEvents("platform", {
  "switch.tripped": {
    category: "operations",
    scope: "staff",
    roles: ["fin_payments", "fin_worker"],
    actors: ["system"],
    target: "switch",
    metadata: z
      .object({
        reasonCode: z.enum([
          "idempotency_mismatch",
          "sent_after_end",
          "orphan_payout",
          "reconciliation_break",
        ]),
        ref: z.string().max(64).nullable(),
      })
      .strict(),
    journal: { kind: "switch_set" },
  },
  "audit.epoch_started": {
    category: "system",
    scope: "staff",
    roles: ["fin_owner"],
    actors: ["operator"],
    target: "epoch",
    metadata: z
      .object({
        reason: z.enum(["created", "restore", "reset", "failover"]),
        previousEpoch: z.number().int().min(0),
        previousSeq: z.number().int().min(0),
        markerKey: z.string().max(200).nullable(),
      })
      .strict(),
  },
  "audit.restore_replayed": {
    category: "operations",
    scope: "staff",
    roles: ["fin_owner"],
    actors: ["operator"],
    target: "marker",
    metadata: z
      .object({
        automatic: journalKindCounts,
        confirmed: journalKindCounts,
        skipped: journalKindCounts,
      })
      .strict(),
  },
  "audit.failover_recorded": {
    category: "system",
    scope: "staff",
    roles: ["fin_owner"],
    actors: ["operator"],
    target: "epoch",
    metadata: z
      .object({
        lastAnchoredSeq: z.number().int().min(0),
        newTimeline: z.number().int().min(1),
        markerKey: z.string().max(200),
      })
      .strict(),
  },
  "operator.task_completed": {
    category: "operations",
    scope: "staff",
    roles: ["fin_owner"],
    actors: ["operator"],
    target: "task",
    metadata: z
      .object({
        task: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
        rowsChanged: z.number().int().min(0),
        release: z.string().max(64),
      })
      .strict(),
  },
  "operator.credential_rotated": {
    category: "operations",
    scope: "staff",
    roles: ["fin_owner"],
    actors: ["operator"],
    target: "family",
    metadata: z
      .object({
        family: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
        version: z.number().int().min(1),
        services: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,62}$/)).max(20),
        overlapEnds: z.iso.date().nullable(),
      })
      .strict(),
  },
  "operator.escrow_opened": {
    category: "operations",
    scope: "staff",
    roles: ["fin_owner"],
    actors: ["operator"],
    target: "family",
    metadata: z
      .object({
        family: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
        version: z.number().int().min(1),
        incidentRef: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      })
      .strict(),
  },
  "system.sweep_completed": {
    category: "system",
    scope: "staff",
    roles: ["fin_worker"],
    actors: ["system"],
    target: "table",
    metadata: z
      .object({
        deleted: z.number().int().min(1),
        olderThan: z.string().regex(/^P(?:\d+[YMWD])*(?:T(?:\d+[HMS])+)?$/),
      })
      .strict(),
  },
});
