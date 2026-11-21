// A small fin-next-shaped monorepo for plan tests: the fixture layout, workspace packages wired
// with workspace:* dependencies, and a file or two in each path class.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The fixture tools/layout.json, modelled on spec 01 §4.3. */
export function fixtureLayout(): string {
  return readFileSync(fileURLToPath(new URL("../../fixtures/plan/layout.json", import.meta.url)), "utf8");
}

function manifest(name: string, deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): string {
  const out: Record<string, unknown> = { name, private: true, type: "module" };
  if (Object.keys(deps).length > 0) out["dependencies"] = deps;
  if (Object.keys(devDeps).length > 0) out["devDependencies"] = devDeps;
  return `${JSON.stringify(out, null, 2)}\n`;
}

const W = "workspace:*";

/** Every file of the base commit. */
export function monorepoFiles(): Record<string, string> {
  return {
    "package.json": manifest("fin-next"),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "README.md": "# fin-next\n",
    "tools/layout.json": fixtureLayout(),
    "tools/fin-review/package.json": manifest("@fin/fin-review"),
    "tools/fin-review/src/main.ts": "export {};\n",
    "docs/plan/README.md": "# plan\n",
    "docs/review/README.md": "# review\n",
    "scripts/check.mjs": "export {};\n",
    "ops/docker/app.Dockerfile": "FROM scratch\n",
    "ops/fin/package.json": manifest("@fin/ops-fin", { "@fin/core": W }),
    "ops/fin/src/main.ts": "export {};\n",
    "ops/credentials.json": "{}\n",

    "apps/console/package.json": manifest("@fin/console", { "@fin/server": W, "@fin/ui": W }),
    "apps/console/index.html": "<!doctype html>\n",
    "apps/console/src/client/main.tsx": "export {};\n",
    "apps/console/src/server/main.ts": "export {};\n",
    "apps/console/static.json": "{}\n",
    "apps/admin/package.json": manifest("@fin/admin", { "@fin/server": W, "@fin/ui": W, "@fin/app-contracts": W }),
    "apps/admin/src/client/main.tsx": "export {};\n",
    "apps/admin/src/server/main.ts": "export {};\n",
    "apps/verify/package.json": manifest("@fin/verify", { "@fin/server": W }),
    "apps/verify/src/server/main.ts": "export {};\n",
    "apps/docs/package.json": manifest("@fin/docs"),
    "apps/docs/src/index.ts": "export {};\n",
    "apps/edge/package.json": manifest("@fin/edge", { "@fin/server": W, "@fin/core": W }),
    "apps/edge/src/main.ts": "export {};\n",
    "apps/api/package.json": manifest("@fin/api", { "@fin/server": W, "@fin/money": W }),
    "apps/api/src/main.ts": "export {};\n",

    "packages/core/package.json": manifest("@fin/core"),
    "packages/core/src/index.ts": "export const core = 1;\n",
    "packages/server/package.json": manifest("@fin/server", { "@fin/core": W }),
    "packages/server/src/index.ts": "export const server = 1;\n",
    "packages/db/package.json": manifest("@fin/db", { "@fin/core": W }),
    "packages/db/src/schema.ts": "export const schema = 1;\n",
    "packages/crypto/package.json": manifest("@fin/crypto", { "@fin/core": W }),
    "packages/crypto/src/index.ts": "export const crypto = 1;\n",
    "packages/kyc/package.json": manifest("@fin/kyc", { "@fin/core": W }),
    "packages/kyc/src/flow.ts": "export const flow = 1;\n",
    "packages/kyc/src/flow.db.test.ts": "export {};\n",
    "packages/money/package.json": manifest("@fin/money", { "@fin/db": W }),
    "packages/money/src/ledger.ts": "export const ledger = 1;\n",
    "packages/ui/package.json": manifest("@fin/ui", { "@fin/tokens": W }),
    "packages/ui/src/button.tsx": "export {};\n",
    "packages/tokens/package.json": manifest("@fin/tokens"),
    "packages/tokens/src/tokens.css": ":root {}\n",
    "packages/app-contracts/package.json": manifest("@fin/app-contracts"),
    "packages/app-contracts/src/index.ts": "export {};\n",
    "packages/contract/package.json": manifest("@fin/contract", { "@fin/core": W }),
    "packages/contract/src/openapi.ts": "export {};\n",
    "packages/testing/package.json": manifest("@fin/testing", {}, { "@fin/core": W }),
    "packages/testing/src/index.ts": "export {};\n",
  };
}

export { manifest, W };
