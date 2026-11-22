// The identity fragment's alerts (spec 02 §18.2; spec 08 §7.8 group C), L-SAT-09's:
// secret-unreadable, rate-limiter-failing and csrf-refused-jump. Each is a staging rule in
// alerts/identity.json with the plan's severity and condition, over the line its catalogue entry
// names, from the services whose code writes that line, one incident per service with the label
// held to those sources, routed to staging-quiet only, with a runbook of Phase 0's headings that
// names it; none is owed any more. auth-endpoint-unlisted, the fragment's first rule, is pinned in
// ruled-alerts.test.ts. The writers are read as text: ops/monitoring imports no other package.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS } from "../src/check.ts";
import { type AlertDef, loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FILE = "ops/monitoring/staging/alerts/identity.json";

interface IdentityRule {
  readonly name: string;
  readonly event: string;
  readonly severity: "P" | "N";
  readonly threshold: string;
  readonly queryPeriod: number;
  readonly recoveryPeriod: number;
  readonly sources: readonly string[];
  readonly runbook: string;
  /** Words the incident cause and the check must carry: the plan's first check. */
  readonly check: RegExp;
}

const RULES: readonly IdentityRule[] = [
  {
    // Any line: the people a secret belongs to cannot finish a factor step.
    name: "secret-unreadable",
    event: "auth.secret_unreadable",
    severity: "P",
    threshold: "@any",
    queryPeriod: 300,
    recoveryPeriod: 900,
    // identity's authenticator check runs in both realms; console's viewer reads backup codes.
    sources: ["console", "admin"],
    runbook: "docs/runbooks/secret-unreadable.md",
    check: /BETTER_AUTH_SECRETS/,
  },
  {
    // Any line: the limiter fails closed, so sign-ins are refused.
    name: "rate-limiter-failing",
    event: "limits.store_failed",
    severity: "P",
    threshold: "@any",
    queryPeriod: 300,
    recoveryPeriod: 600,
    // identity's limiter, in the realms on console and admin (spec 05's joins with the keys lane).
    sources: ["console", "admin"],
    runbook: "docs/runbooks/rate-limiter-failing.md",
    check: /Postgres/,
  },
  {
    // Above the pre-deploy baseline, the overlay's value (OB-13), in 15 minutes.
    name: "csrf-refused-jump",
    event: "csrf.refused",
    severity: "N",
    threshold: "@thresholds.csrf-refused-jump",
    queryPeriod: 900,
    recoveryPeriod: 900,
    // The origin gate on every app's API half.
    sources: ["console", "admin", "verify"],
    runbook: "docs/runbooks/csrf-refused-jump.md",
    check: /FIN_PUBLIC_ORIGIN[\s\S]*X-Fin-App/,
  },
];

const { config, findings } = loadEnv(ROOT, "staging");
const rule = (name: string): AlertDef | undefined => config?.alerts.find((a) => a.name === name);
const entry = (event: string) =>
  Object.values(fragments)
    .flat()
    .find((e) => e.event === event);
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");

describe("the identity fragment's alerts", () => {
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
          metadata: { flow: "F3", runbook: want.runbook },
        });
        expect(alert?.query).toEqual({ count: { events: [want.event] } });
        expect(alert?.window).toBeUndefined();
      });

      it("reads the services that write its line, one incident each, the label held to them", () => {
        const alert = rule(want.name);
        expect(alert?.sources).toEqual(want.sources);
        expect(alert?.seriesBy).toEqual([{ field: "service", oneOf: want.sources }]);
        const labels = want.sources.map((s) => `'${s}'`).join(", ");
        expect(alert === undefined ? "" : renderSql(alert)).toBe(
          `SELECT {{time}} AS time, if(JSONExtractString(raw, 'service') IN (${labels}), JSONExtractString(raw, 'service'), 'other') AS series, count(*) AS value FROM {{source}} WHERE time BETWEEN {{start_time}} AND {{end_time}} AND JSONExtractString(raw, 'event') = '${want.event}' GROUP BY time, series`,
        );
      });

      it("routes to staging-quiet only, and asks for no call, text, push or critical alert", () => {
        const alert = rule(want.name);
        expect(alert?.policy).toBe("staging-quiet");
        for (const key of ["call", "sms", "push", "critical_alert"] as const) {
          expect(alert?.[key], key).toBeUndefined();
        }
        expect(alert?.incident_cause ?? "").not.toBe("");
        expect(alert?.metadata?.check ?? "").toMatch(want.check);
      });

      it("is named by its event's catalogue entry and by identity's line list, and owed no more", () => {
        expect(entry(want.event)?.alerts).toEqual([want.name]);
        expect(entry(want.event)?.owed ?? []).toEqual([]);
        expect(OWED_ALERTS.map((a) => a.name)).not.toContain(want.name);
        expect(read("packages", "identity", "src", "monitoring.ts")).toContain(
          `"${want.event}": { kind: `,
        );
        expect(read("packages", "identity", "src", "monitoring.ts")).toContain(
          `alerts: ["${want.name}"] }`,
        );
      });

      it("has a runbook with Phase 0's headings that names it and its line", () => {
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

  it("are written by the code each catalogue entry names, on the services each rule reads", () => {
    // Each event, a file that writes it, and the text of the write: a writer that stops writing
    // the event, or renames a field the runbook reads, fails here.
    const writers: readonly [event: string, file: string, write: string][] = [
      [
        "auth.secret_unreadable",
        "packages/identity/src/hooks/before.ts",
        'lines.write("auth.secret_unreadable", "error", { realm, kind: "totp" })',
      ],
      [
        "auth.secret_unreadable",
        "apps/console/src/server/viewer.ts",
        'lines.write("auth.secret_unreadable", "error", {',
      ],
      [
        "limits.store_failed",
        "packages/identity/src/limits.ts",
        'lines.write("limits.store_failed", "error", { bucket })',
      ],
      [
        "csrf.refused",
        "packages/web-host/src/origin-gate.ts",
        'telemetry.log("csrf.refused", { reason: code, route }, "warn")',
      ],
      ["csrf.refused", "packages/identity/src/realm.ts", 'lines.write("csrf.refused", "warn", {'],
    ];
    for (const [event, file, write] of writers) {
      expect(read(file), `${file} writes ${event}`).toContain(write);
    }
    expect(entry("auth.secret_unreadable")?.fields).toEqual({ realm: "string", kind: "string" });
    expect(entry("limits.store_failed")?.fields).toEqual({ bucket: "string" });
    expect(entry("csrf.refused")?.fields).toEqual({ reason: "string", route: "string" });
    // The realms run on console and admin, with identity's limiter (no other store is passed in).
    expect(read("packages", "identity", "src", "realm.ts")).toContain(
      "limits: deps.limits ?? createLimitStore({ clock: deps.clock, lines: deps.lines })",
    );
    expect(read("apps", "console", "src", "server", "main.ts")).toContain("createPgDatabase({");
    expect(read("apps", "admin", "src", "server", "database.mjs")).toContain("createPgDatabase({");
    // The origin gate is the API host's, which console builds and admin and verify build through
    // the web-host service.
    expect(read("packages", "web-host", "src", "api-host.ts")).toContain("originGate({");
    expect(read("apps", "console", "src", "server", "main.ts")).toContain("createApiHost({");
    expect(read("apps", "admin", "src", "server", "main.ts")).toContain("buildApiService");
    expect(read("apps", "verify", "src", "server", "main.ts")).toContain("defineApiService");
  });
});
