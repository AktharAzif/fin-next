import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import type { CatalogEntry } from "../catalog/types.ts";
import { checkMonitoring, PHASE0_EVENTS } from "../src/check.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A copy of the staging files, the watcher's settings and the runbooks, to plant one fault in. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "fin-monitoring-check-"));
  roots.push(root);
  cpSync(join(ROOT, "ops", "monitoring", "staging"), join(root, "ops", "monitoring", "staging"), {
    recursive: true,
  });
  cpSync(join(ROOT, "ops", "watcher", "settings"), join(root, "ops", "watcher", "settings"), {
    recursive: true,
  });
  cpSync(join(ROOT, "docs", "runbooks"), join(root, "docs", "runbooks"), { recursive: true });
  return root;
}

function edit(root: string, file: string, change: (json: Record<string, unknown>) => void): void {
  const path = join(root, "ops", "monitoring", "staging", file);
  const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(json);
  writeFileSync(path, JSON.stringify(json));
}

type Json = Record<string, unknown>;
const alerts = (json: Json) => json.alerts as Json[];
const alert = (json: Json, name: string) => alerts(json).find((a) => a.name === name) as Json;

function rules(root: string, options: Parameters<typeof checkMonitoring>[1] = {}): string[] {
  return checkMonitoring(root, { scanCode: false, scan: [], ...options }).map(
    (f) => `${f.rule} ${f.message}`,
  );
}

describe("monitoring:check on the repository", () => {
  it("passes, in well under a second", () => {
    const started = performance.now();
    expect(checkMonitoring(ROOT)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("catalogues every event spec 01 §8.9 lists", () => {
    const events = new Set(Object.values(fragments).flatMap((f) => f.map((e) => e.event)));
    for (const event of PHASE0_EVENTS) expect(events.has(event), event).toBe(true);
  });

  it("passes on the scratch copy (the planted cases below start clean)", () => {
    expect(rules(scratch())).toEqual([]);
  });
});

describe("monitoring:check refuses", () => {
  it("an alert whose runbook does not exist (MC-08)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      (alert(j, "process-crash").metadata as Json).runbook = "docs/runbooks/missing.md";
    });
    expect(rules(root)).toContainEqual(
      "MC-08 process-crash: its runbook docs/runbooks/missing.md does not exist",
    );
  });

  it("an alert without incident_cause or a flow ID (MC-08)", () => {
    const root = scratch();
    edit(root, "alerts/email.json", (j) => {
      delete alert(j, "email-not-sent").incident_cause;
      (alert(j, "email-not-sent").metadata as Json).flow = "email";
    });
    const found = rules(root);
    expect(found).toContainEqual("MC-08 email-not-sent: has no incident_cause");
    expect(found).toContainEqual("MC-08 email-not-sent: metadata.flow email is not a flow ID");
  });

  it("a staging alert routed to a production policy or any other policy (MC-13, RT-01)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      alert(j, "process-crash").policy = "production-page";
      alert(j, "shutdown-forced").policy = "loud";
      delete alert(j, "dns-lookup-failing").policy;
    });
    const found = rules(root);
    expect(found).toContainEqual("MC-13 process-crash: routes to production-page");
    expect(found).toContainEqual("RT-01 shutdown-forced: routes to loud");
    expect(found).toContainEqual("RT-01 dns-lookup-failing: has no policy");
  });

  it("a staging object that calls, texts or pushes (RT-03)", () => {
    const root = scratch();
    edit(root, "monitors.json", (j) => {
      ((j.monitors as Json[])[0] as Json).notify = { sms: true };
    });
    edit(root, "heartbeats.json", (j) => {
      (j.defaults as Json).notify = { email: true, push: true };
    });
    edit(root, "alerts/database.json", (j) => {
      alert(j, "grants-drift").call = true;
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "RT-03 monitor api-health asks for sms: staging stays quiet (email only)",
    );
    expect(found).toContainEqual(
      "RT-03 heartbeat watcher asks for push: staging stays quiet (email only)",
    );
    expect(found).toContainEqual("RT-03 grants-drift: asks for call: staging stays quiet");
  });

  it("a staging-quiet that is not email only, escalates, or has an ai_sre member (RT-02, RT-03)", () => {
    const root = scratch();
    edit(root, "policies.json", (j) => {
      ((j.severities as Json[])[0] as Json).critical_alert = true;
      const policy = (j.policies as Json[])[0] as Json;
      policy.repeatCount = 2;
      ((policy.steps as Json[])[0] as Json).members = [{ type: "ai_sre" }];
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "RT-03 severity quiet asks for critical_alert: staging stays quiet (email only)",
    );
    expect(found).toContainEqual("RT-02 staging-quiet escalates or repeats");
    expect(found).toContainEqual("RT-02 staging-quiet has an ai_sre member");
  });

  it("a watcher alert that does not open one incident per check, target and detail (MC-04)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      alert(j, "cloudflare-config-changed").seriesBy = "target";
      delete alert(j, "tunnel-connectors").seriesBy;
    });
    edit(root, "alerts/email.json", (j) => {
      alert(j, "email-setting-changed").seriesBy = ["target", "detail"];
    });
    const found = rules(root).filter((f) => f.includes("groups watcher.check_failed"));
    const why = "so a failure that stands never hides a later, different one";
    // The fragments are read in name order: email.json before platform.json.
    expect(found).toEqual([
      `MC-04 email-setting-changed: groups watcher.check_failed by target, detail, not by check, target, detail, ${why}`,
      `MC-04 tunnel-connectors: groups watcher.check_failed by nothing, not by check, target, detail, ${why}`,
      `MC-04 cloudflare-config-changed: groups watcher.check_failed by target, not by check, target, detail, ${why}`,
    ]);
  });

  it("a staging-quiet whose step waits, or reaches anyone but the entire staging team (RT-02)", () => {
    const cases: [string, Json, string][] = [
      [
        "no member",
        { members: [] },
        "RT-02 staging-quiet: its step must reach the entire staging team and no one else",
      ],
      [
        "a webhook",
        { members: [{ type: "all_webhook_integrations" }, { type: "all_slack_integrations" }] },
        "RT-02 staging-quiet: its step must reach the entire staging team and no one else",
      ],
      [
        "the on-call",
        { members: [{ type: "current_on_call" }] },
        "RT-02 staging-quiet: its step must reach the entire staging team and no one else",
      ],
      [
        "the team and one more",
        { members: [{ type: "entire_team" }, { type: "all_webhook_integrations" }] },
        "RT-02 staging-quiet: its step must reach the entire staging team and no one else",
      ],
      [
        "a wait",
        { waitBefore: 315360000 },
        "RT-02 staging-quiet: its step must notify at once (waitBefore 0)",
      ],
    ];
    for (const [what, change, expected] of cases) {
      const root = scratch();
      edit(root, "policies.json", (j) => {
        const step = (((j.policies as Json[])[0] as Json).steps as Json[])[0] as Json;
        Object.assign(step, change);
      });
      expect(rules(root), what).toEqual([expected]);
    }
  });

  it("a literal threshold, window or grace (MC-11)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      alert(j, "dns-lookup-failing").threshold = 500;
      alert(j, "no-logs-{service}").window = "300";
    });
    edit(root, "heartbeats.json", (j) => {
      ((j.heartbeats as Json[])[0] as Json).grace = 30;
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "MC-11 dns-lookup-failing: threshold must be @any, @none or an @thresholds.<key> overlay key",
    );
    expect(found).toContainEqual(
      "MC-11 no-logs-edge: window must be an @thresholds.<key> overlay key",
    );
    expect(found).toContainEqual(
      "MC-11 heartbeat watcher: grace must be an @grace.<key> overlay key",
    );
  });

  it("an alert name used twice (MC-14)", () => {
    const root = scratch();
    edit(root, "alerts/email.json", (j) => {
      alerts(j).push({ ...alert(j, "email-not-sent") });
    });
    expect(rules(root).some((r) => r.startsWith("MC-14 email-not-sent is also defined in"))).toBe(
      true,
    );
  });

  it("an alert reading an event or a field the catalogue does not declare (MC-04)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      alert(j, "process-crash").query = { count: { events: ["made.up"] } };
      alert(j, "csp-reports").query = {
        count: { events: ["csp.report"], where: [{ field: "email", eq: "x" }] },
      };
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "MC-04 process-crash: reads the event made.up, which is not catalogued",
    );
    expect(found).toContainEqual(
      "MC-04 csp-reports: reads the field email, which no watched event declares",
    );
  });

  it("an alert the catalogue does not point back at, and a catalogue alert nobody defines (MC-04)", () => {
    const root = scratch();
    const platform = (fragments.platform ?? []).map((e) =>
      e.event === "csp.report" ? { ...e, alerts: ["csp-reports-renamed"] } : e,
    );
    const found = rules(root, { fragments: { ...fragments, platform } });
    expect(found).toContainEqual(
      "MC-04 csp-reports: watches csp.report, whose catalogue entry does not name csp-reports",
    );
    expect(found).toContainEqual(
      "MC-04 csp.report names the alert csp-reports-renamed, which no staging fragment defines",
    );
  });

  it("a failure event with no alert and no reason, and a missing Phase 0 event (MC-02, MC-01)", () => {
    const root = scratch();
    const extra: CatalogEntry = {
      event: "thing.failed",
      kind: "failure",
      level: "error",
      fields: {},
      alerts: [],
      writtenBy: "test",
    };
    const platform = [
      ...(fragments.platform ?? []).filter((e) => e.event !== "dns.lookup_failed"),
      extra,
    ];
    const found = rules(root, { fragments: { ...fragments, platform } });
    expect(found).toContainEqual(
      "MC-02 thing.failed is failure with no alert and no noAlert reason",
    );
    expect(found).toContainEqual("MC-01 spec 01 §8.9's event dns.lookup_failed is not catalogued");
  });

  it("an event written in code that is not catalogued (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "apps", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "apps", "edge", "src", "a.ts"),
      'log("edge.surprise", {});\nlog("request", {});\n',
    );
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 log("edge.surprise") is not catalogued',
    ]);
  });

  it("an ID-shaped metric label (MC-06)", () => {
    const root = scratch();
    edit(root, "metrics.json", (j) => {
      ((j.sets as Json).common as Json[]).push({
        name: "org",
        field: "orgId",
        type: "string_low_cardinality",
        aggregations: [],
      });
    });
    expect(rules(root)).toContainEqual(
      "MC-06 common.org: the label orgId is ID-shaped or free text",
    );
  });

  it("a Better Stack identifier, ingest host or heartbeat URL in a file (MC-12)", () => {
    const root = scratch();
    edit(root, "sources.json", (j) => {
      j.note = ["s1234", "eu-nbg-2", "betterstackdata", "com"].join(".");
    });
    edit(root, "heartbeats.json", (j) => {
      j.note = "https://uptime.betterstack.com/api/v1/heartbeat/abc";
    });
    const found = rules(root);
    expect(found).toContainEqual("MC-12 holds what looks like a Better Stack ingest host");
    expect(found).toContainEqual("MC-12 holds what looks like a Better Stack heartbeat URL");
    // Each file is scanned once.
    expect(found.filter((f) => f.endsWith("ingest host"))).toHaveLength(1);
  });

  it("a runbook without a heading, or that does not name its alert (MC-10)", () => {
    const root = scratch();
    const path = join(root, "docs", "runbooks", "private-dns.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replace("## Containment", "## Fixing")
        .replace("`dns-lookup-failing`", "it"),
    );
    const found = rules(root);
    expect(found).toContainEqual('MC-10 lacks the heading "## Containment"');
    expect(found).toContainEqual("MC-10 does not name dns-lookup-failing, which points at it");
  });

  it("a source with no Errors application and no reason, and an alert on an unknown source (MC-07)", () => {
    const root = scratch();
    edit(root, "errors.json", (j) => {
      delete (j.noApplication as Json).watcher;
    });
    edit(root, "alerts/platform.json", (j) => {
      alert(j, "csp-reports").sources = ["docs"];
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "MC-07 the source watcher has no Errors application and no reason",
    );
    expect(found).toContainEqual("MC-07 csp-reports: names the source docs, which does not exist");
  });

  it("a monitor naming a hostname instead of a host role (MC-00)", () => {
    const root = scratch();
    edit(root, "monitors.json", (j) => {
      ((j.monitors as Json[])[0] as Json).host = "api.example.net";
    });
    expect(rules(root)).toContainEqual(
      "MC-00 monitor api-health: host must be a host role, never a hostname",
    );
  });

  it("files that name another environment's team, name prefix or environment (MC-13)", () => {
    const root = scratch();
    edit(root, "sources.json", (j) => {
      j.team = "fin-production";
      j.namePrefix = "fin-next-production-";
    });
    edit(root, "policies.json", (j) => {
      j.team = "fin-production";
    });
    edit(root, "errors.json", (j) => {
      j.namePrefix = "fin-next-production-";
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "MC-13 names the team fin-production; the staging files belong to fin-staging",
    );
    expect(found).toContainEqual(
      "MC-13 names the prefix fin-next-production-; the staging files use fin-next-staging-",
    );
    expect(found.filter((f) => f.startsWith("MC-13"))).toHaveLength(4);
  });

  it("a Phase 0 heartbeat, or the watcher's own, missing from heartbeats.json (MC-05)", () => {
    const root = scratch();
    edit(root, "heartbeats.json", (j) => {
      j.heartbeats = (j.heartbeats as Json[]).filter((h) => h.name === "verify-daily");
    });
    const found = rules(root);
    for (const name of [
      "watcher",
      "scheduler-worker",
      "scheduler-payments",
      "email-delivery-check",
      "backup-nightly",
      "backup-hourly",
    ]) {
      expect(found).toContainEqual(`MC-05 spec 01 §8.5's heartbeat ${name} is missing`);
    }
    const renamed = scratch();
    const settings = join(renamed, "ops", "watcher", "settings", "staging.json");
    const watcher = JSON.parse(readFileSync(settings, "utf8")) as Json;
    writeFileSync(settings, JSON.stringify({ ...watcher, heartbeat: "watcher-2" }));
    expect(rules(renamed)).toContainEqual(
      "MC-05 the watcher's settings ping the heartbeat watcher-2, which heartbeats.json does not define",
    );
  });

  it("a secret delivered to something that is not a Railway service (MC-07)", () => {
    const root = scratch();
    edit(root, "heartbeats.json", (j) => {
      ((j.heartbeats as Json[])[0] as Json).holders = ["watcher"];
    });
    edit(root, "sources.json", (j) => {
      ((j.sources as Json[]).find((s) => s.service === "ops") as Json).holders = ["ops"];
    });
    edit(root, "errors.json", (j) => {
      ((j.applications as Json[])[0] as Json).holders = ["edge", "edge-2"];
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "MC-07 heartbeat watcher delivers its secret to watcher, which is not a Railway service",
    );
    expect(found).toContainEqual(
      "MC-07 source ops delivers its secret to ops, which is not a Railway service",
    );
    expect(found).toContainEqual(
      "MC-07 application edge delivers its secret to edge-2, which is not a Railway service",
    );
  });

  it("a security event filtered with eq false, which lets a line without the field through (MC-04)", () => {
    const root = scratch();
    edit(root, "alerts/database.json", (j) => {
      alert(j, "privileged-login").query = {
        count: {
          events: ["database.privileged_login"],
          where: [{ field: "registered", eq: false }],
        },
      };
    });
    expect(rules(root)).toContainEqual(
      "MC-04 privileged-login: filters the security event database.privileged_login with registered eq false, so a line without registered never alerts; use notEq true",
    );
  });

  it("a metric whose type is not one of Better Stack's (MC-00)", () => {
    const root = scratch();
    edit(root, "metrics.json", (j) => {
      ((j.sets as Json).request as Json[]).push({
        name: "bytes",
        field: "durationMs",
        type: "float",
        aggregations: ["max"],
      });
    });
    expect(rules(root)).toContainEqual(
      "MC-00 request.bytes: type float is not a Better Stack metric type",
    );
  });

  it("an identifier in any file of the environment, not only the files it parses (MC-12)", () => {
    const root = scratch();
    mkdirSync(join(root, "ops", "monitoring", "staging", "dashboards"), { recursive: true });
    const host = ["s1234", "eu-nbg-2", "betterstackdata", "com"].join(".");
    writeFileSync(
      join(root, "ops", "monitoring", "staging", "dashboards", "fin-services.json"),
      JSON.stringify({ panels: [{ query: `FROM t123456_fin_logs`, from: host }] }, null, 2),
    );
    writeFileSync(
      join(root, "ops", "monitoring", "staging", "webhooks.json"),
      `{\n  "token": "x",\n  "dsn": "https://${"a".repeat(12)}@${host}/1"\n}\n`,
    );
    const found = checkMonitoring(root, { scanCode: false, scan: [] }).filter(
      (f) => f.rule === "MC-12",
    );
    const files = new Set(found.map((f) => f.file.split(":")[0]));
    expect(files).toEqual(
      new Set([
        "ops/monitoring/staging/dashboards/fin-services.json",
        "ops/monitoring/staging/webhooks.json",
      ]),
    );
    const messages = found.map((f) => f.message);
    for (const shape of ["ingest host", "team ID", "token field", "DSN"]) {
      expect(messages).toContainEqual(`holds what looks like a Better Stack ${shape}`);
    }
  });

  it("a templated alert whose forEach does not provide a placeholder (MC-00)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      (alert(j, "process-crash").metadata as Json).check = "Look at {region}.";
    });
    expect(rules(root)).toContainEqual(
      "MC-00 process-crash: an unexpanded {placeholder} remains (forEach does not provide it)",
    );
  });
});
