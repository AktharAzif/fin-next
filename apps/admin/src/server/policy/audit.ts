// Fin Admin's audit log (spec 02 §14.3, §14.5, §16.4; spec 06 §7.2's AdminAudit): the staff-scope
// rows, newest first, behind requireStaff, `audit.read` and aal2 (the Access check ran at the front
// door). Two GETs: a page of the log, filtered and paged by cursor, and one entry by its ID (the
// drawer's deep link, `view=<aud_…>`). Lists in the query are comma-separated IDs or event names,
// never typed text; the limits are the read's own (@fin/staff), so a query the read would refuse
// is refused here first, naming the field and never the value.
import {
  AUDIT_MAX_ACTIONS,
  AUDIT_MAX_ACTORS,
  AUDIT_MAX_ORGS,
  AUDIT_PAGE_MAX,
  AUDIT_PAGE_SIZE,
  AUDIT_RANGES,
  AUDIT_SHOWS,
} from "@fin/staff";
import { z } from "zod";
import { noParams } from "./schemas.ts";
import { definePolicies } from "./types.ts";

const ID = (prefix: string) => new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`);
const EVENT = /^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A comma-separated list of values of one shape, at most `max` of them. */
function list(shape: RegExp, max: number) {
  return z
    .string()
    .max(2_000)
    .transform((value) => value.split(","))
    .pipe(z.array(z.string().regex(shape)).min(1).max(max));
}

export const auditQuery = z
  .strictObject({
    show: z.enum(AUDIT_SHOWS).optional(),
    actor: list(ID("stf"), AUDIT_MAX_ACTORS).optional(),
    action: list(EVENT, AUDIT_MAX_ACTIONS).optional(),
    org: list(ID("org"), AUDIT_MAX_ORGS).optional(),
    date: z.enum(AUDIT_RANGES).optional(),
    from: z.string().regex(DAY).optional(),
    to: z.string().regex(DAY).optional(),
    cursor: z.string().regex(ID("aud")).optional(),
    before: z.string().regex(ID("aud")).optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(AUDIT_PAGE_SIZE),
  })
  .refine((query) => query.cursor === undefined || query.before === undefined, {
    path: ["before"],
    message: "one cursor at a time",
  })
  .refine(
    (query) => query.date === undefined || (query.from === undefined && query.to === undefined),
    {
      path: ["date"],
      message: "a preset or custom days",
    },
  );

export const auditEntryParams = z.strictObject({ eventId: z.string().regex(ID("aud")) });

export const AUDIT_POLICIES = definePolicies([
  {
    id: "audit.list",
    method: "GET",
    path: "/api/audit",
    guard: "requireStaff",
    permission: "audit.read",
    scope: "staff",
    stepUp: "none",
    action: null,
    bind: [],
    assurance: "aal2_or_working",
    params: noParams,
    query: auditQuery,
    body: null,
    limits: [],
    audit: [],
    secret: false,
  },
  {
    id: "audit.get",
    method: "GET",
    path: "/api/audit/:eventId",
    guard: "requireStaff",
    permission: "audit.read",
    scope: "staff",
    stepUp: "none",
    action: null,
    bind: [],
    assurance: "aal2_or_working",
    params: auditEntryParams,
    query: null,
    body: null,
    limits: [],
    audit: [],
    secret: false,
  },
] as const);
