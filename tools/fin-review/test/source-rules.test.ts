// Rules on the engine's own source (spec 07 §2.1; T-RV-20 and T-RV-45's import clause):
// src/** imports only node:* and relative .ts files, starts programs only through spawn with
// shell: false, and nothing at module scope reads the clock, makes randomness or starts a timer.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { TOOL_ROOT } from "./helpers/cli.ts";

const SRC = join(TOOL_ROOT, "src");

function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

/**
 * Static imports and re-exports (`import x from "m"`, `import {a} from"m"`, `export * from "m"`),
 * side-effect imports (`import "m"`) and dynamic imports with a literal (`import("m")`).
 */
const IMPORT_RE =
  /(?:^|[\n;])\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
/** Any dynamic import, literal or not: each must be one IMPORT_RE reads. */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/g;

/** The import specifiers `text` names, and the dynamic imports it makes with no literal. */
function importsIn(text: string): { specifiers: string[]; opaque: number } {
  const specifiers = [...text.matchAll(IMPORT_RE)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
  const literal = [...text.matchAll(/\bimport\s*\(\s*["'][^"']+["']\s*\)/g)].length;
  const dynamic = [...text.matchAll(DYNAMIC_IMPORT_RE)].length;
  return { specifiers, opaque: dynamic - literal };
}

function allowedSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:") || (/^\.\.?\//.test(specifier) && specifier.endsWith(".ts"));
}

/**
 * Loads `files` in a fresh process and records every module specifier Node resolves for them, so
 * an import the text scan misses is still caught. A specifier that is neither node:* nor a file
 * is answered with an empty module, so a planted one does not stop the load.
 */
function resolvedImports(files: readonly string[]): Array<{ specifier: string; parent: string }> {
  const script = `
    import { registerHooks } from "node:module";
    import { pathToFileURL } from "node:url";
    const seen = [];
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL !== undefined && !context.parentURL.startsWith("data:")) seen.push({ specifier, parent: context.parentURL });
        if (!specifier.startsWith("node:") && !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:")) {
          return { url: "data:text/javascript,export default {}; export const a = 1;", shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    for (const file of process.argv.slice(1)) await import(pathToFileURL(file).href);
    process.stdout.write(JSON.stringify(seen.filter((entry) => !entry.parent.endsWith("/[eval1]"))));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, ...files], {
    shell: false,
    timeout: 30_000,
    env: { PATH: process.env["PATH"] ?? "" },
  });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  return JSON.parse(result.stdout.toString("utf8")) as Array<{ specifier: string; parent: string }>;
}

/** Imports `files` in a fresh process with the clock, randomness and timers trapped. */
function moduleScopeCalls(files: readonly string[]): string[] {
  const script = `
    import { syncBuiltinESMExports } from "node:module";
    import nodeCrypto from "node:crypto";
    import timers from "node:timers";
    import { pathToFileURL } from "node:url";
    const calls = [];
    const record = (name, value) => (...args) => { calls.push(name); return value; };
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { calls.push("new Date"); super(...args); }
      static now() { calls.push("Date.now"); return 0; }
    };
    Math.random = record("Math.random", 0);
    for (const name of ["setTimeout", "setInterval", "setImmediate"]) {
      globalThis[name] = record(name, 0);
      timers[name] = record(name, 0);
    }
    performance.now = record("performance.now", 0);
    const trap = (target, name, label) => {
      Object.defineProperty(target, name, { value: record(label, undefined), configurable: true, writable: true });
    };
    // node:crypto's getRandomValues cannot be redefined; it is web crypto's, trapped below.
    for (const name of ["randomBytes", "randomUUID", "randomInt", "randomFillSync", "randomFill"]) {
      trap(nodeCrypto, name, "crypto." + name);
    }
    trap(globalThis.crypto, "getRandomValues", "crypto.getRandomValues");
    trap(globalThis.crypto, "randomUUID", "crypto.randomUUID");
    syncBuiltinESMExports();
    for (const file of process.argv.slice(1)) await import(pathToFileURL(file).href);
    process.stdout.write(JSON.stringify(calls));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, ...files], {
    shell: false,
    timeout: 30_000,
    env: { PATH: process.env["PATH"] ?? "" },
  });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  return JSON.parse(result.stdout.toString("utf8")) as string[];
}

describe("the engine's source", () => {
  const files = sourceFiles();

  it("has the files this pull request delivers", () => {
    const names = files.map((file) => relative(SRC, file));
    for (const expected of [
      "main.ts",
      "cli.ts",
      "options.ts",
      "roles.ts",
      "plan/plan.ts",
      "plan/tiers.ts",
      "plan/ci-map.ts",
    ]) {
      assert.ok(names.includes(expected), expected);
    }
  });

  it("imports only node:* built-ins and relative .ts files", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const { specifiers, opaque } = importsIn(text);
      for (const specifier of specifiers)
        assert.ok(allowedSpecifier(specifier), `${relative(TOOL_ROOT, file)} imports ${specifier}`);
      assert.equal(
        opaque,
        0,
        `${relative(TOOL_ROOT, file)} has a dynamic import whose module is not written out`,
      );
      assert.doesNotMatch(text, /\brequire\(|\bcreateRequire\b/, relative(TOOL_ROOT, file));
    }
    for (const { specifier, parent } of resolvedImports(files)) {
      assert.ok(
        allowedSpecifier(specifier),
        `${relative(TOOL_ROOT, fileURLToPath(parent))} loads ${specifier}`,
      );
    }
  });

  it("the import checks catch side-effect imports, imports with no space and dynamic imports", () => {
    const planted = [
      'import "left-pad";',
      'import {a} from"left-pad";',
      "import x from 'left-pad'",
      'export * from"left-pad";',
      'export { a } from "left-pad";',
      'const m = await import("left-pad");',
    ];
    for (const text of planted) assert.deepEqual(importsIn(text).specifiers, ["left-pad"], text);
    assert.equal(importsIn("const m = await import(name);").opaque, 1);
    assert.deepEqual(importsIn('import { a } from "./a.ts";\nimport "node:fs";').specifiers, [
      "./a.ts",
      "node:fs",
    ]);
    const tmp = mkdtempSync(join(tmpdir(), "fin-review-imports-"));
    try {
      const file = join(tmp, "planted.mjs");
      writeFileSync(
        file,
        'import "left-pad";\nimport {a} from"right-pad";\nexport * from"./other.mjs";\n',
      );
      writeFileSync(join(tmp, "other.mjs"), "export const b = 1;\n");
      assert.deepEqual(
        resolvedImports([file])
          .map((entry) => entry.specifier)
          .filter(
            (specifier) => specifier !== `file://${file}` && !specifier.endsWith("planted.mjs"),
          ),
        ["left-pad", "right-pad", "./other.mjs"],
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("starts programs only with spawn, shell: false, through exec.ts", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const name = relative(SRC, file);
      assert.doesNotMatch(
        text,
        /(?<![.\w])(?:exec|execSync|execFileSync|spawnSync|fork)\s*\(/,
        name,
      );
      assert.doesNotMatch(text, /shell:\s*true/, name);
      // node:child_process in any form (a namespace import, a side-effect import, a dynamic one)
      // is exec.ts's alone, and there only spawn.
      if (importsIn(text).specifiers.includes("node:child_process")) {
        assert.equal(
          name,
          "exec.ts",
          `${name} imports node:child_process; programs start through exec.ts`,
        );
        const named = [
          ...text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']node:child_process["']/g),
        ];
        assert.deepEqual(
          named.filter((match) => match[1] === undefined).map((match) => (match[2] ?? "").trim()),
          ["spawn"],
          "exec.ts imports spawn and nothing else",
        );
        assert.match(text, /shell:\s*false/);
      }
      if (/\bspawn\s*\(/.test(text))
        assert.equal(name, "exec.ts", `${name} calls spawn; programs start through exec.ts`);
    }
    const loaders = resolvedImports(files)
      .filter(({ specifier }) => specifier === "node:child_process")
      .map(({ parent }) => relative(SRC, fileURLToPath(parent)));
    assert.deepEqual([...new Set(loaders)], ["exec.ts"]);
  });

  it("does not read the clock, make randomness or start a timer when imported", () => {
    assert.deepEqual(moduleScopeCalls(files), []);
  });

  it("the probe itself catches a clock read, a random value and a timer at module scope", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fin-review-probe-"));
    try {
      const planted = join(tmp, "planted.mjs");
      writeFileSync(
        planted,
        "export const t = Date.now(); export const r = Math.random(); setTimeout(() => {}, 1);\n",
      );
      assert.deepEqual(moduleScopeCalls([planted]), ["Date.now", "Math.random", "setTimeout"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
