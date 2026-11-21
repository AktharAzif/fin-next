// No deploy nobody asked for: the steward's ruling of 22 Nov on the ops tooling's Railway writes,
// one describe per rule, against the fake Railway modelled on Railway's own schema (a variable
// delete takes no skipDeploys and starts a deployment; a commit without skipDeploys starts one).
//
//   1. a provisioning or configuration write commits with skipDeploys and starts nothing;
//   2. a rotation commits with skipDeploys, redeploys each service that holds the old secret as a
//      recorded step, reads back, and only then revokes the old secret or sends the new one;
//   3. nothing deletes a variable: the superuser reference is overwritten with the inert value and
//      recorded as waiting for removal, so migrate runs once per deploy;
//   4. a read-back proves a write only once it shows that write (its marker), never because it
//      lacks what the write replaced.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FakeGh } from "../../../tools/static-deploy/test/fake.ts";
import { EXIT } from "../src/core/errors.ts";
import { parseOverlay } from "../src/core/overlay.ts";
import { loadSettings } from "../src/core/settings.ts";
import type { Written } from "../src/railway/api.ts";
import {
  INERT_VALUE,
  READ_BACK_READS,
  type Variables,
  WRITE_MARKER,
} from "../src/railway/inspect.ts";
import { showsWrite } from "../src/railway/rollout.ts";
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
const ref = (image: keyof typeof IMAGES) => `ghcr.io/aktharazif/${image}@${IMAGES[image]}`;

type H = ReturnType<typeof harness> & { gh: FakeGh };

/** Staging as provisioned by hand, with the given services already running their images. */
function staging(running: Partial<Record<string, keyof typeof IMAGES>> = {}): H {
  const h = harness() as H;
  h.gh = new FakeGh();
  Object.assign(h.runtime, { exec: h.gh.exec });
  h.rw.provision(settings.railway, uuid("d"), overlay.staticEgress);
  for (const [service, image] of Object.entries(running)) {
    if (image !== undefined) h.rw.running(service, ref(image));
  }
  return h;
}

/** Every service the zone's ingress proofs reach, running. */
const PROOF_SERVICES = {
  edge: "fin-next-edge",
  console: "fin-next-console",
  admin: "fin-next-admin",
  verify: "fin-next-verify",
} as const;

function manifest(h: H, extra: Record<string, unknown> = {}): string {
  const file = join(h.dir, "release-manifest.json");
  const text = JSON.stringify({
    commit: RELEASE,
    images: IMAGES,
    static: {},
    migrations: [],
    ...extra,
  });
  writeFileSync(file, text);
  h.gh.attest(text);
  return file;
}

const deploy = (h: H, file: string) =>
  h.run(["railway", "deploy", "staging", "--release", RELEASE, "--manifest", file]);

const RAILWAY_WRITES = new Set([
  "rw finPatch",
  "rw finDeploy",
  "rw finInstanceUpdate",
  "rw finVariableDelete",
]);

/** The provider calls that write, in order, as `cf POST`, `cf DELETE` or `rw <operation>`. */
function writes(h: H): string[] {
  return h.sequence
    .filter((c) => /^cf (POST|PATCH|PUT|DELETE) /.test(c) || RAILWAY_WRITES.has(c))
    .map((c) => (c.startsWith("cf ") ? c.split(" ").slice(0, 2).join(" ") : c));
}

/** The run log's run.step records of one kind, as `<name>` each. */
function steps(h: H, kind: string): string[] {
  return h
    .records()
    .filter((r) => r.event === "run.step" && r.kind === kind)
    .map((r) => String(r.name));
}

/** The value one commit set for a variable on a service (the newest such commit). */
function lastSet(h: H, service: string, variable: string): string | undefined {
  return h.rw.patches.filter((p) => h.rw.nameOf(p.serviceId) === service).at(-1)?.variables[
    variable
  ]?.value;
}

/** The variables each deployment of a service started with, newest last. */
function startedWith(h: H, service: string): Array<Record<string, string>> {
  return [...h.rw.deployments.entries()]
    .filter(([, d]) => d.service === service)
    .map(([id]) => h.rw.startedWith.get(id))
    .filter((v): v is Record<string, string> => v !== undefined);
}

describe("rule 1: a provisioning or configuration write starts no deployment", () => {
  it("tunnel create, email token and zone apply on services never deployed commit with skipDeploys, deploy nothing and read each write back", async () => {
    const h = staging();
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.ok, h.runtime.err());
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
    assert.equal(
      await h.run(["zone", "apply", "staging", "--only", "rules"]),
      EXIT.ok,
      h.runtime.err(),
    );
    assert.ok(h.rw.patches.length >= 6);
    for (const p of h.rw.patches) assert.equal(p.skipDeploys, true);
    assert.deepEqual(h.rw.writeDeployments, [], "no commit started a deployment");
    assert.deepEqual(h.rw.deployed, [], "nothing was deployed: nothing held an old value");
    assert.deepEqual(steps(h, "redeploy"), []);
    // Each commit is followed by a read that shows it before the run goes on.
    const calls = h.sequence;
    calls.forEach((call, i) => {
      if (call === "rw finPatch")
        assert.equal(calls[i + 1], "rw finVariables", `read back at ${i}`);
    });
  });

  it("a first email token on a running worker is provisioning: worker takes it at its next deploy", async () => {
    const h = staging({ worker: "fin-next-api" });
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
    assert.deepEqual(h.rw.deployed, [], "worker held no token, so none is rotated");
    assert.deepEqual(writes(h), ["cf POST", "rw finPatch"]);
  });
});

describe("rule 2: a rotation redeploys each service that holds the old secret, reads back, and only then revokes or sends", () => {
  it("email token --rotate redeploys worker with the new token, reads back, and only then revokes the old one", async () => {
    // Before the ruling the old token was revoked while worker still ran on it.
    const h = staging({ worker: "fin-next-api" });
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
    h.sequence.length = 0;
    assert.equal(
      await h.run(["email", "token", "staging", "--rotate", "--dry-run"]),
      1,
      h.runtime.err(),
    );
    assert.match(h.runtime.out(), /~ update redeploy worker \[FIN_EMAIL_TOKEN\]/);
    assert.match(h.runtime.out(), /revoked once worker runs the new token, read back/);
    assert.deepEqual(writes(h), [], "a dry run writes nothing");
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.ok, h.runtime.err());
    assert.deepEqual(writes(h), ["cf POST", "rw finPatch", "rw finDeploy", "cf DELETE"]);
    // The deployment started after the write showed, and took the new token.
    const order = h.sequence;
    const patch = order.indexOf("rw finPatch");
    const read = order.indexOf("rw finVariables", patch);
    const started = order.indexOf("rw finDeploy");
    assert.ok(patch < read && read < started, "read back before the redeploy");
    const revoked = order.findIndex((c) => c.startsWith("cf DELETE"));
    assert.ok(
      order.slice(started, revoked).includes("rw finVariables"),
      "read back after the redeploy, before the revocation",
    );
    const token = lastSet(h, "worker", "FIN_EMAIL_TOKEN");
    assert.equal(startedWith(h, "worker").at(-1)?.FIN_EMAIL_TOKEN, token);
    assert.deepEqual(h.rw.deployed, ["worker"]);
    assert.deepEqual(h.rw.writeDeployments, []);
    assert.equal(h.cf.tokens.length, 1);
    // The redeploy is a recorded step of its own, and a line names the service and the variable.
    assert.deepEqual(steps(h, "redeploy"), ["worker"]);
    const line = h.lines().find((l) => l.event === "rotation.redeployed");
    assert.deepEqual(line?.services, ["worker"]);
    assert.deepEqual(line?.variables, ["FIN_EMAIL_TOKEN"]);
    assert.equal(line?.command, "email token");
    h.assertNoLeak([token ?? ""]);
  });

  it("a rotation whose redeploy fails revokes nothing, says the rotation is not done, and a re-run finishes it", async () => {
    const h = staging({ worker: "fin-next-api" });
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    h.rw.deployStatuses = ["DEPLOYING", "CRASHED"];
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.unavailable);
    assert.equal(h.cf.tokens.length, 2, "the old token still works");
    assert.equal(writes(h).filter((w) => w === "cf DELETE").length, 0);
    assert.match(h.runtime.err(), /the rotation is not done: worker may still run the old token/);
    assert.equal(h.records().at(-1)?.result, "failed");
    h.rw.deployStatuses = ["DEPLOYING", "SUCCESS"];
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.ok, h.runtime.err());
    assert.equal(h.cf.tokens.length, 1);
    assert.equal(
      startedWith(h, "worker").at(-1)?.FIN_EMAIL_TOKEN,
      lastSet(h, "worker", "FIN_EMAIL_TOKEN"),
    );
  });

  it("a rotation on a service with no deployment revokes once the write shows, and deploys nothing", async () => {
    const h = staging();
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.ok, h.runtime.err());
    assert.match(h.runtime.out(), /worker has no deployment that holds the old one/);
    assert.deepEqual(h.rw.deployed, []);
    assert.equal(h.cf.tokens.length, 1);
  });

  it("refuses to redeploy a service set to an image its newest deployment does not run, and revokes nothing", async () => {
    const h = staging({ worker: "fin-next-api" });
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    const worker = h.rw.instances.get("worker");
    if (worker === undefined) throw new Error("fixture");
    worker.image = ref("fin-next-edge");
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.refused);
    assert.match(h.runtime.err(), /a redeploy would roll that image/);
    assert.deepEqual(h.rw.deployed, [], "no deployment nobody asked for");
    assert.equal(h.cf.tokens.length, 2);
  });

  it("the tunnel-token incident: tunnel create after the tunnel was deleted rotates, redeploys the connector and reads back", async () => {
    // Before the ruling no pnpm fin command redeployed the connector, and the runbook woke the
    // owner.
    const h = staging();
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.ok);
    const first = lastSet(h, "cloudflared-public", "TUNNEL_TOKEN");
    h.rw.running("cloudflared-public", ref("fin-next-connector"));
    // Containment: the tunnel is deleted at Cloudflare, with its connections.
    h.cf.tunnels.length = 0;
    h.sequence.length = 0;
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.ok, h.runtime.err());
    const token = lastSet(h, "cloudflared-public", "TUNNEL_TOKEN");
    assert.notEqual(token, first);
    assert.deepEqual(h.rw.deployed, ["cloudflared-public"]);
    assert.equal(startedWith(h, "cloudflared-public").at(-1)?.TUNNEL_TOKEN, token);
    assert.deepEqual(steps(h, "redeploy"), ["cloudflared-public"]);
    assert.deepEqual(
      h
        .lines()
        .filter((l) => l.event === "rotation.redeployed")
        .map((l) => l.services),
      [["cloudflared-public"]],
    );
    const order = h.sequence;
    assert.ok(order.indexOf("rw finVariables") < order.indexOf("rw finDeploy"));
    assert.ok(order.lastIndexOf("rw finVariables") > order.indexOf("rw finDeploy"));
    h.assertNoLeak([token ?? ""]);

    // A kept tunnel has the token the connector runs: no redeploy, unless asked for, which is how
    // a rotation whose redeploy did not pass is finished.
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.ok);
    assert.match(
      h.runtime.out(),
      /the tunnel is kept, so its token is the one cloudflared-public runs/,
    );
    assert.equal(h.rw.deployed.length, 1);
    assert.equal(
      await h.run(["tunnel", "create", "staging", "public", "--redeploy"]),
      EXIT.ok,
      h.runtime.err(),
    );
    assert.deepEqual(h.rw.deployed, ["cloudflared-public", "cloudflared-public"]);
  });

  it("a tunnel rotation whose redeploy fails names the command that finishes it", async () => {
    const h = staging({ "cloudflared-admin": "fin-next-connector" });
    h.rw.deployStatuses = ["DEPLOYING", "FAILED"];
    assert.equal(await h.run(["tunnel", "create", "staging", "admin"]), EXIT.unavailable);
    assert.match(
      h.runtime.err(),
      /the rotation is not done: cloudflared-admin may still run the old token; once the cause is fixed, run: pnpm fin tunnel create staging admin --redeploy/,
    );
  });

  it("zone apply redeploys each running service with its new proof, reads back, and only then writes a rule that sends it", async () => {
    // Before the ruling the rule went out while the services still held the old proofs (403s).
    const h = staging(PROOF_SERVICES);
    assert.equal(
      await h.run(["zone", "apply", "staging", "--only", "rules"]),
      EXIT.ok,
      h.runtime.err(),
    );
    assert.deepEqual([...h.rw.deployed].sort(), Object.keys(PROOF_SERVICES).sort());
    assert.deepEqual([...steps(h, "redeploy")].sort(), Object.keys(PROOF_SERVICES).sort());
    const order = h.sequence;
    const firstRule = order.findIndex((c) => /^cf (POST|PATCH) .*\/rulesets/.test(c));
    const lastDeploy = order.lastIndexOf("rw finDeploy");
    assert.ok(lastDeploy >= 0 && firstRule > lastDeploy, "every redeploy before the first rule");
    assert.ok(
      order.slice(lastDeploy, firstRule).includes("rw finVariables"),
      "read back after the last redeploy",
    );
    const rule = [...h.cf.rulesets.values()]
      .flatMap((r) => r.rules)
      .find((r) => r.ref === "fin_next_ingress_proof_verify");
    const headers = (rule?.action_parameters?.headers ?? {}) as Record<string, { value: string }>;
    const sent = headers["Fin-Ingress-Proof"]?.value ?? "";
    const took = JSON.parse(startedWith(h, "verify").at(-1)?.FIN_INGRESS_PROOFS ?? "{}");
    assert.equal(took.verify?.[0], sent, "verify runs the proof the rule sends");
    h.assertNoLeak([sent]);
  });

  it("zone apply whose redeploy fails writes no rule that sends the new proof", async () => {
    const h = staging(PROOF_SERVICES);
    h.rw.deployStatuses = ["DEPLOYING", "CRASHED"];
    assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.unavailable);
    assert.equal(
      h.sequence.some((c) => /^cf (POST|PATCH) .*\/rulesets/.test(c)),
      false,
      "no rule is written",
    );
    assert.match(h.runtime.err(), /the rotation is not done: \S+ may still hold the old proofs/);
  });
});

describe("rule 3: nothing deletes a variable; the superuser reference is made inert and waits for removal", () => {
  it("railway deploy with migrations sends no variable delete, runs migrate once, and records the inert reference as waiting for removal", async () => {
    // Before the ruling the removal fell back to a variable delete with no skipDeploys, which
    // started a second migrate run that wrote migrate.failed for a release that succeeded.
    const h = staging();
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.ok, h.runtime.err());
    assert.equal(h.rw.operations.includes("finVariableDelete"), false);
    assert.deepEqual(h.rw.writeDeployments, []);
    assert.equal(h.rw.deployed.filter((s) => s === "migrate").length, 1);
    assert.equal(h.rw.migrateEnvironments.length, 1, "one migrate run");
    assert.equal(h.rw.instances.get("migrate")?.variables.FIN_BOOTSTRAP_DATABASE_URL, INERT_VALUE);
    const done = h.records().at(-1);
    assert.deepEqual(done?.awaitingRemoval, ["migrate FIN_BOOTSTRAP_DATABASE_URL"]);
    assert.equal(done?.leftover, undefined);

    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    const out = h.runtime.out().split("railway staging:").at(-1) ?? "";
    assert.doesNotMatch(out, /superuser-reference/, "the inert value is not a reference");
    assert.match(out, /waits for removal: migrate FIN_BOOTSTRAP_DATABASE_URL \(inert\)/);

    // The next release with migrations sets the reference over the inert value for its run, and
    // leaves it inert again; still no delete and one migrate run.
    assert.equal(await deploy(h, manifest(h, { migrations: ["y.sql"] })), EXIT.ok, h.runtime.err());
    assert.match(h.runtime.out(), /waits for removal: migrate FIN_BOOTSTRAP_DATABASE_URL/);
    assert.equal(h.rw.migrateEnvironments.length, 2);
    assert.match(
      h.rw.migrateEnvironments[1]?.FIN_BOOTSTRAP_DATABASE_URL ?? "",
      /^\$\{\{postgres\./,
    );
    assert.equal(h.rw.instances.get("migrate")?.variables.FIN_BOOTSTRAP_DATABASE_URL, INERT_VALUE);
    assert.equal(h.rw.operations.includes("finVariableDelete"), false);
  });

  it("the fake answers a variable delete as Railway's schema does: no skipDeploys, and a deployment", async () => {
    // Before the ruling the fake accepted skipDeploys on a delete, so a test passed against a
    // schema Railway does not have.
    const h = staging();
    const send = (input: Record<string, unknown>) =>
      h.rw.fetch("https://backboard.railway.com/graphql/v2", {
        method: "POST",
        headers: { "project-access-token": h.rw.token },
        body: JSON.stringify({
          query:
            "mutation finVariableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }",
          variables: { input },
        }),
      });
    const input = {
      projectId: overlay.railway.projectId,
      environmentId: overlay.railway.environmentId,
      serviceId: h.rw.services.get("migrate"),
      name: "FIN_BOOTSTRAP_DATABASE_URL",
    };
    const refused = await send({ ...input, skipDeploys: true });
    assert.equal(refused.status, 400);
    assert.match(
      await refused.text(),
      /Field \\"skipDeploys\\" is not defined by type \\"VariableDeleteInput\\"/,
    );
    assert.deepEqual(h.rw.writeDeployments, []);
    assert.equal((await send(input)).status, 200);
    assert.deepEqual(h.rw.writeDeployments, ["migrate"]);
  });

  it("a superuser reference that is sealed, or readable with anything but the inert value, still refuses the deploy", async () => {
    for (const set of [
      (v: { variables: Record<string, string>; sealed: Set<string> }) =>
        v.sealed.add("FIN_BOOTSTRAP_DATABASE_URL"),
      (v: { variables: Record<string, string>; sealed: Set<string> }) => {
        v.variables.FIN_BOOTSTRAP_DATABASE_URL = "inert-ish";
      },
    ]) {
      const h = staging();
      const migrate = h.rw.instances.get("migrate");
      if (migrate === undefined) throw new Error("fixture");
      set(migrate);
      assert.equal(await deploy(h, manifest(h)), EXIT.refused);
      assert.match(h.runtime.err(), /migrate \(superuser-reference\)/);
    }
    const h = staging();
    const migrate = h.rw.instances.get("migrate");
    if (migrate === undefined) throw new Error("fixture");
    migrate.variables.FIN_BOOTSTRAP_DATABASE_URL = INERT_VALUE;
    assert.equal(await deploy(h, manifest(h)), EXIT.ok, h.runtime.err());
  });
});

describe("rule 4: a read-back proves a write only once it shows that write", () => {
  it("a read from before the write that set the reference, which shows no reference, is no proof that it is inert", async () => {
    // Before the ruling the first read without the reference counted as its removal, so a
    // lagging read ended the read-back and run.done named nothing.
    const h = staging();
    h.rw.ignorePatch = (_service, variables) =>
      variables.FIN_BOOTSTRAP_DATABASE_URL?.value === INERT_VALUE;
    const fetch = h.rw.fetch;
    let inertSent = false;
    let staleAnswered = false;
    Object.assign(h.rw, {
      fetch: async (url: string, init: RequestInit) => {
        const body = String(init.body);
        if (body.includes("finPatch") && body.includes(`"value":"${INERT_VALUE}"`))
          inertSent = true;
        if (inertSent && !staleAnswered && body.includes("finVariables")) {
          staleAnswered = true;
          // What migrate held before this run: no reference, and no marker of this run's writes.
          return new Response(JSON.stringify({ data: { variables: { PORT: "8080" } } }), {
            status: 200,
          });
        }
        return fetch(url, init);
      },
    });
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.refused);
    assert.ok(staleAnswered);
    const patches = h.sequence.flatMap((c, i) => (c === "rw finPatch" ? [i] : []));
    const after = h.sequence.slice((patches[1] ?? 0) + 1).filter((c) => c === "rw finVariables");
    assert.equal(after.length, READ_BACK_READS, "the stale read did not end the read-back");
    const done = h.records().at(-1);
    assert.match(String(done?.leftover), /may still hold the superuser reference on migrate/);
    assert.equal(done?.cleanupFailed, true);
    assert.equal(done?.awaitingRemoval, undefined);
    assert.ok(h.lines().some((l) => l.event === "run.leftover"));
    assert.deepEqual(
      h.rw.updates.map((u) => u.service),
      ["migrate"],
      "nothing else rolls",
    );
  });

  it("a write setting the reference whose answer was lost, and which lands after the inert value, is named in the run's record", async () => {
    // Before the ruling a read that showed no reference after the removal counted as proof, and a
    // set-write that landed later left the reference with nothing recorded.
    const h = staging();
    const fetch = h.rw.fetch;
    let held: [string, RequestInit] | undefined;
    Object.assign(h.rw, {
      fetch: async (url: string, init: RequestInit) => {
        const body = String(init.body);
        if (
          held === undefined &&
          body.includes("finPatch") &&
          body.includes("postgres.DATABASE_URL")
        ) {
          held = [url, init];
          throw new TypeError("fetch failed");
        }
        return fetch(url, init);
      },
    });
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.unavailable);
    assert.equal(h.rw.operations.includes("finDeploy"), false, "migrate never starts");
    assert.equal(h.rw.instances.get("migrate")?.variables.FIN_BOOTSTRAP_DATABASE_URL, INERT_VALUE);
    assert.match(h.runtime.err(), /got no answer, so it may still land after the inert value/);
    const done = h.records().at(-1);
    assert.match(String(done?.leftover), /may still hold the superuser reference on migrate/);
    assert.equal(done?.cleanupFailed, undefined, "the overwrite itself was proved");
    const line = h.lines().find((l) => l.event === "run.leftover");
    assert.match(String(line?.leftover), /set it to inert by hand now/);
    // The lost write lands now, at Railway: the record named exactly what stands.
    if (held === undefined) throw new Error("the write was not held");
    await fetch(...held);
    assert.match(
      h.rw.instances.get("migrate")?.variables.FIN_BOOTSTRAP_DATABASE_URL ?? "",
      /^\$\{\{/,
    );
    assert.equal(await h.run(["railway", "verify", "staging"]), EXIT.drift);
    assert.match(h.runtime.out(), /! migrate superuser-reference: FIN_BOOTSTRAP_DATABASE_URL/);
  });

  it("each rolled service's write is read back until it shows before its deployment starts, which takes it", async () => {
    const h = staging();
    h.rw.staleVariableReads = 2;
    assert.equal(await deploy(h, manifest(h)), EXIT.ok, h.runtime.err());
    const order = h.sequence;
    order.forEach((call, i) => {
      if (call !== "rw finPatch") return;
      const next = order.slice(i + 1, i + 4);
      assert.deepEqual(next, ["rw finVariables", "rw finVariables", "rw finVariables"], `at ${i}`);
    });
    for (const service of settings.railway.deployOrder) {
      if (service === "payments") continue;
      const took = startedWith(h, service).at(-1);
      assert.equal(took?.FIN_RELEASE, RELEASE, service);
      assert.equal(took?.[WRITE_MARKER], lastSet(h, service, WRITE_MARKER), service);
    }
  });

  it("a write that never shows starts no deployment of its service", async () => {
    const h = staging();
    h.rw.ignorePatch = (service) => service === "api";
    assert.equal(await deploy(h, manifest(h)), EXIT.unavailable);
    assert.match(h.runtime.err(), /api: Railway's variables read did not show this run's write/);
    assert.equal(h.rw.deployed.includes("api"), false);
    assert.match(h.runtime.err(), /deploy stopped at api/);
  });

  it("a rotation's sealed name that was there before the write proves nothing: no redeploy and no revocation until the write's own marker shows", async () => {
    const h = staging({ worker: "fin-next-api" });
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    h.rw.ignorePatch = (service) => service === "worker";
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.unavailable);
    assert.match(h.runtime.err(), /worker: Railway's variables read did not show this run's write/);
    assert.deepEqual(h.rw.deployed, []);
    assert.equal(h.cf.tokens.length, 2, "the old token is not revoked");
  });

  it("showsWrite needs the write's marker, every sealed name and every plain value", () => {
    const written: Written = {
      service: "worker",
      serviceId: uuid("e"),
      marker: "run_x:2",
      sealed: ["FIN_EMAIL_TOKEN"],
      plain: { FIN_EMAIL_FROM: "x", [WRITE_MARKER]: "run_x:2" },
    };
    const read = (over: Partial<Variables>): Variables => ({
      readable: ["FIN_EMAIL_FROM", WRITE_MARKER],
      sealed: ["FIN_EMAIL_TOKEN"],
      templateReferences: [],
      inert: [],
      port: null,
      marker: "run_x:2",
      differs: [],
      ...over,
    });
    assert.equal(showsWrite(read({}), written), true);
    assert.equal(showsWrite(read({ marker: "run_x:1" }), written), false, "an earlier write");
    assert.equal(showsWrite(read({ marker: null }), written), false, "a read from before any");
    assert.equal(showsWrite(read({ sealed: [] }), written), false);
    assert.equal(showsWrite(read({ differs: ["FIN_EMAIL_FROM"] }), written), false);
  });
});
