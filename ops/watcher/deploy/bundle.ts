// Turns ops/watcher/src into Worker modules with Node built-ins only: Node's own type stripping
// (module.stripTypeScriptTypes, the same erasable-syntax rules the repository typechecks under),
// and each relative `.ts` import renamed to its `.js` module. No bundler, no dependency.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";

export interface WorkerModule {
  /** The module's name in the upload, relative to src, with .js: "index.js", "checks/dns.js". */
  readonly name: string;
  readonly content: string;
  readonly sha256: string;
}

export class BundleError extends Error {
  override readonly name = "BundleError";
}

const SPECIFIER = /(\b(?:from|import)\s*["'])([^"']+)(["'])/g;

/** Rewrites one stripped module's imports; refuses anything but a relative .ts import. */
export function rewriteImports(file: string, code: string): string {
  return code.replace(SPECIFIER, (_whole, start: string, specifier: string, end: string) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      throw new BundleError(`${file} imports ${specifier}: the watcher uses relative imports only`);
    }
    if (!specifier.endsWith(".ts")) {
      throw new BundleError(`${file} imports ${specifier}: relative imports name their .ts file`);
    }
    return `${start}${specifier.slice(0, -3)}.js${end}`;
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Every module of the Worker, index.js first. */
export function bundle(srcDir: string): WorkerModule[] {
  const modules = sourceFiles(srcDir).map((path) => {
    const rel = relative(srcDir, path).split("\\").join("/");
    const stripped = stripTypeScriptTypes(readFileSync(path, "utf8"), { mode: "strip" });
    const content = rewriteImports(rel, stripped);
    return {
      name: rel.replace(/\.ts$/, ".js"),
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  if (!modules.some((m) => m.name === "index.js")) throw new BundleError("src/index.ts is missing");
  return [
    ...modules.filter((m) => m.name === "index.js"),
    ...modules.filter((m) => m.name !== "index.js"),
  ];
}
