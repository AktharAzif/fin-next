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
  urlsIn,
} from "../bundle-check.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../bundle-check.mjs", import.meta.url));

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
    ];
    for (const [what, file, text] of cases) {
      const found = staticRules(t, { [file]: text });
      assert.ok(
        found.includes("third-party-origin") || found.includes("url-userinfo"),
        `${what}: ${found.join()}`,
      );
    }
    for (const text of [
      'jsx("img",{srcSet:"/a.png 1x, /b.png 2x"})',
      "e.srcset=t.srcset,e.sizes=n;x=/\\/\\//.test(b);",
      "a=[1, //evil.example/x\n2]",
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
    ];
    for (const [what, text] of cases) {
      const found = staticRules(t, { "assets/a.js": text });
      assert.ok(
        found.includes("third-party-origin") || found.includes("url-userinfo"),
        `${what}: ${found.join()}`,
      );
    }
    // A regular expression's `=/\/x\//` is in no start tag, whatever `<` stands before it.
    for (const text of [
      "for(let e=0;e<t.length;e++){const n=/\\/assets\\//;}",
      "if(a<b){x=1}y=/\\/assets\\//;",
      "e.innerHTML='<b>x</b>';y=/\\/assets\\//;",
      "e.innerHTML='<img src=//react.dev/a.png>';",
    ]) {
      assert.deepEqual(staticRules(t, { "assets/a.js": text }), [], text);
    }
  });

  it("reads a large script's tags in one pass, its regular expressions left alone", {
    timeout: 10_000,
  }, () => {
    const code = "for(let e=0;e<t.length;e++){const n=/\\/assets\\//;a=>b}".repeat(30_000);
    assert.deepEqual(urlsIn(code, { kind: "script" }), []);
    const written = `${code}e.innerHTML='<p title="a>b"><img alt=x src=//collector.evil.example/p.png>';`;
    assert.deepEqual(originsIn(written, { kind: "script" }), ["https://collector.evil.example"]);
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
    assert.deepEqual(originsIn(`\`https://$${"{host}"}/x\` https:// //`), []);
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
