// The alerts identity's line list (packages/identity/src/monitoring.ts) names for audit.write_failed
// are staging rules over that event, as spec 08 §3.14 defines them, each with a runbook that exists
// and names it back, and the catalogue's entry names the same alerts. The fields every writer
// passes are the ones the catalogue declares, and the catalogue, runbook and alert say what a line
// without the audit event's name is labelled. audit-not-written opens one incident per service,
// SQLSTATE and audit event, each label held to a closed set (for the event, the names in
// AUDIT_EVENTS, read from packages/audit's generated index, and the events each area's recorder
// writes, read from its events module), so a refusal that stands never hides a later, different
// one and no line can choose or multiply a label. The scenarios build each line as the envelope
// ships it, so a line that names its event and one that does not each show where they land. The
// list, the writers and the index are read as text, and the area events by a child Node:
// ops/monitoring imports no other package, which is why this package's tests are never cached
// (ops/monitoring/turbo.json, test/turbo.test.ts).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
/** What the catalogue, runbook and alert say of a line that does not name its audit event. */
const NO_EVENT = ["a line without auditevent", "other"];
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

  it("when they leave out auditEvent, land on the label other, as the catalogue, runbook and alert say", () => {
    // A name passed as `event` is dropped by the envelope, which keeps its own; any line that
    // arrives without the audit event's name is labelled `other` (below), and the texts say so and
    // how to read it, whichever writer it came from.
    const says = (text: string) => {
      const plain = text.replace(/`/g, "").replace(/\s+/g, " ").toLowerCase();
      return NO_EVENT.every((phrase) => plain.includes(phrase));
    };
    const check = config?.alerts.find((a) => a.name === "audit-not-written")?.metadata?.check;
    expect(says(entry.writtenBy), "the catalogue's writtenBy").toBe(true);
    expect(says(readFileSync(RUNBOOK, "utf8")), "the runbook").toBe(true);
    expect(says(check ?? ""), "the alert's metadata.check").toBe(true);
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

/**
 * Run by a child Node over each area's events module: the keys of every exported record of event
 * specs (each key an event name, each value a spec with its `roles`), the list the area's recorder
 * checks an event against. A module that exports none fails the run.
 */
const AREA_EVENTS_SCRIPT = `
const names = new Set();
for (const url of process.argv.slice(1)) {
  const module = await import(url);
  let records = 0;
  for (const value of Object.values(module)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entries = Object.entries(value);
    const specs = entries.every(
      ([name, spec]) =>
        /^[a-z][a-z_]*\\.[a-z][a-z_]*$/.test(name) &&
        typeof spec === "object" && spec !== null && Array.isArray(spec.roles),
    );
    if (entries.length === 0 || !specs) continue;
    for (const [name] of entries) names.add(name);
    records += 1;
  }
  if (records === 0) throw new Error(url + " exports no audit events");
}
process.stdout.write(JSON.stringify([...names].sort()));
`;

/**
 * The audit events the area recorders write, from the events module beside each recorder
 * (packages/<area>/src/audit/events.ts), loaded where it lives by a child Node.
 */
function areaEventNames(): string[] {
  const modules = areaRecorders().map((file) => pathToFileURL(join(file, "..", "events.ts")).href);
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", AREA_EVENTS_SCRIPT, ...modules],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`the area events could not be read: ${run.stderr}`);
  return JSON.parse(run.stdout) as string[];
}

/** The field each write of a writer passes the audit event's name in: `auditEvent` or `event`. */
function nameField(file: string): string {
  const named = new Set(writtenFields(file).map((fields) => fields.find((f) => f !== "sqlstate")));
  const [only, ...rest] = named;
  if (only === undefined || rest.length > 0) {
    throw new Error(`${file}: its writes do not pass the event's name in one field`);
  }
  return only;
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

/**
 * One audit.write_failed line as a writer's write reaches Better Stack: the writer passes the audit
 * event's name in `field` and the SQLSTATE in `sqlstate`, and the envelope's own fields (`event`
 * among them, the line's name) win over any the writer passes with the same name.
 */
function shipped(
  minute: number,
  service: string,
  field: string,
  auditEvent: string,
  sqlstate: string,
): Line {
  const envelope = { event: EVENT, message: EVENT, level: "error", service, release: "r1" };
  return { at: minute * 60, fields: { [field]: auditEvent, sqlstate, ...envelope } };
}

describe("audit-not-written's incidents", () => {
  if (config === undefined) throw new Error("no staging config");
  const env = config;
  const rule = env.alerts.find((a) => a.name === "audit-not-written");
  if (rule === undefined) throw new Error("audit-not-written is no rule");
  const AUDIT_EVENTS = auditEventNames();
  const AREA_EVENTS = areaEventNames();
  /** Every audit event the code defines: AUDIT_EVENTS and the area recorders' own. */
  const CODE_EVENTS = [...new Set([...AUDIT_EVENTS, ...AREA_EVENTS])].sort();
  const { sql } = desiredAlert(env, rule);
  const { series } = seriesQuery(sql);
  const seriesOf = (fields: Readonly<Record<string, unknown>>) =>
    evaluate(series, { event: EVENT, ...fields });
  // Events of AUDIT_EVENTS: one fin_owner records (migrate's tasks), and two no fragment gives it.
  const OWN = "operator.task_completed";
  const FOREIGN = "switch.tripped";
  const SECOND = "system.sweep_completed";

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

  it("hold each label to a closed set: the rule's sources, a five-character SQLSTATE, the code's audit events", () => {
    expect(AUDIT_EVENTS).toEqual(expect.arrayContaining([OWN, FOREIGN, SECOND]));
    // identity's recorder writes console's and admin's sign-in events: they are in the set.
    expect(AREA_EVENTS).toEqual(
      expect.arrayContaining(["session.created", "staff.signed_in", "staff.signed_out"]),
    );
    expect(rule.seriesBy).toEqual([
      { field: "service", oneOf: [...rule.sources] },
      { field: "sqlstate", shape: "sqlstate" },
      { field: "auditEvent", oneOf: CODE_EVENTS },
    ]);
    const extract = (field: string) => `JSONExtractString(raw, '${field}')`;
    const bounded = (field: string, values: readonly string[]) =>
      `if(${extract(field)} IN (${values.map((v) => `'${v}'`).join(", ")}), ${extract(field)}, '${OTHER_LABEL}')`;
    const services = ["api", "worker", "payments", "console", "admin", "migrate"];
    const sqlstate = `if(match(${extract("sqlstate")}, '^[0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]$'), ${extract("sqlstate")}, 'other')`;
    const expected = `SELECT {{time}} AS time, concat(${bounded("service", services)}, '/', ${sqlstate}, '/', ${bounded("auditEvent", CODE_EVENTS)}) AS series, count(*) AS value FROM {{source}} WHERE ${WINDOW} AND JSONExtractString(raw, 'event') = 'audit.write_failed' GROUP BY time, series`;
    expect(renderSql(rule)).toBe(expected);
    expect(sql).toBe(expected);
  });

  it("give an audit event the code does not define, a missing one and every forged value the one label other", () => {
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

  /**
   * A service refuses `standing` with `code` every 2 minutes for 40 minutes; meanwhile an FA011 at
   * minute 12, an FA002 at minute 20 for an event no fragment gives the service, and an FA002 at
   * minute 26 for a second such event, while the first FA002's incident is still open. Each line
   * carries the event's name in the field the writer passes it in.
   */
  function scenario(
    service: string,
    field: string,
    standing: string,
    code: string,
    foreign: string,
    second: string,
  ): Line[] {
    return [
      ...Array.from({ length: 20 }, (_, i) => shipped(i * 2, service, field, standing, code)),
      shipped(12, service, field, standing, "FA011"),
      shipped(20, service, field, foreign, "FA002"),
      shipped(26, service, field, second, "FA002"),
    ];
  }

  it("open, for migrate's lines, for an FA011 and for each foreign event's FA002 while an FA004 stands", () => {
    // migrate's tasks record fin_owner's events through packages/audit's recordAudit, which names
    // the event auditEvent; switch.tripped and system.sweep_completed are never fin_owner's.
    const field = nameField(AUDIT_WRITER);
    expect(field).toBe("auditEvent");
    const lines = scenario("migrate", field, OWN, "FA004", FOREIGN, SECOND);
    expect(incidents(env, rule, lines)).toEqual([
      { series: `migrate/FA004/${OWN}`, at: 60 },
      { series: `migrate/FA011/${OWN}`, at: 12 * 60 },
      { series: `migrate/FA002/${FOREIGN}`, at: 20 * 60 },
      { series: `migrate/FA002/${SECOND}`, at: 26 * 60 },
    ]);
    // Grouped by service alone, as the rule first was, the three later refusals join the FA004's
    // incident; by service and SQLSTATE, the second FA002 joins the first's.
    const { seriesBy: _seriesBy, ...byService } = rule;
    expect(incidents(env, byService, lines).map((i) => i.series)).toEqual(["migrate"]);
    const bySqlstate: AlertDef = { ...rule, seriesBy: ["service", "sqlstate"] };
    expect(incidents(env, bySqlstate, lines).map((i) => i.series)).toEqual([
      "migrate/FA004",
      "migrate/FA011",
      "migrate/FA002",
    ]);
  });

  describe("for console's and admin's lines", () => {
    // console records the person-scope events (fin_console) and admin the staff realm's
    // (fin_admin): a staff event's FA002 on console, or a person event's on admin, is foreign.
    /** The incidents for console's scenario, and for an FA002 standing on each service. */
    const outcomes = (field: string) => ({
      console: incidents(
        env,
        rule,
        scenario(
          "console",
          field,
          "session.created",
          "FA004",
          "staff.signed_in",
          "staff.signed_out",
        ),
      ),
      consoleFa002: incidents(env, rule, [
        ...Array.from({ length: 20 }, (_, i) =>
          shipped(i * 2, "console", field, "session.created", "FA002"),
        ),
        shipped(20, "console", field, "staff.signed_in", "FA002"),
      ]).map((i) => i.series),
      adminFa002: incidents(env, rule, [
        ...Array.from({ length: 20 }, (_, i) =>
          shipped(i * 2, "admin", field, "staff.signed_in", "FA002"),
        ),
        shipped(20, "admin", field, "session.created", "FA002"),
      ]).map((i) => i.series),
    });
    /** One incident per service, SQLSTATE and event: what the rule gives lines with auditEvent. */
    const perEvent = {
      console: [
        { series: "console/FA004/session.created", at: 60 },
        { series: "console/FA011/session.created", at: 12 * 60 },
        { series: "console/FA002/staff.signed_in", at: 20 * 60 },
        { series: "console/FA002/staff.signed_out", at: 26 * 60 },
      ],
      consoleFa002: ["console/FA002/session.created", "console/FA002/staff.signed_in"],
      adminFa002: ["admin/FA002/staff.signed_in", "admin/FA002/session.created"],
    };

    it("are one per service, SQLSTATE and event for lines that name it auditEvent, a foreign event's FA002 behind a standing FA002 included", () => {
      expect(outcomes("auditEvent")).toEqual(perEvent);
    });

    it("give a line without auditEvent the label other, so such lines share an incident per service and SQLSTATE", () => {
      // A name passed as `event` is dropped (the envelope keeps its own `event`), so the line
      // carries no auditEvent and lands on <service>/<sqlstate>/other: the second FA002 joins the
      // first's incident, and a foreign event's FA002 joins a standing FA002's, sending no email.
      // The runbook and the alert's check say to read every line of an open `other` incident.
      const residual = {
        console: [
          { series: "console/FA004/other", at: 60 },
          { series: "console/FA011/other", at: 12 * 60 },
          { series: "console/FA002/other", at: 20 * 60 },
        ],
        consoleFa002: ["console/FA002/other"],
        adminFa002: ["admin/FA002/other"],
      };
      expect(outcomes("event")).toEqual(residual);
    });
  });
});
