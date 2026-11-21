// The release bundle's harness guard (ARCHITECTURE §3.5, [SA-38]; the steward's suggestion of 21
// Nov). The test harness, packages/testing, is built only into the `test` image target and the e2e
// harness (spec 01 §4.9: "`test` adds the seams and `packages/testing`"); `release`, the bundle
// that deploys, holds none of it. imports:check keeps the harness out of deployable code's
// imports, but it reads source text; this plugin reads what the build actually put in the bundle,
// so a route the lint does not see (a glob, a path the resolver completes, another package's own
// import) still cannot ship it. It fails the build when any module of the bundle's graph lies
// under packages/testing/, compared by real path (symbolic links, such as pnpm's workspace links,
// resolved, and on a case-insensitive file system the name's case as stored), and names each such
// module by its repository path. serverBundleConfig adds it to every release build, to the main
// bundle's plugins and to each worker's (a `?worker` import is a bundle of its own, built with only
// the worker's plugins).
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

/** The plugin's name, as Vite reports it. */
export const HARNESS_GUARD = "fin:release-harness-guard";

/** The harness's directory, relative to the repository's root. */
export const HARNESS_DIRECTORY = "packages/testing";

// This file is packages/server/src/build/harness-guard.ts.
const REPOSITORY = resolve(import.meta.dirname, "../../../..");

/**
 * `path` with every symbolic link resolved, as the file system stores it. A path that does not
 * exist (a virtual module's) keeps its missing tail under its nearest existing directory's real
 * path, so it compares the same way.
 */
function realPath(path: string): string {
  const tail: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(at), ...tail);
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      tail.unshift(basename(at));
      at = parent;
    }
  }
}

/** Whether `path` is `directory` or lies under it. */
function within(directory: string, path: string): boolean {
  const rest = relative(directory, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** `rest`, a path under the harness's directory, as a repository path. */
function repositoryPath(rest: string): string {
  const posix = rest.split(sep).join("/");
  return posix === "" ? HARNESS_DIRECTORY : `${HARNESS_DIRECTORY}/${posix}`;
}

/**
 * The repository paths of the modules among `ids` that lie under the harness's directory, sorted.
 * A module ID is read as a bundler writes one: a virtual module's leading NUL and a query or
 * fragment are dropped, and an ID that is no path but holds the harness's path (a plugin's prefixed
 * ID, `\0name:/repo/packages/testing/...`) counts as well.
 */
export function harnessModules(ids: Iterable<string>, repository: string = REPOSITORY): string[] {
  const lexical = resolve(repository, HARNESS_DIRECTORY);
  const harness = realPath(lexical);
  const found = new Set<string>();
  for (const id of ids) {
    const bare = id.startsWith("\0") ? id.slice(1) : id;
    // The path without its query first, so the module is named as a file; then as written, for a
    // file whose name holds a `?` or `#`.
    const paths = [bare.replace(/[?#].*$/s, ""), bare].filter((path) => isAbsolute(path));
    for (const path of paths) {
      const real = realPath(path);
      if (!within(harness, real)) continue;
      found.add(repositoryPath(relative(harness, real)));
      break;
    }
    if (paths.length > 0) continue;
    for (const directory of new Set([harness, lexical])) {
      const at = id.indexOf(`${directory}${sep}`);
      if (at === -1) continue;
      const rest = id.slice(at + directory.length + 1).replace(/[?#].*$/s, "");
      found.add(repositoryPath(rest));
    }
  }
  return [...found].sort();
}

/** The guard's refusal, naming each module of the harness the bundle holds. */
export function harnessMessage(modules: readonly string[]): string {
  return (
    "the release server bundle holds the test harness, which only the test target may contain " +
    `(ARCHITECTURE §3.5, SA-38): ${modules.join(", ")}`
  );
}

/**
 * Fails a release build whose module graph holds a module under packages/testing/: when such a
 * module is loaded, when the graph is complete (every module and external, this.getModuleIds()),
 * and in the output (each chunk's modules and each asset's source files).
 */
export function harnessGuard(repository: string = REPOSITORY): Plugin {
  return {
    name: HARNESS_GUARD,
    enforce: "pre",
    load: {
      order: "pre",
      handler(id) {
        const modules = harnessModules([id], repository);
        if (modules.length > 0) this.error(harnessMessage(modules));
        return null;
      },
    },
    buildEnd(error) {
      if (error !== undefined) return;
      const modules = harnessModules(this.getModuleIds(), repository);
      if (modules.length > 0) this.error(harnessMessage(modules));
    },
    generateBundle(_options, bundle) {
      const ids: string[] = [];
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk") ids.push(...file.moduleIds, ...Object.keys(file.modules));
        else ids.push(...file.originalFileNames);
      }
      const modules = harnessModules(ids, repository);
      if (modules.length > 0) this.error(harnessMessage(modules));
    },
  };
}
