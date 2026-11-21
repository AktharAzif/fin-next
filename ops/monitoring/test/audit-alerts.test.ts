// The alerts identity's line list (packages/identity/src/monitoring.ts) names for audit.write_failed
// are staging rules over that event, as spec 08 §3.14 defines them, each with a runbook that exists
// and names it back, and the catalogue's entry names the same alerts. The list is read as text:
// ops/monitoring imports no other package.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { loadEnv } from "../src/config.ts";
import { queryEvents } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const IDENTITY_LINES = join(ROOT, "packages", "identity", "src", "monitoring.ts");
const EVENT = "audit.write_failed";

/** The alert names identity's list gives an event: its `alerts: [...]`, or none for a reason. */
function identityAlerts(event: string): string[] {
  const text = readFileSync(IDENTITY_LINES, "utf8");
  const key = `"${event}":`;
  const start = text.indexOf(key);
  if (start === -1) throw new Error(`${event} is not in identity's line list`);
  const entry = text.slice(start + key.length, text.indexOf("}", start));
  const list = /alerts:\s*\[([^\]]*)\]/.exec(entry);
  return [...(list?.[1] ?? "").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1] ?? "");
}

describe(`the alerts identity names for ${EVENT}`, () => {
  const names = identityAlerts(EVENT);
  const { config, findings } = loadEnv(ROOT, "staging");

  it("are read from identity's list, audit-not-written among them", () => {
    expect(names).toContain("audit-not-written");
  });

  it("exist as staging rules that watch the event, with a runbook that names them", () => {
    expect(findings).toEqual([]);
    for (const name of names) {
      const rule = config?.alerts.find((a) => a.name === name);
      expect(rule, `${name} is no rule in ops/monitoring/staging/alerts`).toBeDefined();
      if (rule === undefined) continue;
      expect(queryEvents(rule.query), name).toEqual([EVENT]);
      const runbook = rule.metadata?.runbook ?? "";
      expect(runbook, name).toMatch(/^docs\/runbooks\/[a-z0-9-]+\.md$/);
      expect(existsSync(join(ROOT, runbook)), `${name}: ${runbook} does not exist`).toBe(true);
      expect(readFileSync(join(ROOT, runbook), "utf8"), runbook).toContain(`\`${name}\``);
    }
  });

  it("are the alerts the catalogue's entry names", () => {
    const entry = Object.values(fragments)
      .flat()
      .find((e) => e.event === EVENT);
    expect(entry?.alerts).toEqual(names);
  });

  it("page on any refusal, as spec 08 §3.14's audit-not-written does", () => {
    const rule = config?.alerts.find((a) => a.name === "audit-not-written");
    expect(rule).toMatchObject({
      group: "D",
      severity: "P",
      operator: "higher_than",
      threshold: "@any",
      policy: "staging-quiet",
      metadata: { runbook: "docs/runbooks/audit-not-written.md" },
    });
    expect(rule?.query).toEqual({ count: { events: [EVENT] } });
  });
});
