// static:check: the static.json allowlist, the built output's rules, and rendered _headers.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  checkCss,
  checkEncoding,
  checkHeaders,
  checkIndexHtml,
  checkStatic,
  checkStaticJson,
  htmlStartTags,
} from "../static-check.mjs";
import { cleanUp, makeRepo, REPO_ROOT, rules, runScript, writeFiles } from "./helpers.mjs";

after(cleanUp);

const STATIC_JSON = {
  compatibility_date: "2026-11-20",
  assets: { not_found_handling: "single-page-application", html_handling: "auto-trailing-slash" },
  workers_dev: false,
  preview_urls: false,
};
const INDEX = [
  "<!doctype html>",
  '<html lang="en"><head>',
  '<meta charset="utf-8"><meta property="csp-nonce">',
  '<script src="/theme.js"></script>',
  '<script type="module" src="/assets/index-abc123.js"></script>',
  '<link rel="stylesheet" href="/assets/index-abc123.css">',
  '</head><body><div id="root" class="skeleton"></div></body></html>',
].join("\n");
const CSS = "@layer ui-sdk;\n@layer base{body{margin:0}}\n";
const LAYOUT = JSON.stringify({
  version: 1,
  controlPaths: [],
  entries: [
    { path: "apps/console", static: "console" },
    { path: "apps/verify", static: ["verify", "selfie"] },
  ],
});

/** @param {Record<string, string>} files */
function repo(files) {
  return makeRepo({ "tools/layout.json": LAYOUT, ...files });
}

const built = (/** @type {string} */ base, /** @type {Record<string, string>} */ extra = {}) => ({
  [`${base}/index.html`]: INDEX,
  [`${base}/assets/index-abc123.css`]: CSS,
  [`${base}/assets/index-abc123.js`]: "console.log(1);\n",
  ...extra,
});

describe("static:check", () => {
  test("passes with a notice while no app has a static build", () => {
    const { findings, notices } = checkStatic(repo({}));
    assert.deepEqual(findings, []);
    assert.equal(notices.length, 1);
    const run = runScript("scripts/static-check.mjs", ["--root", REPO_ROOT]);
    assert.equal(run.status, 0);
    assert.match(run.output, /notice: no app has a static build yet/);
  });

  test("a valid static.json and build pass, verify's two outputs included", () => {
    const dir = repo({
      "apps/console/static.json": JSON.stringify(STATIC_JSON),
      ...built("apps/console/dist/static"),
      ...built("apps/verify/dist/static/verify"),
      ...built("apps/verify/dist/static/selfie"),
    });
    const { findings, notices } = checkStatic(dir);
    assert.deepEqual(findings, []);
    assert.deepEqual(notices, []);
  });

  test("static.json outside the allowlist fails", () => {
    for (const bad of [
      { ...STATIC_JSON, main: "src/worker.ts" },
      { ...STATIC_JSON, workers_dev: true },
      { ...STATIC_JSON, preview_urls: true },
      { ...STATIC_JSON, kv_namespaces: [] },
      { ...STATIC_JSON, assets: { ...STATIC_JSON.assets, run_worker_first: true } },
      { ...STATIC_JSON, assets: { ...STATIC_JSON.assets, binding: "ASSETS" } },
      { ...STATIC_JSON, assets: { ...STATIC_JSON.assets, not_found_handling: "404-page" } },
      { compatibility_date: "2026-11-20", workers_dev: false, preview_urls: false },
      // Spec 01 §7.4 fixes one compatibility date for every deployment.
      { ...STATIC_JSON, compatibility_date: "2020-01-01" },
      { ...STATIC_JSON, compatibility_date: "2026-11-21" },
    ]) {
      assert.deepEqual(
        rules(checkStaticJson("apps/console/static.json", bad)),
        ["static-json"],
        JSON.stringify(bad),
      );
    }
    assert.deepEqual(checkStaticJson("s.json", STATIC_JSON), []);
  });

  test("index.html breaking the page policy fails", () => {
    for (const bad of [
      INDEX.replace('<meta property="csp-nonce">', ""),
      INDEX.replace('<meta property="csp-nonce">', '<meta property="csp-nonce" nonce="abc">'),
      INDEX.replace("</head>", "<script>window.x=1</script></head>"),
      INDEX.replace('class="skeleton"', 'style="color:red"'),
      INDEX.replace('class="skeleton"', 'onclick="go()"'),
      INDEX.replace("</head>", "<style>body{}</style></head>"),
    ]) {
      assert.deepEqual(rules(checkIndexHtml("index.html", bad)), ["static-html"], bad);
    }
    assert.deepEqual(checkIndexHtml("index.html", INDEX), []);
  });

  test("index.html is read as a browser reads it: every spelling of a handler, style or script fails", () => {
    for (const html of [
      '<img/src="x"/onerror=alert(1)>',
      "<svg/onload=alert(1)>",
      '<img alt=">" onerror=alert(1)>',
      "<img alt='>' onerror=alert(1)>",
      '<div/style="color:red">',
      "<IMG SRC=x ONERROR=alert(1)>",
      "<img src=x\nonerror=alert(1)>",
      "<script>alert(1)</script >",
      "<script>alert(1)</script\t>",
      "<SCRIPT>alert(1)</SCRIPT>",
      '<script src="/a.js">alert(1)</script>',
      "<script>alert(1)",
      "<svg><style>x{}</style></svg>",
      "<p nonce=abc>x</p>",
    ]) {
      const page = INDEX.replace("</head>", `${html}</head>`);
      assert.deepEqual(rules(checkIndexHtml("index.html", page)), ["static-html"], html);
    }
  });

  test("markup a browser reads as text or a comment is not a tag", () => {
    for (const html of [
      "<!-- <img src=x onerror=alert(1)> -->",
      "<!--> <p>x</p>",
      "<title>a <img onerror=x> b</title>",
      "<textarea><div style=x></div></textarea>",
      "<p>1 < 2 and a <= b</p>",
      "</p onclick=x>",
      // An unquoted value runs to whitespace or `>`, so this `/onerror=...` is part of src.
      "<img/src=x/onerror=alert(1)>",
    ]) {
      const page = INDEX.replace("<body>", `<body>${html}`);
      assert.deepEqual(checkIndexHtml("index.html", page), [], html);
    }
    assert.deepEqual(
      checkIndexHtml(
        "index.html",
        INDEX.replace('<meta property="csp-nonce">', "<meta property=csp-nonce>"),
      ),
      [],
    );
  });

  test("where a raw-text or RCDATA element ends is found in the text as written", () => {
    // U+0130 lowercases to two code units, so offsets in a lowercased copy run ahead of the text.
    const dotted = "\u{130}".repeat(40);
    for (const element of ["textarea", "noscript", "title", "xmp", "TEXTAREA"]) {
      for (const [after, message] of /** @type {[string, string][]} */ ([
        ["<script>alert(1)</script>", "no inline script; every script is an external file"],
        ["<img src=x onerror=alert(1)>", "no inline event handler (script-src 'self')"],
      ])) {
        const html = `${dotted}<${element}>x</${element}>${after}`;
        const findings = checkIndexHtml("index.html", INDEX.replace("<body>", `<body>${html}`));
        assert.deepEqual(
          findings.map((f) => f.message),
          [message],
          `${element} ${after}`,
        );
      }
    }
  });

  test("tag and attribute names are lowercased in ASCII only, as the tokenizer does", () => {
    const [tag] = htmlStartTags("<DIV ONCLICK=x DATA-\u{212A}=1 \u{130}D=y>");
    assert.equal(tag?.name, "div");
    assert.deepEqual([...(tag?.attributes.keys() ?? [])], ["onclick", "data-\u{212A}", "\u{130}d"]);
    assert.deepEqual(
      htmlStartTags("<SCR\u{130}PT>x</SCR\u{130}PT>").map((t) => t.name),
      ["scr\u{130}pt"],
    );
  });

  test("SVG and MathML, inside which a browser reads raw-text elements as markup, fail", () => {
    for (const html of [
      '<svg><title><img src="x" onerror="alert(1)"></title></svg>',
      "<svg><noscript><img src=x onerror=alert(1)></noscript></svg>",
      "<svg><iframe><img src=x onerror=alert(1)></iframe></svg>",
      '<svg><xmp><a onclick="go()">x</a></xmp></svg>',
      '<svg><textarea><rect style="fill:red"></textarea></svg>',
      "<svg><noscript><script>alert(1)</script></noscript></svg>",
      "<math><xmp><img src=x onerror=alert(1)></xmp></math>",
      '<math><noembed><p style="x">y</p></noembed></math>',
      "<SVG viewBox='0 0 1 1'></SVG>",
      "<template><svg></svg></template>",
    ]) {
      const page = INDEX.replace("<body>", `<body>${html}`);
      const findings = checkIndexHtml("index.html", page);
      assert.deepEqual(rules(findings), ["static-html"], html);
      assert.ok(
        findings.some((f) => /<(svg|math)> element/.test(f.message)),
        html,
      );
    }
  });

  test("a javascript: URL or a srcdoc, which hold inline script, fails in every spelling", () => {
    for (const html of [
      '<a href="javascript:alert(1)">x</a>',
      "<a href='JavaScript:alert(1)'>x</a>",
      '<a href=" java\tscript:alert(1)">x</a>',
      '<a href="&#106;avascript&colon;alert(1)">x</a>',
      '<a href="&#x6A;avascript&#58alert(1)">x</a>',
      '<form action="vbscript:x"></form>',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
      '<iframe srcdoc="<p>x</p>"></iframe>',
    ]) {
      const page = INDEX.replace("<body>", `<body>${html}`);
      assert.deepEqual(rules(checkIndexHtml("index.html", page)), ["static-html"], html);
    }
    assert.deepEqual(
      checkIndexHtml(
        "index.html",
        INDEX.replace("<body>", '<body><a href="/javascript-guide">x</a>'),
      ),
      [],
    );
  });

  test("a built file a browser would decode otherwise than as UTF-8 fails", () => {
    const html = Buffer.from(INDEX);
    assert.deepEqual(checkEncoding("index.html", html, true), []);
    assert.deepEqual(
      checkEncoding("index.html", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), html]), true),
      [],
    );
    for (const bytes of [
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(INDEX, "utf16le")]),
      Buffer.from(INDEX, "utf16le"),
      Buffer.from(INDEX.replace("<body>", "<body><\x1b(Bimg src=x onerror=alert(1)>")),
      Buffer.from(INDEX.replace("<body>", "<body>\0")),
    ]) {
      assert.deepEqual(rules(checkEncoding("index.html", bytes, true)), ["static-encoding"]);
    }
    assert.deepEqual(
      rules(checkEncoding("a.css", Buffer.from("@layer ui-sdk;\0", "utf16le"), false)),
      ["static-encoding"],
    );
    assert.deepEqual(checkEncoding("a.js", Buffer.from("const a = '\x1b';\n"), false), []);
    const dir = repo({
      "apps/console/static.json": JSON.stringify(STATIC_JSON),
      ...built("apps/console/dist/static"),
    });
    writeFileSync(
      join(dir, "apps/console/dist/static/index.html"),
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(INDEX.replace("<body>", "<body><img onerror=x>"), "utf16le"),
      ]),
    );
    assert.deepEqual(rules(checkStatic(dir).findings), ["static-encoding", "static-html"]);
  });

  test("CSS must start with @layer ui-sdk and hold no data: URL", () => {
    assert.deepEqual(rules(checkCss("a.css", "body{margin:0}\n")), ["static-css"]);
    assert.deepEqual(
      rules(checkCss("a.css", `${CSS}.x{background:url(data:image/png;base64,AAAA)}`)),
      ["static-css"],
    );
    assert.deepEqual(checkCss("a.css", `/* banner */\n${CSS}`), []);
    for (const first of ["@layer ui-sdk, base;", "@layer ui-sdk,theme,base;", "@layer ui-sdk{}"]) {
      assert.deepEqual(checkCss("a.css", `${first}\nbody{margin:0}\n`), [], first);
    }
    for (const first of ["@layer ui-sdk-overrides;", "@layer ui-sdkx;", "@layer base, ui-sdk;"]) {
      assert.deepEqual(rules(checkCss("a.css", `${first}\n`)), ["static-css"], first);
    }
  });

  test("a source map, a built _headers or env.json fails", () => {
    for (const extra of [
      { "assets/index-abc123.js.map": "{}" },
      { _headers: "/*\n" },
      { "env.json": "{}" },
      // In any case, and a script by any of its extensions.
      { "assets/index-abc123.js.MAP": "{}" },
      { _HEADERS: "/*\n" },
      { "assets/chunk.mjs": 'const u = "data:text/html,x";\n' },
      { "assets/chunk.CJS": 'const u = "data:text/html,x";\n' },
      { "assets/theme.CSS": "body{margin:0}\n" },
    ]) {
      const files = built("apps/console/dist/static");
      for (const [k, v] of Object.entries(extra)) files[`apps/console/dist/static/${k}`] = v;
      assert.equal(checkStatic(repo(files)).findings.length, 1, String(Object.keys(extra)[0]));
    }
  });

  test("rendered _headers: no unsafe-* or data: outside the docs exception", () => {
    const csp = (/** @type {string} */ policy) => `/*\n  Content-Security-Policy: ${policy}\n`;
    assert.deepEqual(
      checkHeaders(
        "console/_headers",
        csp("default-src 'none'; script-src 'self'; style-src 'self'"),
        "console",
      ),
      [],
    );
    assert.deepEqual(
      rules(checkHeaders("console/_headers", csp("script-src 'self' 'unsafe-inline'"), "console")),
      ["static-headers"],
    );
    assert.deepEqual(
      rules(checkHeaders("console/_headers", csp("img-src 'self' data:"), "console")),
      ["static-headers"],
    );
    assert.deepEqual(
      checkHeaders(
        "docs/_headers",
        csp("style-src 'self' 'unsafe-inline'; img-src 'self' data:"),
        "docs",
      ),
      [],
    );
    assert.deepEqual(
      rules(checkHeaders("docs/_headers", csp("script-src 'self' 'unsafe-eval'"), "docs")),
      ["static-headers"],
    );
    const rendered = mkdtempSync(join(tmpdir(), "fin-rendered-"));
    writeFiles(rendered, { "console/_headers": csp("script-src 'self' 'unsafe-inline'") });
    assert.equal(checkStatic(repo({}), { rendered }).findings.length, 1);
  });

  test("with --rendered, an existing app's output with no rendered _headers fails", () => {
    const rendered = mkdtempSync(join(tmpdir(), "fin-rendered-"));
    const apps = repo({
      "apps/console/static.json": JSON.stringify(STATIC_JSON),
      "apps/verify/static.json": JSON.stringify(STATIC_JSON),
    });
    writeFiles(rendered, {
      "verify/_headers": "/*\n  Content-Security-Policy: default-src 'none'\n",
    });
    const { findings } = checkStatic(apps, { rendered });
    assert.deepEqual(
      findings.map((f) => `${f.file} ${f.rule}`),
      ["console/_headers static-headers-missing", "selfie/_headers static-headers-missing"],
    );
    writeFiles(rendered, {
      "console/_headers": "/*\n  Content-Security-Policy: default-src 'none'\n",
      "selfie/_headers": "/*\n  Content-Security-Policy: default-src 'none'\n",
    });
    assert.deepEqual(checkStatic(apps, { rendered }).findings, []);
  });

  test("the command refuses an argument it cannot read instead of skipping a check", () => {
    for (const args of [
      ["--rendered"],
      ["--rendered", "--root", REPO_ROOT],
      ["--render", "x"],
      ["--rendered", "/nonexistent/dir"],
    ]) {
      const run = runScript("scripts/static-check.mjs", ["--root", REPO_ROOT, ...args]);
      assert.equal(run.status, 2, args.join(" "));
    }
  });
});
