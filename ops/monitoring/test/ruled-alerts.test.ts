// The four alerts the steward's ruling of 22 Nov made rules at once: security-email-unsent and
// email-budget-reached (spec 08 §7.8 group G), auth-endpoint-unlisted and access-keys-unavailable
// (group C, spec 02 §18.2). Each is a staging rule in its area's fragment with the severity,
// condition and runbook the plan gives, routed to staging-quiet, over the event whose catalogue
// entry names it; none is owed any more.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS } from "../catalog/owed.ts";
import { RUNBOOK_HEADINGS } from "../src/check.ts";
import { type AlertDef, loadEnv } from "../src/config.ts";
import { renderSql } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

interface Ruled {
  readonly name: string;
  readonly event: string;
  readonly fragment: string;
  readonly group: string;
  readonly severity: "P" | "N";
  readonly threshold: string;
  readonly flow: string;
  readonly runbook: string;
  readonly sources: readonly string[];
}

const RULED: readonly Ruled[] = [
  {
    name: "security-email-unsent",
    event: "email.security_unsent",
    fragment: "email",
    group: "G",
    severity: "P",
    threshold: "@any",
    flow: "F10",
    runbook: "docs/runbooks/security-email-unsent.md",
    // The sender on worker, and identity's email.enqueue() where the realms run.
    sources: ["worker", "console", "admin"],
  },
  {
    name: "email-budget-reached",
    event: "email.budget_reached",
    fragment: "email",
    group: "G",
    severity: "N",
    threshold: "@any",
    flow: "F10",
    runbook: "docs/runbooks/email.md",
    sources: ["worker"],
  },
  {
    name: "auth-endpoint-unlisted",
    event: "auth.endpoint_blocked",
    fragment: "identity",
    group: "C",
    severity: "N",
    threshold: "@thresholds.auth-endpoint-unlisted",
    flow: "F3",
    runbook: "docs/runbooks/auth-endpoint-unlisted.md",
    sources: ["console", "admin", "verify"],
  },
  {
    name: "access-keys-unavailable",
    event: "access.keys_unavailable",
    fragment: "staff",
    group: "C",
    severity: "P",
    threshold: "@any",
    flow: "F6",
    runbook: "docs/runbooks/access-keys-unavailable.md",
    sources: ["admin"],
  },
];

const { config, findings } = loadEnv(ROOT, "staging");
const rule = (name: string): AlertDef | undefined => config?.alerts.find((a) => a.name === name);
const entry = (event: string) =>
  Object.values(fragments)
    .flat()
    .find((e) => e.event === event);

describe("the alerts the steward ruled real failure modes", () => {
  it("load from the staging files", () => {
    expect(findings).toEqual([]);
  });

  for (const want of RULED) {
    describe(want.name, () => {
      it(`is a staging rule in alerts/${want.fragment}.json with the plan's severity and condition`, () => {
        const alert = rule(want.name);
        expect(alert, `${want.name} is no staging rule`).toBeDefined();
        expect(alert).toMatchObject({
          file: `ops/monitoring/staging/alerts/${want.fragment}.json`,
          group: want.group,
          severity: want.severity,
          operator: "higher_than",
          threshold: want.threshold,
          on_missing_data: "dont_fire",
          policy: "staging-quiet",
          metadata: { flow: want.flow, runbook: want.runbook },
        });
        expect(alert?.sources).toEqual(want.sources);
        expect(alert?.query).toMatchObject({ count: { events: [want.event] } });
        for (const key of ["call", "sms", "push", "critical_alert"] as const) {
          expect(alert?.[key], key).toBeUndefined();
        }
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
        const lines = text.split("\n").map((l) => l.trim());
        for (const heading of RUNBOOK_HEADINGS) expect(lines, heading).toContain(heading);
      });
    });
  }

  it("count every unlisted auth path, and a line without its class, but no blocked one", () => {
    const alert = rule("auth-endpoint-unlisted");
    expect(alert?.query).toEqual({
      count: {
        events: ["auth.endpoint_blocked"],
        where: [{ field: "class", notEq: "blocked" }],
      },
    });
    const sql = alert === undefined ? "" : renderSql(alert);
    expect(sql).toContain("NOT (JSONExtractString(raw, 'class') = 'blocked')");
    expect(sql).toContain("JSONExtractString(raw, 'service') AS series");
  });

  it("open one incident per reason, and per budget scope and share", () => {
    expect(rule("security-email-unsent")?.seriesBy).toBe("reason");
    expect(rule("email-budget-reached")?.seriesBy).toEqual(["scope", "share"]);
    expect(rule("access-keys-unavailable")?.seriesBy).toBeUndefined();
    const budget = rule("email-budget-reached");
    expect(budget === undefined ? "" : renderSql(budget)).toContain(
      "concat(JSONExtractString(raw, 'scope'), '/', JSONExtractString(raw, 'share')) AS series",
    );
  });
});
