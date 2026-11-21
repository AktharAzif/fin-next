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
  /** From the last registered `rules apply` and `access apply` runs. */
  readonly registered: {
    readonly rulesetHashes: Readonly<Record<string, string>>;
    readonly accessPolicyHash: string | null;
  };
  /** The commit SHA being deployed. */
  readonly release: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly stdout: Output;
  readonly fetch?: Fetch;
  readonly mask?: (text: string) => string;
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
    release: ctx.release,
  };
  return parseSettings({ ...publicPart, ...privatePart });
}

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
      throw new DeployError(
        `${method} ${path.replace(/\/accounts\/[^/]+/, "/accounts/<account>")} answered ${response.status}${codes.length > 0 ? ` (${codes.join(",")})` : ""}`,
      );
    }
    return json.result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const source = sources.find((s) => s.attributes.name === settings.telemetrySource);
  const heartbeat = heartbeats.find((h) => h.attributes.name === settings.heartbeat);
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
  out(`  schedule ${settings.cron}; workers.dev and previews off`);
  const result = { dryRun, modules: modules.map((m) => ({ name: m.name, sha256: m.sha256 })) };
  if (dryRun) {
    out("dry run: nothing changed");
    return { ...result, exitCode: 0 };
  }

  const cf = new CloudflareWriter(operatorToken, fetchImpl);
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
