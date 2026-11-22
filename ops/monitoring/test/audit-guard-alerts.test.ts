// The audit fragment's audit-guard (spec 08 §3.14, group D): a staging rule in alerts/audit.json
// that pages on any database.audit_guard, the line the unit of work writes when the guard refuses a
// commit with FA010 (spec 08 §3.5), from every service whose logins record audit events and migrate
// for the operator tasks, one incident per service with the label held to those sources, routed to
// staging-quiet only, with the runbook spec 08 names; it is owed no more. The writers are read as
// text: ops/monitoring imports no other package.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS } from "../src/check.ts";
import { type AlertDef, loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const NAME = "audit-guard";
const EVENT = "database.audit_guard";
const RUNBOOK = "docs/runbooks/audit-guard.md";
/** The services whose logins record audit events (spec 08 §3.4), and migrate for the tasks. */
const SOURCES = ["api", "worker", "payments", "console", "admin", "migrate"];

const { config, findings } = loadEnv(ROOT, "staging");
const rule = (): AlertDef | undefined => config?.alerts.find((a) => a.name === NAME);
const entry = () =>
  Object.values(fragments)
    .flat()
    .find((e) => e.event === EVENT);
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");

describe("audit-guard", () => {
  it("loads from the staging files", () => {
    expect(findings).toEqual([]);
  });

  it("is a staging rule in alerts/audit.json that pages on any database.audit_guard", () => {
    const alert = rule();
    expect(alert, `${NAME} is no staging rule`).toBeDefined();
    expect(alert).toMatchObject({
      file: "ops/monitoring/staging/alerts/audit.json",
      group: "D",
      severity: "P",
      operator: "higher_than",
      threshold: "@any",
      query_period: 300,
      on_missing_data: "dont_fire",
      metadata: { flow: "F15", runbook: RUNBOOK },
    });
    expect(alert?.query).toEqual({ count: { events: [EVENT] } });
    expect(alert?.window).toBeUndefined();
  });

  it("reads every service that records audit events, one incident each, the label held to them", () => {
    const alert = rule();
    expect(alert?.sources).toEqual(SOURCES);
    expect(alert?.seriesBy).toEqual([{ field: "service", oneOf: SOURCES }]);
    const labels = SOURCES.map((s) => `'${s}'`).join(", ");
    expect(alert === undefined ? "" : renderSql(alert)).toBe(
      `SELECT {{time}} AS time, if(JSONExtractString(raw, 'service') IN (${labels}), JSONExtractString(raw, 'service'), 'other') AS series, count(*) AS value FROM {{source}} WHERE time BETWEEN {{start_time}} AND {{end_time}} AND JSONExtractString(raw, 'event') = '${EVENT}' GROUP BY time, series`,
    );
  });

  it("routes to staging-quiet only, and asks for no call, text, push or critical alert", () => {
    const alert = rule();
    expect(alert?.policy).toBe("staging-quiet");
    for (const key of ["call", "sms", "push", "critical_alert"] as const) {
      expect(alert?.[key], key).toBeUndefined();
    }
    expect(alert?.incident_cause ?? "").toMatch(/FA010/);
    expect(alert?.metadata?.check ?? "").toMatch(/privileged-login/);
  });

  it("is named by its event's catalogue entry and by identity's line list, and owed no more", () => {
    expect(entry()?.alerts).toEqual([NAME]);
    expect(entry()?.owed ?? []).toEqual([]);
    expect(OWED_ALERTS.map((a) => a.name)).not.toContain(NAME);
    expect(read("packages", "identity", "src", "monitoring.ts")).toContain(
      `"${EVENT}": { kind: "failure", alerts: ["${NAME}"] }`,
    );
  });

  it("has the runbook spec 08 names, with Phase 0's headings, naming the alert and its line", () => {
    expect(existsSync(join(ROOT, RUNBOOK)), `${RUNBOOK} does not exist`).toBe(true);
    const text = read(RUNBOOK);
    expect(text).toContain(`\`${NAME}\``);
    expect(text).toContain(`\`${EVENT}\``);
    expect(text).toContain("`FA010`");
    const lines = text.split("\n").map((l) => l.trim());
    for (const heading of RUNBOOK_HEADINGS) expect(lines, heading).toContain(heading);
  });

  it("is written, with the table only, by the units of work console, admin and migrate run", () => {
    // identity's unit of work, which console and admin open their databases with.
    const identity = read("packages", "identity", "src", "ports", "pg-database.ts");
    expect(identity).toContain(`lines.write("${EVENT}", "error", { table: guard })`);
    expect(read("apps", "console", "src", "server", "main.ts")).toContain("createPgDatabase({");
    expect(read("apps", "admin", "src", "server", "database.mjs")).toContain("createPgDatabase({");
    // packages/db's, which migrate's operator tasks run in.
    const db = read("packages", "db", "src", "unit.ts");
    expect(db).toContain(`{ event: "${EVENT}", level: "error", fields: { table } }`);
    expect(read("apps", "api", "src", "tasks", "run.ts")).toContain("db.unit(");
    expect(read("apps", "api", "src", "migrate", "main.ts")).toContain(
      "runTask(createDatabase({ pool })",
    );
    expect(entry()?.fields).toEqual({ table: "string" });
  });
});
