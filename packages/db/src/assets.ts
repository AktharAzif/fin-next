// The database's files from every package (spec 01 §6.6, §6.10; ARCHITECTURE §6.3, §6.4): the
// superuser's bootstrap, the migrations and the grant fragments. Areas other than the data layer own
// tables too (packages/identity today, the organisation and staff packages next), so the runner reads
// every package's files, found by one rule under a root laid out as the repository is:
//
//   packages/<package>/bootstrap/NNN_<what>.sql                       the superuser's files
//   packages/<package>/migrations/<YYYYMMDDHHMMSS>_<area>_<what>.sql  fin_owner's files
//   packages/<package>/grants/<area>.json, and packages/db/roles/grants/<area>.json
//
// Each kind is one list across packages, in file-name order (a migration's name starts with its
// timestamp, a bootstrap file's with its number), and two files of a kind may not share a name. The
// root is the repository when the runner runs from the source tree (or a bundle built in it), and
// FIN_DB_ASSETS_DIR in an image: the Dockerfile copies there exactly the files this rule finds
// (`node packages/db/src/assets-cli.ts stage <dir>`, which keeps the layout), so the image and a local
// run apply the same set. Node built-ins only, so the image build and CI run it as it is.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseConfigError, MigrationError } from "./errors.ts";

export type AssetKind = "bootstrap" | "migrations" | "grants";
export const ASSET_KINDS: readonly AssetKind[] = ["bootstrap", "migrations", "grants"];

/** Where the image holds the files (FIN_DB_ASSETS_DIR in ops/docker/app.Dockerfile). */
export const IMAGE_ASSETS_DIR = "/app/db-assets";

/** One file of the set. */
export interface AssetFile {
  kind: AssetKind;
  /** The package directory's name: `db`, `identity`. */
  package: string;
  /** The file name, which orders the kind and is the migration's recorded name. */
  name: string;
  /** Its path from the root, with `/`: the same in the source tree and in the image. */
  source: string;
  /** Its absolute path. */
  path: string;
}

export interface DbAssets {
  root: string;
  bootstrap: readonly AssetFile[];
  migrations: readonly AssetFile[];
  grants: readonly AssetFile[];
}

const PACKAGE_NAME = /^[a-z][a-z0-9-]*$/;
const EXTENSION: Readonly<Record<AssetKind, RegExp>> = {
  bootstrap: /\.sql$/i,
  migrations: /\.sql$/i,
  grants: /\.json$/i,
};

/** The rule: the directories, relative to the root, that hold a package's files of each kind. */
export function assetDirectories(pkg: string): Readonly<Record<AssetKind, readonly string[]>> {
  return {
    bootstrap: [`packages/${pkg}/bootstrap`],
    migrations: [`packages/${pkg}/migrations`],
    grants:
      pkg === "db"
        ? ["packages/db/grants", "packages/db/roles/grants"]
        : [`packages/${pkg}/grants`],
  };
}

function isDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MigrationError("db_assets", `${path}: not a plain directory`);
  }
  return true;
}

function filesIn(root: string, pkg: string, kind: AssetKind, dir: string): AssetFile[] {
  const absolute = join(root, ...dir.split("/"));
  if (!isDirectory(absolute)) return [];
  const out: AssetFile[] = [];
  for (const name of readdirSync(absolute).sort()) {
    if (!EXTENSION[kind].test(name)) continue;
    const path = join(absolute, name);
    if (!lstatSync(path).isFile()) {
      throw new MigrationError("db_assets", `${dir}/${name}: not a plain file`, name);
    }
    out.push({ kind, package: pkg, name, source: `${dir}/${name}`, path });
  }
  return out;
}

/** Orders one kind by file name across packages; two files of a kind may not share a name. */
export function orderAssets(files: readonly AssetFile[]): AssetFile[] {
  const sorted = [...files].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.source < b.source ? -1 : 1,
  );
  for (let i = 1; i < sorted.length; i++) {
    const [before, file] = [sorted[i - 1], sorted[i]];
    if (before !== undefined && file !== undefined && before.name === file.name) {
      throw new MigrationError(
        "db_assets_duplicate",
        `${file.name}: in both ${before.source} and ${file.source}`,
        file.name,
      );
    }
  }
  return sorted;
}

export interface DiscoverOptions {
  /** Only these packages' files (packages/db's own tests); every package when absent. */
  packages?: readonly string[];
}

/**
 * Every package's bootstrap, migrations and grants under `root`, each kind in its one order. A root
 * with none of a kind is refused, so a wrong FIN_DB_ASSETS_DIR stops the run before a statement
 * (an empty grant set would otherwise revoke everything).
 */
export function discoverDbAssets(root: string, options: DiscoverOptions = {}): DbAssets {
  const packagesDir = join(root, "packages");
  if (!isDirectory(packagesDir)) {
    throw new MigrationError("db_assets_missing", "the assets root holds no packages directory");
  }
  const all = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PACKAGE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const packages = options.packages ?? all;
  for (const pkg of packages) {
    if (!all.includes(pkg)) {
      throw new MigrationError("db_assets_missing", `no package ${pkg} under the assets root`);
    }
  }
  const found: Record<AssetKind, AssetFile[]> = { bootstrap: [], migrations: [], grants: [] };
  for (const pkg of packages) {
    const dirs = assetDirectories(pkg);
    for (const kind of ASSET_KINDS) {
      for (const dir of dirs[kind]) found[kind].push(...filesIn(root, pkg, kind, dir));
    }
  }
  for (const kind of ASSET_KINDS) {
    if (found[kind].length === 0) {
      throw new MigrationError("db_assets_missing", `no ${kind} files under the assets root`);
    }
  }
  return {
    root,
    bootstrap: orderAssets(found.bootstrap),
    migrations: orderAssets(found.migrations),
    grants: orderAssets(found.grants),
  };
}

/**
 * The migrations a release applies, in the order it applies them: the release manifest's
 * `migrations`, whose last name is its minimum schema version (ARCHITECTURE §6.4).
 */
export function listMigrations(root: string): string[] {
  return discoverDbAssets(root).migrations.map((file) => file.name);
}

/**
 * The repository holding this file, found by walking up to its pnpm-workspace.yaml, so a bundle built
 * in the source tree finds it too; null in an image, which has none.
 */
export function sourceRoot(from: string = import.meta.dirname): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "packages", "db"))) {
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The root the runner reads: FIN_DB_ASSETS_DIR when set (the image's), else the source tree. */
export function dbAssetsRoot(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.FIN_DB_ASSETS_DIR;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) {
      throw new DatabaseConfigError("FIN_DB_ASSETS_DIR", "must be an absolute path");
    }
    return configured;
  }
  const source = sourceRoot();
  if (source === null) {
    throw new DatabaseConfigError("FIN_DB_ASSETS_DIR", "is required outside the source tree");
  }
  return source;
}

/**
 * Copies every file the rule finds under `root` to `out`, keeping each one's path from the root, and
 * checks that `out` then yields the same set, byte for byte. `out` must be absent or empty.
 */
export function stageDbAssets(root: string, out: string): DbAssets {
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new MigrationError("db_assets", "the staging directory is not empty");
  }
  const assets = discoverDbAssets(root);
  for (const kind of ASSET_KINDS) {
    for (const file of assets[kind]) {
      const target = join(out, ...file.source.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file.path, target);
    }
  }
  const staged = discoverDbAssets(out);
  for (const kind of ASSET_KINDS) {
    const want = assets[kind];
    const got = staged[kind];
    if (
      want.length !== got.length ||
      want.some((file, i) => {
        const copy = got[i];
        return (
          copy === undefined ||
          copy.source !== file.source ||
          !readFileSync(copy.path).equals(readFileSync(file.path))
        );
      })
    ) {
      throw new MigrationError("db_assets", `the staged ${kind} differ from the source`);
    }
  }
  return staged;
}
