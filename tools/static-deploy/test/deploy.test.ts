import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assetHash, assetManifestHash, checkRenderedFiles, readArtefact } from "../src/artefact.ts";
import { cloudflareClient } from "../src/cloudflare.ts";
import { parseStaticConfig, type StaticConfig, StaticConfigError } from "../src/config.ts";
import { assetsOnlyMetadata, deployStatic } from "../src/deploy.ts";
import { main } from "../src/main.ts";
import {
  attestationArgs,
  ProvenanceError,
  type ReleaseIdentity,
  verifyAttestation,
  verifyBuildAttestation,
} from "../src/provenance.ts";
import { parseReleaseManifest } from "../src/release.ts";
import { verifyDeployment } from "../src/verify.ts";
import { ACCOUNT, FakeGh, FakeStatic, RELEASE_SAN, REPOSITORY } from "./fake.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const RELEASE = "e".repeat(40);
const CONFIG: StaticConfig = {
  compatibility_date: "2026-11-20",
  assets: { not_found_handling: "single-page-application", html_handling: "auto-trailing-slash" },
  workers_dev: false,
  preview_urls: false,
};
const HEADERS =
  "/*\n  Cache-Control: no-cache\n  Content-Security-Policy: default-src 'none'; script-src 'self'\n/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n";
const IDENTITY: ReleaseIdentity = {
  repository: REPOSITORY,
  workflow: ".github/workflows/release.yml",
  ref: "refs/heads/main",
};

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
    assert.equal(ok.minimumSchemaVersion, null, "absent: no minimum schema version");
    const withSchema = parseReleaseManifest(
      { commit: RELEASE, minimumSchemaVersion: "20261121100000_audit_core.sql" },
      RELEASE,
    );
    assert.equal(withSchema.minimumSchemaVersion, "20261121100000_audit_core.sql");
    for (const bad of [7, "", "../x", "a b"]) {
      assert.throws(
        () => parseReleaseManifest({ commit: RELEASE, minimumSchemaVersion: bad }, RELEASE),
        /minimumSchemaVersion/,
        String(bad),
      );
    }
    assert.throws(() => parseReleaseManifest({ commit: "f".repeat(40) }, RELEASE), /not --release/);
    assert.throws(
      () =>
        parseReleaseManifest({ commit: RELEASE, images: { "fin-next-api": "latest" } }, RELEASE),
      /digest/,
    );
    assert.throws(() => parseReleaseManifest({ commit: RELEASE }, "short"), /40-character/);
  });
});

describe("provenance (gh attestation verify)", () => {
  const subject = `oci://ghcr.io/aktharazif/fin-next-api@sha256:${"a".repeat(64)}`;

  it("pins the exact identity, binds the commit, and reads the JSON back", () => {
    const args = attestationArgs(subject, IDENTITY, RELEASE);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.equal(flag("--cert-identity"), RELEASE_SAN);
    assert.equal(flag("--source-digest"), RELEASE);
    assert.equal(flag("--source-ref"), "refs/heads/main");
    assert.equal(flag("--format"), "json");
    assert.ok(args.includes("--deny-self-hosted-runners"));
    const gh = new FakeGh();
    verifyAttestation(gh.exec, subject, IDENTITY, RELEASE, "api");
  });

  it("refuses a lower-cased owner, another commit, another trigger and output that is not JSON", () => {
    const gh = new FakeGh();
    assert.throws(
      () =>
        verifyAttestation(
          gh.exec,
          subject,
          { ...IDENTITY, repository: REPOSITORY.toLowerCase() },
          RELEASE,
          "api",
        ),
      ProvenanceError,
      "the certificate identity is compared exactly",
    );
    gh.builtFrom = "f".repeat(40);
    assert.throws(
      () => verifyAttestation(gh.exec, subject, IDENTITY, RELEASE, "api"),
      ProvenanceError,
    );
    gh.builtFrom = undefined;
    gh.trigger = "workflow_dispatch";
    assert.throws(
      () => verifyAttestation(gh.exec, subject, IDENTITY, RELEASE, "api"),
      /no verified attestation is from a push/,
    );
    const quiet = () => ({ status: 0, stdout: "", stderr: "" });
    assert.throws(() => verifyAttestation(quiet, subject, IDENTITY, RELEASE, "api"), /no JSON/);
    const empty = () => ({ status: 0, stdout: "[]", stderr: "" });
    assert.throws(
      () => verifyAttestation(empty, subject, IDENTITY, RELEASE, "api"),
      /no attestation/,
    );
  });

  it("verifies a build from any commit of main with the same pinned identity, for a digest an attested manifest names", () => {
    const args = attestationArgs(subject, IDENTITY, undefined);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.equal(args.includes("--source-digest"), false);
    assert.equal(flag("--cert-identity"), RELEASE_SAN);
    assert.equal(flag("--source-ref"), "refs/heads/main");
    assert.ok(args.includes("--deny-self-hosted-runners"));
    const gh = new FakeGh();
    gh.builtFrom = "f".repeat(40);
    verifyBuildAttestation(gh.exec, subject, IDENTITY, "api");
    gh.trigger = "workflow_dispatch";
    assert.throws(
      () => verifyBuildAttestation(gh.exec, subject, IDENTITY, "api"),
      /no verified attestation is from a push/,
    );
    gh.trigger = "push";
    gh.san = RELEASE_SAN.replace("release.yml", "other.yml");
    assert.throws(() => verifyBuildAttestation(gh.exec, subject, IDENTITY, "api"), ProvenanceError);
    const otherRef = () => ({
      status: 0,
      stdout: JSON.stringify([
        {
          verificationResult: {
            signature: {
              certificate: {
                subjectAlternativeName: RELEASE_SAN,
                buildTrigger: "push",
                sourceRepositoryDigest: "f".repeat(40),
                sourceRepositoryRef: "refs/heads/other",
              },
            },
          },
        },
      ]),
      stderr: "",
    });
    assert.throws(
      () => verifyBuildAttestation(otherRef, subject, IDENTITY, "api"),
      /no verified attestation is from a push to refs\/heads\/main/,
    );
  });
});

describe("the rendered files", () => {
  it("must carry this release and environment, a CSP for /*, and no CORS header", () => {
    const dir = artefactDir(mkdtempSync(join(tmpdir(), "static-")), "console");
    checkRenderedFiles(readArtefact(dir), RELEASE, "staging");
    assert.throws(
      () => checkRenderedFiles(readArtefact(dir), "f".repeat(40), "staging"),
      /release/,
    );
    assert.throws(
      () => checkRenderedFiles(readArtefact(dir), RELEASE, "production"),
      /environment/,
    );
    for (const headers of [
      "/*\n  Cache-Control: no-cache\n",
      "/assets/*\n  Content-Security-Policy: default-src 'none'\n",
      `${HEADERS}/*\n  Access-Control-Allow-Origin: *\n`,
    ]) {
      writeFileSync(join(dir, "_headers"), headers);
      assert.throws(
        () => checkRenderedFiles(readArtefact(dir), RELEASE, "staging"),
        StaticConfigError,
      );
    }
  });
});

describe("the CI entry point", () => {
  const KEYS = ["verify", "selfie", "admin", "console", "docs"];

  function fixtureRepo(attestManifest = true) {
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
    for (const key of KEYS) {
      const a = readArtefact(artefactDir(rendered, key));
      statics[key] = {
        artefact: `static-${key}-${RELEASE}`,
        sha256: "d".repeat(64),
        assetManifestHash: assetManifestHash(a.files),
      };
    }
    const manifest = join(root, "release-manifest.json");
    const text = JSON.stringify({ commit: RELEASE, images: {}, static: statics });
    writeFileSync(manifest, text);
    const gh = new FakeGh();
    if (attestManifest) gh.attest(text);
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, token());
    chmodSync(tokenFile, 0o600);
    return { root, rendered, manifest, tokenFile, gh };
  }

  function io(f: ReturnType<typeof fixtureRepo>, fake: FakeStatic) {
    const printed = { out: "", err: "" };
    return {
      printed,
      io: {
        env: { FIN_CF_STATIC_TOKEN_FILE: f.tokenFile, GITHUB_ACTIONS: "true" },
        repoRoot: f.root,
        fetch: fake.fetch,
        exec: f.gh.exec,
        stdout: (t: string) => {
          printed.out += t;
        },
        stderr: (t: string) => {
          printed.err += t;
        },
      },
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
    };
  }

  it("verifies the manifest, then deploys every static app in order with the one account the token sees, and prints no secret", async () => {
    const f = fixtureRepo();
    const fake = new FakeStatic(token());
    const { io: base, argv, printed } = io(f, fake);
    const code = await main({ ...base, argv });
    assert.equal(code, 0, printed.err);
    assert.equal(f.gh.calls.filter((c) => c[1] === "attestation").length, 1);
    assert.deepEqual(
      [...fake.scripts.keys()],
      KEYS.map((k) => `fin-next-staging-${k}-static`),
    );
    assert.match(printed.out, /"event":"deploy.static_done"/);
    const shown = printed.out
      .split("\n")
      .filter((l) => !l.startsWith("::add-mask::"))
      .join("\n");
    assert.equal(shown.includes(token()), false);
    assert.equal(shown.includes(ACCOUNT), false);
    assert.match(printed.out, /^::add-mask::/m);
  });

  it("refuses a manifest whose attestation does not verify, before the token is read or any call", async () => {
    const f = fixtureRepo(false);
    const fake = new FakeStatic(token());
    const { io: base, argv, printed } = io(f, fake);
    assert.equal(await main({ ...base, argv }), 65);
    assert.match(printed.err, /the release manifest: the attestation does not verify/);
    assert.equal(fake.calls.length, 0);
  });

  it("checks every deployment before the first upload: a bad later one moves no host", async () => {
    for (const tamper of [
      (f: ReturnType<typeof fixtureRepo>) =>
        writeFileSync(join(f.rendered, "console", "theme.js"), "/* not the release's */"),
      (f: ReturnType<typeof fixtureRepo>) =>
        writeFileSync(
          join(f.rendered, "console", "_headers"),
          "/*\n  Access-Control-Allow-Origin: *\n",
        ),
      (f: ReturnType<typeof fixtureRepo>) =>
        writeFileSync(
          join(f.rendered, "console", "env.json"),
          JSON.stringify({ environment: "staging", release: "f".repeat(40) }),
        ),
    ]) {
      const f = fixtureRepo();
      tamper(f);
      const fake = new FakeStatic(token());
      const { io: base, argv, printed } = io(f, fake);
      assert.equal(await main({ ...base, argv }), 65);
      assert.match(printed.err, /static console: .*nothing was uploaded/);
      assert.equal(fake.calls.length, 0, "not even the token's account read");
    }
  });

  it("says which host serves which release when an upload fails", async () => {
    const f = fixtureRepo();
    const fake = new FakeStatic(token());
    const { io: base, argv, printed } = io(f, fake);
    const failing = async (url: string, init: RequestInit) =>
      init.method === "PUT" && url.endsWith("/fin-next-staging-admin-static")
        ? new Response(JSON.stringify({ success: false, errors: [], result: null }), {
            status: 500,
          })
        : fake.fetch(url, init);
    assert.equal(await main({ ...base, fetch: failing, argv }), 69);
    assert.match(
      printed.out,
      /stopped at admin \(it may serve either release\); new release on: verify, selfie; previous release still on: console, docs/,
    );
  });

  it("refuses a token that sees more than one account, and bad arguments", async () => {
    const f = fixtureRepo();
    const fake = new FakeStatic(token());
    fake.accounts.push({ id: "2".repeat(32) });
    const { io: base, argv, printed } = io(f, fake);
    assert.equal(await main({ ...base, argv }), 65);
    assert.match(printed.err, /sees 2 accounts/);
    const production = [...argv];
    production[1] = "production";
    assert.equal(await main({ ...base, argv: production }), 65);
    assert.equal(await main({ ...base, argv: ["--release", RELEASE] }), 65);
    assert.equal(fake.scripts.size, 0);
  });
});
