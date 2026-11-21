// imports:check, with the planted cases of AC-P0-22. Fixture sources are arrays of lines, so no
// line of this file starts with an import a check could mistake for this file's own.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { checkImports, checkSource, findImports } from "../import-rules.mjs";
import { cleanUp, makeRepo, REPO_ROOT, rules, runScript } from "./helpers.mjs";

after(cleanUp);

/** @param {string[]} lines */
const src = (...lines) => `${lines.join("\n")}\n`;
/** @param {string} specifier */
const imp = (specifier) => src(`import x from "${specifier}";`);
const REQ = ["req", "uire"].join("");
const DYN = ["imp", "ort"].join("");
const BUN_SERVE = ["Bun", "serve"].join(".");
const CONSOLE_ERROR = ["console", "error"].join(".");

describe("imports:check", () => {
  test("node:http outside packages/server and apps/connector fails; inside passes", () => {
    for (const module of [
      "node:http",
      "node:https",
      "node:net",
      "node:dns",
      "node:cluster",
      "node:worker_threads",
    ]) {
      assert.deepEqual(
        rules(checkSource("apps/api/src/main.ts", imp(module))),
        ["node-network"],
        module,
      );
    }
    assert.deepEqual(checkSource("packages/server/src/http.ts", imp("node:http")), []);
    assert.deepEqual(checkSource("apps/connector/src/main.ts", imp("node:net")), []);
  });

  test("a node:* import in client code fails", () => {
    for (const file of [
      "apps/console/src/client/main.tsx",
      "packages/ui/src/button.tsx",
      "packages/tokens/src/x.ts",
      "packages/frame/src/x.ts",
      "packages/app-contracts/src/x.ts",
    ]) {
      assert.deepEqual(rules(checkSource(file, imp("node:crypto"))), ["client-node"], file);
    }
    assert.deepEqual(checkSource("apps/console/src/server/main.ts", imp("node:crypto")), []);
  });

  test("a server package in client code fails", () => {
    assert.deepEqual(rules(checkSource("apps/console/src/client/a.ts", imp("@fin/db"))), [
      "client-server-package",
    ]);
    assert.deepEqual(rules(checkSource("apps/console/src/client/a.ts", imp("hono/client"))), [
      "client-server-package",
    ]);
    assert.deepEqual(checkSource("apps/console/src/client/a.ts", imp("@fin/ui")), []);
  });

  test("an @ui-sdk/* import in a screen fails; inside packages/ui it passes", () => {
    assert.deepEqual(
      rules(checkSource("apps/console/src/client/routes/home.tsx", imp("@ui-sdk/react"))),
      ["ui-sdk-outside-ui"],
    );
    assert.deepEqual(
      rules(checkSource("packages/frame/src/app-frame.tsx", imp("@ui-sdk/react/dialog"))),
      ["ui-sdk-outside-ui"],
    );
    assert.deepEqual(checkSource("packages/ui/src/button.tsx", imp("@ui-sdk/react")), []);
  });

  test("the refused SDK entries are refused inside packages/ui too", () => {
    for (const entry of [
      "@ui-sdk/react/agent",
      "@ui-sdk/core/agent",
      "@ui-sdk/react/preferences",
      "@ui-sdk/react/token-input",
      "@ui-sdk/core/web.css",
      "@ui-sdk/react/timeline",
    ]) {
      assert.deepEqual(
        rules(checkSource("packages/ui/src/x.tsx", imp(entry))),
        ["ui-sdk-refused-entry"],
        entry,
      );
    }
    assert.deepEqual(
      rules(
        checkSource(
          "packages/ui/src/x.tsx",
          src('import { createGridFocus, other } from "@ui-sdk/core";'),
        ),
      ),
      ["ui-sdk-refused-entry"],
    );
    assert.deepEqual(rules(checkSource("packages/ui/src/x.tsx", imp("@ui-sdk/core/testing"))), [
      "ui-sdk-testing",
    ]);
    assert.deepEqual(checkSource("packages/ui/src/x.test.tsx", imp("@ui-sdk/core/testing")), []);
  });

  test("a non-built-in import in ops/fin, tools/static-deploy/src or packages/web-host/src/static fails", () => {
    for (const file of [
      "ops/fin/src/main.ts",
      "tools/static-deploy/src/deploy.ts",
      "packages/web-host/src/static/render.ts",
      "tools/fin-review/src/plan/plan.ts",
    ]) {
      assert.deepEqual(rules(checkSource(file, imp("zod"))), ["builtins-only"], file);
      assert.deepEqual(
        checkSource(
          file,
          src('import { readFileSync } from "node:fs";', 'import { a } from "./a.ts";'),
        ),
        [],
        file,
      );
    }
    assert.deepEqual(checkSource("ops/fin/src/main.test.ts", imp("vitest")), []);
    assert.deepEqual(rules(checkSource("ops/fin/src/main.test.ts", imp("zod"))), ["builtins-only"]);
  });

  test("the watcher uses relative imports only", () => {
    assert.deepEqual(rules(checkSource("ops/watcher/src/index.ts", imp("node:fs"))), [
      "relative-only",
    ]);
    assert.deepEqual(checkSource("ops/watcher/src/index.ts", imp("./checks.ts")), []);
  });

  test("refused packages fail anywhere", () => {
    for (const name of [
      "clsx",
      "tailwind-merge",
      "@radix-ui/react-dialog",
      "@phosphor-icons/react",
      "react-router-dom",
      "@remix-run/react",
      "@tanstack/react-start/server",
      "@tanstack/start-client-core",
    ]) {
      assert.deepEqual(
        rules(checkSource("packages/ui/src/x.ts", imp(name))),
        ["refused-package"],
        name,
      );
    }
  });

  test("Bun fails", () => {
    assert.deepEqual(rules(checkSource("apps/api/src/a.ts", imp("bun:sqlite"))), ["no-bun"]);
    assert.deepEqual(rules(checkSource("apps/api/src/a.ts", imp("drizzle-orm/bun-sql"))), [
      "no-bun",
    ]);
    assert.deepEqual(rules(checkSource("apps/api/src/a.ts", src(`const s = ${BUN_SERVE}({});`))), [
      "no-bun",
    ]);
  });

  test("dynamic import() and require() are read too", () => {
    assert.deepEqual(
      rules(checkSource("apps/api/src/a.ts", src(`const h = await ${DYN}("node:http");`))),
      ["node-network"],
    );
    assert.deepEqual(
      rules(checkSource("apps/api/src/a.cjs", src(`const h = ${REQ}("node:net");`))),
      ["node-network"],
    );
    assert.deepEqual(rules(checkSource("ops/fin/src/a.ts", src(`const m = await ${DYN}(name);`))), [
      "dynamic-import",
    ]);
  });

  test("built-ins need their node: name", () => {
    assert.deepEqual(rules(checkSource("apps/api/src/a.ts", imp("fs"))), ["node-prefix"]);
    assert.deepEqual(rules(checkSource("apps/api/src/a.ts", imp("http"))), [
      "node-network",
      "node-prefix",
    ]);
  });

  test("relative imports name the file, by its .ts name", () => {
    assert.deepEqual(rules(checkSource("apps/api/src/a.ts", imp("./b"))), ["relative-extension"]);
    const exists = (/** @type {string} */ p) => p === "apps/api/src/b.ts";
    assert.deepEqual(rules(checkSource("apps/api/src/a.ts", imp("./b.js"), exists)), [
      "relative-extension",
    ]);
    assert.deepEqual(checkSource("apps/api/src/a.ts", imp("./b.ts"), exists), []);
    assert.deepEqual(checkSource("apps/console/src/client/a.tsx", imp("./logo.svg?raw")), []);
  });

  test("logging an error object straight to the console fails", () => {
    assert.deepEqual(
      rules(
        checkSource(
          "apps/api/src/a.ts",
          src("} catch (error) {", `  ${CONSOLE_ERROR}(error);`, "}"),
        ),
      ),
      ["console-error"],
    );
    assert.deepEqual(checkSource("apps/api/src/a.ts", src(`${CONSOLE_ERROR}("starting");`)), []);
  });

  test("multi-line imports, re-exports and type imports are read", () => {
    const { imports } = findImports(
      src(
        "import {",
        "  a,",
        "  type B,",
        '} from "node:http";',
        'export * from "clsx";',
        'import type { C } from "@ui-sdk/react";',
      ),
    );
    assert.deepEqual(
      imports.map((i) => [i.specifier, i.line]),
      [
        ["node:http", 1],
        ["clsx", 5],
        ["@ui-sdk/react", 6],
      ],
    );
  });

  test("a repository with planted imports fails, and this repository passes", () => {
    const dir = makeRepo({
      "apps/api/src/main.ts": imp("node:http"),
      "apps/console/src/client/home.tsx": imp("@ui-sdk/react"),
      "ops/fin/src/main.ts": imp("zod"),
    });
    assert.deepEqual(rules(checkImports(dir)), [
      "builtins-only",
      "node-network",
      "ui-sdk-outside-ui",
    ]);
    const run = runScript("scripts/import-rules.mjs", ["--root", dir]);
    assert.equal(run.status, 1);
    assert.match(run.output, /^apps\/api\/src\/main\.ts:1 node-network: /m);
    assert.deepEqual(checkImports(REPO_ROOT), []);
  });
});
