// The organisations fragment's alert (spec 02 §18.2; spec 08 §7.8 group C), L-SAT-09's:
// team-change-failing is a staging rule in alerts/orgs.json, any 5xx on the console's team and role
// routes (spec 02 §14.2), over the request line, from console, routed to staging-quiet only, with a
// runbook of Phase 0's headings that names it; it is owed no more. Its routes are exactly the
// console route policy's /team and /roles entries, read as text (ops/monitoring imports no other
// package), so a team or role route added to the policy fails here until the rule lists it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS } from "../src/check.ts";
import { type AlertDef, loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const NAME = "team-change-failing";
const RUNBOOK = "docs/runbooks/team-change-failing.md";

/** The route templates of the request line for spec 02 §14.2's team and role routes. */
const ROUTES: readonly string[] = [
  "/api/team",
  "/api/team/members/:memberId",
  "/api/team/members/:memberId/credentials",
  "/api/team/members/:memberId/remove",
  "/api/team/invitations",
  "/api/team/invitations/:invitationId",
  "/api/team/invitations/:invitationId/resend",
  "/api/roles",
  "/api/roles/:roleKey",
  "/api/roles/:roleId",
  "/api/roles/:roleId/delete",
];

const { config, findings } = loadEnv(ROOT, "staging");
const rule = (name: string): AlertDef | undefined => config?.alerts.find((a) => a.name === name);
const request = Object.values(fragments)
  .flat()
  .find((e) => e.event === "request");
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");

describe("the organisations fragment's alert", () => {
  it("loads from the staging files", () => {
    expect(findings).toEqual([]);
  });

  it("team-change-failing is a staging rule in alerts/orgs.json: any 5xx on the team and role routes, on console", () => {
    const alert = rule(NAME);
    expect(alert, `${NAME} is no staging rule`).toBeDefined();
    expect(alert).toMatchObject({
      file: "ops/monitoring/staging/alerts/orgs.json",
      group: "C",
      severity: "N",
      operator: "higher_than",
      // The plan names no threshold: 5xx on the routes, any of them.
      threshold: "@any",
      check_period: 60,
      query_period: 300,
      confirmation_period: 0,
      recovery_period: 900,
      on_missing_data: "dont_fire",
      metadata: { flow: "F4", runbook: RUNBOOK },
    });
    expect(alert?.sources).toEqual(["console"]);
    // One source and no seriesBy: one series, so no field of the line becomes a label.
    expect(alert?.seriesBy).toBeUndefined();
    expect(alert?.window).toBeUndefined();
    expect(alert?.query).toEqual({
      count: {
        events: ["request"],
        where: [
          { field: "statusClass", eq: "5xx" },
          { field: "route", in: ROUTES },
        ],
      },
    });
    const routes = ROUTES.map((r) => `'${r}'`).join(", ");
    expect(alert === undefined ? "" : renderSql(alert)).toBe(
      `SELECT {{time}} AS time, count(*) AS value FROM {{source}} WHERE time BETWEEN {{start_time}} AND {{end_time}} AND JSONExtractString(raw, 'event') = 'request' AND JSONExtractString(raw, 'statusClass') = '5xx' AND JSONExtractString(raw, 'route') IN (${routes}) GROUP BY time`,
    );
  });

  it("routes to staging-quiet only, and asks for no call, text, push or critical alert", () => {
    const alert = rule(NAME);
    expect(alert?.policy).toBe("staging-quiet");
    for (const key of ["call", "sms", "push", "critical_alert"] as const) {
      expect(alert?.[key], key).toBeUndefined();
    }
    expect(alert?.incident_cause ?? "").not.toBe("");
    expect(alert?.metadata?.check ?? "").not.toBe("");
  });

  it("lists exactly the console route policy's team and role routes, with the host's /api", () => {
    const policy = read("apps", "console", "src", "server", "policy", "orgs.ts");
    const paths = [...policy.matchAll(/\bpath: "(\/(?:team|roles)(?:\/[^"]*)?)"/g)].map(
      (m) => `/api${m[1]}`,
    );
    expect(paths.length).toBeGreaterThan(10);
    expect([...new Set(paths)].sort()).toEqual([...ROUTES].sort());
    // The API host names a request by the pattern registered under its /api base path.
    const host = read("packages", "web-host", "src", "api-host.ts");
    expect(host).toContain('new Hono<FinEnv>().basePath("/api")');
    expect(host).toContain('if (names) c.set("route", registration.path);');
    expect(read("apps", "console", "src", "server", "routes.ts")).toContain(
      "api.on(policy.method, policy.path,",
    );
  });

  it("reads the fields packages/server's request unit writes", () => {
    const unit = read("packages", "server", "src", "http", "request.ts");
    expect(unit).toContain('options.telemetry.log(\n          "request",');
    expect(unit).toContain("route: routeTemplate(c),");
    expect(unit).toContain("statusClass: statusClass(status),");
    expect(request?.fields).toMatchObject({ route: "string", statusClass: "string" });
  });

  it("is named by the request entry and owed no more", () => {
    expect(request?.alerts).toContain(NAME);
    expect(request?.owed ?? []).not.toContain(NAME);
    expect(OWED_ALERTS.map((a) => a.name)).not.toContain(NAME);
  });

  it("has a runbook with Phase 0's headings that names it and its line", () => {
    const path = join(ROOT, RUNBOOK);
    expect(existsSync(path), `${RUNBOOK} does not exist`).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toContain(`\`${NAME}\``);
    expect(text).toContain("`request`");
    const lines = text.split("\n").map((l) => l.trim());
    for (const heading of RUNBOOK_HEADINGS) expect(lines, heading).toContain(heading);
  });
});
