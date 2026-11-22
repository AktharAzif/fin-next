// What the Railway services run now (spec 01 §6.9, S0-06; ARCHITECTURE §11.8), read from Railway
// and never from a run log: the log says what a deploy once did, not what serves now. A later
// deploy of another release, a failed one, or a change by hand moves a service off a release
// without leaving any record of it on this machine.
//
// A service runs an image when its newest deployment ended SUCCESS and that deployment runs the
// image. The instance's source image alone is only what the next deployment will take: a deploy
// that failed after setting it, or a rollback in Railway's dashboard, leaves the two apart. The
// deployment's image is read from its `meta` (UNVERIFIED, SP-03). A read Railway refuses, or a
// meta that names no image, leaves that image unread, and no caller treats unread as passing.

import { own, type ReleaseManifest } from "../../../../tools/static-deploy/src/release.ts";
import type { Context } from "../core/context.ts";
import type { RailwayApi } from "./api.ts";
import { type InstanceState, isRefusal, readInstances } from "./inspect.ts";

// UNVERIFIED field name (SP-03): a deployment's meta, a JSON value whose `image` is the image the
// deployment runs.
const DEPLOYMENT_IMAGE =
  "query finDeploymentImage($id: String!) { deployment(id: $id) { id status meta } }";

export interface Running {
  /** The newest deployment's status; null when the service has no deployment. */
  status: string | null;
  /**
   * The image the newest deployment runs: null when there is no deployment, undefined when Railway
   * refused the read or the deployment's meta names no image.
   */
  image: string | null | undefined;
}

/** The image reference a service runs for a release. */
export function imageRef(repository: string, image: string, digest: string): string {
  return `${repository}${image}@${digest}`;
}

/** Reads what one service runs now: its newest deployment's status and image. */
export async function readRunning(
  ctx: Context,
  rw: RailwayApi,
  service: string,
  instance: InstanceState | undefined,
): Promise<Running> {
  const latest = instance?.latestDeployment ?? null;
  if (latest === null) return { status: null, image: null };
  ctx.masker.register(latest.id, `<railway-deployment:${service}>`);
  let answer: { deployment: { status?: unknown; meta?: unknown } | null };
  try {
    answer = await rw.query(DEPLOYMENT_IMAGE, { id: latest.id });
  } catch (error) {
    if (!isRefusal(error)) throw error;
    return { status: latest.status, image: undefined };
  }
  const deployment = answer.deployment;
  const status = typeof deployment?.status === "string" ? deployment.status : latest.status;
  const meta = deployment?.meta;
  const image =
    typeof meta === "object" &&
    meta !== null &&
    !Array.isArray(meta) &&
    Object.hasOwn(meta, "image")
      ? (meta as Record<string, unknown>).image
      : undefined;
  return { status, image: typeof image === "string" && image !== "" ? image : undefined };
}

/**
 * The image reference a release names for each service a deploy rolls (the deploy order, then the
 * connectors); null for a service whose image the release does not build.
 */
export function releaseRefs(ctx: Context, manifest: ReleaseManifest): Map<string, string | null> {
  const s = ctx.settings.railway;
  const refs = new Map<string, string | null>();
  for (const service of [...s.deployOrder, ...s.connectorOrder]) {
    const image = own(s.services, service)?.image;
    const digest = image === undefined ? undefined : own(manifest.images, image);
    refs.set(
      service,
      image === undefined || digest === undefined
        ? null
        : imageRef(s.imageRepository, image, digest),
    );
  }
  return refs;
}

export interface OnRelease {
  /** Why the services do not run the release now, one entry per service. */
  problems: string[];
  /** The services whose newest deployment's image Railway did not say. */
  unread: string[];
}

/**
 * Whether every service a deploy rolls runs the release now: its newest deployment ended SUCCESS
 * and runs the release's digest. A service the release builds no image for must run none, as
 * `railway deploy` keeps only such a service.
 */
export async function servicesOnRelease(
  ctx: Context,
  rw: RailwayApi,
  manifest: ReleaseManifest,
): Promise<OnRelease> {
  const instances = await readInstances(ctx, rw);
  const problems: string[] = [];
  const unread: string[] = [];
  for (const [service, ref] of releaseRefs(ctx, manifest)) {
    const instance = instances.get(service);
    if (instance === undefined || !instance.inEnvironment) {
      problems.push(`${service} does not exist in this environment`);
      continue;
    }
    if (ref === null) {
      if (instance.image !== null && instance.image !== undefined && instance.image !== "")
        problems.push(`${service} runs an image the release does not build`);
      continue;
    }
    if (instance.image !== ref) {
      problems.push(`${service} is set to an image other than the release's`);
      continue;
    }
    const running = await readRunning(ctx, rw, service, instance);
    if (running.status !== "SUCCESS") {
      problems.push(
        `${service}'s newest deployment is ${running.status ?? "missing"}, not SUCCESS`,
      );
    } else if (running.image === undefined) {
      unread.push(service);
    } else if (running.image !== ref) {
      problems.push(`${service}'s newest deployment runs an image other than the release's`);
    }
  }
  return { problems, unread };
}
