// The alerts identity's line list (packages/identity/src/monitoring.ts) names for audit.write_failed
// are staging rules over that event, as spec 08 §3.14 defines them, each with a runbook that exists
// and names it back, and the catalogue's entry names the same alerts. The fields every writer
// passes are the ones the catalogue declares, and the catalogue, runbook and alert say when a
// writer leaves the audit event's name out. audit-not-written opens one incident per service,
// SQLSTATE and audit event, each label held to a closed set (AUDIT_EVENTS for the event, read from
// packages/audit's generated index), so a refusal that stands never hides a later, different one
// and no line can choose or multiply a label. The list, the writers and the index are read as
// text: ops/monitoring imports no other package, which is why this package's tests are never
// cached (ops/monitoring/turbo.json, test/turbo.test.ts).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { type AlertDef, type EnvConfig, loadEnv } from "../src/config.ts";
import { buildDesired } from "../src/desired.ts";
import { OTHER_LABEL, queryEvents, renderSql, seriesFields } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const IDENTITY_LINES = join(ROOT, "packages", "identity", "src", "monitoring.ts");
const EVENT = "audit.write_failed";
const AUDIT_WRITER = join(ROOT, "packages", "audit", "src", "record.ts");
const IDENTITY_WRITER = join(ROOT, "packages", "identity", "src", "audit", "record.ts");
const RUNBOOK = join(ROOT, "docs", "runbooks", "audit-not-written.md");
/** What the catalogue, runbook and alert say while a recorder passes the audit event as `event`. */
const RECORDER_GAP = "passes the event's name as `event`";
/** The services whose logins record audit events (spec 08 §3.4), and migrate for the tasks. */
const RECORDING_SOURCES = ["admin", "api", "console", "migrate", "payments", "worker"];
const AUDIT_PACKAGE = join(ROOT, "packages", "audit");
const AUDIT_INDEX = join(AUDIT_PACKAGE, "src", "events", "_index.gen.ts");

/** Every area's own recorder in the tree: packages/<area>/src/audit/record.ts. */
function areaRecorders(): string[] {
  const packages = join(ROOT, "packages");
  return readdirSync(packages)
    .sort()
    .map((name) => join(packages, name, "src", "audit", "record.ts"))
    .filter((file) => existsSync(file));
}

/**
 * The field names each write of the event in a file passes, one list per write: the first object
 * literal after the quoted name, which is the fields in both `write(name, level, { ... })` and
 * `write({ event: name, level, fields: { ... } })`.
 */
function writtenFields(file: string): string[][] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/"audit\.write_failed"/g)].map((m) => {
    const open = text.indexOf("{", m.index + m[0].length);
    const close = open === -1 ? -1 : text.indexOf("}", open);
    const body = close === -1 ? "..." : text.slice(open + 1, close).trim();
    if (body.includes("...") || body.includes("{")) {
      throw new Error(`${file}: a write of ${EVENT} whose fields cannot be read as text`);
    }
    return fieldNames(body);
  });
}

/** The keys of a flat object literal's body: each name at the start or after a comma. */
function fieldNames(body: string): string[] {
  return [...body.trim().matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=:|,|$)/g)].map(
    (k) => k[1] ?? "",
  );
}

function catalogueEntry() {
  const entry = Object.values(fragments)
    .flat()
    .find((e) => e.event === EVENT);
  if (entry === undefined) throw new Error(`${EVENT} is not in the catalogue`);
  return entry;
}

/** The alert names identity's list gives an event: its `alerts: [...]`, or none for a reason. */
function identityAlerts(event: string): string[] {
  const text = readFileSync(IDENTITY_LINES, "utf8");
  const key = `"${event}":`;
  const start = text.indexOf(key);
  if (start === -1) throw new Error(`${event} is not in identity's line list`);
  const entry = text.slice(start + key.length, text.indexOf("}", start));
  const list = /alerts:\s*\[([^\]]*)\]/.exec(entry);
  return [...(list?.[1] ?? "").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1] ?? "");
}

const { config, findings } = loadEnv(ROOT, "staging");

describe(`the alerts identity names for ${EVENT}`, () => {
  const names = identityAlerts(EVENT);

  it("are read from identity's list, audit-not-written among them", () => {
    expect(names).toContain("audit-not-written");
  });

  it("exist as staging rules that watch the event, with a runbook that names them", () => {
    expect(findings).toEqual([]);
    for (const name of names) {
      const rule = config?.alerts.find((a) => a.name === name);
      expect(rule, `${name} is no rule in ops/monitoring/staging/alerts`).toBeDefined();
      if (rule === undefined) continue;
      expect(queryEvents(rule.query), name).toEqual([EVENT]);
      const runbook = rule.metadata?.runbook ?? "";
      expect(runbook, name).toMatch(/^docs\/runbooks\/[a-z0-9-]+\.md$/);
      expect(existsSync(join(ROOT, runbook)), `${name}: ${runbook} does not exist`).toBe(true);
      expect(readFileSync(join(ROOT, runbook), "utf8"), runbook).toContain(`\`${name}\``);
    }
  });

  it("are the alerts the catalogue's entry names", () => {
    expect(catalogueEntry().alerts).toEqual(names);
  });

  it("page on any refusal from every service that records audit events, as spec 08 §3.14's audit-not-written does", () => {
    const rule = config?.alerts.find((a) => a.name === "audit-not-written");
    expect(rule).toMatchObject({
      group: "D",
      severity: "P",
      operator: "higher_than",
      threshold: "@any",
      policy: "staging-quiet",
      metadata: { runbook: "docs/runbooks/audit-not-written.md" },
    });
    expect(rule?.query).toEqual({ count: { events: [EVENT] } });
    expect([...(rule?.sources ?? [])].sort()).toEqual(RECORDING_SOURCES);
  });
});

describe(`the fields the writers of ${EVENT} pass`, () => {
  const entry = catalogueEntry();
  const declared = Object.keys(entry.fields).sort();
  const recorders = areaRecorders();

  it("are, from packages/audit's recordAudit, exactly the catalogue's", () => {
    const writes = writtenFields(AUDIT_WRITER);
    expect(writes.length).toBeGreaterThan(0);
    for (const fields of writes) expect([...fields].sort()).toEqual(declared);
  });

  it("are read from every area's recorder in the tree, identity's among them", () => {
    expect(recorders).toContain(IDENTITY_WRITER);
  });

  it("are, from each area's recorder, the catalogue's, the audit event as `auditEvent` or the envelope's `event`", () => {
    for (const file of recorders) {
      const writes = writtenFields(file);
      expect(writes.length, file).toBeGreaterThan(0);
      for (const fields of writes) {
        const named = fields.map((field) => (field === "event" ? "auditEvent" : field));
        expect(named.sort(), `${file}: ${fields.join(", ")}`).toEqual(declared);
      }
    }
  });

  it("leave the audit event's name out exactly while the catalogue, runbook and alert say so", () => {
    // While a recorder passes `event`, its lines arrive without the audit event's name, and the
    // catalogue, the runbook and the alert's check must say so; once none does, they must stop.
    const passesEvent = recorders.some((file) =>
      writtenFields(file).some((fields) => fields.includes("event")),
    );
    const says = (text: string) => text.replace(/\s+/g, " ").includes(RECORDER_GAP);
    const check = config?.alerts.find((a) => a.name === "audit-not-written")?.metadata?.check;
    expect(says(entry.writtenBy), "the catalogue's writtenBy").toBe(passesEvent);
    expect(says(readFileSync(RUNBOOK, "utf8")), "the runbook").toBe(passesEvent);
    expect(says(check ?? ""), "the alert's metadata.check").toBe(passesEvent);
  });

  it("are read as keys, never as the values' names, shorthand keys included", () => {
    expect(fieldNames('event: input.event,\n sqlstate: sqlState(error) ?? "unknown",')).toEqual([
      "event",
      "sqlstate",
    ]);
    expect(fieldNames("auditEvent: event, sqlstate: state")).toEqual(["auditEvent", "sqlstate"]);
    expect(fieldNames("table, sqlstate")).toEqual(["table", "sqlstate"]);
  });
});

/**
 * The names in AUDIT_EVENTS, the code's generated audit event list. packages/audit's generator
 * runs first (it loads every fragment, so defineEvents' checks run, and rewrites its git-ignored
 * index only when it changed); the index's AUDIT_EVENT_AREAS names every event once.
 */
function auditEventNames(): string[] {
  const run = spawnSync(process.execPath, [join("src", "gen.ts")], {
    cwd: AUDIT_PACKAGE,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`packages/audit's generator failed: ${run.stderr}`);
  const text = readFileSync(AUDIT_INDEX, "utf8");
  const block = /^export const AUDIT_EVENT_AREAS\b[^=]*= \{\n([^}]*)\};$/m.exec(text);
  if (block === null) throw new Error("the generated index has no AUDIT_EVENT_AREAS");
  return [...(block[1] ?? "").matchAll(/^ {2}"([^"]+)": "[^"]+",$/gm)]
    .map((m) => m[1] ?? "")
    .sort();
}

type SqlNode =
  | { kind: "string"; value: string }
  | { kind: "raw" }
  | { kind: "call"; name: string; args: SqlNode[] }
  | { kind: "in"; left: SqlNode; list: string[] }
  | { kind: "eq"; left: SqlNode; right: SqlNode };

/**
 * Parses the small part of ClickHouse's SQL that renderSql writes for a series or a filter: string
 * literals, `raw`, calls, `IN (...)` and `=`. Anything else throws, so the tests below read the
 * SQL that is sent, never a copy of renderSql's logic.
 */
function parseSql(sql: string): SqlNode {
  const matches = [...sql.matchAll(/\s*('[^']*'|[A-Za-z_][A-Za-z0-9_]*|[(),=])/gy)];
  if (matches.reduce((n, m) => n + m[0].length, 0) !== sql.trimEnd().length) {
    throw new Error(`SQL this test cannot read: ${sql}`);
  }
  const tokens = matches.map((m) => m[1] ?? "");
  let at = 0;
  const take = (want?: string): string => {
    const token = tokens[at++];
    if (token === undefined || (want !== undefined && token !== want)) {
      throw new Error(`expected ${want ?? "a token"} at token ${at - 1} of ${sql}`);
    }
    return token;
  };
  const primary = (): SqlNode => {
    const token = take();
    if (token.startsWith("'")) return { kind: "string", value: token.slice(1, -1) };
    if (token === "raw") return { kind: "raw" };
    if (!/^[A-Za-z]/.test(token) || tokens[at] !== "(") throw new Error(`unexpected ${token}`);
    take("(");
    const args = [expression()];
    while (tokens[at] === ",") {
      take(",");
      args.push(expression());
    }
    take(")");
    return { kind: "call", name: token, args };
  };
  const expression = (): SqlNode => {
    const left = primary();
    if (tokens[at] === "IN") {
      take("IN");
      take("(");
      const list = [take()];
      while (tokens[at] === ",") {
        take(",");
        list.push(take());
      }
      take(")");
      if (!list.every((t) => t.startsWith("'"))) throw new Error("IN lists literals only");
      return { kind: "in", left, list: list.map((t) => t.slice(1, -1)) };
    }
    if (tokens[at] === "=") {
      take("=");
      return { kind: "eq", left, right: primary() };
    }
    return left;
  };
  const node = expression();
  if (at !== tokens.length) throw new Error(`SQL left over after token ${at} of ${sql}`);
  return node;
}

/**
 * Evaluates a parsed expression over one line as ClickHouse does: JSONExtractString gives the
 * value of a string field, and '' for a missing field or a value of another type.
 */
function evaluate(node: SqlNode, line: Readonly<Record<string, unknown>>): string | boolean {
  const text = (n: SqlNode): string => {
    const value = evaluate(n, line);
    if (typeof value !== "string") throw new Error("a truth value where a string belongs");
    return value;
  };
  switch (node.kind) {
    case "string":
      return node.value;
    case "raw":
      throw new Error("raw outside JSONExtractString");
    case "in":
      return node.list.includes(text(node.left));
    case "eq":
      return text(node.left) === text(node.right);
    case "call": {
      const [a, b, c] = node.args;
      if (node.name === "JSONExtractString" && a?.kind === "raw" && b !== undefined) {
        const value = line[text(b)];
        return typeof value === "string" ? value : "";
      }
      if (node.name === "if" && a !== undefined && b !== undefined && c !== undefined) {
        const test = evaluate(a, line);
        if (typeof test !== "boolean") throw new Error("if() tests a truth value");
        return test ? text(b) : text(c);
      }
      if (node.name === "match" && a !== undefined && b?.kind === "string") {
        return new RegExp(b.value).test(text(a));
      }
      if (node.name === "concat") return node.args.map(text).join("");
      throw new Error(`a function this test does not know: ${node.name}`);
    }
  }
}

const WINDOW = "time BETWEEN {{start_time}} AND {{end_time}}";
const SERIES_QUERY =
  /^SELECT \{\{time\}\} AS time, (.+) AS series, count\(\*\) AS value FROM \{\{source\}\} WHERE (.+) GROUP BY time, series$/;

/** The alert Better Stack is sent for a rule, and its exploration's SQL, from buildDesired. */
function desiredAlert(env: EnvConfig, rule: AlertDef) {
  const settings = { hosts: {}, thresholds: {}, grace: {} };
  const { objects } = buildDesired({ ...env, alerts: [rule] }, settings);
  const alert = objects.find((o) => o.kind === "alert" && o.key === rule.name)?.body;
  const exploration = objects.find((o) => o.kind === "exploration" && o.key === `fin/${rule.name}`)
    ?.body as { queries?: { sql_query?: string }[] } | undefined;
  const sql = exploration?.queries?.[0]?.sql_query;
  if (alert === undefined || sql === undefined) throw new Error(`${rule.name} was not built`);
  return { alert, sql };
}

/** The series column and the filter of a rendered series query, parsed. */
function seriesQuery(sql: string): { series: SqlNode; filter: SqlNode } {
  const [, series = "", where = ""] = SERIES_QUERY.exec(sql) ?? [];
  if (!where.startsWith(`${WINDOW} AND `)) throw new Error(`not a windowed series query: ${sql}`);
  return { series: parseSql(series), filter: parseSql(where.slice(`${WINDOW} AND `.length)) };
}

interface Line {
  /** Seconds from the start. */
  readonly at: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * The incidents Better Stack opens for one alert over these lines: a check every check_period over
 * the last query_period; each series whose count is higher than the threshold opens an incident
 * unless one is open for it (with staging-quiet's repeatCount 0, that open is the only email), and
 * an incident resolves once its series has not fired for recovery_period. Without
 * incident_per_series every line is one series.
 */
function incidents(env: EnvConfig, rule: AlertDef, lines: readonly Line[]) {
  const { alert, sql } = desiredAlert(env, rule);
  expect(alert).toMatchObject({ operator: "higher_than", value: 0 });
  const check = alert.check_period as number;
  const query = alert.query_period as number;
  const recovery = alert.recovery_period as number;
  const perSeries = alert.incident_per_series === true;
  const { series, filter } = seriesQuery(sql);
  const opened: { series: string; at: number }[] = [];
  const open = new Set<string>();
  const lastFired = new Map<string, number>();
  const end = Math.max(...lines.map((l) => l.at)) + query + recovery + check;
  for (let t = check; t <= end; t += check) {
    const counts = new Map<string, number>();
    for (const line of lines) {
      if (line.at <= t - query || line.at > t || evaluate(filter, line.fields) !== true) continue;
      const label = evaluate(series, line.fields);
      if (typeof label !== "string") throw new Error("a series that is not a string");
      const key = perSeries ? label : "";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count <= 0) continue;
      lastFired.set(key, t);
      if (!open.has(key)) {
        open.add(key);
        opened.push({ series: key, at: t });
      }
    }
    for (const key of [...open]) {
      if (!counts.has(key) && t - (lastFired.get(key) ?? 0) >= recovery) open.delete(key);
    }
  }
  return opened;
}

/** One audit.write_failed line, as the envelope and a writer give it. */
function refusal(minute: number, fields: Readonly<Record<string, unknown>>): Line {
  return {
    at: minute * 60,
    fields: { event: EVENT, message: EVENT, level: "error", release: "r1", ...fields },
  };
}

describe("audit-not-written's incidents", () => {
  if (config === undefined) throw new Error("no staging config");
  const env = config;
  const rule = env.alerts.find((a) => a.name === "audit-not-written");
  if (rule === undefined) throw new Error("audit-not-written is no rule");
  const AUDIT_EVENTS = auditEventNames();
  const { sql } = desiredAlert(env, rule);
  const { series } = seriesQuery(sql);
  const seriesOf = (fields: Readonly<Record<string, unknown>>) =>
    evaluate(series, { event: EVENT, ...fields });
  // Events of AUDIT_EVENTS: one the scenario's FA004 refuses, and two no fragment gives console.
  const OWN = "operator.task_completed";
  const FOREIGN = "switch.tripped";
  const SECOND = "audit.epoch_started";

  it("are one per service, SQLSTATE and audit event, as the catalogue's entry says", () => {
    expect(seriesFields(rule)).toEqual(["service", "sqlstate", "auditEvent"]);
    expect(catalogueEntry().seriesBy).toEqual(["service", "sqlstate", "auditEvent"]);
    expect(desiredAlert(env, rule).alert).toMatchObject({
      incident_per_series: true,
      check_period: 60,
      query_period: 300,
      recovery_period: 900,
    });
  });

  it("hold each label to a closed set: the rule's sources, a five-character SQLSTATE, AUDIT_EVENTS", () => {
    expect(AUDIT_EVENTS).toEqual(expect.arrayContaining([OWN, FOREIGN, SECOND]));
    expect(rule.seriesBy).toEqual([
      { field: "service", oneOf: [...rule.sources] },
      { field: "sqlstate", shape: "sqlstate" },
      { field: "auditEvent", oneOf: AUDIT_EVENTS },
    ]);
    const extract = (field: string) => `JSONExtractString(raw, '${field}')`;
    const bounded = (field: string, values: readonly string[]) =>
      `if(${extract(field)} IN (${values.map((v) => `'${v}'`).join(", ")}), ${extract(field)}, '${OTHER_LABEL}')`;
    const services = ["api", "worker", "payments", "console", "admin", "migrate"];
    const sqlstate = `if(match(${extract("sqlstate")}, '^[0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]$'), ${extract("sqlstate")}, 'other')`;
    const expected = `SELECT {{time}} AS time, concat(${bounded("service", services)}, '/', ${sqlstate}, '/', ${bounded("auditEvent", AUDIT_EVENTS)}) AS series, count(*) AS value FROM {{source}} WHERE ${WINDOW} AND JSONExtractString(raw, 'event') = 'audit.write_failed' GROUP BY time, series`;
    expect(renderSql(rule)).toBe(expected);
    expect(sql).toBe(expected);
  });

  it("give an audit event outside AUDIT_EVENTS, a missing one and every forged value the one label other", () => {
    const at = (auditEvent: unknown) =>
      seriesOf({ service: "console", sqlstate: "FA004", auditEvent });
    expect(at(OWN)).toBe(`console/FA004/${OWN}`);
    expect(at("transfer.created")).toBe("console/FA004/other");
    expect(seriesOf({ service: "console", sqlstate: "FA004" })).toBe("console/FA004/other");
    const forged: unknown[] = [
      ...Array.from({ length: 500 }, (_, i) => `forged.event_${i}`),
      "other",
      "",
      `${OWN}/FA011`,
      `${OWN} `,
      OWN.toUpperCase(),
      "x' OR 1=1 --",
      42,
      true,
      null,
      { name: OWN },
      [OWN],
    ];
    expect(new Set(forged.map(at))).toEqual(new Set(["console/FA004/other"]));
    const lines = forged.map((auditEvent, i) =>
      refusal((i % 40) + i / 1000, { service: "console", sqlstate: "FA004", auditEvent }),
    );
    expect(incidents(env, rule, lines).map((i) => i.series)).toEqual(["console/FA004/other"]);
  });

  it("give a SQLSTATE that is not five digits or capitals, and a service outside the rule's, the label other", () => {
    const at = (service: unknown, sqlstate: unknown) =>
      seriesOf({ service, sqlstate, auditEvent: OWN });
    for (const code of ["FA011", "42501", "57P01"]) {
      expect(at("console", code)).toBe(`console/${code}/${OWN}`);
    }
    for (const code of ["input", "unknown", "FA0041", "fa004", "FA00", "FA0/1", "", 42501, null]) {
      expect(at("console", code), String(code)).toBe(`console/other/${OWN}`);
    }
    expect(seriesOf({ service: "console", auditEvent: OWN })).toBe(`console/other/${OWN}`);
    for (const service of ["edge", "Console", "console/FA004", "", 1]) {
      expect(at(service, "FA004"), String(service)).toBe(`other/FA004/${OWN}`);
    }
  });

  it("still open an incident for a line whose labels are unknown: no line is ever dropped", () => {
    const unknown = refusal(0, { service: "x", sqlstate: "y", auditEvent: "z" });
    expect(incidents(env, rule, [unknown])).toEqual([{ series: "other/other/other", at: 60 }]);
    expect(incidents(env, rule, [refusal(3, {})]).map((i) => i.series)).toEqual([
      "other/other/other",
    ]);
    const foreign = { service: "console", sqlstate: "FA002", auditEvent: "transfer.created" };
    expect(incidents(env, rule, [refusal(0, foreign)]).map((i) => i.series)).toEqual([
      "console/FA002/other",
    ]);
  });

  it("open for an FA011 and for each foreign event's FA002 while an FA004 stands on the service", () => {
    // console refuses OWN with FA004 every 2 minutes for 40 minutes; meanwhile an FA011 at minute
    // 12, an FA002 at minute 20 for an event no fragment gives console, and an FA002 at minute 26
    // for a second such event, while the first FA002's incident is still open.
    const lines = [
      ...Array.from({ length: 20 }, (_, i) =>
        refusal(i * 2, { service: "console", sqlstate: "FA004", auditEvent: OWN }),
      ),
      refusal(12, { service: "console", sqlstate: "FA011", auditEvent: OWN }),
      refusal(20, { service: "console", sqlstate: "FA002", auditEvent: FOREIGN }),
      refusal(26, { service: "console", sqlstate: "FA002", auditEvent: SECOND }),
    ];
    expect(incidents(env, rule, lines)).toEqual([
      { series: `console/FA004/${OWN}`, at: 60 },
      { series: `console/FA011/${OWN}`, at: 12 * 60 },
      { series: `console/FA002/${FOREIGN}`, at: 20 * 60 },
      { series: `console/FA002/${SECOND}`, at: 26 * 60 },
    ]);
    // Grouped by service alone, as the rule first was, the three later refusals join the FA004's
    // incident; by service and SQLSTATE, the second FA002 joins the first's.
    const { seriesBy: _seriesBy, ...byService } = rule;
    expect(incidents(env, byService, lines).map((i) => i.series)).toEqual(["console"]);
    const bySqlstate: AlertDef = { ...rule, seriesBy: ["service", "sqlstate"] };
    expect(incidents(env, bySqlstate, lines).map((i) => i.series)).toEqual([
      "console/FA004",
      "console/FA011",
      "console/FA002",
    ]);
  });
});
