// The build job's bundle checks: seams in server bundles; secret shapes, server-only markers,
// setting names, maps, refused files and third-party origins in static builds and staged release
// artefacts. Token-, address- and ID-shaped values are built at run time, so this file holds none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkArtefacts,
  checkBundles,
  checkServer,
  checkStatic,
  mapSources,
  originsIn,
  scanWork,
  urlsIn,
} from "../bundle-check.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../bundle-check.mjs", import.meta.url));

/**
 * How many characters the scanner may visit per character of a large input: every pass and
 * read-back it makes, in every reading, stays within a fixed multiple of the text's length. The
 * adversarial inputs below take under 20, and real bundles (four readings of a script, a few
 * passes each) about 30; a read-back that loses its linear bound takes thousands.
 */
const WORK_PER_CHARACTER = 64;
/**
 * The longest a work-count test may run: only a hang, never load, comes near it. The work's bound
 * is counted, not timed (linearWork).
 */
const HANG = { timeout: 600_000 };

/**
 * The origins the scanner names in a large text, asserting its work there is linear: at most
 * WORK_PER_CHARACTER characters visited per character of the text, counted by the scanner
 * (scanWork), which stops a run that passes the bound at once. Load slows a run, never adds to
 * its count, so no clock decides.
 * @param {string} text
 * @param {string} kind
 */
function linearOrigins(text, kind) {
  const { urls } = scanWork(text, { kind, limit: WORK_PER_CHARACTER * text.length });
  return [...new Set(urls.flatMap((u) => (u.origin === null ? [] : [u.origin])))];
}

/**
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} files
 */
function dirWith(t, files) {
  const dir = tempDir(t);
  writeTree(dir, files);
  return dir;
}

/**
 * The rules a static build with these files breaks.
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} files
 */
function staticRules(t, files) {
  return checkStatic("x", dirWith(t, files)).map((f) => f.rule);
}

/**
 * The third-party origins a static build with these files names.
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} files
 */
function staticOrigins(t, files) {
  return checkStatic("x", dirWith(t, files)).flatMap((f) =>
    f.rule === "third-party-origin" ? [f.message.replace(/^names /, "")] : [],
  );
}

describe("server bundles", () => {
  it("passes a release bundle", (t) => {
    const dir = dirWith(t, {
      "main.js":
        'const target = "release";\n//#region ../../packages/server/src/main.ts\nexport {};\n',
      "main.js.map": JSON.stringify({
        version: 3,
        sources: ["../../packages/server/src/main.ts"],
        sourcesContent: ["// __FIN_BUILD_TARGET__ in a comment of the original"],
      }),
    });
    assert.deepEqual(checkServer("apps/api/dist/server", dir), []);
  });

  /** @type {[string, string][]} */
  const seams = [
    ["the unreplaced build target", "if (typeof __FIN_BUILD_TARGET__ === 'string') {}"],
    ["the seam marker", 'const seam = "fin:test-seam";'],
    // A seam module's marker in a comment the bundler keeps (Vite keeps a legal comment and drops
    // a literal the module never uses), and in any other comment: a marker wherever it stands.
    ["the seam marker in a legal comment", "/*! fin:test-seam */\nexport function sink() {}"],
    ["the seam marker in a licence comment", "/** @license fin:test-seam */\nexport {};"],
    ["the seam marker in a kept line comment", "//! fin:test-seam\nexport function sink() {}"],
    ["the seam marker in a line comment", "// fin:test-seam\nexport function sink() {}"],
    ["the seam marker in a block comment", "/* fin:test-seam */export function sink() {}"],
    ["the seam marker in a regular expression", "const r = /fin:test-seam/;"],
    ["a region from packages/testing", "//#region ../../packages/testing/src/sink.ts\n"],
    ["an import of @fin/testing", 'import { sink } from "@fin/testing/sink";'],
    ["a dynamic import of @fin/testing", 'await import("@fin/testing");'],
  ];
  for (const [what, text] of seams) {
    it(`refuses ${what}`, (t) => {
      const dir = dirWith(t, { "main.js": text });
      assert.equal(checkServer("x", dir)[0]?.rule, "seam");
    });
  }

  it("refuses the harness in a real Vite 8.3.8 server bundle, by its module comment", (t) => {
    // Vite 8.3.8's output, verbatim, of `vite build --ssr src/entry.ts` for an entry that imports
    // a module of packages/testing (apps/api/src/entry.ts importing
    // ../../../packages/testing/src/sink.ts), and of the same build of an entry that imports
    // nothing: Vite writes each module's path as a `// <path>` comment, where rolldown writes
    // `//#region <path>`. bundle-check-real.test.mjs builds both with the workspace's own Vite.
    const planted =
      '// ../../packages/testing/src/sink.ts\nfunction sink(x) {\n\treturn ["fin-harness", x];\n}\n// src/entry.ts\nfunction main() {\n\treturn sink(1);\n}\nconsole.log(main());\nexport { main };\n';
    const clean =
      "// src/clean.ts\nfunction main() {\n\treturn 1;\n}\nconsole.log(main());\nexport { main };\n";
    assert.deepEqual(checkServer("x", dirWith(t, { "entry.mjs": planted })), [
      {
        file: "x/entry.mjs",
        rule: "seam",
        message: "the test harness (packages/testing) is bundled",
      },
    ]);
    assert.deepEqual(checkServer("x", dirWith(t, { "clean.mjs": clean })), []);
    // Only a module comment, or code, counts for the harness and the build target: a literal
    // holding such a line, a comment of prose that names the folder or the build target's define,
    // is no module of the harness, and no define left unreplaced.
    for (const text of [
      'const s="\\n// ../../packages/testing/src/sink.ts\\n";',
      "const s=`\n//#region ../../packages/testing/src/sink.ts\n`;",
      "// see packages/testing/src for the fakes\nexport {};",
      "/* __FIN_BUILD_TARGET__ is replaced at build time */\nexport {};",
    ]) {
      assert.deepEqual(checkServer("x", dirWith(t, { "main.js": text })), [], text);
    }
    // A seam's marker is one wherever it stands, a comment of prose included.
    const prose = "/* fin:test-seam marks a seam */\nexport {};";
    assert.deepEqual(checkServer("x", dirWith(t, { "main.js": prose })), [
      { file: "x/main.js", rule: "seam", message: "a test seam's marker" },
    ]);
  });

  it("refuses a bundle the tokenizer cannot read, never reading it in part", (t) => {
    for (const text of ["const a = `", "let a = 1 <!-- 2", "f(a"]) {
      const found = checkServer("x", dirWith(t, { "main.js": text }));
      assert.deepEqual(
        found.map((f) => f.rule),
        ["untokenized"],
        text,
      );
    }
  });

  it("reads a map's sources, not its sourcesContent, and refuses the test harness there", (t) => {
    const harness = dirWith(t, {
      "main.js.map": JSON.stringify({ sources: ["../../packages/testing/src/a.ts"] }),
    });
    assert.equal(checkServer("x", harness)[0]?.rule, "seam");
    const broken = dirWith(t, { "main.js.map": "{" });
    assert.equal(checkServer("x", broken)[0]?.rule, "map");
    assert.deepEqual(mapSources('{"sources":["a",1,"b"]}'), ["a", "b"]);
    assert.equal(mapSources('{"version":3}'), null);
  });
});

describe("static builds", () => {
  it("passes a clean build with allowed library origins", (t) => {
    const dir = dirWith(t, {
      "index.html": '<!doctype html><script type="module" src="/assets/index-abc.js"></script>',
      "assets/index-abc.js":
        'const ns="http://www.w3.org/2000/svg";const e="https://react.dev/errors/1";new URL(p,"http://localhost");a.replace(/\\/\\/+/g,"/");b.match(/\\/assets\\/(.*)/);',
      "assets/index-abc.css": "@layer ui-sdk;",
      "assets/logo (1)-Bq3x.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    assert.deepEqual(checkStatic("apps/console/dist/static", dir), []);
  });

  it("refuses a third-party origin in HTML, CSS or JavaScript", (t) => {
    /** @type {[string, string][]} */
    const cases = [
      ["index.html", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2">'],
      ["assets/a.css", "@font-face{src:url(https://cdn.example.net/f.woff2)}"],
      ["assets/a.js", 'fetch("https://api.example.com/v1")'],
    ];
    for (const [file, text] of cases) {
      assert.deepEqual(staticRules(t, { [file]: text }), ["third-party-origin"], file);
    }
  });

  it("refuses an origin however a build spells it", (t) => {
    /** @type {[string, string, string][]} */
    const cases = [
      [
        "a protocol-relative script",
        "index.html",
        '<script src="//cdn.evil.example/x.js"></script>',
      ],
      [
        "an unquoted protocol-relative attribute",
        "index.html",
        "<img src=//cdn.evil.example/a.png>",
      ],
      ["a protocol-relative CSS import", "assets/a.css", "@import url(//fonts.example/css);"],
      ["an upper-case scheme", "assets/a.js", 'fetch("HTTPS://tracker.example/p")'],
      ["a WebSocket", "assets/a.js", 'new WebSocket("wss://collector.example.net/s")'],
      ["a plain WebSocket", "assets/a.js", 'new WebSocket("ws://collector.example.net/s")'],
      ["JSON-escaped slashes", "assets/a.json", '{"u":"https:\\/\\/tracker.example/p"}'],
      ["unicode-escaped slashes", "assets/a.js", 'fetch("https:\\u002f\\u002ftracker.example/p")'],
      ["a port", "assets/a.js", 'fetch("http://localhost:3000/x")'],
      // Every value that loads or navigates: a button's form action and a video's poster too.
      ["a button's formaction", "index.html", "<button formaction=//evil.example/x>go</button>"],
      ["a video's poster", "index.html", '<video poster="//evil.example/p.png"></video>'],
      ["a written poster", "assets/a.js", "e.innerHTML='<video poster=//evil.example/p.png>';"],
      ["a formAction prop", "assets/a.js", 'jsx("button",{formAction:"//evil.example/x"})'],
      ["a poster property", "assets/a.js", "v.poster=`//evil.example/p.png`"],
    ];
    for (const [what, file, text] of cases) {
      assert.ok(staticRules(t, { [file]: text }).includes("third-party-origin"), what);
    }
  });

  it("refuses a URL whose user name makes an allowed host the one it seems to name", (t) => {
    const found = staticRules(t, {
      "assets/a.js": 'fetch("https://react.dev@collector.evil.example.net/beacon")',
    });
    assert.ok(found.includes("url-userinfo") && found.includes("third-party-origin"), found.join());
    assert.deepEqual(
      urlsIn("https://react.dev@collector.evil.example.net/x").map((u) => u.origin),
      ["https://collector.evil.example.net"],
    );
  });

  it("reads a URL's host as a browser does, whatever ends the scanner's reading early", (t) => {
    const nl = String.fromCharCode(10);
    /** @type {[string, string, string][]} */
    const cases = [
      ["a user name cut by (", "assets/a.js", 'location="https://react.dev(1)@evil.example/c"'],
      ["a user name cut by {", "assets/a.js", 'x="https://www.w3.org{x}@evil.example/"'],
      [
        "a user name cut by ^",
        "assets/a.css",
        "a{background:url(https://react.dev^@evil.example/p.png)}",
      ],
      [
        "a user name cut by a space",
        "index.html",
        '<a href="https://react.dev @evil.example/">x</a>',
      ],
      ["a user name cut by |", "assets/a.js", 'x="https://react.dev|@evil.example/"'],
      [
        "a user name behind an escaped quote",
        "assets/a.js",
        'x="https://react.dev\\"@evil.example/"',
      ],
      ["a user name behind an escape", "assets/a.js", 'x="https://react.dev\\u0040evil.example/"'],
      [
        "a user name with a comma in CSS",
        "assets/a.css",
        "a{b:url(https://react.dev,@evil.example/p.png)}",
      ],
      [
        "a new line in the host",
        "index.html",
        `<script src="https://www.w3.org${nl}.evil.example/x.js"></script>`,
      ],
      [
        "a tab escape in the host",
        "assets/a.js",
        'import("https://react.dev\\t.evil.example/x.js")',
      ],
      ["a tab in the scheme", "assets/a.js", 'fetch("ht\\ttps://evil.example/c")'],
      ["JSON-escaped protocol-relative slashes", "assets/a.json", '{"u":"\\/\\/evil.example\\/c"}'],
      ["three slashes", "index.html", '<script src="///evil.example/x.js"></script>'],
      ["a slash and a backslash", "index.html", '<script src="/\\evil.example/x.js"></script>'],
      ["two backslashes", "assets/a.js", 'fetch("\\\\\\\\evil.example/c")'],
      ["an empty user name", "index.html", '<script src="//@evil.example/x.js"></script>'],
      [
        "srcset's second candidate",
        "index.html",
        '<img srcset="/a.png 1x, //evil.example/b.png 2x">',
      ],
      [
        "srcset's absolute candidate with a comma",
        "index.html",
        '<img srcset="/a.png 1x, https://react.dev,@evil.example/b.png 2x">',
      ],
      ["a scheme with no slashes", "assets/a.js", 'new WebSocket("wss:evil.example/c")'],
      ["backslashes after the scheme", "assets/a.js", 'fetch("https:\\\\\\\\evil.example/c")'],
      [
        "HTML character references",
        "index.html",
        '<script src="https:&#x2f;&#x2f;evil.example/x.js"></script>',
      ],
      [
        "named character references",
        "index.html",
        '<a href="https&colon;&sol;&sol;evil.example/">x</a>',
      ],
      ["braced unicode escapes", "assets/a.js", 'fetch("https:\\u{2f}\\u{2f}evil.example/c")'],
      ["CSS escapes", "assets/a.css", "a{b:url(https:\\2f\\2f evil.example/p.png)}"],
      ["an XHTML page", "page.xhtml", '<script src="https://evil.example/x.js"></script>'],
      ["an unknown extension", "assets/a.data", 'fetch("https://evil.example/c")'],
      // What the URL parser strips before a URL (every C0 control and the space).
      ["a vertical tab first", "assets/a.js", 'fetch("\\v//evil.example/x")'],
      ["a control before wss: alone", "assets/a.js", 'new WebSocket("\\x01wss:evil.example")'],
      [
        "a control before a user name cut by a comma",
        "assets/a.js",
        'fetch("\\x1fhttps://react.dev,@evil.example/p")',
      ],
      ["a control spelled in HTML", "index.html", '<img src="&#x0B;//evil.example/a.png">'],
      ["a control spelled in CSS", "assets/a.css", 'a{background:url("\\b //evil.example/a.png")}'],
      ["a raw control", "assets/a.js", `fetch("${String.fromCharCode(2)}//evil.example/x")`],
      ["a NUL escape", "assets/a.js", 'fetch("\\0//evil.example/x")'],
      ["a NUL hex escape", "assets/a.js", 'fetch("\\x00//evil.example/x")'],
      ["a NUL unicode escape", "assets/a.js", 'fetch("\\u0000//evil.example/x")'],
      ["a classic script's octal escape", "assets/a.js", 'fetch("\\37//evil.example/x")'],
      [
        "a control before a srcset candidate",
        "index.html",
        '<img srcset="/a.png 1x, &#x1;//evil.example/b.png 2x">',
      ],
      // Escapes and references with leading zeros past the usual widths.
      [
        "a braced escape with leading zeros",
        "assets/a.js",
        'fetch("\\u{000000002f}\\u{000000002f}evil.example/c")',
      ],
      [
        "a decimal reference with leading zeros",
        "index.html",
        '<script src="&#0000000047;&#0000000047;evil.example/x.js"></script>',
      ],
      [
        "a hex reference with leading zeros",
        "index.html",
        '<script src="https:&#x000000002f;&#x000000002f;evil.example/x.js"></script>',
      ],
      // A user name long enough to have run past the scanner's old bound.
      [
        "a long user name",
        "assets/a.js",
        `location.href="https://${"a".repeat(511)}@evil.example/c"`,
      ],
    ];
    for (const [what, file, text] of cases) {
      const found = staticRules(t, { [file]: text });
      assert.ok(
        found.includes("third-party-origin") || found.includes("url-userinfo"),
        `${what}: ${found.join()}`,
      );
    }
    assert.ok(
      staticRules(t, { LICENSE: "FIN_SESSION_SECRET" }).includes("setting-name"),
      "an extensionless file",
    );
  });

  it("reads a URL's end as a browser does: what the URL parser strips after it is dropped", (t) => {
    const control = String.fromCharCode(1);
    /** @type {[string, string, string][]} */
    const cases = [
      ["a space", "assets/a.js", 'fetch("https://evil.example ")'],
      ["a control escape", "assets/a.js", 'fetch("https://evil.example\\x01")'],
      ["a NUL escape", "assets/a.js", 'new WebSocket("wss://evil.example\\x00")'],
      ["a form feed escape", "assets/a.js", 'new Image().src="https://evil.example\\f"'],
      ["a vertical tab escape", "assets/a.js", 'new Image().src="https://evil.example\\v"'],
      ["a raw control", "assets/a.js", `fetch("https://evil.example${control}")`],
      ["a protocol-relative URL", "assets/a.js", 'fetch("//evil.example ")'],
      ["a quoted attribute", "index.html", '<iframe src="https://evil.example "></iframe>'],
      ["a single-quoted link", "index.html", "<link rel=stylesheet href='//evil.example '>"],
      ["a reference in an unquoted attribute", "index.html", "<img src=https://evil.example&#12;>"],
      ["a srcset candidate", "index.html", '<img srcset="//evil.example&#1; 1x">'],
      ["a quoted url(", "assets/a.css", 'a{background:url("https://evil.example\\1 ")}'],
      ["an unquoted url(", "assets/a.css", "a{background:url(https://evil.example\\1 )}"],
      ["a CSS import", "assets/a.css", '@import "//evil.example ";'],
    ];
    for (const [what, file, text] of cases) {
      const found = staticRules(t, { [file]: text });
      assert.ok(found.includes("third-party-origin"), `${what}: ${found.join()}`);
    }
  });

  it("reads white space after a protocol-relative URL's slashes as the URL's own", (t) => {
    /** @type {[string, string, string][]} */
    const cases = [
      ["a space before a user name", "assets/a.js", 'location.href="// @evil.example/c";'],
      ["a vertical tab before a user name", "assets/a.js", 'location.href="//\\v@evil.example/c";'],
      [
        "a no-break space before a user name",
        "assets/a.js",
        'location.href="//\\xa0@evil.example/c";',
      ],
      [
        "a referenced space before a user name",
        "index.html",
        '<a href="//&#32;@evil.example/">x</a>',
      ],
      ["a space before a user name in markup", "index.html", '<img src="// @evil.example/p.png">'],
      [
        "a space before a user name in CSS",
        "assets/a.css",
        'a{background:url("// @evil.example/p.png")}',
      ],
      [
        "a byte order mark before the host",
        "assets/a.js",
        'new Image().src="//\\uFEFFevil.example/c1.png";',
      ],
      [
        "a referenced byte order mark",
        "index.html",
        '<script src="//&#xFEFF;evil.example/c2.js"></script>',
      ],
    ];
    for (const [what, file, text] of cases) {
      const found = staticRules(t, { [file]: text });
      assert.ok(
        found.includes("third-party-origin") || found.includes("url-userinfo"),
        `${what}: ${found.join()}`,
      );
    }
    // A comment in a string names no host a browser could load.
    assert.deepEqual(staticRules(t, { "assets/a.js": 'x="// a note";' }), []);
  });

  it("ends an unquoted value only where a browser does, not at other white space", (t) => {
    // Characters JavaScript counts as white space that a browser keeps inside a URL's user name.
    /** @type {[string, string, string][]} */
    const spaces = [
      ["a vertical tab", "\u{b}", "\\v"],
      ["a no-break space", "\u{a0}", "\\xa0"],
      ["a line separator", "\u{2028}", "\\u2028"],
      ["a byte order mark", "\u{feff}", "\\ufeff"],
      ["an ideographic space", "\u{3000}", "\\u3000"],
    ];
    const css = new Map([
      ["\u{b}", "\\b "],
      ["\u{a0}", "\\a0 "],
      ["\u{2028}", "\\2028 "],
      ["\u{feff}", "\\feff "],
      ["\u{3000}", "\\3000 "],
    ]);
    for (const [what, c, js] of spaces) {
      /** @type {[string, string, string][]} */
      const cases = [
        [
          "an unquoted attribute",
          "index.html",
          `<img src=https://react.dev${c}@evil.example/p.png>`,
        ],
        [
          "an unquoted protocol-relative attribute",
          "index.html",
          `<img src=//react.dev${c}@evil.example/p.png>`,
        ],
        [
          "a written attribute",
          "assets/a.js",
          `e.innerHTML='<img src=https://react.dev${js}@evil.example/p.png>';`,
        ],
        [
          "a written protocol-relative attribute",
          "assets/a.js",
          `e.innerHTML='<img src=//react.dev${js}@evil.example/p.png>';`,
        ],
        [
          "a CSS escape in url(",
          "assets/a.css",
          `a{background:url(//react.dev${css.get(c)}@evil.example/p.png)}`,
        ],
        [
          "srcset's second candidate",
          "index.html",
          `<img srcset="/a.png 1x, //react.dev${c}@evil.example/b.png 2x">`,
        ],
      ];
      // A raw vertical tab makes CSS's url( a bad URL, which loads nothing.
      if (c !== "\u{b}") {
        cases.push([
          "url( as written",
          "assets/a.css",
          `a{background:url(https://react.dev${c}@evil.example/p.png)}`,
        ]);
      }
      for (const [where, file, text] of cases) {
        const found = staticRules(t, { [file]: text });
        assert.ok(found.includes("url-userinfo"), `${what} in ${where}: ${found.join()}`);
      }
    }
  });

  it("drops a tab or new line a reference or a CSS escape spells, wherever the URL is", (t) => {
    /** @type {[string, string, string][]} */
    const cases = [
      [
        "a CSS tab escape",
        "assets/a.css",
        "a{background:url(https://react.dev\\9 .evil.example/a.png)}",
      ],
      [
        "a CSS new line escape",
        "assets/a.css",
        "a{background:url(//react.dev\\a .evil.example/a.png)}",
      ],
      [
        "tab references in the host and the port",
        "index.html",
        "<script src=https://react.dev&Tab;.evil.example:44&Tab;3/x.js></script>",
      ],
      ["a new line reference", "index.html", "<img src=https://react.dev&#10;.evil.example/p.png>"],
      [
        "a written tab reference",
        "assets/a.js",
        "e.innerHTML='<img src=https://react.dev&Tab;.evil.example/p.png>';",
      ],
    ];
    for (const [what, file, text] of cases) {
      const found = staticRules(t, { [file]: text });
      assert.ok(found.includes("third-party-origin"), `${what}: ${found.join()}`);
    }
  });

  it("reads a quote in a URL both as its end and as part of it", (t) => {
    /** @type {[string, string, string][]} */
    const cases = [
      // The script's own string ends at the quote: the host is what came before it.
      ["a host then code", "assets/a.js", "e.innerHTML='<img src=https://evil.example'+t[0]+'>';"],
      [
        "a host then a bitwise or",
        "assets/a.js",
        "e.innerHTML='<img src=https://evil.example'+(a|b)+'>';",
      ],
      [
        "a double-quoted string",
        "assets/a.js",
        'e.innerHTML="<img src=https://evil.example"+n[1]+">";',
      ],
      [
        "a protocol-relative host then code",
        "assets/a.js",
        "e.innerHTML='<img src=//evil.example'+t[0]+'>';",
      ],
      // A value opened by one spelling of a quote and closed by the other.
      [
        "a raw quote closed by an escape",
        "assets/a.js",
        "e.innerHTML='<img src=\"https://evil.example\\\" alt=x>';",
      ],
      [
        "a protocol-relative URL so closed",
        "assets/a.js",
        "e.innerHTML='<img src=\"//evil.example\\\" alt=d1>';",
      ],
      [
        "an escaped quote closed raw",
        "assets/a.js",
        "e.innerHTML='<img src=\\x22http://evil.example\" alt=d2>';",
      ],
      // The quote is the value's: the user name holds it.
      [
        "a quote in a user name",
        "assets/a.js",
        "e.innerHTML='<img src=https://react.dev\"@evil.example/p.png>';",
      ],
      ["a lower label holding a quote", "assets/a.js", 'fetch("https://\'x.evil.example/c")'],
    ];
    for (const [what, file, text] of cases) {
      const found = staticRules(t, { [file]: text });
      assert.ok(
        found.includes("third-party-origin") || found.includes("url-userinfo"),
        `${what}: ${found.join()}`,
      );
    }
    // An allowed host the script's string ends after: the rest is built at run time.
    for (const text of [
      "e.innerHTML='<img src=https://react.dev/'+t+'>';",
      "e.innerHTML='<img src=https://react.dev'+t+'>';",
      "e.innerHTML='<a href=\"https://react.dev'+x+'\">';",
    ]) {
      assert.deepEqual(staticRules(t, { "assets/a.js": text }), [], text);
    }
  });

  it("reads every srcset candidate, and a user name past a URL's guessed end", (t) => {
    /** @type {[string, string, string][]} */
    const cases = [
      ["an unquoted srcset", "index.html", "<img srcset=/a.png&#32;1x,&#32;//evil.example/b.png>"],
      [
        "a written unquoted srcset",
        "assets/a.js",
        "e.innerHTML='<img srcset=/a.png&#32;1x,&#32;//evil.example/b.png>';",
      ],
      [
        "a srcset set from a string",
        "assets/a.js",
        'i.setAttribute("srcset","/a.png 1x, //evil.example/b.png 2x")',
      ],
      ["React's srcSet", "assets/a.js", 'jsx("img",{srcSet:"/a.png, //evil.example/b.png 2x"})'],
      [
        "a refresh's URL",
        "index.html",
        '<meta http-equiv="refresh" content="0;https://react.dev,@evil.example/">',
      ],
      [
        "a srcset's absolute candidate",
        "assets/a.js",
        'jsx("img",{srcSet:"/a.png 1x, https://react.dev,@evil.example/b.png 2x"})',
      ],
      // A later candidate a script sets, whatever the candidates before it look like.
      [
        "a candidate after two with no descriptor",
        "assets/a.js",
        'jsx("img",{srcSet:"/a.png, /b.png, //evil.example/c.png 3x"})',
      ],
      [
        "a candidate set after two",
        "assets/a.js",
        'i.setAttribute("srcset","/a.png 1x, /b.png, //evil.example/c.png 3x")',
      ],
      [
        "white space before the first candidate",
        "assets/a.js",
        'jsx("img",{srcSet:" /a.png, //evil.example/c.png 2x"})',
      ],
      [
        "a template literal over several lines",
        "assets/a.js",
        'jsx("img",{srcSet:`\n  /a.png,\n  //evil.example/b.png 2x\n`})',
      ],
      [
        "a descriptor with an exponent",
        "assets/a.js",
        'jsx("img",{srcSet:"/a.png 1e1x, //evil.example/c.png 2x"})',
      ],
      [
        "an absolute candidate after two",
        "assets/a.js",
        `jsx("img",{srcSet:"/a.png, /b.png, https://react.dev'@evil.example/c.png 3x"})`,
      ],
      [
        "a substitution in a candidate with a descriptor",
        "assets/a.js",
        `jsx("img",{srcSet:\`${"$"}{b}/a.png 1x, //evil.example/b.png 2x\`})`,
      ],
      [
        "a substitution in a candidate with no descriptor",
        "assets/a.js",
        `jsx("img",{srcSet:\`${"$"}{b}/a.png, //evil.example/b.png 2x\`})`,
      ],
      // A list a srcset key opens is read whole, whatever its candidates hold: a bracket, a
      // semicolon, a helper call or a condition, and descriptors built at run time or misspelled.
      [
        "a bracket in the first candidate",
        "assets/a.js",
        'jsx("img",{srcSet:"/hero(1).png, //evil.example/b.png 2x"})',
      ],
      [
        "a semicolon in the first candidate",
        "assets/a.js",
        'jsx("img",{srcSet:"/a.png;v=2, //evil.example/b.png 2x"})',
      ],
      [
        "a helper call in the first candidate",
        "assets/a.js",
        `jsx("img",{srcSet:\`${"$"}{asset("a.png")}, //evil.example/b.png 2x\`})`,
      ],
      [
        "a helper call as the minifier prints it",
        "assets/a.js",
        `jsx("img",{srcSet:\`${"$"}{asset(\`a.png\`)}, //evil.example/b.png 2x\`})`,
      ],
      [
        "a condition in the first candidate",
        "assets/a.js",
        `jsx("img",{srcSet:\`${"$"}{dark?"/d.png":"/l.png"}, //evil.example/b.png 2x\`})`,
      ],
      [
        "a descriptor built at run time",
        "assets/a.js",
        `jsx("img",{srcSet:\`/a.png 1x, /b.png ${"$"}{x}x, //evil.example/c.png 3x\`})`,
      ],
      [
        "a density built at run time after a substitution",
        "assets/a.js",
        `jsx("img",{srcSet:\`${"$"}{base}/a.png ${"$"}{dpr}x, //cdn.evil.example/b.png 2x\`})`,
      ],
      [
        "a width built at run time",
        "assets/a.js",
        `jsx("img",{srcSet:\`${"$"}{a} ${"$"}{w}w, //cdn.evil.example/x.png 800w\`})`,
      ],
      [
        "a misspelled density",
        "assets/a.js",
        'jsx("img",{srcSet:"/a.png 2X, //evil.example/b.png 2x"})',
      ],
      [
        "a misspelled width",
        "assets/a.js",
        'i.setAttribute("srcset","/a.png 100px, //evil.example/b.png 200w")',
      ],
      [
        "a property the minifier prints with backticks",
        "assets/a.js",
        "i.srcset=`/a.png, //evil.example/b.png 2x`",
      ],
      [
        "setAttribute as the minifier prints it",
        "assets/a.js",
        "i.setAttribute(`srcset`,`/a.png, //evil.example/b.png 2x`)",
      ],
      // A helper that takes the element or a namespace first names the list in a later argument
      // (Svelte's attr, Solid's setAttribute, the DOM's setAttributeNS).
      [
        "a helper's later argument, a bracket in the first candidate",
        "assets/a.js",
        "attr(e,'srcset','/hero(1).png, //evil.example/b.png 2x')",
      ],
      [
        "a helper's later argument, a semicolon in the first candidate",
        "assets/a.js",
        "setAttribute(e,'srcset','/a.png;v=2, //evil.example/b.png 2x')",
      ],
      [
        "setAttributeNS, a misspelled descriptor",
        "assets/a.js",
        "i.setAttributeNS(null,'srcset','/a.png foo, //evil.example/b.png')",
      ],
      [
        "a helper's later argument in backticks, imagesrcset",
        "assets/a.js",
        "attr(l,`imagesrcset`,`/hero(1).png, //evil.example/b.png 2x`)",
      ],
      ["a JSON key", "assets/a.json", '{"srcSet":"/a.png, //evil.example/b.png 2x"}'],
      [
        "a JSON key whose quotes an escape spells",
        "assets/a.js",
        'x=JSON.parse("{\\"srcset\\":\\"/hero(1).png, //evil.example/b.png 2x\\"}")',
      ],
      // A list no key opens: a later candidate after a descriptor.
      [
        "a condition's branch",
        "assets/a.js",
        'jsx("img",{srcSet:d?"/a.png 1x, //evil.example/b.png 2x":"/l.png"})',
      ],
      [
        "a constant with a descriptor built at run time",
        "assets/a.js",
        `const s=\`/a.png ${"$"}{d}x, //evil.example/b.png 2x\`;`,
      ],
      // A list a string holds, no key opening it: read back to the quote that opens the string,
      // whatever descriptors its candidates have, none (the usual 1x) or misspelled ones.
      [
        "a condition's first branch, as JSX's minifies",
        "assets/a.js",
        'jsx("img",{srcSet:d?"/a.png, //evil.example/b.png 2x":"/l.png"})',
      ],
      [
        "a condition's other branch",
        "assets/a.js",
        'jsx("img",{srcSet:d?"/l.png":"/a.png, //evil.example/b.png 2x"})',
      ],
      [
        "a condition's branch in backticks",
        "assets/a.js",
        "jsx(`img`,{srcSet:d?`/a.png, //evil.example/b.png 2x`:`/l.png`})",
      ],
      ["a guard", "assets/a.js", 'jsx("img",{srcSet:d&&"/a.png, //evil.example/b.png 2x"})'],
      [
        "a default",
        "assets/a.js",
        'jsx("img",{srcSet:p.srcSet??"/a.png, //evil.example/b.png 2x"})',
      ],
      [
        "a property set from a condition",
        "assets/a.js",
        'i.srcset=d?"/a.png, //evil.example/b.png 2x":"/l.png"',
      ],
      [
        "a hoisted constant",
        "assets/a.js",
        'const H="/hero.png, //evil.example/hero-2x.png 2x";function A(){return jsx("img",{srcSet:H})}',
      ],
      [
        "a hoisted constant in backticks with a substitution",
        "assets/a.js",
        `const H=\`${"$"}{b}/hero.png, //evil.example/hero-2x.png 2x\`;`,
      ],
      [
        "an object of images",
        "assets/a.js",
        'const I={hero:"/hero.png, //evil.example/hero-2x.png 2x"};',
      ],
      ["a bracketed key", "assets/a.js", 'i["srcset"]="/a.png, //evil.example/b.png 2x"'],
      [
        "a helper's argument",
        "assets/a.js",
        'jsx("img",{srcSet:pick("/a.png, //evil.example/b.png 2x")})',
      ],
      ["a returned list", "assets/a.js", 'function f(){return"/a.png, //evil.example/b.png 2x"}'],
      [
        "a middle candidate with no descriptor",
        "assets/a.js",
        'jsx("img",{srcSet:d?"/a.png 1x, /b.png, //evil.example/c.png 2x":"/l.png"})',
      ],
      [
        "two candidates with no descriptor",
        "assets/a.js",
        'jsx("img",{srcSet:c?"/a.png, /b.png, //evil.example/c.png 3x":"/l.png"})',
      ],
      [
        "a misspelled density in a condition",
        "assets/a.js",
        'jsx("img",{srcSet:c?"/a.png 2X, //evil.example/b.png 2x":"/l.png"})',
      ],
      [
        "a misspelled width in a constant",
        "assets/a.js",
        'const S="/a.png 100px, //evil.example/b.png 200w";',
      ],
    ];
    for (const [what, file, text] of cases) {
      const found = staticRules(t, { [file]: text });
      assert.ok(
        found.includes("third-party-origin") || found.includes("url-userinfo"),
        `${what}: ${found.join()}`,
      );
    }
    // No list: code, a quote right before the comma (a string's end), prose, and a regular
    // expression after a comma and a string's end, as real libraries minify it (prettier 3.10.1's
    // plugins, a pattern string) and in the backticks the minifier prints, the string's text
    // ending as an opening quote's code may (`(`, `?`) or the code after it starting with a word.
    for (const text of [
      'jsx("img",{srcSet:"/a.png 1x, /b.png 2x"})',
      "e.srcset=t.srcset,e.sizes=n;x=/\\/\\//.test(b);",
      "a=[1, //evil.example/x\n2]",
      'f("a", //evil.example/x\nb)',
      'x="see the docs, //evil.example/x";',
      'if(C[0]===""){if(C.shift(),/\\n/.test(C[0])){let y=1}}',
      `k(0,k(0,t,"'",'"'),/\\\\([^\\da-f])/gi,"$1")`,
      'x="^([^\\\\\\\\s].*)\\\\\\\\((\\\\\\\\d+,\\\\\\\\d+)";',
      'n=e.indexOf("x"),/\\//.test(n)&&f();',
      "n=e.indexOf(`x`),/\\//.test(n)&&f();",
      "let t=e.trim(),n=t.split(`\\n`),/\\r/.test(t)&&n.pop();",
      "t=e.replace(`a`,`b`),/\\/\\/cdn\\.example\\.com\\//.test(t)&&g(t);",
      'm=[[q("a"),/\\/v1\\//],[q("b"),/\\/v2\\//]]',
      'routes.push(route("about"), //about page\n0)',
      'x="a"+b,/\\n/.test(x)',
      // React's attribute table: a srcset key whose list names no URL.
      'r={srcSet:"srcset",imageSrcSet:"imagesrcset"};',
      'e="("+t,/\\//.test(e)',
      'e="?".length,/\\//.test(e)',
      'e="("in t,/\\//.test(e)',
      'f("(",a,b,/\\//)',
      'x="a,b".split(","),/\\//.test(x)',
      'x="Hello, world, and more, //evil.example/x";',
      // Code in a string, a bracket in it: no candidate holds one where no key opens the list.
      'x="f(x), //note";',
      `x=\`${"$"}{name}(${"$"}{args}), //eslint-disable-line\`;`,
      'x="f(x), //cdn.example.org/a";',
      'x="see (the docs), //evil.example/x";',
      'a=f(y),/\\//.test(z);x="q",g(h),/\\/a\\//.test(b);',
      // A later argument that only names a srcset in prose is no key: the code after it is code.
      'log(e,"bad srcset:",v);/\\//.test(v)&&w();',
      'log(e,"the srcset list",v),/\\//.test(v)&&w();',
    ]) {
      assert.deepEqual(staticRules(t, { "assets/a.js": text }), [], text);
    }
  });

  it("refuses a host the scanner reads but a URL parser refuses, never passing it", (t) => {
    assert.deepEqual(staticRules(t, { "assets/a.js": 'fetch("https://evil.example^x/c")' }), [
      "url-unparsed",
    ]);
    // A host built at run time, one with no letter or digit, a comment: no host to read.
    for (const text of [
      'x="http://["+h+"]:"+p;',
      `fetch(\`https://${"$"}{host}^x/c\`);`,
      'x="// note: see the docs";',
    ]) {
      assert.deepEqual(staticRules(t, { "assets/a.js": text }), [], text);
    }
  });

  it("reads two slashes or backslashes with no scheme as a URL only where they name a host", (t) => {
    const bs = (/** @type {number} */ n) => "\\".repeat(n);
    // With no scheme, a host no URL parser takes loads nothing (the browser's parser is the same
    // one), and backslashes alone name a host only where it has a dot or is an IP address. A
    // pattern in a string starts so: a highlighter's grammar (two of @scalar/code-highlight's
    // rules as the minifier prints them, a line comment's pattern, a string's), a bytea escape,
    // an escape table.
    for (const text of [
      `const g=[{match:\`${bs(4)}(?:u[0-9a-fA-F]{4}|["${bs(4)}/bfnrt])\`,scope:\`string.escape\`}];`,
      `const g=[{match:\`${bs(6)}s+${bs(4)}\`,scope:\`string.escape\`}];`,
      `const g={match:\`//[^${bs(2)}n]*\`,scope:\`comment\`};`,
      `const g={match:\`"(?:[^"${bs(6)}r${bs(2)}n]|${bs(4)}.)*"\`,scope:\`string\`};`,
      `function b(e){return\`${bs(4)}x\`+e.toString(\`hex\`)}`,
      `const E={'${bs(1)}n':\`${bs(4)}n\`,'${bs(1)}r':\`${bs(4)}r\`,'${bs(1)}t':\`${bs(4)}t\`};`,
      `const r=new RegExp("${bs(4)}d+");`,
      'fetch("//evil.example^x/c");',
    ]) {
      assert.deepEqual(staticRules(t, { "assets/a.js": text }), [], text);
    }
    /** @type {[string, string][]} */
    const cases = [
      ["a host with a dot", `a.href="${bs(4)}evil.example${bs(2)}x";`],
      ["an IPv4 address as one number", `a.href="${bs(4)}3221225985${bs(2)}x";`],
      ["an IPv6 address", `a.href="${bs(4)}[2001:db8::1]${bs(2)}x";`],
      ["a slash and a backslash", `a.href="/${bs(2)}evil${bs(2)}x";`],
    ];
    for (const [what, text] of cases) {
      const found = staticRules(t, { "assets/a.js": text });
      assert.deepEqual(found, ["third-party-origin"], `${what}: ${found.join()}`);
    }
    // So in a srcset: a candidate of backslashes alone names a host only where it has a dot.
    assert.deepEqual(
      staticRules(t, { "index.html": `<img srcset="${bs(2)}evil${bs(1)}x.png 2x">` }),
      [],
    );
    assert.deepEqual(
      staticRules(t, { "index.html": `<img srcset="${bs(2)}evil.example${bs(1)}x.png 2x">` }),
      ["third-party-origin"],
    );
  });

  it("reads an unquoted attribute in markup a script writes", (t) => {
    /** @type {[string, string][]} */
    const cases = [
      ["an image", "e.innerHTML='<img src=//collector.evil.example/p.png>';"],
      ["a script", 'e.innerHTML="<script src=//collector.evil.example/x.js></script>";'],
      [
        "a stylesheet",
        "document.write('<link rel=stylesheet href=//collector.evil.example/a.css>');",
      ],
      ["a slash after the tag's name", "e.innerHTML='<img/src=//collector.evil.example/p.png>';"],
      [
        "a quoted value holding >",
        "e.innerHTML='<img alt=\"a>b\" src=//collector.evil.example/p.png>';",
      ],
      [
        "escaped quotes and slashes",
        "e.innerHTML='<img alt=\\'x\\' src=\\x2f\\x2fcollector.evil.example/p.png>';",
      ],
      [
        "an absolute URL cut by a comma",
        "e.innerHTML='<a href=https://react.dev,@evil.example/>';",
      ],
      // A character a reference spells is text to the tokenizer: it quotes nothing, ends no tag.
      [
        "a referenced quote before it",
        "e.innerHTML='<img alt=&quot;x src=&#47;/evil.example/p.png>';",
      ],
      ["a referenced > as a value", "e.innerHTML='<img alt=&gt; src=&#47;/evil.example/p.png>';"],
      ["a referenced > as a name", "e.innerHTML='<img &gt; src=&#47;/evil.example/p.png>';"],
      [
        "a referenced apostrophe",
        'e.innerHTML="<img title=&apos; src=&sol;&sol;evil.example/a4.png>";',
      ],
      // A template literal's substitution ends no tag, whatever it holds.
      [
        "a > in a substitution",
        `e.innerHTML=\`<img ${"$"}{a>b?"x":"y"} src=//evil.example/p.png>\`;`,
      ],
      // What looks like a substitution is read as text too: a `${` in a plain string, or one whose
      // braces pair with the wrong `}`, hides no attribute after it.
      [
        "a dollar-brace in a quoted value",
        `function f(){e.innerHTML='<img alt="${"$"}{" src=//evil.example/p.png>'}`,
      ],
      [
        "a dollar-brace as a name",
        `function f(){e.innerHTML='<img ${"$"}{ src=//evil.example/p.png>'}`,
      ],
      [
        "a brace in a string in a substitution",
        `function f(){e.innerHTML=\`<img ${"$"}{a?"{":""} src=//evil.example/p.png>\`}`,
      ],
      [
        "a dollar-brace before a user name",
        `function f(){e.innerHTML='<img ${"$"}{ src=https://react.dev\\x22@evil.example/p.png>'}`,
      ],
      [
        "a dollar-brace before a host then code",
        `function f(){e.innerHTML='<img ${"$"}{ src=//evil.example'+t+'>'}`,
      ],
      [
        "a dollar-brace with a later brace",
        `e.innerHTML='<img ${"$"}{ src=//evil.example/p.png>';x='}';`,
      ],
      [
        "an unbalanced brace in a substitution",
        `function f(){e.innerHTML=\`<img ${"$"}{"{"} src=//evil.example/p.png>\`}`,
      ],
      [
        "a brace in a regular expression in a substitution",
        `function f(a){e.innerHTML=\`<img alt=${"$"}{a.replace(/{/g,'')} src=//evil.example/p.png>\`}`,
      ],
      [
        "an escaped dollar-brace in a template",
        `function f(){e.innerHTML=\`<img \\${"$"}{ src=//evil.example/p.png>\`}`,
      ],
      [
        "an unquoted srcset after a dollar-brace",
        `function f(){e.innerHTML='<img ${"$"}{ srcset=//evil.example/p.png>'}`,
      ],
      [
        "a substitution that may close the quote",
        `e.innerHTML=\`<img alt="${"$"}{q} src=//evil.example/p.png>\`;`,
      ],
      [
        "an unbalanced brace as a value",
        `function f(e){e.innerHTML=\`<img alt=${"$"}{"{"} src=//evil.example/p.png>\`}`,
      ],
      [
        "a dollar-brace as an unquoted value",
        `function f(e){e.innerHTML='<img alt=${"$"}{ src=//evil.example/p.png>'}`,
      ],
      [
        "a dollar-brace as a double-quoted string's value",
        `function f(e){e.innerHTML="<img title=${"$"}{ src=//evil.example/p.png>"}`,
      ],
      [
        "a dollar-brace with no closing brace",
        `e.innerHTML='<img ${"$"}{ src=//evil.example/p.png>';`,
      ],
      ["a balanced substitution", `e.innerHTML=\`<img ${"$"}{a} src=//evil.example/p.png>\`;`],
      // The script's own string delimiter is no attribute's quote: the tag goes on in the next
      // string, after a value built at run time.
      [
        "a value built at run time, then a double-quoted string",
        `e.innerHTML='<img alt='+x+" src=//evil.example/p.png>";`,
      ],
      [
        "a value built at run time, then a single-quoted string",
        `e.innerHTML="<img alt="+x+' src=//evil.example/p.png title="a">';`,
      ],
      ["a tag's name ending its string", `e.innerHTML="<img"+" src=//evil.example/p.png>";`],
      ["the same delimiter twice", `e.innerHTML="<img alt="+x+" src=//evil.example/p.png>";`],
      // A brace in a string or a regular expression in a substitution, and a `>` in its code (an
      // arrow function, a comparison): its `}` is the one a JavaScript lexer pairs it with.
      [
        "an arrow function and a brace in a regular expression",
        `function f(a){e.innerHTML=\`<img alt=${"$"}{a.map(x=>x.replace(/{/g,'')).join()} src=//evil.example/p.png>\`}`,
      ],
      [
        "a comparison and a brace in a string",
        `function f(a,b){e.innerHTML=\`<img ${"$"}{a>b?"{":""} src=//evil.example/p.png>\`}`,
      ],
      [
        "an arrow function and a closing brace in a string",
        `function f(a){e.innerHTML=\`<img alt=${"$"}{a.split("}").map(p=>p).join()} src=//evil.example/p.png>\`}`,
      ],
      [
        "a closing brace in a string, then a comparison",
        `e.innerHTML=\`<img ${"$"}{a?"}":b>c} src=//evil.example/p.png>\`;`,
      ],
      // Code between two strings, a `>` in it: the script's own quotes close no value.
      [
        "a comparison between two strings",
        `e.innerHTML="<img "+(a>b?"x":"y")+" src=//evil.example/p.png>";`,
      ],
      [
        "a value an escaped quote opens, a > in the next string",
        `e.innerHTML="<img alt=\\""+b+">\\" src=//evil.example/p.png>";`,
      ],
      [
        "a value an escaped apostrophe opens, a > in the next string",
        `e.innerHTML='<img alt=\\''+b+'>\\' src=//evil.example/p.png>';`,
      ],
      [
        "a value an escaped quote opens, over three strings",
        `e.innerHTML="<img alt=\\""+n+" > "+m+"\\" src=//evil.example/p.png>";`,
      ],
      [
        "a value an escaped apostrophe opens, over three strings",
        `e.innerHTML='<img alt=\\''+n+' > '+m+'\\' src=//evil.example/p.png>';`,
      ],
      // The code between two strings concatenates strings of its own, or the tag is built over
      // statements, from a list, or in two quote kinds: each later string may go on with it.
      [
        "a string concatenated in the code between two strings",
        "e.innerHTML=`<a `+(n>0?t+` active`:r>0?`muted`:``)+` href=//evil.example/>go</a>`;",
      ],
      [
        "the same, as written before the minifier",
        'el.innerHTML = "<a " + (n > 0 ? c + " active" : m > 0 ? "muted" : "") + " href=//evil.example/>go</a>";',
      ],
      [
        "two conditions between two strings",
        'e.innerHTML="<a "+(x?a+"b":c)+(n>0?"on":"")+" href=//evil.example/>go</a>";',
      ],
      [
        "a tag built over statements",
        "let n=`<a `;t&&(n+=`class=x `),n+=`href=//evil.example/>go</a>`;e.innerHTML=n;",
      ],
      // A later statement goes on with a tag's start a variable holds: a `+=` statement whatever
      // joins its literal, and `+`, `.concat(` or a substitution after a statement's end.
      [
        "a `+=` statement whose literal a name joins",
        "let n='<a ';n+=t+' href=//evil.example/x>go</a>';e.innerHTML=n;",
      ],
      [
        "a `+=` statement whose literal a condition holds",
        "let h='<a ';h+=(c?'class=x ':'')+' href=//evil.example/x>go</a>';",
      ],
      [
        "a `+=` statement whose literal a call joins",
        "let t='<a ';t+=g(e)+' href=//evil.example/x>go</a>';",
      ],
      [
        "a tag's start in a variable, joined by `+` in a later statement",
        "const n='<a '+t;e.innerHTML=n+' href=//evil.example/x>go</a>';",
      ],
      [
        "the same in a function, after a condition",
        "function f(t){const n='<a '+t;if(t)return n+' href=//evil.example/x>go</a>';return n+'>'}",
      ],
      [
        "a variable joined to itself",
        "let h='<img ';h=h+' src=//evil.example/x>';e.innerHTML=h;",
      ],
      [
        "a variable joined by concat",
        "const n='<a '+t;e.innerHTML=n.concat(' href=//evil.example/x>go</a>');",
      ],
      [
        "a variable written by a substitution",
        `const n='<a '+t;e.innerHTML=\`${"$"}{n} href=//evil.example/x>go</a>\`;`,
      ],
      [
        "a tag joined from a list",
        "e.innerHTML=[`<a`,n>r?`class=x`:``,`href=//evil.example/>go</a>`].join(` `);",
      ],
      [
        "two quote kinds",
        `e.innerHTML='<a class="'+c+'" '+(a>b?"hidden":"")+" href=//evil.example/>go</a>";`,
      ],
      [
        "a branch's string that ends as a string may start",
        'e.innerHTML="<a "+(t?"title: ":x)+(n>0?"a":"")+" href=//evil.example/>go</a>";',
      ],
      // The code between two strings writes a value, a `>` in it: the next string's first
      // attribute is a new one, in the backticks the minifier prints and in two quote kinds.
      [
        "a value code writes, a comparison in it",
        "e.innerHTML=`<img width=`+(w>0?w:100)+` src=//evil.example/p.png>`;",
      ],
      [
        "a value code writes, an arrow function in it",
        "e.innerHTML=`<img alt=`+a.map(e=>e.n).join(``)+` src=//evil.example/p.png>`;",
      ],
      [
        "a srcset after a value code writes",
        "e.innerHTML=`<img width=`+(w>0?w:100)+` srcset=//evil.example/p.png>`;",
      ],
      [
        "a user name after a value code writes",
        "e.innerHTML=`<img alt=`+a.map(e=>e.n).join(``)+` src=https://react.dev\\x27@evil.example/p.png>`;",
      ],
      [
        "a value code writes, then the other quote kind",
        `e.innerHTML="<img width="+(w>0?w:100)+' src=//cdn.evil.example/x.png alt="y">';`,
      ],
      [
        "a link after a value code writes",
        `e.innerHTML="<a title="+(n>0?c:x)+' href=//evil.example/x data-k="y">go</a>';`,
      ],
      [
        "a value code writes, then a template literal",
        `e.innerHTML="<img width="+(w>0?w:100)+\` src=//cdn.evil.example/x.png alt="${"$"}{a}">\`;`,
      ],
      // A substitution right after a tag's name writes white space and attributes, or the name.
      [
        "a link whose name a substitution ends",
        `e.innerHTML=\`<a${"$"}{c?" hidden":""} href=//evil.example/x>go</a>\`;`,
      ],
      [
        "a form whose name a substitution ends",
        `e.innerHTML=\`<form${"$"}{attrs} action=//evil.example/submit method=post>\`;`,
      ],
      [
        "a base whose name a substitution ends",
        `e.innerHTML=\`<base${"$"}{t} href=//evil.example/>\`;`,
      ],
      ["a name a substitution writes", `e.innerHTML=\`<${"$"}{t} href=//evil.example/x>go\`;`],
      [
        "another attribute after a name a substitution ends",
        `e.innerHTML=\`<img${"$"}{c} alt=x src=//evil.example/p.png>\`;`,
      ],
    ];
    for (const [what, text] of cases) {
      const found = staticRules(t, { "assets/a.js": text });
      assert.ok(
        found.includes("third-party-origin") || found.includes("url-userinfo"),
        `${what}: ${found.join()}`,
      );
    }
    // A regular expression's `=/\/x\//` is in no start tag, whatever `<` stands before it, nor
    // is code after a tag a substitution or a concatenation stood in, once the tag has ended (a
    // string read as the tag's next piece is read up to its own closing quote), nor a string
    // past MAX_PIECE_GAP after the tag's last string.
    for (const text of [
      "for(let e=0;e<t.length;e++){const n=/\\/assets\\//;}",
      "if(a<b){x=1}y=/\\/assets\\//;",
      "e.innerHTML='<b>x</b>';y=/\\/assets\\//;",
      "e.innerHTML='<img src=//react.dev/a.png>';",
      `e.innerHTML=\`<b ${"$"}{a}>\`;f("x");const r = /\\\\/g;`,
      'e.innerHTML="<b "+a+">";f("x");const r = /\\\\/g;',
      `e.innerHTML=\`<b ${"$"}{a?"{":""}>\`;f("x");const r = /\\\\/g;`,
      `const esc=(s)=>s.replace(/\\${"$"}\\{/g,"\\\\${"$"}{");\ne.innerHTML=\`<b ${"$"}{a?"{":""}>\`;if(c){d()}y=/\\/assets\\//;`,
      `e.innerHTML="<b "+a+">";f(${"z".repeat(1100)},"href=//evil.example/x");`,
      `e.innerHTML="<a "+(n>0?"x":"")+${"z".repeat(1100)}+" href=//evil.example/>";`,
      // A comparison before a substitution in a template literal's text opens a tag that the
      // next `>` ends.
      `x=\`${"$"}{a}<b${"$"}{c} items>\`;y=/\\/assets\\//;`,
      // A `<` before a substitution in a message or a comparison opens a tag only as far as its
      // template literal goes, with no `>` after it: the code after the literal is no tag's
      // (Babel's minified semver, a message, the build's minifier's output of one).
      `if(!s.intersects(\`<${"$"}{r}\`,t))n=/\\/node_modules\\//.test(p);`,
      `function v(e,t){if(e.length>t)throw Error(\`Too long: ${"$"}{e.length}<${"$"}{t}\`)}let a=/\\/api\\//;`,
      `let s=\`Array<${"$"}{t}\`,p=/\\/v1\\//;s+=\`>\`;`,
      `x=\`${"$"}{a}<${"$"}{b}\`;y=/\\/assets\\//;`,
      `throw RangeError(\`index out of range: 0<=i<${"$"}{n}\`);for(e=/\\/\\//g;;){}`,
      `export function check(e,t){if(e>=t)throw RangeError(\`expected ${"$"}{e}<${"$"}{t}\`)}export const API=/\\/api\\/v4\\//;export const isApi=e=>API.test(e);`,
      `const m=\`expected ${"$"}{a}<${"$"}{b}\`,re=/\\/api\\/v4\\//;`,
      `throw Error(\`index<n${"$"}{i}\`);var r=/\\/x\\//;`,
      // Nor where no attribute's `=` follows the substitution before a quote or `>`: a message
      // that names a component (the UI SDK's), and a plain string's `<${`, whose quote comes first.
      `throw Error(\`<${"$"}{u.displayName}> must be used inside <${"$"}{o}${"$"}{x}>.\`);let r=/\\/v1\\//;`,
      `x="<${"$"}{y}"+z;w=/\\/api\\//;q=\`a\`;`,
      `x='<a${"$"}{y}'+z;w=/\\/api\\//;q=\`a\`;`,
      // A name joined to a `<` is read by that quote kind's piece reading alone: the code after
      // the string is no tag's, so a regular expression there is code.
      'x="<"+t;y=/\\/\\/x\\.y/.test(s);',
      "x=`<`+t;y=/\\/\\/x\\.y/.test(s);",
    ]) {
      assert.deepEqual(staticRules(t, { "assets/a.js": text }), [], text);
    }
  });

  it("reads a written tag on in a later string or a literal nested in a substitution", (t) => {
    const d = "$";
    // A tag whose name a substitution ends or writes, or the code joins to a `<`, goes on past
    // its literal's backtick: in a concatenation, a `+=`, a list's next item, a condition's
    // branch, a literal nested in a substitution. The build's minifier (rolldown) prints these
    // from honest source: an optional attribute, a tag whose name is a variable.
    for (const text of [
      `e.innerHTML=\`<a${d}{t}\`+n(e)+\` href=//evil.example/x>go</a>\``,
      `let r=\`<a${d}{t}\`;n&&(r+=\` data-x=${d}{n}\`),r+=\` href=//evil.example/x>go</a>\`,e.innerHTML=r`,
      `[\`<a${d}{c}\`,\` href=//evil.example/x>\`].join("")`,
      `e.innerHTML=\`<a${d}{c}\`+" href=//evil.example/x>go</a>"`,
      `e.innerHTML=\`<${d}{t} class=${d}{n}${d}{r?\` href=//evil.example/x\`:\`\`}>go</${d}{t}>\``,
      `e.innerHTML=\`<${d}{t} class=x \`+(n?\`href=//evil.example/x\`:\`\`)+\`>go</${d}{t}>\``,
      `e.innerHTML=\`<${d}{t} title=\`+n+\` href=//evil.example/x>go</${d}{t}>\``,
      `e.innerHTML=\`<form${d}{c} ${d}{a?\`action=//evil.example/s\`:\`\`}>\`;`,
      `e.innerHTML=\`<img${d}{c} ${d}{u?\`src=//evil.example/x.png\`:\`\`}>\`;`,
      `let n=\`<${d}{t} \`;n+=\`href=//evil.example/x>\`;`,
      `[\`<${d}{t}\`,\`href=//evil.example/x>\`].join(\` \`)`,
      `e.innerHTML=\`<a${d}{c}${d}{h?\` href=//evil.example/x\`:\`\`}>go</a>\`;`,
      `e.innerHTML=\`<form${d}{c}${d}{p?\` action=//evil.example/x\`:\`\`}>\`;`,
      `e.innerHTML=\`<${d}{t}\`+(h?\` href=//evil.example/x\`:\`\`)+\`>\`;`,
      `e.innerHTML=[\`<a${d}{c}\`,\` href=//evil.example/x>\`].join(\`\`);`,
      `let h=\`<a${d}{c}\`;h+=\` href=//evil.example/x>\`;`,
      `e.innerHTML=\`<img${d}{c}${d}{s?\` src=//evil.example/x.png\`:\`\`}>\`;`,
      `e.innerHTML=\`<a${d}{t} \`+(n?\`href=//evil.example/y\`:\`\`)+\`>go</a>\``,
      `e.innerHTML=\`<a${d}{t} title=\`+n+\` href=//evil.example/w>go</a>\``,
      `e.innerHTML=\`<a${d}{t} ${d}{n?\`href=//evil.example/v\`:\`\`}>go</a>\``,
      `e.innerHTML=\`<${d}{t} \`+(n?\`src=//evil.example/z.png\`:\`\`)+\`>\``,
      `e.innerHTML=\`<a${d}{c}${d}{\`href=//evil.example/x\`}>go</a>\`;`,
      "e.innerHTML=`<`+t+` href=//evil.example/x>go`;",
      'e.innerHTML="<"+t+" href=//evil.example/x>go";',
      // An optional attribute right after the tag's name: the substitution that ends the name
      // holds the literal that writes it (rolldown's output, and the quoted spelling of a file
      // Vite copies as it is).
      `e.innerHTML=\`<a${d}{t?\` href=//evil.example/x\`:\`\`}>go</a>\``,
      `e.innerHTML=\`<img${d}{t?\` src=//evil.example/x.png\`:\`\`}>\``,
      `e.innerHTML=\`<form${d}{t?\` action=//evil.example/s\`:\`\`}>\``,
      `e.innerHTML=\`<button${d}{t?\` formaction=//evil.example/s\`:\`\`}>\``,
      `e.innerHTML=\`<video${d}{t?\` poster=//evil.example/p.png\`:\`\`}>\``,
      `e.innerHTML=\`<a${d}{t?\` href=//evil.example/x\`:\`\`} hidden>\``,
      `e.innerHTML=\`<a${d}{h?" href=//evil.example/x":""}>go</a>\`;`,
      `e.innerHTML=\`<a${d}{h?' href=//evil.example/x':''}>go</a>\`;`,
      // A name joined by a list, a `+=` or concat (rolldown's output of each).
      "function f(e){return[`<`,e,` href=//evil.example/x>go</`,e,`>`].join(``)}",
      "function f(e){let t=`<`;return t+=e,t+=` href=//evil.example/x>go`,t}",
      'e.innerHTML="<".concat(t," href=//evil.example/x>go");',
      // An attribute's `=` far past the substitution, within MAX_NAME_GAP.
      `e.innerHTML=\`<a${d}{c} data-tracking-disabled hidden href=//evil.example/x>go</a>\`;`,
    ]) {
      assert.deepEqual(staticOrigins(t, { "assets/a.js": text }), ["https://evil.example"], text);
    }
    // The grid: every way a written tag opens, every way the next string follows it, and every
    // attribute that loads or navigates.
    const b = "`";
    const opens = [
      `${b}<a${d}{c}`,
      `${b}<a${d}{c} `,
      `${b}<${d}{t}`,
      `${b}<${d}{t} `,
      `${b}<a${d}{c} title=x `,
      `${b}<${d}{t} title=${d}{n} `,
      `${b}<${b}+t+${b}`,
      `${b}<${b}+t+${b} `,
      `${b}<a`,
      `${b}<${b},t,${b}`,
      `${b}<${b};h+=t,h+=${b}`,
    ];
    /** @type {((open: string, attribute: string) => string)[]} */
    const goesOn = [
      (o, a) => `e.innerHTML=${o}${b}+${b} ${a}>${b};`,
      (o, a) => `e.innerHTML=${o}${b}+n+${b} ${a}>${b};`,
      (o, a) => `e.innerHTML=${o}${b}+(n?${b} ${a}${b}:${b}${b})+${b}>${b};`,
      (o, a) => `e.innerHTML=${o}${d}{n?${b} ${a}${b}:${b}${b}}>${b};`,
      (o, a) => `e.innerHTML=${o}${d}{${b} ${a}${b}}>${b};`,
      (o, a) => `let h=${o}${b};h+=${b} ${a}>${b};`,
      (o, a) => `e.innerHTML=[${o}${b},${b} ${a}>${b}].join(${b}${b});`,
      (o, a) => `e.innerHTML=${o}${b}+" ${a}>";`,
    ];
    const attributes = ["href", "action", "formaction", "src", "poster", "srcset"];
    for (const open of opens) {
      for (const goOn of goesOn) {
        for (const name of attributes) {
          const text = goOn(open, `${name}=//evil.example/x`);
          assert.deepEqual(originsIn(text, { kind: "script" }), ["https://evil.example"], text);
        }
      }
    }
  });

  it("reads CSS a script holds, and a style attribute's references, through CSS's escapes", (t) => {
    /** @type {[string, string, string, string][]} */
    const cases = [
      [
        "an escaped @ in a style a script sets",
        "assets/a.js",
        'e.style.backgroundImage="url(https://react.dev\\\\40 evil.example/a.png)";',
        "https://evil.example",
      ],
      [
        "an escaped tab in a style a script sets",
        "assets/a.js",
        'e.style.background="url(https://react.dev\\\\9 .evil.example/a.png)";',
        "https://react.dev.evil.example",
      ],
      [
        "escaped slashes in a style a script sets",
        "assets/a.js",
        'e.style.backgroundImage="url(\\\\2f\\\\2f evil.example/a.png)";',
        "https://evil.example",
      ],
      [
        "a stylesheet a script holds",
        "assets/a.js",
        'const css=".a{background:url(https://react.dev\\\\40 evil.example/a.png)}";',
        "https://evil.example",
      ],
      [
        "a referenced backslash in a style attribute",
        "index.html",
        '<div style="background:url(https://react.dev&#92;40 evil.example/a.png)"></div>',
        "https://evil.example",
      ],
      [
        "a style attribute a script writes",
        "assets/a.js",
        "e.innerHTML='<div style=\"background:url(https://react.dev&#92;40 evil.example/a.png)\">';",
        "https://evil.example",
      ],
    ];
    for (const [what, file, text, origin] of cases) {
      const found = staticOrigins(t, { [file]: text });
      assert.ok(found.includes(origin), `${what}: ${found.join()}`);
    }
    assert.deepEqual(
      staticRules(t, {
        "assets/a.js": 'e.style.backgroundImage="url(https://react.dev/a\\\\40 b.png)";',
      }),
      [],
    );
  });

  it("reads a host the host parser drops a character from, wherever the URL starts", (t) => {
    const bom = "\u{feff}";
    /** @type {[string, string, string][]} */
    const cases = [
      [
        "a byte order mark in a srcset's absolute candidate",
        "assets/a.js",
        `jsx("img",{srcSet:"/a.png 1x, https://react.dev${bom}.evil.example/b.png 2x"})`,
      ],
      [
        "a byte order mark in a srcset a script sets",
        "assets/a.js",
        `i.setAttribute("srcset","/a.png 1x, https://react.dev${bom}.evil.example/b.png 2x")`,
      ],
      [
        "a soft hyphen in a srcset's absolute candidate",
        "assets/a.js",
        'jsx("img",{srcSet:"/a.png 1x, https://react.dev\\xad.evil.example/b.png 2x"})',
      ],
      [
        "a byte order mark in a refresh's URL",
        "index.html",
        `<meta http-equiv="refresh" content="0;https://react.dev${bom}.evil.example/">`,
      ],
      [
        "a zero width space in a refresh's URL",
        "index.html",
        '<meta http-equiv="refresh" content="0;https://react.dev&#x200B;.evil.example/">',
      ],
      [
        "a byte order mark after a substitution",
        "assets/a.js",
        `fetch(\`${"$"}{""}https://react.dev${bom}.evil.example/x\`)`,
      ],
      [
        "a byte order mark where nothing known starts the URL",
        "assets/a.js",
        `x="see https://react.dev${bom}.evil.example/x";`,
      ],
    ];
    for (const [what, file, text] of cases) {
      const found = staticOrigins(t, { [file]: text });
      // Each origin compared whole, never as a substring of a URL.
      const origin = "https://react.dev.evil.example";
      assert.ok(
        found.some((o) => o === origin),
        `${what}: ${found.join()}`,
      );
    }
  });

  it("reads a refresh's URL to the end of its value, as a browser does", (t) => {
    const nl = String.fromCharCode(10);
    /** @type {[string, string, string, string][]} */
    const cases = [
      [
        "a space",
        "index.html",
        '<meta http-equiv="refresh" content="0;https://react.dev @evil.example/">',
        "https://evil.example",
      ],
      [
        "a quote",
        "index.html",
        '<meta http-equiv="refresh" content="0;https://react.dev\'@evil.example/">',
        "https://evil.example",
      ],
      [
        "a raw new line",
        "index.html",
        `<meta http-equiv="refresh" content="0;https://react.dev${nl}.evil.example/">`,
        "https://react.dev.evil.example",
      ],
      [
        "url= and a space",
        "index.html",
        '<meta http-equiv="refresh" content="0;url=https://react.dev @evil.example/">',
        "https://evil.example",
      ],
      [
        "url= and a >",
        "index.html",
        '<meta http-equiv="refresh" content="0;url=https://react.dev>@evil.example/">',
        "https://evil.example",
      ],
      [
        "a protocol-relative URL",
        "index.html",
        '<meta http-equiv="refresh" content="0;//evil.example/">',
        "https://evil.example",
      ],
      [
        "a protocol-relative URL after url=",
        "index.html",
        '<meta http-equiv="refresh" content="5, URL = //evil.example/">',
        "https://evil.example",
      ],
      [
        "an unquoted value",
        "index.html",
        "<meta http-equiv=refresh content=0;https://react.dev,@evil.example>",
        "https://evil.example",
      ],
      [
        "an unquoted value a script writes",
        "assets/a.js",
        "e.innerHTML='<meta http-equiv=refresh content=0;https://react.dev,@evil.example>';",
        "https://evil.example",
      ],
      [
        "a value a script sets",
        "assets/a.js",
        'm.httpEquiv="refresh";m.content="0;https://react.dev @evil.example/";',
        "https://evil.example",
      ],
      [
        "a quote in a srcset's absolute candidate",
        "assets/a.js",
        'jsx("img",{srcSet:"/a.png 1x, https://react.dev\'@evil.example/b.png 2x"})',
        "https://evil.example",
      ],
      // A user name read past a guessed end is read up to a `>` that may end the tag, too.
      [
        "a user name before a >",
        "index.html",
        "<p>x 0;https://react.dev,@evil.example>y</p>",
        "https://evil.example",
      ],
      // A refresh skips any amount of white space and reads any number of digits and dots.
      [
        "long white space before the URL",
        "index.html",
        `<meta http-equiv="refresh" content="0;${" ".repeat(300)}//evil.example/">`,
        "https://evil.example",
      ],
      [
        "long white space before a URL with a user name",
        "index.html",
        `<meta http-equiv="refresh" content="0;${" ".repeat(300)}https://react.dev @evil.example/">`,
        "https://evil.example",
      ],
      [
        "a long time",
        "index.html",
        `<meta http-equiv="refresh" content="0.${"0".repeat(300)};//evil.example/">`,
        "https://evil.example",
      ],
      [
        "long white space before the time",
        "index.html",
        `<meta http-equiv="refresh" content="${" ".repeat(300)}0;https://react.dev @evil.example/">`,
        "https://evil.example",
      ],
      [
        "long white space after url=",
        "index.html",
        `<meta http-equiv="refresh" content="0; url=${" ".repeat(300)}https://react.dev @evil.example/">`,
        "https://evil.example",
      ],
      [
        "long white space in a value a script sets",
        "assets/a.js",
        `m.content="0;${" ".repeat(300)}https://react.dev @evil.example/"`,
        "https://evil.example",
      ],
      // A time a script writes at run time, before `url=`: a substitution, or the code before the
      // string.
      [
        "a time a substitution writes",
        "assets/a.js",
        `jsx("meta",{httpEquiv:"refresh",content:\`${"$"}{n}; url=//evil.example/\`})`,
        "https://evil.example",
      ],
      [
        "a time a substitution computes",
        "assets/a.js",
        `jsx("meta",{httpEquiv:"refresh",content:\`${"$"}{Math.ceil(ms/1e3)}; url=//evil.example/\`})`,
        "https://evil.example",
      ],
      [
        "a time concatenated before the string",
        "assets/a.js",
        'jsx("meta",{httpEquiv:"refresh",content:n+"; url=//evil.example/"})',
        "https://evil.example",
      ],
      [
        "a time concatenated as a property is set",
        "assets/a.js",
        'm.httpEquiv="refresh",m.content=t+";url=//evil.example/next"',
        "https://evil.example",
      ],
      [
        "a time concatenated before backticks",
        "assets/a.js",
        "m.setAttribute(`content`,t+`; url=//evil.example/next`);",
        "https://evil.example",
      ],
      // A time written at run time with no `url=`, which a browser's refresh does not need.
      [
        "a time a substitution writes, with no url=",
        "assets/a.js",
        `jsx("meta",{httpEquiv:"refresh",content:\`${"$"}{n}; //evil.example/next\`})`,
        "https://evil.example",
      ],
      [
        "a time concatenated before the string, with no url=",
        "assets/a.js",
        'jsx("meta",{httpEquiv:"refresh",content:n+";//evil.example/next"})',
        "https://evil.example",
      ],
      [
        "a written meta's time a substitution writes, with no url=",
        "assets/a.js",
        `e.innerHTML=\`<meta http-equiv=refresh content="${"$"}{n}; //evil.example/x">\`;`,
        "https://evil.example",
      ],
      [
        "a value set apart from its meta",
        "assets/a.js",
        'x=n+"; //evil.example/x";',
        "https://evil.example",
      ],
      // A time a substitution starts and the text goes on, and url= a list joins to its time.
      [
        "a time's digits after a substitution",
        "assets/a.js",
        `m.content=\`${"$"}{n}0; //evil.example/x\`;`,
        "https://evil.example",
      ],
      [
        "url= joined to a time written apart",
        "assets/a.js",
        'm.content=[n,"url=//evil.example/x"].join(";");',
        "https://evil.example",
      ],
      // A single label where a refresh key stands near: the value is a refresh's.
      [
        "a single label after a refresh key",
        "assets/a.js",
        `jsx("meta",{httpEquiv:"refresh",content:\`${"$"}{n}; //intranet/x\`})`,
        "https://intranet",
      ],
      [
        "a single label after setAttribute's refresh key",
        "assets/a.js",
        'm.setAttribute("http-equiv","refresh"),m.content=n+";//intranet/x";',
        "https://intranet",
      ],
      [
        "a single label after a refresh property's name",
        "assets/a.js",
        `o={refresh:\`${"$"}{n}; //intranet/x\`};`,
        "https://intranet",
      ],
    ];
    for (const [what, file, text, origin] of cases) {
      const found = staticOrigins(t, { [file]: text });
      assert.ok(found.includes(origin), `${what}: ${found.join()}`);
    }
    /** @type {[string, string][]} */
    const passes = [
      ["index.html", '<meta http-equiv="refresh" content="0;https://react.dev/errors">'],
      ["index.html", '<meta http-equiv="refresh" content="0;url=\'https://react.dev\'">'],
      ["assets/a.js", 'x="1, https://react.dev and more";y="2 https://react.dev, see";'],
      ["assets/a.js", "a.x='used'.length;// https://react.dev here\nb();"],
      // After a time written at run time, a comment's note names no host, nor does a host built
      // at run time.
      ["assets/a.js", `x=\`${"$"}{a}; // note\`;y=n+"; // note";z=\`${"$"}{code};//${"$"}{c}\`;`],
      // A code generator's comments with no refresh key near: a single label names no host on
      // the network.
      ["assets/a.js", 'x=code+";//eslint-disable-line";'],
      ["assets/a.js", `x=\`${"$"}{code};//eslint-disable-line\`;`],
      ["assets/a.js", 'x=code+"; //@ts-ignore";'],
      ["assets/a.js", `x=\`let a=${"$"}{v};//TODO\`;`],
      ["assets/a.js", 'x=";//@ts-ignore";y=x+"; //istanbul ignore next";'],
      // Nor where only a longer name, or a function's or a call's, holds the word: no refresh key.
      ["assets/a.js", 'const r=e.refreshToken;x=code+";//eslint-disable-line";'],
      ["assets/a.js", `function onRefresh(){}x=\`${"$"}{code};//TODO\`;`],
      ["assets/a.js", 'i.refetchOnRefresh=!0,x=code+"; //@ts-ignore";'],
      ["assets/a.js", `${"$"}RefreshReg${"$"}(a,"App");x=\`let a=${"$"}{v};//noop\`;`],
      ["assets/a.js", `function refresh(){}x=\`${"$"}{code};//eslint-disable-line\`;`],
      ["assets/a.js", 'refresh(),x=code+";//eslint-disable-line";'],
      // Nor a key further back than REFRESH_REACH.
      [
        "assets/a.js",
        `jsx("meta",{httpEquiv:"refresh",${"k:0,".repeat(70)}content:\`${"$"}{n}; //intranet/x\`})`,
      ],
      // A regular expression after a string's closing quote and `,` or `;`, or after a `}`: its
      // escaped slashes are code's, never two raw ones; nor does a plain string's `"${"` close a
      // substitution before a comment.
      ["assets/a.js", `o={k:"${"$"}{"},/\\/\\/x\\.y/.test(d)`],
      ["assets/a.js", 'a=":",/\\n/.test(b)&&c();'],
      ["assets/a.js", 'x+="(";/\\//.test(y)&&z();'],
      ["assets/a.js", 'k="=",/\\\\/.test(q)&&r();'],
      ["assets/a.js", 'p=e?"?":"&",/\\//.test(u)&&v();'],
      ["assets/a.js", 'w="+",/\\r/.test(t)&&a();'],
      ["assets/a.js", 'a.type="new";/\\//.test(y)&&z();'],
      ["assets/a.js", 'm="in";/\\/\\/cdn\\.example\\.com/.test(u)&&w();'],
      ["assets/a.js", `x="${"$"}{";f(function(){a()},/\\//.test(b));`],
      ["assets/a.js", `f({a:"${"$"}{"}, //cdn.example.com\n)`],
      // A regular expression right after a block's `}`, a plain string's `"${"` before it: the
      // `}` may close a substitution, but its escaped slashes are code's.
      ["assets/a.js", `x="${"$"}{";if(a){b()}/\\/\\/cdn\\.example\\.com\\//.test(c)&&f();`],
      ["assets/a.js", `x='${"$"}{';for(;;){}/\\/\\/cdn\\.example\\.com\\//.test(c);`],
      ["assets/a.js", `x="${"$"}{";function f(){return 1}/\\/\\/cdn\\.example\\.com\\//.test(c);`],
      ["assets/a.js", `x="${"$"}{";function f(){}/\\/\\/cdn\\.example\\.org\\//.test(s)&&c();`],
    ];
    for (const [file, text] of passes) {
      assert.deepEqual(staticRules(t, { [file]: text }), [], text);
    }
  });

  it("looks for a refresh before each URL with work linear in the text", HANG, () => {
    // Quoted path data: a digit run and white space before each `//`, as an icon set has.
    const piece = `<path d="${"1".repeat(120)}${" ".repeat(120)}x//a"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${piece.repeat(3_000)}</svg>`;
    assert.deepEqual(linearOrigins(svg, "markup"), ["http://www.w3.org"]);
    // A refresh a script writes before each of many URLs, with no `url=` and with it.
    const d = "$";
    for (const text of [
      'x=n+"; //a.b";'.repeat(50_000),
      `x=\`${d}{n}0; url=//a.b\`;`.repeat(40_000),
      'm=[n,"url=//a.b"].join(";");'.repeat(30_000),
    ]) {
      assert.deepEqual(linearOrigins(text, "script"), ["https://a.b"], text.slice(0, 30));
    }
  });

  it("reads a fixed host a template literal's substitution follows, and one it precedes", (t) => {
    const d = "$";
    const nl = String.fromCharCode(10);
    /** @type {[string, string, string, string][]} */
    const cases = [
      [
        "a substitution after the host",
        "assets/a.js",
        `fetch(\`https://evil.example${d}{p}\`)`,
        "https://evil.example",
      ],
      [
        "a protocol-relative URL",
        "assets/a.js",
        `i.src=\`//evil.example${d}{p}\``,
        "https://evil.example",
      ],
      [
        "a WebSocket",
        "assets/a.js",
        `new WebSocket(\`wss://evil.example${d}{q}\`)`,
        "wss://evil.example",
      ],
      [
        "a port built at run time",
        "assets/a.js",
        `fetch(\`https://evil.example:${d}{port}/x\`)`,
        "https://evil.example",
      ],
      [
        "an unquoted attribute a script writes",
        "assets/a.js",
        `e.innerHTML=\`<img src=https://evil.example${d}{p}>\``,
        "https://evil.example",
      ],
      // Right after a substitution, the template literal goes on to its backtick.
      [
        "a space after a substitution",
        "assets/a.js",
        `fetch(\`${d}{a}https://react.dev @evil.example/x\`)`,
        "https://evil.example",
      ],
      [
        "a new line after a substitution",
        "assets/a.js",
        `fetch(\`${d}{a}https://react.dev${nl}.evil.example/x\`)`,
        "https://react.dev.evil.example",
      ],
      [
        "slashes after a substitution",
        "assets/a.js",
        `e.innerHTML=\`<img src${d}{eq}//evil.example/p.png>\`;`,
        "https://evil.example",
      ],
      // Past what the URL parser strips, which an empty substitution leaves at the URL's start.
      [
        "a space between a substitution and the URL",
        "assets/a.js",
        `fetch(\`${d}{a} https://react.dev @evil.example/x\`)`,
        "https://evil.example",
      ],
      [
        "a tab between a substitution and the URL",
        "assets/a.js",
        `fetch(\`${d}{a}\\thttps://react.dev\\n.evil.example/x\`)`,
        "https://react.dev.evil.example",
      ],
      [
        "a space between a substitution and slashes",
        "assets/a.js",
        `i.src=\`${d}{p} //evil.example/x.png\``,
        "https://evil.example",
      ],
      // A substitution's `}` as a lexer finds it, whatever braces its strings and expressions hold.
      [
        "a brace in a string in the substitution",
        "assets/a.js",
        `fetch(\`${d}{a?"{":""}https://react.dev @evil.example/x\`)`,
        "https://evil.example",
      ],
      [
        "a closing brace in a string in the substitution",
        "assets/a.js",
        `i.src=\`${d}{a?"}":""}//evil.example/x.png\``,
        "https://evil.example",
      ],
      [
        "a brace in a regular expression in the substitution",
        "assets/a.js",
        `i.src=\`${d}{a.replace(/{/g,"")}//evil.example/x.png\``,
        "https://evil.example",
      ],
      // A `${` in a plain string or a regular expression earlier in the file (a tokenizer's
      // `"${"`, a template-escaping regular expression) starts no substitution: the ones after it
      // are still paired, and the text after each `}` read.
      [
        "a protocol picked at run time after a dollar-brace string",
        "assets/a.js",
        `if(m[1]==="${d}{")depth++;${nl}s.src = \`${d}{secure ? "https:" : "http:"}//cdn.example/x.png\`;${nl}log("done");`,
        "https://cdn.example",
      ],
      [
        "the same in single quotes",
        "assets/a.js",
        `if(m[1]==='${d}{')depth++;${nl}s.src = \`${d}{secure ? 'https:' : 'http:'}//cdn.example/x.png\`;${nl}log('done');`,
        "https://cdn.example",
      ],
      [
        "a space after a substitution, after a dollar-brace string",
        "assets/a.js",
        `if(m[1]==="${d}{")depth++;${nl}fetch(\`${d}{a?"x":""}https://react.dev @evil.example/x\`);log("done");`,
        "https://evil.example",
      ],
      [
        "a protocol picked at run time after a split on a dollar-brace",
        "assets/a.js",
        `n=s.split("${d}{").length;${nl}i.src=\`${d}{secure?"https:":"http:"}//cdn.evil.example/lib.js\`;f("x");`,
        "https://cdn.evil.example",
      ],
      [
        "a protocol picked at run time after a template-escaping regular expression",
        "assets/a.js",
        `const esc=(s)=>s.replace(/\\${d}\\{/g,"\\\\${d}{");${nl}i.src=\`${d}{secure?"https:":"http:"}//cdn.evil.example/lib.js\`;`,
        "https://cdn.evil.example",
      ],
      [
        "a WebSocket's protocol picked at run time after it",
        "assets/a.js",
        `const esc=(s)=>s.replace(/\\${d}\\{/g,"\\\\${d}{");${nl}new WebSocket(\`${d}{secure?"wss:":"ws:"}//cdn.evil.example/live\`);`,
        "https://cdn.evil.example",
      ],
      [
        "a closing brace in a string in the substitution, after it",
        "assets/a.js",
        `const esc=(s)=>s.replace(/\\${d}\\{/g,"\\\\${d}{");${nl}i.src=\`${d}{a?"}":""}//evil.example/x.png\``,
        "https://evil.example",
      ],
      // A scheme written at run time before `://`: a substitution, or the code before a string.
      [
        "a scheme a substitution writes",
        "assets/a.js",
        `jsx("a",{href:\`${d}{s}://evil.example/x\`,children:"go"})`,
        "https://evil.example",
      ],
      [
        "a scheme a condition in a substitution picks",
        "assets/a.js",
        `window.location.href=\`${d}{secure?"https":"http"}://evil.example/login\`;`,
        "https://evil.example",
      ],
      [
        "a scheme concatenated before the string",
        "assets/a.js",
        'window.location.href=(secure?"https":"http")+"://evil.example/login";',
        "https://evil.example",
      ],
      [
        "a scheme's last letter a substitution writes",
        "assets/a.js",
        `location.href=\`http${d}{secure?"s":""}://evil.example/x\`;`,
        "https://evil.example",
      ],
      [
        "a scheme concatenated in a call",
        "assets/a.js",
        'location.assign((p?"https":"http")+"://evil.example/cb")',
        "https://evil.example",
      ],
      [
        "a form's action",
        "assets/a.js",
        `jsx("form",{action:\`${d}{proto}://evil.example/submit\`,method:"post"})`,
        "https://evil.example",
      ],
      [
        "a refresh's URL",
        "assets/a.js",
        `jsx("meta",{httpEquiv:"refresh",content:\`0;url=${d}{s}://evil.example/\`})`,
        "https://evil.example",
      ],
      [
        "an IPv4 address as one number",
        "assets/a.js",
        `location.href=\`${d}{s}://3221225985/x\`;`,
        "https://192.0.2.1",
      ],
      // Outside a script nothing is built at run time: a `$` is the host's own.
      [
        "a $ in markup",
        "index.html",
        '<script src="https://evil$.example/x.js"></script>',
        "https://evil$.example",
      ],
      [
        "a $ in an unquoted attribute",
        "index.html",
        "<img src=//$.evil.example/p.png>",
        "https://$.evil.example",
      ],
      [
        "a $ in a stylesheet",
        "assets/a.css",
        "a{b:url(//x$.evil.example/p.png)}",
        "https://x$.evil.example",
      ],
      [
        "a $ with no brace in a script",
        "assets/a.js",
        'fetch("https://evil$.example/x")',
        "https://evil$.example",
      ],
    ];
    for (const [what, file, text, origin] of cases) {
      const found = staticOrigins(t, { [file]: text });
      assert.ok(found.includes(origin), `${what}: ${found.join()}`);
    }
    for (const text of [
      `fetch(\`https://${d}{host}/x\`);fetch(\`//${d}{host}:${d}{port}/x\`);`,
      `fetch(\`https://${d}{a}.${d}{b}/x\`);fetch(\`http://localhost:${d}{port}/x\`);`,
      `fetch(\`https://react.dev/${d}{p}\`);x=\`${d}{a}https://react.dev for the docs\`;`,
      `x=\`${d}{a}https://react.dev/errors/${d}{c}\`;`,
      // A `}` that closes a block, not a substitution, starts no URL: a comment after it is code's.
      `if(a){b()} // @ts-expect-error${nl}c();x=\`${d}{"{"}\`;`,
      `function f(){}${nl}${nl}// Node walkers.${nl}${nl}var base = {};x=\`${d}{"{"}\`;`,
      // After a scheme written at run time: a single label (a devtools page), a host built at
      // run time, and a scheme the text fixes that names no web host.
      `const u=\`${d}{name}://inspect\`;const v=\`${d}{p}://localhost:${d}{port}\`;const w=p+"://"+h;`,
      'x="chrome://inspect";y="about://blank";',
    ]) {
      assert.deepEqual(staticRules(t, { "assets/a.js": text }), [], text);
    }
  });

  it("reads `://` in a script's strings, and a host joined from literals or chosen among them", (t) => {
    const d = "$";
    /** @type {[string, string, string[]][]} */
    const cases = [
      // `://` and a host in a string's text, whatever writes the scheme before it.
      [
        "a placeholder",
        'a.href="{scheme}://evil.example/x".replace("{scheme}",s);',
        ["https://evil.example"],
      ],
      ["a formatter", 'a.href=fmt("%s://evil.example/x",s);', ["https://evil.example"]],
      ["a scheme's start", `a.href=\`${d}{p}s://evil.example/x\`;`, ["https://evil.example"]],
      ["a variable's name", 'a.href="$SCHEME://evil.example/x";', ["https://evil.example"]],
      [
        "a formatter's named argument",
        "t.href=e(`%(scheme)s://evil.example/x`,{scheme:n})",
        ["https://evil.example"],
      ],
      // A scheme's start the code before the string writes: joined, listed or concatenated, its
      // end at the string's own start is no scheme the text fixes (rolldown's output included).
      ["a scheme's start joined", 'a.href=p+"s://evil.example/x";', ["https://evil.example"]],
      ["the same in quotes", "a.href=p+'s://evil.example/x';", ["https://evil.example"]],
      ["the same in backticks", "e.href=t+`s://evil.example/x`", ["https://evil.example"]],
      ["after a call", 'a.href=f()+"s://evil.example/x";', ["https://evil.example"]],
      ["more of it", 'a.href=h+"ttps://evil.example/x";', ["https://evil.example"]],
      ["a scheme split", 'fetch("http"+"s://evil.example/x")', ["https://evil.example"]],
      ["split elsewhere", "fetch('htt'+'ps://evil.example/x');", ["https://evil.example"]],
      ["split in backticks", "fetch(`http`+`s://evil.example/x`)", ["https://evil.example"]],
      ["a chosen start", "e.href=(t?`ws`:`http`)+`s://evil.example/x`", ["https://evil.example"]],
      ["concat", 'a.href="".concat(p,"s://evil.example/x");', ["https://evil.example"]],
      ["a list", 'a.href=[p,"s://evil.example/x"].join("");', ["https://evil.example"]],
      // A quote character in the string's own text before the colon: an apostrophe, or an
      // attribute's quote in markup the string holds.
      ["an apostrophe", 'a.href="Don\'t go to %s://evil.example/x";', ["https://evil.example"]],
      [
        "an apostrophe's placeholder",
        'a.href=t("it\'s {scheme}://evil.example/x");',
        ["https://evil.example"],
      ],
      [
        "one in backticks",
        "e.href=fmt(`Can't open %s://evil.example/x`,t)",
        ["https://evil.example"],
      ],
      [
        "an attribute's quotes",
        'e.innerHTML=`<a class="x" href={scheme}://evil.example/x>go</a>`.replace(`{scheme}`,t)',
        ["https://evil.example"],
      ],
      [
        "a formatter's markup",
        'e.innerHTML=fmt(`<a class="btn" href=%s://evil.example/x>go</a>`,t)',
        ["https://evil.example"],
      ],
      [
        "single quotes in double",
        "e.innerHTML=\"<a title='x' href={scheme}://evil.example/x>go</a>\";",
        ["https://evil.example"],
      ],
      [
        "a value joined before it",
        "e.innerHTML='<a class=\"'+c+'\" href={scheme}://evil.example/x>go</a>';",
        ["https://evil.example"],
      ],
      // A URL split into literals the script joins.
      ["split at the scheme", 'fetch("https://"+"evil.example/x")', ["https://evil.example"]],
      ["the same in backticks", "fetch(`https://`+`evil.example/x`)", ["https://evil.example"]],
      ["split in the slashes", 'fetch("https:/"+"/evil.example/x")', ["https://evil.example"]],
      ["a run-time scheme, then", 'fetch(s+"://"+"evil.example/x")', ["https://evil.example"]],
      // Hosts chosen among literals right after a fixed scheme.
      [
        "a condition in a substitution",
        `window.location.href=\`https://${d}{e?\`app.evil.example\`:\`staging.evil.example\`}/login\``,
        ["https://app.evil.example", "https://staging.evil.example"],
      ],
      [
        "a condition in brackets",
        "window.location.href=`https://`+(e?`app.evil.example`:`staging.evil.example`)+`/login`",
        ["https://app.evil.example", "https://staging.evil.example"],
      ],
      [
        "a host's start chosen, the rest after it",
        `location.href=\`https://${d}{p?"":"staging."}evil.example/x\`;`,
        ["https://evil.example", "https://staging.evil.example"],
      ],
      [
        "a host's start chosen in brackets, the rest joined",
        'location.href="https://"+(p?"":"www.")+"evil.example/x";',
        ["https://evil.example", "https://www.evil.example"],
      ],
      [
        "nested conditions and a default",
        `fetch(\`https://${d}{a?"a.evil.example":b?"b.evil.example":"c.evil.example"||"d.evil.example"}/x\`)`,
        [
          "https://a.evil.example",
          "https://b.evil.example",
          "https://c.evil.example",
          "https://d.evil.example",
        ],
      ],
      // A host's start chosen and joined to a literal rest, in the substitution or the brackets.
      [
        "a chosen start joined in a substitution",
        `function f(e){return fetch(\`https://${d}{(e?\`app\`:\`staging\`)+\`.evil.example\`}/login\`)}`,
        ["https://app.evil.example", "https://staging.evil.example"],
      ],
      [
        "a chosen start joined in brackets",
        "function f(e){return fetch(`https://`+((e?`app`:`staging`)+`.evil.example`)+`/login`)}",
        ["https://app.evil.example", "https://staging.evil.example"],
      ],
      [
        "two choices in a row",
        `u=\`https://${d}{a?\`x\`:\`y\`}${d}{b?\`.eu\`:\`.us\`}.evil.example/p\`;`,
        [
          "https://x.eu.evil.example",
          "https://x.us.evil.example",
          "https://y.eu.evil.example",
          "https://y.us.evil.example",
        ],
      ],
      ["a host split", 'fetch("https://evil"+".example/x")', ["https://evil.example"]],
      // Literals joined after a scheme in markup a string holds, or where no quote starts the URL
      // (rolldown's output of each).
      [
        "an attribute's quotes",
        'e.innerHTML=`<a href="https://`+(t?`app.evil.example`:`staging.evil.example`)+`/login">Sign in</a>`',
        ["https://app.evil.example", "https://staging.evil.example"],
      ],
      [
        "an unquoted attribute",
        "function f(e){return`<form action=https://`+(e?`app.evil.example`:`staging.evil.example`)+`/s method=post>`}",
        ["https://app.evil.example", "https://staging.evil.example"],
      ],
      [
        "a url(",
        "function f(e){return`url(https://`+(e?`app.evil.example`:`staging.evil.example`)+`/p.png)`}",
        ["https://app.evil.example", "https://staging.evil.example"],
      ],
      [
        "prose",
        "function f(e){return`Open https://`+(e?`app.evil.example`:`staging.evil.example`)+` to go on`}",
        ["https://app.evil.example", "https://staging.evil.example"],
      ],
      [
        "two literals in markup",
        "e.innerHTML='<a href=\"https://'+\"evil.example\"+'/login\">go</a>';",
        ["https://evil.example"],
      ],
    ];
    for (const [what, text, origins] of cases) {
      assert.deepEqual(staticOrigins(t, { "assets/a.js": text }), origins, what);
    }
    // A regular expression after a quoted key, a condition's branch or a case label, as the build's
    // minifier (rolldown) prints it: its escaped slashes are code, not `://`, and a colon after a
    // string's closing quote is code's. A host a name, a call or anything but literals chooses is
    // built at run time (the page's policy refuses it), and a single label after a run-time
    // scheme names no host on the network.
    for (const text of [
      'const e={"text/html":/\\/index\\.html$/,"application/json":/\\/data\\.json$/,"image/svg+xml":/\\/icons\\.svg$/}',
      'const e=e=>e?`strict`:/\\/app\\.css$/,t={"a-b":/\\\\d+\\.\\d+/}',
      'switch(a){case"x":/\\/a.b/.test(c)&&f();break}',
      "const r=e?``:/\\/\\/cdn.jsdelivr.net/;",
      'export const R={"cdn-host":/\\/\\/cdn\\.example\\.org\\//};',
      "function f(e,t){return e?`a`:/\\/\\/cdn\\.example\\.org\\//.test(t)}",
      'const P={"you-tube":/\\/\\/www\\.youtube\\.com\\/embed\\//};',
      'switch(x){case"a":/\\/\\/a\\.b\\.c\\//.test(y)&&f()}',
      'a=e?"":/\\//.test(t);',
      'switch(k){case"x":/\\//.test(y)&&z();break}',
      `a=e?\`${d}{b}\`:/\\//.test(t);`,
      'a=e?"":/\\/\\/cdn\\.example\\.com\\//.test(t);',
      'x={"a:":/\\/\\/cdn\\.example\\.com\\//};',
      'x={"a"://cdn.example.com/docs say so\n1};',
      'u="https://"+host;v="https://"+(a||b);w="https://"+f("x.example");',
      `u=\`https://${d}{f(\`x.example\`)}/a\`;v=\`https://${d}{a?b:\`x.example\`}/a\`;`,
      `u="{scheme}://intranet/x";v=\`${d}{p}s://localhost:8080/\`;`,
      // A scheme the text fixes, not a web one: its URL loads no web page, joined to code or not.
      'u="git+https://github.example/x/y.git";v="mongodb://db.example.com:27017/d";',
      `w=\`socks5://proxy.example.com:${d}{p}\`;x="see chrome://policy.";y='a xhttps://evil.example';`,
      'u=x+"git+https://github.example/a.git";v="see "+"chrome://policy";',
      // A host's start chosen or joined, the rest built at run time from a name or configuration
      // (hosts by role, AGENTS.md section 2; rolldown's output of each): only its start is
      // literal, and a host's start is never read as an origin, nor is `${...}` text.
      `location.href=\`https://${d}{p?"":"staging."}${d}{host}\`;`,
      `location.href=\`https://${d}{e?"a":"b"}${d}{host}\`;`,
      'location.href="https://"+(e?"staging.":"")+host;',
      `function f(e,t){return\`https://${d}{e===\`api\`?\`api\`:\`console\`}.${d}{t.zone}/\`}`,
      "function f(e,t){return`https://`+(e?`www.`:``)+t}",
      `function f(e,t,n){return\`https://${d}{e?\`[\`:\`\`}${d}{t}${d}{e?\`]\`:\`\`}:${d}{n}\`}`,
      `function f(e,t){return\`https://${d}{e?\`staging.\`:\`\`}${d}{t}\`}`,
      `fetch(\`https://api.${d}{zone}/x\`);fetch("https://www."+host);`,
      // `://` and a host's start with only a root dot: URL-normalising code, which names no host.
      `function f(e){return e.replace(/^(\\w+):\\/\\//,\`${d}1://www.\`)}`,
      "function f(e){return e.replace(`://www.`,`://`)}",
      "function f(e){return e.includes(`://www.`)}",
      'u=p+"://www."+h;w=e.replace("://m.","://");',
    ]) {
      assert.deepEqual(staticRules(t, { "assets/a.js": text }), [], text);
    }
  });

  it("reads a large script's tags in one pass, its regular expressions left alone", HANG, () => {
    const loop = "for(let e=0;e<t.length;e++){const n=/\\/assets\\//;a=>b}".repeat(30_000);
    assert.deepEqual(linearOrigins(loop, "script"), []);
    const tag = `e.innerHTML='<p title="a>b"><img alt=x src=//collector.evil.example/p.png>';`;
    assert.deepEqual(linearOrigins(`${loop}${tag}`, "script"), ["https://collector.evil.example"]);
    // Many written tags, each held for the strings after it, before the tag whose URL has the
    // pass read them all: in backticks alone, where the next of each other quote kind is found
    // once, not again at each tag; and beside strings in each quote kind.
    const d = "$";
    const written = `e.innerHTML=\`<a${d}{c}\`+\` x=1\`+(n?\`<\`+t+\` y=2\`:\`\`);`;
    for (const each of [written, `${written}f("a",'b');`]) {
      assert.deepEqual(linearOrigins(`${each.repeat(20_000)}${tag}`, "script"), [
        "https://collector.evil.example",
      ]);
    }
  });

  it(
    "reads a large script's `${` in strings and regular expressions with linear work",
    HANG,
    () => {
      // A `${` in a plain string or a regular expression is text, never a substitution: the
      // substitutions after many of them are read as the tokenizer pairs them.
      const d = "$";
      const strings = `"${d}{" '${d}{' x=/${d}{/g;`.repeat(40_000);
      const tail = `i.src=\`${d}{a?"}":""}//evil.example/x.png\`;e.innerHTML=\`<b ${d}{a?"{":""}>\`;`;
      assert.deepEqual(linearOrigins(`${strings}${tail}`, "script"), ["https://evil.example"]);
    },
  );

  it(
    "reads a large script's schemes written at run time and joined hosts with linear work",
    HANG,
    () => {
      // `://` after a scheme written at run time, each in a literal of its own, and hosts joined
      // to a scheme from literals or chosen among them.
      const d = "$";
      for (const [text, origins] of /** @type {[string, string[]][]} */ ([
        ['a="{s}://x.y"+b;'.repeat(50_000), ["https://x.y"]],
        [`a=\`${d}{p}://x.y\`;b={"k":/\\/\\/z\\.w\\//};`.repeat(40_000), ["https://x.y"]],
        ['u="https://"+(a?"x.y":"z.w")+"/p";'.repeat(30_000), ["https://x.y", "https://z.w"]],
        [
          `u=\`https://${d}{a?\`x.y\`:b?\`z.w\`:\`q.r\`}/p\`;`.repeat(30_000),
          ["https://x.y", "https://z.w", "https://q.r"],
        ],
        // Brackets after each of many schemes that never close: a script whose brackets do not
        // pair is refused whole (untokenized), its URLs never read in part.
        ['"://"+('.repeat(100_000), []],
        ['"https://"+('.repeat(100_000), []],
        ['"https://"+(a?"x":'.repeat(100_000), []],
        // A long run of joined empty literals: followed MAX_JOINS deep, not to its end.
        [`u="https://x.y"${'+""'.repeat(100_000)};`, ["https://x.y"]],
      ])) {
        assert.deepEqual(linearOrigins(text, "script"), origins, text.slice(0, 30));
      }
    },
  );

  it("reads a large script's srcset lists with work linear in the text", HANG, () => {
    // Keyed template lists, each walking through substitutions, and descriptors before commas.
    const d = "$";
    const lists = `i.srcset=\`${`${d}{a} 1x, `.repeat(400)}\`;`.repeat(100);
    const commas = `x=\`${"/a.png 2x, //react.dev/b.png ".repeat(20_000)}\`;`;
    const last = `jsx("img",{srcSet:\`${d}{f(\`a\`)} 1x, //evil.example/b.png 2x\`})`;
    assert.deepEqual(linearOrigins(`${lists}${commas}${last}`, "script"), [
      "https://react.dev",
      "https://evil.example",
    ]);
    // Keyed template lists whose substitutions close far away, nested in each other or closing
    // one by one: a list whose source spans more than MAX_SRCSET is refused (url-unread) without
    // its candidates being read, and a script whose literals never close is refused whole.
    for (const far of [
      `${`i.srcset=\`${d}{`.repeat(10_000)}x${"}".repeat(10_000)}\``,
      `${`srcset:\`${d}{`.repeat(6_000)}${"a".repeat(150_000)}${"}".repeat(6_000)}\``,
      `${`i.srcset=\`${d}{`.repeat(10_000)}0${"}`".repeat(10_000)}`,
    ]) {
      const { urls } = scanWork(far, { kind: "script", limit: WORK_PER_CHARACTER * far.length });
      assert.ok(
        urls.some((u) => u.unread),
        `${far.slice(0, 20)}: not refused`,
      );
    }
    // A list no key opens, read back over many commas from each of many URLs in it: each piece
    // is read back once (the answers kept for the commas passed), never again from a later URL.
    const list = `x="${"/a.png, //react.dev/b.png, ".repeat(25_000)}//evil.example/b.png 2x";`;
    assert.deepEqual(linearOrigins(list, "script"), ["https://react.dev", "https://evil.example"]);
    const plain = `x="${"/a.png, ".repeat(200_000)}//evil.example/b.png 2x";`;
    assert.deepEqual(linearOrigins(plain, "script"), ["https://evil.example"]);
  });

  it("refuses a URL that runs past what the scanner reads, never reading only its start", (t) => {
    const tab = String.fromCharCode(9);
    /** @type {[string, string, string][]} */
    const cases = [
      [
        "a user name past the bound",
        "assets/a.js",
        `location.href="https://${"a".repeat(2100)}@evil.example/c"`,
      ],
      [
        "an allowed host and port, then tabs past the bound",
        "assets/a.js",
        `fetch("https://react.dev:443${tab.repeat(2100)}@evil.example/c")`,
      ],
      [
        "a srcset that does not close",
        "index.html",
        `<img srcset="${"/a.png 1x, ".repeat(500)}//evil.example/b.png 2x>`,
      ],
      [
        "a srcset template literal whose substitution closes past the bound",
        "assets/a.js",
        `i.srcset=\`${"$"}{f(${"0,".repeat(2100)}0)}, //evil.example/b.png 2x\`;`,
      ],
    ];
    for (const [what, file, text] of cases) {
      const found = staticRules(t, { [file]: text });
      assert.ok(found.includes("url-unread"), `${what}: ${found.join()}`);
    }
    assert.deepEqual(
      staticRules(t, { "assets/a.js": `fetch("https://react.dev/${"a".repeat(3000)}")` }),
      [],
      "a long path is not a long host",
    );
  });

  it("passes the spellings a bundle uses for its own and the allowed origins", (t) => {
    /** @type {[string, string, string][]} */
    const cases = [
      [
        "protocol checks",
        "assets/a.js",
        'a.protocol==="https:"||a.protocol==="wss:";b={http:80,https:443};',
      ],
      [
        "a prefix check",
        "assets/a.js",
        'e.startsWith("https://")||e.startsWith("//");f="//"+location.host;',
      ],
      ["a UNC check", "assets/a.js", 'if(p.startsWith("\\\\\\\\"))x();'],
      [
        "regular expressions",
        "assets/a.js",
        "x=/\\/\\/+/g;y=/\\/assets\\//;z=a.replace(/\\/\\//,'/');",
      ],
      [
        "a host built at run time",
        "assets/a.js",
        `fetch(\`//${"$"}{host}/x\`);fetch(\`https://${"$"}{host}/x\`);`,
      ],
      [
        "an allowed URL in escaped HTML",
        "assets/a.js",
        'e.innerHTML="<a href=\\"https://react.dev\\">x</a>";',
      ],
      [
        "an allowed URL with escaped slashes",
        "assets/a.json",
        '{"u":"https:\\/\\/react.dev\\/errors\\/"}',
      ],
      [
        "a relative srcset",
        "index.html",
        '<img srcset="/a.png 1x, /b.png 2x, data:image/png;base64,AA== 3x">',
      ],
      [
        "an allowed namespace in a CSS data URL",
        "assets/a.css",
        "a{b:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E\")}",
      ],
      [
        "an image's own metadata",
        "assets/a.png",
        `\u{89}PNG\u{0}\u{0}http://ns.adobe.com/xap/1.0/\u{0}`,
      ],
    ];
    for (const [what, file, text] of cases) {
      assert.deepEqual(staticRules(t, { [file]: text }), [], what);
    }
  });

  it("refuses secret shapes and whatever public-safety refuses, in any built file", (t) => {
    const token = ["whsec", "_", "QmFzZTY0U2VjcmV0VmFsdWVGb3JUZXN0aW5n"].join("");
    const address = ["ops-lead", "corp.example.co"].join("@");
    const uuid = ["0f3a9c1e", "2b4d", "4e6f", "8a0c", "1e2f3a4b5c6d"].join("-");
    const home = ["", "Users", "someone", "fin"].join("/");
    const ip = [10, 1, 2, 3].join(".");
    /** @type {[string, string, string][]} */
    const cases = [
      ["a signing secret", "assets/a.js", `const s="${token}";`],
      ["a staff address", "assets/a.js", `const a="${address}";`],
      ["an ID-shaped string", "assets/a.json", `{"id":"${uuid}"}`],
      ["a local path", "assets/a.js", `const p="${home}/src/x.ts";`],
      ["a private address", "index.html", `<p>${ip}</p>`],
      ["a secret inside an image", "assets/a.png", `\u0089PNG\u0000\u0000${token}\u0000`],
    ];
    for (const [what, file, text] of cases) {
      const found = staticRules(t, { [file]: text });
      assert.ok(
        found.some((r) => r.startsWith("public-safety:")),
        `${what}: ${found.join()}`,
      );
    }
    const run = checkStatic("x", dirWith(t, { "assets/a.js": `const s="${token}";` }));
    assert.ok(
      run.every((f) => !f.message.includes(token)),
      "a finding never prints the value",
    );
  });

  it("reads a script by its tokens: a comment or a regular expression is no text a rule reads", (t) => {
    // A script the tokenizer cannot read is refused whole, never scanned in part.
    for (const text of ["const a = `", "x = a <!-- b", "f(a"]) {
      assert.deepEqual(staticRules(t, { "assets/a.js": text }), ["untokenized"], text);
    }
    // A URL, a setting's name or an import in a comment, a regular expression, or an import's
    // text in a literal, is no code's: no rule reads it.
    for (const text of [
      '// import "node:fs" and FIN_DB_PASSWORD at https://evil.example/x\nexport {};',
      '/* fetch("https://evil.example/x") */ export {};',
      "const r=/https:\\/\\/evil\\.example\\//;",
      'const s=`import { createHmac } from "node:crypto";`;',
    ]) {
      assert.deepEqual(staticRules(t, { "assets/a.js": text }), [], text);
    }
    // In a literal, the same text is read; and a sourceMappingURL counts only as a comment.
    assert.deepEqual(staticRules(t, { "assets/a.js": 'const s="FIN_DB_PASSWORD";' }), [
      "setting-name",
    ]);
    // A seam's marker is one in a comment too: a seam module carries it in a legal comment.
    assert.deepEqual(staticRules(t, { "assets/a.js": "/*! fin:test-seam */ export {};" }), [
      "seam",
    ]);
    assert.deepEqual(
      staticRules(t, { "assets/a.js": 'const s="//# sourceMappingURL=a.js.map";' }),
      [],
    );
  });

  it("refuses a server setting's name, server-only code and the test harness", (t) => {
    /** @type {[string, string, string][]} */
    const cases = [
      ["a server setting's name", 'const k="FIN_DB_PASSWORD";', "setting-name"],
      ["a node: import", 'import{readFileSync as r}from"node:fs";', "server-only"],
      ["a dynamic node: import", 'await import("node:crypto")', "server-only"],
      ["Vite's stand-in for a Node module", 'var e="__vite-browser-external";', "server-only"],
      ["the unreplaced build target", "if(__FIN_BUILD_TARGET__==='test'){}", "seam"],
      ["the test harness", 'import"@fin/testing/sink";import{a}from"@fin/testing";', "seam"],
    ];
    for (const [what, text, rule] of cases) {
      assert.ok(staticRules(t, { "assets/a.js": text }).includes(rule), what);
    }
    assert.deepEqual(
      staticRules(t, { "assets/a.js": 'const k="__FIN_X";const f="fin_x";const n="NODE_ENV";' }),
      [],
    );
    // The samples' shell variables the plan names (spec 05 §8.2, §8.8) are no setting's, in a
    // guide's page or a script's copy; a setting whose name starts the same is still refused.
    const sample = 'curl "$FIN_API_URL/v4/whoami" -H "Authorization: Bearer $FIN_KEY"';
    assert.deepEqual(
      staticRules(t, { "guides/start/index.html": `<pre><code>${sample}</code></pre>` }),
      [],
    );
    assert.deepEqual(
      staticRules(t, { "assets/a.js": `const s=${JSON.stringify(sample)},c="Copy as FIN_KEY=";` }),
      [],
    );
    // The console's key page as the build prints it (its Try it sample, its copy button's text
    // and what it copies) passes with the plan's names; a sample that names any other, after a
    // `$` included, is refused: `$FIN_API` is no name the plan gives a shell variable.
    const keysPage = (/** @type {string} */ api) =>
      `(0,Z.jsx)(w,{variant:\`block\`,label:\`Try it\`,value:\`curl "$${api}/v4/whoami" -H "Authorization: Bearer $FIN_KEY"\`});` +
      `function ve(e){return\`FIN_KEY=${"$"}{e}\`}const c=\`Copy as FIN_KEY=…\`;`;
    assert.deepEqual(staticRules(t, { "assets/keys.js": keysPage("FIN_API_URL") }), []);
    assert.deepEqual(staticRules(t, { "assets/keys.js": keysPage("FIN_API") }), ["setting-name"]);
    assert.deepEqual(
      staticRules(t, { "guides/a/index.html": '<pre><code>curl "$FIN_API/v4/x"</code></pre>' }),
      ["setting-name"],
    );
    for (const name of ["FIN_KEY_SALT", "FIN_API_ORIGIN", "FIN_API", "FIN_KEYS"]) {
      assert.deepEqual(
        staticRules(t, { "assets/a.js": `const k="${name}";` }),
        ["setting-name"],
        name,
      );
    }
  });

  it("refuses a left source map, a sourceMappingURL, and what a deployment refuses", (t) => {
    assert.deepEqual(staticRules(t, { "assets/a.js.map": "{}" }), ["source-map"]);
    assert.deepEqual(staticRules(t, { "assets/A.JS.MAP": "{}" }), ["source-map"]);
    assert.deepEqual(staticRules(t, { "assets/a.js": "x\n//# sourceMappingURL=a.js.map" }), [
      "source-map",
    ]);
    for (const file of [
      "_headers",
      "env.json",
      "ENV.JSON",
      "_worker.js",
      "_routes.json",
      "_redirects",
    ]) {
      assert.deepEqual(staticRules(t, { [file]: "x" }), ["artefact"], file);
    }
    assert.deepEqual(staticRules(t, { "assets/a%2e.js": "x" }), ["artefact"]);
  });

  it("refuses a link instead of following it", (t) => {
    const dir = dirWith(t, { "index.html": "" });
    symlinkSync("/etc/hosts", join(dir, "hosts"));
    assert.equal(checkStatic("x", dir)[0]?.rule, "link");
  });

  it("collects each origin once, lower-cased", () => {
    assert.deepEqual(
      originsIn("HTTPS://A.Example.com/x https://a.example.com/y http://b.example.org:8080/"),
      ["https://a.example.com", "http://b.example.org:8080"],
    );
    assert.deepEqual(originsIn(`\`https://$${"{host}"}/x\` https:// //`, { kind: "script" }), []);
    // Outside a script nothing is built at run time: a `$` is the host's own.
    assert.deepEqual(originsIn(`"https://$${"{host}"}/x"`), [`https://$${"{host}"}`]);
  });
});

describe("checkBundles over apps/", () => {
  it("passes with a notice when nothing is built, and fails on a finding", (t) => {
    const root = tempDir(t);
    const none = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /::notice title=bundle-check::/);
    writeTree(root, {
      "apps/api/dist/server/main.js": "ok",
      "apps/console/dist/static/index.html": '<img src="https://img.example.com/a.png">',
    });
    const result = checkBundles(root);
    assert.equal(result.server, 1);
    assert.equal(result.static, 1);
    assert.equal(result.findings.length, 1);
    const run = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /bundle-check\.result result=fail server=1 static=1 findings=1/);
  });
});

describe("staged release artefacts (--artefacts)", () => {
  it("checks every staged artefact, carried assets included, and refuses a stray entry", (t) => {
    const dir = tempDir(t);
    writeTree(dir, {
      "console/index.html": "<p>",
      "console/assets/app-2.js": "ok",
      "verify/index.html": "<p>",
      "verify/assets/app-1.js": 'const k="FIN_EMAIL_TOKEN";',
    });
    const result = checkArtefacts(dir);
    assert.equal(result.static, 2);
    assert.deepEqual(
      result.findings.map((f) => `${f.file}:${f.rule}`),
      ["artefact verify/assets/app-1.js:setting-name"],
    );
    writeTree(dir, { "stray.txt": "x" });
    assert.ok(checkArtefacts(dir).findings.some((f) => f.file === "artefact stray.txt"));
    const run = spawnSync(process.execPath, [SCRIPT, "--artefacts", dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /bundle-check\.result result=fail server=0 static=2 findings=2/);
  });

  it("applies the overlay's refuse list when FIN_OVERLAY_FILE names one", (t) => {
    const dir = tempDir(t);
    const zone = ["zone-under", "test", "example"].join(".");
    writeTree(dir, {
      "overlay.json": JSON.stringify({ refuseList: [zone] }),
      "staged/console/index.html": `<p>${zone}</p>`,
    });
    const env = { PATH: process.env.PATH, FIN_OVERLAY_FILE: join(dir, "overlay.json") };
    const run = spawnSync(process.execPath, [SCRIPT, "--artefacts", join(dir, "staged")], {
      encoding: "utf8",
      env,
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /public-safety:refuse-list/);
    assert.doesNotMatch(run.stdout, new RegExp(zone.replaceAll(".", "\\.")));
  });
});
