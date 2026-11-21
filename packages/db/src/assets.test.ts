// The database files' one rule (assets.ts): every package's bootstrap, migrations and grants, each kind
// in one order by name across packages, duplicates refused; and the command line stages exactly that
// set, laid out as in the source.
import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dbAssetsRoot,
  discoverDbAssets,
  IMAGE_ASSETS_DIR,
  listMigrations,
  sourceRoot,
  stageDbAssets,
} from "./assets.ts";
import { orderBootstrapFiles } from "./bootstrap.ts";
import { DatabaseConfigError, MigrationError } from "./errors.ts";
import { loadDbAssets, readMigrationFiles } from "./migrations.ts";

const HEADER = "SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';\n";
const ROOT = sourceRoot() ?? "";
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fin-db-assets-"));
  temporary.push(dir);
  return dir;
}

/** A root laid out as the repository, holding the given files (path from the root, content). */
function fixture(files: Record<string, string>): string {
  const root = tempDir();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const GRANT = (area: string) => JSON.stringify({ area, grants: [] });

/** The smallest complete root: one file of each kind in packages/db. */
const BASE = {
  "packages/db/bootstrap/010_roles.sql": "SELECT 1;",
  "packages/db/migrations/20261121101000_audit_core.sql": `${HEADER}SELECT 1;`,
  "packages/db/roles/grants/ops.json": GRANT("ops"),
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MigrationError) return error.code;
    throw error;
  }
  return "none";
}

/** Every file of the rule, found by a glob of its own rather than by assets.ts. */
function globbed(root: string): string[] {
  return globSync(
    [
      "packages/*/bootstrap/*.sql",
      "packages/*/migrations/*.sql",
      "packages/*/grants/*.json",
      "packages/db/roles/grants/*.json",
    ],
    { cwd: root },
  )
    .map((p) => p.split("\\").join("/"))
    .sort();
}

describe("discovery", () => {
  it("orders each kind by file name across packages", () => {
    const root = fixture({
      ...BASE,
      "packages/db/bootstrap/020_privileged_login.sql": "SELECT 1;",
      "packages/orgs/bootstrap/015_orgs_extension.sql": "SELECT 1;",
      "packages/identity/migrations/20261121120000_identity_realm.sql": `${HEADER}SELECT 1;`,
      "packages/orgs/migrations/20261121110000_orgs_tables.sql": `${HEADER}SELECT 1;`,
      "packages/orgs/migrations/20261121130000_orgs_views.sql": `${HEADER}SELECT 1;`,
      "packages/identity/grants/identity.json": GRANT("identity"),
      "packages/orgs/grants/orgs.json": GRANT("orgs"),
      "packages/orgs/README.md": "not a database file",
      "packages/orgs/migrations/notes.md": "not a migration",
    });
    const assets = discoverDbAssets(root);
    expect(assets.migrations.map((f) => `${f.package} ${f.name}`)).toEqual([
      "db 20261121101000_audit_core.sql",
      "orgs 20261121110000_orgs_tables.sql",
      "identity 20261121120000_identity_realm.sql",
      "orgs 20261121130000_orgs_views.sql",
    ]);
    expect(assets.bootstrap.map((f) => f.source)).toEqual([
      "packages/db/bootstrap/010_roles.sql",
      "packages/orgs/bootstrap/015_orgs_extension.sql",
      "packages/db/bootstrap/020_privileged_login.sql",
    ]);
    expect(assets.grants.map((f) => f.source)).toEqual([
      "packages/identity/grants/identity.json",
      "packages/db/roles/grants/ops.json",
      "packages/orgs/grants/orgs.json",
    ]);
    expect(listMigrations(root)).toEqual(assets.migrations.map((f) => f.name));
    expect(loadDbAssets(root).fragments.map((f) => f.area)).toEqual(["identity", "ops", "orgs"]);
  });

  it("refuses two files of a kind with one name, whichever packages hold them", () => {
    expect(
      codeOf(() =>
        discoverDbAssets(
          fixture({
            ...BASE,
            "packages/identity/migrations/20261121101000_audit_core.sql": `${HEADER}SELECT 2;`,
          }),
        ),
      ),
    ).toBe("db_assets_duplicate");
    expect(
      codeOf(() =>
        discoverDbAssets(fixture({ ...BASE, "packages/identity/grants/ops.json": GRANT("ops") })),
      ),
    ).toBe("db_assets_duplicate");
    expect(
      codeOf(() =>
        discoverDbAssets(fixture({ ...BASE, "packages/db/grants/ops.json": GRANT("ops") })),
      ),
    ).toBe("db_assets_duplicate");
    expect(
      codeOf(() =>
        discoverDbAssets(
          fixture({ ...BASE, "packages/orgs/bootstrap/010_roles.sql": "SELECT 2;" }),
        ),
      ),
    ).toBe("db_assets_duplicate");
  });

  it("refuses two migrations sharing a timestamp across packages", () => {
    const root = fixture({
      ...BASE,
      "packages/identity/migrations/20261121101000_identity_realm.sql": `${HEADER}SELECT 1;`,
    });
    expect(codeOf(() => readMigrationFiles(discoverDbAssets(root).migrations))).toBe(
      "migration_order",
    );
  });

  it("refuses migrations given out of name order", () => {
    const root = fixture({
      ...BASE,
      "packages/identity/migrations/20261121120000_identity_realm.sql": `${HEADER}SELECT 1;`,
    });
    const files = discoverDbAssets(root).migrations;
    expect(codeOf(() => readMigrationFiles([...files].reverse()))).toBe("migration_order");
  });

  it("refuses a root without one of the kinds, so a wrong FIN_DB_ASSETS_DIR applies nothing", () => {
    expect(codeOf(() => discoverDbAssets(tempDir()))).toBe("db_assets_missing");
    const { "packages/db/roles/grants/ops.json": _grants, ...noGrants } = BASE;
    expect(codeOf(() => discoverDbAssets(fixture(noGrants)))).toBe("db_assets_missing");
    expect(codeOf(() => discoverDbAssets(fixture(BASE), { packages: ["orgs"] }))).toBe(
      "db_assets_missing",
    );
  });

  it("runs the roles file first and refuses a misnamed bootstrap file", () => {
    const files = [
      { name: "020_privileged_login.sql", path: "b" },
      { name: "010_roles.sql", path: "a" },
    ];
    expect(orderBootstrapFiles(files).map((f) => f.name)).toEqual([
      "010_roles.sql",
      "020_privileged_login.sql",
    ]);
    expect(codeOf(() => orderBootstrapFiles([{ name: "020_x.sql", path: "x" }]))).toBe(
      "bootstrap_files",
    );
    expect(
      codeOf(() =>
        orderBootstrapFiles([
          { name: "010_roles.sql", path: "a" },
          { name: "roles.sql", path: "b" },
        ]),
      ),
    ).toBe("bootstrap_files");
  });
});

describe("the repository's files", () => {
  it("are every package's, each in the runner's order, and pass the runner's checks", () => {
    const assets = discoverDbAssets(ROOT);
    const sources = [...assets.bootstrap, ...assets.migrations, ...assets.grants]
      .map((f) => f.source)
      .sort();
    expect(sources).toEqual(globbed(ROOT));
    const packages = new Set(assets.migrations.map((f) => f.package));
    expect(packages.has("db")).toBe(true);
    expect(packages.has("identity")).toBe(true);
    const names = assets.migrations.map((f) => f.name);
    expect(names).toEqual([...names].sort());
    const loaded = loadDbAssets(ROOT);
    expect(loaded.migrations.map((f) => f.name)).toEqual(names);
    expect(loaded.fragments.map((f) => f.file)).toEqual(assets.grants.map((f) => f.name));
  });

  it("are what the runner reads locally, and FIN_DB_ASSETS_DIR in an image", () => {
    expect(dbAssetsRoot({})).toBe(ROOT);
    expect(dbAssetsRoot({ FIN_DB_ASSETS_DIR: IMAGE_ASSETS_DIR })).toBe(IMAGE_ASSETS_DIR);
    expect(() => dbAssetsRoot({ FIN_DB_ASSETS_DIR: "db-assets" })).toThrow(DatabaseConfigError);
    expect(sourceRoot("/")).toBeNull();
  });
});

describe("the command line (assets-cli.ts)", () => {
  it("holds exactly the files a local run reads, byte for byte, laid out as in the source", () => {
    const out = join(tempDir(), "db-assets");
    execFileSync(process.execPath, [join(ROOT, "packages/db/src/assets-cli.ts"), "stage", out], {
      stdio: "pipe",
    });
    const local = globbed(ROOT);
    expect(globbed(out)).toEqual(local);
    for (const file of local) {
      expect(readFileSync(join(out, file)).equals(readFileSync(join(ROOT, file))), file).toBe(true);
    }
    const fromImage = discoverDbAssets(out);
    const fromSource = discoverDbAssets(ROOT);
    for (const kind of ["bootstrap", "migrations", "grants"] as const) {
      expect(fromImage[kind].map((f) => f.source)).toEqual(fromSource[kind].map((f) => f.source));
    }
    expect(codeOf(() => stageDbAssets(ROOT, out))).toBe("db_assets");
  });

  it("gives the release manifest its migrations and minimum schema version", () => {
    const printed = execFileSync(
      process.execPath,
      [join(ROOT, "packages/db/src/assets-cli.ts"), "migrations"],
      { encoding: "utf8" },
    );
    const migrations = listMigrations(ROOT);
    expect(JSON.parse(printed)).toEqual({
      migrations,
      minimumSchemaVersion: migrations.at(-1),
    });
  });
});
