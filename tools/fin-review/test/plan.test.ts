// `plan` (spec 07 §2.3.1, §10.1, §10.2) over a fixture monorepo built with git fast-import.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { EngineConfig } from "../src/config.ts";
import { loadEngineConfig } from "../src/config.ts";
import { DataError } from "../src/errors.ts";
import { linkTarget } from "../src/plan/links.ts";
import type { PlanDocument, PlanResult } from "../src/plan/plan.ts";
import { computePlan } from "../src/plan/plan.ts";
import { CONFIG_DIR, cli } from "./helpers/cli.ts";
import type { FileChanges, SpecialEntry } from "./helpers/git-fixture.ts";
import { FixtureRepo, fixtureEnv, tempDir } from "./helpers/git-fixture.ts";
import { fixtureLayout, layoutWith, manifest, monorepoFiles, W } from "./helpers/monorepo.ts";

const loaded = loadEngineConfig(CONFIG_DIR);
assert.equal(loaded.ok, true);
const config = (loaded as { ok: true; value: EngineConfig }).value;

const ALL_APPS = ["console", "admin", "verify", "docs"];
const VARIANTS = ["desktop", "phone", "dark", "reduced", "firefox", "webkit"];
/** The packages that exist: the fixture layout's planned payments, connector and backup entries have none. */
const ALL_IMAGES = [
  "fin-next-admin",
  "fin-next-api",
  "fin-next-console",
  "fin-next-edge",
  "fin-next-verify",
];
const ALL_STATIC = ["admin", "console", "docs", "selfie", "verify"];

function projectsOf(apps: readonly string[]): string[] {
  return apps.flatMap((app) => VARIANTS.map((variant) => `${app}-${variant}`));
}

function e2eOf(apps: readonly string[], shards = 4): PlanDocument["e2e"] {
  return { apps: [...apps], projects: projectsOf(apps), shards };
}

/** Lines a GitHub runner or a terminal could act on: a workflow command or a control character. */
function assertInert(text: string): void {
  assert.match(text, /^[\x20-\x7e\n]*$/, "only printable ASCII and line ends");
  for (const line of text.split("\n")) assert.ok(!line.startsWith("::"), line);
}

describe("plan over the fixture monorepo", () => {
  let tmp: ReturnType<typeof tempDir>;
  let repo: FixtureRepo;
  let base: string;
  let env: Record<string, string>;

  before(() => {
    tmp = tempDir("plan");
    repo = new FixtureRepo(tmp.dir);
    // As on a Linux runner, so a fixture can hold paths that differ only by case.
    repo.git(["config", "core.ignorecase", "false"]);
    base = repo.commit(null, monorepoFiles());
    env = fixtureEnv(tmp.dir);
  });
  after(() => tmp.cleanup());

  async function plan(
    changes: FileChanges,
    event = "pull_request",
    from: string | null = null,
  ): Promise<PlanResult> {
    const head = repo.commit(from ?? base, changes);
    return computePlan({ treeDir: tmp.dir, event, base: from ?? base, head, config, env });
  }

  /** The CI build jobs that are on (review and selfTest are checked on their own). */
  function jobsOn(document: PlanDocument): string[] {
    return Object.entries(document.jobs)
      .filter(
        ([name, value]) => !["e2e_shards", "review", "selfTest"].includes(name) && value === true,
      )
      .map(([name]) => name)
      .sort();
  }

  function assertEverything(document: PlanDocument, reason: string): void {
    assert.equal(document.everything, true);
    assert.equal(document.reason, reason);
    assert.deepEqual(jobsOn(document), [
      "build",
      "bun",
      "check",
      "containers",
      "db",
      "e2e",
      "seams",
      "static",
    ]);
    assert.equal(document.jobs.e2e_shards, 4);
    assert.equal(document.jobs.review, false);
  }

  it("a docs-only change runs only check and static (and the gate)", async () => {
    const { document } = await plan({ "docs/plan/README.md": "# plan, changed\n" });
    assert.deepEqual(document.classes, ["docs"]);
    assert.equal(document.everything, false);
    assert.equal(document.reason, "classes");
    assert.deepEqual(jobsOn(document), ["check", "static"]);
    assert.equal(document.jobs.e2e_shards, 0);
    assert.equal(document.jobs.selfTest, false);
    assert.deepEqual(document.e2e, { apps: [], projects: [], shards: 0 });
    assert.equal(document.tier, "D");
    assert.deepEqual([document.packages, document.images, document.static], [[], [], []]);
    assert.equal(document.changed, 1);
    assert.equal(document.layout, "ok");
  });

  it("names with spaces, quotes, tabs, newlines and non-ASCII letters survive; a name outside printable ASCII runs everything", async () => {
    const plain = ["docs/plan/with space.md", 'docs/plan/"quoted".md', "README two.md"];
    const notPlain = ["docs/plan/tab\there.md", "docs/plan/line\nbreak.md", "docs/plan/ünïcödé.md"];
    const names = [...plain, ...notPlain];
    const result = await plan(Object.fromEntries(names.map((name) => [name, `${name}\n`])));
    assert.deepEqual(result.files.map((file) => file.path).sort(), [...names].sort());
    assert.equal(result.document.changed, names.length);
    const placed = (path: string): unknown[] => {
      const file = result.files.find((candidate) => candidate.path === path);
      return [file?.tier, file?.tierSource, file?.classes];
    };
    assert.deepEqual(placed("docs/plan/with space.md"), ["D", "entry", ["docs"]]);
    assert.deepEqual(placed('docs/plan/"quoted".md'), ["D", "entry", ["docs"]]);
    assert.deepEqual(
      placed("README two.md"),
      ["S", "unmapped", ["docs"]],
      "not a root file the layout lists, so unmapped for tiers",
    );
    for (const path of notPlain)
      assert.deepEqual(placed(path), ["S", "not-plain", ["unmapped"]], JSON.stringify(path));
    assertEverything(result.document, "unmapped");
    assert.equal(result.document.tier, "S");
    assert.equal(
      result.document.jobs.selfTest,
      true,
      "a name that is not plain may be the engine's own on the build machine",
    );
  });

  it("a look-alike letter that a case-folding disk reads as ASCII is tier S and runs everything, self-test included", async () => {
    // U+017F (long s) is s, and U+212A (Kelvin sign) is k, on the build machine's disk.
    const paths = [
      "apps/console/src/ſerver/main.ts", // the server code of a web app (tier S there)
      "apps/console/ſtatic.json", // a control path
      "packages/core/turbo.jſon", // a global input
      "pacKages/core/src/index.ts",
      "apps/admin/src/server/Keys.ts",
      "docs/plan/Kelvin.md",
    ];
    const { files } = await plan(
      Object.fromEntries(paths.map((path) => [path, "export const x = 1;\n"])),
    );
    for (const path of paths) {
      const file = files.find((candidate) => candidate.path === path);
      assert.deepEqual(
        [file?.tier, file?.tierSource, file?.classes],
        ["S", "not-plain", ["unmapped"]],
        path,
      );
    }
    // Alone, each runs everything; the engine's procedure (under the docs class's exclusion) shows it.
    const { document } = await plan({ "docſ/review/prompts/system.md": "# system\n" });
    assertEverything(document, "unmapped");
    assert.equal(document.tier, "S");
    assert.equal(document.jobs.selfTest, true);
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
      const content =
        path === "tools/layout.json"
          ? fixtureLayout().replace('"version": 1', '"version": 1, "note": "x"')
          : path.endsWith(".json")
            ? "{}\n"
            : "x\n";
      const { document } = await plan({ [path]: content });
      assertEverything(document, "global");
      assert.ok(document.classes.includes("global"));
      assert.deepEqual(document.e2e, e2eOf(ALL_APPS));
      assert.deepEqual(document.images, ALL_IMAGES);
      assert.deepEqual(document.static, ALL_STATIC);
      assert.ok(
        document.packages?.includes("@fin/core") && document.packages.includes("@fin/console"),
      );
      assert.equal(
        document.jobs.selfTest,
        path.startsWith("tools/fin-review/") || path.startsWith("docs/review/"),
        "selfTest follows the engine's own paths",
      );
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
    assert.deepEqual(document.e2e, e2eOf(["console", "admin", "verify"]));
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
    const { document } = await plan({
      "apps/console/src/client/main.tsx": "export const x = 1;\n",
    });
    assert.deepEqual(document.classes, ["client"]);
    assert.deepEqual(jobsOn(document), ["build", "check", "e2e", "static"]);
    assert.deepEqual(document.e2e, e2eOf(["console"]));
    assert.equal(document.tier, "N");
    assert.deepEqual(document.static, ["console"]);
  });

  it("a service app's client-shaped path is server code: db and seams run", async () => {
    // apps/api reaches @fin/db through @fin/money; apps/edge does not.
    for (const path of [
      "apps/api/src/client/provider.ts",
      "apps/api/public/hook.js",
      "apps/api/index.html",
      "apps/api/_headers",
    ]) {
      const { document } = await plan({ [path]: "export const changed = 1;\n" });
      assert.deepEqual(document.classes, ["server", "client"], path);
      assert.equal(document.jobs.db, true, path);
      assert.equal(document.jobs.seams, true, path);
      assert.equal(document.tier, "S", path);
    }
    for (const path of ["apps/edge/src/client/upstream.ts", "apps/edge/public/robots.txt"]) {
      const { document } = await plan({ [path]: "x\n" });
      assert.deepEqual(document.classes, ["server", "client"], path);
      assert.equal(document.jobs.seams, true, path);
    }
  });

  it("a design-system package runs every app's e2e; the app contracts run their dependents", async () => {
    const ui = await plan({ "packages/ui/src/button.tsx": "export const b = 1;\n" });
    assert.deepEqual(ui.document.classes, ["client"]);
    assert.deepEqual(ui.document.e2e.apps, ALL_APPS);
    assert.equal(ui.document.jobs.bun, true);
    assert.equal(ui.document.jobs.seams, false);
    const contracts = await plan({
      "packages/app-contracts/src/index.ts": "export const c = 1;\n",
    });
    assert.deepEqual(contracts.document.e2e.apps, ["admin"]);
  });

  it("the contract runs static and the docs and console e2e", async () => {
    const { document } = await plan({
      "packages/contract/src/openapi.ts": "export const o = 1;\n",
    });
    assert.deepEqual(document.classes, ["server", "contract"]);
    assert.deepEqual(document.e2e.apps, ["console", "docs"]);
    assert.equal(document.jobs.static, true);
  });

  it("the testing harness runs every app's e2e", async () => {
    const { document } = await plan({ "packages/testing/src/index.ts": "export const t = 1;\n" });
    assert.deepEqual(document.e2e.apps, ALL_APPS);
  });

  it("docker files run build, seams and containers, and every image that exists", async () => {
    const { document } = await plan({ "ops/docker/app.Dockerfile": "FROM scratch\nUSER 1001\n" });
    assert.deepEqual(document.classes, ["docker"]);
    assert.deepEqual(jobsOn(document), ["build", "check", "containers", "seams", "static"]);
    assert.deepEqual(
      document.images,
      ALL_IMAGES,
      "planned entries with no package have no image to build",
    );
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
    const moved = await plan(
      { "packages/core/src/guide.md": null, "docs/plan/guide.md": guide },
      "pull_request",
      withGuide,
    );
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
    assert.ok(moved.document.packages?.includes("@fin/core"));
  });

  it("a deletion counts at its old path, and a deleted package keeps its dependents from the base", async () => {
    const removed = await plan({ "apps/admin/src/server/main.ts": null });
    assert.deepEqual(
      removed.files.map((file) => [file.status, file.path]),
      [["D", "apps/admin/src/server/main.ts"]],
    );
    assert.equal(removed.document.tier, "S");
    assert.deepEqual(removed.document.e2e.apps, ["admin"]);
    const gone = await plan({
      "packages/crypto/package.json": null,
      "packages/crypto/src/index.ts": null,
    });
    assertEverything(gone.document, "workspace");
    assert.ok(
      gone.document.packages?.includes("@fin/crypto"),
      "a package deleted whole is still a package at the base",
    );
  });

  it("an app deleted whole runs everything and keeps its e2e, image and static output, which fail until main drops them", async () => {
    const gone = await plan({
      "apps/admin/package.json": null,
      "apps/admin/src/client/main.tsx": null,
      "apps/admin/src/server/main.ts": null,
    });
    assertEverything(gone.document, "workspace");
    assert.deepEqual(gone.document.e2e, e2eOf(ALL_APPS));
    assert.deepEqual([gone.document.images, gone.document.static], [ALL_IMAGES, ALL_STATIC]);
  });

  /** Every file of apps/console moved to apps/dashboard, with a change to its server code. */
  function consoleMoved(): Record<string, string | null> {
    const changes: Record<string, string | null> = {};
    for (const [path, content] of Object.entries(monorepoFiles())) {
      if (!path.startsWith("apps/console/")) continue;
      changes[path] = null;
      changes[`apps/dashboard/${path.slice("apps/console/".length)}`] = content;
    }
    changes["apps/dashboard/src/server/main.ts"] = "export const moved = 1;\n";
    return changes;
  }

  it("an app moved to another folder runs everything and keeps its e2e, image and static output", async () => {
    const moved = await plan(consoleMoved());
    assertEverything(moved.document, "workspace");
    assert.ok(moved.document.packages?.includes("@fin/console"));
    assert.deepEqual(
      moved.document.e2e,
      e2eOf(ALL_APPS),
      "console's e2e stays, and fails on CI rather than vanishing",
    );
    assert.deepEqual(moved.document.images, ALL_IMAGES);
    assert.deepEqual(moved.document.static, ALL_STATIC);
    // The layout entry moved with it (a global input).
    const layout = layoutWith((_, entry) => {
      entry("apps/console").path = "apps/dashboard";
    });
    const withLayout = await plan({ ...consoleMoved(), "tools/layout.json": layout });
    assertEverything(withLayout.document, "global");
    assert.deepEqual(withLayout.document.e2e, e2eOf(ALL_APPS));
    assert.deepEqual(withLayout.document.images, ALL_IMAGES);
    // The old folder replaced by a link to the new one, which pnpm still reads as the package.
    const linked = await plan({ ...consoleMoved(), "apps/console": { symlink: "dashboard" } });
    assertEverything(linked.document, "link");
    assert.deepEqual(linked.document.e2e, e2eOf(ALL_APPS));
    assert.deepEqual(linked.document.images, ALL_IMAGES);
    assert.deepEqual(linked.document.static, ALL_STATIC);
    // The push that lands the move on main still runs console's e2e.
    const head = repo.commit(base, consoleMoved());
    const push = await computePlan({ treeDir: tmp.dir, event: "push", base, head, config, env });
    assertEverything(push.document, "event");
    assert.deepEqual(push.document.e2e, e2eOf(ALL_APPS));
    assert.deepEqual(push.document.images, ALL_IMAGES);
  });

  it("a link at a package folder, or at a folder above one, makes the graph unreadable: everything, with every e2e", async () => {
    // Once on main, a link at apps/console is read by pnpm as the package behind it.
    const linkedOnMain = repo.commit(base, {
      ...consoleMoved(),
      "apps/console": { symlink: "dashboard" },
    });
    const later = await plan(
      { "packages/server/src/index.ts": "export const server = 6;\n" },
      "pull_request",
      linkedOnMain,
    );
    assertEverything(later.document, "workspace");
    assert.match(
      later.workspaceProblem ?? "",
      /^"apps\/console" is a symbolic link at a workspace folder/,
    );
    assert.deepEqual(later.document.e2e, e2eOf(ALL_APPS));
    assert.deepEqual(later.document.images, ALL_IMAGES);
    assert.deepEqual(later.document.static, ALL_STATIC);
    const push = await computePlan({
      treeDir: tmp.dir,
      event: "push",
      base: linkedOnMain,
      head: later.document.head,
      config,
      env,
    });
    assert.deepEqual(push.document.e2e, e2eOf(ALL_APPS));
    // A submodule at a package folder, and a link at a folder the workspace globs list folders of.
    const submodule = repo.commit(base, { "packages/vendor": { gitlink: "b".repeat(40) } });
    const viaSubmodule = await plan(
      { "packages/core/src/index.ts": "export const core = 6;\n" },
      "pull_request",
      submodule,
    );
    assertEverything(viaSubmodule.document, "workspace");
    assert.match(
      viaSubmodule.workspaceProblem ?? "",
      /^"packages\/vendor" is a submodule at a workspace folder/,
    );
    const opsFiles: Record<string, string | null | SpecialEntry> = {
      ops: { symlink: "vendor/ops" },
    };
    for (const [path, content] of Object.entries(monorepoFiles())) {
      if (!path.startsWith("ops/")) continue;
      opsFiles[path] = null;
      opsFiles[`vendor/${path}`] = content;
    }
    const opsLinked = repo.commit(base, opsFiles);
    const viaOps = await plan(
      { "packages/core/src/index.ts": "export const core = 7;\n" },
      "pull_request",
      opsLinked,
    );
    assertEverything(viaOps.document, "workspace");
    assert.match(
      viaOps.workspaceProblem ?? "",
      /^"ops" is a symbolic link above the workspace folders/,
    );
  });

  it("a link to a regular file at a workspace folder's path, or above one, holds no package: the graph stays readable", async () => {
    // On main: a file link directly under tools/, which pnpm cannot read a package through.
    const fileLink = repo.commit(base, {
      "scripts/pre-push.mjs": "export {};\n",
      "tools/pre-push.mjs": { symlink: "../scripts/pre-push.mjs" },
    });
    const later = await plan(
      { "docs/plan/README.md": "# plan, beside a file link\n" },
      "pull_request",
      fileLink,
    );
    assert.equal(later.workspaceProblem, null);
    assert.equal(later.document.everything, false);
    assert.equal(later.document.reason, "classes");
    assert.deepEqual(jobsOn(later.document), ["check", "static"]);
    assert.deepEqual(later.document.e2e, { apps: [], projects: [], shards: 0 });
    // The same above the workspace folders: ops/ replaced by a link to a file.
    const opsFile: Record<string, string | null | SpecialEntry> = { ops: { symlink: "README.md" } };
    for (const path of Object.keys(monorepoFiles()))
      if (path.startsWith("ops/")) opsFile[path] = null;
    const opsLinked = repo.commit(base, opsFile);
    const viaOps = await plan(
      { "packages/core/src/index.ts": "export const core = 10;\n" },
      "pull_request",
      opsLinked,
    );
    assert.equal(viaOps.workspaceProblem, null);
    assert.equal(viaOps.document.everything, false);
    // A link that may lead to a folder still makes the graph unreadable: to a folder, to a path
    // the tree lacks, to another link, out of the tree, to a file in another case, or to a file
    // whose name a folder spelled in another case also holds.
    const mayLeadToAFolder: Array<[string, FileChanges]> = [
      ["a folder", { "tools/vendored": { symlink: "../packages/core" } }],
      ["a missing path", { "tools/vendored": { symlink: "../scripts/missing.mjs" } }],
      [
        "another link",
        {
          "scripts/alias.mjs": { symlink: "../packages" },
          "tools/vendored": { symlink: "../scripts/alias.mjs" },
        },
      ],
      ["outside the tree", { "tools/vendored": { symlink: "/etc" } }],
      ["a file in another case", { "tools/vendored": { symlink: "../Scripts/check.mjs" } }],
      [
        "a file a folder in another case shadows",
        {
          "Scripts/check.mjs/package.json": manifest("@fin/shadow"),
          "tools/vendored": { symlink: "../scripts/check.mjs" },
        },
      ],
      ["a submodule", { "tools/vendored": { gitlink: "d".repeat(40) } }],
    ];
    for (const [label, changes] of mayLeadToAFolder) {
      const onMain = repo.commit(base, changes);
      const { document, workspaceProblem } = await plan(
        { "docs/plan/README.md": `# plan, beside ${label}\n` },
        "pull_request",
        onMain,
      );
      // A link out of the tree may reach any path, which runs everything for the link first.
      assertEverything(document, label === "outside the tree" ? "link" : "workspace");
      assert.match(
        workspaceProblem ?? "",
        /^"tools\/vendored" is a (symbolic link|submodule) at a workspace folder/,
        label,
      );
    }
  });

  it("a package.json or tools/layout.json that is a symbolic link is never read as its link text", async () => {
    // pnpm reads the file behind a package.json link; its link text may itself be JSON.
    const text = '{"name":"@fin/console"}';
    const consoleManifest = manifest("@fin/console", { "@fin/server": W, "@fin/ui": W });
    const manifestLink = repo.commit(base, {
      "apps/console/package.json": { symlink: text },
      [`apps/console/${text}`]: consoleManifest,
    });
    const viaManifest = await plan(
      { "packages/server/src/index.ts": "export const server = 7;\n" },
      "pull_request",
      manifestLink,
    );
    assertEverything(viaManifest.document, "workspace");
    assert.match(
      viaManifest.workspaceProblem ?? "",
      /apps\/console\/package\.json" is not a regular file \(a symbolic link\)/,
    );
    assert.deepEqual(viaManifest.document.e2e, e2eOf(ALL_APPS));
    assert.deepEqual(viaManifest.document.images, ALL_IMAGES);
    const submoduleManifest = repo.commit(base, {
      "packages/crypto/package.json": { gitlink: "c".repeat(40) },
    });
    const viaSubmodule = await plan(
      { "packages/core/src/index.ts": "export const core = 8;\n" },
      "pull_request",
      submoduleManifest,
    );
    assertEverything(viaSubmodule.document, "workspace");
    // The layout: a link whose text is a layout calling packages/core tier N is not a layout.
    const lowered = layoutWith((_, entry) => {
      entry("packages/core").tier = "N";
    });
    const layoutLink = repo.commit(base, {
      "tools/layout.json": { symlink: JSON.stringify(JSON.parse(lowered)) },
    });
    const viaLayout = await plan(
      { "packages/core/src/index.ts": "export const core = 9;\n" },
      "pull_request",
      layoutLink,
    );
    assertEverything(viaLayout.document, "layout");
    assert.equal(viaLayout.document.layout, "invalid");
    assert.equal(viaLayout.document.tier, "S");
    assert.match(viaLayout.layoutProblems.join("\n"), /tools\/layout\.json is not a regular file/);
    // A push whose head's layout is a link builds from the base's, and says so.
    const push = await computePlan({
      treeDir: tmp.dir,
      event: "push",
      base,
      head: layoutLink,
      config,
      env,
    });
    assert.deepEqual(push.document.images, ALL_IMAGES);
    assert.match(
      push.layoutProblems.join("\n"),
      /^at the head: tools\/layout\.json is not a regular file/m,
    );
  });

  it("once main holds an app's manifest in a form the plan cannot read, later plans keep its e2e and outputs", async () => {
    const consoleManifest = manifest("@fin/console", { "@fin/server": W, "@fin/ui": W });
    const forms: Array<[string, FileChanges]> = [
      [
        "package.yaml",
        {
          "apps/console/package.json": null,
          "apps/console/package.yaml": "name: '@fin/console'\n",
        },
      ],
      [
        "Package.json",
        { "apps/console/package.json": null, "apps/console/Package.json": consoleManifest },
      ],
      [
        "a link",
        {
          "apps/console/package.json": { symlink: "real.json" },
          "apps/console/real.json": consoleManifest,
        },
      ],
    ];
    for (const [label, form] of forms) {
      const onMain = repo.commit(base, form);
      const later = await plan(
        { "apps/console/src/server/main.ts": `export const x = "${label}";\n` },
        "pull_request",
        onMain,
      );
      assertEverything(later.document, "workspace");
      assert.deepEqual(later.document.e2e, e2eOf(ALL_APPS), label);
      assert.deepEqual(later.document.images, ALL_IMAGES, label);
      assert.deepEqual(later.document.static, ALL_STATIC, label);
      const push = await computePlan({
        treeDir: tmp.dir,
        event: "push",
        base: onMain,
        head: later.document.head,
        config,
        env,
      });
      assert.deepEqual(push.document.e2e, e2eOf(ALL_APPS), label);
      assert.deepEqual(push.document.images, ALL_IMAGES, label);
    }
  });

  it("an app whose package.json is deleted, renamed or replaced by another manifest runs everything, and keeps its e2e and outputs", async () => {
    const consoleManifest = manifest("@fin/console", { "@fin/server": W, "@fin/ui": W });
    const serverChange = { "apps/console/src/server/main.ts": "export const x = 3;\n" };
    const cases: Array<[string, FileChanges]> = [
      ["deleted", { ...serverChange, "apps/console/package.json": null }],
      [
        "renamed to package.yaml",
        {
          ...serverChange,
          "apps/console/package.json": null,
          "apps/console/package.yaml": "name: '@fin/console'\n",
        },
      ],
      [
        "renamed to Package.json",
        {
          ...serverChange,
          "apps/console/package.json": null,
          "apps/console/Package.json": consoleManifest,
        },
      ],
      [
        "renamed to package.json5",
        {
          "packages/server/src/index.ts": "export const server = 3;\n",
          "apps/console/package.json": null,
          "apps/console/package.json5": consoleManifest,
        },
      ],
      [
        "joined by PACKAGE.JSON",
        { "apps/console/PACKAGE.JSON": manifest("@fin/console", { "@fin/money": W }) },
      ],
    ];
    for (const [label, changes] of cases) {
      const { document } = await plan(changes);
      assertEverything(document, "workspace");
      assert.deepEqual(document.e2e, e2eOf(ALL_APPS), label);
      assert.deepEqual(document.images, ALL_IMAGES, label);
      assert.deepEqual(document.static, ALL_STATIC, label);
    }
  });

  it("an app folder renamed only by case, or a package folder spelled unlike the workspace globs, runs everything with every e2e", async () => {
    const changes: Record<string, string | null> = {};
    for (const [path, content] of Object.entries(monorepoFiles())) {
      if (!path.startsWith("apps/console/")) continue;
      changes[path] = null;
      changes[`apps/Console/${path.slice("apps/console/".length)}`] = content;
    }
    const renamed = await plan(changes);
    assertEverything(renamed.document, "workspace");
    assert.deepEqual(
      renamed.document.e2e,
      e2eOf(ALL_APPS),
      "console's e2e stays, and fails on CI rather than vanishing",
    );
    assert.deepEqual(renamed.document.images, ALL_IMAGES);
    const shouted = await plan({
      "APPS/kiosk/package.json": manifest("@fin/kiosk", { "@fin/server": W }),
      "APPS/kiosk/src/main.ts": "export {};\n",
    });
    assertEverything(shouted.document, "workspace");
    assert.match(shouted.workspaceProblem ?? "", /APPS\/kiosk\/package\.json/);
  });

  it("a *.db.test.ts in any case turns on the db job for its package", async () => {
    const withDbTest = repo.commit(base, { "packages/crypto/src/keys.DB.Test.ts": "export {};\n" });
    const { document } = await plan(
      { "packages/crypto/src/index.ts": "export const crypto = 3;\n" },
      "pull_request",
      withDbTest,
    );
    assert.equal(document.everything, false);
    assert.equal(document.jobs.db, true);
  });

  it("an edge present at the base or the head counts", async () => {
    // The branch starts where @fin/server did not depend on @fin/core; main adds that edge later.
    // The diff (merge base to head) shows only the core change, and only the base has the edge.
    const mergeBase = repo.commit(base, {
      "packages/server/package.json": manifest("@fin/server"),
    });
    const mainNow = repo.commit(mergeBase, {
      "packages/server/package.json": manifest("@fin/server", { "@fin/core": W }),
    });
    const head = repo.commit(mergeBase, {
      "packages/core/src/index.ts": "export const core = 3;\n",
    });
    const viaBase = await computePlan({
      treeDir: tmp.dir,
      event: "pull_request",
      base: mainNow,
      head,
      config,
      env,
    });
    assert.deepEqual(
      viaBase.files.map((file) => file.path),
      ["packages/core/src/index.ts"],
    );
    assert.ok(
      viaBase.document.packages?.includes("@fin/server"),
      "server depends on core at the base",
    );
    assert.ok(viaBase.document.e2e.apps.includes("console"));
    const headOnly = await computePlan({
      treeDir: tmp.dir,
      event: "pull_request",
      base: mergeBase,
      head,
      config,
      env,
    });
    assert.ok(
      !headOnly.document.packages?.includes("@fin/server"),
      "with the edge on neither side, server is not affected",
    );
    const addEdge = await plan({
      "packages/crypto/package.json": manifest("@fin/crypto", { "@fin/core": W, "@fin/tokens": W }),
    });
    assert.deepEqual(addEdge.document.packages, ["@fin/crypto"]);
  });

  it("a branch behind main by a commit that added a package is planned by its own change, not as a deleted package", async () => {
    // The branch starts at `base`; main then gains packages/newpkg. The base tree (main's tip)
    // holds a package the head lacks, but the change (merge base to head) removed nothing.
    const newpkg = {
      "packages/newpkg/package.json": manifest("@fin/newpkg", { "@fin/core": W }),
      "packages/newpkg/src/index.ts": "export {};\n",
    };
    const mainNow = repo.commit(base, newpkg);
    const docsOnly = repo.commit(base, { "docs/plan/README.md": "# plan, behind main\n" });
    for (const event of ["pull_request", "local"]) {
      const behind = await computePlan({
        treeDir: tmp.dir,
        event,
        base: mainNow,
        head: docsOnly,
        config,
        env,
      });
      assert.equal(behind.document.everything, false, event);
      assert.equal(behind.document.reason, "classes", event);
      assert.deepEqual(jobsOn(behind.document), ["check", "static"], event);
      assert.deepEqual(behind.document.e2e, { apps: [], projects: [], shards: 0 }, event);
      assert.deepEqual(behind.document.images, [], event);
    }
    // A change to a package main's new one depends on reaches it, from the base's graph.
    const coreChange = repo.commit(base, {
      "packages/core/src/index.ts": "export const core = 11;\n",
    });
    const reaching = await computePlan({
      treeDir: tmp.dir,
      event: "pull_request",
      base: mainNow,
      head: coreChange,
      config,
      env,
    });
    assert.equal(reaching.document.everything, false);
    assert.ok(reaching.document.packages?.includes("@fin/newpkg"));
    // The branch that does remove a package of the merge base still runs everything, whether main
    // is ahead of it or not, and so does one that leaves files in a folder main made a package.
    const removed = repo.commit(base, {
      "packages/crypto/package.json": null,
      "packages/crypto/src/index.ts": null,
    });
    const renamedAway = repo.commit(base, {
      "packages/crypto/package.json": null,
      "packages/crypto/package.json5": manifest("@fin/crypto"),
    });
    const leftFiles = repo.commit(base, { "packages/newpkg/README.md": "# new\n" });
    for (const [label, head] of [
      ["deleted", removed],
      ["renamed away", renamedAway],
      ["files in main's new package folder", leftFiles],
    ] as const) {
      const ahead = await computePlan({
        treeDir: tmp.dir,
        event: "pull_request",
        base: mainNow,
        head,
        config,
        env,
      });
      assert.equal(ahead.document.everything, true, label);
      assert.equal(ahead.document.reason, "workspace", label);
    }
  });

  it("a workspace dependency counts whether it names the package, an alias of it or its folder", async () => {
    const consoleWith = (server: Record<string, string>): string =>
      manifest("@fin/console", { ...server, "@fin/ui": W });
    for (const server of [
      { server: "workspace:@fin/server@*" },
      { "@fin/server": "link:../../packages/server" },
      { "@fin/server": "workspace:../../packages/server" },
      { srv: "file:../../packages/server/" },
    ]) {
      const odd = repo.commit(base, { "apps/console/package.json": consoleWith(server) });
      const { document } = await plan(
        { "packages/server/src/index.ts": "export const server = 2;\n" },
        "pull_request",
        odd,
      );
      assert.equal(document.everything, false, JSON.stringify(server));
      assert.deepEqual(document.e2e.apps, ["console", "admin", "verify"], JSON.stringify(server));
      assert.ok(document.packages?.includes("@fin/console"), JSON.stringify(server));
      assert.ok(document.images.includes("fin-next-console"), JSON.stringify(server));
    }
    const aliasDb = repo.commit(base, {
      "packages/money/package.json": manifest("@fin/money", { db: "workspace:@fin/db@*" }),
    });
    const api = await plan(
      { "apps/api/src/main.ts": "export const api = 2;\n" },
      "pull_request",
      aliasDb,
    );
    assert.equal(api.document.jobs.db, true, "apps/api reaches @fin/db through @fin/money's alias");
  });

  it("a dependency path that names no package, a bad name or folders that differ only by case run everything", async () => {
    for (const changes of [
      { "apps/console/package.json": manifest("@fin/console", { x: "file:../../vendor/x.tgz" }) },
      { "apps/console/package.json": manifest("@fin/console", { x: "link:/opt/x" }) },
      { "apps/console/package.json": manifest("@fin/console", { "Not A Name": W }) },
      {
        "Packages/core/package.json": manifest("@fin/zz"),
        "Packages/core/src/x.ts": "export {};\n",
      },
    ] as FileChanges[]) {
      const { document, workspaceProblem } = await plan(changes);
      assertEverything(document, "workspace");
      assert.notEqual(workspaceProblem, null, JSON.stringify(changes));
    }
  });

  it("tiers come from the base's layout, so a pull request cannot lower its own tier", async () => {
    const lowered = layoutWith((_, entry) => {
      assert.equal(entry("packages/core").tier, "S");
      entry("packages/core").tier = "D";
    });
    const result = await plan({
      "tools/layout.json": lowered,
      "packages/core/src/index.ts": "export const core = 4;\n",
    });
    const core = result.files.find((file) => file.path === "packages/core/src/index.ts");
    assert.equal(core?.tier, "S");
    assert.equal(result.document.tier, "S");
  });

  it("images and static outputs come from the head's layout on a push, and from both on a pull request", async () => {
    const changed = layoutWith((_, entry) => {
      entry("apps/docs").image = "fin-next-docs";
      entry("apps/verify").static = ["verify", "selfie", "kiosk"];
      entry("apps/edge").image = "fin-next-edge-v2";
    });
    const head = repo.commit(base, { "tools/layout.json": changed });
    const headImages = [
      "fin-next-admin",
      "fin-next-api",
      "fin-next-console",
      "fin-next-docs",
      "fin-next-edge-v2",
      "fin-next-verify",
    ];
    const headStatic = ["admin", "console", "docs", "kiosk", "selfie", "verify"];
    for (const [event, from] of [
      ["push", base],
      ["workflow_dispatch", null],
    ] as const) {
      const { document } = await computePlan({
        treeDir: tmp.dir,
        event,
        base: from,
        head,
        config,
        env,
      });
      assert.deepEqual(document.images, headImages, event);
      assert.deepEqual(document.static, headStatic, event);
    }
    const pull = await computePlan({
      treeDir: tmp.dir,
      event: "pull_request",
      base,
      head,
      config,
      env,
    });
    assert.deepEqual(pull.document.images, [...headImages, "fin-next-edge"].sort());
    assert.deepEqual(pull.document.static, headStatic);
    // A push whose layout is broken builds from the base's, and says so.
    const broken = repo.commit(base, { "tools/layout.json": "{ broken" });
    const pushBroken = await computePlan({
      treeDir: tmp.dir,
      event: "push",
      base,
      head: broken,
      config,
      env,
    });
    assert.deepEqual(pushBroken.document.images, ALL_IMAGES);
    assert.match(
      pushBroken.layoutProblems.join("\n"),
      /^at the head: tools\/layout\.json is not valid JSON/m,
    );
  });

  it("an entry whose package does not exist yet lists no image or static output, until it does", async () => {
    const withKiosk = layoutWith((layout, entry) => {
      const at = layout.entries.indexOf(entry("apps/edge"));
      layout.entries.splice(at, 0, {
        path: "apps/kiosk",
        name: "@fin/kiosk",
        kind: "app",
        status: "planned",
        tier: "N",
        static: "kiosk",
      });
    });
    const planned = repo.commit(base, { "tools/layout.json": withKiosk });
    for (const event of ["push", "workflow_dispatch"]) {
      const head = repo.commit(planned, { "docs/plan/README.md": `${event}\n` });
      const { document } = await computePlan({
        treeDir: tmp.dir,
        event,
        base: event === "push" ? planned : null,
        head,
        config,
        env,
      });
      assert.deepEqual(document.images, ALL_IMAGES, event);
      assert.deepEqual(document.static, ALL_STATIC, event);
    }
    const docker = await plan(
      { "ops/docker/app.Dockerfile": "FROM scratch\nUSER 1002\n" },
      "pull_request",
      planned,
    );
    assert.deepEqual(docker.document.images, ALL_IMAGES);
    const created = repo.commit(planned, {
      "apps/payments/package.json": manifest("@fin/payments", { "@fin/server": W }),
      "apps/payments/src/main.ts": "export {};\n",
      "apps/kiosk/package.json": manifest("@fin/kiosk"),
      "apps/kiosk/src/client/main.tsx": "export {};\n",
    });
    const push = await computePlan({
      treeDir: tmp.dir,
      event: "push",
      base: planned,
      head: created,
      config,
      env,
    });
    assert.deepEqual(push.document.images, [...ALL_IMAGES, "fin-next-payments"].sort());
    assert.deepEqual(push.document.static, [...ALL_STATIC, "kiosk"].sort());
  });

  it("a missing or invalid layout makes every path S and runs everything", async () => {
    const noLayout = repo.commit(base, { "tools/layout.json": null });
    const missing = await plan({ "docs/plan/README.md": "x\n" }, "pull_request", noLayout);
    assertEverything(missing.document, "layout");
    assert.equal(missing.document.layout, "missing");
    assert.equal(missing.document.tier, "S");
    assert.deepEqual(missing.document.images, []);
    assert.match(missing.layoutProblems[0] ?? "", /not in the tree/);
    for (const text of [
      "{ not json",
      '{"version": 2, "controlPaths": [], "entries": []}',
      '{"version":1,"version":1}',
    ]) {
      const badLayout = repo.commit(base, { "tools/layout.json": text });
      const invalid = await plan({ "docs/plan/README.md": "y\n" }, "pull_request", badLayout);
      assertEverything(invalid.document, "layout");
      assert.equal(invalid.document.layout, "invalid", text);
    }
  });

  it("an invalid manifest runs everything, with every app's e2e and every image", async () => {
    for (const text of [
      "{ broken",
      '{"private": true}',
      '{"name": "@fin/console", "dependencies": []}',
      '{"name":"a","name":"b"}',
      '{"name":"@fin/console","private":true,"private":true}',
      "﻿{}",
    ]) {
      const { document, workspaceProblem } = await plan({
        "apps/console/package.json": text,
        "apps/console/src/server/main.ts": "export const x = 2;\n",
      });
      assertEverything(document, "workspace");
      assert.notEqual(workspaceProblem, null, text);
      assert.deepEqual(document.e2e, e2eOf(ALL_APPS), text);
      assert.equal(
        document.packages,
        null,
        "the package graph is unknown, so every package counts",
      );
      assert.deepEqual(document.images, ALL_IMAGES, text);
      assert.deepEqual(document.static, ALL_STATIC, text);
    }
    const twice = await plan({ "packages/crypto/package.json": manifest("@fin/core") });
    assertEverything(twice.document, "workspace");
    const pushed = await plan({ "ops/fin/package.json": "{ broken" }, "push");
    assertEverything(pushed.document, "event");
    assert.deepEqual(pushed.document.e2e.apps, ALL_APPS);
  });

  it("with a package graph that cannot be read, an e2e app whose folder neither tree holds is not named", async () => {
    // main without apps/docs: no tracked entry there, in any case, at the base or the head.
    const docsGone: Record<string, null> = {};
    for (const path of Object.keys(monorepoFiles()))
      if (path.startsWith("apps/docs/")) docsGone[path] = null;
    const noDocs = repo.commit(base, docsGone);
    const yaml = { "packages/core/package.yaml": "name: '@fin/core'\n" };
    const unreadable: Array<[string, FileChanges]> = [
      ["a package.yaml", yaml],
      [
        "a path that names no package",
        {
          "apps/console/package.json": manifest("@fin/console", { x: "link:../../vendor/x" }),
        },
      ],
      ["a broken manifest", { "packages/crypto/package.json": "{ broken" }],
    ];
    for (const [label, changes] of unreadable) {
      const { document, workspaceProblem } = await plan(changes, "pull_request", noDocs);
      assertEverything(document, "workspace");
      assert.notEqual(workspaceProblem, null, label);
      assert.equal(document.packages, null, label);
      assert.deepEqual(document.e2e, e2eOf(["console", "admin", "verify"]), label);
      assert.ok(!document.static.includes("docs"), label);
    }
    // A folder either tree holds an entry in, in any case, or that is a link, keeps its e2e.
    const held: Array<[string, FileChanges]> = [
      ["a file at the head", { ...yaml, "apps/docs/README.md": "# docs\n" }],
      ["a file in another case", { ...yaml, "Apps/Docs/README.md": "# docs\n" }],
      ["a link", { ...yaml, "apps/docs": { symlink: "../packages/core" } }],
    ];
    for (const [label, changes] of held) {
      const { document } = await plan(changes, "pull_request", noDocs);
      assert.equal(document.everything, true, label);
      assert.equal(document.packages, null, label);
      assert.deepEqual(document.e2e, e2eOf(ALL_APPS), label);
    }
    // A file at the base only: main still holds a file in the folder the pull request lacks.
    const docsReadme = repo.commit(noDocs, { "apps/docs/README.md": "# docs\n" });
    const branch = repo.commit(noDocs, yaml);
    const viaBase = await computePlan({
      treeDir: tmp.dir,
      event: "pull_request",
      base: docsReadme,
      head: branch,
      config,
      env,
    });
    assert.equal(viaBase.document.packages, null);
    assert.deepEqual(viaBase.document.e2e, e2eOf(ALL_APPS));
  });

  it("push to main and workflow_dispatch run everything", async () => {
    const head = repo.commit(base, { "docs/plan/README.md": "z\n" });
    const push = await computePlan({ treeDir: tmp.dir, event: "push", base, head, config, env });
    assertEverything(push.document, "event");
    assert.equal(push.document.tier, "D", "the diff is still read for the tier");
    assert.equal(push.document.jobs.selfTest, false, "the diff shows the engine did not change");
    const dispatch = await computePlan({
      treeDir: tmp.dir,
      event: "workflow_dispatch",
      base: null,
      head,
      config,
      env,
    });
    assertEverything(dispatch.document, "event");
    assert.equal(dispatch.document.tier, "S");
    assert.equal(dispatch.document.changed, 0);
    assert.equal(dispatch.document.base, null);
    assert.equal(dispatch.document.jobs.selfTest, true, "with no diff the engine may have changed");
    assert.equal(dispatch.document.layout, "ok", "with no base the head's layout is read");
    const rewritten = await computePlan({
      treeDir: tmp.dir,
      event: "push",
      base: "3".repeat(40),
      head,
      config,
      env,
    });
    assertEverything(rewritten.document, "event");
    assert.equal(rewritten.document.base, null);
    assert.deepEqual(rewritten.notes, [
      `base ${"3".repeat(40)} is not a commit here; planning the push without a diff`,
    ]);
  });

  it("an empty diff runs check and static", async () => {
    const { document } = await plan({});
    assert.deepEqual(jobsOn(document), ["check", "static"]);
    assert.equal(document.tier, null);
    assert.equal(document.changed, 0);
  });

  it("a history with several merge bases is planned against all of them, and runs everything", async () => {
    // main fixes apps/api; an earlier pull request (c1, then c2 merging the fix) is merged as m.
    // The attacking head merges c1 and the fix but keeps the old file. Both c1 and the fix are
    // merge bases of m and the head; git's diff would take the newer one, c1, alone.
    const fixed = repo.commit(base, { "apps/api/src/main.ts": "export const fixed = true;\n" });
    const c1 = repo.commit(base, { "docs/plan/c1.md": "# c1\n" });
    const c2 = repo.commit([c1, fixed], { "apps/api/src/main.ts": "export const fixed = true;\n" });
    const main = repo.commit([fixed, c2], { "docs/plan/c1.md": "# c1\n" });
    const head = repo.commit([c1, fixed], { "docs/plan/more.md": "# more\n" });
    assert.equal(repo.git(["merge-base", "--all", main, head]).trim().split("\n").length, 2);
    const result = await computePlan({
      treeDir: tmp.dir,
      event: "pull_request",
      base: main,
      head,
      config,
      env,
    });
    assertEverything(result.document, "history");
    assert.equal(result.document.tier, "S");
    assert.ok(
      result.files.some((file) => file.path === "apps/api/src/main.ts"),
      "the reverted file is in the change",
    );
    assert.match(result.notes.join("\n"), /have 2 merge bases/);
    // Unrelated histories: every difference between the trees, and everything.
    const stranger = repo.commit(null, { "README.md": "# another history\n" });
    const unrelated = await computePlan({
      treeDir: tmp.dir,
      event: "pull_request",
      base,
      head: stranger,
      config,
      env,
    });
    assertEverything(unrelated.document, "history");
    assert.ok(unrelated.document.changed > 40);
    assert.match(unrelated.notes.join("\n"), /share no history/);
  });

  it("a changed symbolic link or submodule runs everything at tier S", async () => {
    const link = await plan({
      "apps/console/src/server/lib": { symlink: "../../../../docs/plan/lib" },
    });
    assertEverything(link.document, "link");
    assert.equal(link.document.tier, "S");
    const bare = await plan(
      {
        "docs/review": { symlink: "plan/procedure" },
        "docs/plan/procedure/prompts/system.md": "# system\n",
      },
      "pull_request",
      repo.commit(base, { "docs/review/README.md": null }),
    );
    assertEverything(bare.document, "link");
    assert.equal(bare.files.find((file) => file.path === "docs/review")?.tierSource, "control");
    const gitlink = await plan({ "docs/plan/sub": { gitlink: "a".repeat(40) } });
    assertEverything(gitlink.document, "link");
    assert.equal(gitlink.document.tier, "S");
  });

  it("a path a symbolic link reaches counts at the link's path too", async () => {
    const linked = repo.commit(base, {
      "apps/console/src/server/lib": { symlink: "../../../../docs/plan/lib" },
      "docs/plan/lib/notes.md": "# notes\n",
    });
    const { document, files } = await plan(
      { "docs/plan/lib/notes.md": "# notes, changed\n" },
      "pull_request",
      linked,
    );
    assert.deepEqual(
      files.map((file) => [file.side, file.path, file.tier, file.link]),
      [
        ["new", "docs/plan/lib/notes.md", "D", null],
        ["link", "apps/console/src/server/lib/notes.md", "S", "apps/console/src/server/lib"],
      ],
    );
    assert.equal(document.tier, "S");
    assert.deepEqual(document.classes, ["docs", "server"]);
    assert.deepEqual(document.e2e.apps, ["console"]);
    assert.equal(document.jobs.seams, true);
    assert.equal(
      linkTarget("a/b/link", Buffer.from("../../../outside")),
      "",
      "a link out of the tree reaches all of it",
    );
    assert.equal(linkTarget("a/link", Buffer.from("/etc")), "");
    assert.equal(linkTarget("a/link", Buffer.from("../c/./d/")), "c/d");
  });

  it("a target that climbs out of a folder it names reaches what the kernel finds, so it counts as the whole tree", () => {
    for (const target of ["../c/../d", "x/./../y", "../../docs/plan/d/../y", "a/b/../../c"]) {
      assert.equal(linkTarget("p/q/link", Buffer.from(target)), "", target);
    }
    assert.equal(
      linkTarget("p/q/link", Buffer.from("../../c/./d")),
      "c/d",
      "leading .. climbs the link's own folders",
    );
    assert.equal(linkTarget("p/q/link", Buffer.from("./../c")), "p/c");
    assert.equal(
      linkTarget("p/q/link", Buffer.from("../ſerver")),
      "",
      "a target that is not plain may name another folder on the disk",
    );
  });

  it("a link that may reach any path runs everything at tier S, whatever it is reached through", async () => {
    // A link to the root, and a link into the tree through it: the kernel reaches packages/ui
    // through both, and the second is server code.
    const throughRoot = repo.commit(base, {
      "apps/console/src/client/root": { symlink: "../../../.." },
      "apps/api/src/server/rt": { symlink: "../../../console/src/client/root/packages/ui" },
    });
    // A target that climbs out of a link it names: docs/plan/d leads to packages/ui/src/x, so
    // ../y from there is packages/ui/src/y, not docs/plan/y.
    const climbing = repo.commit(base, {
      "docs/plan/d": { symlink: "../../packages/ui/src/x" },
      "apps/api/src/server/lib": { symlink: "../../../../docs/plan/d/../y" },
    });
    for (const from of [throughRoot, climbing]) {
      const { document, notes } = await plan(
        { "packages/ui/src/y/a.ts": "export const a = 1;\n" },
        "pull_request",
        from,
      );
      assertEverything(document, "link");
      assert.equal(document.tier, "S");
      assert.equal(document.jobs.selfTest, true, "what the change reaches is unknown");
      assert.match(notes.join("\n"), /may reach any path/);
    }
  });

  it("a chain of links is followed as far as a kernel follows it, and a longer one runs everything", async () => {
    // packages/ui/chain/l0 -> ../src, each further link to the one before, and server code at the end.
    const chain = (length: number): Record<string, SpecialEntry> => {
      const out: Record<string, SpecialEntry> = { "packages/ui/chain/l0": { symlink: "../src" } };
      for (let i = 1; i < length; i++) out[`packages/ui/chain/l${i}`] = { symlink: `l${i - 1}` };
      out["apps/api/src/server/deep"] = { symlink: `../../../../packages/ui/chain/l${length - 1}` };
      return out;
    };
    const ten = await plan(
      { "packages/ui/src/y/a.ts": "export const a = 1;\n" },
      "pull_request",
      repo.commit(base, chain(10)),
    );
    assert.equal(ten.document.everything, false);
    assert.equal(ten.files.filter((file) => file.side === "link").length, 11);
    assert.deepEqual(
      ten.files
        .filter((file) => file.path.startsWith("apps/"))
        .map((file) => [file.side, file.path, file.tier, file.link]),
      [["link", "apps/api/src/server/deep/y/a.ts", "S", "apps/api/src/server/deep"]],
    );
    assert.equal(ten.document.tier, "S");
    assert.deepEqual(ten.document.classes, ["server", "client"]);
    assert.equal(ten.document.jobs.seams, true);
    assert.equal(ten.document.jobs.db, true, "apps/api reaches @fin/db");
    const forty = await plan(
      { "packages/ui/src/y/a.ts": "export const a = 2;\n" },
      "pull_request",
      repo.commit(base, chain(39)),
    );
    assert.equal(forty.document.everything, false, "40 links in a row is as far as Linux goes");
    const longer = await plan(
      { "packages/ui/src/y/a.ts": "export const a = 3;\n" },
      "pull_request",
      repo.commit(base, chain(40)),
    );
    assertEverything(longer.document, "link");
    assert.match(longer.notes.join("\n"), /longer chains than the plan follows/);
    // A link to its own folder reaches every path below it again and again.
    const loop = await plan(
      { "packages/ui/src/y/a.ts": "export const a = 4;\n" },
      "pull_request",
      repo.commit(base, { "packages/ui/src/again": { symlink: "." } }),
    );
    assertEverything(loop.document, "link");
  });

  it("code under docs/ is not documentation: tier S and everything", async () => {
    const { document, files } = await plan({ "docs/plan/evil.ts": "export const run = 1;\n" });
    assertEverything(document, "unmapped");
    assert.equal(document.tier, "S");
    assert.equal(files[0]?.tierSource, "not-documentation");
  });

  it("is deterministic: the same base and head give the same document", async () => {
    const head = repo.commit(base, {
      "packages/core/src/index.ts": "export const core = 9;\n",
      "docs/plan/x.md": "x\n",
    });
    const first = await computePlan({
      treeDir: tmp.dir,
      event: "pull_request",
      base,
      head,
      config,
      env,
    });
    const second = await computePlan({
      treeDir: tmp.dir,
      event: "pull_request",
      base,
      head,
      config,
      env,
    });
    assert.deepEqual(first.document, second.document);
    assert.deepEqual(Object.keys(first.document), [
      "v",
      "event",
      "base",
      "head",
      "tier",
      "changed",
      "classes",
      "everything",
      "reason",
      "jobs",
      "e2e",
      "packages",
      "images",
      "static",
      "layout",
    ]);
    assert.deepEqual(Object.keys(first.document.jobs), [
      "check",
      "db",
      "build",
      "seams",
      "e2e",
      "e2e_shards",
      "static",
      "bun",
      "review",
      "selfTest",
      "containers",
    ]);
    assert.deepEqual(Object.keys(first.document.e2e), ["apps", "projects", "shards"]);
  });

  it("ignores the caller's GIT_* variables", async () => {
    const head = repo.commit(base, { "docs/plan/README.md": "env\n" });
    const hostile = {
      ...env,
      GIT_DIR: "/nonexistent",
      GIT_WORK_TREE: "/nonexistent",
      GIT_EXTERNAL_DIFF: "false",
    };
    const result = await computePlan({
      treeDir: tmp.dir,
      event: "pull_request",
      base,
      head,
      config,
      env: hostile,
    });
    assert.deepEqual(result.document.classes, ["docs"]);
  });

  it("refuses a base or head that is not a commit here", async () => {
    await assert.rejects(
      computePlan({
        treeDir: tmp.dir,
        event: "pull_request",
        base: "1".repeat(40),
        head: base,
        config,
        env,
      }),
      (error: unknown) =>
        error instanceof DataError && /base 1{40} is not a commit/.test(error.message),
    );
    const tree = repo.git(["rev-parse", `${base}^{tree}`]).trim();
    await assert.rejects(
      computePlan({ treeDir: tmp.dir, event: "pull_request", base, head: tree, config, env }),
      DataError,
    );
    await assert.rejects(
      computePlan({ treeDir: tmp.dir, event: "pull_request", base: null, head: base, config, env }),
      TypeError,
    );
    await assert.rejects(
      computePlan({ treeDir: tmp.dir, event: "Pull Request", base, head: base, config, env }),
      TypeError,
    );
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
      const equals = await cli(["plan", `--base=${base}`, `--head=${head}`, `--tree=${tmp.dir}`], {
        env,
      });
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
      assert.deepEqual(document.e2e, e2eOf(ALL_APPS));
      assert.ok(Buffer.byteLength(lines[1] ?? "") <= 64 * 1024);
    });

    it("--ci on push with a zero base, and on workflow_dispatch with no base, runs everything", async () => {
      for (const [event, baseSha] of [
        ["push", "0".repeat(40)],
        ["workflow_dispatch", ""],
        ["schedule", ""],
      ] as const) {
        const run = await cli(["plan", "--ci", "--tree", tmp.dir], {
          env: { ...env, EVENT_NAME: event, BASE_SHA: baseSha, HEAD_SHA: base },
        });
        assert.equal(run.code, 0, run.stderr);
        const document = JSON.parse(run.stdout) as PlanDocument;
        assert.equal(document.everything, true, event);
        assert.equal(document.reason, "event");
      }
    });

    it("prints paths, package names and JSON keys from the pull request escaped", async () => {
      const cases: FileChanges[] = [
        { "packages/x\n::warning title=injected::y/package.json": "{" },
        {
          "packages/a/package.json": manifest("@fin/a\n::error title=pwn::x\u001b]0;title\u0007"),
          "packages/b/package.json": manifest("@fin/a\n::error title=pwn::x\u001b]0;title\u0007"),
        },
        { "packages/c/package.json": '{"name":"@fin/c","x\\n::notice::y":{"k":1,"k":2}}' },
        {
          "packages/d/package.json":
            '{"name":"@fin/c","dependencies":{"x\\u001b[31m":"workspace:*"}}',
        },
        {
          "tools/layout.json":
            '{"version":1,"controlPaths":[],"entries":[{"path":"a\\n::warning::b","image":"X\\n::error::y"}]}',
        },
      ];
      for (const changes of cases) {
        const head = repo.commit(base, changes);
        const run = await cli(["plan", "--ci", "--tree", tmp.dir], {
          env: { ...env, EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head },
        });
        assert.equal(run.code, 0, run.stderr);
        assert.notEqual(run.stderr, "", JSON.stringify(changes));
        assertInert(run.stderr);
        assertInert(run.stdout);
        const document = JSON.parse(run.stdout) as PlanDocument;
        assert.equal(document.everything, true);
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
        [
          ["plan", "--base", base, "--head", base, "--output", "x"],
          {},
          /invalid_value: --output is only for --ci/,
        ],
        [
          ["plan", "--base", base, "--head", base, "--tree", join(tmp.dir, "missing")],
          {},
          /invalid_value: --tree is not a directory/,
        ],
        [["plan", "--base", base, "--base", base, "--head", base], {}, /duplicate_option: --base/],
        [
          ["plan", "--base", base, "--head", base, "--cold"],
          {},
          /unknown_option: Unknown option "--cold"/,
        ],
        [
          ["plan", "--base", base, "--head", base, "--model", "opus"],
          {},
          /unknown_option: Unknown option "--model"/,
        ],
        [
          ["plan", "--base", base, "--head", base, "extra"],
          {},
          /unknown_option: Unexpected argument "extra"/,
        ],
        [["plan", "--ci", "--ci"], {}, /duplicate_option: --ci/],
        [["plan", "--ci=yes"], {}, /wrong_type: --ci is a flag/],
        [
          ["plan", "--ci"],
          { BASE_SHA: base, HEAD_SHA: base },
          /missing_option: --ci needs EVENT_NAME/,
        ],
        [
          ["plan", "--ci"],
          { EVENT_NAME: "Pull Request", BASE_SHA: base, HEAD_SHA: base },
          /invalid_value: EVENT_NAME/,
        ],
        [
          ["plan", "--ci"],
          { EVENT_NAME: "pull_request", HEAD_SHA: base },
          /missing_option: A pull_request plan needs BASE_SHA/,
        ],
        [
          ["plan", "--ci"],
          { EVENT_NAME: "pull_request", BASE_SHA: base },
          /missing_option: plan --ci needs HEAD_SHA/,
        ],
        [
          ["plan", "--ci"],
          { EVENT_NAME: "pull_request", BASE_SHA: "0".repeat(40), HEAD_SHA: base },
          /missing_option/,
        ],
      ];
      for (const [argv, extraEnv, pattern] of cases) {
        const run = await cli([...argv, ...(argv.includes("--tree") ? [] : ["--tree", tmp.dir])], {
          env: { ...env, ...extraEnv },
        });
        assert.equal(run.code, 64, `${JSON.stringify(argv)}: ${run.stderr}`);
        assert.match(run.stderr, pattern, JSON.stringify(argv));
        assert.equal(run.stdout, "");
      }
    });

    it("exits 65 for a SHA that is not a commit in the tree", async () => {
      const run = await cli(["plan", "--base", "2".repeat(40), "--head", base, "--tree", tmp.dir], {
        env,
      });
      assert.equal(run.code, 65);
      assert.match(run.stderr, /^fin-review: error: base 2{40} is not a commit/);
    });

    it("exits 70 when the tree is not a git repository", async () => {
      const empty = tempDir("not-git");
      try {
        const run = await cli(["plan", "--base", base, "--head", base, "--tree", empty.dir], {
          env: fixtureEnv(empty.dir),
        });
        assert.equal(run.code, 70);
        assert.match(run.stderr, /^fin-review: error: git cat-file failed/);
      } finally {
        empty.cleanup();
      }
    });

    it("reports layout problems on stderr and still plans", async () => {
      const noLayout = repo.commit(base, { "tools/layout.json": null });
      const head = repo.commit(noLayout, { "README.md": "# changed\n" });
      const run = await cli(["plan", "--base", noLayout, "--head", head, "--tree", tmp.dir], {
        env,
      });
      assert.equal(run.code, 0);
      assert.equal(run.stderr, "fin-review: plan: layout: tools/layout.json is not in the tree\n");
      assert.equal((JSON.parse(run.stdout) as PlanDocument).reason, "layout");
    });
  });
});
