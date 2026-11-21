// Reading Railway staging back (spec 01 §6.1, §6.2, §6.3, §6.5, §6.8). The core read is the project
// query the hand provisioning used on 21 Nov; the settings Railway may name differently
// (healthcheck, overlap, draining, start command, cron), the readable variables and the static
// egress are separate reads. A read Railway refuses (it answered with a schema or authorisation
// error) is reported as "not checked", never as passing, and is tried again for every service; any
// other failure (no answer, a 429 or a 5xx after the retries, or a GraphQL error that is no refusal)
// stops the command instead, so a transient failure can never turn a check off. The deploy refuses
// on every refused read it depends on unless the operator accepts it with a flag the run records.
// Every §6.2, §6.3 and §6.8 row with no read in Phase 0 is listed as not checked, and so is any
// compared field Railway answered with no value.
//
// Variables are read unrendered, so a reference (`${{postgres.DATABASE_URL}}`) is seen as a
// reference and never rendered into a value that carries the template's password. Of the values,
// only PORT's and the write marker's (FIN_VARIABLES_RUN, which every `pnpm fin` commit sets to its
// run and write) are kept; for every other variable only the name is kept, whether it refers to a
// template's variables (spec 01 §6.3), whether it holds the inert value a run leaves instead of a
// removal (rule 3 of the steward's ruling of 22 Nov), and, when the caller names the values it
// wrote, whether each one differs. Nothing else of a value is kept, printed or logged. Railway
// answers a sealed variable with its name and a null value: such a name is sealed, and present.
// The read is eventually consistent: straight after a write it may still answer what stood before,
// so a read-back of a write is tried again for a short, bounded time (readVariablesBack), and
// counts only once it shows that write (the marker; rule 4).
//
// Names come from Railway, so every lookup by one goes through Object.hasOwn: a service named
// `constructor` is an unknown service like any other.

import type { Context } from "../core/context.ts";
import { ProviderError } from "../core/errors.ts";
import { mustBeSealed, type ServiceSettings, type Settings } from "../core/settings.ts";
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
  /** The names of the readable (unsealed) variables; undefined when the read was refused. */
  readableVariables?: string[];
  /** The names of the sealed variables (answered with a null value); undefined when refused. */
  sealedVariables?: string[];
  /** The readable variables whose value refers to a template service's variables (§6.3). */
  templateReferences?: string[];
  /** The readable variables that hold the inert value: each waits for removal (rule 3). */
  inertVariables?: string[];
  /** PORT's value, or null when it is not readable (§6.2: PORT=8080 on every service). */
  port?: string | null;
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
// UNVERIFIED (SP-03): the variables of a service, unrendered (a reference stays a reference); a
// sealed one is answered by its name with a null value, as staging answers it.
const VARIABLES =
  "query finVariables($projectId: String!, $environmentId: String!, $serviceId: String!) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true) }";

/** The superuser reference that may exist only inside a registered run (spec 01 §6.3, §6.6). */
export const BOOTSTRAP_REFERENCE = "FIN_BOOTSTRAP_DATABASE_URL";

/**
 * The plain variable every `pnpm fin` variable commit sets, in the same commit, to the run and the
 * write that made it (`<run ID>:<n>`): a read that shows it has seen that write (rule 4). Not a
 * secret, and read by no Fin service.
 */
export const WRITE_MARKER = "FIN_VARIABLES_RUN";

/**
 * The value a variable is overwritten with where no deployment is wanted, instead of a removal
 * (rule 3: Railway's variableDelete takes no skipDeploys). It is no URL, so `migrate` refuses it at
 * its configuration check as it refuses an absent superuser reference.
 */
export const INERT_VALUE = "inert";

/** The rows of spec 01 §6.2, §6.3 and §6.8 that Phase 0 has no read for. */
export const NO_READ_ROWS = [
  "memory limits, PITR and the deployment webhook (no read in Phase 0; checked by hand against spec 01 §6)",
  "no staged but undeployed change (no read in Phase 0; check the environment's pending changes by hand)",
  "image auto-updates off, Railway's CDN and Edge Rules, hard usage limits (no read in Phase 0)",
  "shared variables holding a secret (no read in Phase 0)",
  "each service's database login (spec 01 §6.2: the Postgres role behind FIN_DB_USER; no read in Phase 0)",
  "no TUNNEL_TOKEN on the services that hold no token, and no database template reference set as a sealed variable (no read in Phase 0; Railway answers a sealed variable with its name only)",
  "Config as Code (a railway.json or railway.toml path) and a repository source on a service (no read in Phase 0 beyond the image-by-digest check)",
];

export interface Inspection {
  instances: Map<string, InstanceState>;
  notChecked: string[];
  /** The services whose static egress Railway refused to read (the deploy refuses on these). */
  egressUnread: string[];
  /** The services whose variables Railway refused to read (the deploy refuses on these). */
  variablesUnread: string[];
  /** Whether Railway refused the instance settings read: health checks and the rest unread. */
  settingsUnread: boolean;
  /** `<service> <variable>` for each variable that holds the inert value (rule 3). */
  awaitingRemoval: string[];
}

/**
 * The messages that say Railway refused the query itself: the schema has no such field or argument,
 * or the field has another shape (SP-03's unverified names), or the token may not make it.
 */
const REFUSAL =
  /Cannot query field|Unknown argument|Unknown type|Unknown field|is not defined by type|must have a selection of subfields|must not have a selection|Not Authori[sz]ed|Unauthori[sz]ed|Forbidden|Permission denied|not permitted/i;

/**
 * Whether a failed read is Railway refusing the query (an answer with a schema or authorisation
 * error), as opposed to no usable answer, or an error that is Railway's own failure, which must
 * stop the command rather than turn a check off.
 */
export function isRefusal(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    [200, 400, 403].includes(error.status) &&
    REFUSAL.test(error.message)
  );
}

/** The template services of the settings (the database), whose variables no service may refer to. */
export function templateServices(settings: Settings): string[] {
  return Object.entries(settings.railway.services)
    .filter(([, s]) => s.template === true)
    .map(([name]) => name);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The names of the variables whose value refers to a template service's variables
 * (`${{postgres.DATABASE_URL}}`, spaces and case aside). A template's references to its own
 * variables are its own; any other service's are what spec 01 §6.3 forbids outside a run.
 */
export function templateReferences(
  service: string,
  variables: Readonly<Record<string, unknown>>,
  templates: readonly string[],
): string[] {
  const patterns = templates
    .filter((t) => t !== service)
    .map((t) => new RegExp(`\\$\\{\\{\\s*${escapeRegExp(t)}\\s*\\.`, "i"));
  return Object.entries(variables)
    .filter(([, value]) => typeof value === "string" && patterns.some((p) => p.test(value)))
    .map(([name]) => name)
    .sort();
}

/** What the checks keep of one service's variables. */
export interface Variables {
  /** The names of the readable variables (any value but null). */
  readable: string[];
  /** The names Railway answered with a null value: sealed variables, present all the same. */
  sealed: string[];
  /** The readable variables whose value refers to a template service's variables. */
  templateReferences: string[];
  /** The readable variables that hold the inert value (rule 3). */
  inert: string[];
  /** PORT's value, or null when it is not readable. */
  port: string | null;
  /** The write marker's value (WRITE_MARKER), or null when it is not readable. */
  marker: string | null;
  /** Of the values the caller expected, the names whose readable value is not that value. */
  differs: string[];
}

/** A variable's own value from Railway's answer (a name like `constructor` is a name like any). */
function own(variables: Readonly<Record<string, unknown>>, name: string): unknown {
  return Object.hasOwn(variables, name) ? variables[name] : undefined;
}

/**
 * Reads one service's variables, unrendered, and keeps only what the checks need: the readable
 * names, the sealed names, the names that refer to a template or hold the inert value, PORT's
 * value, the write marker's value, and, of `expect` (plain values the caller wrote), the names
 * whose value differs. Throws on a refusal like any read.
 */
export async function readVariables(
  rw: RailwayApi,
  settings: Settings,
  service: string,
  serviceId: string,
  expect: Readonly<Record<string, string>> = {},
): Promise<Variables> {
  const v = await rw.query<{ variables: Record<string, unknown> | null }>(VARIABLES, {
    projectId: rw.projectId,
    environmentId: rw.environmentId,
    serviceId,
  });
  const variables = v.variables ?? {};
  const port = own(variables, "PORT");
  const marker = own(variables, WRITE_MARKER);
  const names = Object.keys(variables);
  return {
    readable: names.filter((name) => variables[name] !== null),
    sealed: names.filter((name) => variables[name] === null),
    templateReferences: templateReferences(service, variables, templateServices(settings)),
    inert: names.filter((name) => variables[name] === INERT_VALUE),
    port: typeof port === "string" ? port : null,
    marker: typeof marker === "string" ? marker : null,
    differs: Object.entries(expect)
      .filter(([name, value]) => own(variables, name) !== value)
      .map(([name]) => name),
  };
}

/** Reads of a read-back in all, at most, and the wait between two of them (10 s in all). */
export const READ_BACK_READS = 6;
export const READ_BACK_PAUSE_MS = 2_000;

/**
 * Reads back one service's variables after a write, until `settled` says the write shows, or
 * READ_BACK_READS reads were made: Railway's read is eventually consistent, so a read straight
 * after a write may still answer what stood before it. Returns the last read, which alone may
 * report a mismatch. A refusal or a failed read throws at once, like any read. A caller's
 * `settled` holds only for a read that shows the write itself (its marker), never for one that
 * merely lacks what the write replaced: a read from before the write lacks it too (rule 4).
 */
export async function readVariablesBack(
  rw: RailwayApi,
  settings: Settings,
  service: string,
  serviceId: string,
  sleep: (ms: number) => Promise<void>,
  settled: (variables: Variables) => boolean,
  expect: Readonly<Record<string, string>> = {},
): Promise<Variables> {
  for (let read = 1; ; read++) {
    const variables = await readVariables(rw, settings, service, serviceId, expect);
    if (settled(variables) || read >= READ_BACK_READS) return variables;
    await sleep(READ_BACK_PAUSE_MS);
  }
}

/**
 * The core read: every service of the project with its instance in this environment (exposure, the
 * image it is set to, its newest deployment) and its instances elsewhere. IDs and domains are
 * masked as they are read.
 */
export async function readInstances(
  ctx: Context,
  rw: RailwayApi,
): Promise<Map<string, InstanceState>> {
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
  return instances;
}

/** Reads every service of the project in this environment. */
export async function inspectRailway(ctx: Context, rw: RailwayApi): Promise<Inspection> {
  const notChecked: string[] = [];
  let settingsUnread = false;
  const instances = await readInstances(ctx, rw);
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
    settingsUnread = true;
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
      const v = await readVariables(rw, ctx.settings, name, state.id);
      state.readableVariables = v.readable;
      state.sealedVariables = v.sealed;
      state.templateReferences = v.templateReferences;
      state.inertVariables = v.inert;
      state.port = v.port;
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
      `which variables are sealed on ${variablesUnread.join(", ")}, their PORT, and whether a database template reference (the superuser URL) stands there (Railway refused the read; SP-03)`,
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
  const awaitingRemoval = [...instances].flatMap(([name, state]) =>
    (state.inertVariables ?? []).map((variable) => `${name} ${variable}`),
  );
  return { instances, notChecked, egressUnread, variablesUnread, settingsUnread, awaitingRemoval };
}

/**
 * Whether a service's variables hold the superuser reference by its own name: present and sealed
 * (its value cannot be read), or readable with any value but the inert one (rule 3).
 */
export function holdsBootstrapReference(
  readable: readonly string[],
  sealed: readonly string[],
  inert: readonly string[],
): boolean {
  return (
    sealed.includes(BOOTSTRAP_REFERENCE) ||
    (readable.includes(BOOTSTRAP_REFERENCE) && !inert.includes(BOOTSTRAP_REFERENCE))
  );
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
  const references = new Set(got.templateReferences ?? []);
  // Present, sealed or not: a sealed superuser reference stands all the same. Only the inert value
  // a run leaves it (rule 3), which is readable, does not.
  if (
    holdsBootstrapReference(
      got.readableVariables ?? [],
      got.sealedVariables ?? [],
      got.inertVariables ?? [],
    )
  )
    references.add(BOOTSTRAP_REFERENCE);
  if (references.size > 0) {
    add(
      name,
      "superuser-reference",
      `${[...references].sort().join(", ")}: a database template reference or ${BOOTSTRAP_REFERENCE} outside a registered run (spec 01 §6.3, §6.6)`,
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
    if (e === undefined && !inspection.settingsUnread) {
      add(name, "healthcheck", "Railway's answer held no settings for this service's instance");
    }
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
    if (got.readableVariables !== undefined && got.port !== "8080") {
      add(
        name,
        "port",
        got.port === null || got.port === undefined
          ? "PORT is not set or not readable: it must be the plain 8080 (spec 01 §6.2)"
          : "PORT is not 8080 (spec 01 §6.2)",
      );
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

/**
 * The finding checks a deploy refuses on for each service it rolls, before and after: Railway's
 * health check (/readyz, 60 s) is what makes SUCCESS mean the service is ready on its schema.
 */
export const ROLL_CHECKS: ReadonlySet<string> = new Set(["healthcheck", "healthcheck-timeout"]);
