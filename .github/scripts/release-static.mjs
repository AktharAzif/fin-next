#!/usr/bin/env node
// The static half of release.yml and its manifest (spec 01 §5.5, §7.4; ARCHITECTURE §11.7;
// EXECUTION EX-28; FW-C13; orchestrator decision BD-05). A control path. Subcommands, run in order
// by release.yml's static-build, static and manifest jobs, each reading what the one before wrote
// under release/:
//
//   build     (static-build, the only job that runs the dependencies' code, and holds no token,
//             OIDC permission or attestation right) builds every static app tools/layout.json
//             names (console, admin, verify with its two outputs verify and selfie, docs) whose
//             folder is on main, through Turborepo with --force (a release restores no cache);
//             stages each output in release/static/<key>/ and moves every source map out into
//             release/source-maps/<key>/; refuses a build no artefact may be (artefactProblems:
//             _headers or env.json, which the deploy renders, SF-05; a Worker control file; a
//             path the deploy refuses or would read two ways; an asset over 25 MiB), or a link
//   take      (static, from here on no dependency code runs) admits what the build job staged,
//             downloaded into release-staged/: static/, source-maps/ and meta/static-build.json
//             only, no link, copied into release/ before anything else is downloaded there
//   previous  finds the previous release: the newest earlier run of release.yml for a push to
//             main of this repository that succeeded and left a release-<sha> manifest artefact
//   merge     takes nothing the build job staged on trust (stagedKeys), then FW-C13: carries the
//             previous release's own hashed assets/ into each output (this release's files win),
//             checks that every one of them is present and that the output is still one the
//             deploy takes, and computes each output's asset manifest hash (tools/static-deploy's,
//             SP-26); sets the step outputs the uploads read
//   record    adds each uploaded artefact's SHA-256, writes the checksums file actions/attest
//             signs, and gives the static record's own SHA-256 as the step output record_sha256
//   manifest  writes release-manifest.json: the commit, each image's digest from exactly one
//             record per release image (readImageRecords), each static artefact's name, SHA-256
//             and asset manifest hash, the source-map artefact, every package's migrations by
//             migrate's own rule (readMigrations) and the minimum schema version, the newest of
//             them. Any job of a run can replace an artefact of that run, but only a job sets
//             its own outputs: each record is taken only when its SHA-256 equals the one the job
//             that wrote it gave as an output (RECORD_SHA256_<IMAGE>, RECORD_SHA256_STATIC)
//
// Only the previous release's *own* assets travel (the ones its build produced, which its
// manifest lists), so an artefact holds two releases' assets at most, never a growing pile. The
// same path rule (artefactPathProblem) admits a release's own assets and the previous release's
// list, and it is the deploy's own (ops/fin's zip reader), so no name one release accepts can break
// the release after it or its deploy.
// Node built-ins only. Every line it prints is `release.<what> key=value ...`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, posix, relative, sep } from "node:path";
import { addSummary, annotate, clean, isMain, isRecord, isSha, say, setOutput } from "./lib/ci.mjs";

export const RELEASE = "release";
/** The release images, one matrix entry each of release.yml's images job (release-image.sh). */
export const RELEASE_IMAGES = ["console", "admin", "verify", "edge", "api", "connector"];
const KEY = /^[a-z]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE = /^fin-next-[a-z0-9-]+$/;
/** The files the deploy renders into a copy of the build, which no build may hold (SF-05). */
export const RENDERED_FILES = new Set(["/_headers", "/env.json"]);
/**
 * File names no static artefact holds, at any depth and in any case: the two the deploy renders,
 * and the Worker control files tools/static-deploy refuses (an assets-only deployment runs no
 * Worker code).
 */
export const REFUSED_NAMES = new Set([
  "_headers",
  "env.json",
  "_worker.js",
  "_routes.json",
  "_redirects",
]);
/** tools/static-deploy's limits: Cloudflare's 25 MiB per asset, 20,000 files per artefact. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ARTEFACT_FILES = 20_000;
/** A migration's file name, in whichever package (DA-04; packages/db's MIGRATION_NAME). */
const MIGRATION = /^\d{14}_[a-z][a-z0-9-]*_[a-z0-9][a-z0-9_]*\.sql$/;
/** A package folder whose files migrate reads (packages/db/src/assets.ts's PACKAGE_NAME). */
const PACKAGE = /^[a-z][a-z0-9-]*$/;
/**
 * The characters a path segment of an artefact may hold: exactly ops/fin's zip reader's SEGMENT
 * (ops/fin/src/static/zip.ts), which `fin static render` applies to every entry of the archive.
 */
const SEGMENT = /^[A-Za-z0-9._@~+=,-]+$/;

/**
 * Why a path may not name a file of a static artefact, or null. It is a URL path that the deploy
 * takes and that the deploy, Cloudflare and a browser all read one way: absolute, at most 1,024
 * characters, with no empty, `.` or `..` segment, and every segment made only of ASCII letters,
 * digits and `. _ @ ~ + = , -` (SEGMENT, the deploy's own rule). So no backslash, no `%` (read
 * again as an escape), no `?` or `#` (they end a URL's path), no control or format character, and
 * no space, bracket, `!`, `'`, `&` or letter beyond ASCII either: a bundler keeps those in an
 * asset's name (`logo (1)-Bq3x.svg`), but `fin static render` refuses the archive that holds one,
 * so the release refuses the build here rather than carry an asset no later release could deploy
 * (FW-C13). Rename the source file instead.
 * @param {unknown} path
 * @returns {string | null}
 */
export function artefactPathProblem(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return "is not an absolute URL path";
  if (path.length > 1024) return "is longer than 1,024 characters";
  const segments = path.slice(1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return "has an empty, . or .. segment";
  }
  if (!segments.every((s) => SEGMENT.test(s))) {
    return "holds a character the deploy refuses (it takes A-Z a-z 0-9 . _ @ ~ + = , - only)";
  }
  return null;
}

/**
 * Whether a file name is a source map, in any case.
 * @param {string} path
 */
export function isSourceMap(path) {
  return path.toLowerCase().endsWith(".map");
}

/**
 * @typedef {{ app: string, name: string, key: string, dir: string, mapsDir: string }} StaticOutput
 * @typedef {{ path: string, abs: string }} FileEntry
 */

// ---- the layout ---------------------------------------------------------------------------

/**
 * The static outputs tools/layout.json names: one per `static` key of each app entry. An app
 * with one output builds to dist/static/, an app with several to dist/static/<key>/; maps go to
 * the matching dist/source-maps/ folder (the apps' Vite configs, EX-28).
 * @param {unknown} layout
 * @returns {StaticOutput[]}
 */
export function staticOutputs(layout) {
  if (!isRecord(layout) || !Array.isArray(layout.entries)) {
    throw new Error("tools/layout.json has no entries");
  }
  /** @type {StaticOutput[]} */
  const outputs = [];
  for (const entry of layout.entries) {
    if (!isRecord(entry) || entry.kind !== "app" || entry.static === undefined) continue;
    const path = String(entry.path ?? "");
    const name = String(entry.name ?? "");
    if (!/^apps\/[a-z][a-z0-9-]*$/.test(path) || !/^@fin\/[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(`a static app entry has a bad path or name: ${clean(path)}`);
    }
    const keys = Array.isArray(entry.static) ? entry.static : [entry.static];
    for (const key of keys) {
      if (typeof key !== "string" || !KEY.test(key)) {
        throw new Error(`${path}: a static output key is not lower-case letters`);
      }
      const several = keys.length > 1;
      outputs.push({
        app: path.slice("apps/".length),
        name,
        key,
        dir: several ? `dist/static/${key}` : "dist/static",
        mapsDir: several ? `dist/source-maps/${key}` : "dist/source-maps",
      });
    }
  }
  return outputs;
}

// ---- files and hashes ---------------------------------------------------------------------

/**
 * Every regular file under a directory, as URL paths (`/index.html`). A link or any other kind
 * of entry is refused: an artefact holds files only.
 * @param {string} dir
 * @returns {FileEntry[]}
 */
export function walkFiles(dir) {
  /** @type {FileEntry[]} */
  const out = [];
  /** @param {string} current */
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const abs = join(current, entry.name);
      const stat = lstatSync(abs);
      const path = `/${relative(dir, abs).split(sep).join(posix.sep)}`;
      if (stat.isSymbolicLink()) throw new Error(`${path} is a link; a build holds files only`);
      if (stat.isDirectory()) visit(abs);
      else if (stat.isFile()) out.push({ path, abs });
      else throw new Error(`${path} is not a regular file`);
    }
  };
  if (existsSync(dir)) visit(dir);
  return out;
}

/**
 * SP-26's per-file hash, as tools/static-deploy computes it: the first 32 hex characters of
 * SHA-256 over the file's base64 text followed by its extension.
 * @param {Buffer} content
 * @param {string} path
 */
export function assetHash(content, path) {
  return createHash("sha256")
    .update(content.toString("base64") + extname(path).slice(1))
    .digest("hex")
    .slice(0, 32);
}

/**
 * The asset manifest hash the release manifest records and the deploy compares (tools/static-
 * deploy's assetManifestHash): SHA-256 over the sorted `<path> <hash> <size>` lines of the built
 * files, the rendered _headers and env.json left out.
 * @param {string} dir
 */
export function assetManifestHash(dir) {
  const lines = walkFiles(dir)
    .filter((f) => !RENDERED_FILES.has(f.path))
    .map((f) => {
      const content = readFileSync(f.abs);
      return `${f.path} ${assetHash(content, f.path)} ${content.length}`;
    })
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * @param {Buffer} content
 * @returns {string} its SHA-256 in hex
 */
function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * @param {string} file
 * @param {string} text
 */
function writeFile(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * What keeps a set of files from being a static artefact the deploy takes (tools/static-deploy's
 * artefact.ts, and SF-05): a file no artefact holds (REFUSED_NAMES), a path artefactPathProblem
 * refuses, a source map (unless `maps`, while a build's maps still sit beside it), a file over the
 * size limit, or more files than a deployment takes. Each problem names its file, never its
 * content.
 * @param {FileEntry[]} files
 * @param {{ maps: boolean }} options
 * @returns {string[]}
 */
export function artefactProblems(files, { maps }) {
  /** @type {string[]} */
  const problems = [];
  const served = files.filter((f) => !isSourceMap(f.path));
  if (served.length > MAX_ARTEFACT_FILES) {
    problems.push(`${served.length} files, more than the ${MAX_ARTEFACT_FILES} a deployment takes`);
  }
  for (const f of files) {
    const name = (f.path.split("/").pop() ?? "").toLowerCase();
    if (RENDERED_FILES.has(`/${name}`)) {
      problems.push(`${clean(f.path)}: the deploy renders it, never the build (SF-05)`);
    } else if (REFUSED_NAMES.has(name)) {
      problems.push(`${clean(f.path)}: an assets-only deployment holds no Worker control file`);
    }
    const pathProblem = artefactPathProblem(f.path);
    if (pathProblem !== null) problems.push(`${clean(f.path)}: the path ${pathProblem}`);
    if (!maps && isSourceMap(f.path)) {
      problems.push(`${clean(f.path)}: a source map never reaches a deployment`);
    }
    if (lstatSync(f.abs).size > MAX_FILE_BYTES) {
      problems.push(`${clean(f.path)}: over the 25 MiB asset limit`);
    }
  }
  return problems;
}

// ---- build --------------------------------------------------------------------------------

/**
 * Copies one built output into the release folder, moving source maps aside. The build is
 * refused first when it is not an artefact the deploy would take (artefactProblems).
 * @param {{ from: string, mapsFrom: string, to: string, mapsTo: string }} paths
 * @returns {{ files: number, maps: number }}
 */
export function stageOutput({ from, mapsFrom, to, mapsTo }) {
  const files = walkFiles(from);
  if (!files.some((f) => f.path === "/index.html")) throw new Error("the build has no index.html");
  const problems = artefactProblems(files, { maps: true });
  if (problems.length > 0) throw new Error(`the build is refused: ${problems.join("; ")}`);
  rmSync(to, { recursive: true, force: true });
  let maps = 0;
  for (const f of files) {
    const target = isSourceMap(f.path) ? join(mapsTo, f.path) : join(to, f.path);
    if (isSourceMap(f.path)) maps++;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(f.abs, target);
  }
  for (const f of walkFiles(mapsFrom)) {
    const target = join(mapsTo, f.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(f.abs, target);
    maps++;
  }
  return { files: files.filter((f) => !isSourceMap(f.path)).length, maps };
}

/**
 * @param {{ root: string, env: NodeJS.ProcessEnv, runBuild?: (names: string[]) => void }} ctx
 */
export function build(ctx) {
  const { root } = ctx;
  const outputs = staticOutputs(readJson(join(root, "tools", "layout.json")));
  /** @type {Map<string, { name: string, buildable: boolean, why: string }>} */
  const apps = new Map();
  for (const o of outputs) {
    if (apps.has(o.app)) continue;
    const manifestFile = join(root, "apps", o.app, "package.json");
    let buildable = false;
    let why = `apps/${o.app} is not on main yet`;
    if (existsSync(manifestFile)) {
      const manifest = readJson(manifestFile);
      buildable = isRecord(manifest) && isRecord(manifest.scripts) && "build" in manifest.scripts;
      why = buildable ? "" : `apps/${o.app} has no build script`;
    }
    apps.set(o.app, { name: o.name, buildable, why });
  }
  const names = [...apps.values()].filter((a) => a.buildable).map((a) => a.name);
  if (names.length > 0) {
    const runBuild =
      ctx.runBuild ??
      ((/** @type {string[]} */ list) =>
        execFileSync(
          "pnpm",
          ["exec", "turbo", "run", "build", "--force", ...list.map((n) => `--filter=${n}`)],
          { cwd: root, stdio: "inherit", env: { ...ctx.env, TURBO_TELEMETRY_DISABLED: "1" } },
        ));
    runBuild(names);
  }
  /** @type {Record<string, { app: string, files: number, maps: number }>} */
  const built = {};
  /** @type {{ key: string, why: string }[]} */
  const skipped = [];
  let maps = 0;
  for (const o of outputs) {
    const app = apps.get(o.app);
    if (app === undefined || !app.buildable) {
      skipped.push({ key: o.key, why: app?.why ?? "unknown app" });
      annotate("notice", `static ${o.key}`, `${app?.why ?? "unknown app"}; skipped`);
      setOutput(o.key, "false", ctx.env);
      continue;
    }
    const staged = stageOutput({
      from: join(root, "apps", o.app, o.dir),
      mapsFrom: join(root, "apps", o.app, o.mapsDir),
      to: join(root, RELEASE, "static", o.key),
      mapsTo: join(root, RELEASE, "source-maps", o.key),
    });
    maps += staged.maps;
    built[o.key] = { app: o.app, ...staged };
    setOutput(o.key, "true", ctx.env);
    say(`release.static.build key=${o.key} app=${o.app} files=${staged.files} maps=${staged.maps}`);
  }
  setOutput("maps", maps > 0 ? "true" : "false", ctx.env);
  writeFile(join(root, RELEASE, "meta", "static-build.json"), JSON.stringify({ built, skipped }));
  return { built, skipped, maps };
}

// ---- previous -----------------------------------------------------------------------------

/**
 * @typedef {(path: string) => Promise<unknown>} ApiRequest
 */

/**
 * The previous release: the newest run of release.yml, other than this one and for another
 * commit, started by a push to main of this repository, that completed successfully and still
 * holds its release-<sha> manifest artefact (a run without one did not finish, and is no release).
 * @param {{ repo: string, runId: string, sha: string, request: ApiRequest, maxRuns?: number }} input
 * @returns {Promise<{ runId: string, sha: string } | null>}
 */
export async function findPreviousRelease({ repo, runId, sha, request, maxRuns = 50 }) {
  const runs = await request(
    `/repos/${repo}/actions/workflows/release.yml/runs?branch=main&event=push&per_page=${maxRuns}`,
  );
  const list = isRecord(runs) && Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [];
  for (const run of list) {
    if (!isRecord(run)) continue;
    const id = String(run.id ?? "");
    const head = String(run.head_sha ?? "");
    const sameRepo =
      isRecord(run.repository) &&
      isRecord(run.head_repository) &&
      run.repository.full_name === repo &&
      run.head_repository.full_name === repo;
    if (
      id === runId ||
      !/^\d+$/.test(id) ||
      !isSha(head) ||
      head === sha ||
      run.event !== "push" ||
      run.head_branch !== "main" ||
      // A release is a run that finished: one that failed after leaving its manifest (before
      // its attestation, say) is none.
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      !/^\.github\/workflows\/release\.yml(?:@.*)?$/.test(String(run.path ?? "")) ||
      !sameRepo
    ) {
      continue;
    }
    const artifacts = await request(
      `/repos/${repo}/actions/runs/${id}/artifacts?name=release-${head}&per_page=10`,
    );
    const found =
      isRecord(artifacts) &&
      Array.isArray(artifacts.artifacts) &&
      artifacts.artifacts.some(
        (a) => isRecord(a) && a.name === `release-${head}` && a.expired === false,
      );
    if (found) return { runId: id, sha: head };
  }
  return null;
}

/**
 * The REST client `previous` uses: GET only, the job's read token, GitHub's API host.
 * @param {NodeJS.ProcessEnv} env
 * @returns {ApiRequest}
 */
function githubRequest(env) {
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const token = env.GH_TOKEN ?? "";
  if (token === "") throw new Error("GH_TOKEN is not set");
  return async (path) => {
    const response = await fetch(`${api}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for a run listing`);
    return response.json();
  };
}

// ---- merge (FW-C13) -----------------------------------------------------------------------

/**
 * The previous release's own assets for one output: the list its manifest recorded, or, for a
 * release before manifests listed them, every file under its assets/.
 * @param {unknown} manifest
 * @param {string} key
 * @param {string} previousDir
 * @returns {string[]}
 */
export function previousOwnAssets(manifest, key, previousDir) {
  const entry =
    isRecord(manifest) && isRecord(manifest.static) && isRecord(manifest.static[key])
      ? manifest.static[key]
      : null;
  const listed = entry !== null && Array.isArray(entry.ownAssets) ? entry.ownAssets : null;
  const paths =
    listed ??
    walkFiles(join(previousDir, "assets")).map((f) => posix.join("/assets", f.path.slice(1)));
  for (const path of paths) {
    // The same rule this release's own paths passed (merge), so no name a release accepted
    // breaks the one after it: a path that could leave assets/ or that the deploy refuses is
    // refused.
    if (
      typeof path !== "string" ||
      !path.startsWith("/assets/") ||
      artefactPathProblem(path) !== null
    ) {
      throw new Error(`the previous release names an asset path that is refused: ${clean(path)}`);
    }
  }
  return /** @type {string[]} */ (paths);
}

/**
 * Carries the previous release's own assets into one staged output and checks they are there.
 * @param {{ dir: string, previousDir: string | null, previousAssets: string[] }} input
 * @returns {{ own: string[], carried: string[], kept: string[] }}
 */
export function carryAssets({ dir, previousDir, previousAssets }) {
  const own = walkFiles(join(dir, "assets")).map((f) => posix.join("/assets", f.path.slice(1)));
  /** @type {string[]} */
  const carried = [];
  /** @type {string[]} */
  const kept = [];
  if (previousDir !== null) {
    walkFiles(previousDir); // refuses a link anywhere in the previous artefact
    for (const path of previousAssets) {
      const from = join(previousDir, path);
      const to = join(dir, path);
      if (!existsSync(from)) throw new Error(`the previous artefact lacks its own asset ${path}`);
      if (existsSync(to)) {
        if (!readFileSync(from).equals(readFileSync(to))) kept.push(path);
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      carried.push(path);
    }
    // FW-C13's test: every asset of the previous release is served by this one.
    const missing = previousAssets.filter((path) => !existsSync(join(dir, path)));
    if (missing.length > 0) {
      throw new Error(`FW-C13: ${missing.length} previous asset(s) missing after the merge`);
    }
  }
  return { own: own.sort(), carried: carried.sort(), kept: kept.sort() };
}

/** Where the static job downloads what the build job staged, before `take` admits it. */
export const STAGED = "release-staged";

/**
 * Takes what the build job staged (downloaded into <root>/release-staged) into <root>/release:
 * only static/, source-maps/ and meta/static-build.json, with no link anywhere, and before any
 * previous release is downloaded, so a build can stage nothing that passes for the previous
 * release's files. The build job ran the dependencies' code, so nothing it staged is trusted.
 * @param {{ root: string }} ctx
 */
export function take({ root }) {
  const from = join(root, STAGED);
  const to = join(root, RELEASE);
  if (existsSync(to)) throw new Error("release/ exists already; take runs first");
  const names = existsSync(from) ? readdirSync(from).sort() : [];
  for (const name of names) {
    if (name !== "static" && name !== "source-maps" && name !== "meta") {
      throw new Error(`the staged outputs hold ${clean(name)}, which no stage writes`);
    }
  }
  const files = walkFiles(from); // refuses a link or another kind of entry anywhere
  const meta = files.filter((f) => f.path.startsWith("/meta/")).map((f) => f.path);
  if (meta.join(",") !== "/meta/static-build.json") {
    throw new Error("the staged outputs' meta/ holds other than static-build.json");
  }
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  say(`release.static.take files=${files.length}`);
  return files.length;
}

/**
 * The staged outputs merge takes from the build job, each refused unless it is an artefact the
 * deploy would take: the keys static-build.json says were built, which are exactly the folders
 * under release/static/, each with its index.html and no file artefactProblems refuses. The
 * build job ran the dependencies' code, so nothing it staged is taken on trust.
 * @param {string} root
 * @param {unknown} meta static-build.json
 * @returns {string[]} the built keys
 */
export function stagedKeys(root, meta) {
  const built = isRecord(meta) && isRecord(meta.built) ? Object.keys(meta.built) : [];
  const dir = join(root, RELEASE, "static");
  const folders = existsSync(dir) ? readdirSync(dir).sort() : [];
  if ([...built].sort().join(",") !== folders.join(",")) {
    throw new Error("the staged outputs are not the ones static-build.json says were built");
  }
  for (const key of built) {
    if (!KEY.test(key)) throw new Error("a staged output key is not lower-case letters");
    const files = walkFiles(join(dir, key));
    if (!files.some((f) => f.path === "/index.html")) {
      throw new Error(`the staged ${key} output has no index.html`);
    }
    const problems = artefactProblems(files, { maps: false });
    if (problems.length > 0)
      throw new Error(`the staged ${key} output is refused: ${problems.join("; ")}`);
  }
  walkFiles(join(root, RELEASE, "source-maps")); // refuses a link among the maps
  return built;
}

/**
 * @param {{ root: string, env: NodeJS.ProcessEnv }} ctx
 */
export function merge(ctx) {
  const { root, env } = ctx;
  const meta = readJson(join(root, RELEASE, "meta", "static-build.json"));
  const built = stagedKeys(root, meta);
  const previousSha = isSha(env.PREVIOUS_SHA) ? env.PREVIOUS_SHA : null;
  const manifestFile = join(root, RELEASE, "previous", "manifest", "release-manifest.json");
  const previousManifest =
    previousSha !== null && existsSync(manifestFile) ? readJson(manifestFile) : null;
  /** @type {Record<string, unknown>} */
  const keys = {};
  for (const key of built) {
    const dir = join(root, RELEASE, "static", key);
    const candidate =
      previousSha === null
        ? null
        : join(root, RELEASE, "previous", "static", `static-${key}-${previousSha}`);
    const previousDir = candidate !== null && existsSync(candidate) ? candidate : null;
    if (previousSha !== null && previousDir === null) {
      annotate("notice", `static ${key}`, "the previous release has no artefact for this output");
    }
    const previousAssets =
      previousDir === null ? [] : previousOwnAssets(previousManifest, key, previousDir);
    const carry = carryAssets({ dir, previousDir, previousAssets });
    for (const path of carry.kept) {
      annotate(
        "warning",
        `static ${key}`,
        `${clean(path)} differs from the previous release's; kept this one`,
      );
    }
    // With the previous release's assets in, the output is still one the deploy takes.
    const merged = walkFiles(dir);
    const problems = artefactProblems(merged, { maps: false });
    if (problems.length > 0) {
      throw new Error(`the merged ${key} output is refused: ${problems.join("; ")}`);
    }
    const hash = assetManifestHash(dir);
    keys[key] = {
      files: merged.length,
      ownAssets: carry.own,
      carried: carry.carried,
      carriedFrom: previousDir === null ? null : previousSha,
      assetManifestHash: hash,
    };
    setOutput(key, "true", env);
    say(
      `release.static.merge key=${key} files=${merged.length} own=${carry.own.length} carried=${carry.carried.length} from=${previousDir === null ? "none" : previousSha}`,
    );
  }
  // The build job's list of skipped outputs, rebuilt from its keys and printable reasons only:
  // it ends up in the attested manifest.
  /** @type {{ key: string, why: string }[]} */
  const skipped = [];
  for (const s of isRecord(meta) && Array.isArray(meta.skipped) ? meta.skipped : []) {
    if (!isRecord(s) || typeof s.key !== "string" || !KEY.test(s.key) || built.includes(s.key)) {
      throw new Error("static-build.json lists a skipped output that is not one");
    }
    skipped.push({ key: s.key, why: clean(typeof s.why === "string" ? s.why : "skipped", 200) });
    setOutput(s.key, "false", env);
  }
  const maps = walkFiles(join(root, RELEASE, "source-maps")).length;
  setOutput("maps", maps > 0 ? "true" : "false", env);
  writeFile(join(root, RELEASE, "meta", "static-merged.json"), JSON.stringify({ keys, skipped }));
  return keys;
}

// ---- record -------------------------------------------------------------------------------

/**
 * An upload's digest as upload-artifact gives it (hex, or `sha256:<hex>`), as hex.
 * @param {string | undefined} value
 * @returns {string | null}
 */
export function digestHex(value) {
  const hex = (value ?? "").trim().replace(/^sha256:/, "");
  return HEX64.test(hex) ? hex : null;
}

/**
 * @param {{ root: string, env: NodeJS.ProcessEnv }} ctx
 */
export function record(ctx) {
  const { root, env } = ctx;
  const sha = env.GITHUB_SHA ?? "";
  if (!isSha(sha)) throw new Error("GITHUB_SHA is not a commit SHA");
  const merged = readJson(join(root, RELEASE, "meta", "static-merged.json"));
  const keys = isRecord(merged) && isRecord(merged.keys) ? merged.keys : {};
  /** @type {Record<string, unknown>} */
  const statics = {};
  /** @type {string[]} */
  const checksums = [];
  for (const [key, value] of Object.entries(keys)) {
    const digest = digestHex(env[`DIGEST_${key.toUpperCase()}`]);
    if (digest === null) throw new Error(`no artefact digest for ${key}: was it uploaded?`);
    const artefact = `static-${key}-${sha}`;
    statics[key] = { artefact, sha256: digest, ...(isRecord(value) ? value : {}) };
    checksums.push(`${digest}  ${artefact}`);
  }
  /** @type {{ artefact: string, sha256: string } | null} */
  let sourceMaps = null;
  if ((env.MAPS ?? "") === "true") {
    const digest = digestHex(env.DIGEST_SOURCE_MAPS);
    if (digest === null) throw new Error("no artefact digest for the source maps");
    sourceMaps = { artefact: `source-maps-${sha}`, sha256: digest };
    checksums.push(`${digest}  ${sourceMaps.artefact}`);
  }
  const skipped = isRecord(merged) && Array.isArray(merged.skipped) ? merged.skipped : [];
  const staticRecord = JSON.stringify({ static: statics, sourceMaps, skipped });
  writeFile(join(root, RELEASE, "meta", "static.json"), staticRecord);
  writeFile(join(root, RELEASE, "meta", "static-checksums.txt"), `${checksums.join("\n")}\n`);
  setOutput("attest", checksums.length > 0 ? "true" : "false", env);
  // The manifest job takes the record only with this SHA-256, a job output no other job can set.
  setOutput("record_sha256", sha256Hex(Buffer.from(staticRecord)), env);
  for (const line of checksums) say(`release.static.record ${line.replace("  ", " artefact=")}`);
  return { static: statics, sourceMaps };
}

// ---- manifest -----------------------------------------------------------------------------

/**
 * The images the images job built, from the records the manifest job downloaded: one folder per
 * record artefact, `image-record-<image>-<sha>/fin-next-<image>.json` (download-artifact's layout
 * without merge-multiple), exactly one for each of RELEASE_IMAGES and nothing else, each record
 * the very bytes the images job wrote (its SHA-256 is that job's output, which no other job can
 * set, while any job of the run can replace an artefact), naming its own image, and a built
 * image's reference this repository's own GHCR package, `ghcr.io/<owner>/fin-next-<image>`.
 * These digests are what the attested manifest names, so a missing, extra, second or replaced
 * record, or a reference elsewhere, refuses the release.
 * @param {string} dir
 * @param {{ sha: string, owner: string, hashes: Record<string, string | undefined> }} run this
 *   run's commit, the repository's owner, and each image's record SHA-256 from the images job
 */
export function readImageRecords(dir, { sha, owner, hashes }) {
  if (!isSha(sha)) throw new Error("GITHUB_SHA is not a commit SHA");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    throw new Error("GITHUB_REPOSITORY_OWNER is not an account name");
  }
  /** @type {Record<string, string>} */
  const images = {};
  /** @type {Record<string, string>} */
  const refs = {};
  /** @type {{ image: string, why: string }[]} */
  const skipped = [];
  const expected = RELEASE_IMAGES.map((image) => `image-record-${image}-${sha}`).sort();
  const folders = existsSync(dir) ? readdirSync(dir).sort() : [];
  if (folders.join("\n") !== expected.join("\n")) {
    throw new Error(
      `the image records are not exactly one artefact per release image (${RELEASE_IMAGES.join(", ")})`,
    );
  }
  const namespace = `ghcr.io/${owner.toLowerCase()}/`;
  for (const image of RELEASE_IMAGES) {
    const name = `fin-next-${image}`;
    const files = walkFiles(join(dir, `image-record-${image}-${sha}`));
    const only = files[0];
    if (files.length !== 1 || only === undefined || only.path !== `/${name}.json`) {
      throw new Error(`the record artefact of ${name} holds other than ${name}.json`);
    }
    const expected = hashes[image];
    if (typeof expected !== "string" || !HEX64.test(expected)) {
      throw new Error(`no SHA-256 of ${name}'s record from the images job`);
    }
    const bytes = readFileSync(only.abs);
    if (sha256Hex(bytes) !== expected) {
      throw new Error(`${name}: the record is not the one the images job wrote`);
    }
    const rec = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(rec) || rec.image !== name || !IMAGE.test(name)) {
      throw new Error(`${name}.json is not ${name}'s record`);
    }
    if (rec.built === true) {
      if (typeof rec.digest !== "string" || !DIGEST.test(rec.digest)) {
        throw new Error(`${name}: the record's digest is not sha256:<hex>`);
      }
      if (rec.ref !== `${namespace}${name}`) {
        throw new Error(`${name}: the record's reference is not ${namespace}${name}`);
      }
      images[name] = rec.digest;
      refs[name] = `${rec.ref}@${rec.digest}`;
    } else if (rec.built === false) {
      skipped.push({ image: name, why: clean(rec.why ?? "not built", 200) });
    } else {
      throw new Error(`${name}: the record says neither built nor skipped`);
    }
  }
  return { images, refs, skipped };
}

/**
 * The migrations the release's migrate applies, in the order it applies them, and the newest as
 * the minimum schema version (ARCHITECTURE §6.4). Found by the runner's own rule (packages/db/src/
 * assets.ts, discoverDbAssets and listMigrations): every `.sql` file, in any case, of
 * packages/<package>/migrations for each package folder with a lower-case name, in one name order
 * across the packages. This job attests the manifest, so it runs only control-path code and reads
 * the files itself rather than running packages/db's `assets-cli.ts migrations`; a test compares
 * the two on this repository. So that the manifest never lists other than migrate applies, a
 * `.sql` file whose name is not a migration's, a name two packages hold, a timestamp two files
 * share, or a link refuses the release, as each would refuse migrate. A tree with no packages
 * (before the data layer is on main) has none.
 * @param {string} root
 * @returns {{ migrations: string[], minimumSchemaVersion: string | null }}
 */
export function readMigrations(root) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return { migrations: [], minimumSchemaVersion: null };
  /** @param {string} abs @param {string} shown */
  const plainFolder = (abs, shown) => {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${shown} is not a plain folder`);
    }
  };
  plainFolder(packagesDir, "packages");
  /** @type {Map<string, string>} each migration to the folder that holds it */
  const found = new Map();
  const packages = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PACKAGE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const pkg of packages) {
    const folder = `packages/${pkg}/migrations`;
    const dir = join(packagesDir, pkg, "migrations");
    if (!existsSync(dir)) continue;
    plainFolder(dir, folder);
    for (const name of readdirSync(dir).sort()) {
      if (!/\.sql$/i.test(name)) continue;
      const shown = `${folder}/${clean(name, 120)}`;
      if (!lstatSync(join(dir, name)).isFile()) throw new Error(`${shown} is not a plain file`);
      if (!MIGRATION.test(name)) {
        throw new Error(`${shown} is not named <YYYYMMDDHHMMSS>_<area>_<what>.sql`);
      }
      const other = found.get(name);
      if (other !== undefined) throw new Error(`${name} is in both ${other} and ${folder}`);
      found.set(name, folder);
    }
  }
  const migrations = [...found.keys()].sort();
  for (let i = 1; i < migrations.length; i++) {
    const [before, name] = [migrations[i - 1] ?? "", migrations[i] ?? ""];
    if (before.slice(0, 14) === name.slice(0, 14)) {
      throw new Error(`${name} shares its timestamp with ${before}`);
    }
  }
  return { migrations, minimumSchemaVersion: migrations.at(-1) ?? null };
}

/**
 * The checks tools/static-deploy's parser applies to a manifest (release.ts), run before upload
 * so a malformed manifest fails the release, not the deploy.
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
export function manifestProblems(manifest) {
  /** @type {string[]} */
  const problems = [];
  if (!isSha(manifest.commit)) problems.push("commit is not a SHA");
  const images = isRecord(manifest.images) ? manifest.images : null;
  if (images === null) problems.push("images is not an object");
  for (const [name, digest] of Object.entries(images ?? {})) {
    if (!IMAGE.test(name)) problems.push(`images.${name} is not a Fin image`);
    if (typeof digest !== "string" || !DIGEST.test(digest)) problems.push(`images.${name}`);
  }
  const statics = isRecord(manifest.static) ? manifest.static : null;
  if (statics === null) problems.push("static is not an object");
  for (const [key, entry] of Object.entries(statics ?? {})) {
    if (!isRecord(entry)) {
      problems.push(`static.${key} is not an object`);
      continue;
    }
    if (
      typeof entry.artefact !== "string" ||
      !/^static-[a-z]+-[0-9a-f]{40}$/.test(entry.artefact)
    ) {
      problems.push(`static.${key}.artefact`);
    }
    if (typeof entry.sha256 !== "string" || !HEX64.test(entry.sha256)) {
      problems.push(`static.${key}.sha256`);
    }
    if (typeof entry.assetManifestHash !== "string" || !HEX64.test(entry.assetManifestHash)) {
      problems.push(`static.${key}.assetManifestHash`);
    }
  }
  if (
    !Array.isArray(manifest.migrations) ||
    manifest.migrations.some((m) => typeof m !== "string")
  ) {
    problems.push("migrations is not a list of names");
  }
  // imageRefs (ours, not the deploy parser's): each image's reference is its own GHCR package at
  // the digest `images` names, and no reference stands without its image.
  if (manifest.imageRefs !== undefined) {
    const refs = isRecord(manifest.imageRefs) ? manifest.imageRefs : null;
    if (refs === null) problems.push("imageRefs is not an object");
    const names = new Set([...Object.keys(images ?? {}), ...Object.keys(refs ?? {})]);
    for (const name of names) {
      const ref = refs?.[name];
      const digest = images?.[name];
      if (
        typeof ref !== "string" ||
        typeof digest !== "string" ||
        !/^ghcr\.io\/[a-z0-9-]+\/fin-next-[a-z0-9-]+@sha256:[0-9a-f]{64}$/.test(ref) ||
        !ref.endsWith(`/${name}@${digest}`)
      ) {
        problems.push(`imageRefs.${name}`);
      }
    }
  }
  return problems;
}

/**
 * @param {{ root: string, env: NodeJS.ProcessEnv, now?: () => Date }} ctx
 */
export function writeManifest(ctx) {
  const { root, env } = ctx;
  const sha = env.GITHUB_SHA ?? "";
  if (!isSha(sha)) throw new Error("GITHUB_SHA is not a commit SHA");
  const images = readImageRecords(join(root, RELEASE, "images"), {
    sha,
    owner: env.GITHUB_REPOSITORY_OWNER ?? "",
    hashes: Object.fromEntries(
      RELEASE_IMAGES.map((image) => [image, env[`RECORD_SHA256_${image.toUpperCase()}`]]),
    ),
  });
  // The static record, only as the static job wrote it (its SHA-256 is that job's output).
  const staticFile = join(root, RELEASE, "meta", "static.json");
  const staticBytes = existsSync(staticFile) ? readFileSync(staticFile) : null;
  const staticHash = env.RECORD_SHA256_STATIC ?? "";
  if (staticBytes === null || !HEX64.test(staticHash) || sha256Hex(staticBytes) !== staticHash) {
    throw new Error("the static record is not the one the static job wrote");
  }
  const staticMeta = JSON.parse(staticBytes.toString("utf8"));
  const { migrations, minimumSchemaVersion } = readMigrations(root);
  const manifest = {
    v: 1,
    commit: sha,
    createdAt: (ctx.now ?? (() => new Date()))().toISOString(),
    run: {
      id: /^\d+$/.test(env.GITHUB_RUN_ID ?? "") ? Number(env.GITHUB_RUN_ID) : null,
      attempt: /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ? Number(env.GITHUB_RUN_ATTEMPT) : null,
      workflow: ".github/workflows/release.yml",
    },
    images: images.images,
    imageRefs: images.refs,
    static: isRecord(staticMeta) && isRecord(staticMeta.static) ? staticMeta.static : {},
    sourceMaps:
      isRecord(staticMeta) && isRecord(staticMeta.sourceMaps) ? staticMeta.sourceMaps : null,
    migrations,
    minimumSchemaVersion,
    skipped: {
      images: images.skipped,
      static: isRecord(staticMeta) && Array.isArray(staticMeta.skipped) ? staticMeta.skipped : [],
    },
  };
  const problems = manifestProblems(manifest);
  if (problems.length > 0) throw new Error(`the manifest is malformed: ${problems.join("; ")}`);
  const file = join(root, RELEASE, "out", "release-manifest.json");
  writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  const imageCount = Object.keys(manifest.images).length;
  const staticCount = Object.keys(manifest.static).length;
  say(
    `release.manifest commit=${sha} images=${imageCount} static=${staticCount} migrations=${migrations.length} minimumSchemaVersion=${minimumSchemaVersion ?? "none"}`,
  );
  addSummary(
    [
      `### Release ${sha.slice(0, 12)}`,
      "",
      "| Kind | Name | Digest or SHA-256 |",
      "|---|---|---|",
      ...Object.entries(manifest.images).map(([n, d]) => `| image | ${n} | \`${d}\` |`),
      ...Object.entries(manifest.static).map(
        ([k, e]) => `| static | ${k} | \`${isRecord(e) ? String(e.sha256) : ""}\` |`,
      ),
      "",
      `Migrations: ${migrations.length}, minimum schema version ${minimumSchemaVersion === null ? "none" : `\`${minimumSchemaVersion}\``}.`,
      "",
      `Skipped: ${[...manifest.skipped.images.map((s) => s.image), ...manifest.skipped.static.map((s) => (isRecord(s) ? String(s.key) : ""))].join(", ") || "none"}.`,
    ].join("\n"),
    env,
  );
  return manifest;
}

// ---- the command line ---------------------------------------------------------------------

/**
 * @param {string | undefined} command
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 */
export async function main(command, env, root) {
  switch (command) {
    case "build":
      build({ root, env });
      return 0;
    case "previous": {
      const repo = env.GITHUB_REPOSITORY ?? "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY is not owner/name");
      const found = await findPreviousRelease({
        repo,
        runId: env.GITHUB_RUN_ID ?? "",
        sha: env.GITHUB_SHA ?? "",
        request: githubRequest(env),
      });
      setOutput("run_id", found?.runId ?? "", env);
      setOutput("sha", found?.sha ?? "", env);
      if (found === null) {
        annotate(
          "notice",
          "previous release",
          "none found: this release carries no earlier assets",
        );
      }
      say(`release.previous run=${found?.runId ?? "none"} sha=${found?.sha ?? "none"}`);
      return 0;
    }
    case "take":
      take({ root });
      return 0;
    case "merge":
      merge({ root, env });
      return 0;
    case "record":
      record({ root, env });
      return 0;
    case "manifest":
      writeManifest({ root, env });
      return 0;
    default:
      say("usage: release-static.mjs build|take|previous|merge|record|manifest");
      return 64;
  }
}

if (isMain(import.meta)) {
  try {
    process.exitCode = await main(process.argv[2], process.env, process.cwd());
  } catch (error) {
    annotate("error", "release", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
