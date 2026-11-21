import { describe, expect, it } from "vitest";
import type { AlertDef } from "../src/config.ts";
import { condition, QueryError, renderSql } from "../src/sql.ts";

const base: AlertDef = {
  name: "x",
  template: "x",
  file: "f",
  group: "A",
  severity: "P",
  sources: ["api"],
  query: { lines: {} },
  operator: "higher_than",
  threshold: "@any",
  check_period: 60,
  query_period: 60,
  confirmation_period: 0,
  recovery_period: 60,
  on_missing_data: "dont_fire",
};

const WINDOW = "time BETWEEN {{start_time}} AND {{end_time}}";

describe("renderSql", () => {
  it("counts every line for a no-logs alert", () => {
    expect(renderSql(base)).toBe(
      `SELECT {{time}} AS time, count(*) AS value FROM {{source}} WHERE ${WINDOW} GROUP BY time`,
    );
  });

  it("counts events with conditions, one series per service across several sources", () => {
    const sql = renderSql({
      ...base,
      sources: ["api", "edge"],
      query: {
        count: {
          events: ["a.b", "c.d"],
          where: [{ field: "check", in: ["dns", "routes"] }],
          whereAny: [
            { field: "linesLost", gt: 0 },
            { field: "statuses", contains: 402 },
          ],
        },
      },
    });
    expect(sql).toBe(
      `SELECT {{time}} AS time, JSONExtractString(raw, 'service') AS series, count(*) AS value FROM {{source}} WHERE ${WINDOW} AND JSONExtractString(raw, 'event') IN ('a.b', 'c.d') AND JSONExtractString(raw, 'check') IN ('dns', 'routes') AND (JSONExtract(raw, 'linesLost', 'Nullable(Float64)') > 0 OR has(JSONExtract(raw, 'statuses', 'Array(Float64)'), 402)) GROUP BY time, series`,
    );
  });

  it("takes the max of a field, by absolute value when asked", () => {
    const sql = renderSql({
      ...base,
      query: { max: { event: "process.health", field: "clockSkewMs", abs: true } },
    });
    expect(sql).toContain(
      "max(abs(JSONExtract(raw, 'clockSkewMs', 'Nullable(Float64)'))) AS value",
    );
  });

  it("renders a ratio with its minimum count from the overlay", () => {
    const sql = renderSql(
      {
        ...base,
        query: {
          ratio: {
            event: "request",
            match: [{ field: "statusClass", eq: "5xx" }],
            minCount: "thresholds.m",
          },
        },
      },
      { "thresholds.m": 20 },
    );
    expect(sql).toContain(
      "if(count(*) >= 20, countIf(JSONExtractString(raw, 'statusClass') = '5xx') / count(*), 0) AS value",
    );
    expect(() =>
      renderSql({
        ...base,
        query: { ratio: { event: "request", match: [], minCount: "thresholds.m" } },
      }),
    ).toThrow(QueryError);
  });

  it("groups by the alert's own series field", () => {
    expect(renderSql({ ...base, sources: ["watcher"], seriesBy: "target" })).toContain(
      "JSONExtractString(raw, 'target') AS series",
    );
  });
});

describe("conditions", () => {
  it("requires the key for a boolean, so a line without it never matches false", () => {
    expect(condition({ field: "dbOk", eq: false })).toBe(
      "(JSONHas(raw, 'dbOk') AND JSONExtractBool(raw, 'dbOk') = 0)",
    );
  });

  it("refuses a literal or a field outside the allowed alphabet", () => {
    expect(() => condition({ field: "check", eq: "x' OR 1=1 --" })).toThrow(QueryError);
    expect(() => condition({ field: "a b", eq: "x" })).toThrow(QueryError);
    expect(() => condition({ field: "x", gt: Number.POSITIVE_INFINITY })).toThrow(QueryError);
    expect(() => condition({ field: "x", eq: "a", in: ["b"] })).toThrow(QueryError);
  });
});
