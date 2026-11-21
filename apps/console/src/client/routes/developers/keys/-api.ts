// The API keys routes as the page reads them (spec 02 §12.3; the console API half's policy/keys.ts):
// a mode's list with what the role may make, create (the secret in the answer, shown once), edit,
// roll and revoke, each of the changes after a step-up intent the frame's StepUp dialog proves.
// Unknown fields are kept.
import { defineContract, z } from "@fin/app-contracts";

export const KEY_STATUSES = ["active", "rolling", "expired", "revoked"] as const;

export const keyRow = z.looseObject({
  keyId: z.string().min(1),
  name: z.string(),
  prefix: z.string(),
  mode: z.enum(["test", "live"]),
  kind: z.enum(["sk", "rk"]),
  access: z.string(),
  scopes: z.array(z.string()),
  ipAllowlist: z.array(z.string()),
  status: z.enum(KEY_STATUSES),
  createdAt: z.string(),
  createdBy: z.looseObject({ userId: z.string(), name: z.string() }),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
  rollingUntil: z.string().nullable(),
  replacedBy: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  flags: z.looseObject({ makerLacksPermissions: z.boolean(), secretUnseen: z.boolean() }),
});
export type KeyRow = z.output<typeof keyRow>;

const makeable = z.looseObject({
  manage: z.boolean(),
  fullAccess: z.boolean(),
  scopes: z.array(z.string()),
});

export const keysList = defineContract({
  name: "keys.list",
  method: "GET",
  path: "/keys",
  organization: true,
  input: z.object({
    mode: z.enum(["test", "live"]),
    page: z.number().int().positive().optional(),
    size: z.number().int().positive().max(100).optional(),
  }),
  output: z.looseObject({
    keys: z.array(keyRow),
    total: z.number().int().nonnegative(),
    working: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    can: z.looseObject({ test: makeable, live: makeable.extend({ approved: z.boolean() }) }),
  }),
});
export type KeysAnswer = z.output<(typeof keysList)["output"]>;

const madeKey = z.looseObject({ secret: z.string().min(1), key: keyRow });

export const createKey = defineContract({
  name: "keys.create",
  method: "POST",
  path: "/keys",
  organization: true,
  creates: true,
  input: z.object({
    name: z.string().max(200),
    mode: z.enum(["test", "live"]),
    kind: z.enum(["sk", "rk"]),
    scopes: z.array(z.string()),
    ipAllowlist: z.array(z.string()),
    expiresIn: z.enum(["30d", "90d", "1y", "never"]),
  }),
  output: madeKey,
});

export const updateKey = defineContract({
  name: "keys.update",
  method: "PATCH",
  path: "/keys/:keyId",
  organization: true,
  input: z.object({
    keyId: z.string().min(1),
    name: z.string().max(200).optional(),
    scopes: z.array(z.string()).optional(),
    expiresAt: z.string().optional(),
    ipAllowlist: z.array(z.string()).optional(),
  }),
  output: z.looseObject({ key: keyRow }),
});

export const rollKey = defineContract({
  name: "keys.roll",
  method: "POST",
  path: "/keys/:keyId/roll",
  organization: true,
  input: z.object({ keyId: z.string().min(1), overlap: z.enum(["now", "1h", "24h"]) }),
  output: madeKey.extend({ replaced: keyRow }),
});

export const revokeKey = defineContract({
  name: "keys.revoke",
  method: "POST",
  path: "/keys/:keyId/revoke",
  organization: true,
  input: z.object({ keyId: z.string().min(1) }),
  output: z.looseObject({ key: keyRow }),
});
