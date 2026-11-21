// monitoring:check (spec 08 §7.11; ARCHITECTURE §10.11): the rules over ops/monitoring/<env>/ and
// the catalogue, with no network, in well under a second. It fails when:
//   MC-00 a file is missing or malformed, or an alert has an unexpanded placeholder;
//   MC-01 an event written in code (`log("<name>", ...)`) is missing from the catalogue, a
//         catalogue entry is listed twice, or one of spec 01 §8.9's Phase 0 events is missing;
//   MC-02 a failure, security or money entry has no alert and no noAlert reason;
//   MC-03 an entry redeclares an envelope field, or a reason code breaks the ReasonCode shape;
//   MC-04 an alert reads an event or field the catalogue does not declare, a catalogue entry names
//         an alert no fragment defines (or an alert watches an event whose entry does not name
//         it), or an alert's query cannot be rendered;
//   MC-06 a metric label is ID-shaped or free text;
//   MC-07 a source has no Errors application and no written reason, or a file names a source
//         that does not exist;
//   MC-08 an alert lacks incident_cause, metadata.check, metadata.flow or metadata.runbook, or a
//         runbook (an alert's, a monitor's or a heartbeat's) does not exist;
//   MC-10 a runbook lacks one of Phase 0's headings, or does not name an alert that points at it;
//   MC-11 a threshold, window, minimum count or grace is a literal number instead of an overlay
//         key;
//   MC-12 a file holds a Better Stack identifier, ingest host, DSN or heartbeat URL;
//   MC-13 a staging object names a production policy;
//   MC-14 an alert name is used twice;
//   RT-01 an alert, monitor or heartbeat has no policy, or a staging one names anything but
//         staging-quiet, or names a policy the files do not define;
//   RT-02 staging-quiet is not email only: a severity that calls, texts, pushes or sends critical
//         alerts, an escalation (a repeat or a second step), or an ai_sre member;
//   RT-03 any staging object asks for a call, an SMS, a push or a critical alert itself.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fragments as defaultFragments } from "../catalog/index.ts";
import { type CatalogEntry, ENVELOPE_FIELDS, kindsOf } from "../catalog/types.ts";
import {
  type AlertDef,
  type EnvConfig,
  type Finding,
  loadEnv,
  type Notify,
  overlayKeys,
} from "./config.ts";
import { QueryError, queryEvents, queryFields, renderSql, seriesField } from "./sql.ts";

/** Spec 01 §8.9: every event Phase 0 writes. platform.ts must hold each one. */
export const PHASE0_EVENTS: readonly string[] = [
  "request",
  "process.start",
  "process.health",
  "shutdown.started",
  "shutdown.done",
  "shutdown.forced",
  "process.uncaught_exception",
  "process.unhandled_rejection",
  "background.failed",
  "database.pool_error",
  "dns.lookup_failed",
  "connector.state",
  "connector.health",
  "connector.exited",
  "ingress.untrusted_peer",
  "csrf.refused",
  "api.outside_request",
  "caller.signature_invalid",
  "telemetry.ship_failed",
  "telemetry.recovered",
  "error.unexpected",
  "migrate.started",
  "migrate.done",
  "migrate.failed",
  "task.done",
  "task.failed",
  "job.run",
  "email.sent",
  "email.send_failed",
  "csp.report",
  "watcher.run",
  "watcher.check_failed",
  "deploy.started",
  "deploy.step",
  "deploy.done",
  "deploy.failed",
  "run.registered",
  "run.done",
];

/** The headings every Phase 0 runbook has (spec 01 §8.7: short runbooks). */
export const RUNBOOK_HEADINGS: readonly string[] = [
  "## What it means",
  "## First check",
  "## Containment",
  "## When to wake the owner",
];

const QUIET_POLICY = "staging-quiet";
const REASON_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
const FLOW_ID = /^F(?:\d{1,2}|-[a-z0-9-]+)$/;
const THRESHOLD = /^@(?:any|none|thresholds\.[a-z0-9][a-z0-9-]*)$/;
const ID_SHAPED_FIELD = /(?:Id|ID|_id)$|^(?:cfRay|dt|message|replica|release|detail|target|runId)$/;
const NOTIFY_KEYS = ["sms", "call", "push", "critical_alert"] as const;
const LOG_CALL = /\blog\(\s*["']([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)["']/g;
const CODE_DIRS = ["apps", "packages", "ops", "tools"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage", "test", "fixtures"]);

/** Better Stack identifiers, ingest hosts, DSNs and heartbeat URLs (MC-12). */
const IDENTIFIER_SHAPES: readonly { name: string; pattern: RegExp }[] = [
  { name: "ingest host", pattern: /betterstackdata\.com/i },
  { name: "heartbeat URL", pattern: /\/api\/v\d+\/heartbeat\//i },
  { name: "DSN", pattern: /https?:\/\/[A-Za-z0-9]{8,}@/ },
  { name: "team ID", pattern: /(?<![A-Za-z0-9])t\d{4,}(?![A-Za-z0-9])/ },
  {
    name: "object ID",
    pattern:
      /"(?:id|team_id|source_id|policy_id|monitor_id|heartbeat_id|exploration_id|urgency_id|application_id)"\s*:/,
  },
  { name: "token field", pattern: /"(?:token|ingesting_host|url|dsn)"\s*:/ },
];

export interface CheckOptions {
  readonly envs?: readonly string[];
  readonly fragments?: Readonly<Record<string, readonly CatalogEntry[]>>;
  /** Extra files scanned for MC-12, relative to root (directories are walked). */
  readonly scan?: readonly string[];
  /** Whether to scan the repository's code for log("...") calls (MC-01). */
  readonly scanCode?: boolean;
}

function walk(root: string, dir: string, out: string[]): void {
  const full = join(root, dir);
  if (!existsSync(full)) return;
  for (const name of readdirSync(full)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const rel = `${dir}/${name}`;
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
}

/** Events written in code: `log("<event>", ...)` in TypeScript outside tests. */
export function eventsInCode(root: string): Map<string, string> {
  const files: string[] = [];
  for (const dir of CODE_DIRS) walk(root, dir, files);
  const found = new Map<string, string>();
  for (const file of files) {
    if (!/\.tsx?$/.test(file) || /\.(?:db\.)?test\.tsx?$/.test(file)) continue;
    if (file.startsWith("ops/monitoring/")) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(LOG_CALL)) {
      const event = match[1] ?? "";
      if (!found.has(event)) found.set(event, file);
    }
  }
  return found;
}

function envDirs(root: string): string[] {
  const base = join(root, "ops", "monitoring");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => existsSync(join(base, name, "sources.json")))
    .sort();
}

function notifyFindings(file: string, what: string, notify: Notify | undefined): Finding[] {
  if (notify === undefined) return [];
  return NOTIFY_KEYS.filter((key) => notify[key] === true).map((key) => ({
    file,
    rule: "RT-03",
    message: `${what} asks for ${key}: staging stays quiet (email only)`,
  }));
}

function checkCatalogue(
  fragments: Readonly<Record<string, readonly CatalogEntry[]>>,
  root: string,
  scanCode: boolean,
): { findings: Finding[]; byEvent: Map<string, CatalogEntry> } {
  const findings: Finding[] = [];
  const byEvent = new Map<string, CatalogEntry>();
  for (const [area, entries] of Object.entries(fragments)) {
    const file = `ops/monitoring/catalog/${area}.ts`;
    for (const entry of entries) {
      if (byEvent.has(entry.event)) {
        findings.push({ file, rule: "MC-01", message: `${entry.event} is catalogued twice` });
      }
      byEvent.set(entry.event, entry);
      const kinds = kindsOf(entry);
      const watched = kinds.some((k) => k === "failure" || k === "security" || k === "money");
      if (watched && entry.alerts.length === 0 && (entry.noAlert ?? "").trim() === "") {
        findings.push({
          file,
          rule: "MC-02",
          message: `${entry.event} is ${kinds.join(" and ")} with no alert and no noAlert reason`,
        });
      }
      for (const name of Object.keys(entry.fields)) {
        if (ENVELOPE_FIELDS.includes(name)) {
          findings.push({
            file,
            rule: "MC-03",
            message: `${entry.event} redeclares the envelope field ${name}`,
          });
        }
      }
      for (const reason of entry.reasons ?? []) {
        if (!REASON_CODE.test(reason) || reason.length > 64) {
          findings.push({
            file,
            rule: "MC-03",
            message: `${entry.event}: reason ${reason} breaks the ReasonCode shape`,
          });
        }
      }
    }
  }
  const catalogDir = join(root, "ops", "monitoring", "catalog");
  if (existsSync(catalogDir)) {
    for (const name of readdirSync(catalogDir)) {
      const area = name.replace(/\.ts$/, "");
      if (!name.endsWith(".ts") || area === "types" || area === "index") continue;
      if (!(area in fragments)) {
        findings.push({
          file: `ops/monitoring/catalog/${name}`,
          rule: "MC-01",
          message: "a catalogue fragment that catalog/index.ts does not list",
        });
      }
    }
  }
  for (const event of PHASE0_EVENTS) {
    if (!byEvent.has(event)) {
      findings.push({
        file: "ops/monitoring/catalog/platform.ts",
        rule: "MC-01",
        message: `spec 01 §8.9's event ${event} is not catalogued`,
      });
    }
  }
  if (scanCode) {
    for (const [event, file] of eventsInCode(root)) {
      if (!byEvent.has(event)) {
        findings.push({ file, rule: "MC-01", message: `log("${event}") is not catalogued` });
      }
    }
  }
  return { findings, byEvent };
}

function fieldsOf(entry: CatalogEntry | undefined): Set<string> {
  return new Set([...ENVELOPE_FIELDS, ...Object.keys(entry?.fields ?? {})]);
}

function checkAlert(
  alert: AlertDef,
  config: EnvConfig,
  byEvent: Map<string, CatalogEntry>,
  sourceNames: Set<string>,
  policyNames: Set<string>,
  root: string,
): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: string, message: string) =>
    findings.push({ file: alert.file, rule, message: `${alert.name}: ${message}` });
  const { template: _template, ...expanded } = alert;
  if (/(?<!\{)\{[a-z]+\}(?!\})/.test(JSON.stringify(expanded))) {
    add("MC-00", "an unexpanded {placeholder} remains (forEach does not provide it)");
  }
  if (alert.severity !== "P" && alert.severity !== "N") add("MC-00", "severity must be P or N");
  if (!Array.isArray(alert.sources) || alert.sources.length === 0) {
    add("MC-00", "names no source");
  }
  for (const source of alert.sources ?? []) {
    if (!sourceNames.has(source)) add("MC-07", `names the source ${source}, which does not exist`);
  }
  // Routing.
  if (alert.policy === undefined || alert.policy === "") add("RT-01", "has no policy");
  else if (config.env === "staging" && alert.policy !== QUIET_POLICY) {
    add(alert.policy.startsWith("production-") ? "MC-13" : "RT-01", `routes to ${alert.policy}`);
  } else if (!policyNames.has(alert.policy)) add("RT-01", `names an undefined policy`);
  for (const key of NOTIFY_KEYS) {
    if (alert[key] === true) add("RT-03", `asks for ${key}: staging stays quiet`);
  }
  // Metadata and runbook.
  if ((alert.incident_cause ?? "").trim() === "") add("MC-08", "has no incident_cause");
  const meta = alert.metadata ?? {};
  for (const key of ["check", "flow", "runbook"]) {
    if ((meta[key] ?? "").trim() === "") add("MC-08", `has no metadata.${key}`);
  }
  const flow = meta.flow ?? "";
  if (flow !== "" && !FLOW_ID.test(flow)) add("MC-08", `metadata.flow ${flow} is not a flow ID`);
  const atlas = join(root, "docs", "flows", "atlas.json");
  if (flow !== "" && existsSync(atlas) && !readFileSync(atlas, "utf8").includes(`"${flow}"`)) {
    add("MC-08", `metadata.flow ${flow} is not in docs/flows/atlas.json`);
  }
  const runbook = meta.runbook ?? "";
  if (runbook !== "" && (!runbook.startsWith("docs/runbooks/") || !runbook.endsWith(".md"))) {
    add("MC-08", "metadata.runbook must be a docs/runbooks/*.md path");
  } else if (runbook !== "" && !existsSync(join(root, runbook))) {
    add("MC-08", `its runbook ${runbook} does not exist`);
  }
  // Thresholds name overlay keys.
  if (typeof alert.threshold !== "string" || !THRESHOLD.test(alert.threshold)) {
    add("MC-11", "threshold must be @any, @none or an @thresholds.<key> overlay key");
  } else if (alert.threshold === "@any" && alert.operator !== "higher_than") {
    add("MC-00", "@any needs the operator higher_than");
  } else if (alert.threshold === "@none" && alert.operator !== "lower_than") {
    add("MC-00", "@none needs the operator lower_than");
  }
  if (alert.window !== undefined && overlayKeys(alert.window).length !== 1) {
    add("MC-11", "window must be an @thresholds.<key> overlay key");
  }
  if (alert.window === undefined && typeof alert.query_period !== "number") {
    add("MC-00", "needs a query_period or a window");
  }
  if ("ratio" in alert.query && overlayKeys(`@${alert.query.ratio.minCount}`).length === 0) {
    add("MC-11", "ratio.minCount must be an @thresholds.<key> overlay key");
  }
  // The catalogue.
  for (const event of queryEvents(alert.query)) {
    const entry = byEvent.get(event);
    if (entry === undefined) {
      add("MC-04", `reads the event ${event}, which is not catalogued`);
      continue;
    }
    if (!entry.alerts.includes(alert.template)) {
      add("MC-04", `watches ${event}, whose catalogue entry does not name ${alert.template}`);
    }
  }
  const events = queryEvents(alert.query);
  const declared = new Set(events.flatMap((e) => [...fieldsOf(byEvent.get(e))]));
  const series = seriesField(alert);
  for (const name of [...queryFields(alert.query), ...(series === undefined ? [] : [series])]) {
    if (events.length > 0 && !declared.has(name)) {
      add("MC-04", `reads the field ${name}, which no watched event declares`);
    }
  }
  try {
    const numbers: Record<string, number> = {};
    if ("ratio" in alert.query) numbers[alert.query.ratio.minCount] = 1;
    renderSql(alert, numbers);
  } catch (error) {
    add(
      "MC-04",
      `its query cannot be rendered (${error instanceof QueryError ? error.message : "error"})`,
    );
  }
  return findings;
}

function checkRunbook(root: string, path: string, names: readonly string[]): Finding[] {
  const full = join(root, path);
  if (!existsSync(full)) return [];
  const text = readFileSync(full, "utf8");
  const findings: Finding[] = [];
  for (const heading of RUNBOOK_HEADINGS) {
    if (!text.split("\n").some((line) => line.trim() === heading)) {
      findings.push({ file: path, rule: "MC-10", message: `lacks the heading "${heading}"` });
    }
  }
  for (const name of names) {
    if (!text.includes(`\`${name}\``)) {
      findings.push({
        file: path,
        rule: "MC-10",
        message: `does not name ${name}, which points at it`,
      });
    }
  }
  return findings;
}

function checkIdentifiers(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const shape of IDENTIFIER_SHAPES) {
      if (shape.pattern.test(line)) {
        findings.push({
          file: `${file}:${index + 1}`,
          rule: "MC-12",
          message: `holds what looks like a Better Stack ${shape.name}`,
        });
      }
    }
  }
  return findings;
}

function checkEnv(config: EnvConfig, byEvent: Map<string, CatalogEntry>, root: string): Finding[] {
  const findings: Finding[] = [];
  const base = `ops/monitoring/${config.env}`;
  const { sources, errors, metrics, monitors, heartbeats, policies } = config;
  const sourceNames = new Set(sources.sources.map((s) => s.service));

  // MC-07: every source has an Errors application or a written reason.
  const covered = new Set<string>();
  for (const app of errors.applications) {
    if (app.source !== undefined) {
      if (!sourceNames.has(app.source)) {
        findings.push({
          file: `${base}/errors.json`,
          rule: "MC-07",
          message: `${app.name} correlates with ${app.source}, which is not a source`,
        });
      }
      covered.add(app.source);
    }
    for (const user of app.alsoUsedBy ?? []) covered.add(user);
    if (!Array.isArray(app.holders) || typeof app.variable !== "string") {
      findings.push({
        file: `${base}/errors.json`,
        rule: "MC-00",
        message: `${app.name}: needs holders and variable (where its DSN is delivered)`,
      });
    }
    if (!/_errors$/.test(app.platform)) {
      findings.push({
        file: `${base}/errors.json`,
        rule: "MC-00",
        message: `${app.name}: an Errors platform ends in _errors`,
      });
    }
  }
  const reasons = errors.noApplication ?? {};
  for (const source of sourceNames) {
    if (!covered.has(source) && (reasons[source] ?? "").trim() === "") {
      findings.push({
        file: `${base}/errors.json`,
        rule: "MC-07",
        message: `the source ${source} has no Errors application and no reason`,
      });
    }
  }

  // MC-06 and MC-07 for metrics.
  for (const name of Object.keys(metrics.sources)) {
    if (!sourceNames.has(name)) {
      findings.push({
        file: `${base}/metrics.json`,
        rule: "MC-07",
        message: `metrics for ${name}, which is not a source`,
      });
    }
    for (const set of metrics.sources[name] ?? []) {
      if (!(set in metrics.sets)) {
        findings.push({
          file: `${base}/metrics.json`,
          rule: "MC-00",
          message: `${name} names the unknown set ${set}`,
        });
      }
    }
  }
  const allFields = new Set<string>(ENVELOPE_FIELDS);
  for (const entry of byEvent.values()) for (const f of Object.keys(entry.fields)) allFields.add(f);
  for (const [set, defs] of Object.entries(metrics.sets)) {
    for (const metric of defs) {
      const label = metric.aggregations.length === 0;
      if (label && ID_SHAPED_FIELD.test(metric.field)) {
        findings.push({
          file: `${base}/metrics.json`,
          rule: "MC-06",
          message: `${set}.${metric.name}: the label ${metric.field} is ID-shaped or free text`,
        });
      }
      if (label && metric.type !== "string_low_cardinality") {
        findings.push({
          file: `${base}/metrics.json`,
          rule: "MC-06",
          message: `${set}.${metric.name}: a label is string_low_cardinality`,
        });
      }
      if (!allFields.has(metric.field)) {
        findings.push({
          file: `${base}/metrics.json`,
          rule: "MC-04",
          message: `${set}.${metric.name} reads ${metric.field}, which no catalogued event declares`,
        });
      }
    }
  }

  // Policies: staging-quiet exists and is email only (RT-02).
  const policyNames = new Set(policies.policies.map((p) => p.name));
  const severities = new Map(policies.severities.map((s) => [s.name, s]));
  if (policies.team !== sources.team) {
    findings.push({
      file: `${base}/policies.json`,
      rule: "RT-01",
      message: "the policies' team differs from the sources' team",
    });
  }
  if (config.env === "staging") {
    if (!policyNames.has(QUIET_POLICY)) {
      findings.push({ file: `${base}/policies.json`, rule: "RT-01", message: "no staging-quiet" });
    }
    for (const policy of policies.policies) {
      if (policy.name !== QUIET_POLICY) {
        findings.push({
          file: `${base}/policies.json`,
          rule: policy.name.startsWith("production-") ? "MC-13" : "RT-01",
          message: `staging defines ${policy.name}; staging has staging-quiet only`,
        });
      }
    }
  }
  for (const policy of policies.policies) {
    const file = `${base}/policies.json`;
    if (config.env === "staging" && (policy.repeatCount !== 0 || policy.steps.length !== 1)) {
      findings.push({ file, rule: "RT-02", message: `${policy.name} escalates or repeats` });
    }
    for (const step of policy.steps) {
      const severity = severities.get(step.severity);
      if (severity === undefined) {
        findings.push({ file, rule: "RT-02", message: `${policy.name}: unknown severity` });
      } else if (config.env === "staging") {
        findings.push(...notifyFindings(file, `severity ${severity.name}`, severity));
        if (severity.email !== true) {
          findings.push({
            file,
            rule: "RT-02",
            message: `severity ${severity.name} sends no email`,
          });
        }
      }
      for (const member of step.members) {
        if (member.type === "ai_sre") {
          findings.push({ file, rule: "RT-02", message: `${policy.name} has an ai_sre member` });
        }
      }
    }
  }

  // Alerts.
  const seen = new Map<string, string>();
  const runbookUsers = new Map<string, string[]>();
  const point = (runbook: string | undefined, name: string) => {
    if (runbook === undefined || runbook === "") return;
    runbookUsers.set(runbook, [...(runbookUsers.get(runbook) ?? []), name]);
  };
  for (const alert of config.alerts) {
    const other = seen.get(alert.name);
    if (other !== undefined) {
      findings.push({
        file: alert.file,
        rule: "MC-14",
        message: `${alert.name} is also defined in ${other}`,
      });
    }
    seen.set(alert.name, alert.file);
    findings.push(...checkAlert(alert, config, byEvent, sourceNames, policyNames, root));
    point(alert.metadata?.runbook, alert.template);
  }
  const templates = new Set(config.alerts.map((a) => a.template));
  for (const entry of byEvent.values()) {
    for (const name of entry.alerts) {
      if (!templates.has(name)) {
        findings.push({
          file: "ops/monitoring/catalog",
          rule: "MC-04",
          message: `${entry.event} names the alert ${name}, which no ${config.env} fragment defines`,
        });
      }
    }
  }

  // Monitors and heartbeats: policy, quiet, runbook.
  const objects = [
    ...monitors.monitors.map((m) => ({
      file: `${base}/monitors.json`,
      what: `monitor ${m.name}`,
      name: m.name,
      policy: m.policy ?? monitors.defaults.policy,
      notify: { ...monitors.defaults.notify, ...m.notify },
      runbook: m.runbook ?? monitors.defaults.runbook,
    })),
    ...heartbeats.heartbeats.map((h) => ({
      file: `${base}/heartbeats.json`,
      what: `heartbeat ${h.name}`,
      name: h.name,
      policy: h.policy ?? heartbeats.defaults.policy,
      notify: { ...heartbeats.defaults.notify, ...h.notify },
      runbook: h.runbook ?? heartbeats.defaults.runbook,
    })),
  ];
  for (const object of objects) {
    if (object.policy === undefined || object.policy === "") {
      findings.push({ file: object.file, rule: "RT-01", message: `${object.what} has no policy` });
    } else if (config.env === "staging" && object.policy !== QUIET_POLICY) {
      findings.push({
        file: object.file,
        rule: object.policy.startsWith("production-") ? "MC-13" : "RT-01",
        message: `${object.what} routes to ${object.policy}`,
      });
    } else if (!policyNames.has(object.policy)) {
      findings.push({
        file: object.file,
        rule: "RT-01",
        message: `${object.what}: unknown policy`,
      });
    }
    if (config.env === "staging")
      findings.push(...notifyFindings(object.file, object.what, object.notify));
    if (!existsSync(join(root, object.runbook))) {
      findings.push({
        file: object.file,
        rule: "MC-08",
        message: `${object.what}: its runbook ${object.runbook} does not exist`,
      });
    }
    point(object.runbook, object.name);
  }
  for (const monitor of monitors.monitors) {
    if (/[./]/.test(monitor.host) || !/^[a-z]+$/.test(monitor.host)) {
      findings.push({
        file: `${base}/monitors.json`,
        rule: "MC-00",
        message: `monitor ${monitor.name}: host must be a host role, never a hostname`,
      });
    }
    if (!monitor.path.startsWith("/")) {
      findings.push({
        file: `${base}/monitors.json`,
        rule: "MC-00",
        message: `monitor ${monitor.name}: path must start with /`,
      });
    }
    if (monitor.type === "keyword" && (monitor.keyword ?? "") === "") {
      findings.push({
        file: `${base}/monitors.json`,
        rule: "MC-00",
        message: `monitor ${monitor.name}: a keyword monitor needs its keyword`,
      });
    }
    if (monitor.type === "expected_status_code" && (monitor.expectStatus ?? []).length === 0) {
      findings.push({
        file: `${base}/monitors.json`,
        rule: "MC-00",
        message: `monitor ${monitor.name}: needs expectStatus`,
      });
    }
  }
  for (const heartbeat of heartbeats.heartbeats) {
    if (!/^@grace\.[a-z0-9-]+$/.test(String(heartbeat.grace))) {
      findings.push({
        file: `${base}/heartbeats.json`,
        rule: "MC-11",
        message: `heartbeat ${heartbeat.name}: grace must be an @grace.<key> overlay key`,
      });
    }
  }

  // MC-10: each runbook has the headings and names who points at it.
  for (const [runbook, names] of runbookUsers) {
    findings.push(...checkRunbook(root, runbook, [...new Set(names)]));
  }

  // MC-12 over every file of the environment.
  for (const [file, text] of config.files) findings.push(...checkIdentifiers(file, text));
  return findings;
}

/** Runs every rule. Returns the findings, empty when the files pass. */
export function checkMonitoring(root: string, options: CheckOptions = {}): Finding[] {
  const fragments = options.fragments ?? defaultFragments;
  const { findings, byEvent } = checkCatalogue(fragments, root, options.scanCode ?? true);
  const envs = options.envs ?? envDirs(root);
  if (envs.length === 0) {
    findings.push({ file: "ops/monitoring", rule: "MC-00", message: "no environment files" });
  }
  for (const env of envs) {
    const loaded = loadEnv(root, env);
    findings.push(...loaded.findings);
    if (loaded.config !== undefined) findings.push(...checkEnv(loaded.config, byEvent, root));
  }
  for (const path of options.scan ?? ["ops/watcher/settings"]) {
    const files: string[] = [];
    const full = join(root, path);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(root, path, files);
    else files.push(path);
    for (const file of files) {
      findings.push(...checkIdentifiers(file, readFileSync(join(root, file), "utf8")));
    }
  }
  return findings;
}

/** Formats findings one per line: where, the rule, the message. Never a value from a secret. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.file}: ${f.rule} ${f.message}`).join("\n");
}
