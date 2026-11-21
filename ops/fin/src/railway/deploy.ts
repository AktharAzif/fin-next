// `pnpm fin railway deploy <env> --release <sha> --manifest <file> [--smoke]` (spec 01 §6.9's
// `deploy-staging`, adapted for the operator machine (BD-05); ARCHITECTURE §11.8's order):
//
//   1. refuse while any service has a public domain or a TCP proxy, or static egress differs from
//      §6.5 (staging is provisioned by hand, [P-13]: fix it there, then deploy);
//   2. verify every image's attestation (`gh attestation verify`: built by release.yml from main);
//   3. register the run (the lock, `deploy.started`);
//   4. when the release lists migrations, run `migrate` with the new api image and wait for its
//      `migrate.done` for this release;
//   5. roll payments, api, worker, edge, verify, admin, console: the image by digest, the start
//      command, the plain FIN_SERVICE/FIN_ENVIRONMENT/FIN_RELEASE/FIN_DRAIN_SECONDS/PORT, then a
//      deploy, waiting for SUCCESS (Railway's health check is /readyz) and the running digest;
//   6. roll cloudflared-admin and cloudflared-public only when their image changed;
//   7. check again that no service has a domain or a TCP proxy; with --smoke, fetch the public
//      health paths; write `deploy.done` with the running digests.
//
// A failed step stops the deploy: the services already rolled stay on the new release, the rest keep
// the previous one, `deploy.failed` names the step and the output prints which service runs what.

import { StaticConfigError } from "../../../../tools/static-deploy/src/config.ts";
import {
  loadReleaseManifest,
  type ReleaseManifest,
} from "../../../../tools/static-deploy/src/release.ts";
import { railway } from "../cloudflare/common.ts";
import type { Command } from "../command.ts";
import { flagBool, flagString } from "../core/args.ts";
import type { Context } from "../core/context.ts";
import { DataError, ProviderError, RefusedError, UsageError } from "../core/errors.ts";
import { hostOf } from "../core/overlay.ts";
import type { Change } from "../core/plan.ts";
import type { RailwayApi } from "./api.ts";
import { findings, type Inspection, inspectRailway } from "./inspect.ts";

const SHA = /^[0-9a-f]{40}$/;
const POLL_MS = 5_000;
const SERVICE_TIMEOUT_MS = 15 * 60_000;

const INSTANCE_UPDATE =
  "mutation finInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }";
const DEPLOY =
  "mutation finDeploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }";
// UNVERIFIED field names (SP-03): a deployment's status and its log lines.
const DEPLOYMENT = "query finDeployment($id: String!) { deployment(id: $id) { id status } }";
const LOGS =
  "query finLogs($deploymentId: String!) { deploymentLogs(deploymentId: $deploymentId, limit: 500) { message } }";

/** The image reference a service runs for a release. */
export function imageRef(repository: string, image: string, digest: string): string {
  return `${repository}${image}@${digest}`;
}

/** Verifies an image's attestation: built by release.yml, from main, in this repository. */
export function verifyAttestation(ctx: Context, ref: string): void {
  const a = ctx.settings.railway.attestation;
  const result = ctx.runtime.exec("gh", [
    "attestation",
    "verify",
    `oci://${ref}`,
    "--repo",
    a.repository,
    "--signer-workflow",
    a.workflow,
    "--source-ref",
    a.ref,
  ]);
  if (result.status !== 0) {
    throw new DataError(
      `the attestation of ${ref.split("@")[0]} does not verify (built by ${a.workflow} from ${a.ref}?)`,
    );
  }
}

async function waitForDeployment(
  ctx: Context,
  rw: RailwayApi,
  id: string,
  what: string,
): Promise<void> {
  const attempts = Math.ceil(SERVICE_TIMEOUT_MS / POLL_MS);
  for (let i = 0; i < attempts; i++) {
    const data = await rw.query<{ deployment: { status: string } }>(DEPLOYMENT, { id });
    const status = data.deployment.status;
    if (status === "SUCCESS") return;
    if (["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(status)) {
      throw new ProviderError("railway", `${what}: the deployment ended ${status}`, 0);
    }
    await ctx.runtime.sleep(POLL_MS);
  }
  throw new ProviderError(
    "railway",
    `${what}: the deployment did not finish within ${SERVICE_TIMEOUT_MS / 60_000} minutes`,
    0,
  );
}

/** Waits for `migrate.done` for this release in the migrate deployment's log (spec 01 §6.9 step 3). */
async function waitForMigrate(rw: RailwayApi, id: string, release: string): Promise<void> {
  const data = await rw.query<{ deploymentLogs: Array<{ message?: string }> }>(LOGS, {
    deploymentId: id,
  });
  for (const { message } of data.deploymentLogs) {
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(message ?? "") as Record<string, unknown>;
    } catch {
      continue;
    }
    if (line.event === "migrate.failed")
      throw new ProviderError("railway", "migrate: migrate.failed", 0);
    if (line.event === "migrate.done" && line.release === release) return;
  }
  throw new ProviderError("railway", "migrate: no migrate.done for this release in its log", 0);
}

function exposures(ctx: Context, inspection: Inspection): string[] {
  return findings(ctx, inspection)
    .filter((f) => f.check === "domain" || f.check === "tcp-proxy")
    .map((f) => `${f.service} (${f.check})`);
}

async function smoke(ctx: Context): Promise<void> {
  for (const { host, path } of ctx.settings.railway.smoke) {
    const url = `https://${hostOf(ctx.overlay, host)}${path}`;
    let status = 0;
    try {
      status = (await ctx.runtime.fetch(url, { method: "GET", redirect: "manual" })).status;
    } catch {
      status = 0;
    }
    if (status !== 200)
      throw new ProviderError("smoke", `smoke: ${url} answered ${status || "nothing"}`, status);
    ctx.out.info(`  smoke: ${url} 200`);
  }
}

interface Roll {
  service: string;
  ref: string;
  task: boolean;
}

export const railwayDeploy: Command = {
  words: ["railway", "deploy"],
  summary: "deploy a release's images to Railway staging by digest, in ARCHITECTURE §11.8's order",
  positionals: [],
  flags: [
    { name: "release", kind: "string", description: "the release's full commit SHA" },
    {
      name: "manifest",
      kind: "string",
      description: "the release manifest (release-manifest.json)",
    },
    { name: "smoke", kind: "boolean", description: "fetch the public health paths after the roll" },
  ],
  overlay: true,
  mutating: true,
  runbook: "railway-deploy.md",
  async run(ctx) {
    const release = flagString(ctx.args, "release") ?? "";
    const manifestFile = flagString(ctx.args, "manifest");
    if (!SHA.test(release))
      throw new UsageError("--release must be the full 40-character commit SHA");
    if (manifestFile === undefined) throw new UsageError("--manifest is required");
    let manifest: ReleaseManifest;
    try {
      manifest = loadReleaseManifest(manifestFile, release);
    } catch (error) {
      throw error instanceof StaticConfigError ? new DataError(error.message) : error;
    }
    const s = ctx.settings.railway;
    const rw = railway(ctx);
    const before = await inspectRailway(ctx, rw);
    const exposed = exposures(ctx, before);
    if (exposed.length > 0) {
      throw new RefusedError(
        `refusing to deploy while a service is exposed: ${exposed.join(", ")} (spec 01 §6.3)`,
      );
    }
    const egress = findings(ctx, before).filter((f) => f.check === "static-egress");
    if (egress.length > 0) {
      throw new RefusedError(
        `static egress differs from spec 01 §6.5 on ${egress.map((f) => f.service).join(", ")}; fix it by hand (P-13), then deploy`,
      );
    }

    const rolls: Roll[] = [];
    const changes: Change[] = [];
    const plan = (service: string, task: boolean, connector: boolean) => {
      const want = s.services[service];
      const image = want?.image;
      if (want === undefined || image === undefined) return;
      const digest = manifest.images[image];
      if (digest === undefined) {
        changes.push({
          kind: task ? "task" : "service",
          name: service,
          action: "keep",
          detail: "the release manifest names no image for it",
        });
        return;
      }
      const ref = imageRef(s.imageRepository, image, digest);
      const running = before.instances.get(service)?.image;
      if (connector && running === ref) {
        changes.push({ kind: "service", name: service, action: "keep", detail: "image unchanged" });
        return;
      }
      rolls.push({ service, ref, task });
      changes.push({
        kind: task ? "task" : "service",
        name: service,
        action: "update",
        detail: `${image}@${digest.slice(7, 19)}${task ? ", then wait for migrate.done" : ""}`,
      });
    };
    if (manifest.migrations.length > 0) plan("migrate", true, false);
    else
      changes.push({
        kind: "task",
        name: "migrate",
        action: "keep",
        detail: "the release lists no migrations",
      });
    for (const service of s.deployOrder) plan(service, false, false);
    for (const service of s.connectorOrder) plan(service, false, true);

    for (const ref of new Set(rolls.map((r) => r.ref))) verifyAttestation(ctx, ref);
    ctx.out.info(`attestations: ${new Set(rolls.map((r) => r.ref)).size} image(s) verified`);

    const running: Record<string, string> = {};
    let started = false;
    return ctx.applyPlan(
      `railway deploy ${release.slice(0, 12)}`,
      changes,
      async (change) => {
        if (!started) {
          started = true;
          ctx.run.line("deploy.started", "info", { release, services: rolls.length });
        }
        const roll = rolls.find((r) => r.service === change.name);
        if (roll === undefined) return;
        const want = s.services[roll.service];
        const serviceId = await rw.serviceId(roll.service);
        try {
          await rw.mutate(ctx.run, INSTANCE_UPDATE, {
            serviceId,
            environmentId: rw.environmentId,
            input: {
              source: { image: roll.ref },
              ...(want?.startCommand === undefined ? {} : { startCommand: want.startCommand }),
            },
          });
          await rw.setVariables(
            ctx.run,
            ctx.settings,
            roll.service,
            {
              FIN_SERVICE: roll.service,
              FIN_ENVIRONMENT: ctx.environment,
              FIN_RELEASE: release,
              FIN_DRAIN_SECONDS: String(want?.drainingSeconds ?? 0),
              PORT: "8080",
            },
            `pnpm fin railway deploy ${release.slice(0, 12)} (${ctx.run.id})`,
          );
          const deployed = await rw.mutate<{ serviceInstanceDeployV2: string }>(ctx.run, DEPLOY, {
            serviceId,
            environmentId: rw.environmentId,
          });
          await waitForDeployment(ctx, rw, deployed.serviceInstanceDeployV2, roll.service);
          if (roll.task) await waitForMigrate(rw, deployed.serviceInstanceDeployV2, release);
          running[roll.service] = roll.ref;
          ctx.run.line("deploy.step", "info", {
            release,
            step: roll.task ? "migrate" : "roll",
            service: roll.service,
          });
        } catch (error) {
          ctx.run.line("deploy.failed", "error", { release, step: roll.service });
          ctx.out.error(
            `deploy stopped at ${roll.service}; on the new release: ${Object.keys(running).join(", ") || "none"}`,
          );
          throw error;
        }
      },
      { release },
      async () => {
        if (!started) return {};
        const after = await inspectRailway(ctx, rw);
        const exposedAfter = exposures(ctx, after);
        if (exposedAfter.length > 0) {
          ctx.run.line("deploy.failed", "error", { release, step: "checks" });
          throw new RefusedError(
            `a service is exposed after the deploy: ${exposedAfter.join(", ")}`,
          );
        }
        for (const [service, state] of after.instances) {
          if (running[service] !== undefined && state.image !== running[service]) {
            ctx.run.line("deploy.failed", "error", { release, step: "digest" });
            throw new ProviderError("railway", `${service} does not report the deployed digest`, 0);
          }
        }
        if (flagBool(ctx.args, "smoke")) await smoke(ctx);
        ctx.run.line("deploy.done", "info", { release, services: Object.keys(running).length });
        return { running };
      },
    );
  },
};
