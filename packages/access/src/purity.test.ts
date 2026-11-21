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

// Words before which a "/" starts a regular expression, not a division.
const BEFORE_AN_EXPRESSION = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * The code with comments, string and template text and regular expressions blanked, so only code
 * is searched; the code inside a template's `${...}` is kept, nested templates and braces
 * included. It throws on a comment, string, template or regular expression it cannot close, so a
 * misreading fails the test instead of passing code by.
 */
function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  // The last significant token, to tell a regular expression from a division: "word" (a name, a
  // number, or a literal's end), a keyword before an expression, or a punctuator.
  let prev = "";
  let depth = 0;
  const opens: number[] = []; // for each `${` still open, the brace depth outside it
  const unclosed = (what: string, from: number): never => {
    throw new Error(`${what} at offset ${from} is not closed`);
  };
  // Template text from i up to the closing "`" or the next "${".
  const templateText = (from: number): void => {
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        out += "`";
        i += 1;
        prev = "word";
        return;
      } else if (c === "$" && text[i + 1] === "{") {
        out += "${";
        i += 2;
        opens.push(depth);
        depth += 1;
        prev = "{";
        return;
      } else {
        i += 1;
      }
    }
    unclosed("a template", from);
  };
  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) unclosed("a comment", i);
      out += " ";
      i = end + 2;
    } else if (c === '"' || c === "'") {
      const from = i;
      i += 1;
      while (text[i] !== c) {
        if (i >= text.length || text[i] === "\n") unclosed("a string", from);
        i += text[i] === "\\" ? 2 : 1;
      }
      i += 1;
      out += c + c;
      prev = "word";
    } else if (c === "`") {
      out += "`";
      i += 1;
      templateText(i - 1);
    } else if (c === "/" && !["word", ")", "]"].includes(prev)) {
      const from = i;
      let inClass = false;
      for (i += 1; ; i += 1) {
        const r = text[i];
        if (r === undefined || r === "\n") unclosed("a regular expression", from);
        if (r === "\\") i += 1;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
      }
      i += 1;
      while (/[a-z]/i.test(text[i] ?? "")) i += 1;
      out += "/ /";
      prev = "word";
    } else if (c === "}" && opens.at(-1) === depth - 1) {
      opens.pop();
      depth -= 1;
      out += "}";
      i += 1;
      templateText(i - 1);
    } else if (/[\w$]/.test(c)) {
      const word = /^[\w$]+/.exec(text.slice(i))?.[0] ?? c;
      out += word;
      i += word.length;
      prev = BEFORE_AN_EXPRESSION.has(word) ? "keyword" : "word";
    } else if ((c === "+" || c === "-") && next === c) {
      out += c + c; // ++ and --: a division may follow (x++ / 2)
      i += 2;
      prev = "word";
    } else {
      if (c === "{") depth += 1;
      if (c === "}") depth -= 1;
      if (!/\s/.test(c)) prev = c;
      out += c;
      i += 1;
    }
  }
  if (opens.length > 0) unclosed("a template's ${", text.length);
  return out;
}

const SPECIFIER =
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
const DYNAMIC = /\b(?:import|require)\s*\(/;
const FORBIDDEN = [
  // The host and its globals.
  /\bprocess\b/,
  /\bBuffer\b/,
  /\bglobalThis\b/,
  /\bglobal\b/,
  /\bself\b/,
  /\bwindow\b/,
  /\bdocument\b/,
  /\bnavigator\b/,
  /\bimport\s*\.\s*meta\b/,
  // Storage, the network and messages.
  /\b(?:local|session)Storage\b/,
  /\bindexedDB\b/,
  /\bcaches\b/,
  /\bfetch\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bpostMessage\b/,
  // Timers and the event loop.
  /\bset(?:Timeout|Interval|Immediate)\b/,
  /\bqueueMicrotask\b/,
  /\brequest(?:AnimationFrame|IdleCallback)\b/,
  // The clock, randomness and the collector.
  /\bDate\b/,
  /\bTemporal\b/,
  /\bIntl\b/,
  /\bperformance\b/,
  /\bMath\s*\.\s*random\b/,
  /\bcrypto\b/,
  /\bWeakRef\b/,
  /\bFinalizationRegistry\b/,
  // The console, and code made at run time.
  /\bconsole\b/,
  /\beval\b/,
  /\bFunction\b/,
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

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the scanner's fixtures are source text holding templates
describe("the purity scanner", () => {
  it("reads the code inside a template's interpolations", () => {
    const stamp =
      "export const stamp = (): string => `${Date.now()}:${Math.random()}:${globalThis.constructor.name}`;";
    const code = codeOnly(stamp);
    for (const pattern of [/\bDate\b/, /\bMath\s*\.\s*random\b/, /\bglobalThis\b/]) {
      expect(pattern.test(code), String(pattern)).toBe(true);
    }
    expect(codeOnly("`a${`b${process.env}c`}d`")).toContain("process"); // a nested template
    expect(codeOnly("`${ { a: 1 }.a } ${Math.random()}`")).toContain("Math.random"); // braces
    expect(codeOnly("`${'}'}${Date.now()}`")).toContain("Date"); // a brace in a string inside
    expect(codeOnly("`x` + `${a}` + Date.now()")).toContain("Date"); // after the template ends
  });

  it("blanks a template's own text", () => {
    expect(codeOnly("`Date ${1} process`")).toBe("`${1}`");
    expect(codeOnly("`a\\`Date`")).toBe("``");
  });

  it("reads a regular expression as one literal, quotes and slashes included", () => {
    expect(codeOnly("const r = /[\"']/; Date.now();")).toContain("Date.now");
    expect(codeOnly("const r = /[/]/g; Date.now();")).toContain("Date.now");
    expect(codeOnly("const r = /\\//; Date.now();")).toContain("Date.now");
    expect(codeOnly("if (/Date/.test(x)) y();")).not.toContain("Date");
    expect(codeOnly("return /x/.test(Date)")).toContain("Date");
  });

  it("tells a division from a regular expression", () => {
    expect(codeOnly("const half = total / 2 / Date.now();")).toContain("Date.now");
    expect(codeOnly("const q = (a) / Date.now() / 2;")).toContain("Date.now");
    expect(codeOnly("const q = a[0] / Date.now() / 2;")).toContain("Date.now");
    expect(codeOnly("x++ / Date.now() / 2")).toContain("Date.now");
    expect(codeOnly('const q = "a".length / Date.now() / 2;')).toContain("Date.now");
  });

  it("refuses what it cannot close, so it never passes code by", () => {
    expect(() => codeOnly('const a = "open')).toThrow("a string");
    expect(() => codeOnly('const a = "open\nDate.now()"')).toThrow("a string");
    expect(() => codeOnly("const a = `open ${b}")).toThrow("a template");
    expect(() => codeOnly("const a = `${b")).toThrow("a template's ${");
    expect(() => codeOnly("/* open")).toThrow("a comment");
    expect(() => codeOnly("x = /open\nDate.now() /")).toThrow("a regular expression");
  });
});
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: the fixtures end here
