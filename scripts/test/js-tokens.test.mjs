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

  test("of outside a for head is an identifier, and divides", () => {
    assert.deepEqual(regexes("x = of / 2 / 3;"), []);
    assert.deepEqual(regexes("of / total > 1 ? f(/re/) : of / total;"), ["/re/"]);
    assert.deepEqual(regexes("x = a\nof / 2 / 3;"), []);
    assert.deepEqual(regexes("for (const of of /re/.exec(s)) {}"), ["/re/"]);
    assert.deepEqual(regexes("for ([a, b] of /re/.exec(s)) {}"), ["/re/"]);
    assert.deepEqual(regexes("for (x.y of /re/.exec(s)) {}"), ["/re/"]);
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
