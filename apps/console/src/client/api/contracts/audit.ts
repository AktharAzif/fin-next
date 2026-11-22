// The audit log (spec 02 §14.2, §14.5, §15.2.1): the organisation's rows through `api`'s door,
// filtered by search, type, range and one object, with the object's current label. Account
// security's "Recent activity" reads the same row shape for the person. The rows carry IDs, the
// actor and objects resolved to current labels, the verification chip, the address and the device;
// the sentence is drawn here, in the client (src/client/audit/sentences.ts).
import { defineContract, z } from "@fin/app-contracts";

export const VERIFICATIONS = [
  "passkey",
  "totp",
  "backup_code",
  "session",
  "email_otp",
  "password",
  "google",
] as const;
export type Verification = (typeof VERIFICATIONS)[number];

const labelled = z.looseObject({
  id: z.string().min(1),
  /** The object's current label in this organisation, or null when it no longer exists. */
  label: z.string().nullable().optional(),
});

export const auditRow = z.looseObject({
  id: z.string().min(1),
  event: z.string().min(1),
  category: z.string().optional(),
  at: z.string().min(1),
  actor: z.looseObject({
    kind: z.string(),
    id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    roleLabel: z.string().nullable().optional(),
  }),
  target: labelled.nullable().optional(),
  refs: z.array(labelled).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  verification: z.string().nullable().optional(),
  ipAddress: z.string().nullable().optional(),
  device: z.string().nullable().optional(),
});
export type AuditRow = z.output<typeof auditRow>;

export const AUDIT_RANGES = ["today", "7d", "30d", "90d", "all"] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number];

export const auditLog = defineContract({
  name: "audit.organisationLog",
  method: "GET",
  path: "/audit-log",
  organization: true,
  input: z.object({
    q: z.string().max(200).optional(),
    type: z.string().max(40).optional(),
    range: z.enum(AUDIT_RANGES).optional(),
    tz: z.string().max(64).optional(),
    page: z.number().int().positive().optional(),
    size: z.number().int().positive().max(100).optional(),
    target: z.string().max(80).optional(),
    targetKind: z.literal("role").optional(),
  }),
  output: z.looseObject({
    items: z.array(auditRow),
    total: z.number().int().nonnegative(),
    totalCapped: z.boolean().optional(),
    filterLabel: z.string().nullable().optional(),
  }),
});
export type AuditLogAnswer = z.output<(typeof auditLog)["output"]>;
