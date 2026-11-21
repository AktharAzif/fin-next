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
//      revoked or a rule start sending the new one. A service with no deployment holds nothing: it
//      takes the value at its first deployment, and nothing is deployed for it here.
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
  isRefusal,
  READ_BACK_READS,
  readInstances,
  readVariablesBack,
  type Variables,
} from "./inspect.ts";
import { readRunning } from "./running.ts";

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
 * The services of a list that have a deployment: each holds the variables it started with, so a
 * rotated secret reaches it only through a redeploy. A service with none takes it at its first.
 */
export async function deployedOf(
  ctx: Context,
  rw: RailwayApi,
  services: readonly string[],
): Promise<Set<string>> {
  const instances = await readInstances(ctx, rw);
  return new Set(
    services.filter((service) => {
      const instance = instances.get(service);
      return instance?.inEnvironment === true && (instance.latestDeployment ?? null) !== null;
    }),
  );
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
 * ended SUCCESS. Then writes `rotation.redeployed`. A service that no longer has a deployment gets
 * none.
 */
export async function redeploy(
  ctx: Context,
  rw: RailwayApi,
  written: Written,
  variables: readonly string[],
): Promise<void> {
  const service = written.service;
  const instance = (await readInstances(ctx, rw)).get(service);
  if ((instance?.latestDeployment ?? null) === null) {
    ctx.out.info(
      `  ${service} has no deployment: it takes the new value at its first (railway deploy); nothing is deployed for it here`,
    );
    return;
  }
  const running = await readRunning(ctx, rw, service, instance);
  if (typeof running.image === "string" && running.image !== instance?.image) {
    throw new RefusedError(
      `${service} is set to an image its newest deployment does not run, so a redeploy would roll that image: run railway deploy for the release it should run, then run this command again`,
    );
  }
  if (running.image === undefined) {
    ctx.out.warn(
      `Railway did not say which image ${service}'s newest deployment runs (SP-03): the redeploy takes the image the service is set to`,
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
