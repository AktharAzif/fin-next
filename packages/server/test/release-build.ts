// One app's release server build, run as app.Dockerfile's build-release stage runs it, and what that
// build ran with and held, for the harness guard's real-bundle tests
// (src/build/harness-guard.test.ts, whose inspect() starts it). The test starts this file with
// `node` and no exec arguments, in the app's directory, with an environment it builds from a short
// list, as `pnpm run build:server` starts `vite build --config` there: so Node resolves every
// package's `exports` and `imports` maps with its own conditions alone (never the test runner's
// `--conditions development`), and the config, every helper it imports and the build all read the
// process a release build has. The build takes Vite CLI's own path (createBuilder, its builder
// chosen by the config, then buildApp), with Vite's default config loader, which bundles the config
// and imports it; this file adds a recorder to the main bundle's plugins and to every worker's and
// sends the output to the directory it is given. It writes what it recorded, or the build's error,
// as JSON to the result file.
//
//   node test/release-build.ts <config file> <output directory> <result file>
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBuilder, type Plugin } from "vite";

/** An output file's source: a chunk's code as text, an asset's bytes in base64. */
export type RecordedOutput = { text: string } | { base64: string };

/** What one bundle of a release build ran with and held: the main bundle, or a worker's. */
export interface RecordedBundle {
  worker: boolean;
  /** The mode and NODE_ENV's verdict the bundle's config resolved with (a release: `production`). */
  mode: string;
  production: boolean;
  /** The plugins the bundle's build ran, by name. */
  plugins: string[];
  /** Every module of the bundle's graph, as the build lists it at its end (this.getModuleIds()). */
  modules: string[];
  /** Each file the bundle's output holds, by its source: its chunks' code and its assets'. */
  outputs: RecordedOutput[];
  /** The files each asset of the output was read from, as paths. */
  assets: string[];
}

/** What a server bundle's release build, run from its config file, resolved, ran with and held. */
export interface Recording {
  /** The process the build ran in: Node's exec arguments and its working directory. */
  execArgv: string[];
  cwd: string;
  /** Each bundle the build made: the main bundle and each worker's. */
  bundles: RecordedBundle[];
  /** The plugins the resolved config gives a worker's bundle, whether or not the app has one. */
  workerPlugins: string[];
  /** The main bundle's entry, as a path. */
  entry: string;
}

/** The result file's content: the recording, or the message of the error the build failed with. */
export type Result = { recording: Recording } | { error: string };

const names = (plugins: readonly { name: string }[]): string[] =>
  plugins.map((plugin) => plugin.name);

/**
 * A plugin that records what the bundle it is built into ran with and held, as that build reports
 * it: the mode and production flag its config resolved with; the plugins its environment ran; at
 * its end every module of its graph, those that add no code to the output (a file of re-exports)
 * included, which a source map does not name; and the output it generates, each asset's files
 * included, which no module or map names. In the main bundle it also takes, from the config the
 * build resolved, the entry and the plugins that config gives a worker's bundle.
 */
function recorder(recording: Recording): Plugin {
  let worker = false;
  let mode = "";
  let production = false;
  let recorded: RecordedBundle | undefined;
  return {
    name: "fin:test-bundle-recorder",
    async configResolved(config) {
      worker = config.isWorker;
      mode = config.mode;
      production = config.isProduction;
      if (worker) return;
      recording.entry = resolve(config.root, String(config.build.ssr));
      recording.workerPlugins = names((await config.worker.plugins([])).plugins);
    },
    buildEnd() {
      recorded = {
        worker,
        mode,
        production,
        plugins: names(this.environment.plugins),
        modules: [...this.getModuleIds()],
        outputs: [],
        assets: [],
      };
      recording.bundles.push(recorded);
    },
    generateBundle(_options, bundle) {
      if (recorded === undefined) throw new Error("a bundle was generated before its build ended");
      const root = this.environment.config.root;
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk") {
          recorded.outputs.push({ text: file.code });
        } else {
          const source = file.source;
          recorded.outputs.push(
            typeof source === "string"
              ? { text: source }
              : { base64: Buffer.from(source).toString("base64") },
          );
          recorded.assets.push(...file.originalFileNames.map((name) => resolve(root, name)));
        }
      }
    },
  };
}

const [configFile, outDir, resultFile] = process.argv.slice(2);
if (configFile === undefined || outDir === undefined || resultFile === undefined) {
  throw new Error(
    "usage: node test/release-build.ts <config file> <output directory> <result file>",
  );
}
const recording: Recording = {
  execArgv: [...process.execArgv],
  cwd: process.cwd(),
  bundles: [],
  workerPlugins: [],
  entry: "",
};
let result: Result;
try {
  // As `vite build --config <file>` calls it (Vite's cli.js): no root, mode or config loader given,
  // and `null`, so the config's own `builder` option decides whether every environment is built.
  const builder = await createBuilder(
    {
      configFile,
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
      plugins: [recorder(recording)],
      worker: { plugins: () => [recorder(recording)] },
    },
    null,
  );
  await builder.buildApp();
  result = { recording };
} catch (error) {
  result = { error: error instanceof Error ? error.message : String(error) };
}
writeFileSync(resultFile, JSON.stringify(result));
