// The shared tokenizer (scripts/js-tokens.mjs): every case its design names, pinned by name.
// Fixtures are plain strings; a keyword the import rules read is built at run time.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JavaScript source text, in which `${` is a template substitution
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { syntaxOf, TokenizeError, tokenize } from "../js-tokens.mjs";

const EXP = ["exp", "ort"].join("");
const BS = "\\";

/**
 * Each token as `kind:text`.
 * @param {string} src
 * @param {string} [file]
 */
const read = (src, file = "x.js") =>
  tokenize(src, file).map((t) => `${t.kind}:${src.slice(t.start, t.end)}`);
/**
 * The literal, comment and JSX-text tokens, as `kind:text`.
 * @param {string} src
 * @param {string} [file]
 */
const literals = (src, file = "x.js") =>
  read(src, file).filter(
    (t) => !t.startsWith("name:") && !t.startsWith("punct:") && !t.startsWith("number:"),
  );
/**
 * The regular expressions, as written.
 * @param {string} src
 * @param {string} [file]
 */
const regexes = (src, file = "x.js") =>
  read(src, file)
    .filter((t) => t.startsWith("regex:"))
    .map((t) => t.slice("regex:".length));
/**
 * Whether `src` holds a division `/` punctuator.
 * @param {string} src
 * @param {string} [file]
 */
const divides = (src, file = "x.js") => read(src, file).includes("punct:/");
/**
 * The token of `src` whose text is `text`.
 * @param {string} src
 * @param {string} text
 * @param {string} [file]
 */
const tokenOf = (src, text, file = "x.js") => {
  const token = tokenize(src, file).find((t) => src.slice(t.start, t.end) === text);
  assert.ok(token !== undefined, `no token ${text}`);
  return token;
};
/**
 * Asserts that tokenizing fails closed, naming the file and line.
 * @param {string} src
 * @param {string} file
 * @param {number} line
 * @param {RegExp} reason
 */
const refuses = (src, file, line, reason) => {
  assert.throws(
    () => tokenize(src, file),
    (/** @type {unknown} */ error) => {
      assert.ok(error instanceof TokenizeError);
      assert.equal(error.file, file);
      assert.equal(error.line, line);
      assert.ok(error.message.startsWith(`${file}:${line}:`), error.message);
      assert.match(error.reason, reason);
      return true;
    },
  );
};

describe("js-tokens: the interface", () => {
  test("tokens carry kind, start, end, line and value; strings and template pieces their raw text", () => {
    const src = 'a = "x\\ty";\nb = `p${q}r`;';
    const str = tokenOf(src, '"x\\ty"');
    assert.deepEqual(
      {
        kind: str.kind,
        start: str.start,
        end: str.end,
        line: str.line,
        value: str.value,
        raw: str.raw,
      },
      { kind: "string", start: 4, end: 10, line: 1, value: "x\ty", raw: "x\\ty" },
    );
    const head = tokenOf(src, "`p${");
    assert.deepEqual(
      [head.kind, head.line, head.value, head.raw, head.cooked],
      ["template-head", 2, "p", "p", true],
    );
    const tail = tokenOf(src, "}r`");
    assert.deepEqual([tail.kind, tail.value, tail.raw], ["template-tail", "r", "r"]);
  });

  test("comments carry their text, regular expressions their pattern and flags", () => {
    const src = "// line\n/* block */ x = /a[/]b/gu;";
    assert.equal(tokenOf(src, "// line").value, " line");
    assert.equal(tokenOf(src, "/* block */").value, " block ");
    const re = tokenOf(src, "/a[/]b/gu");
    assert.deepEqual([re.kind, re.value, re.flags], ["regex", "a[/]b", "gu"]);
  });

  test("a hashbang is its own token", () => {
    assert.deepEqual(literals("#!/usr/bin/env node\nx = 1;"), ["hashbang:#!/usr/bin/env node"]);
  });

  test("syntaxOf: the extension decides the syntax as TypeScript does", () => {
    for (const file of ["a.tsx", "a.jsx", "a.js", "a.mjs", "a.cjs"]) {
      assert.equal(syntaxOf(file).jsx, true, file);
    }
    for (const file of ["a.ts", "a.mts", "a.cts", "a.d.ts"]) {
      assert.equal(syntaxOf(file).jsx, false, file);
    }
    assert.equal(syntaxOf("a.tsx").typescript, true);
    assert.equal(syntaxOf("a.js").typescript, false);
    assert.throws(() => syntaxOf("a.json"), TokenizeError);
    assert.throws(() => tokenize("x", "README.md"), TokenizeError);
  });
});

describe("js-tokens: regular expression or division, by the keyword before it", () => {
  for (const [keyword, src] of [
    ["return", "function f() { return /re/; }"],
    ["typeof", "x = typeof /re/;"],
    ["instanceof", "x = y instanceof /re/.constructor;"],
    ["in", 'x = "source" in /re/;'],
    ["of", "for (const m of /re/.exec(s)) {}"],
    ["new", "x = new /re/.constructor();"],
    ["delete", "delete /re/.lastIndex;"],
    ["void", "x = void /re/;"],
    ["throw", "throw /re/;"],
    ["case", "switch (s) { case /re/.source: break; }"],
    ["do", "do /re/.test(s); while (0);"],
    ["else", "if (a) b(); else /re/.test(s);"],
    ["yield", "function* g() { yield /re/; }"],
    ["await", "async function f() { await /re/; }"],
    ["extends", "class A extends /re/.constructor {}"],
    ["default", `${EXP} default /re/;`],
    ["break", "for (;;) { break\n/re/.test(s); }"],
    ["continue", "for (;;) { continue\n/re/.test(s); }"],
  ]) {
    test(`a / after the keyword ${keyword} starts a regular expression`, () => {
      assert.deepEqual(regexes(src ?? ""), ["/re/"]);
    });
  }

  test("return followed by a line break still starts a regular expression", () => {
    assert.deepEqual(regexes("function f() {\n  return\n  /re/.test(s);\n}"), ["/re/"]);
  });

  for (const [what, src] of [
    ["an identifier", "x = a / b / c;"],
    ["a number", "x = 1 / 2 / 3;"],
    ["a string", 'x = "s" / 2 / 3;'],
    ["a template's end", "x = `t` / 2 / 3;"],
    ["a template's tail", "x = `t${a}` / 2 / 3;"],
    ["a keyword used as a property", "x = o.return / 2 / 3;"],
    ["this", "x = this / 2 / 3;"],
    ["a private name", "class A { #p = 1; m() { return this.#p / 2 / 3; } }"],
  ]) {
    test(`a / after ${what} divides`, () => {
      assert.deepEqual(regexes(src ?? ""), []);
      assert.ok(divides(src ?? ""));
    });
  }

  test("let with no binding after it is an identifier, and divides", () => {
    assert.deepEqual(regexes("x = let / 2 / 3;"), []);
    assert.deepEqual(regexes("let r = /re/;"), ["/re/"]);
  });

  test("a++ / 2 divides; a prefix ++ before a regular expression does not", () => {
    assert.deepEqual(regexes("x = a++ / 2 / 3;"), []);
    assert.deepEqual(regexes("x = a-- / 2 / 3;"), []);
    assert.deepEqual(regexes("++/re/.lastIndex;"), ["/re/"]);
    assert.deepEqual(regexes("x = a\n++/re/.lastIndex;"), ["/re/"]);
  });

  test("x! / 2 divides (TypeScript's non-null assertion); a prefix ! before a regular expression does not", () => {
    assert.deepEqual(regexes("const y = x! / 2 / 3;", "x.ts"), []);
    assert.ok(divides("const y = x! / 2 / 3;", "x.ts"));
    assert.deepEqual(regexes("const y = !/re/.test(s);", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("const y = a\n!/re/.test(s);", "x.ts"), ["/re/"]);
  });
});

describe("js-tokens: of, keyof, yield and await are operators only where the syntax makes them so", () => {
  test("of as a name divides; a literal after it is read", () => {
    assert.deepEqual(regexes("var of = 6; var r = of / 2 / 3;"), []);
    assert.ok(divides("var of = 6; var r = of / 2 / 3;"));
    assert.deepEqual(literals('var of = 1; var r = [of / 1, "evil.example", 1 / 1];'), [
      'string:"evil.example"',
    ]);
    assert.deepEqual(
      literals(
        'import { of } from "rxjs";\nexport const half = of / 2; const sep = "//"; fetch("https://third.example/x");',
      ),
      ['string:"rxjs"', 'string:"//"', 'string:"https://third.example/x"'],
    );
    assert.deepEqual(literals('const of=4;x=of/2;fetch("https:\\/\\/third.example");y=of/(2);'), [
      'string:"https:\\/\\/third.example"',
    ]);
  });

  test("of as a mangled name in a minified bundle", () => {
    assert.deepEqual(literals("n.push(of/-t.length,`https:third-701.example`),n.push(of/3,`s`);"), [
      "template:`https:third-701.example`",
      "template:`s`",
    ]);
    assert.deepEqual(literals("const as=6,is=2,of=1;r=as/is/of;q=of/2,`s705`,of/3;"), [
      "template:`s705`",
    ]);
  });

  test("of is an operator in a for-of head, after its binding or left-hand side", () => {
    assert.deepEqual(regexes("for (const m of /re/.exec(s)) {}"), ["/re/"]);
    assert.deepEqual(regexes("for (const of of /re/.exec(s)) {}"), ["/re/"]);
    assert.deepEqual(regexes("for (of of /re/.exec(s)) {}"), ["/re/"]);
    assert.deepEqual(regexes("for (const [a, b] of /re/.exec(s)) {}"), ["/re/"]);
    assert.deepEqual(regexes("for (const { a } of /re/.exec(s)) {}"), ["/re/"]);
    assert.deepEqual(regexes("for (x.y of /re/.exec(s)) {}"), ["/re/"]);
    assert.deepEqual(regexes("async function f() { for await (const x of /re/.exec(s)) {} }"), [
      "/re/",
    ]);
    assert.deepEqual(literals('for (var of = 0; of < n; of++) { s += "it\'s"; }'), [
      'string:"it\'s"',
    ]);
    assert.deepEqual(regexes("for (var i = 0; i < of / 2 / 1; i++) {}"), []);
  });

  test("of is an operator after an annotated binding in a TypeScript for head", () => {
    assert.deepEqual(regexes("for (const x: T of /re/.exec(s)) {}", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("for (const x: of of /re/.exec(s)) {}", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("for (const [a, b]: T of /re/.exec(s)) {}", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("for (let x: T = of / 2 / 1; ;) {}", "x.ts"), []);
    assert.deepEqual(regexes("for (const f = (): T => { return /re/ }; ;) {}", "x.ts"), ["/re/"]);
  });

  test("keyof as a name divides; in a type it is read by the type", () => {
    assert.deepEqual(regexes("const keyof = 6; const r = keyof / 2 / 3;", "x.ts"), []);
    assert.deepEqual(regexes("var keyof = 6; var r = keyof / 2 / 3;"), []);
    assert.deepEqual(regexes("type K = keyof T;\n/re/.test(s);", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("let k: keyof T = x;\n/re/.test(s);", "x.ts"), ["/re/"]);
  });

  test("yield is an operator in a generator's body and parameters, a name elsewhere", () => {
    assert.deepEqual(regexes("function* g() { yield /re/; }"), ["/re/"]);
    assert.deepEqual(regexes("var g = function* () { yield /re/; };"), ["/re/"]);
    assert.deepEqual(regexes("class A { *g() { yield /re/; } }"), ["/re/"]);
    assert.deepEqual(regexes("var o = { *g() { yield /re/; } };"), ["/re/"]);
    assert.deepEqual(regexes("class A { static async *[Symbol.iterator]() { yield /re/; } }"), [
      "/re/",
    ]);
    assert.deepEqual(regexes("function* g(a = yield /re/) {}"), ["/re/"]);
    assert.deepEqual(regexes("function* g() { var r = yield\n/re/.test(s); }"), ["/re/"]);
    assert.deepEqual(regexes("function f() { var yield = 6; return yield / 2 / 3; }"), []);
    assert.deepEqual(regexes("var yield = 2, t = 1;\nz = yield / t / 1;", "x.cjs"), []);
    assert.deepEqual(regexes("function g() { var r = yield\n/ 2 / 3; }"), []);
    assert.deepEqual(regexes("var r = yield / 2 / 3;"), []);
    // A function, arrow function or class field inside a generator reads it as a name.
    assert.deepEqual(regexes("function* g() { function h() { return yield / 2 / 3; } }"), []);
    assert.deepEqual(regexes("function* g() { var h = () => yield / 2 / 3; }"), []);
    assert.deepEqual(regexes("function* g() { var h = () => { return yield / 2 / 3; }; }"), []);
    assert.deepEqual(
      regexes("var o = { get a() { return yield / 2 / 3; }, *b() { yield /re/; } };"),
      ["/re/"],
    );
  });

  test("await is an operator in an async body and parameters, a name elsewhere", () => {
    assert.deepEqual(regexes("async function f() { await /re/; }"), ["/re/"]);
    assert.deepEqual(
      regexes("function f() { var g = async function () { return await /re/; }; }"),
      ["/re/"],
    );
    assert.deepEqual(regexes("const f = async () => await /re/;"), ["/re/"]);
    assert.deepEqual(regexes("const f = async x => await /re/;"), ["/re/"]);
    assert.deepEqual(regexes("const f = async (x) => { await /re/; };"), ["/re/"]);
    assert.deepEqual(regexes("class A { async m() { await /re/; } }"), ["/re/"]);
    assert.deepEqual(regexes("var o = { async m() { return await /re/; } };"), ["/re/"]);
    assert.deepEqual(regexes("async function f(a = await /re/) {}"), ["/re/"]);
    assert.deepEqual(regexes("async function f() { var r = await\n/re/.test(s); }"), ["/re/"]);
    assert.deepEqual(regexes("class A { static { await /re/; } }"), ["/re/"]);
    assert.deepEqual(
      regexes("async function f() { var o = { [await /re/]: 1, a: await /re/ }; }"),
      ["/re/", "/re/"],
    );
    // A function, a non-async arrow function or method, or a class field reads it as a name.
    assert.deepEqual(regexes("var await = 6; function f() { return await / 2 / 3; }"), []);
    assert.deepEqual(regexes("async function f() { function g() { return await / 2 / 3; } }"), []);
    assert.deepEqual(regexes("async function f() { var g = () => await / 2 / 3; }"), []);
    assert.deepEqual(regexes("async function f() { var g = x => await / 2 / 3; }"), []);
    assert.deepEqual(regexes("async function f() { class A { x = await / 2 / 3; } }"), []);
    assert.deepEqual(
      regexes("async function f() { var o = { m() { return await / 2 / 3; } }; }"),
      [],
    );
    assert.deepEqual(
      regexes("function f() { var r = async\nfunction g() { return await / 2 / 3; } }"),
      [],
    );
    assert.deepEqual(regexes("function f() { var g = async\nx => await / 2 / 3; }"), []);
  });

  test("an arrow function's expression body ends at a comma, a conditional's colon or a new statement", () => {
    assert.deepEqual(regexes("async function f() { var g = () => 1, h = await /re/; }"), ["/re/"]);
    assert.deepEqual(regexes("async function f() { g(() => 1, await /re/); }"), ["/re/"]);
    assert.deepEqual(regexes("async function f() { var g = c ? () => 1 : await /re/; }"), ["/re/"]);
    assert.deepEqual(regexes("async function f() { var g = () => c ? 1 : await / 2 / 3; }"), []);
    assert.deepEqual(regexes("async function f() { var g = () => 1\nawait /re/; }"), ["/re/"]);
    assert.deepEqual(
      regexes("async function f() { class A { x = 1\ny = () => 2\nasync m() { await /re/ } } }"),
      ["/re/"],
    );
    // `~` and a number such as `.5` cannot go on with an expression either.
    assert.deepEqual(regexes("async function f() { var g = () => a\n~await /re/ }"), ["/re/"]);
    assert.deepEqual(regexes("async function f() { g = () => a\n.5, await /re/ }"), ["/re/"]);
    assert.deepEqual(regexes("async function f() { var g = () => a\n.b / 2 / 3 }"), []);
  });

  test("a statement that a line break ends ends its declaration: a comma after it separates no bindings", () => {
    assert.deepEqual(regexes("async function f() { var a = 1\nx = 2, await /re/ }"), ["/re/"]);
    assert.deepEqual(regexes("async function f() { let a = 1\nfoo(), await /re/ }"), ["/re/"]);
    assert.deepEqual(regexes("async function f() { var g = () => a\n.5, await /re/ }"), ["/re/"]);
    // A name that starts with a letter outside ASCII (U+03C0).
    assert.deepEqual(regexes("async function f() { var g = () => a\n\u03c0, await /re/ }"), [
      "/re/",
    ]);
    assert.deepEqual(regexes("async function f() { var g = () => a\n\\u0061, await /re/ }"), [
      "/re/",
    ]);
    // A `{` after a function's parameters or anything after a class head goes on.
    assert.deepEqual(
      regexes("async function f() { var a = function ()\n{ return 1 }, b = await /re/ }"),
      ["/re/"],
    );
    assert.deepEqual(
      regexes("async function f() { var C = () => class extends B\n{ [await / 2 / 3]() {} } }"),
      [],
    );
  });

  test("TypeScript: async methods and arrow functions with type parameters, optional methods", () => {
    assert.deepEqual(
      regexes("function f() { const g = async <T,>(x: T) => await /re/; }", "x.ts"),
      ["/re/"],
    );
    assert.deepEqual(
      regexes("function f() { const g = async <T>(x: T): Promise<T> => await /re/; }", "x.ts"),
      ["/re/"],
    );
    assert.deepEqual(
      regexes("function f() { const g = async <T,>(x: T) => await /re/; }", "x.tsx"),
      ["/re/"],
    );
    assert.deepEqual(
      regexes("function f() { const g = async (x): Promise<number> => await /re/; }", "x.ts"),
      ["/re/"],
    );
    assert.deepEqual(
      regexes("function f() { class A { async m<T>() { return await /re/; } } }", "x.ts"),
      ["/re/"],
    );
    assert.deepEqual(
      regexes("function f() { class A { async m?() { return await /re/; } } }", "x.ts"),
      ["/re/"],
    );
    assert.deepEqual(
      regexes("async function f() { class A { m?() { return await / 2 / 3; } } }", "x.ts"),
      [],
    );
    assert.deepEqual(regexes("const async = 1; const r = async < b && c > /re/.exec(s);", "x.ts"), [
      "/re/",
    ]);
  });

  test("await at the top level: an operator in a module", () => {
    assert.deepEqual(regexes("await /re/.test(s);", "x.mjs"), ["/re/"]);
    assert.deepEqual(regexes("await /re/.test(s);", "x.mts"), ["/re/"]);
    assert.deepEqual(regexes('import x from "y";\nawait /re/.test(x);'), ["/re/"]);
    assert.deepEqual(regexes("export {};\nawait /re/.test(s);", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes('import x = require("y");\nawait /re/.test(x);', "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("import.meta;\nawait /re/.test(s);"), ["/re/"]);
    // In a module, a namespace's body and a function's read it as a name.
    assert.deepEqual(regexes("export {};\nnamespace N { var r = await / 2 / 3; }", "x.ts"), []);
    assert.deepEqual(regexes("export function f() { var r = await / 2 / 3; }"), []);
    // So do a module declaration's and a global augmentation's, and one nested in either.
    for (const src of [
      "export {};\ndeclare module 'm' { var r = await / 2 / 3 }",
      "export {};\ndeclare global { var r = await / 2 / 3 }",
      "export {};\nglobal { var r = await / 2 / 3 }",
      "export {};\nglobal\n{ var r = await / 2 / 3 }",
      "export {};\nnamespace A { namespace B { var r = await / 2 / 3 } }",
      "declare module 'm' { global { var r = await / 2 / 3 } }",
    ]) {
      assert.deepEqual(regexes(src, "x.ts"), [], src);
    }
    assert.deepEqual(regexes("namespace A { var r = await / 2 / 3 }", "x.mts"), []);
    // Elsewhere their bodies read `await` and `yield` as around them.
    assert.deepEqual(regexes("async function f() { namespace N { await /re/ } }", "x.ts"), [
      "/re/",
    ]);
    assert.deepEqual(regexes("async function f() { module N { await /re/ } }", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("function* g() { namespace N { yield /re/ } }", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("async function f() { global { await /re/ } }", "x.ts"), ["/re/"]);
    assert.deepEqual(
      regexes("export {};\nnamespace A { async function f() { await /re/ } }", "x.ts"),
      ["/re/"],
    );
    // `global` that declares nothing is a name.
    assert.deepEqual(regexes("export {};\nglobal.x\n{ var r = await /re/ }", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("export {};\nx = global\n{ var r = await /re/ }", "x.ts"), ["/re/"]);
    // Until an import or export says it is a module, the file may be a script: unknown.
    assert.deepEqual(regexes("await (x);\nexport {};"), []);
  });

  test("an await or yield whose reading the file alone cannot decide fails closed before a token the readings split on", () => {
    const reason = /may be an operator or a name/;
    refuses("var await = 6; var r = await / 2 / 3;", "bad.js", 1, reason);
    refuses("var await = 6; var r = await / 2 / 3;", "bad.ts", 1, reason);
    refuses("var r = await / 2 / 3;", "bad.cjs", 1, reason);
    refuses("var r = await / 2 / 3;\nimport x from 'y';", "bad.js", 1, reason);
    refuses("import x = y.z;\nvar r = await / 2 / 3;", "bad.ts", 2, reason);
    refuses("export as namespace N;\nvar r = await / 2 / 3;", "bad.ts", 2, reason);
    refuses("var r = import('x');\nvar s = await\n/ 2 / 3;", "bad.js", 2, reason);
    refuses("var a = await <b>c</b>;", "bad.jsx", 1, reason);
    refuses("var a = await !b;", "bad.js", 1, reason);
    refuses("var a = await ++b;", "bad.js", 1, reason);
    refuses("var a = await\n{};", "bad.js", 1, reason);
    refuses("for (await of /re/.exec(s)) {}", "bad.js", 1, reason);
    // A parenthesis after async: an async arrow function's parameters, or a call's arguments.
    refuses("function f() { var h = async (await / 2 / 3); }", "bad.js", 1, reason);
    refuses("function* g() { var h = async (yield / 2 / 3); }", "bad.js", 1, reason);
    // `global` then a block on a later line in a JavaScript file: TypeScript reads a global
    // declaration, a JavaScript engine `global;` and a block.
    refuses("export {};\nglobal\n{ var r = await / 2 / 3 }", "bad.js", 3, reason);
    assert.deepEqual(regexes("export {};\nglobal { var r = await / 2 / 3 }"), []);
  });
});

describe("js-tokens: a line break after a statement that cannot go on starts the next one", () => {
  for (const [what, src, file] of [
    ["a var binding with no initializer", "var x", "x.js"],
    ["a let binding with no initializer", "let x", "x.js"],
    ["two bindings", "var x, y", "x.js"],
    ["an array pattern", "var [a]", "x.js"],
    ["an object pattern", "var {a}", "x.js"],
    ["a labelled break", "a: for (;;) { break a", "x.js"],
    ["a labelled continue", "a: for (;;) { continue a", "x.js"],
    ["an import's module specifier", 'import x from "y"', "x.js"],
    ["an import of a module only", 'import "a"', "x.js"],
    ["an import's attributes", 'import x from "a" with { type: "json" }', "x.js"],
    ["an import's attributes on the next line", 'import x from "a"\nwith { type: "json" }', "x.js"],
    ["a named import on two lines", 'import { a }\nfrom "b"', "x.js"],
    ["a default and named import", 'import x, { y } from "z"', "x.js"],
    ["export * from", 'export * from "x"', "x.js"],
    ["export * as from", 'export * as ns from "x"', "x.js"],
    ["export { } from", 'export { a } from "b"', "x.js"],
    ["export { } from on two lines", 'export { a }\nfrom "b"', "x.js"],
    ["export { } with a string name", 'export { a as "b c" } from "d"', "x.js"],
    ["export { }", "export { a }", "x.js"],
    ["declare function", "declare function f()", "x.ts"],
    ["an overload signature", "function f(a: string)", "x.ts"],
    ["declare module", 'declare module "m"', "x.ts"],
    ["declare var", "declare var a", "x.ts"],
    ["import = require", 'import a = require("a")', "x.ts"],
    ["import = entity", "import a = b.c", "x.ts"],
    ["import = entity on two lines", "import a = b\n.c", "x.ts"],
    ["import = entity on three lines", "import a = b /* c */\n.c\n.d", "x.ts"],
    ["export as namespace", "export as namespace a", "x.ts"],
    ["import type", 'import type { A } from "a"', "x.ts"],
    ["export type * from", 'export type * from "a"', "x.ts"],
    ["export type { }", "export type { A }", "x.ts"],
  ]) {
    test(`after ${what}`, () => {
      const close = (src ?? "").includes("for (;;) {") ? " }" : "";
      assert.deepEqual(
        regexes(`${src}\n/re/.test(q)${close}`, file).filter((r) => r === "/re/"),
        ["/re/"],
      );
    });
  }

  test("an import's module specifier then a regular expression holding a quote", () => {
    assert.deepEqual(
      literals('import x from "y"\n/"/.test(x) || fetch("https://evil.example")\n'),
      ['string:"y"', 'regex:/"/', 'string:"https://evil.example"'],
    );
  });

  test("after a binding with no initializer, JSX on the next line", () => {
    assert.deepEqual(literals("let v\n<p>it's Bob's</p>", "x.tsx"), ["jsx-text:it's Bob's"]);
  });

  test("what goes on with the statement after a line break still divides", () => {
    assert.deepEqual(regexes("var x = 1\n/ 2 / 3"), []);
    assert.deepEqual(regexes("var x\n= 1\n/ 2 / 3"), []);
    assert.deepEqual(regexes("var x\n(a)\n/ 2 / 3"), []);
    assert.deepEqual(regexes("let x\n: number = 1\n/ 2 / 3", "x.ts"), []);
    assert.deepEqual(regexes('export { a }\nfoo("x", {})\n/ 2 / 3'), []);
    assert.deepEqual(regexes("export const a = 1\nx = {}\n/ 2 / 3"), []);
    assert.deepEqual(regexes("x = from\n/ 2 / 3"), []);
    assert.deepEqual(regexes("module\n/ 2 / 3"), []);
    assert.deepEqual(regexes("function f()\n{ return /re/ }"), ["/re/"]);
    assert.deepEqual(regexes('declare module "m"\n{ export const a = /re/; }', "x.ts"), ["/re/"]);
  });
});

describe("js-tokens: TypeScript reads type arguments only after a type reference", () => {
  test("after a keyword type, a literal or a closing bracket, < is less-than", () => {
    assert.deepEqual(regexes("const ok = n as number < 5 && m > /re/.exec(s).length;", "x.ts"), [
      "/re/",
    ]);
    for (const type of [
      "number",
      "T[]",
      "'lit'",
      "{}",
      "(A)",
      "`t`",
      "this",
      "unknown",
      "void",
      "null",
      "true",
      "-1",
      "unique symbol",
    ]) {
      const src = `const a = x as ${type} < 5 && m > /re/.exec(s).length;`;
      assert.deepEqual(regexes(src, "x.ts"), ["/re/"], type);
    }
    assert.deepEqual(literals('if (x as number < y) { z = "s" }', "x.ts"), ['string:"s"']);
    assert.deepEqual(regexes("const ok = n as number << 5 / 2 / 1;", "x.ts"), []);
    assert.deepEqual(
      regexes("const a = x satisfies boolean < 5 && m > /re/.exec(s).length;", "x.ts"),
      ["/re/"],
    );
    assert.deepEqual(literals("const x = count as number < 5 && <i>it's Bob's</i>;", "x.tsx"), [
      "jsx-text:it's Bob's",
    ]);
  });

  test("after a type reference, a typeof query or an import type, < opens type arguments", () => {
    assert.deepEqual(regexes("const a = x as Array<string>;\n/re/.test(q)", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("const a = x as typeof y<string>;\n/re/.test(q)", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("const a = x as import('m').T<string>;\n/re/.test(q)", "x.ts"), [
      "/re/",
    ]);
    assert.deepEqual(regexes("const a = x as string.T<string>;\n/re/.test(q)", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("const a = x as A.B<C> / 2 / 1;", "x.ts"), []);
    assert.deepEqual(regexes("const a = x as intrinsic<C> / 2 / 1;", "x.ts"), []);
    // A qualified name is a type reference whatever its last name (`A.string`, `A.void`).
    for (const type of ["A.string", "A.void", "A.B.any", "typeof A.number"]) {
      assert.deepEqual(regexes(`const a = x as ${type}<C> / 2 / 1;`, "x.ts"), [], type);
    }
  });
});

describe("js-tokens: ) ] and } decided by what they close", () => {
  for (const keyword of ["if", "while", "for", "with"]) {
    test(`) closing the condition of ${keyword} is followed by a statement: a regular expression`, () => {
      const head = keyword === "for" ? "for (;;)" : `${keyword} (x)`;
      assert.deepEqual(regexes(`${head} /re/.test(s);`), ["/re/"]);
    });
  }

  test("for await (...) is a statement's head too", () => {
    assert.deepEqual(regexes("async function f() { for await (const x of y) /re/.test(x); }"), [
      "/re/",
    ]);
  });

  test(") closing a group or a call divides", () => {
    assert.deepEqual(regexes("x = (a) / b / c;"), []);
    assert.deepEqual(regexes("x = f(a) / b / c;"), []);
    assert.deepEqual(regexes("x = if_(a) / b / c;"), []);
  });

  test("] divides", () => {
    assert.deepEqual(regexes("x = [a] / b / c;"), []);
    assert.deepEqual(regexes("x = a[0] / b / c;"), []);
  });

  for (const [what, src] of [
    ["a block", "{ a(); } /re/.test(s);"],
    ["an if's block", "if (a) { b(); } /re/.test(s);"],
    ["a function declaration's body", "function f() {} /re/.test(s);"],
    ["an async function declaration's body", "async function f() {} /re/.test(s);"],
    ["a class declaration's body", "class A {} /re/.test(s);"],
    ["an arrow function's body", "const f = () => {}\n/re/.test(s);"],
    ["a switch", "switch (a) { default: } /re/.test(s);"],
    ["a try statement", "try { a(); } catch (e) { b(); } finally { c(); } /re/.test(s);"],
  ]) {
    test(`} closing ${what} is followed by a statement: a regular expression`, () => {
      assert.deepEqual(regexes(src ?? ""), ["/re/"]);
    });
  }

  for (const [what, src] of [
    ["an object literal", "x = {} / a / b;"],
    ["an object literal in parentheses", "x = ({}) / a / b;"],
    ["a function expression's body", "x = function () {} / a / b;"],
    ["a class expression's body", "x = class {} / a / b;"],
    [`an ${EXP} default object`, `${EXP} default {} / a / b;`],
  ]) {
    test(`} closing ${what} ends an expression: it divides`, () => {
      assert.deepEqual(regexes(src ?? ""), []);
      assert.ok(divides(src ?? ""));
    });
  }

  test("catch with no binding opens a block: a regular expression in it and after it", () => {
    for (const file of ["x.js", "x.ts"]) {
      assert.deepEqual(regexes("try { g() } catch { return /re/ }", file), ["/re/"], file);
      assert.deepEqual(regexes("try { g() } catch { return /re/.test(s) }", file), ["/re/"], file);
    }
    assert.deepEqual(regexes("try{g()}catch{return/re/}"), ["/re/"]);
    assert.deepEqual(regexes("try{g()}catch{throw/re/}"), ["/re/"]);
    assert.deepEqual(regexes("try{g()}catch{if(a)/re/.test(b)}"), ["/re/"]);
    assert.deepEqual(regexes("try{g()}catch{}/re/.test(s);"), ["/re/"]);
    assert.deepEqual(regexes("try { g(); } catch {}\n/\\.ts$/.test(name) && h();"), ["/\\.ts$/"]);
    assert.deepEqual(regexes("function f() { try { a() } catch { throw /'/ } }"), ["/'/"]);
    assert.deepEqual(regexes("try { a() } catch { b() } finally { c() } /re/.test(s);"), ["/re/"]);
    // catch with a binding is unchanged, and `catch` as a key or member is no keyword.
    assert.deepEqual(regexes("try { a() } catch (e) { b() } /re/.test(s);"), ["/re/"]);
    assert.deepEqual(regexes("x = { catch: 1 } / 2 / 3; y = p.catch / 2 / 3;"), []);
  });

  test("catch with no binding: strings, comments and JSX text in its block keep their kind", () => {
    assert.deepEqual(
      literals(
        'function f(a) {\n  try { g() } catch { return /"/.test(a) || fetch("//evil.example/x") }\n  /}/.test(a);\n}',
      ),
      ['regex:/"/', 'string:"//evil.example/x"', "regex:/}/"],
    );
    assert.deepEqual(
      literals(
        'export function f(a, b) {\n  try { return g(a) } catch { return /"/.test(a) && /"/.test(b) }\n}',
      ),
      ['regex:/"/', 'regex:/"/'],
    );
    assert.deepEqual(
      literals(
        "export function F() {\n  try { return g(); } catch { return <p>see http://example.com // b</p>\n  }\n}",
        "x.tsx",
      ),
      ["jsx-text:see http://example.com // b"],
    );
  });

  test("catch with no binding in a minified bundle (rolldown drops an unused binding)", () => {
    assert.deepEqual(
      literals(
        "export function h(e,t){try{JSON.parse(e)}catch{log(1)}/'/.test(e)&&send(`https://third.example`),globalThis.ok=/'/.test(t)}",
      ),
      ["regex:/'/", "template:`https://third.example`", "regex:/'/"],
    );
    assert.deepEqual(
      literals(
        'export function safeParse(e){try{return JSON.parse(e)}catch{return/^\\s*"/.test(e)?`a string // not a comment`:null}}',
      ),
      ['regex:/^\\s*"/', "template:`a string // not a comment`"],
    );
  });

  test("} closing a template substitution goes on with the template", () => {
    assert.deepEqual(literals("x = `a${ {b: 1}.b }c` / 2;"), [
      "template-head:`a${",
      "template-tail:}c`",
    ]);
    assert.deepEqual(literals("x = `a${(() => { return 1; })()}c`;"), [
      "template-head:`a${",
      "template-tail:}c`",
    ]);
  });
});

describe("js-tokens: regular expression bodies", () => {
  test("a regular expression class may hold /", () => {
    assert.deepEqual(regexes("x = /[/]/;"), ["/[/]/"]);
    assert.deepEqual(regexes("x = /[^/\\]]+\\/x/g;"), ["/[^/\\]]+\\/x/g"]);
    assert.deepEqual(regexes("x = /a[\\]/]b/;"), ["/a[\\]/]b/"]);
    assert.deepEqual(regexes("x = /[\"'`]/.test(s);"), ["/[\"'`]/"]);
  });

  test("escapes and every flag", () => {
    assert.deepEqual(regexes("x = /a\\/b/dgimsy;"), ["/a\\/b/dgimsy"]);
    assert.deepEqual(regexes("x = /[\\p{L}--[a-z]]/v;"), ["/[\\p{L}--[a-z]]/v"]);
    assert.equal(tokenOf("x = /a/gi;", "/a/gi").flags, "gi");
  });

  test("a regular expression that starts with = is no /= operator", () => {
    assert.deepEqual(regexes("x = /=/.test(s);"), ["/=/"]);
    assert.ok(read("x /= 2;").includes("punct:/="));
  });
});

describe("js-tokens: a comment right before a regular expression", () => {
  test("(s) => /re/.test(s)", () => {
    assert.deepEqual(regexes("const f = (s) => /re/.test(s);"), ["/re/"]);
  });

  test("a line comment then a regular expression", () => {
    assert.deepEqual(literals("x = // note\n/re/.test(s);"), [
      "line-comment:// note",
      "regex:/re/",
    ]);
  });

  test("a block comment then a regular expression", () => {
    assert.deepEqual(literals("return /* note */ /re/;"), [
      "block-comment:/* note */",
      "regex:/re/",
    ]);
    assert.deepEqual(literals("/* note */ /re/.test(s);"), [
      "block-comment:/* note */",
      "regex:/re/",
    ]);
  });

  test("a comment between an operand and a division keeps the division", () => {
    assert.deepEqual(literals("x = a /* note */ / 2;"), ["block-comment:/* note */"]);
    assert.ok(divides("x = a // note\n/ 2;"));
  });
});

describe("js-tokens: string escapes", () => {
  for (const [what, written, value] of [
    ["\\n", "\\n", "\n"],
    ["\\t", "\\t", "\t"],
    ["\\r", "\\r", "\r"],
    ["\\b", "\\b", "\b"],
    ["\\f", "\\f", "\f"],
    ["\\v", "\\v", "\v"],
    ["\\0", "\\0", "\0"],
    ["\\x", "\\x41", "A"],
    ["\\u", "\\u0041", "A"],
    ["\\u{...}", "\\u{1F600}", String.fromCodePoint(0x1f600)],
    ["\\u{...} short", "\\u{41}", "A"],
    ["legacy octal", "\\101", "A"],
    ["legacy octal of one digit", "\\7", String.fromCharCode(7)],
    ["\\0 before a digit", "\\08", `${String.fromCharCode(0)}8`],
    ["\\8 and \\9", "\\8\\9", "89"],
    ["identity", "\\a\\'\\\"\\\\", "a'\"\\"],
    ["line continuation (LF)", "a\\\nb", "ab"],
    ["line continuation (CRLF)", "a\\\r\nb", "ab"],
    ["line continuation (CR)", "a\\\rb", "ab"],
    ["line continuation (LS)", `a\\${String.fromCharCode(0x2028)}b`, "ab"],
    ["line continuation (PS)", `a\\${String.fromCharCode(0x2029)}b`, "ab"],
  ]) {
    test(`string escape: ${what}`, () => {
      const src = `x = "${written}";`;
      assert.equal(tokenOf(src, `"${written}"`).value, value);
    });
  }

  test("a string holds an unescaped LS or PS", () => {
    const text = `'a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c'`;
    assert.equal(tokenOf(`x = ${text};`, text).value, text.slice(1, -1));
  });

  test("an invalid escape in a string fails closed", () => {
    refuses('x = "\\x4";', "bad.js", 1, /invalid \\x escape/);
    refuses('x = "\\u12";', "bad.js", 1, /invalid \\u escape/);
    refuses('x = "\\u{110000}";', "bad.js", 1, /past U\+10FFFF/);
  });
});

describe("js-tokens: template literals", () => {
  test("templates nested three deep", () => {
    const src = "x = `a${`b${`c${d}e`}f`}g`;";
    const pieces = tokenize(src, "x.js").filter((t) => t.kind.startsWith("template"));
    assert.deepEqual(
      pieces.map((t) => [t.kind, t.value]),
      [
        ["template-head", "a"],
        ["template-head", "b"],
        ["template-head", "c"],
        ["template-tail", "e"],
        ["template-tail", "f"],
        ["template-tail", "g"],
      ],
    );
  });

  test("a template's cooked value decodes escapes and reads CRLF as LF; raw keeps the text", () => {
    const src = "x = `a\\nb\r\nc\\`\\${d}`;";
    const token = tokenOf(src, src.slice(4, -1));
    assert.equal(token.kind, "template");
    assert.equal(token.value, "a\nb\nc`${d}");
    assert.equal(token.raw, "a\\nb\r\nc\\`\\${d}");
  });

  test("a template middle piece", () => {
    assert.deepEqual(literals("x = `a${b}c${d}e`;"), [
      "template-head:`a${",
      "template-middle:}c${",
      "template-tail:}e`",
    ]);
  });

  test("a tagged template may hold an escape with no cooked value", () => {
    const src = "x = String.raw`\\u{` + tag`\\xZ${y}\\9`;";
    const raw = tokenOf(src, "`\\u{`");
    assert.deepEqual([raw.kind, raw.cooked, raw.value], ["template", false, "\\u{"]);
    assert.equal(tokenOf(src, "}\\9`").cooked, false);
  });

  test("an untagged template with an invalid escape fails closed", () => {
    refuses("x = `\\u{`;", "bad.js", 1, /invalid escape in an untagged template/);
    refuses("x = (`\\01`);", "bad.js", 1, /invalid escape/);
  });
});

describe("js-tokens: numbers, names and punctuators", () => {
  test("every numeric form", () => {
    const forms = [
      "0x1F",
      "0X1f",
      "0o17",
      "0b101",
      "1n",
      "0x1Fn",
      "1_000_000",
      "1e10",
      "1E-5",
      "1.5e+3",
      ".5",
      "1.",
      "017",
      "08",
      "09.5",
      "0.0",
    ];
    const src = `a = [${forms.join(", ")}, 1..toString()];`;
    assert.deepEqual(
      read(src).filter((t) => t.startsWith("number:")),
      [...forms, "1."].map((n) => `number:${n}`),
    );
  });

  test("an invalid number fails closed", () => {
    refuses("x = 1__0;", "bad.js", 1, /numeric separator/);
    refuses("x = 1_;", "bad.js", 1, /numeric separator/);
    refuses("x = 0x;", "bad.js", 1, /no digits/);
    refuses("x = 1e;", "bad.js", 1, /exponent/);
    refuses("x = 3in y;", "bad.js", 1, /directly after a number/);
  });

  test("identifiers by ID_Start and ID_Continue, and \\u escapes", () => {
    const names = [
      `caf${String.fromCharCode(0xe9)}`,
      String.fromCharCode(0x3c0),
      String.fromCodePoint(0x1d465),
      `a${String.fromCharCode(0x200d)}b`,
    ];
    const src = `${names.join(" + ")} + \\u0061bc + a\\u{62}c + $_;`;
    assert.deepEqual(
      tokenize(src, "x.js")
        .filter((t) => t.kind === "name")
        .map((t) => t.value),
      [...names, "abc", "abc", "$_"],
    );
    refuses("a\\u0020b = 1;", "bad.js", 1, /no identifier character/);
  });

  test("the longest punctuators: ?. ??= **= >>>= => ...", () => {
    const src = "a?.b; a ??= b; a **= b; a >>>= b; f = (...r) => r; a ?? b; a?.[0];";
    const puncts = read(src).filter((t) => t.startsWith("punct:"));
    for (const p of ["?.", "??=", "**=", ">>>=", "=>", "...", "??"]) {
      assert.ok(puncts.includes(`punct:${p}`), p);
    }
  });

  test("a?.5:1 is a conditional, not optional chaining", () => {
    assert.deepEqual(
      read("x = a?.5:1;").filter((t) => t.startsWith("punct:") || t.startsWith("number:")),
      ["punct:=", "punct:?", "number:.5", "punct::", "number:1", "punct:;"],
    );
  });

  test("private names", () => {
    assert.deepEqual(
      tokenize("class A { #x; m() { return #x in this; } }", "x.js")
        .filter((t) => t.kind === "private-name")
        .map((t) => t.value),
      ["#x", "#x"],
    );
  });
});

describe("js-tokens: TypeScript", () => {
  test("generics: type arguments and parameters", () => {
    assert.deepEqual(regexes("const m = new Map<string, number>() / 2 / 3;", "x.ts"), []);
    assert.deepEqual(
      regexes(
        "function f<T extends { a: string }>(x: T): T { return /re/.test(x.a) ? x : x; }",
        "x.ts",
      ),
      ["/re/"],
    );
    assert.deepEqual(
      regexes(
        "class A<T = {}> extends B<T> implements C<{ d: 1 }> { m<U>(): void {} }\n/re/.test(s);",
        "x.ts",
      ),
      ["/re/"],
    );
    assert.deepEqual(regexes("const y = f?.<T>(x) / 2 / 3;", "x.ts"), []);
  });

  test("as and satisfies end a type, and an expression goes on", () => {
    assert.deepEqual(regexes("const y = x as number / 2 / 3;", "x.ts"), []);
    assert.deepEqual(regexes("const y = x as unknown as Array<string> / 2 / 3;", "x.ts"), []);
    assert.deepEqual(regexes("const y = x satisfies T / 2 / 3;", "x.ts"), []);
    assert.deepEqual(regexes("const y = c ? (x as A extends B ? C : D) : /re/;", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("const y = { a: 1 } as const;\n/re/.test(s);", "x.ts"), ["/re/"]);
  });

  test("a type assertion <T>x in .ts, before a regular expression", () => {
    assert.deepEqual(regexes("const r = <RegExp>/re/;", "x.ts"), ["/re/"]);
    assert.deepEqual(literals('const s = <string>"a";', "x.ts"), ['string:"a"']);
  });

  test("x! / 2: the non-null assertion leaves an expression", () => {
    assert.deepEqual(regexes("const y = a.b! / 2 / 3;", "x.ts"), []);
    assert.deepEqual(regexes("const y = a[0]! / 2 / 3;", "x.ts"), []);
    assert.deepEqual(regexes("let x!: number;\n/re/.test(s);", "x.ts"), ["/re/"]);
  });

  test("annotations, aliases and interfaces end where TypeScript ends them", () => {
    assert.deepEqual(regexes("let x: { a: string } = { a: '/' };\n/re/.test(s);", "x.ts"), [
      "/re/",
    ]);
    assert.deepEqual(regexes("type A = { a: 1 }\n/re/.test(s);", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("interface I { a: string; b?(): void }\n/re/.test(s);", "x.ts"), [
      "/re/",
    ]);
    assert.deepEqual(regexes("function f(): { a: 1 } { return /re/; }", "x.ts"), ["/re/"]);
    assert.deepEqual(regexes("const f = (a?: string): boolean => /re/.test(a ?? '');", "x.ts"), [
      "/re/",
    ]);
    assert.deepEqual(
      regexes(
        "class A { a?: string; b!: number; c = /re/; static d: Array<number> = []; }",
        "x.ts",
      ),
      ["/re/"],
    );
    assert.deepEqual(literals("type T = `a${string}` | 'b';\nconst u: T = `a${'x'}`;", "x.ts"), [
      "template-head:`a${",
      "template-tail:}`",
      "string:'b'",
      "template-head:`a${",
      "string:'x'",
      "template-tail:}`",
    ]);
  });

  test("decorators", () => {
    assert.deepEqual(regexes("@dec class A {}\n/re/.test(s);", "x.ts"), ["/re/"]);
    assert.deepEqual(
      regexes("@a.b.c(1) class A { @d() m() { return /re/; } @e x: string = '/'; }", "x.ts"),
      ["/re/"],
    );
    assert.deepEqual(
      regexes("class A { constructor(@inject(T) private x: T) {} }\n/re/.test(s);", "x.ts"),
      ["/re/"],
    );
  });

  test("a generic arrow function in .ts", () => {
    assert.deepEqual(regexes("const f = <T>(x: T): T => x;\n/re/.test(s);", "x.ts"), ["/re/"]);
  });
});

describe("js-tokens: JSX", () => {
  test("JSX text, attribute strings and expression containers", () => {
    assert.deepEqual(
      literals("const a = <p class=\"c\" id='d' x={/re/}>hello {name}!</p>;", "x.tsx"),
      ['string:"c"', "string:'d'", "regex:/re/", "jsx-text:hello ", "jsx-text:!"],
    );
  });

  test("a JSX attribute string has no escapes and may span lines", () => {
    const src = 'const a = <p title="a\\nb\nc" />;';
    const token = tokenOf(src, '"a\\nb\nc"', "x.jsx");
    assert.deepEqual([token.kind, token.value, token.jsx], ["string", "a\\nb\nc", true]);
  });

  test("// inside JSX text is never a comment", () => {
    assert.deepEqual(literals("const a = <p>see https://example.com // here</p>;", "x.tsx"), [
      "jsx-text:see https://example.com // here",
    ]);
  });

  test("a quote inside JSX text never opens a string", () => {
    assert.deepEqual(literals("const a = <p>Don't \"quote\" `me`</p>;\nconst b = 'x';", "x.tsx"), [
      'jsx-text:Don\'t "quote" `me`',
      "string:'x'",
    ]);
  });

  test("JSX nested inside a template inside JSX", () => {
    const src = "const a = <div title={`t ${<b>{x}</b>} u`}>{`v ${<i>w</i>}`}</div>;";
    assert.deepEqual(literals(src, "x.tsx"), [
      "template-head:`t ${",
      "template-tail:} u`",
      "template-head:`v ${",
      "jsx-text:w",
      "template-tail:}`",
    ]);
  });

  test("fragments, member and namespace names, spread attributes, comments in tags", () => {
    const src = "const a = <><A.B.C {...p} /* c */ x:y='1' // d\n>t</A.B.C>{/* e */}</>;";
    assert.deepEqual(literals(src, "x.jsx"), [
      "block-comment:/* c */",
      "string:'1'",
      "line-comment:// d",
      "jsx-text:t",
      "block-comment:/* e */",
    ]);
  });

  test("an element as an attribute value, and a self-closing element", () => {
    assert.deepEqual(literals('const a = <A b=<C d="1" /> e />;', "x.jsx"), ['string:"1"']);
  });

  test("type arguments on a JSX element in .tsx", () => {
    assert.deepEqual(literals('const a = <Select<Option> value="v" />;', "x.tsx"), ['string:"v"']);
  });

  test("a generic arrow function in .tsx is no JSX: <T,> and <T extends U>", () => {
    assert.deepEqual(regexes("const f = <T,>(x: T) => /re/.test(String(x));", "x.tsx"), ["/re/"]);
    assert.deepEqual(regexes("const f = <T extends unknown>(x: T) => /re/;", "x.tsx"), ["/re/"]);
    assert.deepEqual(regexes("const f = <const T,>(x: T) => /re/;", "x.tsx"), ["/re/"]);
    assert.deepEqual(literals("const e = <T>(x)</T>;", "x.tsx"), ["jsx-text:(x)"]);
  });

  test("a generic function type in a .tsx type is no JSX", () => {
    const src =
      "type Same<A, B> =\n  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;\nconst e = <p>'</p>;";
    assert.deepEqual(literals(src, "x.tsx"), ["jsx-text:'"]);
  });

  test("JSX in .js files, as TypeScript reads them; never in .ts", () => {
    assert.deepEqual(literals("const a = <p>it's</p>;", "x.js"), ["jsx-text:it's"]);
    assert.deepEqual(literals("const a = <p>it;", "x.ts"), []);
  });

  test("a mismatched or unterminated JSX element fails closed", () => {
    refuses("const a = <a>\n</b>;", "bad.tsx", 2, /closing tag <\/b> for <a>/);
    refuses("const a = <a>\ntext", "bad.tsx", 1, /unterminated JSX element <a>/);
    refuses("const a = <a b=>x</a>;", "bad.tsx", 1, /attribute value/);
    refuses("const a = <a>}</a>;", "bad.tsx", 1, /in JSX text/);
  });
});

describe("js-tokens: it fails closed, naming the file and line", () => {
  test("an unterminated string", () => {
    refuses('x = 1;\ny = "abc;\n', "bad.js", 2, /unterminated string/);
    refuses("x = 'abc", "bad.js", 1, /unterminated string/);
  });

  test("an unterminated template", () => {
    refuses("x = 1;\ny = `abc${d}", "bad.js", 2, /unterminated template/);
    refuses("x = `a${b", "bad.js", 1, /left open/);
  });

  test("an unterminated comment", () => {
    refuses("x = 1;\n/* abc", "bad.js", 2, /unterminated comment/);
  });

  test("an unterminated regular expression", () => {
    refuses("x = 1;\ny = /abc\n/;", "bad.js", 2, /unterminated regular expression/);
    refuses(`y = /a${BS}`, "bad.js", 1, /unterminated regular expression/);
    refuses("y = /a[/;", "bad.js", 1, /unterminated regular expression/);
  });

  test("an invalid regular expression flag", () => {
    refuses("y = /a/gg;", "bad.js", 1, /invalid flag/);
    refuses("y = /a/x;", "bad.js", 1, /invalid flag/);
    refuses("y = /a/uv;", "bad.js", 1, /u and v/);
  });

  test("an impossible character", () => {
    refuses(`x = 1;\ny = a ${String.fromCharCode(0xa7)} b;`, "bad.js", 2, /cannot stand in code/);
    refuses(`x = a ${String.fromCharCode(0x200b)} b;`, "bad.js", 1, /cannot stand in code/);
    refuses("x = a \\ b;", "bad.js", 1, /backslash/);
    refuses("x = # b;", "bad.js", 1, /private name/);
  });

  test("brace imbalance", () => {
    refuses("function f() {\n  return 1;\n", "bad.js", 1, /left open/);
    refuses("x = 1;\n}", "bad.js", 2, /closes nothing/);
    refuses("x = (a];", "bad.js", 1, /"\]" where "\)"/);
    refuses("x = [a);", "bad.js", 1, /"\)" where "\]"/);
  });

  test("an HTML-like comment, read differently by a script and a module", () => {
    refuses("x = 1;\n<!-- note", "bad.js", 2, /HTML-like comment/);
    refuses("x = 1;\n--> note", "bad.js", 2, /HTML-like comment/);
    assert.deepEqual(regexes("x = a-->b;"), []);
  });

  test("a version-control conflict marker", () => {
    refuses("x = 1;\n<<<<<<< ours\ny = 2;", "bad.js", 2, /conflict marker/);
    refuses("x = 1;\n=======\ny = 2;", "bad.js", 2, /conflict marker/);
  });
});
