// The owed alerts the steward's ruling of 22 Nov gives L-SAT-09 for today, in its build order, so
// the first apply turns them on: audit-guard, secret-unreadable, rate-limiter-failing,
// csrf-refused-jump and the email delivery stall, then the sign-in and step-up rates. Each is a
// staging rule over a line the code writes where the rule's sources run, routed to staging-quiet
// only, with a runbook of Phase 0's headings that names it and its event, and owed no more. Then
// monitoring-drift over what pnpm fin monitoring apply writes, and what stays owed with its reason:
// an alert over a line nothing in the tree writes can never fire, so it is owed, not defined.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS } from "../src/check.ts";
import { type AlertDef, type Condition, loadEnv } from "../src/config.ts";
import { queryEvents, renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");

interface Want {
  readonly name: string;
  readonly event: string;
  readonly fragment: string;
  readonly group: string;
  readonly severity: "P" | "N";
  readonly threshold: string;
  readonly queryPeriod: number;
  readonly sources: readonly string[];
  readonly flow: string;
  readonly runbook: string;
  /** Files of the processes the sources run that write the event, and how each writes it. */
  readonly writers: readonly (readonly [file: string, writes: string])[];
}

const REALMS = ["console", "admin"];
const RECORDING = ["api", "worker", "payments", "console", "admin", "migrate"];

const WANT: readonly Want[] = [
  {
    name: "audit-guard",
    event: "database.audit_guard",
    fragment: "audit",
    group: "D",
    severity: "P",
    threshold: "@any",
    queryPeriod: 300,
    sources: RECORDING,
    flow: "F15",
    runbook: "docs/runbooks/audit-guard.md",
    writers: [
      ["packages/db/src/unit.ts", 'event: "database.audit_guard"'],
      ["packages/identity/src/ports/pg-database.ts", 'lines.write("database.audit_guard"'],
    ],
  },
  {
    name: "secret-unreadable",
    event: "auth.secret_unreadable",
    fragment: "identity",
    group: "C",
    severity: "P",
    threshold: "@any",
    queryPeriod: 300,
    sources: REALMS,
    flow: "F3",
    runbook: "docs/runbooks/secret-unreadable.md",
    writers: [
      ["packages/identity/src/hooks/before.ts", 'lines.write("auth.secret_unreadable"'],
      ["apps/console/src/server/viewer.ts", 'lines.write("auth.secret_unreadable"'],
    ],
  },
  {
    name: "rate-limiter-failing",
    event: "limits.store_failed",
    fragment: "identity",
    group: "C",
    severity: "P",
    threshold: "@any",
    queryPeriod: 300,
    sources: REALMS,
    flow: "F3",
    runbook: "docs/runbooks/rate-limiter-failing.md",
    writers: [["packages/identity/src/limits.ts", 'lines.write("limits.store_failed"']],
  },
  {
    name: "csrf-refused-jump",
    event: "csrf.refused",
    fragment: "identity",
    group: "C",
    severity: "N",
    threshold: "@thresholds.csrf-refused-jump",
    queryPeriod: 900,
    sources: ["console", "admin", "verify"],
    flow: "F3",
    runbook: "docs/runbooks/csrf-refused-jump.md",
    writers: [["packages/web-host/src/origin-gate.ts", 'log("csrf.refused"']],
  },
  {
    name: "email-delivery-stalled",
    event: "job.run",
    fragment: "email",
    group: "G",
    severity: "P",
    threshold: "@any",
    queryPeriod: 300,
    sources: ["worker"],
    flow: "F10",
    runbook: "docs/runbooks/email-delivery-stalled.md",
    writers: [["apps/api/src/worker/email/delivery-check.ts", '"job.run"']],
  },
  {
    name: "sign-in-failing",
    event: "auth.unhandled_error",
    fragment: "identity",
    group: "C",
    severity: "P",
    threshold: "@any",
    queryPeriod: 300,
    sources: REALMS,
    flow: "F3",
    runbook: "docs/runbooks/sign-in-failing.md",
    writers: [["packages/identity/src/realm.ts", 'lines.write("auth.unhandled_error"']],
  },
  {
    name: "second-factor-step-failing",
    event: "auth.unhandled_error",
    fragment: "identity",
    group: "C",
    severity: "P",
    threshold: "@any",
    queryPeriod: 300,
    sources: REALMS,
    flow: "F3",
    runbook: "docs/runbooks/sign-in-failing.md",
    writers: [["packages/identity/src/realm.ts", 'lines.write("auth.unhandled_error"']],
  },
  {
    name: "step-up-failing",
    event: "step_up.refused",
    fragment: "identity",
    group: "C",
    severity: "N",
    threshold: "@thresholds.step-up-failing",
    queryPeriod: 900,
    sources: REALMS,
    flow: "F3",
    runbook: "docs/runbooks/step-up.md",
    writers: [
      ["packages/identity/src/step-up/intents.ts", 'lines.write("step_up.refused"'],
      ["packages/orgs/src/intents.ts", 'lines.write("step_up.refused"'],
    ],
  },
  {
    name: "step-up-locked",
    event: "step_up.locked",
    fragment: "identity",
    group: "C",
    severity: "N",
    threshold: "@thresholds.step-up-locked",
    queryPeriod: 900,
    sources: REALMS,
    flow: "F3",
    runbook: "docs/runbooks/step-up.md",
    writers: [["packages/identity/src/hooks/shared.ts", 'lines.write("step_up.locked"']],
  },
];

const { config, findings } = loadEnv(ROOT, "staging");
const rule = (name: string): AlertDef | undefined => config?.alerts.find((a) => a.name === name);
const entry = (event: string) =>
  Object.values(fragments)
    .flat()
    .find((e) => e.event === event);
const sql = (name: string) => {
  const alert = rule(name);
  return alert === undefined ? "" : renderSql(alert);
};

describe("the alerts the ruling of 22 Nov gives L-SAT-09 for today", () => {
  it("load from the staging files", () => {
    expect(findings).toEqual([]);
  });

  for (const want of WANT) {
    describe(want.name, () => {
      it(`is a staging rule in alerts/${want.fragment}.json, routed to staging-quiet only`, () => {
        const alert = rule(want.name);
        expect(alert, `${want.name} is no staging rule`).toBeDefined();
        expect(alert).toMatchObject({
          file: `ops/monitoring/staging/alerts/${want.fragment}.json`,
          group: want.group,
          severity: want.severity,
          operator: "higher_than",
          threshold: want.threshold,
          query_period: want.queryPeriod,
          on_missing_data: "dont_fire",
          policy: "staging-quiet",
          metadata: { flow: want.flow, runbook: want.runbook },
        });
        expect(alert?.sources).toEqual(want.sources);
        expect(queryEvents(alert?.query ?? { lines: {} })).toEqual([want.event]);
        for (const key of ["call", "sms", "push", "critical_alert"] as const) {
          expect(alert?.[key], key).toBeUndefined();
        }
        expect(alert?.incident_cause ?? "").not.toBe("");
        expect(alert?.metadata?.check ?? "").not.toBe("");
      });

      it("opens one incident per service, the label held to its sources", () => {
        const alert = rule(want.name);
        if (want.sources.length === 1) {
          expect(alert?.seriesBy).toBeUndefined();
          return;
        }
        expect(alert?.seriesBy).toEqual([{ field: "service", oneOf: want.sources }]);
        expect(sql(want.name)).toContain(`, ${bounded("service", want.sources)} AS series`);
      });

      it("is named by its event's catalogue entry and owed no more", () => {
        expect(entry(want.event)?.alerts).toContain(want.name);
        expect(entry(want.event)?.owed ?? []).not.toContain(want.name);
        expect(OWED_ALERTS.map((a) => a.name)).not.toContain(want.name);
      });

      it("reads a line the code writes", () => {
        for (const [file, writes] of want.writers) {
          expect(read(file), `${file} writes ${want.event}`).toContain(writes);
        }
      });

      it("has a runbook with Phase 0's headings that names it and its event", () => {
        const path = join(ROOT, want.runbook);
        expect(existsSync(path), `${want.runbook} does not exist`).toBe(true);
        const text = read(want.runbook);
        expect(text).toContain(`\`${want.name}\``);
        expect(text).toContain(want.event === "job.run" ? "`job.run`" : `\`${want.event}\``);
        if (want.threshold !== "@any") expect(text).toContain(want.threshold);
        const lines = text.split("\n").map((l) => l.trim());
        for (const heading of RUNBOOK_HEADINGS) expect(lines, heading).toContain(heading);
      });
    });
  }

  it("split auth.unhandled_error by authPath, so every line reaches exactly one of the two", () => {
    const where = (name: string) => {
      const q = rule(name)?.query;
      return q !== undefined && "count" in q ? (q.count.where ?? []) : [];
    };
    const [signIn] = where("sign-in-failing");
    const [factor] = where("second-factor-step-failing");
    expect(signIn?.field).toBe("authPath");
    expect(factor?.field).toBe("authPath");
    expect(signIn?.notIn).toEqual(factor?.in);
    const paths = factor?.in ?? [];
    expect(paths.length).toBeGreaterThan(5);
    // Each is a path identity's endpoint allowlist names, as the realm writes it in authPath.
    const policy = read("packages", "identity", "src", "endpoint-policy.ts");
    for (const path of paths) expect(policy, path).toContain(`"${path}"`);
    expect(read("packages", "identity", "src", "realm.ts")).toContain(
      "state.line.authPath = rule.path",
    );
    // A line without authPath (an error before the path was classified) is sign-in-failing's.
    const line = { event: "auth.unhandled_error" };
    expect(matches(where("sign-in-failing"), [], line)).toBe(true);
    expect(matches(where("second-factor-step-failing"), [], line)).toBe(false);
  });

  it("count the step-up refusals whose digest differs, a reason the step-up checks write", () => {
    expect(rule("step-up-failing")?.query).toEqual({
      count: { events: ["step_up.refused"], where: [{ field: "reason", eq: "digest" }] },
    });
    expect(read("packages", "identity", "src", "step-up", "intents.ts")).toContain(
      'return "digest"',
    );
  });

  it("stall on a failed delivery check or an unrecorded run, never on the heartbeat's sent line", () => {
    const q = rule("email-delivery-stalled")?.query;
    expect(q).toEqual({
      count: {
        events: ["job.run"],
        where: [
          { field: "job", eq: "email-delivery-check" },
          { field: "trigger", notEq: "sent" },
        ],
        whereAny: [
          { field: "result", eq: "failed" },
          { field: "dutyState", eq: "failed" },
        ],
      },
    });
    const code = read("apps", "api", "src", "worker", "email", "delivery-check.ts");
    expect(code).toContain('export const DUTY = "email-delivery-check"');
    for (const written of [
      'result: "failed"',
      "code: outcome.code",
      'dutyState: "failed"',
      'trigger: "sent"',
    ]) {
      expect(code, written).toContain(written);
    }
    // A failure's code: the driver's or the socket's own (a SQLSTATE such as 55P03, or an errno
    // such as ETIMEDOUT) after pg_, and `error` without one.
    expect(code).toMatch(/\? `pg_\$\{code\}` : "error"/);
    const where = q !== undefined && "count" in q ? (q.count.where ?? []) : [];
    const any = q !== undefined && "count" in q ? (q.count.whereAny ?? []) : [];
    const run = { event: "job.run", job: "email-delivery-check" };
    // A lock timeout, a connection that timed out, and a run that could not be recorded.
    expect(
      matches(where, any, { ...run, trigger: "schedule", result: "failed", code: "pg_55P03" }),
    ).toBe(true);
    expect(
      matches(where, any, { ...run, trigger: "schedule", result: "failed", code: "pg_ETIMEDOUT" }),
    ).toBe(true);
    expect(
      matches(where, any, { ...run, trigger: "daily", result: "ok", dutyState: "failed" }),
    ).toBe(true);
    // A run that queued its email, and the heartbeat's own line after the email is sent.
    expect(matches(where, any, { ...run, trigger: "daily", result: "ok" })).toBe(false);
    expect(
      matches(where, any, { ...run, trigger: "sent", result: "failed", heartbeat: "failed" }),
    ).toBe(false);
    // The job.run fields it reads are the catalogue's.
    for (const field of ["job", "trigger", "result", "dutyState", "code"]) {
      expect(entry("job.run")?.fields, field).toHaveProperty(field);
    }
  });
});

describe("monitoring-drift", () => {
  const OUTCOMES = ["dry-run", "unchanged", "applied", "refused", "stopped", "mismatch"];

  it("counts what pnpm fin monitoring apply writes: the monitoring.apply line, its outcome and drift", () => {
    const alert = rule("monitoring-drift");
    expect(alert).toMatchObject({ severity: "N", sources: ["ops"], policy: "staging-quiet" });
    expect(alert?.query).toEqual({
      count: {
        events: ["monitoring.apply"],
        whereAny: [
          { field: "drift", eq: true },
          { field: "outcome", notIn: ["dry-run", "unchanged", "applied"] },
        ],
      },
    });
    const command = read("ops", "fin", "src", "monitoring", "apply.ts");
    expect(command).toContain('ctx.run.line("monitoring.apply"');
    expect(command).toContain("outcome: result.outcome");
    expect(command).toContain("drift: result.drift");
    expect(command).toContain('return { dryRun, outcome: "error" }');
    for (const outcome of OUTCOMES) expect(command).toContain(`"${outcome}"`);
    expect(entry("monitoring.apply")?.alerts).toEqual(["monitoring-drift"]);
    expect(entry("monitoring.apply")?.kind).toEqual(["unit", "failure"]);
    // The SQL sent, which matches() below reads.
    expect(sql("monitoring-drift")).toContain(
      "((JSONHas(raw, 'drift') AND JSONExtractBool(raw, 'drift') = 1) OR JSONExtractString(raw, 'outcome') NOT IN ('dry-run', 'unchanged', 'applied'))",
    );
  });

  it("fires on drift, a read-back that differs, a refusal, a stop and a failed apply, never on a clean run", () => {
    const q = rule("monitoring-drift")?.query;
    const any = q !== undefined && "count" in q ? (q.count.whereAny ?? []) : [];
    const line = (fields: Record<string, unknown>) => ({ event: "monitoring.apply", ...fields });
    for (const outcome of ["dry-run", "unchanged", "applied"]) {
      expect(matches([], any, line({ outcome, drift: false })), outcome).toBe(false);
      expect(matches([], any, line({ outcome, drift: true })), `${outcome} with drift`).toBe(true);
    }
    for (const outcome of ["refused", "stopped", "mismatch"]) {
      expect(matches([], any, line({ outcome, drift: false })), outcome).toBe(true);
    }
    // The apply process gave no result: no drift field at all.
    expect(matches([], any, line({ outcome: "error", dryRun: false }))).toBe(true);
    expect(matches([], any, line({}))).toBe(true);
  });

  it("no staging alert reads a run.done result of drift, which no run writes", () => {
    const run = read("ops", "fin", "src", "core", "run.ts");
    expect(run).toContain('export type RunResult = "ok" | "failed" | "refused";');
    for (const alert of config?.alerts ?? []) {
      const q = alert.query;
      if (!("count" in q) || !q.count.events.includes("run.done")) continue;
      const conditions = [...(q.count.where ?? []), ...(q.count.whereAny ?? [])];
      expect(
        conditions.some((c) => c.field === "result" && c.eq === "drift"),
        alert.name,
      ).toBe(false);
    }
  });
});

describe("the first recorded run (docs/runbooks/monitoring-drift.md)", () => {
  const text = read("docs", "runbooks", "monitoring-drift.md");
  const first = text.slice(text.indexOf("## The first recorded run"));

  it("writes the overlay key MA-10 refuses the first apply without, which an alert reads", () => {
    expect(first).toContain("`thresholds.auth-endpoint-unlisted`");
    expect(rule("auth-endpoint-unlisted")?.threshold).toBe("@thresholds.auth-endpoint-unlisted");
    // Every other key it names is one a staging alert reads.
    const named = [...first.matchAll(/`thresholds\.([a-z0-9-]+)`/g)].map((m) => m[1]);
    const keys = new Set(
      (config?.alerts ?? []).map((a) => a.threshold.replace(/^@thresholds\./, "")),
    );
    for (const key of named) expect(keys.has(key ?? ""), key).toBe(true);
  });

  it("checks that the apply creates every alert due tonight, each a staging rule", () => {
    const step = first.slice(first.indexOf("3. **Apply.**"), first.indexOf("4. **Read-back.**"));
    const names = [...step.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)].map((m) => m[1] ?? "");
    for (const want of WANT) expect(names, want.name).toContain(want.name);
    for (const name of names) expect(rule(name), name).toBeDefined();
  });
});

describe("what stays owed, with why", () => {
  const owed = (name: string) => OWED_ALERTS.find((a) => a.name === name);

  it("github-settings-changed: pnpm fin has no github verify command", () => {
    expect(rule("github-settings-changed")).toBeUndefined();
    expect(owed("github-settings-changed")).toMatchObject({ fragment: "platform", lane: "P0-F" });
    expect(owed("github-settings-changed")?.note).toMatch(/no such command/);
    const dirs = ["commands", "cloudflare", "railway", "monitoring", "static"];
    const commands = dirs.flatMap((dir) => {
      const base = join(ROOT, "ops", "fin", "src", dir);
      return readdirSync(base)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => readFileSync(join(base, f), "utf8"));
    });
    expect(commands.some((text) => /words: \["github"/.test(text))).toBe(false);
    expect(entry("run.done")?.owed).toEqual(["github-settings-changed"]);
    expect(entry("run.done")?.alerts).toEqual([]);
  });

  it("every L-SAT-09 or P0-F alert owed today says why it is not built", () => {
    const today = OWED_ALERTS.filter(
      (a) => (a.lane === "L-SAT-09" || a.lane === "P0-F") && a.due <= "2026-11-22",
    );
    expect(today.map((a) => a.name).sort()).toEqual([
      "admin-access-drift",
      "admin-without-second-factor",
      "clock-skew",
      "duty-stalled-access-drift",
      "github-settings-changed",
      "sign-in-code-contested",
      "team-change-failing",
    ]);
    for (const alert of today) expect(alert.note ?? "", alert.name).not.toBe("");
  });
});

/** A series label held to `values`: the line's value when it is one of them, else `other`. */
function bounded(field: string, values: readonly string[]): string {
  const value = `JSONExtractString(raw, '${field}')`;
  return `if(${value} IN (${values.map((v) => `'${v}'`).join(", ")}), ${value}, 'other')`;
}

/**
 * Whether a line matches `where` (every condition) and `whereAny` (one of them, when given), as
 * renderSql's SQL reads it in ClickHouse: a string field is '' when missing or of another type; a
 * boolean `eq` needs the key; `notEq` is the negation of `eq`, so a missing field matches it.
 */
function matches(
  where: readonly Condition[],
  any: readonly Condition[],
  line: Readonly<Record<string, unknown>>,
): boolean {
  const text = (field: string) => (typeof line[field] === "string" ? (line[field] as string) : "");
  const one = (c: Condition): boolean => {
    if (c.notEq !== undefined) return !one({ field: c.field, eq: c.notEq });
    if (c.in !== undefined) return c.in.includes(text(c.field));
    if (c.notIn !== undefined) return !c.notIn.includes(text(c.field));
    if (typeof c.eq === "boolean") return c.field in line && line[c.field] === c.eq;
    if (typeof c.eq === "string") return text(c.field) === c.eq;
    throw new Error(`a condition this test does not read: ${JSON.stringify(c)}`);
  };
  return where.every(one) && (any.length === 0 || any.some(one));
}
