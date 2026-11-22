// Renders an alert's query as the SQL of a Better Stack exploration over the source's logs
// (spec 08 §7.8: `query` is a metric or a saved exploration). Phase 0 renders every alert over the
// raw lines with JSONExtract, the form Better Stack's exploration API documents; staging's volume
// is small, and metric-backed queries replace these once SP-06 confirms the metric merge
// functions under the unified metrics schema (recorded in the pull request).
//
// Every literal comes from a reviewed file and is checked against a narrow alphabet, and every
// number from the overlay is checked to be finite, so nothing can break out of the SQL.
import type { AlertDef, AlertQuery, Condition, SeriesField } from "./config.ts";

const LITERAL = /^[A-Za-z0-9 ._:/-]{1,64}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The one label a bounded series field gives every value outside its set, a missing one too. */
export const OTHER_LABEL = "other";

/**
 * The `sqlstate` shape: five digits or capital letters, as the SQL standard and Postgres write a
 * SQLSTATE. Spelt without a `{5}`, so the only braces in the SQL stay Better Stack's `{{...}}`.
 * `other` never has it.
 */
const SQLSTATE_PATTERN = "^[0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]$";

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
const wrap = (expression: string) =>
  expression.startsWith("(") && expression.endsWith(")") ? expression : `(${expression})`;
const float = (name: string) => `JSONExtract(raw, '${field(name)}', 'Nullable(Float64)')`;

/** One condition as a SQL boolean expression. */
export function condition(c: Condition): string {
  const set = [c.eq, c.notEq, c.in, c.notIn, c.gt, c.contains, c.present].filter(
    (v) => v !== undefined,
  ).length;
  if (set !== 1) throw new QueryError(`condition on ${c.field} must set exactly one comparison`);
  if (c.present !== undefined) {
    // Only a line that carries the field, whatever its value: a line without it does not count.
    if (c.present !== true) throw new QueryError(`present on ${c.field} takes only true`);
    return `JSONHas(raw, '${field(c.field)}')`;
  }
  if (c.notEq !== undefined) {
    // The negation of `eq`, so a line without the field matches (fails closed).
    if (typeof c.notEq !== "boolean" && typeof c.notEq !== "string") {
      throw new QueryError(`notEq on ${c.field} takes a boolean or a string`);
    }
    return `NOT ${wrap(condition({ field: c.field, eq: c.notEq }))}`;
  }
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

/** Every condition a query filters by. */
export function queryConditions(query: AlertQuery): Condition[] {
  if ("count" in query) return [...(query.count.where ?? []), ...(query.count.whereAny ?? [])];
  if ("max" in query) return [...(query.max.where ?? [])];
  if ("ratio" in query) return [...query.ratio.match];
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

/** An alert's series as written, each field plain or bounded, when it groups. */
function seriesSpec(alert: AlertDef): readonly (string | SeriesField)[] | undefined {
  if (alert.seriesBy !== undefined) {
    return typeof alert.seriesBy === "string" ? [alert.seriesBy] : alert.seriesBy;
  }
  return alert.sources.length > 1 ? ["service"] : undefined;
}

/** The fields an alert's series is made of, when it groups (one incident per series). */
export function seriesFields(alert: AlertDef): readonly string[] | undefined {
  return seriesSpec(alert)?.map((f) =>
    typeof f === "object" && f !== null ? String(f.field) : String(f),
  );
}

/**
 * A bounded field's label: its value when it is one of `oneOf` or has the shape, else
 * OTHER_LABEL. A value of `oneOf` is never OTHER_LABEL and never holds the `/` that joins labels,
 * so no value can pass for another series.
 */
function boundedLabel(f: SeriesField): string {
  if (typeof f !== "object" || f === null || typeof f.field !== "string") {
    throw new QueryError("a series field that is neither a name nor { field, oneOf or shape }");
  }
  const value = str(f.field);
  if ((f.oneOf === undefined) === (f.shape === undefined)) {
    throw new QueryError(`series field ${f.field} must set exactly one of oneOf and shape`);
  }
  if (f.oneOf !== undefined) {
    if (!Array.isArray(f.oneOf) || f.oneOf.length === 0) {
      throw new QueryError(`series field ${f.field}: oneOf must list at least one value`);
    }
    for (const v of f.oneOf) {
      if (typeof v !== "string" || v === OTHER_LABEL || v.includes("/")) {
        throw new QueryError(`series field ${f.field}: a oneOf value that is not a label`);
      }
    }
    return `if(${value} IN (${f.oneOf.map(literal).join(", ")}), ${value}, '${OTHER_LABEL}')`;
  }
  if (f.shape !== "sqlstate") throw new QueryError(`series field ${f.field}: unknown shape`);
  return `if(match(${value}, '${SQLSTATE_PATTERN}'), ${value}, '${OTHER_LABEL}')`;
}

/** The series column: one field, or several joined with `/` so each combination is a series. */
function seriesExpression(fields: readonly (string | SeriesField)[]): string {
  const labels = fields.map((f) => (typeof f === "string" ? str(f) : boundedLabel(f)));
  const [only] = labels;
  if (only === undefined) throw new QueryError("seriesBy names no field");
  if (labels.length === 1) return only;
  return `concat(${labels.join(", '/', ")})`;
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
  const series = seriesSpec(alert);
  const select = series === undefined ? "" : `, ${seriesExpression(series)} AS series`;
  const group = series === undefined ? "time" : "time, series";
  return `SELECT {{time}} AS time${select}, ${value} AS value FROM {{source}} WHERE ${where.join(" AND ")} GROUP BY ${group}`;
}
