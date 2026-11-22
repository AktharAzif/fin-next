// No deploy nobody asked for: the steward's ruling of 22 Nov on the ops tooling's Railway writes,
// one describe per rule, against the fake Railway modelled on Railway's own schema (a variable
// delete takes no skipDeploys and starts a deployment; a commit without skipDeploys starts one).
//
//   1. a provisioning or configuration write commits with skipDeploys and starts nothing;
//   2. a rotation commits with skipDeploys, redeploys each service that holds the old secret as a
//      recorded step, reads back, and only then revokes the old secret or sends the new one (a
//      service holds it whenever it has a newest deployment, whatever its status: an aborted one
//      is REMOVED while the one before it serves); its dry run only reads;
//   3. nothing deletes a variable: the superuser reference is overwritten with the inert value and
//      recorded as waiting for removal, so migrate runs once per deploy;
//   4. a read-back proves a write only once it shows that write (its marker), never because it
//      lacks what the write replaced.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FakeGh } from "../../../tools/static-deploy/test/fake.ts";
import { EXIT } from "../src/core/errors.ts";
import { parseOverlay } from "../src/core/overlay.ts";
import { loadSettings, mustBeSealed } from "../src/core/settings.ts";
import type { Written } from "../src/railway/api.ts";
import {
  INERT_VALUE,
  READ_BACK_READS,
  type Variables,
  WRITE_MARKER,
} from "../src/railway/inspect.ts";
import { showsWrite } from "../src/railway/rollout.ts";
import { hex, overlayFixture, REPO_ROOT, uuid, writePrivate } from "./helpers/fixtures.ts";
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
  return h.rw.patches
    .filter((p) => h.rw.nameOf(p.serviceId) === service && Object.hasOwn(p.variables, variable))
    .at(-1)?.variables[variable]?.value;
}

/** Sets the image a service's instance is set to (what its next deployment takes). */
function setImage(h: H, service: string, image: string): void {
  const instance = h.rw.instances.get(service);
  if (instance === undefined) throw new Error(`no instance of ${service}`);
  instance.image = image;
}

/** Ends a service's newest deployment with a status, as Railway reports it from then on. */
function endNewest(h: H, service: string, status: string): void {
  const instance = h.rw.instances.get(service);
  const latest = instance?.latestDeployment ?? null;
  const deployment = latest === null ? undefined : h.rw.deployments.get(latest.id);
  if (instance === undefined || latest === null || deployment === undefined)
    throw new Error(`no deployment of ${service}`);
  deployment.statuses = [status];
  instance.latestDeployment = { id: latest.id, status };
}

/** The variables each deployment of a service started with, newest last. */
function startedWith(h: H, service: string): Array<Record<string, string>> {
  return [...h.rw.deployments.entries()]
    .filter(([, d]) => d.service === service)
    .map(([id]) => h.rw.startedWith.get(id))
    .filter((v): v is Record<string, string> => v !== undefined);
}

/** The variables the deployment of a service that serves started with (FakeRailway.serving). */
function serving(h: H, service: string): Record<string, string> | undefined {
  const id = h.rw.serving(service);
  return id === undefined ? undefined : h.rw.startedWith.get(id);
}

/**
 * A deployment of a service started and aborted in Railway's dashboard: Railway marks it REMOVED
 * (REMOVING while the abort is under way), it is the service's newest deployment, and the one
 * before it keeps serving with the variables it started with.
 */
function abortNewer(h: H, service: string, status = "REMOVED"): void {
  const image = h.rw.instances.get(service)?.image;
  if (image === null || image === undefined) throw new Error(`no image on ${service}`);
  h.rw.running(service, image, status);
}

/** The proof the rule of a host role sends, or undefined when no such rule stands. */
function sentProof(h: H, role: string): string | undefined {
  const rule = [...h.cf.rulesets.values()]
    .flatMap((r) => r.rules)
    .find((r) => r.ref === `fin_next_ingress_proof_${role}`);
  const headers = (rule?.action_parameters?.headers ?? {}) as Record<string, { value: string }>;
  return headers["Fin-Ingress-Proof"]?.value;
}

/** The proof of a host role that a service's serving deployment holds. */
function heldProof(h: H, service: string, role: string): string | undefined {
  return JSON.parse(serving(h, service)?.FIN_INGRESS_PROOFS ?? "{}")[role]?.[0];
}

/** Deletes the rule that sends a role's proof, as rotate-ingress-proof.md does by hand. */
function dropProofRule(h: H, role: string): void {
  for (const ruleset of h.cf.rulesets.values())
    ruleset.rules = ruleset.rules.filter((r) => r.ref !== `fin_next_ingress_proof_${role}`);
}

const RULE_WRITE = /^cf (POST|PATCH) .*\/rulesets/;

/**
 * The Railway calls of a harness in order, a variables read and a deployment labelled with its
 * service (`finVariables worker`, `finDeploy worker`), the rest by operation. The sequence must be
 * whole, and every variables read answered.
 */
function railwayCalls(h: H): string[] {
  let reads = 0;
  let deploys = 0;
  return h.sequence
    .filter((c) => c.startsWith("rw "))
    .map((c) => {
      const op = c.slice(3);
      if (op === "finVariables") return `${op} ${h.rw.variableReads[reads++]}`;
      if (op === "finDeploy") return `${op} ${h.rw.deployed[deploys++]}`;
      return op;
    });
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

  it("a first email token on a running worker that has never held one is provisioning: worker takes it at its next deploy", async () => {
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

  it("the leak path: with the old token revoked at Cloudflare first, --rotate still redeploys worker, which runs on it", async () => {
    // Before, the rotation was read from Cloudflare's list: once the leaked token was revoked by
    // hand (rotate-email-token.md), none was listed, the run counted as provisioning and exited 0,
    // and worker kept running on the revoked token until someone ran railway deploy.
    const h = staging({ worker: "fin-next-api" });
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
    // worker's deployment takes the first token, as its next railway deploy would.
    h.rw.running("worker", ref("fin-next-api"));
    h.cf.tokens.length = 0;
    h.sequence.length = 0;
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.ok, h.runtime.err());
    assert.deepEqual(writes(h), ["cf POST", "rw finPatch", "rw finDeploy"]);
    assert.deepEqual(h.rw.deployed, ["worker"]);
    const order = h.sequence;
    const patch = order.indexOf("rw finPatch");
    assert.ok(patch < order.indexOf("rw finVariables", patch), "read back");
    assert.ok(order.indexOf("rw finVariables", patch) < order.indexOf("rw finDeploy"));
    // The redeploy started after this run's write showed, and took it: the new token.
    const took = startedWith(h, "worker").at(-1);
    assert.equal(took?.[WRITE_MARKER], lastSet(h, "worker", WRITE_MARKER));
    assert.equal(took?.FIN_EMAIL_TOKEN, lastSet(h, "worker", "FIN_EMAIL_TOKEN"));
    assert.deepEqual(steps(h, "redeploy"), ["worker"]);
    assert.deepEqual(
      h
        .lines()
        .filter((l) => l.event === "rotation.redeployed")
        .map((l) => l.services),
      [["worker"]],
    );
    h.assertNoLeak([lastSet(h, "worker", "FIN_EMAIL_TOKEN") ?? ""]);
  });

  it("a rotation whose redeploy fails revokes nothing, says the rotation is not done, and a re-run finishes it", async () => {
    const h = staging();
    assert.equal(await deploy(h, manifest(h)), EXIT.ok, h.runtime.err());
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    h.rw.deployStatuses = ["DEPLOYING", "CRASHED"];
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.unavailable);
    assert.equal(h.cf.tokens.length, 2, "the old token still works");
    assert.equal(writes(h).filter((w) => w === "cf DELETE").length, 0);
    assert.match(h.runtime.err(), /the rotation is not done: worker may still run the old token/);
    assert.equal(h.records().at(-1)?.result, "failed");
    h.rw.deployStatuses = ["DEPLOYING", "SUCCESS"];
    // worker's newest deployment is the redeploy that crashed, on the digest the registered
    // deploys recorded for it: the re-run takes that digest again, and says so.
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.ok, h.runtime.err());
    assert.match(
      h.runtime.err(),
      /worker's newest deployment is CRASHED, not SUCCESS: the redeploy takes the image it is set to, the digest the registered deploys recorded for it/,
    );
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

  it("refuses a redeploy when Railway does not say which image the newest deployment runs and no registered deploy recorded the one set: email token, tunnel create and zone apply", async () => {
    // Before, an unread image only warned, and the redeploy rolled whatever image the service was
    // set to, then revoked the old token or wrote the rule.
    for (const answer of ["refused", "no-image"] as const) {
      const email = staging({ worker: "fin-next-api" });
      assert.equal(await email.run(["email", "token", "staging"]), EXIT.ok);
      setImage(email, "worker", `ghcr.io/someone/else@${DIGEST("e")}`);
      email.rw.deploymentImageAnswer = answer;
      assert.equal(
        await email.run(["email", "token", "staging", "--rotate"]),
        EXIT.refused,
        answer,
      );
      assert.match(
        email.runtime.err(),
        /Railway did not say which image worker's newest deployment runs \(SP-03\), and worker is set to an image no registered railway deploy recorded for it/,
      );
      assert.match(
        email.runtime.err(),
        /the rotation is not done: worker may still run the old token/,
      );
      assert.deepEqual(email.rw.deployed, [], answer);
      assert.equal(email.cf.tokens.length, 2, "the old token is not revoked");

      const tunnel = staging({ "cloudflared-admin": "fin-next-connector" });
      tunnel.rw.deploymentImageAnswer = answer;
      assert.equal(
        await tunnel.run(["tunnel", "create", "staging", "admin"]),
        EXIT.refused,
        answer,
      );
      assert.match(tunnel.runtime.err(), /Railway did not say which image cloudflared-admin's/);
      assert.deepEqual(tunnel.rw.deployed, [], answer);

      const zone = staging(PROOF_SERVICES);
      zone.rw.deploymentImageAnswer = answer;
      assert.equal(
        await zone.run(["zone", "apply", "staging", "--only", "rules"]),
        EXIT.refused,
        answer,
      );
      assert.deepEqual(zone.rw.deployed, [], answer);
      assert.equal(
        zone.sequence.some((c) => /^cf (POST|PATCH) .*\/rulesets/.test(c)),
        false,
        "no rule is written",
      );
    }
  });

  it("with the running image unread, a redeploy rolls only the digest the registered deploys recorded for the service", async () => {
    const h = staging();
    assert.equal(await deploy(h, manifest(h)), EXIT.ok, h.runtime.err());
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
    const rolled = h.rw.deployed.length;
    h.rw.deploymentImageAnswer = "no-image";
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.ok, h.runtime.err());
    assert.match(h.runtime.err(), /the digest the registered deploys recorded for it/);
    assert.deepEqual(h.rw.deployed.slice(rolled), ["worker"]);
    assert.equal(h.cf.tokens.length, 1);
    // Set to another digest since (a deploy stopped between its update and its deployment, or a
    // change by hand): refused, nothing deployed, the old token kept.
    setImage(h, "worker", ref("fin-next-edge"));
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.refused);
    assert.match(
      h.runtime.err(),
      /worker is set to an image other than the one the registered deploys recorded for it/,
    );
    assert.deepEqual(h.rw.deployed.slice(rolled), ["worker"]);
    assert.equal(h.cf.tokens.length, 2);
  });

  it("refuses a redeploy when the newest deployment did not end SUCCESS and the service is set to an image the registered deploys did not record: a rotation does not roll a failed deploy's image", async () => {
    // Before, only the images were compared: after a railway deploy that failed at worker (its
    // deployment ended FAILED on the new release's image while the one before kept serving), the
    // rotation's redeploy passed and rolled the failed release's image, outside the deploy's order
    // and its after-checks, then revoked the old token.
    const h = staging();
    assert.equal(await deploy(h, manifest(h)), EXIT.ok, h.runtime.err());
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
    const next = hex(40, "b");
    const images = { ...IMAGES, "fin-next-api": DIGEST("c") };
    h.rw.onUpdate = (service) => {
      h.rw.deployStatuses =
        service === "worker" ? ["DEPLOYING", "FAILED"] : ["DEPLOYING", "SUCCESS"];
    };
    assert.equal(
      await h.run([
        "railway",
        "deploy",
        "staging",
        "--release",
        next,
        "--manifest",
        manifest(h, { commit: next, images }),
      ]),
      EXIT.unavailable,
    );
    h.rw.onUpdate = undefined;
    h.rw.deployStatuses = ["DEPLOYING", "SUCCESS"];
    const worker = h.rw.instances.get("worker");
    assert.equal(worker?.image, `ghcr.io/aktharazif/fin-next-api@${images["fin-next-api"]}`);
    assert.equal(worker?.latestDeployment?.status, "FAILED");
    const rolled = h.rw.deployed.length;
    for (const answer of ["ok", "no-image"] as const) {
      h.rw.deploymentImageAnswer = answer;
      const tokens = h.cf.tokens.length;
      assert.equal(
        await h.run(["email", "token", "staging", "--rotate"]),
        EXIT.refused,
        h.runtime.err(),
      );
      assert.match(
        h.runtime.err(),
        /worker's newest deployment is FAILED, not SUCCESS, and worker is set to an image other than the one the registered deploys recorded for it, so a redeploy could roll an image nobody asked for/,
      );
      assert.match(h.runtime.err(), /the rotation is not done: worker may still run the old token/);
      assert.deepEqual(h.rw.deployed.slice(rolled), [], answer);
      assert.equal(h.cf.tokens.length, tokens + 1, "a token is minted, and none is revoked");
    }

    // zone apply: a proof service whose newest deployment FAILED, with no registered deploy that
    // recorded its image, is refused, and no rule that sends the new proof is written.
    const zone = staging(PROOF_SERVICES);
    endNewest(zone, "admin", "FAILED");
    assert.equal(
      await zone.run(["zone", "apply", "staging", "--only", "rules"]),
      EXIT.refused,
      zone.runtime.err(),
    );
    assert.match(zone.runtime.err(), /admin's newest deployment is FAILED, not SUCCESS/);
    assert.equal(zone.rw.deployed.includes("admin"), false);
    assert.equal(
      zone.sequence.some((c) => /^cf (POST|PATCH) .*\/rulesets/.test(c)),
      false,
      "no rule is written",
    );
  });

  it("an aborted newest deployment (REMOVED or REMOVING) over a running one still holds the old token: with worker's image unrecorded, email token --rotate is refused and revokes nothing", async () => {
    // Before, a newest deployment REMOVED counted as "runs nothing": the plan had no redeploy, and
    // the old token was revoked while the deployment before the aborted one still sent with it.
    for (const status of ["REMOVED", "REMOVING"]) {
      const h = staging({ worker: "fin-next-api" });
      assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
      // worker serves on the first token; a deployment after it is aborted.
      h.rw.running("worker", ref("fin-next-api"));
      const first = serving(h, "worker")?.FIN_EMAIL_TOKEN;
      assert.equal(first, lastSet(h, "worker", "FIN_EMAIL_TOKEN"));
      abortNewer(h, "worker", status);
      assert.equal(
        await h.run(["email", "token", "staging", "--rotate", "--dry-run"]),
        1,
        h.runtime.err(),
      );
      assert.match(h.runtime.out(), /~ update redeploy worker \[FIN_EMAIL_TOKEN\]/);
      assert.match(h.runtime.out(), /revoked once worker runs the new token, read back/);
      assert.match(
        h.runtime.out(),
        new RegExp(
          `worker's newest deployment is ${status}: an earlier one may still serve with the old value`,
        ),
      );
      assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.refused, status);
      assert.match(
        h.runtime.err(),
        new RegExp(
          `worker's newest deployment is ${status}, not SUCCESS .*, and worker is set to an image no registered railway deploy recorded for it, so a redeploy could roll an image nobody asked for: check by hand which image it runs, run pnpm fin railway deploy staging for the release it should run, then run this command again`,
        ),
      );
      assert.match(
        h.runtime.err(),
        /the rotation is not done: worker may still run the old token, which is not revoked; once the cause is fixed, run: pnpm fin email token staging --rotate/,
      );
      assert.deepEqual(h.rw.deployed, [], status);
      assert.equal(h.cf.tokens.length, 2, "the token worker serves on is not revoked");
      assert.equal(serving(h, "worker")?.FIN_EMAIL_TOKEN, first);
    }

    // Aborted between the plan and its redeploy step: the step is refused the same way.
    const h = staging({ worker: "fin-next-api" });
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
    h.rw.running("worker", ref("fin-next-api"));
    h.rw.ignorePatch = (service) => {
      if (service === "worker") abortNewer(h, "worker");
      return false;
    };
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.refused);
    assert.match(h.runtime.err(), /worker's newest deployment is REMOVED, not SUCCESS/);
    assert.deepEqual(h.rw.deployed, []);
    assert.equal(h.cf.tokens.length, 2, "the old token is not revoked");
  });

  it("a rotation's redeploy that was aborted (REMOVED) is finished by the re-run it names: worker is redeployed onto its recorded digest, and only then are the old tokens revoked", async () => {
    // Before, the re-run read the aborted redeploy as "worker runs nothing": it exited 0, started
    // no deployment and revoked both older tokens while worker still sent with the first.
    for (const status of ["REMOVED", "REMOVING"]) {
      const h = staging();
      assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
      assert.equal(await deploy(h, manifest(h)), EXIT.ok, h.runtime.err());
      const first = serving(h, "worker")?.FIN_EMAIL_TOKEN;
      assert.equal(first, lastSet(h, "worker", "FIN_EMAIL_TOKEN"));
      // The rotation's own redeploy is aborted: Railway marks it REMOVED, or REMOVING while the
      // abort is under way, and a re-run must read either the same way.
      h.rw.deployStatuses = ["DEPLOYING", "REMOVED"];
      assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.unavailable);
      assert.match(h.runtime.err(), /worker \(redeploy\): the deployment ended REMOVED/);
      assert.match(
        h.runtime.err(),
        /the rotation is not done: worker may still run the old token, which is not revoked; once the cause is fixed, run: pnpm fin email token staging --rotate/,
      );
      assert.equal(h.cf.tokens.length, 2);
      assert.equal(serving(h, "worker")?.FIN_EMAIL_TOKEN, first, "worker still sends with it");
      if (status === "REMOVING") endNewest(h, "worker", "REMOVING");
      assert.equal(h.rw.instances.get("worker")?.latestDeployment?.status, status);

      h.rw.deployStatuses = ["DEPLOYING", "SUCCESS"];
      const rolled = h.rw.deployed.length;
      h.sequence.length = 0;
      assert.equal(
        await h.run(["email", "token", "staging", "--rotate"]),
        EXIT.ok,
        h.runtime.err(),
      );
      assert.deepEqual(h.rw.deployed.slice(rolled), ["worker"], status);
      assert.equal(h.cf.tokens.length, 1, "both older tokens are revoked");
      const token = lastSet(h, "worker", "FIN_EMAIL_TOKEN");
      assert.notEqual(token, first);
      assert.equal(serving(h, "worker")?.FIN_EMAIL_TOKEN, token, "worker sends with the new one");
      assert.match(
        h.runtime.err(),
        new RegExp(
          `worker's newest deployment is ${status}, not SUCCESS .*: the redeploy takes the image it is set to, the digest the registered deploys recorded for it`,
        ),
      );
      const order = h.sequence;
      const started = order.indexOf("rw finDeploy");
      const revoked = order.findIndex((c) => c.startsWith("cf DELETE"));
      assert.ok(started >= 0 && revoked > started, "revoked after the redeploy");
      assert.ok(order.slice(started, revoked).includes("rw finVariables"), "and its read-back");
      assert.equal(h.records().at(-1)?.leftover, undefined);
      h.assertNoLeak([token ?? "", first ?? ""]);
    }
  });

  it("zone apply after an aborted newest deployment on admin writes no rule that sends a proof admin's serving deployment does not hold", async () => {
    // Before, admin counted as running nothing: the rule that sends the new proof was written
    // while admin's serving deployment held only the old one, so the host answered 403.
    const zone = staging(PROOF_SERVICES);
    assert.equal(
      await zone.run(["zone", "apply", "staging", "--only", "rules"]),
      EXIT.ok,
      zone.runtime.err(),
    );
    const old = sentProof(zone, "admin");
    assert.equal(heldProof(zone, "admin", "admin"), old);
    dropProofRule(zone, "admin");
    abortNewer(zone, "admin");
    const rolled = zone.rw.deployed.length;
    zone.sequence.length = 0;
    // admin's image is one no registered railway deploy recorded: refused.
    assert.equal(
      await zone.run(["zone", "apply", "staging", "--only", "rules"]),
      EXIT.refused,
      zone.runtime.err(),
    );
    assert.match(zone.runtime.err(), /admin's newest deployment is REMOVED, not SUCCESS/);
    assert.match(
      zone.runtime.err(),
      /the rotation is not done: admin may still hold the old proofs, and no rule that sends the new one is written/,
    );
    assert.deepEqual(zone.rw.deployed.slice(rolled), []);
    assert.equal(
      zone.sequence.some((c) => RULE_WRITE.test(c)),
      false,
      "no rule is written",
    );
    assert.equal(sentProof(zone, "admin"), undefined);
    assert.equal(heldProof(zone, "admin", "admin"), old);

    // admin set to the digest the registered deploys recorded: it is redeployed with the new
    // proof, read back, and only then is the rule that sends it written.
    const h = staging();
    assert.equal(await deploy(h, manifest(h)), EXIT.ok, h.runtime.err());
    assert.equal(
      await h.run(["zone", "apply", "staging", "--only", "rules"]),
      EXIT.ok,
      h.runtime.err(),
    );
    const first = sentProof(h, "admin");
    dropProofRule(h, "admin");
    abortNewer(h, "admin");
    const before = h.rw.deployed.length;
    h.sequence.length = 0;
    assert.equal(
      await h.run(["zone", "apply", "staging", "--only", "rules"]),
      EXIT.ok,
      h.runtime.err(),
    );
    assert.deepEqual(h.rw.deployed.slice(before), ["admin"]);
    assert.deepEqual(steps(h, "redeploy").at(-1), "admin");
    const sent = sentProof(h, "admin");
    assert.ok(sent !== undefined && sent !== first);
    assert.equal(
      heldProof(h, "admin", "admin"),
      sent,
      "admin serves with the proof the rule sends",
    );
    const order = h.sequence;
    const deployed = order.indexOf("rw finDeploy");
    const rule = order.findIndex((c) => RULE_WRITE.test(c));
    assert.ok(deployed >= 0 && rule > deployed, "the rule after the redeploy");
    assert.ok(order.slice(deployed, rule).includes("rw finVariables"), "and its read-back");
    h.assertNoLeak([sent ?? "", first ?? ""]);
  });

  it("a tunnel rotation whose redeploy was aborted (REMOVED) is finished by a plain re-run and by --redeploy: the connector is redeployed onto its recorded digest", async () => {
    // Before, the connector counted as running nothing: --redeploy said nothing was redeployed, a
    // plain re-run registered no rotation, and both exited 0 with no leftover while the connector
    // still ran the deleted tunnel's token.
    for (const finish of [[], ["--redeploy"]]) {
      const h = staging();
      assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.ok);
      assert.equal(await deploy(h, manifest(h)), EXIT.ok, h.runtime.err());
      const first = serving(h, "cloudflared-public")?.TUNNEL_TOKEN;
      assert.equal(first, lastSet(h, "cloudflared-public", "TUNNEL_TOKEN"));
      h.cf.tunnels.length = 0;
      h.rw.deployStatuses = ["DEPLOYING", "REMOVED"];
      assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.unavailable);
      const notDone =
        /the rotation is not done: cloudflared-public may still run the old token; once the cause is fixed, run: pnpm fin tunnel create staging public --redeploy/;
      assert.match(h.runtime.err(), notDone);
      assert.match(String(h.records().at(-1)?.leftover), notDone);
      assert.equal(serving(h, "cloudflared-public")?.TUNNEL_TOKEN, first);

      h.rw.deployStatuses = ["DEPLOYING", "SUCCESS"];
      const rolled = h.rw.deployed.length;
      assert.equal(
        await h.run(["tunnel", "create", "staging", "public", ...finish]),
        EXIT.ok,
        h.runtime.err(),
      );
      assert.doesNotMatch(h.runtime.out(), /has no deployment/);
      assert.deepEqual(h.rw.deployed.slice(rolled), ["cloudflared-public"], finish.join(" "));
      const token = lastSet(h, "cloudflared-public", "TUNNEL_TOKEN");
      assert.notEqual(token, first);
      assert.equal(serving(h, "cloudflared-public")?.TUNNEL_TOKEN, token);
      assert.equal(h.records().at(-1)?.leftover, undefined);
      h.assertNoLeak([token ?? "", first ?? ""]);
    }
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

    // A kept tunnel with no unfinished rotation in the run log: no redeploy, unless asked for.
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.ok);
    assert.match(
      h.runtime.out(),
      /the tunnel is kept, and the run log shows no rotation of cloudflared-public's token left unfinished: it is not redeployed/,
    );
    assert.equal(h.rw.deployed.length, 1);
    assert.equal(
      await h.run(["tunnel", "create", "staging", "public", "--redeploy"]),
      EXIT.ok,
      h.runtime.err(),
    );
    assert.deepEqual(h.rw.deployed, ["cloudflared-public", "cloudflared-public"]);
  });

  it("a tunnel rotation that fails before its redeploy says it is not done, and a plain re-run redeploys the connector", async () => {
    // Before, only the redeploy step said the rotation was not done; a failed read-back after the
    // new tunnel was made printed the provider error alone, and a plain re-run kept the tunnel,
    // exited 0 and said the connector ran its token while it still ran the deleted tunnel's.
    const h = staging();
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.ok);
    const first = lastSet(h, "cloudflared-public", "TUNNEL_TOKEN");
    h.rw.running("cloudflared-public", ref("fin-next-connector"));
    h.cf.tunnels.length = 0;
    h.rw.ignorePatch = (service) => service === "cloudflared-public";
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.unavailable);
    assert.equal(h.cf.tunnels.length, 1, "the new tunnel stands");
    assert.deepEqual(h.rw.deployed, []);
    const notDone =
      /the rotation is not done: cloudflared-public may still run the old token; once the cause is fixed, run: pnpm fin tunnel create staging public --redeploy/;
    assert.match(h.runtime.err(), notDone);
    const failed = h.records().at(-1);
    assert.equal(failed?.result, "failed");
    assert.match(String(failed?.leftover), notDone);

    h.rw.ignorePatch = undefined;
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.ok, h.runtime.err());
    assert.match(
      h.runtime.out(),
      /the run log shows a rotation of cloudflared-public's token whose redeploy did not pass: the tunnel is kept, and cloudflared-public is redeployed to finish it/,
    );
    assert.doesNotMatch(h.runtime.out(), /it is not redeployed/);
    assert.deepEqual(h.rw.deployed, ["cloudflared-public"]);
    const token = lastSet(h, "cloudflared-public", "TUNNEL_TOKEN");
    assert.notEqual(token, first);
    assert.equal(startedWith(h, "cloudflared-public").at(-1)?.TUNNEL_TOKEN, token);
    assert.deepEqual(steps(h, "redeploy"), ["cloudflared-public"]);
    assert.equal(h.records().at(-1)?.leftover, undefined);

    // Finished: the next plain run keeps the tunnel and redeploys nothing.
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.ok, h.runtime.err());
    assert.deepEqual(h.rw.deployed, ["cloudflared-public"]);
    h.assertNoLeak([token ?? "", first ?? ""]);
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

  it("each redeploy reads the write back just before its deployment starts, and again once it ended SUCCESS (email token, tunnel create, zone apply)", async () => {
    const email = staging({ worker: "fin-next-api" });
    assert.equal(await email.run(["email", "token", "staging"]), EXIT.ok, email.runtime.err());
    email.rw.running("worker", ref("fin-next-api"));
    assert.equal(
      await email.run(["email", "token", "staging", "--rotate"]),
      EXIT.ok,
      email.runtime.err(),
    );
    const tunnel = staging({ "cloudflared-admin": "fin-next-connector" });
    assert.equal(
      await tunnel.run(["tunnel", "create", "staging", "admin"]),
      EXIT.ok,
      tunnel.runtime.err(),
    );
    const zone = staging(PROOF_SERVICES);
    assert.equal(
      await zone.run(["zone", "apply", "staging", "--only", "rules"]),
      EXIT.ok,
      zone.runtime.err(),
    );
    const runs: Array<[H, string[]]> = [
      [email, ["worker"]],
      [tunnel, ["cloudflared-admin"]],
      [zone, Object.keys(PROOF_SERVICES)],
    ];
    for (const [h, services] of runs) {
      const calls = railwayCalls(h);
      const redeploys = calls.flatMap((c, i) => (c.startsWith("finDeploy ") ? [i] : []));
      const deployedServices = redeploys.map((i) => calls[i]?.slice("finDeploy ".length) ?? "");
      assert.deepEqual([...deployedServices].sort(), [...services].sort());
      redeploys.forEach((i, n) => {
        const service = deployedServices[n];
        const before = calls.slice(0, i).filter((c) => c !== "finServices");
        assert.equal(
          before.at(-1),
          `finVariables ${service}`,
          `read back before ${service} starts`,
        );
        const after = calls.slice(i + 1).find((c) => c !== "finDeployment");
        assert.equal(after, `finVariables ${service}`, `read back once ${service} ended SUCCESS`);
      });
    }
  });
});

describe("a rotation's dry run: read-only, and the Railway token never printed", () => {
  /** Every Railway query text a harness sends from now on. */
  function railwayQueries(h: H): string[] {
    const queries: string[] = [];
    const fetch = h.rw.fetch;
    Object.assign(h.rw, {
      fetch: async (url: string, init: RequestInit) => {
        queries.push(String(JSON.parse(String(init.body)).query));
        return fetch(url, init);
      },
    });
    return queries;
  }

  it("zone apply's dry run sends no mutation of any kind to Railway or Cloudflare, whether the services that take a new proof run or not", async () => {
    const cases: Array<[string, () => Promise<H>, RegExp | undefined]> = [
      ["no service has a deployment", async () => staging(), undefined],
      ["every proof service runs", async () => staging(PROOF_SERVICES), /~ update redeploy edge/],
      [
        "admin's rule gone and its newest deployment aborted",
        async () => {
          const h = staging(PROOF_SERVICES);
          assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.ok);
          dropProofRule(h, "admin");
          abortNewer(h, "admin");
          return h;
        },
        /~ update redeploy admin \[FIN_INGRESS_PROOFS\]/,
      ],
    ];
    for (const [name, make, redeploy] of cases) {
      const h = await make();
      const records = h.records().length;
      const patches = h.rw.patches.length;
      const deployed = h.rw.deployed.length;
      const queries = railwayQueries(h);
      h.sequence.length = 0;
      assert.equal(await h.run(["zone", "apply", "staging", "--dry-run"]), 1, h.runtime.err());
      assert.match(h.runtime.out(), /dry run: nothing was sent/, name);
      if (redeploy !== undefined) assert.match(h.runtime.out(), redeploy, name);
      assert.ok(queries.length > 0, `${name}: Railway is read`);
      for (const query of queries) assert.match(query, /^\s*query\s/, `${name}: ${query}`);
      assert.deepEqual(
        h.sequence.filter((c) => c.startsWith("cf ") && !c.startsWith("cf GET ")),
        [],
        `${name}: Cloudflare is only read`,
      );
      assert.equal(h.rw.patches.length, patches, name);
      assert.equal(h.rw.deployed.length, deployed, name);
      assert.deepEqual(h.rw.writeDeployments, [], name);
      assert.equal(h.records().length, records, `${name}: no run is registered`);
    }
  });

  it("zone apply's dry run never prints the Railway token, whether Railway accepts it or refuses it", async () => {
    for (const accepted of [true, false]) {
      const h = staging(PROOF_SERVICES);
      const planted = `rwplanted${"Z".repeat(24)}${accepted ? "A" : "R"}`;
      h.env.FIN_RAILWAY_TOKEN_FILE = writePrivate(h.dir, "planted-railway-token", planted);
      if (accepted) Object.assign(h.rw, { token: planted });
      const code = await h.run(["zone", "apply", "staging", "--dry-run"]);
      if (accepted) {
        assert.equal(code, 1, h.runtime.err());
        assert.match(h.runtime.out(), /~ update redeploy admin \[FIN_INGRESS_PROOFS\]/);
      } else {
        assert.ok(code !== EXIT.ok && code !== 1, `refused: exit ${code}`);
        assert.match(h.runtime.err(), /Not Authori[sz]ed/);
      }
      const readable = h.readable().toLowerCase();
      assert.equal(readable.includes(planted.toLowerCase()), false, "the whole token");
      assert.equal(readable.includes(planted.slice(0, 12).toLowerCase()), false, "a part of it");
      h.assertNoLeak([planted]);
    }
  });

  it("zone apply with no new proof needs no Railway token: its dry run, and a plan of settings, call Railway not once, with the token file unset or absent", async () => {
    const h = staging(PROOF_SERVICES);
    assert.equal(
      await h.run(["zone", "apply", "staging", "--only", "rules"]),
      EXIT.ok,
      h.runtime.err(),
    );
    for (const file of [undefined, join(h.dir, "no-such-railway-token")]) {
      if (file === undefined) delete h.env.FIN_RAILWAY_TOKEN_FILE;
      else h.env.FIN_RAILWAY_TOKEN_FILE = file;
      h.sequence.length = 0;
      assert.equal(
        await h.run(["zone", "apply", "staging", "--only", "rules", "--dry-run"]),
        EXIT.ok,
        h.runtime.err(),
      );
      assert.match(h.runtime.out(), /dry run: nothing to change/);
      // The whole plan: the shared zone's settings stay held (exit 1), and Railway is not needed.
      assert.equal(await h.run(["zone", "apply", "staging", "--dry-run"]), 1, h.runtime.err());
      assert.deepEqual(
        h.sequence.filter((c) => c.startsWith("rw ")),
        [],
        `Railway is never called (${file === undefined ? "unset" : "absent"})`,
      );
      assert.doesNotMatch(h.runtime.err(), /FIN_RAILWAY_TOKEN_FILE|Railway staging project token/);
    }
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

  it("the inert value is the one migrate's own parser refuses with its configuration error", () => {
    // apps/api/src/migrate/main.test.ts hands this value to migrate as its superuser reference:
    // every mode that reads it fails closed with exit 78, before any connection, so the value
    // left between runs is no credential. ops/fin may not import migrate, so the value is pinned
    // on both sides: change it in neither without the other.
    assert.equal(INERT_VALUE, "inert");
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

  it("the write marker is plain, never sealed, a run ID and a write number only, and read by no service at run time", async () => {
    assert.equal(mustBeSealed(settings, WRITE_MARKER), false);
    const h = staging({ worker: "fin-next-api" });
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
    h.rw.running("worker", ref("fin-next-api"));
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.ok, h.runtime.err());
    assert.equal(await deploy(h, manifest(h, { migrations: ["x.sql"] })), EXIT.ok, h.runtime.err());
    assert.ok(h.rw.patches.length > 5);
    for (const p of h.rw.patches) {
      const marker = p.variables[WRITE_MARKER];
      assert.deepEqual(Object.keys(marker ?? {}), ["value"], "plain: set with no isSealed");
      assert.match(marker?.value ?? "", /^run_[0-9a-hjkmnp-tv-z]{26}:[1-9][0-9]*$/);
    }
    // No service's code names it, whole or split in two: nothing at run time reads it.
    const under = (top: string, sub: string) =>
      readdirSync(join(REPO_ROOT, top))
        .map((name) => join(REPO_ROOT, top, name, sub))
        .filter((dir) => existsSync(dir));
    const roots = [
      ...under("apps", "src"),
      ...under("packages", "src"),
      join(REPO_ROOT, "ops", "watcher"),
      join(REPO_ROOT, "ops", "docker"),
    ];
    const files = roots.flatMap((root) => filesUnder(root));
    assert.ok(files.length > 100, `the scan reads the services' code (${files.length} files)`);
    assert.ok(files.includes(join(REPO_ROOT, "apps", "api", "src", "migrate", "main.ts")));
    assert.deepEqual(
      files.filter((file) => readFileSync(file, "utf8").includes("VARIABLES_RUN")),
      [],
    );
  });
});

/** Every file under a directory, outside installed and built output. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return ["node_modules", "dist", ".turbo"].includes(entry.name) ? [] : filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}
