// `plan` (spec 07 §2.3.1, §10.1, §10.2) over a fixture monorepo built with git fast-import.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadEngineConfig } from "../src/config.ts";
import type { EngineConfig } from "../src/config.ts";
import { DataError } from "../src/errors.ts";
import { computePlan } from "../src/plan/plan.ts";
import type { PlanDocument, PlanResult } from "../src/plan/plan.ts";
import { CONFIG_DIR, cli } from "./helpers/cli.ts";
import { FixtureRepo, fixtureEnv, tempDir } from "./helpers/git-fixture.ts";
import type { FileChanges } from "./helpers/git-fixture.ts";
import { fixtureLayout, manifest, monorepoFiles, W } from "./helpers/monorepo.ts";

const loaded = loadEngineConfig(CONFIG_DIR);
assert.equal(loaded.ok, true);
const config = (loaded as { ok: true; value: EngineConfig }).value;

const ALL_APPS = ["console", "admin", "verify", "docs"];
const ALL_IMAGES = ["fin-next-admin", "fin-next-api", "fin-next-console", "fin-next-edge", "fin-next-verify"];
const ALL_STATIC = ["admin", "console", "docs", "selfie", "verify"];

describe("plan over the fixture monorepo", () => {
  let tmp: ReturnType<typeof tempDir>;
  let repo: FixtureRepo;
  let base: string;
  let env: Record<string, string>;

  before(() => {
    tmp = tempDir("plan");
    repo = new FixtureRepo(tmp.dir);
    base = repo.commit(null, monorepoFiles());
    env = fixtureEnv(tmp.dir);
  });
  after(() => tmp.cleanup());

  async function plan(changes: FileChanges, event = "pull_request", from: string | null = null): Promise<PlanResult> {
    const head = repo.commit(from ?? base, changes);
    return computePlan({ treeDir: tmp.dir, event, base: from ?? base, head, config, env });
  }

  function jobsOn(document: PlanDocument): string[] {
    return Object.entries(document.jobs)
      .filter(([name, value]) => name !== "e2e_shards" && value === true)
      .map(([name]) => name)
      .sort();
  }

  function assertEverything(document: PlanDocument, reason: string): void {
    assert.equal(document.everything, true);
    assert.equal(document.reason, reason);
    assert.deepEqual(jobsOn(document), ["build", "bun", "check", "containers", "db", "e2e", "seams", "static"]);
    assert.equal(document.jobs.e2e_shards, 4);
  }

  it("a docs-only change runs only check and static (and the gate)", async () => {
    const { document } = await plan({ "docs/plan/README.md": "# plan, changed\n" });
    assert.deepEqual(document.classes, ["docs"]);
    assert.equal(document.everything, false);
    assert.equal(document.reason, "classes");
    assert.deepEqual(jobsOn(document), ["check", "static"]);
    assert.equal(document.jobs.e2e_shards, 0);
    assert.deepEqual(document.e2e, { apps: [], shards: 0 });
    assert.equal(document.tier, "D");
    assert.deepEqual([document.packages, document.images, document.static], [[], [], []]);
    assert.equal(document.changed, 1);
    assert.equal(document.layout, "ok");
  });

  it("names with spaces, quotes, tabs, newlines and non-ASCII letters survive", async () => {
    const names = [
      "docs/plan/with space.md",
      'docs/plan/"quoted".md',
      "docs/plan/tab\there.md",
      "docs/plan/line\nbreak.md",
      "docs/plan/ünïcödé.md",
      "README two.md",
    ];
    const result = await plan(Object.fromEntries(names.map((name) => [name, `${name}\n`])));
    assert.deepEqual(result.files.map((file) => file.path).sort(), [...names].sort());
    assert.deepEqual(result.document.classes, ["docs"]);
    assert.equal(result.document.changed, names.length);
    assert.equal(result.document.tier, "S", "README two.md is not a root file the layout lists, so it is unmapped for tiers");
  });

  for (const path of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    "tsconfig.base.json",
    "biome.json",
    ".node-version",
    "tools/layout.json",
    "package.json",
    "vitest.config.ts",
    "playwright.config.ts",
    "compose.yaml",
    ".github/workflows/ci.yml",
    "tools/fin-review/src/main.ts",
    "docs/review/README.md",
  ]) {
    it(`T-RV-22: the global input ${path} runs everything`, async () => {
      const content = path === "tools/layout.json" ? fixtureLayout().replace('"version": 1', '"version": 1, "note": "x"') : path.endsWith(".json") ? "{}\n" : "x\n";
      const { document } = await plan({ [path]: content });
      assertEverything(document, "global");
      assert.ok(document.classes.includes("global"));
      assert.deepEqual(document.e2e.apps, ALL_APPS);
      assert.deepEqual(document.images, ALL_IMAGES);
      assert.deepEqual(document.static, ALL_STATIC);
      assert.ok(document.packages.includes("@fin/core") && document.packages.includes("@fin/console"));
    });
  }

  it("T-RV-22: a planted unmapped path runs everything", async () => {
    const { document } = await plan({ "planted/unmapped.ts": "export {};\n" });
    assertEverything(document, "unmapped");
    assert.deepEqual(document.classes, ["unmapped"]);
    assert.equal(document.tier, "S");
  });

  it("a folder under apps/ or packages/ that is no package runs everything", async () => {
    const { document } = await plan({ "apps/ghost/src/main.ts": "export {};\n" });
    assertEverything(document, "workspace");
    const nested = await plan({ "packages/notes.txt": "x\n" });
    assert.equal(nested.document.everything, true);
  });

  it("a server package change runs check, build, seams and the e2e of the apps that depend on it", async () => {
    const { document } = await plan({ "packages/core/src/index.ts": "export const core = 2;\n" });
    assert.deepEqual(document.classes, ["server"]);
    assert.equal(document.everything, false);
    assert.deepEqual(jobsOn(document), ["build", "bun", "check", "e2e", "seams", "static"]);
    assert.deepEqual(document.e2e, { apps: ["console", "admin", "verify"], shards: 4 });
    assert.equal(document.tier, "S");
    assert.deepEqual(document.packages, [
      "@fin/admin",
      "@fin/api",
      "@fin/console",
      "@fin/contract",
      "@fin/core",
      "@fin/crypto",
      "@fin/db",
      "@fin/edge",
      "@fin/kyc",
      "@fin/money",
      "@fin/ops-fin",
      "@fin/server",
      "@fin/testing",
      "@fin/verify",
    ]);
    assert.deepEqual(document.images, ALL_IMAGES);
    assert.deepEqual(document.static, ["admin", "console", "selfie", "verify"]);
  });

  it("the db job runs when a changed package depends on @fin/db or holds a *.db.test.ts", async () => {
    const money = await plan({ "packages/money/src/ledger.ts": "export const ledger = 2;\n" });
    assert.equal(money.document.jobs.db, true);
    assert.equal(money.document.jobs.e2e, false, "no web app depends on @fin/money");
    assert.deepEqual(money.document.packages, ["@fin/api", "@fin/money"]);
    assert.deepEqual(money.document.images, ["fin-next-api"]);
    const kyc = await plan({ "packages/kyc/src/flow.ts": "export const flow = 2;\n" });
    assert.equal(kyc.document.jobs.db, true);
    const crypto = await plan({ "packages/crypto/src/index.ts": "export const crypto = 2;\n" });
    assert.equal(crypto.document.jobs.db, false);
  });

  it("the db class runs db and every app's e2e", async () => {
    const { document } = await plan({ "packages/db/src/schema.ts": "export const schema = 2;\n" });
    assert.deepEqual(document.classes, ["db", "server"]);
    assert.deepEqual(jobsOn(document), ["build", "bun", "check", "db", "e2e", "seams", "static"]);
    assert.deepEqual(document.e2e.apps, ALL_APPS);
    const dbTest = await plan({ "packages/kyc/src/flow.db.test.ts": "export const x = 1;\n" });
    assert.deepEqual(dbTest.document.classes, ["db", "server"]);
    assert.equal(dbTest.document.jobs.db, true);
  });

  it("a client change runs check, build and that app's e2e, without seams or db", async () => {
    const { document } = await plan({ "apps/console/src/client/main.tsx": "export const x = 1;\n" });
    assert.deepEqual(document.classes, ["client"]);
    assert.deepEqual(jobsOn(document), ["build", "check", "e2e", "static"]);
    assert.deepEqual(document.e2e.apps, ["console"]);
    assert.equal(document.tier, "N");
    assert.deepEqual(document.static, ["console"]);
  });

  it("a design-system package runs every app's e2e; the app contracts run their dependents", async () => {
    const ui = await plan({ "packages/ui/src/button.tsx": "export const b = 1;\n" });
    assert.deepEqual(ui.document.classes, ["client"]);
    assert.deepEqual(ui.document.e2e.apps, ALL_APPS);
    assert.equal(ui.document.jobs.bun, true);
    assert.equal(ui.document.jobs.seams, false);
    const contracts = await plan({ "packages/app-contracts/src/index.ts": "export const c = 1;\n" });
    assert.deepEqual(contracts.document.e2e.apps, ["admin"]);
  });

  it("the contract runs static and the docs and console e2e", async () => {
    const { document } = await plan({ "packages/contract/src/openapi.ts": "export const o = 1;\n" });
    assert.deepEqual(document.classes, ["server", "contract"]);
    assert.deepEqual(document.e2e.apps, ["console", "docs"]);
    assert.equal(document.jobs.static, true);
  });

  it("the testing harness runs every app's e2e", async () => {
    const { document } = await plan({ "packages/testing/src/index.ts": "export const t = 1;\n" });
    assert.deepEqual(document.e2e.apps, ALL_APPS);
  });

  it("docker files run build, seams and containers, and every image", async () => {
    const { document } = await plan({ "ops/docker/app.Dockerfile": "FROM scratch\nUSER 1001\n" });
    assert.deepEqual(document.classes, ["docker"]);
    assert.deepEqual(jobsOn(document), ["build", "check", "containers", "seams", "static"]);
    assert.deepEqual(document.images, ALL_IMAGES);
    assert.equal(document.jobs.e2e, false);
  });

  it("ops and scripts run only check and static", async () => {
    for (const path of ["ops/fin/src/main.ts", "scripts/check.mjs"]) {
      const { document } = await plan({ [path]: "export const changed = 1;\n" });
      assert.deepEqual(jobsOn(document), ["check", "static"], path);
      assert.equal(document.tier, "S", path);
    }
  });

  it("a rename counts at its old and its new path, for tiers and classes", async () => {
    const guide = "# A guide long enough to be found as a rename\n".repeat(20);
    const withGuide = repo.commit(base, { "packages/core/src/guide.md": guide });
    const moved = await plan({ "packages/core/src/guide.md": null, "docs/plan/guide.md": guide }, "pull_request", withGuide);
    assert.equal(moved.document.changed, 1);
    assert.deepEqual(
      moved.files.map((file) => [file.status, file.side, file.path, file.tier]),
      [
        ["R", "new", "docs/plan/guide.md", "D"],
        ["R", "old", "packages/core/src/guide.md", "S"],
      ],
    );
    assert.equal(moved.document.tier, "S", "the old path's tier S counts");
    assert.deepEqual(moved.document.classes, ["docs", "server"]);
    assert.ok(moved.document.packages.includes("@fin/core"));
  });

  it("a deletion counts at its old path, and a deleted package keeps its dependents from the base", async () => {
    const removed = await plan({ "apps/admin/src/server/main.ts": null });
    assert.deepEqual(removed.files.map((file) => [file.status, file.path]), [["D", "apps/admin/src/server/main.ts"]]);
    assert.equal(removed.document.tier, "S");
    assert.deepEqual(removed.document.e2e.apps, ["admin"]);
    const gone = await plan({ "packages/crypto/package.json": null, "packages/crypto/src/index.ts": null });
    assert.equal(gone.document.everything, false, "a package deleted whole is still a package at the base");
    assert.deepEqual(gone.document.packages, ["@fin/crypto"]);
  });

  it("an edge present at the base or the head counts", async () => {
    // The branch starts where @fin/server did not depend on @fin/core; main adds that edge later.
    // The diff (merge base to head) shows only the core change, and only the base has the edge.
    const mergeBase = repo.commit(base, { "packages/server/package.json": manifest("@fin/server") });
    const mainNow = repo.commit(mergeBase, { "packages/server/package.json": manifest("@fin/server", { "@fin/core": W }) });
    const head = repo.commit(mergeBase, { "packages/core/src/index.ts": "export const core = 3;\n" });
    const viaBase = await computePlan({ treeDir: tmp.dir, event: "pull_request", base: mainNow, head, config, env });
    assert.deepEqual(viaBase.files.map((file) => file.path), ["packages/core/src/index.ts"]);
    assert.ok(viaBase.document.packages.includes("@fin/server"), "server depends on core at the base");
    assert.ok(viaBase.document.e2e.apps.includes("console"));
    const headOnly = await computePlan({ treeDir: tmp.dir, event: "pull_request", base: mergeBase, head, config, env });
    assert.ok(!headOnly.document.packages.includes("@fin/server"), "with the edge on neither side, server is not affected");
    const addEdge = await plan({ "packages/crypto/package.json": manifest("@fin/crypto", { "@fin/core": W, "@fin/tokens": W }) });
    assert.deepEqual(addEdge.document.packages, ["@fin/crypto"]);
  });

  it("tiers come from the base's layout, so a pull request cannot lower its own tier", async () => {
    const lowered = fixtureLayout().replace('{ "path": "packages/core", "name": "@fin/core", "kind": "package", "status": "active", "tier": "S" }', '{ "path": "packages/core", "name": "@fin/core", "kind": "package", "status": "active", "tier": "D" }');
    assert.notEqual(lowered, fixtureLayout());
    const result = await plan({ "tools/layout.json": lowered, "packages/core/src/index.ts": "export const core = 4;\n" });
    const core = result.files.find((file) => file.path === "packages/core/src/index.ts");
    assert.equal(core?.tier, "S");
    assert.equal(result.document.tier, "S");
  });

  it("a missing or invalid layout makes every path S and runs everything", async () => {
    const noLayout = repo.commit(base, { "tools/layout.json": null });
    const missing = await plan({ "docs/plan/README.md": "x\n" }, "pull_request", noLayout);
    assertEverything(missing.document, "layout");
    assert.equal(missing.document.layout, "missing");
    assert.equal(missing.document.tier, "S");
    assert.deepEqual(missing.document.images, []);
    assert.match(missing.layoutProblems[0] ?? "", /not in the tree/);
    for (const text of ["{ not json", '{"version": 2, "controlPaths": [], "entries": []}', '{"version":1,"version":1}']) {
      const badLayout = repo.commit(base, { "tools/layout.json": text });
      const invalid = await plan({ "docs/plan/README.md": "y\n" }, "pull_request", badLayout);
      assertEverything(invalid.document, "layout");
      assert.equal(invalid.document.layout, "invalid", text);
    }
  });

  it("an invalid manifest runs everything", async () => {
    for (const text of ["{ broken", '{"private": true}', '{"name": "@fin/console", "dependencies": []}', '{"name":"a","name":"b"}']) {
      const { document, workspaceProblem } = await plan({ "apps/console/package.json": text });
      assertEverything(document, "workspace");
      assert.notEqual(workspaceProblem, null, text);
    }
    const twice = await plan({ "packages/crypto/package.json": manifest("@fin/core") });
    assertEverything(twice.document, "workspace");
  });

  it("push to main and workflow_dispatch run everything", async () => {
    const head = repo.commit(base, { "docs/plan/README.md": "z\n" });
    const push = await computePlan({ treeDir: tmp.dir, event: "push", base, head, config, env });
    assertEverything(push.document, "event");
    assert.equal(push.document.tier, "D", "the diff is still read for the tier");
    const dispatch = await computePlan({ treeDir: tmp.dir, event: "workflow_dispatch", base: null, head, config, env });
    assertEverything(dispatch.document, "event");
    assert.equal(dispatch.document.tier, "S");
    assert.equal(dispatch.document.changed, 0);
    assert.equal(dispatch.document.base, null);
    assert.equal(dispatch.document.layout, "ok", "with no base the head's layout is read");
    const rewritten = await computePlan({ treeDir: tmp.dir, event: "push", base: "3".repeat(40), head, config, env });
    assertEverything(rewritten.document, "event");
    assert.equal(rewritten.document.base, null);
    assert.deepEqual(rewritten.notes, [`base ${"3".repeat(40)} is not a commit here; planning the push without a diff`]);
  });

  it("an empty diff runs check and static", async () => {
    const { document } = await plan({});
    assert.deepEqual(jobsOn(document), ["check", "static"]);
    assert.equal(document.tier, null);
    assert.equal(document.changed, 0);
  });

  it("is deterministic: the same base and head give the same document", async () => {
    const head = repo.commit(base, { "packages/core/src/index.ts": "export const core = 9;\n", "docs/plan/x.md": "x\n" });
    const first = await computePlan({ treeDir: tmp.dir, event: "pull_request", base, head, config, env });
    const second = await computePlan({ treeDir: tmp.dir, event: "pull_request", base, head, config, env });
    assert.deepEqual(first.document, second.document);
    assert.deepEqual(Object.keys(first.document), ["v", "event", "base", "head", "tier", "changed", "classes", "everything", "reason", "jobs", "e2e", "packages", "images", "static", "layout"]);
    assert.deepEqual(Object.keys(first.document.jobs), ["check", "db", "build", "seams", "e2e", "e2e_shards", "static", "bun", "containers"]);
  });

  it("ignores the caller's GIT_* variables", async () => {
    const head = repo.commit(base, { "docs/plan/README.md": "env\n" });
    const hostile = { ...env, GIT_DIR: "/nonexistent", GIT_WORK_TREE: "/nonexistent", GIT_EXTERNAL_DIFF: "false" };
    const result = await computePlan({ treeDir: tmp.dir, event: "pull_request", base, head, config, env: hostile });
    assert.deepEqual(result.document.classes, ["docs"]);
  });

  it("refuses a base or head that is not a commit here", async () => {
    await assert.rejects(
      computePlan({ treeDir: tmp.dir, event: "pull_request", base: "1".repeat(40), head: base, config, env }),
      (error: unknown) => error instanceof DataError && /base 1{40} is not a commit/.test(error.message),
    );
    const tree = repo.git(["rev-parse", `${base}^{tree}`]).trim();
    await assert.rejects(computePlan({ treeDir: tmp.dir, event: "pull_request", base, head: tree, config, env }), DataError);
    await assert.rejects(computePlan({ treeDir: tmp.dir, event: "pull_request", base: null, head: base, config, env }), TypeError);
    await assert.rejects(computePlan({ treeDir: tmp.dir, event: "Pull Request", base, head: base, config, env }), TypeError);
  });

  describe("the plan command", () => {
    it("prints the document as one line on stdout", async () => {
      const head = repo.commit(base, { "docs/plan/README.md": "cli\n" });
      const run = await cli(["plan", "--base", base, "--head", head, "--tree", tmp.dir], { env });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stdout.split("\n").length, 2);
      const document = JSON.parse(run.stdout) as PlanDocument;
      assert.equal(document.event, "local");
      assert.deepEqual(document.classes, ["docs"]);
      const equals = await cli(["plan", `--base=${base}`, `--head=${head}`, `--tree=${tmp.dir}`], { env });
      assert.equal(equals.stdout, run.stdout);
    });

    it("--ci reads EVENT_NAME, BASE_SHA and HEAD_SHA and appends plan=<json> to --output", async () => {
      const head = repo.commit(base, { "packages/ui/src/button.tsx": "export const b = 2;\n" });
      const output = join(tmp.dir, "github-output");
      writeFileSync(output, "earlier=1\n");
      const run = await cli(["plan", "--ci", "--tree", tmp.dir, "--output", output], {
        env: { ...env, EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head },
      });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stdout, "");
      const lines = readFileSync(output, "utf8").split("\n");
      assert.equal(lines[0], "earlier=1");
      assert.match(lines[1] ?? "", /^plan=\{/);
      assert.equal(lines[2], "");
      const document = JSON.parse((lines[1] ?? "").slice("plan=".length)) as PlanDocument;
      assert.equal(document.event, "pull_request");
      assert.deepEqual(document.e2e.apps, ALL_APPS);
      assert.ok(Buffer.byteLength(lines[1] ?? "") <= 64 * 1024);
    });

    it("--ci on push with a zero base, and on workflow_dispatch with no base, runs everything", async () => {
      for (const [event, baseSha] of [
        ["push", "0".repeat(40)],
        ["workflow_dispatch", ""],
        ["schedule", ""],
      ] as const) {
        const run = await cli(["plan", "--ci", "--tree", tmp.dir], { env: { ...env, EVENT_NAME: event, BASE_SHA: baseSha, HEAD_SHA: base } });
        assert.equal(run.code, 0, run.stderr);
        const document = JSON.parse(run.stdout) as PlanDocument;
        assert.equal(document.everything, true, event);
        assert.equal(document.reason, "event");
      }
    });

    it("refuses bad arguments with exit 64 before reading git", async () => {
      const cases: Array<[string[], Record<string, string>, RegExp]> = [
        [["plan", "--head", base], {}, /missing_option: plan needs --base/],
        [["plan", "--base", base], {}, /missing_option: plan needs --head/],
        [["plan", "--base", base.toUpperCase(), "--head", base], {}, /invalid_value: The base/],
        [["plan", "--base", base.slice(0, 7), "--head", base], {}, /invalid_value: The base/],
        [["plan", "--base", "HEAD", "--head", base], {}, /invalid_value: The base/],
        [["plan", "--base", `${base};rm`, "--head", base], {}, /invalid_value: The base/],
        [["plan", "--base", base, "--head", base, "--output", "x"], {}, /invalid_value: --output is only for --ci/],
        [["plan", "--base", base, "--head", base, "--tree", join(tmp.dir, "missing")], {}, /invalid_value: --tree is not a directory/],
        [["plan", "--base", base, "--base", base, "--head", base], {}, /duplicate_option: --base/],
        [["plan", "--base", base, "--head", base, "--cold"], {}, /unknown_option: Unknown option "--cold"/],
        [["plan", "--base", base, "--head", base, "--model", "opus"], {}, /unknown_option: Unknown option "--model"/],
        [["plan", "--base", base, "--head", base, "extra"], {}, /unknown_option: Unexpected argument "extra"/],
        [["plan", "--ci", "--ci"], {}, /duplicate_option: --ci/],
        [["plan", "--ci=yes"], {}, /wrong_type: --ci is a flag/],
        [["plan", "--ci"], { BASE_SHA: base, HEAD_SHA: base }, /missing_option: --ci needs EVENT_NAME/],
        [["plan", "--ci"], { EVENT_NAME: "Pull Request", BASE_SHA: base, HEAD_SHA: base }, /invalid_value: EVENT_NAME/],
        [["plan", "--ci"], { EVENT_NAME: "pull_request", HEAD_SHA: base }, /missing_option: A pull_request plan needs BASE_SHA/],
        [["plan", "--ci"], { EVENT_NAME: "pull_request", BASE_SHA: base }, /missing_option: plan --ci needs HEAD_SHA/],
        [["plan", "--ci"], { EVENT_NAME: "pull_request", BASE_SHA: "0".repeat(40), HEAD_SHA: base }, /missing_option/],
      ];
      for (const [argv, extraEnv, pattern] of cases) {
        const run = await cli([...argv, ...(argv.includes("--tree") ? [] : ["--tree", tmp.dir])], { env: { ...env, ...extraEnv } });
        assert.equal(run.code, 64, `${JSON.stringify(argv)}: ${run.stderr}`);
        assert.match(run.stderr, pattern, JSON.stringify(argv));
        assert.equal(run.stdout, "");
      }
    });

    it("exits 65 for a SHA that is not a commit in the tree", async () => {
      const run = await cli(["plan", "--base", "2".repeat(40), "--head", base, "--tree", tmp.dir], { env });
      assert.equal(run.code, 65);
      assert.match(run.stderr, /^fin-review: error: base 2{40} is not a commit/);
    });

    it("exits 70 when the tree is not a git repository", async () => {
      const empty = tempDir("not-git");
      try {
        const run = await cli(["plan", "--base", base, "--head", base, "--tree", empty.dir], { env: fixtureEnv(empty.dir) });
        assert.equal(run.code, 70);
        assert.match(run.stderr, /^fin-review: error: git cat-file failed/);
      } finally {
        empty.cleanup();
      }
    });

    it("reports layout problems on stderr and still plans", async () => {
      const noLayout = repo.commit(base, { "tools/layout.json": null });
      const head = repo.commit(noLayout, { "README.md": "# changed\n" });
      const run = await cli(["plan", "--base", noLayout, "--head", head, "--tree", tmp.dir], { env });
      assert.equal(run.code, 0);
      assert.equal(run.stderr, "fin-review: plan: layout: tools/layout.json is not in the tree\n");
      assert.equal((JSON.parse(run.stdout) as PlanDocument).reason, "layout");
    });
  });
});
