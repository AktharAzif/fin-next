// The email fragment's email-delivery-stalled (spec 08 §7.8 group G; a name no text of the plan
// gives, proposed for the steward to confirm): a staging rule in alerts/email.json that notifies on
// any email.delivery_stalled, the line worker's sender and delivery check write when a database
// step of the delivery path stalls on a lock wait that ran out (55P03) or a connection not had in
// time, one incident per reason with the label held to the two reasons the line carries, routed to
// staging-quiet only, with group G's runbook, email.md, naming it. The series field is `reason`, a
// name the telemetry keeps (never `code`, which spec 08 §5.4 withholds), so its value reaches
// Better Stack. The writers are read as text: ops/monitoring imports no other package
// (packages/email's stall tests and apps/api's worker tests prove the line is written, and that it
// survives the scrubber).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS } from "../src/check.ts";
import { type AlertDef, loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const NAME = "email-delivery-stalled";
const EVENT = "email.delivery_stalled";
const RUNBOOK = "docs/runbooks/email.md";
const SENDER = ["packages", "email", "src", "sender", "sender.ts"];
const CHECK = ["apps", "api", "src", "worker", "email", "delivery-check.ts"];
/** The reasons the line carries: a connection not had in time, a lock wait that ran out. */
const REASONS = ["connect_timeout", "lock_timeout"];
/** The sender's steps, then the delivery check's. */
const STEPS = ["claim", "row", "digest", "age", "sweep", "check", "check_state"];

const { config, findings } = loadEnv(ROOT, "staging");
const rule = (): AlertDef | undefined => config?.alerts.find((a) => a.name === NAME);
const entry = () =>
  Object.values(fragments)
    .flat()
    .find((e) => e.event === EVENT);
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");

describe("email-delivery-stalled", () => {
  it("loads from the staging files", () => {
    expect(findings).toEqual([]);
  });

  it("is a staging rule in alerts/email.json that notifies on any email.delivery_stalled", () => {
    const alert = rule();
    expect(alert, `${NAME} is no staging rule`).toBeDefined();
    expect(alert).toMatchObject({
      file: "ops/monitoring/staging/alerts/email.json",
      group: "G",
      severity: "N",
      operator: "higher_than",
      threshold: "@any",
      check_period: 60,
      query_period: 300,
      confirmation_period: 0,
      recovery_period: 900,
      on_missing_data: "dont_fire",
      metadata: { flow: "F10", runbook: RUNBOOK },
    });
    expect(alert?.query).toEqual({ count: { events: [EVENT] } });
    expect(alert?.window).toBeUndefined();
  });

  it("reads worker, one incident per reason, the label held to the reasons the line carries", () => {
    const alert = rule();
    expect(alert?.sources).toEqual(["worker"]);
    expect(alert?.seriesBy).toEqual([{ field: "reason", oneOf: REASONS }]);
    expect(alert === undefined ? "" : renderSql(alert)).toBe(
      `SELECT {{time}} AS time, if(JSONExtractString(raw, 'reason') IN ('connect_timeout', 'lock_timeout'), JSONExtractString(raw, 'reason'), 'other') AS series, count(*) AS value FROM {{source}} WHERE time BETWEEN {{start_time}} AND {{end_time}} AND JSONExtractString(raw, 'event') = '${EVENT}' GROUP BY time, series`,
    );
  });

  it("routes to staging-quiet only, and asks for no call, text, push or critical alert", () => {
    const alert = rule();
    expect(alert?.policy).toBe("staging-quiet");
    for (const key of ["call", "sms", "push", "critical_alert"] as const) {
      expect(alert?.[key], key).toBeUndefined();
    }
    expect(alert?.incident_cause ?? "").toMatch(/55P03/);
    expect(alert?.metadata?.check ?? "").toMatch(/step and reason/);
    expect(alert?.metadata?.check ?? "").toMatch(/email-send or email-delivery-check/);
  });

  it("is named by its event's catalogue entry, and is not owed", () => {
    expect(entry()?.alerts).toEqual([NAME]);
    expect(entry()?.owed ?? []).toEqual([]);
    expect(entry()?.kind).toBe("failure");
    expect(entry()?.fields).toEqual({ step: "string", reason: "string", emailId: "string" });
    expect(OWED_ALERTS.map((a) => a.name)).not.toContain(NAME);
  });

  it("is named, with its line, its reasons and its steps, by group G's runbook", () => {
    const text = read(RUNBOOK);
    expect(text).toContain(`\`${NAME}\``);
    expect(text).toContain(`\`${EVENT}\``);
    for (const reason of REASONS) expect(text).toContain(`\`reason: ${reason}\``);
    for (const step of STEPS) expect(text).toContain(`\`${step}\``);
    // The runbook never sends the operator to the stall's kind under `code`, which is withheld,
    // and never says a stall at every step pages as email-outbox-age.
    expect(text).not.toMatch(/`code: (?:pg_55P03|connect_timeout)`|`step` and `code`/);
    expect(text).not.toContain("a stall that goes on also pages as `email-outbox-age`");
    expect(text).toMatch(/`email-outbox-age`\s+stays silent/);
    const lines = text.split("\n").map((l) => l.trim());
    for (const heading of RUNBOOK_HEADINGS) expect(lines, heading).toContain(heading);
  });

  it("is written by worker's sender and delivery check with the step and the reason", () => {
    const sender = read(...SENDER);
    expect(sender).toContain(`"${EVENT}",`);
    expect(sender).toContain("{ step, reason, ...(emailId === undefined ? {} : { emailId }) }");
    expect(sender).toContain('export type StallReason = "lock_timeout" | "connect_timeout";');
    expect(sender).toContain(
      'export type StallStep = "claim" | "row" | "digest" | "age" | "sweep" | "check" | "check_state";',
    );
    const check = read(...CHECK);
    expect(check).toContain('noteStall(o.log, "check", error);');
    expect(check).toContain('noteStall(log, "check_state", error);');
    // The sender and the check run in worker only.
    expect(read("apps", "api", "src", "worker", "main.ts")).toContain("startEmailWorker(");
  });
});
