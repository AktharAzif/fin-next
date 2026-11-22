import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AlertDef, loadEnv, type SeriesField } from "../src/config.ts";
import { condition, QueryError, renderSql, seriesFields } from "../src/sql.ts";

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

  it("joins several series fields into one series, so each combination is its own incident", () => {
    const sql = renderSql({
      ...base,
      sources: ["watcher"],
      seriesBy: ["check", "target", "detail"],
    });
    expect(sql).toContain(
      "concat(JSONExtractString(raw, 'check'), '/', JSONExtractString(raw, 'target'), '/', JSONExtractString(raw, 'detail')) AS series",
    );
    expect(sql).toContain("GROUP BY time, series");
    expect(() => renderSql({ ...base, seriesBy: [] })).toThrow(QueryError);
    expect(() => renderSql({ ...base, seriesBy: ["target", "it's"] })).toThrow(QueryError);
  });

  it("holds a bounded series field to its set or its shape, and gives any other value the one label other", () => {
    const sql = renderSql({
      ...base,
      sources: ["api", "console"],
      seriesBy: [
        { field: "service", oneOf: ["api", "console"] },
        { field: "sqlstate", shape: "sqlstate" },
      ],
    });
    expect(sql).toContain(
      "concat(if(JSONExtractString(raw, 'service') IN ('api', 'console'), JSONExtractString(raw, 'service'), 'other'), '/', if(match(JSONExtractString(raw, 'sqlstate'), '^[0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]$'), JSONExtractString(raw, 'sqlstate'), 'other')) AS series",
    );
    expect(seriesFields({ ...base, seriesBy: [{ field: "sqlstate", shape: "sqlstate" }] })).toEqual(
      ["sqlstate"],
    );
  });

  it("refuses a bounded series field it cannot hold to a closed set of labels", () => {
    const bad: unknown[] = [
      { field: "x" },
      { field: "x", oneOf: ["a"], shape: "sqlstate" },
      { field: "x", oneOf: [] },
      { field: "x", oneOf: ["other"] },
      { field: "x", oneOf: ["a/b"] },
      { field: "x", oneOf: ["it's"] },
      { field: "x", oneOf: [1] },
      { field: "x", shape: "anything" },
      { field: "it's", shape: "sqlstate" },
      { oneOf: ["a"] },
      null,
    ];
    for (const field of bad) {
      expect(
        () => renderSql({ ...base, seriesBy: [field as SeriesField] }),
        JSON.stringify(field),
      ).toThrow(QueryError);
    }
  });
});

describe("conditions", () => {
  it("requires the key for a boolean, so a line without it never matches false", () => {
    expect(condition({ field: "dbOk", eq: false })).toBe(
      "(JSONHas(raw, 'dbOk') AND JSONExtractBool(raw, 'dbOk') = 0)",
    );
  });

  it("matches a line without the field for notEq, so a security alert fails closed", () => {
    expect(condition({ field: "registered", notEq: true })).toBe(
      "NOT (JSONHas(raw, 'registered') AND JSONExtractBool(raw, 'registered') = 1)",
    );
    expect(condition({ field: "check", notEq: "dns" })).toBe(
      "NOT (JSONExtractString(raw, 'check') = 'dns')",
    );
    expect(() => condition({ field: "n", notEq: 3 as unknown as boolean })).toThrow(QueryError);
    expect(() => condition({ field: "registered", notEq: true, eq: false })).toThrow(QueryError);
  });

  it("matches only a line that carries the field for present, whatever its value", () => {
    expect(condition({ field: "userId", present: true })).toBe("JSONHas(raw, 'userId')");
    for (const value of [false, "true", 1, null]) {
      expect(
        () => condition({ field: "userId", present: value as unknown as true }),
        String(value),
      ).toThrow(QueryError);
    }
    expect(() => condition({ field: "userId", present: true, eq: "x" })).toThrow(QueryError);
    expect(() => condition({ field: "it's", present: true })).toThrow(QueryError);
  });

  it("renders privileged-login so a login whose registration is unknown alerts", () => {
    const { config } = loadEnv(join(import.meta.dirname, "..", "..", ".."), "staging");
    const login = config?.alerts.find((a) => a.name === "privileged-login");
    expect(login).toBeDefined();
    expect(renderSql(login as AlertDef)).toContain(
      "JSONExtractString(raw, 'event') = 'database.privileged_login' AND NOT (JSONHas(raw, 'registered') AND JSONExtractBool(raw, 'registered') = 1)",
    );
  });

  it("refuses a literal or a field outside the allowed alphabet", () => {
    expect(() => condition({ field: "check", eq: "x' OR 1=1 --" })).toThrow(QueryError);
    expect(() => condition({ field: "a b", eq: "x" })).toThrow(QueryError);
    expect(() => condition({ field: "x", gt: Number.POSITIVE_INFINITY })).toThrow(QueryError);
    expect(() => condition({ field: "x", eq: "a", in: ["b"] })).toThrow(QueryError);
  });
});
