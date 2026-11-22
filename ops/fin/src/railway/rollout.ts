// The deployments `pnpm fin` starts, and the proof that a variable write took effect. The rule is
// the steward's ruling of 22 Nov: no deploy nobody asked for, which is not never deploy.
//
//   1. Provisioning and configuration writes commit with skipDeploys: true and start nothing; the
//      service takes them at its next deployment (`railway deploy`).
//   2. A rotation (a secret a running service holds: the email token, a tunnel token, the ingress
//      proofs) commits with skipDeploys: true, is read back until it shows, then redeploys each
//      service that has a deployment, as a step of its own plan (`run.step` kind `redeploy`, and a
//      `rotation.redeployed` line naming the service and the variables), waits for SUCCESS and
//      reads back again. The rotation is done only then, and only then may the old secret be
//      revoked or a rule start sending the new one. Only a service with no deployment holds
//      nothing: it takes the value at its next deployment, and nothing is deployed for it here. A
//      newest deployment of any status may hold the old value, REMOVED and REMOVING included
//      (Railway marks an aborted deployment REMOVED, and the one before it keeps serving).
//   3. No variable is deleted (api.ts): a value no deployment may carry is overwritten with
//      INERT_VALUE, with skipDeploys: true, and waits for removal (railway verify lists it).
//   4. A read-back is proof only once it shows the write: the write's own marker (WRITE_MARKER, set
//      in the same commit), each sealed name present and sealed, and each plain value as written.
//      A read that merely lacks what the write replaced proves nothing: a read from before the
//      write lacks it too.
//
// The redeploy reads the write back before it starts, not only after: a deployment takes the
// variables Railway holds when it starts, so one started before the write shows could take the old
// value, and a read-back after it would then prove the wrong thing.

import type { Context } from "../core/context.ts";
import { ProviderError, RefusedError } from "../core/errors.ts";
import type { Change } from "../core/plan.ts";
import type { RailwayApi, Written } from "./api.ts";
import {
  type InstanceState,
  isRefusal,
  READ_BACK_READS,
  readInstances,
  readVariablesBack,
  type Variables,
} from "./inspect.ts";
import { readRunning } from "./running.ts";
import { lastDeployed } from "./verify.ts";

export const POLL_MS = 5_000;
export const SERVICE_TIMEOUT_MS = 15 * 60_000;
export const FAILED: ReadonlySet<string> = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

export const DEPLOY =
  "mutation finDeploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }";
// UNVERIFIED field names (SP-03): a deployment's status.
const DEPLOYMENT = "query finDeployment($id: String!) { deployment(id: $id) { id status } }";

export async function deploymentStatus(rw: RailwayApi, id: string): Promise<string> {
  const data = await rw.query<{ deployment: { status: string } }>(DEPLOYMENT, { id });
  return data.deployment.status;
}

/** Starts one deployment of a service, with its instance and variables as they stand. */
export async function startDeployment(
  ctx: Context,
  rw: RailwayApi,
  service: string,
): Promise<string> {
  const serviceId = await rw.serviceId(service);
  const deployed = await rw.mutate<{ serviceInstanceDeployV2: string }>(ctx.run, DEPLOY, {
    serviceId,
    environmentId: rw.environmentId,
  });
  const id = deployed.serviceInstanceDeployV2;
  ctx.masker.register(id, `<railway-deployment:${service}>`);
  return id;
}

/** Waits for a deployment to end SUCCESS; a failed status, a stop or the time limit ends it. */
export async function waitForDeployment(
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
    // A stop cuts the wait short (a StoppedError), so the run closes within its settle time.
    await ctx.run.pause(POLL_MS);
  }
  throw new ProviderError(
    "railway",
    `${what}: the deployment did not finish within ${SERVICE_TIMEOUT_MS / 60_000} minutes`,
    0,
  );
}

/** Whether a read shows the write (rule 4): its marker, its sealed names and its plain values. */
export function showsWrite(read: Variables, written: Written): boolean {
  return (
    read.marker === written.marker &&
    written.sealed.every((name) => read.sealed.includes(name)) &&
    read.differs.length === 0
  );
}

/**
 * Reads a service's variables back until they show the write (rule 4), for a bounded time, and
 * returns that read; `also` adds a condition the read must meet too. Throws when the write never
 * showed: the write may still land later, so nothing that depends on it may be sent. A refusal of
 * the read throws like any read.
 */
export async function confirmWritten(
  ctx: Context,
  rw: RailwayApi,
  written: Written,
  also: (read: Variables) => boolean = () => true,
): Promise<Variables> {
  const read = await readVariablesBack(
    rw,
    ctx.settings,
    written.service,
    written.serviceId,
    ctx.runtime.sleep,
    (v) => showsWrite(v, written) && also(v),
    written.plain,
  );
  if (!showsWrite(read, written)) {
    throw new ProviderError(
      "railway",
      `${written.service}: Railway's variables read did not show this run's write within ${READ_BACK_READS} reads; it may still land, so nothing that depends on it is sent`,
      0,
    );
  }
  return read;
}

/**
 * Whether a service may run a deployment that holds the variables it started with: whenever it has
 * a newest deployment, whatever that deployment's status. Only a service with none (it never
 * deployed, or Railway reports no deployment for it) holds nothing.
 *
 * A newest deployment's status says nothing about what serves. One that FAILED or was SKIPPED
 * leaves the deployment before it serving; so does one that was aborted, which Railway marks
 * REMOVED (REMOVING while that is under way). Whether anything still runs could be read only from
 * a field that lists the running deployments (ServiceInstance.activeDeployments), which neither
 * Railway's public API documentation nor SP-03 confirms; until it does, nothing here decides that
 * a service was taken down. A REMOVED or REMOVING newest deployment counts as holding the old
 * value, like any that did not end SUCCESS (redeploy).
 */
function holdsDeployment(instance: InstanceState | undefined): boolean {
  return (instance?.latestDeployment ?? null) !== null;
}

/** Statuses of a newest deployment that may be an aborted one, or a service taken down. */
const REMOVAL: ReadonlySet<string> = new Set(["REMOVED", "REMOVING"]);

/** Why a newest deployment of a status that is no SUCCESS still counts as holding the old value. */
function removalNote(status: string): string {
  return REMOVAL.has(status)
    ? " (Railway marks an aborted deployment REMOVED, and the one before it may still serve)"
    : "";
}

/**
 * The services of a list that have a deployment that may hold the old value: each holds the
 * variables it started with, so a rotated secret reaches it only through a redeploy. A service with
 * none takes it at its next deployment. A service whose newest deployment is REMOVED or REMOVING
 * is one of them, and the plan says why, and that its redeploy starts it again if it was taken
 * down.
 */
export async function deployedOf(
  ctx: Context,
  rw: RailwayApi,
  services: readonly string[],
): Promise<Set<string>> {
  const instances = await readInstances(ctx, rw);
  const held = new Set<string>();
  for (const service of services) {
    const instance = instances.get(service);
    if (instance?.inEnvironment !== true || !holdsDeployment(instance)) continue;
    held.add(service);
    const status = instance.latestDeployment?.status ?? "";
    if (REMOVAL.has(status)) {
      ctx.out.info(
        `${service}'s newest deployment is ${status}: an earlier one may still serve with the old value (Railway marks an aborted deployment REMOVED), so ${service} counts as holding it. Its redeploy goes only onto the digest the registered deploys recorded for it, and starts ${service} again if it was taken down`,
      );
    }
  }
  return held;
}

/** The plan step that redeploys a service so it takes the rotated variables (rule 2). */
export function redeployChange(service: string, variables: readonly string[]): Change {
  return {
    kind: "redeploy",
    name: service,
    action: "update",
    fields: [...variables],
    detail:
      "it holds the old value: the commit starts no deployment, so one deployment takes it, read back before and after",
  };
}

/**
 * Redeploys one service so it takes a rotated value (rule 2), after the write showed (rule 4):
 * refuses when the service is set to an image its newest deployment does not run (the redeploy
 * would roll that image: a deploy nobody asked for), starts one deployment, waits for SUCCESS, and
 * reads back: the variables still show the write, and the service's newest deployment is this one,
 * ended SUCCESS. Then writes `rotation.redeployed`. Only a service that no longer has a deployment
 * gets none (holdsDeployment).
 *
 * A service runs an image only when its newest deployment ended SUCCESS on it (running.ts). When
 * that deployment did not end SUCCESS (a `railway deploy` that failed at the service leaves it set
 * to the failed release's image while the deployment before serves; an aborted deployment, REMOVED,
 * leaves the one before it serving too), or Railway does not say which image it runs (a refused
 * read, or a meta that names no image; SP-03), neither is passing: the redeploy goes on only when
 * the service is set to the digest the registered deploys recorded for it (railway verify's digest
 * check), an image a `railway deploy` verified and rolled, and is refused otherwise, naming the
 * service and the command to run first.
 */
export async function redeploy(
  ctx: Context,
  rw: RailwayApi,
  written: Written,
  variables: readonly string[],
): Promise<void> {
  const service = written.service;
  const instance = (await readInstances(ctx, rw)).get(service);
  if (!holdsDeployment(instance)) {
    ctx.out.info(
      `  ${service} has no deployment: it takes the new value at its next (railway deploy); nothing is deployed for it here`,
    );
    return;
  }
  const deploy = `pnpm fin railway deploy ${ctx.environment}`;
  const running = await readRunning(ctx, rw, service, instance);
  if (running.status !== "SUCCESS" || typeof running.image !== "string") {
    const why =
      running.status !== "SUCCESS"
        ? `${service}'s newest deployment is ${running.status ?? "missing"}, not SUCCESS${removalNote(running.status ?? "")}`
        : `Railway did not say which image ${service}'s newest deployment runs (SP-03)`;
    const recorded = lastDeployed(ctx).get(service);
    if (recorded === undefined || recorded !== instance?.image) {
      throw new RefusedError(
        `${why}, and ${service} is set to ${recorded === undefined ? "an image no registered railway deploy recorded for it" : "an image other than the one the registered deploys recorded for it"}, so a redeploy could roll an image nobody asked for: check by hand which image it runs, run ${deploy} for the release it should run, then run this command again`,
      );
    }
    ctx.out.warn(
      `${why}: the redeploy takes the image it is set to, the digest the registered deploys recorded for it`,
    );
  } else if (running.image !== instance?.image) {
    throw new RefusedError(
      `${service} is set to an image its newest deployment does not run, so a redeploy would roll that image: run ${deploy} for the release it should run, then run this command again`,
    );
  }
  // The write showed before this deployment starts, so the deployment takes it.
  await confirmWritten(ctx, rw, written);
  const id = await startDeployment(ctx, rw, service);
  await waitForDeployment(ctx, rw, id, `${service} (redeploy)`);
  await confirmWritten(ctx, rw, written);
  const newest = (await readInstances(ctx, rw)).get(service)?.latestDeployment ?? null;
  if (newest?.id !== id || newest.status !== "SUCCESS") {
    throw new ProviderError(
      "railway",
      `${service}: its newest deployment is no longer the redeploy that took the new value, ended SUCCESS`,
      0,
    );
  }
  // `service` is the envelope's own field (always `ops`), so the services go by their own name.
  ctx.run.line("rotation.redeployed", "info", {
    command: ctx.run.command,
    services: [service],
    variables: [...variables],
  });
}

/**
 * Confirms a write (rule 4) unless Railway refused the variables read and the operator accepted
 * that (`railway deploy --accept-unchecked-variables`): then it warns and returns undefined.
 */
export async function confirmWrittenOrAccepted(
  ctx: Context,
  rw: RailwayApi,
  written: Written,
  accepted: boolean,
): Promise<Variables | undefined> {
  try {
    return await confirmWritten(ctx, rw, written);
  } catch (error) {
    if (!isRefusal(error) || !accepted) throw error;
    ctx.out.warn(
      `Railway refused ${written.service}'s variables read, so its write could not be read back before its deployment (accepted: --accept-unchecked-variables)`,
    );
    return undefined;
  }
}
