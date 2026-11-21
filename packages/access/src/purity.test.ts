// The engine is pure and browser-safe (spec 02 §8.1; ARCHITECTURE principle 14): its source
// imports nothing but its own relative .ts files (no node:*, no package), and never touches the
// clock, randomness, timers, the network, storage, the console or a host's globals. The
// typecheck also compiles it with neither Node's nor the DOM's types (tsconfig.engine.json).
// Tests and src/test-support may use Node; nothing else may import test-support.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const src = import.meta.dirname;
const isTest = (file: string) => file.endsWith(".test.ts");

function sourceFiles(): string[] {
  return readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.split("\\").join("/"))
    .filter((file) => !isTest(file) && !file.startsWith("test-support/"))
    .sort();
}

/** The code with comments and string contents blanked, so only code is searched. */
function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    const char = text[i] ?? "";
    if (two === "//") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      out += " ";
    } else if (char === '"' || char === "'" || char === "`") {
      out += char;
      i += 1;
      while (i < text.length && text[i] !== char) i += text[i] === "\\" ? 2 : 1;
      out += char;
      i += 1;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

const SPECIFIER =
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
const DYNAMIC = /\b(?:import|require)\s*\(/;
const FORBIDDEN = [
  /\bprocess\b/,
  /\bBuffer\b/,
  /\bglobalThis\b/,
  /\bwindow\b/,
  /\bdocument\b/,
  /\bnavigator\b/,
  /\b(?:local|session)Storage\b/,
  /\bfetch\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bset(?:Timeout|Interval|Immediate)\b/,
  /\bqueueMicrotask\b/,
  /\bconsole\b/,
  /\bcrypto\b/,
  /\bDate\b/,
  /\bperformance\b/,
  /\bMath\.random\b/,
  /\beval\b/,
  /\bnew\s+Function\b/,
];

describe("the engine's source", () => {
  const files = sourceFiles();

  it("is found", () => {
    expect(files).toContain("index.ts");
    expect(files).toContain("engine/giving.ts");
    expect(files).toContain("catalogue/dashboard/index.ts");
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)("%s imports only its own relative .ts files", (file) => {
    const text = readFileSync(join(src, file), "utf8");
    const specifiers = [...text.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? "");
    for (const specifier of specifiers) {
      expect(
        specifier.startsWith("./") || specifier.startsWith("../"),
        `${file}: ${specifier}`,
      ).toBe(true);
      expect(specifier.endsWith(".ts"), `${file}: ${specifier}`).toBe(true);
      expect(specifier.includes("test-support"), `${file}: ${specifier}`).toBe(false);
      const target = relative(src, join(src, file, "..", specifier));
      expect(target.startsWith(".."), `${file} reaches outside src: ${specifier}`).toBe(false);
    }
    expect(DYNAMIC.test(codeOnly(text)), `${file} loads code at run time`).toBe(false);
  });

  it.each(files)(
    "%s touches no clock, randomness, timer, network, storage or host global",
    (file) => {
      const code = codeOnly(readFileSync(join(src, file), "utf8"));
      for (const pattern of FORBIDDEN)
        expect(pattern.test(code), `${file}: ${pattern}`).toBe(false);
    },
  );

  it("blanks comments and strings before searching", () => {
    expect(codeOnly('const a = "Date"; // process\n/* window */ b')).toBe('const a = ""; \n  b');
  });
});
