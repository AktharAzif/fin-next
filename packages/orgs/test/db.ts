// The integration tests' databases on Postgres 18 (never PGlite, CI-12), for this package and the
// console's API half. FIN_TEST_DATABASE_URL names a server where the connecting role may create
// databases and roles; its password comes from the URL or PGPASSWORD and is never printed.
//
// One template database is built from the identity lane's platform fixture (its stand-in for P0-E's
// audit, email and ops objects), the revocation-journal stand-in, the identity realm's migrations,
// this area's migrations and the grant fragments of both, with the event registry and the email
// allowlist loaded from the code. Each test file clones it. Roles are cluster-wide, so the tests use
// their own `l_sat_03_` roles and never touch another lane's.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findTemplate } from "@fin/email";
import { eventTypeRows as identityEventTypeRows, REALM_TEMPLATES } from "@fin/identity";
import pg, { type Client, type Pool, type PoolConfig } from "pg";
import { eventTypeRows } from "../src/audit/events.ts";
import { ORG_TEMPLATES } from "../src/email.ts";

export const ROLE_PREFIX = "l_sat_03_";
export const SERVICE_ROLES = [
  "fin_console",
  "fin_admin",
  "fin_api",
  "fin_worker",
  "fin_readonly",
] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

const TEMPLATE_DB = `${ROLE_PREFIX}template`;
const PACKAGE_ROOT = join(import.meta.dirname, "..");
/** The identity package this one depends on, as pnpm links it. */
const IDENTITY_ROOT = join(PACKAGE_ROOT, "node_modules", "@fin", "identity");

/** The platform grants P0-E's fragments hold (ops.json, audit.json, email.json). */
const PLATFORM_GRANTS: DbFragment = {
  area: "platform-test",
  grants: [
    {
      on: "function",
      name: "audit.record(jsonb)",
      privileges: ["EXECUTE"],
      to: ["fin_console", "fin_admin", "fin_api"],
    },
    {
      on: "function",
      name: "audit.record_journal(jsonb)",
      privileges: ["EXECUTE"],
      to: ["fin_console", "fin_admin"],
    },
    {
      on: "function",
      name: "email.enqueue(jsonb)",
      privileges: ["EXECUTE"],
      to: ["fin_console", "fin_admin"],
    },
    {
      on: "table",
      name: "ops.kill_switch",
      privileges: ["SELECT"],
      to: ["fin_console", "fin_admin"],
    },
  ],
};

/**
 * packages/db's fragment shape (roles/grants/<area>.json), the migration runner's, which this
 * area's fragment and @fin/identity's (packages/identity/grants/*.json) both use.
 */
export interface DbFragment {
  area: string;
  grants: {
    on: "schema" | "table" | "function";
    name: string;
    privileges: string[];
    columns?: string[];
    to: string[];
  }[];
}

const PRIVILEGE = /^(SELECT|INSERT|UPDATE|DELETE|EXECUTE|USAGE)$/;
const OBJECT = /^[a-z_]+\.[a-z_]+(\([a-z0-9_, ]*\))?$/;
const COLUMN = /^[a-z_][a-z0-9_]*$/;
const KINDS: readonly string[] = ["schema", "table", "function"];
const ENTRY_KEYS: readonly string[] = ["on", "name", "privileges", "columns", "to"];

function quoteObject(name: string): string {
  const [schema, rest = ""] = name.split(".");
  const paren = rest.indexOf("(");
  const object = paren < 0 ? rest : rest.slice(0, paren);
  const args = paren < 0 ? "" : rest.slice(paren);
  return `"${schema}"."${object}"${args}`;
}

/**
 * Checks that an entry is in the runner's shape: an entry in any other shape (the identity lane's
 * old `{ role, tables, functions }`, say) is refused, never skipped, so a change of shape cannot
 * drop a grant without a word.
 */
function checkEntry(area: string, grant: DbFragment["grants"][number]): void {
  const shaped =
    Object.keys(grant).every((key) => ENTRY_KEYS.includes(key)) &&
    KINDS.includes(grant.on) &&
    typeof grant.name === "string" &&
    Array.isArray(grant.privileges) &&
    grant.privileges.length > 0 &&
    Array.isArray(grant.to) &&
    grant.to.length > 0;
  if (!shaped) throw new Error(`grant fragment ${area}: an entry not in the runner's shape`);
  for (const p of grant.privileges) if (!PRIVILEGE.test(p)) throw new Error(`grant privilege ${p}`);
}

/** Renders the fragments to SQL with the roles mapped to the test's prefixed roles. */
export function renderGrants(fragments: readonly DbFragment[]): string {
  const statements: string[] = [];
  const usage = new Set<string>();
  const role = (name: string) => `"${testRole(name)}"`;
  const addUsage = (name: string, object: string) =>
    usage.add(`${object.split(".")[0] as string}\u0000${name}`);
  for (const fragment of fragments) {
    for (const grant of fragment.grants) {
      checkEntry(fragment.area, grant);
      for (const to of grant.to) {
        if (grant.on === "schema") {
          if (!/^[a-z_]+$/.test(grant.name)) throw new Error(`grant schema ${grant.name}`);
          statements.push(`GRANT USAGE ON SCHEMA "${grant.name}" TO ${role(to)};`);
          continue;
        }
        if (!OBJECT.test(grant.name)) throw new Error(`grant object ${grant.name}`);
        const columns = grant.columns ?? [];
        if (columns.some((c) => !COLUMN.test(c))) throw new Error(`grant columns ${grant.name}`);
        const cols = columns.length === 0 ? "" : ` (${columns.map((c) => `"${c}"`).join(", ")})`;
        // The columns go with each privilege, as the runner writes them.
        const privileges = grant.privileges.map((p) => `${p}${cols}`).join(", ");
        const kind = grant.on === "function" ? "FUNCTION" : "TABLE";
        statements.push(
          `GRANT ${privileges} ON ${kind} ${quoteObject(grant.name)} TO ${role(to)};`,
        );
        addUsage(to, grant.name);
      }
    }
  }
  for (const entry of usage) {
    const [schema, name] = entry.split("\u0000") as [string, string];
    statements.unshift(`GRANT USAGE ON SCHEMA "${schema}" TO ${role(name)};`);
  }
  return statements.join("\n");
}

function readJson<T>(dir: string): T[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
}

export function testDatabaseUrl(): URL | null {
  const raw = process.env.FIN_TEST_DATABASE_URL;
  if (raw === undefined || raw === "") return null;
  return new URL(raw);
}

function serverPassword(url: URL): string {
  return url.password !== "" ? decodeURIComponent(url.password) : (process.env.PGPASSWORD ?? "");
}

function serverConfig(url: URL, database: string): PoolConfig {
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || "postgres"),
    password: serverPassword(url),
    database,
    max: 4,
    application_name: "orgs-tests",
  };
}

/** A login role's password, derived from the server's own so it is never stored or printed. */
export function loginPassword(url: URL, role: string): string {
  return createHash("sha256")
    .update(`${serverPassword(url)}:${ROLE_PREFIX}${role}`)
    .digest("hex");
}

export function testRole(role: string): string {
  return `${ROLE_PREFIX}${role}`;
}

function sqlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f));
}

const SOURCES = {
  platform: join(IDENTITY_ROOT, "test", "fixtures", "platform.sql"),
  journal: join(PACKAGE_ROOT, "test", "fixtures", "journal.sql"),
  identityMigrations: join(IDENTITY_ROOT, "migrations"),
  orgsMigrations: join(PACKAGE_ROOT, "migrations"),
  identityGrants: join(IDENTITY_ROOT, "grants"),
  orgsGrants: join(PACKAGE_ROOT, "grants"),
};

/** The template's grants: the platform's, @fin/identity's and this area's fragments. */
export function templateGrantSql(): string {
  return renderGrants([
    PLATFORM_GRANTS,
    ...readJson<DbFragment>(SOURCES.identityGrants),
    ...readJson<DbFragment>(SOURCES.orgsGrants),
  ]);
}

function templateGrants(): { template: string; role: string; category: string }[] {
  const rows = Object.entries(REALM_TEMPLATES).map(([template, spec]) => ({
    template,
    role: spec.role,
    category: spec.class as string,
  }));
  for (const id of ORG_TEMPLATES) {
    const template = findTemplate(id);
    if (template === undefined) throw new Error(`no template ${id} in packages/email`);
    rows.push({ template: id, role: "fin_console", category: template.class });
  }
  return rows;
}

function fingerprint(): string {
  const hash = createHash("sha256");
  const files = [
    SOURCES.platform,
    SOURCES.journal,
    ...sqlFiles(SOURCES.identityMigrations),
    ...sqlFiles(SOURCES.orgsMigrations),
    ...readdirSync(SOURCES.identityGrants).map((f) => join(SOURCES.identityGrants, f)),
    ...readdirSync(SOURCES.orgsGrants).map((f) => join(SOURCES.orgsGrants, f)),
  ];
  for (const file of files) hash.update(readFileSync(file));
  hash.update(JSON.stringify(identityEventTypeRows()));
  hash.update(JSON.stringify(eventTypeRows()));
  hash.update(JSON.stringify(templateGrants()));
  // The SQL the grants render to, not only their files: a template an older renderer built is
  // rebuilt, never cloned.
  hash.update(templateGrantSql());
  return hash.digest("hex").slice(0, 32);
}

async function ensureRoles(admin: Client, url: URL): Promise<void> {
  for (const role of SERVICE_ROLES) {
    const group = testRole(role);
    const login = `${group}_a`;
    await admin.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${group}') THEN CREATE ROLE "${group}" NOLOGIN; END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${login}') THEN CREATE ROLE "${login}" LOGIN; END IF;
       END $$`,
    );
    await admin.query(
      `ALTER ROLE "${login}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${loginPassword(url, role)}'`,
    );
    await admin.query(`GRANT "${group}" TO "${login}"`);
  }
}

async function buildTemplate(url: URL, admin: Client, print: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
  const db = new pg.Client(serverConfig(url, TEMPLATE_DB));
  await db.connect();
  try {
    await db.query(readFileSync(SOURCES.platform, "utf8"));
    await db.query(readFileSync(SOURCES.journal, "utf8"));
    const migrations = [
      ...sqlFiles(SOURCES.identityMigrations),
      ...sqlFiles(SOURCES.orgsMigrations),
    ].sort((a, b) => (a.split("/").at(-1) as string).localeCompare(b.split("/").at(-1) as string));
    for (const file of migrations) {
      // One transaction per file, as the runner applies it (SET LOCAL holds inside it).
      await db.query("BEGIN");
      await db.query(readFileSync(file, "utf8"));
      await db.query("COMMIT");
    }
    await db.query(templateGrantSql());
    for (const row of identityEventTypeRows()) {
      await db.query(
        "INSERT INTO audit.event_type (name, area, category, scope, roles) VALUES ($1, $2, $3, $4, $5)",
        [row.name, row.area, row.category, row.scope, row.roles.map(testRole)],
      );
    }
    for (const row of eventTypeRows()) {
      await db.query(
        `INSERT INTO audit.event_type (name, area, category, scope, roles, journal_kind)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.name, row.area, row.category, row.scope, row.roles.map(testRole), row.journalKind],
      );
    }
    for (const grant of templateGrants()) {
      await db.query(
        "INSERT INTO email.template_grant (template, role, category) VALUES ($1, $2, $3)",
        [grant.template, testRole(grant.role), grant.category],
      );
    }
  } finally {
    await db.end();
  }
  await admin.query(`COMMENT ON DATABASE "${TEMPLATE_DB}" IS '${print}'`);
}

/** Builds the template once per change of its inputs; concurrent workers wait on a lock. */
export async function ensureTemplate(): Promise<void> {
  const url = testDatabaseUrl();
  if (url === null) throw new Error("FIN_TEST_DATABASE_URL is not set");
  const admin = new pg.Client(serverConfig(url, url.pathname.slice(1) || "postgres"));
  await admin.connect();
  try {
    await admin.query("SELECT pg_advisory_lock(hashtext('l_sat_03_template'))");
    await ensureRoles(admin, url);
    const print = fingerprint();
    const current = await admin.query<{ comment: string | null }>(
      "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
      [TEMPLATE_DB],
    );
    if (current.rows[0]?.comment !== print) await buildTemplate(url, admin, print);
  } finally {
    await admin
      .query("SELECT pg_advisory_unlock(hashtext('l_sat_03_template'))")
      .catch(() => undefined);
    await admin.end();
  }
}

export interface TestDatabase {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** A pool connected as the superuser: for fixtures and assertions, never for the code under test. */
  readonly admin: Pool;
  /** A pool connected as a service's own login (`l_sat_03_fin_console_a` and so on). */
  login(role: ServiceRole, options?: { max?: number }): Pool;
  /** The login's name and password, for code that builds its own pool from settings. */
  credentials(role: ServiceRole): { user: string; password: string };
  drop(): Promise<void>;
}

export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const url = testDatabaseUrl();
  if (url === null) throw new Error("FIN_TEST_DATABASE_URL is not set");
  await ensureTemplate();
  const name = `${ROLE_PREFIX}${label.replace(/[^a-z0-9_]/g, "_")}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const server = new pg.Client(serverConfig(url, url.pathname.slice(1) || "postgres"));
  await server.connect();
  try {
    await server.query("SELECT pg_advisory_lock(hashtext('l_sat_03_template'))");
    await server.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DB}"`);
    await server.query("SELECT pg_advisory_unlock(hashtext('l_sat_03_template'))");
  } finally {
    await server.end();
  }
  const pools: Pool[] = [];
  const admin = new pg.Pool(serverConfig(url, name));
  admin.on("error", () => undefined);
  pools.push(admin);
  return {
    name,
    host: url.hostname,
    port: Number(url.port || 5432),
    admin,
    login(role, options = {}) {
      const pool = new pg.Pool({
        ...serverConfig(url, name),
        user: `${testRole(role)}_a`,
        password: loginPassword(url, role),
        max: options.max ?? 6,
      });
      pool.on("error", () => undefined);
      pools.push(pool);
      return pool;
    },
    credentials(role) {
      return { user: `${testRole(role)}_a`, password: loginPassword(url, role) };
    },
    async drop() {
      await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
      const cleanup = new pg.Client(serverConfig(url, url.pathname.slice(1) || "postgres"));
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** Runs SQL as the superuser with triggers off, so fixtures can seed rows the guards would refuse. */
export async function seed(
  admin: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(text, values);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
