// The tokenizer's differential: scripts/js-tokens.mjs against TypeScript's own parser.
//
// AN UNSTABLE, TEST-ONLY API. This test reads code through TypeScript 7.0.2's unstable API
// (typescript/unstable/sync for the parser, typescript/unstable/ast for its node kinds and its
// scanner), pinned to the catalog's exact 7.0.2. That API may change in any release: an upgrade
// that moves it shows here as a broken test, to be fixed with the upgrade. Only a test file under
// scripts/ or a control path may import these two specifiers, and nothing else from typescript
// (imports:check). Nothing that runs in production reads TypeScript; the tokenizer is
// dependency-free.
//
// The oracle. For every file of a corpus, TypeScript parses it natively (its extension decides
// the syntax, JSX included) and its tree gives where every string literal (a JSX attribute's
// included), template piece and regular expression starts and ends (JSDoc's nodes skipped: they
// stand inside comments); its scanner, run over the file and jumped past each of those literals
// and each JSX text, gives every comment. The tokenizer must agree exactly, kind and range, on
// all of them, and on every JSX text, which is never a string or a comment. A file TypeScript
// reports a syntax error in is compared all the same (its parser recovers); the tokenizer may
// refuse only such a file. The oracle checks itself as well: its scanner must land on the start
// of every literal it jumps.
//
// The corpora. Inside `pnpm check`: every JavaScript and TypeScript file under node_modules/.pnpm
// (declaration files included), every source file of the repository, and the shapes the
// tokenizer's reviews found it misreading (SHAPES below: minified bundles, `catch {`, `of` as a
// name, automatic semicolon insertion, `<` after a type), each of which TypeScript reads with no
// syntax error. With FIN_JSTOK_FULL_CORPUS=1 also the apps' real builds: every workspace package
// with a build script must have built JavaScript under its dist/, and a missing build fails the
// test. Run it after `pnpm build` as `FIN_JSTOK_FULL_CORPUS=1 pnpm run test:root` (or through
// `pnpm test` or `pnpm check`: turbo.json's root test task declares the variable, so it reaches
// the test, and is never cached, so a change anywhere reruns every corpus). No CI step runs it yet:
// that is the CI lane's build job, after its `pnpm build`. A large corpus is split into shards,
// each read by this same file run as a worker process (FIN_JSTOK_ORACLE_WORKER names its shard)
// with its own TypeScript.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createScanner, NodeFlags, SyntaxKind } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { TokenizeError, tokenize } from "../js-tokens.mjs";
import { listFiles } from "../lib/repo.mjs";
import { cleanUp, makeRepo, REPO_ROOT } from "./helpers.mjs";

/** The oracle's version: the catalog's exact TypeScript. */
const ORACLE_VERSION = "7.0.2";
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const BUILT = /\.[cm]?js$/;
const FULL = process.env.FIN_JSTOK_FULL_CORPUS === "1";
const WORKER = process.env.FIN_JSTOK_ORACLE_WORKER;
const MAX_SHARDS = 8;
const BYTES_PER_SHARD = 2_000_000;

/** @typedef {{ kind: string, start: number, end: number }} Range */

// The shapes the tokenizer's reviews found it misreading, as [file name, text]: each is valid, and
// TypeScript reads it with no syntax error, so the tokenizer must agree on every literal, comment
// and JSX text. Minified ones are what rolldown (Vite's minifier) makes of ordinary source.
/** @type {[string, string][]} */
const SHAPES = [
  // `catch {` with no binding opens a block, not an object literal.
  [
    "x.js",
    'export function f(a, b) {\n  try { return g(a) } catch { return /"/.test(a) && /"/.test(b) }\n}',
  ],
  [
    "x.tsx",
    "export function F() {\n  try { return g(); } catch { return <p>see http://example.com</p>\n  }\n}",
  ],
  ["x.js", "try { g(); } catch {}\n/\\.ts$/.test(name) && h();"],
  ["x.js", "function f() { try { a() } catch { throw /'/ } }"],
  ["x.js", "try{g()}catch{}/re/.test(s);"],
  ["x.ts", "function f(s: string) { try { g() } catch { return /re/.test(s) } }"],
  ["x.js", "function f(s) { try{g()}catch{if(s)/re/.test(s)} }"],
  [
    "x.js",
    'function f(a) {\n  try { g() } catch { return /"/.test(a) || fetch("//evil.example/x") }\n  /}/.test(a);\n}',
  ],
  [
    "Probe.tsx",
    "export function Probe({ load }: { load: () => string }) {\n  try {\n    return <p>{load()}</p>;\n  } catch {\n    return <p>See http://example.com/help</p>;\n  }\n}",
  ],
  [
    "x.js",
    "export function h(e,t){try{JSON.parse(e)}catch{log(1)}/'/.test(e)&&send(`https://third.example`),globalThis.ok=/'/.test(t)}",
  ],
  [
    "x.js",
    'export function safeParse(e){try{return JSON.parse(e)}catch{return/^\\s*"/.test(e)?`a string // not a comment`:null}}',
  ],
  // `of`, `keyof`, `yield` and `await` as names divide.
  [
    "x.js",
    'import { of } from "rxjs";\nexport const half = of / 2; const sep = "//"; fetch("https://third.example/x");',
  ],
  ["x.ts", "const keyof = 4;\nexport const q = keyof / 2 / 1;"],
  ["x.cjs", "var yield = 2, t = 1;\nz = yield / t / 1;"],
  ["x.js", 'var of = 1; var r = [of / 1, "evil.example", 1 / 1];'],
  ["x.js", 'const of=4;x=of/2;fetch("https:\\/\\/third.example");y=of/(2);'],
  ["x.js", "export const r=[];const of=7,t=[1];r.push(of/-t.length,`https:third-701.example`);"],
  ["x.js", 'for (var of = 0; of < n; of++) { s += "it\'s"; }'],
  ["x.js", "for (const of of /re/.exec(s)) {}"],
  ["x.js", "function f() { var yield = 6; return yield / 2 / 3; }"],
  [
    "x.js",
    "function* g() { function h() { var r = yield / 2 / 3; } var k = () => yield / 2 / 3; }",
  ],
  ["x.js", "class A { static { var r = yield / 2 / 3; } }"],
  [
    "x.js",
    "async function f() { function g() { var r = await / 2 / 3; } var h = () => await / 2 / 3; }",
  ],
  [
    "x.js",
    "async function f() { class A { x = await / 2 / 3; } var o = { m() { return await / 2 / 3; } }; }",
  ],
  ["x.js", "export class A { x = await / 2 / 3; }\nexport function f() { var r = await / 2 / 3; }"],
  [
    "x.js",
    "async function f() { var g = () => c ? 1 : await / 2 / 3; var k = function () { return await / 2 / 3; }; }",
  ],
  ["x.ts", "async function f() { class A { m?() { return await / 2 / 3; } } }"],
  ["x.ts", "export {};\nnamespace N { var r = await / 2 / 3; }"],
  ["x.js", "function f() { var r = async\nfunction g() { return await / 2 / 3; } }"],
  ["x.js", "function f() { var g = async\nx => await / 2 / 3; }"],
  ["x.js", "var o = { get a() { return await / 2 / 3; }, async *b() { yield /re/; } };"],
  ["x.ts", "class A { constructor(private a = await / 2 / 3) {} }"],
  [
    "x.js",
    "function* g() { var r = yield\n/re/.test(s); }\nasync function f() { var r = await\n/re/.test(s); }",
  ],
  ["x.js", "class A { static async *[Symbol.iterator]() { yield /re/; await /re/; } }"],
  ["x.js", "async function f() { var g = async x => await /re/; }"],
  ["x.ts", "for (const x: T of /re/.exec(s)) {}\nfor (const [a, b]: T of /re/.exec(s)) {}"],
  [
    "x.ts",
    "export {}\ndeclare global { var r = await / 2 / 3 }\nglobal\n{ var s = await / 2 / 3 }\ndeclare module 'm' { global { var t = await / 2 / 3 } }",
  ],
  ["x.js", "export {}\nglobal { var r = await / 2 / 3 }"],
  [
    "x.ts",
    "async function f() { namespace N { await /re/ } module M { await /re/ } }\nfunction* g() { namespace N { yield /re/ } }",
  ],
  [
    "x.js",
    "async function f() { var g = () => a\n~await /re/ }\nasync function h() { g = () => a\n.5, await /re/ }",
  ],
  [
    "x.ts",
    "async function f() { var a = 1\nx = 2, await /re/ }\nasync function g() { var b = () => a\n\u03c0, await /re/ }",
  ],
  // A line break after a statement that cannot go on starts the next one.
  ["x.js", 'import x from "y"\n/"/.test(x) || fetch("https://evil.example")\n'],
  [
    "x.js",
    "var x\n/re/.test(y)\nlet z\n/re/.test(q)\nvar a, b\n/re/.test(q)\nvar [c]\n/re/.test(q)\nvar {d}\n/re/.test(q)",
  ],
  ["x.js", "a: for (;;) { break a\n/re/.test(y) }\nb: for (;;) { continue b\n/re/.test(y) }"],
  ["x.js", 'import "a"\n/re/.test(q)\nimport b from "a" with { type: "json" }\n/re/.test(q)'],
  [
    "x.js",
    'import x from "a"\nwith { type: "json" }\n/re/.test(q)\nimport { a }\nfrom "b"\n/re/.test(q)',
  ],
  [
    "x.js",
    'export * from "x"\n/re/.test(q)\nexport { a } from "b"\n/re/.test(q)\nexport { c }\nfrom "b"\n/re/.test(q)',
  ],
  [
    "x.js",
    'export { a as "b c" } from "d"\n/re/.test(q)\nimport x, { y } from "z"\n/re/.test(q)\nexport * as ns from "x"\n/re/.test(q)',
  ],
  ["x.ts", "declare function f()\n/re/.test(q)\ndeclare var a\n/re/.test(q)"],
  ["x.ts", 'declare module "m"\n/re/.test(q)'],
  ["x.ts", 'import a = require("a")\n/re/.test(q)\nimport b = a.c\n/re/.test(q)'],
  ["x.ts", "export as namespace a\n/re/.test(q)"],
  ["x.ts", "import a = b\n.c\n/re/.test(q)\nimport d = e /* c */\n.f\n.g\n/re/.test(q)"],
  [
    "x.ts",
    'import type { A } from "a"\n/re/.test(q)\nexport type * from "a"\n/re/.test(q)\nexport type { B }\n/re/.test(q)',
  ],
  ["x.tsx", "let v\n<p>it's Bob's</p>"],
  ["x.js", "var x\n(a)\n/ 2 / 3\nvar y\n= 1\n/ 2 / 3\nvar z = 1\n/ 2 / 3"],
  [
    "x.ts",
    "let x\n: number = 1\n/ 2 / 3\nfunction f(a: string)\nfunction f(a) { return /re/ }\n/re/.test(q)",
  ],
  ["x.js", 'export { a }\nfoo("x", {})\n/ 2 / 3\nx = from\n/ 2 / 3\nmodule\n/ 2 / 3'],
  // `<` after a type that is no type reference is the less-than operator.
  ["x.ts", "const ok = n as number < 5 && m > /re/.exec(s).length;"],
  [
    "x.ts",
    'const a = n as T[] < 5;\nif (x as number < y) { z = "s" }\nconst b = n as number << 5 / 2 / 1;',
  ],
  ["x.tsx", "const x = count as number < 5 && <i>it's Bob's</i>;"],
  ["x.ts", "const a = x as 'lit' < 5, b = x as {} < 5, c = x as (A) < 5, d = x as `t` < 5;"],
  ["x.ts", "const a = x as this < 5, b = x as unknown < 5, c = x as void < 5, d = x as null < 5;"],
  [
    "x.ts",
    "const a = x as true < 5, b = x as -1 < 5, c = x as unique symbol < 5, d = x satisfies boolean < 5;",
  ],
  [
    "x.ts",
    "const a = x as Array<string>;\n/re/.test(q)\nconst b = x as typeof y<string>;\n/re/.test(q)",
  ],
  ["x.ts", "const a = x as import('m').T<string>;\n/re/.test(q)\nconst b = x as A.B<C> / 2 / 1;"],
  [
    "x.ts",
    "const a = x as A.string<C> / 2 / 1, b = x as A.void<C> / 2 / 1, c = x as typeof A.number<C> / 2 / 1;",
  ],
  [
    "x.ts",
    "function f() { const g = async <T,>(x: T) => await /re/; const h = async <T>(x: T): Promise<T> => await /re/; }",
  ],
  ["x.ts", "const async = 1; const r = async < b && c > /re/.exec(s);"],
];

const LITERAL = new Map([
  [SyntaxKind.StringLiteral, "string"],
  [SyntaxKind.NoSubstitutionTemplateLiteral, "template"],
  [SyntaxKind.TemplateHead, "template-head"],
  [SyntaxKind.TemplateMiddle, "template-middle"],
  [SyntaxKind.TemplateTail, "template-tail"],
  [SyntaxKind.RegularExpressionLiteral, "regex"],
]);
const COMPARED = new Set([
  "hashbang",
  "line-comment",
  "block-comment",
  "string",
  "template",
  "template-head",
  "template-middle",
  "template-tail",
  "regex",
  "jsx-text",
]);

/**
 * Every file under `dir` whose name matches `pattern`, as absolute paths; symbolic links are not
 * followed (pnpm links every package from node_modules/.pnpm, which is walked itself).
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function walk(dir, pattern) {
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const stack = [dir];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      const path = join(next, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && pattern.test(entry.name)) found.push(path);
    }
  }
  return found.sort();
}

/** Every JavaScript and TypeScript file installed under node_modules/.pnpm. */
function nodeModules() {
  const store = join(REPO_ROOT, "node_modules", ".pnpm");
  assert.ok(existsSync(store), "node_modules/.pnpm is missing: run pnpm install first");
  return walk(store, SOURCE);
}

/** Every JavaScript and TypeScript source file of the repository (tracked, or new and not ignored). */
function repositorySources() {
  const files = listFiles(REPO_ROOT, { untracked: true }).filter((f) => SOURCE.test(f));
  return files.map((f) => join(REPO_ROOT, f));
}

/**
 * The workspace packages under `root`: the directories pnpm-workspace.yaml's `packages` globs
 * name (each a fixed path or one `*` segment, as the repository writes them).
 * @param {string} root
 * @returns {string[]} paths relative to `root`
 */
function workspacePackages(root) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const block = /^packages:\n((?:[ \t]+-[^\n]*\n)+)/m.exec(yaml)?.[1] ?? "";
  const globs = [...block.matchAll(/-\s*['"]?([^'"\s#]+)/g)].map((m) => m[1] ?? "");
  assert.ok(globs.length > 0, "pnpm-workspace.yaml lists no packages");
  return globs.flatMap((glob) => {
    if (!glob.endsWith("/*")) return [glob];
    const parent = glob.slice(0, -2);
    const dir = join(root, parent);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${parent}/${e.name}`)
      .sort();
  });
}

/**
 * The apps' real builds under `root`: the JavaScript under dist/ of every workspace package with
 * a build script. Fails when no package has a build script, or when one has no built JavaScript
 * (a build that did not run is never skipped silently).
 * @param {string} root
 * @returns {{ files: string[], packages: string[] }}
 */
function builds(root) {
  /** @type {string[]} */
  const packages = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const paths = [];
  for (const pkg of workspacePackages(root)) {
    const manifest = join(root, pkg, "package.json");
    if (!existsSync(manifest)) continue;
    const scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
    if (typeof scripts.build !== "string") continue;
    packages.push(pkg);
    const dist = join(root, pkg, "dist");
    const built = existsSync(dist) && lstatSync(dist).isDirectory() ? walk(dist, BUILT) : [];
    if (built.length === 0) missing.push(pkg);
    paths.push(...built);
  }
  assert.ok(
    packages.length > 0,
    "FIN_JSTOK_FULL_CORPUS=1 reads the apps' builds, and no workspace package has a build script",
  );
  assert.deepEqual(
    missing,
    [],
    `FIN_JSTOK_FULL_CORPUS=1 reads every build: these packages have a build script and no built JavaScript under dist/ (run pnpm build first): ${missing.join(", ")}`,
  );
  return { files: paths, packages };
}

/**
 * What the oracle reads in one parsed file: its literals, JSX texts, comments and hashbang, and
 * whether its scanner lost its place (the oracle is then broken, not the tokenizer).
 * @param {import("typescript/unstable/ast").SourceFile} sf
 * @param {ReturnType<typeof createScanner>} scanner
 * @returns {{ ranges: Range[], lost: number[] }}
 */
function oracleRanges(sf, scanner) {
  /** @type {Range[]} */
  const ranges = [];
  /** @type {[number, number][]} */
  const jumps = [];
  /** @param {import("typescript/unstable/ast").Node} node */
  const visit = (node) => {
    const kind = node.kind;
    if (
      (node.flags & (NodeFlags.JSDoc | NodeFlags.Reparsed)) !== 0 ||
      (kind >= SyntaxKind.FirstJSDocNode && kind <= SyntaxKind.LastJSDocNode)
    ) {
      return;
    }
    const literal = LITERAL.get(kind);
    if (literal !== undefined) {
      const start = node.getStart(sf);
      ranges.push({ kind: literal, start, end: node.end });
      jumps.push([start, node.end]);
    } else if (kind === SyntaxKind.JsxText) {
      if (node.end > node.pos) ranges.push({ kind: "jsx-text", start: node.pos, end: node.end });
      jumps.push([node.pos, node.end]);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  jumps.sort((a, b) => a[0] - b[0]);
  const text = sf.text;
  scanner.setLanguageVariant(sf.languageVariant);
  scanner.setText(text);
  /** @type {Set<number>} */
  const reached = new Set();
  let k = 0;
  for (;;) {
    const token = scanner.scan();
    if (token === SyntaxKind.EndOfFile) break;
    const start = scanner.getTokenStart();
    while (k < jumps.length && (jumps[k]?.[1] ?? 0) <= start) k++;
    const jump = jumps[k];
    if (jump !== undefined && jump[0] <= start) {
      if (jump[0] === start) reached.add(start);
      scanner.resetTokenState(jump[1]);
      continue;
    }
    if (token === SyntaxKind.SingleLineCommentTrivia) {
      ranges.push({ kind: "line-comment", start, end: scanner.getTokenEnd() });
    } else if (token === SyntaxKind.MultiLineCommentTrivia) {
      ranges.push({ kind: "block-comment", start, end: scanner.getTokenEnd() });
    } else if (token === SyntaxKind.Unknown && start === 0 && text.startsWith("#!")) {
      ranges.push({ kind: "hashbang", start, end: scanner.getTokenEnd() });
    }
  }
  const lost = jumps.filter(([s, e]) => e > s && !reached.has(s)).map(([s]) => s);
  return { ranges: ranges.sort((a, b) => a.start - b.start), lost };
}

/**
 * The tokenizer's reading of one file, in the oracle's terms.
 * @param {string} text
 * @param {string} name
 * @returns {Range[] | TokenizeError}
 */
function tokenizerRanges(text, name) {
  try {
    return tokenize(text, name)
      .filter((t) => COMPARED.has(t.kind))
      .map((t) => ({ kind: t.kind, start: t.start, end: t.end }));
  } catch (error) {
    if (error instanceof TokenizeError) return error;
    throw error;
  }
}

/**
 * @param {string} text
 * @param {number} at
 */
function lineOf(text, at) {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < at; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/**
 * Runs the differential over a corpus, returning the disagreements (at most a few per file) and
 * how much was compared. TypeScript reads the files itself; the tokenizer reads the text
 * TypeScript read (a byte-order mark dropped, as TypeScript drops it), named by the file's path.
 * @param {string[]} corpus absolute paths
 * @returns {{ disagreements: string[], files: number, ranges: number, chars: number }}
 */
function differential(corpus) {
  const dir = mkdtempSync(join(tmpdir(), "fin-jstok-oracle-"));
  const config = join(dir, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        noLib: true,
        noResolve: true,
        types: [],
        target: "esnext",
        module: "esnext",
        jsx: "preserve",
      },
      files: corpus,
    }),
  );
  /** @type {string[]} */
  const disagreements = [];
  let ranges = 0;
  let chars = 0;
  const api = new API({ cwd: dir });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    assert.ok(project !== undefined, "the oracle opened no project");
    /** @type {Set<string>} */
    const syntaxErrors = new Set();
    for (const diagnostic of project.program.getSyntacticDiagnostics()) {
      if (diagnostic.fileName !== undefined) syntaxErrors.add(diagnostic.fileName);
    }
    const scanner = createScanner(false);
    for (const [i, file] of corpus.entries()) {
      // The oracle's trees are cached per file; dropping them bounds the memory a large corpus
      // takes.
      if (i % 500 === 499) api.clearSourceFileCache();
      const where = file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;
      const sf = project.program.getSourceFile(file);
      assert.ok(sf !== undefined, `the oracle has no source file for ${where}`);
      const text = sf.text;
      chars += text.length;
      const mine = tokenizerRanges(text, file);
      // A file TypeScript reports a syntax error in is compared all the same (its parser recovers,
      // and a tokenizer does not see a missing function body); a file both refuse agrees.
      const note = syntaxErrors.has(sf.fileName)
        ? " (TypeScript reports a syntax error in it)"
        : "";
      if (mine instanceof TokenizeError) {
        if (note === "") {
          disagreements.push(
            `${where}:${mine.line}:${mine.column}: the tokenizer refused it: ${mine.reason}`,
          );
        }
        continue;
      }
      const oracle = oracleRanges(sf, scanner);
      for (const at of oracle.lost.slice(0, 3)) {
        disagreements.push(`${where}:${lineOf(text, at)}: the oracle's scanner lost its place`);
      }
      ranges += oracle.ranges.length;
      let shown = 0;
      const length = Math.max(oracle.ranges.length, mine.length);
      for (let k = 0; k < length && shown < 3; k++) {
        const want = oracle.ranges[k];
        const got = mine[k];
        if (want?.kind === got?.kind && want?.start === got?.start && want?.end === got?.end) {
          continue;
        }
        const at = Math.min(want?.start ?? text.length, got?.start ?? text.length);
        disagreements.push(
          `${where}:${lineOf(text, at)}: TypeScript reads ${show(text, want)}, the tokenizer ${show(text, got)}${note}`,
        );
        shown++;
      }
    }
  } finally {
    api.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { disagreements, files: corpus.length, ranges, chars };
}

/**
 * @param {string} text
 * @param {Range | undefined} range
 */
function show(text, range) {
  if (range === undefined) return "nothing";
  const slice = text.slice(range.start, Math.min(range.end, range.start + 40));
  return `${range.kind} ${JSON.stringify(slice)} at ${range.start}-${range.end}`;
}

/**
 * Splits a corpus into shards of about equal size (largest file first, each to the lightest
 * shard): one per processor, at most MAX_SHARDS, and none smaller than BYTES_PER_SHARD.
 * @param {string[]} corpus
 * @returns {string[][]}
 */
function shards(corpus) {
  const sized = corpus.map((file) => ({ file, size: statSync(file).size }));
  const total = sized.reduce((sum, { size }) => sum + size, 0);
  const count = Math.max(
    1,
    Math.min(
      MAX_SHARDS,
      availableParallelism(),
      corpus.length,
      Math.floor(total / BYTES_PER_SHARD),
    ),
  );
  /** @type {{ files: string[], size: number }[]} */
  const parts = Array.from({ length: count }, () => ({ files: [], size: 0 }));
  sized.sort((a, b) => b.size - a.size);
  for (const { file, size } of sized) {
    let lightest = parts[0];
    for (const part of parts)
      if (lightest === undefined || part.size < lightest.size) lightest = part;
    if (lightest === undefined) break;
    lightest.files.push(file);
    lightest.size += size;
  }
  return parts.map((part) => part.files);
}

/**
 * Runs one shard's differential in a worker process: this file, with FIN_JSTOK_ORACLE_WORKER
 * naming the shard. A worker that fails fails the test.
 * @param {string} dir
 * @param {number} index
 * @param {string[]} files
 * @returns {Promise<ReturnType<typeof differential>>}
 */
function worker(dir, index, files) {
  const input = join(dir, `shard-${index}.json`);
  const output = join(dir, `result-${index}.json`);
  writeFileSync(input, JSON.stringify({ files, output }));
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, FIN_JSTOK_ORACLE_WORKER: input };
  // A worker is no test process of node --test's: it reports through its output file only.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`oracle shard ${index} exited with ${code}: ${stderr}`));
      else resolve(JSON.parse(readFileSync(output, "utf8")));
    });
  });
}

/**
 * Runs the differential over a corpus, in shards, and fails on any disagreement.
 * @param {import("node:test").TestContext} t
 * @param {string} label
 * @param {string[]} corpus
 */
async function check(t, label, corpus) {
  assert.ok(corpus.length > 0, `${label}: the corpus is empty`);
  const started = performance.now();
  const parts = shards(corpus);
  const dir = mkdtempSync(join(tmpdir(), "fin-jstok-shards-"));
  /** @type {ReturnType<typeof differential>[]} */
  let results;
  try {
    results = await Promise.all(parts.map((files, index) => worker(dir, index, files)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const disagreements = results.flatMap((r) => r.disagreements).sort();
  const sum = (/** @type {"files" | "ranges" | "chars"} */ key) =>
    results.reduce((total, r) => total + r[key], 0);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  t.diagnostic(
    `${label}: ${sum("files")} files, ${sum("chars")} characters, ${sum("ranges")} literals, comments and JSX texts compared in ${seconds}s (${parts.length} shard(s)); ${disagreements.length} disagreement(s)`,
  );
  assert.equal(sum("files"), corpus.length, `${label}: a shard skipped files`);
  assert.deepEqual(
    disagreements.slice(0, 50),
    [],
    `${label}: the tokenizer and TypeScript disagree`,
  );
}

if (WORKER !== undefined) {
  // A worker: one shard's differential, written to the file the shard names.
  const { files, output } = JSON.parse(readFileSync(WORKER, "utf8"));
  writeFileSync(output, JSON.stringify(differential(files)));
} else {
  describe("the tokenizer against TypeScript's parser (an unstable, test-only API, pinned to 7.0.2)", () => {
    test("the oracle is the catalog's exact TypeScript", () => {
      const installed = JSON.parse(
        readFileSync(join(REPO_ROOT, "node_modules", "typescript", "package.json"), "utf8"),
      ).version;
      assert.equal(
        installed,
        ORACLE_VERSION,
        "the installed TypeScript is not the oracle's version",
      );
      const catalog = /^ {2}typescript: (\S+)$/m.exec(
        readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"),
      )?.[1];
      assert.equal(catalog, ORACLE_VERSION, "the catalog's TypeScript is not the oracle's version");
    });

    test("differential: node_modules", async (t) => {
      await check(t, "node_modules", nodeModules());
    });

    test("differential: the repository's own sources", async (t) => {
      await check(t, "repository sources", repositorySources());
    });

    test("differential: the shapes the reviews found", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "fin-jstok-shapes-"));
      try {
        const files = SHAPES.map(([name, text], i) => {
          const sub = join(dir, String(i));
          mkdirSync(sub);
          const file = join(sub, name);
          writeFileSync(file, text);
          return file;
        });
        await check(t, "shapes", files);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("FIN_JSTOK_FULL_CORPUS reaches the test through pnpm test and pnpm check, and nothing replays an old result", () => {
      // Turborepo passes a task only the variables it declares: without the declaration the
      // builds differential would skip silently. A cached result would replay a comparison of
      // files that have changed since (the test reads every source file and every build).
      const turbo = JSON.parse(readFileSync(join(REPO_ROOT, "turbo.json"), "utf8"));
      const task = turbo.tasks?.["//#test:root"];
      assert.ok(task !== undefined, "turbo.json has no //#test:root task");
      assert.ok(
        Array.isArray(task.env) && task.env.includes("FIN_JSTOK_FULL_CORPUS"),
        "turbo.json's //#test:root does not declare FIN_JSTOK_FULL_CORPUS in env",
      );
      assert.equal(task.cache, false, "turbo.json's //#test:root may be cached");
      const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts;
      assert.equal(scripts["test:root"], 'node --test "scripts/test/*.test.mjs"');
      for (const name of ["test", "check"]) {
        assert.match(scripts[name], /turbo run [^&]*\btest:root\b/, `pnpm ${name} runs test:root`);
      }
    });

    test("differential: the apps' real builds (FIN_JSTOK_FULL_CORPUS=1; a missing build fails)", {
      skip: FULL ? false : "set FIN_JSTOK_FULL_CORPUS=1 after pnpm build to read the apps' builds",
    }, async (t) => {
      const { files, packages } = builds(REPO_ROOT);
      t.diagnostic(`builds of ${packages.length} package(s): ${packages.join(", ")}`);
      await check(t, "builds", files);
    });

    describe("the full corpus's builds", () => {
      after(cleanUp);
      const workspace = "packages:\n  - apps/*\n  - ops/fin\n";
      const manifest = (/** @type {boolean} */ build) =>
        JSON.stringify({ name: "x", private: true, scripts: build ? { build: "vite build" } : {} });

      test("every package with a build script gives its built JavaScript", () => {
        const dir = makeRepo({
          "pnpm-workspace.yaml": workspace,
          "apps/a/package.json": manifest(true),
          "apps/a/dist/static/assets/index.js": "x();\n",
          "apps/a/dist/server/main.mjs": "y();\n",
          "apps/a/dist/static/index.html": "<p></p>\n",
          "apps/b/package.json": manifest(false),
          "ops/fin/package.json": manifest(false),
        });
        const { files, packages } = builds(dir);
        assert.deepEqual(packages, ["apps/a"]);
        assert.deepEqual(
          files.map((f) => f.slice(dir.length + 1)),
          ["apps/a/dist/server/main.mjs", "apps/a/dist/static/assets/index.js"],
        );
      });

      test("with FIN_JSTOK_FULL_CORPUS=1, missing build output fails the test, never a silent skip", () => {
        const dir = makeRepo({
          "pnpm-workspace.yaml": workspace,
          "apps/a/package.json": manifest(true),
          "apps/a/dist/index.js": "x();\n",
          "apps/c/package.json": manifest(true),
          "apps/d/package.json": manifest(true),
          "apps/d/dist/index.html": "<p></p>\n",
        });
        assert.throws(
          () => builds(dir),
          /no built JavaScript under dist\/ \(run pnpm build first\): apps\/c, apps\/d\n/,
        );
      });

      test("with FIN_JSTOK_FULL_CORPUS=1, a workspace with no package that builds fails the test", () => {
        const dir = makeRepo({
          "pnpm-workspace.yaml": workspace,
          "apps/b/package.json": manifest(false),
        });
        assert.throws(() => builds(dir), /no workspace package has a build script/);
      });
    });
  });
}
