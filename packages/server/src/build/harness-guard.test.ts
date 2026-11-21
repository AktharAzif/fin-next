// The release bundle's harness guard (harness-guard.ts). Planted apps in a temporary directory load
// the test harness by its package name (linked into node_modules as pnpm links a workspace
// package), by a relative path, through import.meta.glob and from a worker's bundle (`?worker`,
// which Vite builds apart with the worker's own plugins): each release build fails with the
// guard's message naming the module by its repository path and writes no bundle, while the same
// app's `test` build holds the harness, which that target may (spec 01 §4.9). So does a release
// build that carries a harness file as an asset Vite read itself (a worker's
// `new URL(..., import.meta.url)`, an `?inline` stylesheet's `url()`), inlined or emitted, planted
// inside the repository so the asset's name is the one a real app's build gives. Each of the
// guard's three checks refuses on its own. Every real server bundle (apps/*/vite.server.config.ts)
// carries the guard in a release build, in its main bundle and in every worker's, and still builds,
// with no module of the harness in its graph and no file of it in its output, as the build itself
// reports them. turbo runs these tests on every run, so no cached pass hides a release build that
// lost the guard; planted apps whose config's helper spreads the guard away, whose file of
// re-exports loads the harness by a typed glob, or whose stylesheet inlines an asset linked to a
// harness file, fail the same check.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { build, type Plugin } from "vite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  HARNESS_GUARD,
  harnessContents,
  harnessGuard,
  harnessMessage,
  harnessModules,
} from "./harness-guard.ts";
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

/**
 * A fresh temporary directory under `parent` (the system's temporary directory by default), by its
 * real path (macOS's temporary directory is a link).
 */
function temporary(parent: string = tmpdir()): string {
  mkdirSync(parent, { recursive: true });
  const dir = realpathSync.native(mkdtempSync(join(parent, "fin-harness-guard-")));
  made.push(dir);
  return dir;
}

/**
 * A place inside the repository for a planted app, ignored by git and by every tool's sources, so a
 * path the build writes relative to the app's root reaches the harness as a real app's does.
 */
const IN_REPOSITORY = join(REPOSITORY, "packages/server/node_modules/.cache");

type Source = (harness: (path: string) => string) => string;

/**
 * A planted app under `parent`: @fin/testing linked into its node_modules as pnpm links a workspace
 * package, and an entry `src/server.node.ts` whose text `entry` writes, given how the entry's
 * directory reaches a file of the harness by a relative path; `files` adds others beside the entry
 * the same way.
 */
function plant(
  entry: Source,
  files: Readonly<Record<string, Source>> = {},
  parent: string = tmpdir(),
): string {
  const root = temporary(parent);
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

describe("harnessContents", () => {
  /** A repository whose harness holds `src/a.ts`, an empty file, and a dependency's file. */
  function repository(): string {
    const root = temporary();
    const harness = join(root, "packages/testing");
    mkdirSync(join(harness, "src"), { recursive: true });
    mkdirSync(join(harness, "node_modules/dep"), { recursive: true });
    writeFileSync(join(harness, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(harness, "src/empty.ts"), "");
    writeFileSync(join(harness, "node_modules/dep/index.js"), "export const dep = 1;\n");
    return root;
  }
  const base64 = (text: string) => Buffer.from(text).toString("base64");

  it("names a harness file an output carries whole: its bytes, or a data: URL of them", () => {
    const root = repository();
    const named = ["packages/testing/src/a.ts"];
    const a = "export const a = 1;\n";
    expect(harnessContents([`const u = "data:video/mp2t;base64,${base64(a)}";`], root)).toEqual(
      named,
    );
    expect(harnessContents([`a{background:url("data:x;base64,${base64(a)}")}`], root)).toEqual(
      named,
    );
    expect(harnessContents([new Uint8Array(Buffer.from(a))], root)).toEqual(named);
    expect(harnessContents([a], root)).toEqual(named);
  });

  it("leaves every other output alone", () => {
    const root = repository();
    expect(
      harnessContents(
        [
          `"data:text/plain;base64,${base64("other")}"`,
          `"data:text/plain;base64,${base64("export const a = 1;\nmore")}"`,
          "// export const a = 1;\n",
          '"data:application/octet-stream;base64,"',
          "",
          `"data:text/javascript;base64,${base64("export const dep = 1;\n")}"`,
          "export const dep = 1;\n",
        ],
        root,
      ),
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

// Vite reads a file named in `new URL(..., import.meta.url)` (which a worker's bundle resolves, as
// Vite builds it for a client) or in a stylesheet's `url()` itself, never loading it as a module.
// It inlines the file as a data: URL when it is under 4 KiB or the URL asks with `?inline`, and
// otherwise emits it as an asset named by its path relative to the app's root (which a server
// build then leaves out of its output). The apps are planted inside the repository, so that path
// is the one a real app's build gives. The test build shows the route reaches the harness: an
// inlined file's bytes are in its output.
describe("a release build that carries a harness file as an asset fails", () => {
  const sized = (fits: (size: number) => boolean) => {
    const file = globSync("src/**/*.ts", { cwd: HARNESS })
      .map((path) => path.split(sep).join("/"))
      .sort()
      .find((path) => fits(statSync(join(HARNESS, path)).size));
    if (file === undefined) throw new Error("no file of the harness has the size the test needs");
    return file;
  };
  const small = sized((size) => size > 0 && size < 4096);
  const large = sized((size) => size >= 4096);

  const worker = (file: string): [Source, Record<string, Source>] => [
    () =>
      'import Planted from "./planted-worker.ts?worker&inline";\nexport const planted = Planted;\n',
    {
      "planted-worker.ts": (harness) =>
        `export const url = new URL(${JSON.stringify(harness(file))}, import.meta.url);\n` +
        "(globalThis as Record<string, unknown>).planted = url;\n",
    },
  ];
  const stylesheet = (file: string): [Source, Record<string, Source>] => [
    () => 'import css from "./planted.css?inline";\nexport const planted = css;\n',
    { "planted.css": (harness) => `a { background: url(${JSON.stringify(harness(file))}); }\n` },
  ];

  it.each([
    ["a worker's new URL() names a small file, inlined", worker(small), small, true],
    ["a worker's new URL() names a larger file, emitted", worker(large), large, false],
    [
      "a worker's new URL() names a larger file with ?inline",
      worker(`${large}?inline`),
      large,
      true,
    ],
    ["an ?inline stylesheet's url() names a small file, inlined", stylesheet(small), small, true],
    ["an ?inline stylesheet's url() names a larger file, emitted", stylesheet(large), large, false],
    ["an ?inline stylesheet's url() with ?inline", stylesheet(`${large}?inline`), large, true],
  ] as const)(
    "%s",
    async (_name, [entry, files], file, inlined) => {
      const root = plant(entry, files, IN_REPOSITORY);
      const module = `packages/testing/${file}`;
      await expect(bundle(root, RELEASE)).rejects.toThrow(harnessMessage([module]));
      expect(existsSync(join(root, "dist/server/main.js"))).toBe(false);
      await bundle(root, TEST);
      if (inlined) {
        expect(written(root)).toContain(readFileSync(join(HARNESS, file)).toString("base64"));
      }
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

  it("generateBundle reads an asset's name relative to the build's root", () => {
    type Hook = (this: unknown, options: unknown, bundle: unknown, isWrite: boolean) => void;
    const generateBundle = harnessGuard().generateBundle as unknown as Hook;
    const name = "../../packages/testing/src/later.ts";
    const context = {
      environment: { config: { root: join(REPOSITORY, "apps/planted") } },
      error(message: string): never {
        throw new Error(message);
      },
    };
    const asset = { type: "asset", fileName: "assets/later.ts", originalFileNames: [name] };
    const call = (source: string) =>
      generateBundle.call(context, {}, { "assets/later.ts": { ...asset, source } }, false);
    expect(harnessModules([name])).toEqual([]);
    expect(() => call("not the harness's text")).toThrow(
      harnessMessage(["packages/testing/src/later.ts"]),
    );
  });
});

/** What one bundle of a release build ran with and held: the main bundle, or a worker's. */
interface Bundle {
  worker: boolean;
  /** The plugins the bundle's build ran, by name. */
  plugins: string[];
  /** Every module of the bundle's graph, as the build lists it at its end (this.getModuleIds()). */
  modules: string[];
  /** Each file the bundle's output holds, by its source: its chunks' code and its assets'. */
  outputs: (string | Uint8Array)[];
  /** The files each asset of the output was read from, as paths. */
  assets: string[];
}

/** What a server bundle's release build, run from its config file, resolved, ran with and held. */
interface Inspection {
  /** Each bundle the build made: the main bundle and each worker's. */
  bundles: Bundle[];
  /** The plugins the resolved config gives a worker's bundle, whether or not the app has one. */
  workerPlugins: string[];
  /** The main bundle's entry, as a path. */
  entry: string;
  outDir: string;
}

const names = (plugins: readonly { name: string }[]): string[] =>
  plugins.map((plugin) => plugin.name);

/**
 * A plugin that records what the bundle it is built into ran with and held, as that build reports
 * it: the plugins its environment ran; at its end every module of its graph, those that add no
 * code to the output (a file of re-exports) included, which a source map does not name; and the
 * output it generates, each asset's files included, which no module or map names. In the main
 * bundle it also takes, from the config the build resolved, the entry and the plugins that config
 * gives a worker's bundle.
 */
function recorder(inspection: Inspection): Plugin {
  let worker = false;
  let recorded: Bundle | undefined;
  return {
    name: "fin:test-bundle-recorder",
    async configResolved(config) {
      worker = config.isWorker;
      if (worker) return;
      inspection.entry = resolve(config.root, String(config.build.ssr));
      inspection.workerPlugins = names((await config.worker.plugins([])).plugins);
    },
    buildEnd() {
      recorded = {
        worker,
        plugins: names(this.environment.plugins),
        modules: [...this.getModuleIds()],
        outputs: [],
        assets: [],
      };
      inspection.bundles.push(recorded);
    },
    generateBundle(_options, bundle) {
      if (recorded === undefined) throw new Error("a bundle was generated before its build ended");
      const root = this.environment.config.root;
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk") {
          recorded.outputs.push(file.code);
        } else {
          recorded.outputs.push(file.source);
          recorded.assets.push(...file.originalFileNames.map((name) => resolve(root, name)));
        }
      }
    },
  };
}

/**
 * Runs the release build of the server bundle `configFile` describes, as the app's `build:server`
 * runs it (`vite build --config`, though the config is imported by Node rather than bundled first,
 * so the build writes nothing beside it), into a temporary directory, with a recorder added to its
 * plugins and to every worker's.
 */
async function inspect(configFile: string): Promise<Inspection> {
  vi.stubEnv("FIN_BUILD_TARGET", "release");
  const inspection: Inspection = { bundles: [], workerPlugins: [], entry: "", outDir: temporary() };
  await build({
    configFile,
    configLoader: "native",
    logLevel: "silent",
    build: { outDir: inspection.outDir, emptyOutDir: true },
    plugins: [recorder(inspection)],
    worker: { plugins: () => [recorder(inspection)] },
  });
  return inspection;
}

/**
 * What makes an inspected release build unfit to ship, read from the build itself: a config that
 * gives a worker's bundle no guard, a bundle built without the guard, any module of the harness in
 * a bundle's graph, and any file of the harness its output carries as an asset or whole
 * (harnessContents, which compares with every file of packages/testing). The main bundle comes
 * first, then each worker's.
 */
function problems(inspection: Inspection): string[] {
  const found: string[] = [];
  if (!inspection.workerPlugins.includes(HARNESS_GUARD)) {
    found.push("the release config gives a worker's bundle no guard");
  }
  const main = inspection.bundles.filter((bundle) => !bundle.worker).length;
  if (main !== 1) found.push(`the build made ${main} main bundles`);
  const bundles = [...inspection.bundles].sort((a, b) => Number(a.worker) - Number(b.worker));
  for (const bundle of bundles) {
    const which = bundle.worker ? "a worker's bundle" : "the main bundle";
    if (!bundle.plugins.includes(HARNESS_GUARD)) found.push(`${which} was built without the guard`);
    const harness = harnessModules(bundle.modules);
    if (harness.length > 0) found.push(`${which} holds the harness: ${harness.join(", ")}`);
    const carried = [
      ...new Set([...harnessModules(bundle.assets), ...harnessContents(bundle.outputs)]),
    ].sort();
    if (carried.length > 0) found.push(`${which} carries the harness: ${carried.join(", ")}`);
  }
  return found;
}

/** The sources the source maps a build wrote name, each map read against its own place. */
function mapSources(outDir: string): string[] {
  return globSync("**/*.map", { cwd: outDir }).flatMap((path) => {
    const map: unknown = JSON.parse(readFileSync(join(outDir, path), "utf8"));
    const at = dirname(join(outDir, path));
    return (map as { sources: string[] }).sources.map((source) => resolve(at, source));
  });
}

/**
 * How turbo resolves `@fin/server#test` in this checkout, by its own dry run, which reads turbo.json
 * and any package's turbo.json (a package's configuration overrides the root's) as a run does.
 */
function serverTestTask(): { cache: boolean } {
  const turbo = join(REPOSITORY, "node_modules/.bin/turbo");
  const out = execFileSync(turbo, ["run", "test", "--filter=@fin/server", "--dry=json"], {
    cwd: REPOSITORY,
    encoding: "utf8",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const dry = JSON.parse(out) as {
    tasks: { taskId: string; resolvedTaskDefinition: { cache: boolean } }[];
  };
  const task = dry.tasks.find((each) => each.taskId === "@fin/server#test");
  if (task === undefined) throw new Error("turbo's dry run holds no @fin/server#test");
  return task.resolvedTaskDefinition;
}

// These tests read files no list of a task's inputs can name before they exist: any file an app's
// vite.server.config.ts imports (a helper it spreads into its config), every module of a bundle's
// graph wherever it lies (a file of re-exports adds no code, so no map names it), every file of
// packages/testing (harnessContents compares each output with them all), and any file Vite reads
// itself into a bundle as an asset. A cached pass replayed after a change to one of them could
// hide a release build that lost the guard and ships the harness. So turbo never caches
// `@fin/server#test`: the tests run on every `turbo run test`, which costs `pnpm check` the
// package's whole suite (4 to 16 s on a developer's machine, by its load) even when nothing
// changed. Each real-bundle test reads the build itself: the plugins each of its bundles ran,
// every module of each one's graph and its output, as the build reports them.
describe("the real server bundles", () => {
  const configs = globSync("apps/*/vite.server.config.ts", { cwd: REPOSITORY })
    .map((path) => path.split(sep).join("/"))
    .sort();

  it("are found", () => {
    expect(configs.length).toBeGreaterThan(0);
  });

  it("are checked on every run of the tests, never by a cached pass", () => {
    expect(serverTestTask().cache).toBe(false);
  }, 30_000);

  it.each(configs)(
    "%s carries the guard in every bundle of a release build and still builds",
    async (path) => {
      const inspection = await inspect(join(REPOSITORY, path));
      expect(problems(inspection)).toEqual([]);
      expect(existsSync(join(inspection.outDir, "main.js"))).toBe(true);
      const main = inspection.bundles.find((bundle) => !bundle.worker);
      expect(main?.modules).toContain(inspection.entry);
    },
    60_000,
  );
});

/**
 * A planted app that builds from its own vite.server.config.ts as a real app does, with
 * `@fin/server`, `@fin/testing` and `vite` linked into its node_modules as pnpm links them; `files`
 * writes each file under its root, given how that file's directory reaches the harness's files.
 */
function plantApp(files: Readonly<Record<string, Source>>): string {
  const root = temporary();
  mkdirSync(join(root, "node_modules/@fin"), { recursive: true });
  symlinkSync(HARNESS, join(root, "node_modules/@fin/testing"), "dir");
  symlinkSync(join(REPOSITORY, "packages/server"), join(root, "node_modules/@fin/server"), "dir");
  const vite = realpathSync.native(join(REPOSITORY, "packages/server/node_modules/vite"));
  symlinkSync(vite, join(root, "node_modules/vite"), "dir");
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name);
    const harness = (path: string) =>
      relative(dirname(file), join(HARNESS, path)).split(sep).join("/");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text(harness));
  }
  return root;
}

// A planted app whose config takes a helper's config after serverBundleConfig's, and whose entry
// starts a worker and imports through a file of re-exports at the app's root: files a change could
// add to an app without touching its vite.server.config.ts's call or its src/. `files` adds others.
const helped = (
  helper: string,
  barrel: Source,
  files: Readonly<Record<string, Source>> = {},
): Record<string, Source> => ({
  ...files,
  "vite.server.config.ts": () =>
    'import { serverBundleConfig } from "@fin/server/vite";\n' +
    'import { defineConfig } from "vite";\n' +
    'import { shared } from "./vite.shared.ts";\n\n' +
    "export default defineConfig({\n" +
    '  ...serverBundleConfig({ root: import.meta.dirname, entry: "src/server.node.ts" }),\n' +
    "  ...shared,\n" +
    "});\n",
  "vite.shared.ts": () =>
    `import type { UserConfig } from "vite";\n\nexport const shared: UserConfig = ${helper};\n`,
  "zz-barrel.ts": barrel,
  "src/value.ts": () => "export const value = 1;\n",
  "src/planted-worker.ts": () => "(globalThis as Record<string, unknown>).planted = 1;\n",
  [ENTRY]: () =>
    'import Planted from "./planted-worker.ts?worker&inline";\n' +
    'import { planted, value } from "../zz-barrel.ts";\n' +
    "export const harness = [Planted, planted, value];\n",
});
/** Helpers: one that keeps serverBundleConfig's plugins, and ones that spread them away. */
const KEEPS = "{}";
const SPREADS_AWAY = "{ plugins: [], worker: {} }";
const SPREADS_WORKERS_AWAY = "{ worker: {} }";
/**
 * Files of re-exports: one that adds no code, one that loads the harness by a typed glob, and one
 * that takes an `?inline` stylesheet whose `url()` names a file outside src/.
 */
const REEXPORTS: Source = () => 'export { value, value as planted } from "./src/value.ts";\n';
const GLOBS: Source = (harness) =>
  'export { value } from "./src/value.ts";\n' +
  `export const planted = import.meta.glob<Record<string, unknown>>(${JSON.stringify(
    harness("src/tot?.ts"),
  )}, { eager: true });\n`;
const STYLES: Source = () =>
  'export { value } from "./src/value.ts";\n' +
  'export { default as planted } from "./src/planted.css?inline";\n';
const STYLESHEET: Record<string, Source> = {
  "src/planted.css": () => 'a { background: url("../assets/banner.bin"); }\n',
};

// A change can hide a release build that has lost the guard and ships the harness in two ways:
// turbo replays a cached pass of these tests, or the tests, when they run, read something other
// than the build. Here a helper the app's config imports spreads the guard away, and a file of
// re-exports beside the entry loads the harness through a typed glob; no list of inputs named
// either file, and the file of re-exports adds no code of its own until it globs. An asset outside
// src/ that is a link to a harness file, which a stylesheet's `url()` inlines, is no module at
// all. The tests run on every change (above), and each case is what they then report.
describe("a release build that lost the guard fails the real-bundle check", () => {
  const config = (root: string) => join(root, "vite.server.config.ts");
  // A file of the harness that Vite inlines as a data: URL (under 4 KiB).
  const small = globSync("src/**/*.ts", { cwd: HARNESS })
    .map((path) => path.split(sep).join("/"))
    .sort()
    .find((path) => {
      const size = statSync(join(HARNESS, path)).size;
      return size > 0 && size < 4096;
    });
  /** The planted app `files` make, with assets/banner.bin a link to the small harness file. */
  const withBanner = (files: Record<string, Source>): string => {
    if (small === undefined) throw new Error("the harness holds no file the test can inline");
    const root = plantApp(files);
    mkdirSync(join(root, "assets"));
    symlinkSync(join(HARNESS, small), join(root, "assets/banner.bin"));
    return root;
  };

  it("with only the config's helper changed: no bundle carries the guard", async () => {
    const inspection = await inspect(config(plantApp(helped(SPREADS_AWAY, REEXPORTS))));
    expect(problems(inspection)).toEqual([
      "the release config gives a worker's bundle no guard",
      "the main bundle was built without the guard",
      "a worker's bundle was built without the guard",
    ]);
  }, 60_000);

  it("with a helper that spreads away only the worker's guard", async () => {
    const inspection = await inspect(config(plantApp(helped(SPREADS_WORKERS_AWAY, REEXPORTS))));
    expect(problems(inspection)).toEqual([
      "the release config gives a worker's bundle no guard",
      "a worker's bundle was built without the guard",
    ]);
  }, 60_000);

  it("with the helper and the file of re-exports changed: the build ships the harness", async () => {
    const inspection = await inspect(config(plantApp(helped(SPREADS_AWAY, GLOBS))));
    expect(readFileSync(join(inspection.outDir, "main.js"), "utf8")).toContain("function totp(");
    expect(problems(inspection)).toEqual([
      "the release config gives a worker's bundle no guard",
      "the main bundle was built without the guard",
      "the main bundle holds the harness: packages/testing/src/totp.ts",
      "a worker's bundle was built without the guard",
    ]);
  }, 60_000);

  it("with only the file of re-exports changed: the guard refuses the build", async () => {
    await expect(inspect(config(plantApp(helped(KEEPS, GLOBS))))).rejects.toThrow(
      harnessMessage(["packages/testing/src/totp.ts"]),
    );
  }, 60_000);

  it("with the helper changed and an asset linked to a harness file: the output carries it", async () => {
    const inspection = await inspect(config(withBanner(helped(SPREADS_AWAY, STYLES, STYLESHEET))));
    const file = readFileSync(join(HARNESS, String(small)));
    expect(readFileSync(join(inspection.outDir, "main.js"), "utf8")).toContain(
      file.toString("base64"),
    );
    expect(problems(inspection)).toEqual([
      "the release config gives a worker's bundle no guard",
      "the main bundle was built without the guard",
      `the main bundle carries the harness: packages/testing/${small}`,
      "a worker's bundle was built without the guard",
    ]);
  }, 60_000);

  it("with only the asset linked to a harness file: the guard refuses the build", async () => {
    await expect(inspect(config(withBanner(helped(KEEPS, STYLES, STYLESHEET))))).rejects.toThrow(
      harnessMessage([`packages/testing/${small}`]),
    );
  }, 60_000);

  it("and reads every bundle and module, a file of re-exports the maps leave out included", async () => {
    const root = plantApp(helped(KEEPS, REEXPORTS));
    const inspection = await inspect(config(root));
    expect(problems(inspection)).toEqual([]);
    expect(inspection.bundles.map((bundle) => bundle.worker).sort()).toEqual([false, true]);
    const barrel = join(root, "zz-barrel.ts");
    expect(inspection.bundles.flatMap((bundle) => bundle.modules)).toContain(barrel);
    expect(mapSources(inspection.outDir)).not.toContain(barrel);
  }, 60_000);
});
