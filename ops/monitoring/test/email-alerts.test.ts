// The email fragment's email-delivery-stalled (spec 08 §7.8 group G; a name no text of the plan
// gives, proposed for the steward to confirm): a staging rule in alerts/email.json that notifies on
// any email.delivery_stalled, the line worker's sender writes when a database step of its delivery
// path stalls on a lock wait that ran out (55P03) or a connection not had in time, one incident per
// code with the label held to the two codes the sender writes, routed to staging-quiet only, with
// group G's runbook, email.md, naming it. The sender is read as text: ops/monitoring imports no
// other package (packages/email's stall.test.ts and stall.db.test.ts prove the line is written).
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
/** The codes the sender writes: a connection not had in time, a lock wait that ran out. */
const CODES = ["connect_timeout", "pg_55P03"];

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

  it("reads worker, one incident per code, the label held to the codes the sender writes", () => {
    const alert = rule();
    expect(alert?.sources).toEqual(["worker"]);
    expect(alert?.seriesBy).toEqual([{ field: "code", oneOf: CODES }]);
    expect(alert === undefined ? "" : renderSql(alert)).toBe(
      `SELECT {{time}} AS time, if(JSONExtractString(raw, 'code') IN ('connect_timeout', 'pg_55P03'), JSONExtractString(raw, 'code'), 'other') AS series, count(*) AS value FROM {{source}} WHERE time BETWEEN {{start_time}} AND {{end_time}} AND JSONExtractString(raw, 'event') = '${EVENT}' GROUP BY time, series`,
    );
  });

  it("routes to staging-quiet only, and asks for no call, text, push or critical alert", () => {
    const alert = rule();
    expect(alert?.policy).toBe("staging-quiet");
    for (const key of ["call", "sms", "push", "critical_alert"] as const) {
      expect(alert?.[key], key).toBeUndefined();
    }
    expect(alert?.incident_cause ?? "").toMatch(/55P03/);
    expect(alert?.metadata?.check ?? "").toMatch(/job\.run/);
  });

  it("is named by its event's catalogue entry, and is not owed", () => {
    expect(entry()?.alerts).toEqual([NAME]);
    expect(entry()?.owed ?? []).toEqual([]);
    expect(entry()?.kind).toBe("failure");
    expect(entry()?.fields).toEqual({ step: "string", code: "string", emailId: "string" });
    expect(OWED_ALERTS.map((a) => a.name)).not.toContain(NAME);
  });

  it("is named, with its line, its codes and its steps, by group G's runbook", () => {
    const text = read(RUNBOOK);
    expect(text).toContain(`\`${NAME}\``);
    expect(text).toContain(`\`${EVENT}\``);
    for (const code of CODES) expect(text).toContain(`\`code: ${code}\``);
    for (const step of ["claim", "row", "digest", "age", "sweep"]) {
      expect(text).toContain(`\`${step}\``);
    }
    const lines = text.split("\n").map((l) => l.trim());
    for (const heading of RUNBOOK_HEADINGS) expect(lines, heading).toContain(heading);
  });

  it("is written by worker's sender with the step and the code, the codes the rule's", () => {
    const sender = read(...SENDER);
    expect(sender).toContain(`"${EVENT}",`);
    expect(sender).toContain("{ step, code, ...(emailId === undefined ? {} : { emailId }) }");
    expect(sender).toContain('export type StallCode = "pg_55P03" | "connect_timeout";');
    expect(sender).toContain(
      'export type StallStep = "claim" | "row" | "digest" | "age" | "sweep";',
    );
    // The sender runs in worker only.
    expect(read("apps", "api", "src", "worker", "main.ts")).toContain("startEmailWorker(");
  });
});
