import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { signerIdentity } from "../../../tools/static-deploy/src/provenance.ts";
import { FakeGh, RELEASE_SAN } from "../../../tools/static-deploy/test/fake.ts";
import { EXIT, ProviderError, RefusedError } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import { Output } from "../src/core/output.ts";
import { parseOverlay } from "../src/core/overlay.ts";
import { Run } from "../src/core/run.ts";
import { RunLog } from "../src/core/runlog.ts";
import { Secret } from "../src/core/secret.ts";
import { loadSettings } from "../src/core/settings.ts";
import { RailwayApi } from "../src/railway/api.ts";
import { migrateOutcome } from "../src/railway/deploy.ts";
import {
  INERT_VALUE,
  isRefusal,
  NO_READ_ROWS,
  READ_BACK_PAUSE_MS,
  READ_BACK_READS,
  readVariables,
  WRITE_MARKER,
} from "../src/railway/inspect.ts";
import {
  fakeRuntime,
  fakeToken,
  hex,
  overlayFixture,
  REPO_ROOT,
  tempDir,
  uuid,
} from "./helpers/fixtures.ts";
import { FakeRailway, RENDERED_SECRET } from "./helpers/providers.ts";
import { harness } from "./helpers/setup.ts";

const RELEASE = hex(40, "a");
const settings = loadSettings(REPO_ROOT, "staging");
const overlay = parseOverlay(overlayFixture(), "staging");
/** The api image's whole command line before the mode: a start command replaces ENTRYPOINT and CMD. */
const LINE =
  "/nodejs/bin/node --max-old-space-size-percentage=70 --disable-proto=throw --enable-source-maps dist/main.js";
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

/** Waits until the condition holds, letting other work run between checks. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), "the condition never held");
}

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * A release with migrations whose migrate never writes migrate.done, so the deploy waits on it;
 * with `holdLog`, the first read of migrate's log is held in flight until `log.open()`.
 */
function migrateWaits(holdLog = false) {
  const h = provisioned((x) => {
    x.rw.migrateLogs = () => [JSON.stringify({ event: "migrate.started" })];
    x.rw.deployStatuses = ["DEPLOYING"];
  });
  const log = gate();
  const reached = gate();
  if (holdLog) {
    const fetch = h.rw.fetch;
    let held = false;
    Object.assign(h.rw, {
      fetch: async (url: string, init: RequestInit) => {
        if (!held && String(init.body).includes("finLogs")) {
          held = true;
          reached.open();
          await log.wait;
        }
        return fetch(url, init);
      },
    });
  }
  return { h, file: manifest(h, { migrations: ["x.sql"] }), log, reached: reached.wait };
}

/** The commits that overwrote migrate's superuser reference with the inert value (rule 3). */
const inertWrites = (h: H) =>
  h.rw.patches.filter(
    (p) =>
      h.rw.nameOf(p.serviceId) === "migrate" &&
      p.variables.FIN_BOOTSTRAP_DATABASE_URL?.value === INERT_VALUE,
  );

/** Whether migrate's superuser reference holds the inert value now. */
const inert = (h: H) =>
  h.rw.instances.get("migrate")?.variables.FIN_BOOTSTRAP_DATABASE_URL === INERT_VALUE;

/** What a stop that could not make the superuser reference inert says to do (the leftover). */
const REMOVE_BY_HAND =
  /^FIN_BOOTSTRAP_DATABASE_URL may still hold the superuser reference on migrate: set it to inert by hand now \(spec 01 §6\.3, §6\.6\)$/;

/**
 * The run log's run.done and the run.leftover line kept (and shipped) with it, once each has said
 * that the superuser reference may still be on migrate and that it is removed by hand. The output
 * is closed in these tests, so the record is all there is.
 */
function leftoverRecorded(h: H): {
  done: Record<string, unknown>;
  line: Record<string, unknown>;
} {
  const done = h.records().at(-1) ?? {};
  assert.equal(done.event, "run.done");
  assert.match(String(done.leftover), REMOVE_BY_HAND);
  const lines = h.lines();
  const at = lines.findIndex((l) => l.event === "run.leftover");
  const line = lines[at] ?? {};
  assert.equal(line.level, "error");
  assert.equal(line.command, "railway deploy");
  assert.match(String(line.leftover), REMOVE_BY_HAND);
  assert.equal(lines[at + 1]?.event, "run.done", "written just before run.done's own line");
  assert.doesNotMatch(h.runtime.err(), /by hand/, "nothing printed reached anyone");
  return { done, line };
}

/** Whether the superuser reference still stands on migrate (anything but the inert value). */
const standing = (h: H) => {
  const migrate = h.rw.instances.get("migrate");
  const value = migrate?.variables.FIN_BOOTSTRAP_DATABASE_URL;
  return (
    migrate?.sealed.has("FIN_BOOTSTRAP_DATABASE_URL") === true ||
    (value !== undefined && value !== INERT_VALUE)
  );
};

/** Lets the work in progress run for a while (no real I/O happens in these tests). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Holds the write that sets migrate's superuser reference until `write.open()`: in flight, or, with
 * `limited`, answered 429 with Retry-After 4 and re-sent when that wait ends (the runtime's other
 * waits end at once).
 */
function referenceWriteHeld(h: H, limited = false) {
  const write = gate();
  const reached = gate();
  const fetch = h.rw.fetch;
  let held = false;
  Object.assign(h.rw, {
    fetch: async (url: string, init: RequestInit) => {
      const body = String(init.body);
      if (!held && body.includes("finPatch") && body.includes("FIN_BOOTSTRAP_DATABASE_URL")) {
        held = true;
        reached.open();
        if (limited) return new Response("{}", { status: 429, headers: { "retry-after": "4" } });
        await write.wait;
      }
      return fetch(url, init);
    },
  });
  if (limited) {
    Object.assign(h.runtime, {
      sleep: (ms: number) => (ms === 4_000 ? write.wait : Promise.resolve()),
    });
  }
  return { write, reached: reached.wait };
}

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

  it("takes a variable Railway answers with a null value as sealed and present: no readable-secret drift, and a sealed superuser reference still found", async () => {
    const h = provisioned((x) => {
      for (const [service, name] of [
        ["api", "FIN_DB_PASSWORD"],
        ["edge", "FIN_INGRESS_PROOFS"],
        ["cloudflared-public", "TUNNEL_TOKEN"],
        ["worker", "FIN_BOOTSTRAP_DATABASE_URL"],
      ] as const) {
        x.rw.instances.get(service)?.sealed.add(name);
      }
    });
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    const out = h.runtime.out();
    assert.doesNotMatch(out, /! \S+ sealed:/, "a sealed variable is not a readable one");
    assert.doesNotMatch(out, /! \S+ port:/);
    assert.match(out, /! worker superuser-reference: FIN_BOOTSTRAP_DATABASE_URL/);
    assert.equal(await deploy(h, manifest(h)), EXIT.refused);
    assert.match(h.runtime.err(), /worker \(superuser-reference\)/);
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
    assert.equal(
      isRefusal(
        answered(
          'Field "meta" of type "DeploymentMeta" must have a selection of subfields. Did you mean "meta { ... }"?',
          400,
        ),
      ),
      true,
      "a field of another shape than the query assumed is the schema refusing it (SP-03)",
    );
    assert.equal(isRefusal(answered("Problem processing request")), false);
    assert.equal(isRefusal(answered("Internal server error")), false);
    assert.equal(isRefusal(answered("Not Authorized", 503)), false);
  });

  it("checks what each service's newest deployment runs, not only the image it is set to", async () => {
    const h = provisioned();
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.ok, h.runtime.err());
    // A rollback in Railway's dashboard: an older deployment serves, the source still says the release.
    const api = h.rw.instances.get("api");
    if (api === undefined) throw new Error("fixture");
    h.rw.running("api", `ghcr.io/aktharazif/fin-next-api@${DIGEST("c")}`);
    api.image = ref("fin-next-api");
    // A deploy that crashed: the previous deployment still serves.
    h.rw.running("edge", ref("fin-next-edge"), "CRASHED");
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    const out = h.runtime.out().split("railway staging:").at(-1) ?? "";
    assert.match(out, /! api digest: the newest deployment runs a digest other than/);
    assert.match(out, /! edge deployment: the newest deployment is CRASHED, not SUCCESS/);
    assert.doesNotMatch(out, /! migrate /, "a task runs to its end and serves nothing");
    assert.doesNotMatch(out, /! (worker|console|cloudflared-public) /);
    h.rw.deploymentImageAnswer = "refused";
    await h.run(["railway", "verify", "staging"]);
    assert.match(
      h.runtime.out().split("railway staging:").at(-1) ?? "",
      /\? not checked: the image the newest deployment of [^\n]*console[^\n]* runs/,
    );
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
    assert.equal(h.rw.instances.get("worker")?.startCommand, `${LINE} --worker`);
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
      for (const name of ["cloudflared-public", "cloudflared-admin"])
        x.rw.running(name, ref("fin-next-connector"));
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
    assert.match(h.runtime.out(), /! cloudflared-public digest: is set to a digest other than/);
  });

  it("keeps a connector only when its newest deployment ended SUCCESS on the release's image", async () => {
    const other = `ghcr.io/aktharazif/fin-next-connector@${DIGEST("c")}`;
    const cases: Array<[string, (x: H) => void]> = [
      ["crashed", (x) => x.rw.running("cloudflared-public", ref("fin-next-connector"), "CRASHED")],
      [
        "an older deployment serving, the source set to the release's image",
        (x) => {
          x.rw.running("cloudflared-public", other);
          const c = x.rw.instances.get("cloudflared-public");
          if (c) c.image = ref("fin-next-connector");
        },
      ],
      [
        "set to the release's image with no deployment",
        (x) => {
          const c = x.rw.instances.get("cloudflared-public");
          if (c) c.image = ref("fin-next-connector");
        },
      ],
      [
        "a deployment image Railway does not say",
        (x) => {
          x.rw.running("cloudflared-public", ref("fin-next-connector"));
          x.rw.deploymentImageAnswer = "refused";
        },
      ],
    ];
    for (const [name, change] of cases) {
      const h = provisioned((x) => {
        x.rw.running("cloudflared-admin", ref("fin-next-connector"));
        change(x);
      });
      assert.equal(await deploy(h, manifest(h)), EXIT.ok, `${name}: ${h.runtime.err()}`);
      const rolled = h.rw.updates.map((u) => u.service);
      assert.ok(rolled.includes("cloudflared-public"), `${name}: rolled`);
      if (name !== "a deployment image Railway does not say")
        assert.equal(rolled.includes("cloudflared-admin"), false, `${name}: the other is kept`);
    }
  });

  it("stops after the roll when a kept connector's newest deployment is no longer SUCCESS", async () => {
    const h = provisioned((x) => {
      for (const name of ["cloudflared-public", "cloudflared-admin"])
        x.rw.running(name, ref("fin-next-connector"));
      x.rw.onUpdate = (service) => {
        const c = x.rw.instances.get("cloudflared-admin");
        if (service === "console" && c?.latestDeployment)
          c.latestDeployment = { ...c.latestDeployment, status: "CRASHED" };
      };
    });
    assert.equal(await deploy(h, manifest(h)), EXIT.unavailable);
    assert.match(h.runtime.err(), /cloudflared-admin's newest deployment is CRASHED, not SUCCESS/);
    assert.equal(h.records().at(-1)?.result, "failed");
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

  it("runs migrate first with the superuser reference for this run only, and makes it inert afterwards", async () => {
    const h = provisioned();
    const file = manifest(h, { migrations: ["20261121100000_audit_core.sql"] });
    assert.equal(await deploy(h, file), EXIT.ok, h.runtime.err());
    assert.equal(h.rw.updates[0]?.service, "migrate");
    assert.equal(h.rw.instances.get("migrate")?.startCommand, `${LINE} --migrate`);
    const started = h.rw.migrateEnvironments[0];
    assert.match(started?.FIN_BOOTSTRAP_DATABASE_URL ?? "", /^\$\{\{postgres\.DATABASE_URL\}\}$/);
    assert.match(started?.FIN_RUN_ID ?? "", /^run_/);
    assert.deepEqual(h.rw.variableDeletes, [], "no variable is deleted");
    assert.equal(inertWrites(h).length, 1);
    assert.equal(inert(h), true);
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

  it("stops without migrate.done, rolls nothing after a failed migrate, and still makes the reference inert", async () => {
    const h = provisioned((x) => {
      x.rw.migrateLogs = () => [JSON.stringify({ event: "migrate.failed" })];
    });
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.unavailable);
    assert.deepEqual(
      h.rw.updates.map((u) => u.service),
      ["migrate"],
      "nothing rolls after a failed migrate",
    );
    assert.equal(inertWrites(h).length, 1);
    assert.equal(inert(h), true);
    assert.match(h.readable(), /"event":"deploy.failed"/);
    assert.equal(h.records().at(-1)?.result, "failed");
    const h2 = provisioned((x) => {
      x.rw.migrateLogs = () => [JSON.stringify({ event: "migrate.done", release: hex(40, "b") })];
      x.rw.deployStatuses = ["DEPLOYING", "SUCCESS", "CRASHED"];
    });
    assert.equal(await deploy(h2, manifest(h2, { migrations: ["x.sql"] })), EXIT.unavailable);
    assert.match(h2.runtime.err(), /ended CRASHED with no migrate.done for this release/);
  });

  it("makes the superuser reference inert when a signal stops the run during the migrate wait, which the stop cuts short", async () => {
    const { h, file } = migrateWaits();
    // Neither a poll's pause nor the stop's settle wait ends on its own: only the stop ends the
    // pause, and the run closes once the change in flight settles.
    Object.assign(h.runtime, { sleep: () => new Promise<void>(() => {}) });
    const pending = deploy(h, file);
    await until(() => h.rw.operations.includes("finLogs"));
    assert.equal(await h.runtime.interrupt("SIGTERM"), true);
    assert.equal(await pending, EXIT.terminated, h.runtime.err());
    assert.equal(inertWrites(h).length, 1);
    assert.equal(inert(h), true);
    assert.deepEqual(h.rw.writeDeployments, [], "the overwrite starts no migrate deployment");
    assert.deepEqual(
      h.rw.updates.map((u) => u.service),
      ["migrate"],
      "nothing rolls after the stop",
    );
    assert.match(h.runtime.err(), /deploy stopped at migrate; on the new release: none/);
    const done = h.records().at(-1);
    assert.equal(done?.event, "run.done");
    assert.equal(done?.result, "failed");
    assert.equal(done?.interrupted, "SIGTERM");
    assert.equal(done?.inFlight, undefined, "migrate's change settled within the settle time");
    h.assertNoLeak();
  });

  it("makes the superuser reference inert before it closes the run when the migrate wait does not settle in time", async () => {
    const { h, file, log, reached } = migrateWaits(true);
    const pending = deploy(h, file);
    await reached;
    // The fake runtime's sleep returns at once: the settle wait times out with the log read held.
    assert.equal(await h.runtime.interrupt("SIGTERM"), true);
    assert.equal(inertWrites(h).length, 1, "made inert while the run could still write");
    assert.equal(inert(h), true);
    const done = h.records().at(-1);
    assert.equal(done?.event, "run.done");
    assert.equal(done?.interrupted, "SIGTERM");
    assert.deepEqual(done?.inFlight, { kind: "task", name: "migrate", action: "update" });
    assert.deepEqual(done?.awaitingRemoval, ["migrate FIN_BOOTSTRAP_DATABASE_URL"]);
    log.open();
    assert.equal(await pending, EXIT.terminated, h.runtime.err());
    assert.equal(inertWrites(h).length, 1, "made inert once");
    assert.deepEqual(
      h.rw.updates.map((u) => u.service),
      ["migrate"],
    );
  });

  it("says to make the superuser reference inert by hand when a stop closes the run at once before it could", async () => {
    const { h, file, log, reached } = migrateWaits(true);
    Object.assign(h.runtime, { sleep: () => new Promise<void>(() => {}) });
    const pending = deploy(h, file);
    await reached;
    const stopping = h.runtime.interrupt("SIGINT");
    await until(() => h.runtime.err().includes("closing the run"));
    assert.equal(h.runtime.forceClose("SIGQUIT"), true);
    assert.match(
      h.runtime.err(),
      /FIN_BOOTSTRAP_DATABASE_URL may still hold the superuser reference on migrate: set it to inert by hand now \(spec 01 §6\.3, §6\.6\)/,
    );
    assert.equal(h.records().at(-1)?.forced, "SIGQUIT");
    log.open();
    await stopping;
    await pending;
  });

  it("makes the superuser reference inert only once the write setting it lands, when a stop comes while that write is in flight, and starts no migrate", async () => {
    const h = provisioned();
    const file = manifest(h, { migrations: ["x.sql"] });
    const { write, reached } = referenceWriteHeld(h);
    const pending = deploy(h, file);
    await reached;
    // The fake runtime's sleep returns at once: the settle wait times out with the write held.
    const stopping = h.runtime.interrupt("SIGTERM");
    await until(() => h.runtime.err().includes("closing the run"));
    await settle();
    assert.equal(inertWrites(h).length, 0, "no overwrite while the write is in flight");
    assert.notEqual(h.records().at(-1)?.event, "run.done", "the run stays open meanwhile");
    write.open();
    assert.equal(await stopping, true);
    assert.equal(await pending, EXIT.terminated, h.runtime.err());
    assert.equal(inertWrites(h).length, 1);
    assert.equal(inert(h), true);
    assert.equal(h.rw.operations.includes("finDeploy"), false, "migrate never starts after a stop");
    assert.doesNotMatch(h.runtime.err(), /by hand/);
    const done = h.records().at(-1);
    assert.equal(done?.event, "run.done");
    assert.equal(done?.interrupted, "SIGTERM");
  });

  it("makes the superuser reference inert after a 429 on the write setting it is waited out, when a stop comes during that wait", async () => {
    const h = provisioned();
    const file = manifest(h, { migrations: ["x.sql"] });
    const { write, reached } = referenceWriteHeld(h, true);
    const pending = deploy(h, file);
    await reached;
    const stopping = h.runtime.interrupt("SIGTERM");
    await until(() => h.runtime.err().includes("closing the run"));
    await settle();
    assert.equal(inertWrites(h).length, 0, "no overwrite while the write waits to be re-sent");
    write.open();
    await stopping;
    assert.equal(await pending, EXIT.terminated, h.runtime.err());
    const patches = h.sequence.flatMap((call, i) => (call === "rw finPatch" ? [i] : []));
    assert.equal(patches.length, 3, "the write is re-sent after the 429, then made inert");
    assert.deepEqual(
      h.rw.patches.map((p) => p.variables.FIN_BOOTSTRAP_DATABASE_URL?.value),
      [reference("postgres", "DATABASE_URL"), INERT_VALUE],
      "the overwrite follows the re-sent write",
    );
    assert.equal(inert(h), true);
    assert.equal(h.rw.operations.includes("finDeploy"), false);
  });

  it("says to make the superuser reference inert by hand when the run is closed at once while the write setting it is in flight", async () => {
    const h = provisioned();
    const file = manifest(h, { migrations: ["x.sql"] });
    const { write, reached } = referenceWriteHeld(h);
    const pending = deploy(h, file);
    await reached;
    const stopping = h.runtime.interrupt("SIGTERM");
    await until(() => h.runtime.err().includes("closing the run"));
    await settle();
    assert.equal(h.runtime.forceClose("deadline"), true);
    assert.match(
      h.runtime.err(),
      /FIN_BOOTSTRAP_DATABASE_URL may still hold the superuser reference on migrate: set it to inert by hand now \(spec 01 §6\.3, §6\.6\)/,
    );
    assert.equal(h.records().at(-1)?.forced, "deadline");
    write.open();
    await stopping;
    await pending;
    assert.equal(h.rw.operations.includes("finDeploy"), false);
  });

  it("records in the run log the superuser reference a hangup leaves while the write setting it is in flight, with no one reading the output", async () => {
    const h = provisioned();
    const file = manifest(h, { migrations: ["x.sql"] });
    const { write, reached } = referenceWriteHeld(h);
    const pending = deploy(h, file);
    await reached;
    // The operator's terminal closed: the hangup comes, and nothing printed reaches anyone.
    h.runtime.closeOutput();
    const stopping = h.runtime.interrupt("SIGHUP");
    await settle();
    assert.equal(inertWrites(h).length, 0, "the overwrite waits for the write");
    // The write is still in flight at the five-second deadline.
    assert.equal(h.runtime.forceClose("deadline"), true);
    const { done, line } = leftoverRecorded(h);
    assert.equal(done.interrupted, "SIGHUP");
    assert.equal(done.forced, "deadline");
    assert.equal(done.cleanupFailed, undefined, "the overwrite had not failed: it had not run");
    assert.equal(line.cleanupFailed, undefined);
    write.open();
    await stopping;
    assert.equal(await pending, EXIT.hangup);
    // The real process exits at the deadline; here the overwrite comes too late to write.
    assert.equal(standing(h), true, "the record names a reference that is really there");
    assert.equal(h.rw.operations.includes("finDeploy"), false);
    h.assertNoLeak();
  });

  it("records in the run log the superuser reference a hangup leaves while an overwrite Railway accepted without applying it is read back", async () => {
    const { h, file } = migrateWaits();
    h.rw.ignorePatch = (_service, variables) =>
      variables.FIN_BOOTSTRAP_DATABASE_URL?.value === INERT_VALUE;
    const readBack = gate();
    // The migrate wait and the stop's settle wait end only when the run stops or closes; the
    // read-back after the overwrite waits until the test opens it, so the deadline comes first.
    Object.assign(h.runtime, {
      sleep: (ms: number) =>
        ms === READ_BACK_PAUSE_MS ? readBack.wait : new Promise<void>(() => {}),
    });
    const pending = deploy(h, file);
    await until(() => h.rw.operations.includes("finLogs"));
    h.runtime.closeOutput();
    const stopping = h.runtime.interrupt("SIGHUP");
    await until(() => inertWrites(h).length === 1);
    await settle();
    assert.notEqual(h.records().at(-1)?.event, "run.done", "the run waits for the read-back");
    assert.equal(h.runtime.forceClose("deadline"), true);
    const { done } = leftoverRecorded(h);
    assert.equal(done.interrupted, "SIGHUP");
    assert.equal(done.forced, "deadline");
    assert.equal(done.awaitingRemoval, undefined, "nothing was proved inert");
    readBack.open();
    await stopping;
    assert.equal(await pending, EXIT.hangup);
    assert.equal(inertWrites(h).length, 1);
    assert.equal(standing(h), true, "Railway accepted the overwrite and applied nothing");
    h.assertNoLeak();
  });

  for (const closer of ["the stop's trap", "applyPlan"] as const) {
    it(`records in the run log an inert overwrite that failed after a hangup, when ${closer} closes the run, with no one reading the output`, async () => {
      // With the log read held past the settle wait, the trap runs the overwrite and closes the
      // run; with the migrate wait cut short by the stop, migrate's own change runs it and
      // applyPlan closes the run.
      const trap = closer === "the stop's trap";
      const { h, file, log, reached } = migrateWaits(trap);
      h.rw.ignorePatch = (_service, variables) =>
        variables.FIN_BOOTSTRAP_DATABASE_URL?.value === INERT_VALUE;
      if (!trap) {
        Object.assign(h.runtime, {
          sleep: (ms: number) =>
            ms === READ_BACK_PAUSE_MS ? Promise.resolve() : new Promise<void>(() => {}),
        });
      }
      const pending = deploy(h, file);
      if (trap) await reached;
      else await until(() => h.rw.operations.includes("finLogs"));
      h.runtime.closeOutput();
      const stopping = h.runtime.interrupt("SIGHUP");
      if (trap) await stopping;
      log.open();
      assert.equal(await pending, EXIT.hangup);
      await stopping;
      const { done, line } = leftoverRecorded(h);
      assert.equal(
        done.error,
        trap ? "interrupted by SIGHUP" : "interrupted by SIGHUP: nothing more is sent",
        `${closer} closed the run`,
      );
      assert.equal(done.interrupted, "SIGHUP");
      for (const record of [done, line]) {
        assert.equal(record.cleanupFailed, true);
        assert.match(
          String(record.cleanupError),
          /^Railway's variables read never showed FIN_BOOTSTRAP_DATABASE_URL overwritten with inert on migrate: set it to inert by hand now/,
        );
      }
      assert.equal(inertWrites(h).length, 1, "overwritten once");
      assert.equal(standing(h), true);
      h.assertNoLeak();
    });
  }

  it("records nothing left over when the superuser reference is made inert, and records it as waiting for removal", async () => {
    const h = provisioned();
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.ok, h.runtime.err());
    const done = h.records().at(-1);
    assert.equal(done?.result, "ok");
    assert.equal(done?.leftover, undefined);
    assert.equal(done?.cleanupFailed, undefined);
    assert.deepEqual(done?.awaitingRemoval, ["migrate FIN_BOOTSTRAP_DATABASE_URL"]);
    assert.equal(
      h.lines().some((l) => l.event === "run.leftover"),
      false,
    );
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
    // A safety rule's refusal (exit 77) closes the run as refused, not failed.
    assert.equal(h.records().at(-1)?.result, "refused");
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

  it("confirms the superuser reference is inert on migrate, and stops before rolling when it is not", async () => {
    const h = provisioned((x) => {
      x.rw.ignorePatch = (_service, variables) =>
        variables.FIN_BOOTSTRAP_DATABASE_URL?.value === INERT_VALUE;
    });
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.refused);
    assert.match(
      h.runtime.err(),
      /never showed FIN_BOOTSTRAP_DATABASE_URL overwritten with inert on migrate/,
    );
    assert.deepEqual(
      h.rw.updates.map((u) => u.service),
      ["migrate"],
      "nothing rolls while the reference stands",
    );
    assert.equal(h.records().at(-1)?.result, "refused");
  });

  it("commits every variable with skipDeploys, so no write starts a deployment and migrate runs once", async () => {
    const h = provisioned();
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.ok, h.runtime.err());
    assert.ok(h.rw.patches.length > 1);
    for (const p of h.rw.patches) assert.equal(p.skipDeploys, true, p.serviceId);
    assert.deepEqual(h.rw.variableDeletes, [], "no variable is deleted");
    assert.deepEqual(h.rw.writeDeployments, [], "no variable write started a deployment");
    assert.equal(h.rw.migrateEnvironments.length, 1, "one migrate run, the one the deploy started");
    assert.equal(
      h.rw.operations.filter((op) => op === "finDeploy").length,
      h.rw.updates.length,
      "one deployment per rolled service",
    );
  });

  it("reads migrate's variables again while a lagging read does not show the inert overwrite, and stops only once the bounded wait is out", async () => {
    const waits: number[] = [];
    const lagging = (reads: number) =>
      provisioned((x) => {
        x.rw.staleVariableReads = reads;
        Object.assign(x.runtime, {
          sleep: async (ms: number) => {
            waits.push(ms);
          },
        });
      });
    /** The calls after the inert overwrite: migrate's second variable commit of the run. */
    const afterInert = (x: H) => {
      const patches = x.sequence.flatMap((call, i) => (call === "rw finPatch" ? [i] : []));
      return x.sequence.slice((patches[1] ?? x.sequence.length) + 1);
    };
    const h = lagging(2);
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.ok, h.runtime.err());
    const reads = afterInert(h);
    assert.equal(
      reads.findIndex((c) => c !== "rw finVariables"),
      3,
      "two lagging reads, then the one that shows the write",
    );
    assert.ok(
      h.rw.updates.some((u) => u.service === "console"),
      "the roll goes on",
    );
    assert.equal(h.records().at(-1)?.result, "ok");

    waits.length = 0;
    // Every read lags: the write that sets the reference never shows, so migrate never starts,
    // and the overwrite never shows either.
    const h2 = lagging(100);
    assert.equal(await deploy(h2, manifest(h2, { migrations: ["x.sql"] })), EXIT.unavailable);
    assert.match(
      h2.runtime.err(),
      /migrate: Railway's variables read did not show this run's write/,
    );
    assert.equal(h2.rw.operations.includes("finDeploy"), false, "migrate never starts");
    assert.equal(
      afterInert(h2).filter((call) => call === "rw finVariables").length,
      READ_BACK_READS,
      "a bounded number of reads",
    );
    assert.equal(waits.filter((ms) => ms === READ_BACK_PAUSE_MS).length, 2 * (READ_BACK_READS - 1));
    assert.deepEqual(
      h2.rw.updates.map((u) => u.service),
      ["migrate"],
      "nothing rolls while the reference may stand",
    );
    assert.match(String(h2.records().at(-1)?.leftover), REMOVE_BY_HAND);
  });

  it("finds the superuser reference on migrate after the overwrite when Railway answers it sealed", async () => {
    const h = provisioned((x) => {
      const fetch = x.rw.fetch;
      Object.assign(x.rw, {
        fetch: async (url: string, init: RequestInit) => {
          const answer = await fetch(url, init);
          const migrate = x.rw.instances.get("migrate");
          if (String(init.body).includes(`"value":"${INERT_VALUE}"`) && migrate !== undefined) {
            delete migrate.variables.FIN_BOOTSTRAP_DATABASE_URL;
            migrate.sealed.add("FIN_BOOTSTRAP_DATABASE_URL");
          }
          return answer;
        },
      });
    });
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.refused);
    assert.match(h.runtime.err(), /FIN_BOOTSTRAP_DATABASE_URL overwritten with inert on migrate/);
    assert.equal(standing(h), true);
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

function setup() {
  const token = fakeToken("r");
  const rw = new FakeRailway(token, ["worker", "edge"]);
  const runtime = fakeRuntime({ fetch: rw.fetch });
  const masker = new Masker();
  const run = new Run(
    runtime,
    new RunLog(join(tempDir(), "s"), masker),
    new Output(runtime, masker),
    { command: "test", environment: "staging", dryRun: false },
  );
  run.register();
  const api = new RailwayApi(new Secret(token), runtime, overlay, masker);
  return { rw, run, api };
}

const DELETE =
  "mutation finVariableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }";

function deleteInput(serviceId: string, name = "FIN_BOOTSTRAP_DATABASE_URL") {
  const { projectId, environmentId } = overlay.railway;
  return { projectId, environmentId, serviceId, name };
}

const PATCH =
  "mutation finPatch($environmentId: String!, $patch: EnvironmentConfig, $commitMessage: String) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage, skipDeploys: true) }";

describe("the Railway client's writes", () => {
  it("sends only the mutations pnpm fin makes, to this environment and the project's services", async () => {
    const { rw, run, api } = setup();
    const worker = await api.serviceId("worker");
    const env = overlay.railway.environmentId;
    const patch = (serviceId: string) => ({ services: { [serviceId]: { variables: {} } } });
    await api.mutate(run, PATCH, { environmentId: env, patch: patch(worker) });
    assert.equal(rw.patches.length, 1);
    const refusals: Array<[string, Record<string, unknown>]> = [
      ["mutation finDrop($id: String!) { serviceDelete(id: $id) }", { id: worker }],
      [
        "mutation finTwo($environmentId: String!) { environmentPatchCommit(environmentId: $environmentId) serviceDelete(id: $environmentId) }",
        { environmentId: env },
      ],
      [PATCH, { environmentId: uuid("e"), patch: patch(worker) }],
      [PATCH, { environmentId: env, patch: patch(uuid("f")) }],
      // An environment patch passes skipDeploys: true in the call itself, so it starts no deployment.
      [PATCH.replace(", skipDeploys: true", ""), { environmentId: env, patch: patch(worker) }],
      [
        PATCH.replace("skipDeploys: true", "skipDeploys: false"),
        { environmentId: env, patch: patch(worker) },
      ],
      [
        PATCH.replace("skipDeploys: true", "skipDeploys: $skip"),
        { environmentId: env, patch: patch(worker), skip: false },
      ],
      [
        "mutation finDeploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }",
        { serviceId: uuid("f"), environmentId: env },
      ],
      // No variable is deleted, not even the superuser reference (rule 3).
      [DELETE, { input: deleteInput(worker) }],
      [DELETE, { input: deleteInput(worker, "FIN_RELEASE") }],
      [DELETE, { input: { ...deleteInput(worker), projectId: uuid("e") } }],
      [DELETE, { input: deleteInput(uuid("f")) }],
    ];
    for (const [query, variables] of refusals) {
      await assert.rejects(api.mutate(run, query, variables), RefusedError, query);
    }
    assert.equal(rw.patches.length, 1);
    assert.deepEqual(
      rw.operations.filter((op) => op !== "finServices"),
      ["finPatch"],
    );
  });

  it("sets variables with skipDeploys, sealed where they must be, and its own write marker", async () => {
    const { rw, run, api } = setup();
    const first = await api.setVariables(
      run,
      settings,
      "worker",
      { FIN_RELEASE: RELEASE, FIN_DB_PASSWORD: new Secret("x".repeat(32)) },
      "test",
    );
    assert.equal(rw.patches.length, 1);
    assert.equal(rw.patches[0]?.skipDeploys, true);
    assert.equal(rw.patches[0]?.variables.FIN_DB_PASSWORD?.isSealed, true);
    assert.deepEqual(rw.writeDeployments, []);
    // The marker is plain, names the run and the write, and comes back for the read-back.
    assert.equal(first.marker, `${run.id}:1`);
    assert.deepEqual(rw.patches[0]?.variables[WRITE_MARKER], { value: first.marker });
    assert.deepEqual(first.sealed, ["FIN_DB_PASSWORD"]);
    assert.deepEqual(first.plain, { FIN_RELEASE: RELEASE, [WRITE_MARKER]: first.marker });
    const second = await api.setVariables(run, settings, "worker", { FIN_RELEASE: RELEASE }, "t");
    assert.equal(second.marker, `${run.id}:2`, "each write its own marker");
    await assert.rejects(
      api.setVariables(run, settings, "worker", { [WRITE_MARKER]: "x" }, "t"),
      RefusedError,
    );
    assert.equal(rw.patches.length, 2);
  });

  it("reads a sealed variable, which Railway answers with a null value, as sealed and present", async () => {
    const { rw, api } = setup();
    rw.addService("api", {
      variables: { PORT: "8080", FIN_SERVICE: "api" },
      sealed: new Set(["FIN_DB_PASSWORD"]),
    });
    const v = await readVariables(api, settings, "api", await api.serviceId("api"));
    assert.deepEqual(v.readable.sort(), ["FIN_SERVICE", "PORT"]);
    assert.deepEqual(v.sealed, ["FIN_DB_PASSWORD"]);
    assert.equal(v.port, "8080");
    assert.equal(v.marker, null);
    // Compared where it is read: only the names that differ are kept, never a value.
    const compared = await readVariables(api, settings, "api", await api.serviceId("api"), {
      FIN_SERVICE: "api",
      PORT: "3000",
      FIN_DB_PASSWORD: "x",
    });
    assert.deepEqual(compared.differs, ["PORT", "FIN_DB_PASSWORD"]);
  });
});
