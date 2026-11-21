#!/usr/bin/env node
// supply-chain:check (spec 01 §4.2; ARCHITECTURE §7.13; DECISIONS G-06, SA-02). A control path.
// It refuses, in tracked files:
//   - pnpm-workspace.yaml with a policy key missing or changed, an unknown key, or a key that
//     loosens the policy (minimumReleaseAgeExclude, trustPolicyExclude, trustPolicyIgnoreAfter,
//     dangerouslyAllowAllBuilds, pnpmfile, globalPnpmfile, configDependencies, ...);
//   - an allowBuilds or overrides entry without a dated comment naming the owner's yes (an
//     allowBuilds entry set to false, meaning "never run this script", is accepted with one);
//   - a catalog entry that is not one exact version;
//   - a pnpmfile or a .npmrc;
//   - a dependency spec that is a git URL, a tarball URL, a local path or an alias, an @fin/*
//     dependency that is not workspace:*, any other dependency not taken from the catalog;
//   - a workspace package without "private": true, or a manifest field that bypasses the policy
//     (pnpm, resolutions, overrides, bundledDependencies);
//   - a refused package (FW-C01, OD-5, ARCHITECTURE §3.3's "not used" list) in a manifest, the
//     catalog or the lockfile; wrangler outside tools/static-deploy/package.json; @ui-sdk/*
//     outside packages/ui/package.json; seroval or seroval-plugins below 1.6.11; a lockfile
//     package resolved from anything but the registry;
//   - a root package.json whose pnpm pin is not exact, or lacks devEngines.packageManager with
//     onFail "error" (without it pnpm 12 downloads whatever packageManager names; SP-01);
//   - a `uses:` in .github/ not pinned to a 40-character commit SHA with a version comment.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePolicy } from "./lib/policy-yaml.mjs";
import { globToRegExp, isRecord, listFiles, readJson, report } from "./lib/repo.mjs";

/** @typedef {import("./lib/repo.mjs").Finding} Finding */
/** @typedef {import("./lib/policy-yaml.mjs").Item} Item */

const WORKSPACE = "pnpm-workspace.yaml";
const LOCKFILE = "pnpm-lock.yaml";

/** The exact package globs (spec 01 §4.2). */
export const PACKAGE_GLOBS = [
  "apps/*",
  "packages/*",
  "tools/fin-review",
  "tools/static-deploy",
  "ops/fin",
  "ops/monitoring",
  "ops/watcher",
  "ops/backup",
];

/** The policy settings and their only accepted values (spec 01 §4.2). */
export const REQUIRED = {
  minimumReleaseAge: 4320,
  minimumReleaseAgeStrict: true,
  minimumReleaseAgeIgnoreMissingTime: false,
  trustPolicy: "no-downgrade",
  blockExoticSubdeps: true,
  strictDepBuilds: true,
  engineStrict: true,
};

const ALLOWED_KEYS = new Set([
  "packages",
  ...Object.keys(REQUIRED),
  "allowBuilds",
  "catalog",
  "overrides",
]);

/** Keys named by spec 01 §4.2 as loosening the policy, with the reason each is refused. */
const LOOSENING = {
  minimumReleaseAgeExclude: "it exempts packages from the release age",
  trustPolicyExclude: "it exempts packages from the trust policy",
  trustPolicyIgnoreAfter: "it switches the trust policy off for older versions",
  dangerouslyAllowAllBuilds: "it lets every install script run",
  onlyBuiltDependencies: "install scripts are approved only through allowBuilds",
  neverBuiltDependencies: "install scripts are decided only through allowBuilds",
  ignoredBuiltDependencies: "install scripts are decided only through allowBuilds",
  pnpmfile: "a pnpmfile can rewrite any manifest at install time",
  globalPnpmfile: "a pnpmfile can rewrite any manifest at install time",
  configDependencies: "config dependencies run code before the policy applies",
  packageExtensions: "it adds dependencies the manifests do not show",
  patchedDependencies: "patches change package code after the registry's checks",
  catalogs: "one default catalog only, so every package has one version",
};

/**
 * Refused packages: [pattern, reason]. A pattern is an exact name or a glob over the name.
 * The first group is also refused in the lockfile, as a dependency of anything.
 * @type {[string, string][]}
 */
const REFUSED_EVERYWHERE = [
  ["@tanstack/react-start", "FW-C01: no server functions"],
  ["@tanstack/react-start-*", "FW-C01: no server functions"],
  ["@tanstack/start-*", "FW-C01: no server functions"],
  ["@vitejs/plugin-rsc", "FW-C01: no server components"],
  ["react-server-dom-*", "FW-C01: no server components"],
  ["@rsbuild/core", "FW-C01"],
  ["@radix-ui/*", "OD-5: controls come from @fin/ui on the UI SDK"],
  ["radix-ui", "OD-5: controls come from @fin/ui on the UI SDK"],
  ["@phosphor-icons/*", "OD-5: glyph data lives in @fin/icons"],
  ["clsx", "OD-5: use the in-house cn in @fin/ui"],
  ["tailwind-merge", "OD-5: use the in-house cn in @fin/ui"],
  ["@fontsource*", "G-06: the fonts are committed files in @fin/tokens"],
  ["@fontsource*/*", "G-06: the fonts are committed files in @fin/tokens"],
];

/** Refused as a direct dependency or catalog entry (ARCHITECTURE §3.3, "not used"). */
/** @type {[string, string][]} */
const REFUSED_DIRECT = [
  ...REFUSED_EVERYWHERE,
  ["tsx", "Node runs TypeScript itself"],
  ["@logtail/*", "Fin has its own log transport"],
  ["@opentelemetry/*", "no tracing at launch (OB-08)"],
  ["libphonenumber-js", "phones are accepted only in E.164"],
  ["redis", "no Redis"],
  ["ioredis", "no Redis"],
  ["@redis/*", "no Redis"],
  ["pg-boss", "a fallback only, with the owner's yes (P-11)"],
  ["@scalar/hono-api-reference", "it loads Scalar from a CDN"],
  ["@railway/cli", "its postinstall downloads a binary"],
  ["react-router-dom", "FW-C18: TanStack Router is the router"],
  ["@remix-run/*", "FW-C18"],
  ["drizzle-kit", "drafts only, outside the repository (G-06)"],
  ["jsdom", "no DOM test environment without the owner's yes"],
  ["happy-dom", "no DOM test environment without the owner's yes"],
  ["@vitest/browser*", "no DOM test environment without the owner's yes"],
  ["@axe-core/playwright", "only with the owner's yes"],
];

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATED_COMMENT = /^#\s*(\d{4})-(\d{2})-(\d{2}):\s*(.+)$/;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const BYPASS_FIELDS = {
  pnpm: "pnpm settings belong in pnpm-workspace.yaml, under this check",
  resolutions: "pnpm applies it as overrides, outside this check",
  overrides: "overrides belong in pnpm-workspace.yaml, with a dated comment",
  bundledDependencies: "bundled packages skip the lockfile and the registry's checks",
  bundleDependencies: "bundled packages skip the lockfile and the registry's checks",
};

/**
 * @param {string} name
 * @param {[string, string][]} list
 * @returns {string | undefined} the reason when refused
 */
export function refusedReason(name, list) {
  for (const [pattern, why] of list) {
    if (pattern.includes("*") ? globToRegExp(pattern).test(name) : name === pattern) return why;
  }
  return undefined;
}

/**
 * Whether a comment is a dated comment naming the owner's yes: `# YYYY-MM-DD: ... owner ...`.
 * @param {string | undefined} comment
 * @returns {boolean}
 */
export function isDatedApproval(comment) {
  if (comment === undefined) return false;
  const match = DATED_COMMENT.exec(comment);
  if (!match) return false;
  const [, y, m, d, text = ""] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`)
    return false;
  return /\bowner\b|\bowner's\b/i.test(text);
}

/**
 * The dated comment on an item, trailing or on the line just above.
 * @param {Item} item
 * @returns {boolean}
 */
function hasDatedApproval(item) {
  return isDatedApproval(item.comment) || (item.above ?? []).some(isDatedApproval);
}

/**
 * Classifies a dependency spec that is not a plain version or range.
 * @param {string} spec
 * @returns {string | undefined} what kind of exotic spec it is
 */
export function exoticKind(spec) {
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(spec) || /\.git(#.*)?$/.test(spec))
    return "a git URL";
  if (/^https?:/.test(spec)) return "a tarball URL";
  if (/^(file:|link:|portal:|\.{0,2}\/|~)/.test(spec)) return "a local path";
  if (spec.startsWith("npm:") || spec.startsWith("jsr:")) return "an alias";
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)) return "a git URL (GitHub shorthand)";
  return undefined;
}

/**
 * Checks pnpm-workspace.yaml.
 * @param {string} text
 * @returns {{ findings: Finding[], catalog: Map<string, Item> }}
 */
export function checkWorkspace(text) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Map<string, Item>} */
  let catalog = new Map();
  /**
   * @param {number | undefined} line
   * @param {string} rule
   * @param {string} message
   */
  const add = (line, rule, message) =>
    findings.push({ file: WORKSPACE, ...(line === undefined ? {} : { line }), rule, message });
  const { keys, errors } = parsePolicy(text);
  for (const error of errors) add(error.line, "policy-syntax", error.message);

  for (const [key, node] of keys) {
    if (key in LOOSENING) {
      add(
        node.line,
        "policy-loosened",
        `${key} is refused: ${LOOSENING[/** @type {keyof typeof LOOSENING} */ (key)]}`,
      );
    } else if (!ALLOWED_KEYS.has(key)) {
      add(
        node.line,
        "policy-unknown-key",
        `${key} is not one of the policy's keys; a new setting needs the owner`,
      );
    }
  }
  for (const [key, expected] of Object.entries(REQUIRED)) {
    const node = keys.get(key);
    if (node === undefined)
      add(undefined, "policy-missing", `${key} is missing (it must be ${expected})`);
    else if (node.kind !== "scalar" || node.value !== expected) {
      add(node.line, "policy-changed", `${key} must be ${expected}`);
    }
  }

  const packages = keys.get("packages");
  const globs = packages?.kind === "list" ? packages.items.map((i) => i.value) : undefined;
  if (globs === undefined || globs.join("\n") !== PACKAGE_GLOBS.join("\n")) {
    add(
      packages?.line,
      "policy-packages",
      `packages must list exactly: ${PACKAGE_GLOBS.join(", ")}`,
    );
  }

  const allowBuilds = keys.get("allowBuilds");
  if (allowBuilds === undefined)
    add(undefined, "policy-missing", "allowBuilds is missing (it must be a map, {} when empty)");
  else if (allowBuilds.kind !== "map")
    add(allowBuilds.line, "policy-changed", "allowBuilds must be a map");
  else {
    for (const [name, item] of allowBuilds.entries) {
      if (typeof item.value !== "boolean") {
        add(item.line, "allow-builds-value", `allowBuilds ${name} must be true or false`);
      }
      if (!hasDatedApproval(item)) {
        add(
          item.line,
          "allow-builds-undated",
          `allowBuilds ${name} needs a dated comment naming the owner's yes`,
        );
      }
    }
  }

  const overrides = keys.get("overrides");
  if (overrides !== undefined) {
    if (overrides.kind !== "map") add(overrides.line, "overrides-shape", "overrides must be a map");
    else {
      for (const [name, item] of overrides.entries) {
        if (typeof item.value !== "string" || !EXACT_VERSION.test(item.value)) {
          add(item.line, "overrides-version", `overrides ${name} must pin one exact version`);
        }
        if (!hasDatedApproval(item)) {
          add(
            item.line,
            "overrides-undated",
            `overrides ${name} needs a dated comment naming the owner's yes`,
          );
        }
      }
    }
  }

  const catalogNode = keys.get("catalog");
  if (catalogNode !== undefined && catalogNode.kind !== "map") {
    add(catalogNode.line, "catalog-shape", "catalog must be a map of package to exact version");
  } else if (catalogNode !== undefined) {
    catalog = catalogNode.entries;
    for (const [name, item] of catalog) {
      if (typeof item.value !== "string" || !EXACT_VERSION.test(item.value)) {
        add(
          item.line,
          "catalog-version",
          `catalog ${name} must be one exact version, never a range or tag`,
        );
      }
      const why = refusedReason(name, REFUSED_DIRECT);
      if (why !== undefined) add(item.line, "refused-package", `${name} is refused (${why})`);
    }
    // Packages that move together (EX-30, SA-02).
    for (const group of [
      ["@ui-sdk/react", "@ui-sdk/core"],
      ["better-auth", "@better-auth/core", "@better-auth/passkey", "@better-auth/drizzle-adapter"],
    ]) {
      const versions = new Set(
        group.filter((n) => catalog.has(n)).map((n) => catalog.get(n)?.value),
      );
      if (versions.size > 1)
        add(
          catalog.get(group[0] ?? "")?.line,
          "catalog-group",
          `${group.join(", ")} must share one version`,
        );
    }
  }
  if (overrides?.kind === "map") {
    const core = overrides.entries.get("@better-auth/core");
    const betterAuth = catalog.get("better-auth");
    if (core !== undefined && betterAuth !== undefined && core.value !== betterAuth.value) {
      add(
        core.line,
        "overrides-better-auth",
        "the @better-auth/core override must equal better-auth's version (SA-02)",
      );
    }
  }
  return { findings, catalog };
}

/**
 * Checks one manifest.
 * @param {string} file the manifest's path
 * @param {unknown} manifest
 * @param {Map<string, Item>} catalog
 * @returns {Finding[]}
 */
export function checkManifest(file, manifest, catalog) {
  /** @type {Finding[]} */
  const findings = [];
  /**
   * @param {string} rule
   * @param {string} message
   */
  const add = (rule, message) => findings.push({ file, rule, message });
  if (!isRecord(manifest)) {
    add("manifest-shape", "a manifest must be a JSON object");
    return findings;
  }
  if (manifest.private !== true)
    add("not-private", 'every workspace package needs "private": true');
  for (const [field, why] of Object.entries(BYPASS_FIELDS)) {
    if (field in manifest) add("manifest-bypass", `the "${field}" field is refused: ${why}`);
  }
  for (const field of DEP_FIELDS) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    if (!isRecord(deps)) {
      add("manifest-shape", `${field} must be an object`);
      continue;
    }
    for (const [name, rawSpec] of Object.entries(deps)) {
      const spec = typeof rawSpec === "string" ? rawSpec.trim() : "";
      const at = `${field} ${name}`;
      if (spec === "") {
        add("dependency-spec", `${at} must be a string`);
        continue;
      }
      const why = refusedReason(name, REFUSED_DIRECT);
      if (why !== undefined) add("refused-package", `${at} is refused (${why})`);
      if (name === "wrangler" && file !== "tools/static-deploy/package.json") {
        add(
          "wrangler-outside-static-deploy",
          `${at}: wrangler is allowed only in tools/static-deploy/package.json (FD-19)`,
        );
      }
      if (name.startsWith("@ui-sdk/") && file !== "packages/ui/package.json") {
        add(
          "ui-sdk-outside-ui",
          `${at}: only packages/ui/package.json may list @ui-sdk/* (EXECUTION §1.3)`,
        );
      }
      if (name.startsWith("@fin/")) {
        if (spec !== "workspace:*") {
          add(
            "fin-not-workspace",
            `${at} must be workspace:* (the @fin scope on npm belongs to someone else)`,
          );
        }
        continue;
      }
      const exotic = exoticKind(spec);
      if (exotic !== undefined) {
        add(
          "exotic-dependency",
          `${at} is ${exotic}; dependencies come from the registry through the catalog`,
        );
        continue;
      }
      if (spec.startsWith("workspace:")) {
        add("workspace-not-fin", `${at}: only @fin/* packages are workspace dependencies`);
        continue;
      }
      if (field === "peerDependencies") {
        if (
          spec !== "catalog:" &&
          !/^[\d\sxX*.^~<>=|-]+$|^[\d\sxX*.^~<>=|-]*\d+\.\d+\.\d+-[\w.]+$/.test(spec)
        ) {
          add("dependency-spec", `${at} must be catalog: or a version range`);
        }
      } else if (spec !== "catalog:" && spec !== "catalog:default") {
        add(
          "not-from-catalog",
          `${at} must be catalog: (one exact version per package, in pnpm-workspace.yaml)`,
        );
        continue;
      }
      if (spec.startsWith("catalog:") && !catalog.has(name)) {
        add("catalog-missing", `${at} uses catalog: but the catalog has no ${name}`);
      }
    }
  }
  return findings;
}

/**
 * Checks the root manifest's pnpm pin. `packageManager`, `engines.pnpm` and
 * `devEngines.packageManager` name one exact version, and `devEngines.packageManager.onFail` is
 * "error": SP-01 showed that pnpm 12.21.0, by default, downloads and runs whatever version
 * `packageManager` names, while with this devEngines entry it never switches and refuses a
 * mismatch instead.
 * @param {string} file
 * @param {unknown} manifest
 * @returns {Finding[]}
 */
export function checkPackageManager(file, manifest) {
  /** @type {Finding[]} */
  const findings = [];
  /** @param {string} message */
  const add = (message) => findings.push({ file, rule: "package-manager", message });
  if (!isRecord(manifest)) return findings;
  const pm = typeof manifest.packageManager === "string" ? manifest.packageManager : "";
  const pin = /^pnpm@(\d+\.\d+\.\d+)(\+sha(256|512)\.[0-9a-f]+)?$/.exec(pm);
  if (pin === null) {
    add("packageManager must pin one exact pnpm version");
    return findings;
  }
  const engines = isRecord(manifest.engines) ? manifest.engines : {};
  if (engines.pnpm !== pin[1]) add("engines.pnpm must equal the packageManager version");
  const dev = isRecord(manifest.devEngines) ? manifest.devEngines.packageManager : undefined;
  if (!isRecord(dev) || dev.name !== "pnpm" || dev.version !== pin[1] || dev.onFail !== "error") {
    add(
      'devEngines.packageManager must be { "name": "pnpm", "version": <the packageManager version>, "onFail": "error" }, so pnpm refuses a mismatch instead of downloading another pnpm',
    );
  }
  return findings;
}

/**
 * Compares two versions (major.minor.patch, prerelease below release).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const parse = (/** @type {string} */ v) => {
    const [core = "", pre] = v.split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Checks the lockfile's packages and snapshots (every document in the file).
 * @param {string} text
 * @returns {Finding[]}
 */
export function checkLockfile(text) {
  /** @type {Finding[]} */
  const findings = [];
  let section = "";
  /** @type {string | undefined} */
  let current;
  for (const [index, line] of text.split("\n").entries()) {
    const top = /^([A-Za-z]+):/.exec(line);
    if (top) {
      section = top[1] ?? "";
      current = undefined;
      continue;
    }
    if (section !== "packages" && section !== "snapshots") continue;
    const key = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s'/]+)@([^('\s]+?)(?:\(.*\))?'?:\s*$/.exec(line);
    if (key) {
      const [, name = "", version = ""] = key;
      current = `${name}@${version}`;
      const why = refusedReason(name, REFUSED_EVERYWHERE);
      if (why !== undefined) {
        findings.push({
          file: LOCKFILE,
          line: index + 1,
          rule: "refused-package",
          message: `${name} is in the lockfile but refused (${why})`,
        });
      }
      if (
        (name === "seroval" || name === "seroval-plugins") &&
        compareVersions(version, "1.6.11") < 0
      ) {
        findings.push({
          file: LOCKFILE,
          line: index + 1,
          rule: "seroval-floor",
          message: `${name} ${version} is below the 1.6.11 floor`,
        });
      }
      continue;
    }
    if (section === "packages" && current !== undefined && /^ {4}resolution:/.test(line)) {
      if (!/^ {4}resolution: \{integrity: [\w+/=-]+\}\s*$/.test(line)) {
        findings.push({
          file: LOCKFILE,
          line: index + 1,
          rule: "exotic-resolution",
          message: `${current} is not resolved from the registry by integrity`,
        });
      }
    }
  }
  return findings;
}

/**
 * Checks `uses:` lines in a workflow or action file.
 * @param {string} file
 * @param {string} text
 * @returns {Finding[]}
 */
export function checkUses(file, text) {
  /** @type {Finding[]} */
  const findings = [];
  for (const [index, line] of text.split("\n").entries()) {
    const match = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"\s#]+)\1\s*(#.*)?$/.exec(line);
    if (!match) {
      if (/^\s*(?:-\s+)?uses:/.test(line)) {
        findings.push({
          file,
          line: index + 1,
          rule: "action-unpinned",
          message: "a uses: line this check cannot read",
        });
      }
      continue;
    }
    const [, , ref = "", comment] = match;
    if (ref.startsWith("./")) continue;
    if (ref.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(ref)) {
        findings.push({
          file,
          line: index + 1,
          rule: "action-unpinned",
          message: "a docker:// action must be pinned by digest",
        });
      }
      continue;
    }
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) {
      findings.push({
        file,
        line: index + 1,
        rule: "action-unpinned",
        message: "uses: must pin a full 40-character commit SHA",
      });
    } else if (comment === undefined || !/^#\s*v?\d/.test(comment)) {
      findings.push({
        file,
        line: index + 1,
        rule: "action-unpinned",
        message: "a pinned uses: needs its version as a comment (# vX.Y.Z)",
      });
    }
  }
  return findings;
}

/**
 * Runs every supply-chain rule over the repository at `root`.
 * @param {string} root
 * @returns {Finding[]}
 */
export function checkSupplyChain(root) {
  /** @type {Finding[]} */
  const findings = [];
  const files = listFiles(root);

  /** @type {Map<string, Item>} */
  let catalog = new Map();
  if (!files.includes(WORKSPACE)) {
    findings.push({
      file: WORKSPACE,
      rule: "policy-missing",
      message: "the workspace policy file is missing",
    });
  } else {
    const result = checkWorkspace(readFileSync(join(root, WORKSPACE), "utf8"));
    findings.push(...result.findings);
    catalog = result.catalog;
  }

  for (const file of files) {
    const base = file.split("/").pop() ?? "";
    if (/^\.?pnpmfile\.(c|m)?js$/.test(base) || /^\.?pnpmfile\.(c|m)?ts$/.test(base)) {
      findings.push({
        file,
        rule: "pnpmfile",
        message: "a pnpmfile can rewrite manifests at install time; refused",
      });
    }
    if (base === ".npmrc" || base === ".pnpmrc" || base === ".yarnrc" || base === ".yarnrc.yml") {
      findings.push({
        file,
        rule: "npmrc",
        message: "registry and install settings live only in pnpm-workspace.yaml; refused",
      });
    }
  }

  // The root manifest and every workspace package's.
  const globs = PACKAGE_GLOBS.map((g) => globToRegExp(`${g}/package.json`));
  const manifests = files.filter((f) => f === "package.json" || globs.some((g) => g.test(f)));
  for (const file of manifests) {
    /** @type {unknown} */
    let manifest;
    try {
      manifest = readJson(join(root, file));
    } catch {
      findings.push({ file, rule: "manifest-shape", message: "not valid JSON" });
      continue;
    }
    findings.push(...checkManifest(file, manifest, catalog));
    if (file === "package.json") findings.push(...checkPackageManager(file, manifest));
  }

  if (!files.includes(LOCKFILE)) {
    findings.push({
      file: LOCKFILE,
      rule: "lockfile-missing",
      message: "the lockfile must be committed",
    });
  } else {
    findings.push(...checkLockfile(readFileSync(join(root, LOCKFILE), "utf8")));
  }

  for (const file of files.filter((f) => f.startsWith(".github/") && /\.ya?ml$/.test(f))) {
    findings.push(...checkUses(file, readFileSync(join(root, file), "utf8")));
  }
  return findings;
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex > 0 ? (process.argv[rootIndex + 1] ?? ".") : process.cwd();
  if (!existsSync(root)) {
    console.error(`supply-chain:check: no such directory: ${root}`);
    process.exitCode = 2;
  } else {
    process.exitCode = report("supply-chain:check", checkSupplyChain(root));
  }
}
