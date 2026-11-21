// supply-chain:check, with the planted cases of AC-P0-21 and spec 01 §4.2's refusals.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  checkLockfile,
  checkManifest,
  checkPackageManager,
  checkSupplyChain,
  checkUses,
  checkWorkspace,
  compareVersions,
  exoticKind,
  isDatedApproval,
  parsePolicy,
} from "../check-supply-chain.mjs";
import { cleanUp, git, makeRepo, REPO_ROOT, readRepoFile, rules, runScript } from "./helpers.mjs";

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

/** The lockfile with `text` added at the start of the packages section. */
const lockWithPackage = (/** @type {string} */ text) =>
  LOCK_OK.replace("packages:\n", `packages:\n\n${text}`);

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

  test("a key after a carriage return is read as pnpm reads it, and the carriage return fails", () => {
    // YAML ends a line at a lone CR, so these keys are real settings to pnpm.
    for (const text of [
      `${WORKSPACE}# reviewed 2026-11-21\rminimumReleaseAgeExclude:\r  - '@sentry/*'\n`,
      workspaceWith(
        "engineStrict: true\n",
        "engineStrict: true # keep in step\rdangerouslyAllowAllBuilds: true\rtrustPolicyExclude: ['*']\n",
      ),
      workspaceWith(
        /allowBuilds: \{\}.*\n/.exec(WORKSPACE)?.[0] ?? "",
        "allowBuilds: {}   # none yet\rminimumReleaseAgeExclude: ['*']\n",
      ),
    ]) {
      const { findings } = checkWorkspace(text);
      assert.deepEqual(rules(findings), ["policy-loosened", "policy-syntax"]);
      assert.ok(findings.some((f) => /carriage return/.test(f.message)));
      const dir = fixture({ "pnpm-workspace.yaml": text });
      assert.deepEqual(rules(checkSupplyChain(dir)), ["policy-loosened", "policy-syntax"]);
    }
    // CRLF line endings are refused too: the policy file is LF only.
    assert.deepEqual(rules(checkWorkspace(WORKSPACE.replaceAll("\n", "\r\n")).findings), [
      "policy-syntax",
    ]);
  });

  test("control, separator and invisible characters in the policy file fail", () => {
    for (const char of ["\u0000", "\u000b", "\u000c", "\u001e", "\u0085", "\u2028", "\u2029"]) {
      const text = workspaceWith("engineStrict: true\n", `engineStrict: true # a${char}b\n`);
      assert.deepEqual(rules(checkWorkspace(text).findings), ["policy-syntax"], escape(char));
    }
    assert.ok(rules(checkWorkspace(`\ufeff${WORKSPACE}`).findings).includes("policy-syntax"));
  });

  test("a space before a key's colon fails", () => {
    const dir = fixture({
      "pnpm-workspace.yaml": workspaceWith("engineStrict: true", "engineStrict : true"),
    });
    assert.ok(rules(checkSupplyChain(dir)).includes("policy-syntax"));
  });

  test("a changed packages list fails", () => {
    const dir = fixture({
      "pnpm-workspace.yaml": workspaceWith("  - ops/backup\n", "  - ops/backup\n  - vendor/*\n"),
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["policy-packages"]);
  });

  test("a pnpmfile fails, and so does an .npmrc", () => {
    for (const name of [".pnpmfile.cjs", ".pnpmfile.mjs", "pnpmfile.js", ".pnpmfile.mts"]) {
      assert.deepEqual(rules(checkSupplyChain(fixture({ [name]: "export default {};\n" }))), [
        "pnpmfile",
      ]);
    }
    assert.deepEqual(
      rules(checkSupplyChain(fixture({ ".npmrc": "registry=https://registry.example.com/\n" }))),
      ["npmrc"],
    );
  });

  test("a manifest pnpm reads besides package.json fails, wherever it is", () => {
    for (const file of [
      "packages/identity/package.yaml",
      "packages/identity/package.yml",
      "packages/identity/package.json5",
      "apps/console/package.yaml",
      "package.yaml",
      "docs/notes/package.json5",
    ]) {
      const dir = fixture({
        [file]: 'name: "@fin/identity"\ndependencies:\n  is-number: "7.0.0"\n',
      });
      assert.deepEqual(rules(checkSupplyChain(dir)), ["manifest-format"], file);
    }
  });

  test("a symbolic link fails, so pnpm cannot be pointed at a manifest this check skips", () => {
    const dir = fixture({
      "scripts/test/fixture-dir/package.json": JSON.stringify({
        dependencies: { "left-pad": "1.3.0" },
      }),
    });
    symlinkSync("../scripts/test/fixture-dir", join(dir, "packages/linked"));
    git(dir, ["add", "-A"]);
    assert.deepEqual(rules(checkSupplyChain(dir)), ["symlink"]);
    const dangling = fixture();
    symlinkSync("/nonexistent/target", join(dangling, "packages/gone"));
    git(dangling, ["add", "-A"]);
    assert.deepEqual(rules(checkSupplyChain(dangling)), ["symlink"]);
  });

  test("a submodule fails, checked out or not", () => {
    const dir = fixture();
    git(dir, ["update-index", "--add", "--cacheinfo", `160000,${SHA},packages/vendored`]);
    assert.deepEqual(rules(checkSupplyChain(dir)), ["submodule"]);
    mkdirSync(join(dir, "packages/vendored"));
    assert.deepEqual(rules(checkSupplyChain(dir)), ["submodule"]);
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
    assert.deepEqual(
      checkSupplyChain(fixture(workflow(`uses: actions/checkout@${SHA} # v6.0.1   `))),
      [],
    );
    assert.deepEqual(checkSupplyChain(fixture(workflow("uses: ./.github/actions/setup"))), []);
    assert.deepEqual(rules(checkUses("x.yml", "    uses: docker://alpine:3\n")), [
      "action-unpinned",
    ]);
  });

  test("every other YAML spelling of uses fails, pinned or not", () => {
    const steps = (/** @type {string} */ body) => `jobs:\n  a:\n    steps:\n${body}\n`;
    for (const body of [
      "      - { name: co, uses: actions/checkout@v4 }",
      `      - { name: co, uses: actions/checkout@${SHA} } # v4`,
      '      - "uses": actions/checkout@v4',
      "      - 'uses': actions/checkout@v4",
      "      - uses : actions/checkout@v4",
      "      - Uses: actions/checkout@v4",
      '      - {"uses":actions/checkout@v4}',
      "      - ? uses\n        : actions/checkout@v4",
      '      - "u\\x73es": actions/checkout@v4',
      "      - &k uses: actions/checkout@v4",
      "      - *k : actions/checkout@v4",
      "    steps: [{uses: actions/checkout@v4}]",
    ]) {
      assert.deepEqual(rules(checkUses("w.yml", steps(body))), ["action-unpinned"], body);
    }
  });

  test("a lone carriage return or a line separator in a workflow fails, and the lines are read as YAML reads them", () => {
    const text = `jobs:\n  a:\n    steps:\n      - run: true # x\r      - uses: actions/checkout@v4\n`;
    const findings = checkUses("w.yml", text);
    assert.deepEqual(rules(findings), ["action-unpinned"]);
    assert.equal(findings.length, 2); // the carriage return, and the unpinned uses: it starts
    assert.deepEqual(rules(checkUses("w.yml", "jobs: {}\u2028\n")), ["action-unpinned"]);
    // CRLF files are read line by line as GitHub reads them.
    assert.deepEqual(
      checkUses("w.yml", `steps:\r\n  - uses: actions/checkout@${SHA} # v6.0.1\r\n`),
      [],
    );
  });

  test("a local action outside .github/ fails, and action.yml files anywhere are checked", () => {
    assert.deepEqual(rules(checkUses("w.yml", "      - uses: ./tools/setup\n")), [
      "action-unpinned",
    ]);
    const dir = fixture({
      "tools/setup/action.yml":
        "runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n",
    });
    assert.deepEqual(rules(checkSupplyChain(dir)), ["action-unpinned"]);
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
      "@fontsource/inter",
    ]) {
      const lock = lockWithPackage(
        `  '${name}@1.0.0':\n    resolution: {integrity: sha512-BBBB==}\n`,
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
    for (const comment of [
      "# 2026-11-21: looked fine",
      "# 2026-11-21: the owner refused this",
      "# 2026-11-21: waiting for the owner",
      "# 2026-11-21: approved by the owner? not yet",
    ]) {
      const notApproved = fixture({
        "pnpm-workspace.yaml": workspaceWith(line, `allowBuilds:\n  esbuild: false ${comment}\n`),
      });
      assert.deepEqual(rules(checkSupplyChain(notApproved)), ["allow-builds-undated"], comment);
    }
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
    const refused = fixture({
      "pnpm-workspace.yaml": `${head}overrides:\n  '@better-auth/core': 1.7.25   # 2026-11-21: the owner said no\n`,
    });
    assert.deepEqual(rules(checkSupplyChain(refused)), ["overrides-undated"]);
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

  test("a peer dependency comes from the catalog too, since pnpm installs peers itself", () => {
    for (const spec of ["^3.0.0", "3.0.1", "*", ">=1 <2"]) {
      const dir = fixture({
        "packages/evil/package.json": pkg("@fin/evil", { peerDependencies: { "is-odd": spec } }),
      });
      assert.deepEqual(rules(checkSupplyChain(dir)), ["not-from-catalog"], spec);
    }
    const unlisted = fixture({
      "packages/ui/package.json": pkg("@fin/ui", { peerDependencies: { "is-odd": "catalog:" } }),
    });
    assert.deepEqual(rules(checkSupplyChain(unlisted)), ["catalog-missing"]);
    const ui = fixture({
      "packages/ui/package.json": pkg("@fin/ui", {
        peerDependencies: { react: "catalog:", "@fin/tokens": "workspace:*" },
      }),
    });
    assert.deepEqual(checkSupplyChain(ui), []);
  });

  test("manifest fields that bypass the policy fail", () => {
    for (const field of ["pnpm", "resolutions", "overrides", "bundledDependencies"]) {
      const dir = fixture({ "packages/ui/package.json": pkg("@fin/ui", { [field]: {} }) });
      assert.deepEqual(rules(checkSupplyChain(dir)), ["manifest-bypass"], field);
    }
  });

  test("seroval below 1.6.11 fails; at or above passes", () => {
    const lock = (/** @type {string} */ v) =>
      lockWithPackage(`  seroval@${v}:\n    resolution: {integrity: sha512-CCCC==}\n`);
    assert.deepEqual(rules(checkLockfile(lock("1.6.10"))), ["seroval-floor"]);
    assert.deepEqual(checkLockfile(lock("1.6.11")), []);
    assert.deepEqual(checkLockfile(lock("1.7.0")), []);
  });

  test("a lockfile package not resolved from the registry fails", () => {
    const lock = lockWithPackage(
      "  thing@1.0.0:\n    resolution: {tarball: https://example.com/thing.tgz}\n",
    );
    assert.deepEqual(rules(checkLockfile(lock)), ["exotic-resolution"]);
    for (const text of [
      "  thing@1.0.0:\n    engines: {node: '>=18'}\n", // no resolution at all
      "  thing@file:thing-1.0.0.tgz:\n    resolution: {integrity: sha512-DDDD==}\n",
      "  thing@1.0.0:\n    resolution: {integrity: sha512-DDDD==, tarball: https://example.com/t.tgz}\n",
    ]) {
      assert.ok(rules(checkLockfile(lockWithPackage(text))).includes("exotic-resolution"), text);
    }
  });

  test("a lockfile line outside pnpm's own form fails, so nothing in it is skipped", () => {
    const resolution = "    resolution: {tarball: https://example.com/x.tgz}\n";
    for (const text of [
      `  "clsx@2.1.1":\n    resolution: {integrity: sha512-AAAA==}\n`, // a double-quoted key
      `  clsx@2.1.1:\r${resolution}`, // a lone carriage return
      `  thing@1.0.0:\n    "resolution": {tarball: https://example.com/x.tgz}\n`, // a quoted field
      `   clsx@2.1.1:\n      resolution: {integrity: sha512-AAAA==}\n`, // another indentation
      `  thing@1.0.0:\n    resolution: {integrity: sha512-AAAA==,\n      tarball: https://example.com/x.tgz}\n`,
      `  thing@1.0.0:\n    resolution: &r {integrity: sha512-AAAA==}\n`,
      `  thing@1.0.0:\n    resolution: *r\n`,
      `  thing@1.0.0:\n    resolution: !!map {integrity: sha512-AAAA==}\n`,
      `  thing@1.0.0:\n    deprecated: |\n      text\n`,
      `  thing@1.0.0:\n    resolution: {integrity: sha512-AAAA==}\n    name: clsx\n`, // a name override
      `  thing@1.0.0:\n    resolution: {integrity: sha512-AAAA==}\n    version: 2.1.1\n`,
      `  thing@1.0.0:\n    resolution: {integrity: sha512-AAAA==}\n    resolution: {integrity: sha512-BBBB==}\n`,
      `  thing@1.0.0: {resolution: {integrity: sha512-AAAA==}}\n`,
      `  ? thing@1.0.0\n  : resolution: {integrity: sha512-AAAA==}\n`,
      `  # a comment\n  thing@1.0.0:\n    resolution: {integrity: sha512-AAAA==}\n`,
      `  thing@1.0.0:\n    resolution: {integrity: sha512-AAAA==}\n    deprecated: use other\n      more text\n`,
    ]) {
      assert.ok(rules(checkLockfile(lockWithPackage(text))).length > 0, JSON.stringify(text));
    }
  });

  test("a resolution in the snapshots section fails (pnpm would merge it into the package)", () => {
    const lock = LOCK_OK.replace(
      "  '@biomejs/biome@2.6.8': {}",
      "  '@biomejs/biome@2.6.8':\n    resolution: {tarball: https://example.com/x.tgz}",
    );
    assert.deepEqual(rules(checkLockfile(lock)), ["lockfile-format"]);
  });

  test("an unknown lockfile section and a second catalog fail", () => {
    assert.deepEqual(rules(checkLockfile(`${LOCK_OK}patchedDependencies:\n  x: abc\n`)), [
      "lockfile-format",
    ]);
    assert.deepEqual(
      rules(checkLockfile(`${LOCK_OK}catalogs:\n  other:\n    zod:\n      specifier: 4.6.7\n`)),
      ["lockfile-format"],
    );
  });

  test("an importer locked to an exotic version, or to another version than the catalog's, fails", () => {
    const { catalog } = checkWorkspace(WORKSPACE);
    const importer = (/** @type {string} */ specifier, /** @type {string} */ version) =>
      LOCK_OK.replace(
        "packages:\n",
        `importers:\n\n  .:\n    devDependencies:\n      zod:\n        specifier: ${specifier}\n        version: ${version}\n\npackages:\n`,
      );
    assert.deepEqual(checkLockfile(importer("'catalog:'", "4.6.7"), catalog), []);
    assert.deepEqual(rules(checkLockfile(importer("'catalog:'", "4.6.6"), catalog)), [
      "lockfile-catalog",
    ]);
    for (const version of ["link:../../evil", "file:evil.tgz", "https://example.com/z.tgz"]) {
      assert.deepEqual(
        rules(checkLockfile(importer("'catalog:'", version), catalog)),
        ["exotic-resolution"],
        version,
      );
    }
    assert.deepEqual(rules(checkLockfile(importer("'catalog:default'", "4.6.6"), catalog)), [
      "lockfile-catalog",
    ]);
    const workspaceLink = (/** @type {string} */ link) =>
      LOCK_OK.replace(
        "packages:\n",
        `importers:\n\n  packages/ui:\n    dependencies:\n      '@fin/core':\n        specifier: workspace:*\n        version: link:${link}\n\npackages:\n`,
      );
    assert.deepEqual(checkLockfile(workspaceLink("../core"), catalog), []);
    for (const link of ["../../../outside", "../../scripts", "../core/../../tools/x"]) {
      assert.deepEqual(
        rules(checkLockfile(workspaceLink(link), catalog)),
        ["exotic-resolution"],
        link,
      );
    }
  });

  test("this repository's lockfile reads cleanly, line by line", () => {
    const { catalog } = checkWorkspace(WORKSPACE);
    assert.deepEqual(checkLockfile(readRepoFile("pnpm-lock.yaml"), catalog), []);
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
  test("dated approvals name the owner's yes in a fixed phrase, with no negation", () => {
    for (const yes of [
      "# 2026-11-21: approved by the owner",
      "# 2026-11-21: approved by the owner (decision 1, DECISIONS short list)",
      "# 2026-11-21: the owner's yes, at the 08:00 sitting",
      "# 2026-11-21: owner's yes",
      "# 2026-11-21: approved by the orchestrator under the owner's delegation",
    ]) {
      assert.ok(isDatedApproval(yes), yes);
    }
    for (const no of [
      "# approved by the owner",
      "# 2026-02-30: approved by the owner",
      "# 2026-11-21: approved",
      "# 2026-11-21: the owner said yes",
      "# 2026-11-21: the owner refused this",
      "# 2026-11-21: waiting for the owner",
      "# 2026-11-21: the owner said no",
      "# 2026-11-21: approved by the owner? no",
      "# 2026-11-21: approved by the owner, if the tests pass",
      "# 2026-11-21: not approved by the owner",
      "# 2026-11-21: approved by the ownership",
      "# 2026-11-21: approved by the owner, then revoked",
    ]) {
      assert.ok(!isDatedApproval(no), no);
    }
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

  test("checkManifest reads a manifest as an object", () => {
    assert.deepEqual(rules(checkManifest("packages/x/package.json", [], new Map())), [
      "manifest-shape",
    ]);
  });
});
