// The api bundle builds from a clean checkout (spec 01 §4.9; spec 08 §3.2). The image runs exactly
// `pnpm --filter @fin/api run build:server` after copying the sources (ops/docker/app.Dockerfile), and
// the bundle reaches @fin/audit (main.ts, then migrate/main.ts), whose index loads the event index
// `node packages/audit/src/gen.ts` writes and git ignores. So build:server's pre-script writes it first,
// as the test and typecheck scripts do; without it the image's build fails on the missing file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(import.meta.dirname, "..");
const ROOT = join(APP, "..", "..");
const GENERATE = "node ../../packages/audit/src/gen.ts";

const scripts = (
  JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

describe("the api bundle's build", () => {
  it("writes the audit event index before it bundles", () => {
    expect(scripts["prebuild:server"]).toBe(GENERATE);
    expect(scripts["build:server"]).toBe("vite build --config vite.server.config.ts");
    // `build` (turbo's) goes through build:server, so its pre-script runs there too.
    expect(scripts.build).toBe("pnpm run build:server");
  });

  it("is what both of the image's bundle stages run", () => {
    const dockerfile = readFileSync(join(ROOT, "ops/docker/app.Dockerfile"), "utf8");
    const builds = /FIN_BUILD_TARGET=(\w+) pnpm --filter "@fin\/\$\{APP\}" run (\S+)/g;
    const runs = [...dockerfile.matchAll(builds)].map((m) => `${m[1]} ${m[2]}`);
    expect(runs).toEqual(["release build:server", "test build:server"]);
  });
});
