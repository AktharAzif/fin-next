// Test helpers for every lane's integration tests (`*.db.test.ts`) and for the unit-of-work rule.
//
// Integration tests run against a real Postgres 18 named by FIN_TEST_DATABASE_URL (a superuser URL to a
// loopback server, never PGlite, CI-12). Each test file gets a fresh database, bootstrapped and
// migrated with the code under test. Roles are cluster-wide, so:
//   - every login's test password is derived from its name (deterministic, never a secret: the
//     cluster is a local throwaway), and concurrent runs set the same ones;
//   - everything that changes a role (the bootstrap, fin_owner's password) runs under one
//     cluster-wide advisory lock held on the admin database, so two files never race on pg_authid;
//   - every test bootstrap sizes the logins' CONNECTION LIMIT for TEST_REPLICAS replicas, because
//     turbo runs each package's test:db at the same time, Vitest runs a package's files in parallel,
//     and the limits are shared by all of them;
//   - `database(group)` hands out one pool per login for the file, so a test never leaves idle
//     connections of its own behind against those limits.
import { createHash } from "node:crypto";
import { scramSha256Verifier } from "@fin/crypto";
import { bootstrap } from "../bootstrap.ts";
import {
  connectClient,
  type DatabaseTarget,
  parseSuperuserUrl,
  withOwnerSession,
} from "../connect.ts";
import { type Clock, discardLines, type LineSink, type UnitContext } from "../context.ts";
import { ClientHeldAcrossCallError } from "../errors.ts";
import { loadFragments } from "../grants.ts";
import {
  BOOTSTRAP_DIR,
  GRANTS_DIR,
  MIGRATIONS_DIR,
  type RunOptions,
  readMigrations,
  runMigrations,
} from "../migrations.ts";
import { escapeIdentifier, escapeLiteral, type PgClient, type PgPool } from "../pg.ts";
import {
  type ConnectionSettings,
  clientConfig,
  createPool,
  ScramOnlyClient,
  type TlsSettings,
} from "../pool.ts";
import {
  SERVICE_GROUPS,
  type ServiceGroup,
  type ServiceName,
  VERIFIER_LOGINS,
  type VerifierLogin,
} from "../roles.ts";
import { createDatabase, type FinDatabase, isHoldingClient } from "../unit.ts";

export { registerEventTypes, type TestEventType, testId } from "./events.ts";

const CLUSTER_LOCK = 0x46494e30; // "FIN0": the one advisory lock every role change in tests takes.

/** The replicas every test bootstrap sizes connection limits for (see the header). */
export const TEST_REPLICAS = 4;

/** TEST_REPLICAS for every service, as bootstrap's `replicas` and FIN_DB_REPLICAS take it. */
export function testReplicas(): Record<ServiceName, number> {
  return {
    edge: TEST_REPLICAS,
    api: TEST_REPLICAS,
    worker: TEST_REPLICAS,
    payments: TEST_REPLICAS,
    console: TEST_REPLICAS,
    admin: TEST_REPLICAS,
  };
}

/** testReplicas() as FIN_DB_REPLICAS holds it, for tests that drive `migrate --bootstrap` itself. */
export function testReplicasJson(): string {
  return JSON.stringify(testReplicas());
}

/** The environment every test database is bootstrapped for. */
export const TEST_ENVIRONMENT = "ci";

/**
 * A connection, optionally with session settings in the startup packet (`-c name=value`), the way a
 * client chooses them before any trigger or statement of ours runs.
 */
async function connectWith(
  settings: ConnectionSettings,
  startupOptions?: string,
): Promise<PgClient> {
  if (startupOptions === undefined) return connectClient(settings);
  const client = new ScramOnlyClient({
    ...clientConfig(settings),
    options: startupOptions,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
}

/** A login's test password: derived from its name, so concurrent runs agree. */
export function testLoginPassword(login: string): string {
  return createHash("sha256").update(`fin-test-login:${login}`).digest("base64url");
}

/** Every login's verifier for the bootstrap, from the test passwords. */
export function testVerifiers(): Record<VerifierLogin, string> {
  const out = {} as Record<VerifierLogin, string>;
  for (const login of VERIFIER_LOGINS) out[login] = scramSha256Verifier(testLoginPassword(login));
  return out;
}

export interface TestClusterSettings extends DatabaseTarget {
  user: string;
  password: string;
}

/** FIN_TEST_DATABASE_URL, which must name a loopback server. */
export function testClusterSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TestClusterSettings {
  const url = env.FIN_TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "FIN_TEST_DATABASE_URL is not set: integration tests need a Postgres 18 superuser URL",
    );
  }
  const parsed = parseSuperuserUrl(url);
  if (!["127.0.0.1", "::1", "localhost"].includes(parsed.host)) {
    throw new Error("FIN_TEST_DATABASE_URL must name a loopback server");
  }
  return parsed;
}

const LOOPBACK_TLS: TlsSettings = { insecureLoopback: true };

export const testClock: Clock = { now: () => Date.now() };

/** A unit context for tests, with an optional line collector. */
export function testContext(overrides: Partial<UnitContext> = {}): UnitContext {
  return { clock: testClock, release: "test-release", log: discardLines, ...overrides };
}

/** Collects lines written by the unit under test. */
export function collectLines(): LineSink & {
  lines: { event: string; fields: Record<string, unknown> }[];
} {
  const lines: { event: string; fields: Record<string, unknown> }[] = [];
  return {
    lines,
    write(line) {
      lines.push({ event: line.event, fields: { ...line.fields } });
    },
  };
}

async function withClusterLock<T>(cluster: TestClusterSettings, fn: () => Promise<T>): Promise<T> {
  const admin = await connectClient({
    ...cluster,
    tls: LOOPBACK_TLS,
    applicationName: "fin-test-admin",
  });
  try {
    await admin.query("SELECT pg_advisory_lock($1)", [CLUSTER_LOCK]);
    return await fn();
  } finally {
    await admin.query("SELECT pg_advisory_unlock($1)", [CLUSTER_LOCK]).catch(() => {});
    await admin.end().catch(() => {});
  }
}

export interface TestDatabase {
  readonly name: string;
  readonly target: DatabaseTarget;
  /** A superuser connection to this database, optionally with startup settings (`-c name=value`). */
  superuser(startupOptions?: string): Promise<PgClient>;
  /**
   * A connection as a login, with its application name and optional startup settings; fin_owner's
   * test password is set first, under the cluster lock.
   */
  connect(login: string, applicationName?: string, startupOptions?: string): Promise<PgClient>;
  /** The file's pool and unit of work for a service group's `_a` login (or `_b`), made once. */
  database(group: ServiceGroup, login?: "a" | "b"): FinDatabase;
  /** A pool and unit of work as fin_owner (operator tasks), its test password set under the lock. */
  ownerDatabase(): Promise<FinDatabase>;
  /** Runs `fn` under the cluster lock (for tests that change roles themselves). */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Runs the migrations again as fin_owner, with the given options. */
  migrate(options?: Partial<RunOptions>): Promise<void>;
  drop(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** The lane's prefix, so a leftover database says whose it is: `p0e`, `sat02`. */
  prefix: string;
  /** Bootstrap only, without the migrations (for the runner's own tests). */
  migrate?: boolean;
  /** An empty database: no bootstrap and no migrations (for `migrate --bootstrap`'s own tests). */
  bootstrap?: boolean;
  /** Runs after the migrations in their transaction: a lane's own registry sync. */
  after?: RunOptions["after"];
}

/** Creates, bootstraps and migrates a fresh database for one test file. */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions,
): Promise<TestDatabase> {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(options.prefix)) throw new TypeError("prefix shape");
  const cluster = testClusterSettings();
  const name = `${options.prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const target: DatabaseTarget = { host: cluster.host, port: cluster.port, database: name };
  const pools: PgPool[] = [];
  const databases = new Map<string, FinDatabase>();

  const admin = await connectClient({
    ...cluster,
    tls: LOOPBACK_TLS,
    applicationName: "fin-test-admin",
  });
  try {
    await admin.query(
      `CREATE DATABASE ${escapeIdentifier(name)} ENCODING 'UTF8' TEMPLATE template0`,
    );
  } finally {
    await admin.end();
  }

  const superuser = (startupOptions?: string) =>
    connectWith(
      { ...cluster, database: name, tls: LOOPBACK_TLS, applicationName: "fin-test-superuser" },
      startupOptions,
    );

  const setOwnerPassword = async () => {
    const su = await superuser();
    try {
      await su.query(
        `ALTER ROLE fin_owner WITH LOGIN PASSWORD ${escapeLiteral(scramSha256Verifier(testLoginPassword("fin_owner")))} VALID UNTIL 'infinity'`,
      );
    } finally {
      await su.end();
    }
  };

  const connectOwner = (applicationName = "fin-test-owner", startupOptions?: string) =>
    connectWith(
      {
        ...target,
        user: "fin_owner",
        password: testLoginPassword("fin_owner"),
        tls: LOOPBACK_TLS,
        applicationName,
      },
      startupOptions,
    );

  const migrate = async (overrides: Partial<RunOptions> = {}) => {
    await withClusterLock(cluster, async () => {
      await setOwnerPassword();
      const owner = await connectOwner();
      try {
        await runMigrations(owner, {
          files: readMigrations(MIGRATIONS_DIR),
          release: "test-release",
          fragments: loadFragments(GRANTS_DIR),
          ...(options.after === undefined ? {} : { after: options.after }),
          ...overrides,
        });
      } finally {
        await owner.end();
      }
    });
  };

  if (options.bootstrap !== false) {
    await withClusterLock(cluster, async () => {
      const su = await superuser();
      try {
        await bootstrap(su, {
          verifiers: testVerifiers(),
          replicas: testReplicas(),
          environment: TEST_ENVIRONMENT,
          bootstrapDir: BOOTSTRAP_DIR,
          fragments: loadFragments(GRANTS_DIR),
        });
      } finally {
        await su.end();
      }
      await setOwnerPassword();
    });
    if (options.migrate !== false) await migrate();
  }

  return {
    name,
    target,
    superuser,
    async connect(login, applicationName, startupOptions) {
      if (login === "fin_owner") {
        return withClusterLock(cluster, async () => {
          await setOwnerPassword();
          return connectOwner(applicationName, startupOptions);
        });
      }
      return connectWith(
        {
          ...target,
          user: login,
          password: testLoginPassword(login),
          tls: LOOPBACK_TLS,
          applicationName: applicationName ?? "fin-test",
        },
        startupOptions,
      );
    },
    database(group, login = "a") {
      if (!(SERVICE_GROUPS as readonly string[]).includes(group)) throw new TypeError("group");
      const made = databases.get(`${group}_${login}`);
      if (made !== undefined) return made;
      const pool = createPool(
        {
          ...target,
          user: `${group}_${login}`,
          password: testLoginPassword(`${group}_${login}`),
          tls: LOOPBACK_TLS,
          applicationName: `fin-test-${group.replace(/^fin_/, "")}`,
          max: 4,
        },
        discardLines,
      );
      pools.push(pool);
      const database = createDatabase({ pool });
      databases.set(`${group}_${login}`, database);
      return database;
    },
    async ownerDatabase() {
      // One connection, opened under the lock and kept: another file's bootstrap may clear the owner's
      // password at any time, which stops new logins but not an open session.
      const pool = createPool(
        {
          ...target,
          user: "fin_owner",
          password: testLoginPassword("fin_owner"),
          tls: LOOPBACK_TLS,
          applicationName: "fin-test-owner",
          max: 1,
          idleTimeoutMillis: 0,
        },
        discardLines,
      );
      pools.push(pool);
      await withClusterLock(cluster, async () => {
        await setOwnerPassword();
        const client = await pool.connect();
        client.release();
      });
      return createDatabase({ pool });
    },
    withLock: (fn) => withClusterLock(cluster, fn),
    migrate,
    async drop() {
      await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
      const dropper = await connectClient({
        ...cluster,
        tls: LOOPBACK_TLS,
        applicationName: "fin-test-admin",
      });
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/** Runs `fn` with fin_owner's per-run password flow against a test database, under the cluster lock. */
export async function withTestOwnerSession<T>(
  db: TestDatabase,
  fn: (owner: PgClient, superuser: PgClient) => Promise<T>,
): Promise<T> {
  return db.withLock(async () => {
    const su = await db.superuser();
    try {
      return await withOwnerSession(
        su,
        { ...db.target, tls: LOOPBACK_TLS, applicationName: "fin-test-run" },
        testClock,
        (owner) => fn(owner, su),
      );
    } finally {
      await su.end();
    }
  });
}

/**
 * The superuser URL of a test database, for driving `migrate`'s own entry point in tests. It carries
 * the cluster's superuser password, so it never leaves the test process.
 */
export function testSuperuserUrl(db: TestDatabase): string {
  const cluster = testClusterSettings();
  const auth = `${encodeURIComponent(cluster.user)}:${encodeURIComponent(cluster.password)}`;
  return `postgresql://${auth}@${cluster.host}:${cluster.port}/${db.name}`;
}

/** The test verifiers as FIN_ROLE_VERIFIERS holds them. */
export function testVerifiersJson(): string {
  return JSON.stringify(testVerifiers());
}

/**
 * The unit-of-work test hook (ARCHITECTURE §3.5): while installed, any `fetch` that starts inside a
 * unit of work (while a client is held) throws ClientHeldAcrossCallError. Returns the uninstaller.
 */
export function installFetchGuard(): () => void {
  const original = globalThis.fetch;
  const guarded: typeof fetch = (input, init) => {
    if (isHoldingClient()) return Promise.reject(new ClientHeldAcrossCallError("fetch"));
    return original(input, init);
  };
  globalThis.fetch = guarded;
  return () => {
    globalThis.fetch = original;
  };
}
