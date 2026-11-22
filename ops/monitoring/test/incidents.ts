// The incident model the alert tests replay lines through: the alert buildDesired sends Better
// Stack for a rule, the SQL of its exploration parsed (never a copy of renderSql's logic), and the
// incidents Better Stack opens for those lines. Shared by audit-alerts.test.ts and
// staff-alerts.test.ts, so both read one model.
import { expect } from "vitest";
import type { AlertDef, EnvConfig } from "../src/config.ts";
import { buildDesired } from "../src/desired.ts";

export type SqlNode =
  | { kind: "string"; value: string }
  | { kind: "raw" }
  | { kind: "call"; name: string; args: SqlNode[] }
  | { kind: "in"; left: SqlNode; list: string[] }
  | { kind: "eq"; left: SqlNode; right: SqlNode };

/**
 * Parses the small part of ClickHouse's SQL that renderSql writes for a series or a filter: string
 * literals, `raw`, calls, `IN (...)` and `=`. Anything else throws, so the tests read the SQL that
 * is sent, never a copy of renderSql's logic.
 */
export function parseSql(sql: string): SqlNode {
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
export function evaluate(node: SqlNode, line: Readonly<Record<string, unknown>>): string | boolean {
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

export const WINDOW = "time BETWEEN {{start_time}} AND {{end_time}}";
const SERIES_QUERY =
  /^SELECT \{\{time\}\} AS time, (.+) AS series, count\(\*\) AS value FROM \{\{source\}\} WHERE (.+) GROUP BY time, series$/;
const ONE_SERIES_QUERY =
  /^SELECT \{\{time\}\} AS time, count\(\*\) AS value FROM \{\{source\}\} WHERE (.+) GROUP BY time$/;

/** The alert Better Stack is sent for a rule, and its exploration's SQL, from buildDesired. */
export function desiredAlert(env: EnvConfig, rule: AlertDef) {
  const settings = { hosts: {}, thresholds: {}, grace: {} };
  const { objects } = buildDesired({ ...env, alerts: [rule] }, settings);
  const alert = objects.find((o) => o.kind === "alert" && o.key === rule.name)?.body;
  const exploration = objects.find((o) => o.kind === "exploration" && o.key === `fin/${rule.name}`)
    ?.body as { queries?: { sql_query?: string }[] } | undefined;
  const sql = exploration?.queries?.[0]?.sql_query;
  if (alert === undefined || sql === undefined) throw new Error(`${rule.name} was not built`);
  return { alert, sql };
}

/**
 * The series column and the filter of a rendered count query, parsed. A query that groups by time
 * alone has one series, the empty label.
 */
export function seriesQuery(sql: string): { series: SqlNode; filter: SqlNode } {
  const grouped = SERIES_QUERY.exec(sql);
  const where = grouped?.[2] ?? ONE_SERIES_QUERY.exec(sql)?.[1] ?? "";
  if (!where.startsWith(`${WINDOW} AND `)) throw new Error(`not a windowed count query: ${sql}`);
  const column = grouped?.[1];
  return {
    series: column === undefined ? { kind: "string", value: "" } : parseSql(column),
    filter: parseSql(where.slice(`${WINDOW} AND `.length)),
  };
}

export interface Line {
  /** Seconds from the start. */
  readonly at: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * The incidents Better Stack opens for one alert over these lines: a check every check_period over
 * the last query_period; each series whose count is higher than the threshold opens an incident
 * unless one is open for it (with staging-quiet's repeatCount 0, that open is the only email), and
 * an incident resolves once its series has not fired for recovery_period. Without
 * incident_per_series every line is one series. The first check is at check_period, so a line at
 * second 0 falls outside a query_period no longer than check_period: scenarios start after it.
 */
export function incidents(env: EnvConfig, rule: AlertDef, lines: readonly Line[]) {
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
