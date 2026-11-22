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
// (declaration files included) and every source file of the repository. With
// FIN_JSTOK_FULL_CORPUS=1 also the apps' real builds: every workspace package with a build script
// must have built JavaScript under its dist/, and a missing build fails the test (CI's build job
// runs it so after `pnpm build`). A large corpus is split into shards, each read by this same file
// run as a worker process (FIN_JSTOK_ORACLE_WORKER names its shard) with its own TypeScript.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
