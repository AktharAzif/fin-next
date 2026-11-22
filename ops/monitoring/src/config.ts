// Reads ops/monitoring/<env>/ and the catalogue into typed values, and expands templated alerts
// (`forEach`). Shape problems are collected as findings rather than thrown, so monitoring:check
// reports every one in a single run. Node built-ins only: it runs with no install.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface Finding {
  readonly file: string;
  readonly rule: string;
  readonly message: string;
}

export type Notify = Readonly<{
  email?: boolean;
  sms?: boolean;
  call?: boolean;
  push?: boolean;
  critical_alert?: boolean;
}>;

export interface SourcesFile {
  readonly team: string;
  readonly environment: string;
  readonly namePrefix: string;
  readonly platform: string;
  readonly dataRegion: string;
  readonly sources: readonly {
    readonly service: string;
    readonly writes: string;
    /** Services that receive FIN_TELEMETRY_HOST and FIN_TELEMETRY_TOKEN; defaults to [service]. */
    readonly holders?: readonly string[];
  }[];
}

export interface ErrorsApp {
  readonly name: string;
  readonly platform: string;
  readonly source?: string;
  readonly alsoUsedBy?: readonly string[];
  /** Services that receive the DSN, and the variable it goes in. */
  readonly holders: readonly string[];
  readonly variable: string;
}

export interface ErrorsFile {
  readonly namePrefix: string;
  readonly retentionDays: number;
  readonly applications: readonly ErrorsApp[];
  readonly noApplication?: Readonly<Record<string, string>>;
}

export interface MetricDef {
  readonly name: string;
  readonly field: string;
  readonly type: string;
  readonly aggregations: readonly string[];
}

export interface MetricsFile {
  readonly sets: Readonly<Record<string, readonly MetricDef[]>>;
  readonly sources: Readonly<Record<string, readonly string[]>>;
}

export interface MonitorDefaults {
  readonly checkFrequency: number;
  readonly regions: readonly string[];
  readonly requestTimeout: number;
  readonly confirmationPeriod: number;
  readonly recoveryPeriod: number;
  readonly sslExpiration: number;
  readonly domainExpiration: number;
  readonly followRedirects: boolean;
  readonly verifySsl: boolean;
  readonly secretHeader: string;
  readonly policy: string;
  readonly notify: Notify;
  readonly runbook: string;
}

export interface MonitorDef {
  readonly name: string;
  readonly host: string;
  readonly path: string;
  readonly type: "expected_status_code" | "keyword" | "status";
  readonly expectStatus?: readonly number[];
  readonly keyword?: string;
  readonly policy?: string;
  readonly notify?: Notify;
  readonly runbook?: string;
}

export interface MonitorsFile {
  readonly defaults: MonitorDefaults;
  readonly monitors: readonly MonitorDef[];
}

export interface HeartbeatDef {
  readonly name: string;
  readonly period: number;
  readonly grace: string;
  /**
   * The Railway service that pings it, which receives FIN_HEARTBEAT_<NAME>_URL as a sealed
   * variable; empty when the pinger reads its URL from Better Stack itself (`watcher deploy`,
   * `pnpm fin verify`).
   */
  readonly holders: readonly string[];
  readonly policy?: string;
  readonly notify?: Notify;
  readonly runbook?: string;
}

export interface HeartbeatsFile {
  readonly defaults: { readonly policy: string; readonly notify: Notify; readonly runbook: string };
  readonly heartbeats: readonly HeartbeatDef[];
}

export interface SeverityDef extends Notify {
  readonly name: string;
}

export interface PolicyMember {
  readonly type: string;
  readonly id?: string;
}

export interface PolicyDef {
  readonly name: string;
  readonly repeatCount: number;
  readonly repeatDelay: number;
  readonly steps: readonly {
    readonly waitBefore: number;
    readonly severity: string;
    readonly members: readonly PolicyMember[];
  }[];
}

export interface PoliciesFile {
  readonly team: string;
  readonly severities: readonly SeverityDef[];
  readonly policies: readonly PolicyDef[];
}

/**
 * A condition on one field of a line. Exactly one comparison is set. `eq: false` needs the field
 * on the line; `notEq` also matches a line without it, which is what a security alert wants (a
 * line whose field is missing must alert, never pass). `present: true` matches only a line that
 * carries the field, whatever its value: for an alert the plan defines per that field, where a
 * line without it is no part of what the alert counts (spec 02 §18.2's "for one userId").
 */
export interface Condition {
  readonly field: string;
  readonly eq?: string | number | boolean;
  readonly notEq?: string | boolean;
  readonly in?: readonly string[];
  readonly notIn?: readonly string[];
  readonly gt?: number;
  readonly contains?: number;
  readonly present?: true;
}

export type AlertQuery =
  | { readonly lines: Record<string, never> }
  | {
      readonly count: {
        readonly events: readonly string[];
        readonly where?: readonly Condition[];
        readonly whereAny?: readonly Condition[];
      };
    }
  | {
      readonly max: {
        readonly event: string;
        readonly field: string;
        readonly abs?: boolean;
        readonly where?: readonly Condition[];
      };
    }
  | {
      readonly ratio: {
        readonly event: string;
        readonly match: readonly Condition[];
        readonly minCount: string;
      };
    };

/**
 * A series field whose label the query holds to a closed set: the line's value when it is one of
 * `oneOf`, or has the `shape` named, and otherwise the one fixed label `other` (a missing field
 * and a value of another type included). No line, a forged one included, can then choose a label
 * or add one, and every line still counts. Exactly one of `oneOf` and `shape` is set; the shape
 * `sqlstate` is five digits or capital letters.
 */
export interface SeriesField {
  readonly field: string;
  readonly oneOf?: readonly string[];
  readonly shape?: "sqlstate";
}

/** An alert after `forEach` expansion: every `{var}` replaced. */
export interface AlertDef {
  readonly name: string;
  /** The name as written in the file, before expansion (what the catalogue refers to). */
  readonly template: string;
  readonly file: string;
  readonly group: string;
  readonly severity: "P" | "N";
  readonly sources: readonly string[];
  /**
   * The field, or the fields joined, that make an alert's series: one incident per series. With
   * none, an alert over several sources has one series per service. A field may be held to a
   * closed set of labels (SeriesField).
   */
  readonly seriesBy?: string | readonly (string | SeriesField)[];
  readonly query: AlertQuery;
  readonly operator: string;
  readonly threshold: string;
  readonly window?: string;
  readonly check_period: number;
  readonly query_period?: number;
  readonly confirmation_period: number;
  readonly recovery_period: number;
  readonly on_missing_data: string;
  readonly policy?: string;
  readonly call?: boolean;
  readonly sms?: boolean;
  readonly push?: boolean;
  readonly critical_alert?: boolean;
  readonly incident_cause?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly paused?: boolean;
}

export interface EnvConfig {
  readonly env: string;
  readonly dir: string;
  readonly sources: SourcesFile;
  readonly errors: ErrorsFile;
  readonly metrics: MetricsFile;
  readonly monitors: MonitorsFile;
  readonly heartbeats: HeartbeatsFile;
  readonly policies: PoliciesFile;
  readonly alerts: readonly AlertDef[];
  /** Every file read, by repository path, with its raw text (MC-12 scans the whole directory). */
  readonly files: ReadonlyMap<string, string>;
}

const REQUIRED_FILES = [
  "sources.json",
  "errors.json",
  "metrics.json",
  "monitors.json",
  "heartbeats.json",
  "policies.json",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replaces each `{name}` in every string inside `value`. */
export function substitute<T>(value: T, vars: Readonly<Record<string, string>>): T {
  if (typeof value === "string") {
    return value.replace(
      /(?<!\{)\{([a-z]+)\}(?!\})/g,
      (whole, key: string) => vars[key] ?? whole,
    ) as T;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars)) as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = substitute(item, vars);
    return out as T;
  }
  return value;
}

/** Expands one raw alert into its instances. */
export function expandAlert(raw: Record<string, unknown>, file: string): AlertDef[] {
  const { forEach, ...rest } = raw;
  const template = String(rest.name ?? "");
  const base = { ...rest, template, file } as unknown as AlertDef;
  if (forEach === undefined) return [base];
  if (!Array.isArray(forEach)) return [base];
  return forEach.map((item) => {
    const vars: Record<string, string> =
      typeof item === "string"
        ? { service: item }
        : isRecord(item)
          ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, String(v)]))
          : {};
    const expanded = substitute(rest, vars);
    return { ...expanded, template, file } as unknown as AlertDef;
  });
}

function readJson(path: string, label: string, findings: Finding[]): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    findings.push({
      file: label,
      rule: "MC-00",
      message: `not valid JSON (${error instanceof Error ? error.name : "error"})`,
    });
    return undefined;
  }
}

/**
 * Loads one environment's files. `root` is the repository root; paths in findings are relative
 * to it.
 */
export function loadEnv(root: string, env: string): { config?: EnvConfig; findings: Finding[] } {
  const findings: Finding[] = [];
  const dir = join(root, "ops", "monitoring", env);
  const label = (path: string) => relative(root, path).split("\\").join("/");
  if (!existsSync(dir)) {
    findings.push({ file: label(dir), rule: "MC-00", message: "the environment has no files" });
    return { findings };
  }
  const files = new Map<string, string>();
  const parsed: Record<string, unknown> = {};
  for (const name of REQUIRED_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      findings.push({ file: label(path), rule: "MC-00", message: "required file is missing" });
      continue;
    }
    files.set(label(path), readFileSync(path, "utf8"));
    parsed[name] = readJson(path, label(path), findings);
  }
  const alerts: AlertDef[] = [];
  const alertsDir = join(dir, "alerts");
  const alertFiles = existsSync(alertsDir)
    ? readdirSync(alertsDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];
  if (alertFiles.length === 0) {
    findings.push({ file: label(alertsDir), rule: "MC-00", message: "no alert fragments" });
  }
  for (const name of alertFiles) {
    const path = join(alertsDir, name);
    files.set(label(path), readFileSync(path, "utf8"));
    const raw = readJson(path, label(path), findings);
    if (!isRecord(raw) || !Array.isArray(raw.alerts)) {
      findings.push({ file: label(path), rule: "MC-00", message: 'must hold an "alerts" array' });
      continue;
    }
    for (const entry of raw.alerts) {
      if (!isRecord(entry) || typeof entry.name !== "string") {
        findings.push({ file: label(path), rule: "MC-00", message: "an alert without a name" });
        continue;
      }
      alerts.push(...expandAlert(entry, label(path)));
    }
  }
  if (findings.length > 0) return { findings };
  const config: EnvConfig = {
    env,
    dir,
    sources: parsed["sources.json"] as SourcesFile,
    errors: parsed["errors.json"] as ErrorsFile,
    metrics: parsed["metrics.json"] as MetricsFile,
    monitors: parsed["monitors.json"] as MonitorsFile,
    heartbeats: parsed["heartbeats.json"] as HeartbeatsFile,
    policies: parsed["policies.json"] as PoliciesFile,
    alerts,
    files,
  };
  return { config, findings };
}

/** The metrics a source gets, from its sets, in file order with duplicates by name removed. */
export function metricsFor(metrics: MetricsFile, service: string): MetricDef[] {
  const out = new Map<string, MetricDef>();
  for (const set of metrics.sources[service] ?? []) {
    for (const metric of metrics.sets[set] ?? []) {
      if (!out.has(metric.name)) out.set(metric.name, metric);
    }
  }
  return [...out.values()];
}

/** The SQL a metric is extracted with (spec 08 §7.4's form). */
export function metricExpression(metric: MetricDef): string {
  const type = metric.aggregations.length === 0 ? "String" : "Float64";
  return `JSONExtract(raw, '${metric.field}', 'Nullable(${type})')`;
}

/** The overlay keys an alert or heartbeat reads (`@thresholds.x`, `@grace.x`). */
export function overlayKeys(value: string): string[] {
  return [...value.matchAll(/@((?:thresholds|grace)\.[a-z0-9][a-z0-9-]*)/g)].map((m) => m[1] ?? "");
}
