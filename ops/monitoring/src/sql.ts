// Renders an alert's query as the SQL of a Better Stack exploration over the source's logs
// (spec 08 §7.8: `query` is a metric or a saved exploration). Phase 0 renders every alert over the
// raw lines with JSONExtract, the form Better Stack's exploration API documents; staging's volume
// is small, and metric-backed queries replace these once SP-06 confirms the metric merge
// functions under the unified metrics schema (recorded in the pull request).
//
// Every literal comes from a reviewed file and is checked against a narrow alphabet, and every
// number from the overlay is checked to be finite, so nothing can break out of the SQL.
import type { AlertDef, AlertQuery, Condition } from "./config.ts";

const LITERAL = /^[A-Za-z0-9 ._:/-]{1,64}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export class QueryError extends Error {
  override readonly name = "QueryError";
}

function field(name: string): string {
  if (!FIELD.test(name)) throw new QueryError(`field name not allowed: ${name}`);
  return name;
}

function literal(value: string): string {
  if (!LITERAL.test(value)) throw new QueryError("a literal outside the allowed alphabet");
  return `'${value}'`;
}

function num(value: number): string {
  if (!Number.isFinite(value)) throw new QueryError("a number that is not finite");
  return String(value);
}

const str = (name: string) => `JSONExtractString(raw, '${field(name)}')`;
const float = (name: string) => `JSONExtract(raw, '${field(name)}', 'Nullable(Float64)')`;

/** One condition as a SQL boolean expression. */
export function condition(c: Condition): string {
  const set = [c.eq, c.in, c.notIn, c.gt, c.contains].filter((v) => v !== undefined).length;
  if (set !== 1) throw new QueryError(`condition on ${c.field} must set exactly one comparison`);
  if (c.in !== undefined) return `${str(c.field)} IN (${c.in.map(literal).join(", ")})`;
  if (c.notIn !== undefined) return `${str(c.field)} NOT IN (${c.notIn.map(literal).join(", ")})`;
  if (c.gt !== undefined) return `${float(c.field)} > ${num(c.gt)}`;
  if (c.contains !== undefined) {
    return `has(JSONExtract(raw, '${field(c.field)}', 'Array(Float64)'), ${num(c.contains)})`;
  }
  const eq = c.eq;
  if (typeof eq === "boolean") {
    // A line without the field must not match `= false`, so require the key.
    return `(JSONHas(raw, '${field(c.field)}') AND JSONExtractBool(raw, '${c.field}') = ${eq ? 1 : 0})`;
  }
  if (typeof eq === "number") return `${float(c.field)} = ${num(eq)}`;
  return `${str(c.field)} = ${literal(String(eq))}`;
}

function eventFilter(events: readonly string[]): string {
  return events.length === 1
    ? `${str("event")} = ${literal(events[0] ?? "")}`
    : `${str("event")} IN (${events.map(literal).join(", ")})`;
}

/** The events a query reads, for the catalogue checks. */
export function queryEvents(query: AlertQuery): string[] {
  if ("count" in query) return [...query.count.events];
  if ("max" in query) return [query.max.event];
  if ("ratio" in query) return [query.ratio.event];
  return [];
}

/** The fields a query reads, for the catalogue checks. */
export function queryFields(query: AlertQuery): string[] {
  const conds = (list: readonly Condition[] | undefined) => (list ?? []).map((c) => c.field);
  if ("count" in query) return [...conds(query.count.where), ...conds(query.count.whereAny)];
  if ("max" in query) return [query.max.field, ...conds(query.max.where)];
  if ("ratio" in query) return conds(query.ratio.match);
  return [];
}

/** The series column, when the alert groups by a field (one incident per series). */
export function seriesField(alert: AlertDef): string | undefined {
  if (alert.seriesBy !== undefined) return alert.seriesBy;
  return alert.sources.length > 1 ? "service" : undefined;
}

/**
 * Renders the alert's SQL. `numbers` holds every overlay value the query needs (a ratio's
 * minimum count), already resolved.
 */
export function renderSql(alert: AlertDef, numbers: Readonly<Record<string, number>> = {}): string {
  const where = ["time BETWEEN {{start_time}} AND {{end_time}}"];
  let value: string;
  const q = alert.query;
  if ("lines" in q) {
    value = "count(*)";
  } else if ("count" in q) {
    where.push(eventFilter(q.count.events));
    for (const c of q.count.where ?? []) where.push(condition(c));
    if (q.count.whereAny !== undefined && q.count.whereAny.length > 0) {
      where.push(`(${q.count.whereAny.map(condition).join(" OR ")})`);
    }
    value = "count(*)";
  } else if ("max" in q) {
    where.push(eventFilter([q.max.event]));
    for (const c of q.max.where ?? []) where.push(condition(c));
    value = q.max.abs ? `max(abs(${float(q.max.field)}))` : `max(${float(q.max.field)})`;
  } else if ("ratio" in q) {
    where.push(eventFilter([q.ratio.event]));
    const min = numbers[q.ratio.minCount];
    if (min === undefined) throw new QueryError(`missing overlay value for ${q.ratio.minCount}`);
    const match = q.ratio.match.map(condition).join(" AND ");
    value = `if(count(*) >= ${num(min)}, countIf(${match}) / count(*), 0)`;
  } else {
    throw new QueryError("unknown query kind");
  }
  const series = seriesField(alert);
  const select = series === undefined ? "" : `, ${str(series)} AS series`;
  const group = series === undefined ? "time" : "time, series";
  return `SELECT {{time}} AS time${select}, ${value} AS value FROM {{source}} WHERE ${where.join(" AND ")} GROUP BY ${group}`;
}
