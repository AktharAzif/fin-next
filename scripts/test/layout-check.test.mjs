// layout:check, with the planted cases of AC-P0-19.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import {
  CONTROL_PATH_OWNER,
  checkLayout,
  checkTestScripts,
  entryFor,
  parseCodeowners,
  VITEST_SCRIPTS,
  validateLayout,
} from "../layout-check.mjs";
import { cleanUp, makeRepo, REPO_ROOT, rules, runScript } from "./helpers.mjs";

after(cleanUp);

const OWNER = CONTROL_PATH_OWNER;
const CONTROL = [
  "CODEOWNERS",
  "tools/layout.json",
  "packages/web-host/src/static/",
  "apps/*/static.json",
];
const CODEOWNERS = `# Control paths\n${CONTROL.map((p) => `/${p} ${OWNER}`).join("\n")}\n`;

/**
 * A small, valid repository: a root entry, an active package, an active app with a static
 * output, a planned app and a planned package that do not exist yet, and the plan's folder.
 * @param {{ layout?: (layout: any) => void, files?: Record<string, string> }} [change]
 */
function fixture(change = {}) {
  const layout = {
    version: 1,
    controlPaths: [...CONTROL],
    notFin: [{ path: "apps/dashboard", why: "the old product's path" }],
    entries: [
      {
        path: ".",
        kind: "root",
        status: "active",
        lane: "steward",
        tiers: { "**": "S" },
        areas: ["platform"],
        files: ["CODEOWNERS", "README.md"],
      },
      {
        path: "tools/layout.json",
        kind: "file",
        status: "active",
        lane: "steward",
        tiers: { "**": "S" },
        areas: ["platform"],
      },
      {
        path: "packages/core",
        name: "@fin/core",
        kind: "package",
        status: "active",
        lane: "P0-D",
        tiers: { "**": "S" },
        areas: ["core"],
      },
      {
        path: "packages/web-host",
        name: "@fin/web-host",
        kind: "package",
        status: "active",
        lane: "P0-D",
        tiers: { "**": "S" },
        areas: ["web-host"],
      },
      {
        path: "apps/console",
        name: "@fin/console",
        kind: "app",
        status: "active",
        lane: "P0-G",
        tiers: { "src/server/**": "S", "static.json": "S", "**": "N" },
        areas: ["console"],
        static: "console",
      },
      {
        path: "apps/admin",
        name: "@fin/admin",
        kind: "app",
        status: "planned",
        lane: "P0-G",
        tiers: { "src/server/**": "S", "static.json": "S", "**": "N" },
        areas: ["admin"],
        static: "admin",
      },
      {
        path: "packages/money",
        name: "@fin/money",
        kind: "package",
        status: "planned",
        lane: "day lane",
        tiers: { "**": "S" },
        areas: ["money"],
      },
      {
        path: "docs/plan",
        kind: "dir",
        status: "active",
        lane: "steward",
        tiers: { "**": "D" },
        areas: ["plan"],
      },
    ],
  };
  change.layout?.(layout);
  return makeRepo({
    "README.md": "# fixture\n",
    CODEOWNERS,
    "tools/layout.json": JSON.stringify(layout, null, 2),
    "packages/core/package.json": JSON.stringify({ name: "@fin/core", private: true }),
    "packages/core/src/index.ts": "export {};\n",
    "packages/web-host/package.json": JSON.stringify({ name: "@fin/web-host", private: true }),
    "packages/web-host/src/static/app.headers": "/*\n",
    "apps/console/package.json": JSON.stringify({ name: "@fin/console", private: true }),
    "apps/console/static.json": "{}\n",
    "docs/plan/README.md":
      "Uses @fin/core and packages/core, and apps/console/src/server/main.ts.\n" +
      "Calls `GET /apps/github-actions` and names the old apps/dashboard/** glue.\n" +
      "The day lanes add packages/money and @fin/money, and apps/admin, later.\n",
    ...change.files,
  });
}

describe("layout:check", () => {
  test("a valid repository passes", () => {
    const { findings, warnings } = checkLayout(fixture());
    assert.deepEqual(findings, []);
    assert.deepEqual(warnings, []);
  });

  test("this repository's own layout passes", () => {
    const { findings } = checkLayout(REPO_ROOT);
    assert.deepEqual(findings, []);
  });

  test("a planted unmapped file fails", () => {
    const dir = fixture({ files: { "stray/notes.txt": "x\n" } });
    const { findings } = checkLayout(dir);
    assert.deepEqual(rules(findings), ["unmapped-file"]);
    assert.equal(findings[0]?.file, "stray/notes.txt");
  });

  test("a root file not listed by name fails", () => {
    assert.deepEqual(rules(checkLayout(fixture({ files: { Makefile: "all:\n" } })).findings), [
      "unmapped-file",
    ]);
  });

  test("an untracked, unignored new file is caught too", () => {
    const dir = fixture();
    writeFileSync(`${dir}/loose.txt`, "x\n");
    assert.deepEqual(rules(checkLayout(dir).findings), ["unmapped-file"]);
  });

  test("a planted docs/plan mention of an unlisted package fails, with its line", () => {
    const dir = fixture({
      files: {
        "docs/plan/specs/09.md": "Intro.\nThe lane adds @fin/ledger and packages/ledger.\n",
      },
    });
    const { findings } = checkLayout(dir);
    assert.deepEqual(rules(findings), ["plan-unlisted"]);
    assert.equal(findings.length, 2);
    assert.deepEqual(
      findings.map((f) => `${f.file}:${f.line}`),
      ["docs/plan/specs/09.md:2", "docs/plan/specs/09.md:2"],
    );
  });

  test("an unlisted apps/* mention fails too", () => {
    const dir = fixture({ files: { "docs/plan/x.md": "Then apps/portal ships.\n" } });
    assert.deepEqual(rules(checkLayout(dir).findings), ["plan-unlisted"]);
  });

  test("a CODEOWNERS line missing from controlPaths fails", () => {
    const dir = fixture({ files: { CODEOWNERS: `${CODEOWNERS}/ops/extra/ ${OWNER}\n` } });
    const { findings } = checkLayout(dir);
    assert.deepEqual(rules(findings), ["codeowners-drift"]);
    assert.equal(findings[0]?.line, 6);
  });

  test("a control path missing from CODEOWNERS fails", () => {
    const dir = fixture({
      files: {
        CODEOWNERS: `/CODEOWNERS ${OWNER}\n/tools/layout.json ${OWNER}\n/apps/*/static.json ${OWNER}\n`,
      },
    });
    const { findings } = checkLayout(dir);
    assert.deepEqual(rules(findings), ["codeowners-drift"]);
    assert.match(findings[0]?.message ?? "", /packages\/web-host\/src\/static\//);
  });

  test("a CODEOWNERS line without an owner fails", () => {
    const dir = fixture({ files: { CODEOWNERS: `${CONTROL.map((p) => `/${p}`).join("\n")}\n` } });
    assert.deepEqual(rules(checkLayout(dir).findings), ["codeowners-owner"]);
  });

  test("a CODEOWNERS line that hands a control path to anyone else fails", () => {
    for (const extra of [
      "/CODEOWNERS @someone-else\n", // GitHub applies the last matching line
      `/tools/layout.json ${OWNER} @someone-else\n`,
      `/tools/layout.json ${OWNER}\n`, // a pattern twice
    ]) {
      const dir = fixture({ files: { CODEOWNERS: `${CODEOWNERS}${extra}` } });
      assert.deepEqual(rules(checkLayout(dir).findings), ["codeowners-owner"], extra);
    }
    const other = fixture({
      files: { CODEOWNERS: CODEOWNERS.replaceAll(OWNER, "@someone-else") },
    });
    assert.deepEqual(rules(checkLayout(other).findings), ["codeowners-owner"]);
  });

  test("a line hidden after a carriage return in CODEOWNERS is read, and the carriage return fails", () => {
    const dir = fixture({
      files: { CODEOWNERS: `# Control paths\r/CODEOWNERS @someone-else\n${CODEOWNERS}` },
    });
    assert.deepEqual(rules(checkLayout(dir).findings), ["codeowners-format", "codeowners-owner"]);
    assert.deepEqual(rules(parseCodeowners(`/a ${OWNER}\u{200B}\n`).findings), [
      "codeowners-format",
      "codeowners-owner",
    ]);
  });

  test("a packages/* directory with no entry fails", () => {
    const dir = fixture({
      files: {
        "packages/ledger/package.json": JSON.stringify({ name: "@fin/ledger", private: true }),
      },
    });
    const { findings } = checkLayout(dir);
    assert.deepEqual(rules(findings), ["unlisted-package-dir", "unmapped-file"]);
  });

  test("an app's static.json outside controlPaths fails", () => {
    const dir = fixture({
      layout: (l) => {
        l.controlPaths = l.controlPaths.filter(
          (/** @type {string} */ p) => p !== "apps/*/static.json",
        );
      },
      files: {
        CODEOWNERS: `/CODEOWNERS ${OWNER}\n/tools/layout.json ${OWNER}\n/packages/web-host/src/static/ ${OWNER}\n`,
      },
    });
    const found = checkLayout(dir).findings;
    assert.deepEqual(rules(found), ["static-not-control"]);
    assert.ok(found.every((f) => f.file.endsWith("/static.json")));
  });

  test("a header profile outside controlPaths fails", () => {
    const dir = fixture({
      layout: (l) => {
        l.controlPaths = l.controlPaths.filter(
          (/** @type {string} */ p) => p !== "packages/web-host/src/static/",
        );
      },
      files: {
        CODEOWNERS: `/CODEOWNERS ${OWNER}\n/tools/layout.json ${OWNER}\n/apps/*/static.json ${OWNER}\n`,
      },
    });
    const found = checkLayout(dir).findings;
    assert.deepEqual(rules(found), ["static-not-control"]);
    assert.equal(found[0]?.file, "packages/web-host/src/static/app.headers");
  });

  test("an active app with a static output and no static.json fails", () => {
    const dir = fixture();
    rmSync(`${dir}/apps/console/static.json`);
    assert.deepEqual(rules(checkLayout(dir).findings), ["static-json-missing"]);
  });

  test("a planned app that exists without its static.json fails too (BD-08 relaxes only the status rule)", () => {
    const dir = fixture({
      files: {
        "apps/admin/package.json": JSON.stringify({ name: "@fin/admin", private: true }),
        "apps/admin/src/client/main.ts": "export {};\n",
      },
    });
    const { findings, warnings } = checkLayout(dir);
    assert.deepEqual(rules(findings), ["static-json-missing"]);
    assert.equal(findings[0]?.file, "apps/admin/static.json");
    assert.deepEqual(rules(warnings), ["planned-exists"]);
    const complete = fixture({
      files: {
        "apps/admin/package.json": JSON.stringify({ name: "@fin/admin", private: true }),
        "apps/admin/static.json": "{}\n",
      },
    });
    assert.deepEqual(checkLayout(complete).findings, []);
  });

  test("an active entry whose path does not exist fails", () => {
    const dir = fixture({
      layout: (l) => {
        l.entries.push({
          path: "ops/docker",
          kind: "dir",
          status: "active",
          lane: "P0-D",
          tiers: { "**": "S" },
          areas: ["images"],
        });
      },
    });
    assert.deepEqual(rules(checkLayout(dir).findings), ["active-missing"]);
  });

  test("a planned entry whose path exists is a warning, not a failure (BD-08)", () => {
    const dir = fixture({
      files: {
        "packages/money/package.json": JSON.stringify({ name: "@fin/money", private: true }),
      },
    });
    const { findings, warnings } = checkLayout(dir);
    assert.deepEqual(findings, []);
    assert.deepEqual(rules(warnings), ["planned-exists"]);
    assert.equal(runScript("scripts/layout-check.mjs", ["--root", dir]).status, 0);
  });

  test("a manifest other than package.json fails, a planned package's included", () => {
    for (const file of [
      "packages/money/package.yaml",
      "packages/money/package.yml",
      "packages/money/package.json5",
      "packages/core/package.yaml",
    ]) {
      const dir = fixture({ files: { [file]: 'name: "@fin/money"\n' } });
      assert.deepEqual(rules(checkLayout(dir).findings), ["manifest-format"], file);
    }
  });

  test("a package whose name differs from its entry fails", () => {
    const dir = fixture({
      files: {
        "packages/core/package.json": JSON.stringify({ name: "@fin/kernel", private: true }),
      },
    });
    assert.deepEqual(rules(checkLayout(dir).findings), ["package-name"]);
  });

  test("a package runs Vitest only through the root configuration", () => {
    const manifest = (/** @type {Record<string, string>} */ scripts) => ({
      "packages/core/package.json": JSON.stringify({ name: "@fin/core", private: true, scripts }),
    });
    const good = fixture({ files: manifest({ ...VITEST_SCRIPTS, lint: "biome check ." }) });
    assert.deepEqual(checkLayout(good).findings, []);
    for (const scripts of [
      { test: "vitest run" },
      { test: "vitest" },
      { test: "vitest run --root ." },
      { "test:db": "vitest run --mode db" },
      { "test:watch": "vitest --config ../../vitest.config.ts" },
    ]) {
      const dir = fixture({ files: manifest(scripts) });
      assert.deepEqual(
        rules(checkLayout(dir).findings),
        ["vitest-config"],
        JSON.stringify(scripts),
      );
    }
    assert.deepEqual(checkTestScripts("x/package.json", { test: "node --test" }), []);
  });

  test("a package's own Vitest configuration fails: the root's is the only one", () => {
    for (const file of [
      "packages/core/vitest.config.ts",
      "packages/core/vitest.config.mts",
      "packages/core/vitest.workspace.ts",
    ]) {
      const dir = fixture({ files: { [file]: "export default {};\n" } });
      assert.deepEqual(rules(checkLayout(dir).findings), ["vitest-config"], file);
    }
  });

  test("a malformed layout fails closed", () => {
    for (const bad of [
      (/** @type {any} */ l) => {
        l.version = 2;
      },
      (/** @type {any} */ l) => {
        l.entries[2].status = "maybe";
      },
      (/** @type {any} */ l) => {
        l.entries[2].name = "core";
      },
      (/** @type {any} */ l) => {
        l.entries[2].tiers = { "src/**": "S" };
      },
      (/** @type {any} */ l) => {
        l.entries.push({ ...l.entries[2] });
      },
      (/** @type {any} */ l) => {
        l.entries[3].path = "packages/web-host/";
      },
    ]) {
      const dir = fixture({ layout: bad });
      assert.deepEqual(rules(checkLayout(dir).findings), ["layout-schema"]);
    }
  });

  test("the command prints file and rule and exits 1 on a finding", () => {
    const dir = fixture({ files: { "stray.txt": "x\n" } });
    const run = runScript("scripts/layout-check.mjs", ["--root", dir]);
    assert.equal(run.status, 1);
    assert.match(run.output, /^stray\.txt unmapped-file: /m);
  });
});

describe("layout helpers", () => {
  test("the longest path prefix wins", () => {
    const { layout } = validateLayout({
      version: 1,
      controlPaths: [],
      entries: [
        {
          path: ".",
          kind: "root",
          status: "active",
          lane: "s",
          tiers: { "**": "S" },
          areas: ["a"],
          files: ["a.md"],
        },
        {
          path: "docs",
          kind: "dir",
          status: "active",
          lane: "s",
          tiers: { "**": "D" },
          areas: ["a"],
        },
        {
          path: "docs/review",
          kind: "dir",
          status: "active",
          lane: "s",
          tiers: { "**": "D" },
          areas: ["a"],
        },
      ],
    });
    assert.ok(layout);
    assert.equal(entryFor(layout, "docs/review/x.md")?.path, "docs/review");
    assert.equal(entryFor(layout, "docs/reviewer.md")?.path, "docs");
    assert.equal(entryFor(layout, "a.md")?.kind, "root");
    assert.equal(entryFor(layout, "b.md"), undefined);
  });

  test("CODEOWNERS parsing drops the leading slash and keeps line numbers", () => {
    const { patterns, findings } = parseCodeowners(`# c\n\n/a/ ${OWNER}\n/b ${OWNER}\n`);
    assert.deepEqual(patterns, [
      { pattern: "a/", line: 3 },
      { pattern: "b", line: 4 },
    ]);
    assert.deepEqual(findings, []);
  });
});
