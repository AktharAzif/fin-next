// release-static: the static outputs, staging and map strip, FW-C13's carry and its test, the
// asset manifest hash the deploy compares, the previous-release lookup and the manifest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  artefactPathProblem,
  assetHash,
  assetManifestHash,
  build,
  carryAssets,
  digestHex,
  findPreviousRelease,
  MAX_FILE_BYTES,
  manifestProblems,
  merge,
  previousOwnAssets,
  RELEASE_IMAGES,
  readImageRecords,
  readMigrations,
  record,
  STAGED,
  stageOutput,
  staticOutputs,
  take,
  writeManifest,
} from "../release-static.mjs";
import { child, parseOutline } from "../workflow-rules.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHA = "1".repeat(40);
const PREV = "2".repeat(40);
const REPO = "owner/fin-next";
const OWNER = "owner";
const HEX = (/** @type {string} */ c) => c.repeat(64);
/** The opening of a GitHub expression, spelled so that no linter reads it as a template. */
const E = `${"$"}{{`;
/** The static outputs tools/layout.json names, each uploaded as static-<key>-<sha>. */
const RELEASE_KEYS = staticOutputs(
  JSON.parse(readFileSync(join(ROOT, "tools", "layout.json"), "utf8")),
).map((o) => o.key);

/** @param {string | Buffer} content */
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

/**
 * The image records as the manifest job downloads them: one artefact folder per release image,
 * each holding its one record. Images not named are skipped.
 * @param {string} dir release/images
 * @param {string} sha
 * @param {Record<string, Record<string, unknown>>} [built] image to the record's fields
 * @returns {Record<string, string>} each record's SHA-256, as the images job's outputs give it
 */
function imageRecords(dir, sha, built = {}) {
  /** @type {Record<string, string>} */
  const files = {};
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const image of RELEASE_IMAGES) {
    const name = `fin-next-${image}`;
    const fields = built[image] ?? { built: false, why: `ops/docker is not on main yet` };
    const content = `${JSON.stringify({ image: name, ...fields })}\n`;
    files[`image-record-${image}-${sha}/${name}.json`] = content;
    hashes[image] = sha256(content);
  }
  writeTree(dir, files);
  return hashes;
}

/**
 * The manifest step's environment for these record hashes (release.yml's job outputs).
 * @param {Record<string, string>} hashes
 */
function recordEnv(hashes) {
  return Object.fromEntries(
    Object.entries(hashes).map(([image, hash]) => [`RECORD_SHA256_${image.toUpperCase()}`, hash]),
  );
}

/**
 * A step output the run wrote to a GITHUB_OUTPUT file.
 * @param {string} file
 * @param {string} name
 */
function outputOf(file, name) {
  return new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(file, "utf8"))?.[1];
}

describe("staticOutputs", () => {
  it("reads this repository's layout: console, admin, verify and selfie, docs", () => {
    const layout = JSON.parse(readFileSync(join(ROOT, "tools", "layout.json"), "utf8"));
    const outputs = staticOutputs(layout);
    assert.deepEqual(
      outputs.map((o) => `${o.app}:${o.key}:${o.dir}:${o.mapsDir}`),
      [
        "console:console:dist/static:dist/source-maps",
        "admin:admin:dist/static:dist/source-maps",
        "verify:verify:dist/static/verify:dist/source-maps/verify",
        "verify:selfie:dist/static/selfie:dist/source-maps/selfie",
        "docs:docs:dist/static:dist/source-maps",
      ],
    );
    assert.ok(outputs.every((o) => o.name === `@fin/${o.app}`));
  });

  it("refuses a bad key or path", () => {
    const entry = { kind: "app", path: "apps/x", name: "@fin/x", static: "Bad-Key" };
    assert.throws(() => staticOutputs({ entries: [entry] }), /lower-case/);
    assert.throws(
      () => staticOutputs({ entries: [{ ...entry, static: "x", path: "../x" }] }),
      /bad path/,
    );
    assert.throws(() => staticOutputs({}), /no entries/);
  });
});

describe("hashes", () => {
  it("hashes a file as SP-26 does: SHA-256 of base64 and extension, 32 characters", () => {
    const content = Buffer.from("hello");
    const expected = createHash("sha256")
      .update(`${content.toString("base64")}js`)
      .digest("hex")
      .slice(0, 32);
    assert.equal(assetHash(content, "/assets/a.js"), expected);
    assert.equal(assetHash(content, "/a.js").length, 32);
  });

  it("hashes a build over its sorted path, hash and size lines, without _headers and env.json", (t) => {
    const dir = tempDir(t);
    writeTree(dir, { "index.html": "<p>", "assets/b.js": "b", "assets/a.css": "a" });
    const line = (/** @type {string} */ p, /** @type {string} */ c) =>
      `${p} ${assetHash(Buffer.from(c), p)} ${Buffer.byteLength(c)}`;
    const expected = createHash("sha256")
      .update(
        [line("/assets/a.css", "a"), line("/assets/b.js", "b"), line("/index.html", "<p>")]
          .sort()
          .join("\n"),
      )
      .digest("hex");
    assert.equal(assetManifestHash(dir), expected);
    writeTree(dir, { _headers: "x", "env.json": "{}" });
    assert.equal(assetManifestHash(dir), expected, "rendered files are left out");
  });
});

describe("stageOutput", () => {
  it("copies the build and moves every source map aside", (t) => {
    const root = tempDir(t);
    writeTree(root, {
      "build/index.html": "<p>",
      "build/assets/a.js": "a",
      "build/assets/a.js.map": "{}",
      "maps/assets/b.js.map": "{}",
    });
    const staged = stageOutput({
      from: join(root, "build"),
      mapsFrom: join(root, "maps"),
      to: join(root, "out"),
      mapsTo: join(root, "out-maps"),
    });
    assert.deepEqual(staged, { files: 2, maps: 2 });
    assert.ok(existsSync(join(root, "out", "assets", "a.js")));
    assert.ok(!existsSync(join(root, "out", "assets", "a.js.map")));
    assert.ok(existsSync(join(root, "out-maps", "assets", "a.js.map")));
    assert.ok(existsSync(join(root, "out-maps", "assets", "b.js.map")));
  });

  it("refuses a build without index.html, with a rendered file, or with a link", (t) => {
    const root = tempDir(t);
    const paths = {
      from: join(root, "b"),
      mapsFrom: join(root, "m"),
      to: join(root, "o"),
      mapsTo: join(root, "om"),
    };
    writeTree(root, { "b/a.js": "a" });
    assert.throws(() => stageOutput(paths), /no index.html/);
    writeTree(root, { "b/index.html": "", "b/env.json": "{}" });
    assert.throws(() => stageOutput(paths), /deploy renders it/);
    const linked = tempDir(t);
    writeTree(linked, { "b/index.html": "" });
    symlinkSync("/etc/hosts", join(linked, "b", "hosts"));
    assert.throws(() => stageOutput({ ...paths, from: join(linked, "b") }), /is a link/);
  });

  it("refuses what the deploy refuses, in any case and at any depth, and moves a map in any case", (t) => {
    /** @type {[string, RegExp][]} */
    const refused = [
      ["_worker.js", /no Worker control file/],
      ["assets/_Routes.json", /no Worker control file/],
      ["_redirects", /no Worker control file/],
      ["ENV.JSON", /deploy renders it/],
      ["assets/_headers", /deploy renders it/],
      ["assets/a%2e.js", /the path holds/],
      [`assets/a${String.fromCharCode(0x200b)}.js`, /the path holds/],
    ];
    for (const [file, why] of refused) {
      const root = tempDir(t);
      writeTree(root, { "b/index.html": "", [`b/${file}`]: "x" });
      const paths = {
        from: join(root, "b"),
        mapsFrom: join(root, "m"),
        to: join(root, "o"),
        mapsTo: join(root, "om"),
      };
      assert.throws(() => stageOutput(paths), why, file);
    }
    const root = tempDir(t);
    writeTree(root, {
      "b/index.html": "",
      "b/assets/A.JS.MAP": "{}",
      "b/assets/logo (1)-Bq3x.svg": "<svg/>",
    });
    const staged = stageOutput({
      from: join(root, "b"),
      mapsFrom: join(root, "m"),
      to: join(root, "o"),
      mapsTo: join(root, "om"),
    });
    assert.deepEqual(staged, { files: 2, maps: 1 });
    assert.ok(existsSync(join(root, "om", "assets", "A.JS.MAP")));
    assert.ok(existsSync(join(root, "o", "assets", "logo (1)-Bq3x.svg")));
  });

  it("refuses an asset over the deploy's 25 MiB limit", (t) => {
    const root = tempDir(t);
    writeTree(root, { "b/index.html": "", "b/assets/big.bin": "" });
    truncateSync(join(root, "b", "assets", "big.bin"), MAX_FILE_BYTES + 1);
    const paths = {
      from: join(root, "b"),
      mapsFrom: join(root, "m"),
      to: join(root, "o"),
      mapsTo: join(root, "om"),
    };
    assert.throws(() => stageOutput(paths), /over the 25 MiB asset limit/);
  });
});

describe("artefactPathProblem", () => {
  it("keeps the names a bundler emits and refuses what reads two ways or leaves the folder", () => {
    for (const ok of [
      "/index.html",
      "/assets/logo (1)-Bq3x.svg",
      "/assets/~a!b_c@d+e.js",
      "/assets/ü-1.css",
    ]) {
      assert.equal(artefactPathProblem(ok), null, ok);
    }
    for (const bad of [
      "assets/a.js",
      "/assets/../a.js",
      "/assets/./a.js",
      "/assets//a.js",
      "/assets/",
      "/assets/a\\b.js",
      "/assets/a%2e.js",
      "/assets/a?.js",
      "/assets/a#.js",
      "/assets/a\u0000.js",
      `/assets/a${String.fromCharCode(0x2028)}.js`,
      `/assets/a${String.fromCharCode(0x202e)}.js`,
      `/${"a".repeat(1024)}`,
      7,
    ]) {
      assert.notEqual(artefactPathProblem(bad), null, String(bad));
    }
  });
});

describe("FW-C13: carrying the previous release's assets", () => {
  it("carries the previous release's own assets, keeps this release's files, and lists both", (t) => {
    const root = tempDir(t);
    writeTree(root, {
      "new/index.html": "new",
      "new/assets/app-new.js": "new",
      "new/assets/shared.css": "same",
      "prev/index.html": "old",
      "prev/assets/app-old.js": "old",
      "prev/assets/shared.css": "same",
      "prev/assets/two-back.js": "older",
    });
    const result = carryAssets({
      dir: join(root, "new"),
      previousDir: join(root, "prev"),
      previousAssets: ["/assets/app-old.js", "/assets/shared.css"],
    });
    assert.deepEqual(result.own, ["/assets/app-new.js", "/assets/shared.css"]);
    assert.deepEqual(result.carried, ["/assets/app-old.js"]);
    assert.equal(
      readFileSync(join(root, "new", "index.html"), "utf8"),
      "new",
      "this release's document wins",
    );
    assert.ok(
      !existsSync(join(root, "new", "assets", "two-back.js")),
      "only the previous release's own assets travel",
    );
  });

  it("keeps this release's file when a previous asset differs, and reports it", (t) => {
    const root = tempDir(t);
    writeTree(root, { "new/assets/x.js": "new", "prev/assets/x.js": "old" });
    const result = carryAssets({
      dir: join(root, "new"),
      previousDir: join(root, "prev"),
      previousAssets: ["/assets/x.js"],
    });
    assert.deepEqual(result.kept, ["/assets/x.js"]);
    assert.equal(readFileSync(join(root, "new", "assets", "x.js"), "utf8"), "new");
  });

  it("fails when the previous artefact lacks one of its own assets", (t) => {
    const root = tempDir(t);
    writeTree(root, { "new/index.html": "", "prev/index.html": "" });
    assert.throws(
      () =>
        carryAssets({
          dir: join(root, "new"),
          previousDir: join(root, "prev"),
          previousAssets: ["/assets/gone.js"],
        }),
      /lacks its own asset/,
    );
  });

  it("refuses a link in the previous artefact", (t) => {
    const root = tempDir(t);
    writeTree(root, { "new/index.html": "", "prev/assets/a.js": "a" });
    symlinkSync("/etc/hosts", join(root, "prev", "assets", "evil.js"));
    assert.throws(
      () =>
        carryAssets({
          dir: join(root, "new"),
          previousDir: join(root, "prev"),
          previousAssets: ["/assets/a.js"],
        }),
      /is a link/,
    );
  });

  it("reads the previous own assets from its manifest, else from its assets/ folder", (t) => {
    const prev = tempDir(t);
    writeTree(prev, { "assets/a.js": "a", "assets/deep/b.js": "b", "index.html": "" });
    const manifest = { static: { console: { ownAssets: ["/assets/a.js"] } } };
    assert.deepEqual(previousOwnAssets(manifest, "console", prev), ["/assets/a.js"]);
    assert.deepEqual(previousOwnAssets(null, "console", prev), [
      "/assets/a.js",
      "/assets/deep/b.js",
    ]);
  });

  it("refuses an asset path from a manifest that could leave assets/ or read two ways", (t) => {
    const prev = tempDir(t);
    for (const bad of [
      "/assets/../../etc/passwd",
      "/index.html",
      "assets/a.js",
      "/assets/./a.js",
      "/assets//a.js",
      "/assets/a%2f..%2fb.js",
      "/assets/a\\b.js",
      "/assets/a\u0000.js",
      7,
    ]) {
      const manifest = { static: { console: { ownAssets: [bad] } } };
      assert.throws(() => previousOwnAssets(manifest, "console", prev), /refused/, String(bad));
    }
    const named = { static: { console: { ownAssets: ["/assets/logo (1)-Bq3x.svg"] } } };
    assert.deepEqual(previousOwnAssets(named, "console", prev), ["/assets/logo (1)-Bq3x.svg"]);
  });

  it("carries an asset whose name a bundler keeps (spaces, brackets) into the next release", (t) => {
    const root = tempDir(t);
    const layout = JSON.stringify({
      entries: [{ kind: "app", path: "apps/console", name: "@fin/console", static: "console" }],
    });
    const release = (/** @type {string} */ sha, /** @type {Record<string, string>} */ files) => {
      rmSync(join(root, "release"), { recursive: true, force: true });
      rmSync(join(root, "apps"), { recursive: true, force: true });
      writeTree(root, {
        "tools/layout.json": layout,
        "apps/console/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
        "apps/console/dist/static/index.html": `<p>${sha}`,
        ...Object.fromEntries(
          Object.entries(files).map(([p, c]) => [`apps/console/dist/static/${p}`, c]),
        ),
      });
      const env = { GITHUB_OUTPUT: join(root, `out-${sha}.txt`), GITHUB_SHA: sha };
      build({ root, env, runBuild: () => {} });
      return env;
    };
    // Release A builds an asset named as Vite names `logo (1).svg`.
    const a = release(PREV, { "assets/app-1.js": "one", "assets/logo (1)-Bq3x.svg": "<svg/>" });
    const first = /** @type {any} */ (merge({ root, env: a }));
    assert.deepEqual(first.console.ownAssets, ["/assets/app-1.js", "/assets/logo (1)-Bq3x.svg"]);
    const manifestA = { static: { console: { ownAssets: first.console.ownAssets } } };
    const artefactA = join(root, "keep", `static-console-${PREV}`);
    writeTree(root, {
      [`keep/static-console-${PREV}/index.html`]: "<p>a",
      [`keep/static-console-${PREV}/assets/app-1.js`]: "one",
      [`keep/static-console-${PREV}/assets/logo (1)-Bq3x.svg`]: "<svg/>",
    });
    // Release B, the next one, carries both of A's assets in.
    const b = release(SHA, { "assets/app-2.js": "two" });
    writeTree(root, {
      "release/previous/manifest/release-manifest.json": JSON.stringify(manifestA),
      [`release/previous/static/static-console-${PREV}/index.html`]: readFileSync(
        join(artefactA, "index.html"),
        "utf8",
      ),
      [`release/previous/static/static-console-${PREV}/assets/app-1.js`]: "one",
      [`release/previous/static/static-console-${PREV}/assets/logo (1)-Bq3x.svg`]: "<svg/>",
    });
    const second = /** @type {any} */ (merge({ root, env: { ...b, PREVIOUS_SHA: PREV } }));
    assert.deepEqual(second.console.carried, ["/assets/app-1.js", "/assets/logo (1)-Bq3x.svg"]);
    assert.deepEqual(second.console.ownAssets, ["/assets/app-2.js"]);
  });
});

describe("findPreviousRelease", () => {
  /**
   * @param {Record<string, unknown>} overrides
   */
  const run = (overrides) => ({
    id: 10,
    head_sha: PREV,
    event: "push",
    head_branch: "main",
    path: ".github/workflows/release.yml",
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    ...overrides,
  });

  /**
   * @param {unknown[]} runs
   * @param {Record<string, unknown[]>} artifacts by run id
   */
  const api = (runs, artifacts) => {
    /** @type {string[]} */
    const asked = [];
    const request = async (/** @type {string} */ path) => {
      asked.push(path);
      if (path.includes("/workflows/release.yml/runs")) return { workflow_runs: runs };
      const id = /\/runs\/(\d+)\/artifacts/.exec(path)?.[1] ?? "";
      return { artifacts: artifacts[id] ?? [] };
    };
    return { request, asked };
  };

  it("picks the newest earlier release that left its manifest", async () => {
    const { request, asked } = api(
      [run({ id: 12, head_sha: SHA }), run({ id: 11, head_sha: "3".repeat(40) }), run({ id: 10 })],
      { 10: [{ name: `release-${PREV}`, expired: false }] },
    );
    const found = await findPreviousRelease({ repo: REPO, runId: "12", sha: SHA, request });
    assert.deepEqual(found, { runId: "10", sha: PREV });
    assert.match(asked[0] ?? "", /branch=main&event=push/);
  });

  it("skips runs from another event, branch, workflow or repository, and expired manifests", async () => {
    const { request } = api(
      [
        run({ id: 20, event: "workflow_dispatch" }),
        run({ id: 21, head_branch: "feature" }),
        run({ id: 22, path: ".github/workflows/ci.yml" }),
        run({ id: 23, head_repository: { full_name: "fork/fin-next" } }),
        run({ id: 24 }),
        run({ id: 25, head_sha: "not-a-sha" }),
      ],
      {
        20: [{ name: `release-${PREV}`, expired: false }],
        21: [{ name: `release-${PREV}`, expired: false }],
        22: [{ name: `release-${PREV}`, expired: false }],
        23: [{ name: `release-${PREV}`, expired: false }],
        24: [{ name: `release-${PREV}`, expired: true }],
      },
    );
    assert.equal(await findPreviousRelease({ repo: REPO, runId: "99", sha: SHA, request }), null);
  });

  it("takes only a run that finished successfully, whatever artefacts it left", async () => {
    const manifest = [{ name: `release-${PREV}`, expired: false }];
    const { request } = api(
      [
        run({ id: 30, conclusion: "failure" }),
        run({ id: 31, conclusion: "cancelled" }),
        run({ id: 32, status: "in_progress", conclusion: null }),
        run({ id: 33, conclusion: undefined }),
        run({ id: 34, head_sha: "3".repeat(40) }),
      ],
      { 30: manifest, 31: manifest, 32: manifest, 33: manifest, 34: [] },
    );
    assert.equal(await findPreviousRelease({ repo: REPO, runId: "99", sha: SHA, request }), null);
    const passed = api([run({ id: 30, conclusion: "failure" }), run({ id: 29 })], {
      30: manifest,
      29: manifest,
    });
    assert.deepEqual(
      await findPreviousRelease({ repo: REPO, runId: "99", sha: SHA, request: passed.request }),
      { runId: "29", sha: PREV },
    );
  });

  it("finds none on the first release", async () => {
    const { request } = api([], {});
    assert.equal(await findPreviousRelease({ repo: REPO, runId: "1", sha: SHA, request }), null);
  });
});

describe("build, merge, record and manifest end to end", () => {
  /** @param {import("node:test").TestContext} t */
  function repo(t) {
    const root = tempDir(t);
    writeTree(root, {
      "tools/layout.json": JSON.stringify({
        entries: [
          { kind: "app", path: "apps/console", name: "@fin/console", static: "console" },
          { kind: "app", path: "apps/verify", name: "@fin/verify", static: ["verify", "selfie"] },
          { kind: "app", path: "apps/docs", name: "@fin/docs", static: "docs" },
        ],
      }),
      "apps/console/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "apps/console/dist/static/index.html": "<p>console",
      "apps/console/dist/static/assets/app-2.js": "two",
      "apps/console/dist/source-maps/assets/app-2.js.map": "{}",
      "apps/verify/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "apps/verify/dist/static/verify/index.html": "<p>verify",
      "apps/verify/dist/static/selfie/index.html": "<p>selfie",
      "apps/docs/package.json": JSON.stringify({ scripts: {} }),
      "packages/db/migrations/20261121101000_audit_core.sql": "--",
      "packages/db/migrations/20261121101100_audit_journal.sql": "--",
      "packages/db/migrations/README.md": "not a migration",
    });
    return root;
  }

  it("builds what is on main, carries the previous release in, and writes a manifest the deploy accepts", (t) => {
    const root = repo(t);
    const outputFile = join(root, "out.txt");
    const env = {
      GITHUB_OUTPUT: outputFile,
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REPOSITORY_OWNER: "Owner",
    };
    /** @type {string[][]} */
    const builds = [];
    const built = build({ root, env, runBuild: (names) => builds.push(names) });
    assert.deepEqual(builds, [["@fin/console", "@fin/verify"]]);
    assert.deepEqual(Object.keys(built.built), ["console", "verify", "selfie"]);
    assert.deepEqual(built.skipped, [{ key: "docs", why: "apps/docs has no build script" }]);
    const outputs = readFileSync(outputFile, "utf8");
    assert.match(outputs, /^console=true$/m);
    assert.match(outputs, /^docs=false$/m);
    assert.match(outputs, /^maps=true$/m);
    assert.ok(
      existsSync(join(root, "release", "source-maps", "console", "assets", "app-2.js.map")),
    );

    // The previous release, as download-artifact leaves it.
    writeTree(root, {
      [`release/previous/static/static-console-${PREV}/index.html`]: "<p>old",
      [`release/previous/static/static-console-${PREV}/assets/app-1.js`]: "one",
      [`release/previous/static/static-console-${PREV}/assets/app-0.js`]:
        "zero (carried by the previous one)",
      "release/previous/manifest/release-manifest.json": JSON.stringify({
        static: { console: { ownAssets: ["/assets/app-1.js"] } },
      }),
    });
    const mergeOutput = join(root, "merge-out.txt");
    const merged = merge({
      root,
      env: { ...env, GITHUB_OUTPUT: mergeOutput, PREVIOUS_SHA: PREV },
    });
    assert.deepEqual(/** @type {any} */ (merged.console).carried, ["/assets/app-1.js"]);
    assert.deepEqual(/** @type {any} */ (merged.console).ownAssets, ["/assets/app-2.js"]);
    assert.equal(/** @type {any} */ (merged.console).carriedFrom, PREV);
    assert.equal(/** @type {any} */ (merged.verify).carriedFrom, null);
    assert.ok(existsSync(join(root, "release", "static", "console", "assets", "app-1.js")));
    assert.ok(!existsSync(join(root, "release", "static", "console", "assets", "app-0.js")));
    // merge, in the job that uploads, says what to upload: the build job's outputs stay there.
    assert.equal(
      readFileSync(mergeOutput, "utf8"),
      "console=true\nverify=true\nselfie=true\ndocs=false\nmaps=true\n",
    );

    record({
      root,
      env: {
        ...env,
        MAPS: "true",
        DIGEST_CONSOLE: HEX("a"),
        DIGEST_VERIFY: `sha256:${HEX("b")}`,
        DIGEST_SELFIE: HEX("c"),
        DIGEST_SOURCE_MAPS: HEX("d"),
      },
    });
    const checksums = readFileSync(join(root, "release", "meta", "static-checksums.txt"), "utf8");
    assert.match(checksums, new RegExp(`^${HEX("a")}  static-console-${SHA}$`, "m"));
    assert.match(checksums, new RegExp(`^${HEX("b")}  static-verify-${SHA}$`, "m"));
    assert.match(checksums, new RegExp(`^${HEX("d")}  source-maps-${SHA}$`, "m"));
    assert.match(readFileSync(outputFile, "utf8"), /^attest=true$/m);
    const staticHash = outputOf(outputFile, "record_sha256");
    assert.equal(staticHash, sha256(readFileSync(join(root, "release", "meta", "static.json"))));

    const hashes = imageRecords(join(root, "release", "images"), SHA, {
      api: { built: true, ref: "ghcr.io/owner/fin-next-api", digest: `sha256:${HEX("e")}` },
      edge: { built: false, why: "ops/docker/app.Dockerfile is not on main yet" },
    });
    const manifest = writeManifest({
      root,
      env: { ...env, ...recordEnv(hashes), RECORD_SHA256_STATIC: staticHash },
      now: () => new Date("2026-11-21T12:00:00Z"),
    });
    const onDisk = JSON.parse(
      readFileSync(join(root, "release", "out", "release-manifest.json"), "utf8"),
    );
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(manifest)));
    assert.equal(onDisk.commit, SHA);
    assert.deepEqual(onDisk.images, { "fin-next-api": `sha256:${HEX("e")}` });
    assert.equal(onDisk.imageRefs["fin-next-api"], `ghcr.io/owner/fin-next-api@sha256:${HEX("e")}`);
    assert.deepEqual(Object.keys(onDisk.static), ["console", "verify", "selfie"]);
    assert.equal(onDisk.static.console.artefact, `static-console-${SHA}`);
    assert.equal(onDisk.static.console.sha256, HEX("a"));
    assert.equal(onDisk.static.verify.sha256, HEX("b"));
    assert.equal(
      onDisk.static.console.assetManifestHash,
      assetManifestHash(join(root, "release", "static", "console")),
    );
    assert.deepEqual(onDisk.sourceMaps, { artefact: `source-maps-${SHA}`, sha256: HEX("d") });
    assert.deepEqual(onDisk.migrations, [
      "20261121101000_audit_core.sql",
      "20261121101100_audit_journal.sql",
    ]);
    assert.equal(onDisk.minimumSchemaVersion, "20261121101100_audit_journal.sql");
    assert.deepEqual(
      onDisk.skipped.images.map((/** @type {any} */ s) => s.image),
      RELEASE_IMAGES.filter((i) => i !== "api").map((i) => `fin-next-${i}`),
    );
    assert.deepEqual(
      onDisk.skipped.images.find((/** @type {any} */ s) => s.image === "fin-next-edge"),
      { image: "fin-next-edge", why: "ops/docker/app.Dockerfile is not on main yet" },
    );
    assert.deepEqual(onDisk.run, { id: 42, attempt: 1, workflow: ".github/workflows/release.yml" });
    assert.deepEqual(manifestProblems(onDisk), []);
  });

  it("with nothing on main, builds nothing and writes an empty but valid manifest", (t) => {
    const root = tempDir(t);
    writeTree(root, {
      "tools/layout.json": JSON.stringify({
        entries: [{ kind: "app", path: "apps/console", name: "@fin/console", static: "console" }],
      }),
    });
    const env = {
      GITHUB_OUTPUT: join(root, "out.txt"),
      GITHUB_SHA: SHA,
      GITHUB_REPOSITORY_OWNER: OWNER,
    };
    let ran = false;
    build({
      root,
      env,
      runBuild: () => {
        ran = true;
      },
    });
    assert.equal(ran, false);
    merge({ root, env });
    record({ root, env });
    assert.match(readFileSync(join(root, "out.txt"), "utf8"), /^attest=false$/m);
    const hashes = imageRecords(join(root, "release", "images"), SHA);
    const manifest = writeManifest({
      root,
      env: {
        ...env,
        ...recordEnv(hashes),
        RECORD_SHA256_STATIC: outputOf(join(root, "out.txt"), "record_sha256"),
      },
    });
    assert.deepEqual(manifest.images, {});
    assert.deepEqual(manifest.static, {});
    assert.deepEqual(manifest.migrations, []);
    assert.equal(manifest.minimumSchemaVersion, null);
  });

  it("takes only the records their own jobs wrote, as those jobs' outputs pin them", (t) => {
    /**
     * A run up to the manifest, with nothing built; then `plant` changes what the manifest job
     * downloaded or was given.
     * @param {(root: string, env: Record<string, string | undefined>) => void} plant
     */
    const manifestAfter = (plant) => {
      const root = tempDir(t);
      writeTree(root, {
        "tools/layout.json": JSON.stringify({
          entries: [{ kind: "app", path: "apps/console", name: "@fin/console", static: "console" }],
        }),
      });
      const out = join(root, "out.txt");
      const env = { GITHUB_OUTPUT: out, GITHUB_SHA: SHA, GITHUB_REPOSITORY_OWNER: OWNER };
      build({ root, env, runBuild: () => {} });
      merge({ root, env });
      record({ root, env });
      const hashes = imageRecords(join(root, "release", "images"), SHA, {
        api: { built: true, ref: "ghcr.io/owner/fin-next-api", digest: `sha256:${HEX("a")}` },
      });
      /** @type {Record<string, string | undefined>} */
      const manifestEnv = {
        ...env,
        ...recordEnv(hashes),
        RECORD_SHA256_STATIC: outputOf(out, "record_sha256"),
      };
      plant(root, manifestEnv);
      return () => writeManifest({ root, env: manifestEnv });
    };
    assert.deepEqual(manifestAfter(() => {})().images, { "fin-next-api": `sha256:${HEX("a")}` });
    const apiRecord = (/** @type {string} */ root) =>
      join(root, "release", "images", `image-record-api-${SHA}`, "fin-next-api.json");
    /** @type {[string, (root: string, env: Record<string, string | undefined>) => void, RegExp][]} */
    const cases = [
      [
        "an image record replaced with an earlier digest",
        (root) =>
          writeTree(root, {
            [`release/images/image-record-api-${SHA}/fin-next-api.json`]: `${JSON.stringify({
              image: "fin-next-api",
              built: true,
              ref: "ghcr.io/owner/fin-next-api",
              digest: `sha256:${HEX("d")}`,
            })}\n`,
          }),
        /fin-next-api: the record is not the one the images job wrote/,
      ],
      [
        "an image record replaced to say it was not built",
        (root) =>
          writeTree(root, {
            [`release/images/image-record-api-${SHA}/fin-next-api.json`]: JSON.stringify({
              image: "fin-next-api",
              built: false,
              why: "x",
            }),
          }),
        /fin-next-api: the record is not the one the images job wrote/,
      ],
      [
        "an image record with a byte added",
        (root) => appendFileSync(apiRecord(root), " "),
        /fin-next-api: the record is not the one the images job wrote/,
      ],
      [
        "no SHA-256 from the images job for one image",
        (_root, env) => {
          env.RECORD_SHA256_EDGE = undefined;
        },
        /no SHA-256 of fin-next-edge's record from the images job/,
      ],
      [
        "a static record replaced",
        (root) =>
          writeTree(root, {
            "release/meta/static.json": JSON.stringify({
              static: {},
              sourceMaps: null,
              skipped: [],
            }),
          }),
        /the static record is not the one the static job wrote/,
      ],
      [
        "a static record missing",
        (root) => rmSync(join(root, "release", "meta", "static.json")),
        /the static record is not the one the static job wrote/,
      ],
      [
        "no SHA-256 from the static job",
        (_root, env) => {
          env.RECORD_SHA256_STATIC = "";
        },
        /the static record is not the one the static job wrote/,
      ],
    ];
    for (const [what, plant, why] of cases) {
      assert.throws(manifestAfter(plant), why, what);
    }
  });

  it("refuses to record a built output without its artefact digest", (t) => {
    const root = repo(t);
    const env = { GITHUB_OUTPUT: join(root, "out.txt"), GITHUB_SHA: SHA };
    build({ root, env, runBuild: () => {} });
    merge({ root, env });
    assert.throws(
      () => record({ root, env: { ...env, DIGEST_CONSOLE: HEX("a") } }),
      /no artefact digest for verify/,
    );
  });

  it("merge takes nothing the build job staged on trust", (t) => {
    /** @type {[string, (root: string) => void, RegExp][]} */
    const cases = [
      [
        "an output static-build.json does not name",
        (root) => writeTree(root, { "release/static/admin/index.html": "<p>" }),
        /not the ones static-build.json says/,
      ],
      [
        "a built output that is missing",
        (root) => rmSync(join(root, "release", "static", "selfie"), { recursive: true }),
        /not the ones static-build.json says/,
      ],
      [
        "a Worker control file",
        (root) => writeTree(root, { "release/static/console/_worker.js": "export default {}" }),
        /no Worker control file/,
      ],
      [
        "a source map left in an output",
        (root) => writeTree(root, { "release/static/console/assets/app-2.js.map": "{}" }),
        /source map never reaches a deployment/,
      ],
      [
        "a path the release refuses",
        (root) => writeTree(root, { "release/static/console/assets/a%2e.js": "x" }),
        /the path holds/,
      ],
      [
        "an output without its index.html",
        (root) => rmSync(join(root, "release", "static", "verify", "index.html")),
        /has no index.html/,
      ],
      [
        "a link among the source maps",
        (root) =>
          symlinkSync("/etc/hosts", join(root, "release", "source-maps", "console", "hosts.map")),
        /is a link/,
      ],
      [
        "a skipped output that was also built",
        (root) => {
          const file = join(root, "release", "meta", "static-build.json");
          const meta = JSON.parse(readFileSync(file, "utf8"));
          meta.skipped.push({ key: "console", why: "x" });
          writeTree(root, { "release/meta/static-build.json": JSON.stringify(meta) });
        },
        /lists a skipped output that is not one/,
      ],
    ];
    for (const [what, plant, why] of cases) {
      const root = repo(t);
      const env = { GITHUB_OUTPUT: join(root, "out.txt"), GITHUB_SHA: SHA };
      build({ root, env, runBuild: () => {} });
      plant(root);
      assert.throws(() => merge({ root, env }), why, what);
    }
    // A skipped output's reason reaches the attested manifest only as printable text.
    const root = repo(t);
    const env = { GITHUB_OUTPUT: join(root, "out.txt"), GITHUB_SHA: SHA };
    build({ root, env, runBuild: () => {} });
    const file = join(root, "release", "meta", "static-build.json");
    const meta = JSON.parse(readFileSync(file, "utf8"));
    meta.skipped[0].why = "line one\n::error::line two";
    writeTree(root, { "release/meta/static-build.json": JSON.stringify(meta) });
    merge({ root, env });
    const merged = JSON.parse(
      readFileSync(join(root, "release", "meta", "static-merged.json"), "utf8"),
    );
    assert.deepEqual(merged.skipped, [{ key: "docs", why: "line one?::error::line two" }]);
  });
});

describe("the manifest's pieces", () => {
  it("reads an upload digest as hex, with or without its prefix", () => {
    assert.equal(digestHex(HEX("a")), HEX("a"));
    assert.equal(digestHex(`sha256:${HEX("a")}`), HEX("a"));
    for (const bad of [undefined, "", "sha256:xyz", HEX("A")]) assert.equal(digestHex(bad), null);
  });

  it("reads exactly one record per release image, in this repository's own package", (t) => {
    const dir = tempDir(t);
    const hashes = imageRecords(dir, SHA, {
      api: { built: true, ref: "ghcr.io/owner/fin-next-api", digest: `sha256:${HEX("a")}` },
    });
    const read = readImageRecords(dir, { sha: SHA, owner: "Owner", hashes });
    assert.deepEqual(read.images, { "fin-next-api": `sha256:${HEX("a")}` });
    assert.deepEqual(read.refs, {
      "fin-next-api": `ghcr.io/owner/fin-next-api@sha256:${HEX("a")}`,
    });
    assert.equal(read.skipped.length, RELEASE_IMAGES.length - 1);
  });

  it("refuses a malformed, foreign, missing, extra or second image record", (t) => {
    const good = {
      built: true,
      ref: "ghcr.io/owner/fin-next-api",
      digest: `sha256:${HEX("a")}`,
    };
    /** @type {[string, (dir: string) => Record<string, string>, RegExp][]} */
    const cases = [
      [
        "a digest that is not sha256",
        (dir) => imageRecords(dir, SHA, { api: { ...good, digest: "sha256:abc" } }),
        /not sha256/,
      ],
      [
        "a reference in another account's namespace",
        (dir) =>
          imageRecords(dir, SHA, { api: { ...good, ref: "ghcr.io/another-account/anything" } }),
        /is not ghcr\.io\/owner\/fin-next-api/,
      ],
      [
        "a reference to another of this account's packages",
        (dir) => imageRecords(dir, SHA, { api: { ...good, ref: "ghcr.io/owner/fin-next-edge" } }),
        /is not ghcr\.io\/owner\/fin-next-api/,
      ],
      [
        "a reference off GHCR",
        (dir) => imageRecords(dir, SHA, { api: { ...good, ref: "docker.io/x" } }),
        /is not ghcr/,
      ],
      [
        "a record naming another image",
        (dir) => imageRecords(dir, SHA, { api: { ...good, image: "fin-next-edge" } }),
        /is not fin-next-api's record/,
      ],
      [
        "a record neither built nor skipped",
        (dir) => imageRecords(dir, SHA, { api: { built: "yes" } }),
        /neither built/,
      ],
      [
        "an extra record artefact",
        (dir) => {
          const hashes = imageRecords(dir, SHA, { api: good });
          writeTree(dir, { [`image-record-zz-${SHA}/fin-next-zz.json`]: "{}" });
          return hashes;
        },
        /not exactly one artefact per release image/,
      ],
      [
        "a missing record",
        (dir) => {
          const hashes = imageRecords(dir, SHA, { api: good });
          rmSync(join(dir, `image-record-edge-${SHA}`), { recursive: true });
          return hashes;
        },
        /not exactly one artefact per release image/,
      ],
      [
        "a record of another commit",
        (dir) => {
          const hashes = imageRecords(dir, SHA, { api: good });
          rmSync(join(dir, `image-record-api-${SHA}`), { recursive: true });
          writeTree(dir, {
            [`image-record-api-${PREV}/fin-next-api.json`]: JSON.stringify({
              image: "fin-next-api",
              ...good,
            }),
          });
          return hashes;
        },
        /not exactly one artefact per release image/,
      ],
      [
        "a second file in a record artefact",
        (dir) => {
          const hashes = imageRecords(dir, SHA, { api: good });
          writeTree(dir, {
            [`image-record-api-${SHA}/zz.json`]: JSON.stringify({ image: "fin-next-api", ...good }),
          });
          return hashes;
        },
        /holds other than fin-next-api\.json/,
      ],
    ];
    for (const [what, plant, why] of cases) {
      const dir = join(tempDir(t), "images");
      const hashes = plant(dir);
      assert.throws(() => readImageRecords(dir, { sha: SHA, owner: OWNER, hashes }), why, what);
    }
    const dir = join(tempDir(t), "images");
    const hashes = imageRecords(dir, SHA);
    assert.throws(
      () => readImageRecords(dir, { sha: SHA, owner: "bad/owner", hashes }),
      /account name/,
    );
  });

  it("lists migrations in name order and ignores other files", (t) => {
    const root = tempDir(t);
    assert.deepEqual(readMigrations(root), { migrations: [], minimumSchemaVersion: null });
    writeTree(root, {
      "packages/db/migrations/20261122000000_b_two.sql": "",
      "packages/db/migrations/20261121000000_a_one.sql": "",
      "packages/db/migrations/notes.sql": "",
    });
    assert.deepEqual(readMigrations(root).migrations, [
      "20261121000000_a_one.sql",
      "20261122000000_b_two.sql",
    ]);
  });

  it("applies the deploy's own manifest checks", () => {
    const good = {
      commit: SHA,
      images: { "fin-next-api": `sha256:${HEX("a")}` },
      static: {
        console: {
          artefact: `static-console-${SHA}`,
          sha256: HEX("b"),
          assetManifestHash: HEX("c"),
        },
      },
      migrations: [],
    };
    assert.deepEqual(manifestProblems(good), []);
    assert.ok(manifestProblems({ ...good, commit: "x" }).length > 0);
    assert.ok(manifestProblems({ ...good, images: { api: `sha256:${HEX("a")}` } }).length > 0);
    assert.ok(
      manifestProblems({
        ...good,
        static: { console: { ...good.static.console, artefact: "static-Console-x" } },
      }).length > 0,
    );
    assert.ok(manifestProblems({ ...good, migrations: [1] }).length > 0);
  });

  it("checks each image reference against its image and digest", () => {
    const base = {
      commit: SHA,
      images: { "fin-next-api": `sha256:${HEX("a")}` },
      static: {},
      migrations: [],
    };
    const ref = `ghcr.io/owner/fin-next-api@sha256:${HEX("a")}`;
    assert.deepEqual(manifestProblems({ ...base, imageRefs: { "fin-next-api": ref } }), []);
    for (const imageRefs of [
      {},
      { "fin-next-api": `ghcr.io/owner/fin-next-api@sha256:${HEX("b")}` },
      { "fin-next-api": `ghcr.io/owner/fin-next-edge@sha256:${HEX("a")}` },
      { "fin-next-api": `docker.io/owner/fin-next-api@sha256:${HEX("a")}` },
      { "fin-next-api": ref, "fin-next-edge": `ghcr.io/owner/fin-next-edge@sha256:${HEX("c")}` },
      "not an object",
    ]) {
      assert.ok(manifestProblems({ ...base, imageRefs }).length > 0, JSON.stringify(imageRefs));
    }
  });

  it("names the six images release.yml's matrix builds", () => {
    const text = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    const matrix = /^\s+image: \[([^\]]*)\]$/m
      .exec(text)?.[1]
      ?.split(",")
      .map((s) => s.trim());
    assert.deepEqual(matrix, RELEASE_IMAGES);
  });
});

describe("take: what the build job staged, and nothing else", () => {
  it("copies static/, source-maps/ and meta/static-build.json into release/", (t) => {
    const root = tempDir(t);
    writeTree(root, {
      [`${STAGED}/static/console/index.html`]: "<p>",
      [`${STAGED}/source-maps/console/assets/a.js.map`]: "{}",
      [`${STAGED}/meta/static-build.json`]: "{}",
    });
    assert.equal(take({ root }), 3);
    assert.ok(existsSync(join(root, "release", "static", "console", "index.html")));
    assert.ok(existsSync(join(root, "release", "meta", "static-build.json")));
  });

  it("refuses an entry no stage writes, a second meta file, a link, or a release/ already there", (t) => {
    /** @type {[string, (root: string) => void, RegExp][]} */
    const cases = [
      [
        "a previous release planted among the staged outputs",
        (root) =>
          writeTree(root, {
            [`${STAGED}/previous/manifest/release-manifest.json`]: "{}",
          }),
        /hold previous, which no stage writes/,
      ],
      [
        "a second meta file",
        (root) => writeTree(root, { [`${STAGED}/meta/static.json`]: "{}" }),
        /meta\/ holds other than static-build.json/,
      ],
      [
        "a link",
        (root) => symlinkSync("/etc/hosts", join(root, STAGED, "static", "console", "hosts")),
        /is a link/,
      ],
      [
        "a release/ already there",
        (root) => writeTree(root, { "release/x": "" }),
        /exists already/,
      ],
    ];
    for (const [what, plant, why] of cases) {
      const root = tempDir(t);
      writeTree(root, {
        [`${STAGED}/static/console/index.html`]: "<p>",
        [`${STAGED}/meta/static-build.json`]: "{}",
      });
      plant(root);
      assert.throws(() => take({ root }), why, what);
    }
  });
});

describe("release.yml", () => {
  const text = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const { root } = parseOutline("release.yml", text);
  const jobs = child(root, "jobs");
  /** @param {string} name */
  const job = (name) => {
    const node = jobs === undefined ? undefined : child(jobs, name);
    assert.ok(node !== undefined, `release.yml has the job ${name}`);
    return node;
  };
  /** @param {string} name */
  const stepTexts = (name) =>
    (child(job(name), "steps")?.children ?? []).map((s) =>
      [child(s, "uses")?.value, child(s, "run")?.value, child(s, "env")?.raw]
        .filter((v) => v !== undefined)
        .join(" "),
    );
  /** @param {string} name */
  const permissions = (name) =>
    (child(job(name), "permissions")?.children ?? []).map((c) => `${c.key}: ${c.value}`);

  it("builds the static apps in a job that holds no token, OIDC permission or attestation right", () => {
    assert.deepEqual(permissions("static-build"), ["contents: read"]);
    const steps = stepTexts("static-build");
    assert.ok(steps.some((s) => s.includes("pnpm install --frozen-lockfile")));
    assert.ok(steps.some((s) => s.includes("release-static.mjs build")));
    const yaml = text.slice(text.indexOf("  static-build:"), text.indexOf("\n  static:\n"));
    assert.doesNotMatch(yaml, /github\.token|secrets\.|GH_TOKEN|id-token|attestations/);
  });

  it("attests only in jobs that run no install, no build and no dependency code", () => {
    for (const name of ["static", "manifest"]) {
      assert.ok(permissions(name).includes("id-token: write"), name);
      for (const step of stepTexts(name)) {
        assert.doesNotMatch(
          step,
          /pnpm|install-pnpm|turbo|npm |npx|release-static\.mjs build/,
          `${name}: ${step}`,
        );
      }
    }
  });

  it("scans every artefact after the merge and before any upload or attestation", () => {
    const steps = stepTexts("static");
    const at = (/** @type {RegExp} */ pattern) => steps.findIndex((s) => pattern.test(s));
    const take = at(/release-static\.mjs take/);
    const previous = at(/release-static\.mjs previous/);
    const merge = at(/release-static\.mjs merge/);
    const scan = at(/bundle-check\.mjs --artefacts release\/static/);
    const gitleaks = at(/gitleaks-static\.sh release\/static/);
    const firstUpload = at(/actions\/upload-artifact@/);
    const attest = at(/actions\/attest@/);
    assert.ok(take >= 0 && take < previous && previous < merge, "take, previous, then merge");
    assert.ok(merge < scan && merge < gitleaks, "the scans read the merged artefacts");
    assert.ok(scan < firstUpload && gitleaks < firstUpload && firstUpload < attest);
  });

  it("names no artefact the previous-release download could take but the static outputs", () => {
    /** @param {string} value an artefact name or pattern, with this run's and the previous SHA */
    const fill = (value) =>
      value
        .replace(/^(["'])(.*)\1$/, "$2")
        .replaceAll(`${E} github.sha }}`, SHA)
        .replaceAll(`${E} steps.previous.outputs.sha }}`, SHA);
    /** @type {string[]} */
    const uploads = [];
    /** @type {string[]} */
    const patterns = [];
    for (const name of ["images", "static-build", "static", "manifest"]) {
      for (const step of child(job(name), "steps")?.children ?? []) {
        const uses = child(step, "uses")?.value ?? "";
        const withNode = child(step, "with");
        const value = (/** @type {string} */ key) =>
          withNode === undefined ? undefined : child(withNode, key)?.value;
        if (uses.startsWith("actions/upload-artifact@")) {
          const upload = fill(value("name") ?? "");
          uploads.push(
            ...(upload.includes(`${E} matrix.image }}`)
              ? RELEASE_IMAGES.map((image) => upload.replace(`${E} matrix.image }}`, image))
              : [upload]),
          );
        }
        const pattern = value("pattern");
        if (uses.startsWith("actions/download-artifact@") && pattern !== undefined) {
          if ((value("run-id") ?? "").includes("steps.previous.outputs.run_id")) {
            patterns.push(fill(pattern));
          }
        }
      }
    }
    assert.equal(patterns.length, 1, "one download takes the previous release's static outputs");
    assert.ok(uploads.length > 6 && uploads.every((u) => !u.includes(E)), uploads.join());
    // download-artifact matches a name with minimatch: `*` is any run of characters but `/`.
    const glob = new RegExp(
      `^${(patterns[0] ?? "")
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*")}$`,
    );
    const taken = uploads.filter((u) => glob.test(u)).sort();
    const outputs = RELEASE_KEYS.map((key) => `static-${key}-${SHA}`).sort();
    assert.deepEqual(taken, outputs);
  });

  it("pins each record the manifest reads to an output of the job that wrote it", () => {
    /** @param {import("../workflow-rules.mjs").OutlineNode | undefined} node */
    const pairs = (node) =>
      Object.fromEntries((node?.children ?? []).map((c) => [c.key ?? "", c.value]));
    const images = pairs(child(job("images"), "outputs"));
    const write = (child(job("manifest"), "steps")?.children ?? []).find((s) =>
      (child(s, "run")?.value ?? "").includes("release-static.mjs manifest"),
    );
    const env = pairs(write === undefined ? undefined : child(write, "env"));
    assert.equal(Object.keys(images).length, RELEASE_IMAGES.length);
    for (const image of RELEASE_IMAGES) {
      assert.equal(
        images[`record_sha256_${image}`],
        `${E} steps.build.outputs.record_sha256_${image} }}`,
        image,
      );
      assert.equal(
        env[`RECORD_SHA256_${image.toUpperCase()}`],
        `${E} needs.images.outputs.record_sha256_${image} }}`,
        image,
      );
    }
    assert.deepEqual(pairs(child(job("static"), "outputs")), {
      record_sha256: `${E} steps.record.outputs.record_sha256 }}`,
    });
    assert.equal(env.RECORD_SHA256_STATIC, `${E} needs.static.outputs.record_sha256 }}`);
    const script = readFileSync(join(ROOT, ".github", "scripts", "release-image.sh"), "utf8");
    assert.match(script, /hash="\$\(sha256sum "\$record"\)"\n\s+echo "record_sha256_\$\{IMAGE\}=/);
    assert.equal(script.match(/^\s*record_output$/gm)?.length, 2, "both records are hashed");
  });

  it("downloads each image record into its own folder, never merged into one", () => {
    const download = (child(job("manifest"), "steps")?.children ?? []).find((s) =>
      (child(s, "with") ?? s).children.some(
        (c) => c.key === "pattern" && c.value.startsWith("image-record-"),
      ),
    );
    assert.ok(download !== undefined);
    assert.equal(
      download === undefined
        ? "?"
        : child(/** @type {any} */ (child(download, "with")), "merge-multiple"),
      undefined,
    );
  });
});
