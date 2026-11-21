import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { signerIdentity } from "../../../tools/static-deploy/src/provenance.ts";
import { FakeGh, RELEASE_SAN } from "../../../tools/static-deploy/test/fake.ts";
import { EXIT, ProviderError } from "../src/core/errors.ts";
import { parseOverlay } from "../src/core/overlay.ts";
import { loadSettings } from "../src/core/settings.ts";
import { migrateOutcome } from "../src/railway/deploy.ts";
import { isRefusal, NO_READ_ROWS } from "../src/railway/inspect.ts";
import { hex, overlayFixture, REPO_ROOT, uuid } from "./helpers/fixtures.ts";
import { RENDERED_SECRET } from "./helpers/providers.ts";
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
const ref = (image: keyof typeof IMAGES) => `ghcr.io/aktharazif/${image}@${IMAGES[image]}`;
/** A Railway reference (`${{service.VARIABLE}}`), built so that no source line holds one. */
const reference = (service: string, variable: string, spaced = false) =>
  ["$", "{{", spaced ? " " : "", `${service}.${variable}`, spaced ? " " : "", "}}"].join("");

type H = ReturnType<typeof harness> & { gh: FakeGh };

function provisioned(change?: (h: H) => void): H {
  const h = harness() as H;
  h.gh = new FakeGh();
  Object.assign(h.runtime, { exec: h.gh.exec });
  h.rw.provision(settings.railway, uuid("d"), overlay.staticEgress);
  change?.(h);
  return h;
}

/** Writes a release manifest; release.yml attests it unless `attested` is false. */
function manifest(h: H, extra: Record<string, unknown> = {}, attested = true): string {
  const file = join(h.dir, "release-manifest.json");
  const text = JSON.stringify({
    commit: RELEASE,
    images: IMAGES,
    static: {},
    migrations: [],
    ...extra,
  });
  writeFileSync(file, text);
  if (attested) h.gh.attest(text);
  return file;
}

const deploy = (h: H, file: string, ...more: string[]) =>
  h.run(["railway", "deploy", "staging", "--release", RELEASE, "--manifest", file, ...more]);

describe("railway verify", () => {
  it("reports every service without an image until the first deploy, and nothing else", async () => {
    const h = provisioned();
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    const out = h.runtime.out();
    assert.match(out, /! api image: no image set/);
    assert.doesNotMatch(
      out,
      /! \S+ (domain|tcp-proxy|replicas|region|sealed|unknown|environment|superuser-reference):/,
    );
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

  it("names the domain and TCP proxy of a service the settings do not list, and a prototype-named one", async () => {
    const h = provisioned((x) => {
      x.rw.addService("debug-proxy", { domains: ["debug.up.railway.app"], tcpProxies: 1 });
      x.rw.addService("constructor", { tcpProxies: 1 });
    });
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    const out = h.runtime.out();
    assert.match(out, /! debug-proxy unknown: a service the settings do not list/);
    assert.match(out, /! debug-proxy domain: 1 public domain/);
    assert.match(out, /! debug-proxy tcp-proxy: a TCP proxy exists/);
    assert.match(out, /! constructor unknown/);
    assert.match(out, /! constructor tcp-proxy/);
    assert.equal(out.includes("debug.up.railway.app"), false);
  });

  it("reports an instance in another environment of the project (spec 01 §6.1)", async () => {
    const h = provisioned((x) => {
      x.rw.otherEnvironment.set("api", ["api-pr-1.up.railway.app"]);
    });
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    assert.match(
      h.runtime.out(),
      /! api environment: 1 instance\(s\) in another environment of the project, 1 with a public domain/,
    );
  });

  it("lists what Railway refused to read as not checked, never as passing", async () => {
    const h = provisioned((x) => {
      x.rw.extendedRefused = true;
      x.rw.variablesRefused = true;
      x.rw.egressAnswer = "refused";
    });
    await h.run(["railway", "verify", "staging"]);
    const out = h.runtime.out();
    assert.match(out, /\? not checked: health checks, overlap/);
    assert.match(out, /\? not checked: which variables are sealed on .*api/);
    assert.match(
      out,
      /\? not checked: [^\n]*api[^\n]*a database template reference \(the superuser URL\)/,
      "the not-checked line names the superuser-reference check",
    );
    assert.match(
      out,
      /\? not checked: static egress on .*api.*\(Railway refused the read; SP-08\)/,
    );
  });

  it("finds a database template reference under any variable name, read unrendered, and PORT drift (spec 01 §6.2, §6.3)", async () => {
    const h = provisioned((x) => {
      const api = x.rw.instances.get("api");
      const edge = x.rw.instances.get("edge");
      const worker = x.rw.instances.get("worker");
      const pg = x.rw.instances.get("postgres");
      if (!api || !edge || !worker || !pg) throw new Error("fixture");
      api.variables.DATABASE_URL = reference("postgres", "DATABASE_URL");
      edge.variables.PGPASS = `x-${reference("Postgres", "PGPASSWORD", true)}`;
      worker.variables.PORT = "3000";
      // The template's own variables may refer to each other; that is no reference into a service.
      pg.variables.DATABASE_URL = reference("postgres", "PGPASSWORD");
    });
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    const out = h.runtime.out();
    assert.match(out, /! api superuser-reference: [^\n]*DATABASE_URL/);
    assert.match(out, /! edge superuser-reference: [^\n]*PGPASS/);
    assert.match(out, /! worker port: PORT is not 8080/);
    assert.doesNotMatch(out, /! postgres superuser-reference/);
    assert.doesNotMatch(out, /! (api|edge|console) port/);
    assert.equal(h.readable().includes(RENDERED_SECRET), false);
    assert.equal(h.readable().includes("R".repeat(24)), false, "no rendered value is printed");
    assert.equal(await deploy(h, manifest(h)), EXIT.refused);
    assert.match(h.runtime.err(), /api \(superuser-reference\)/);
    assert.match(h.runtime.err(), /edge \(superuser-reference\)/);
    assert.equal(h.rw.updates.length, 0);
  });

  it("lists every §6.8 row it has no read for, and a field Railway answered with no value", async () => {
    const h = provisioned((x) => {
      const api = x.rw.instances.get("api");
      if (api === undefined) throw new Error("fixture");
      (api as { region: string | null }).region = null;
    });
    await h.run(["railway", "verify", "staging"]);
    const out = h.runtime.out();
    for (const row of NO_READ_ROWS) assert.ok(out.includes(`? not checked: ${row}`), row);
    for (const row of [/database login/, /TUNNEL_TOKEN/, /sealed variable/, /Config as Code/]) {
      assert.ok(
        NO_READ_ROWS.some((r) => row.test(r)),
        `a spec 01 §6.2/§6.3 row with no read: ${row}`,
      );
    }
    assert.match(out, /\? not checked: region of api \(Railway answered no value\)/);
  });

  it("stops, rather than passing, when a read gets no answer (a 503 after the retries)", async () => {
    const h = provisioned((x) => {
      x.rw.egressAnswer = "unavailable";
    });
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.unavailable);
  });

  it("stops, rather than turning a check off, on a GraphQL error that is no refusal", async () => {
    for (const op of ["finVariables:migrate", "finStatusExtended", "finEgress"]) {
      const h = provisioned((x) => {
        x.rw.transient.add(op);
      });
      assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.unavailable, op);
    }
    const answered = (message: string, status = 200) =>
      new ProviderError("railway", `railway finVariables answered ${status}: ${message}`, status);
    assert.equal(isRefusal(answered('Cannot query field "variables" on type "Query".')), true);
    assert.equal(isRefusal(answered("Not Authorized")), true);
    assert.equal(isRefusal(answered('Unknown argument "unrendered"', 400)), true);
    assert.equal(isRefusal(answered("Problem processing request")), false);
    assert.equal(isRefusal(answered("Internal server error")), false);
    assert.equal(isRefusal(answered("Not Authorized", 503)), false);
  });
});

describe("railway deploy", () => {
  it("checks the merge job, verifies the manifest for this commit and every image it names, rolls in order and records every digest", async () => {
    const h = provisioned();
    const code = await deploy(h, manifest(h));
    assert.equal(code, EXIT.ok, h.runtime.err());
    const api = h.gh.calls.filter((c) => c[1] === "api");
    assert.ok(
      api.some((c) => /actions\/workflows\/ci\.yml\/runs\?head_sha=a{40}/.test(c.at(-1) ?? "")),
    );
    const verifies = h.gh.calls.filter((c) => c[1] === "attestation");
    // The manifest plus one per distinct image.
    assert.equal(verifies.length, 1 + new Set(Object.values(IMAGES)).size);
    for (const c of verifies) {
      const flag = (name: string) => c[c.indexOf(name) + 1];
      assert.equal(flag("--cert-identity"), RELEASE_SAN);
      assert.equal(flag("--source-ref"), "refs/heads/main");
      assert.equal(flag("--format"), "json");
      assert.ok(c.includes("--deny-self-hosted-runners"));
      assert.equal(c.includes("--signer-workflow"), false);
      // The manifest is bound to this commit; an image is bound through the manifest that names
      // its digest, since release.yml rebuilds only the images that changed (ARCHITECTURE §11.7).
      if (c[3]?.startsWith("oci://")) assert.equal(c.includes("--source-digest"), false);
      else assert.equal(flag("--source-digest"), RELEASE);
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
    assert.equal(h.rw.instances.get("api")?.image, ref("fin-next-api"));
    assert.equal(h.rw.instances.get("worker")?.startCommand, "dist/main.js --worker");
    assert.equal(h.rw.instances.get("api")?.variables.FIN_RELEASE, RELEASE);
    assert.equal(h.rw.instances.get("worker")?.variables.FIN_DRAIN_SECONDS, "60");
    const done = h.records().at(-1);
    assert.equal(done?.event, "run.done");
    assert.equal(done?.result, "ok");
    const running = (done?.running ?? {}) as Record<string, string>;
    assert.equal(running.console, ref("fin-next-console"));
    assert.equal(running["cloudflared-public"], ref("fin-next-connector"));
    assert.match(h.readable(), /"event":"deploy.done"/);
    assert.equal(
      h.rw.instances.get("cloudflared-public-b")?.image,
      null,
      "standbys are never rolled",
    );
    assert.equal(
      await h.run(["railway", "verify", "staging"]),
      EXIT.drift,
      "the never-deployed services still have no image",
    );
    assert.doesNotMatch(
      h.runtime.out().split("railway staging:").at(-1) ?? "",
      /! (api|worker|console|cloudflared-public) /,
    );
  });

  it("records kept connectors, so verify still checks their digest after a deploy that kept them", async () => {
    const h = provisioned((x) => {
      for (const name of ["cloudflared-public", "cloudflared-admin"]) {
        const c = x.rw.instances.get(name);
        if (c) c.image = ref("fin-next-connector");
      }
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.ok, h.runtime.err());
    assert.equal(
      h.rw.updates.some((u) => u.service.startsWith("cloudflared")),
      false,
      "connectors roll only when their image changed",
    );
    const running = (h.records().at(-1)?.running ?? {}) as Record<string, string>;
    assert.equal(running["cloudflared-public"], ref("fin-next-connector"));
    const pub = h.rw.instances.get("cloudflared-public");
    if (pub === undefined) throw new Error("fixture");
    pub.image = `ghcr.io/aktharazif/fin-next-connector@${DIGEST("c")}`;
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    assert.match(h.runtime.out(), /! cloudflared-public digest: runs a digest other than/);
  });

  it("lists the digest check as not checked when no registered deploy recorded one", async () => {
    const h = provisioned((x) => {
      const api = x.rw.instances.get("api");
      if (api) api.image = ref("fin-next-api");
    });
    await h.run(["railway", "verify", "staging"]);
    assert.match(
      h.runtime.out(),
      /\? not checked: the running digest of api \(no registered deploy/,
    );
  });

  it("runs migrate first with the superuser reference for this run only, and removes it afterwards", async () => {
    const h = provisioned();
    const file = manifest(h, { migrations: ["20261121100000_audit_core.sql"] });
    assert.equal(await deploy(h, file), EXIT.ok, h.runtime.err());
    assert.equal(h.rw.updates[0]?.service, "migrate");
    assert.equal(h.rw.instances.get("migrate")?.startCommand, "dist/main.js --migrate");
    const started = h.rw.migrateEnvironments[0];
    assert.match(started?.FIN_BOOTSTRAP_DATABASE_URL ?? "", /^\$\{\{postgres\.DATABASE_URL\}\}$/);
    assert.match(started?.FIN_RUN_ID ?? "", /^run_/);
    assert.deepEqual(h.rw.variableDeletes, [
      { service: "migrate", name: "FIN_BOOTSTRAP_DATABASE_URL" },
    ]);
    assert.equal(h.rw.instances.get("migrate")?.variables.FIN_BOOTSTRAP_DATABASE_URL, undefined);
  });

  it("waits for a migrate.done that reaches the log after Railway reports SUCCESS", async () => {
    const h = provisioned((x) => {
      x.rw.migrateLogReadsBehind = 3;
      x.rw.migrateLogs = (release) => [
        JSON.stringify({ event: "migrate.started" }),
        "null",
        "42",
        "plain text",
        JSON.stringify({ event: "migrate.done", release }),
      ];
    });
    const file = manifest(h, { migrations: ["20261121100000_audit_core.sql"] });
    assert.equal(await deploy(h, file), EXIT.ok, h.runtime.err());
    assert.equal(h.rw.updates.filter((u) => u.service === "migrate").length, 1);
    assert.ok(h.rw.updates.some((u) => u.service === "console"));
  });

  it("stops without migrate.done, rolls nothing after a failed migrate, and still removes the reference", async () => {
    const h = provisioned((x) => {
      x.rw.migrateLogs = () => [JSON.stringify({ event: "migrate.failed" })];
    });
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.unavailable);
    assert.deepEqual(
      h.rw.updates.map((u) => u.service),
      ["migrate"],
      "nothing rolls after a failed migrate",
    );
    assert.equal(h.rw.variableDeletes.length, 1);
    assert.match(h.readable(), /"event":"deploy.failed"/);
    assert.equal(h.records().at(-1)?.result, "failed");
    const h2 = provisioned((x) => {
      x.rw.migrateLogs = () => [JSON.stringify({ event: "migrate.done", release: hex(40, "b") })];
      x.rw.deployStatuses = ["DEPLOYING", "SUCCESS", "CRASHED"];
    });
    assert.equal(await deploy(h2, manifest(h2, { migrations: ["x.sql"] })), EXIT.unavailable);
    assert.match(h2.runtime.err(), /ended CRASHED with no migrate.done for this release/);
  });

  it("reads migrate's log lines as JSON objects only", () => {
    assert.equal(migrateOutcome([{ message: "null" }, { message: "[1]" }], RELEASE), undefined);
    assert.equal(
      migrateOutcome(
        [{ message: JSON.stringify({ event: "migrate.done", release: RELEASE }) }],
        RELEASE,
      ),
      "done",
    );
    assert.equal(migrateOutcome([{ message: '{"event":"migrate.failed"}' }], RELEASE), "failed");
  });

  it("refuses a release that lists migrations but has no image for migrate, before any change", async () => {
    const h = provisioned();
    const { "fin-next-api": _api, ...rest } = IMAGES;
    const file = manifest(h, { migrations: ["20261121100000_audit_core.sql"], images: rest });
    assert.equal(await deploy(h, file), EXIT.data);
    assert.match(h.runtime.err(), /lists migrations but its manifest names no fin-next-api/);
    assert.equal(h.rw.updates.length, 0);
  });

  it("refuses a partial release, and keeps only a service that has never run an image", async () => {
    const h = provisioned((x) => {
      const payments = x.rw.instances.get("payments");
      if (payments) payments.image = `ghcr.io/aktharazif/fin-next-payments@${DIGEST("1")}`;
    });
    const { "fin-next-payments": _p, ...rest } = IMAGES;
    assert.equal(await deploy(h, manifest(h, { images: rest })), EXIT.data);
    assert.match(
      h.runtime.err(),
      /names no fin-next-payments, and payments runs an earlier release/,
    );
    assert.equal(h.rw.updates.length, 0);
    const h2 = provisioned();
    assert.equal(await deploy(h2, manifest(h2, { images: rest })), EXIT.ok, h2.runtime.err());
    assert.equal(
      h2.rw.updates.some((u) => u.service === "payments"),
      false,
    );
    assert.deepEqual(h2.records().at(-1)?.notBuilt, ["payments"]);
  });

  it("refuses while any service, listed or not, is exposed, and with egress drift", async () => {
    const h = provisioned((x) => {
      const pg = x.rw.instances.get("postgres");
      if (pg) pg.tcpProxies = 1;
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.refused);
    assert.match(h.runtime.err(), /postgres \(tcp-proxy\)/);
    assert.equal(h.rw.updates.length, 0);
    const h2 = provisioned((x) => {
      x.rw.egress.set("api", []);
    });
    assert.equal(await deploy(h2, manifest(h2)), EXIT.refused);
    const h3 = provisioned((x) => {
      x.rw.addService("debug-proxy", { domains: ["debug.up.railway.app"], tcpProxies: 1 });
    });
    assert.equal(await deploy(h3, manifest(h3)), EXIT.refused);
    assert.match(
      h3.runtime.err(),
      /debug-proxy \(unknown\), debug-proxy \(domain\), debug-proxy \(tcp-proxy\)/,
    );
    assert.equal(h3.rw.updates.length, 0);
    const h4 = provisioned((x) => {
      x.rw.addService("constructor", {});
    });
    assert.equal(await deploy(h4, manifest(h4)), EXIT.refused);
    assert.match(h4.runtime.err(), /constructor \(unknown\)/);
    assert.equal(h4.rw.updates.length, 0);
    const h5 = provisioned((x) => {
      x.rw.otherEnvironment.set("edge", []);
    });
    assert.equal(await deploy(h5, manifest(h5)), EXIT.refused);
    assert.match(h5.runtime.err(), /edge \(environment\)/);
    const h6 = provisioned((x) => {
      const m = x.rw.instances.get("migrate");
      if (m) m.variables.FIN_BOOTSTRAP_DATABASE_URL = "left over";
    });
    assert.equal(await deploy(h6, manifest(h6)), EXIT.refused);
    assert.match(h6.runtime.err(), /migrate \(superuser-reference\)/);
  });

  it("refuses when Railway refuses the static egress read, unless the operator accepts it, and stops on no answer", async () => {
    const h = provisioned((x) => {
      x.rw.egressAnswer = "refused";
      x.rw.egress.set("api", []);
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.refused);
    assert.match(h.runtime.err(), /refused the static egress read/);
    assert.match(h.runtime.out(), /\? not checked: static egress on/);
    assert.equal(h.rw.updates.length, 0);
    assert.equal(
      await deploy(h, manifest(h), "--accept-unchecked-egress"),
      EXIT.ok,
      h.runtime.err(),
    );
    const registered = h.records().find((r) => r.event === "run.registered");
    assert.equal(registered?.egressUnchecked, true);
    const h2 = provisioned((x) => {
      x.rw.egressAnswer = "unavailable";
    });
    assert.equal(await deploy(h2, manifest(h2)), EXIT.unavailable);
    assert.equal(h2.rw.updates.length, 0);
  });

  it("refuses an image or a manifest whose attestation does not verify, before any change", async () => {
    const h = provisioned((x) => {
      x.gh.unattestedImages.add(`oci://${ref("fin-next-edge")}`);
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.data);
    assert.equal(h.rw.updates.length, 0);
    assert.equal(h.records().length, 0);
    const h2 = provisioned();
    assert.equal(await deploy(h2, manifest(h2, {}, false)), EXIT.data);
    assert.match(h2.runtime.err(), /the release manifest: the attestation does not verify/);
    const h3 = provisioned((x) => {
      x.gh.builtFrom = hex(40, "b");
    });
    assert.equal(await deploy(h3, manifest(h3)), EXIT.data, "a manifest built from another commit");
    assert.match(h3.runtime.err(), /the release manifest: the attestation does not verify/);
    assert.equal(h3.rw.updates.length, 0);
    const h4 = provisioned((x) => {
      x.gh.trigger = "workflow_dispatch";
    });
    assert.equal(await deploy(h4, manifest(h4)), EXIT.data);
    assert.match(h4.runtime.err(), /no verified attestation is from a push/);
    assert.equal(h4.rw.updates.length, 0);
    const h5 = provisioned((x) => {
      x.gh.triggerSubject.set(`oci://${ref("fin-next-payments")}`, "workflow_dispatch");
    });
    assert.equal(await deploy(h5, manifest(h5)), EXIT.data, "one image from a manual run");
    assert.match(
      h5.runtime.err(),
      /the image fin-next-payments: no verified attestation is from a push/,
    );
    assert.equal(h5.rw.updates.length, 0);
  });

  it("deploys a release that rebuilt only some images: the others are trusted through this commit's attested manifest (ARCHITECTURE §11.7)", async () => {
    const previous = hex(40, "e");
    const h = provisioned((x) => {
      for (const image of Object.keys(IMAGES) as Array<keyof typeof IMAGES>) {
        if (image !== "fin-next-console")
          x.gh.builtFromSubject.set(`oci://${ref(image)}`, previous);
      }
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.ok, h.runtime.err());
    assert.equal(h.rw.instances.get("payments")?.image, ref("fin-next-payments"));
    assert.equal(h.rw.instances.get("console")?.image, ref("fin-next-console"));
    assert.equal(h.records().at(-1)?.result, "ok");
  });

  it("refuses to roll a service whose Railway health check is not /readyz with 60 s, the gate SUCCESS stands on", async () => {
    const h = provisioned((x) => {
      const api = x.rw.instances.get("api");
      if (api) api.healthcheckPath = null;
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.refused);
    assert.match(h.runtime.err(), /api \(healthcheck\)/);
    assert.equal(h.rw.updates.length, 0);
    const h2 = provisioned((x) => {
      const worker = x.rw.instances.get("worker");
      if (worker) worker.healthcheckTimeout = 30;
    });
    assert.equal(await deploy(h2, manifest(h2)), EXIT.refused);
    assert.match(h2.runtime.err(), /worker \(healthcheck-timeout\)/);
    assert.equal(h2.rw.updates.length, 0);
    const h3 = provisioned((x) => {
      const standby = x.rw.instances.get("cloudflared-public-b");
      if (standby) standby.healthcheckPath = null;
    });
    assert.equal(await deploy(h3, manifest(h3)), EXIT.ok, "a service the deploy does not roll");
  });

  it("refuses when Railway refuses the instance settings read, unless the operator accepts it, which the run records", async () => {
    const h = provisioned((x) => {
      x.rw.extendedRefused = true;
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.refused);
    assert.match(h.runtime.err(), /refused the instance settings read/);
    assert.equal(h.rw.updates.length, 0);
    assert.equal(
      await deploy(h, manifest(h), "--accept-unchecked-settings"),
      EXIT.ok,
      h.runtime.err(),
    );
    const registered = h.records().find((r) => r.event === "run.registered");
    assert.equal(registered?.settingsUnchecked, true);
  });

  it("stops after the roll when a rolled service's health check is no longer /readyz", async () => {
    const h = provisioned((x) => {
      x.rw.onUpdate = (service, instance) => {
        if (service === "console") instance.healthcheckPath = null;
      };
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.refused);
    assert.match(h.runtime.err(), /after the deploy: console \(healthcheck\)/);
    assert.match(h.readable(), /"event":"deploy.failed"[^\n]*"step":"checks"/);
    assert.equal(h.records().at(-1)?.result, "failed");
  });

  it("parses the manifest's minimum schema version and records it with the run and each step", async () => {
    const h = provisioned();
    const migration = "20261121100000_audit_core.sql";
    const file = manifest(h, { migrations: [migration], minimumSchemaVersion: migration });
    assert.equal(await deploy(h, file), EXIT.ok, h.runtime.err());
    const steps = h.readable().match(/"event":"deploy.step"[^\n]*/g) ?? [];
    assert.ok(steps.length > 0);
    for (const step of steps) assert.ok(step.includes(`"minimumSchemaVersion":"${migration}"`));
    assert.equal(
      h.records().find((r) => r.event === "run.registered")?.minimumSchemaVersion,
      migration,
    );
    const h2 = provisioned();
    assert.equal(await deploy(h2, manifest(h2, { minimumSchemaVersion: 7 })), EXIT.data);
    assert.match(h2.runtime.err(), /minimumSchemaVersion/);
  });

  it("refuses when Railway refuses a variables read, so a superuser reference never passes unread, unless accepted (recorded)", async () => {
    const h = provisioned((x) => {
      x.rw.variablesRefused = true;
      const api = x.rw.instances.get("api");
      if (api) api.variables.FIN_BOOTSTRAP_DATABASE_URL = reference("postgres", "DATABASE_URL");
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.refused);
    assert.match(h.runtime.err(), /refused the variables read/);
    assert.match(h.runtime.out(), /\? not checked: [^\n]*a database template reference/);
    assert.equal(h.rw.updates.length, 0);
    assert.equal(
      await deploy(h, manifest(h), "--accept-unchecked-variables"),
      EXIT.ok,
      h.runtime.err(),
    );
    assert.equal(h.records().find((r) => r.event === "run.registered")?.variablesUnchecked, true);
    const h2 = provisioned((x) => {
      x.rw.transient.add("finVariables:migrate");
    });
    assert.equal(await deploy(h2, manifest(h2)), EXIT.unavailable, "no refusal: stop");
    assert.equal(h2.rw.updates.length, 0);
  });

  it("confirms the superuser reference is gone from migrate, and stops before rolling when it is not", async () => {
    const h = provisioned((x) => {
      x.rw.variableDeleteNoop = true;
    });
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.refused);
    assert.match(h.runtime.err(), /FIN_BOOTSTRAP_DATABASE_URL is still on migrate/);
    assert.deepEqual(
      h.rw.updates.map((u) => u.service),
      ["migrate"],
      "nothing rolls while the reference stands",
    );
    assert.equal(h.records().at(-1)?.result, "failed");
  });

  it("refuses unless ci.yml's merge job succeeded for the commit, before reading Railway", async () => {
    for (const conclusion of ["failure", "cancelled", undefined]) {
      const h = provisioned((x) => {
        x.gh.mergeConclusion = conclusion;
      });
      assert.equal(await deploy(h, manifest(h)), EXIT.refused, String(conclusion));
      assert.match(h.runtime.err(), /ci\.yml's merge job/);
      assert.equal(h.rw.operations.length, 0);
    }
  });

  it("pins release.yml's identity with the owner as GitHub writes it", () => {
    assert.equal(settings.release.repository, "AktharAzif/fin-next");
    assert.equal(signerIdentity(settings.release), RELEASE_SAN);
  });

  it("stops at a crashed deployment and prints the mixed state", async () => {
    const h = provisioned((x) => {
      x.rw.deployStatuses = ["DEPLOYING", "CRASHED"];
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.unavailable);
    assert.deepEqual(
      h.rw.updates.map((u) => u.service),
      ["payments"],
    );
    assert.match(h.runtime.err(), /deploy stopped at payments; on the new release: none/);
  });

  it("refuses a manifest for another commit, or with a tag instead of a digest", async () => {
    const h = provisioned();
    assert.equal(await deploy(h, manifest(h, { commit: hex(40, "b") })), EXIT.data);
    const tagged = manifest(h, { images: { "fin-next-api": "latest" } });
    assert.equal(await deploy(h, tagged), EXIT.data);
    assert.equal(
      await h.run(["railway", "deploy", "staging", "--release", "main", "--manifest", tagged]),
      EXIT.usage,
    );
  });

  it("dry run: checks the merge job, verifies attestations and changes nothing", async () => {
    const h = provisioned();
    assert.equal(await deploy(h, manifest(h), "--dry-run"), 1);
    assert.equal(h.rw.updates.length, 0);
    assert.equal(h.rw.patches.length, 0);
    assert.ok(h.gh.calls.some((c) => c[1] === "api"));
    assert.match(h.runtime.out(), /~ update service api fin-next-api@/);
  });
});
