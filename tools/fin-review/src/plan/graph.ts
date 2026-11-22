// The import scanner (spec 07 §2.5): `import ... from`, `export ... from`, a bare side-effect
// import, a dynamic import and a `require` (or `require.resolve`) of a string literal or of a
// template literal with no substitution, read with regular expressions over the tree; no compiler.
// Relative specifiers resolve against the importing file (with the usual TypeScript extensions and
// index files, and `./x.js` for `x.ts`); `@fin/<name>[/sub]` resolves through that package's
// package.json `exports` (subpath patterns included, or `main`) to a file; `#<name>` resolves
// through the `imports` of the nearest package.json above the importing file. Out: the files a file
// imports. In: the files that import it, and the files that import its package's entry and name an
// export it defines. `reachable` walks out from a set of files through any chain of imports, each
// file once, and says when the walk met a code file it could not read (`opaque`).

import { posix } from "node:path";
import { isJsonObject, parseJsonBytes } from "../json.ts";

export const CODE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const MAX_SCAN_BYTES = 1 << 20;
// Every pattern below matches in time linear in the text: no unbounded lazy part follows a keyword.
/** An `import` or `export` keyword where a statement can start. */
const KEYWORD_RE = /(?:^|[\s;}])(import|export)(?=\s)/g;
/** A `from "<specifier>"` clause. */
const FROM_RE = /\sfrom\s+["']([^"'\n]{1,300})["']/g;
/** A side-effect import: `import "<specifier>"`. */
const SIDE_EFFECT_RE = /(?:^|[\s;}])import\s*["']([^"'\n]{1,300})["']/g;
/**
 * A dynamic import, `require` or `require.resolve` of a quoted specifier or of a template literal with
 * no substitution (a specifier between backticks); an import's options may follow its specifier.
 */
const DYNAMIC_RE = /\b(?:import|require|require\.resolve)\(\s*(?:["']([^"'\n]{1,300})["']|`([^`$\n]{1,300})`)\s*[,)]/g;
/** Most characters of a package manifest's value that is read as a path or a pattern; a longer one is skipped. */
const MAX_MANIFEST_VALUE = 300;
/** Characters a statement's head never holds between its keyword and `from`: ' " ` ; */
const BREAK_CODES: ReadonlySet<number> = new Set([0x27, 0x22, 0x60, 0x3b]);
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
  /**
   * True for a code file of the tree whose imports the graph did not read (its text was not given, as
   * for a symbolic link, or is past the scan bound): a file it may import is unknown.
   */
  opaque(path: string): boolean;
  /** Files `path` imports (one hop out). */
  importsOf(path: string): string[];
  /** Files whose own imports resolve to `path`: the reverse of importsOf (one hop in). */
  directImportersOf(path: string): string[];
  /** Files that import `path`, or import its package's entry and name one of its exports (one hop in). */
  importersOf(path: string): string[];
  /**
   * The statements by which `from` reaches `target` in one hop, as `importersOf(target)` counts it: an
   * import or re-export that resolves to it, or an import of its package's entry that names one of
   * its exports. Empty when `from` does not reach it.
   */
  importStatements(from: string, target: string): string[];
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

/**
 * `text` without its comments, in time linear in the text. Block comments and line comments outside
 * strings are removed well enough for import scanning; a `//` inside a string literal can cut a
 * line, which loses at most that line's import. An unterminated block comment is left as it is.
 */
function stripComments(text: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const open = text.indexOf("/*", pos);
    if (open < 0) break;
    const close = text.indexOf("*/", open + 2);
    if (close < 0) break;
    out += `${text.slice(pos, open)} `;
    pos = close + 2;
  }
  return `${out}${text.slice(pos)}`.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/**
 * The specifiers a file imports, each with its statement's text (for matching named imports), in
 * time linear in the file: a `from` clause belongs to the nearest `import` or `export` keyword before
 * it with no quote, backtick or `;` in between; side-effect and dynamic imports stand alone.
 */
export function scanImports(text: string): Array<{ spec: string; statement: string }> {
  const out: Array<{ spec: string; statement: string }> = [];
  const keywords: number[] = [];
  for (const match of text.matchAll(KEYWORD_RE)) keywords.push((match.index ?? 0) + match[0].length - (match[1]?.length ?? 0));
  // breaks[i] counts the break characters before position i, so a range holds none when two counts agree.
  const breaks = new Uint32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) breaks[i + 1] = (breaks[i] ?? 0) + (BREAK_CODES.has(text.charCodeAt(i)) ? 1 : 0);
  for (const match of text.matchAll(FROM_RE)) {
    const at = match.index ?? 0;
    const spec = match[1];
    if (spec === undefined) continue;
    let lo = 0;
    let hi = keywords.length - 1;
    let start = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const position = keywords[mid] ?? 0;
      if (position < at) {
        start = position;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (start < 0 || breaks[at] !== breaks[start]) continue;
    out.push({ spec, statement: text.slice(start, at + match[0].length) });
  }
  for (const match of text.matchAll(SIDE_EFFECT_RE)) if (match[1] !== undefined) out.push({ spec: match[1], statement: match[0] });
  for (const match of text.matchAll(DYNAMIC_RE)) {
    const spec = match[1] ?? match[2];
    if (spec !== undefined) out.push({ spec, statement: match[0] });
  }
  return out;
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

/** A conditional target's path: the first of its import, default, node or types conditions that names one. */
function pick(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isJsonObject(value)) {
    for (const key of ["import", "default", "node", "types"]) {
      const found = pick(value[key]);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * The target `map` (an `exports` or `imports` object) gives `key`, as Node resolves one: the entry of
 * that key, or else the subpath pattern (a key with one `*`) whose text before and after the `*`
 * start and end `key`, the one with the longest text before it first, with every `*` of its target
 * replaced by what the `*` matched. Null when none, or when the target is too long to read.
 */
function mappedTarget(map: Record<string, unknown>, key: string): string | null {
  const exact = map[key];
  if (exact !== undefined) return pick(exact);
  let best: { prefix: number; key: string; match: string } | null = null;
  for (const candidate of Object.keys(map)) {
    const star = candidate.indexOf("*");
    if (star < 0 || candidate.indexOf("*", star + 1) >= 0) continue;
    const prefix = candidate.slice(0, star);
    const suffix = candidate.slice(star + 1);
    if (key.length < prefix.length + suffix.length || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    if (best === null || prefix.length > best.prefix || (prefix.length === best.prefix && candidate.length > best.key.length)) {
      best = { prefix: prefix.length, key: candidate, match: key.slice(prefix.length, key.length - suffix.length) };
    }
  }
  if (best === null) return null;
  const target = pick(map[best.key]);
  return target === null || target.length > MAX_MANIFEST_VALUE ? null : target.split("*").join(best.match);
}

function exportTarget(exportsField: unknown, subpath: string): string | null {
  if (typeof exportsField === "string") return subpath === "." ? exportsField : null;
  if (!isJsonObject(exportsField)) return null;
  const keys = Object.keys(exportsField);
  if (keys.length > 0 && keys.every((key) => !key.startsWith("."))) return subpath === "." ? pick(exportsField) : null;
  return mappedTarget(exportsField, subpath);
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
 * A `#<name>` specifier of the file at `from`, resolved as Node resolves one: through the `imports` of
 * the nearest package manifest above the file (and no other), to a path relative to that manifest or
 * to a `@fin/` package. Null when it names nothing in the tree.
 */
function resolveImports(
  files: ReadonlySet<string>,
  packages: ReadonlyMap<string, PackageInfo>,
  scopes: ReadonlyMap<string, Record<string, unknown>>,
  from: string,
  spec: string,
): { target: string; name: string | null; entry: boolean } | null {
  let dir = posix.dirname(from);
  let scope = scopes.get(dir);
  while (scope === undefined && dir !== ".") {
    dir = posix.dirname(dir);
    scope = scopes.get(dir);
  }
  const imports = scope?.["imports"];
  if (!isJsonObject(imports)) return null;
  const target = mappedTarget(imports, spec);
  if (target === null) return null;
  if (target.startsWith("./")) {
    const resolved = resolveRelative(files, dir === "." ? "package.json" : `${dir}/package.json`, target);
    return resolved === null ? null : { target: resolved, name: null, entry: false };
  }
  return resolvePackage(files, packages, target);
}

/**
 * Builds the graph from the code files' texts and the workspace manifests (`<dir>/package.json`
 * texts), with every tracked path in `files`.
 */
export function buildGraph(files: ReadonlySet<string>, texts: ReadonlyMap<string, string>, manifests: ReadonlyMap<string, string>): ImportGraph {
  const packages = new Map<string, PackageInfo>();
  // Every manifest by its directory, named or not: the scope of the `#` imports of the files below it.
  const scopes = new Map<string, Record<string, unknown>>();
  for (const [path, text] of manifests) {
    const parsed = parseJsonBytes(Buffer.from(text, "utf8"));
    if (!parsed.ok || !isJsonObject(parsed.value)) continue;
    scopes.set(posix.dirname(path), parsed.value);
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
      const resolved = spec.startsWith("#") ? resolveImports(files, packages, scopes, path, spec) : resolvePackage(files, packages, spec);
      if (resolved !== null && resolved.target !== path) {
        records.push({ target: resolved.target, statement, packageName: resolved.name, packageEntry: resolved.entry });
      }
    };
    for (const { spec, statement } of scanImports(text)) add(spec, statement);
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
  /** A record of another file reaches `path` through its package's entry when it names one of `path`'s exports. */
  const entryReach = (path: string): ((record: ImportRecord) => boolean) | null => {
    const pkg = packageOf(path);
    const text = texts.get(path);
    if (pkg === null || text === undefined) return null;
    const names = exportedNames(text);
    if (names.length === 0) return null;
    const nameRe = new RegExp(`\\b(?:${names.map((name) => name.replace(/\$/g, "\\$")).join("|")})\\b`);
    return (record) => record.packageName === pkg && record.packageEntry && nameRe.test(record.statement);
  };
  return {
    opaque: (path) => CODE_FILE_RE.test(path) && files.has(path) && !out.has(path),
    importsOf: (path) => sorted(new Set((out.get(path) ?? []).map((record) => record.target))),
    directImportersOf: (path) => sorted(importers.get(path) ?? []),
    importersOf: (path) => {
      const set = new Set(importers.get(path) ?? []);
      const reaches = entryReach(path);
      if (reaches !== null) {
        for (const [from, records] of out) {
          if (from === path) continue;
          if (records.some(reaches)) set.add(from);
        }
      }
      set.delete(path);
      return sorted(set);
    },
    importStatements: (from, target) => {
      if (from === target) return [];
      const reaches = entryReach(target);
      return (out.get(from) ?? []).filter((record) => record.target === target || (reaches !== null && reaches(record))).map((record) => record.statement);
    },
  };
}

const ENTRY_FIELDS = ["exports", "imports", "main", "module", "types", "typings", "browser", "bin"] as const;
/** Most `*` patterns a manifest's entries are matched by; past it the manifest names every path (fail closed). */
export const MAX_MANIFEST_PATTERNS = 32;

/** True for a package manifest's path. */
export function isManifestPath(path: string): boolean {
  return path === "package.json" || path.endsWith("/package.json");
}

/** A count of the steps the matchers and walks below take, for tests that bound their work without a clock. */
export interface WorkCounter {
  steps: number;
}

/**
 * The failure table of `part` for a Knuth-Morris-Pratt search: at each position, the length of the
 * longest proper prefix of `part` that ends there.
 */
function failureTable(part: string, work: WorkCounter): Uint32Array {
  const table = new Uint32Array(part.length);
  let k = 0;
  for (let i = 1; i < part.length; i++) {
    while (k > 0 && part[i] !== part[k]) {
      k = table[k - 1] ?? 0;
      work.steps++;
    }
    work.steps++;
    if (part[i] === part[k]) k++;
    table[i] = k;
  }
  return table;
}

/**
 * A matcher for a glob whose only special character is `*` (any text, `/` included), in time linear
 * in the pattern and the path, with no backtracking: the text before the first `*` must start the
 * path and the text after the last must end it, and each text between two `*` is found, in order,
 * by a Knuth-Morris-Pratt search from where the last one ended (the leftmost match of each is always
 * the one to take, so the search never goes back). `work`, when given, counts each comparison.
 */
export function starGlob(pattern: string, work: WorkCounter = { steps: 0 }): (path: string) => boolean {
  const parts = pattern.split("*");
  const prefix = parts[0] ?? "";
  if (parts.length === 1) {
    return (path) => {
      work.steps += 1;
      return path === pattern;
    };
  }
  const suffix = parts[parts.length - 1] ?? "";
  const middle = parts.slice(1, -1).filter((part) => part !== "");
  const tables = middle.map((part) => failureTable(part, work));
  return (path) => {
    work.steps += prefix.length + suffix.length + 1;
    if (path.length < prefix.length + suffix.length || !path.startsWith(prefix) || !path.endsWith(suffix)) return false;
    const end = path.length - suffix.length;
    let at = prefix.length;
    for (const [index, part] of middle.entries()) {
      const table = tables[index] ?? new Uint32Array(0);
      let k = 0;
      for (; at < end && k < part.length; at++) {
        while (k > 0 && path[at] !== part[k]) {
          k = table[k - 1] ?? 0;
          work.steps++;
        }
        work.steps++;
        if (path[at] === part[k]) k++;
      }
      if (k < part.length) return false;
    }
    return true;
  };
}

/**
 * Whether a path of `files` is one a package manifest at `manifestPath` names as an entry: a path in
 * its `exports` (every subpath and condition), `imports`, `main`, `module`, `types`, `typings`,
 * `browser` or `bin`, resolved as an import of it resolves, or a path one of its `*` patterns matches
 * (a `*` matches any text, `/` included, as Node's subpath patterns do; starGlob, in linear time).
 * Every value is read, however deeply its conditions nest (the JSON parser bounds the nesting). A
 * manifest with more than MAX_MANIFEST_PATTERNS patterns names every path. Nothing for a manifest that
 * is not a JSON object. `work`, when given, counts the steps of each match.
 */
export function manifestTargets(files: ReadonlySet<string>, manifestPath: string, text: string, work?: WorkCounter): (path: string) => boolean {
  const parsed = parseJsonBytes(Buffer.from(text, "utf8"));
  if (!parsed.ok || !isJsonObject(parsed.value)) return () => false;
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (work !== undefined) work.steps++;
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item);
    else if (isJsonObject(value)) for (const item of Object.values(value)) collect(item);
  };
  for (const field of ENTRY_FIELDS) collect(parsed.value[field]);
  const dir = posix.dirname(manifestPath);
  const named = new Set<string>();
  const patterns: Array<(path: string) => boolean> = [];
  for (const value of strings) {
    if (value === "" || value.length > MAX_MANIFEST_VALUE) continue;
    const spec = value.startsWith(".") ? value : `./${value}`;
    if (spec.includes("*")) {
      const joined = posix.normalize(posix.join(dir, spec));
      if (joined.startsWith("../") || joined.startsWith("/")) continue;
      if (patterns.length === MAX_MANIFEST_PATTERNS) return () => true;
      patterns.push(starGlob(joined, work));
      continue;
    }
    const resolved = resolveRelative(files, manifestPath, spec);
    if (resolved !== null) named.add(resolved);
  }
  return (path) => named.has(path) || patterns.some((matches) => matches(path));
}

/**
 * Every file reached from `starts` by following `next` from each file reached, `starts` included:
 * each file visited once (a cycle never loops), so the work is linear in the files and edges walked.
 * `opaque` is true when the walk met a code file whose imports the graph did not read.
 */
function walk(starts: Iterable<string>, next: (path: string) => readonly string[], isOpaque: (path: string) => boolean, work?: WorkCounter): { files: Set<string>; opaque: boolean } {
  const files = new Set<string>(starts);
  const queue = [...files];
  let opaque = false;
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index] ?? "";
    if (work !== undefined) work.steps++;
    if (isOpaque(path)) opaque = true;
    for (const target of next(path)) {
      if (work !== undefined) work.steps++;
      if (files.has(target)) continue;
      files.add(target);
      queue.push(target);
    }
  }
  return { files, opaque };
}

/** Every file `starts` reach through any chain of imports (importsOf), `starts` included; see walk. */
export function reachable(graph: Pick<ImportGraph, "importsOf" | "opaque">, starts: Iterable<string>, work?: WorkCounter): { files: Set<string>; opaque: boolean } {
  return walk(starts, (path) => graph.importsOf(path), (path) => graph.opaque(path), work);
}

/** Every file from which a chain of imports reaches one of `targets` (directImportersOf), `targets` included; see walk. */
export function reaching(graph: Pick<ImportGraph, "directImportersOf">, targets: Iterable<string>, work?: WorkCounter): Set<string> {
  return walk(targets, (path) => graph.directImportersOf(path), () => false, work).files;
}
