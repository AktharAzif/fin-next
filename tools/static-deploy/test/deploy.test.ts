import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assetHash, assetManifestHash, readArtefact } from "../src/artefact.ts";
import { cloudflareClient } from "../src/cloudflare.ts";
import { parseStaticConfig, type StaticConfig, StaticConfigError } from "../src/config.ts";
import { assetsOnlyMetadata, deployStatic } from "../src/deploy.ts";
import { main } from "../src/main.ts";
import { parseReleaseManifest } from "../src/release.ts";
import { verifyDeployment } from "../src/verify.ts";
import { ACCOUNT, FakeStatic } from "./fake.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const RELEASE = "e".repeat(40);
const CONFIG: StaticConfig = {
  compatibility_date: "2026-11-20",
  assets: { not_found_handling: "single-page-application", html_handling: "auto-trailing-slash" },
  workers_dev: false,
  preview_urls: false,
};
const HEADERS =
  "/*\n  Cache-Control: no-cache\n/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n";

function artefactDir(root: string, key: string): string {
  const dir = join(root, key);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>${key}</title>`);
  writeFileSync(join(dir, "assets", "app-1a2b.js"), `export const app = "${key}";`);
  writeFileSync(join(dir, "theme.js"), "/* theme */");
  writeFileSync(join(dir, "_headers"), HEADERS);
  writeFileSync(
    join(dir, "env.json"),
    JSON.stringify({ environment: "staging", release: RELEASE }),
  );
  return dir;
}

function token(): string {
  return `static${"S".repeat(30)}`;
}

function deployOptions(
  fake: FakeStatic,
  dir: string,
  overrides: Partial<Parameters<typeof deployStatic>[0]> = {},
) {
  const artefact = readArtefact(dir);
  const lines: string[] = [];
  const writes: string[] = [];
  return {
    lines,
    writes,
    options: {
      client: cloudflareClient(fake.token, fake.fetch),
      accountId: ACCOUNT,
      name: "fin-next-staging-console-static",
      config: CONFIG,
      artefact,
      expectedAssetManifestHash: assetManifestHash(artefact.files),
      beforeWrite: (what: string) => {
        writes.push(what);
      },
      log: (line: string) => {
        lines.push(line);
      },
      ...overrides,
    },
  };
}

describe("static.json", () => {
  it("accepts exactly the allowlist", () => {
    assert.deepEqual(parseStaticConfig(CONFIG), CONFIG);
  });

  it("refuses a script, a binding, run_worker_first, a route and wrong values", () => {
    for (const extra of [
      { main: "x.js" },
      { kv_namespaces: [] },
      { routes: [] },
      { triggers: { crons: [] } },
    ]) {
      assert.throws(() => parseStaticConfig({ ...CONFIG, ...extra }), StaticConfigError);
    }
    assert.throws(
      () => parseStaticConfig({ ...CONFIG, assets: { ...CONFIG.assets, run_worker_first: true } }),
      /run_worker_first/,
    );
    assert.throws(
      () => parseStaticConfig({ ...CONFIG, assets: { ...CONFIG.assets, binding: "ASSETS" } }),
      /assets.binding/,
    );
    assert.throws(() => parseStaticConfig({ ...CONFIG, workers_dev: true }), /workers_dev/);
    assert.throws(() => parseStaticConfig({ ...CONFIG, preview_urls: true }), /preview_urls/);
    assert.throws(
      () =>
        parseStaticConfig({
          ...CONFIG,
          assets: { ...CONFIG.assets, not_found_handling: "404-page" },
        }),
      /single-page/,
    );
  });
});

describe("the artefact", () => {
  it("hashes each file as SP-26 did: sha256(base64(content) + extension), 32 hex", () => {
    const content = Buffer.from("export const a = 1;\n");
    const expected = createHash("sha256")
      .update(`${content.toString("base64")}js`)
      .digest("hex")
      .slice(0, 32);
    assert.equal(assetHash(content, "/assets/a.js"), expected);
    assert.equal(assetHash(content, "/LICENSE").length, 32);
  });

  it("reads files and the rendered _headers, and leaves rendered files out of the release hash", () => {
    const root = mkdtempSync(join(tmpdir(), "static-"));
    const a = readArtefact(artefactDir(root, "console"));
    assert.deepEqual(
      a.files.map((f) => f.path),
      ["/assets/app-1a2b.js", "/env.json", "/index.html", "/theme.js"],
    );
    assert.equal(a.headers, HEADERS);
    const b = readArtefact(artefactDir(mkdtempSync(join(tmpdir(), "static-")), "console"));
    writeFileSync(join(b.dir, "env.json"), "{}");
    assert.equal(
      assetManifestHash(readArtefact(b.dir).files),
      assetManifestHash(a.files),
      "env.json is left out",
    );
    writeFileSync(join(b.dir, "theme.js"), "/* changed */");
    assert.notEqual(assetManifestHash(readArtefact(b.dir).files), assetManifestHash(a.files));
  });

  it("refuses links, source maps, Worker control files and a missing _headers or index.html", () => {
    const make = () => artefactDir(mkdtempSync(join(tmpdir(), "static-")), "console");
    const linked = make();
    symlinkSync("/etc/hosts", join(linked, "hosts"));
    assert.throws(() => readArtefact(linked), /is a link/);
    const mapped = make();
    writeFileSync(join(mapped, "assets", "app.js.map"), "{}");
    assert.throws(() => readArtefact(mapped), /source map/);
    const worker = make();
    writeFileSync(join(worker, "_worker.js"), "export default {}");
    assert.throws(() => readArtefact(worker), /Worker control file/);
    const bare = mkdtempSync(join(tmpdir(), "static-"));
    writeFileSync(join(bare, "index.html"), "x");
    assert.throws(() => readArtefact(bare), /no rendered _headers/);
  });
});

describe("the assets-only upload (BD-16)", () => {
  it("uploads through the session, the buckets and one metadata part, then turns workers.dev off and re-reads", async () => {
    const fake = new FakeStatic(token());
    const dir = artefactDir(mkdtempSync(join(tmpdir(), "static-")), "console");
    const { options, writes } = deployOptions(fake, dir);
    const result = await deployStatic(options);
    assert.equal(result.uploaded, 4);
    assert.deepEqual(
      fake.calls.map((c) => `${c.method} ${c.path.replace(ACCOUNT, "A")}`),
      [
        "POST /accounts/A/workers/scripts/fin-next-staging-console-static/assets-upload-session",
        "POST /accounts/A/workers/assets/upload?base64=true",
        "PUT /accounts/A/workers/scripts/fin-next-staging-console-static",
        "POST /accounts/A/workers/scripts/fin-next-staging-console-static/subdomain",
        "GET /accounts/A/workers/scripts",
        "GET /accounts/A/workers/scripts/fin-next-staging-console-static/settings",
        "GET /accounts/A/workers/scripts/fin-next-staging-console-static/subdomain",
      ],
    );
    assert.equal(
      fake.calls[1]?.auth,
      `Bearer ${fake.uploadToken}`,
      "buckets use the upload token, not the API token",
    );
    const script = fake.scripts.get("fin-next-staging-console-static");
    assert.deepEqual(script?.parts, ["metadata"], "one part: metadata, no module");
    assert.deepEqual(Object.keys(script?.metadata ?? {}).sort(), ["assets", "compatibility_date"]);
    assert.deepEqual(script?.metadata.assets, {
      jwt: `completion${"C".repeat(20)}`,
      config: {
        not_found_handling: "single-page-application",
        html_handling: "auto-trailing-slash",
        _headers: HEADERS,
      },
    });
    assert.deepEqual(script?.subdomain, { enabled: false, previews_enabled: false });
    const index = fake.stored.get(
      readArtefact(dir).files.find((f) => f.path === "/index.html")?.hash ?? "",
    );
    assert.equal(
      Buffer.from(index?.base64 ?? "", "base64").toString(),
      "<!doctype html><title>console</title>",
    );
    assert.equal(index?.type, "text/html");
    assert.equal(writes.length, 4, "every write passed the gate first");
  });

  it("sends only the files Cloudflare lacks on the next release", async () => {
    const fake = new FakeStatic(token());
    const dir = artefactDir(mkdtempSync(join(tmpdir(), "static-")), "console");
    await deployStatic(deployOptions(fake, dir).options);
    writeFileSync(join(dir, "theme.js"), "/* next release */");
    const second = await deployStatic(deployOptions(fake, dir).options);
    assert.equal(second.uploaded, 1);
  });

  it("refuses an artefact whose hash is not the release manifest's, before any call", async () => {
    const fake = new FakeStatic(token());
    const dir = artefactDir(mkdtempSync(join(tmpdir(), "static-")), "console");
    const { options } = deployOptions(fake, dir, { expectedAssetManifestHash: "0".repeat(64) });
    await assert.rejects(deployStatic(options), /differs from the release manifest/);
    assert.equal(fake.calls.length, 0);
  });

  it("refuses a deployment name outside fin-next-<env>-<app>-static", async () => {
    const fake = new FakeStatic(token());
    const dir = artefactDir(mkdtempSync(join(tmpdir(), "static-")), "console");
    await assert.rejects(
      deployStatic(deployOptions(fake, dir, { name: "fin-next-staging-watcher" }).options),
      /not a static deployment name/,
    );
    assert.equal(fake.calls.length, 0);
  });

  it("stops when the gate refuses, before anything is sent", async () => {
    const fake = new FakeStatic(token());
    const dir = artefactDir(mkdtempSync(join(tmpdir(), "static-")), "console");
    const { options } = deployOptions(fake, dir, {
      beforeWrite: () => {
        throw new Error("a dry run sends nothing");
      },
    });
    await assert.rejects(deployStatic(options), /dry run/);
    assert.equal(fake.calls.length, 0);
  });

  it("the re-read fails on a module, a binding, workers.dev or previews", async () => {
    const fake = new FakeStatic(token());
    const dir = artefactDir(mkdtempSync(join(tmpdir(), "static-")), "console");
    await deployStatic(deployOptions(fake, dir).options);
    const script = fake.scripts.get("fin-next-staging-console-static");
    assert.ok(script);
    script.has_modules = true;
    script.bindings = [{ type: "kv_namespace" }];
    script.subdomain = { enabled: true, previews_enabled: true };
    const problems = await verifyDeployment(
      cloudflareClient(fake.token, fake.fetch),
      ACCOUNT,
      script.id,
      CONFIG,
    );
    assert.deepEqual(problems, [
      "it has a script module",
      "it has bindings",
      "workers.dev is on",
      "preview URLs are on",
    ]);
  });

  it("builds metadata with nothing but the date and the assets", () => {
    assert.deepEqual(Object.keys(assetsOnlyMetadata(CONFIG, "t", "h")).sort(), [
      "assets",
      "compatibility_date",
    ]);
  });
});

describe("the release manifest", () => {
  it("validates the commit, the digests and the static entries", () => {
    const ok = parseReleaseManifest(
      {
        commit: RELEASE,
        images: { "fin-next-api": `sha256:${"a".repeat(64)}` },
        static: {
          console: {
            artefact: `static-console-${RELEASE}`,
            sha256: "b".repeat(64),
            assetManifestHash: "c".repeat(64),
          },
        },
      },
      RELEASE,
    );
    assert.equal(ok.images["fin-next-api"], `sha256:${"a".repeat(64)}`);
    assert.throws(() => parseReleaseManifest({ commit: "f".repeat(40) }, RELEASE), /not --release/);
    assert.throws(
      () =>
        parseReleaseManifest({ commit: RELEASE, images: { "fin-next-api": "latest" } }, RELEASE),
      /digest/,
    );
    assert.throws(() => parseReleaseManifest({ commit: RELEASE }, "short"), /40-character/);
  });
});

describe("the CI entry point", () => {
  function fixtureRepo() {
    const root = mkdtempSync(join(tmpdir(), "repo-"));
    mkdirSync(join(root, "ops", "environments"), { recursive: true });
    cpSync(
      join(REPO, "ops", "environments", "staging.json"),
      join(root, "ops", "environments", "staging.json"),
    );
    for (const app of ["console", "admin", "verify", "docs"]) {
      mkdirSync(join(root, "apps", app), { recursive: true });
      writeFileSync(join(root, "apps", app, "static.json"), JSON.stringify(CONFIG));
    }
    const rendered = join(root, "rendered");
    const statics: Record<string, unknown> = {};
    for (const key of ["verify", "selfie", "admin", "console", "docs"]) {
      const a = readArtefact(artefactDir(rendered, key));
      statics[key] = {
        artefact: `static-${key}-${RELEASE}`,
        sha256: "d".repeat(64),
        assetManifestHash: assetManifestHash(a.files),
      };
    }
    const manifest = join(root, "release-manifest.json");
    writeFileSync(manifest, JSON.stringify({ commit: RELEASE, images: {}, static: statics }));
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, token());
    chmodSync(tokenFile, 0o600);
    return { root, rendered, manifest, tokenFile };
  }

  it("deploys every static app in order with the one account the token sees, and prints no secret", async () => {
    const f = fixtureRepo();
    const fake = new FakeStatic(token());
    let out = "";
    let err = "";
    const code = await main({
      argv: [
        "--env",
        "staging",
        "--release",
        RELEASE,
        "--manifest",
        f.manifest,
        "--dir",
        f.rendered,
      ],
      env: { FIN_CF_STATIC_TOKEN_FILE: f.tokenFile, GITHUB_ACTIONS: "true" },
      repoRoot: f.root,
      fetch: fake.fetch,
      stdout: (t) => {
        out += t;
      },
      stderr: (t) => {
        err += t;
      },
    });
    assert.equal(code, 0, err);
    assert.deepEqual(
      [...fake.scripts.keys()],
      [
        "fin-next-staging-verify-static",
        "fin-next-staging-selfie-static",
        "fin-next-staging-admin-static",
        "fin-next-staging-console-static",
        "fin-next-staging-docs-static",
      ],
    );
    assert.match(out, /"event":"deploy.static_done"/);
    const printed = out
      .split("\n")
      .filter((l) => !l.startsWith("::add-mask::"))
      .join("\n");
    assert.equal(printed.includes(token()), false);
    assert.equal(printed.includes(ACCOUNT), false);
    assert.match(out, /^::add-mask::/m);
  });

  it("refuses a token that sees more than one account, and bad arguments", async () => {
    const f = fixtureRepo();
    const fake = new FakeStatic(token());
    fake.accounts.push({ id: "2".repeat(32) });
    let err = "";
    const io = {
      env: { FIN_CF_STATIC_TOKEN_FILE: f.tokenFile },
      repoRoot: f.root,
      fetch: fake.fetch,
      stdout: () => {},
      stderr: (t: string) => {
        err += t;
      },
    };
    assert.equal(
      await main({
        ...io,
        argv: [
          "--env",
          "staging",
          "--release",
          RELEASE,
          "--manifest",
          f.manifest,
          "--dir",
          f.rendered,
        ],
      }),
      65,
    );
    assert.match(err, /sees 2 accounts/);
    assert.equal(
      await main({
        ...io,
        argv: [
          "--env",
          "production",
          "--release",
          RELEASE,
          "--manifest",
          f.manifest,
          "--dir",
          f.rendered,
        ],
      }),
      65,
    );
    assert.equal(await main({ ...io, argv: ["--release", RELEASE] }), 65);
    assert.equal(fake.scripts.size, 0);
  });
});
