// The release bundle's harness guard (harness-guard.ts). Planted apps in a temporary directory load
// the test harness by its package name (linked into node_modules as pnpm links a workspace
// package), by a relative path and through import.meta.glob: each release build fails with the
// guard's message naming the module by its repository path and writes no bundle, while the same
// app's `test` build holds the harness, which that target may (spec 01 §4.9). Each of the guard's
// three checks refuses on its own. Every real server bundle (apps/*/vite.server.config.ts) carries
// the guard in a release build and still builds, with nothing of the harness in its source map.
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { build, type Plugin, resolveConfig } from "vite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HARNESS_GUARD, harnessGuard, harnessMessage, harnessModules } from "./harness-guard.ts";
import { serverBundleConfig } from "./vite-server.ts";

const REPOSITORY = resolve(import.meta.dirname, "../../../..");
const HARNESS = join(REPOSITORY, "packages/testing");
const ENTRY = "src/server.node.ts";
const RELEASE = { FIN_BUILD_TARGET: "release" };
const TEST = { FIN_BUILD_TARGET: "test" };
const REFUSED = /the release server bundle holds the test harness/;

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A fresh temporary directory, by its real path (macOS's temporary directory is a link). */
function temporary(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "fin-harness-guard-")));
  made.push(dir);
  return dir;
}

/**
 * A planted app: @fin/testing linked into its node_modules as pnpm links a workspace package, and
 * an entry `src/server.node.ts` whose text `entry` writes, given how the entry's directory reaches
 * a file of the harness by a relative path.
 */
function plant(entry: (harness: (path: string) => string) => string): string {
  const root = temporary();
  mkdirSync(join(root, "node_modules/@fin"), { recursive: true });
  symlinkSync(HARNESS, join(root, "node_modules/@fin/testing"), "dir");
  const from = dirname(join(root, ENTRY));
  const harness = (path: string) => relative(from, join(HARNESS, path)).split(sep).join("/");
  mkdirSync(from, { recursive: true });
  writeFileSync(join(root, ENTRY), entry(harness));
  return root;
}

/** Builds the planted app's server bundle for the target `env` names; returns main.js's text. */
async function bundle(root: string, env: Record<string, string>): Promise<string> {
  const config = serverBundleConfig({ root, entry: ENTRY }, env);
  await build({ ...config, configFile: false, logLevel: "silent" });
  return readFileSync(join(root, "dist/server/main.js"), "utf8");
}

describe("harnessModules", () => {
  it("names a module under the harness by its repository path, links resolved", () => {
    const root = plant(() => "export {};\n");
    const linked = join(root, "node_modules/@fin/testing/src/totp.ts");
    expect(harnessModules([linked])).toEqual(["packages/testing/src/totp.ts"]);
    expect(harnessModules([join(HARNESS, "src/http/node.ts")])).toEqual([
      "packages/testing/src/http/node.ts",
    ]);
  });

  it("reads an ID as a bundler writes one: a NUL prefix, a query or a plugin's prefix", () => {
    expect(harnessModules([`\0${join(HARNESS, "src/clock.ts")}?commonjs-proxy`])).toEqual([
      "packages/testing/src/clock.ts",
    ]);
    expect(harnessModules([`${join(HARNESS, "src/totp.ts")}?raw`])).toEqual([
      "packages/testing/src/totp.ts",
    ]);
    expect(harnessModules([`\0plugin:${join(HARNESS, "src/totp.ts")}#x`])).toEqual([
      "packages/testing/src/totp.ts",
    ]);
    expect(harnessModules([join(HARNESS, "src/missing/later.ts")])).toEqual([
      "packages/testing/src/missing/later.ts",
    ]);
  });

  it("leaves every other module alone", () => {
    expect(
      harnessModules([
        join(REPOSITORY, "packages/server/src/build/vite-server.ts"),
        join(REPOSITORY, "packages/testing-other/src/index.ts"),
        join(REPOSITORY, "packages/server/src/testing/http.ts"),
        "\0vite/preload-helper.js",
        "node:http",
        "pg-native",
      ]),
    ).toEqual([]);
  });
});

describe("serverBundleConfig and the harness guard", () => {
  it("adds the guard to a release build and not to a test build", () => {
    const names = (env: Record<string, string>) =>
      (serverBundleConfig({ root: REPOSITORY, entry: ENTRY }, env).plugins ?? []).map((plugin) =>
        plugin !== null && typeof plugin === "object" && "name" in plugin ? plugin.name : null,
      );
    expect(names(RELEASE)).toEqual([HARNESS_GUARD]);
    expect(names({})).toEqual([HARNESS_GUARD]);
    expect(names(TEST)).toEqual([]);
  });
});

/**
 * The planted app's release build fails with the guard's message naming `module` and writes no
 * bundle; the same app's test build, which may hold the harness (spec 01 §4.9: "`test` adds the
 * seams and `packages/testing`"), holds `marker`, so the route really reaches the harness.
 */
async function refusedInRelease(root: string, module: string, marker: string): Promise<void> {
  await expect(bundle(root, RELEASE)).rejects.toThrow(harnessMessage([module]));
  expect(existsSync(join(root, "dist/server/main.js"))).toBe(false);
  expect(await bundle(root, TEST)).toContain(marker);
}

describe("a release build that loads the harness fails", () => {
  it("by the harness's package name", async () => {
    const root = plant(
      () => `import { totp } from "@fin/testing";\nexport const harness = typeof totp;\n`,
    );
    await refusedInRelease(root, "packages/testing/src/index.ts", "function totp(");
  }, 60_000);

  it("by a relative path", async () => {
    const root = plant(
      (harness) =>
        `import { listen } from ${JSON.stringify(harness("src/http/node.ts"))};\n` +
        "export const harness = typeof listen;\n",
    );
    await refusedInRelease(root, "packages/testing/src/http/node.ts", "function listen(");
  }, 60_000);

  it("through import.meta.glob, lazy", async () => {
    const root = plant((harness) => {
      const pattern = JSON.stringify(harness("src/http/n*.ts"));
      return (
        `const found = import.meta.glob([${pattern}, "!**/*.test.ts"]);\n` +
        "export const harness = Object.values(found).map((load) => load());\n"
      );
    });
    await refusedInRelease(root, "packages/testing/src/http/node.ts", "function listen(");
  }, 60_000);

  it("through import.meta.glob, eager", async () => {
    const root = plant((harness) => {
      const pattern = JSON.stringify(harness("src/tot*.ts"));
      return (
        `const found = import.meta.glob(${pattern}, { eager: true });\n` +
        "export const harness = Object.values(found);\n"
      );
    });
    await refusedInRelease(root, "packages/testing/src/totp.ts", "function totp(");
  }, 60_000);

  it("when FIN_BUILD_TARGET is unset, since release is the default", async () => {
    const root = plant(
      (harness) =>
        `import { totp } from ${JSON.stringify(harness("src/totp.ts"))};\n` +
        "export const harness = typeof totp;\n",
    );
    await expect(bundle(root, {})).rejects.toThrow(REFUSED);
  }, 60_000);
});

describe("each of the guard's checks", () => {
  it.each(["load", "buildEnd", "generateBundle"] as const)(
    "%s refuses on its own",
    async (hook) => {
      const guard = harnessGuard();
      const alone: Plugin = { name: guard.name, [hook]: guard[hook] };
      if (guard.enforce !== undefined) alone.enforce = guard.enforce;
      const root = plant(
        (harness) =>
          `import { totp } from ${JSON.stringify(harness("src/totp.ts"))};\n` +
          "export const harness = typeof totp;\n",
      );
      const config = serverBundleConfig({ root, entry: ENTRY }, TEST);
      await expect(
        build({ ...config, plugins: [alone], configFile: false, logLevel: "silent" }),
      ).rejects.toThrow(harnessMessage(["packages/testing/src/totp.ts"]));
    },
    60_000,
  );
});

describe("the real server bundles", () => {
  const configs = globSync("apps/*/vite.server.config.ts", { cwd: REPOSITORY })
    .map((path) => path.split(sep).join("/"))
    .sort();

  it("are found", () => {
    expect(configs.length).toBeGreaterThan(0);
  });

  it.each(configs)(
    "%s carries the guard in a release build and still builds",
    async (path) => {
      vi.stubEnv("FIN_BUILD_TARGET", "release");
      const configFile = join(REPOSITORY, path);
      const resolved = await resolveConfig(
        { configFile, configLoader: "native", logLevel: "silent" },
        "build",
      );
      expect(resolved.plugins.map((plugin) => plugin.name)).toContain(HARNESS_GUARD);
      const outDir = temporary();
      await build({
        configFile,
        configLoader: "native",
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });
      expect(existsSync(join(outDir, "main.js"))).toBe(true);
      const map: unknown = JSON.parse(readFileSync(join(outDir, "main.js.map"), "utf8"));
      const sources = (map as { sources: string[] }).sources.map((source) =>
        resolve(outDir, source),
      );
      expect(sources.length).toBeGreaterThan(0);
      expect(harnessModules(sources)).toEqual([]);
    },
    60_000,
  );
});
