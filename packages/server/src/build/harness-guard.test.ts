// The release bundle's harness guard (harness-guard.ts). Planted apps in a temporary directory load
// the test harness by its package name (linked into node_modules as pnpm links a workspace
// package), by a relative path, through import.meta.glob and from a worker's bundle (`?worker`,
// which Vite builds apart with the worker's own plugins): each release build fails with the
// guard's message naming the module by its repository path and writes no bundle, while the same
// app's `test` build holds the harness, which that target may (spec 01 §4.9). So does a release
// build that carries a harness file as an asset Vite read itself (a worker's
// `new URL(..., import.meta.url)`, an `?inline` stylesheet's `url()`), inlined or emitted, planted
// inside the repository so the asset's name is the one a real app's build gives. Each of the
// guard's three checks refuses on its own. Every release server build the images run (each
// ops/docker Dockerfile's build step, the script it runs and the config file that script names,
// read by test/image-build.ts, which refuses a script or a step it cannot read) carries the guard,
// in its main bundle and in every worker's, and still builds, with no module of the harness in its
// graph and no file of it in its output, as the build itself reports them, and the image's output
// scan passes over that output. Each is built as the release image's build runs it: in a Node
// process of its own with no exec arguments, from the package's directory, in the environment the
// Dockerfile gives the step (so NODE_ENV is unset and Vite resolves a production build) and with
// Vite's default config loader (test/release-build.ts). An app whose build:server names another
// config, one without the guard, fails the check (round 2's attacker's reproduction). turbo runs
// these tests on every run, so no cached pass hides a release build that lost the guard; planted
// apps whose config's helper spreads the guard away (always, only when NODE_ENV is production, or
// only in the `default` branch of the app's `exports` map, which the test runner's worker does not
// take), whose file of re-exports or package's production export loads the harness by a typed
// glob, whose helper aliases the app's own module to the harness, or whose stylesheet inlines an
// asset linked to a harness file, fail the same check.
import { execFile, execFileSync } from "node:child_process";
import {
  copyFileSync,
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
import { afterAll, describe, expect, it } from "vitest";
import { type ImageBuild, imageBuilds, runHarnessScan } from "../../test/image-build.ts";
import type {
  RecordedBundle,
  RecordedOutput,
  Recording,
  Result,
} from "../../test/release-build.ts";
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

/** What one bundle of a release build ran with and held (test/release-build.ts records it). */
interface Bundle extends Omit<RecordedBundle, "outputs"> {
  /** Each file the bundle's output holds, by its source: its chunks' code and its assets'. */
  outputs: (string | Uint8Array)[];
}

/** What a server bundle's release build, run from its config file, resolved, ran with and held. */
interface Inspection extends Omit<Recording, "bundles"> {
  /** Each bundle the build made: the main bundle and each worker's. */
  bundles: Bundle[];
  outDir: string;
}

/** The release build's inspector, which inspect() starts as a process of its own. */
const RELEASE_BUILD = join(REPOSITORY, "packages/server/test/release-build.ts");

/**
 * Every release server build the images run, read from the Dockerfiles under ops/docker, the
 * script each runs and the config file that script names (test/image-build.ts).
 */
const IMAGES = imageBuilds(REPOSITORY);

/** A release build to inspect: the config file, the directory it runs from and its environment. */
type Target = Pick<ImageBuild, "configFile" | "directory" | "environment">;

/**
 * The environment app.Dockerfile gives its release build step, as test/image-build.ts reads it for
 * the first app it builds (the ENV of its stages, the app's build argument and the step's
 * FIN_BUILD_TARGET=release, with no NODE_ENV), for a planted app's build.
 */
function appImageEnvironment(): Record<string, string> {
  const build = IMAGES.builds.find((each) => each.dockerfile === "ops/docker/app.Dockerfile");
  if (build === undefined) {
    throw new Error(`app.Dockerfile builds no app: ${IMAGES.refusals.join("; ")}`);
  }
  return { ...build.environment };
}

/** The planted app at `root`, built from its vite.server.config.ts as app.Dockerfile builds one. */
const planted = (root: string): Target => ({
  configFile: join(root, "vite.server.config.ts"),
  directory: root,
  environment: appImageEnvironment(),
});

const decode = (output: RecordedOutput): string | Uint8Array =>
  "text" in output ? output.text : new Uint8Array(Buffer.from(output.base64, "base64"));

/**
 * Runs the release build of the server bundle that `target`'s config file describes into a
 * temporary directory, with a recorder added to its plugins and to every worker's, as the image's
 * build step runs `vite build --config <file>` through pnpm (test/release-build.ts): in a process
 * of its own started with `node` and no exec arguments (this test's worker thread runs with
 * Vitest's `--conditions node --conditions development`, under which Node takes a package's
 * `exports` or `imports` map's `development` branch where a release build takes `default`), with
 * the package's directory as its working directory, where pnpm runs the script, and with Vite's
 * default config loader, which bundles the config and imports it. Its environment is the one the
 * Dockerfile gives the build step (`target.environment`: its stages' ENV, such as CI=1, the app's
 * build argument and FIN_BUILD_TARGET=release, and no NODE_ENV, so `vite build` sets it to
 * `production` before it loads the config, and Vite resolves the `development|production` export
 * condition and import.meta.env.PROD as that build does), with PATH and HOME taken from here and
 * `env` laid over it (an `undefined` value unsets a name); it is built from that list rather than
 * by removing names from the test runner's, so NODE_OPTIONS and the runner's variables (VITEST and
 * the rest) never reach it. A build that fails rejects with its error's message. What still
 * differs from the release build: the recorder in each bundle's plugins and the output's
 * directory, which the recorder needs; the base image's own variables and those `pnpm run` adds
 * for a script (npm_lifecycle_event and the rest), which no app's config reads; and that the
 * image's build runs on Linux from a fresh install. problems() refuses a build that ran with exec
 * arguments or did not resolve as a production build.
 */
async function inspect(
  target: Target,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<Inspection> {
  const outDir = temporary();
  const resultFile = join(temporary(), "result.json");
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...target.environment,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  const stderr = await new Promise<string>((done, fail) => {
    execFile(
      process.execPath,
      [RELEASE_BUILD, target.configFile, outDir, resultFile],
      {
        cwd: target.directory,
        env: environment,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 55_000,
      },
      (error, _stdout, text) => {
        if (error !== null && !existsSync(resultFile)) {
          fail(new Error(`the release build's process failed: ${error.message}\n${text}`));
        } else {
          done(text);
        }
      },
    );
  });
  if (!existsSync(resultFile)) throw new Error(`the release build wrote no result: ${stderr}`);
  const result = JSON.parse(readFileSync(resultFile, "utf8")) as Result;
  if ("error" in result) throw new Error(result.error);
  const { recording } = result;
  return {
    ...recording,
    bundles: recording.bundles.map((bundle) => ({
      ...bundle,
      outputs: bundle.outputs.map(decode),
    })),
    outDir,
  };
}

/**
 * What makes an inspected release build unfit to ship, or unfit to stand for the one that ships,
 * read from the build itself: a build that ran with Node's exec arguments (`vite build` runs with
 * none, so a `--conditions` flag would change what the config's imports resolve to), a config that
 * gives a worker's bundle no guard, a bundle that did not resolve as a production build (mode
 * `production` and NODE_ENV `production`, as `vite build` resolves a release), a bundle built
 * without the guard, any module of the harness in a bundle's graph, and any file of the harness its
 * output carries as an asset or whole (harnessContents, which compares with every file of
 * packages/testing). The main bundle comes first, then each worker's.
 */
function problems(inspection: Inspection): string[] {
  const found: string[] = [];
  if (inspection.execArgv.length > 0) {
    found.push(`the build ran with Node's exec arguments: ${inspection.execArgv.join(" ")}`);
  }
  if (!inspection.workerPlugins.includes(HARNESS_GUARD)) {
    found.push("the release config gives a worker's bundle no guard");
  }
  const main = inspection.bundles.filter((bundle) => !bundle.worker).length;
  if (main !== 1) found.push(`the build made ${main} main bundles`);
  const bundles = [...inspection.bundles].sort((a, b) => Number(a.worker) - Number(b.worker));
  for (const bundle of bundles) {
    const which = bundle.worker ? "a worker's bundle" : "the main bundle";
    if (bundle.mode !== "production" || !bundle.production) {
      found.push(
        `${which} did not resolve as a release build: ` +
          `mode ${bundle.mode}, isProduction ${bundle.production}`,
      );
    }
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

// These tests read files no list of a task's inputs can name before they exist: the Dockerfiles
// under ops/docker and each app's manifest (which script the image runs, and which config file it
// names), any file an app's config imports (a helper it spreads into its config), every module of a
// bundle's graph wherever it lies (a file of re-exports adds no code, so no map names it), every
// file of packages/testing (harnessContents compares each output with them all), and any file
// Vite reads itself into a bundle as an asset. A cached pass replayed after a change to one of them
// could hide a release build that lost the guard and ships the harness. So turbo never caches
// `@fin/server#test`: the tests run on every `turbo run test`, which costs `pnpm check` the
// package's whole suite (4 to 16 s on a developer's machine, by its load) even when nothing
// changed. Each real-bundle test builds what an image's build step runs (IMAGES) and reads the
// build itself, run as that step runs it (inspect): the plugins each of its bundles ran, every
// module of each one's graph and its output, as the build reports them; and it runs the image's
// output scan over that output, as the step does right after the build.
describe("the real server bundles", () => {
  it("are every release build the images run, each read from its Dockerfile and script", () => {
    expect(IMAGES.refusals).toEqual([]);
    expect(IMAGES.builds.length).toBeGreaterThan(0);
  });

  it("are checked on every run of the tests, never by a cached pass", () => {
    expect(serverTestTask().cache).toBe(false);
  }, 30_000);

  it.each(IMAGES.builds.map((build) => [build.label, build] as const))(
    "%s carries the guard in every bundle of a release build, still builds, and passes the scan",
    async (_label, build) => {
      const inspection = await inspect(build);
      expect(problems(inspection)).toEqual([]);
      expect(existsSync(join(inspection.outDir, "main.js"))).toBe(true);
      const main = inspection.bundles.find((bundle) => !bundle.worker);
      expect(main?.modules).toContain(inspection.entry);
      expect(runHarnessScan(REPOSITORY, inspection.outDir).status).toBe(0);
    },
    60_000,
  );
});

/** A planted app's package.json, as a real app's: a private ES module package. */
const appManifest = (fields: Readonly<Record<string, unknown>> = {}): Source => {
  const manifest = { name: "@planted/app", private: true, type: "module", ...fields };
  return () => `${JSON.stringify(manifest, null, 2)}\n`;
};

/**
 * A planted app that builds from its own vite.server.config.ts as a real app does, with its own
 * package.json (appManifest unless `files` writes one) and `@fin/server`, `@fin/testing` and `vite`
 * linked into its node_modules as pnpm links them; `files` writes each file under its root (a new
 * temporary directory unless `root` names one), given how that file's directory reaches the
 * harness's files.
 */
function plantApp(files: Readonly<Record<string, Source>>, root: string = temporary()): string {
  mkdirSync(join(root, "node_modules/@fin"), { recursive: true });
  symlinkSync(HARNESS, join(root, "node_modules/@fin/testing"), "dir");
  symlinkSync(join(REPOSITORY, "packages/server"), join(root, "node_modules/@fin/server"), "dir");
  const vite = realpathSync.native(join(REPOSITORY, "packages/server/node_modules/vite"));
  symlinkSync(vite, join(root, "node_modules/vite"), "dir");
  for (const [name, text] of Object.entries({ "package.json": appManifest(), ...files })) {
    const file = join(root, name);
    const harness = (path: string) =>
      relative(dirname(file), join(HARNESS, path)).split(sep).join("/");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text(harness));
  }
  return root;
}

// A planted app whose config takes, after serverBundleConfig's, the config `shared` that the module
// `helperModule` names exports, and whose entry starts a worker and imports through a file of
// re-exports at the app's root: files a change could add to an app without touching its
// vite.server.config.ts's call or its src/. `files` adds others.
const configured = (
  helperModule: string,
  barrel: Source,
  files: Readonly<Record<string, Source>> = {},
): Record<string, Source> => ({
  ...files,
  "vite.server.config.ts": () =>
    'import { serverBundleConfig } from "@fin/server/vite";\n' +
    'import { defineConfig } from "vite";\n' +
    `import { shared } from ${JSON.stringify(helperModule)};\n\n` +
    "export default defineConfig({\n" +
    '  ...serverBundleConfig({ root: import.meta.dirname, entry: "src/server.node.ts" }),\n' +
    "  ...shared,\n" +
    "});\n",
  "zz-barrel.ts": barrel,
  "src/value.ts": () => "export const value = 1;\n",
  "src/planted-worker.ts": () => "(globalThis as Record<string, unknown>).planted = 1;\n",
  [ENTRY]: () =>
    'import Planted from "./planted-worker.ts?worker&inline";\n' +
    'import { planted, value } from "../zz-barrel.ts";\n' +
    "export const harness = [Planted, planted, value];\n",
});
/** A helper module whose `shared` config is the expression `helper`. */
const sharedConfig =
  (helper: string): Source =>
  () =>
    `import type { UserConfig } from "vite";\n\nexport const shared: UserConfig = ${helper};\n`;
/** A planted app whose config takes `helper`'s config from vite.shared.ts beside it (configured). */
const helped = (
  helper: string,
  barrel: Source,
  files: Readonly<Record<string, Source>> = {},
): Record<string, Source> =>
  configured("./vite.shared.ts", barrel, { ...files, "vite.shared.ts": sharedConfig(helper) });
/**
 * A planted app whose config takes its helper by the app's own package name, through the `exports`
 * map of its package.json: the `development` branch, which Node takes under the test runner's
 * `--conditions development`, keeps serverBundleConfig's plugins; the `default` branch, which
 * `vite build` takes, is the module `released` writes.
 */
const behindExports = (
  released: Source,
  barrel: Source,
  files: Readonly<Record<string, Source>> = {},
): Record<string, Source> =>
  configured("@planted/app/vite-shared", barrel, {
    ...files,
    "package.json": appManifest({
      exports: {
        "./vite-shared": { development: "./vite.shared.dev.ts", default: "./vite.shared.ts" },
      },
    }),
    "vite.shared.dev.ts": sharedConfig("{}"),
    "vite.shared.ts": released,
  });
/**
 * A helper that spreads the guard away and aliases the app's own src/codes.ts to the harness's
 * totp.ts, a file of re-exports that takes src/codes.ts, and src/codes.ts itself, which holds no
 * `function totp(`: so the output holds the harness's code only where the alias applied.
 */
const ALIASES_TO_THE_HARNESS: Source = (harness) =>
  'import { join } from "node:path";\n' +
  'import type { UserConfig } from "vite";\n\n' +
  "export const shared: UserConfig = {\n" +
  "  plugins: [],\n" +
  "  worker: {},\n" +
  `  resolve: { alias: { "./src/codes.ts": join(import.meta.dirname, ${JSON.stringify(
    harness("src/totp.ts"),
  )}) } },\n` +
  "};\n";
const CODES: Source = () =>
  'export { value } from "./src/value.ts";\nexport { totp as planted } from "./src/codes.ts";\n';
const CODES_MODULE: Record<string, Source> = {
  "src/codes.ts": () => 'export const totp = (): string => "";\n',
};
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
/**
 * What only a production build reads: a helper that spreads the guard away when NODE_ENV is
 * `production`, a file of re-exports that globs the harness where import.meta.env.PROD is true, and
 * one that takes a package whose `production` export condition globs it.
 */
const SPREADS_AWAY_IN_PRODUCTION =
  '(process.env.NODE_ENV === "production" ? { plugins: [], worker: {} } : {})';
/** A helper that spreads the guard away outside the test runner, as a release build runs. */
const SPREADS_AWAY_OUTSIDE_VITEST =
  "(process.env.VITEST === undefined ? { plugins: [], worker: {} } : {})";
const GLOBS_IN_PRODUCTION: Source = (harness) =>
  'export { value } from "./src/value.ts";\n' +
  "export const planted = import.meta.env.PROD\n" +
  `  ? import.meta.glob<Record<string, unknown>>(${JSON.stringify(harness("src/tot?.ts"))})\n` +
  "  : {};\n";
const FROM_PACKAGE: Source = () =>
  'export { value } from "./src/value.ts";\nexport { planted } from "@planted/conditional";\n';
const CONDITIONAL_PACKAGE: Record<string, Source> = {
  "conditional/package.json": () =>
    `${JSON.stringify({
      name: "@planted/conditional",
      private: true,
      type: "module",
      exports: { ".": { production: "./production.ts", default: "./default.ts" } },
    })}\n`,
  "conditional/production.ts": (harness) =>
    `export const planted = import.meta.glob<Record<string, unknown>>(${JSON.stringify(
      harness("src/tot?.ts"),
    )}, { eager: true });\n`,
  "conditional/default.ts": () => "export const planted = {};\n",
};

// A change can hide a release build that has lost the guard and ships the harness in three ways:
// turbo replays a cached pass of these tests, the tests, when they run, read something other than
// the build, or they build in another environment than the release's. Here a helper the app's
// config imports spreads the guard away, and a file of re-exports beside the entry loads the
// harness through a typed glob; no list of inputs named either file, and the file of re-exports
// adds no code of its own until it globs. An asset outside src/ that is a link to a harness file,
// which a stylesheet's `url()` inlines, is no module at all. A helper, a file of re-exports or a
// package's export condition that does so only in a production build is hidden from a build under
// the test runner's NODE_ENV, and a helper behind a package's `exports` map whose `default` branch
// does so (an alias can also send an app's own module to the harness there) is hidden from a build
// in the test runner's worker, whose Node takes the `development` branch. The tests run on every
// change (above), and each case is what they then report.
describe("a release build that lost the guard fails the real-bundle check", () => {
  const config = planted;
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
  /** The planted app `files` make, with the conditional package linked as pnpm links one. */
  const withPackage = (files: Record<string, Source>): string => {
    const root = plantApp({ ...files, ...CONDITIONAL_PACKAGE });
    mkdirSync(join(root, "node_modules/@planted"));
    symlinkSync(join(root, "conditional"), join(root, "node_modules/@planted/conditional"), "dir");
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

  // app.Dockerfile runs `vite build` with NODE_ENV unset, so Vite sets it to `production` before it
  // loads the config: a helper that reads it, the `development|production` export condition and
  // import.meta.env.PROD all take their production branch, which the test runner's `test` hides.
  it("with a helper that spreads the guard away only in a production build", async () => {
    const root = plantApp(helped(SPREADS_AWAY_IN_PRODUCTION, REEXPORTS));
    expect(problems(await inspect(config(root)))).toEqual([
      "the release config gives a worker's bundle no guard",
      "the main bundle was built without the guard",
      "a worker's bundle was built without the guard",
    ]);
  }, 60_000);

  it("with a helper that spreads the guard away only outside the test runner", async () => {
    const root = plantApp(helped(SPREADS_AWAY_OUTSIDE_VITEST, REEXPORTS));
    expect(problems(await inspect(config(root)))).toEqual([
      "the release config gives a worker's bundle no guard",
      "the main bundle was built without the guard",
      "a worker's bundle was built without the guard",
    ]);
  }, 60_000);

  it("with that helper and a file of re-exports that globs the harness in production", async () => {
    const root = plantApp(helped(SPREADS_AWAY_IN_PRODUCTION, GLOBS_IN_PRODUCTION));
    const inspection = await inspect(config(root));
    expect(readFileSync(join(inspection.outDir, "main.js"), "utf8")).toContain("function totp(");
    expect(problems(inspection)).toEqual([
      "the release config gives a worker's bundle no guard",
      "the main bundle was built without the guard",
      "the main bundle holds the harness: packages/testing/src/totp.ts",
      "a worker's bundle was built without the guard",
    ]);
  }, 60_000);

  it("with that helper and a package whose production export globs the harness", async () => {
    const root = withPackage(helped(SPREADS_AWAY_IN_PRODUCTION, FROM_PACKAGE));
    const inspection = await inspect(config(root));
    expect(readFileSync(join(inspection.outDir, "main.js"), "utf8")).toContain("function totp(");
    expect(problems(inspection)).toEqual([
      "the release config gives a worker's bundle no guard",
      "the main bundle was built without the guard",
      "the main bundle holds the harness: packages/testing/src/totp.ts",
      "a worker's bundle was built without the guard",
    ]);
  }, 60_000);

  it("with only a file of re-exports that globs the harness in production: the guard refuses", async () => {
    await expect(inspect(config(plantApp(helped(KEEPS, GLOBS_IN_PRODUCTION))))).rejects.toThrow(
      harnessMessage(["packages/testing/src/totp.ts"]),
    );
  }, 60_000);

  // app.Dockerfile's `vite build` runs in a Node process with no exec arguments, so a package's
  // `exports` map takes its `default` branch where the test runner's worker takes `development`.
  it("with a helper behind the app's exports map that spreads the guard away by default", async () => {
    const root = plantApp(behindExports(sharedConfig(SPREADS_AWAY), REEXPORTS));
    expect(problems(await inspect(config(root)))).toEqual([
      "the release config gives a worker's bundle no guard",
      "the main bundle was built without the guard",
      "a worker's bundle was built without the guard",
    ]);
  }, 60_000);

  it("with that helper aliasing the app's own module to the harness: the build ships it", async () => {
    const root = plantApp(behindExports(ALIASES_TO_THE_HARNESS, CODES, CODES_MODULE));
    const inspection = await inspect(config(root));
    expect(readFileSync(join(inspection.outDir, "main.js"), "utf8")).toContain("function totp(");
    expect(problems(inspection)).toEqual([
      "the release config gives a worker's bundle no guard",
      "the main bundle was built without the guard",
      "the main bundle holds the harness: packages/testing/src/totp.ts",
      "a worker's bundle was built without the guard",
    ]);
  }, 60_000);

  it("and runs the build as `vite build` runs: no exec arguments, from the app's directory", async () => {
    const root = plantApp(helped(KEEPS, REEXPORTS));
    const inspection = await inspect(config(root));
    expect(inspection.execArgv).toEqual([]);
    expect(inspection.cwd).toBe(root);
    expect(problems({ ...inspection, execArgv: ["--conditions", "development"] })).toEqual([
      "the build ran with Node's exec arguments: --conditions development",
    ]);
  }, 60_000);

  it("and refuses a build that did not resolve as the release build does", async () => {
    const root = plantApp(helped(KEEPS, REEXPORTS));
    expect(problems(await inspect(config(root), { NODE_ENV: "test" }))).toEqual([
      "the main bundle did not resolve as a release build: mode production, isProduction false",
      "a worker's bundle did not resolve as a release build: mode production, isProduction false",
    ]);
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

/**
 * A planted repository holding the real Dockerfiles and pnpm-workspace.yaml, and one app, apps/api,
 * planted from `files` as plantApp plants one, so test/image-build.ts reads the image's build of it
 * as it reads a real app's.
 */
function plantRepository(files: Readonly<Record<string, Source>>): string {
  const repository = temporary();
  const copied = [
    "pnpm-workspace.yaml",
    ...globSync("ops/docker/*.Dockerfile", { cwd: REPOSITORY }),
  ];
  for (const path of copied) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    copyFileSync(join(REPOSITORY, path), join(repository, path));
  }
  plantApp(files, join(repository, "apps/api"));
  return repository;
}

// Round 2's attacker: app.Dockerfile runs `pnpm --filter "@fin/${APP}" run build:server`, not a
// build of vite.server.config.ts, so an app whose build:server names another config, one without
// the guard, shipped that config's build while the check, which built vite.server.config.ts by its
// name, passed. Here apps/api's build:server names vite.bundle.config.ts, which spreads the guard
// away and aliases the app's own module to the harness's totp.ts; its vite.server.config.ts, which
// the image no longer runs, is the real apps' config and builds clean. The check builds what the
// image runs (test/image-build.ts reads the Dockerfile and the script), so it reports the lost
// guard and the harness in the bundle; and the image's output scan, which the build step runs right
// after the build, refuses the output, which carries the harness's markers.
describe("the release build the image runs is the one checked", () => {
  const BUNDLE_CONFIG: Source = (harness) =>
    'import { join } from "node:path";\n' +
    'import { serverBundleConfig } from "@fin/server/vite";\n' +
    'import { defineConfig } from "vite";\n\n' +
    "export default defineConfig({\n" +
    '  ...serverBundleConfig({ root: import.meta.dirname, entry: "src/server.node.ts" }),\n' +
    "  plugins: [],\n" +
    "  worker: {},\n" +
    `  resolve: { alias: { "./codes.ts": join(import.meta.dirname, ${JSON.stringify(
      harness("src/totp.ts"),
    )}) } },\n` +
    "});\n";
  const SERVER_CONFIG: Source = () =>
    'import { serverBundleConfig } from "@fin/server/vite";\n' +
    'import { defineConfig } from "vite";\n\n' +
    "export default defineConfig(\n" +
    '  serverBundleConfig({ root: import.meta.dirname, entry: "src/server.node.ts" }),\n' +
    ");\n";

  it("an app whose build:server names a config without the guard fails the check", async () => {
    const repository = plantRepository({
      "package.json": appManifest({
        name: "@fin/api",
        scripts: { "build:server": "vite build --config vite.bundle.config.ts" },
      }),
      "vite.server.config.ts": SERVER_CONFIG,
      "vite.bundle.config.ts": BUNDLE_CONFIG,
      [ENTRY]: () => 'import { totp } from "./codes.ts";\nexport const planted = totp;\n',
      "src/codes.ts": () => 'export const totp = (): string => "";\n',
    });
    const images = imageBuilds(repository);
    expect(images.refusals).toEqual([]);
    expect(images.builds.map((build) => [build.label, build.configFile])).toEqual([
      ["ops/docker/app.Dockerfile, APP=api", join(repository, "apps/api/vite.bundle.config.ts")],
    ]);
    const [build] = images.builds;
    if (build === undefined) throw new Error("the planted repository's image builds nothing");
    const inspection = await inspect(build);
    expect(readFileSync(join(inspection.outDir, "main.js"), "utf8")).toContain("function totp(");
    expect(problems(inspection)).toEqual([
      "the release config gives a worker's bundle no guard",
      "the main bundle was built without the guard",
      "the main bundle holds the harness: packages/testing/src/totp.ts",
    ]);
    const scan = runHarnessScan(REPOSITORY, inspection.outDir);
    expect(scan.status).toBe(1);
    expect(scan.stderr).toContain("/main.js: a module of the test harness (packages/testing)");
    expect(scan.stderr).toContain("/main.js.map: a map names a file of the test harness");
    // The config the image no longer runs builds clean: a check that took it by its name passed.
    const named = await inspect({
      ...build,
      configFile: join(build.directory, "vite.server.config.ts"),
    });
    expect(problems(named)).toEqual([]);
  }, 120_000);
});
