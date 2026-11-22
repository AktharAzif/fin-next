// The integration tests' databases on Postgres 18 (never PGlite, CI-12). FIN_TEST_DATABASE_URL
// names a server where the connecting role may create databases and roles; its password comes
// from the URL or PGPASSWORD and is never printed. One template database is built from the
// platform fixture, this package's migrations, the organisation stub and the grant fragments;
// each test file clones it. Roles are cluster-wide, so the tests use their own prefixed roles
// and never touch another lane's.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg, { type Client, type Pool, type PoolConfig } from "pg";
import { eventTypeRows } from "../src/audit/events.ts";
import { REALM_TEMPLATES } from "../src/email/templates.ts";
import { type GrantFragment, readFragments, renderGrants } from "./grants.ts";

export const ROLE_PREFIX = "l_sat_02_";
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

/** The platform grants P0-E's fragments will hold (ops.json, audit.json, email.json). */
const PLATFORM_GRANTS: GrantFragment = {
  area: "platform-test",
  grants: [
    {
      role: "fin_console",
      privileges: ["EXECUTE"],
      functions: ["audit.record(jsonb)", "email.enqueue(jsonb)"],
    },
    {
      role: "fin_admin",
      privileges: ["EXECUTE"],
      functions: ["audit.record(jsonb)", "email.enqueue(jsonb)"],
    },
    { role: "fin_api", privileges: ["EXECUTE"], functions: ["audit.record(jsonb)"] },
    { role: "fin_console", privileges: ["SELECT"], tables: ["ops.kill_switch"] },
    { role: "fin_admin", privileges: ["SELECT"], tables: ["ops.kill_switch"] },
  ],
};

export function testDatabaseUrl(): URL | null {
  const raw = process.env.FIN_TEST_DATABASE_URL;
  if (raw === undefined || raw === "") return null;
  return new URL(raw);
}

function serverConfig(url: URL, database: string): PoolConfig {
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || "postgres"),
    password:
      url.password !== "" ? decodeURIComponent(url.password) : (process.env.PGPASSWORD ?? ""),
    database,
    max: 4,
    application_name: "identity-tests",
  };
}

/** A login role's password, derived from the server's own so it is never stored or printed. */
function loginPassword(url: URL, role: string): string {
  const secret =
    url.password !== "" ? decodeURIComponent(url.password) : (process.env.PGPASSWORD ?? "");
  return createHash("sha256").update(`${secret}:${ROLE_PREFIX}${role}`).digest("hex");
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

function fingerprint(): string {
  const hash = createHash("sha256");
  const files = [
    join(PACKAGE_ROOT, "test", "fixtures", "platform.sql"),
    ...sqlFiles(join(PACKAGE_ROOT, "migrations")),
    join(PACKAGE_ROOT, "test", "fixtures", "orgs-stub.sql"),
    ...readdirSync(join(PACKAGE_ROOT, "grants")).map((f) => join(PACKAGE_ROOT, "grants", f)),
  ];
  for (const file of files) hash.update(readFileSync(file));
  hash.update(JSON.stringify(eventTypeRows()));
  hash.update(
    JSON.stringify(Object.entries(REALM_TEMPLATES).map(([n, t]) => [n, t.class, t.role])),
  );
  hash.update(JSON.stringify(PLATFORM_GRANTS));
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
    await db.query(readFileSync(join(PACKAGE_ROOT, "test", "fixtures", "platform.sql"), "utf8"));
    for (const file of sqlFiles(join(PACKAGE_ROOT, "migrations"))) {
      await db.query(readFileSync(file, "utf8"));
    }
    await db.query(readFileSync(join(PACKAGE_ROOT, "test", "fixtures", "orgs-stub.sql"), "utf8"));
    const fragments = [PLATFORM_GRANTS, ...readFragments(join(PACKAGE_ROOT, "grants"))];
    await db.query(renderGrants(fragments, testRole));
    for (const row of eventTypeRows()) {
      await db.query(
        "INSERT INTO audit.event_type (name, area, category, scope, roles) VALUES ($1, $2, $3, $4, $5)",
        [row.name, row.area, row.category, row.scope, row.roles.map(testRole)],
      );
    }
    for (const [template, spec] of Object.entries(REALM_TEMPLATES)) {
      await db.query(
        "INSERT INTO email.template_grant (template, role, category) VALUES ($1, $2, $3)",
        [template, testRole(spec.role), spec.class],
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
    await admin.query("SELECT pg_advisory_lock(hashtext('l_sat_02_template'))");
    await ensureRoles(admin, url);
    const print = fingerprint();
    const current = await admin.query<{ comment: string | null }>(
      "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
      [TEMPLATE_DB],
    );
    if (current.rows[0]?.comment !== print) await buildTemplate(url, admin, print);
  } finally {
    await admin
      .query("SELECT pg_advisory_unlock(hashtext('l_sat_02_template'))")
      .catch(() => undefined);
    await admin.end();
  }
}

export interface TestDatabase {
  readonly name: string;
  /** A pool connected as the superuser: for fixtures and assertions, never for the code under test. */
  readonly admin: Pool;
  /** A pool connected as a service's own login (`l_sat_02_fin_console_a` and so on). */
  login(role: ServiceRole, options?: { max?: number }): Pool;
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
    await server.query("SELECT pg_advisory_lock(hashtext('l_sat_02_template'))");
    await server.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DB}"`);
    await server.query("SELECT pg_advisory_unlock(hashtext('l_sat_02_template'))");
  } finally {
    await server.end();
  }
  const pools: Pool[] = [];
  const admin = new pg.Pool(serverConfig(url, name));
  pools.push(admin);
  return {
    name,
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
