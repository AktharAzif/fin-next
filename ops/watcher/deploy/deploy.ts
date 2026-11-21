// `pnpm fin watcher deploy <env> [--dry-run]` (spec 01 §7.11): uploads the watcher through the
// Workers API with Node built-ins (no wrangler). ops/fin's dispatcher loads `watcherDeploy` and
// calls it with a WatcherDeployContext (the hook is recorded in the pull request).
//
// One upload carries the modules, the compatibility date and the Worker's whole environment: the
// settings as one plain-text value, and four secrets (the read-only Cloudflare token, the source's
// ingest host and token, the heartbeat URL). No other binding exists. Then the `* * * * *`
// schedule, workers.dev and previews off, and a read-back that fails the run on any difference.
// Secrets are read from files or resolved from Better Stack at run time and never printed; the
// settings hold the zone, the hostnames and the account ID, so they are never printed either.
//
// The Worker's Cloudflare token must be read-only (CR-18, OB-11): before anything is uploaded the
// deploy refuses the operator's own token, verifies the Worker's token is an active token of the
// account, reads its permission groups with the operator token, and refuses any group that is not
// a Read group, and a token with no expiry or one more than a year away (spec 08 §6.5's yearly
// rotation of the watcher's tokens). It prints only the outcome.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BetterStackClient, PATHS } from "../../monitoring/src/betterstack.ts";
import {
  type HostRole,
  type PrivateSettings,
  type PublicSettings,
  parseSettings,
  type WatcherSettings,
} from "../src/settings.ts";
import { bundle, type WorkerModule } from "./bundle.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Output {
  write(text: string): void;
}

export interface WatcherDeployContext {
  readonly env: string;
  readonly args: readonly string[];
  readonly root: string;
  /** From the overlay (no API resolves the account from a name). */
  readonly accountId: string;
  readonly zone: string;
  readonly hosts: Readonly<Record<HostRole, string>>;
  /** The overlay's staticEgress.<service>. */
  readonly staticEgress: Readonly<Record<string, readonly string[]>>;
  /** From the last registered `rules apply`, `access apply` and static deploy runs. */
  readonly registered: {
    /** Per phase, `finRulesetHash` (src/hash.ts) of the entrypoint's rules after the run. */
    readonly rulesetHashes: Readonly<Record<string, string>>;
    readonly accessPolicyHash: string | null;
    /** Per static deployment, the active version its registered upload read back. */
    readonly staticVersions?: Readonly<Record<string, string>>;
  };
  /** The commit SHA being deployed. */
  readonly release: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly stdout: Output;
  readonly fetch?: Fetch;
  readonly mask?: (text: string) => string;
  readonly now?: () => Date;
}

export interface DeployResult {
  readonly exitCode: number;
  readonly dryRun: boolean;
  readonly modules: readonly { readonly name: string; readonly sha256: string }[];
}

export class DeployError extends Error {
  override readonly name = "DeployError";
}

const API = "https://api.cloudflare.com/client/v4";
const SECRET_NAMES = [
  "FIN_CF_TOKEN",
  "FIN_TELEMETRY_HOST",
  "FIN_TELEMETRY_TOKEN",
  "FIN_HEARTBEAT_WATCHER_URL",
] as const;
type SecretName = (typeof SECRET_NAMES)[number];

function readSecretFile(environ: Readonly<Record<string, string | undefined>>, variable: string) {
  const path = environ[variable];
  if (path === undefined || path === "") throw new DeployError(`${variable} is not set`);
  try {
    if (!statSync(path).isFile()) throw new Error();
  } catch {
    throw new DeployError(`${variable} does not name a readable file`);
  }
  const value = readFileSync(path, "utf8").trim();
  if (value === "" || /\s/.test(value)) {
    throw new DeployError(`${variable}'s file is empty or holds more than one value`);
  }
  return value;
}

/** Joins the committed settings with the run's private part, and validates the whole. */
export function buildSettings(
  root: string,
  ctx: Pick<
    WatcherDeployContext,
    "env" | "accountId" | "zone" | "hosts" | "staticEgress" | "registered" | "release"
  >,
): WatcherSettings {
  const path = join(root, "ops", "watcher", "settings", `${ctx.env}.json`);
  const { $comment: _comment, ...publicPart } = JSON.parse(
    readFileSync(path, "utf8"),
  ) as PublicSettings & { $comment?: string };
  const egress: Record<string, readonly string[]> = {};
  for (const tunnel of Object.values(publicPart.tunnels)) {
    for (const service of tunnel.egressServices) egress[service] = ctx.staticEgress[service] ?? [];
  }
  const privatePart: PrivateSettings = {
    accountId: ctx.accountId,
    zone: ctx.zone,
    hosts: ctx.hosts,
    egress,
    rulesetHashes: ctx.registered.rulesetHashes,
    accessPolicyHash: ctx.registered.accessPolicyHash,
    staticVersions: ctx.registered.staticVersions ?? {},
    release: ctx.release,
  };
  return parseSettings({ ...publicPart, ...privatePart });
}

/** What the watcher will report as unset, so the operator sees it before the first minute. */
export function unsetNotes(settings: WatcherSettings): string[] {
  const notes: string[] = [];
  for (const phase of settings.rulesetPhases) {
    if (settings.rulesetHashes[phase] === undefined) {
      notes.push(`no registered hash for rule set phase ${phase}: the watcher reports hash_unset`);
    }
  }
  if (settings.accessPolicyHash === null) {
    notes.push("no registered Access policy hash: the watcher reports hash_unset");
  }
  for (const { name } of settings.static) {
    if (settings.staticVersions[name] === undefined) {
      notes.push(`no registered version for ${name}: the watcher reports version_unset`);
    }
  }
  return notes;
}

/** A permission group a read-only token may hold: Cloudflare names every read group "... Read". */
export function isReadGroup(name: unknown): boolean {
  return typeof name === "string" && / Read$/.test(name);
}

const DAY_MS = 86_400_000;
/** Spec 08 §6.5 rotates the watcher's tokens yearly, so no token lives longer. */
export const WATCHER_TOKEN_MAX_DAYS = 366;

/** The multipart body of a module Worker upload. */
export function uploadForm(
  modules: readonly WorkerModule[],
  settings: WatcherSettings,
  secrets: Readonly<Record<SecretName, string>>,
): FormData {
  const metadata = {
    main_module: "index.js",
    compatibility_date: settings.compatibilityDate,
    bindings: [
      { type: "plain_text", name: "FIN_WATCHER_SETTINGS", text: JSON.stringify(settings) },
      ...SECRET_NAMES.map((name) => ({ type: "secret_text", name, text: secrets[name] })),
    ],
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const module of modules) {
    form.append(
      module.name,
      new Blob([module.content], { type: "application/javascript+module" }),
      module.name,
    );
  }
  return form;
}

class CloudflareWriter {
  readonly #token: string;
  readonly #fetch: Fetch;
  constructor(token: string, fetchImpl: Fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }
  async call(method: string, path: string, body?: FormData | unknown): Promise<unknown> {
    const isForm = body instanceof FormData;
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body === undefined || isForm ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    let json: { success?: boolean; result?: unknown; errors?: { code?: number }[] } = {};
    try {
      json = (await response.json()) as typeof json;
    } catch {
      json = {};
    }
    if (!response.ok || json.success === false) {
      const codes = (json.errors ?? []).map((e) => e.code).filter((c) => c !== undefined);
      const shown = path
        .replace(/\/accounts\/[^/]+/, "/accounts/<account>")
        .replace(/\/tokens\/(?!verify\b)[^/?]+/, "/tokens/<token>");
      throw new DeployError(
        `${method} ${shown} answered ${response.status}${codes.length > 0 ? ` (${codes.join(",")})` : ""}`,
      );
    }
    return json.result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Proves the Worker's token is read-only before it is uploaded: an active token of the account
 * (verified with the token itself), whose every permission group is a Read group (read with the
 * operator token), with an expiry within a year. Prints nothing; returns what may be printed.
 */
export async function checkWatcherToken(
  operator: CloudflareWriter,
  watcher: CloudflareWriter,
  accountId: string,
  now: Date,
): Promise<{ groups: number; expiresInDays: number }> {
  let verified: unknown;
  try {
    verified = await watcher.call("GET", `/accounts/${accountId}/tokens/verify`);
  } catch {
    throw new DeployError(
      "the watcher's token (FIN_WATCHER_CF_TOKEN_FILE) is not a token of this account: mint it with pnpm fin (CR-18)",
    );
  }
  if (
    !isRecord(verified) ||
    verified.status !== "active" ||
    typeof verified.id !== "string" ||
    verified.id === ""
  ) {
    throw new DeployError("the watcher's token is not active");
  }
  let token: unknown;
  try {
    token = await operator.call(
      "GET",
      `/accounts/${accountId}/tokens/${encodeURIComponent(verified.id)}`,
    );
  } catch {
    throw new DeployError(
      "the operator token cannot read the watcher token's permissions (it needs Account API Tokens Read)",
    );
  }
  const policies =
    isRecord(token) && Array.isArray(token.policies) ? token.policies.filter(isRecord) : [];
  const groups = policies
    .filter((p) => p.effect !== "deny")
    .flatMap((p) => (Array.isArray(p.permission_groups) ? p.permission_groups : []))
    .filter(isRecord);
  if (groups.length === 0) throw new DeployError("the watcher's token grants no permission");
  const writable = [
    ...new Set(groups.filter((g) => !isReadGroup(g.name)).map((g) => String(g.name))),
  ];
  if (writable.length > 0) {
    throw new DeployError(
      `the watcher's token is not read-only (${writable.join(", ")}): mint it with Read groups only (CR-18)`,
    );
  }
  const expires =
    isRecord(token) && typeof token.expires_on === "string" ? Date.parse(token.expires_on) : NaN;
  if (!Number.isFinite(expires)) {
    throw new DeployError(
      "the watcher's token has no expiry: mint it with one within a year (spec 08 §6.5)",
    );
  }
  if (expires <= now.getTime()) throw new DeployError("the watcher's token has expired");
  const expiresInDays = Math.floor((expires - now.getTime()) / DAY_MS);
  if (expiresInDays > WATCHER_TOKEN_MAX_DAYS) {
    throw new DeployError(
      `the watcher's token expires in ${expiresInDays} days, beyond its yearly rotation (spec 08 §6.5)`,
    );
  }
  return { groups: groups.length, expiresInDays };
}

/** Reads the deployed Worker back and lists every difference from what was uploaded. */
export async function verifyDeployed(
  cf: CloudflareWriter,
  settings: WatcherSettings,
): Promise<string[]> {
  const problems: string[] = [];
  const base = `/accounts/${settings.accountId}/workers/scripts/${encodeURIComponent(settings.scriptName)}`;
  const [scripts, workerSettings, schedules, subdomain] = await Promise.all([
    cf.call("GET", `/accounts/${settings.accountId}/workers/scripts`),
    cf.call("GET", `${base}/settings`),
    cf.call("GET", `${base}/schedules`),
    cf.call("GET", `${base}/subdomain`),
  ]);
  const script = (Array.isArray(scripts) ? scripts : []).find(
    (s) => isRecord(s) && s.id === settings.scriptName,
  ) as Record<string, unknown> | undefined;
  if (script === undefined) problems.push("the script is not listed");
  else {
    if (script.has_modules !== true) problems.push("the script has no modules");
    const handlers = Array.isArray(script.handlers) ? script.handlers.map(String) : [];
    if (!handlers.includes("scheduled")) problems.push("no scheduled handler");
    if (handlers.some((h) => h !== "scheduled")) problems.push("a handler other than scheduled");
  }
  const bindings =
    isRecord(workerSettings) && Array.isArray(workerSettings.bindings)
      ? workerSettings.bindings.filter(isRecord)
      : [];
  const seen = bindings.map((b) => `${String(b.type)}:${String(b.name)}`).sort();
  const want = [
    "plain_text:FIN_WATCHER_SETTINGS",
    ...SECRET_NAMES.map((n) => `secret_text:${n}`),
  ].sort();
  if (JSON.stringify(seen) !== JSON.stringify(want)) {
    problems.push(
      `bindings are ${seen.join(", ") || "none"}, not exactly the settings and four secrets`,
    );
  }
  const crons =
    isRecord(schedules) && Array.isArray(schedules.schedules)
      ? schedules.schedules.filter(isRecord).map((s) => String(s.cron))
      : [];
  if (JSON.stringify(crons) !== JSON.stringify([settings.cron])) {
    problems.push(`schedules are ${crons.join(", ") || "none"}, not ${settings.cron}`);
  }
  if (!isRecord(subdomain) || subdomain.enabled !== false || subdomain.previews_enabled !== false) {
    problems.push("workers.dev or previews are on");
  }
  return problems;
}

export async function watcherDeploy(ctx: WatcherDeployContext): Promise<DeployResult> {
  const dryRun = ctx.args.includes("--dry-run");
  for (const arg of ctx.args) {
    if (arg !== "--dry-run") throw new DeployError(`unknown argument ${arg}`);
  }
  const hostPairs = Object.entries(ctx.hosts).sort((a, b) => b[1].length - a[1].length);
  const hide = (text: string) => {
    let out = hostPairs.reduce((acc, [role, host]) => acc.split(host).join(`<${role}>`), text);
    out = out.split(ctx.zone).join("<zone>").split(ctx.accountId).join("<account>");
    return (ctx.mask ?? ((t: string) => t))(out);
  };
  const out = (text: string) => ctx.stdout.write(`${hide(text)}\n`);
  const environ = ctx.environ ?? process.env;
  const fetchImpl = ctx.fetch ?? fetch;

  const settings = buildSettings(ctx.root, ctx);
  const modules = bundle(join(ctx.root, "ops", "watcher", "src"));
  const team = `fin-${ctx.env}`;

  // The run's credentials: two Cloudflare tokens and two Better Stack team tokens, from files.
  const operatorToken = readSecretFile(environ, "FIN_CLOUDFLARE_OPERATOR_TOKEN_FILE");
  const readToken = readSecretFile(environ, "FIN_WATCHER_CF_TOKEN_FILE");
  if (readToken === operatorToken) {
    throw new DeployError(
      "FIN_WATCHER_CF_TOKEN_FILE holds the operator token: the watcher holds a read-only token of its own (CR-18)",
    );
  }
  const cf = new CloudflareWriter(operatorToken, fetchImpl);
  const tokenCheck = await checkWatcherToken(
    cf,
    new CloudflareWriter(readToken, fetchImpl),
    settings.accountId,
    ctx.now?.() ?? new Date(),
  );
  const telemetry = new BetterStackClient(
    "telemetry",
    readSecretFile(environ, "FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE"),
    fetchImpl,
  );
  const uptime = new BetterStackClient(
    "uptime",
    readSecretFile(environ, "FIN_BETTERSTACK_UPTIME_TOKEN_FILE"),
    fetchImpl,
  );
  const [sources, heartbeats] = await Promise.all([
    telemetry.list(PATHS.sources),
    uptime.list(PATHS.heartbeats),
  ]);
  // One object per name: with two, the apply and this deploy could each take a different one.
  const named = <T extends { attributes: Readonly<Record<string, unknown>> }>(
    list: readonly T[],
    name: string,
    kind: string,
  ): T | undefined => {
    const found = list.filter((r) => r.attributes.name === name);
    if (found.length > 1) {
      throw new DeployError(
        `Better Stack holds ${found.length} ${kind}s named ${name}: remove the duplicates by hand first`,
      );
    }
    return found[0];
  };
  const source = named(sources, settings.telemetrySource, "source");
  const heartbeat = named(heartbeats, settings.heartbeat, "heartbeat");
  if (source === undefined)
    throw new DeployError(
      `no Better Stack source ${settings.telemetrySource}: run pnpm fin monitoring apply ${ctx.env} first`,
    );
  if (heartbeat === undefined)
    throw new DeployError(
      `no heartbeat ${settings.heartbeat}: run pnpm fin monitoring apply ${ctx.env} first`,
    );
  for (const r of [source, heartbeat]) {
    if (r.attributes.team_name !== team)
      throw new DeployError(`the Better Stack tokens are not ${team}'s`);
  }
  const text = (v: unknown, what: string) => {
    if (typeof v !== "string" || v === "")
      throw new DeployError(`Better Stack returned no ${what}`);
    return v;
  };
  const secrets: Record<SecretName, string> = {
    FIN_CF_TOKEN: readToken,
    FIN_TELEMETRY_HOST: text(source.attributes.ingesting_host, "ingest host"),
    FIN_TELEMETRY_TOKEN: text(source.attributes.token, "source token"),
    FIN_HEARTBEAT_WATCHER_URL: text(heartbeat.attributes.url, "heartbeat URL"),
  };

  out(`watcher deploy ${ctx.env}${dryRun ? " (dry run)" : ""}: ${settings.scriptName}`);
  for (const m of modules) out(`  module ${m.name} ${m.sha256.slice(0, 12)}`);
  out(
    `  settings: FIN_WATCHER_SETTINGS (${Object.keys(settings).length} keys, release ${settings.release.slice(0, 12)})`,
  );
  out(`  secrets: ${SECRET_NAMES.join(", ")} (values not shown)`);
  out(
    `  the watcher's token: active, read-only (${tokenCheck.groups} Read group(s)), expires in ${tokenCheck.expiresInDays} days`,
  );
  out(`  schedule ${settings.cron}; workers.dev and previews off`);
  for (const note of unsetNotes(settings)) out(`  note: ${note}`);
  const result = { dryRun, modules: modules.map((m) => ({ name: m.name, sha256: m.sha256 })) };
  if (dryRun) {
    out("dry run: nothing changed");
    return { ...result, exitCode: 0 };
  }

  const base = `/accounts/${settings.accountId}/workers/scripts/${encodeURIComponent(settings.scriptName)}`;
  await cf.call("PUT", base, uploadForm(modules, settings, secrets));
  out("uploaded the script with its settings and secrets");
  await cf.call("PUT", `${base}/schedules`, [{ cron: settings.cron }]);
  await cf.call("POST", `${base}/subdomain`, { enabled: false, previews_enabled: false });
  const problems = await verifyDeployed(cf, settings);
  if (problems.length > 0) {
    out(`read-back failed:\n  ${problems.join("\n  ")}`);
    return { ...result, exitCode: 1 };
  }
  out(
    "read back: modules, scheduled handler only, exactly the settings and four secrets, the schedule, workers.dev and previews off",
  );
  return { ...result, exitCode: 0 };
}

/** The command ops/fin's dispatcher registers. */
export const command = {
  name: "watcher deploy",
  usage: "pnpm fin watcher deploy <env> [--dry-run]",
  run: watcherDeploy,
} as const;
