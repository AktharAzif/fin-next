// MC-15: every alert name a package (packages/*/src/monitoring.ts's line lists, and comments that
// call a name an alert) or the catalogue gives is a rule in ops/monitoring/<env>/alerts or is owed
// in catalog/owed.ts with a lane and a date (the steward's ruling of 22 Nov, option (b)); any other
// name fails. The code is read as text: ops/monitoring imports no other package.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { OWED_ALERTS, type OwedAlert } from "../catalog/owed.ts";
import type { CatalogEntry } from "../catalog/types.ts";
import { alertsInCode, type CheckOptions, checkMonitoring } from "../src/check.ts";
import { loadEnv } from "../src/config.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * The ruling's fifteen, less those that have become rules (admin-access-mismatch,
 * admin-staff-refused, staff-enrolled and staff-enrolment-refused, in alerts/staff.json and
 * staff-alerts.test.ts): the alerts the code names that no fragment defines yet, due Sunday.
 */
const RULED: readonly string[] = [
  "admin-without-second-factor",
  "audit-guard",
  "csrf-refused-jump",
  "rate-limiter-failing",
  "second-factor-step-failing",
  "secret-unreadable",
  "sign-in-code-contested",
  "sign-in-failing",
  "step-up-failing",
  "step-up-locked",
  "duty-stalled-access-drift",
];

/**
 * The later ruling of 22 Nov: five more alerts the catalogue owes, each with its lane and date,
 * less staff-changed, a rule now (alerts/staff.json).
 */
const RULED_LATER: Readonly<Record<string, { lane: string; due: string }>> = {
  "admin-access-drift": { lane: "L-SAT-09", due: "2026-11-22" },
  "review-refusals": { lane: "P0-C", due: "2026-11-22" },
  "review-model-mismatch": { lane: "P0-C", due: "2026-11-22" },
  "money-switch-tripped": { lane: "L-MON-09", due: "2026-11-23" },
};

/**
 * Owed by the lane rule in owed.ts's header and not yet ruled by name: the steward confirms or
 * changes each. A new name here is a visible change to this test in the same pull request.
 */
const BY_LANE_RULE: Readonly<Record<string, { lane: string; due: string }>> = {
  "team-change-failing": { lane: "L-SAT-09", due: "2026-11-22" },
  // Its rule read clockSkewMs, which no process writes (alert-fields.test.ts).
  "clock-skew": { lane: "P0-F", due: "2026-11-22" },
};

/** A copy of the staging files, the watcher's settings and the runbooks, to plant one fault in. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "fin-monitoring-owed-"));
  roots.push(root);
  for (const dir of [
    ["ops", "monitoring", "staging"],
    ["ops", "watcher", "settings"],
    ["docs", "runbooks"],
  ]) {
    cpSync(join(ROOT, ...dir), join(root, ...dir), { recursive: true });
  }
  return root;
}

function plant(root: string, file: string, lines: readonly string[]): void {
  const path = join(root, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.join("\n"));
}

function mc15(root: string, options: CheckOptions = {}): string[] {
  return checkMonitoring(root, { scan: [], ...options })
    .filter((f) => f.rule === "MC-15")
    .map((f) => `${f.file}: ${f.message}`);
}

const staging = (() => {
  const { config } = loadEnv(ROOT, "staging");
  return new Set((config?.alerts ?? []).flatMap((a) => [a.name, a.template]));
})();
const owedByName = new Map(OWED_ALERTS.map((a) => [a.name, a]));

describe("the alert names on the repository", () => {
  const inCode = alertsInCode(ROOT);
  const inCatalogue = Object.values(fragments).flatMap((entries) =>
    entries.flatMap((e) => [...e.alerts, ...(e.owed ?? [])]),
  );

  it("are read from identity's line list, every name it gives", () => {
    for (const name of RULED.filter((n) => n !== "duty-stalled-access-drift")) {
      expect(inCode.get(name)?.file, name).toBe("packages/identity/src/monitoring.ts");
    }
    expect(inCode.has("audit-not-written")).toBe(true);
  });

  it("are each a staging rule, or owed with a lane and a due date", () => {
    const names = new Set([...inCode.keys(), ...inCatalogue]);
    expect(names.size).toBeGreaterThan(20);
    for (const name of names) {
      if (staging.has(name)) continue;
      const owed = owedByName.get(name);
      expect(owed, `${name} is no staging rule and is not owed`).toBeDefined();
      expect(owed?.lane, name).toMatch(/^(?:P0-[A-Z]|L-[A-Z]{3}-\d{2})$/);
      expect(owed?.due, name).toMatch(/^2026-11-\d{2}$/);
    }
    expect(mc15(ROOT)).toEqual([]);
  });

  it("owe the ruling's fifteen, each with its lane, due Sunday 22 Nov 2026", () => {
    for (const name of RULED) {
      expect(staging.has(name), `${name} is a staging rule now`).toBe(false);
      expect(owedByName.get(name), name).toMatchObject({ due: "2026-11-22" });
      expect(owedByName.get(name)?.lane, name).toMatch(/^(?:P0-F|L-SAT-09)$/);
    }
    // Decided by the plan's order (spec 02 §10.9): a success alert and no heartbeat.
    expect(owedByName.get("duty-stalled-access-drift")).toMatchObject({ fragment: "staff" });
    expect(owedByName.get("duty-stalled-access-drift")?.heartbeat).toBeUndefined();
    const heartbeats = readFileSync(
      join(ROOT, "ops", "monitoring", "staging", "heartbeats.json"),
      "utf8",
    );
    expect(heartbeats).not.toContain("access-drift");
  });

  it("owe exactly the ruled names and those the lane rule gives, so a new one changes this test", () => {
    const want = [...RULED, ...Object.keys(RULED_LATER), ...Object.keys(BY_LANE_RULE)].sort();
    expect(OWED_ALERTS.map((a) => a.name).sort()).toEqual(want);
    for (const [name, ruled] of Object.entries({ ...RULED_LATER, ...BY_LANE_RULE })) {
      expect(owedByName.get(name), name).toMatchObject(ruled);
    }
  });

  it("carry the later ruling's note, the decided question, and the production precondition", () => {
    expect(owedByName.get("admin-access-drift")?.note).toMatch(
      /writes access\.drift .* but no process runs the duty yet/,
    );
    const question = owedByName.get("duty-stalled-access-drift")?.note ?? "";
    expect(question).toMatch(/decided/);
    expect(question).toMatch(/spec 02 §10\.9/);
    expect(question).toMatch(/pings no heartbeat but has a success alert/);
    expect(question).toMatch(/no heartbeat/);
    const header = readFileSync(join(ROOT, "ops", "monitoring", "catalog", "owed.ts"), "utf8");
    expect(header).toMatch(/HARD PRODUCTION PRECONDITION/);
    expect(header).toMatch(/fails closed when it cannot read it/);
    expect(header).toMatch(/refuses the deploy while any entry here exists/);
  });

  it("owe nothing a staging fragment already defines, and list each owed alert once", () => {
    expect(OWED_ALERTS.filter((a) => staging.has(a.name))).toEqual([]);
    expect(owedByName.size).toBe(OWED_ALERTS.length);
  });

  it("give every catalogue entry that owes an alert the owed list's entry for it", () => {
    for (const entry of Object.values(fragments).flat()) {
      for (const name of entry.owed ?? []) expect(owedByName.has(name), entry.event).toBe(true);
    }
  });
});

describe("MC-15 refuses", () => {
  it("an alert a package names that is no rule and is not owed, in each way code names one", () => {
    const root = scratch();
    plant(root, "packages/edge/src/monitoring.ts", [
      "export interface LineSpec {",
      "  readonly alerts: readonly string[] | { readonly none: string };",
      "}",
      "export const EDGE_LINES = {",
      '  "edge.a": { kind: "failure", alerts: ["edge-surprise", "process-crash"] },',
      '  "edge.b": { kind: "info", alerts: { none: "not-an-alert, a reason" } },',
      '  "edge.c": { kind: "failure", alerts: [{ name: "nested-name" }, "sign-in-failing"] },',
      '  "edge.d": { kind: "failure", alerts: "edge-single" },',
      "};",
    ]);
    plant(root, "apps/edge/src/duty.ts", [
      "/**",
      " * One run of the duty; its `job.run` line and its success alert (`duty-stalled-edge`)",
      " * report a run that throws. The `edge-prose` alert pages; `edge-watches` watches it.",
      " */",
      "// Each duty has its `duty-stalled-<duty>` alert, whose runbook is below.",
      "export const runbook = 'docs/runbooks/duty-stalled.md';",
    ]);
    plant(root, "packages/edge/src/a.test.ts", ['const x = { alerts: ["in-a-test"] };']);
    const tail =
      "which is no staging rule and is not listed in catalog/owed.ts with a lane and a date";
    expect(mc15(root, { scanCode: true })).toEqual([
      `apps/edge/src/duty.ts:2: names the alert duty-stalled-edge, ${tail}`,
      `apps/edge/src/duty.ts:3: names the alert edge-prose, ${tail}`,
      `packages/edge/src/monitoring.ts:5: names the alert edge-surprise, ${tail}`,
      `packages/edge/src/monitoring.ts:8: names the alert edge-single, ${tail}`,
    ]);
  });

  it("an alert a catalogue entry owes, or a noAlert names by its severity, that is not owed", () => {
    const root = scratch();
    const extra: CatalogEntry = {
      event: "thing.failed",
      kind: "failure",
      level: "error",
      fields: {},
      alerts: [],
      owed: ["thing-failing", "sign-in-failing"],
      writtenBy: "test",
    };
    const other: CatalogEntry = {
      ...extra,
      event: "thing.refused",
      owed: [],
      noAlert: "thing-refused (P, spec 99 §1) is owed by a fragment; process-crash covers a crash",
    };
    const platform = [...(fragments.platform ?? []), extra, other];
    const tail =
      "which is no staging rule and is not listed in catalog/owed.ts with a lane and a date";
    expect(mc15(root, { fragments: { ...fragments, platform }, scanCode: false })).toEqual([
      `ops/monitoring/catalog/platform.ts: thing.failed owes the alert thing-failing, ${tail}`,
      `ops/monitoring/catalog/platform.ts: thing.refused's noAlert names the alert thing-refused, ${tail}`,
    ]);
  });

  it("an alert a noAlert names in any words, but not a file name, a path or an event", () => {
    const root = scratch();
    const base: CatalogEntry = {
      event: "thing.watched",
      kind: "security",
      level: "warn",
      fields: {},
      alerts: [],
      writtenBy: "test",
    };
    const platform = [
      ...(fragments.platform ?? []),
      {
        ...base,
        noAlert:
          "Watched by the `thing-failing` alert's sibling: thing-refused-jump, which its lane adds",
      },
      {
        ...base,
        event: "thing.paged",
        noAlert: "thing-refused (page) is owed by the area's fragment",
      },
      {
        ...base,
        event: "thing.covered",
        noAlert:
          "process-crash and no-logs-{service} cover it; see docs/runbooks/process-crash.md, telemetry.ship_failed and @thresholds.auth-endpoint-unlisted",
      },
    ];
    const tail =
      "which is no staging rule and is not listed in catalog/owed.ts with a lane and a date";
    expect(mc15(root, { fragments: { ...fragments, platform }, scanCode: false })).toEqual([
      `ops/monitoring/catalog/platform.ts: thing.watched's noAlert names the alert thing-failing, ${tail}`,
      `ops/monitoring/catalog/platform.ts: thing.watched's noAlert names the alert thing-refused-jump, ${tail}`,
      `ops/monitoring/catalog/platform.ts: thing.paged's noAlert names the alert thing-refused, ${tail}`,
    ]);
  });

  it("an alert a fragment file's own text names, in the specs' form or as code names one", () => {
    const root = scratch();
    plant(root, "ops/monitoring/catalog/thing.ts", [
      "// The thing area's lines. thing-change-failing (N, spec 99 §1) reads the request lines,",
      "// and the `thing-stalled` alert comes with the area's fragment; sign-in and step-up are",
      "// words, and process-crash (P) is a rule.",
      "export const entries = [];",
    ]);
    const tail =
      "which is no staging rule and is not listed in catalog/owed.ts with a lane and a date";
    expect(mc15(root, { fragments: { ...fragments, thing: [] }, scanCode: false })).toEqual([
      `ops/monitoring/catalog/thing.ts:2: names the alert thing-stalled, ${tail}`,
      `ops/monitoring/catalog/thing.ts:1: names the alert thing-change-failing, ${tail}`,
    ]);
  });

  it("an owed alert with no lane, no due date or no fragment, listed twice, or a rule already", () => {
    const root = scratch();
    const good = OWED_ALERTS[0] as OwedAlert;
    const owed: OwedAlert[] = [
      ...OWED_ALERTS,
      { ...good, name: "no-lane", lane: "" },
      { ...good, name: "bad-date", due: "2026-11-31" },
      { ...good, name: "no-fragment", fragment: "alerts/x.json" },
      { ...good },
      { ...good, name: "process-crash" },
    ];
    expect(mc15(root, { owed, scanCode: false })).toEqual([
      "ops/monitoring/catalog/owed.ts: no-lane: names no lane (a lane of EXECUTION's tables, such as L-SAT-09)",
      "ops/monitoring/catalog/owed.ts: bad-date: has no due date (YYYY-MM-DD)",
      "ops/monitoring/catalog/owed.ts: no-fragment: names no fragment (ops/monitoring/<env>/alerts/<fragment>.json)",
      `ops/monitoring/catalog/owed.ts: ${good.name}: is listed twice`,
      "ops/monitoring/catalog/owed.ts: process-crash is a staging rule now: name it in its catalogue entries' alerts and drop it from the owed list",
    ]);
  });

  it("a catalogue entry that still owes an alert a fragment now defines", () => {
    const root = scratch();
    const platform = (fragments.platform ?? []).map((e) =>
      e.event === "csp.report" ? { ...e, owed: ["csp-reports"] } : e,
    );
    expect(mc15(root, { fragments: { ...fragments, platform }, scanCode: false })).toEqual([
      "ops/monitoring/catalog/platform.ts: csp.report owes csp-reports, which is a staging rule now: name it in alerts",
    ]);
  });

  it("nothing else: an entry whose only cover is an owed alert passes MC-02", () => {
    const root = scratch();
    const extra: CatalogEntry = {
      event: "thing.failed",
      kind: "security",
      level: "warn",
      fields: {},
      alerts: [],
      owed: ["sign-in-failing"],
      writtenBy: "test",
    };
    const platform = [...(fragments.platform ?? []), extra];
    expect(
      checkMonitoring(root, { fragments: { ...fragments, platform }, scan: [], scanCode: false }),
    ).toEqual([]);
  });
});
