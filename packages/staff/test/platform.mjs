// The real platform for the staff integration tests (Postgres 18, never PGlite, CI-12): one fresh
// database per test file, bootstrapped by @fin/db's own test bootstrap (the real roles, schemas and
// privileged-login guard), then migrated by @fin/db's runner with every migration the staff realm
// stands on, in name order: P0-E's (audit, ops, email, events), @fin/identity's (the staff realm's
// sign-in tables, intents, limits, views and guards) and this package's; and every grant fragment
// the runner renders: P0-E's, @fin/identity's (converted to the runner's format) and this one's.
// The runner's `after` step registers the event types and the email template grants, as the
// `migrate` service's registry sync does.
//
// This file is JavaScript, typed by platform.d.mts, for one reason recorded in the pull request:
// @fin/db and @fin/identity each declare the `pg` module for themselves, and the two declarations
// cannot share one TypeScript program. Nothing that imports @fin/identity may import @fin/db's
// sources, so the one place that needs both at run time is this file, which TypeScript reads only
// through its declaration.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GRANTS_DIR, loadFragments, MIGRATIONS_DIR, parseMigration, readMigrations } from "@fin/db";
import { createTestDatabase, testLoginPassword } from "@fin/db/testing";
import { grantRows } from "@fin/email";
import { eventTypeRows as identityEventTypeRows } from "@fin/identity";
import { staffEventTypeRows } from "../src/audit/events.ts";

const STAFF_ROOT = join(import.meta.dirname, "..");
const IDENTITY_ROOT = join(STAFF_ROOT, "..", "identity");

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

/** This package's migrations, checked by the runner's own parser. */
function staffMigrations() {
  const dir = join(STAFF_ROOT, "migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => parseMigration(name, readFileSync(join(dir, name))));
}

/**
 * @fin/identity's staff-realm, step-up and limits fragments in the runner's format: one entry
 * per object, and the schemas' USAGE its own renderer adds.
 */
function identityFragments() {
  const out = [];
  for (const file of ["staff-realm.json", "step-up.json", "limits.json"]) {
    const fragment = JSON.parse(readFileSync(join(IDENTITY_ROOT, "grants", file), "utf8"));
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
  return [...readMigrations(MIGRATIONS_DIR), ...identityMigrations(), ...staffMigrations()].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

export function grantFragments() {
  return [
    ...loadFragments(GRANTS_DIR),
    ...identityFragments(),
    ...loadFragments(join(STAFF_ROOT, "grants")),
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
    ...staffEventTypeRows(),
  ];
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
  const templates = grantRows().map((g) => ({
    template: g.template,
    role: g.role,
    category: g.category,
  }));
  await q.query(
    `INSERT INTO email.template_grant (template, role, category)
     SELECT r.template, r.role, r.category
       FROM jsonb_to_recordset($1::jsonb) AS r(template text, role text, category text)
     ON CONFLICT DO NOTHING`,
    [JSON.stringify(templates)],
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

export async function createStaffPlatform(prefix) {
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
    owner: async () => wrap(await database.connect("fin_owner", "fin-test-owner")),
    drop: () => database.drop(),
  };
}
