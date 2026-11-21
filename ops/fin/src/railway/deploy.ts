// `pnpm fin railway deploy <env> --release <sha> --manifest <file> [--smoke]` (spec 01 §6.9's
// `deploy-staging`, adapted for the operator machine (BD-05); ARCHITECTURE §11.8's order):
//
//   1. check that ci.yml's `merge` job succeeded for the commit, and verify the release manifest's
//      own attestation (release.yml, a push to main, this commit): its digests are trusted only then;
//   2. refuse while any service, listed in the settings or not, has a public domain or a TCP proxy,
//      while the project has a service the settings do not list or an instance in another
//      environment, while a database template reference (the superuser URL, under any name) stands
//      outside a run, or while static egress differs from §6.5 (staging is provisioned by hand,
//      [P-13]: fix it there, then deploy); a read Railway refused that one of these checks needs
//      refuses too, unless the operator checked it by hand and says so with a flag the run records
//      (`--accept-unchecked-egress`, `--accept-unchecked-variables`, `--accept-unchecked-settings`);
//   3. refuse a partial release: migrations with no api image, or a service the release builds no
//      image for while it runs an earlier release's image (the manifest names every service's digest,
//      ARCHITECTURE §11.7, so a rollback to it is whole);
//   4. refuse to roll a service whose Railway health check is not the settings' (/readyz, 60 s): it
//      is what makes SUCCESS mean the service is ready, schema included;
//   5. verify every image's attestation with the same pinned identity (release.yml, a push to main,
//      no self-hosted runner); the commit is bound once, through the manifest that names the digests,
//      because release.yml rebuilds only the images that changed;
//   6. register the run (the lock, `deploy.started`);
//   7. when the release lists migrations, run `migrate` with the new api image and the superuser
//      reference set for this run only (§6.6 step 6; migrate gives fin_owner a password valid for
//      the run), poll its log until `migrate.done` for this release, then remove the reference and
//      read migrate's variables back to confirm it is gone;
//   8. roll payments, api, worker, edge, verify, admin, console: the image by digest, the start
//      command, the plain FIN_SERVICE/FIN_ENVIRONMENT/FIN_RELEASE/FIN_DRAIN_SECONDS/PORT, then a
//      deploy, waiting for SUCCESS (Railway's health check is /readyz, which fails below the
//      release's minimum schema version, recorded with every step) and the running digest;
//   9. roll cloudflared-admin and cloudflared-public unless they run the release's image now (set
//      to it, with a newest deployment that ended SUCCESS on it);
//  10. check again everything steps 2 and 4 refuse on, and that every service is set to the digest
//      recorded for it with a newest deployment that ended SUCCESS; with --smoke, fetch the public
//      health paths; write `deploy.done`, and record
//      in `run.done` the digest of every service on the release, rolled or kept, which `railway
//      verify` checks.
//
// A failed step stops the deploy: the services already rolled stay on the new release, the rest keep
// the previous one, `deploy.failed` names the step and the output prints which service runs what.

import { own, type ReleaseManifest } from "../../../../tools/static-deploy/src/release.ts";
import { railway } from "../cloudflare/common.ts";
import type { Command } from "../command.ts";
import { flagBool, flagString } from "../core/args.ts";
import type { Context } from "../core/context.ts";
import { DataError, ProviderError, RefusedError, UsageError } from "../core/errors.ts";
import { hostOf } from "../core/overlay.ts";
import type { Change } from "../core/plan.ts";
import { checkMergeJob, verifiedManifest, verifyImage } from "../release/provenance.ts";
import type { RailwayApi } from "./api.ts";
import {
  BOOTSTRAP_REFERENCE,
  findings,
  type Inspection,
  inspectRailway,
  isRefusal,
  REFUSED_CHECKS,
  ROLL_CHECKS,
  readVariables,
} from "./inspect.ts";
import { imageRef, readRunning } from "./running.ts";

const SHA = /^[0-9a-f]{40}$/;
const POLL_MS = 5_000;
const SERVICE_TIMEOUT_MS = 15 * 60_000;
const FAILED = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

const INSTANCE_UPDATE =
  "mutation finInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }";
const DEPLOY =
  "mutation finDeploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }";
// UNVERIFIED field names (SP-03): a deployment's status and its log lines, and removing a variable.
const DEPLOYMENT = "query finDeployment($id: String!) { deployment(id: $id) { id status } }";
const LOGS =
  "query finLogs($deploymentId: String!) { deploymentLogs(deploymentId: $deploymentId, limit: 500) { message } }";
const VARIABLE_DELETE =
  "mutation finVariableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }";

async function deploymentStatus(rw: RailwayApi, id: string): Promise<string> {
  const data = await rw.query<{ deployment: { status: string } }>(DEPLOYMENT, { id });
  return data.deployment.status;
}

async function waitForDeployment(
  ctx: Context,
  rw: RailwayApi,
  id: string,
  what: string,
): Promise<void> {
  const attempts = Math.ceil(SERVICE_TIMEOUT_MS / POLL_MS);
  for (let i = 0; i < attempts; i++) {
    const status = await deploymentStatus(rw, id);
    if (status === "SUCCESS") return;
    if (FAILED.has(status)) {
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

/**
 * What the migrate deployment's log says so far: "done" once `migrate.done` for this release is
 * there, "failed" on any `migrate.failed`, undefined otherwise. A line that is not a JSON object
 * (plain text, `null`, a number) is skipped.
 */
export function migrateOutcome(
  lines: ReadonlyArray<{ message?: unknown }>,
  release: string,
): "done" | "failed" | undefined {
  for (const { message } of lines) {
    if (typeof message !== "string") continue;
    let line: unknown;
    try {
      line = JSON.parse(message);
    } catch {
      continue;
    }
    if (typeof line !== "object" || line === null || Array.isArray(line)) continue;
    const { event, release: lineRelease } = line as Record<string, unknown>;
    if (event === "migrate.failed") return "failed";
    if (event === "migrate.done" && lineRelease === release) return "done";
  }
  return undefined;
}

/**
 * Waits for `migrate.done` for this release (spec 01 §6.9 step 3). `migrate` has no health check, so
 * Railway's SUCCESS says only that the container started, and its log reaches the API late: each
 * pass reads the log, then the deployment's status, until the line arrives, `migrate.failed` or a
 * failed deployment stops it, or the time runs out. A failed status gets one last log read, in
 * case the line was still on its way.
 */
async function waitForMigrate(
  ctx: Context,
  rw: RailwayApi,
  id: string,
  release: string,
): Promise<void> {
  const read = async () => {
    const data = await rw.query<{ deploymentLogs: Array<{ message?: unknown }> | null }>(LOGS, {
      deploymentId: id,
    });
    const outcome = migrateOutcome(data.deploymentLogs ?? [], release);
    if (outcome === "failed") throw new ProviderError("railway", "migrate: migrate.failed", 0);
    return outcome === "done";
  };
  const attempts = Math.ceil(SERVICE_TIMEOUT_MS / POLL_MS);
  for (let i = 0; i < attempts; i++) {
    if (await read()) return;
    const status = await deploymentStatus(rw, id);
    if (FAILED.has(status)) {
      await ctx.runtime.sleep(POLL_MS);
      if (await read()) return;
      throw new ProviderError(
        "railway",
        `migrate: the deployment ended ${status} with no migrate.done for this release`,
        0,
      );
    }
    await ctx.runtime.sleep(POLL_MS);
  }
  throw new ProviderError(
    "railway",
    `migrate: no migrate.done for this release within ${SERVICE_TIMEOUT_MS / 60_000} minutes`,
    0,
  );
}

/**
 * The findings a deploy refuses on: exposure, unknown services, other environments and references
 * on any service, and, on each service it rolls, a health check that is not the settings'.
 */
export function refusals(
  ctx: Context,
  inspection: Inspection,
  rolled: ReadonlySet<string> = new Set(),
): string[] {
  return findings(ctx, inspection)
    .filter(
      (f) => REFUSED_CHECKS.has(f.check) || (ROLL_CHECKS.has(f.check) && rolled.has(f.service)),
    )
    .map((f) => `${f.service} (${f.check})`);
}

/** What the operator accepted on their own word, because Railway refused the read (recorded). */
interface Accepted {
  egress: boolean;
  variables: boolean;
  settings: boolean;
}

/**
 * The refused reads a deploy depends on that the operator did not accept: the variables (the
 * superuser-reference check) and the instance settings (the health check SUCCESS stands on).
 */
function unreadRefusals(inspection: Inspection, accepted: Accepted): string[] {
  const out: string[] = [];
  if (inspection.variablesUnread.length > 0 && !accepted.variables) {
    out.push(
      `Railway refused the variables read for ${inspection.variablesUnread.join(", ")}, so no database template reference (the superuser URL) can be ruled out there; check spec 01 §6.3 by hand, then pass --accept-unchecked-variables`,
    );
  }
  if (inspection.settingsUnread && !accepted.settings) {
    out.push(
      "Railway refused the instance settings read, so the health checks the roll stands on (/readyz, 60 s) could not be checked; check them by hand, then pass --accept-unchecked-settings",
    );
  }
  return out;
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
    {
      name: "accept-unchecked-egress",
      kind: "boolean",
      description: "deploy although Railway refused the static egress read (checked by hand)",
    },
    {
      name: "accept-unchecked-variables",
      kind: "boolean",
      description:
        "deploy although Railway refused a variables read (no superuser reference, checked by hand)",
    },
    {
      name: "accept-unchecked-settings",
      kind: "boolean",
      description:
        "deploy although Railway refused the instance settings read (health checks, checked by hand)",
    },
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
    checkMergeJob(ctx, release);
    const manifest: ReleaseManifest = verifiedManifest(ctx, manifestFile, release);
    const schema = manifest.minimumSchemaVersion;
    ctx.out.info(
      `minimum schema version: ${schema ?? "none"} (each service's /readyz fails below it; Railway's health check holds SUCCESS until /readyz passes)`,
    );
    const s = ctx.settings.railway;
    const rw = railway(ctx);
    const accepted: Accepted = {
      egress: flagBool(ctx.args, "accept-unchecked-egress"),
      variables: flagBool(ctx.args, "accept-unchecked-variables"),
      settings: flagBool(ctx.args, "accept-unchecked-settings"),
    };
    const before = await inspectRailway(ctx, rw);
    for (const n of before.notChecked) ctx.out.info(`  ? not checked: ${n}`);
    const refused = refusals(ctx, before);
    if (refused.length > 0) {
      throw new RefusedError(
        `refusing to deploy: ${refused.join(", ")} (spec 01 §6.1, §6.3; NB-07); run railway verify for the details`,
      );
    }
    const egress = findings(ctx, before).filter((f) => f.check === "static-egress");
    if (egress.length > 0) {
      throw new RefusedError(
        `static egress differs from spec 01 §6.5 on ${egress.map((f) => f.service).join(", ")}; fix it by hand (P-13), then deploy`,
      );
    }
    const egressUnchecked = before.egressUnread.length > 0;
    if (egressUnchecked && !accepted.egress) {
      throw new RefusedError(
        `Railway refused the static egress read for ${before.egressUnread.join(", ")}, so the egress check could not run; check spec 01 §6.5 by hand, then pass --accept-unchecked-egress`,
      );
    }
    const unread = unreadRefusals(before, accepted);
    if (unread.length > 0) throw new RefusedError(unread.join("; "));
    const variablesUnchecked = before.variablesUnread.length > 0;
    const settingsUnchecked = before.settingsUnread;
    for (const [taken, what] of [
      [egressUnchecked, "static egress was not read (--accept-unchecked-egress)"],
      [variablesUnchecked, "some variables were not read (--accept-unchecked-variables)"],
      [settingsUnchecked, "the health checks were not read (--accept-unchecked-settings)"],
    ] as const) {
      if (taken) ctx.out.warn(`${what}; deploying on the operator's word`);
    }

    /**
     * The connectors that run the release's image now, so they need no roll: set to it, with a
     * newest deployment that ended SUCCESS on it. One whose deployment Railway does not describe
     * rolls (a roll is harmless; keeping a connector that does not run the image is not).
     */
    const runsRelease = new Set<string>();
    for (const service of s.connectorOrder) {
      const image = own(s.services, service)?.image;
      const digest = image === undefined ? undefined : own(manifest.images, image);
      if (image === undefined || digest === undefined) continue;
      const ref = imageRef(s.imageRepository, image, digest);
      const instance = before.instances.get(service);
      if (instance?.image !== ref) continue;
      const running = await readRunning(ctx, rw, service, instance);
      if (running.status === "SUCCESS" && running.image === ref) runsRelease.add(service);
    }

    const rolls: Roll[] = [];
    const changes: Change[] = [];
    /** Every service on the release after the run: rolled, or kept because its image is unchanged. */
    const onRelease = new Map<string, string>();
    const notBuilt: string[] = [];
    const plan = (service: string, task: boolean, connector: boolean) => {
      const want = own(s.services, service);
      const image = want?.image;
      if (want === undefined || image === undefined) {
        throw new DataError(`${service} has no image in the settings`);
      }
      const digest = own(manifest.images, image);
      const running = before.instances.get(service)?.image;
      if (digest === undefined) {
        if (task) {
          throw new DataError(
            `the release lists migrations but its manifest names no ${image} for migrate; no service rolls onto a schema that was not migrated`,
          );
        }
        if (running !== null && running !== undefined && running !== "") {
          throw new DataError(
            `the release manifest names no ${image}, and ${service} runs an earlier release's image; a partial release is refused`,
          );
        }
        notBuilt.push(service);
        changes.push({
          kind: "service",
          name: service,
          action: "keep",
          detail: `the release builds no ${image}, and ${service} has never run an image`,
        });
        return;
      }
      const ref = imageRef(s.imageRepository, image, digest);
      if (connector && runsRelease.has(service)) {
        onRelease.set(service, ref);
        changes.push({
          kind: "service",
          name: service,
          action: "keep",
          detail: "runs the release's image",
        });
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

    const rolled = new Set(rolls.map((r) => r.service));
    const tasks = new Set(rolls.filter((r) => r.task).map((r) => r.service));
    const health = refusals(ctx, before, rolled).filter((r) => !refused.includes(r));
    if (health.length > 0) {
      throw new RefusedError(
        `refusing to roll: ${health.join(", ")}; Railway's health check (/readyz, 60 s) is what holds SUCCESS until a service is ready on its schema (spec 01 §6.2, §6.9 step 4); fix it by hand (P-13), then deploy`,
      );
    }

    const refs = new Set(rolls.map((r) => r.ref));
    for (const ref of refs) verifyImage(ctx, ref);
    ctx.out.info(
      `attestations: ${refs.size} image(s) verified (release.yml, a push to main), each named by this commit's attested manifest`,
    );

    let started = false;
    const reference = s.bootstrapReference;
    /** Confirms migrate's variables no longer hold the superuser reference (spec 01 §6.3, §6.6). */
    const confirmRemoved = async (serviceId: string): Promise<void> => {
      let left: string[];
      try {
        const v = await readVariables(rw, ctx.settings, "migrate", serviceId);
        left = [
          ...new Set([
            ...v.templateReferences,
            ...v.names.filter((n) => n === reference.variable || n === BOOTSTRAP_REFERENCE),
          ]),
        ];
      } catch (error) {
        if (!isRefusal(error) || !accepted.variables) throw error;
        ctx.out.warn(
          `Railway refused migrate's variables read: check by hand now that ${reference.variable} is gone from migrate (spec 01 §6.3)`,
        );
        return;
      }
      if (left.length > 0) {
        throw new RefusedError(
          `${left.includes(reference.variable) ? reference.variable : left.join(", ")} is still on migrate after its removal: remove it by hand now (spec 01 §6.3, §6.6); no service rolls while it stands`,
        );
      }
    };
    const runMigrate = async (serviceId: string, roll: Roll) => {
      let failure: unknown;
      try {
        const deployed = await rw.mutate<{ serviceInstanceDeployV2: string }>(ctx.run, DEPLOY, {
          serviceId,
          environmentId: rw.environmentId,
        });
        await waitForMigrate(ctx, rw, deployed.serviceInstanceDeployV2, release);
      } catch (error) {
        failure = error;
      }
      try {
        await rw.mutate(ctx.run, VARIABLE_DELETE, {
          input: {
            projectId: rw.projectId,
            environmentId: rw.environmentId,
            serviceId,
            name: reference.variable,
          },
        });
        await confirmRemoved(serviceId);
      } catch (error) {
        ctx.out.error(
          `${reference.variable} could not be removed from ${roll.service}: remove it by hand now (spec 01 §6.3, §6.6)`,
        );
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    };
    const unchecked = {
      ...(egressUnchecked ? { egressUnchecked: true } : {}),
      ...(variablesUnchecked ? { variablesUnchecked: true } : {}),
      ...(settingsUnchecked ? { settingsUnchecked: true } : {}),
    };
    return ctx.applyPlan(
      `railway deploy ${release.slice(0, 12)}`,
      changes,
      async (change) => {
        if (!started) {
          started = true;
          ctx.run.line("deploy.started", "info", {
            release,
            services: rolls.length,
            minimumSchemaVersion: schema,
          });
        }
        const roll = rolls.find((r) => r.service === change.name);
        if (roll === undefined) return;
        const want = own(s.services, roll.service);
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
              ...(roll.task
                ? { FIN_RUN_ID: ctx.run.id, [reference.variable]: reference.value }
                : {}),
            },
            `pnpm fin railway deploy ${release.slice(0, 12)} (${ctx.run.id})`,
          );
          if (roll.task) await runMigrate(serviceId, roll);
          else {
            const deployed = await rw.mutate<{ serviceInstanceDeployV2: string }>(ctx.run, DEPLOY, {
              serviceId,
              environmentId: rw.environmentId,
            });
            await waitForDeployment(ctx, rw, deployed.serviceInstanceDeployV2, roll.service);
          }
          onRelease.set(roll.service, roll.ref);
          ctx.run.line("deploy.step", "info", {
            release,
            step: roll.task ? "migrate" : "roll",
            service: roll.service,
            minimumSchemaVersion: schema,
          });
        } catch (error) {
          ctx.run.line("deploy.failed", "error", { release, step: roll.service });
          const rolledSoFar = rolls.filter((r) => onRelease.has(r.service)).map((r) => r.service);
          ctx.out.error(
            `deploy stopped at ${roll.service}; on the new release: ${rolledSoFar.join(", ") || "none"}`,
          );
          throw error;
        }
      },
      { release, minimumSchemaVersion: schema, ...unchecked },
      async () => {
        if (!started) return {};
        const after = await inspectRailway(ctx, rw);
        const problems = [...refusals(ctx, after, rolled), ...unreadRefusals(after, accepted)];
        if (problems.length > 0) {
          ctx.run.line("deploy.failed", "error", { release, step: "checks" });
          throw new RefusedError(`after the deploy: ${problems.join(", ")}`);
        }
        for (const [service, ref] of onRelease) {
          const instance = after.instances.get(service);
          if (instance?.image !== ref) {
            ctx.run.line("deploy.failed", "error", { release, step: "digest" });
            throw new ProviderError("railway", `${service} does not report the deployed digest`, 0);
          }
          // migrate runs to its end and serves nothing; migrate.done is its proof (step 7).
          if (!tasks.has(service) && instance.latestDeployment?.status !== "SUCCESS") {
            ctx.run.line("deploy.failed", "error", { release, step: "digest" });
            throw new ProviderError(
              "railway",
              `${service}'s newest deployment is ${instance.latestDeployment?.status ?? "missing"}, not SUCCESS`,
              0,
            );
          }
        }
        if (flagBool(ctx.args, "smoke")) await smoke(ctx);
        ctx.run.line("deploy.done", "info", {
          release,
          services: onRelease.size,
          minimumSchemaVersion: schema,
          ...(notBuilt.length > 0 ? { notBuilt } : {}),
        });
        return {
          running: Object.fromEntries(onRelease),
          ...(notBuilt.length > 0 ? { notBuilt } : {}),
        };
      },
    );
  },
};
