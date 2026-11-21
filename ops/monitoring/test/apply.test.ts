import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type MonitoringContext,
  monitoringApply,
  parseFlags,
  type SecretDelivery,
  UsageError,
} from "../src/apply.ts";
import { RAILWAY_SERVICES } from "../src/check.ts";
import { loadEnv } from "../src/config.ts";
import { buildDesired } from "../src/desired.ts";
import { FakeBetterStack } from "./fake-betterstack.ts";

type Json = Record<string, unknown>;
const ROOT = join(import.meta.dirname, "..", "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "fin-monitoring-apply-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const TELEMETRY = ["telemetry", "team", "token"].join("-");
const UPTIME = ["uptime", "team", "token"].join("-");
const HEADER = ["monitor", "header", "value"].join("-");
const file = (name: string, value: string) => {
  const path = join(tmp, name);
  writeFileSync(path, `${value}\n`);
  return path;
};
const environ = {
  FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE: file("telemetry", TELEMETRY),
  FIN_BETTERSTACK_UPTIME_TOKEN_FILE: file("uptime", UPTIME),
  FIN_MONITOR_HEADER_FILE: file("header", HEADER),
};
const ZONE = "example.net";
const HOSTS = Object.fromEntries(
  ["console", "admin", "verify", "selfie", "docs", "api"].map((r) => [r, `${r}-x.${ZONE}`]),
);

/** Every overlay key the files name, each with a value. */
function overlay(): { thresholds: Record<string, number>; grace: Record<string, number> } {
  const { config } = loadEnv(ROOT, "staging");
  if (config === undefined) throw new Error("no config");
  const missing = buildDesired(config, { hosts: HOSTS, thresholds: {}, grace: {} }).missing;
  const thresholds: Record<string, number> = {};
  const grace: Record<string, number> = {};
  for (const key of missing) {
    const [family, name = ""] = key.split(/\.(.*)/s);
    if (family === "thresholds") thresholds[name] = 300;
    if (family === "grace") grace[name] = 30;
  }
  return { thresholds, grace };
}

interface SetupOptions {
  team?: string;
  deliver?: false | ((s: SecretDelivery) => Promise<void>);
  root?: string;
}

function setup(args: string[], options: SetupOptions = {}) {
  const bs = new FakeBetterStack({
    telemetryToken: TELEMETRY,
    uptimeToken: UPTIME,
    ...(options.team === undefined ? {} : { team: options.team }),
  });
  const output: string[] = [];
  const delivered: SecretDelivery[] = [];
  const deliver =
    typeof options.deliver === "function"
      ? options.deliver
      : async (s: SecretDelivery) => {
          delivered.push(s);
        };
  const ctx: MonitoringContext = {
    env: "staging",
    args,
    root: options.root ?? ROOT,
    hosts: HOSTS,
    zones: [ZONE],
    ...overlay(),
    environ,
    stdout: { write: (t) => output.push(t) },
    fetch: bs.fetch,
    now: () => new Date(Date.UTC(2026, 10, 21)),
    ...(options.deliver === false ? {} : { deliver }),
  };
  return { bs, ctx, output, delivered, text: () => output.join("") };
}

/** A first apply on an empty team, then a fresh run of `args` against what it made. */
async function applied(args: string[], options: SetupOptions = {}) {
  const first = setup(["--assert-empty-team", "fin-staging"]);
  const result = await monitoringApply(first.ctx);
  expect(result.exitCode).toBe(0);
  const next = setup(args, options);
  for (const [k, v] of first.bs.store) next.bs.store.set(k, v);
  return { first, next };
}

const writes = (bs: FakeBetterStack) => bs.requests.filter((r) => r.method !== "GET");

function expectNothingPrivate(text: string) {
  expect(text).not.toContain(TELEMETRY);
  expect(text).not.toContain(UPTIME);
  expect(text).not.toContain(HEADER);
  expect(text).not.toContain(ZONE);
  expect(text).not.toContain("tok-");
  expect(text).not.toContain("heartbeat.example.com");
}

/** A scratch copy of the monitoring files, the watcher's settings and the runbooks. */
function scratchRoot(): string {
  const root = mkdtempSync(join(tmp, "root-"));
  for (const dir of [
    ["ops", "monitoring", "staging"],
    ["ops", "watcher", "settings"],
    ["docs", "runbooks"],
  ]) {
    cpSync(join(ROOT, ...dir), join(root, ...dir), { recursive: true });
  }
  return root;
}

function editJson(root: string, name: string, change: (json: Record<string, unknown>) => void) {
  const path = join(root, "ops", "monitoring", "staging", name);
  const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(json);
  writeFileSync(path, JSON.stringify(json));
}

describe("monitoring apply: the guards", () => {
  it("refuses an empty team it cannot identify, and changes nothing (MA-02)", async () => {
    const { bs, ctx, text } = setup(["--dry-run"]);
    const result = await monitoringApply(ctx);
    expect(result.exitCode).toBe(1);
    expect(text()).toContain("refused: MA-02 the telemetry token shows no object");
    expect(writes(bs)).toEqual([]);
  });

  it("prints the dry run's difference for a first apply and changes nothing (MA-01)", async () => {
    const { bs, ctx, text } = setup(["--dry-run", "--assert-empty-team", "fin-staging"]);
    const result = await monitoringApply(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.drift).toBe(true);
    expect(text()).toContain("monitoring apply staging (dry run), team fin-staging");
    expect(text()).toContain("+ urgency quiet");
    expect(text()).toContain("+ policy staging-quiet");
    expect(text()).toContain("+ source fin-next-staging-watcher");
    expect(text()).toContain("+ monitor api-health");
    expect(text()).toContain("+ heartbeat watcher");
    expect(text()).toContain("dry run: nothing changed");
    expect(writes(bs)).toEqual([]);
    expectNothingPrivate(text());
  });

  it("refuses tokens that read another team's objects (MA-02)", async () => {
    const { bs, ctx, text } = setup(["--dry-run"], { team: "fin-production" });
    bs.seed("urgencies", { name: "High Severity", call: true });
    bs.seed("sources", { name: "fin-next-production-api" });
    const result = await monitoringApply(ctx);
    expect(result.exitCode).toBe(1);
    expect(text()).toContain(
      "MA-02 the telemetry token reads another team's objects, not fin-staging",
    );
    expect(text()).toContain(
      "MA-02 the uptime token reads another team's objects, not fin-staging",
    );
  });

  it("honours --assert-empty-team only for a team that holds nothing at all (MA-02)", async () => {
    const { bs, ctx, text } = setup(["--assert-empty-team", "fin-staging"]);
    for (const name of ["prod-api", "prod-console", "prod-admin"]) {
      bs.seed("monitors", { pronounceable_name: name, team_name: undefined });
    }
    const result = await monitoringApply(ctx);
    expect(result.exitCode).toBe(1);
    expect(text()).toContain(
      "refused: MA-02 the uptime token reads 3 object(s) but none carries a team name, so its team cannot be checked",
    );
    expect(text()).not.toContain("the uptime token shows no object");
    expect(writes(bs)).toEqual([]);
  });

  it("refuses a missing overlay value (MA-10)", async () => {
    const { ctx, text } = setup(["--dry-run", "--assert-empty-team", "fin-staging"]);
    const { [Object.keys(ctx.thresholds)[0] ?? ""]: _dropped, ...rest } = ctx.thresholds;
    const result = await monitoringApply({ ...ctx, thresholds: rest });
    expect(result.exitCode).toBe(1);
    expect(text()).toMatch(/refused: MA-10 the run's settings have no value for thresholds\./);
  });

  it("refuses an ai_sre member and a policy that calls, outside the files (MA-08, MA-06)", async () => {
    const { bs, ctx, text } = setup(["--dry-run"]);
    const loud = bs.seed("urgencies", { name: "High Severity", call: true, email: true });
    bs.seed("policies", {
      name: "Default",
      steps: [
        { type: "escalation", urgency_id: Number(loud.id), step_members: [{ type: "ai_sre" }] },
      ],
    });
    bs.seed("sources", { name: "fin-next-staging-api" });
    const result = await monitoringApply(ctx);
    expect(result.exitCode).toBe(1);
    expect(text()).toContain("refused: MA-08 policy Default has an ai_sre member");
    expect(text()).toContain("refused: MA-06 policy Default (not in the files) notifies by call");
  });

  it("refuses a second policy that shares a name the files use, and checks it for ai_sre (MA-08)", async () => {
    const { next } = await applied(["--dry-run"]);
    next.bs.seed("policies", {
      name: "staging-quiet",
      steps: [{ type: "escalation", step_members: [{ type: "ai_sre" }] }],
    });
    const result = await monitoringApply(next.ctx);
    expect(result.exitCode).toBe(1);
    expect(next.text()).toContain("refused: MA-08 policy staging-quiet has an ai_sre member");
    expect(next.text()).toContain("refused: Better Stack holds 2 policies named staging-quiet");
  });

  it("requires the monitor header for a real apply", async () => {
    const { ctx } = setup(["--assert-empty-team", "fin-staging"]);
    const { FIN_MONITOR_HEADER_FILE: _h, ...noHeader } = environ;
    await expect(monitoringApply({ ...ctx, environ: noHeader })).rejects.toThrow(UsageError);
  });

  it("parses its flags strictly", () => {
    expect(parseFlags(["--dry-run", "--confirm-delete", "4"])).toMatchObject({
      dryRun: true,
      confirmDelete: 4,
    });
    expect(() => parseFlags(["--confirm-delete", "all"])).toThrow(UsageError);
    expect(() => parseFlags(["--yes"])).toThrow(UsageError);
  });

  it("takes the team from the environment, and refuses files that name another (MA-02, MC-13)", async () => {
    const root = scratchRoot();
    for (const name of ["sources.json", "policies.json"]) {
      editJson(root, name, (j) => {
        j.team = "fin-production";
      });
    }
    const { bs, ctx, text } = setup([], { team: "fin-production", root });
    bs.seed("sources", { name: "fin-next-production-api" });
    const result = await monitoringApply(ctx);
    expect(result.exitCode).toBe(1);
    expect(text()).toContain("MC-13 names the team fin-production");
    expect(writes(bs)).toEqual([]);
  });
});

describe("monitoring apply: applying", () => {
  it("creates everything parents first, resolves names to IDs, delivers secrets, and is idempotent", async () => {
    const first = setup(["--assert-empty-team", "fin-staging"]);
    const result = await monitoringApply(first.ctx);
    expect(result.exitCode).toBe(0);
    expect(result.deleted).toBe(0);
    const posts = writes(first.bs).filter((r) => r.method === "POST");
    const order = posts.map((r) => r.path.split("/")[3]);
    expect(order.indexOf("urgencies")).toBeLessThan(order.indexOf("policies"));
    expect(order.indexOf("policies")).toBeLessThan(order.indexOf("sources"));
    expect(order.lastIndexOf("policies")).toBeLessThan(order.indexOf("monitors"));
    expect(order.indexOf("explorations")).toBeLessThan(order.indexOf("heartbeats"));

    const policy = first.bs.items("policies")[0]?.attributes as {
      steps: { urgency_id: unknown }[];
    };
    expect(policy.steps[0]?.urgency_id).toBe(Number(first.bs.items("urgencies")[0]?.id));
    const monitor = first.bs
      .items("monitors")
      .find((m) => m.attributes.pronounceable_name === "admin");
    expect(monitor?.attributes).toMatchObject({
      url: `https://${HOSTS.admin}/`,
      monitor_type: "expected_status_code",
      expected_status_codes: [302],
      follow_redirects: false,
      regions: ["us", "eu"],
      check_frequency: 60,
      call: false,
      sms: false,
      push: false,
      critical_alert: false,
      email: true,
      maintenance_from: null,
      maintenance_to: null,
      team_wait: null,
      request_headers: [{ name: "Fin-Monitor", value: HEADER }],
    });
    const alert = first.bs.items("alerts").find((a) => a.attributes.name === "tunnel-connectors");
    expect(alert?.attributes).toMatchObject({
      alert_type: "threshold",
      operator: "higher_than",
      value: 0,
    });
    const exploration = first.bs
      .items("explorations")
      .find((e) => e.attributes.name === "fin/tunnel-connectors");
    const watcherSource = first.bs
      .items("sources")
      .find((s) => s.attributes.name === "fin-next-staging-watcher");
    expect(JSON.stringify(exploration?.attributes.variables)).toContain(`"${watcherSource?.id}"`);
    expect(first.bs.items(`metrics:${watcherSource?.id}`).map((m) => m.attributes.name)).toContain(
      "check",
    );

    // Secrets go to Railway services only, and never to the output. The watcher's own source
    // token and heartbeat URL are read by `watcher deploy`, so nothing is delivered for them.
    expect(first.delivered.length).toBeGreaterThan(0);
    for (const d of first.delivered) expect(RAILWAY_SERVICES).toContain(d.service);
    expect(first.delivered.some((d) => d.variable === "FIN_HEARTBEAT_WATCHER_URL")).toBe(false);
    expect(first.delivered.some((d) => d.service === "ops" || d.service === "watcher")).toBe(false);
    expect(first.delivered).toContainEqual({
      service: "worker",
      variable: "FIN_HEARTBEAT_SCHEDULER_WORKER_URL",
      value: expect.stringMatching(/^https:\/\/heartbeat\.example\.com\//),
    });
    expect(
      first.delivered.filter((d) => d.variable === "FIN_TELEMETRY_TOKEN").map((d) => d.service),
    ).toContain("cloudflared-admin-b");
    expect(
      first.delivered.find((d) => d.service === "edge" && d.variable === "FIN_DOCS_ERRORS_DSN")
        ?.value,
    ).toMatch(/^https:\/\/tok-applications-\d+@s\d+\.eu-nbg-2\.example\.com\/1$/);
    expect(result.undelivered).toEqual([]);
    expectNothingPrivate(first.text());

    // A second dry run against what was applied finds nothing to do.
    const second = setup(["--dry-run"]);
    for (const [k, v] of first.bs.store) second.bs.store.set(k, v);
    const again = await monitoringApply(second.ctx);
    expect(again.exitCode).toBe(0);
    expect(again.drift).toBe(false);
    expect(second.text()).toMatch(
      /summary: 0 to create, 0 to update, 0 to delete, 0 to pause, 0 for review/,
    );
    expect(writes(second.bs)).toEqual([]);
  });

  it("sends each metric with the type the files give it, and reports a type that differs", async () => {
    const { first, next } = await applied(["--dry-run"]);
    const { config } = loadEnv(ROOT, "staging");
    const types = new Map(
      Object.values(config?.metrics.sets ?? {})
        .flat()
        .map((m) => [m.name, m.type]),
    );
    const metricPosts = writes(first.bs).filter((r) => /\/metrics$/.test(r.path));
    expect(metricPosts.length).toBeGreaterThan(0);
    for (const post of metricPosts) {
      const body = post.body as { name: string; type?: string };
      expect(body.type, body.name).toBe(types.get(body.name));
    }
    const api = next.bs.items("sources").find((s) => s.attributes.name === "fin-next-staging-api");
    const metric = next.bs
      .items(`metrics:${api?.id}`)
      .find((m) => m.attributes.name === "duration_ms");
    Object.assign(metric?.attributes ?? {}, { type: "int64_delta" });
    const result = await monitoringApply(next.ctx);
    expect(result.drift).toBe(true);
    expect(next.text()).toContain(
      "! metric fin-next-staging-api/duration_ms: type is int64_delta, the files say float64_delta",
    );
  });

  it("sends every alert email only, and puts back an alert someone made loud (MA-06)", async () => {
    const { first, next } = await applied(["--dry-run"]);
    const alertPosts = writes(first.bs).filter((r) =>
      /\/explorations\/[^/]+\/alerts$/.test(r.path),
    );
    expect(alertPosts.length).toBeGreaterThan(0);
    for (const post of alertPosts) {
      expect(post.body).toMatchObject({
        email: true,
        call: false,
        sms: false,
        push: false,
        critical_alert: false,
      });
    }
    const alert = next.bs.items("alerts").find((a) => a.attributes.name === "tunnel-connectors");
    Object.assign(alert?.attributes ?? {}, {
      call: true,
      sms: true,
      push: true,
      critical_alert: true,
    });
    const dry = await monitoringApply(next.ctx);
    expect(dry.drift).toBe(true);
    expect(next.text()).toMatch(/~ alert tunnel-connectors: .*call true -> false/);
    expect(next.text()).toContain(
      "note: alert tunnel-connectors notifies by call, sms, push, critical_alert; the apply quiets it (MA-06)",
    );
    const fix = setup([]);
    for (const [k, v] of next.bs.store) fix.bs.store.set(k, v);
    expect((await monitoringApply(fix.ctx)).exitCode).toBe(0);
    expect(alert?.attributes).toMatchObject({
      call: false,
      sms: false,
      push: false,
      critical_alert: false,
    });
  });

  it("does not count a field Better Stack leaves out of its answer as drift", async () => {
    const { next } = await applied(["--dry-run"]);
    const alert = next.bs.items("alerts").find((a) => a.attributes.name === "process-crash");
    delete alert?.attributes.alert_type;
    delete alert?.attributes.email;
    const api = next.bs.items("sources").find((s) => s.attributes.name === "fin-next-staging-api");
    for (const metric of next.bs.items(`metrics:${api?.id}`)) delete metric.attributes.type;
    const result = await monitoringApply(next.ctx);
    expect(result.drift).toBe(false);
    // A loud flag it leaves out reads as off, which is what the files say.
    delete alert?.attributes.call;
    expect((await monitoringApply(next.ctx)).drift).toBe(false);
  });

  it("finds an alert whose kind was changed (threshold to another)", async () => {
    const { next } = await applied(["--dry-run"]);
    const alert = next.bs.items("alerts").find((a) => a.attributes.name === "process-crash");
    Object.assign(alert?.attributes ?? {}, { alert_type: "anomaly_rrcf" });
    const result = await monitoringApply(next.ctx);
    expect(result.drift).toBe(true);
    expect(next.text()).toContain("~ alert process-crash: alert_type anomaly_rrcf -> threshold");
  });

  it("finds and clears a maintenance window or a team wait on a monitor or a heartbeat", async () => {
    const { next } = await applied(["--dry-run"]);
    const heartbeat = next.bs.items("heartbeats").find((h) => h.attributes.name === "watcher");
    Object.assign(heartbeat?.attributes ?? {}, {
      maintenance_from: "00:00:00",
      maintenance_to: "23:59:00",
    });
    const monitor = next.bs
      .items("monitors")
      .find((m) => m.attributes.pronounceable_name === "api-health");
    Object.assign(monitor?.attributes ?? {}, { team_wait: 86400 });
    const result = await monitoringApply(next.ctx);
    expect(result.drift).toBe(true);
    expect(next.text()).toContain(
      "~ heartbeat watcher: maintenance_from 00:00:00 -> (none); maintenance_to 23:59:00 -> (none)",
    );
    expect(next.text()).toContain("~ monitor api-health: team_wait 86400 -> (none)");
  });

  it("caps deletions and pauses together without --confirm-delete equal to their number (MA-03)", async () => {
    const { bs, ctx, text } = setup(["--assert-empty-team", "fin-staging"]);
    for (const n of [1, 2, 3, 4])
      bs.seed("monitors", { pronounceable_name: `old-${n}`, url: "https://x.example.com" });
    const refused = await monitoringApply(ctx);
    expect(refused.exitCode).toBe(1);
    expect(text()).toContain(
      "refused: MA-03 this run would delete or pause 4 objects; pass --confirm-delete 4",
    );
    expect(writes(bs)).toEqual([]);

    const wrong = setup(["--assert-empty-team", "fin-staging", "--confirm-delete", "3"]);
    for (const n of [1, 2, 3, 4]) wrong.bs.seed("monitors", { pronounceable_name: `old-${n}` });
    expect((await monitoringApply(wrong.ctx)).exitCode).toBe(1);
    expect(wrong.text()).toContain(
      "MA-03 --confirm-delete 3 does not match the 4 deletion(s) and pause(s)",
    );

    const confirmed = setup(["--assert-empty-team", "fin-staging", "--confirm-delete", "4"]);
    for (const n of [1, 2, 3, 4]) confirmed.bs.seed("monitors", { pronounceable_name: `old-${n}` });
    const result = await monitoringApply(confirmed.ctx);
    expect(result.exitCode).toBe(0);
    expect(result.deleted).toBe(4);
  });

  it("reports drift from a dry run that would delete more than three, without --confirm-delete (MA-03)", async () => {
    const { next } = await applied(["--dry-run"]);
    for (const collection of ["alerts", "heartbeats", "monitors"]) {
      for (const item of next.bs.items(collection)) item.attributes.paused = true;
    }
    for (const n of [1, 2, 3, 4]) next.bs.seed("monitors", { pronounceable_name: `stray-${n}` });
    const result = await monitoringApply(next.ctx);
    expect(result).toMatchObject({ exitCode: 0, drift: true });
    expect(next.text()).toContain(
      "note: a real run would delete or pause 4 objects, so it needs --confirm-delete 4 (MA-03)",
    );
    expect(next.text()).not.toContain("refused");
    expect(writes(next.bs)).toEqual([]);
  });

  it("reports drift from a dry run that Better Stack's own state refuses", async () => {
    const cases: [string, (bs: FakeBetterStack) => void, string][] = [
      [
        "a loud alert outside the files",
        (bs) => bs.seed("alerts", { name: "someone's alert", exploration_id: 1, call: true }),
        "refused: MA-06 alert someone's alert (not in the files) notifies by call",
      ],
      [
        "a second heartbeat with a managed name",
        (bs) => bs.seed("heartbeats", { name: "watcher", period: 60 }),
        "refused: Better Stack holds 2 heartbeats named watcher",
      ],
      [
        "an ai_sre member",
        (bs) =>
          bs.seed("policies", { name: "Extra", steps: [{ step_members: [{ type: "ai_sre" }] }] }),
        "refused: MA-08 policy Extra has an ai_sre member",
      ],
    ];
    for (const [what, change, refusal] of cases) {
      const { next } = await applied(["--dry-run"]);
      change(next.bs);
      const result = await monitoringApply(next.ctx);
      expect(result, what).toMatchObject({ exitCode: 1, drift: true });
      expect(next.text(), what).toContain(refusal);
    }
  });

  it("reports a source or an Errors application the files do not name as drift", async () => {
    const { next } = await applied(["--dry-run"]);
    next.bs.seed("sources", { name: "hand-made" });
    const result = await monitoringApply(next.ctx);
    expect(result).toMatchObject({ exitCode: 0, drift: true });
    expect(next.text()).toContain("summary: 0 to create, 0 to update, 0 to delete, 0 to pause");
    expect(next.text()).toContain("dry run: nothing changed (differences found)");
  });

  it("counts paused heartbeats against the cap: four dropped heartbeats need --confirm-delete 4", async () => {
    const { next } = await applied([]);
    for (const n of [1, 2, 3, 4]) next.bs.seed("heartbeats", { name: `old-duty-${n}`, period: 60 });
    const refused = await monitoringApply(next.ctx);
    expect(refused.exitCode).toBe(1);
    expect(refused.paused).toBe(0);
    expect(next.text()).toContain("MA-03 this run would delete or pause 4 objects");
    expect(writes(next.bs)).toEqual([]);
  });

  it("pauses a heartbeat the files dropped, never deletes it (MA-04)", async () => {
    const { bs, ctx, text } = setup(["--assert-empty-team", "fin-staging"]);
    const old = bs.seed("heartbeats", { name: "old-duty", period: 60, grace: 30 });
    const result = await monitoringApply(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.paused).toBe(1);
    expect(bs.requests.some((r) => r.method === "DELETE" && r.path.includes("heartbeats"))).toBe(
      false,
    );
    expect(bs.items("heartbeats").find((h) => h.id === old.id)?.attributes.paused).toBe(true);
    expect(text()).toContain(
      "paused heartbeat old-duty: not in ops/monitoring; paused by pnpm fin monitoring apply on 2026-11-21",
    );
  });

  it("refuses two remote objects with one name, naming the kind and the name", async () => {
    const { next } = await applied(["--dry-run"]);
    next.bs.seed("monitors", {
      pronounceable_name: "api-health",
      call: true,
      sms: true,
      push: true,
    });
    const result = await monitoringApply(next.ctx);
    expect(result.exitCode).toBe(1);
    expect(next.text()).toContain(
      "refused: Better Stack holds 2 monitors named api-health; the apply works by name, so remove the extra one by hand",
    );
  });

  it("never deletes a source or an Errors application the files do not name", async () => {
    const { bs, ctx, text } = setup(["--assert-empty-team", "fin-staging"]);
    bs.seed("sources", { name: "hand-made" });
    const result = await monitoringApply(ctx);
    expect(result.exitCode).toBe(0);
    expect(bs.items("sources").some((s) => s.attributes.name === "hand-made")).toBe(true);
    expect(text()).toContain(
      "source hand-made is not in the files; sources and Errors applications are never deleted",
    );
  });

  it("resumes an alert Better Stack paused, saying so, and reports a region it cannot change", async () => {
    const first = setup(["--assert-empty-team", "fin-staging"]);
    await monitoringApply(first.ctx);
    const alert = first.bs.items("alerts").find((a) => a.attributes.name === "process-crash");
    Object.assign(alert?.attributes ?? {}, { paused: true, paused_reason: "query failing" });
    const source = first.bs
      .items("sources")
      .find((s) => s.attributes.name === "fin-next-staging-api");
    Object.assign(source?.attributes ?? {}, { data_region: "us_east" });
    const second = setup([]);
    for (const [k, v] of first.bs.store) second.bs.store.set(k, v);
    const result = await monitoringApply(second.ctx);
    expect(result.exitCode).toBe(0);
    expect(second.text()).toContain(
      "alert process-crash was paused (query failing); the apply resumes it",
    );
    expect(second.text()).toContain("! source fin-next-staging-api: data_region is us_east");
    expect(alert?.attributes.paused).toBe(false);
    const patches = writes(second.bs).filter((r) => r.method === "PATCH");
    expect(patches.some((p) => p.path.includes("/sources/"))).toBe(false);
  });

  it("prints names for the IDs a difference holds, never the IDs", async () => {
    const { next } = await applied(["--dry-run"]);
    const monitor = next.bs
      .items("monitors")
      .find((m) => m.attributes.pronounceable_name === "api-health");
    Object.assign(monitor?.attributes ?? {}, { policy_id: 987654 });
    const exploration = next.bs
      .items("explorations")
      .find((e) => e.attributes.name === "fin/tunnel-connectors");
    Object.assign(exploration?.attributes ?? {}, {
      variables: [{ name: "source", variable_type: "source", values: ["555111"] }],
    });
    const policy = next.bs.items("policies")[0];
    Object.assign(policy?.attributes ?? {}, {
      steps: [
        {
          type: "escalation",
          wait_before: 0,
          urgency_id: 424242,
          step_members: [{ type: "user", id: 313131 }],
        },
      ],
    });
    const result = await monitoringApply(next.ctx);
    expect(result.drift).toBe(true);
    const text = next.text();
    expect(text).toContain("~ monitor api-health: policy_id (another policy) -> staging-quiet");
    expect(text).toContain(
      '~ exploration fin/tunnel-connectors: sources ["(another source)"] -> ["fin-next-staging-watcher"]',
    );
    expect(text).toContain("(another urgency)");
    for (const id of ["987654", "555111", "424242", "313131"]) expect(text).not.toContain(id);
    expectNothingPrivate(text);
  });

  it("prints each changed part of a long value, so a change never reads the same on both sides", async () => {
    const { next } = await applied(["--dry-run"]);
    const policy = next.bs.items("policies")[0];
    const [step] = (policy?.attributes.steps ?? []) as Json[];
    if (step === undefined) throw new Error("no step");
    step.step_members = [{ type: "all_webhook_integrations" }, { type: "all_slack_integrations" }];
    const alert = next.bs.items("alerts").find((a) => a.attributes.name === "tunnel-connectors");
    const attributes = alert?.attributes ?? {};
    attributes.incident_cause = `${String(attributes.incident_cause)} Ignore it.`;
    (attributes.metadata as Json).runbook = "docs/runbooks/monitor-down.md";
    const exploration = next.bs
      .items("explorations")
      .find((e) => e.attributes.name === "fin/tunnel-connectors");
    const [query] = (exploration?.attributes.queries ?? []) as Json[];
    if (query !== undefined) query.sql_query = `${String(query.sql_query)} LIMIT 0`;
    const monitor = next.bs
      .items("monitors")
      .find((m) => m.attributes.pronounceable_name === "api-health");
    Object.assign(monitor?.attributes ?? {}, {
      request_headers: [{ name: "Fin-Monitor", value: "another value" }],
    });
    const result = await monitoringApply(next.ctx);
    expect(result.drift).toBe(true);
    const lines = next.text().split("\n");
    const line = (start: string) => lines.find((l) => l.startsWith(start)) ?? "";
    expect(line("~ policy staging-quiet:")).toBe(
      '~ policy staging-quiet: steps[0].step_members [{"type":"all_webhook_integrations"},{"type":"all_slack_integrations"}] -> [{"type":"entire_team"}]',
    );
    const alertLine = line("~ alert tunnel-connectors:");
    expect(alertLine).toContain(
      "metadata.runbook docs/runbooks/monitor-down.md -> docs/runbooks/evict-tunnel.md",
    );
    expect(alertLine).toMatch(/incident_cause \.\.\.[^;]* Ignore it\. -> \.\.\.[^;]*token\./);
    expect(line("~ exploration fin/tunnel-connectors:")).toMatch(
      /^~ exploration fin\/tunnel-connectors: query \(query [0-9a-f]{8}\) -> \(query [0-9a-f]{8}\)$/,
    );
    expect(line("~ monitor api-health:")).toBe(
      "~ monitor api-health: request_headers (not shown) -> (not shown, differs)",
    );
    // Every printed change differs between its two sides.
    for (const l of lines.filter((x) => x.startsWith("~ "))) {
      for (const change of l.slice(l.indexOf(": ") + 2).split("; ")) {
        const [from, to] = change.slice(change.indexOf(" ") + 1).split(" -> ");
        expect(from, change).not.toBe(to);
      }
    }
    expectNothingPrivate(next.text());
  });

  it("masks the zone in every name it prints, and in Better Stack's own error text", async () => {
    const { next } = await applied(["--dry-run"]);
    next.bs.seed("monitors", { pronounceable_name: `legacy.${ZONE}` });
    next.bs.seed("heartbeats", { name: `cron on db1.${ZONE}` });
    next.bs.seed("policies", { name: `${ZONE} on-call`, steps: [] });
    next.bs.seed("sources", { name: `${ZONE} nginx` });
    await monitoringApply(next.ctx);
    expect(next.text()).toContain("- monitor legacy.<zone>");
    expectNothingPrivate(next.text());

    const failing = setup([]);
    for (const [k, v] of next.bs.store) failing.bs.store.set(k, v);
    const monitor = failing.bs
      .items("monitors")
      .find((m) => m.attributes.pronounceable_name === "api-health");
    Object.assign(monitor?.attributes ?? {}, { check_frequency: 30 });
    failing.bs.failWith = (method, path, body) =>
      method === "PATCH" && path.includes("/monitors/")
        ? {
            status: 422,
            body: {
              errors: { url: `${String((body as { url?: string }).url)} is invalid` },
              invalid_attributes: [
                JSON.stringify((body as { request_headers?: unknown }).request_headers),
              ],
            },
          }
        : undefined;
    const result = await monitoringApply(failing.ctx);
    expect(result.exitCode).toBe(1);
    expect(failing.text()).toContain(
      "monitoring apply: Better Stack refused PATCH /api/v2/monitors/<id> answered 422",
    );
    expect(failing.text()).toContain("(the monitor header)");
    expectNothingPrivate(failing.text());
  });

  it("masks a long value before cutting it, so no part of a host or the zone is printed", async () => {
    // A zone long enough that a cut around a change past the host could land inside it.
    const zone = "qzvwlonghiddenzonename.example";
    const hosts = Object.fromEntries(Object.keys(HOSTS).map((role) => [role, `${role}.${zone}`]));
    const pieces = (text: string) => {
      const found: string[] = [];
      for (let i = 0; i + 6 <= zone.length; i += 1) {
        if (text.includes(zone.slice(i, i + 6))) found.push(zone.slice(i, i + 6));
      }
      return found;
    };
    const first = setup(["--assert-empty-team", "fin-staging"]);
    expect((await monitoringApply({ ...first.ctx, hosts, zones: [zone] })).exitCode).toBe(0);

    // A hand edit in Better Stack that makes the remote URL long, its change past the host.
    const edited = (bs: FakeBetterStack) => {
      for (const name of ["api-unauthenticated", "api-health", "admin"]) {
        const monitor = bs.items("monitors").find((m) => m.attributes.pronounceable_name === name);
        if (monitor === undefined) throw new Error(`no monitor ${name}`);
        monitor.attributes.url = `${String(monitor.attributes.url)}?probe=${"a".repeat(60)}`;
      }
    };
    const dry = setup(["--dry-run"]);
    for (const [k, v] of first.bs.store) dry.bs.store.set(k, v);
    edited(dry.bs);
    expect((await monitoringApply({ ...dry.ctx, hosts, zones: [zone] })).drift).toBe(true);
    expect(dry.text()).toContain(
      "~ monitor api-unauthenticated: url https://<api>/v4/whoami?probe=",
    );
    expect(dry.text()).toContain("-> https://<api>/v4/whoami");
    expect(pieces(dry.text())).toEqual([]);

    // Better Stack's own error text echoing the URL, long enough that a cut at its end would
    // fall inside the zone.
    const failing = setup([]);
    for (const [k, v] of first.bs.store) failing.bs.store.set(k, v);
    failing.bs.failWith = (method, path, body) => {
      if (method !== "PATCH" || !path.includes("/monitors/")) return undefined;
      const url = String((body as { url?: string }).url);
      const pad = 400 - "url: ".length - 1 - (url.indexOf(zone) + 10);
      return { status: 422, body: { errors: { url: `${"x".repeat(pad)} ${url} is invalid` } } };
    };
    const result = await monitoringApply({ ...failing.ctx, hosts, zones: [zone] });
    expect(result.exitCode).toBe(1);
    expect(failing.text()).toContain(
      "Better Stack refused PATCH /api/v2/monitors/<id> answered 422",
    );
    expect(pieces(failing.text())).toEqual([]);
  });

  it("looks up a create that got no answer by name, and delivers its secrets", async () => {
    const { config } = loadEnv(ROOT, "staging");
    if (config === undefined) throw new Error("no config");
    const desired = buildDesired(config, { hosts: HOSTS, thresholds: {}, grace: {} }).objects;
    const labels = (o: (typeof desired)[number]) =>
      (o.delivery?.services ?? []).flatMap((service) =>
        Object.keys(o.delivery?.variables ?? {}).map((variable) => `${service} ${variable}`),
      );
    const cases = [
      ["source", "/api/v3/sources"],
      ["application", "/api/v3/applications"],
      ["heartbeat", "/api/v2/heartbeats"],
    ] as const;
    for (const [kind, path] of cases) {
      const target = desired.find((o) => o.kind === kind && labels(o).length > 0);
      if (target === undefined) throw new Error(`no ${kind} with secrets`);
      for (const failure of [
        new TypeError("fetch failed"),
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      ]) {
        const run = setup(["--assert-empty-team", "fin-staging"]);
        const serve = run.bs.fetch;
        let lost = false;
        // Better Stack makes the object, but its answer never arrives.
        const fetch = async (input: string, init?: RequestInit) => {
          const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
          if (!lost && init?.method === "POST" && new URL(input).pathname === path) {
            if ((body as { name?: string }).name === target.key) {
              lost = true;
              await serve(input, init);
              throw failure;
            }
          }
          return serve(input, init);
        };
        const result = await monitoringApply({ ...run.ctx, fetch });
        const what = `${kind} ${failure.name}`;
        expect(lost, what).toBe(true);
        expect(result.exitCode, what).toBe(1);
        const delivered = run.delivered.map((d) => `${d.service} ${d.variable}`);
        for (const label of labels(target)) expect(delivered, what).toContain(label);
        expect(result.undelivered, what).toEqual([]);
        expect(run.text(), what).toContain(
          `created ${kind} ${target.key} (its create got no answer; found by name)`,
        );
        expect(run.text(), what).not.toContain("fetch failed");
        expectNothingPrivate(run.text());

        // The next plain run finds nothing left to deliver for it.
        const next = setup([]);
        for (const [k, v] of run.bs.store) next.bs.store.set(k, v);
        expect((await monitoringApply(next.ctx)).exitCode, what).toBe(0);
        expect(
          next.bs.items(`${kind}s`).filter((i) => i.attributes.name === target.key),
        ).toHaveLength(1);
      }
    }
  });

  it("lists the secrets of a create that got no answer for --redeliver when it cannot find the object", async () => {
    const { config } = loadEnv(ROOT, "staging");
    if (config === undefined) throw new Error("no config");
    const target = buildDesired(config, { hosts: HOSTS, thresholds: {}, grace: {} }).objects.find(
      (o) => o.kind === "source" && (o.delivery?.services.length ?? 0) > 0,
    );
    if (target === undefined) throw new Error("no source with secrets");
    const run = setup(["--assert-empty-team", "fin-staging"]);
    const serve = run.bs.fetch;
    let lost = false;
    // The answer is lost, and so is every read after it.
    const fetch = async (input: string, init?: RequestInit) => {
      if (lost) throw new TypeError("fetch failed");
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
      if (init?.method === "POST" && (body as { name?: string }).name === target.key) {
        lost = true;
        await serve(input, init);
        throw new TypeError("fetch failed");
      }
      return serve(input, init);
    };
    const result = await monitoringApply({ ...run.ctx, fetch });
    expect(result.exitCode).toBe(1);
    const services = target.delivery?.services ?? [];
    const variables = Object.keys(target.delivery?.variables ?? {});
    for (const service of services) {
      for (const variable of variables) {
        expect(result.undelivered).toContain(
          `${service} ${variable} (its create got no answer; it may exist)`,
        );
      }
    }
    expect(run.text()).toContain("not delivered (set these sealed variables with");
    expect(run.text()).toContain("--redeliver");
    expectNothingPrivate(run.text());
  });

  it("lists every secret --redeliver could not read when a read stops it", async () => {
    const { first, next } = await applied(["--redeliver"]);
    const total = first.delivered.length;
    let reads = 0;
    // Each source, application and heartbeat is read back by its ID; the third read fails.
    next.bs.failWith = (method, path) => {
      if (method !== "GET" || !/\/(sources|applications|heartbeats)\/[^/]+$/.test(path)) {
        return undefined;
      }
      reads += 1;
      return reads >= 3 ? { status: 500, body: {} } : undefined;
    };
    const result = await monitoringApply(next.ctx);
    expect(result.exitCode).toBe(1);
    expect(result.delivered).toBeLessThan(total);
    expect(result.delivered + result.undelivered.length).toBe(total);
    expect(result.undelivered.every((u) => u.endsWith("(its secrets could not be read)"))).toBe(
      true,
    );
    expect(next.text()).toContain("not delivered (set these sealed variables with");
    expectNothingPrivate(next.text());
  });

  it("delivers what it created even when a later write fails, and lists each delivery that failed", async () => {
    const failing = setup(["--assert-empty-team", "fin-staging"], {
      deliver: async (s) => {
        if (s.service === "payments") throw new Error(`refused ${s.value}`);
      },
    });
    failing.bs.failWith = (method, path) =>
      method === "POST" && path.endsWith("/heartbeats") ? { status: 500, body: {} } : undefined;
    const result = await monitoringApply(failing.ctx);
    expect(result.exitCode).toBe(1);
    expect(result.created).toBeGreaterThan(0);
    expect(result.delivered).toBeGreaterThan(0);
    expect(result.undelivered).toContain("payments FIN_TELEMETRY_TOKEN (delivery failed)");
    expect(failing.text()).toContain(
      "monitoring apply: Better Stack refused POST /api/v2/heartbeats answered 500",
    );
    expect(failing.text()).not.toContain("refused tok-");
    expectNothingPrivate(failing.text());
  });

  it("delivers what it created when the connection drops or times out partway, and exits 1", async () => {
    const { config } = loadEnv(ROOT, "staging");
    if (config === undefined) throw new Error("no config");
    const sourceSecrets = buildDesired(config, { hosts: HOSTS, thresholds: {}, grace: {} })
      .objects.filter((o) => o.kind === "source")
      .flatMap((o) =>
        (o.delivery?.services ?? []).flatMap((service) =>
          Object.keys(o.delivery?.variables ?? {}).map((variable) => `${service} ${variable}`),
        ),
      )
      .sort();
    expect(sourceSecrets.length).toBe(26);
    for (const failure of [
      new TypeError("fetch failed"),
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    ]) {
      const run = setup(["--assert-empty-team", "fin-staging"]);
      const serve = run.bs.fetch;
      // The first metric is written right after the last source.
      const fetch = async (input: string, init?: RequestInit) => {
        if (init?.method === "POST" && /\/metrics$/.test(new URL(input).pathname)) throw failure;
        return serve(input, init);
      };
      const result = await monitoringApply({ ...run.ctx, fetch });
      expect(result.exitCode, failure.name).toBe(1);
      expect(result.drift).toBe(true);
      expect(run.bs.items("sources").length).toBe(12);
      expect(run.delivered.map((d) => `${d.service} ${d.variable}`).sort()).toEqual(sourceSecrets);
      expect(result.undelivered).toEqual([]);
      const said = failure.name === "TimeoutError" ? "timed out" : "got no answer";
      expect(run.text()).toContain(
        `monitoring apply: a Better Stack call failed: POST /api/v2/sources/<id>/metrics ${said}`,
      );
      expect(run.text()).toContain(
        "stopped after: 14 created, 0 updated, 0 deleted, 0 paused, 26 secret(s) delivered",
      );
      expect(run.text()).not.toContain("fetch failed");
      expectNothingPrivate(run.text());
    }
  });

  it("retries a read once when the connection drops, and never retries a write", async () => {
    const { next } = await applied([]);
    const serve = next.bs.fetch;
    let dropped = 0;
    const fetch = async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (dropped === 0 && method === "GET") {
        dropped += 1;
        throw new TypeError("fetch failed");
      }
      return serve(input, init);
    };
    const result = await monitoringApply({ ...next.ctx, fetch });
    expect(result.exitCode).toBe(0);
    expect(dropped).toBe(1);
  });

  it("still delivers what it created when something else stops the writes, then rethrows it", async () => {
    const run = setup(["--assert-empty-team", "fin-staging"]);
    const bug = new RangeError("a fault in the run itself");
    const lines: string[] = [];
    const ctx: MonitoringContext = {
      ...run.ctx,
      stdout: {
        write: (t) => {
          if (t.startsWith("created source fin-next-staging-api")) throw bug;
          lines.push(t);
        },
      },
    };
    await expect(monitoringApply(ctx)).rejects.toBe(bug);
    expect(run.delivered.map((d) => d.service)).toEqual(["edge", "edge", "api", "api"]);
    const text = lines.join("");
    expect(text).toContain("monitoring apply: stopped by an unexpected RangeError");
    expect(text).toContain("stopped after: 4 created");
  });

  it("lists what it could not deliver when no delivery hook is given, by name only", async () => {
    const { ctx, text } = setup(["--assert-empty-team", "fin-staging"], { deliver: false });
    const result = await monitoringApply(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.undelivered).toContain("worker FIN_HEARTBEAT_SCHEDULER_WORKER_URL");
    expect(result.undelivered.some((u) => u.includes("FIN_HEARTBEAT_WATCHER_URL"))).toBe(false);
    expect(text()).toContain("not delivered");
    expectNothingPrivate(text());
  });

  it("refuses to run when monitoring:check fails", async () => {
    const { ctx, text } = setup(["--dry-run"]);
    const result = await monitoringApply({ ...ctx, root: tmp });
    expect(result.exitCode).toBe(1);
    expect(text()).toContain("monitoring apply: refused, monitoring:check has");
  });
});
