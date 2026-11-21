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
