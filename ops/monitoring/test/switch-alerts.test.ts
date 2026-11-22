// A kill switch moved by a person (spec 08 §7.8 group I, `switch-changed`): Fin Admin's switches
// route writes switch.set or switch.cleared with the event's name held in a variable, which MC-01
// reads from its declaration. Both lines are catalogued as security lines, and the rule that
// watches them is a staging rule, quiet, with its runbook.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { checkMonitoring, eventsInCode, RUNBOOK_HEADINGS } from "../src/check.ts";
import { loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const EVENTS = ["switch.set", "switch.cleared"] as const;
const entry = (event: string) =>
  Object.values(fragments)
    .flat()
    .find((e) => e.event === event);
const { config } = loadEnv(ROOT, "staging");
const rule = config?.alerts.find((a) => a.name === "switch-changed");

/** The staff switches route's own write, as the staff lane wrote it. */
const SWITCHES = [
  "export async function setSwitch(deps, tx, who, name, input) {",
  '  const event = input.state === "on" ? "switch.set" : "switch.cleared";',
  "  await deps.audit(tx, { event, target: name });",
  '  deps.lines.write(event, "warn", {',
  "    switch: name,",
  "    reasonCode: input.reasonCode,",
  "    staffId: who.staffId,",
  "  });",
  "}",
];

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

  it("covers the switches route's write as written, a name held in a variable", () => {
    const root = mkdtempSync(join(tmpdir(), "fin-monitoring-switch-"));
    roots.push(root);
    for (const dir of [
      ["ops", "monitoring", "staging"],
      ["ops", "watcher", "settings"],
      ["docs", "runbooks"],
    ]) {
      cpSync(join(ROOT, ...dir), join(root, ...dir), { recursive: true });
    }
    mkdirSync(join(root, "packages", "staff", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "staff", "src", "switches.ts"), SWITCHES.join("\n"));
    const found = eventsInCode(root);
    for (const event of EVENTS) {
      expect(found.get(event), event).toMatchObject({ file: "packages/staff/src/switches.ts" });
    }
    expect(checkMonitoring(root, { scan: [] })).toEqual([]);
    // Without their entries, MC-01 names both.
    const staff = (fragments.staff ?? []).filter(
      (e) => !(EVENTS as readonly string[]).includes(e.event),
    );
    const ops = { ...fragments, staff };
    expect(
      checkMonitoring(root, { fragments: ops, scan: [] })
        .filter((f) => f.rule === "MC-01")
        .map((f) => f.message),
    ).toEqual([
      'lines.write(event: "switch.set") is not catalogued',
      'lines.write(event: "switch.cleared") is not catalogued',
    ]);
  });
});
