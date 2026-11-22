// The real platform for the keys integration tests (Postgres 18, never PGlite, CI-12): one fresh
// database per test file, bootstrapped and migrated by @fin/db's own test helpers with every
// package's database files, the set `migrate` applies: P0-E's (audit, ops, email, events),
// @fin/identity's (the developer realm, intents, limits, views and guards), @fin/orgs'
// (organisations, members, roles), this package's and the rest, migrations and grant fragments
// alike. The runner's `after` step registers the event types and the email template grants, as the
// `migrate` service's registry sync does. The console's API half, the edge and the lifecycle all
// run against it as their own logins (fin_console_a, fin_edge_a, ...).
//
// JavaScript typed by platform.d.mts, as packages/staff's is, for one reason: @fin/db and
// @fin/identity each declare the `pg` module for themselves, and the two declarations cannot share
// one TypeScript program. The keys tests that drive the console import @fin/identity; this file is
// the one place that needs @fin/db at run time beside it.
import { createTestDatabase, testLoginPassword } from "@fin/db/testing";
import { grantRows } from "@fin/email";
import { eventTypeRows as identityEventTypeRows } from "@fin/identity";
import { eventTypeRows as orgsEventTypeRows } from "@fin/orgs";
import { keyEventTypeRows } from "../src/audit.ts";
import { keyTemplateGrants } from "../src/email.ts";

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
