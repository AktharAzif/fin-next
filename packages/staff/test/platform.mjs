// The real platform for the staff integration tests (Postgres 18, never PGlite, CI-12): one fresh
// database per test file, bootstrapped and migrated by @fin/db's own test helpers with every
// package's database files, the set `migrate` applies: P0-E's (audit, ops, email, events),
// @fin/identity's (the staff realm's sign-in tables, intents, limits, views and guards, already in
// the runner's form), this package's and the rest, migrations and grant fragments alike. The
// runner's `after` step registers the event types and the email template grants, as the `migrate`
// service's registry sync does.
//
// This file is JavaScript, typed by platform.d.mts, for one reason recorded in the pull request:
// @fin/db and @fin/identity each declare the `pg` module for themselves, and the two declarations
// cannot share one TypeScript program. Nothing that imports @fin/identity may import @fin/db's
// sources, so the one place that needs both at run time is this file, which TypeScript reads only
// through its declaration.
import { createTestDatabase, testLoginPassword, testSuperuserUrl } from "@fin/db/testing";
import { grantRows } from "@fin/email";
import { eventTypeRows as identityEventTypeRows } from "@fin/identity";
import { staffEventTypeRows } from "../src/audit/events.ts";

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
  try {
    await database.migrate({ after: registerAll });
  } catch (error) {
    // No test file holds the platform yet, so nothing else would drop the database.
    await database.drop().catch(() => undefined);
    throw error;
  }
  return {
    name: database.name,
    host: database.target.host,
    port: database.target.port,
    password: (login) => testLoginPassword(login),
    superuser: async () => wrap(await database.superuser()),
    owner: async () => wrap(await database.connect("fin_owner", "fin-test-owner")),
    superuserUrl: () => testSuperuserUrl(database),
    withLock: (fn) => database.withLock(fn),
    drop: () => database.drop(),
  };
}
