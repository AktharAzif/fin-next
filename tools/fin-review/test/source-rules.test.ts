// Rules on the engine's own source (spec 07 §2.1; T-RV-20 and T-RV-45's import clause):
// src/** imports only node:* and relative .ts files, starts programs only through spawn with
// shell: false, and nothing at module scope reads the clock, makes randomness or starts a timer.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
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

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

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
    for (const expected of ["main.ts", "cli.ts", "options.ts", "roles.ts", "plan/plan.ts", "plan/tiers.ts", "plan/ci-map.ts"]) {
      assert.ok(names.includes(expected), expected);
    }
  });

  it("imports only node:* built-ins and relative .ts files", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(IMPORT_RE)) {
        const specifier = match[1] ?? match[2] ?? "";
        const ok = specifier.startsWith("node:") || (/^\.\.?\//.test(specifier) && specifier.endsWith(".ts"));
        assert.ok(ok, `${relative(TOOL_ROOT, file)} imports ${specifier}`);
      }
      assert.doesNotMatch(text, /\brequire\(/, relative(TOOL_ROOT, file));
    }
  });

  it("starts programs only with spawn, shell: false, through exec.ts", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const name = relative(SRC, file);
      assert.doesNotMatch(text, /(?<![.\w])(?:exec|execSync|execFileSync|spawnSync|fork)\s*\(/, name);
      assert.doesNotMatch(text, /shell:\s*true/, name);
      if (/\bspawn\s*\(/.test(text)) {
        assert.equal(name, "exec.ts", `${name} calls spawn; programs start through exec.ts`);
        assert.match(text, /shell:\s*false/);
      }
    }
  });

  it("does not read the clock, make randomness or start a timer when imported", () => {
    assert.deepEqual(moduleScopeCalls(files), []);
  });

  it("the probe itself catches a clock read, a random value and a timer at module scope", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fin-review-probe-"));
    try {
      const planted = join(tmp, "planted.mjs");
      writeFileSync(planted, "export const t = Date.now(); export const r = Math.random(); setTimeout(() => {}, 1);\n");
      assert.deepEqual(moduleScopeCalls([planted]), ["Date.now", "Math.random", "setTimeout"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
