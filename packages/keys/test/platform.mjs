// The real platform for the keys integration tests (Postgres 18, never PGlite, CI-12): one fresh
// database per test file, bootstrapped by @fin/db's own test bootstrap (the real roles, schemas and
// privileged-login guard), then migrated by @fin/db's runner with every migration the keys area
// stands on, in name order: P0-E's (audit, ops, email, events), @fin/identity's (the developer realm,
// intents, limits, views and guards), @fin/orgs' (organisations, members, roles) and this package's;
// and every grant fragment the runner renders: P0-E's, @fin/identity's (converted to the runner's
// format), @fin/orgs' and this one's. The runner's `after` step registers the event types and the
// email template grants, as the `migrate` service's registry sync does. The console's API half, the
// edge and the lifecycle all run against it as their own logins (fin_console_a, fin_edge_a, ...).
//
// JavaScript typed by platform.d.mts, as packages/staff's is, for one reason: @fin/db and
// @fin/identity each declare the `pg` module for themselves, and the two declarations cannot share
// one TypeScript program. The keys tests that drive the console import @fin/identity; this file is
// the one place that needs @fin/db at run time beside it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GRANTS_DIR, loadFragments, MIGRATIONS_DIR, parseMigration, readMigrations } from "@fin/db";
import { createTestDatabase, testLoginPassword } from "@fin/db/testing";
import { grantRows } from "@fin/email";
import { eventTypeRows as identityEventTypeRows } from "@fin/identity";
import { eventTypeRows as orgsEventTypeRows } from "@fin/orgs";
import { keyEventTypeRows } from "../src/audit.ts";
import { keyTemplateGrants } from "../src/email.ts";

const KEYS_ROOT = join(import.meta.dirname, "..");
const IDENTITY_ROOT = join(KEYS_ROOT, "..", "identity");
const ORGS_ROOT = join(KEYS_ROOT, "..", "orgs");

/** @fin/identity's migrations, which open with `SET` rather than the runner's `SET LOCAL`. */
function identityMigrations() {
  const dir = join(IDENTITY_ROOT, "migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(dir, name));
      return {
        name,
        sql: bytes.toString("utf8"),
        checksum: createHash("sha256").update(bytes).digest(),
        transactional: true,
      };
    });
}

/** A package's migrations, checked by the runner's own parser. */
function packageMigrations(root) {
  const dir = join(root, "migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => parseMigration(name, readFileSync(join(dir, name))));
}

/** @fin/identity's fragments in the runner's format: one entry per object, with schema USAGE. */
function identityFragments() {
  const out = [];
  const dir = join(IDENTITY_ROOT, "grants");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const fragment = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const grants = [];
    const usage = new Map();
    const use = (role, object) => {
      const schema = object.split(".")[0];
      const roles = usage.get(schema) ?? new Set();
      roles.add(role);
      usage.set(schema, roles);
    };
    for (const entry of fragment.grants) {
      for (const table of entry.tables ?? []) {
        grants.push({ on: "table", name: table, privileges: entry.privileges, to: [entry.role] });
        use(entry.role, table);
      }
      for (const fn of entry.functions ?? []) {
        grants.push({ on: "function", name: fn, privileges: ["EXECUTE"], to: [entry.role] });
        use(entry.role, fn);
      }
      if (entry.table !== undefined) {
        grants.push({
          on: "table",
          name: entry.table,
          privileges: entry.privileges,
          columns: entry.columns,
          to: [entry.role],
        });
        use(entry.role, entry.table);
      }
    }
    for (const [schema, roles] of usage) {
      grants.unshift({ on: "schema", name: schema, privileges: ["USAGE"], to: [...roles] });
    }
    out.push({ file: `identity-${file}`, area: `identity-${fragment.area}`, grants });
  }
  return out;
}

/** Every file the runner applies, in name order. */
export function migrationFiles() {
  return [
    ...readMigrations(MIGRATIONS_DIR),
    ...identityMigrations(),
    ...packageMigrations(ORGS_ROOT),
    ...packageMigrations(KEYS_ROOT),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export function grantFragments() {
  return [
    ...loadFragments(GRANTS_DIR),
    ...identityFragments(),
    ...loadFragments(join(ORGS_ROOT, "grants")),
    ...loadFragments(join(KEYS_ROOT, "grants")),
  ];
}

export function eventTypes() {
  return [
    ...identityEventTypeRows().map((row) => ({
      ...row,
      roles: [...row.roles].sort(),
      journal_kind: null,
      retired: false,
    })),
    ...orgsEventTypeRows().map((row) => ({
      name: row.name,
      area: row.area,
      category: row.category,
      scope: row.scope,
      roles: [...row.roles].sort(),
      journal_kind: row.journalKind,
      retired: false,
    })),
    ...keyEventTypeRows(),
  ];
}

export function templateGrants() {
  const rows = grantRows().map((g) => ({
    template: g.template,
    role: g.role,
    category: g.category,
  }));
  return [...rows, ...keyTemplateGrants()];
}

async function registerAll(q) {
  await q.query(
    `INSERT INTO audit.event_type AS t (name, area, category, scope, roles, journal_kind, retired, synced_release)
     SELECT r.name, r.area, r.category, r.scope, r.roles, r.journal_kind, r.retired, 'test-release'
       FROM jsonb_to_recordset($1::jsonb)
         AS r(name text, area text, category text, scope text, roles text[], journal_kind text, retired boolean)
     ON CONFLICT (name) DO NOTHING`,
    [JSON.stringify(eventTypes())],
  );
  await q.query(
    `INSERT INTO email.template_grant (template, role, category)
     SELECT r.template, r.role, r.category
       FROM jsonb_to_recordset($1::jsonb) AS r(template text, role text, category text)
     ON CONFLICT DO NOTHING`,
    [JSON.stringify(templateGrants())],
  );
}

function wrap(client) {
  return {
    query: async (text, values) => {
      const result = await client.query(text, values);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    end: () => client.end(),
  };
}

export async function createKeysPlatform(prefix) {
  const database = await createTestDatabase({ prefix, migrate: false });
  await database.migrate({
    files: migrationFiles(),
    fragments: grantFragments(),
    after: registerAll,
  });
  return {
    name: database.name,
    host: database.target.host,
    port: database.target.port,
    password: (login) => testLoginPassword(login),
    superuser: async () => wrap(await database.superuser()),
    login: async (login, applicationName = "fin-keys-test") =>
      wrap(await database.connect(login, applicationName)),
    drop: () => database.drop(),
  };
}

/**
 * Seeds a person, an organisation and a membership as the superuser with triggers off (the guards
 * would refuse rows written without their events; the actions under test write their own).
 */
export async function seedOrganization(superuser, seed) {
  await superuser.query("BEGIN");
  try {
    await superuser.query("SET LOCAL session_replication_role = replica");
    for (const person of seed.people) {
      await superuser.query(
        `INSERT INTO identity."user" (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES ($1, $2, $3, true, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
        [person.userId, person.name, person.email],
      );
    }
    await superuser.query(
      `INSERT INTO identity.organization (id, name, live_status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [seed.orgId, seed.name, seed.liveStatus ?? "sandbox", seed.people[0].userId],
    );
    for (const person of seed.people) {
      await superuser.query(
        `INSERT INTO identity.member (id, organization_id, user_id, role_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())`,
        [person.memberId, seed.orgId, person.userId, person.roleKey],
      );
    }
    await superuser.query("COMMIT");
  } catch (error) {
    await superuser.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
