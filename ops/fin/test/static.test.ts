import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assetManifestHash, readArtefact } from "../../../tools/static-deploy/src/artefact.ts";
import { ACCOUNT, FakeStatic } from "../../../tools/static-deploy/test/fake.ts";
import { runCli } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import { staticDeploy } from "../src/static/deploy.ts";
import { staticRenderCommand } from "../src/static/render.ts";
import type { RenderInput, StaticRenderer } from "../src/static/renderer.ts";
import {
  commandEnv,
  fakeRuntime,
  fakeToken,
  hex,
  REPO_ROOT,
  tempDir,
  writePrivate,
  ZONE,
} from "./helpers/fixtures.ts";

const RELEASE = hex(40, "c");
const KEYS = ["verify", "selfie", "admin", "console", "docs"];

/** A renderer that behaves like packages/web-host's will: headers from the profile, env.json. */
function fakeRenderer(
  seen: RenderInput[] = [],
  override?: (input: RenderInput) => { headers: string; env: Record<string, unknown> },
): StaticRenderer {
  return {
    renderStatic(input) {
      seen.push(input);
      if (override !== undefined) return override(input);
      const connect = input.profile === "docs" ? `'self' https://${input.hosts.api}` : "'self'";
      return {
        headers: `/*\n  Cache-Control: no-cache\n  Content-Security-Policy: default-src 'none'; connect-src ${connect}\n/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n`,
        env: {
          environment: input.environment,
          release: input.release,
          consoleOrigin: `https://${input.hosts.console}`,
          docsOrigin: `https://${input.hosts.docs}`,
          ...(input.profile === "docs" ? { apiOrigin: `https://${input.hosts.api}` } : {}),
        },
      };
    },
  };
}

function builds(dir: string): string {
  const root = join(dir, "artefacts");
  for (const key of KEYS) {
    mkdirSync(join(root, key, "assets"), { recursive: true });
    writeFileSync(join(root, key, "index.html"), `<!doctype html><title>${key}</title>`);
    writeFileSync(join(root, key, "assets", "main-abc.js"), `console.log("${key}")`);
  }
  return root;
}

describe("static render", () => {
  it("refuses while packages/web-host's renderer does not exist (no fallback renderer)", async () => {
    const { env, dir } = commandEnv();
    const r = fakeRuntime({ env });
    const command = staticRenderCommand(async () => undefined);
    const code = await runCli(
      [
        "static",
        "render",
        "staging",
        "--release",
        RELEASE,
        "--artefacts",
        builds(dir),
        "--out",
        join(dir, "out"),
      ],
      r,
      [command],
    );
    assert.equal(code, EXIT.config);
    assert.match(r.err(), /waits for packages\/web-host\/src\/static\/render.ts/);
  });

  it("renders _headers and env.json into a copy of each build, never naming Fin Admin's host in a public output", async () => {
    const { env, dir } = commandEnv();
    const r = fakeRuntime({ env });
    const seen: RenderInput[] = [];
    const out = join(dir, "out");
    const code = await runCli(
      [
        "static",
        "render",
        "staging",
        "--release",
        RELEASE,
        "--artefacts",
        builds(dir),
        "--out",
        out,
      ],
      r,
      [staticRenderCommand(async () => fakeRenderer(seen))],
    );
    assert.equal(code, EXIT.ok, r.err());
    assert.deepEqual(
      seen.map((s) => [s.output, s.app, s.profile]),
      [
        ["verify", "verify", "hosted"],
        ["selfie", "verify", "selfie"],
        ["admin", "admin", "app"],
        ["console", "console", "app"],
        ["docs", "docs", "docs"],
      ],
    );
    for (const s of seen) {
      assert.equal(
        "admin" in s.hosts,
        s.output === "admin",
        `${s.output}: the admin host only in its own input`,
      );
      assert.equal("pg" in s.hosts, false);
      assert.equal(s.indexable, false);
    }
    const env0 = JSON.parse(readFileSync(join(out, "docs", "env.json"), "utf8"));
    assert.equal(env0.apiOrigin, `https://gateway.${ZONE}`);
    assert.ok(existsSync(join(out, "console", "assets", "main-abc.js")));
    assert.match(readFileSync(join(out, "console", "_headers"), "utf8"), /Cache-Control: no-cache/);
    assert.equal(r.out().includes(ZONE), false);
  });

  it("refuses a build that already holds _headers, env.json or a source map", async () => {
    for (const file of ["_headers", "env.json", "assets/main.js.map"]) {
      const { env, dir } = commandEnv();
      const artefacts = builds(dir);
      writeFileSync(join(artefacts, "console", file), "x");
      const r = fakeRuntime({ env });
      const code = await runCli(
        [
          "static",
          "render",
          "staging",
          "--release",
          RELEASE,
          "--artefacts",
          artefacts,
          "--out",
          join(dir, "out"),
        ],
        r,
        [staticRenderCommand(async () => fakeRenderer())],
      );
      assert.equal(code, EXIT.data, file);
    }
  });

  it("refuses a rendered output that names a host it may not, or another release", async () => {
    const { env, dir } = commandEnv();
    const r = fakeRuntime({ env });
    const leaky = fakeRenderer([], (input) => ({
      headers: `/*\n  Content-Security-Policy: connect-src 'self' https://staff.${ZONE}\n`,
      env: { environment: input.environment, release: input.release },
    }));
    const code = await runCli(
      [
        "static",
        "render",
        "staging",
        "--release",
        RELEASE,
        "--artefacts",
        builds(dir),
        "--out",
        join(dir, "out"),
        "--only",
        "console",
      ],
      r,
      [staticRenderCommand(async () => leaky)],
    );
    assert.equal(code, EXIT.refused);
    const stale = fakeRenderer([], () => ({
      headers: "/*\n  X: y\n",
      env: { environment: "staging", release: hex(40, "d") },
    }));
    const r2 = fakeRuntime({ env });
    assert.equal(
      await runCli(
        [
          "static",
          "render",
          "staging",
          "--release",
          RELEASE,
          "--artefacts",
          builds(tempDir()),
          "--out",
          join(tempDir(), "o"),
        ],
        r2,
        [staticRenderCommand(async () => stale)],
      ),
      EXIT.data,
    );
    assert.equal(
      existsSync(join(dir, "out", "console")),
      false,
      "nothing is written when a check fails",
    );
  });
});

describe("static deploy (pnpm fin)", () => {
  function repoWithStatic(dir: string): string {
    const root = join(dir, "repo");
    mkdirSync(join(root, "ops", "environments"), { recursive: true });
    cpSync(
      join(REPO_ROOT, "ops", "environments", "staging.json"),
      join(root, "ops", "environments", "staging.json"),
    );
    for (const app of ["console", "admin", "verify", "docs"]) {
      mkdirSync(join(root, "apps", app), { recursive: true });
      writeFileSync(
        join(root, "apps", app, "static.json"),
        JSON.stringify({
          compatibility_date: "2026-11-20",
          assets: {
            not_found_handling: "single-page-application",
            html_handling: "auto-trailing-slash",
          },
          workers_dev: false,
          preview_urls: false,
        }),
      );
    }
    return root;
  }

  it("uploads every rendered build as an assets-only deployment inside a registered run", async () => {
    const { env, dir } = commandEnv();
    const rendered = join(dir, "rendered");
    const statics: Record<string, unknown> = {};
    for (const key of KEYS) {
      mkdirSync(join(rendered, key, "assets"), { recursive: true });
      writeFileSync(join(rendered, key, "index.html"), `<!doctype html>${key}`);
      writeFileSync(join(rendered, key, "assets", "a.js"), key);
      writeFileSync(join(rendered, key, "_headers"), "/*\n  Cache-Control: no-cache\n");
      writeFileSync(join(rendered, key, "env.json"), "{}");
      statics[key] = {
        artefact: `static-${key}-${RELEASE}`,
        sha256: hex(64, "e"),
        assetManifestHash: assetManifestHash(readArtefact(join(rendered, key)).files),
      };
    }
    const manifestFile = join(dir, "release-manifest.json");
    writeFileSync(manifestFile, JSON.stringify({ commit: RELEASE, images: {}, static: statics }));
    const token = fakeToken("static");
    env.FIN_CF_STATIC_TOKEN_FILE = writePrivate(dir, "static-token", token);
    const fake = new FakeStatic(token);
    const r = fakeRuntime({ env, fetch: fake.fetch, repoRoot: repoWithStatic(dir) });
    const code = await runCli(
      [
        "static",
        "deploy",
        "staging",
        "--release",
        RELEASE,
        "--manifest",
        manifestFile,
        "--dir",
        rendered,
      ],
      r,
      [staticDeploy],
    );
    assert.equal(code, EXIT.ok, r.err());
    assert.deepEqual(
      [...fake.scripts.keys()],
      KEYS.map((k) => `fin-next-staging-${k}-static`),
    );
    for (const s of fake.scripts.values()) {
      assert.deepEqual(s.parts, ["metadata"]);
      assert.deepEqual(s.subdomain, { enabled: false, previews_enabled: false });
    }
    assert.equal(r.out().includes(ACCOUNT), false);
    assert.equal(r.out().includes(token), false);
    const log = readFileSync(join(env.FIN_STATE_DIR ?? "", "staging", "runs.jsonl"), "utf8");
    assert.match(log, /"event":"run.registered"/);
    assert.match(log, /"result":"ok"/);
    const lines = readFileSync(join(env.FIN_STATE_DIR ?? "", "staging", "lines.jsonl"), "utf8");
    assert.equal((lines.match(/"event":"deploy.static_step"/g) ?? []).length, 5);
    assert.match(lines, /"event":"deploy.static_done"/);
  });

  it("dry run: plans and sends nothing", async () => {
    const { env, dir } = commandEnv();
    const fake = new FakeStatic(fakeToken("s"));
    const manifestFile = join(dir, "m.json");
    const statics = Object.fromEntries(
      KEYS.map((k) => [
        k,
        {
          artefact: `static-${k}-${RELEASE}`,
          sha256: hex(64, "e"),
          assetManifestHash: hex(64, "f"),
        },
      ]),
    );
    writeFileSync(manifestFile, JSON.stringify({ commit: RELEASE, static: statics }));
    const r = fakeRuntime({ env, fetch: fake.fetch, repoRoot: repoWithStatic(dir) });
    assert.equal(
      await runCli(
        [
          "static",
          "deploy",
          "staging",
          "--release",
          RELEASE,
          "--manifest",
          manifestFile,
          "--dir",
          dir,
          "--dry-run",
        ],
        r,
        [staticDeploy],
      ),
      1,
    );
    assert.equal(fake.calls.length, 0);
  });
});
