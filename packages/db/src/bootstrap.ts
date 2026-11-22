// `migrate --bootstrap` (spec 01 §6.6 steps 3 and 4): run once per environment, by a registered run,
// as the template's superuser. In one transaction it creates the roles and schemas
// (bootstrap/010_roles.sql), sets each login's SCRAM verifier and CONNECTION LIMIT, then runs the
// superuser's other files in name order (every package's bootstrap/ by assets.ts's rule; today only
// packages/db has any): the privileged-login record and its guards
// (020_privileged_login.sql), the environment row (030_environment.sql, written here from
// FIN_ENVIRONMENT) and the guard on the audit trail's protections (040_audit_guard.sql); and it applies
// the grants on the superuser's own objects.
//
// It is handed verifiers only (FIN_ROLE_VERIFIERS), never a password: anything that is not a
// SCRAM-SHA-256 verifier is refused before a statement runs, and nothing it logs carries one.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isScramVerifier } from "@fin/crypto";
import { MigrationError } from "./errors.ts";
import { applyGrants, type GrantFragment } from "./grants.ts";
import { commitTransaction, escapeIdentifier, escapeLiteral, type PgClient } from "./pg.ts";
import {
  auxiliaryConnectionLimit,
  connectionLimit,
  SERVICE_LOGINS,
  type ServiceLogin,
  type ServiceName,
  serviceOfLogin,
  VERIFIER_LOGINS,
  type VerifierLogin,
} from "./roles.ts";
import type { Queryable } from "./unit.ts";

export const MIN_SERVER_VERSION = 180_000;

export type Environment = "development" | "ci" | "staging" | "production";

/** The roles file, run first; the other `NNN_<what>.sql` files follow in name order. */
export const ROLES_FILE = "010_roles.sql";
const BOOTSTRAP_FILE = /^\d{3}_[a-z][a-z0-9_]*\.sql$/;

/** One of the superuser's files: its name, which orders it, and where to read it. */
export interface BootstrapFile {
  name: string;
  path: string;
}

export interface BootstrapInput {
  /** Login to SCRAM-SHA-256 verifier. Every `_a` login needs one; the others are optional. */
  verifiers: Partial<Record<VerifierLogin, string>>;
  /** Replicas per service, for the connection limits; 1 when absent (staging). */
  replicas?: Partial<Record<ServiceName, number>>;
  /** FIN_ENVIRONMENT: written once to ops.environment, which audit.start_epoch() checks. */
  environment: Environment;
  /** Every package's bootstrap files (loadDbAssets's `bootstrap`). */
  files: readonly BootstrapFile[];
  fragments: readonly GrantFragment[];
}

/**
 * The bootstrap files in the order they run, whichever packages they come from: each named
 * `NNN_<what>.sql`, no name twice, the roles file first and the others by name.
 */
export function orderBootstrapFiles<T extends BootstrapFile>(files: readonly T[]): T[] {
  for (const file of files) {
    if (!BOOTSTRAP_FILE.test(file.name)) {
      throw new MigrationError("bootstrap_files", `${file.name}: not NNN_<what>.sql`, file.name);
    }
  }
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]?.name === sorted[i - 1]?.name) {
      throw new MigrationError(
        "bootstrap_files",
        `${sorted[i]?.name}: two bootstrap files share the name`,
        sorted[i]?.name,
      );
    }
  }
  if (sorted[0]?.name !== ROLES_FILE) {
    throw new MigrationError("bootstrap_files", `the bootstrap must start with ${ROLES_FILE}`);
  }
  return sorted;
}

/** One directory's bootstrap files, by name, in the order they run. */
export function bootstrapFiles(dir: string): string[] {
  const names = readdirSync(dir).filter((name) => BOOTSTRAP_FILE.test(name));
  return orderBootstrapFiles(names.map((name) => ({ name, path: join(dir, name) }))).map(
    (file) => file.name,
  );
}

export interface BootstrapResult {
  serverVersion: string;
  serverVersionNum: number;
  /** Whether pg_stat_statements is in shared_preload_libraries (a Railway template setting). */
  statStatementsPreloaded: boolean;
  verifiersSet: number;
}

/** Parses FIN_ROLE_VERIFIERS: a JSON object of login to verifier. Errors never echo a value. */
export function parseRoleVerifiers(
  text: string | undefined,
): Partial<Record<VerifierLogin, string>> {
  if (text === undefined || text === "") {
    throw new MigrationError("bootstrap_verifiers", "FIN_ROLE_VERIFIERS is required");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MigrationError("bootstrap_verifiers", "FIN_ROLE_VERIFIERS is not JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new MigrationError("bootstrap_verifiers", "FIN_ROLE_VERIFIERS is a JSON object");
  }
  const out: Partial<Record<VerifierLogin, string>> = {};
  for (const [login, value] of Object.entries(json)) {
    if (!(VERIFIER_LOGINS as readonly string[]).includes(login)) {
      throw new MigrationError(
        "bootstrap_verifiers",
        `FIN_ROLE_VERIFIERS names an unknown login ${login}`,
      );
    }
    if (typeof value !== "string" || !isScramVerifier(value)) {
      // The value may be a plaintext password by mistake: say which login, never what was given.
      throw new MigrationError(
        "bootstrap_verifiers",
        `FIN_ROLE_VERIFIERS.${login} is not a SCRAM-SHA-256 verifier`,
      );
    }
    out[login as VerifierLogin] = value;
  }
  for (const login of SERVICE_LOGINS.filter((l) => l.endsWith("_a"))) {
    if (out[login] === undefined) {
      throw new MigrationError("bootstrap_verifiers", `FIN_ROLE_VERIFIERS.${login} is required`);
    }
  }
  return out;
}

export function parseReplicas(text: string | undefined): Partial<Record<ServiceName, number>> {
  if (text === undefined || text === "") return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MigrationError("bootstrap_replicas", "FIN_DB_REPLICAS is not JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new MigrationError("bootstrap_replicas", "FIN_DB_REPLICAS is a JSON object");
  }
  const out: Partial<Record<ServiceName, number>> = {};
  for (const [service, value] of Object.entries(json)) {
    if (!["edge", "api", "worker", "payments", "console", "admin"].includes(service)) {
      throw new MigrationError(
        "bootstrap_replicas",
        `FIN_DB_REPLICAS names an unknown service ${service}`,
      );
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) {
      throw new MigrationError("bootstrap_replicas", `FIN_DB_REPLICAS.${service} is 1 to 20`);
    }
    out[service as ServiceName] = value;
  }
  return out;
}

function loginLimit(
  login: VerifierLogin | "fin_readonly",
  replicas: Partial<Record<ServiceName, number>>,
): number {
  if (login === "fin_backup" || login === "fin_probe" || login === "fin_readonly") {
    return auxiliaryConnectionLimit(login);
  }
  const service = serviceOfLogin(login as ServiceLogin);
  return connectionLimit(service, replicas[service] ?? 1);
}

export async function bootstrap(client: PgClient, input: BootstrapInput): Promise<BootstrapResult> {
  const who = await client.query<{ rolsuper: boolean }>(
    "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user",
  );
  if (who.rows[0]?.rolsuper !== true) {
    throw new MigrationError("bootstrap_role", "the bootstrap runs as the superuser");
  }
  const server = await client.query<{
    version: string;
    num: string;
    encoding: string;
    preload: string;
  }>(
    `SELECT current_setting('server_version') AS version, current_setting('server_version_num') AS num,
            current_setting('server_encoding') AS encoding, current_setting('shared_preload_libraries') AS preload`,
  );
  const info = server.rows[0];
  if (info === undefined || Number(info.num) < MIN_SERVER_VERSION) {
    throw new MigrationError("bootstrap_version", "Postgres 18 or later is required");
  }
  if (info.encoding !== "UTF8") {
    throw new MigrationError(
      "bootstrap_encoding",
      "the database must be UTF8 (the audit hash reads UTF-8 bytes)",
    );
  }
  if (!["development", "ci", "staging", "production"].includes(input.environment)) {
    throw new MigrationError("bootstrap_environment", "the environment is not one of Fin's four");
  }
  const [rolesFile, ...others] = orderBootstrapFiles(input.files);
  if (rolesFile === undefined) throw new MigrationError("bootstrap_files", "no bootstrap files");
  const roles = readFileSync(rolesFile.path, "utf8");
  const rest = others.map((file) => readFileSync(file.path, "utf8"));
  const replicas = input.replicas ?? {};
  const q: Queryable = { query: (text, values) => client.query(text, values) };

  let verifiersSet = 0;
  await client.query("BEGIN");
  try {
    await client.query(roles);
    for (const login of [...VERIFIER_LOGINS, "fin_readonly" as const]) {
      const verifier = login === "fin_readonly" ? undefined : input.verifiers[login];
      const parts = [`CONNECTION LIMIT ${loginLimit(login, replicas)}`];
      if (verifier !== undefined) {
        if (!isScramVerifier(verifier)) {
          throw new MigrationError("bootstrap_verifiers", `${login}: not a SCRAM-SHA-256 verifier`);
        }
        parts.push(`PASSWORD ${escapeLiteral(verifier)}`);
        verifiersSet += 1;
      }
      await client.query(`ALTER ROLE ${escapeIdentifier(login)} WITH ${parts.join(" ")}`);
    }
    await client.query(
      `ALTER ROLE fin_owner WITH CONNECTION LIMIT ${auxiliaryConnectionLimit("fin_owner")}`,
    );
    for (const sql of rest) await client.query(sql);
    // Written once; a second bootstrap for another environment is refused rather than relabelling it.
    await client.query(
      "INSERT INTO ops.environment (only_row, name, recorded_at) VALUES (true, $1, statement_timestamp()) ON CONFLICT (only_row) DO NOTHING",
      [input.environment],
    );
    // The bootstrap's own row and only it: ONLY leaves out any child table, and anything but exactly
    // one row is refused (030 refuses to adopt a table the bootstrap did not make).
    const recorded = await client.query<{ name: string }>(
      "SELECT name FROM ONLY ops.environment WHERE only_row",
    );
    if (recorded.rows.length !== 1 || recorded.rows[0]?.name !== input.environment) {
      throw new MigrationError(
        "bootstrap_environment",
        "this database was bootstrapped for another environment",
      );
    }
    await applyGrants(q, input.fragments, { missing: "skip" });
    await commitTransaction(client);
  } catch (error) {
    if (client.getTransactionStatus() !== "I") await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
  return {
    serverVersion: info.version,
    serverVersionNum: Number(info.num),
    statStatementsPreloaded: info.preload
      .split(",")
      .map((s) => s.trim())
      .includes("pg_stat_statements"),
    verifiersSet,
  };
}
