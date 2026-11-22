// The identity fragment's sign-in and step-up rates (spec 02 §18.2; spec 08 §7.8 group C),
// L-SAT-09's: sign-in-code-contested and step-up-locked are staging rules in alerts/identity.json
// with the plan's severity and condition, over the line their catalogue entry names, from the
// services whose realms write it, routed to staging-quiet only, with a runbook of Phase 0's headings
// that names them; neither is owed any more. sign-in-failing, second-factor-step-failing and
// step-up-failing stay owed while the host's request line carries no auth path, and the checks
// below fail once it does, so the lane that lands the field moves them in the same change (MC-15).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS, readCode } from "../src/check.ts";
import { type AlertDef, type AlertQuery, loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FILE = "ops/monitoring/staging/alerts/identity.json";

interface IdentityRule {
  readonly name: string;
  readonly event: string;
  readonly severity: "P" | "N";
  readonly threshold: string;
  readonly sources: readonly string[];
  readonly seriesBy: AlertDef["seriesBy"];
  readonly query: AlertQuery;
  readonly queryPeriod: number;
  readonly recoveryPeriod: number;
  readonly flow: string;
  readonly runbook: string;
  /** The SQL the rule renders, from the WHERE clause's event filter on. */
  readonly sql: string;
}

const WINDOW = "time BETWEEN {{start_time}} AND {{end_time}}";

const RULES: readonly IdentityRule[] = [
  {
    // Contests for one userId above the threshold: one series per account, over the lines that
    // carry a userId (a contest for an address with no account has none and is no account's).
    // Only the developer realm's code requests write the line (spec 02 §5.2), so console is the
    // one source.
    name: "sign-in-code-contested",
    event: "auth.code_contested",
    severity: "N",
    threshold: "@thresholds.sign-in-code-contested",
    sources: ["console"],
    seriesBy: "userId",
    query: {
      count: { events: ["auth.code_contested"], where: [{ field: "userId", present: true }] },
    },
    queryPeriod: 3600,
    recoveryPeriod: 3600,
    flow: "F3",
    runbook: "docs/runbooks/sign-in-code-contested.md",
    sql: `SELECT {{time}} AS time, JSONExtractString(raw, 'userId') AS series, count(*) AS value FROM {{source}} WHERE ${WINDOW} AND JSONExtractString(raw, 'event') = 'auth.code_contested' AND JSONHas(raw, 'userId') GROUP BY time, series`,
  },
  {
    // Locks above the threshold, per service: both realms write the line.
    name: "step-up-locked",
    event: "step_up.locked",
    severity: "N",
    threshold: "@thresholds.step-up-locked",
    sources: ["console", "admin"],
    seriesBy: [{ field: "service", oneOf: ["console", "admin"] }],
    // Every line of the event counts: no filter can drop a line that lost a field.
    query: { count: { events: ["step_up.locked"] } },
    queryPeriod: 900,
    recoveryPeriod: 900,
    flow: "F4",
    runbook: "docs/runbooks/step-up-locked.md",
    sql: `SELECT {{time}} AS time, if(JSONExtractString(raw, 'service') IN ('console', 'admin'), JSONExtractString(raw, 'service'), 'other') AS series, count(*) AS value FROM {{source}} WHERE ${WINDOW} AND JSONExtractString(raw, 'event') = 'step_up.locked' GROUP BY time, series`,
  },
];

const { config, findings } = loadEnv(ROOT, "staging");
const rule = (name: string): AlertDef | undefined => config?.alerts.find((a) => a.name === name);
const entry = (event: string) =>
  Object.values(fragments)
    .flat()
    .find((e) => e.event === event);
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");

type Line = Readonly<Record<string, unknown>>;

const PLAIN_SERIES =
  /^SELECT \{\{time\}\} AS time, JSONExtractString\(raw, '([A-Za-z]+)'\) AS series, count\(\*\) AS value FROM \{\{source\}\} WHERE (.+) GROUP BY time, series$/;

/**
 * Counts lines per series as ClickHouse would run the rendered SQL over them, for a series that is
 * one plain field and a filter of `=` and JSONHas conditions joined by AND: JSONExtractString gives
 * '' for a missing field or a value that is not a string, and JSONHas whether the line carries the
 * key. Any other shape throws, so the counts come from the SQL that is sent.
 */
function seriesCounts(sql: string, lines: readonly Line[]): Record<string, number> {
  const [, seriesField = "", where = ""] = PLAIN_SERIES.exec(sql) ?? [];
  if (!where.startsWith(`${WINDOW} AND `)) throw new Error(`SQL this test cannot read: ${sql}`);
  const extract = (line: Line, key: string) => {
    const value = line[key];
    return typeof value === "string" ? value : "";
  };
  const tests = where
    .slice(`${WINDOW} AND `.length)
    .split(" AND ")
    .map((part): ((line: Line) => boolean) => {
      const eq = /^JSONExtractString\(raw, '([A-Za-z]+)'\) = '([^']*)'$/.exec(part);
      if (eq !== null) return (line) => extract(line, eq[1] ?? "") === eq[2];
      const has = /^JSONHas\(raw, '([A-Za-z]+)'\)$/.exec(part);
      if (has !== null) return (line) => Object.hasOwn(line, has[1] ?? "");
      throw new Error(`a condition this test cannot read: ${part}`);
    });
  const counts: Record<string, number> = {};
  for (const line of lines) {
    if (!tests.every((test) => test(line))) continue;
    const label = extract(line, seriesField);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

describe("the identity fragment's sign-in and step-up rates", () => {
  it("load from the staging files", () => {
    expect(findings).toEqual([]);
  });

  for (const want of RULES) {
    describe(want.name, () => {
      it("is a staging rule in alerts/identity.json with the plan's severity and condition", () => {
        const alert = rule(want.name);
        expect(alert, `${want.name} is no staging rule`).toBeDefined();
        expect(alert).toMatchObject({
          file: FILE,
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
        expect(alert?.sources).toEqual(want.sources);
        expect(alert?.seriesBy).toEqual(want.seriesBy);
        expect(alert?.query).toEqual(want.query);
        expect(alert?.window).toBeUndefined();
        expect(alert === undefined ? "" : renderSql(alert)).toBe(want.sql);
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

      it("has a runbook with Phase 0's headings that names it, its line and its threshold", () => {
        const path = join(ROOT, want.runbook);
        expect(existsSync(path), `${want.runbook} does not exist`).toBe(true);
        const text = readFileSync(path, "utf8");
        expect(text).toContain(`\`${want.name}\``);
        expect(text).toContain(`\`${want.event}\``);
        expect(text).toContain(want.threshold);
        const lines = text.split("\n").map((l) => l.trim());
        for (const heading of RUNBOOK_HEADINGS) expect(lines, heading).toContain(heading);
      });
    });
  }

  it("sign-in-code-contested: the catalogue groups every alert on the line by userId", () => {
    expect(entry("auth.code_contested")?.seriesBy).toEqual(["userId"]);
    expect(entry("auth.code_contested")?.fields).toMatchObject({ userId: "string" });
  });

  it("sign-in-code-contested: counts one account's contests, never contests for addresses with no account", () => {
    const alert = rule("sign-in-code-contested");
    if (alert === undefined) throw new Error("sign-in-code-contested is no staging rule");
    // Six people signing up, each asking for a code again on an address with no account (no
    // userId, as codes.ts writes it), and a stranger contesting one account three times.
    const contest = (reason: string, userId?: string) => ({
      event: "auth.code_contested",
      level: "warn",
      service: "console",
      reason,
      ...(userId === undefined ? {} : { userId }),
    });
    const lines = [
      ...Array.from({ length: 6 }, () => contest("unknown_share_used")),
      contest("supersede_refused", "usr_contested"),
      contest("unknown_share_used", "usr_contested"),
      contest("unknown_share_used", "usr_contested"),
    ];
    const sql = renderSql(alert);
    expect(seriesCounts(sql, lines)).toEqual({ usr_contested: 3 });
    // The same lines without the rule's userId condition: every no-account contest would share one
    // empty series, held to the threshold meant for one account.
    const unfiltered = sql.replace(" AND JSONHas(raw, 'userId')", "");
    expect(unfiltered).not.toBe(sql);
    expect(seriesCounts(unfiltered, lines)).toEqual({ "": 6, usr_contested: 3 });
  });

  it("are written by the code the catalogue names, on the services their rules read", () => {
    // auth.code_contested: the developer realm's code requests, with the account's userId.
    const codes = read("packages", "identity", "src", "codes.ts");
    expect(codes).toContain('deps.lines.write("auth.code_contested"');
    expect(codes).toMatch(/\{\s*userId\s*\}/);
    // Asked only by the developer realm's code send and the console's sign-up: the staff realm's
    // code send never runs the contest rule.
    const before = read("packages", "identity", "src", "hooks", "before.ts");
    const staffSend = before.slice(before.indexOf("async function staffCodeSend("));
    expect(staffSend.slice(0, staffSend.indexOf("\n}\n"))).not.toMatch(/requestCode/);
    expect(before).toMatch(/async function developerCodeSend\([\s\S]*?await requestCode\(/);
    expect(read("packages", "identity", "src", "sign-up.ts")).toMatch(/\brequestCodeless\b/);
    // step_up.locked: the step-up counter, both realms.
    expect(read("packages", "identity", "src", "hooks", "shared.ts")).toContain(
      'rt.lines.write("step_up.locked", "warn", { realm: state.realm })',
    );
    // Both deployables run a realm whose lines are the process's own.
    expect(read("apps", "console", "src", "server", "main.ts")).toMatch(
      /createRealm\(\{ settings, db, clock, lines,/,
    );
    expect(read("apps", "admin", "src", "server", "main.ts")).toMatch(
      /createRealm\(\{\s*settings,\s*db: database\.db,\s*clock,\s*lines,/,
    );
  });
});

/**
 * The identity fragment's rates that stay owed while what they read is written by no process: each
 * 5xx condition reads the auth path (spec 02 §18.1's authPath), and the host's one request line
 * does not carry it. A rule over the missing field never fires (eq) or fires on every line (notEq).
 */
describe("the identity fragment's owed rates", () => {
  const owed = (name: string) => OWED_ALERTS.find((a) => a.name === name);

  it("stay owed, in the identity fragment, with the reason in their note", () => {
    for (const [name, severity] of [
      ["sign-in-failing", "P"],
      ["second-factor-step-failing", "P"],
      ["step-up-failing", "N"],
    ] as const) {
      expect(rule(name), `${name} is a staging rule`).toBeUndefined();
      expect(owed(name), name).toMatchObject({ fragment: "identity", lane: "L-SAT-09", severity });
      expect(owed(name)?.note, name).toMatch(/the host's request line carries no authPath/);
      expect(entry("request")?.owed, name).toContain(name);
    }
    expect(owed("step-up-failing")?.note).toMatch(/stepUp, which packages\/server's RequestFields/);
  });

  it("no host's request line carries the auth path yet", () => {
    // The host's one request line: packages/server's fields, and what each realm's hook copies.
    expect(read("packages", "server", "src", "telemetry", "lines.ts")).not.toMatch(/\bauthPath\b/);
    expect(read("packages", "server", "src", "http", "request.ts")).not.toMatch(/\bauthPath\b/);
    expect(read("apps", "console", "src", "server", "routes.ts")).not.toMatch(/\bauthPath\b/);
    expect(read("apps", "admin", "src", "server", "auth-hook.ts")).not.toMatch(/\bauthPath\b/);
    expect(entry("request")?.fields).not.toHaveProperty("authPath");
    // The realm writes its own request line only when the host gives it no annotate hook, and
    // both hosts give one.
    expect(read("packages", "identity", "src", "realm.ts")).toContain(
      "if (state.context.annotate !== undefined) state.context.annotate(fields);",
    );
    expect(read("apps", "console", "src", "server", "routes.ts")).toMatch(/\bannotate: \(fields\)/);
    expect(read("apps", "admin", "src", "server", "auth-hook.ts")).toMatch(
      /\bannotate: \(fields\)/,
    );
  });

  it("step-up-failing: nothing sets the request line's stepUp yet", () => {
    // A request line's fields come from the context's variables (packages/server's request unit
    // copies the ones it knows); no code sets stepUp there, and the unit copies none.
    const setters = readCode(ROOT)
      .filter(({ text }) => /\.set\(\s*["']stepUp["']/.test(text))
      .map(({ file }) => file);
    expect(setters).toEqual([]);
    expect(read("packages", "server", "src", "http", "request.ts")).not.toMatch(/\bstepUp\b/);
  });
});
