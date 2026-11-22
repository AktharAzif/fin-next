// The lint half of the page policy (ARCHITECTURE FW-C18, spec 06 §6.2, AC-UI-01): Biome refuses
// dangerouslySetInnerHTML everywhere, packages/ui included, and no override or nested
// configuration turns the rule off. imports:check refuses the same again in code that runs
// (scripts/import-rules.mjs), so a lint override alone cannot drop it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { cleanUp, git, makeRepo, REPO_ROOT } from "./helpers.mjs";

after(cleanUp);

const RULE = "noDangerouslySetInnerHtml";

/**
 * Every setting a Biome configuration gives the rule, with where it gives it.
 * @param {unknown} config
 * @param {string} where
 * @returns {[string, unknown][]}
 */
function settings(config, where) {
  /** @type {[string, unknown][]} */
  const found = [];
  /** @param {unknown} block @param {string} at */
  const read = (block, at) => {
    const rules = /** @type {any} */ (block)?.linter?.rules;
    if (rules === undefined || rules === null) return;
    for (const group of Object.values(rules)) {
      if (typeof group === "object" && group !== null && RULE in group) {
        found.push([at, /** @type {Record<string, unknown>} */ (group)[RULE]]);
      }
    }
  };
  read(config, where);
  const overrides = /** @type {any} */ (config)?.overrides;
  for (const [index, override] of (Array.isArray(overrides) ? overrides : []).entries()) {
    read(override, `${where} overrides[${index}]`);
  }
  return found;
}

describe("Biome's page-policy rule", () => {
  test("is an error at the root, and no override or nested configuration changes it", () => {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "biome.json"), "utf8"));
    assert.deepEqual(settings(root, "biome.json"), [["biome.json", "error"]]);
    const nested = git(REPO_ROOT, ["ls-files", "-z"])
      .split("\0")
      .filter((path) => /(?:^|\/)biome\.jsonc?$/.test(path) && path !== "biome.json");
    for (const path of nested) {
      const config = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
      assert.equal(config.extends, "//", `${path} extends the root configuration`);
      assert.deepEqual(settings(config, path), [], path);
    }
  });

  test("refuses a planted dangerouslySetInnerHTML in packages/ui as anywhere else", () => {
    const biome = join(REPO_ROOT, "node_modules", ".bin", "biome");
    assert.ok(existsSync(biome), "Biome is installed (pnpm install)");
    const planted = [
      "export function X(p: { html: string }) {",
      "  return <div dangerouslySetInnerHTML={{ __html: p.html }} />;",
      "}",
      "",
    ].join("\n");
    const dir = makeRepo({
      "biome.json": readFileSync(join(REPO_ROOT, "biome.json"), "utf8"),
      "packages/ui/src/x.tsx": planted,
      "packages/icons/src/x.tsx": planted,
      "apps/console/src/client/x.tsx": planted,
    });
    for (const file of [
      "packages/ui/src/x.tsx",
      "packages/icons/src/x.tsx",
      "apps/console/src/client/x.tsx",
    ]) {
      const run = spawnSync(biome, ["lint", file], { cwd: dir, encoding: "utf8" });
      assert.equal(run.status, 1, `${file}: ${run.stdout}${run.stderr}`);
      assert.match(`${run.stdout}${run.stderr}`, new RegExp(`security/${RULE}`), file);
    }
  });
});
