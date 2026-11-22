#!/usr/bin/env node
// The release image's output scan (ARCHITECTURE §3.5, [SA-38]; spec 01 §4.9: only the `test`
// target holds packages/testing). It has two modes, one for each kind of copy a release stage
// takes:
//   - the bundle's: app.Dockerfile's build-release stage and connector.Dockerfile's build stage run
//     it right after the server bundle's release build, in the same RUN, over the directory the
//     image's release stage copies to /app/dist/;
//   - the database's files' (`--db-assets`): app.Dockerfile's db-assets stage runs it right after
//     packages/db/src/assets-cli.ts stages them, over the directory the release stage copies to
//     /app/db-assets/ (the one other copy release-allowlist.json lets it take). The marker rules
//     below read a bundle's markers, so they cannot see raw harness sources or a planted file; in
//     this mode every file must also be one of the database's files as packages/db/src/assets.ts
//     finds them: a .sql file in packages/<package>/bootstrap or packages/<package>/migrations, or
//     a .json file in packages/<package>/grants or packages/db/roles/grants, <package> a name of
//     lower-case letters, digits and dashes that starts with a letter (its PACKAGE_NAME). Any
//     other extension (raw .ts sources, a .js bundle), any other folder, and any path that contains
//     packages/testing (which assets.ts's rule would otherwise read as a package) is a finding,
//     and so is a directory outside those folders.
// Any finding exits non-zero, which fails that RUN and so the image's build. The harness guard
// (packages/server/src/build/harness-guard.ts) refuses the harness while the bundle is built; this
// reads what the build actually left for the image, so a build that ran without the guard (a
// changed script or config), or a staging command that copied more than the database's files,
// still cannot ship it. What runs the scan, where, and with what before it, is held by
// packages/server/test/image-build.ts, which reads the Dockerfiles: the scan cannot see that it
// was emptied or replaced.
//
// The marker rules, read in both modes, are the harness rules of CI's bundle check, which the CI
// lane holds and which returns with the tokenizer PR: in every file but a map, the
// `fin:test-seam` marker a seam module carries, a module comment naming a file of packages/testing
// (the harness bundled in), and an import of the harness's package left in (a static, side-effect
// or dynamic import, or a require call); in a source map, a `sources` entry under packages/testing
// (its sourcesContent, the original text with its comments, is not read). A module comment is the
// line the bundler writes before each module's code, the module's path alone: CI's bundle check
// reads `//#region <path>`, and this build's Vite writes `// <path>`, so both are read. A path
// through node_modules/@fin/testing, which the build writes only when it keeps symbolic links,
// counts as packages/testing. A map inlined as a base64 `data:` URL is read as a map. A link in
// the output is refused, since the image would copy the link and not what it names. This file is
// self-contained and uses Node built-ins only, so it runs in the build stage from the build
// context with no install (CI's bundle check returns only with the tokenizer PR, and imports the
// CI lane's helpers; assets.ts is not a control path, so its rule is written here again, and
// packages/db's tests hold the two equal). Usage, from the repository's root:
//   node ops/docker/harness-scan.mjs <output directory>
//   node ops/docker/harness-scan.mjs --db-assets <output directory>
// It exits 0 when the directory holds at least one file and nothing the rules refuse, 1 on any
// finding, and 2 on a usage error or when the directory is missing, not a directory or empty.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** A file of the harness, by its repository path or by its package's link. */
const HARNESS_PATH = /(?:^|[/\\])(?:packages[/\\]testing|node_modules[/\\]@fin[/\\]testing)[/\\]/;

/** The markers read in each file of the output but its maps, with what each one means. */
export const MARKERS = [
  { pattern: /fin:test-seam/, what: "a test seam's marker (fin:test-seam)" },
  {
    pattern:
      /^\/\/(?:#region)?[ \t]+\S*(?:packages\/testing|node_modules\/@fin\/testing)\/\S*[ \t]*\r?$/m,
    what: "a module of the test harness (packages/testing) is bundled",
  },
  {
    pattern:
      /(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@fin\/testing(?:\/[^"']*)?["']/,
    what: "the test harness's package (@fin/testing) is imported",
  },
];

// A source map inlined as a base64 `data:` URL in a `sourceMappingURL` comment.
const INLINE_MAP =
  /[#@]\s*sourceMappingURL=data:application\/json;(?:charset=[\w-]+;)?base64,([A-Za-z0-9+/]+={0,2})/g;

const MAX_FILES = 50_000;

/** The flag that runs the scan in the database's files' mode. */
export const DB_ASSETS = "--db-assets";

// packages/db/src/assets.ts's PACKAGE_NAME: the package directories its rule reads.
const PACKAGE_NAME = /^[a-z][a-z0-9-]*$/;

const HARNESS_IN_DB =
  "a path of the test harness (packages/testing), which only the test target may hold";
const OUTSIDE_FOLDERS =
  "a file outside the database's folders (packages/<package>/bootstrap, migrations or grants, and packages/db/roles/grants)";

/** @typedef {{ file: string, what: string }} Finding */

/**
 * The database's folders of the package `pkg`, each with the extension of its files, as
 * packages/db/src/assets.ts's assetDirectories and EXTENSION give them (an extension in any case).
 * @param {string} pkg
 * @returns {{ folder: string, extension: string }[]}
 */
function dbFolders(pkg) {
  const grants =
    pkg === "db" ? ["packages/db/grants", "packages/db/roles/grants"] : [`packages/${pkg}/grants`];
  return [
    { folder: `packages/${pkg}/bootstrap`, extension: ".sql" },
    { folder: `packages/${pkg}/migrations`, extension: ".sql" },
    ...grants.map((folder) => ({ folder, extension: ".json" })),
  ];
}

/**
 * Whether `path`, a path in the output with `/`, names the test harness: it contains
 * packages/testing, or it goes through the harness's package link.
 * @param {string} path
 */
const harnessPath = (path) => path.includes("packages/testing") || HARNESS_PATH.test(`${path}/`);

/**
 * Why the file `file` (its path in the output, with `/`) is not one of the database's files as
 * packages/db/src/assets.ts finds them, or undefined when it is one.
 * @param {string} file
 * @returns {string | undefined}
 */
export function dbAssetFinding(file) {
  if (harnessPath(file)) return HARNESS_IN_DB;
  const at = file.lastIndexOf("/");
  const name = file.slice(at + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot).toLowerCase();
  if (extension !== ".sql" && extension !== ".json") {
    const kind = extension === "" ? "a file with no extension" : `a ${extension} file`;
    return `${kind}, which is none of the database's files (.sql and .json files only)`;
  }
  const folder = at === -1 ? "" : file.slice(0, at);
  const pkg = /^packages\/([^/]+)\//.exec(file)?.[1];
  const known =
    pkg !== undefined && PACKAGE_NAME.test(pkg)
      ? dbFolders(pkg).find((each) => each.folder === folder)
      : undefined;
  if (known === undefined) return OUTSIDE_FOLDERS;
  if (known.extension !== extension) {
    return `a ${extension} file in ${folder}, which holds ${known.extension} files only`;
  }
  return undefined;
}

/**
 * Why the directory `dir` (its path in the output, with `/`) is not one the database's files lie
 * in or under, or undefined when it is one.
 * @param {string} dir
 * @returns {string | undefined}
 */
export function dbAssetDirectoryFinding(dir) {
  if (harnessPath(dir)) return HARNESS_IN_DB;
  if (dir === "packages") return undefined;
  const pkg = /^packages\/([^/]+)(?:\/|$)/.exec(dir)?.[1];
  const known =
    pkg !== undefined &&
    PACKAGE_NAME.test(pkg) &&
    (dir === `packages/${pkg}` ||
      dbFolders(pkg).some(({ folder }) => folder === dir || folder.startsWith(`${dir}/`)));
  return known ? undefined : "a directory outside the database's folders";
}

/**
 * The `sources` of the source map `text`, or null when it is not one.
 * @param {string} text
 * @returns {string[] | null}
 */
export function mapSources(text) {
  try {
    const map = JSON.parse(text);
    if (typeof map !== "object" || map === null || !Array.isArray(map.sources)) return null;
    return map.sources.filter((/** @type {unknown} */ source) => typeof source === "string");
  } catch {
    return null;
  }
}

/**
 * What the rules find in one file of the output, `name` its path in the output.
 * @param {string} name
 * @param {Buffer} bytes
 * @returns {string[]}
 */
export function scanFile(name, bytes) {
  /** @type {string[]} */
  const found = [];
  const readMap = (/** @type {string} */ text, /** @type {string} */ which) => {
    const sources = mapSources(text);
    if (sources === null) found.push(`${which} that is not a source map`);
    else if (sources.some((source) => HARNESS_PATH.test(source))) {
      found.push(`${which} names a file of the test harness (packages/testing) in its sources`);
    }
  };
  if (name.endsWith(".map")) {
    readMap(bytes.toString("utf8"), "a map");
    return found;
  }
  // Each byte as one character, so a marker is found whatever the file's encoding.
  const text = bytes.toString("latin1");
  for (const marker of MARKERS) {
    if (marker.pattern.test(text)) found.push(marker.what);
  }
  for (const match of text.matchAll(INLINE_MAP)) {
    readMap(Buffer.from(match[1] ?? "", "base64").toString("utf8"), "an inline map");
  }
  return found;
}

/**
 * Scans every file under `dir`: each finding names the file by its path in the output. A link is
 * a finding of its own and is never followed. With `dbAssets`, every file must also be one of the
 * database's files and every directory one they lie in or under (dbAssetFinding and
 * dbAssetDirectoryFinding).
 * @param {string} dir
 * @param {boolean} [dbAssets]
 * @returns {{ files: number, findings: Finding[] }}
 */
export function scanOutput(dir, dbAssets = false) {
  /** @type {Finding[]} */
  const findings = [];
  let files = 0;
  /** @param {string} at */
  const visit = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const file = relative(dir, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        findings.push({ file, what: "a link, which the image would copy as a link" });
      } else if (stat.isDirectory()) {
        const what = dbAssets ? dbAssetDirectoryFinding(file) : undefined;
        if (what !== undefined) findings.push({ file, what });
        visit(path);
      } else if (stat.isFile()) {
        files++;
        if (files > MAX_FILES) throw new Error(`more than ${MAX_FILES} files under ${dir}`);
        const what = dbAssets ? dbAssetFinding(file) : undefined;
        if (what !== undefined) findings.push({ file, what });
        for (const what of scanFile(file, readFileSync(path))) findings.push({ file, what });
      } else {
        findings.push({ file, what: "neither a file nor a directory" });
      }
    }
  };
  visit(dir);
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files, findings };
}

/**
 * Runs the scan over the directory `args` names, in the database's files' mode when `args` begins
 * with DB_ASSETS; returns the exit code and the lines to print.
 * @param {string[]} args
 * @returns {{ code: number, lines: string[] }}
 */
export function main(args) {
  const dbAssets = args[0] === DB_ASSETS;
  const [dir, ...rest] = dbAssets ? args.slice(1) : args;
  if (dir === undefined || rest.length > 0 || dir.startsWith("--")) {
    return {
      code: 2,
      lines: [`usage: node ops/docker/harness-scan.mjs [${DB_ASSETS}] <output directory>`],
    };
  }
  /** @type {import("node:fs").Stats} */
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return { code: 2, lines: [`harness-scan: ${dir} does not exist: the build left no output`] };
  }
  if (!stat.isDirectory()) {
    return { code: 2, lines: [`harness-scan: ${dir} is not a directory`] };
  }
  const { files, findings } = scanOutput(dir, dbAssets);
  if (findings.length > 0) {
    const holds = dbAssets
      ? "what the image copies as the database's files holds more than them, or the test harness"
      : "the release output holds the test harness";
    return {
      code: 1,
      lines: [
        ...findings.map((finding) => `harness-scan: ${dir}/${finding.file}: ${finding.what}`),
        `harness-scan: ${holds}, which only the test target ` +
          `may contain (ARCHITECTURE §3.5, SA-38): ${findings.length} finding(s)`,
      ],
    };
  }
  if (files === 0) return { code: 2, lines: [`harness-scan: ${dir} holds no file`] };
  const only = dbAssets ? ", the database's files only" : "";
  return { code: 0, lines: [`harness-scan: ${dir}: ${files} file(s)${only}, no harness marker`] };
}

if (import.meta.main) {
  const { code, lines } = main(process.argv.slice(2));
  const out = code === 0 ? process.stdout : process.stderr;
  out.write(`${lines.join("\n")}\n`);
  process.exitCode = code;
}
