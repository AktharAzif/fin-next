// `pnpm fin monitoring apply <env> [--dry-run] [--confirm-delete <count>]
//   [--assert-empty-team <team>] [--split-sources] [--redeliver]`
//
// ops/fin's dispatcher loads `monitoringApply` and calls it with a MonitoringContext (the hook is
// recorded in the pull request). It applies ops/monitoring/<env>/ through Better Stack's APIs,
// idempotent by name (OB-05, spec 08 §7.11):
//   - monitoring:check runs first, and any finding refuses the run;
//   - the dry-run difference is always printed before anything changes (MA-01);
//   - the tokens must belong to the environment's team, `fin-<env>` (MA-02);
//   - more than 3 deletions and pauses together need --confirm-delete <count> equal to their
//     number (MA-03);
//   - a heartbeat the files drop is paused with a reason, never deleted (MA-04);
//   - no object without a policy, and nothing in staging that calls, texts or pushes (MA-05,
//     MA-06); no ai_sre member (MA-08); every overlay key the files name has a value (MA-10);
//   - two remote objects with one name refuse the run, since it works by name.
// Tokens come from files named by FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE and
// FIN_BETTERSTACK_UPTIME_TOKEN_FILE; the monitor header from FIN_MONITOR_HEADER_FILE. IDs, ingest
// hosts, DSNs and heartbeat URLs are resolved at run time; the new ones are handed to
// `ctx.deliver` (the services' sealed variables) and never printed. Everything printed passes
// one mask: the hostnames, the zones and the monitor header's value, Better Stack's own error
// text included.
import { readFileSync, statSync } from "node:fs";
import {
  BetterStackClient,
  BetterStackError,
  type Fetch,
  PATHS,
  type Resource,
} from "./betterstack.ts";
import { checkMonitoring, formatFindings } from "./check.ts";
import { loadEnv } from "./config.ts";
import { buildDesired, type DesiredObject, KIND_ORDER, type RunSettings } from "./desired.ts";
import {
  type Action,
  type Clients,
  formatPlan,
  makePlan,
  type RemoteObject,
  readRemote,
  resolveRefs,
} from "./plan.ts";

export interface Output {
  write(text: string): void;
}

export interface SecretDelivery {
  readonly service: string;
  readonly variable: string;
  readonly value: string;
}

export interface MonitoringContext {
  /** The environment: "staging" (production's files come before production). */
  readonly env: string;
  /** The arguments after `monitoring apply <env>`. */
  readonly args: readonly string[];
  /** The repository root. */
  readonly root: string;
  /** Host role to real hostname (console, admin, verify, selfie, docs, api), from the overlay. */
  readonly hosts: Readonly<Record<string, string>>;
  /** Every zone the hosts live in, from the overlay: masked as `<zone>` wherever it appears. */
  readonly zones: readonly string[];
  /** The overlay's `thresholds` and `grace` (OB-13). */
  readonly thresholds: Readonly<Record<string, number>>;
  readonly grace: Readonly<Record<string, number>>;
  /** Where the token file variables are read; defaults to process.env. */
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly stdout: Output;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
  /** Hides private values before printing (ops/fin also registers them with ::add-mask::). */
  readonly mask?: (text: string) => string;
  /** Sets one sealed variable on one service. Absent: the run lists what it could not deliver. */
  readonly deliver?: (secret: SecretDelivery) => Promise<void>;
}

export interface ApplyResult {
  readonly exitCode: number;
  readonly dryRun: boolean;
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly paused: number;
  readonly delivered: number;
  readonly undelivered: readonly string[];
  /** Whether the files and Better Stack differed (the daily dry run reports this as drift). */
  readonly drift: boolean;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

interface Flags {
  readonly dryRun: boolean;
  readonly confirmDelete?: number;
  readonly assertEmptyTeam?: string;
  readonly splitSources: boolean;
  readonly redeliver: boolean;
}

export function parseFlags(args: readonly string[]): Flags {
  let dryRun = false;
  let splitSources = false;
  let redeliver = false;
  let confirmDelete: number | undefined;
  let assertEmptyTeam: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--split-sources") splitSources = true;
    else if (arg === "--redeliver") redeliver = true;
    else if (arg === "--confirm-delete") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) throw new UsageError("--confirm-delete takes a count");
      confirmDelete = Number(value);
      i += 1;
    } else if (arg === "--assert-empty-team") {
      const value = args[i + 1] ?? "";
      if (!/^[a-z0-9-]+$/.test(value))
        throw new UsageError("--assert-empty-team takes a team name");
      assertEmptyTeam = value;
      i += 1;
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  return {
    dryRun,
    splitSources,
    redeliver,
    ...(confirmDelete === undefined ? {} : { confirmDelete }),
    ...(assertEmptyTeam === undefined ? {} : { assertEmptyTeam }),
  };
}

/** Reads a credential from a file. Errors never include the file's content. */
export function readSecretFile(
  environ: Readonly<Record<string, string | undefined>>,
  variable: string,
): string {
  const path = environ[variable];
  if (path === undefined || path === "") throw new UsageError(`${variable} is not set`);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new UsageError(`${variable} names a file that cannot be read`);
  }
  if (!stat.isFile()) throw new UsageError(`${variable} does not name a file`);
  const value = readFileSync(path, "utf8").trim();
  if (value === "" || /\s/.test(value)) {
    throw new UsageError(`${variable}'s file is empty or holds more than one value`);
  }
  return value;
}

/**
 * Replaces every hostname with its role, then every zone with `<zone>` (a remote name or one of
 * Better Stack's error strings can hold any name in the zone), then each secret value.
 */
export function hostMask(
  hosts: Readonly<Record<string, string>>,
  zones: readonly string[] = [],
  secrets: readonly { readonly value: string; readonly as: string }[] = [],
): (text: string) => string {
  const pairs: [string, string][] = [
    ...Object.entries(hosts)
      .filter(([, host]) => host !== "")
      .sort((a, b) => b[1].length - a[1].length)
      .map(([role, host]): [string, string] => [host, `<${role}>`]),
    ...[...zones]
      .filter((zone) => zone !== "")
      .sort((a, b) => b.length - a.length)
      .map((zone): [string, string] => [zone, "<zone>"]),
    ...secrets.filter((s) => s.value !== "").map((s): [string, string] => [s.value, s.as]),
  ];
  return (text) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), text);
}

function pathFor(object: DesiredObject | RemoteObject, ids: ReadonlyMap<string, string>): string {
  const parent = (key: string | undefined, kind: string) => {
    const id = key === undefined ? undefined : ids.get(`${kind}:${key}`);
    if (id === undefined) throw new UsageError(`no ${kind} for ${object.key}`);
    return id;
  };
  switch (object.kind) {
    case "urgency":
      return PATHS.urgencies;
    case "policy":
      return PATHS.policies;
    case "source":
      return PATHS.sources;
    case "application":
      return PATHS.applications;
    case "exploration":
      return PATHS.explorations;
    case "monitor":
      return PATHS.monitors;
    case "heartbeat":
      return PATHS.heartbeats;
    case "metric":
      return "parentId" in object && object.parentId !== undefined
        ? PATHS.metrics(object.parentId)
        : PATHS.metrics(parent((object as DesiredObject).parent, "source"));
    case "alert":
      return "parentId" in object && object.parentId !== undefined
        ? PATHS.explorationAlerts(object.parentId)
        : PATHS.explorationAlerts(parent((object as DesiredObject).parent, "exploration"));
  }
}

/** The path of one existing object (updates, deletes, pauses). */
function itemPath(remote: RemoteObject): string {
  const id = encodeURIComponent(remote.id);
  switch (remote.kind) {
    case "alert":
      return `${PATHS.alerts}/${id}`;
    case "metric":
      return `${PATHS.metrics(remote.parentId ?? "")}/${id}`;
    default:
      return `${pathFor(remote, new Map())}/${id}`;
  }
}

function clientFor(clients: Clients, kind: DesiredObject["kind"]): BetterStackClient {
  if (kind === "application") return clients.errors;
  if (kind === "urgency" || kind === "policy" || kind === "monitor" || kind === "heartbeat") {
    return clients.uptime;
  }
  return clients.telemetry;
}

function secretValue(kind: string, resource: Resource): string | undefined {
  const a = resource.attributes;
  const token = typeof a.token === "string" ? a.token : undefined;
  const host = typeof a.ingesting_host === "string" ? a.ingesting_host : undefined;
  if (kind === "dsn") {
    return token === undefined || host === undefined ? undefined : `https://${token}@${host}/1`;
  }
  if (kind === "token") return token;
  if (kind === "ingesting_host") return host;
  if (kind === "url") return typeof a.url === "string" ? a.url : undefined;
  return undefined;
}

/** Body to send: references resolved, fixed attributes dropped on update. */
function sendable(object: DesiredObject, ids: ReadonlyMap<string, string>, update: boolean) {
  const resolved = resolveRefs(object.body, ids) as Record<string, unknown> | undefined;
  if (resolved === undefined)
    throw new UsageError(`${object.kind} ${object.key}: unresolved reference`);
  if (!update) return resolved;
  const out = { ...resolved };
  for (const field of object.immutable ?? []) delete out[field];
  return out;
}

type Delivery = { object: DesiredObject; resource: Resource };

/** Hands each new secret to its service, one at a time: a refusal is listed, never printed. */
async function deliverAll(
  ctx: MonitoringContext,
  toDeliver: readonly Delivery[],
  result: { delivered: number; undelivered: string[] },
): Promise<void> {
  for (const { object, resource } of toDeliver) {
    if (object.delivery === undefined) continue;
    for (const service of object.delivery.services) {
      for (const [variable, kind] of Object.entries(object.delivery.variables)) {
        const value = secretValue(kind, resource);
        const label = `${service} ${variable}`;
        if (value === undefined) {
          result.undelivered.push(`${label} (Better Stack returned no ${kind})`);
        } else if (ctx.deliver === undefined) {
          result.undelivered.push(label);
        } else {
          try {
            await ctx.deliver({ service, variable, value });
            result.delivered += 1;
          } catch {
            // The error may carry the value; only the label is kept.
            result.undelivered.push(`${label} (delivery failed)`);
          }
        }
      }
    }
  }
}

export async function monitoringApply(ctx: MonitoringContext): Promise<ApplyResult> {
  const flags = parseFlags(ctx.args);
  const environ = ctx.environ ?? process.env;
  let monitorHeader: string | undefined;
  const mask = (text: string) => {
    const secrets =
      monitorHeader === undefined
        ? []
        : [
            { value: monitorHeader, as: "(the monitor header)" },
            { value: JSON.stringify(monitorHeader).slice(1, -1), as: "(the monitor header)" },
          ];
    return (ctx.mask ?? ((t: string) => t))(hostMask(ctx.hosts, ctx.zones, secrets)(text));
  };
  const out = (text: string) => ctx.stdout.write(`${mask(text)}\n`);
  const result = {
    exitCode: 1,
    dryRun: flags.dryRun,
    created: 0,
    updated: 0,
    deleted: 0,
    paused: 0,
    delivered: 0,
    undelivered: [] as string[],
    drift: false,
  };
  // MA-02: the team is the environment's, never a string from the files being applied.
  const team = `fin-${ctx.env}`;

  // monitoring:check first: the files must pass before they are applied (MC-13 holds the files'
  // team to the same name).
  const findings = checkMonitoring(ctx.root, { envs: [ctx.env] });
  if (findings.length > 0) {
    out(
      `${formatFindings(findings)}\nmonitoring apply: refused, monitoring:check has ${findings.length} finding(s)`,
    );
    return result;
  }
  const { config } = loadEnv(ctx.root, ctx.env);
  if (config === undefined) throw new UsageError(`no files for ${ctx.env}`);

  const telemetryToken = readSecretFile(environ, "FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE");
  const uptimeToken = readSecretFile(environ, "FIN_BETTERSTACK_UPTIME_TOKEN_FILE");
  if ((environ.FIN_MONITOR_HEADER_FILE ?? "") !== "") {
    monitorHeader = readSecretFile(environ, "FIN_MONITOR_HEADER_FILE");
  } else if (!flags.dryRun && config.monitors.monitors.length > 0) {
    throw new UsageError(
      "FIN_MONITOR_HEADER_FILE is not set: every monitor sends the secret header",
    );
  }
  const fetchImpl = ctx.fetch ?? fetch;
  const clients: Clients = {
    telemetry: new BetterStackClient("telemetry", telemetryToken, fetchImpl),
    errors: new BetterStackClient("errors", telemetryToken, fetchImpl),
    uptime: new BetterStackClient("uptime", uptimeToken, fetchImpl),
  };
  const settings: RunSettings = {
    hosts: ctx.hosts,
    thresholds: ctx.thresholds,
    grace: ctx.grace,
    ...(monitorHeader === undefined ? {} : { monitorHeader }),
    splitSources: flags.splitSources,
  };
  const desired = buildDesired(config, settings);
  // Better Stack's refusals are printed through the mask, never thrown past it.
  const refusedBy = (error: unknown): boolean => {
    if (!(error instanceof BetterStackError)) return false;
    out(`monitoring apply: Better Stack refused ${error.message}`);
    return true;
  };
  let remote: Awaited<ReturnType<typeof readRemote>>;
  try {
    remote = await readRemote(clients, desired, config.sources.namePrefix);
  } catch (error) {
    if (refusedBy(error)) return result;
    throw error;
  }
  const today = (ctx.now?.() ?? new Date()).toISOString().slice(0, 10);
  const plan = makePlan(desired, remote, {
    team,
    ...(flags.assertEmptyTeam === undefined ? {} : { assertEmptyTeam: flags.assertEmptyTeam }),
    ...(flags.confirmDelete === undefined ? {} : { confirmDelete: flags.confirmDelete }),
    headerValues: monitorHeader !== undefined,
    today,
  });

  // MA-01: the difference is printed before anything changes.
  out(`monitoring apply ${ctx.env}${flags.dryRun ? " (dry run)" : ""}, team ${team}`);
  out(formatPlan(plan, (t) => t));
  if (monitorHeader === undefined)
    out("  note: the monitor header's value was not read, so it was not compared");
  if (plan.refusals.length > 0) {
    out(plan.refusals.map((r) => `refused: ${r}`).join("\n"));
    return result;
  }
  if (flags.dryRun) {
    const drift = plan.actions.length > 0;
    out(`dry run: nothing changed${drift ? " (differences found)" : ""}`);
    return { ...result, drift, exitCode: 0 };
  }

  // Apply, parents first. A refusal stops the writes; whatever was created before it still has
  // its secrets delivered, since a second run would find those objects and deliver nothing.
  const ids = new Map<string, string>();
  for (const object of remote.objects.values()) ids.set(`${object.kind}:${object.key}`, object.id);
  const createdResources: Delivery[] = [];
  let failed = false;
  try {
    const byKind = (a: Action) =>
      KIND_ORDER.indexOf(a.op === "create" || a.op === "update" ? a.object.kind : "heartbeat");
    const writes = plan.actions
      .filter((a) => a.op === "create" || a.op === "update")
      .sort((a, b) => byKind(a) - byKind(b));
    for (const action of writes) {
      if (action.op === "create") {
        const resource = await clientFor(clients, action.object.kind).create(
          pathFor(action.object, ids),
          sendable(action.object, ids, false),
        );
        ids.set(`${action.object.kind}:${action.object.key}`, resource.id);
        createdResources.push({ object: action.object, resource });
        result.created += 1;
        out(`created ${action.object.kind} ${action.object.key}`);
      } else if (action.op === "update") {
        await clientFor(clients, action.object.kind).update(
          itemPath(action.remote),
          sendable(action.object, ids, true),
        );
        result.updated += 1;
        out(`updated ${action.object.kind} ${action.object.key}`);
      }
    }
    // Deletions: alerts before their explorations, then the rest.
    const deletions = plan.actions
      .filter((a): a is Extract<Action, { op: "delete" }> => a.op === "delete")
      .sort((a, b) => (a.remote.kind === "alert" ? -1 : b.remote.kind === "alert" ? 1 : 0));
    for (const action of deletions) {
      await clientFor(clients, action.remote.kind).remove(itemPath(action.remote));
      result.deleted += 1;
      out(`deleted ${action.remote.kind} ${action.remote.key}`);
    }
    for (const action of plan.actions) {
      if (action.op !== "pause") continue;
      await clients.uptime.update(itemPath(action.remote), { paused: true });
      result.paused += 1;
      out(`paused ${action.remote.kind} ${action.remote.key}: ${action.reason}`);
    }
  } catch (error) {
    if (!refusedBy(error)) throw error;
    failed = true;
  }

  // Hand the new secrets to their services, never printing one.
  const toDeliver: Delivery[] = [...createdResources];
  if (flags.redeliver && !failed) {
    for (const object of desired.objects) {
      if (object.delivery === undefined) continue;
      if (createdResources.some((c) => c.object === object)) continue;
      const id = ids.get(`${object.kind}:${object.key}`);
      if (id === undefined) continue;
      const client = clientFor(clients, object.kind);
      try {
        toDeliver.push({
          object,
          resource: await client.get(`${pathFor(object, ids)}/${encodeURIComponent(id)}`),
        });
      } catch (error) {
        if (!refusedBy(error)) throw error;
        failed = true;
        break;
      }
    }
  }
  await deliverAll(ctx, toDeliver, result);
  if (result.undelivered.length > 0) {
    out(
      `not delivered (set these sealed variables by a registered run):\n  ${result.undelivered.join("\n  ")}`,
    );
  }
  out(
    `${failed ? "stopped after" : "applied"}: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted, ${result.paused} paused, ${result.delivered} secret(s) delivered`,
  );
  return { ...result, exitCode: failed ? 1 : 0 };
}

/** The command ops/fin's dispatcher registers. */
export const command = {
  name: "monitoring apply",
  usage:
    "pnpm fin monitoring apply <env> [--dry-run] [--confirm-delete <count>] [--assert-empty-team <team>] [--split-sources] [--redeliver]",
  run: monitoringApply,
} as const;
