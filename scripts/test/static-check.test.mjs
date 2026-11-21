// static:check: the static.json allowlist, the built output's rules, and rendered _headers.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  checkCss,
  checkHeaders,
  checkIndexHtml,
  checkStatic,
  checkStaticJson,
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
    // A sub-layer of ui-sdk is not the layer either (\b would have matched before "." and "-").
    for (const first of ["@layer ui-sdk.inner;", "@layer ui-sdk-extra; a{}"]) {
      assert.deepEqual(rules(checkCss("a.css", `${first}\n`)), ["static-css"], first);
    }
  });

  test("a source map, a built _headers or env.json fails", () => {
    for (const extra of [
      { "assets/index-abc123.js.map": "{}" },
      { _headers: "/*\n" },
      { "env.json": "{}" },
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
