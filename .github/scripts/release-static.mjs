#!/usr/bin/env node
// The static half of release.yml and its manifest (spec 01 §5.5, §7.4; ARCHITECTURE §11.7;
// EXECUTION EX-28; FW-C13; orchestrator decision BD-05). A control path. Subcommands, run in order
// by release.yml's static and manifest jobs, each reading what the one before wrote under release/:
//
//   build     builds every static app tools/layout.json names (console, admin, verify with its
//             two outputs verify and selfie, docs) whose folder is on main, through Turborepo with
//             --force (a release restores no cache); stages each output in release/static/<key>/
//             and moves every source map out into release/source-maps/<key>/; refuses a build
//             that holds _headers or env.json (rendered at deploy, SF-05) or a link
//   previous  finds the previous release: the newest earlier run of release.yml for a push to
//             main of this repository that left a release-<sha> manifest artefact
//   merge     FW-C13: carries the previous release's own hashed assets/ into each output (this
//             release's files win), then checks that every one of them is present, and computes
//             each output's asset manifest hash (tools/static-deploy's, SP-26)
//   record    adds each uploaded artefact's SHA-256 and writes the checksums file actions/attest
//             signs
//   manifest  writes release-manifest.json: the commit, each image's digest, each static
//             artefact's name, SHA-256 and asset manifest hash, the source-map artefact, the
//             migrations and the minimum schema version
//
// Only the previous release's *own* assets travel (the ones its build produced, which its
// manifest lists), so an artefact holds two releases' assets at most, never a growing pile.
// Node built-ins only. Every line it prints is `release.<what> key=value ...`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
const KEY = /^[a-z]+$/;
const ASSET_PATH = /^\/assets\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE = /^fin-next-[a-z0-9-]+$/;
/** The files the deploy renders into a copy of the build, which no build may hold (SF-05). */
export const RENDERED_FILES = new Set(["/_headers", "/env.json"]);
/** packages/db's migration file names (DA-04). */
const MIGRATION = /^\d{14}_[a-z][a-z0-9-]*_[a-z0-9][a-z0-9_]*\.sql$/;

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

// ---- build --------------------------------------------------------------------------------

/**
 * Copies one built output into the release folder, moving source maps aside.
 * @param {{ from: string, mapsFrom: string, to: string, mapsTo: string }} paths
 * @returns {{ files: number, maps: number }}
 */
export function stageOutput({ from, mapsFrom, to, mapsTo }) {
  const files = walkFiles(from);
  if (!files.some((f) => f.path === "/index.html")) throw new Error("the build has no index.html");
  for (const f of files) {
    if (RENDERED_FILES.has(f.path)) {
      throw new Error(`the build holds ${f.path}; the deploy renders it (SF-05)`);
    }
  }
  rmSync(to, { recursive: true, force: true });
  let maps = 0;
  for (const f of files) {
    const target = f.path.endsWith(".map") ? join(mapsTo, f.path) : join(to, f.path);
    if (f.path.endsWith(".map")) maps++;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(f.abs, target);
  }
  for (const f of walkFiles(mapsFrom)) {
    const target = join(mapsTo, f.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(f.abs, target);
    maps++;
  }
  return { files: files.filter((f) => !f.path.endsWith(".map")).length, maps };
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
 * commit, started by a push to main of this repository, that still holds its release-<sha>
 * manifest artefact (a run without one did not finish, and is no release).
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
    if (
      typeof path !== "string" ||
      !ASSET_PATH.test(path) ||
      path.split("/").some((segment) => segment === "." || segment === "..")
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

/**
 * @param {{ root: string, env: NodeJS.ProcessEnv }} ctx
 */
export function merge(ctx) {
  const { root, env } = ctx;
  const meta = readJson(join(root, RELEASE, "meta", "static-build.json"));
  const built = isRecord(meta) && isRecord(meta.built) ? meta.built : {};
  const previousSha = isSha(env.PREVIOUS_SHA) ? env.PREVIOUS_SHA : null;
  const manifestFile = join(root, RELEASE, "previous", "manifest", "release-manifest.json");
  const previousManifest =
    previousSha !== null && existsSync(manifestFile) ? readJson(manifestFile) : null;
  /** @type {Record<string, unknown>} */
  const keys = {};
  for (const key of Object.keys(built)) {
    if (!KEY.test(key)) throw new Error("a staged output key is not lower-case letters");
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
        `${path} differs from the previous release's; kept this one`,
      );
    }
    const files = walkFiles(dir).length;
    const hash = assetManifestHash(dir);
    keys[key] = {
      files,
      ownAssets: carry.own,
      carried: carry.carried,
      carriedFrom: previousDir === null ? null : previousSha,
      assetManifestHash: hash,
    };
    say(
      `release.static.merge key=${key} files=${files} own=${carry.own.length} carried=${carry.carried.length} from=${previousDir === null ? "none" : previousSha}`,
    );
  }
  const skipped = isRecord(meta) && Array.isArray(meta.skipped) ? meta.skipped : [];
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
  writeFile(
    join(root, RELEASE, "meta", "static.json"),
    JSON.stringify({ static: statics, sourceMaps, skipped }),
  );
  writeFile(join(root, RELEASE, "meta", "static-checksums.txt"), `${checksums.join("\n")}\n`);
  setOutput("attest", checksums.length > 0 ? "true" : "false", env);
  for (const line of checksums) say(`release.static.record ${line.replace("  ", " artefact=")}`);
  return { static: statics, sourceMaps };
}

// ---- manifest -----------------------------------------------------------------------------

/**
 * The images the images job built, from its records (one JSON file per image).
 * @param {string} dir
 */
export function readImageRecords(dir) {
  /** @type {Record<string, string>} */
  const images = {};
  /** @type {Record<string, string>} */
  const refs = {};
  /** @type {{ image: string, why: string }[]} */
  const skipped = [];
  for (const f of walkFiles(dir)) {
    if (!f.path.endsWith(".json")) continue;
    const rec = readJson(f.abs);
    if (!isRecord(rec) || typeof rec.image !== "string" || !IMAGE.test(rec.image)) {
      throw new Error(`${f.path} is not an image record`);
    }
    if (rec.built === true) {
      if (typeof rec.digest !== "string" || !DIGEST.test(rec.digest)) {
        throw new Error(`${rec.image}: the record's digest is not sha256:<hex>`);
      }
      if (typeof rec.ref !== "string" || !rec.ref.startsWith("ghcr.io/")) {
        throw new Error(`${rec.image}: the record's reference is not on ghcr.io`);
      }
      images[rec.image] = rec.digest;
      refs[rec.image] = `${rec.ref}@${rec.digest}`;
    } else {
      skipped.push({ image: rec.image, why: clean(rec.why ?? "not built", 200) });
    }
  }
  return { images, refs, skipped };
}

/**
 * The migration files packages/db ships, in name order, and the newest as the minimum schema.
 * @param {string} root
 */
export function readMigrations(root) {
  const dir = join(root, "packages", "db", "migrations");
  if (!existsSync(dir)) return { migrations: [], minimumSchemaVersion: null };
  const migrations = readdirSync(dir)
    .filter((name) => MIGRATION.test(name))
    .sort();
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
  return problems;
}

/**
 * @param {{ root: string, env: NodeJS.ProcessEnv, now?: () => Date }} ctx
 */
export function writeManifest(ctx) {
  const { root, env } = ctx;
  const sha = env.GITHUB_SHA ?? "";
  if (!isSha(sha)) throw new Error("GITHUB_SHA is not a commit SHA");
  const images = readImageRecords(join(root, RELEASE, "images"));
  const staticFile = join(root, RELEASE, "meta", "static.json");
  const staticMeta = existsSync(staticFile) ? readJson(staticFile) : {};
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
    `release.manifest commit=${sha} images=${imageCount} static=${staticCount} migrations=${migrations.length}`,
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
      say("usage: release-static.mjs build|previous|merge|record|manifest");
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
