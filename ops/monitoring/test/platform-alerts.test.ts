// The platform fragment's clock-skew alert (spec 01 §8.7; spec 08 §7.8 group A; DECISIONS CF-72):
// a staging rule in alerts/platform.json over process.health's clockSkewMs, by absolute value,
// above the overlay's threshold, routed to staging-quiet only, with a runbook of Phase 0's headings.
// It is owed no more because a process writes the field: packages/server's sampleDatabaseClock,
// called from the health hooks of worker, console and admin. The code is read as text:
// ops/monitoring imports no other package.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS } from "../src/check.ts";
import { type AlertDef, loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");

const { config, findings } = loadEnv(ROOT, "staging");
const rule = (name: string): AlertDef | undefined => config?.alerts.find((a) => a.name === name);
const health = Object.values(fragments)
  .flat()
  .find((e) => e.event === "process.health");

/** The services whose health hooks write clockSkewMs today. */
const WRITERS = ["worker", "console", "admin"] as const;

describe("clock-skew", () => {
  it("loads from the staging files", () => {
    expect(findings).toEqual([]);
  });

  it("is a staging rule in alerts/platform.json: N, the max of |clockSkewMs| above its threshold", () => {
    const alert = rule("clock-skew");
    expect(alert, "clock-skew is no staging rule").toBeDefined();
    expect(alert).toMatchObject({
      template: "clock-skew",
      file: "ops/monitoring/staging/alerts/platform.json",
      group: "A",
      severity: "N",
      operator: "higher_than",
      threshold: "@thresholds.clock-skew",
      check_period: 60,
      query_period: 300,
      confirmation_period: 120,
      recovery_period: 600,
      on_missing_data: "dont_fire",
      metadata: { flow: "F20", runbook: "docs/runbooks/clock-skew.md" },
    });
    expect(alert?.query).toEqual({
      max: { event: "process.health", field: "clockSkewMs", abs: true },
    });
    expect(alert?.sources).toEqual([
      "edge",
      "api",
      "worker",
      "payments",
      "console",
      "admin",
      "verify",
      "backup",
    ]);
    for (const service of WRITERS) expect(alert?.sources, service).toContain(service);
    // One series per service, so a skewing service is its own incident.
    expect(alert?.seriesBy).toBeUndefined();
    expect(alert?.window).toBeUndefined();
    expect(alert === undefined ? "" : renderSql(alert)).toBe(
      "SELECT {{time}} AS time, JSONExtractString(raw, 'service') AS series, max(abs(JSONExtract(raw, 'clockSkewMs', 'Nullable(Float64)'))) AS value FROM {{source}} WHERE time BETWEEN {{start_time}} AND {{end_time}} AND JSONExtractString(raw, 'event') = 'process.health' GROUP BY time, series",
    );
  });

  it("routes to staging-quiet only, and asks for no call, text, push or critical alert", () => {
    const alert = rule("clock-skew");
    expect(alert?.policy).toBe("staging-quiet");
    for (const key of ["call", "sms", "push", "critical_alert"] as const) {
      expect(alert?.[key], key).toBeUndefined();
    }
    expect(alert?.incident_cause ?? "").toContain("{{value}} ms");
    expect(alert?.metadata?.check ?? "").not.toBe("");
  });

  it("is named by process.health's catalogue entry, and owed no more", () => {
    expect(health?.fields).toMatchObject({ clockSkewMs: "number" });
    expect(health?.alerts).toContain("clock-skew");
    expect(health?.owed ?? []).not.toContain("clock-skew");
    expect(OWED_ALERTS.map((a) => a.name)).not.toContain("clock-skew");
  });

  it("has a runbook with Phase 0's headings that names it, its field and its threshold", () => {
    const path = join(ROOT, "docs", "runbooks", "clock-skew.md");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    for (const want of [
      "`clock-skew`",
      "`process.health`",
      "`clockSkewMs`",
      "`@thresholds.clock-skew`",
      "`SELECT clock_timestamp()`",
    ]) {
      expect(text).toContain(want);
    }
    const lines = text.split("\n").map((l) => l.trim());
    for (const heading of RUNBOOK_HEADINGS) expect(lines, heading).toContain(heading);
  });

  it("reads a field the services write: clock_timestamp() on their own pool, on process.health", () => {
    // The sampler: the line it belongs to, the field it writes, and the database's clock at the
    // moment of the query (never now(), the transaction's start).
    const sampler = read("packages", "server", "src", "health", "process-health.ts");
    expect(sampler).toContain('logUnit("process.health"');
    expect(sampler).toContain("export async function sampleDatabaseClock(");
    expect(sampler).toMatch(/clockSkewMs: Math\.round\(/);
    const sql = /DATABASE_CLOCK_SQL =\s*"([^"]+)"/.exec(sampler)?.[1] ?? "";
    expect(sql).toContain("clock_timestamp()");
    expect(sql).not.toMatch(/\bnow\(\)|current_timestamp|transaction_timestamp/i);

    // Each writer's health hook calls it through the service's own pool and injected clock.
    expect(read("apps", "api", "src", "worker", "main.ts")).toContain(
      "clockSkewMs: (await sampleDatabaseClock(pool, ctx.clock)).clockSkewMs",
    );
    expect(read("apps", "console", "src", "server", "main.ts")).toContain(
      "...(await sampleDatabaseClock(pool, ctx.clock))",
    );
    expect(read("apps", "admin", "src", "server", "database.mjs")).toContain(
      "sampleClock: (processClock) => sampleDatabaseClock(pool, processClock)",
    );
    expect(read("apps", "admin", "src", "server", "main.ts")).toContain(
      "...(await database.sampleClock(ctx.clock))",
    );
  });

  it("has its logs-to-metrics series, clock_skew_ms (spec 01 §8.3)", () => {
    const metrics = config?.metrics.sets.process ?? [];
    expect(metrics).toContainEqual({
      name: "clock_skew_ms",
      field: "clockSkewMs",
      type: "float64_delta",
      aggregations: ["max"],
    });
  });
});
