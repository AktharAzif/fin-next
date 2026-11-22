// The staff fragment's alerts (spec 02 §18.2; spec 08 §7.8 group C), L-SAT-09's: each a staging
// rule in alerts/staff.json with the plan's severity and condition, over the line its catalogue
// entry names, from admin (the one service the staff realm runs on), routed to staging-quiet only,
// with a runbook of Phase 0's headings that names it; none is owed any more.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS, readCode } from "../src/check.ts";
import { type AlertDef, loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

interface StaffRule {
  readonly name: string;
  readonly event: string;
  readonly severity: "P" | "N";
  readonly threshold: string;
  readonly queryPeriod: number;
  readonly flow: string;
  readonly runbook: string;
}

const RULES: readonly StaffRule[] = [
  {
    // Any Access identity that is no active or pending member reaching the API.
    name: "admin-staff-refused",
    event: "staff.not_listed",
    severity: "P",
    threshold: "@any",
    queryPeriod: 300,
    flow: "F6",
    runbook: "docs/runbooks/admin-staff-refused.md",
  },
  {
    name: "admin-access-mismatch",
    event: "staff.access_mismatch",
    severity: "P",
    threshold: "@any",
    queryPeriod: 300,
    flow: "F6",
    runbook: "docs/runbooks/admin-access-mismatch.md",
  },
  {
    // An out-of-band notice of every change.
    name: "staff-changed",
    event: "staff.changed",
    severity: "N",
    threshold: "@any",
    queryPeriod: 300,
    flow: "F-staff-add-and-enrol",
    runbook: "docs/runbooks/staff-changed.md",
  },
  {
    name: "staff-enrolled",
    event: "staff.enrolled",
    severity: "N",
    threshold: "@any",
    queryPeriod: 300,
    flow: "F-staff-add-and-enrol",
    runbook: "docs/runbooks/staff-enrolled.md",
  },
  {
    // Above its threshold, the value in the private overlay (OB-13).
    name: "staff-enrolment-refused",
    event: "staff.enrolment_refused",
    severity: "N",
    threshold: "@thresholds.staff-enrolment-refused",
    queryPeriod: 900,
    flow: "F-staff-add-and-enrol",
    runbook: "docs/runbooks/staff-enrolment-refused.md",
  },
];

const { config, findings } = loadEnv(ROOT, "staging");
const rule = (name: string): AlertDef | undefined => config?.alerts.find((a) => a.name === name);
const entry = (event: string) =>
  Object.values(fragments)
    .flat()
    .find((e) => e.event === event);

describe("the staff fragment's alerts", () => {
  it("load from the staging files", () => {
    expect(findings).toEqual([]);
  });

  for (const want of RULES) {
    describe(want.name, () => {
      it("is a staging rule in alerts/staff.json with the plan's severity and condition, on admin", () => {
        const alert = rule(want.name);
        expect(alert, `${want.name} is no staging rule`).toBeDefined();
        expect(alert).toMatchObject({
          file: "ops/monitoring/staging/alerts/staff.json",
          group: "C",
          severity: want.severity,
          operator: "higher_than",
          threshold: want.threshold,
          query_period: want.queryPeriod,
          on_missing_data: "dont_fire",
          metadata: { flow: want.flow, runbook: want.runbook },
        });
        expect(alert?.sources).toEqual(["admin"]);
        expect(alert?.query).toEqual({ count: { events: [want.event] } });
        // One source and no seriesBy: one series, so no field of the line becomes a label.
        expect(alert?.seriesBy).toBeUndefined();
        expect(alert?.window).toBeUndefined();
        expect(alert === undefined ? "" : renderSql(alert)).toBe(
          `SELECT {{time}} AS time, count(*) AS value FROM {{source}} WHERE time BETWEEN {{start_time}} AND {{end_time}} AND JSONExtractString(raw, 'event') = '${want.event}' GROUP BY time`,
        );
      });

      it("routes to staging-quiet only, and asks for no call, text, push or critical alert", () => {
        const alert = rule(want.name);
        expect(alert?.policy).toBe("staging-quiet");
        for (const key of ["call", "sms", "push", "critical_alert"] as const) {
          expect(alert?.[key], key).toBeUndefined();
        }
        expect(alert?.incident_cause ?? "").not.toBe("");
        expect(alert?.metadata?.check ?? "").not.toBe("");
      });

      it("is named by its event's catalogue entry and owed no more", () => {
        expect(entry(want.event)?.alerts).toContain(want.name);
        expect(entry(want.event)?.owed ?? []).not.toContain(want.name);
        expect(OWED_ALERTS.map((a) => a.name)).not.toContain(want.name);
      });

      it("has a runbook with Phase 0's headings that names it", () => {
        const path = join(ROOT, want.runbook);
        expect(existsSync(path), `${want.runbook} does not exist`).toBe(true);
        const text = readFileSync(path, "utf8");
        expect(text).toContain(`\`${want.name}\``);
        expect(text).toContain(`\`${want.event}\``);
        if (want.threshold !== "@any") expect(text).toContain(want.threshold);
        const lines = text.split("\n").map((l) => l.trim());
        for (const heading of RUNBOOK_HEADINGS) expect(lines, heading).toContain(heading);
      });
    });
  }

  it("are written on admin by the code the catalogue names", () => {
    // Each event, and a file of a process that writes it (the staff realm and packages/staff run
    // on admin): a writer that stops writing the event fails here.
    const writers: readonly [event: string, file: string][] = [
      ["staff.not_listed", "packages/identity/src/hooks/before.ts"],
      ["staff.not_listed", "packages/staff/src/require-staff.ts"],
      ["staff.access_mismatch", "packages/identity/src/hooks/before.ts"],
      ["staff.access_mismatch", "packages/staff/src/require-staff.ts"],
      ["staff.changed", "packages/staff/src/members.ts"],
      ["staff.enrolled", "packages/identity/src/hooks/after.ts"],
      ["staff.enrolment_refused", "packages/identity/src/staff/enrolment.ts"],
    ];
    for (const [event, file] of writers) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, `${file} writes ${event}`).toContain(`lines.write("${event}"`);
    }
    const admin = readFileSync(join(ROOT, "apps", "admin", "src", "server", "main.ts"), "utf8");
    expect(admin).toContain("createStaffDeps({ realm, clock, lines");
  });
});

/**
 * The staff fragment's alerts that stay owed, each while what it would read is written by no
 * process: a rule over such a line can never fire (or, over a missing field with notEq, fires on
 * every line). Each check below fails once the writer lands, so the lane that lands it moves the
 * alert from catalog/owed.ts to alerts/staff.json in the same change (MC-15).
 */
describe("the staff fragment's owed alerts", () => {
  const owed = (name: string) => OWED_ALERTS.find((a) => a.name === name);
  const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");

  it("stay owed, in the staff fragment, with the reason in their note", () => {
    for (const name of [
      "admin-without-second-factor",
      "admin-access-drift",
      "duty-stalled-access-drift",
    ]) {
      expect(rule(name), `${name} is a staging rule`).toBeUndefined();
      expect(owed(name), name).toMatchObject({ fragment: "staff", lane: "L-SAT-09" });
    }
    expect(owed("admin-without-second-factor")?.note).toMatch(
      /no admin request line carries assurance/,
    );
    expect(owed("admin-access-drift")?.note).toMatch(/no process runs the duty yet/);
    expect(owed("duty-stalled-access-drift")?.note).toMatch(/no process runs the duty yet/);
  });

  it("admin-without-second-factor: no admin request line carries assurance yet", () => {
    // The host's one request line: packages/server's fields, and what admin adds to them.
    expect(read("packages", "server", "src", "telemetry", "lines.ts")).not.toMatch(/\bassurance\b/);
    expect(read("packages", "server", "src", "http", "request.ts")).not.toMatch(/\bassurance\b/);
    expect(read("apps", "admin", "src", "server", "auth-hook.ts")).not.toMatch(/\bassurance\b/);
    expect(read("apps", "admin", "src", "server", "routes", "register.ts")).not.toMatch(
      /c\.set\("assurance"/,
    );
    expect(entry("request")?.fields).not.toHaveProperty("assurance");
    expect(entry("request")?.owed).toContain("admin-without-second-factor");
  });

  it("admin-access-drift and duty-stalled-access-drift: no process runs the Access drift duty yet", () => {
    // packages/staff writes the line when the duty runs; nothing in a deployable runs it.
    expect(read("packages", "staff", "src", "access-drift.ts")).toContain(
      'lines.write("access.drift"',
    );
    const runners = readCode(ROOT)
      .filter(({ file }) => file.startsWith("apps/") || file.startsWith("ops/"))
      .filter(({ text }) => /\brunAccessDriftCheck\b/.test(text))
      .map(({ file }) => file);
    expect(runners).toEqual([]);
    expect(entry("access.drift")?.owed).toEqual(["admin-access-drift"]);
    expect(entry("access.drift")?.alerts).toEqual([]);
  });
});
