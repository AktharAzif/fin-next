// The migration runner (ARCHITECTURE §6.4, DECISIONS DA-04, spec 01 §6.10).
//
// - Files are packages/<package>/migrations/<YYYYMMDDHHMMSS>_<area>_<what>.sql (assets.ts's rule),
//   hand-written, applied in name order across every package, each recorded in ops.schema_migrations
//   with the SHA-256 of its bytes. A changed applied file stops the run; an applied file the runner
//   does not know (a newer release's) is ignored, so an older image never trips on a newer schema.
// - The whole run is one transaction holding `LOCK TABLE ops.schema_migrations IN EXCLUSIVE MODE`, so
//   no other login can migrate at the same time, and a failure leaves the schema as it was.
// - Every transactional file sets `SET LOCAL lock_timeout` and `SET LOCAL statement_timeout` before
//   anything else. A file whose first line is `-- fin:non-transactional` holds one statement (for
//   CREATE INDEX CONCURRENTLY); the runner commits what came before it, runs it alone, then relocks.
// - After the files, the grants are rendered from the fragments, and the caller's `after` step (the
//   audit registry sync) runs, all in the same transaction.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AssetFile, type DiscoverOptions, discoverDbAssets } from "./assets.ts";
import { MigrationError } from "./errors.ts";
import { applyGrants, type GrantFragment, loadFragmentFiles } from "./grants.ts";
import { commitTransaction, type PgClient } from "./pg.ts";
import type { Queryable } from "./unit.ts";

export const MIGRATION_NAME = /^(\d{14})_([a-z][a-z0-9-]*)_([a-z0-9][a-z0-9_]*)\.sql$/;
const NON_TRANSACTIONAL = "-- fin:non-transactional";

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: Buffer;
  transactional: boolean;
}

function validTimestamp(ts: string): boolean {
  const [y, mo, d, h, mi, s] = [
    ts.slice(0, 4),
    ts.slice(4, 6),
    ts.slice(6, 8),
    ts.slice(8, 10),
    ts.slice(10, 12),
    ts.slice(12, 14),
  ].map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    y >= 2026 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s
  );
}

/** The statements of a file, comments and blank lines removed, for the header checks. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function parseMigration(name: string, bytes: Buffer): MigrationFile {
  const match = MIGRATION_NAME.exec(name);
  if (match?.[1] === undefined || !validTimestamp(match[1])) {
    throw new MigrationError(
      "migration_name",
      `${name}: not <YYYYMMDDHHMMSS>_<area>_<what>.sql with a real time`,
      name,
    );
  }
  const sql = bytes.toString("utf8");
  if (sql.includes("\r")) {
    throw new MigrationError("migration_line_endings", `${name}: CR line endings`, name);
  }
  const transactional = !sql.startsWith(NON_TRANSACTIONAL);
  const parts = statements(sql);
  if (transactional) {
    const head = parts.slice(0, 2).map((s) => s.replace(/\s+/g, " "));
    const hasLock = head.some((s) => /^SET LOCAL lock_timeout = '\d+(ms|s)'$/i.test(s));
    const hasStatement = head.some((s) =>
      /^SET LOCAL statement_timeout = '\d+(ms|s|min)'$/i.test(s),
    );
    if (!hasLock || !hasStatement) {
      throw new MigrationError(
        "migration_timeouts",
        `${name}: must begin with SET LOCAL lock_timeout and SET LOCAL statement_timeout`,
        name,
      );
    }
  } else if (parts.length !== 1) {
    throw new MigrationError(
      "migration_non_transactional",
      `${name}: holds exactly one statement`,
      name,
    );
  }
  return {
    name,
    sql,
    checksum: createHash("sha256").update(bytes).digest(),
    transactional,
  };
}

/**
 * Reads and checks the migrations given, which must be in name order (discoverDbAssets's): two files
 * may not share a timestamp, whichever packages they come from.
 */
export function readMigrationFiles(
  files: readonly Pick<AssetFile, "name" | "path">[],
): MigrationFile[] {
  const parsed = files.map((file) => parseMigration(file.name, readFileSync(file.path)));
  for (let i = 1; i < parsed.length; i++) {
    const [before, file] = [parsed[i - 1], parsed[i]];
    if (before === undefined || file === undefined) continue;
    if (file.name.slice(0, 14) === before.name.slice(0, 14)) {
      throw new MigrationError("migration_order", `${file.name}: shares its timestamp`, file.name);
    }
    if (file.name < before.name) {
      throw new MigrationError("migration_order", `${file.name}: out of name order`, file.name);
    }
  }
  return parsed;
}

/** Reads and checks every migration in one directory, in name order. */
export function readMigrations(dir: string): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return readMigrationFiles(names.map((name) => ({ name, path: join(dir, name) })));
}

/** Every package's files, read and checked: what `migrate --bootstrap` and `--migrate` apply. */
export interface LoadedDbAssets {
  root: string;
  /** The superuser's files, in the order discovered (bootstrap() checks the roles file is first). */
  bootstrap: readonly AssetFile[];
  migrations: MigrationFile[];
  fragments: GrantFragment[];
}

/** Finds (assets.ts's rule), reads and checks every package's files under `root`. */
export function loadDbAssets(root: string, options: DiscoverOptions = {}): LoadedDbAssets {
  const assets = discoverDbAssets(root, options);
  return {
    root,
    bootstrap: assets.bootstrap,
    migrations: readMigrationFiles(assets.migrations),
    fragments: loadFragmentFiles(assets.grants),
  };
}

/**
 * The CI order check (DA-04): every migration a branch adds must be later than the newest on main, so
 * files never merge out of order. Returns the offending names.
 */
export function migrationsNotAfterMain(
  branchNames: readonly string[],
  mainNames: readonly string[],
): string[] {
  const onMain = new Set(mainNames);
  const newest = [...mainNames].sort().at(-1) ?? "";
  return branchNames.filter((name) => !onMain.has(name) && name <= newest).sort();
}

const CREATE_SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS ops.schema_migrations (
  name       text PRIMARY KEY CHECK (name ~ '^[0-9]{14}_[a-z][a-z0-9-]*_[a-z0-9][a-z0-9_]*\\.sql$'),
  checksum   bytea NOT NULL CHECK (octet_length(checksum) = 32),
  release    text NOT NULL CHECK (char_length(release) BETWEEN 1 AND 64),
  applied_at timestamptz NOT NULL
)`;

// The newest name in code-point order, the order the files are read and applied in (readMigrationFiles,
// migrationsNotAfterMain): "C", never the database's default collation, which may order names apart
// from the code (glibc's en_US.utf8 ignores the underscores).
const SELECT_NEWEST = 'SELECT max(name COLLATE "C") AS name FROM ops.schema_migrations';

export interface RunOptions {
  files: readonly MigrationFile[];
  release: string;
  fragments: readonly GrantFragment[];
  /** Runs in the run's transaction after the files and grants: the audit registry sync. */
  after?: (q: Queryable) => Promise<void>;
}

export interface RunResult {
  applied: string[];
  /** Applied rows the runner has no file for (a newer release's). */
  unknown: number;
  /** The newest applied name, the schema version `/readyz` compares. */
  newest: string | null;
  grantStatements: number;
}

/** Runs the migrations on a client logged in as fin_owner. The caller owns the connection. */
export async function runMigrations(client: PgClient, options: RunOptions): Promise<RunResult> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.release)) {
    throw new MigrationError("migration_release", "FIN_RELEASE must be 1 to 64 safe characters");
  }
  const role = await client.query<{ current_user: string }>("SELECT current_user");
  if (role.rows[0]?.current_user !== "fin_owner") {
    throw new MigrationError("migration_role", "migrations run as fin_owner");
  }

  const q: Queryable = { query: (text, values) => client.query(text, values) };
  const lock = async () => {
    await client.query("BEGIN");
    await client.query(CREATE_SCHEMA_MIGRATIONS);
    await client.query("LOCK TABLE ops.schema_migrations IN EXCLUSIVE MODE");
  };

  let inTransaction = false;
  try {
    await lock();
    inTransaction = true;
    const appliedRows = await client.query<{ name: string; checksum: Buffer }>(
      "SELECT name, checksum FROM ops.schema_migrations",
    );
    const applied = new Map(appliedRows.rows.map((row) => [row.name, row.checksum]));
    const known = new Set(options.files.map((f) => f.name));
    const newlyApplied: string[] = [];

    for (const file of options.files) {
      const checksum = applied.get(file.name);
      if (checksum !== undefined) {
        if (!checksum.equals(file.checksum)) {
          throw new MigrationError(
            "migration_changed",
            `${file.name}: changed after it was applied`,
            file.name,
          );
        }
        continue;
      }
      if (file.transactional) {
        await client.query(file.sql);
      } else {
        // Commit what came before, run the one statement on its own, then take the lock again.
        inTransaction = false;
        await commitTransaction(client);
        await client.query("SELECT pg_catalog.set_config('lock_timeout', '5s', false)");
        await client.query("SELECT pg_catalog.set_config('statement_timeout', '30min', false)");
        await client.query(file.sql);
        await client.query("RESET lock_timeout");
        await client.query("RESET statement_timeout");
        await lock();
        inTransaction = true;
        const again = await client.query("SELECT 1 FROM ops.schema_migrations WHERE name = $1", [
          file.name,
        ]);
        if (again.rowCount !== 0) continue;
      }
      await client.query(
        "INSERT INTO ops.schema_migrations (name, checksum, release, applied_at) VALUES ($1, $2, $3, statement_timestamp())",
        [file.name, file.checksum, options.release],
      );
      newlyApplied.push(file.name);
    }

    const grantStatements = await applyGrants(q, options.fragments);
    if (options.after !== undefined) await options.after(q);

    const newest = await client.query<{ name: string | null }>(SELECT_NEWEST);
    inTransaction = false;
    await commitTransaction(client);
    return {
      applied: newlyApplied,
      unknown: [...applied.keys()].filter((name) => !known.has(name)).length,
      newest: newest.rows[0]?.name ?? null,
      grantStatements: grantStatements.length,
    };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** The newest applied migration, for `/readyz`'s minimum schema version (ARCHITECTURE §6.4). */
export async function schemaVersion(q: Queryable): Promise<string | null> {
  const result = await q.query<{ name: string | null }>(SELECT_NEWEST);
  return result.rows[0]?.name ?? null;
}

/**
 * packages/db's own directories, for its own tests of Phase 0's files. The runner reads every
 * package's (loadDbAssets), never these alone.
 */
export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");
export const BOOTSTRAP_DIR = join(import.meta.dirname, "..", "bootstrap");
export const GRANTS_DIR = join(import.meta.dirname, "..", "roles", "grants");
