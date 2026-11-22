// The staff fragment's alerts (spec 02 §18.2; spec 08 §7.8 group C), L-SAT-09's: each a staging
// rule in alerts/staff.json with the plan's severity and condition, over the line its catalogue
// entry names, from admin (the one service the staff realm runs on), routed to staging-quiet only,
// with a runbook of Phase 0's headings that names it; none is owed any more. The four that fire on
// any line give each line its own incident, replayed through the incident model the audit alerts'
// tests use (test/incidents.ts), so an expected change, enrolment or refusal never hides a later one.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS, readCode } from "../src/check.ts";
import { type AlertDef, loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";
import { incidents, type Line } from "./incidents.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

interface StaffRule {
  readonly name: string;
  readonly event: string;
  readonly severity: "P" | "N";
  readonly threshold: string;
  readonly queryPeriod: number;
  readonly recoveryPeriod: number;
  /** The one series field, held to a closed set; absent for one series. */
  readonly seriesBy?: { readonly field: string; readonly oneOf: readonly string[] };
  readonly flow: string;
  readonly runbook: string;
}

/** The kinds packages/staff's member changes write on staff.changed (spec 02 §18.1). */
const CHANGE_KINDS = ["added", "role_changed", "removed", "reset"];

/**
 * A rule that fires on any line gives each line its own incident: a query_period of 120 s, so a
 * line ingested up to a minute late still counts, and a recovery_period of 60 s, so the incident
 * closes within about three minutes of its last line and a later line opens a new one.
 */
const EACH_LINE = { threshold: "@any", queryPeriod: 120, recoveryPeriod: 60 } as const;

const RULES: readonly StaffRule[] = [
  {
    // Any Access identity that is no active or pending member reaching the API.
    name: "admin-staff-refused",
    event: "staff.not_listed",
    severity: "P",
    ...EACH_LINE,
    flow: "F6",
    runbook: "docs/runbooks/admin-staff-refused.md",
  },
  {
    name: "admin-access-mismatch",
    event: "staff.access_mismatch",
    severity: "P",
    ...EACH_LINE,
    flow: "F6",
    runbook: "docs/runbooks/admin-access-mismatch.md",
  },
  {
    // An out-of-band notice of every change: one incident per line, and per kind.
    name: "staff-changed",
    event: "staff.changed",
    severity: "N",
    ...EACH_LINE,
    seriesBy: { field: "kind", oneOf: CHANGE_KINDS },
    flow: "F-staff-add-and-enrol",
    runbook: "docs/runbooks/staff-changed.md",
  },
  {
    name: "staff-enrolled",
    event: "staff.enrolled",
    severity: "N",
    ...EACH_LINE,
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
    recoveryPeriod: 900,
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
          check_period: 60,
          query_period: want.queryPeriod,
          confirmation_period: 0,
          recovery_period: want.recoveryPeriod,
          on_missing_data: "dont_fire",
          metadata: { flow: want.flow, runbook: want.runbook },
        });
        expect(alert?.sources).toEqual(["admin"]);
        expect(alert?.query).toEqual({ count: { events: [want.event] } });
        expect(alert?.window).toBeUndefined();
        const where = `WHERE time BETWEEN {{start_time}} AND {{end_time}} AND JSONExtractString(raw, 'event') = '${want.event}'`;
        if (want.seriesBy === undefined) {
          // One source and no seriesBy: one series, so no field of the line becomes a label.
          expect(alert?.seriesBy).toBeUndefined();
          expect(alert === undefined ? "" : renderSql(alert)).toBe(
            `SELECT {{time}} AS time, count(*) AS value FROM {{source}} ${where} GROUP BY time`,
          );
        } else {
          // One series per value of a closed set, `other` for anything else: no line can choose
          // or multiply a label, and the catalogue entry groups by the same field.
          const { field, oneOf } = want.seriesBy;
          expect(alert?.seriesBy).toEqual([{ field, oneOf }]);
          expect(entry(want.event)?.seriesBy).toEqual([field]);
          const value = `JSONExtractString(raw, '${field}')`;
          const list = oneOf.map((v) => `'${v}'`).join(", ");
          expect(alert === undefined ? "" : renderSql(alert)).toBe(
            `SELECT {{time}} AS time, if(${value} IN (${list}), ${value}, 'other') AS series, count(*) AS value FROM {{source}} ${where} GROUP BY time, series`,
          );
        }
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
        // What the incident does after its last line, as the rule's periods give it.
        const plain = text.replace(/\s+/g, " ");
        if (want.recoveryPeriod === EACH_LINE.recoveryPeriod) {
          expect(plain).toContain("within about three minutes of the last");
          expect(plain).toContain("opens a new incident");
          expect(plain).not.toContain("15 minutes after the last");
        }
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

  it("hold staff-changed's kinds to exactly the kinds packages/staff writes", () => {
    const text = readFileSync(join(ROOT, "packages", "staff", "src", "members.ts"), "utf8");
    const written = [...text.matchAll(/lines\.write\("staff\.changed", "warn", \{([^}]*)\}/g)].map(
      (m) => /\bkind: "([a-z_]+)"/.exec(m[1] ?? "")?.[1],
    );
    expect(written.length).toBeGreaterThan(0);
    expect([...written].sort()).toEqual(CHANGE_KINDS);
  });
});

/** One line of `event` on admin `minutes` after the start, as the envelope ships it. */
function line(
  event: string,
  minutes: number,
  fields: Readonly<Record<string, unknown>> = {},
): Line {
  const envelope = { event, message: event, level: "warn", service: "admin", release: "r1" };
  return { at: minutes * 60, fields: { ...fields, ...envelope } };
}

/**
 * Each line opens its own incident, and so its own email (staging-quiet's repeatCount is 0): an
 * expected change, enrolment or refusal never hides a later one. The scenarios are spec 02
 * §18.2's notice of every change and the attacks an absorbed line would hide.
 */
describe("the staff fragment's incidents", () => {
  if (config === undefined) throw new Error("no staging config");
  const env = config;
  const ruleOf = (name: string): AlertDef => {
    const found = rule(name);
    if (found === undefined) throw new Error(`${name} is no rule`);
    return found;
  };
  /** The rule with the periods it had before: one incident absorbed every line for 20 minutes. */
  const absorbing = (r: AlertDef): AlertDef => {
    const { seriesBy: _seriesBy, ...one } = r;
    return { ...one, query_period: 300, recovery_period: 900 };
  };
  const changed = (minutes: number, kind: string) =>
    line("staff.changed", minutes, { kind, staffId: "stf_target", actorId: "stf_actor" });

  it("staff-changed: an expected change, then a raise and a removal inside 20 minutes, each opens its own", () => {
    const rule = ruleOf("staff-changed");
    const lines = [changed(1, "added"), changed(11, "role_changed"), changed(19, "removed")];
    expect(incidents(env, rule, lines)).toEqual([
      { series: "added", at: 60 },
      { series: "role_changed", at: 11 * 60 },
      { series: "removed", at: 19 * 60 },
    ]);
    expect(incidents(env, absorbing(rule), lines)).toHaveLength(1);
  });

  it("staff-changed: two changes of one kind ten minutes apart open two incidents", () => {
    const rule = ruleOf("staff-changed");
    const lines = [changed(1, "reset"), changed(11, "reset")];
    expect(incidents(env, rule, lines)).toEqual([
      { series: "reset", at: 60 },
      { series: "reset", at: 11 * 60 },
    ]);
    expect(incidents(env, absorbing(rule), lines)).toHaveLength(1);
  });

  it("staff-changed: a change every 14 minutes for three hours opens 13 incidents, never one that stays open", () => {
    const rule = ruleOf("staff-changed");
    const lines = Array.from({ length: 13 }, (_, i) => changed(1 + i * 14, "role_changed"));
    expect(incidents(env, rule, lines)).toHaveLength(13);
    expect(incidents(env, absorbing(rule), lines)).toHaveLength(1);
  });

  it("staff-changed: changes of different kinds in the same minute open one incident each", () => {
    const rule = ruleOf("staff-changed");
    const lines = [changed(5, "added"), changed(5.5, "reset")];
    expect(incidents(env, rule, lines).map((i) => i.series)).toEqual(["added", "reset"]);
  });

  it("staff-changed: a kind outside the four still opens an incident, labelled other", () => {
    const rule = ruleOf("staff-changed");
    for (const kind of ["promoted", "", "added/removed", 42, null]) {
      expect(incidents(env, rule, [changed(1, kind as string)]), String(kind)).toEqual([
        { series: "other", at: 60 },
      ]);
    }
  });

  it("staff-enrolled: an expected enrolment never hides an unexpected one 12 minutes later", () => {
    const rule = ruleOf("staff-enrolled");
    const lines = [
      line("staff.enrolled", 1, { staffId: "stf_a", method: "passkey" }),
      line("staff.enrolled", 13, { staffId: "stf_b", method: "totp" }),
    ];
    expect(incidents(env, rule, lines)).toEqual([
      { series: "", at: 60 },
      { series: "", at: 13 * 60 },
    ]);
    expect(incidents(env, absorbing(rule), lines)).toHaveLength(1);
  });

  it("admin-staff-refused: a colleague opening the host never hides another identity's code requests", () => {
    const rule = ruleOf("admin-staff-refused");
    const lines = [
      line("staff.not_listed", 1, { reason: "request" }),
      line("staff.not_listed", 16, { reason: "code_request" }),
      line("staff.not_listed", 31, { reason: "code_request" }),
    ];
    expect(incidents(env, rule, lines)).toHaveLength(3);
    expect(incidents(env, absorbing(rule), lines)).toHaveLength(1);
  });

  it("admin-access-mismatch: an explained mismatch never hides a stolen session ten minutes later", () => {
    const rule = ruleOf("admin-access-mismatch");
    const lines = [
      line("staff.access_mismatch", 1, { staffId: "stf_a" }),
      line("staff.access_mismatch", 11, { staffId: "stf_b" }),
    ];
    expect(incidents(env, rule, lines)).toHaveLength(2);
    expect(incidents(env, absorbing(rule), lines)).toHaveLength(1);
  });

  it("each line is counted in two checks, so a line ingested up to a minute late still opens one", () => {
    for (const name of [
      "admin-staff-refused",
      "admin-access-mismatch",
      "staff-changed",
      "staff-enrolled",
    ]) {
      const r = ruleOf(name);
      expect(r.query_period, name).toBe(2 * r.check_period);
      expect(r.recovery_period, name).toBe(r.check_period);
    }
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
