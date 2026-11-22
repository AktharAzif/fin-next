// A kill switch moved by a person (spec 08 §7.8 group I, `switch-changed`): Fin Admin's switches
// route writes switch.set or switch.cleared. Both lines are catalogued as security lines, and the
// rule that watches them is a staging rule, quiet, with its runbook.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS } from "../src/check.ts";
import { loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const EVENTS = ["switch.set", "switch.cleared"] as const;
const entry = (event: string) =>
  Object.values(fragments)
    .flat()
    .find((e) => e.event === event);
const { config } = loadEnv(ROOT, "staging");
const rule = config?.alerts.find((a) => a.name === "switch-changed");

describe("switch-changed", () => {
  it("is a quiet staging rule in alerts/ops.json over both lines, on admin", () => {
    expect(rule).toMatchObject({
      file: "ops/monitoring/staging/alerts/ops.json",
      group: "I",
      severity: "N",
      operator: "higher_than",
      threshold: "@any",
      on_missing_data: "dont_fire",
      policy: "staging-quiet",
      metadata: { flow: "F23", runbook: "docs/runbooks/kill-switches.md" },
    });
    expect(rule?.sources).toEqual(["admin"]);
    expect(rule?.query).toEqual({ count: { events: [...EVENTS] } });
    // No field of the line is a label: one source, so one series.
    expect(rule?.seriesBy).toBeUndefined();
    for (const key of ["call", "sms", "push", "critical_alert"] as const) {
      expect(rule?.[key], key).toBeUndefined();
    }
    const sql = rule === undefined ? "" : renderSql(rule);
    expect(sql).toContain("IN ('switch.set', 'switch.cleared')");
    expect(sql).not.toContain("AS series");
  });

  it("watches two security lines whose entries name it, and is owed by no one", () => {
    for (const event of EVENTS) {
      expect(entry(event), event).toMatchObject({
        kind: "security",
        level: "warn",
        fields: { switch: "string", reasonCode: "string", staffId: "string" },
        alerts: ["switch-changed"],
      });
    }
    expect(OWED_ALERTS.map((a) => a.name)).not.toContain("switch-changed");
  });

  it("has a runbook with Phase 0's headings that names it", () => {
    const path = join(ROOT, "docs", "runbooks", "kill-switches.md");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("`switch-changed`");
    const lines = text.split("\n").map((l) => l.trim());
    for (const heading of RUNBOOK_HEADINGS) expect(lines, heading).toContain(heading);
  });
});
