// Reading Railway staging back (spec 01 §6.2, §6.3, §6.5, §6.8). The core read is the project
// query the hand provisioning used on 21 Nov; the settings Railway may name differently
// (healthcheck, overlap, draining, start command, cron), the readable variables and the static
// egress are separate reads, and a read Railway refuses is reported as "not checked", never as
// passing.

import type { Context } from "../core/context.ts";
import { ProviderError } from "../core/errors.ts";
import { mustBeSealed, type ServiceSettings } from "../core/settings.ts";
import type { RailwayApi } from "./api.ts";

export interface InstanceState {
  id: string;
  name: string;
  region?: string | null;
  numReplicas?: number | null;
  restartPolicyType?: string | null;
  sleepApplication?: boolean | null;
  ipv6EgressEnabled?: boolean | null;
  image?: string | null;
  domains: string[];
  latestDeployment?: { id: string; status: string } | null;
  extended?: {
    healthcheckPath?: string | null;
    healthcheckTimeout?: number | null;
    overlapSeconds?: number | null;
    drainingSeconds?: number | null;
    startCommand?: string | null;
    cronSchedule?: string | null;
  };
  tcpProxies?: number;
  readableVariables?: string[];
  egress?: string[];
}

export interface Finding {
  service: string;
  check: string;
  detail: string;
}

interface StatusNode {
  id: string;
  name: string;
  serviceInstances: {
    edges: Array<{
      node: {
        environmentId: string;
        region?: string | null;
        numReplicas?: number | null;
        restartPolicyType?: string | null;
        sleepApplication?: boolean | null;
        ipv6EgressEnabled?: boolean | null;
        source?: { image?: string | null } | null;
        domains?: {
          serviceDomains?: Array<{ domain: string }>;
          customDomains?: Array<{ domain: string }>;
        } | null;
        latestDeployment?: { id: string; status: string } | null;
      };
    }>;
  };
}

const STATUS = `query finStatus($projectId: String!) { project(id: $projectId) { services { edges { node { id name serviceInstances { edges { node { environmentId region numReplicas restartPolicyType sleepApplication ipv6EgressEnabled source { image } domains { serviceDomains { domain } customDomains { domain } } latestDeployment { id status } } } } } } } } }`;
// UNVERIFIED field names (SP-03): Railway's ServiceInstance settings beyond the hand-provisioning query.
const EXTENDED = `query finStatusExtended($projectId: String!) { project(id: $projectId) { services { edges { node { name serviceInstances { edges { node { environmentId healthcheckPath healthcheckTimeout overlapSeconds drainingSeconds startCommand cronSchedule } } } } } } } }`;
const TCP =
  "query finTcp($environmentId: String!, $serviceId: String!) { tcpProxies(environmentId: $environmentId, serviceId: $serviceId) { id } }";
// UNVERIFIED (SP-03): the readable variables of a service; a sealed one is absent from the answer.
const VARIABLES =
  "query finVariables($projectId: String!, $environmentId: String!, $serviceId: String!) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }";

export interface Inspection {
  instances: Map<string, InstanceState>;
  notChecked: string[];
}

/** Reads every service of the project in this environment. */
export async function inspectRailway(ctx: Context, rw: RailwayApi): Promise<Inspection> {
  const notChecked: string[] = [];
  const data = await rw.query<{ project: { services: { edges: Array<{ node: StatusNode }> } } }>(
    STATUS,
    { projectId: rw.projectId },
  );
  const instances = new Map<string, InstanceState>();
  for (const { node } of data.project.services.edges) {
    ctx.masker.register(node.id, `<railway:${node.name}>`);
    const instance = node.serviceInstances.edges.find(
      (e) => e.node.environmentId === rw.environmentId,
    )?.node;
    if (instance === undefined) continue;
    const domains = [
      ...(instance.domains?.serviceDomains ?? []).map((d) => d.domain),
      ...(instance.domains?.customDomains ?? []).map((d) => d.domain),
    ];
    for (const d of domains) ctx.masker.register(d, `<railway-domain:${node.name}>`);
    instances.set(node.name, {
      id: node.id,
      name: node.name,
      region: instance.region ?? null,
      numReplicas: instance.numReplicas ?? null,
      restartPolicyType: instance.restartPolicyType ?? null,
      sleepApplication: instance.sleepApplication ?? null,
      ipv6EgressEnabled: instance.ipv6EgressEnabled ?? null,
      image: instance.source?.image ?? null,
      domains,
      latestDeployment: instance.latestDeployment ?? null,
    });
  }
  try {
    const extended = await rw.query<{
      project: {
        services: {
          edges: Array<{
            node: {
              name: string;
              serviceInstances: {
                edges: Array<{ node: Record<string, unknown> & { environmentId: string } }>;
              };
            };
          }>;
        };
      };
    }>(EXTENDED, { projectId: rw.projectId });
    for (const { node } of extended.project.services.edges) {
      const i = node.serviceInstances.edges.find(
        (e) => e.node.environmentId === rw.environmentId,
      )?.node;
      const state = instances.get(node.name);
      if (i !== undefined && state !== undefined)
        state.extended = i as NonNullable<InstanceState["extended"]>;
    }
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    notChecked.push(
      "health checks, overlap, draining, start commands and crons (Railway refused the read; SP-03)",
    );
  }
  let variablesReadable = true;
  let egressReadable = true;
  for (const [name, state] of instances) {
    const tcp = await rw.query<{ tcpProxies: Array<{ id: string }> }>(TCP, {
      environmentId: rw.environmentId,
      serviceId: state.id,
    });
    state.tcpProxies = tcp.tcpProxies.length;
    if (variablesReadable) {
      try {
        const v = await rw.query<{ variables: Record<string, string> }>(VARIABLES, {
          projectId: rw.projectId,
          environmentId: rw.environmentId,
          serviceId: state.id,
        });
        // Only the names are kept: the values are never printed or logged.
        state.readableVariables = Object.keys(v.variables ?? {});
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        variablesReadable = false;
        notChecked.push("which variables are sealed (Railway refused the read; SP-03)");
      }
    }
    if (egressReadable && ctx.settings.railway.services[name] !== undefined) {
      try {
        state.egress = await rw.egressAddresses(name);
        for (const ip of state.egress) ctx.masker.register(ip, `<egress:${name}>`);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        egressReadable = false;
        notChecked.push("static egress (Railway refused the read; SP-08)");
      }
    }
  }
  notChecked.push(
    "memory limits, PITR and the deployment webhook (no read in Phase 0; checked by hand against spec 01 §6)",
  );
  return { instances, notChecked };
}

const DIGEST_REF = /^ghcr\.io\/[a-z0-9-]+\/(fin-next-[a-z0-9-]+)@sha256:[0-9a-f]{64}$/;

/** The image a service runs, as `<repository>@sha256:<digest>`, or why it is not one. */
export function imageProblem(
  image: string | null | undefined,
  settings: ServiceSettings,
  repository: string,
): string | undefined {
  if (image === null || image === undefined || image === "") return "no image set";
  const m = DIGEST_REF.exec(image);
  if (m === null) return "the image is not set by digest";
  if (!image.startsWith(repository)) return "the image is not from the release repository";
  if (settings.image !== undefined && m[1] !== settings.image)
    return `runs ${m[1]}, not ${settings.image}`;
  return undefined;
}

/** Compares the inspection with the public settings (spec 01 §6.2, §6.3, §6.5). */
export function findings(ctx: Context, inspection: Inspection): Finding[] {
  const out: Finding[] = [];
  const add = (service: string, check: string, detail: string) =>
    out.push({ service, check, detail });
  const s = ctx.settings.railway;
  for (const [name, want] of Object.entries(s.services)) {
    const got = inspection.instances.get(name);
    if (got === undefined) {
      add(name, "exists", "the service does not exist in this environment");
      continue;
    }
    if (got.domains.length > 0)
      add(name, "domain", `${got.domains.length} public domain(s): none is allowed (NB-07)`);
    if ((got.tcpProxies ?? 0) > 0)
      add(name, "tcp-proxy", "a TCP proxy exists: none is allowed (NB-07)");
    if (got.region !== null && got.region !== undefined && got.region !== s.region)
      add(name, "region", `${got.region}, not ${s.region}`);
    if (
      got.numReplicas !== null &&
      got.numReplicas !== undefined &&
      got.numReplicas !== want.replicas
    ) {
      add(name, "replicas", `${got.numReplicas}, not ${want.replicas}`);
    }
    if (want.template === true) continue;
    if (got.sleepApplication === true) add(name, "serverless", "app sleeping is on");
    if (got.ipv6EgressEnabled === true) add(name, "ipv6-egress", "outbound IPv6 is on");
    if (
      want.restart !== undefined &&
      got.restartPolicyType !== null &&
      got.restartPolicyType !== undefined &&
      got.restartPolicyType !== want.restart
    ) {
      add(name, "restart", `${got.restartPolicyType}, not ${want.restart}`);
    }
    const problem = imageProblem(got.image, want, s.imageRepository);
    if (problem !== undefined) add(name, "image", problem);
    const e = got.extended;
    if (e !== undefined) {
      const health = want.healthcheck ?? null;
      if ((e.healthcheckPath ?? null) !== health)
        add(name, "healthcheck", `${e.healthcheckPath ?? "none"}, not ${health ?? "none"}`);
      if (health !== null && e.healthcheckTimeout !== 60)
        add(name, "healthcheck-timeout", `${e.healthcheckTimeout ?? "none"}, not 60`);
      if (want.overlapSeconds !== undefined && (e.overlapSeconds ?? 0) !== want.overlapSeconds)
        add(name, "overlap", `${e.overlapSeconds ?? 0}, not ${want.overlapSeconds}`);
      if (want.drainingSeconds !== undefined && (e.drainingSeconds ?? 0) !== want.drainingSeconds)
        add(name, "draining", `${e.drainingSeconds ?? 0}, not ${want.drainingSeconds}`);
      if ((e.startCommand ?? null) !== (want.startCommand ?? null))
        add(name, "start-command", "differs from the settings");
      if (want.cron !== undefined && e.cronSchedule !== want.cron)
        add(name, "cron", "differs from the settings");
    }
    for (const variable of got.readableVariables ?? []) {
      if (mustBeSealed(ctx.settings, variable))
        add(name, "sealed", `${variable} is readable: it must be sealed`);
    }
    if (got.egress !== undefined) {
      if (want.staticEgress && got.egress.length === 0)
        add(name, "static-egress", "static egress is off; it must be on (spec 01 §6.5)");
      if (!want.staticEgress && got.egress.length > 0)
        add(name, "static-egress", "static egress is on; it must be off");
      const expected = ctx.overlay.staticEgress[name];
      if (
        want.staticEgress &&
        expected !== undefined &&
        [...expected].sort().join(",") !== [...got.egress].sort().join(",")
      ) {
        add(name, "static-egress", "the addresses differ from the overlay's staticEgress");
      }
    }
  }
  for (const name of inspection.instances.keys()) {
    if (s.services[name] === undefined) add(name, "unknown", "a service the settings do not list");
  }
  return out;
}
