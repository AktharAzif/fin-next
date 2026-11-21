// imports:check, with the planted cases of AC-P0-22. The check reads import-shaped text anywhere,
// strings included, so every fixture builds its keywords at run time: no line of this file holds
// an import, a re-export or a loading call that the check could take for this file's own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { checkImports, checkSource, codeMask, findImports } from "../import-rules.mjs";
import { cleanUp, makeRepo, REPO_ROOT, rules, runScript } from "./helpers.mjs";

after(cleanUp);

const IMP = ["imp", "ort"].join("");
const EXP = ["exp", "ort"].join("");
const REQ = ["req", "uire"].join("");
const GBM = ["getBuiltin", "Module"].join("");
const BUN_SERVE = ["Bun", "serve"].join(".");
const CONSOLE_ERROR = ["console", "error"].join(".");

/** @param {string[]} lines */
const src = (...lines) => `${lines.join("\n")}\n`;
/** @param {string} specifier */
const imp = (specifier) => src(`${IMP} x from "${specifier}";`);
const CONTROL = { controlPaths: ["ops/fin/", ".github/", "scripts/check-supply-chain.mjs"] };

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
    for (const clause of ["{ createGridFocus, other }", '{ "createGridFocus" as grid }']) {
      assert.deepEqual(
        rules(checkSource("packages/ui/src/x.tsx", src(`${IMP} ${clause} from "@ui-sdk/core";`))),
        ["ui-sdk-refused-entry"],
        clause,
      );
    }
    assert.deepEqual(rules(checkSource("packages/ui/src/x.tsx", imp("@ui-sdk/core/testing"))), [
      "ui-sdk-testing",
    ]);
    assert.deepEqual(checkSource("packages/ui/src/x.test.tsx", imp("@ui-sdk/core/testing")), []);
  });

  test("a non-built-in import in ops/fin, tools/static-deploy/src, packages/web-host/src/static or scripts fails", () => {
    for (const file of [
      "ops/fin/src/main.ts",
      "tools/static-deploy/src/deploy.ts",
      "packages/web-host/src/static/render.ts",
      "tools/fin-review/src/plan/plan.ts",
      "scripts/check.mjs",
    ]) {
      assert.deepEqual(rules(checkSource(file, imp("zod"))), ["builtins-only"], file);
      assert.deepEqual(
        checkSource(
          file,
          src(`${IMP} { readFileSync } from "node:fs";`, `${IMP} { a } from "./a.ts";`),
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
      "@fontsource/inter",
      "@fontsource-variable/inter",
      "@fontsource-variable/inter/wght.css",
    ]) {
      assert.deepEqual(
        rules(checkSource("packages/ui/src/x.ts", imp(name))),
        ["refused-package"],
        name,
      );
    }
    assert.deepEqual(
      rules(checkSource("packages/tokens/src/x.ts", src(`${IMP} "@fontsource-variable/inter";`))),
      ["refused-package"],
    );
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
      rules(checkSource("apps/api/src/a.ts", src(`const h = await ${IMP}("node:http");`))),
      ["node-network"],
    );
    assert.deepEqual(
      rules(checkSource("apps/api/src/a.cjs", src(`const h = ${REQ}("node:net");`))),
      ["node-network"],
    );
    assert.deepEqual(
      rules(checkSource("apps/api/src/a.cts", src(`${IMP} h = ${REQ}("node:http");`))),
      ["node-network"],
    );
    assert.deepEqual(rules(checkSource("ops/fin/src/a.ts", src(`const m = await ${IMP}(name);`))), [
      "dynamic-import",
    ]);
    // A literal that is only the start of the argument is not what the call loads.
    for (const call of [`${REQ}("node:" + "http")`, `${IMP}("node:" + kind)`]) {
      assert.deepEqual(
        rules(checkSource("packages/ui/src/a.ts", src(`const m = ${call};`))),
        ["dynamic-import"],
        call,
      );
    }
    // In a comment, in a restricted area, it still fails closed.
    assert.deepEqual(
      rules(checkSource("ops/fin/src/a.ts", src(`// m = await ${IMP}(name)`, "export {};"))),
      ["dynamic-import"],
    );
  });

  test("getBuiltinModule loads a module like an import", () => {
    assert.deepEqual(
      rules(checkSource("packages/ui/src/x.ts", src(`const http = process.${GBM}("node:http");`))),
      ["client-node", "node-network"],
    );
    assert.deepEqual(
      rules(checkSource("apps/api/src/x.ts", src(`const m = process.${GBM}(kind);`))),
      ["dynamic-import"],
    );
    assert.deepEqual(
      rules(checkSource("packages/ui/src/x.ts", src(`const m = process["${GBM}"]("node:fs");`))),
      ["dynamic-import"],
    );
  });

  test("other ways to load code unseen fail where every import must be read", () => {
    const [createRequire, binding, fn, evaluate] = [
      ["create", "Require"],
      ["process", "binding"],
      ["new Func", "tion"],
      ["ev", "al"],
    ].map((parts) => parts.join(parts[0] === "process" ? "." : ""));
    for (const line of [
      `const r = ${createRequire}(${IMP}.meta.url);`,
      `const b = ${binding}('fs');`,
      `const f = ${fn}('return 1');`,
      `const v = ${evaluate}('1');`,
    ]) {
      assert.deepEqual(rules(checkSource("ops/fin/src/a.ts", src(line))), ["dynamic-import"], line);
      assert.deepEqual(checkSource("apps/api/src/a.ts", src(line)), [], line);
    }
  });

  test("string names in an import's clause are read", () => {
    assert.deepEqual(
      rules(
        checkSource(
          "packages/ui/src/x.ts",
          src(`${IMP} { "createServer" as cs } from "node:http";`),
        ),
      ),
      ["client-node", "node-network"],
    );
    assert.deepEqual(
      rules(checkSource("ops/fin/src/x.ts", src(`${IMP} { "Hono" as H } from "hono";`))),
      ["builtins-only"],
    );
    assert.deepEqual(
      rules(checkSource("packages/ui/src/x.ts", src(`${EXP} { "a b" as c } from "clsx";`))),
      ["refused-package"],
    );
  });

  test("an import anywhere in a line, or after a comment in its clause, is read", () => {
    for (const [file, line, rule] of /** @type {[string, string, string][]} */ ([
      ["ops/fin/src/a.ts", `const a = 1; ${IMP} x from "node-fetch";`, "builtins-only"],
      ["tools/static-deploy/src/a.ts", `let a; ${IMP} x from "left-pad";`, "builtins-only"],
      ["ops/watcher/src/a.ts", `const a = 1; ${IMP} x from "node:fs";`, "relative-only"],
      ["packages/ui/src/a.ts", `;${IMP} cn from "clsx";`, "refused-package"],
      ["packages/ui/src/a.ts", `/* x */ ${EXP} * from "clsx";`, "refused-package"],
    ])) {
      assert.deepEqual(rules(checkSource(file, src(line))), [rule], line);
    }
    const clause = src(`${IMP} {`, "  createServer, // the server's own", '} from "node:http";');
    assert.deepEqual(rules(checkSource("packages/ui/src/a.ts", clause)), [
      "client-node",
      "node-network",
    ]);
  });

  test("ordinary code that only mentions the keyword is not an import", () => {
    for (const line of [
      'for (const key of ["import", "default", "node", "types"]) {}',
      'switch (kind) { case "import": return "x"; }',
      "const conditions = { import: './x.js', require: './x.cjs' };",
      'type Kind = Pick<Options, "from" | "to">;',
    ]) {
      assert.deepEqual(checkSource("tools/fin-review/src/plan/graph.ts", src(line)), [], line);
    }
  });

  test("a URL import, which could hold imports of its own, fails anywhere", () => {
    for (const specifier of [
      "data:text/javascript,export default 1",
      "file:///tmp/x.mjs",
      "https://example.com/x.js",
    ]) {
      assert.deepEqual(
        rules(checkSource("apps/api/src/a.ts", imp(specifier))),
        ["absolute-import"],
        specifier,
      );
    }
  });

  test("in code that runs, import-shaped text in a string fails closed", () => {
    assert.deepEqual(
      rules(checkSource("ops/fin/src/a.ts", src(`const s = '${IMP} x from "zod";';`))),
      ["builtins-only"],
    );
    assert.deepEqual(
      rules(checkSource("packages/ui/src/a.ts", src(`// ${IMP} cn from "clsx"`, "export {};"))),
      ["refused-package"],
    );
  });

  test("in a test file, fixtures in strings, comments and template text are skipped, and code is read", () => {
    const fixture = src(
      `expect(() => rewrite("x.ts", '${IMP} { a } from "./a";')).toThrow();`,
      `// ${IMP} cn from "clsx"`,
      `const t = \`${IMP} z from "zod"; \${await ${IMP}("node:fs")}\`;`,
      "/* new Function('x') and eval('y') are refused in shipped code */",
    );
    assert.deepEqual(checkSource("ops/watcher/test/deploy.test.ts", fixture), []);
    assert.deepEqual(
      checkSource("packages/ui/test/rules.test.ts", fixture),
      ["client-node"].map((rule) => ({
        file: "packages/ui/test/rules.test.ts",
        line: 3,
        rule,
        message: "client code imports no node:* module (FW-C12)",
      })),
    );
    assert.deepEqual(
      rules(checkSource("ops/fin/src/a.test.ts", src(`const a = 1; ${IMP} x from "zod";`))),
      ["builtins-only"],
    );
    assert.deepEqual(
      rules(
        checkSource(
          "ops/fin/src/a.test.ts",
          imp("../../../packages/testing/src/x.ts"),
          () => false,
          CONTROL,
        ),
      ),
      [],
    );
  });

  test("the code mask skips comments, strings and template text, and keeps template expressions", () => {
    const text = `a /* b */ 'c' "d" // e\n\`f \${g + \`h \${i}\`} j\` k`;
    const mask = codeMask(text);
    const code = [...text].filter((_, i) => mask[i] === 1).join("");
    assert.equal(code.replace(/\s+/g, " "), ["a '' \"\" `", "{g + `", "{i}`}` k"].join("$"));
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

  test("a control-path file imports only built-ins and control-path files", () => {
    const check = (/** @type {string} */ file, /** @type {string} */ text) =>
      rules(checkSource(file, text, () => false, CONTROL));
    assert.deepEqual(check("ops/fin/src/main.ts", imp("../../../packages/core/src/x.ts")), [
      "control-path-import",
    ]);
    assert.deepEqual(check("ops/fin/src/main.ts", imp("../../../../outside.ts")), [
      "control-path-import",
    ]);
    assert.deepEqual(check("ops/fin/src/main.ts", imp("./commands/deploy.ts")), []);
    assert.deepEqual(check(".github/scripts/gate.mjs", imp("../../ops/fin/src/x.ts")), []);
    assert.deepEqual(check(".github/scripts/gate.mjs", imp("zod")), ["control-path-import"]);
    assert.deepEqual(check(".github/scripts/gate.mjs", imp("../../scripts/lib/repo.mjs")), [
      "control-path-import",
    ]);
    assert.deepEqual(check("scripts/check-supply-chain.mjs", imp("./lib/repo.mjs")), [
      "control-path-import",
    ]);
    assert.deepEqual(
      check(
        "ops/fin/src/main.ts",
        src(`${IMP} type { Row } from "../../../packages/db/src/x.ts";`),
      ),
      [],
    );
    assert.deepEqual(check("ops/fin/src/main.test.ts", imp("vitest")), []);
    assert.deepEqual(check("packages/core/src/x.ts", imp("../../ops/fin/src/x.ts")), []);
  });

  test("the two control-path checks of this repository import Node built-ins only", () => {
    for (const file of ["scripts/check-supply-chain.mjs", "scripts/public-safety.mjs"]) {
      const { imports } = findImports(readFileSync(join(REPO_ROOT, file), "utf8"));
      assert.ok(imports.length > 0, file);
      assert.deepEqual(
        imports.filter((i) => !i.specifier.startsWith("node:")).map((i) => i.specifier),
        [],
        file,
      );
    }
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

  test("multi-line imports, re-exports, type imports and mid-line imports are read", () => {
    const { imports } = findImports(
      src(
        `${IMP} {`,
        "  a,",
        "  type B,",
        '} from "node:http";',
        `${EXP} * from "clsx";`,
        `${IMP} type { C } from "@ui-sdk/react";`,
        `const d = 1; ${IMP} e from "./e.ts";`,
        `${IMP} { "f g" as f } from "node:fs";`,
      ),
    );
    assert.deepEqual(
      imports.map((i) => [i.specifier, i.line, i.typeOnly]),
      [
        ["node:http", 1, false],
        ["clsx", 5, false],
        ["@ui-sdk/react", 6, true],
        ["./e.ts", 7, false],
        ["node:fs", 8, false],
      ],
    );
    assert.deepEqual(imports[4]?.names, ["as", "f", "f g"]);
  });

  test("a repository with planted imports fails, and this repository passes", () => {
    const dir = makeRepo({
      "tools/layout.json": JSON.stringify({ version: 1, controlPaths: ["ops/fin/"], entries: [] }),
      "apps/api/src/main.ts": imp("node:http"),
      "apps/console/src/client/home.tsx": imp("@ui-sdk/react"),
      "ops/fin/src/main.ts": src(
        `${IMP} z from "zod";`,
        `${IMP} c from "../../../packages/c/x.ts";`,
      ),
    });
    assert.deepEqual(rules(checkImports(dir)), [
      "builtins-only",
      "control-path-import",
      "node-network",
      "ui-sdk-outside-ui",
    ]);
    const run = runScript("scripts/import-rules.mjs", ["--root", dir]);
    assert.equal(run.status, 1);
    assert.match(run.output, /^apps\/api\/src\/main\.ts:1 node-network: /m);
    assert.deepEqual(checkImports(REPO_ROOT), []);
  });
});
