// The import scanner for one hop (spec 07 §2.5): `import ... from`, `export ... from`, a bare
// side-effect import and a dynamic import of a string literal, read with regular expressions over
// the tree; no compiler.
// Relative specifiers resolve against the importing file (with the usual TypeScript extensions and
// index files, and `./x.js` for `x.ts`); `@fin/<name>[/sub]` resolves through that package's
// package.json `exports` (or `main`) to a file. Out: the files a file imports. In: the files that
// import it, and the files that import its package's entry and name an export it defines.

import { posix } from "node:path";
import { isJsonObject, parseJsonBytes } from "../json.ts";

export const CODE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const MAX_SCAN_BYTES = 1 << 20;
const STATIC_RE = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"'\n]{1,300})["']/g;
const DYNAMIC_RE = /\bimport\(\s*["']([^"'\n]{1,300})["']\s*\)/g;
const EXPORT_NAME_RE =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const INDEXES = ["index.ts", "index.tsx", "index.js", "index.mjs"];

export interface ImportRecord {
  /** The resolved file in the tree. */
  readonly target: string;
  /** The import statement's text, for matching named imports. */
  readonly statement: string;
  /** The package name when the specifier was `@fin/...`. */
  readonly packageName: string | null;
  /** True when the specifier was the package's entry (no subpath). */
  readonly packageEntry: boolean;
}

export interface ImportGraph {
  /** Files `path` imports (one hop out). */
  importsOf(path: string): string[];
  /** Files that import `path`, or import its package's entry and name one of its exports (one hop in). */
  importersOf(path: string): string[];
}

interface PackageInfo {
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
}

/** The export names a file defines at top level. */
export function exportedNames(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(EXPORT_NAME_RE)) if (match[1] !== undefined) out.add(match[1]);
  return [...out];
}

/** The export declaration heads of a file: each top-level `export` line, cut before its body. */
export function exportHeads(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.startsWith("export ")) continue;
    const brace = line.indexOf("{");
    const head = brace > 0 && !/^export\s*\{/.test(line) && !/^export\s+(?:type|interface)\s/.test(line) ? line.slice(0, brace).trimEnd() : line;
    out.push(head.length > 200 ? `${head.slice(0, 200)}...` : head);
  }
  return out;
}

function stripComments(text: string): string {
  // Block comments and line comments outside strings are removed well enough for import scanning;
  // a `//` inside a string literal can cut a line, which loses at most that line's import.
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function resolveRelative(files: ReadonlySet<string>, from: string, spec: string): string | null {
  const joined = posix.normalize(posix.join(posix.dirname(from), spec));
  if (joined.startsWith("../") || joined === ".." || joined.startsWith("/")) return null;
  const candidates = [joined];
  for (const ext of EXTENSIONS) candidates.push(`${joined}${ext}`);
  const jsToTs = /\.(m|c)?js$/.exec(joined);
  if (jsToTs !== null) {
    const stem = joined.slice(0, -jsToTs[0].length);
    candidates.push(`${stem}.${jsToTs[1] ?? ""}ts`, `${stem}.tsx`);
  }
  for (const index of INDEXES) candidates.push(posix.join(joined, index));
  for (const candidate of candidates) if (files.has(candidate)) return candidate;
  return null;
}

function exportTarget(exportsField: unknown, subpath: string): string | null {
  const pick = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (isJsonObject(value)) {
      for (const key of ["import", "default", "node", "types"]) {
        const found = pick(value[key]);
        if (found !== null) return found;
      }
    }
    return null;
  };
  if (typeof exportsField === "string") return subpath === "." ? exportsField : null;
  if (!isJsonObject(exportsField)) return null;
  const keys = Object.keys(exportsField);
  if (keys.length > 0 && keys.every((key) => !key.startsWith("."))) return subpath === "." ? pick(exportsField) : null;
  return pick(exportsField[subpath]);
}

function resolvePackage(files: ReadonlySet<string>, packages: ReadonlyMap<string, PackageInfo>, spec: string): { target: string; name: string; entry: boolean } | null {
  const match = /^(@fin\/[a-z0-9][a-z0-9._-]*)(\/.*)?$/.exec(spec);
  if (match === null || match[1] === undefined) return null;
  const name = match[1];
  const info = packages.get(name);
  if (info === undefined) return null;
  const subpath = match[2] === undefined ? "." : `.${match[2]}`;
  let target = exportTarget(info.manifest["exports"], subpath);
  if (target === null && subpath === ".") {
    const main = info.manifest["main"];
    target = typeof main === "string" ? main : "index.ts";
  }
  if (target === null) return null;
  const resolved = resolveRelative(files, posix.join(info.dir, "package.json"), target.startsWith(".") ? target : `./${target}`);
  return resolved === null ? null : { target: resolved, name, entry: subpath === "." };
}

/**
 * Builds the graph from the code files' texts and the workspace manifests (`<dir>/package.json`
 * texts), with every tracked path in `files`.
 */
export function buildGraph(files: ReadonlySet<string>, texts: ReadonlyMap<string, string>, manifests: ReadonlyMap<string, string>): ImportGraph {
  const packages = new Map<string, PackageInfo>();
  for (const [path, text] of manifests) {
    const parsed = parseJsonBytes(Buffer.from(text, "utf8"));
    if (!parsed.ok || !isJsonObject(parsed.value)) continue;
    const name = parsed.value["name"];
    if (typeof name === "string" && !packages.has(name)) packages.set(name, { dir: posix.dirname(path), manifest: parsed.value });
  }
  const out = new Map<string, ImportRecord[]>();
  for (const [path, raw] of texts) {
    if (!CODE_FILE_RE.test(path) || raw.length > MAX_SCAN_BYTES) continue;
    const text = stripComments(raw);
    const records: ImportRecord[] = [];
    const add = (spec: string, statement: string): void => {
      if (spec.startsWith(".")) {
        const target = resolveRelative(files, path, spec);
        if (target !== null && target !== path) records.push({ target, statement, packageName: null, packageEntry: false });
        return;
      }
      const resolved = resolvePackage(files, packages, spec);
      if (resolved !== null && resolved.target !== path) {
        records.push({ target: resolved.target, statement, packageName: resolved.name, packageEntry: resolved.entry });
      }
    };
    for (const match of text.matchAll(STATIC_RE)) if (match[1] !== undefined) add(match[1], match[0]);
    for (const match of text.matchAll(DYNAMIC_RE)) if (match[1] !== undefined) add(match[1], match[0]);
    out.set(path, records);
  }
  const importers = new Map<string, Set<string>>();
  for (const [from, records] of out) {
    for (const record of records) {
      let set = importers.get(record.target);
      if (set === undefined) importers.set(record.target, (set = new Set()));
      set.add(from);
    }
  }
  const packageOf = (path: string): string | null => {
    let best: { name: string; length: number } | null = null;
    for (const [name, info] of packages) {
      const prefix = info.dir === "." ? "" : `${info.dir}/`;
      if (path.startsWith(prefix) && (best === null || prefix.length > best.length)) best = { name, length: prefix.length };
    }
    return best?.name ?? null;
  };
  const sorted = (set: Iterable<string>): string[] => [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    importsOf: (path) => sorted(new Set((out.get(path) ?? []).map((record) => record.target))),
    importersOf: (path) => {
      const set = new Set(importers.get(path) ?? []);
      const pkg = packageOf(path);
      const text = texts.get(path);
      if (pkg !== null && text !== undefined) {
        const names = exportedNames(text);
        if (names.length > 0) {
          const nameRe = new RegExp(`\\b(?:${names.map((name) => name.replace(/\$/g, "\\$")).join("|")})\\b`);
          for (const [from, records] of out) {
            if (from === path) continue;
            if (records.some((record) => record.packageName === pkg && record.packageEntry && nameRe.test(record.statement))) set.add(from);
          }
        }
      }
      set.delete(path);
      return sorted(set);
    },
  };
}
