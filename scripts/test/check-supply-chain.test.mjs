// supply-chain:check, with the planted cases of AC-P0-21 and spec 01 §4.2's refusals.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  checkLockfile,
  checkPackageManager,
  checkSupplyChain,
  checkUses,
  checkWorkspace,
  compareVersions,
  exoticKind,
  isDatedApproval,
} from "../check-supply-chain.mjs";
import { parsePolicy } from "../lib/policy-yaml.mjs";
import { cleanUp, makeRepo, REPO_ROOT, readRepoFile, rules, runScript } from "./helpers.mjs";

after(cleanUp);

const WORKSPACE = readRepoFile("pnpm-workspace.yaml");
const APPROVAL = "# 2026-11-21: approved by the owner";
const DEV_ENGINES = { packageManager: { name: "pnpm", version: "12.21.0", onFail: "error" } };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const LOCK_OK = [
  "lockfileVersion: '9.0'",
  "",
  "packages:",
  "",
  "  '@biomejs/biome@2.6.8':",
  "    resolution: {integrity: sha512-AAAA==}",
  "",
  "snapshots:",
  "",
  "  '@biomejs/biome@2.6.8': {}",
  "",
].join("\n");

/**
 * A valid repository, changed by `files`.
 * @param {Record<string, string>} [files]
 */
function fixture(files = {}) {
  return makeRepo({
    "pnpm-workspace.yaml": WORKSPACE,
    "pnpm-lock.yaml": LOCK_OK,
    "package.json": JSON.stringify({
      name: "fin-next",
      private: true,
      packageManager: "pnpm@12.21.0",
      devEngines: DEV_ENGINES,
      engines: { node: ">=26.13.1 <27", pnpm: "12.21.0" },
      devDependencies: { turbo: "catalog:" },
    }),
    "packages/core/package.json": JSON.stringify({
      name: "@fin/core",
      private: true,
      dependencies: { zod: "catalog:" },
    }),
    "tools/static-deploy/package.json": JSON.stringify({
      name: "@fin/static-deploy",
      private: true,
      devDependencies: { wrangler: "catalog:" },
    }),
    ...files,
  });
}

/**
 * @param {string} name
 * @param {object} extra
 */
const pkg = (name, extra) => JSON.stringify({ name, private: true, ...extra });

/**
 * The workspace file with one line replaced or appended.
 * @param {string} from
 * @param {string} to
 */
const workspaceWith = (from, to) => {
  assert.ok(WORKSPACE.includes(from), `fixture text not found: ${from}`);
  return WORKSPACE.replace(from, to);
};

describe("supply-chain:check", () => {
  test("a valid repository passes", () => {
    assert.deepEqual(checkSupplyChain(fixture()), []);
  });

  test("this repository passes", () => {
    assert.deepEqual(checkSupplyChain(REPO_ROOT), []);
  });

  test("an @fin/* dependency that is not workspace:* fails", () => {
    const dir = fixture({
      "packages/ui/package.json": pkg("@fin/ui", { dependencies: { "@fin/core": "^1.0.0" } }),
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["fin-not-workspace"]);
  });

  test("a workspace package without private: true fails", () => {
    const dir = fixture({ "packages/ui/package.json": JSON.stringify({ name: "@fin/ui" }) });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["not-private"]);
  });

  test("a loosened policy key fails", () => {
    for (const [from, to] of [
      ["minimumReleaseAge: 4320", "minimumReleaseAge: 1440"],
      ["minimumReleaseAgeStrict: true", "minimumReleaseAgeStrict: false"],
      ["minimumReleaseAgeIgnoreMissingTime: false", "minimumReleaseAgeIgnoreMissingTime: true"],
      ["trustPolicy: no-downgrade", "trustPolicy: off"],
      ["blockExoticSubdeps: true", "blockExoticSubdeps: false"],
      ["strictDepBuilds: true", "strictDepBuilds: false"],
      ["engineStrict: true", "engineStrict: false"],
    ]) {
      const dir = fixture({ "pnpm-workspace.yaml": workspaceWith(from ?? "", to ?? "") });
      assert.deepEqual(rules(checkSupplyChain(dir)), ["policy-changed"], String(to));
    }
  });

  test("a missing policy key fails", () => {
    const dir = fixture({
      "pnpm-workspace.yaml": workspaceWith("trustPolicy: no-downgrade\n", ""),
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["policy-missing"]);
  });

  test("each loosening key fails, and so does an unknown key", () => {
    for (const key of [
      "minimumReleaseAgeExclude: [left-pad]",
      "trustPolicyExclude: [left-pad]",
      "trustPolicyIgnoreAfter: 10",
      "dangerouslyAllowAllBuilds: true",
      "pnpmfile: .pnpmfile.cjs",
      "globalPnpmfile: x.cjs",
      "configDependencies: {}",
      "onlyBuiltDependencies: []",
    ]) {
      const dir = fixture({ "pnpm-workspace.yaml": `${WORKSPACE}${key}\n` });
      const found = rules(checkSupplyChain(dir));
      assert.ok(found.includes("policy-loosened"), `${key}: ${found.join(", ")}`);
    }
    const dir = fixture({
      "pnpm-workspace.yaml": `${WORKSPACE}registry: https://registry.example.com/\n`,
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["policy-unknown-key"]);
  });

  test("a changed packages list fails", () => {
    const dir = fixture({
      "pnpm-workspace.yaml": workspaceWith("  - ops/backup\n", "  - ops/backup\n  - vendor/*\n"),
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["policy-packages"]);
  });

  test("a pnpmfile fails, and so does an .npmrc", () => {
    assert.deepEqual(
      rules(checkSupplyChain(fixture({ ".pnpmfile.cjs": "module.exports = {};\n" }))),
      ["pnpmfile"],
    );
    assert.deepEqual(
      rules(checkSupplyChain(fixture({ ".pnpmfile.mjs": "export default {};\n" }))),
      ["pnpmfile"],
    );
    assert.deepEqual(
      rules(checkSupplyChain(fixture({ ".npmrc": "registry=https://registry.example.com/\n" }))),
      ["npmrc"],
    );
  });

  test("a uses: not pinned to a SHA fails; a pinned one needs its version comment", () => {
    const workflow = (/** @type {string} */ line) => ({
      ".github/workflows/ci.yml": `jobs:\n  a:\n    steps:\n      - ${line}\n`,
    });
    assert.deepEqual(rules(checkSupplyChain(fixture(workflow("uses: actions/checkout@v6")))), [
      "action-unpinned",
    ]);
    assert.deepEqual(rules(checkSupplyChain(fixture(workflow(`uses: actions/checkout@${SHA}`)))), [
      "action-unpinned",
    ]);
    assert.deepEqual(
      checkSupplyChain(fixture(workflow(`uses: actions/checkout@${SHA} # v6.0.1`))),
      [],
    );
    assert.deepEqual(checkSupplyChain(fixture(workflow("uses: ./.github/actions/setup"))), []);
    assert.deepEqual(rules(checkUses("x.yml", "    uses: docker://alpine:3\n")), [
      "action-unpinned",
    ]);
  });

  test("a refused package in the lockfile fails", () => {
    for (const name of [
      "@radix-ui/react-dialog",
      "@tanstack/react-start",
      "@tanstack/start-server-core",
      "clsx",
      "tailwind-merge",
      "@phosphor-icons/react",
      "react-server-dom-webpack",
      "@fontsource-variable/inter",
    ]) {
      const lock = LOCK_OK.replace(
        "packages:\n",
        `packages:\n\n  '${name}@1.0.0':\n    resolution: {integrity: sha512-BBBB==}\n`,
      );
      assert.deepEqual(
        rules(checkSupplyChain(fixture({ "pnpm-lock.yaml": lock }))),
        ["refused-package"],
        name,
      );
    }
  });

  test("a refused package in a manifest fails", () => {
    for (const name of [
      "@radix-ui/react-dialog",
      "@tanstack/react-start",
      "clsx",
      "tsx",
      "@opentelemetry/api",
      "ioredis",
    ]) {
      const dir = fixture({
        "packages/ui/package.json": pkg("@fin/ui", { dependencies: { [name]: "catalog:" } }),
      });
      assert.ok(rules(checkSupplyChain(dir)).includes("refused-package"), name);
    }
  });

  test("wrangler in a manifest other than tools/static-deploy/package.json fails", () => {
    const dir = fixture({
      "apps/console/package.json": pkg("@fin/console", {
        devDependencies: { wrangler: "catalog:" },
      }),
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["wrangler-outside-static-deploy"]);
    const root = fixture({
      "package.json": JSON.stringify({
        name: "fin-next",
        private: true,
        packageManager: "pnpm@12.21.0",
        devEngines: DEV_ENGINES,
        engines: { pnpm: "12.21.0" },
        devDependencies: { wrangler: "catalog:" },
      }),
    });
    assert.deepEqual(rules(checkSupplyChain(root)), ["wrangler-outside-static-deploy"]);
  });

  test("@ui-sdk/* outside packages/ui/package.json fails", () => {
    const dir = fixture({
      "apps/console/package.json": pkg("@fin/console", {
        dependencies: { "@ui-sdk/react": "catalog:" },
      }),
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["ui-sdk-outside-ui"]);
    const ui = fixture({
      "packages/ui/package.json": pkg("@fin/ui", { dependencies: { "@ui-sdk/react": "catalog:" } }),
    });
    assert.deepEqual(checkSupplyChain(ui), []);
  });

  test("an allowBuilds entry without its dated comment fails", () => {
    const dir = fixture({
      "pnpm-workspace.yaml": workspaceWith(
        /allowBuilds: \{\}.*\n/.exec(WORKSPACE)?.[0] ?? "",
        "allowBuilds:\n  esbuild: true\n",
      ),
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["allow-builds-undated"]);
  });

  test("an allowBuilds entry with a dated comment passes, false (never run) included", () => {
    const line = /allowBuilds: \{\}.*\n/.exec(WORKSPACE)?.[0] ?? "";
    for (const entry of [`  esbuild: false   ${APPROVAL}\n`, `  ${APPROVAL}\n  workerd: true\n`]) {
      const dir = fixture({ "pnpm-workspace.yaml": workspaceWith(line, `allowBuilds:\n${entry}`) });
      assert.deepEqual(checkSupplyChain(dir), [], entry);
    }
    const notOwner = fixture({
      "pnpm-workspace.yaml": workspaceWith(
        line,
        "allowBuilds:\n  esbuild: false # 2026-11-21: looked fine\n",
      ),
    });
    assert.deepEqual(rules(checkSupplyChain(notOwner)), ["allow-builds-undated"]);
    const badValue = fixture({
      "pnpm-workspace.yaml": workspaceWith(line, `allowBuilds:\n  esbuild: maybe ${APPROVAL}\n`),
    });
    assert.deepEqual(rules(checkSupplyChain(badValue)), ["allow-builds-value"]);
  });

  test("an overrides entry needs its dated comment and, for @better-auth/core, better-auth's version", () => {
    const head = WORKSPACE.split("overrides:")[0] ?? "";
    const undated = fixture({
      "pnpm-workspace.yaml": `${head}overrides:\n  '@better-auth/core': 1.7.25\n`,
    });
    assert.deepEqual(rules(checkSupplyChain(undated)), ["overrides-undated"]);
    const above = fixture({
      "pnpm-workspace.yaml": `${head}overrides:\n  ${APPROVAL}\n  '@better-auth/core': 1.7.25\n`,
    });
    assert.deepEqual(checkSupplyChain(above), []);
    const mismatch = fixture({
      "pnpm-workspace.yaml": `${head}overrides:\n  '@better-auth/core': 1.7.24   ${APPROVAL}\n`,
    });
    assert.deepEqual(rules(checkSupplyChain(mismatch)), ["overrides-better-auth"]);
    const range = fixture({
      "pnpm-workspace.yaml": `${head}overrides:\n  lodash: ^4.0.0   ${APPROVAL}\n`,
    });
    assert.deepEqual(rules(checkSupplyChain(range)), ["overrides-version"]);
  });

  test("a catalog range or tag fails, and catalog groups move together", () => {
    assert.deepEqual(
      rules(
        checkSupplyChain(
          fixture({ "pnpm-workspace.yaml": workspaceWith("zod: 4.6.7", "zod: ^4.6.7") }),
        ),
      ),
      ["catalog-version"],
    );
    assert.deepEqual(
      rules(
        checkSupplyChain(
          fixture({ "pnpm-workspace.yaml": workspaceWith("zod: 4.6.7", "zod: latest") }),
        ),
      ),
      ["catalog-version"],
    );
    assert.deepEqual(
      rules(
        checkSupplyChain(
          fixture({
            "pnpm-workspace.yaml": workspaceWith(
              "'@ui-sdk/core': 0.1.0-beta.9",
              "'@ui-sdk/core': 0.1.0-beta.10",
            ),
          }),
        ),
      ),
      ["catalog-group"],
    );
  });

  test("git, tarball, local-path and alias dependencies fail", () => {
    for (const spec of [
      "github:owner/repo",
      "git+https://example.com/x.git",
      "owner/repo",
      "https://example.com/x.tgz",
      "file:../x",
      "link:../x",
      "../x",
      "npm:other@1.0.0",
    ]) {
      const dir = fixture({
        "packages/ui/package.json": pkg("@fin/ui", { dependencies: { thing: spec } }),
      });
      assert.deepEqual(rules(checkSupplyChain(dir)), ["exotic-dependency"], spec);
    }
  });

  test("a dependency not taken from the catalog fails", () => {
    const dir = fixture({
      "packages/ui/package.json": pkg("@fin/ui", { dependencies: { zod: "4.6.7" } }),
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["not-from-catalog"]);
    const missing = fixture({
      "packages/ui/package.json": pkg("@fin/ui", { dependencies: { "left-pad": "catalog:" } }),
    });
    assert.deepEqual(rules(checkSupplyChain(missing)), ["catalog-missing"]);
  });

  test("manifest fields that bypass the policy fail", () => {
    for (const field of ["pnpm", "resolutions", "overrides", "bundledDependencies"]) {
      const dir = fixture({ "packages/ui/package.json": pkg("@fin/ui", { [field]: {} }) });
      assert.deepEqual(rules(checkSupplyChain(dir)), ["manifest-bypass"], field);
    }
  });

  test("seroval below 1.6.11 fails; at or above passes", () => {
    const lock = (/** @type {string} */ v) =>
      LOCK_OK.replace(
        "packages:\n",
        `packages:\n\n  seroval@${v}:\n    resolution: {integrity: sha512-CCCC==}\n`,
      );
    assert.deepEqual(rules(checkLockfile(lock("1.6.10"))), ["seroval-floor"]);
    assert.deepEqual(checkLockfile(lock("1.6.11")), []);
    assert.deepEqual(checkLockfile(lock("1.7.0")), []);
  });

  test("a lockfile package not resolved from the registry fails", () => {
    const lock = LOCK_OK.replace(
      "packages:\n",
      "packages:\n\n  thing@1.0.0:\n    resolution: {tarball: https://example.com/thing.tgz}\n",
    );
    assert.deepEqual(rules(checkLockfile(lock)), ["exotic-resolution"]);
  });

  test("the packageManager pin must be exact and match engines.pnpm", () => {
    const dir = fixture({
      "package.json": JSON.stringify({
        name: "fin-next",
        private: true,
        packageManager: "pnpm@^12",
        engines: { pnpm: "12.21.0" },
      }),
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["package-manager"]);
  });

  test("devEngines.packageManager must refuse a mismatch (onFail error) at the same version", () => {
    const base = {
      name: "fin-next",
      private: true,
      packageManager: "pnpm@12.21.0",
      engines: { pnpm: "12.21.0" },
    };
    const good = { packageManager: { name: "pnpm", version: "12.21.0", onFail: "error" } };
    assert.deepEqual(checkPackageManager("package.json", { ...base, devEngines: good }), []);
    for (const devEngines of [
      undefined,
      { packageManager: { ...good.packageManager, onFail: "download" } },
      { packageManager: { ...good.packageManager, version: "12.20.0" } },
      { packageManager: { ...good.packageManager, name: "npm" } },
    ]) {
      assert.deepEqual(rules(checkPackageManager("package.json", { ...base, devEngines })), [
        "package-manager",
      ]);
    }
  });

  test("YAML outside the supported subset is refused", () => {
    for (const extra of [
      "x: &a 1\n",
      "y: !!str 1\n",
      "---\n",
      "z:\n  - a\n  b: c\n",
      "catalog2: |\n  text\n",
    ]) {
      const { errors } = parsePolicy(`${WORKSPACE}${extra}`);
      assert.ok(errors.length > 0, extra);
    }
    assert.ok(rules(checkWorkspace(`${WORKSPACE}\tbad: 1\n`).findings).includes("policy-syntax"));
  });

  test("the command exits 1 and prints file, line and rule", () => {
    const dir = fixture({
      "pnpm-workspace.yaml": workspaceWith("minimumReleaseAge: 4320", "minimumReleaseAge: 0"),
    });
    const run = runScript("scripts/check-supply-chain.mjs", ["--root", dir]);
    assert.equal(run.status, 1);
    assert.match(run.output, /^pnpm-workspace\.yaml:\d+ policy-changed: /m);
  });
});

describe("supply-chain helpers", () => {
  test("dated approvals", () => {
    assert.ok(
      isDatedApproval("# 2026-11-21: approved by the orchestrator under the owner's delegation"),
    );
    assert.ok(isDatedApproval("# 2026-11-21: the owner said yes"));
    assert.ok(!isDatedApproval("# approved by the owner"));
    assert.ok(!isDatedApproval("# 2026-02-30: the owner said yes"));
    assert.ok(!isDatedApproval("# 2026-11-21: approved"));
  });

  test("exotic specs", () => {
    assert.equal(exoticKind("1.2.3"), undefined);
    assert.equal(exoticKind("catalog:"), undefined);
    assert.equal(exoticKind("^1.2.3 || ^2"), undefined);
    assert.equal(exoticKind("gitlab:a/b"), "a git URL");
  });

  test("version order", () => {
    assert.ok(compareVersions("1.6.10", "1.6.11") < 0);
    assert.ok(compareVersions("1.6.11-beta.1", "1.6.11") < 0);
    assert.equal(compareVersions("1.6.11", "1.6.11"), 0);
  });
});
