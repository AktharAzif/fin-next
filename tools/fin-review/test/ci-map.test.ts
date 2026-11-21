// T-RV-21 and T-RV-22 (spec 07 §10.1): the CI path classes of config/ci-map.json.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CLASS_NAMES, classesOf, parseCiConfig, parseCiMap } from "../src/plan/ci-map.ts";
import type { CiMap } from "../src/plan/ci-map.ts";
import { CONFIG_DIR, TOOL_ROOT } from "./helpers/cli.ts";

const rawMap = JSON.parse(readFileSync(join(CONFIG_DIR, "ci-map.json"), "utf8")) as Record<string, unknown>;
const rawCi = JSON.parse(readFileSync(join(CONFIG_DIR, "ci.json"), "utf8")) as Record<string, unknown>;

function committedMap(): CiMap {
  const parsed = parseCiMap(rawMap);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
  return (parsed as { ok: true; value: CiMap }).value;
}

function names(map: CiMap, path: string): string[] {
  return classesOf(map, path).map((cls) => cls.name);
}

/** A concrete path that `pattern` matches: ** becomes two segments, * and ? one letter. */
function samplePath(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => (segment === "**" ? "x/y" : segment.replace(/\*/g, "x").replace(/\?/g, "q")))
    .join("/");
}

/** The repository's tracked files, or null outside a git checkout. */
function trackedFiles(): string[] | null {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: TOOL_ROOT, shell: false, timeout: 30_000 });
  if (top.error !== undefined || top.status !== 0) return null;
  const root = top.stdout.toString("utf8").replace(/\n$/, "");
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, shell: false, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout.toString("utf8").split("\0").filter((path) => path !== "");
}

describe("config/ci-map.json", () => {
  const map = committedMap();

  it("defines every class of spec 07 §10.1 once, with check and static always on", () => {
    assert.deepEqual(map.classes.map((cls) => cls.name), [...CLASS_NAMES]);
    assert.deepEqual([...map.always].sort(), ["check", "static"]);
    const global = map.classes.find((cls) => cls.name === "global");
    assert.equal(global?.everything, true);
    assert.ok(map.classes.filter((cls) => cls.everything).length === 1);
  });

  it("every path pattern maps a path to its own class", () => {
    for (const cls of map.classes) {
      for (const glob of cls.paths) {
        const sample = samplePath(glob.pattern);
        assert.ok(glob.test(sample), `${glob.pattern} should match its sample ${sample}`);
        assert.ok(names(map, sample).includes(cls.name), `${cls.name}: ${glob.pattern} (as ${sample}) maps to ${names(map, sample).join(", ")}`);
      }
    }
  });

  it("T-RV-21: every tracked file maps to a class, and every pattern matches a tracked file or is planned", (t) => {
    const files = trackedFiles();
    if (files === null) {
      t.skip("not in a git checkout");
      return;
    }
    assert.ok(files.length > 0);
    const unmapped = files.filter((path) => classesOf(map, path).length === 0);
    assert.deepEqual(unmapped, [], "tracked files no class maps (add them to config/ci-map.json)");
    for (const cls of map.classes) {
      for (const glob of cls.paths) {
        if (cls.planned.has(glob.pattern)) continue;
        assert.ok(files.some((path) => glob.test(path)), `${cls.name}: ${glob.pattern} matches no tracked file; mark it planned`);
      }
    }
  });

  it("T-RV-22: each global input is in the global class", () => {
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
      ".github/dependabot.yml",
      ".github/scripts/gate.mjs",
      "tools/fin-review/src/plan/plan.ts",
      "tools/fin-review/config/ci-map.json",
      "docs/review/prompts/system.md",
    ]) {
      assert.ok(names(map, path).includes("global"), path);
    }
    assert.deepEqual(names(map, "planted/unmapped.ts"), []);
  });

  it("maps the paths of spec 07 §10.1's table to their classes", () => {
    const cases: Array<[string, string[]]> = [
      ["docs/plan/README.md", ["docs"]],
      ["docs/runbooks/review-x.md", ["docs"]],
      ["README.md", ["docs"]],
      ["LICENSE", ["docs"]],
      ["docs/review/README.md", ["global"]],
      ["packages/db/src/schema.ts", ["db", "server"]],
      ["packages/audit/src/chain.ts", ["db", "server"]],
      ["packages/kyc/src/flow.db.test.ts", ["db", "server"]],
      ["apps/api/src/main.ts", ["server"]],
      ["apps/edge/src/main.ts", ["server"]],
      ["apps/payments/src/hooks/x.ts", ["server"]],
      ["apps/connector/src/main.ts", ["server"]],
      ["apps/console/src/server/main.ts", ["server"]],
      ["apps/console/package.json", ["server"]],
      ["apps/console/README.md", ["server"]],
      ["packages/core/src/index.ts", ["server"]],
      ["packages/web-host/src/static/app.ts", ["server"]],
      ["packages/testing/src/seed.ts", ["server"]],
      ["apps/console/src/client/main.tsx", ["client"]],
      ["apps/console/index.html", ["client"]],
      ["apps/admin/public/logo.svg", ["client"]],
      ["apps/verify/_headers", ["client"]],
      ["apps/docs/src/try-it/run.ts", ["client"]],
      ["apps/docs/package.json", ["client"]],
      ["packages/tokens/src/tokens.css", ["client"]],
      ["packages/ui/src/button.tsx", ["client"]],
      ["packages/frame/src/app-frame.tsx", ["client"]],
      ["packages/app-contracts/src/index.ts", ["client"]],
      ["packages/icons/src/index.ts", ["client"]],
      ["packages/motion/fin-motion.css", ["client"]],
      ["ops/docker/app.Dockerfile", ["docker"]],
      [".dockerignore", ["docker"]],
      ["ops/fin/src/main.ts", ["ops"]],
      ["ops/fin/README.md", ["docs", "ops"]],
      ["ops/monitoring/catalog/review.ts", ["ops"]],
      ["ops/watcher/src/index.ts", ["ops"]],
      ["ops/backup/src/main.ts", ["ops"]],
      ["ops/environments/staging.json", ["ops"]],
      ["ops/credentials.json", ["ops"]],
      ["tools/static-deploy/src/main.ts", ["ops"]],
      ["packages/contract/openapi/keys.json", ["server", "contract"]],
      ["scripts/public-safety.mjs", ["scripts"]],
      [".githooks/pre-commit", ["scripts"]],
      [".gitleaks.toml", ["scripts"]],
      ["CODEOWNERS", ["scripts"]],
      ["AGENTS.md", ["docs", "scripts"]],
      [".claude/settings.json", ["scripts"]],
      [".gitignore", ["scripts"]],
      ["nowhere/x.ts", []],
      ["ops/unknown/x.json", []],
      ["tools/other/x.ts", []],
    ];
    for (const [path, expected] of cases) assert.deepEqual(names(map, path), expected, path);
  });

  it("refuses a malformed ci-map.json", () => {
    const classes = rawMap["classes"] as Array<Record<string, unknown>>;
    const replace = (index: number, patch: Record<string, unknown>): unknown => ({
      ...rawMap,
      classes: classes.map((cls, i) => (i === index ? { ...cls, ...patch } : cls)),
    });
    const docs = classes.findIndex((cls) => cls.name === "docs");
    const db = classes.findIndex((cls) => cls.name === "db");
    const server = classes.findIndex((cls) => cls.name === "server");
    for (const bad of [
      null,
      { ...rawMap, version: 2 },
      { ...rawMap, extra: 1 },
      { ...rawMap, always: ["check", "e2e"] },
      { ...rawMap, always: ["deploy"] },
      { ...rawMap, classes: classes.slice(1) },
      { ...rawMap, classes: [...classes, classes[0]] },
      replace(docs, { jobs: ["check", "deploy"] }),
      replace(docs, { jobs: ["check", "bun"] }),
      replace(docs, { jobs: [] }),
      replace(docs, { paths: [] }),
      replace(docs, { paths: ["docs/{a,b}"] }),
      replace(docs, { planned: ["not/a/path/of/docs"] }),
      replace(docs, { colour: "red" }),
      replace(docs, { e2e: "every" }),
      replace(db, { e2e: undefined }),
      replace(db, { e2e: ["console"] }),
      replace(db, { e2eEvery: ["packages/ui/**"] }),
      replace(server, { dbWhen: "always" }),
      replace(0, { jobs: ["check"] }),
    ]) {
      assert.equal(parseCiMap(bad).ok, false, JSON.stringify(bad).slice(0, 200));
    }
  });
});

describe("config/ci.json", () => {
  it("is valid, with 4 e2e shards and the four web apps", () => {
    const parsed = parseCiConfig(rawCi);
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
    if (!parsed.ok) return;
    assert.equal(parsed.value.e2eShards, 4);
    assert.deepEqual(parsed.value.e2eApps, ["apps/console", "apps/admin", "apps/verify", "apps/docs"]);
    assert.equal(parsed.value.dbPackage, "@fin/db");
  });

  it("refuses a malformed ci.json", () => {
    for (const bad of [
      null,
      { ...rawCi, version: 2 },
      { ...rawCi, extra: true },
      { ...rawCi, e2eShards: 0 },
      { ...rawCi, e2eShards: 2.5 },
      { ...rawCi, e2eShards: "4" },
      { ...rawCi, e2eApps: ["console"] },
      { ...rawCi, e2eApps: ["apps/console", "apps/console"] },
      { ...rawCi, workspaces: [] },
      { ...rawCi, workspaces: ["apps/**"] },
      { ...rawCi, packageRoots: ["Apps"] },
      { ...rawCi, dbPackage: "" },
      { ...rawCi, bun: [] },
    ]) {
      assert.equal(parseCiConfig(bad).ok, false, JSON.stringify(bad));
    }
  });
});
