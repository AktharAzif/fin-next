#!/usr/bin/env node
// imports:check (spec 01 §4.6; ARCHITECTURE §3.2; EXECUTION §1.5; spec 06 §11.5). The import rules
// Biome cannot express, and the ones it can, enforced again so a lint override cannot drop them:
//   - no bun:*, Bun.* or drizzle-orm/bun-sql, anywhere;
//   - node:http, node:https, node:net, node:dns, node:cluster and node:worker_threads only in
//     packages/server and apps/connector;
//   - no node:* import and no server package in any src/client/**, packages/ui, packages/tokens,
//     packages/icons, packages/motion, packages/frame or packages/app-contracts (FW-C12);
//   - only node:* and relative imports in ops/fin/src, tools/fin-review/src,
//     packages/web-host/src/static, tools/static-deploy/src and scripts/, and only relative
//     imports in ops/watcher/src (Web APIs only); their test files may also import vitest;
//   - a file under a control path (tools/layout.json's controlPaths) imports only node:* and
//     files under the control paths (type-only imports aside; a test may also import vitest and
//     any file of the repository, since a test does not change what the code does when it runs),
//     so an owner-approved file imports only owner-approved files (CI-14);
//   - code that runs imports no test file (a target is matched in any case, as a case-insensitive
//     file system reads it), since a test's own imports are not held to these rules, and no file
//     under a test/, tests/, __tests__/, e2e/ or fixtures/ directory (in any case too), which the
//     page policy below leaves out;
//   - a module specifier names its module plainly: no surrounding white space, control character,
//     backslash or percent-encoding (in a relative URL Node reads `%2e` as a dot and `\` as a
//     slash, and drops a tab), and no subpath import, `#name`, which stands for a module the rules
//     cannot see; on the Node side where every import must be read (below), a relative import
//     names a file the repository holds, a source file or JSON: require() runs a file of any
//     other extension as code (a source file is read whatever the case of its extension, so
//     `X.JS` is read too), and for a directory or a name that is no file it loads another one (a
//     package.json main, an index file, or the name with .js, .json or .node added);
//   - no @tanstack/react-start*, @tanstack/start-*, @remix-run/*, react-router-dom, Radix,
//     Phosphor, clsx, tailwind-merge or @fontsource*, anywhere (FW-C01, FW-C18, OD-5);
//   - @ui-sdk/* only inside packages/ui, so screens take their controls from @fin/ui; the refused
//     SDK entries and core's experimental helpers nowhere; @ui-sdk/core/testing in tests only;
//   - no console.error(error): errors go through reportError with safeError;
//   - the page policy, in code that runs anywhere (tests and fixtures aside): no markup parsed
//     from a string (React's inner-HTML prop, the DOM's members that parse HTML, document.write),
//     no style attribute written by script, no eval, Function constructor or string timer (spec 06
//     §6.2, §11.5), read in the whole text, comments and strings included, as written and with
//     every escape decoded, so no reading of the code's structure can hide one;
//   - Node built-ins by their node: name; relative imports with their file extension, .ts or
//     .tsx where the source is TypeScript.
// What it guarantees (BD-19). imports:check refuses the imports these rules forbid and, in the
// Node-side areas and the control paths (below), the plain spellings of loading or running code
// (static and dynamic import, require and require.resolve, createRequire, eval, Function, the
// process binding and getBuiltinModule, and the forms its tests list), so that honest code there
// stays readable and portable. It is a lint against mistakes, not a sandbox: deliberately
// obfuscated loading (a constructor reached by destructuring, `arguments`, `with`, a computed key
// built at run time, a trick on the lexer) cannot be excluded by a lexer, and is a review finding
// by definition, which fin-review's lenses treat as critical. The control-path approval rule
// returns in hardening (BD-02).
// How imports are read. Every `import` and `export` keyword is read as a statement, with comments
// wherever JavaScript allows them and every string escape and line continuation decoded, and so is
// every call of import(), require() and getBuiltinModule(), an optional call or an escaped name
// included. Where every import must be read, in the restricted areas above, client code and the
// control paths, such a call whose argument is not one string literal is refused; any use of
// getBuiltinModule but a direct call with one is refused everywhere. In the Node-side areas among
// them (all but client code) these spellings of loading or running code are refused as well:
// require other than called with one string literal (require.resolve, and require as a value or
// a destructured key, included; only an object-literal key whose value is one string, as in an
// exports-conditions map, is not a use), createRequire and node:module's other loaders, node:vm,
// node:repl, node:inspector and node:wasi, the process binding, dlopen, eval, the Function
// constructor, Reflect, the property-descriptor functions, `.constructor`, a computed member of a
// global object, a string that names a loader, and an `import` or `export` this check cannot read
// as one of JavaScript's forms. In code that runs, text in comments and strings is read as well,
// so an import-shaped string that breaks a rule is reported; in a test file, comments, strings,
// template text and regular expressions are skipped, since fixtures often hold import-shaped text,
// except in a JSX test file (.jsx, .tsx), which is read whole like code that runs: the lexer does
// not read JSX, whose text may hold a quote, a backtick or `/*` that is none of them. Outside the
// areas where every import must be read, a module name assembled at run time is beyond a static
// check.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { coveredBy, globToRegExp, isRecord, listFiles, readJson, report } from "./lib/repo.mjs";

/** @typedef {import("./lib/repo.mjs").Finding} Finding */
/**
 * @typedef {{ specifier: string, line: number, names: string[], dynamic: boolean,
 *   typeOnly: boolean, imported: string[], index: number, at: number }} ImportRef
 * `imported` holds the names the import binds from the module ("default", "*" for the whole
 * namespace, which a dynamic import gives); `index` is where its keyword or call starts and `at`
 * where its specifier does.
 */
/** @typedef {{ line: number, loader: string }} DynamicExpression */
/**
 * @typedef {{ type: "name" | "string" | "template" | "punct" | "regex" | "number" | "other",
 *   value: string, raw: string, start: number, afterDot?: boolean, closesKeywordParen?: boolean,
 *   closesBlock?: boolean }} Token
 */
/** @typedef {{ kind: "name" | "string" | "punct", value: string }} ClauseToken */

// Source files in any case: require() runs a file of an unknown extension (`X.JS`) as JavaScript.
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const TS_SOURCE = /\.(?:[cm]?ts|tsx)$/;
// What code in the Node-side areas may import by a relative path: a source file these rules read,
// or JSON. require() would run any other file as JavaScript (or load it as a native addon).
const LOADABLE = /\.(?:[cm]?[jt]s|[jt]sx|json)$/;
const TEST_FILE = /\.(?:db\.)?test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/;
// An import's target names a test file in any case (Unicode case folding, as a case-insensitive
// file system compares names): such a file system loads `x.test.ts` for `./x.TEST.ts`. A file
// counts as a test only when spelled as TEST_FILE has it, so one named in another case is held to
// every rule.
const TEST_TARGET = new RegExp(TEST_FILE.source, "iu");
const BUILTINS = new Set(
  builtinModules.filter((m) => !m.startsWith("_")).map((m) => m.replace(/^node:/, "")),
);
const NETWORK = new Set(["http", "https", "net", "dns", "cluster", "worker_threads"]);
const NETWORK_ALLOWED = ["packages/server/", "apps/connector/"];
// Built-ins that run code they are handed, refused in the Node-side areas that must read every
// import. node:module's loaders are refused there too; only these of its names may be imported.
const CODE_RUNNERS = new Set(["vm", "repl", "inspector", "wasi"]);
const MODULE_NAMES_ALLOWED = new Set(["builtinModules", "isBuiltin"]);
// Spec 06 §3.1: @fin/icons and @fin/motion ship to every browser through @fin/ui, @fin/frame and
// the screens, so they are client code like the rest (FW-C12).
const CLIENT_PACKAGES = [
  "packages/ui/",
  "packages/tokens/",
  "packages/icons/",
  "packages/motion/",
  "packages/frame/",
  "packages/app-contracts/",
];
const BUILTINS_ONLY = [
  "ops/fin/src/",
  "tools/fin-review/src/",
  "packages/web-host/src/static/",
  "tools/static-deploy/src/",
  "scripts/",
];
const RELATIVE_ONLY = ["ops/watcher/src/"];
const SERVER_PACKAGES = [
  "@fin/server",
  "@fin/web-host",
  "@fin/db",
  "@fin/crypto",
  "@fin/audit",
  "@fin/email",
  "@fin/testing",
  "@fin/identity",
  "@fin/orgs",
  "@fin/staff",
  "@fin/keys",
  "@fin/kyc",
  "@fin/money",
  "@fin/events",
  "hono",
  "@hono/*",
  "pg",
  "drizzle-orm",
  "@sentry/node",
  "wrangler",
];
const REFUSED = [
  "@tanstack/react-start",
  "@tanstack/react-start-*",
  "@tanstack/start-*",
  "@remix-run/*",
  "react-router-dom",
  "react-server-dom-*",
  "@vitejs/plugin-rsc",
  "@rsbuild/core",
  "@radix-ui/*",
  "radix-ui",
  "@phosphor-icons/*",
  "clsx",
  "tailwind-merge",
  "@fontsource*",
  "@fontsource*/*",
];
const SDK_REFUSED = [
  /^@ui-sdk\/[^/]+\/agent(?:\/|$)/,
  /^@ui-sdk\/react\/(?:preferences|token-input|label|timeline|segmented-control|rating|color-picker|image-cropper|waterfall)(?:\/|$)/,
  /^@ui-sdk\/core\/web\.css$/,
];
const SDK_CORE_REFUSED_NAMES = [
  "createGridFocus",
  "createVirtualizer",
  "createCellRange",
  "createLasso",
];

// The names of the loaders, built at run time like the test fixtures: a string that names a
// loader is refused in this file's own area, so this file holds none.
const words = (/** @type {string} */ list) => list.split(" ");
const GET_BUILTIN = ["getBuiltin", "Module"].join("");
const CREATE_REQUIRE = ["create", "Require"].join("");
const INTERNAL_LOADERS = words("_linkedBinding dlopen _load mainModule registerHooks");
// Other ways to load code that the rules cannot read, refused where every import must be read:
// the calls themselves, and the same names reached as a computed member with a string key. They
// are matched in the text as written and again with its escapes decoded.
const UNREAD_LOADERS = new RegExp(
  [
    String.raw`\b(?:${CREATE_REQUIRE}|_linkedBinding|dlopen|_load|eval)\s*\(`,
    String.raw`\bprocess\s*\??\.\s*binding\b`,
    String.raw`\bnew\s+Function\b`,
    String.raw`\[\s*(['"\x60])(?:${GET_BUILTIN}|${CREATE_REQUIRE}|binding|_linkedBinding|dlopen|_load|require|eval|Function|constructor|mainModule|register|registerHooks)\1\s*\]`,
  ].join("|"),
  "g",
);
// Names that load or run code, refused in the Node-side areas that must read every import,
// wherever they stand in code; a string literal naming one of the last group is refused there too.
const LOADER_NAMES = new Set([
  CREATE_REQUIRE,
  ...words(
    "eval Function Reflect getOwnPropertyDescriptor getOwnPropertyDescriptors getOwnPropertyNames",
  ),
  ...INTERNAL_LOADERS,
]);
const LOADER_STRINGS = new Set([GET_BUILTIN, CREATE_REQUIRE, ...INTERNAL_LOADERS]);
const LOADER_KEYS = new Set([
  ...LOADER_STRINGS,
  ...words("binding require eval Function constructor register"),
]);
// Objects whose members include loaders: a computed member of one is refused in those areas.
const GLOBAL_OBJECTS = new Set([
  "globalThis",
  "global",
  "process",
  "module",
  "require",
  "self",
  "window",
]);
// What may follow `export` when it re-exports nothing: a declaration, a local list, an assignment.
const EXPORT_DECLARATIONS = new Set([
  "const",
  "let",
  "var",
  "function",
  "async",
  "class",
  "default",
  "interface",
  "enum",
  "namespace",
  "module",
  "declare",
  "abstract",
  "type",
  "import",
  "as",
]);

// The page policy's refusals (spec 06 §6.2 and §11.5, FW-C18, AC-UI-01), in code that runs,
// wherever it is: markup parsed from a string (React's inner-HTML prop, the DOM's members that
// parse HTML, document.write), a style attribute written by script, and code built from a string
// (eval, the Function constructor, a string handed to setTimeout or setInterval). The whole text is
// read, comments, strings and regular expressions included, as written and again with every
// escape decoded (unescapeText): a reading of the code's structure can be led to take code for a
// string or a comment, so the policy trusts none, and a comment that names a sink is refused too.
// A computed member with a string key is read as well. Tests, their helpers and fixtures (files
// under test/, e2e/ or fixtures/) are left out, since a violation fixture plants one on purpose,
// and code that runs imports none of them (above); Biome's noDangerouslySetInnerHtml still covers
// their JSX. The sink names are built at run time and no pattern below reads as a call to what it
// refuses, so this file passes its own check.
const TEST_CODE = /(?:^|\/)(?:test|tests|__tests__|e2e|fixtures)\//;
// Code that runs imports nothing from those directories, matched in any case as TEST_TARGET is.
const TEST_CODE_TARGET = new RegExp(TEST_CODE.source, "iu");
const HTML_SINK_NAMES = [
  ["dangerously", "Set", "Inner", "HTML"],
  ["inner", "HTML"],
  ["outer", "HTML"],
  ["insertAdjacent", "HTML"],
  ["createContextual", "Fragment"],
  ["set", "HTML", "Unsafe"],
  ["parse", "HTML", "Unsafe"],
].map((parts) => parts.join(""));
const HTML_SINKS = HTML_SINK_NAMES.join("|");
const CODE_FROM_STRING = "no code is built from a string (eval, the Function constructor)";
/** @type {{ pattern: RegExp, message: string, codeFromString?: boolean }[]} */
const PAGE_POLICY = [
  {
    pattern: new RegExp(String.raw`(?<![\w$])(?:${HTML_SINKS})(?![\w$])`, "g"),
    message: `markup is never parsed from a string (${HTML_SINK_NAMES.slice(0, 2).join(", ")} and kin)`,
  },
  {
    pattern: /(?<![\w$])document\s*\??\.\s*write(?:ln)?\s*\(/g,
    message: "markup is never written from a string (document.write)",
  },
  {
    pattern: /(?<![\w$])setAttribute(?:NS)?\s*\(\s*(?:[^,()'"`]*,\s*)?(['"`])style\1/gi,
    message: "styles go through the CSSOM (React's style prop), never a style attribute",
  },
  {
    pattern: /(?<![\w$])(?:setTimeout|setInterval)\s*\(\s*['"`]/g,
    message: "setTimeout and setInterval take a function, never a string of code",
  },
  {
    pattern: new RegExp(
      [
        String.raw`(?<![\w$.])eval\s*\(`,
        String.raw`(?<![\w$])(?:globalThis|window|self)\s*\??\.\s*eval\s*\(`,
        String.raw`(?<![\w$])new\s+Function\b(?!\$)`,
        String.raw`(?<![\w$.])(?<!new\s+)Function\s*\(`,
        String.raw`(?<![\w$])(?:globalThis|window|self)\s*\??\.\s*Function\s*\(`,
      ].join("|"),
      "g",
    ),
    message: CODE_FROM_STRING,
    codeFromString: true,
  },
  {
    pattern: new RegExp(String.raw`\[\s*(['"\x60])(?:${HTML_SINKS})\1\s*\]`, "g"),
    message: "a refused sink reached by a string key is refused the same",
  },
  {
    pattern: /\[\s*(['"`])(?:eval|Function)\1\s*\]/g,
    message: "a refused sink reached by a string key is refused the same",
    codeFromString: true,
  },
];

/**
 * The package name of a bare specifier (`@scope/name` or `name`).
 * @param {string} specifier
 * @returns {string}
 */
export function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
}

/**
 * @param {string} name
 * @param {string[]} patterns exact names or globs
 * @returns {boolean}
 */
function matchesAny(name, patterns) {
  return patterns.some((p) => (p.includes("*") ? globToRegExp(p).test(name) : name === p));
}

/**
 * A function from a character offset to its 1-based line number.
 * @param {string} text
 * @returns {(index: number) => number}
 */
function lineFinder(text) {
  /** @type {number[]} */
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

// --- Reading JavaScript and TypeScript text ------------------------------------------------------

// JavaScript's white space and line terminators.
const SPACE =
  /[\t\v\f \u{A0}\u{1680}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}\u{FEFF}\n\r\u{2028}\u{2029}]/u;
const LINE_TERMINATOR = /[\n\r\u{2028}\u{2029}]/gu;
const ESCAPED = String.raw`\\u(?:[0-9A-Fa-f]{4}|\{[0-9A-Fa-f]+\})`;
const IDENTIFIER_SOURCE = String.raw`(?:[\p{ID_Start}$_]|${ESCAPED})(?:[\p{ID_Continue}$\u{200C}\u{200D}]|${ESCAPED})*`;
const IDENTIFIER = new RegExp(IDENTIFIER_SOURCE, "uy");
const IDENTIFIERS = new RegExp(IDENTIFIER_SOURCE, "gu");

/**
 * Where the line holding `from` ends.
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function lineEnd(text, from) {
  LINE_TERMINATOR.lastIndex = from;
  const match = LINE_TERMINATOR.exec(text);
  return match === null ? text.length : match.index;
}

/**
 * Skips white space and comments: block and line comments, and the HTML-like comments a CommonJS
 * script may hold (read as comments wherever they stand, which never hides code: where they are
 * not comments, they could not stand between the parts of an import).
 * @param {string} text
 * @param {number} from
 * @returns {number} the index of the next character that is neither
 */
export function skipTrivia(text, from) {
  let i = from;
  while (i < text.length) {
    if (SPACE.test(text.charAt(i))) i++;
    else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (
      text.startsWith("//", i) ||
      text.startsWith("<!--", i) ||
      text.startsWith("-->", i)
    ) {
      i = lineEnd(text, i);
    } else break;
  }
  return i;
}

const SIMPLE_ESCAPES = /** @type {Record<string, string>} */ ({
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
});
const HEX2 = /[0-9A-Fa-f]{2}/y;
const HEX4 = /[0-9A-Fa-f]{4}/y;
const BRACED = /\{([0-9A-Fa-f]+)\}/y;
const OCTAL = /[0-3][0-7]{0,2}|[4-7][0-7]?/y;

/**
 * Decodes one escape sequence in a string or template literal, as a sloppy-mode script reads it
 * (legacy octal escapes included, which a CommonJS file may use; a template refuses them).
 * @param {string} text
 * @param {number} at the backslash
 * @param {boolean} template
 * @returns {{ value: string, end: number } | undefined} undefined when the escape is invalid
 */
function readEscape(text, at, template) {
  const c = text.charAt(at + 1);
  if (c === "") return undefined;
  if (c === "\r") return { value: "", end: text.charAt(at + 2) === "\n" ? at + 3 : at + 2 };
  if (c === "\n" || c === "\u{2028}" || c === "\u{2029}") return { value: "", end: at + 2 };
  const simple = SIMPLE_ESCAPES[c];
  if (simple !== undefined) return { value: simple, end: at + 2 };
  if (c === "x") {
    HEX2.lastIndex = at + 2;
    const hex = HEX2.exec(text);
    return hex === null
      ? undefined
      : { value: String.fromCharCode(Number.parseInt(hex[0], 16)), end: at + 4 };
  }
  if (c === "u") {
    BRACED.lastIndex = at + 2;
    const braced = BRACED.exec(text);
    if (braced !== null) {
      const code = Number.parseInt(braced[1] ?? "", 16);
      return code > 0x10ffff
        ? undefined
        : { value: String.fromCodePoint(code), end: at + 2 + braced[0].length };
    }
    HEX4.lastIndex = at + 2;
    const hex = HEX4.exec(text);
    return hex === null
      ? undefined
      : { value: String.fromCharCode(Number.parseInt(hex[0], 16)), end: at + 6 };
  }
  if (c >= "0" && c <= "7") {
    const next = text.charAt(at + 2);
    if (c === "0" && !(next >= "0" && next <= "9")) return { value: "\0", end: at + 2 };
    if (template) return undefined;
    OCTAL.lastIndex = at + 1;
    const octal = OCTAL.exec(text)?.[0] ?? c;
    return { value: String.fromCharCode(Number.parseInt(octal, 8)), end: at + 1 + octal.length };
  }
  if (c === "8" || c === "9") return template ? undefined : { value: c, end: at + 2 };
  const char = String.fromCodePoint(text.codePointAt(at + 1) ?? 0);
  return { value: char, end: at + 1 + char.length };
}

/**
 * Reads a single- or double-quoted string literal, decoding its escapes.
 * @param {string} text
 * @param {number} at the opening quote
 * @returns {{ value: string, end: number } | undefined} undefined when it is not a complete,
 *   valid literal (a line ends it first, or an escape is invalid)
 */
export function readQuoted(text, at) {
  const quote = text.charAt(at);
  let value = "";
  let i = at + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === quote) return { value, end: i + 1 };
    if (ch === "\n" || ch === "\r") return undefined;
    if (ch === "\\") {
      const sequence = readEscape(text, i, false);
      if (sequence === undefined) return undefined;
      value += sequence.value;
      i = sequence.end;
    } else {
      value += ch;
      i++;
    }
  }
  return undefined;
}

/**
 * Reads a template literal from its opening backtick: its cooked text when it has no
 * substitution, or that it has one.
 * @param {string} text
 * @param {number} at the opening backtick
 * @returns {{ value: string, end: number, substitution: boolean } | undefined}
 */
function readTemplate(text, at) {
  let value = "";
  let i = at + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "`") return { value, end: i + 1, substitution: false };
    if (ch === "$" && text.charAt(i + 1) === "{") return { value, end: i + 2, substitution: true };
    if (ch === "\\") {
      const sequence = readEscape(text, i, true);
      if (sequence === undefined) return undefined;
      value += sequence.value;
      i = sequence.end;
    } else if (ch === "\r") {
      value += "\n"; // a template's text reads CR and CRLF as LF
      i += text.charAt(i + 1) === "\n" ? 2 : 1;
    } else {
      value += ch;
      i++;
    }
  }
  return undefined;
}

/**
 * Decodes the `\u` escapes of an identifier.
 * @param {string} raw
 * @returns {string}
 */
function decodeIdentifier(raw) {
  if (!raw.includes("\\")) return raw;
  return raw.replace(/\\u(?:\{([0-9A-Fa-f]+)\}|([0-9A-Fa-f]{4}))/g, (_, braced, hex) => {
    const code = Number.parseInt(braced ?? hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "\u{FFFD}";
  });
}

/**
 * Reads an identifier (or a keyword) at `at`, with its escapes decoded.
 * @param {string} text
 * @param {number} at
 * @returns {{ name: string, raw: string, end: number } | undefined}
 */
function readIdentifier(text, at) {
  IDENTIFIER.lastIndex = at;
  const match = IDENTIFIER.exec(text);
  if (match === null) return undefined;
  return { name: decodeIdentifier(match[0]), raw: match[0], end: at + match[0].length };
}

/**
 * The text with every escape decoded, as a string literal reads it (readEscape): `\u` and `\x`
 * escapes, legacy octal and one-letter escapes, any other character after a backslash as itself
 * (`"\H"` is "H"), and a backslash before a line break dropped with the break (a line
 * continuation); an escaped backslash stays one backslash. It is for the patterns that read the
 * text as written, so escapes are decoded wherever they stand, a regular expression's or a
 * comment's included (the patterns fail closed on them). `lineAt` gives, for a character of the
 * decoded text, the line of the source it comes from.
 * @param {string} text
 * @returns {{ text: string, lineAt: (index: number) => number }}
 */
export function unescapeText(text) {
  const sourceLine = lineFinder(text);
  if (!text.includes("\\")) return { text, lineAt: sourceLine };
  let out = "";
  /** @type {number[]} */
  const origin = []; // for each UTF-16 unit of `out`, where in `text` it comes from
  let i = 0;
  while (i < text.length) {
    const slash = text.indexOf("\\", i);
    const stop = slash < 0 ? text.length : slash;
    for (let k = i; k < stop; k++) origin.push(k);
    out += text.slice(i, stop);
    if (slash < 0) break;
    const sequence = readEscape(text, slash, false);
    const value = sequence === undefined ? "\\" : sequence.value;
    for (let k = 0; k < value.length; k++) origin.push(slash);
    out += value;
    i = sequence === undefined ? slash + 1 : sequence.end;
  }
  return { text: out, lineAt: (index) => sourceLine(origin[index] ?? text.length) };
}

// --- The lexer ------------------------------------------------------------------------------------

// After these words a `/` starts a regular expression; after any other name it divides.
const REGEX_AFTER_WORDS = new Set([
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
  "extends",
  "default", // export default /x/
]);
// After these words a `{` opens an object; after any other name it opens a block.
const OBJECT_AFTER_WORDS = new Set([
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
  "yield",
  "await",
  "default", // export default { ... }
]);
const PAREN_KEYWORDS = new Set(["if", "while", "for", "with"]);

/**
 * Splits JavaScript or TypeScript source into tokens, as far as the rules need: names (escapes
 * decoded), strings and substitution-free templates (decoded), numbers, regular expressions and
 * punctuators. Whether a `/` starts a regular expression is decided from the token before it, as
 * JavaScript tools commonly do. The mask marks which characters are code: not a comment, nor the
 * inside of a string, a template's text or a regular expression (a template's `${...}` is code).
 * A string ends at its quote or at the end of its line.
 * @param {string} text
 * @returns {{ tokens: Token[], mask: Uint8Array }}
 */
export function lex(text) {
  const mask = new Uint8Array(text.length).fill(1);
  /**
   * @param {number} from
   * @param {number} to
   */
  const clear = (from, to) => mask.fill(0, from, Math.min(to, text.length));
  /** @type {Token[]} */
  const tokens = [];
  /** @type {("block" | "object" | "template")[]} */
  const braces = [];
  /** @type {boolean[]} */
  const parens = [];
  /** @type {Token | undefined} */
  let prev;
  /** @param {Token} token */
  const push = (token) => {
    tokens.push(token);
    prev = token;
  };
  const regexAllowed = () => {
    if (prev === undefined) return true;
    if (prev.type === "name") return REGEX_AFTER_WORDS.has(prev.value) && !prev.afterDot;
    if (prev.type !== "punct") return false;
    if (prev.value === ")") return prev.closesKeywordParen === true;
    if (prev.value === "}") return prev.closesBlock === true;
    return !["]", "++", "--"].includes(prev.value);
  };
  const opensBlock = () => {
    if (prev === undefined) return true;
    if (prev.type === "name") return prev.afterDot === true || !OBJECT_AFTER_WORDS.has(prev.value);
    return prev.type === "punct" && [")", ";", "{", "}", "=>"].includes(prev.value);
  };
  /**
   * Reads template text from `from` up to its closing backtick or its next `${`.
   * @param {number} from the first character of the text
   * @param {boolean} head whether the text starts the template, just after its backtick
   * @returns {number} where code resumes
   */
  const templateText = (from, head) => {
    for (let j = from; j < text.length; j++) {
      const ch = text.charAt(j);
      if (ch === "\\") j++;
      else if (ch === "`") {
        clear(from, j);
        const whole = head ? readTemplate(text, from - 1) : undefined;
        const plain = whole !== undefined && !whole.substitution;
        push({
          type: plain ? "template" : "other",
          value: plain ? whole.value : "",
          raw: text.slice(from - 1, j + 1),
          start: from - 1,
        });
        return j + 1;
      } else if (ch === "$" && text.charAt(j + 1) === "{") {
        clear(from, j);
        braces.push("template");
        push({ type: "punct", value: "${", raw: "${", start: j });
        return j + 2;
      }
    }
    clear(from, text.length);
    return text.length;
  };
  let i = 0;
  if (text.startsWith("#!")) {
    i = lineEnd(text, 0);
    clear(0, i);
  }
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    const regexEnd = ch === "/" && regexAllowed() ? scanRegex(text, i) : undefined;
    if (SPACE.test(ch)) {
      i++;
    } else if (ch === "/" && next === "/") {
      const stop = lineEnd(text, i);
      clear(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      clear(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== ch && text.charAt(j) !== "\n") {
        j += text.charAt(j) === "\\" ? 2 : 1;
      }
      clear(i + 1, j);
      const literal = readQuoted(text, i);
      push({
        type: literal === undefined ? "other" : "string",
        value: literal?.value ?? "",
        raw: text.slice(i, j + 1),
        start: i,
      });
      i = j + 1;
    } else if (ch === "`") {
      i = templateText(i + 1, true);
    } else if (ch === "}" && braces[braces.length - 1] === "template") {
      braces.pop();
      i = templateText(i + 1, false);
    } else if (regexEnd !== undefined) {
      clear(i + 1, text.lastIndexOf("/", regexEnd - 1));
      push({ type: "regex", value: "", raw: text.slice(i, regexEnd), start: i });
      i = regexEnd;
    } else if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next))) {
      const number = /[0-9A-Za-z_.]*/y;
      number.lastIndex = i + 1;
      const end = i + 1 + (number.exec(text)?.[0].length ?? 0);
      push({ type: "number", value: text.slice(i, end), raw: text.slice(i, end), start: i });
      i = end;
    } else {
      const id = readIdentifier(text, i);
      if (id !== undefined) {
        const afterDot = prev?.type === "punct" && (prev.value === "." || prev.value === "?.");
        push({ type: "name", value: id.name, raw: id.raw, start: i, afterDot });
        i = id.end;
        continue;
      }
      let value = ch;
      if (ch === "?" && next === "." && !/[0-9]/.test(text.charAt(i + 2))) value = "?.";
      else if (ch === "=" && next === ">") value = "=>";
      else if ((ch === "+" || ch === "-") && next === ch) value = ch + ch;
      else if (ch === "." && next === "." && text.charAt(i + 2) === ".") value = "...";
      /** @type {Token} */
      const token = { type: "punct", value, raw: value, start: i };
      if (ch === "(") {
        parens.push(prev?.type === "name" && !prev.afterDot && PAREN_KEYWORDS.has(prev.value));
      } else if (ch === ")") {
        token.closesKeywordParen = parens.pop() === true;
      } else if (ch === "{") {
        braces.push(opensBlock() ? "block" : "object");
      } else if (ch === "}") {
        token.closesBlock = braces.pop() === "block";
      }
      push(token);
      i += value.length;
    }
  }
  return { tokens, mask };
}

/**
 * Where a regular expression literal that starts at `at` ends, or undefined when the line ends
 * first (so the `/` was not one).
 * @param {string} text
 * @param {number} at
 * @returns {number | undefined}
 */
function scanRegex(text, at) {
  let inClass = false;
  for (let j = at + 1; j < text.length; j++) {
    const c = text.charAt(j);
    if (c === "\n" || c === "\r" || c === "\u{2028}" || c === "\u{2029}") return undefined;
    if (c === "\\") j++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "/") {
      let end = j + 1;
      while (/[A-Za-z0-9_$]/.test(text.charAt(end))) end++;
      return end;
    }
  }
  return undefined;
}

/**
 * Which characters of a JavaScript or TypeScript source are code (see lex). It is used for test
 * files, to skip the import-shaped text their fixtures hold, and for the rules that read names in
 * code; in code that runs, the imports themselves are read everywhere.
 * @param {string} text
 * @returns {Uint8Array} 1 for code, 0 otherwise, per character
 */
export function codeMask(text) {
  return lex(text).mask;
}

// --- Finding imports --------------------------------------------------------------------------

/**
 * Reads the statement an `import` or `export` keyword starts, when it loads a module: a
 * side-effect import, or a clause (names, braces, commas, `*` and string names, with comments
 * anywhere) followed by `from` and the specifier.
 * @param {string} text
 * @param {number} end just past the keyword
 * @param {string} keyword
 * @returns {{ specifier: string, at: number, clause: ClauseToken[] } | undefined}
 */
function readStaticImport(text, end, keyword) {
  let i = skipTrivia(text, end);
  /** @type {ClauseToken[]} */
  const clause = [];
  const first = text.charAt(i);
  if (keyword === "import" && (first === "'" || first === '"')) {
    // A side-effect import. In text that is not code, as `["import", "x"]`, the quote after the
    // keyword closes a string instead; what it "opens" then starts with a separator or a space,
    // which no module Node can load does.
    const literal = readQuoted(text, i);
    if (literal !== undefined && /^[^\s,;:)\]}]/.test(literal.value)) {
      return { specifier: literal.value, at: i, clause };
    }
  }
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "'" || ch === '"') {
      const literal = readQuoted(text, i);
      if (literal === undefined) return undefined;
      clause.push({ kind: "string", value: literal.value });
      i = skipTrivia(text, literal.end);
    } else if (ch === "{" || ch === "}" || ch === "," || ch === "*") {
      clause.push({ kind: "punct", value: ch });
      i = skipTrivia(text, i + 1);
    } else {
      const id = readIdentifier(text, i);
      if (id === undefined) return undefined;
      i = skipTrivia(text, id.end);
      const quote = text.charAt(i);
      if (id.name === "from" && (quote === "'" || quote === '"')) {
        const literal = readQuoted(text, i);
        return literal === undefined ? undefined : { specifier: literal.value, at: i, clause };
      }
      clause.push({ kind: "name", value: id.name });
    }
  }
  return undefined;
}

/**
 * What an import or export clause binds, and whether the whole statement is type-only (erased
 * before it runs): exactly `type {...}`, `type * [as name]` or `type Name`. An inline `type` on
 * one name leaves the statement, and the module's loading, in place.
 * @param {ClauseToken[]} clause
 * @returns {{ typeOnly: boolean, imported: string[] }}
 */
function clauseBindings(clause) {
  const is = (/** @type {number} */ k, /** @type {string} */ value) =>
    clause[k]?.value === value && clause[k]?.kind !== "string";
  const isBinding = (/** @type {number} */ k) =>
    clause[k] !== undefined && clause[k]?.kind !== "punct";
  if (is(0, "type") && clause.length > 1) {
    const braces = clause.filter((t) => t.kind === "punct" && (t.value === "{" || t.value === "}"));
    if (is(1, "{") && braces.length === 2 && is(clause.length - 1, "}")) {
      return { typeOnly: true, imported: [] };
    }
    if (
      is(1, "*") &&
      (clause.length === 2 || (clause.length === 4 && is(2, "as") && isBinding(3)))
    ) {
      return { typeOnly: true, imported: [] };
    }
    if (clause.length === 2 && clause[1]?.kind === "name") return { typeOnly: true, imported: [] };
  }
  /** @type {string[]} */
  const imported = [];
  let k = 0;
  if (
    (is(0, "defer") || is(0, "source")) &&
    clause[1] !== undefined &&
    !is(1, ",") &&
    !is(1, "}")
  ) {
    k = 1; // a phase modifier, not a default binding
  }
  while (k < clause.length) {
    if (is(k, "*")) {
      imported.push("*");
      k += is(k + 1, "as") ? 3 : 1;
    } else if (is(k, "{")) {
      k++;
      while (k < clause.length && !is(k, "}")) {
        const typed = is(k, "type") && isBinding(k + 1) && !is(k + 1, "as");
        const name = clause[typed ? k + 1 : k];
        if (name !== undefined && name.kind !== "punct" && !typed) imported.push(name.value);
        while (k < clause.length && !is(k, ",") && !is(k, "}")) k++;
        if (is(k, ",")) k++;
      }
      k++;
    } else if (isBinding(k)) {
      imported.push("default");
      k++;
    } else {
      k++;
    }
  }
  return { typeOnly: false, imported };
}

/**
 * Reads a loader's call just past its name: `(` or `?.(`, then its first argument when that is
 * one string literal, or a template with no substitution, and nothing else.
 * @param {string} text
 * @param {number} end
 * @returns {{ call: boolean, literal?: string, empty?: boolean }}
 */
function readCall(text, end) {
  let i = skipTrivia(text, end);
  if (text.startsWith("?.", i)) i = skipTrivia(text, i + 2);
  if (text.charAt(i) !== "(") return { call: false };
  i = skipTrivia(text, i + 1);
  const ch = text.charAt(i);
  if (ch === ")") return { call: true, empty: true };
  /** @type {{ value: string, end: number } | undefined} */
  let literal;
  if (ch === "'" || ch === '"') literal = readQuoted(text, i);
  else if (ch === "`") {
    const template = readTemplate(text, i);
    if (template !== undefined && !template.substitution) literal = template;
  }
  if (literal === undefined) return { call: true };
  const after = text.charAt(skipTrivia(text, literal.end));
  return after === "," || after === ")" ? { call: true, literal: literal.value } : { call: true };
}

/**
 * Finds the import specifiers in a source file, with their line numbers: static imports and
 * re-exports, and import(), require() and getBuiltinModule() calls, wherever they stand.
 * @param {string} text
 * @param {Uint8Array} [mask] when given, only keywords and calls that stand in code (see lex)
 * @returns {{ imports: ImportRef[], dynamicExpressions: DynamicExpression[], statements: Set<number> }}
 *   `statements` holds where each keyword that starts a static import or re-export stands
 */
export function findImports(text, mask) {
  /** @type {Map<number, ImportRef>} */
  const byAt = new Map();
  /** @type {ImportRef[]} */
  const calls = [];
  /** @type {DynamicExpression[]} */
  const dynamicExpressions = [];
  /** @type {Set<number>} */
  const statements = new Set();
  const lineAt = lineFinder(text);
  for (const match of text.matchAll(IDENTIFIERS)) {
    const index = match.index;
    if (mask !== undefined && mask[index] !== 1) continue;
    const raw = match[0];
    const name = decodeIdentifier(raw);
    if (name !== "import" && name !== "export" && name !== "require" && name !== GET_BUILTIN) {
      continue;
    }
    const end = index + raw.length;
    const before = text.charAt(index - 1);
    // A keyword is never escaped, and one after a dot (a member) or a # (a private name) is a name.
    const startsStatement = before !== "." && before !== "#";
    if ((name === "import" || name === "export") && raw === name && startsStatement) {
      const found = readStaticImport(text, end, name);
      if (found !== undefined) {
        statements.add(index);
        const { typeOnly, imported } = clauseBindings(found.clause);
        const names = [
          ...found.clause.filter((t) => t.kind === "name").map((t) => t.value),
          ...found.clause.filter((t) => t.kind === "string").map((t) => t.value),
        ];
        const ref = {
          specifier: found.specifier,
          line: lineAt(index),
          names,
          dynamic: false,
          typeOnly,
          imported,
          index,
          at: found.at,
        };
        // Two keywords that reach one specifier (a clause read past its statement) give one
        // import, type-only only if both readings are, read from the keyword nearer to it.
        const seen = byAt.get(found.at);
        if (seen === undefined) byAt.set(found.at, ref);
        else {
          const nearer = ref.index > seen.index ? ref : seen;
          byAt.set(found.at, {
            ...nearer,
            typeOnly: seen.typeOnly && ref.typeOnly,
            imported: [...new Set([...seen.imported, ...ref.imported])],
            names: [...new Set([...seen.names, ...ref.names])],
          });
        }
      }
    }
    if (name === "export") continue;
    const call = readCall(text, end);
    if (!call.call) continue;
    const line = lineAt(index);
    if (call.literal !== undefined) {
      calls.push({
        specifier: call.literal,
        line,
        names: [],
        dynamic: true,
        typeOnly: false,
        imported: ["*"],
        index,
        at: index,
      });
    } else if (call.empty !== true) {
      // `import()` with nothing inside is prose, not code: the call would not parse.
      dynamicExpressions.push({ line, loader: name });
    }
  }
  const imports = [...byAt.values(), ...calls].sort((a, b) => a.index - b.index);
  return { imports, dynamicExpressions, statements };
}

// --- The rules --------------------------------------------------------------------------------

/**
 * The repository paths a relative specifier can name: with its query and fragment dropped, as an
 * ES module reads it, and whole, as require() reads `?` and `#` (as part of the file name).
 * @param {string} file
 * @param {string} specifier
 * @returns {string[]}
 */
function relativeTargets(file, specifier) {
  const dir = posix.dirname(file);
  return [
    ...new Set(
      [specifier.replace(/[?#].*$/, ""), specifier].map((s) =>
        posix.normalize(posix.join(dir, s)).replace(/\/+$/, ""),
      ),
    ),
  ];
}

/**
 * Checks one source file.
 * @param {string} file the repository path
 * @param {string} text the file's content
 * @param {(path: string) => boolean} [fileExists] for the .js-to-.ts check
 * @param {{ controlPaths?: string[], isFile?: (path: string) => boolean }} [options] the control
 *   paths of tools/layout.json, and whether a repository path is a regular file the repository
 *   lists. checkImports always passes `isFile`; with it, a relative import where every import must
 *   be read names such a file, and without it (one file checked alone) that is not checked.
 * @returns {Finding[]}
 */
export function checkSource(file, text, fileExists = () => false, options = {}) {
  /** @type {Finding[]} */
  const findings = [];
  /**
   * @param {number} line
   * @param {string} rule
   * @param {string} message
   */
  const add = (line, rule, message) => findings.push({ file, line, rule, message });
  const controlPaths = options.controlPaths ?? [];
  const isControlled = (/** @type {string} */ path) =>
    controlPaths.some((cp) => coveredBy(path, cp));
  const isTest = TEST_FILE.test(file);
  const isClient =
    /(^|\/)src\/client\//.test(file) || CLIENT_PACKAGES.some((p) => file.startsWith(p));
  const builtinsOnly = BUILTINS_ONLY.some((p) => file.startsWith(p));
  const relativeOnly = RELATIVE_ONLY.some((p) => file.startsWith(p));
  const controlled = isControlled(file);
  const mustReadAll = builtinsOnly || relativeOnly || isClient || controlled;
  // The Node-side areas whose every import must be read, where the plain spellings of loading or
  // running code are refused too (a lint against mistakes, not a sandbox: see the header).
  const loadsChecked = (builtinsOnly || relativeOnly || controlled) && !isTest;
  const { isFile } = options;
  const lexed = lex(text);
  // A test file's fixtures are skipped by the lexer's mask, except in JSX, which it does not read.
  const { imports, dynamicExpressions, statements } = findImports(
    text,
    isTest && !/\.[jt]sx$/i.test(file) ? lexed.mask : undefined,
  );
  const lineAt = lineFinder(text);
  // The text as written, and with its escapes decoded, for the rules that read the whole text.
  const unescaped = unescapeText(text);
  /** @type {[string, (index: number) => number][]} */
  const views =
    unescaped.text === text
      ? [[text, lineAt]]
      : [
          [text, lineAt],
          [unescaped.text, unescaped.lineAt],
        ];

  for (const { line, loader } of dynamicExpressions) {
    if (mustReadAll || loader === GET_BUILTIN) {
      add(
        line,
        "dynamic-import",
        `${loader}() takes one string literal here, so the rules can read what it loads`,
      );
    }
  }
  if (mustReadAll && !isTest) {
    /** @type {Set<number>} */
    const lines = new Set();
    for (const [view, viewLineAt] of views) {
      for (const match of view.matchAll(UNREAD_LOADERS)) lines.add(viewLineAt(match.index));
    }
    for (const line of [...lines].sort((a, b) => a - b)) {
      add(
        line,
        "dynamic-import",
        "code here loads modules only by import, so the rules can read every one (no module loader, process binding, eval or Function constructor)",
      );
    }
  }
  if (!isTest) checkCodeNames(lexed.tokens, statements, loadsChecked, lineAt, add);

  for (const ref of imports) {
    const { specifier, line, names, typeOnly, imported, dynamic } = ref;
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(specifier)?.[1]?.toLowerCase();
    if (scheme === "bun" || specifier === "bun" || specifier === "drizzle-orm/bun-sql") {
      add(line, "no-bun", "Node is the only runtime (ARCHITECTURE §3.2)");
      continue;
    }
    if (specifier.startsWith("/") || (scheme !== undefined && scheme !== "node")) {
      add(
        line,
        "absolute-import",
        "imports are relative, by package name or node:, never an absolute path or a URL (file:, data:, http:), whose own imports the rules could not read",
      );
      continue;
    }
    // What a URL parser strips or rewrites (white space at either end, tabs and line breaks,
    // control characters, `\` and percent-encoding) would let a specifier name another file.
    if (/^\s|\s$|[\\%\p{Cc}]/u.test(specifier) || specifier === "") {
      add(
        line,
        "specifier-form",
        "a module specifier names its module plainly: no surrounding white space, control character, backslash or percent-encoding",
      );
      continue;
    }
    if (specifier.startsWith("#")) {
      add(
        line,
        "subpath-import",
        "a subpath import, #name, stands for a module the rules cannot see; name that module itself",
      );
      continue;
    }
    const relative = /^\.\.?(?:\/|$)/.test(specifier);
    const bare = !relative && scheme === undefined;
    const first = specifier.split("/")[0] ?? "";
    const builtin =
      scheme === "node"
        ? (specifier.slice(5).split("/")[0] ?? "")
        : bare && BUILTINS.has(first)
          ? first
          : undefined;
    const name = bare && builtin === undefined ? packageName(specifier) : specifier;

    if (builtin !== undefined && scheme === undefined) {
      add(line, "node-prefix", `use node:${specifier}, so the built-in rules can see it`);
    }
    if (
      builtin !== undefined &&
      NETWORK.has(builtin) &&
      !NETWORK_ALLOWED.some((p) => file.startsWith(p))
    ) {
      add(
        line,
        "node-network",
        `node:${builtin} is allowed only in packages/server and apps/connector`,
      );
    }
    if (builtin !== undefined && isClient) {
      add(line, "client-node", "client code imports no node:* module (FW-C12)");
    }
    if (builtin !== undefined && loadsChecked) {
      const loaderNames =
        builtin === "module" &&
        (dynamic || imported.some((n) => !MODULE_NAMES_ALLOWED.has(n))) &&
        !typeOnly;
      if (CODE_RUNNERS.has(builtin) || loaderNames) {
        add(
          line,
          "dynamic-import",
          `node:${builtin}${builtin === "module" ? "'s loaders" : ""} would run code the rules cannot read; this code loads modules only by import`,
        );
      }
    }
    if (bare && builtin === undefined) {
      if (matchesAny(name, REFUSED))
        add(line, "refused-package", `${name} is refused (FW-C01, FW-C18, OD-5)`);
      if (isClient && matchesAny(name, SERVER_PACKAGES)) {
        add(
          line,
          "client-server-package",
          `client code depends on no server package (FW-C12): ${name}`,
        );
      }
      if (name.startsWith("@ui-sdk/")) {
        if (!file.startsWith("packages/ui/")) {
          add(
            line,
            "ui-sdk-outside-ui",
            "only packages/ui imports the UI SDK; screens import controls from @fin/ui",
          );
        }
        if (SDK_REFUSED.some((r) => r.test(specifier))) {
          add(
            line,
            "ui-sdk-refused-entry",
            "this UI SDK entry is refused everywhere (EX-30, spec 06 §11.5)",
          );
        }
        if (specifier === "@ui-sdk/core/testing" && !isTest) {
          add(line, "ui-sdk-testing", "@ui-sdk/core/testing is allowed in test files only");
        }
        if (name === "@ui-sdk/core" && names.some((n) => SDK_CORE_REFUSED_NAMES.includes(n))) {
          add(
            line,
            "ui-sdk-refused-entry",
            "core's experimental helpers are refused (EX-30, spec 06 §11.5)",
          );
        }
      }
    }
    const targets = relative ? relativeTargets(file, specifier) : [];
    if (
      !isTest &&
      (relative ? targets : [specifier.replace(/[?#].*$/, ""), specifier]).some((t) =>
        TEST_TARGET.test(t.replace(/\/+$/, "")),
      )
    ) {
      add(
        line,
        "test-file-import",
        "code that runs imports no test file: a test's own imports are not held to these rules",
      );
    } else if (
      !isTest &&
      !TEST_CODE.test(file) &&
      targets.some((t) => TEST_CODE_TARGET.test(`${t}/`))
    ) {
      add(
        line,
        "test-file-import",
        "code that runs imports nothing under test/, e2e/ or fixtures/, which the page policy leaves out",
      );
    }
    const testRunner = isTest && name === "vitest";
    if (relativeOnly && !relative) {
      add(line, "relative-only", "the watcher uses Web APIs and relative imports only");
    } else if (builtinsOnly && !relative && builtin === undefined && !testRunner) {
      add(
        line,
        "builtins-only",
        "this code runs with no install: node:* and relative imports only",
      );
    } else if (controlled && bare && builtin === undefined && !testRunner && !typeOnly) {
      add(
        line,
        "control-path-import",
        "a control-path file imports Node built-ins and control-path files only (CI-14)",
      );
    }
    if (
      controlled &&
      relative &&
      !typeOnly &&
      !isTest &&
      targets.some((target) => target === ".." || target.startsWith("../") || !isControlled(target))
    ) {
      add(
        line,
        "control-path-import",
        "a control-path file imports only files under the control paths, so a file outside them cannot change what it does (CI-14)",
      );
    }
    if (relative) {
      const last = specifier.split("/").pop() ?? "";
      const clean = last.replace(/[?#].*$/, "");
      if (!/\.[A-Za-z0-9]+$/.test(clean)) {
        add(
          line,
          "relative-extension",
          "a relative import names its file with the extension (.ts or .tsx)",
        );
      } else if (loadsChecked && (!LOADABLE.test(clean) || !LOADABLE.test(last))) {
        add(
          line,
          "relative-extension",
          "code here imports by a relative path only source files these rules read (.ts, .js, ...) and JSON: require() runs any other file as code",
        );
      } else if (TS_SOURCE.test(file) && /\.(?:m?js|jsx)$/.test(clean)) {
        const target = posix.join(posix.dirname(file), specifier.replace(/[?#].*$/, ""));
        const ts = target.replace(/\.(m?)js$/, ".$1ts").replace(/\.jsx$/, ".tsx");
        if (fileExists(ts))
          add(
            line,
            "relative-extension",
            "import the .ts source by its .ts name (rewriteRelativeImportExtensions)",
          );
      }
      // Every path the specifier can name (as an ES module and as require() read it) is a
      // regular file the repository lists, so the file the rules read is the file that loads.
      if (loadsChecked && isFile !== undefined && targets.some((target) => !isFile(target))) {
        add(
          line,
          "relative-target",
          "code here imports by a relative path only a file the repository holds: for a directory or a name that is no file, require() loads another file (a package.json main, an index file, or the name with .js, .json or .node added)",
        );
      }
    }
  }

  if (!isTest && !TEST_CODE.test(file)) {
    // A line the loader rules refused already for eval or the Function constructor is not
    // reported twice.
    const refusedLines = new Set(
      findings.filter((f) => f.rule === "dynamic-import").map((f) => f.line),
    );
    /** @type {Map<string, { line: number, message: string }>} */
    const found = new Map();
    for (const [view, viewLineAt] of views) {
      for (const { pattern, message, codeFromString } of PAGE_POLICY) {
        for (const match of view.matchAll(pattern)) {
          const line = viewLineAt(match.index);
          if (codeFromString === true && refusedLines.has(line)) continue;
          found.set(`${line}|${message}`, { line, message });
        }
      }
    }
    for (const { line, message } of [...found.values()].sort((a, b) => a.line - b.line)) {
      add(line, "page-policy", `${message} (spec 06 §6.2, FW-C18)`);
    }
  }

  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (/(?<![\w$.])Bun\.[A-Za-z]/.test(line))
      add(index + 1, "no-bun", "Node is the only runtime: no Bun.* (ARCHITECTURE §3.2)");
    if (/\bconsole\.error\(\s*(?:error|err|e)\s*[,)]/.test(line)) {
      add(
        index + 1,
        "console-error",
        "errors go through reportError with safeError, never straight to the console",
      );
    }
  }
  return findings;
}

/**
 * The rules that read names in code (a file that runs, never a test): any use of getBuiltinModule
 * but a direct call, everywhere; and in the Node-side areas that must read every import, the
 * plain spellings of loading or running code the header lists, and any `import` or `export` this
 * check cannot read.
 * @param {Token[]} tokens
 * @param {Set<number>} statements where the static imports and re-exports start
 * @param {boolean} loadsChecked
 * @param {(index: number) => number} lineAt
 * @param {(line: number, rule: string, message: string) => void} add
 */
function checkCodeNames(tokens, statements, loadsChecked, lineAt, add) {
  const punct = (/** @type {Token | undefined} */ t, /** @type {string} */ value) =>
    t?.type === "punct" && t.value === value;
  /** @param {number} k */
  const directCall = (k) =>
    punct(tokens[k + 1], "(") || (punct(tokens[k + 1], "?.") && punct(tokens[k + 2], "("));
  /**
   * Whether the name at `k` is an object literal's key whose whole value is one string or
   * template literal, as in an exports-conditions map (`{ import: "./x.js", require: "./x.cjs" }`).
   * A literal is never a binding, so this is no destructuring pattern; after `?` the name is a
   * conditional's value, and with any other value the lexer cannot tell an object from a pattern.
   * @param {number} k
   */
  const conditionKey = (k) => {
    const value = tokens[k + 2];
    return (
      (punct(tokens[k - 1], "{") || punct(tokens[k - 1], ",")) &&
      punct(tokens[k + 1], ":") &&
      (value?.type === "string" || value?.type === "template") &&
      (punct(tokens[k + 3], ",") || punct(tokens[k + 3], "}"))
    );
  };
  /** @type {Set<string>} */
  const reported = new Set();
  /**
   * @param {Token} token
   * @param {string} message
   * @param {string} [rule]
   */
  const refuse = (token, message, rule = "dynamic-import") => {
    const line = lineAt(token.start);
    if (reported.has(`${line}|${rule}|${message}`)) return;
    reported.add(`${line}|${rule}|${message}`);
    add(line, rule, message);
  };
  const loaderMessage = (/** @type {string} */ what) =>
    `code here loads modules only by import, so the rules can read every one: ${what} is refused`;
  for (const [k, token] of tokens.entries()) {
    const next = tokens[k + 1];
    if (token.type === "name") {
      if (token.value === GET_BUILTIN) {
        if (!directCall(k)) {
          refuse(
            token,
            `${GET_BUILTIN} is called directly, with one string literal, so the rules can read what it loads`,
          );
        }
        continue;
      }
      if (!loadsChecked) continue;
      const { value } = token;
      if (value === "require" && !directCall(k) && !conditionKey(k)) {
        refuse(token, loaderMessage("require other than called with one string literal"));
      } else if (LOADER_NAMES.has(value)) {
        refuse(token, loaderMessage(value));
      } else if (value === "constructor" && token.afterDot) {
        refuse(token, loaderMessage("a constructor reached as a member"));
      } else if (value === "binding" && token.afterDot && tokens[k - 2]?.value === "process") {
        refuse(token, loaderMessage("the process binding"));
      } else if (
        GLOBAL_OBJECTS.has(value) &&
        !token.afterDot &&
        (punct(next, "[") || (punct(next, "?.") && punct(tokens[k + 2], "[")))
      ) {
        refuse(token, loaderMessage(`a computed member of ${value}`));
      } else if ((value === "import" || value === "export") && token.raw === value) {
        if (token.afterDot || statements.has(token.start)) continue;
        const after = tokens[k + 2];
        const known =
          value === "import"
            ? punct(next, "(") ||
              punct(next, ".") ||
              punct(next, ":") ||
              punct(next, "=") ||
              (next?.type === "name" && punct(after, "=")) ||
              (next?.type === "name" && next.value === "type" && punct(tokens[k + 3], "="))
            : punct(next, "{") ||
              punct(next, ":") ||
              punct(next, "=") ||
              punct(next, "(") ||
              (next?.type === "name" && EXPORT_DECLARATIONS.has(next.value));
        if (!known) {
          refuse(
            token,
            `an ${value} this check cannot read; write it in one of JavaScript's import and export forms`,
            "unread-import",
          );
        }
      }
    } else if (loadsChecked && (token.type === "string" || token.type === "template")) {
      const computedKey = punct(tokens[k - 1], "[") && punct(next, "]");
      if (LOADER_STRINGS.has(token.value) || (computedKey && LOADER_KEYS.has(token.value))) {
        refuse(token, loaderMessage("a string naming a loader"));
      }
    }
  }
}

/**
 * The control paths tools/layout.json lists (none when it is missing or malformed; layout:check
 * reports that).
 * @param {string} root
 * @returns {string[]}
 */
function readControlPaths(root) {
  try {
    const layout = readJson(join(root, "tools/layout.json"));
    if (!isRecord(layout) || !Array.isArray(layout.controlPaths)) return [];
    return layout.controlPaths.filter((p) => typeof p === "string" && p !== "");
  } catch {
    return [];
  }
}

/**
 * Runs the import rules over every source file in the repository at `root`.
 * @param {string} root
 * @returns {Finding[]}
 */
export function checkImports(root) {
  const listed = new Set(listFiles(root, { untracked: true }));
  const files = [...listed].filter((f) => SOURCE.test(f));
  const known = new Set(files);
  const exists = (/** @type {string} */ path) => known.has(path) || existsSync(join(root, path));
  // A path the repository lists that is a regular file: not a directory (a submodule), and not a
  // symbolic link, whose target the listing does not show.
  const isFile = (/** @type {string} */ path) => {
    if (!listed.has(path)) return false;
    try {
      return lstatSync(join(root, path)).isFile();
    } catch {
      return false;
    }
  };
  const controlPaths = readControlPaths(root);
  return files.flatMap((file) =>
    checkSource(file, readFileSync(join(root, file), "utf8"), exists, { controlPaths, isFile }),
  );
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex > 0 ? (process.argv[rootIndex + 1] ?? ".") : process.cwd();
  process.exitCode = report("imports:check", checkImports(root));
}
