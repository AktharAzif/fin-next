// `pnpm fin monitoring apply <env> [--dry-run] [--confirm-delete <count>]
//   [--assert-empty-team <team>] [--split-sources] [--redeliver]`
//
// `pnpm fin monitoring apply` runs this through apply-cli.ts, ops/monitoring's own entry point,
// as a child process: ops/fin may not import ops/monitoring (CI-14), so pnpm fin holds the run
// (the lock, run.registered before the first write, a run.step per write, run.done), the team
// tokens and the overlay, and forwards each Better Stack call this code makes (MonitoringContext's
// `fetchAuthenticates` and `hooks`). It applies ops/monitoring/<env>/ through Better Stack's APIs,
// idempotent by name (OB-05, spec 08 §7.11):
//   - monitoring:check runs first, and any finding refuses the run;
//   - the dry-run difference is always printed before anything changes (MA-01);
//   - the tokens must belong to the environment's team, `fin-<env>` (MA-02);
//   - more than 3 deletions and pauses together need --confirm-delete <count> equal to their
//     number (MA-03; a dry run, which deletes nothing, only notes it and still reports drift);
//   - a heartbeat the files drop is paused with a reason, never deleted (MA-04);
//   - no object without a policy, and nothing in staging that calls, texts or pushes, or routes
//     to any policy but staging-quiet (MA-05, MA-06); no ai_sre member (MA-08); every overlay key
//     the files name has a value (MA-10);
//   - two remote objects with one name refuse the run, since it works by name;
//   - after a run that wrote anything, everything is read back and compared with the files again:
//     any object that differs fails the run (`readBack`), named with the parts that differ, never
//     a value.
// Called directly, the tokens come from files named by FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE and
// FIN_BETTERSTACK_UPTIME_TOKEN_FILE, and the monitor header from FIN_MONITOR_HEADER_FILE. IDs,
// ingest hosts, DSNs and heartbeat URLs are resolved at run time; the new ones are handed to
// `ctx.deliver` (the services' sealed variables) and never printed. Everything printed passes
// one mask: the hostnames, the zones and the monitor header's value, Better Stack's own error
// text included. The overlay's numbers (thresholds, windows, grace periods) are never printed: a
// change to one shows its placeholder (`<threshold:clock-skew>`), and so does each number a
// refused write carried (or its object held) where Better Stack's error text echoes it.
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
  type Plan,
  type PlanOptions,
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
  /**
   * Whether `fetch` authenticates every call itself (pnpm fin forwards each call and adds the team
   * token, apply-cli.ts): no token file is read then, and no token reaches this code.
   */
  readonly fetchAuthenticates?: boolean;
  /** The secret monitor header's value, from the caller; when absent, FIN_MONITOR_HEADER_FILE. */
  readonly monitorHeader?: string;
  /** The caller's run (pnpm fin's registered run), told before and around every write. */
  readonly hooks?: RunHooks;
}

/** What a run's plan will do, by count (run.registered records it). */
export interface PlanCounts {
  readonly create: number;
  readonly update: number;
  readonly delete: number;
  readonly pause: number;
  readonly manual: number;
  readonly unchanged: number;
}

/** One write, by what it changes: never a value. */
export interface WriteChange {
  readonly op: "create" | "update" | "delete" | "pause";
  readonly kind: string;
  readonly key: string;
}

export interface RunHooks {
  /**
   * Called once, after the plan is printed and has passed every rule, before the first write; not
   * in a dry run and not when nothing is to be written. A throw stops the run with nothing written.
   */
  beforeWrites(plan: PlanCounts): Promise<void>;
  /** Called around each write: `send` makes the write's one call. */
  writing<T>(change: WriteChange, send: () => Promise<T>): Promise<T>;
}

/**
 * How a run ended: a dry run; a real run with nothing to write; every write made and read back as
 * the files say; refused before anything was written (monitoring:check, a rule); stopped partway
 * by Better Stack (a refusal, a call with no answer, a read-back it could not make); or written,
 * but read back different from the files.
 */
export type Outcome = "dry-run" | "unchanged" | "applied" | "refused" | "stopped" | "mismatch";

/** The read-back after the writes: how many objects were compared, and which ones differ. */
export interface ReadBack {
  readonly compared: number;
  /** `<kind>:<name>` of each object that differs from the files, or a refusal's rule. */
  readonly mismatched: readonly string[];
}

export interface ApplyResult {
  readonly exitCode: number;
  readonly outcome: Outcome;
  readonly dryRun: boolean;
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly paused: number;
  readonly delivered: number;
  readonly undelivered: readonly string[];
  /**
   * Whether Better Stack differs from the files, the daily dry run's drift: what a dry run or a
   * refused run found (a refusal never hides it), true after a real run that stopped partway or
   * read back different, and after any real run whose plan still holds what no run changes (a
   * part Better Stack fixes at creation, a source or an Errors application the files do not name).
   */
  readonly drift: boolean;
  /** How many refusals stopped the run before it wrote anything. */
  readonly refusals: number;
  /** After a run that wrote anything and was not stopped. */
  readonly readBack?: ReadBack;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** The most of a Better Stack error message printed, after the mask. */
const ERROR_WIDTH = 480;

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
    outcome: "refused" as Outcome,
    dryRun: flags.dryRun,
    created: 0,
    updated: 0,
    deleted: 0,
    paused: 0,
    delivered: 0,
    undelivered: [] as string[],
    drift: false,
    refusals: 0,
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
    return { ...result, refusals: findings.length };
  }
  const { config } = loadEnv(ctx.root, ctx.env);
  if (config === undefined) throw new UsageError(`no files for ${ctx.env}`);

  // With a forwarding fetch, the caller adds the tokens: none is read here.
  const telemetryToken =
    ctx.fetchAuthenticates === true
      ? undefined
      : readSecretFile(environ, "FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE");
  const uptimeToken =
    ctx.fetchAuthenticates === true
      ? undefined
      : readSecretFile(environ, "FIN_BETTERSTACK_UPTIME_TOKEN_FILE");
  if (ctx.monitorHeader !== undefined) {
    monitorHeader = ctx.monitorHeader;
  } else if ((environ.FIN_MONITOR_HEADER_FILE ?? "") !== "") {
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
  // Better Stack's refusals, and calls that got no answer, are printed through the mask, never
  // thrown past it. The message is masked whole and only then cut to length: a cut made first
  // could leave part of a hostname or zone that the mask no longer finds.
  // A refused write's own private numbers are hidden too: Better Stack may echo a value it was
  // sent (or the one it holds), and pnpm fin's masker leaves short numbers alone.
  const refusedBy = (error: unknown, numbers: readonly PrivateNumber[] = []): boolean => {
    if (!(error instanceof BetterStackError)) return false;
    const masked = hideNumbers(mask(error.message), numbers);
    const message = masked.length > ERROR_WIDTH ? `${masked.slice(0, ERROR_WIDTH - 3)}...` : masked;
    out(
      error.status === 0
        ? `monitoring apply: a Better Stack call failed: ${message}`
        : `monitoring apply: Better Stack refused ${message}`,
    );
    return true;
  };
  let remote: Awaited<ReturnType<typeof readRemote>>;
  try {
    remote = await readRemote(clients, desired, config.sources.namePrefix);
  } catch (error) {
    if (refusedBy(error)) return { ...result, outcome: "stopped" };
    throw error;
  }
  const today = (ctx.now?.() ?? new Date()).toISOString().slice(0, 10);
  const planOptions = planOptionsFor(ctx.env, {
    team,
    ...(flags.assertEmptyTeam === undefined ? {} : { assertEmptyTeam: flags.assertEmptyTeam }),
    headerValues: monitorHeader !== undefined,
    today,
    mask,
  });
  const plan = makePlan(desired, remote, {
    ...planOptions,
    ...(flags.confirmDelete === undefined ? {} : { confirmDelete: flags.confirmDelete }),
    dryRun: flags.dryRun,
  });

  // MA-01: the difference is printed before anything changes.
  out(`monitoring apply ${ctx.env}${flags.dryRun ? " (dry run)" : ""}, team ${team}`);
  out(formatPlan(plan, (t) => t));
  if (monitorHeader === undefined)
    out("  note: the monitor header's value was not read, so it was not compared");
  if (plan.refusals.length > 0) {
    out(plan.refusals.map((r) => `refused: ${r}`).join("\n"));
    return { ...result, drift: plan.drift, refusals: plan.refusals.length };
  }
  if (flags.dryRun) {
    out(`dry run: nothing changed${plan.drift ? " (differences found)" : ""}`);
    return { ...result, outcome: "dry-run", drift: plan.drift, exitCode: 0 };
  }
  const counts = countPlan(plan);
  const writeCount = counts.create + counts.update + counts.delete + counts.pause;
  // The caller's run registers before the first write; nothing is written if it cannot.
  if (writeCount > 0) await ctx.hooks?.beforeWrites(counts);
  const write = <T>(change: WriteChange, send: () => Promise<T>): Promise<T> =>
    ctx.hooks === undefined ? send() : ctx.hooks.writing(change, send);

  // Apply, parents first. Anything that stops the writes (a refusal, a call with no answer, a
  // fault in the run itself) still leaves whatever was created before it with its secrets
  // delivered, since a second run would find those objects and deliver nothing.
  const ids = new Map<string, string>();
  for (const object of remote.objects.values()) ids.set(`${object.kind}:${object.key}`, object.id);
  const createdResources: Delivery[] = [];
  let failed = false;
  // A fault that is not Better Stack's is rethrown once the secrets are delivered.
  let fault: { readonly error: unknown } | undefined;
  const stoppedBy = (error: unknown, numbers: readonly PrivateNumber[] = []) => {
    failed = true;
    if (refusedBy(error, numbers)) return;
    fault = { error };
    const name = error instanceof Error ? error.name : typeof error;
    out(`monitoring apply: stopped by an unexpected ${name}`);
  };
  /**
   * A create that got no answer, or a server error, may have made the object all the same, and
   * the next run would find it by name and deliver nothing. So an object with secrets is read back
   * by name (a read is safe to repeat): found once, it is delivered like any object this run made;
   * otherwise its variables are listed as not delivered, so the run says to use --redeliver.
   */
  const recoverLost = async (object: DesiredObject, error: BetterStackError) => {
    if (object.delivery === undefined) return;
    const how = error.status === 0 ? "got no answer" : `answered ${error.status}`;
    // Every kind that carries secrets (sources, applications, heartbeats) is named by `name`.
    const client = clientFor(clients, object.kind);
    try {
      const path = pathFor(object, ids);
      const found = (await client.list(path)).filter((r) => r.attributes.name === object.key);
      const [only] = found;
      if (found.length === 1 && only !== undefined) {
        const resource = await client.get(`${path}/${encodeURIComponent(only.id)}`);
        createdResources.push({ object, resource });
        result.created += 1;
        out(`created ${object.kind} ${object.key} (its create ${how}; found by name)`);
        return;
      }
    } catch (readError) {
      if (!refusedBy(readError)) fault ??= { error: readError };
    }
    for (const service of object.delivery.services) {
      for (const variable of Object.keys(object.delivery.variables)) {
        result.undelivered.push(`${service} ${variable} (its create ${how}; it may exist)`);
      }
    }
  };
  // The create in flight, while its call is unanswered.
  let creating: DesiredObject | undefined;
  // The private numbers the write in flight carries, hidden in a refusal's text.
  let carried: readonly PrivateNumber[] = [];
  try {
    const byKind = (a: Action) =>
      KIND_ORDER.indexOf(a.op === "create" || a.op === "update" ? a.object.kind : "heartbeat");
    const writes = plan.actions
      .filter((a) => a.op === "create" || a.op === "update")
      .sort((a, b) => byKind(a) - byKind(b));
    for (const action of writes) {
      const { kind, key } = action.object;
      if (action.op === "create") {
        const path = pathFor(action.object, ids);
        const body = sendable(action.object, ids, false);
        creating = action.object;
        carried = privateNumbersOf(action.object, settings);
        const resource = await write({ op: "create", kind, key }, () =>
          clientFor(clients, kind).create(path, body),
        );
        creating = undefined;
        ids.set(`${kind}:${key}`, resource.id);
        createdResources.push({ object: action.object, resource });
        result.created += 1;
        out(`created ${kind} ${key}`);
      } else if (action.op === "update") {
        const path = itemPath(action.remote);
        const body = sendable(action.object, ids, true);
        carried = privateNumbersOf(action.object, settings, action.remote.attributes);
        await write({ op: "update", kind, key }, () => clientFor(clients, kind).update(path, body));
        result.updated += 1;
        out(`updated ${kind} ${key}`);
      }
    }
    // Deletions and pauses send no number of the files'.
    carried = [];
    // Deletions: alerts before their explorations, then the rest.
    const deletions = plan.actions
      .filter((a): a is Extract<Action, { op: "delete" }> => a.op === "delete")
      .sort((a, b) => (a.remote.kind === "alert" ? -1 : b.remote.kind === "alert" ? 1 : 0));
    for (const action of deletions) {
      const { kind, key } = action.remote;
      await write({ op: "delete", kind, key }, () =>
        clientFor(clients, kind).remove(itemPath(action.remote)),
      );
      result.deleted += 1;
      out(`deleted ${action.remote.kind} ${action.remote.key}`);
    }
    for (const action of plan.actions) {
      if (action.op !== "pause") continue;
      const { kind, key } = action.remote;
      await write({ op: "pause", kind, key }, () =>
        clients.uptime.update(itemPath(action.remote), { paused: true }),
      );
      result.paused += 1;
      out(`paused ${action.remote.kind} ${action.remote.key}: ${action.reason}`);
    }
  } catch (error) {
    stoppedBy(error, carried);
    // A refusal (4xx) made nothing; no answer or a server error may have made the object.
    if (
      creating !== undefined &&
      error instanceof BetterStackError &&
      !(error.status >= 400 && error.status < 500)
    ) {
      await recoverLost(creating, error);
    }
  }

  // Hand the new secrets to their services, never printing one.
  const toDeliver: Delivery[] = [...createdResources];
  if (flags.redeliver && !failed) {
    // A read that fails stops the reads; what was not read is listed, never silently skipped.
    let stopped = false;
    for (const object of desired.objects) {
      if (object.delivery === undefined) continue;
      if (createdResources.some((c) => c.object === object)) continue;
      const id = ids.get(`${object.kind}:${object.key}`);
      if (id === undefined) continue;
      if (!stopped) {
        const client = clientFor(clients, object.kind);
        try {
          toDeliver.push({
            object,
            resource: await client.get(`${pathFor(object, ids)}/${encodeURIComponent(id)}`),
          });
          continue;
        } catch (error) {
          stoppedBy(error);
          stopped = true;
        }
      }
      for (const service of object.delivery.services) {
        for (const variable of Object.keys(object.delivery.variables)) {
          result.undelivered.push(`${service} ${variable} (its secrets could not be read)`);
        }
      }
    }
  }
  await deliverAll(ctx, toDeliver, result);
  if (result.undelivered.length > 0) {
    const how =
      ctx.deliver === undefined
        ? `this run sets no service variable; Better Stack keeps each value, and a pnpm fin monitoring apply ${ctx.env} --redeliver that delivers reads them again`
        : `set these sealed variables with a registered pnpm fin monitoring apply ${ctx.env} --redeliver`;
    out(`not delivered (${how}):\n  ${result.undelivered.join("\n  ")}`);
  }
  out(
    `${failed ? "stopped after" : "applied"}: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted, ${result.paused} paused, ${result.delivered} secret(s) delivered`,
  );
  if (fault !== undefined) throw fault.error;
  if (failed) return { ...result, outcome: "stopped", drift: true, exitCode: 1 };
  // Nothing to write, though the plan may still hold what no run changes (a part Better Stack
  // fixes at creation, a source the files do not name): its drift stands.
  if (writeCount === 0) {
    if (plan.drift) {
      out(
        "nothing to write, but Better Stack differs from the files in what no run changes (above)",
      );
    }
    return { ...result, outcome: "unchanged", drift: plan.drift, exitCode: 0 };
  }

  // Read everything back and compare it with the files again, as a dry run would: what this run
  // wrote, and what it left alone, must now be exactly what the files say.
  let after: Awaited<ReturnType<typeof readRemote>>;
  try {
    after = await readRemote(clients, desired, config.sources.namePrefix);
  } catch (error) {
    if (!refusedBy(error)) throw error;
    out("read back: Better Stack could not be read after the writes, so nothing was compared");
    return { ...result, outcome: "stopped", drift: true, exitCode: 1 };
  }
  const afterPlan = makePlan(desired, after, { ...planOptions, dryRun: true });
  const { lines, ...readBack } = compareBack(desired, afterPlan);
  if (readBack.mismatched.length === 0 && afterPlan.drift) {
    // Only what no run changes is left: a source or an Errors application the files do not name.
    out(
      `read back: ${readBack.compared} object(s) compared, each as the files say, but Better Stack also holds what the files do not name (drift):\n  ${afterPlan.notes.join("\n  ")}`,
    );
    return { ...result, outcome: "applied", drift: true, exitCode: 0, readBack };
  }
  if (readBack.mismatched.length === 0) {
    out(`read back: ${readBack.compared} object(s) compared, every one as the files say`);
    return { ...result, outcome: "applied", exitCode: 0, readBack };
  }
  out(
    `read back: ${lines.length} difference(s) from the files after the writes, ${readBack.compared} object(s) compared:\n  ${lines.join("\n  ")}`,
  );
  return { ...result, outcome: "mismatch", drift: true, exitCode: 1, readBack };
}

/** The quiet policy every staging alert, monitor and heartbeat routes to (spec 08 §7.9). */
export const STAGING_QUIET = "staging-quiet";

/** A plan's actions by count. */
export function countPlan(plan: Plan): PlanCounts {
  const count = (op: Action["op"]) => plan.actions.filter((a) => a.op === op).length;
  return {
    create: count("create"),
    update: count("update"),
    delete: count("delete"),
    pause: count("pause"),
    manual: count("manual"),
    unchanged: plan.unchanged,
  };
}

/**
 * What a plan made after the writes says: every action it still holds and every refusal is a
 * difference, a `manual` one included: a part Better Stack fixes at creation that differs (a
 * source's data_region, a metric's type) is not as the files say, whether this run created the
 * object or found it so, and only a recreation by hand fixes it. Each object is named once, by
 * kind and name, with the parts that differ, never a value.
 */
export function compareBack(
  desired: { readonly objects: readonly DesiredObject[] },
  plan: Plan,
): ReadBack & { readonly lines: readonly string[] } {
  const found = new Map<string, { readonly label: string; readonly what: string[] }>();
  const differs = (kind: string, key: string, what: string) => {
    const id = `${kind}:${key}`;
    const entry = found.get(id) ?? { label: `${kind} ${key}`, what: [] };
    entry.what.push(what);
    found.set(id, entry);
  };
  for (const action of plan.actions) {
    switch (action.op) {
      case "create":
        differs(action.object.kind, action.object.key, "missing");
        break;
      case "update":
        differs(
          action.object.kind,
          action.object.key,
          `differs in ${[...new Set(action.changes.map((c) => c.path))].join(", ")}`,
        );
        break;
      case "manual":
        differs(
          action.kind,
          action.key,
          `differs in ${action.path}, which Better Stack fixes at creation (recreate it by hand after review)`,
        );
        break;
      case "delete":
        differs(action.remote.kind, action.remote.key, "still there, though the files dropped it");
        break;
      case "pause":
        differs(action.remote.kind, action.remote.key, "not paused, though the files dropped it");
        break;
    }
  }
  const mismatched = [...found.keys()];
  const lines = [...found.values()].map((e) => `${e.label}: ${e.what.join("; ")}`);
  for (const refusal of plan.refusals) {
    // A rule's refusal by its rule; the one refusal without a rule is two objects with one name.
    mismatched.push(`refused:${/^MA-\d{2}\b/.exec(refusal)?.[0] ?? "duplicate-name"}`);
    lines.push(`refused: ${refusal}`);
  }
  return { compared: desired.objects.length, mismatched, lines };
}

/** A private number a write carries (a threshold, a window, a grace period) and its placeholder. */
export interface PrivateNumber {
  readonly value: number;
  readonly as: string;
}

const PLACEHOLDER = /<(threshold|grace):([a-z0-9][a-z0-9-]*)>/g;

/**
 * The private numbers one write carries: each overlay number its object's `private` parts name
 * (`<threshold:x>`, `<grace:x>`, a ratio query's minimum count) and, for an update, the numbers
 * the object holds in those parts now, which are the overlay's earlier ones.
 */
export function privateNumbersOf(
  object: DesiredObject,
  settings: Pick<RunSettings, "thresholds" | "grace">,
  held: Readonly<Record<string, unknown>> = {},
): PrivateNumber[] {
  const out: PrivateNumber[] = [];
  for (const [field, shown] of Object.entries(object.private ?? {})) {
    for (const m of shown.matchAll(PLACEHOLDER)) {
      const family = m[1] === "grace" ? settings.grace : settings.thresholds;
      const value = family[m[2] ?? ""];
      if (typeof value === "number") out.push({ value, as: m[0] });
    }
    const was = held[field];
    const as = [...shown.matchAll(PLACEHOLDER)][0]?.[0];
    if (typeof was === "number" && as !== undefined) out.push({ value: was, as });
  }
  return out;
}

/**
 * Replaces each private number in a text (Better Stack's error text, which may echo a value it was
 * sent or holds) with its placeholder wherever it stands as a number of its own, never inside a
 * longer number, a word or an ID.
 */
export function hideNumbers(text: string, numbers: readonly PrivateNumber[]): string {
  const longestFirst = [...numbers]
    .filter((n) => Number.isFinite(n.value))
    .sort((a, b) => String(b.value).length - String(a.value).length);
  let out = text;
  for (const { value, as } of longestFirst) {
    const spelt = String(value).replace(/[.+-]/g, (c) => `\\${c}`);
    const alone = new RegExp(`(?<![0-9A-Za-z_.])${spelt}(?![0-9A-Za-z_]|\\.[0-9])`, "g");
    out = out.replace(alone, as);
  }
  return out;
}

/**
 * The plan's options for an environment: in staging, MA-06's one quiet policy, which every alert,
 * monitor and heartbeat must route to (spec 08 §7.9).
 */
export function planOptionsFor(env: string, options: PlanOptions): PlanOptions {
  return env === "staging" ? { ...options, quietPolicy: STAGING_QUIET } : options;
}
