// imports:check, with the planted cases of AC-P0-22. The check reads import-shaped text anywhere,
// strings included, so every fixture builds its keywords at run time: no line of this file holds
// an import, a re-export or a loading call that the check could take for this file's own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  checkImports,
  checkManifest,
  checkSource,
  codeMask,
  findImports,
} from "../import-rules.mjs";
import { cleanUp, makeRepo, REPO_ROOT, rules, runScript } from "./helpers.mjs";

after(cleanUp);

const IMP = ["imp", "ort"].join("");
const EXP = ["exp", "ort"].join("");
const REQ = ["req", "uire"].join("");
const GBM = ["getBuiltin", "Module"].join("");
const CREATE_REQUIRE = ["create", "Require"].join("");
const BUN_SERVE = ["Bun", "serve"].join(".");
const CONSOLE_ERROR = ["console", "error"].join(".");
// A backslash, so a fixture can spell an escape sequence without this file holding one.
const BS = "\\";

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

  test("node:http and node:https are allowed in the harness's HTTP bridge, and in no other file of packages/testing", () => {
    // The steward's decision of 21 Nov names exactly one file, by its full path.
    const BRIDGE = "packages/testing/src/http/node.ts";
    assert.deepEqual(checkSource(BRIDGE, imp("node:http")), []);
    assert.deepEqual(checkSource(BRIDGE, imp("node:https")), []);
    // Only those two modules: the rest stay in packages/server and apps/connector.
    for (const module of ["node:net", "node:dns", "node:cluster", "node:worker_threads"]) {
      assert.deepEqual(rules(checkSource(BRIDGE, imp(module))), ["node-network"], module);
    }
    for (const file of [
      "packages/testing/src/http/certificate.ts",
      "packages/testing/src/http/node.test.ts",
      "packages/testing/src/http/node.tsx",
      "packages/testing/src/http/Node.ts",
      "packages/testing/src/http/node/index.ts",
      "packages/testing/src/static-host/host.ts",
      "packages/testing/test/fake-api.ts",
      "packages/testing/e2e/harness.spec.ts",
      "packages/testing/node.ts",
      "apps/api/packages/testing/src/http/node.ts",
    ]) {
      for (const module of ["node:http", "node:https"]) {
        assert.deepEqual(rules(checkSource(file, imp(module))), ["node-network"], file);
      }
    }
  });

  test("only tests and test support import @fin/testing, so the harness never reaches deployable code", () => {
    const check = (/** @type {string} */ file, /** @type {string} */ text) =>
      rules(checkSource(file, text));
    const forms = [
      imp("@fin/testing"),
      imp("@fin/testing/playwright"),
      imp("@fin/testing/playwright/config"),
      imp("@FIN/Testing"),
      src(`${IMP} type { Clock } from "@fin/testing";`),
      src(`${EXP} * from "@fin/testing";`),
      src(`const t = await ${IMP}("@fin/testing");`),
      src(`const t = ${REQ}("@fin/testing");`),
    ];
    // Deployable code, and test-only code inside a deployable package.
    for (const file of [
      "apps/api/src/main.ts",
      "apps/console/src/server/routes.ts",
      "packages/identity/src/sign-in.ts",
      "packages/server/src/testing/http.ts",
      "packages/web-host/src/testing.ts",
      // An e2e/ or test/ directory below a package's root is not test support.
      "apps/console/src/e2e/helper.ts",
      "packages/identity/src/test/helper.ts",
      "packages/identity/e2e.ts",
      "vitest.config.ts",
    ]) {
      for (const text of forms) assert.deepEqual(check(file, text), ["testing-import"], file);
    }
    // A file of test support by a relative path reaches the same code, in any case.
    for (const specifier of [
      "../../../packages/testing/src/index.ts",
      "../../../packages/Testing/src/index.ts",
      "../../console/e2e/fixtures.ts",
      "../test/helpers.ts",
      "../../../e2e/fixtures/csp.ts",
      "../../../playwright.config.ts",
    ]) {
      assert.deepEqual(
        check("apps/api/src/main.ts", imp(specifier)),
        ["testing-import"],
        specifier,
      );
    }
    // Tests and test support may.
    for (const file of [
      "apps/api/src/main.test.ts",
      "packages/identity/src/sign-in.db.test.ts",
      "apps/console/e2e/sat/sign-in.spec.ts",
      "apps/console/e2e/fixtures/helpers.ts",
      "e2e/fixtures/csp.ts",
      "packages/identity/test/canon.ts",
      "tools/fin-review/test/helpers/monorepo.ts",
      "packages/testing/src/static-host/host.ts",
      "packages/testing/test/fake-api.ts",
      "playwright.config.ts",
    ]) {
      for (const text of forms) assert.deepEqual(check(file, text), [], file);
    }
    assert.deepEqual(
      check("playwright.config.ts", imp("./packages/testing/src/playwright/config.ts")),
      [],
    );
    assert.deepEqual(check("apps/console/e2e/sat/a.spec.ts", imp("../fixtures/helpers.ts")), []);
    // Other packages, and names that only start like it, are not the harness.
    assert.deepEqual(check("apps/api/src/main.ts", imp("@fin/testing-kit")), []);
    assert.deepEqual(check("apps/api/src/main.ts", imp("@fin/server/testing/http")), []);
  });

  test("a manifest lists @fin/testing only under devDependencies", () => {
    const manifest = (/** @type {Record<string, unknown>} */ fields) =>
      `${JSON.stringify({ name: "@fin/api", private: true, ...fields }, null, 2)}\n`;
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const text = manifest({ [field]: { "@fin/testing": "workspace:*" } });
      const findings = checkManifest("apps/api/package.json", text);
      assert.deepEqual(rules(findings), ["testing-dependency"], field);
      assert.equal(findings[0]?.line, 5, field);
    }
    assert.deepEqual(
      rules(
        checkManifest("apps/api/package.json", manifest({ bundleDependencies: ["@fin/testing"] })),
      ),
      ["testing-dependency"],
    );
    assert.deepEqual(
      rules(
        checkManifest(
          "apps/api/package.json",
          manifest({ dependencies: { "@FIN/Testing": "workspace:*" } }),
        ),
      ),
      ["testing-dependency"],
    );
    assert.deepEqual(
      checkManifest(
        "apps/api/package.json",
        manifest({
          dependencies: { "@fin/server": "workspace:*" },
          devDependencies: { "@fin/testing": "workspace:*" },
        }),
      ),
      [],
    );
    assert.deepEqual(checkManifest("apps/api/package.json", "{ not json"), []);
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

  test("an import with a comment between any of its parts is read", () => {
    const outside = "../../../scripts/lib/verdict.ts";
    for (const line of [
      `${IMP} evil from /* c */ "${outside}";`,
      `${IMP} evil from // c\n"${outside}";`,
      `${IMP}/**/{ evil }/**/from/**/"${outside}";`,
      `${EXP} * from /**/ "${outside}";`,
      `${EXP} { a } from // c\n  "${outside}";`,
      `${IMP} /**/ "${outside}";`,
      `${IMP} // c\n"${outside}";`,
    ]) {
      assert.deepEqual(
        rules(checkSource("ops/fin/src/commented.ts", src(line), () => false, CONTROL)),
        ["control-path-import"],
        line,
      );
    }
    assert.deepEqual(
      rules(
        checkSource(
          "apps/console/src/client/fs.ts",
          src(`${IMP} { readFileSync } from /**/ "node:fs";`),
        ),
      ),
      ["client-node"],
    );
    assert.deepEqual(rules(checkSource("packages/ui/src/a.ts", src(`${IMP} /* x */ "clsx";`))), [
      "refused-package",
    ]);
  });

  test("a specifier's escapes and line continuations are decoded before the rules read it", () => {
    const control = (
      /** @type {string} */ specifier,
      /** @type {string} */ file = "ops/fin/src/escaped.ts",
    ) => rules(checkSource(file, imp(specifier), () => false, CONTROL));
    for (const specifier of [
      `./${BS}x2e${BS}x2e/../../scripts/lib/verdict.ts`,
      `${BS}u002e${BS}u002e/../../scripts/lib/verdict.ts`,
      `${BS}u{2e}./../../scripts/lib/verdict.ts`,
      `../..${BS}\n/../scripts/lib/verdict.ts`,
    ]) {
      assert.deepEqual(control(specifier), ["control-path-import"], specifier);
    }
    // Legacy octal escapes, which a CommonJS file may use.
    assert.deepEqual(
      rules(
        checkSource(
          "ops/fin/src/a.cjs",
          src(
            `const v = ${REQ}("${BS}56${BS}56/${BS}56${BS}56/${BS}56${BS}56/scripts/lib/v.cjs");`,
          ),
          () => false,
          CONTROL,
        ),
      ),
      ["control-path-import"],
    );
    for (const [file, specifier, rule] of /** @type {[string, string, string][]} */ ([
      ["apps/console/src/client/a.ts", `node${BS}x3afs`, "client-node"],
      ["apps/api/src/a.ts", `node:n${BS}x65t`, "node-network"],
      ["apps/console/src/client/a.ts", `@fin/d${BS}x62`, "client-server-package"],
      ["apps/console/src/client/a.ts", `@ui-sdk/cor${BS}x65`, "ui-sdk-outside-ui"],
      ["packages/ui/src/a.ts", `cl${BS}u{73}x`, "refused-package"],
    ])) {
      assert.deepEqual(rules(checkSource(file, imp(specifier))), [rule], specifier);
    }
  });

  test("a specifier a URL parser would rewrite, or a subpath import, is refused", () => {
    for (const specifier of [
      "./%2e%2e/%2e%2e/../scripts/lib/verdict.ts",
      "./verd%69ct.ts",
      `./..${BS}${BS}..${BS}${BS}../scripts/lib/verdict.ts`,
      `./.${BS}t./../../scripts/lib/verdict.ts`,
      " ./a.ts",
      "./a.ts ",
      `node:fs${BS}n`,
    ]) {
      assert.deepEqual(
        rules(checkSource("apps/api/src/a.ts", imp(specifier))),
        ["specifier-form"],
        specifier,
      );
    }
    assert.deepEqual(rules(checkSource("apps/console/src/client/a.ts", imp("#db"))), [
      "subpath-import",
    ]);
    assert.deepEqual(checkSource("apps/api/src/a.ts", imp("./my file.ts")), []);
  });

  test("code that runs imports no test file, so a test cannot carry an import past the rules", () => {
    const check = (/** @type {string} */ file, /** @type {string} */ text) =>
      rules(checkSource(file, text, () => false, CONTROL));
    for (const specifier of [
      "./rules.test.ts",
      "./rules.test.ts?v=1",
      "../plan/plan.spec.ts",
      "@fin/testing/src/x.db.test.ts",
    ]) {
      assert.ok(
        check("ops/fin/src/receipt/check.ts", imp(specifier)).includes("test-file-import"),
        specifier,
      );
    }
    assert.ok(
      check(
        "ops/fin/src/receipt/check.cjs",
        src(`const r = ${REQ}("./x.cjs#/../rules.test.cjs");`),
      ).includes("test-file-import"),
    );
    // A test may import any file, and another test too.
    assert.deepEqual(
      check(
        "ops/fin/src/receipt/rules.test.ts",
        src(`${EXP} { v } from "../../../../scripts/lib/v.ts";`),
      ),
      [],
    );
    assert.deepEqual(check("ops/fin/src/receipt/a.test.ts", imp("./rules.test.ts")), []);
    assert.deepEqual(check("ops/fin/src/receipt/check.ts", imp("./rules.ts")), []);
  });

  test("a test file is recognised among import targets in any case", () => {
    // A case-insensitive file system loads `x.test.ts` for `./x.TEST.ts`.
    for (const file of ["ops/fin/src/receipt/check.ts", "apps/api/src/a.ts"]) {
      for (const specifier of [
        "./x.test.ts",
        "./x.TEST.ts",
        "./x.spec.mts",
        "./x.Spec.mts",
        "./x.test.TS",
        "../plan/plan.SPEC.ts",
        "./x.cjs#/../rules.Test.cjs",
        "@fin/testing/src/x.db.test.ts",
        "@fin/testing/src/x.DB.Test.ts",
      ]) {
        assert.ok(
          rules(checkSource(file, imp(specifier), () => false, CONTROL)).includes(
            "test-file-import",
          ),
          `${file} ${specifier}`,
        );
      }
    }
  });

  test("every call of a loader is read, however it is spelled", () => {
    for (const [file, line] of /** @type {[string, string][]} */ ([
      ["apps/api/src/a.ts", `const h = process.${GBM}?.("node:http");`],
      ["apps/api/src/a.ts", `const h = await ${IMP}(/* c */ "node:http" /* d */);`],
      ["apps/api/src/a.ts", `const h = await ${IMP}(\`node:h${BS}x74tp\`);`],
      ["apps/api/src/a.cjs", `const h = ${REQ} /* c */ ("node:net");`],
      ["apps/api/src/a.cjs", `const h = ${REQ}?.("node:net");`],
      ["apps/api/src/a.cjs", `const h = ${BS}u0072equire("node:net");`],
      ["apps/api/src/a.cjs", `const h = ${REQ}<!-- c\n("node:net");`],
      ["apps/api/src/a.cjs", `const h = module.${REQ}("node:dns");`],
    ])) {
      assert.deepEqual(rules(checkSource(file, src(line))), ["node-network"], line);
    }
  });

  test("getBuiltinModule is called directly with one string literal, everywhere", () => {
    for (const line of [
      `const { ${GBM}: g } = process;`,
      `const g = process.${GBM};`,
      `const h = ${GBM}.call(process, "node:http");`,
    ]) {
      assert.deepEqual(
        rules(checkSource("apps/api/src/a.ts", src(line))),
        ["dynamic-import"],
        line,
      );
    }
    assert.deepEqual(
      checkSource("apps/api/src/a.ts", src(`const f = process.${GBM}("node:fs");`)),
      [],
    );
  });

  test("where every import must be read, a loader reached any other way fails", () => {
    const lines = [
      `${IMP} { ${CREATE_REQUIRE} as cr } from "node:module"; const load = cr(${IMP}.meta.url); load("../../../apps/console/src/evil.cjs");`,
      `${IMP} Module from "node:module";`,
      `${IMP} * as m from "node:module";`,
      `const m = await ${IMP}("node:module");`,
      `${IMP} { runInThisContext } from "node:vm"; runInThisContext(code);`,
      `${IMP} repl from "node:repl";`,
      `${IMP} { Session } from "node:inspector";`,
      `${IMP} { WASI } from "node:wasi";`,
      `Reflect.get(Reflect.get(process, "${GBM}")("node:module"), "${CREATE_REQUIRE}")(${IMP}.meta.url);`,
      "const r = (0, eval)(code);",
      'const r = globalThis["ev" + "al"](code);',
      "const F = (() => {}).constructor;",
      'const d = Object.getOwnPropertyDescriptor(process, "x");',
      `const r = process[/* c */"${GBM}"]("node:fs");`,
      `const name = "${GBM}";`,
      `const r = ${REQ};`,
      `const r = ${REQ}.call(null, "x");`,
      `const p = ${REQ}.resolve("./a.ts");`,
      "const b = process.binding;",
    ];
    for (const line of lines) {
      assert.ok(
        rules(
          checkSource("tools/fin-review/src/main.ts", src(line), () => false, CONTROL),
        ).includes("dynamic-import"),
        line,
      );
    }
    // Outside those areas only getBuiltinModule's rule applies, and node:module's names are free.
    assert.deepEqual(checkSource("apps/api/src/a.ts", src("const r = (0, eval)(code);")), []);
    assert.deepEqual(checkSource("apps/api/src/a.ts", src(lines[1] ?? "")), []);
    // node:module's listing names, and type-only imports, are fine.
    assert.deepEqual(
      checkSource(
        "scripts/check.mjs",
        src(`${IMP} { builtinModules, isBuiltin } from "node:module";`),
      ),
      [],
    );
    assert.deepEqual(
      checkSource(
        "ops/fin/src/a.ts",
        src(`${IMP} type { Module } from "node:module";`),
        () => false,
        CONTROL,
      ),
      [],
    );
  });

  test("require is a key only in an object literal whose value is one string, as in an exports-conditions map", () => {
    const check = (/** @type {string} */ line) =>
      rules(checkSource("ops/fin/src/a.ts", src(line), () => false, CONTROL));
    // A conditional's value, and a destructuring pattern, read require itself. The lexer cannot
    // tell an object literal from a pattern, so a key whose value is not one literal is refused.
    for (const line of [
      `const { ${REQ}: load } = module;`,
      `const { a, ${REQ}: load } = module;`,
      `({ ${REQ}: load } = module);`,
      `({ ${REQ}: "x".y } = module);`,
      `const load = c ? ${REQ} : null;`,
      `const load = c ? x : ${REQ};`,
      `const o = { a: 1, ${REQ}: load };`,
    ]) {
      assert.deepEqual(check(line), ["dynamic-import"], line);
    }
    for (const line of [
      "const conditions = { import: './x.js', require: './x.cjs' };",
      'const conditions = { require: "./x.cjs", default: "./x.js" };',
      "const conditions = { require: `./x.cjs` };",
    ]) {
      assert.deepEqual(check(line), [], line);
    }
  });

  test("a source file is read in any case, and code that runs unread files is refused", () => {
    // require() runs a file of an unknown extension as JavaScript, so the rules read it too.
    const dir = makeRepo({
      "tools/layout.json": JSON.stringify({ version: 1, controlPaths: ["ops/fin/"], entries: [] }),
      "ops/fin/src/evil.JS": src(`module.exports = ${REQ}("../../../scripts/lib/repo.mjs");`),
      "scripts/lib/repo.mjs": src(`${EXP} const v = 1;`),
    });
    assert.deepEqual(rules(checkImports(dir)), ["control-path-import"]);
    for (const specifier of [
      "./notes.txt",
      "./addon.node",
      "./mod.wasm",
      "./evil.JS",
      "./a.ts#.txt",
    ]) {
      assert.deepEqual(
        rules(
          checkSource("ops/fin/src/a.cjs", src(`${REQ}("${specifier}");`), () => false, CONTROL),
        ),
        ["relative-extension"],
        specifier,
      );
    }
    for (const specifier of ["./a.ts", "./b.mjs", "./data.json"]) {
      assert.deepEqual(
        checkSource("ops/fin/src/a.ts", imp(specifier), () => false, CONTROL),
        [],
        specifier,
      );
    }
    // Client code imports assets (?raw stylesheets, images) through the bundler.
    assert.deepEqual(checkSource("apps/console/src/client/a.tsx", imp("./logo.svg?raw")), []);
  });

  test("where every import must be read, a relative import names a file the repository holds", () => {
    // require() loads a directory's package.json main, and probes X.js, X.json and X.node for a
    // name that is no file, so neither is read as the file it names.
    const dir = makeRepo({
      "tools/layout.json": JSON.stringify({ version: 1, controlPaths: ["ops/fin/"], entries: [] }),
      "ops/fin/src/a.cjs": src(`const h = ${REQ}("./helper.js");`),
      "ops/fin/src/helper.js/package.json": JSON.stringify({ main: "main.cjs" }),
      "ops/fin/src/helper.js/main.cjs": "module.exports = 1;\n",
      "ops/fin/src/b.cjs": src(`const m = ${REQ}("./missing.js");`),
      "ops/fin/src/c.ts": imp("./helper.js/main.cjs"),
      "ops/fin/src/d.ts": src(`${IMP} type { T } from "./types.ts";`, `${IMP} x from "./c.ts";`),
      "ops/fin/src/types.ts": src(`${EXP} type T = string;`),
      "scripts/e.mjs": imp("./gone.mjs"),
      "scripts/f.mjs": src(`const g = await ${IMP}("./lib");`),
      "scripts/lib/package.json": JSON.stringify({ main: "index.mjs" }),
      "scripts/lib/index.mjs": src(`${EXP} const v = 1;`),
      // Outside those areas, a bundler or a test runner resolves the import.
      "apps/api/src/g.cjs": src(`const h = ${REQ}("./missing.js");`),
    });
    assert.deepEqual(
      checkImports(dir).map((f) => `${f.file} ${f.rule}`),
      [
        "ops/fin/src/a.cjs relative-target",
        "ops/fin/src/b.cjs relative-target",
        "scripts/e.mjs relative-target",
        "scripts/f.mjs relative-extension",
        "scripts/f.mjs relative-target",
      ],
    );
  });

  test("a statement is type-only only when the whole of it is", () => {
    const outside = "../../../scripts/lib/repo.mjs";
    const check = (/** @type {string} */ text) =>
      rules(checkSource("ops/fin/src/a.ts", text, () => false, CONTROL));
    // Without semicolons, a reading of the first statement's clause runs on into the next.
    assert.deepEqual(check(src(`${EXP} type { A }`, `${IMP} evil from "${outside}"`)), [
      "control-path-import",
    ]);
    // An inline `type` keeps the statement, so the module still loads.
    assert.deepEqual(check(src(`${IMP} { type A } from "${outside}";`)), ["control-path-import"]);
    assert.deepEqual(check(src(`${IMP} type from "${outside}";`)), ["control-path-import"]);
    for (const clause of ["type { A, B }", "type A", "type * as ns"]) {
      assert.deepEqual(check(src(`${IMP} ${clause} from "${outside}";`)), [], clause);
    }
    assert.deepEqual(check(src(`${EXP} type * from "${outside}";`)), []);
  });

  test("an import or export this check cannot read fails where every import must be read", () => {
    for (const line of [`${IMP} x from y;`, `${EXP} * as ns;`]) {
      assert.deepEqual(
        rules(checkSource("ops/fin/src/a.ts", src(line), () => false, CONTROL)),
        ["unread-import"],
        line,
      );
      assert.deepEqual(checkSource("apps/api/src/a.ts", src(line)), [], line);
    }
    for (const line of [
      `${EXP} const a = 1;`,
      `${EXP} { a, b as c };`,
      `${EXP} default class {}`,
      `${EXP} type T = { from: string };`,
      `const m = ${IMP}.meta.dirname;`,
      `type M = typeof ${IMP}("./a.ts");`,
    ]) {
      assert.deepEqual(
        checkSource("ops/fin/src/a.ts", src(line), () => false, CONTROL),
        [],
        line,
      );
    }
  });

  test("the lexer tells a regular expression from a division", () => {
    const code = (/** @type {string} */ text) => {
      const mask = codeMask(text);
      return [...text].filter((_, i) => mask[i] === 1).join("");
    };
    assert.equal(code("if (a) /'/.test(b); x"), "if (a) //.test(b); x");
    assert.equal(code("function f() {}\n/'/.test(b); x"), "function f() {}\n//.test(b); x");
    assert.equal(code("y = {} / 2; '/'; x"), "y = {} / 2; ''; x");
    assert.equal(code("y = a++ / 2; '/'; x"), "y = a++ / 2; ''; x");
    assert.equal(code("y = a.if(b) / 2; '/'; x"), "y = a.if(b) / 2; ''; x");
  });

  test("a repository with the review's planted imports fails", () => {
    const dir = makeRepo({
      "tools/layout.json": JSON.stringify({
        version: 1,
        controlPaths: ["ops/fin/", "tools/fin-review/"],
        entries: [],
      }),
      "scripts/lib/verdict.ts": "export const verdict = 1;\n",
      "ops/fin/src/commented.ts": src(
        `${IMP} { verdict } from /* c */ "../../../scripts/lib/verdict.ts";`,
      ),
      "ops/fin/src/escaped.ts": src(
        `${IMP} { verdict } from "./${BS}x2e${BS}x2e/../../scripts/lib/verdict.ts";`,
      ),
      "apps/console/src/client/fs.ts": src(`${IMP} { readFileSync } from /**/ "node:fs";`),
      "tools/fin-review/src/receipt/check.ts": src(`${IMP} { verdict } from "./rules.test.ts";`),
      "tools/fin-review/src/receipt/rules.test.ts": src(
        `${EXP} { verdict } from "../../../../scripts/lib/verdict.ts";`,
      ),
      "tools/fin-review/src/main.ts": src(
        `${IMP} { ${CREATE_REQUIRE} as cr } from "node:module";`,
        `cr(${IMP}.meta.url)("../../../apps/console/src/evil.cjs");`,
      ),
    });
    assert.deepEqual(rules(checkImports(dir)), [
      "client-node",
      "control-path-import",
      "dynamic-import",
      "test-file-import",
    ]);
    const run = runScript("scripts/import-rules.mjs", ["--root", dir]);
    assert.equal(run.status, 1);
    assert.match(run.output, /^ops\/fin\/src\/commented\.ts:1 control-path-import: /m);
    assert.match(run.output, /^ops\/fin\/src\/escaped\.ts:1 control-path-import: /m);
    assert.match(run.output, /^tools\/fin-review\/src\/receipt\/check\.ts:1 test-file-import: /m);
  });

  test("a repository with the harness planted in deployable code fails", () => {
    const manifest = (/** @type {Record<string, unknown>} */ fields) =>
      `${JSON.stringify({ private: true, type: "module", ...fields }, null, 2)}\n`;
    const dir = makeRepo({
      "tools/layout.json": JSON.stringify({ version: 1, controlPaths: [], entries: [] }),
      // Allowed: the bridge's two imports, and the harness in a test and in test support.
      "packages/testing/package.json": manifest({ name: "@fin/testing" }),
      "packages/testing/src/http/node.ts": src(
        `${IMP} * as http from "node:http";`,
        `${IMP} * as https from "node:https";`,
      ),
      "apps/api/src/main.test.ts": imp("@fin/testing"),
      "apps/api/e2e/sign-in.spec.ts": imp("@fin/testing/playwright"),
      "apps/api/test/canon.ts": imp("@fin/testing"),
      "apps/console/package.json": manifest({
        name: "@fin/console",
        devDependencies: { "@fin/testing": "workspace:*" },
      }),
      // Refused: the harness in production code and in a manifest's dependencies, and node:http
      // in another file of packages/testing.
      "apps/api/src/main.ts": src("// The API.", imp("@fin/testing")),
      "apps/api/package.json": manifest({
        name: "@fin/api",
        dependencies: { "@fin/testing": "workspace:*" },
      }),
      "packages/testing/src/email/sink.ts": imp("node:http"),
    });
    const findings = checkImports(dir);
    assert.deepEqual(findings.map((f) => `${f.file}:${f.line} ${f.rule}`).sort(), [
      "apps/api/package.json:6 testing-dependency",
      "apps/api/src/main.ts:2 testing-import",
      "packages/testing/src/email/sink.ts:1 node-network",
    ]);
    const run = runScript("scripts/import-rules.mjs", ["--root", dir]);
    assert.equal(run.status, 1);
    assert.match(run.output, /^apps\/api\/src\/main\.ts:2 testing-import: /m);
    assert.match(run.output, /^apps\/api\/package\.json:6 testing-dependency: /m);
    assert.match(run.output, /^packages\/testing\/src\/email\/sink\.ts:1 node-network: /m);
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
      "packages/c/x.ts": src(`${EXP} default 1;`),
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
