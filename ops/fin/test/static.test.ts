import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  renderStatic,
  type RenderInput as WebHostRenderInput,
} from "../../../packages/web-host/src/static/render.ts";
import { ACCOUNT, FakeGh, FakeStatic } from "../../../tools/static-deploy/test/fake.ts";
import { runCli } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import { RunLog } from "../src/core/runlog.ts";
import { loadSettings } from "../src/core/settings.ts";
import { staticDeployCommand } from "../src/static/deploy.ts";
import { buildHash, staticRenderCommand } from "../src/static/render.ts";
import type { RenderInput, StaticRenderer } from "../src/static/renderer.ts";
import { readZip, ZipError } from "../src/static/zip.ts";
import {
  commandEnv,
  fakeRuntime,
  fakeToken,
  hex,
  overlayFixture,
  REPO_ROOT,
  uuid,
  writePrivate,
  ZONE,
} from "./helpers/fixtures.ts";
import { FakeCloudflare, FakeRailway } from "./helpers/providers.ts";
import { type ZipInput, zipOf } from "./helpers/zip.ts";

const RELEASE = hex(40, "c");
/** Another release, deployed after RELEASE in some tests. */
const OTHER = hex(40, "d");
const KEYS = ["verify", "selfie", "admin", "console", "docs"];
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const settings = loadSettings(REPO_ROOT, "staging");
const IMAGE_NAMES = [
  "fin-next-api",
  "fin-next-edge",
  "fin-next-payments",
  "fin-next-console",
  "fin-next-admin",
  "fin-next-verify",
  "fin-next-connector",
];
/** A release's image digests, one per image and different for each seed. */
const imagesOf = (seed: string): Record<string, string> =>
  Object.fromEntries(IMAGE_NAMES.map((name, i) => [name, `sha256:${hex(63, seed)}${i}`]));
/** The image reference each service a deploy rolls runs on a release, as `railway deploy` sets it. */
function refsOf(images: Record<string, string>): Map<string, string> {
  const s = settings.railway;
  const refs = new Map<string, string>();
  for (const service of [...s.deployOrder, ...s.connectorOrder]) {
    const image = s.services[service]?.image ?? "";
    refs.set(service, `${s.imageRepository}${image}@${images[image]}`);
  }
  return refs;
}

/**
 * A renderer that answers as packages/web-host's does: headers from the profile, and env.json as
 * the bytes it renders.
 */
function fakeRenderer(
  seen: RenderInput[] = [],
  override?: (input: RenderInput) => { headers: string; env: Record<string, unknown> },
): StaticRenderer {
  const bytes = (env: Record<string, unknown>) => `${JSON.stringify(env, null, 2)}\n`;
  return {
    renderStatic(input) {
      seen.push(input);
      if (override !== undefined) {
        const { headers, env } = override(input);
        return { headers, envJson: bytes(env) };
      }
      const connect = input.profile === "docs" ? `'self' https://${input.hosts.api}` : "'self'";
      return {
        headers: `/*\n  Cache-Control: no-cache\n  Content-Security-Policy: default-src 'none'; connect-src ${connect}\n/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n`,
        envJson: bytes({
          environment: input.environment,
          release: input.release,
          consoleOrigin: `https://${input.hosts.console}`,
          docsOrigin: `https://${input.hosts.docs}`,
          ...(input.profile === "docs" ? { apiOrigin: `https://${input.hosts.api}` } : {}),
        }),
      };
    },
  };
}

/** Waits until the condition holds, letting other work run between checks. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), "the condition never held");
}

/** A sleep that never ends: a stop's settle wait then lasts until the change in flight settles. */
const NEVER = () => new Promise<void>(() => {});

/** The hosts `static render` gives the renderer for an output (hostsFor). */
function hostsOf(key: string): Record<string, string> {
  const { pg: _pg, admin, ...hosts } = overlayFixture().hosts;
  return key === "admin" ? { ...hosts, admin } : hosts;
}

function buildFiles(key: string): ZipInput[] {
  return [
    { path: "index.html", data: `<!doctype html><title>${key}</title>` },
    { path: "assets/main-abc.js", data: `console.log("${key}")` },
  ];
}

interface Release {
  archives: string;
  manifestFile: string;
  gh: FakeGh;
}

/**
 * What release.yml leaves for a release: one zip per static deployment and the manifest, each
 * attested (unless a test changes it first).
 */
function release(
  dir: string,
  change: {
    files?: (key: string) => ZipInput[];
    manifest?: (statics: Record<string, Record<string, string>>) => void;
    attestManifest?: boolean;
    attestArchive?: (key: string) => boolean;
  } = {},
): Release {
  const gh = new FakeGh();
  const archives = join(dir, "archives");
  mkdirSync(archives, { recursive: true });
  const statics: Record<string, Record<string, string>> = {};
  for (const key of KEYS) {
    const files = (change.files ?? buildFiles)(key);
    const zip = zipOf(files);
    const name = `static-${key}-${RELEASE}`;
    writeFileSync(join(archives, `${name}.zip`), zip);
    if (change.attestArchive?.(key) ?? true) gh.attest(zip);
    statics[key] = {
      artefact: name,
      sha256: sha256(zip),
      assetManifestHash: buildHash(files.map((f) => ({ path: f.path, data: Buffer.from(f.data) }))),
    };
  }
  change.manifest?.(statics);
  const text = JSON.stringify({
    commit: RELEASE,
    images: imagesOf("3"),
    static: statics,
    migrations: [],
  });
  const manifestFile = join(dir, "release-manifest.json");
  writeFileSync(manifestFile, text);
  if (change.attestManifest ?? true) gh.attest(text);
  return { archives, manifestFile, gh };
}

/** Renders with a test renderer, or with packages/web-host's own through the default loader. */
async function render(
  r: Release,
  env: Record<string, string>,
  out: string,
  renderer: StaticRenderer | "web-host" = fakeRenderer(),
  extra: string[] = [],
) {
  const rt = fakeRuntime({ env, exec: r.gh.exec });
  const code = await runCli(
    [
      "static",
      "render",
      "staging",
      "--release",
      RELEASE,
      "--manifest",
      r.manifestFile,
      "--archives",
      r.archives,
      "--out",
      out,
      ...extra,
    ],
    rt,
    [renderer === "web-host" ? staticRenderCommand() : staticRenderCommand(async () => renderer)],
  );
  return { code, rt };
}

describe("static render", () => {
  it("refuses while packages/web-host's renderer does not exist (no fallback renderer)", async () => {
    const { env, dir } = commandEnv();
    const r = release(dir);
    const rt = fakeRuntime({ env, exec: r.gh.exec });
    const code = await runCli(
      [
        "static",
        "render",
        "staging",
        "--release",
        RELEASE,
        "--manifest",
        r.manifestFile,
        "--archives",
        r.archives,
        "--out",
        join(dir, "out"),
      ],
      rt,
      [staticRenderCommand(async () => undefined)],
    );
    assert.equal(code, EXIT.config);
    assert.match(rt.err(), /waits for packages\/web-host\/src\/static\/render.ts/);
  });

  it("verifies the manifest and every archive, then writes each attested build with its rendered files", async () => {
    const { env, dir } = commandEnv();
    const r = release(dir);
    const seen: RenderInput[] = [];
    const out = join(dir, "out");
    const { code, rt } = await render(r, env, out, fakeRenderer(seen));
    assert.equal(code, EXIT.ok, rt.err());
    const verified = r.gh.calls.filter((c) => c[1] === "attestation");
    assert.equal(verified.length, 1 + KEYS.length, "the manifest and each archive");
    for (const c of verified) assert.equal(c[c.indexOf("--source-digest") + 1], RELEASE);
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
    assert.equal(
      readFileSync(join(out, "console", "assets", "main-abc.js"), "utf8"),
      'console.log("console")',
    );
    assert.match(readFileSync(join(out, "console", "_headers"), "utf8"), /Cache-Control: no-cache/);
    assert.equal(rt.out().includes(ZONE), false);
  });

  it("renders with packages/web-host's own renderer through the default loader, writing its bytes as they are", async () => {
    const { env, dir } = commandEnv();
    const r = release(dir);
    const out = join(dir, "out");
    const { code, rt } = await render(r, env, out, "web-host");
    assert.equal(code, EXIT.ok, rt.err());
    for (const key of KEYS) {
      const expected = renderStatic({
        output: key as WebHostRenderInput["output"],
        environment: "staging",
        release: RELEASE,
        hosts: hostsOf(key),
      });
      assert.equal(readFileSync(join(out, key, "_headers"), "utf8"), expected.headers, key);
      assert.equal(readFileSync(join(out, key, "env.json"), "utf8"), expected.envJson, key);
    }
    const docs = JSON.parse(readFileSync(join(out, "docs", "env.json"), "utf8"));
    assert.equal(docs.apiOrigin, `https://gateway.${ZONE}`);
    assert.equal(docs.release, RELEASE);
    for (const key of KEYS.filter((k) => k !== "admin")) {
      const files = ["_headers", "env.json"].map((f) => readFileSync(join(out, key, f), "utf8"));
      assert.equal(files.join("").includes(`staff.${ZONE}`), false, `${key} names no admin host`);
    }
    assert.equal(rt.out().includes(ZONE), false);
  });

  it("refuses with a config error when packages/web-host's renderer refuses the input", async () => {
    const { env, dir } = commandEnv();
    const overlay = overlayFixture();
    const { docs: _docs, ...hosts } = overlay.hosts;
    env.FIN_OVERLAY_FILE = writePrivate(
      dir,
      "overlay-no-docs.json",
      JSON.stringify({ ...overlay, hosts }),
    );
    const r = release(dir);
    const out = join(dir, "out");
    const { code, rt } = await render(r, env, out, "web-host", ["--only", "console"]);
    assert.equal(code, EXIT.config, rt.err());
    assert.match(rt.err(), /static console: the renderer refused: .*docs role/);
    assert.equal(existsSync(join(out, "console")), false);
  });

  it("refuses an unattested manifest, an unattested archive, and an archive whose SHA-256 is not the manifest's", async () => {
    for (const [name, change] of [
      ["manifest", { attestManifest: false }],
      ["archive", { attestArchive: (key: string) => key !== "admin" }],
      [
        "sha256",
        {
          manifest: (s: Record<string, Record<string, string>>) => {
            if (s.console) s.console.sha256 = hex(64, "0");
          },
        },
      ],
    ] as const) {
      const { env, dir } = commandEnv();
      const r = release(dir, change);
      const out = join(dir, "out");
      const { code, rt } = await render(r, env, out);
      assert.equal(code, EXIT.data, name);
      assert.equal(existsSync(out), false, `${name}: nothing is written`);
      if (name === "sha256") assert.match(rt.err(), /SHA-256 is not the release manifest's/);
    }
  });

  it("refuses an archive that holds _headers, env.json or a source map, or files that do not hash to the manifest's", async () => {
    for (const extra of ["_headers", "env.json", "assets/main.js.map"]) {
      const { env, dir } = commandEnv();
      const r = release(dir, {
        files: (key) => [
          ...buildFiles(key),
          ...(key === "console" ? [{ path: extra, data: "x" }] : []),
        ],
      });
      const { code } = await render(r, env, join(dir, "out"));
      assert.equal(code, EXIT.data, extra);
    }
    const { env, dir } = commandEnv();
    const r = release(dir, {
      manifest: (s) => {
        if (s.docs) s.docs.assetManifestHash = hex(64, "f");
      },
    });
    const { code, rt } = await render(r, env, join(dir, "out"));
    assert.equal(code, EXIT.data);
    assert.match(rt.err(), /do not hash to the release manifest's assetManifestHash/);
  });

  it("refuses a rendered output that names a host it may not, or another release", async () => {
    const { env, dir } = commandEnv();
    const r = release(dir);
    const leaky = fakeRenderer([], (input) => ({
      headers: `/*\n  Content-Security-Policy: connect-src 'self' https://staff.${ZONE}\n`,
      env: { environment: input.environment, release: input.release },
    }));
    const out = join(dir, "out");
    assert.equal((await render(r, env, out, leaky, ["--only", "console"])).code, EXIT.refused);
    const stale = fakeRenderer([], () => ({
      headers: "/*\n  X: y\n",
      env: { environment: "staging", release: hex(40, "d") },
    }));
    assert.equal((await render(r, env, out, stale)).code, EXIT.data);
    assert.equal(existsSync(join(out, "console")), false, "nothing is written when a check fails");
  });
});

describe("the archive reader", () => {
  it("reads the files of a deflated or stored archive", () => {
    const files = readZip(
      zipOf([
        { path: "index.html", data: "<!doctype html>" },
        { path: "assets/a.js", data: "a", method: 0 },
      ]),
    );
    assert.deepEqual(
      files.map((f) => [f.path, f.data.toString()]),
      [
        ["index.html", "<!doctype html>"],
        ["assets/a.js", "a"],
      ],
    );
  });

  it("refuses links, unsafe paths, duplicates and a corrupted entry", () => {
    const bad: ZipInput[][] = [
      [{ path: "assets/link", data: "/etc/hosts", mode: 0o120777 }],
      [{ path: "../escape.html", data: "x" }],
      [{ path: "/abs.html", data: "x" }],
      [{ path: "a\\b.html", data: "x" }],
      [
        { path: "index.html", data: "x" },
        { path: "index.html", data: "y" },
      ],
    ];
    for (const entries of bad) assert.throws(() => readZip(zipOf(entries)), ZipError);
    const zip = zipOf([{ path: "index.html", data: "hello world", method: 0 }]);
    const at = 30 + "index.html".length;
    zip.writeUInt8(zip.readUInt8(at) ^ 0xff, at);
    assert.throws(() => readZip(zip), /CRC-32/);
    assert.throws(() => readZip(Buffer.from("not a zip")), ZipError);
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

  const MINTED = `mintedvalue${"Q".repeat(30)}1`;

  /**
   * A registered `railway deploy` in this machine's run log: its release, and how it ended (with no
   * result it has no `run.done`, as when it is still running or was stopped).
   */
  interface Logged {
    release: string;
    result?: "ok" | "failed";
  }
  function seedRunLog(env: Record<string, string>, runs: readonly Logged[]): void {
    const log = new RunLog(join(env.FIN_STATE_DIR ?? "", "staging"), new Masker());
    const at = new Date("2026-11-21T05:00:00Z");
    runs.forEach(({ release: sha, result }, i) => {
      const runId = `run_railway${i}`;
      log.append(at, runId, "run.registered", { command: "railway deploy", release: sha });
      // As applyPlan writes them: a failed run's run.done carries no release.
      if (result !== undefined)
        log.append(at, runId, "run.done", {
          command: "railway deploy",
          result,
          ...(result === "ok" ? { release: sha } : {}),
        });
    });
  }

  /**
   * A rendered release, and the fakes a deploy talks to (Railway, the token mint and the uploads).
   * By default the run log holds a successful `railway deploy` of the release and every service
   * runs its digests; `live: false` leaves the services as provisioned, with no image.
   */
  async function rendered(
    change: Parameters<typeof release>[1] = {},
    {
      runs = [{ release: RELEASE, result: "ok" }],
      live = true,
      webHost = false,
    }: { runs?: readonly Logged[]; live?: boolean; webHost?: boolean } = {},
  ) {
    const { env, dir } = commandEnv();
    seedRunLog(env, runs);
    const r = release(dir, change);
    const out = join(dir, "rendered");
    const { code, rt } = await render(r, env, out, webHost ? "web-host" : fakeRenderer());
    assert.equal(code, EXIT.ok, rt.err());
    const cfToken = fakeToken("cf");
    env.FIN_CF_TOKEN_FILE = writePrivate(dir, "cf-token", cfToken);
    // CR-20 never reaches the operator machine: a static token file named here is never read.
    env.FIN_CF_STATIC_TOKEN_FILE = join(dir, "no-such-static-token");
    const rwToken = fakeToken("rw");
    env.FIN_RAILWAY_TOKEN_FILE = writePrivate(dir, "railway-token", rwToken);
    const rw = new FakeRailway(rwToken, Object.keys(settings.railway.services));
    rw.provision(settings.railway, uuid("d"), overlayFixture().staticEgress);
    if (live) for (const [service, ref] of refsOf(imagesOf("3"))) rw.running(service, ref);
    const cf = new FakeCloudflare(cfToken);
    cf.groups.push({ id: hex(32, "9"), name: "Workers Scripts Write" });
    const statics = new FakeStatic(MINTED);
    const sequence: string[] = [];
    let failPut: string | undefined;
    /** Calls held in flight until the test opens them: the first call each one matches. */
    const holds: Array<{
      match: (method: string, path: string) => boolean;
      reached: () => void;
      wait: Promise<void>;
    }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      if (url.startsWith("https://backboard.railway.com/")) return rw.fetch(url, init);
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      sequence.push(`${method} ${path}`);
      const held = holds.find((h) => h.match(method, path));
      if (held !== undefined) {
        holds.splice(holds.indexOf(held), 1);
        held.reached();
        await held.wait;
      }
      if (path.includes("/tokens")) return cf.fetch(url, init);
      if (failPut !== undefined && init.method === "PUT" && path.endsWith(`/${failPut}`))
        return new Response(JSON.stringify({ success: false, errors: [], result: null }), {
          status: 500,
        });
      return statics.fetch(url, init);
    };
    /** Starts a deploy without waiting for it (the test may stop it meanwhile). */
    const start = (extra: string[] = [], dirArg = out, sleep?: (ms: number) => Promise<void>) => {
      const rt = fakeRuntime({
        env,
        fetch,
        exec: r.gh.exec,
        repoRoot: repoWithStatic(dir),
        ...(sleep === undefined ? {} : { sleep }),
      });
      const done = runCli(
        [
          "static",
          "deploy",
          "staging",
          "--release",
          RELEASE,
          "--manifest",
          r.manifestFile,
          "--dir",
          dirArg,
          ...extra,
        ],
        rt,
        [webHost ? staticDeployCommand() : staticDeployCommand(async () => fakeRenderer())],
      );
      return { rt, done };
    };
    const run = async (extra: string[] = [], dirArg = out) => {
      const { rt, done } = start(extra, dirArg);
      return { code: await done, rt };
    };
    /** Holds the first call that matches in flight until open() (reached settles once it is). */
    const hold = (match: (method: string, path: string) => boolean) => {
      let reached: () => void = () => {};
      let open: () => void = () => {};
      const isReached = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      holds.push({ match, reached, wait });
      return { reached: isReached, open };
    };
    /** A real `railway deploy` of RELEASE (its manifest) or OTHER (other digests), attested. */
    const railwayDeploy = async (sha: string): Promise<number> => {
      let manifestFile = r.manifestFile;
      if (sha !== RELEASE) {
        const text = JSON.stringify({
          commit: sha,
          images: imagesOf("4"),
          static: {},
          migrations: [],
        });
        manifestFile = join(dir, `release-manifest-${sha}.json`);
        writeFileSync(manifestFile, text);
        r.gh.attest(text);
      }
      const rt = fakeRuntime({ env, fetch, exec: r.gh.exec });
      const code = await runCli(
        ["railway", "deploy", "staging", "--release", sha, "--manifest", manifestFile],
        rt,
      );
      assert.equal(code, EXIT.ok, rt.err());
      return code;
    };
    return {
      env,
      dir,
      out,
      r,
      rw,
      cf,
      statics,
      sequence,
      run,
      start,
      hold,
      railwayDeploy,
      failAt: (script: string) => {
        failPut = script;
      },
    };
  }

  const runsLog = (t: { env: Record<string, string> }) =>
    readFileSync(join(t.env.FIN_STATE_DIR ?? "", "staging", "runs.jsonl"), "utf8");

  it("uploads every rendered build with a one-run token it mints and revokes, inside a registered run", async () => {
    const t = await rendered();
    const { code, rt } = await t.run();
    assert.equal(code, EXIT.ok, rt.err());
    assert.deepEqual(
      [...t.statics.scripts.keys()],
      KEYS.map((k) => `fin-next-staging-${k}-static`),
    );
    for (const s of t.statics.scripts.values()) {
      assert.deepEqual(s.parts, ["metadata"]);
      assert.deepEqual(s.subdomain, { enabled: false, previews_enabled: false });
    }
    const mint = t.cf.calls.find((c) => c.method === "POST" && c.path.endsWith("/tokens"));
    const body = mint?.body as {
      name: string;
      policies: Array<{
        resources: Record<string, string>;
        permission_groups: Array<{ id: string }>;
      }>;
      expires_on: string;
    };
    assert.equal(body.name, "fin-next-staging-static-run");
    assert.deepEqual(Object.keys(body.policies[0]?.resources ?? {}), [
      `com.cloudflare.api.account.${ACCOUNT}`,
    ]);
    assert.deepEqual(body.policies[0]?.permission_groups, [{ id: hex(32, "9") }]);
    const expires = Date.parse(body.expires_on) - Date.parse("2026-11-21T06:00:00Z");
    assert.ok(expires > 0 && expires <= 60 * 60_000, "a one-run token expires within the hour");
    assert.equal(t.cf.tokens.length, 0, "the one-run token is revoked when the run ends");
    assert.equal(
      t.sequence.at(-1)?.startsWith("DELETE"),
      true,
      "revoked after the last upload's re-read",
    );
    for (const value of [ACCOUNT, MINTED, fakeToken("cf"), fakeToken("rw"), uuid("c"), uuid("d")])
      assert.equal(rt.out().includes(value), false);
    assert.match(rt.out(), /every service runs this release now/);
    assert.ok(
      t.rw.operations.includes("finDeploymentImage"),
      "what each service runs is read from Railway",
    );
    const log = runsLog(t);
    assert.match(log, /"event":"run.registered"/);
    assert.match(log, /"result":"ok"/);
    const lines = readFileSync(join(t.env.FIN_STATE_DIR ?? "", "staging", "lines.jsonl"), "utf8");
    assert.equal((lines.match(/"event":"deploy.static_step"/g) ?? []).length, 5);
    assert.match(lines, /"event":"deploy.static_done"/);
  });

  it("refuses unless ci.yml's merge job succeeded for the commit, before any Cloudflare call, in a dry run too", async () => {
    for (const conclusion of ["failure", "cancelled", undefined]) {
      const t = await rendered();
      t.r.gh.mergeConclusion = conclusion;
      for (const extra of [[], ["--dry-run"]]) {
        const { code, rt } = await t.run(extra);
        assert.equal(code, EXIT.refused, `${conclusion} ${extra.join(" ")}`);
        assert.match(rt.err(), /ci\.yml's merge job/);
      }
      assert.ok(
        t.r.gh.calls.some((c) => c[1] === "api"),
        "the Actions API is read",
      );
      assert.equal(t.sequence.length, 0, "no token minted, nothing uploaded");
    }
  });

  it("refuses unless the newest railway deploy in this machine's run log is a successful one of the release (S0-06), in a dry run too", async () => {
    const ok = (sha: string): Logged => ({ release: sha, result: "ok" });
    const cases: Array<[string, Logged[]]> = [
      ["no deploy", []],
      ["a failed deploy", [{ release: RELEASE, result: "failed" }]],
      ["a deploy of another release", [ok(OTHER)]],
      ["a later deploy of another release", [ok(RELEASE), ok(OTHER)]],
      ["a later failed deploy", [ok(RELEASE), { release: OTHER, result: "failed" }]],
      ["a later deploy that did not finish", [ok(RELEASE), { release: RELEASE }]],
    ];
    for (const [name, runs] of cases) {
      // Every service runs the release, so only the run log can refuse here.
      const t = await rendered({}, { runs });
      for (const extra of [[], ["--dry-run"]]) {
        const { code, rt } = await t.run(extra);
        assert.equal(code, EXIT.refused, `${name} ${extra.join(" ")}`);
        assert.match(rt.err(), /this machine's run log (records no|has a newest) railway deploy/);
      }
      assert.equal(t.sequence.length, 0, `${name}: no token minted, nothing uploaded`);
    }
  });

  it("refuses unless every service runs the release's digest now, as Railway says (S0-06), in a dry run too", async () => {
    const ours = refsOf(imagesOf("3"));
    const theirs = refsOf(imagesOf("4"));
    const at = (refs: Map<string, string>, service: string) => refs.get(service) ?? "";
    const cases: Array<[string, (rw: FakeRailway) => void]> = [
      ["a service set to another digest", (rw) => rw.running("api", at(theirs, "api"))],
      [
        "a newest deployment that crashed",
        (rw) => rw.running("worker", at(ours, "worker"), "CRASHED"),
      ],
      [
        "a newest deployment of another digest, the source set back by hand",
        (rw) => {
          rw.running("console", at(theirs, "console"));
          const instance = rw.instances.get("console");
          if (instance) instance.image = at(ours, "console");
        },
      ],
      [
        "a connector on another digest",
        (rw) => rw.running("cloudflared-public", at(theirs, "cloudflared-public")),
      ],
      [
        "a service with no deployment",
        (rw) => {
          const edge = rw.instances.get("edge");
          if (edge) edge.latestDeployment = null;
        },
      ],
    ];
    for (const [name, change] of cases) {
      // The run log's newest railway deploy is a successful one of the release.
      const t = await rendered();
      change(t.rw);
      for (const extra of [[], ["--dry-run"]]) {
        const { code, rt } = await t.run(extra);
        assert.equal(code, EXIT.refused, `${name} ${extra.join(" ")}`);
        assert.match(rt.err(), /the services do not run this release now/);
      }
      assert.equal(t.sequence.length, 0, `${name}: no token minted, nothing uploaded`);
    }
  });

  it("follows what real railway deploys left running: a later deploy of another release refuses the earlier release's pages until the services run it again", async () => {
    const t = await rendered({}, { runs: [], live: false });
    await t.railwayDeploy(RELEASE);
    const first = await t.run(["--dry-run"]);
    assert.equal(first.code, 1, first.rt.err());
    await t.railwayDeploy(OTHER);
    const refused = await t.run();
    assert.equal(refused.code, EXIT.refused);
    assert.match(refused.rt.err(), /has a newest railway deploy of another release/);
    assert.equal(t.statics.calls.length, 0, "no page of the earlier release meets the later API");
    assert.doesNotMatch(runsLog(t), /"staticRollback"/);
    // A rollback takes the pages back first, on the operator's recorded word.
    const back = await t.run(["--static-rollback"]);
    assert.equal(back.code, EXIT.ok, back.rt.err());
    assert.match(runsLog(t), /"event":"run.registered"[^\n]*"staticRollback":true/);
    await t.railwayDeploy(RELEASE);
    const again = await t.run();
    assert.equal(again.code, EXIT.ok, again.rt.err());
    assert.match(again.rt.out(), /every service runs this release now/);
  });

  it("refuses when Railway does not say which image a deployment runs, unless --accept-unchecked-deployments, which the run records", async () => {
    for (const answer of ["refused", "no-image"] as const) {
      const t = await rendered();
      t.rw.deploymentImageAnswer = answer;
      const { code, rt } = await t.run();
      assert.equal(code, EXIT.refused, answer);
      assert.match(rt.err(), /did not say which image the newest deployment of payments, api/);
      assert.equal(t.statics.calls.length, 0, answer);
      const accepted = await t.run(["--accept-unchecked-deployments"]);
      assert.equal(accepted.code, EXIT.ok, accepted.rt.err());
      assert.match(runsLog(t), /"event":"run.registered"[^\n]*"deploymentsUnchecked":true/);
    }
    const t = await rendered();
    t.rw.deploymentImageAnswer = "refused";
    t.rw.running("api", refsOf(imagesOf("4")).get("api") ?? "");
    const { code, rt } = await t.run(["--accept-unchecked-deployments"]);
    assert.equal(code, EXIT.refused, "the flag accepts an unread image only, never another digest");
    assert.match(rt.err(), /api is set to an image other than the release's/);
  });

  it("uploads a static-only rollback with --static-rollback, which the run records", async () => {
    const t = await rendered({}, { runs: [], live: false });
    const { code, rt } = await t.run(["--static-rollback"]);
    assert.equal(code, EXIT.ok, rt.err());
    assert.match(runsLog(t), /"event":"run.registered"[^\n]*"staticRollback":true/);
    const refused = await rendered({}, { runs: [] });
    refused.r.gh.mergeConclusion = "failure";
    assert.equal(
      (await refused.run(["--static-rollback"])).code,
      EXIT.refused,
      "the merge job is checked for a rollback too",
    );
  });

  it("dry run: verifies and checks everything, mints nothing and uploads nothing", async () => {
    const t = await rendered();
    const { code, rt } = await t.run(["--dry-run"]);
    assert.equal(code, 1, rt.err());
    assert.match(rt.out(), /5 rendered _headers and env.json equal a fresh render/);
    assert.equal(t.statics.calls.length, 0);
    assert.equal(
      t.cf.calls.some((c) => c.method !== "GET"),
      false,
    );
    const missing = await t.run(["--dry-run"], join(t.dir, "no-such-dir"));
    assert.equal(missing.code, EXIT.data, "a dry run reads every rendered build");
  });

  it("refuses before the first upload when a later deployment's build is not the release's", async () => {
    const t = await rendered();
    writeFileSync(join(t.out, "admin", "assets", "main-abc.js"), 'console.log("changed")');
    for (const extra of [[], ["--dry-run"]]) {
      const { code, rt } = await t.run(extra);
      assert.equal(code, EXIT.data);
      assert.match(rt.err(), /static admin: the build's asset manifest hash differs/);
    }
    assert.equal(t.statics.calls.length, 0, "no host moved to the new release");
    assert.equal(t.cf.calls.filter((c) => c.method === "POST").length, 0, "no token minted");
  });

  it("refuses a rendered _headers or env.json that differs from a fresh render, before any upload", async () => {
    for (const [file, text] of [
      ["_headers", "/*\n  Access-Control-Allow-Origin: *\n"],
      [
        "env.json",
        `${JSON.stringify({ environment: "staging", release: RELEASE, apiOrigin: "https://attacker.example.net" })}\n`,
      ],
    ] as const) {
      const t = await rendered();
      writeFileSync(join(t.out, "console", file), text);
      const { code } = await t.run();
      assert.equal(code, EXIT.data, file);
      assert.equal(t.statics.calls.length, 0, file);
    }
  });

  it("refuses a manifest whose attestation does not verify, before any Cloudflare call", async () => {
    const t = await rendered();
    writeFileSync(
      t.r.manifestFile,
      readFileSync(t.r.manifestFile, "utf8").replace(`"migrations":[]`, `"migrations":["x.sql"]`),
    );
    const { code, rt } = await t.run();
    assert.equal(code, EXIT.data);
    assert.match(rt.err(), /the release manifest: the attestation does not verify/);
    assert.equal(t.sequence.length, 0);
  });

  it("stops at a failed upload, says which host serves which release, and still revokes the token", async () => {
    const t = await rendered();
    t.failAt("fin-next-staging-admin-static");
    const { code, rt } = await t.run();
    assert.equal(code, EXIT.unavailable);
    assert.match(
      rt.err(),
      /static deploy stopped at admin \(it may serve either release\); new release on: verify, selfie; previous release still on: console, docs/,
    );
    assert.equal(t.cf.tokens.length, 0, "revoked after the failure");
    assert.ok(t.sequence.some((s) => s.startsWith("DELETE")));
  });

  /** The records of the last static deploy run in the run log. */
  const records = (t: { env: Record<string, string> }) => {
    const all = runsLog(t)
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // The fake runtime gives every run the same ID, so the run starts at its registration.
    return all.slice(
      all.findLastIndex((r) => r.event === "run.registered" && r.command === "static deploy"),
    );
  };
  const isMint = (method: string, path: string) => method === "POST" && path.endsWith("/tokens");

  it("revokes the one-run token when a signal stops the run while the token is being minted", async () => {
    const t = await rendered();
    const mint = t.hold(isMint);
    // The settle wait lasts until the change in flight settles.
    const { rt, done } = t.start([], t.out, NEVER);
    await mint.reached;
    const stopping = rt.interrupt("SIGINT");
    await until(() => rt.err().includes("closing the run"));
    mint.open();
    assert.equal(await stopping, true);
    assert.equal(await done, EXIT.interrupted, rt.err());
    assert.equal(t.cf.tokens.length, 0, "the token minted as the run stopped is revoked");
    assert.equal(t.sequence.at(-1)?.startsWith("DELETE"), true);
    assert.equal(t.statics.calls.length, 0, "nothing is uploaded after the stop");
    assert.match(rt.out(), /revoked the one-run token fin-next-staging-static-run/);
    assert.deepEqual(
      records(t).map((r) => [r.event, r.kind, r.action, r.result, r.interrupted]),
      [
        ["run.registered", undefined, undefined, undefined, undefined],
        ["run.step", "token", "create", undefined, undefined],
        ["run.step", "token", "revoke", undefined, undefined],
        ["run.done", undefined, undefined, "failed", "SIGINT"],
      ],
    );
    for (const value of [MINTED, ACCOUNT]) assert.equal(rt.all().includes(value), false);
  });

  it("revokes the one-run token before it closes the run when an upload in flight does not settle in time", async () => {
    const t = await rendered();
    const upload = t.hold(
      (method, path) => method === "PUT" && path.endsWith("/fin-next-staging-verify-static"),
    );
    // The fake runtime's sleep returns at once: the settle wait times out.
    const { rt, done } = t.start();
    await upload.reached;
    assert.equal(await rt.interrupt("SIGTERM"), true);
    assert.equal(t.cf.tokens.length, 0, "revoked while the run could still write");
    const log = records(t);
    assert.deepEqual(
      log.filter((r) => r.event === "run.step").map((r) => [r.kind, r.action]),
      [
        ["token", "create"],
        ["token", "revoke"],
      ],
    );
    const closed = log.at(-1);
    assert.equal(closed?.event, "run.done");
    assert.equal(closed?.interrupted, "SIGTERM");
    assert.deepEqual(closed?.inFlight, {
      kind: "static",
      name: "fin-next-staging-verify-static",
      action: "update",
    });
    upload.open();
    assert.notEqual(await done, EXIT.ok);
    assert.deepEqual(
      [...t.statics.scripts.keys()],
      ["fin-next-staging-verify-static"],
      "no later deployment is uploaded once the run is closed",
    );
    assert.equal(t.sequence.filter((s) => s.startsWith("DELETE")).length, 1, "revoked once");
  });

  it("says to revoke the one-run token by hand when a stop closes the run at once before it could", async () => {
    const t = await rendered();
    const mint = t.hold(isMint);
    const { rt, done } = t.start([], t.out, NEVER);
    await mint.reached;
    const stopping = rt.interrupt("SIGINT");
    await until(() => rt.err().includes("closing the run"));
    assert.equal(rt.forceClose("SIGQUIT"), true);
    assert.match(
      rt.err(),
      /the one-run token fin-next-staging-static-run may not be revoked: revoke it by hand now \(it expires within 60 minutes\)/,
    );
    assert.equal(records(t).at(-1)?.forced, "SIGQUIT");
    mint.open();
    await stopping;
    await done;
  });

  it("renders and uploads with packages/web-host's own renderer: the rendered files equal a fresh render", async () => {
    const t = await rendered({}, { webHost: true });
    const { code, rt } = await t.run();
    assert.equal(code, EXIT.ok, rt.err());
    assert.match(rt.out(), /5 rendered _headers and env.json equal a fresh render/);
    assert.equal(t.statics.scripts.size, KEYS.length);
    assert.equal(t.cf.tokens.length, 0);
  });
});
