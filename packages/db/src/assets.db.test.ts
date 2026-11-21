// Every package's files (assets.ts's rule) from an empty Postgres 18: the bootstrap, then every
// package's migrations in one order across packages, then every package's grants, exactly; each file
// recorded with its checksum, the schema version the newest name, and a second run applying nothing.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { discoverDbAssets } from "./assets.ts";
import { bootstrap } from "./bootstrap.ts";
import { expandMatrix, grantDrift, livePrivileges, privilegeKey } from "./grants.ts";
import { type RunResult, runMigrations, schemaVersion } from "./migrations.ts";
import type { PgClient } from "./pg.ts";
import {
  createTestDatabase,
  type TestDatabase,
  testDbAssets,
  testReplicas,
  testVerifiers,
  withTestOwnerSession,
} from "./testing/index.ts";

// The integration timeouts, which the root Vitest configuration leaves to each file: a file's
// database is made under the cluster-wide lock that other files' bootstraps may hold.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const assets = testDbAssets();
let db: TestDatabase;
let su: PgClient;
let first: RunResult;

function migrate(): Promise<RunResult> {
  return withTestOwnerSession(db, (owner) =>
    runMigrations(owner, {
      files: assets.migrations,
      release: "test-release",
      fragments: assets.fragments,
    }),
  );
}

beforeAll(async () => {
  // An empty database: no bootstrap and no migrations from the harness.
  db = await createTestDatabase({ prefix: "p0eall", bootstrap: false });
  su = await db.superuser();
  await db.withLock(async () => {
    const superuser = await db.superuser();
    try {
      await bootstrap(superuser, {
        verifiers: testVerifiers(),
        replicas: testReplicas(),
        environment: "ci",
        files: assets.bootstrap,
        fragments: assets.fragments,
      });
    } finally {
      await superuser.end();
    }
  });
  first = await migrate();
});

afterAll(async () => {
  await su?.end();
  await db?.drop();
});

describe("every package's files, from an empty database", () => {
  it("takes the migrations of more than one package", () => {
    const discovered = discoverDbAssets(assets.root);
    expect(new Set(discovered.migrations.map((f) => f.package))).toEqual(
      new Set(["db", "email", "identity", ...discovered.migrations.map((f) => f.package)]),
    );
    expect(discovered.migrations.map((f) => f.name)).toEqual(assets.migrations.map((f) => f.name));
  });

  it("applies every migration once, in one order by name across packages", async () => {
    const names = assets.migrations.map((f) => f.name);
    expect(first.applied).toEqual(names);
    expect(names).toEqual([...names].sort());
    const recorded = await su.query<{ name: string; checksum: Buffer; release: string }>(
      "SELECT name, checksum, release FROM ops.schema_migrations ORDER BY name",
    );
    expect(recorded.rows.map((r) => r.name)).toEqual(names);
    for (const [i, row] of recorded.rows.entries()) {
      expect(row.checksum.equals(assets.migrations[i]?.checksum ?? Buffer.alloc(0)), row.name).toBe(
        true,
      );
      expect(row.release).toBe("test-release");
    }
    expect(first.newest).toBe(names.at(-1));
    expect(await schemaVersion(su)).toBe(names.at(-1));
  });

  it("creates each package's objects", async () => {
    const result = await su.query<{ name: string; found: boolean }>(
      `SELECT name, pg_catalog.to_regclass(name) IS NOT NULL AS found
       FROM unnest($1::text[]) AS t(name) ORDER BY name`,
      [
        [
          "audit.event",
          "email_private.outbox",
          "email_private.send_bucket",
          "ops.kill_switch",
          "identity.user",
          "identity.session_view",
          "staff.member",
          "ops.step_up_intent",
          "ops.lockout",
        ],
      ],
    );
    for (const row of result.rows) expect(row.found, row.name).toBe(true);
    // The identity package's guards, installed through packages/db's audit.install_guard().
    const guards = await su.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'identity.user'::regclass AND tgname LIKE 'audit_guard_%'`,
    );
    expect(guards.rows[0]?.n).toBeGreaterThan(0);
  });

  it("grants exactly every package's fragments, and nothing else", async () => {
    const owner = await db.connect("fin_owner");
    try {
      const live = (await livePrivileges(owner)).map(
        (p) => `${p.kind} ${p.object} ${p.privilege} ${p.role}`,
      );
      expect(live).toEqual(expandMatrix(assets.fragments).map(privilegeKey));
      expect(await grantDrift(owner, assets.fragments)).toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it("applies nothing on a second run, and keeps the grants", async () => {
    const again = await migrate();
    expect(again.applied).toEqual([]);
    expect(again.unknown).toBe(0);
    expect(again.newest).toBe(first.newest);
    expect(again.grantStatements).toBe(first.grantStatements);
  });
});
