// release-static: the static outputs, staging and map strip, FW-C13's carry and its test, the
// asset manifest hash the deploy compares, the previous-release lookup and the manifest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assetHash,
  assetManifestHash,
  build,
  carryAssets,
  digestHex,
  findPreviousRelease,
  manifestProblems,
  merge,
  previousOwnAssets,
  readImageRecords,
  readMigrations,
  record,
  stageOutput,
  staticOutputs,
  writeManifest,
} from "../release-static.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHA = "1".repeat(40);
const PREV = "2".repeat(40);
const REPO = "owner/fin-next";
const HEX = (/** @type {string} */ c) => c.repeat(64);

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

  it("refuses an asset path from a manifest that could leave assets/", (t) => {
    const prev = tempDir(t);
    for (const bad of [
      "/assets/../../etc/passwd",
      "/index.html",
      "assets/a.js",
      "/assets/./a.js",
      "/assets/a b.js",
      7,
    ]) {
      const manifest = { static: { console: { ownAssets: [bad] } } };
      assert.throws(() => previousOwnAssets(manifest, "console", prev), /refused/, String(bad));
    }
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
    const merged = merge({ root, env: { ...env, PREVIOUS_SHA: PREV } });
    assert.deepEqual(/** @type {any} */ (merged.console).carried, ["/assets/app-1.js"]);
    assert.deepEqual(/** @type {any} */ (merged.console).ownAssets, ["/assets/app-2.js"]);
    assert.equal(/** @type {any} */ (merged.console).carriedFrom, PREV);
    assert.equal(/** @type {any} */ (merged.verify).carriedFrom, null);
    assert.ok(existsSync(join(root, "release", "static", "console", "assets", "app-1.js")));
    assert.ok(!existsSync(join(root, "release", "static", "console", "assets", "app-0.js")));

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

    writeTree(root, {
      "release/images/fin-next-api.json": JSON.stringify({
        image: "fin-next-api",
        built: true,
        ref: "ghcr.io/owner/fin-next-api",
        digest: `sha256:${HEX("e")}`,
      }),
      "release/images/fin-next-edge.json": JSON.stringify({
        image: "fin-next-edge",
        built: false,
        why: "ops/docker/app.Dockerfile is not on main yet",
      }),
    });
    const manifest = writeManifest({ root, env, now: () => new Date("2026-11-21T12:00:00Z") });
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
    assert.deepEqual(onDisk.skipped.images, [
      { image: "fin-next-edge", why: "ops/docker/app.Dockerfile is not on main yet" },
    ]);
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
    const env = { GITHUB_OUTPUT: join(root, "out.txt"), GITHUB_SHA: SHA };
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
    const manifest = writeManifest({ root, env });
    assert.deepEqual(manifest.images, {});
    assert.deepEqual(manifest.static, {});
    assert.deepEqual(manifest.migrations, []);
    assert.equal(manifest.minimumSchemaVersion, null);
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
});

describe("the manifest's pieces", () => {
  it("reads an upload digest as hex, with or without its prefix", () => {
    assert.equal(digestHex(HEX("a")), HEX("a"));
    assert.equal(digestHex(`sha256:${HEX("a")}`), HEX("a"));
    for (const bad of [undefined, "", "sha256:xyz", HEX("A")]) assert.equal(digestHex(bad), null);
  });

  it("refuses a malformed image record", (t) => {
    const dir = tempDir(t);
    writeTree(dir, {
      "a.json": JSON.stringify({
        image: "fin-next-api",
        built: true,
        ref: "ghcr.io/o/fin-next-api",
        digest: "sha256:abc",
      }),
    });
    assert.throws(() => readImageRecords(dir), /not sha256/);
    writeTree(dir, { "a.json": JSON.stringify({ image: "other", built: false }) });
    assert.throws(() => readImageRecords(dir), /not an image record/);
    writeTree(dir, {
      "a.json": JSON.stringify({
        image: "fin-next-api",
        built: true,
        ref: "docker.io/x",
        digest: `sha256:${HEX("a")}`,
      }),
    });
    assert.throws(() => readImageRecords(dir), /not on ghcr.io/);
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
});
