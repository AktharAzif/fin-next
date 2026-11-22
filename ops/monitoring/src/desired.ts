// Turns ops/monitoring/<env>/ plus the run's private settings (hostnames, the overlay's thresholds
// and grace periods, the monitor header) into the Better Stack objects the environment should
// have. Objects refer to each other by name ({ $ref: "<kind>:<name>" }); the apply resolves the
// names to IDs at run time, so no ID is ever written down.
import {
  type AlertDef,
  type EnvConfig,
  metricExpression,
  metricsFor,
  type Notify,
  overlayKeys,
} from "./config.ts";
import { renderSql, seriesFields } from "./sql.ts";

export type Kind =
  | "urgency"
  | "policy"
  | "source"
  | "metric"
  | "application"
  | "exploration"
  | "alert"
  | "monitor"
  | "heartbeat";

/** The order objects are created in, parents first. */
export const KIND_ORDER: readonly Kind[] = [
  "urgency",
  "policy",
  "source",
  "metric",
  "application",
  "exploration",
  "alert",
  "monitor",
  "heartbeat",
];

export interface Ref {
  readonly $ref: string;
  /** Better Stack wants some IDs as integers (urgency_id, an alert's policy_id). */
  readonly as?: "number";
}

export const ref = (kind: Kind, name: string, as?: "number"): Ref =>
  as === undefined ? { $ref: `${kind}:${name}` } : { $ref: `${kind}:${name}`, as };

export function isRef(value: unknown): value is Ref {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $ref?: unknown }).$ref === "string"
  );
}

/** A secret the apply hands to a service after it creates the object (never printed). */
export interface Delivery {
  readonly services: readonly string[];
  readonly variables: Readonly<Record<string, "token" | "ingesting_host" | "dsn" | "url">>;
}

export interface DesiredObject {
  readonly kind: Kind;
  /** Unique within the kind: the object's name, or "<source>/<metric>" for a metric. */
  readonly key: string;
  /** For a metric its source's key; for an alert its exploration's key. */
  readonly parent?: string;
  readonly body: Readonly<Record<string, unknown>>;
  /** Attributes Better Stack fixes at creation: a difference is reported, never sent. */
  readonly immutable?: readonly string[];
  readonly delivery?: Delivery;
  /**
   * Compared attributes that hold one of the overlay's private numbers ([OB-13]: a threshold, a
   * window, a minimum count, a grace period), each with what a change prints in its place
   * (`<threshold:process-restarts>`): neither side of such a change is ever printed.
   */
  readonly private?: Readonly<Record<string, string>>;
}

/** What a private number prints as: `<threshold:<name>>` or `<grace:<name>>`, as pnpm fin does. */
export function placeholderOf(key: string): string {
  const [family, name = ""] = key.split(/\.(.*)/s);
  return `<${family === "grace" ? "grace" : "threshold"}:${name}>`;
}

/** The placeholder of the overlay key a file's value names (`@thresholds.x`), if it names one. */
function privateAs(value: string | undefined): string | undefined {
  const key = value === undefined ? undefined : overlayKeys(value)[0];
  return key === undefined ? undefined : placeholderOf(key);
}

export interface RunSettings {
  /** Host role to the real hostname, from the deploy configuration. Never committed. */
  readonly hosts: Readonly<Record<string, string>>;
  readonly thresholds: Readonly<Record<string, number>>;
  readonly grace: Readonly<Record<string, number>>;
  /** The secret monitor header's value, from FIN_MONITOR_HEADER_FILE; absent in a dry run. */
  readonly monitorHeader?: string;
  /** One exploration per source instead of one over all of an alert's sources. */
  readonly splitSources?: boolean;
}

export interface Desired {
  readonly objects: readonly DesiredObject[];
  /** Overlay keys the files name that the run's settings lack (MA-10). */
  readonly missing: readonly string[];
}

const CHANNELS = ["email", "sms", "call", "push", "critical_alert"] as const;

function channels(notify: Notify): Record<string, boolean> {
  return Object.fromEntries(CHANNELS.map((c) => [c, notify[c] === true]));
}

/**
 * What a monitor or heartbeat sends besides its channels, so nothing silences or widens it: no
 * maintenance window (no incident is opened inside one) and no team wait (which escalates to the
 * whole team's own channels).
 */
const QUIET_FIELDS = { maintenance_from: null, maintenance_to: null, team_wait: null } as const;

export const EXPLORATION_PREFIX = "fin/";

/** Resolves `@thresholds.x` or `@grace.x` against the settings, recording a missing key. */
function lookup(value: string, settings: RunSettings, missing: Set<string>): number | undefined {
  const key = overlayKeys(value)[0];
  if (key === undefined) return undefined;
  const [family, name = ""] = key.split(/\.(.*)/s);
  const table = family === "grace" ? settings.grace : settings.thresholds;
  const number = table[name];
  if (typeof number !== "number" || !Number.isFinite(number)) {
    missing.add(key);
    return undefined;
  }
  return number;
}

function alertObjects(
  alert: AlertDef,
  config: EnvConfig,
  settings: RunSettings,
  missing: Set<string>,
): DesiredObject[] {
  const prefix = config.sources.namePrefix;
  let value: number;
  if (alert.threshold === "@any") value = 0;
  else if (alert.threshold === "@none") value = 1;
  else value = lookup(alert.threshold, settings, missing) ?? Number.NaN;
  const numbers: Record<string, number> = {};
  if ("ratio" in alert.query) {
    const min = lookup(`@${alert.query.ratio.minCount}`, settings, missing);
    if (min !== undefined) numbers[alert.query.ratio.minCount] = min;
    else numbers[alert.query.ratio.minCount] = 0;
  }
  const queryPeriod =
    alert.window !== undefined
      ? (lookup(alert.window, settings, missing) ?? Number.NaN)
      : (alert.query_period ?? Number.NaN);
  const groups: { suffix: string; sources: readonly string[] }[] =
    settings.splitSources === true && alert.sources.length > 1
      ? alert.sources.map((s) => ({ suffix: ` (${s})`, sources: [s] }))
      : [{ suffix: "", sources: alert.sources }];
  // What carries a private number: the threshold and the window, and the query that holds a
  // minimum count (its digest would name the number, since the rest of the query is public).
  const hidden: Record<string, string> = {};
  const threshold = privateAs(alert.threshold);
  if (threshold !== undefined) hidden.value = threshold;
  const window = privateAs(alert.window);
  if (window !== undefined) hidden.query_period = window;
  const minCount = "ratio" in alert.query ? privateAs(`@${alert.query.ratio.minCount}`) : undefined;
  const out: DesiredObject[] = [];
  for (const group of groups) {
    const name = `${alert.name}${group.suffix}`;
    const instance: AlertDef = { ...alert, sources: group.sources };
    const sql = renderSql(instance, numbers);
    const exploration = `${EXPLORATION_PREFIX}${name}`;
    out.push({
      kind: "exploration",
      key: exploration,
      ...(minCount === undefined ? {} : { private: { query: `(a query with ${minCount})` } }),
      body: {
        name: exploration,
        date_range_from: "now-3h",
        date_range_to: "now",
        chart: { chart_type: "line_chart", description: alert.incident_cause ?? "" },
        queries: [
          {
            name: "value",
            query_type: "sql_expression",
            sql_query: sql,
            source_variable: "source",
          },
        ],
        variables: [
          {
            name: "source",
            variable_type: "source",
            values: group.sources.map((s) => ref("source", `${prefix}${s}`)),
          },
        ],
      },
    });
    const metadata: Record<string, string> = {
      ...(alert.metadata ?? {}),
      environment: config.env,
      group: alert.group,
      severity: alert.severity,
    };
    out.push({
      kind: "alert",
      key: name,
      parent: exploration,
      ...(Object.keys(hidden).length === 0 ? {} : { private: hidden }),
      body: {
        name,
        alert_type: "threshold",
        operator: alert.operator,
        value,
        check_period: alert.check_period,
        query_period: queryPeriod,
        confirmation_period: alert.confirmation_period,
        recovery_period: alert.recovery_period,
        on_missing_data: alert.on_missing_data,
        incident_cause: alert.incident_cause ?? "",
        incident_per_series: seriesFields(instance) !== undefined,
        escalation_target: { policy_id: ref("policy", alert.policy ?? "", "number") },
        // Sent and compared on every alert, so none takes Better Stack's defaults (MA-06).
        ...channels({
          email: true,
          ...(alert.call === undefined ? {} : { call: alert.call }),
          ...(alert.sms === undefined ? {} : { sms: alert.sms }),
          ...(alert.push === undefined ? {} : { push: alert.push }),
          ...(alert.critical_alert === undefined ? {} : { critical_alert: alert.critical_alert }),
        }),
        metadata,
        paused: false,
      },
    });
  }
  return out;
}

/** Builds every object the files describe. */
export function buildDesired(config: EnvConfig, settings: RunSettings): Desired {
  const missing = new Set<string>();
  const objects: DesiredObject[] = [];
  const prefix = config.sources.namePrefix;

  for (const severity of config.policies.severities) {
    objects.push({
      kind: "urgency",
      key: severity.name,
      body: { name: severity.name, ...channels(severity) },
    });
  }
  for (const policy of config.policies.policies) {
    objects.push({
      kind: "policy",
      key: policy.name,
      body: {
        name: policy.name,
        repeat_count: policy.repeatCount,
        repeat_delay: policy.repeatDelay,
        steps: policy.steps.map((step) => ({
          type: "escalation",
          wait_before: step.waitBefore,
          urgency_id: ref("urgency", step.severity, "number"),
          step_members: step.members.map((m) => ({ ...m })),
        })),
      },
    });
  }
  for (const source of config.sources.sources) {
    const name = `${prefix}${source.service}`;
    objects.push({
      kind: "source",
      key: name,
      body: { name, platform: config.sources.platform, data_region: config.sources.dataRegion },
      immutable: ["platform", "data_region"],
      delivery: {
        services: source.holders ?? [source.service],
        variables: { FIN_TELEMETRY_HOST: "ingesting_host", FIN_TELEMETRY_TOKEN: "token" },
      },
    });
    for (const metric of metricsFor(config.metrics, source.service)) {
      objects.push({
        kind: "metric",
        key: `${name}/${metric.name}`,
        parent: name,
        body: {
          name: metric.name,
          sql_expression: metricExpression(metric),
          type: metric.type,
          aggregations: [...metric.aggregations],
        },
        // A metric's type decides its column; Better Stack fixes it when the metric is made.
        immutable: ["type"],
      });
    }
  }
  for (const app of config.errors.applications) {
    const name = `${config.errors.namePrefix}${app.name}`;
    objects.push({
      kind: "application",
      key: name,
      body: {
        name,
        platform: app.platform,
        errors_retention: config.errors.retentionDays,
        ...(app.source === undefined
          ? {}
          : { correlate_with_source_id: ref("source", `${prefix}${app.source}`) }),
      },
      immutable: ["platform", "correlate_with_source_id"],
      delivery: { services: app.holders, variables: { [app.variable]: "dsn" } },
    });
  }
  for (const alert of config.alerts)
    objects.push(...alertObjects(alert, config, settings, missing));

  const md = config.monitors.defaults;
  for (const monitor of config.monitors.monitors) {
    const host = settings.hosts[monitor.host];
    if (host === undefined || host === "") missing.add(`hosts.${monitor.host}`);
    objects.push({
      kind: "monitor",
      key: monitor.name,
      body: {
        pronounceable_name: monitor.name,
        url: `https://${host ?? `<${monitor.host}>`}${monitor.path}`,
        monitor_type: monitor.type,
        check_frequency: md.checkFrequency,
        regions: [...md.regions],
        request_timeout: md.requestTimeout,
        confirmation_period: md.confirmationPeriod,
        recovery_period: md.recoveryPeriod,
        verify_ssl: md.verifySsl,
        ssl_expiration: md.sslExpiration,
        domain_expiration: md.domainExpiration,
        follow_redirects: md.followRedirects,
        http_method: "GET",
        ...(monitor.expectStatus === undefined
          ? {}
          : { expected_status_codes: [...monitor.expectStatus] }),
        ...(monitor.keyword === undefined ? {} : { required_keyword: monitor.keyword }),
        request_headers: [{ name: md.secretHeader, value: settings.monitorHeader ?? null }],
        policy_id: ref("policy", monitor.policy ?? md.policy),
        ...channels({ ...md.notify, ...monitor.notify }),
        ...QUIET_FIELDS,
        paused: false,
      },
    });
  }
  const hd = config.heartbeats.defaults;
  for (const heartbeat of config.heartbeats.heartbeats) {
    const grace = lookup(heartbeat.grace, settings, missing);
    const graceAs = privateAs(heartbeat.grace);
    objects.push({
      kind: "heartbeat",
      key: heartbeat.name,
      ...(graceAs === undefined ? {} : { private: { grace: graceAs } }),
      body: {
        name: heartbeat.name,
        period: heartbeat.period,
        grace: grace ?? Number.NaN,
        policy_id: ref("policy", heartbeat.policy ?? hd.policy),
        ...channels({ ...hd.notify, ...heartbeat.notify }),
        ...QUIET_FIELDS,
        paused: false,
      },
      delivery: {
        services: [...heartbeat.holders],
        variables: {
          [`FIN_HEARTBEAT_${heartbeat.name.toUpperCase().replace(/-/g, "_")}_URL`]: "url",
        },
      },
    });
  }
  return { objects, missing: [...missing].sort() };
}
