// The database roles of spec 01 §6.6 step 4 and ARCHITECTURE §6.3, and the connection budget of
// ARCHITECTURE §4.5 they are sized by.

export const SERVICE_GROUPS = [
  "fin_edge",
  "fin_api",
  "fin_worker",
  "fin_payments",
  "fin_console",
  "fin_admin",
] as const;
export type ServiceGroup = (typeof SERVICE_GROUPS)[number];

/**
 * The owner of `email.enqueue()`: a NOLOGIN role, a member of nothing, holding only what the function
 * needs (INSERT on `email_private.outbox` and what it reads), so the function reaches the worker's
 * private schema while no caller does. fin_owner is its one member, to own and replace the function.
 */
export const ENQUEUE_OWNER = "fin_email_enqueue";

/** Roles a grant fragment may name: the service groups, the two narrow logins and enqueue's owner. */
export const GRANTEE_ROLES = [
  ...SERVICE_GROUPS,
  "fin_probe",
  "fin_readonly",
  ENQUEUE_OWNER,
] as const;
export type GranteeRole = (typeof GRANTEE_ROLES)[number];

export const SERVICE_LOGINS = SERVICE_GROUPS.flatMap((group) => [
  `${group}_a`,
  `${group}_b`,
]) as readonly `${ServiceGroup}_${"a" | "b"}`[];
export type ServiceLogin = `${ServiceGroup}_${"a" | "b"}`;

/** Logins that take a SCRAM verifier at bootstrap. fin_owner and fin_readonly never do. */
export const VERIFIER_LOGINS = [...SERVICE_LOGINS, "fin_backup", "fin_probe"] as const;
export type VerifierLogin = ServiceLogin | "fin_backup" | "fin_probe";

/** Every role the bootstrap creates. */
export const FIN_ROLES = [
  "fin_owner",
  ...SERVICE_GROUPS,
  ...SERVICE_LOGINS,
  "fin_backup",
  "fin_probe",
  "fin_readonly",
  ENQUEUE_OWNER,
] as const;

/**
 * The schemas, one per area (DECISIONS DA-01), plus `email_private`: the worker's outbox and sender
 * tables, which only the worker and enqueue's owner may use, so no other login can name (and so lock)
 * them. The superuser's guard schema is GUARD_SCHEMA.
 */
export const FIN_SCHEMAS = [
  "identity",
  "staff",
  "keys",
  "kyc",
  "money",
  "events",
  "email",
  "email_private",
  "audit",
  "ops",
] as const;
export type FinSchema = (typeof FIN_SCHEMAS)[number];
export const GUARD_SCHEMA = "ops_guard";

export type ServiceName = "edge" | "api" | "worker" | "payments" | "console" | "admin";

export function groupOf(service: ServiceName): ServiceGroup {
  return `fin_${service}`;
}

/** ARCHITECTURE §4.5's pool budget: pool max, and the extra unpooled `LISTEN` connection. */
export const POOL_BUDGET: Readonly<Record<ServiceName, { max: number; extra: number }>> = {
  edge: { max: 8, extra: 0 },
  api: { max: 8, extra: 0 },
  worker: { max: 6, extra: 1 },
  payments: { max: 6, extra: 1 },
  console: { max: 6, extra: 0 },
  admin: { max: 3, extra: 0 },
};

/** The owner, backup, probe and operator logins: one or two connections each per run. */
export const AUXILIARY_BUDGET = {
  fin_owner: 2,
  fin_backup: 2,
  fin_probe: 1,
  fin_readonly: 2,
} as const;

/** `CONNECTION LIMIT` = (pool max + extra) × replicas × 2 + 2 (ARCHITECTURE §4.5, P-12). */
export function connectionLimit(service: ServiceName, replicas: number): number {
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > 20) {
    throw new RangeError("replicas must be an integer from 1 to 20");
  }
  const { max, extra } = POOL_BUDGET[service];
  return (max + extra) * replicas * 2 + 2;
}

export function auxiliaryConnectionLimit(role: keyof typeof AUXILIARY_BUDGET): number {
  return AUXILIARY_BUDGET[role] * 2 + 2;
}

export function serviceOfLogin(login: ServiceLogin): ServiceName {
  return login.replace(/^fin_/, "").replace(/_[ab]$/, "") as ServiceName;
}
