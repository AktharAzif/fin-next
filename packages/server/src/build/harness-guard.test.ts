// The release bundle's harness guard (harness-guard.ts). Planted apps in a temporary directory load
// the test harness by its package name (linked into node_modules as pnpm links a workspace
// package), by a relative path, through import.meta.glob and from a worker's bundle (`?worker`,
// which Vite builds apart with the worker's own plugins): each release build fails with the
// guard's message naming the module by its repository path and writes no bundle, while the same
// app's `test` build holds the harness, which that target may (spec 01 §4.9). Each of the guard's
// three checks refuses on its own. Every real server bundle (apps/*/vite.server.config.ts) carries
// the guard in a release build, in its main bundle and in every worker's, and still builds, with
// nothing of the harness in any of its source maps.
import { execFileSync } from "node:child_process";
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

type Source = (harness: (path: string) => string) => string;

/**
 * A planted app: @fin/testing linked into its node_modules as pnpm links a workspace package, and
 * an entry `src/server.node.ts` whose text `entry` writes, given how the entry's directory reaches
 * a file of the harness by a relative path; `files` adds others beside the entry the same way.
 */
function plant(entry: Source, files: Readonly<Record<string, Source>> = {}): string {
  const root = temporary();
  mkdirSync(join(root, "node_modules/@fin"), { recursive: true });
  symlinkSync(HARNESS, join(root, "node_modules/@fin/testing"), "dir");
  const from = dirname(join(root, ENTRY));
  const harness = (path: string) => relative(from, join(HARNESS, path)).split(sep).join("/");
  mkdirSync(from, { recursive: true });
  writeFileSync(join(root, ENTRY), entry(harness));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(from, name), text(harness));
  return root;
}

/** Builds the planted app's server bundle for the target `env` names; returns main.js's text. */
async function bundle(root: string, env: Record<string, string>): Promise<string> {
  const config = serverBundleConfig({ root, entry: ENTRY }, env);
  await build({ ...config, configFile: false, logLevel: "silent" });
  return readFileSync(join(root, "dist/server/main.js"), "utf8");
}

/** The text of every file the planted app's build wrote to dist/server/, its maps included. */
function written(root: string): string {
  const out = join(root, "dist/server");
  return globSync("**/*", { cwd: out, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
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

  it("adds it to a worker's bundle in a release build as well", async () => {
    const names = async (env: Record<string, string>) => {
      const worker = serverBundleConfig({ root: REPOSITORY, entry: ENTRY }, env).worker;
      const plugins = (await worker?.plugins?.()) ?? [];
      return plugins.map((plugin) =>
        plugin !== null && typeof plugin === "object" && "name" in plugin ? plugin.name : null,
      );
    };
    expect(await names(RELEASE)).toEqual([HARNESS_GUARD]);
    expect(await names({})).toEqual([HARNESS_GUARD]);
    expect(await names(TEST)).toEqual([]);
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

// Vite builds a `?worker` or `?sharedworker` import as a bundle of its own, with only the worker's
// plugins (config.worker.plugins). In a server bundle the worker's map, its sources' text included,
// is written to assets/ beside main.js and, with `&inline`, the worker's code goes into main.js as
// text. The main graph holds only the virtual module, so the main bundle's guard never sees the
// worker's graph: a release build guards the worker's bundle too. The test build shows the route
// reaches the harness: its output holds the harness's code.
describe("a release build whose worker loads the harness fails", () => {
  it.each(["?worker", "?worker&inline", "?worker&url", "?sharedworker"])(
    "imported with %s",
    async (query) => {
      const root = plant(
        () =>
          `import Planted from ${JSON.stringify(`./planted-worker.ts${query}`)};\n` +
          "export const planted = Planted;\n",
        {
          "planted-worker.ts": (harness) =>
            `import { totp } from ${JSON.stringify(harness("src/totp.ts"))};\n` +
            "(globalThis as Record<string, unknown>).planted = totp;\n",
        },
      );
      await expect(bundle(root, RELEASE)).rejects.toThrow(
        harnessMessage(["packages/testing/src/totp.ts"]),
      );
      expect(existsSync(join(root, "dist/server/main.js"))).toBe(false);
      await bundle(root, TEST);
      expect(written(root)).toContain("function totp(");
    },
    60_000,
  );
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

// These tests read files outside packages/server (each app's manifest, vite.server.config.ts and
// sources, packages/audit/src and packages/testing), so turbo.json names them as inputs of
// `@fin/server#test`: a change to any of them runs the tests again instead of replaying a cached
// pass.
describe("the real server bundles", () => {
  const configs = globSync("apps/*/vite.server.config.ts", { cwd: REPOSITORY })
    .map((path) => path.split(sep).join("/"))
    .sort();

  // A real bundle can reach @fin/audit (the api's does: main.ts, then migrate/main.ts), whose index
  // loads the event index that packages/audit/src/gen.ts writes and git ignores. The real build
  // writes it first (the api's prebuild:server); these tests call Vite without that pre-script, so
  // they run the same generator before any build, and pass from a clean clone in any task order.
  // The generator renames a finished file into place, so a package script running it at the same
  // time is safe.
  beforeAll(() => {
    execFileSync(process.execPath, [join(REPOSITORY, "packages/audit/src/gen.ts")], {
      stdio: "pipe",
    });
  });

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
      const worker = await resolved.worker.plugins([]);
      expect(worker.plugins.map((plugin) => plugin.name)).toContain(HARNESS_GUARD);
      const outDir = temporary();
      await build({
        configFile,
        configLoader: "native",
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });
      expect(existsSync(join(outDir, "main.js"))).toBe(true);
      // Every map the build wrote, a worker's bundle's included, each read against its own place.
      const maps = globSync("**/*.map", { cwd: outDir });
      expect(maps).toContain("main.js.map");
      const sources = maps.flatMap((path) => {
        const map: unknown = JSON.parse(readFileSync(join(outDir, path), "utf8"));
        const at = dirname(join(outDir, path));
        return (map as { sources: string[] }).sources.map((source) => resolve(at, source));
      });
      expect(sources.length).toBeGreaterThan(0);
      expect(harnessModules(sources)).toEqual([]);
    },
    60_000,
  );
});
