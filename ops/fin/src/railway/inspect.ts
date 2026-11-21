// Reading Railway staging back (spec 01 §6.1, §6.2, §6.3, §6.5, §6.8). The core read is the project
// query the hand provisioning used on 21 Nov; the settings Railway may name differently
// (healthcheck, overlap, draining, start command, cron), the readable variables and the static
// egress are separate reads. A read Railway refuses (it answered, with a GraphQL error) is reported
// as "not checked", never as passing, and is tried again for every service; a read that never got
// an answer (a network error, a 429 or a 5xx after the retries) stops the command instead, so a
// transient failure can never turn a check off. Every §6.8 row with no read in Phase 0 is listed as
// not checked, and so is any compared field Railway answered with no value.
//
// Names come from Railway, so every lookup by one goes through Object.hasOwn: a service named
// `constructor` is an unknown service like any other.

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
  /** Whether the service has an instance in the overlay's environment. */
  inEnvironment: boolean;
  /** Instances of this service in environments other than the overlay's (spec 01 §6.1). */
  otherEnvironments: number;
  /** Domains of those instances. */
  otherDomains: number;
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

/** The superuser reference that may exist only inside a registered run (spec 01 §6.3, §6.6). */
export const BOOTSTRAP_REFERENCE = "FIN_BOOTSTRAP_DATABASE_URL";

/** The rows of spec 01 §6.3 and §6.8 that Phase 0 has no read for. */
export const NO_READ_ROWS = [
  "memory limits, PITR and the deployment webhook (no read in Phase 0; checked by hand against spec 01 §6)",
  "no staged but undeployed change (no read in Phase 0; check the environment's pending changes by hand)",
  "image auto-updates off, Railway's CDN and Edge Rules, hard usage limits (no read in Phase 0)",
  "shared variables holding a secret (no read in Phase 0)",
];

export interface Inspection {
  instances: Map<string, InstanceState>;
  notChecked: string[];
  /** The services whose static egress Railway refused to read (the deploy refuses on these). */
  egressUnread: string[];
}

/**
 * Whether a failed read is Railway refusing the query (an answer with a GraphQL error), as opposed
 * to no usable answer at all, which must stop the command rather than turn a check off.
 */
export function isRefusal(error: unknown): boolean {
  return error instanceof ProviderError && [200, 400, 403].includes(error.status);
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
    const edges = node.serviceInstances.edges;
    const instance = edges.find((e) => e.node.environmentId === rw.environmentId)?.node;
    const others = edges.filter((e) => e.node.environmentId !== rw.environmentId);
    const otherDomains = others.reduce(
      (n, e) =>
        n +
        (e.node.domains?.serviceDomains ?? []).length +
        (e.node.domains?.customDomains ?? []).length,
      0,
    );
    const domains = [
      ...(instance?.domains?.serviceDomains ?? []).map((d) => d.domain),
      ...(instance?.domains?.customDomains ?? []).map((d) => d.domain),
    ];
    for (const d of domains) ctx.masker.register(d, `<railway-domain:${node.name}>`);
    if (instance === undefined && others.length === 0) continue;
    instances.set(node.name, {
      id: node.id,
      name: node.name,
      region: instance?.region ?? null,
      numReplicas: instance?.numReplicas ?? null,
      restartPolicyType: instance?.restartPolicyType ?? null,
      sleepApplication: instance?.sleepApplication ?? null,
      ipv6EgressEnabled: instance?.ipv6EgressEnabled ?? null,
      image: instance?.source?.image ?? null,
      domains,
      latestDeployment: instance?.latestDeployment ?? null,
      inEnvironment: instance !== undefined,
      otherEnvironments: others.length,
      otherDomains,
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
    if (!isRefusal(error)) throw error;
    notChecked.push(
      "health checks, overlap, draining, start commands and crons (Railway refused the read; SP-03)",
    );
  }
  const variablesUnread: string[] = [];
  const egressUnread: string[] = [];
  for (const [name, state] of instances) {
    if (!state.inEnvironment) continue;
    const tcp = await rw.query<{ tcpProxies: Array<{ id: string }> }>(TCP, {
      environmentId: rw.environmentId,
      serviceId: state.id,
    });
    state.tcpProxies = tcp.tcpProxies.length;
    try {
      const v = await rw.query<{ variables: Record<string, string> }>(VARIABLES, {
        projectId: rw.projectId,
        environmentId: rw.environmentId,
        serviceId: state.id,
      });
      // Only the names are kept: the values are never printed or logged.
      state.readableVariables = Object.keys(v.variables ?? {});
    } catch (error) {
      if (!isRefusal(error)) throw error;
      variablesUnread.push(name);
    }
    if (Object.hasOwn(ctx.settings.railway.services, name)) {
      try {
        state.egress = await rw.egressAddresses(name);
        for (const ip of state.egress) ctx.masker.register(ip, `<egress:${name}>`);
      } catch (error) {
        if (!isRefusal(error)) throw error;
        egressUnread.push(name);
      }
    }
  }
  if (variablesUnread.length > 0)
    notChecked.push(
      `which variables are sealed on ${variablesUnread.join(", ")} (Railway refused the read; SP-03)`,
    );
  if (egressUnread.length > 0)
    notChecked.push(
      `static egress on ${egressUnread.join(", ")} (Railway refused the read; SP-08)`,
    );
  const unanswered = new Map<string, string[]>();
  for (const [name, state] of instances) {
    if (!state.inEnvironment) continue;
    for (const field of [
      "region",
      "numReplicas",
      "restartPolicyType",
      "sleepApplication",
      "ipv6EgressEnabled",
    ] as const) {
      if (state[field] === null || state[field] === undefined) {
        unanswered.set(field, [...(unanswered.get(field) ?? []), name]);
      }
    }
  }
  for (const [field, names] of unanswered)
    notChecked.push(`${field} of ${names.join(", ")} (Railway answered no value)`);
  notChecked.push(...NO_READ_ROWS);
  return { instances, notChecked, egressUnread };
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

/** The checks that apply to every service, listed or not: exposure and other environments. */
function exposureFindings(
  name: string,
  got: InstanceState,
  add: (service: string, check: string, detail: string) => void,
): void {
  if (got.domains.length > 0)
    add(name, "domain", `${got.domains.length} public domain(s): none is allowed (NB-07)`);
  if ((got.tcpProxies ?? 0) > 0)
    add(name, "tcp-proxy", "a TCP proxy exists: none is allowed (NB-07)");
  if (got.otherEnvironments > 0) {
    add(
      name,
      "environment",
      `${got.otherEnvironments} instance(s) in another environment of the project, ${got.otherDomains} with a public domain: only the default environment may exist (spec 01 §6.1, §6.3)`,
    );
  }
  if ((got.readableVariables ?? []).includes(BOOTSTRAP_REFERENCE)) {
    add(
      name,
      "superuser-reference",
      `${BOOTSTRAP_REFERENCE} is set outside a registered run (spec 01 §6.3, §6.6)`,
    );
  }
}

/** Compares the inspection with the public settings (spec 01 §6.1, §6.2, §6.3, §6.5). */
export function findings(ctx: Context, inspection: Inspection): Finding[] {
  const out: Finding[] = [];
  const add = (service: string, check: string, detail: string) =>
    out.push({ service, check, detail });
  const s = ctx.settings.railway;
  for (const [name, want] of Object.entries(s.services)) {
    const got = inspection.instances.get(name);
    if (got === undefined || !got.inEnvironment) {
      add(name, "exists", "the service does not exist in this environment");
      if (got !== undefined) exposureFindings(name, got, add);
      continue;
    }
    exposureFindings(name, got, add);
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
      const expected = Object.hasOwn(ctx.overlay.staticEgress, name)
        ? ctx.overlay.staticEgress[name]
        : undefined;
      if (
        want.staticEgress &&
        expected !== undefined &&
        [...expected].sort().join(",") !== [...got.egress].sort().join(",")
      ) {
        add(name, "static-egress", "the addresses differ from the overlay's staticEgress");
      }
    }
  }
  // A service the settings do not list is drift in itself, and its exposure is checked like any
  // other's: an unlisted service with a domain or a TCP proxy is the case the refusal exists for.
  for (const [name, got] of inspection.instances) {
    if (Object.hasOwn(s.services, name)) continue;
    add(name, "unknown", "a service the settings do not list (spec 01 §6.2)");
    exposureFindings(name, got, add);
  }
  return out;
}

/** The finding checks a deploy refuses on, before it changes anything and again after the roll. */
export const REFUSED_CHECKS: ReadonlySet<string> = new Set([
  "domain",
  "tcp-proxy",
  "environment",
  "unknown",
  "superuser-reference",
]);
