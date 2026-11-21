// layout:check, with the planted cases of AC-P0-19.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import { checkLayout, entryFor, parseCodeowners, validateLayout } from "../layout-check.mjs";
import { cleanUp, makeRepo, REPO_ROOT, rules, runScript } from "./helpers.mjs";

after(cleanUp);

const CONTROL = [
  "CODEOWNERS",
  "tools/layout.json",
  "packages/web-host/src/static/",
  "apps/*/static.json",
];

/**
 * A small, valid repository: a root entry, an active package, an active app with a static
 * output, a planned package and the plan's folder.
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
    CODEOWNERS: `${CONTROL.map((p) => `/${p} @owner`).join("\n")}\n`,
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
      "The day lanes add packages/money and @fin/money later.\n",
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
    const dir = fixture({
      files: {
        CODEOWNERS: `${CONTROL.map((p) => `/${p} @owner`).join("\n")}\n/ops/extra/ @owner\n`,
      },
    });
    const { findings } = checkLayout(dir);
    assert.deepEqual(rules(findings), ["codeowners-drift"]);
    assert.equal(findings[0]?.line, 5);
  });

  test("a control path missing from CODEOWNERS fails", () => {
    const dir = fixture({
      files: {
        CODEOWNERS: "/CODEOWNERS @owner\n/tools/layout.json @owner\n/apps/*/static.json @owner\n",
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
        CODEOWNERS:
          "/CODEOWNERS @owner\n/tools/layout.json @owner\n/packages/web-host/src/static/ @owner\n",
      },
    });
    const found = checkLayout(dir).findings;
    assert.deepEqual(rules(found), ["static-not-control"]);
    assert.ok(found.every((f) => f.file === "apps/console/static.json"));
  });

  test("a header profile outside controlPaths fails", () => {
    const dir = fixture({
      layout: (l) => {
        l.controlPaths = l.controlPaths.filter(
          (/** @type {string} */ p) => p !== "packages/web-host/src/static/",
        );
      },
      files: {
        CODEOWNERS: "/CODEOWNERS @owner\n/tools/layout.json @owner\n/apps/*/static.json @owner\n",
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

  test("a package whose name differs from its entry fails", () => {
    const dir = fixture({
      files: {
        "packages/core/package.json": JSON.stringify({ name: "@fin/kernel", private: true }),
      },
    });
    assert.deepEqual(rules(checkLayout(dir).findings), ["package-name"]);
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
    const { patterns } = parseCodeowners("# c\n\n/a/ @o\n/b @o @p\n");
    assert.deepEqual(patterns, [
      { pattern: "a/", line: 3 },
      { pattern: "b", line: 4 },
    ]);
  });
});
