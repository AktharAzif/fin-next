// Fin Admin's audit log routes as the AdminAudit screen calls them (spec 02 §14.3, §14.5): a page
// of the staff log and one entry, both GETs through @fin/frame's api(), same-origin. The answers
// are what the screen reads and nothing more; one that fails its schema is reported with IDs only
// and drawn as the page's failed state. The API half's tests parse its answers with these schemas,
// so the two halves cannot drift apart unseen. They move to packages/app-contracts/src/staff/ with
// the staff lane's other contracts (spec 06 §11.3).
import { defineContract, z } from "@fin/app-contracts";
import { AUDIT_ID } from "./ids.ts";

/** An object a row names: its ID, and its current label where it is a staff object that exists. */
export const auditObject = z.object({ id: z.string().min(1), label: z.string().nullable() });

export const auditEntry = z.object({
  id: z.string().regex(AUDIT_ID),
  event: z.string().min(1),
  category: z.string(),
  at: z.string(),
  actor: z.object({
    kind: z.string(),
    id: z.string().nullable(),
    via: z.string(),
    email: z.string().nullable(),
    name: z.string().nullable(),
  }),
  target: auditObject,
  refs: z.array(auditObject),
  organisationId: z.string().nullable(),
  /** Flat: IDs, statuses, codes, counts and role keys; never a name, an address or typed text. */
  metadata: z.record(z.string(), z.unknown()),
  /** How the actor was verified ([BC-03]); null for the operator, the system or a provider. */
  verification: z.string().nullable(),
  /** The client address of the request, from the tunnel. */
  address: z.string().nullable(),
  /** A short device summary ("Chrome on Mac"), never the raw user agent. */
  device: z.string().nullable(),
});
export type AuditEntry = z.output<typeof auditEntry>;

export const auditPerson = z.object({ id: z.string().min(1), email: z.string() });
export type AuditPerson = z.output<typeof auditPerson>;

export const auditPageAnswer = z.object({
  items: z.array(auditEntry),
  total: z.number().int().nonnegative(),
  totalCapped: z.boolean(),
  /**
   * The older page's cursor, or null when nothing older matches. On a page with no rows past the
   * newest end, the way back to the rows.
   */
  nextCursor: z.string().nullable(),
  /**
   * The newer page's cursor, or null on the first page. On a page with no rows past the oldest
   * end, the way back to the rows.
   */
  previousCursor: z.string().nullable(),
  /** The Staff member filter's choices; empty for a reader without `staff.read`. */
  people: z.array(auditPerson),
});
export type AuditPageAnswer = z.output<typeof auditPageAnswer>;

export const auditEntryAnswer = z.object({ entry: auditEntry });

/** The query the list takes: comma-separated IDs and event names, presets and UTC days. */
export const auditListInput = z.object({
  show: z.enum(["mine", "rejections"]).optional(),
  actor: z.string().optional(),
  action: z.string().optional(),
  org: z.string().optional(),
  date: z.enum(["today", "week", "7d", "30d", "month"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type AuditListInput = z.input<typeof auditListInput>;

/** `GET /api/audit` (`audit.read`): one page of the staff log, newest first. */
export const listAudit = defineContract({
  name: "audit.list",
  method: "GET",
  path: "/audit",
  input: auditListInput,
  output: auditPageAnswer,
});

/** `GET /api/audit/:eventId` (`audit.read`): one entry, for the drawer's deep link. */
export const getAuditEntry = defineContract({
  name: "audit.get",
  method: "GET",
  path: "/audit/:eventId",
  input: z.object({ eventId: z.string().min(1).max(64) }),
  output: auditEntryAnswer,
});
