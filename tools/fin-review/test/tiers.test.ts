// T-RV-23 (spec 07 §2.4): tiers from tools/layout.json, here the fixture modelled on spec 01 §4.3.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Layout } from "../src/plan/tiers.ts";
import { maxTier, parseLayout, tierOf } from "../src/plan/tiers.ts";
import { fixtureLayout } from "./helpers/monorepo.ts";

function layout(value: unknown = JSON.parse(fixtureLayout())): Layout {
  const parsed = parseLayout(value);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
  return (parsed as { ok: true; value: Layout }).value;
}

describe("T-RV-23: tiers", () => {
  const fixture = layout();

  it("maps each path by the longest prefix, then the first matching glob", () => {
    const cases: Array<[string, string]> = [
      ["apps/console/src/server/main.ts", "S"],
      ["apps/console/src/client/main.tsx", "N"],
      ["apps/console/index.html", "N"],
      ["apps/console/static.json", "S"],
      ["apps/docs/src/try-it/run.ts", "S"],
      ["apps/docs/src/guides/start.md", "N"],
      ["apps/edge/src/main.ts", "S"],
      ["packages/ui/src/button.tsx", "N"],
      ["packages/core/src/index.ts", "S"],
      ["docs/plan/README.md", "D"],
      ["README.md", "D"],
      ["package.json", "S"],
      ["ops/credentials.json", "S"],
      ["scripts/check.mjs", "S"],
    ];
    for (const [path, tier] of cases) assert.equal(tierOf(fixture, path).tier, tier, path);
  });

  it("an unmapped path is S", () => {
    for (const path of [
      "nowhere/file.ts",
      "apps/unknown/x.ts",
      "LICENSE-OTHER",
      "docs/other/x.md",
    ]) {
      const result = tierOf(fixture, path);
      assert.equal(result.tier, "S", path);
      assert.equal(result.source, "unmapped", path);
    }
  });

  it("a control path is S whatever its entry says", () => {
    for (const path of [
      "docs/review/README.md",
      "apps/console/static.json",
      "AGENTS.md",
      ".github/workflows/ci.yml",
      "tools/layout.json",
    ]) {
      const result = tierOf(fixture, path);
      assert.equal(result.tier, "S", path);
      assert.equal(result.source, "control", path);
    }
  });

  it("a control path written as a folder covers the folder's own path too", () => {
    for (const path of [
      "docs/review",
      ".github",
      ".claude",
      "tools/fin-review",
      "ops/docker",
      "ops/fin",
      "tools/static-deploy",
      "Docs/Review",
    ]) {
      const result = tierOf(fixture, path);
      assert.deepEqual([result.tier, result.source], ["S", "control"], path);
    }
    assert.equal(
      tierOf(fixture, "docs/reviewed.md").source,
      "unmapped",
      "a longer name is not the folder",
    );
  });

  it("refuses image and static output names outside their grammar, and shows a refused value escaped", () => {
    for (const entry of [
      { path: "apps/x", image: "Fin-Next" },
      { path: "apps/x", image: "fin next" },
      { path: "apps/x", image: "a\n::error::b" },
      { path: "apps/x", static: "Kiosk" },
      { path: "apps/x", static: ["ok", "not ok"] },
    ]) {
      const parsed = parseLayout({ version: 1, controlPaths: [], entries: [entry] });
      assert.equal(parsed.ok, false, JSON.stringify(entry));
      if (!parsed.ok)
        for (const error of parsed.errors) assert.match(error, /^[\x20-\x7e]*$/, error);
    }
    const duplicate = parseLayout({
      version: 1,
      controlPaths: [],
      entries: [{ path: "a\nb" }, { path: "a\nb" }],
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok)
      assert.deepEqual(duplicate.errors, ['entries[1].path "a\\u000ab" appears twice']);
    assert.equal(
      parseLayout({
        version: 1,
        controlPaths: [],
        entries: [{ path: "apps/x", image: "fin-next-x", static: ["x", "x-2"] }],
      }).ok,
      true,
    );
  });

  it("matching ignores case, in prefixes, globs and control paths", () => {
    assert.equal(tierOf(fixture, "APPS/Console/src/client/main.tsx").tier, "N");
    assert.equal(tierOf(fixture, "Apps/Console/SRC/Server/main.ts").tier, "S");
    assert.equal(tierOf(fixture, "DOCS/PLAN/x.md").tier, "D");
    assert.equal(tierOf(fixture, "Docs/Review/x.md").source, "control");
  });

  it("a path outside printable ASCII is S, whatever entry or glob it resembles", () => {
    for (const path of [
      "apps/console/src/ſerver/main.ts",
      "apps/console/src/client/é.tsx",
      "pacKages/ui/src/x.ts",
      "docs/plan/Kelvin.md",
      "docs/plan/tab\there.md",
    ]) {
      assert.deepEqual(
        tierOf(fixture, path),
        { tier: "S", source: "not-plain", entry: null },
        JSON.stringify(path),
      );
    }
  });

  it("a prefix matches whole segments only", () => {
    assert.equal(tierOf(fixture, "apps/console2/src/client/x.tsx").source, "unmapped");
    assert.equal(tierOf(fixture, "packages/ui-extra/x.ts").source, "unmapped");
  });

  it("the change takes the highest tier of its paths, and only goes up", () => {
    assert.equal(maxTier("D", "N"), "N");
    assert.equal(maxTier("N", "D"), "N");
    assert.equal(maxTier("N", "S"), "S");
    assert.equal(maxTier("S", "D"), "S");
    assert.equal(maxTier("D", "D"), "D");
  });

  it("with no layout every path is S", () => {
    assert.deepEqual(tierOf(null, "README.md"), { tier: "S", source: "no-layout", entry: null });
  });

  it("an entry whose globs all miss gives S", () => {
    const only = layout({
      version: 1,
      controlPaths: [],
      entries: [{ path: "apps/x", tiers: { "src/client/**": "N" } }],
    });
    assert.equal(tierOf(only, "apps/x/src/client/a.ts").tier, "N");
    assert.deepEqual(
      [tierOf(only, "apps/x/other.ts").tier, tierOf(only, "apps/x/other.ts").source],
      ["S", "entry-default"],
    );
  });

  it("the root entry maps only root files, and only those it lists", () => {
    assert.equal(tierOf(fixture, "README.md").entry?.isRoot, true);
    assert.equal(tierOf(fixture, "LICENSE").source, "unmapped");
    const open = layout({ version: 1, controlPaths: [], entries: [{ path: "", tier: "N" }] });
    assert.equal(tierOf(open, "anything.txt").tier, "N");
    assert.equal(tierOf(open, "dir/anything.txt").source, "unmapped");
  });

  it("accepts a single tier given as `tier` or as a string `tiers`", () => {
    const simple = layout({
      version: 1,
      controlPaths: [],
      entries: [
        { path: "a", tier: "D" },
        { path: "b", tiers: "N" },
      ],
    });
    assert.equal(tierOf(simple, "a/x").tier, "D");
    assert.equal(tierOf(simple, "b/x").tier, "N");
  });

  it("refuses an invalid layout", () => {
    const good = JSON.parse(fixtureLayout()) as Record<string, unknown>;
    for (const bad of [
      null,
      [],
      { ...good, version: 2 },
      { ...good, entries: "x" },
      { ...good, controlPaths: undefined },
      { ...good, controlPaths: [5] },
      { ...good, controlPaths: ["{a,b}"] },
      { version: 1, controlPaths: [], entries: [{ path: "a", tiers: { "**": "X" } }] },
      { version: 1, controlPaths: [], entries: [{ path: "a", tiers: { "[x]": "S" } }] },
      { version: 1, controlPaths: [], entries: [{ path: "a", tiers: { "1": "S" } }] },
      { version: 1, controlPaths: [], entries: [{ path: "a", tier: "s" }] },
      { version: 1, controlPaths: [], entries: [{ path: "/abs" }] },
      { version: 1, controlPaths: [], entries: [{ path: "a/../b" }] },
      { version: 1, controlPaths: [], entries: [{ path: "apps/*" }] },
      { version: 1, controlPaths: [], entries: [{ path: "a" }, { path: "A" }] },
      { version: 1, controlPaths: [], entries: [{ path: "a", files: ["x"] }] },
      { version: 1, controlPaths: [], entries: [{ path: "a", static: 5 }] },
      { version: 1, controlPaths: [], entries: [{ path: "a", image: 5 }] },
      { version: 1, controlPaths: [], entries: [{ path: 5 }] },
      { version: 1, controlPaths: [], entries: [{ path: "x", kind: "root" }] },
    ]) {
      assert.equal(parseLayout(bad).ok, false, JSON.stringify(bad));
    }
  });
});
