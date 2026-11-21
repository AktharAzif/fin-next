import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXIT } from "../src/core/errors.ts";
import { parseOverlay } from "../src/core/overlay.ts";
import { loadSettings } from "../src/core/settings.ts";
import { hex, overlayFixture, REPO_ROOT, uuid } from "./helpers/fixtures.ts";
import { harness } from "./helpers/setup.ts";

const RELEASE = hex(40, "a");
const settings = loadSettings(REPO_ROOT, "staging");
const overlay = parseOverlay(overlayFixture(), "staging");
const DIGEST = (c: string) => `sha256:${hex(64, c)}`;
const IMAGES = {
  "fin-next-api": DIGEST("3"),
  "fin-next-edge": DIGEST("4"),
  "fin-next-payments": DIGEST("5"),
  "fin-next-console": DIGEST("6"),
  "fin-next-admin": DIGEST("7"),
  "fin-next-verify": DIGEST("8"),
  "fin-next-connector": DIGEST("9"),
};

function provisioned(change?: (h: ReturnType<typeof harness>) => void) {
  const h = harness();
  h.rw.provision(settings.railway, uuid("d"), overlay.staticEgress);
  change?.(h);
  return h;
}

function manifest(h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}): string {
  const file = join(h.dir, "release-manifest.json");
  writeFileSync(
    file,
    JSON.stringify({ commit: RELEASE, images: IMAGES, static: {}, migrations: [], ...extra }),
  );
  return file;
}

function attestations(h: ReturnType<typeof harness>, ok = true): string[][] {
  const calls: string[][] = [];
  Object.assign(h.runtime, {
    exec: (program: string, args: readonly string[]) => {
      calls.push([program, ...args]);
      return { status: ok ? 0 : 1, stdout: "", stderr: "" };
    },
  });
  return calls;
}

describe("railway verify", () => {
  it("reports every service without an image until the first deploy, and nothing else", async () => {
    const h = provisioned();
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    const out = h.runtime.out();
    assert.match(out, /! api image: no image set/);
    assert.doesNotMatch(out, /domain|tcp-proxy|replicas|region|sealed/);
    assert.match(out, /\? not checked: memory limits, PITR and the deployment webhook/);
    h.assertNoLeak(["198.51.100.1"]);
  });

  it("finds a domain, a TCP proxy, a readable secret, IPv6, replicas and egress drift", async () => {
    const h = provisioned((x) => {
      const api = x.rw.instances.get("api");
      const edge = x.rw.instances.get("edge");
      const worker = x.rw.instances.get("worker");
      if (api === undefined || edge === undefined || worker === undefined)
        throw new Error("fixture");
      api.domains = ["api-production.up.railway.app"];
      api.tcpProxies = 1;
      api.variables.FIN_DB_PASSWORD = "readable-password-value";
      edge.ipv6EgressEnabled = true;
      edge.numReplicas = 2;
      x.rw.egress.set("worker", []);
      worker.healthcheckPath = null;
    });
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    const out = h.runtime.out();
    for (const line of [
      /! api domain: 1 public domain/,
      /! api tcp-proxy: a TCP proxy exists/,
      /! api sealed: FIN_DB_PASSWORD is readable: it must be sealed/,
      /! edge ipv6-egress/,
      /! edge replicas: 2, not 1/,
      /! worker static-egress: static egress is off/,
      /! worker healthcheck: none, not \/readyz/,
    ]) {
      assert.match(out, line);
    }
    assert.equal(out.includes("readable-password-value"), false);
    assert.equal(out.includes("api-production.up.railway.app"), false);
  });

  it("lists what Railway refused to read as not checked, never as passing", async () => {
    const h = provisioned((x) => {
      x.rw.extendedRefused = true;
      x.rw.variablesRefused = true;
    });
    await h.run(["railway", "verify", "staging"]);
    assert.match(h.runtime.out(), /\? not checked: health checks, overlap/);
    assert.match(h.runtime.out(), /\? not checked: which variables are sealed/);
  });
});

describe("railway deploy", () => {
  it("verifies attestations, rolls in order by digest, waits for each, and records the running digests", async () => {
    const h = provisioned();
    const calls = attestations(h);
    const code = await h.run([
      "railway",
      "deploy",
      "staging",
      "--release",
      RELEASE,
      "--manifest",
      manifest(h),
    ]);
    assert.equal(code, EXIT.ok, h.runtime.err());
    assert.equal(calls.length, new Set(Object.values(IMAGES)).size);
    for (const c of calls) {
      assert.deepEqual(c.slice(0, 3), ["gh", "attestation", "verify"]);
      assert.ok(
        c.includes("--signer-workflow") &&
          c.includes("aktharazif/fin-next/.github/workflows/release.yml"),
      );
      assert.ok(c.includes("refs/heads/main"));
    }
    const order = h.rw.updates.map((u) => u.service);
    assert.deepEqual(order, [
      "payments",
      "api",
      "worker",
      "edge",
      "verify",
      "admin",
      "console",
      "cloudflared-admin",
      "cloudflared-public",
    ]);
    assert.equal(
      h.rw.instances.get("api")?.image,
      `ghcr.io/aktharazif/fin-next-api@${IMAGES["fin-next-api"]}`,
    );
    assert.equal(h.rw.instances.get("worker")?.startCommand, "dist/main.js --worker");
    assert.equal(h.rw.instances.get("api")?.variables.FIN_RELEASE, RELEASE);
    assert.equal(h.rw.instances.get("worker")?.variables.FIN_DRAIN_SECONDS, "60");
    const done = h.records().at(-1);
    assert.equal(done?.event, "run.done");
    assert.equal(done?.result, "ok");
    assert.equal(
      ((done?.running ?? {}) as Record<string, string>).console,
      `ghcr.io/aktharazif/fin-next-console@${IMAGES["fin-next-console"]}`,
    );
    assert.match(h.readable(), /"event":"deploy.done"/);
    assert.equal(
      h.rw.instances.get("cloudflared-public-b")?.image,
      null,
      "standbys are never rolled",
    );
    // A verify after the deploy finds no drift at all.
    assert.equal(
      await h.run(["railway", "verify", "staging"]),
      EXIT.drift,
      "the never-deployed services still have no image",
    );
    assert.doesNotMatch(
      h.runtime.out().split("railway staging:").at(-1) ?? "",
      /! (api|worker|console) /,
    );
  });

  it("rolls connectors only when their image changed", async () => {
    const h = provisioned((x) => {
      const pub = x.rw.instances.get("cloudflared-public");
      if (pub) pub.image = `ghcr.io/aktharazif/fin-next-connector@${IMAGES["fin-next-connector"]}`;
    });
    attestations(h);
    await h.run(["railway", "deploy", "staging", "--release", RELEASE, "--manifest", manifest(h)]);
    assert.equal(
      h.rw.updates.some((u) => u.service === "cloudflared-public"),
      false,
    );
    assert.equal(
      h.rw.updates.some((u) => u.service === "cloudflared-admin"),
      true,
    );
  });

  it("runs migrate first when the release lists migrations, and stops without its migrate.done", async () => {
    const h = provisioned();
    attestations(h);
    const file = manifest(h, { migrations: ["20261121100000_audit_core.sql"] });
    assert.equal(
      await h.run(["railway", "deploy", "staging", "--release", RELEASE, "--manifest", file]),
      EXIT.ok,
      h.runtime.err(),
    );
    assert.equal(h.rw.updates[0]?.service, "migrate");
    assert.equal(h.rw.instances.get("migrate")?.startCommand, "dist/main.js --migrate");
    const h2 = provisioned((x) => {
      x.rw.migrateLogs = () => [JSON.stringify({ event: "migrate.failed" })];
    });
    attestations(h2);
    assert.equal(
      await h2.run([
        "railway",
        "deploy",
        "staging",
        "--release",
        RELEASE,
        "--manifest",
        manifest(h2, { migrations: ["x.sql"] }),
      ]),
      EXIT.unavailable,
    );
    assert.deepEqual(
      h2.rw.updates.map((u) => u.service),
      ["migrate"],
      "nothing rolls after a failed migrate",
    );
    assert.match(h2.readable(), /"event":"deploy.failed"/);
    assert.equal(h2.records().at(-1)?.result, "failed");
  });

  it("refuses while any service has a domain or a TCP proxy, and with egress drift", async () => {
    const h = provisioned((x) => {
      const pg = x.rw.instances.get("postgres");
      if (pg) pg.tcpProxies = 1;
    });
    attestations(h);
    assert.equal(
      await h.run([
        "railway",
        "deploy",
        "staging",
        "--release",
        RELEASE,
        "--manifest",
        manifest(h),
      ]),
      EXIT.refused,
    );
    assert.match(h.runtime.err(), /postgres \(tcp-proxy\)/);
    assert.equal(h.rw.updates.length, 0);
    const h2 = provisioned((x) => {
      x.rw.egress.set("api", []);
    });
    attestations(h2);
    assert.equal(
      await h2.run([
        "railway",
        "deploy",
        "staging",
        "--release",
        RELEASE,
        "--manifest",
        manifest(h2),
      ]),
      EXIT.refused,
    );
  });

  it("refuses an image whose attestation does not verify, before any change", async () => {
    const h = provisioned();
    attestations(h, false);
    assert.equal(
      await h.run([
        "railway",
        "deploy",
        "staging",
        "--release",
        RELEASE,
        "--manifest",
        manifest(h),
      ]),
      EXIT.data,
    );
    assert.equal(h.rw.updates.length, 0);
    assert.equal(h.records().length, 0);
  });

  it("stops at a crashed deployment and prints the mixed state", async () => {
    const h = provisioned((x) => {
      x.rw.deployStatuses = ["DEPLOYING", "CRASHED"];
    });
    attestations(h);
    assert.equal(
      await h.run([
        "railway",
        "deploy",
        "staging",
        "--release",
        RELEASE,
        "--manifest",
        manifest(h),
      ]),
      EXIT.unavailable,
    );
    assert.deepEqual(
      h.rw.updates.map((u) => u.service),
      ["payments"],
    );
    assert.match(h.runtime.err(), /deploy stopped at payments; on the new release: none/);
  });

  it("refuses a manifest for another commit, or with a tag instead of a digest", async () => {
    const h = provisioned();
    attestations(h);
    const other = manifest(h, { commit: hex(40, "b") });
    assert.equal(
      await h.run(["railway", "deploy", "staging", "--release", RELEASE, "--manifest", other]),
      EXIT.data,
    );
    const tagged = manifest(h, { images: { "fin-next-api": "latest" } });
    assert.equal(
      await h.run(["railway", "deploy", "staging", "--release", RELEASE, "--manifest", tagged]),
      EXIT.data,
    );
    assert.equal(
      await h.run(["railway", "deploy", "staging", "--release", "main", "--manifest", tagged]),
      EXIT.usage,
    );
  });

  it("dry run: plans, verifies attestations and changes nothing", async () => {
    const h = provisioned();
    attestations(h);
    assert.equal(
      await h.run([
        "railway",
        "deploy",
        "staging",
        "--release",
        RELEASE,
        "--manifest",
        manifest(h),
        "--dry-run",
      ]),
      1,
    );
    assert.equal(h.rw.updates.length, 0);
    assert.equal(h.rw.patches.length, 0);
    assert.match(h.runtime.out(), /~ update service api fin-next-api@/);
  });
});
