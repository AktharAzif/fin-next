// Integration test database (real Postgres 18, never PGlite; CI-12). Each test file gets its own
// database, named from FIN_TEST_DATABASE_URL's database plus a suffix, and its own group and login
// roles under a per-file prefix, so files can run in parallel on one shared cluster. Passwords are
// made at run time and never printed.
/// <reference path="./pg.d.ts" />
import { randomBytes } from "node:crypto";
import pg, { type Pool } from "pg";
import { SENDER_ROLES, type SenderRole } from "../catalogue.ts";
import { installOutboxSchema } from "./index.ts";

export const DATABASE_URL = process.env.FIN_TEST_DATABASE_URL ?? "";
export const HAS_DATABASE = DATABASE_URL !== "";

export interface TestDatabase {
  readonly admin: Pool;
  readonly as: Readonly<Record<SenderRole, Pool>>;
  readonly roleName: (role: SenderRole) => string;
  readonly loginName: (role: SenderRole) => string;
  /** A connection URL for a role's login, for a dedicated client such as the LISTEN connection. */
  readonly urlFor: (role: SenderRole) => string;
  close(): Promise<void>;
}

function withDatabase(url: string, database: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user !== undefined) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

async function ignoreExists(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (error) {
    const code = (error as { code?: string }).code;
    // 42710 duplicate_object, 42P04 duplicate_database, 23505 a concurrent create.
    if (code !== "42710" && code !== "42P04" && code !== "23505") throw error;
  }
}

/** Creates (or reuses) this file's database and roles and installs the outbox schema fresh. */
export async function openTestDatabase(suffix: string): Promise<TestDatabase> {
  const base = new URL(DATABASE_URL);
  const baseName = base.pathname.replace(/^\//u, "") || "postgres";
  const name = `${baseName}_${suffix}`.replace(/[^a-z0-9_]/gu, "_");
  const bootstrap = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await ignoreExists(bootstrap.query(`CREATE DATABASE ${name}`));
  await bootstrap.end();

  const prefix = `l05${suffix.replace(/[^a-z0-9]/gu, "").slice(0, 8)}_`;
  const roleName = (role: SenderRole): string => `${prefix}${role}`;
  const loginName = (role: SenderRole): string => `${prefix}${role}_a`;
  const admin = new pg.Pool({ connectionString: withDatabase(DATABASE_URL, name), max: 4 });
  const passwords = new Map<SenderRole, string>();
  for (const role of SENDER_ROLES) {
    await ignoreExists(admin.query(`CREATE ROLE ${roleName(role)} NOLOGIN`));
    await ignoreExists(
      admin.query(`CREATE ROLE ${loginName(role)} LOGIN IN ROLE ${roleName(role)}`),
    );
    const password = randomBytes(24).toString("base64url");
    passwords.set(role, password);
    await admin.query(`ALTER ROLE ${loginName(role)} WITH LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO ${roleName(role)}`);
  }
  await installOutboxSchema(admin, roleName);

  const as = Object.fromEntries(
    SENDER_ROLES.map((role) => [
      role,
      new pg.Pool({
        connectionString: withDatabase(DATABASE_URL, name, loginName(role), passwords.get(role)),
        max: 6,
      }),
    ]),
  ) as Record<SenderRole, Pool>;

  return {
    admin,
    as,
    roleName,
    loginName,
    urlFor: (role) => withDatabase(DATABASE_URL, name, loginName(role), passwords.get(role)),
    close: async () => {
      await Promise.all(Object.values(as).map((p) => p.end()));
      await admin.end();
    },
  };
}
