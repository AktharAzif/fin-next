import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { loadEnv } from "../src/config.ts";
import { buildDesired } from "../src/desired.ts";
import { FakeBetterStack } from "./fake-betterstack.ts";

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

function setup(args: string[], options: { team?: string; deliver?: boolean } = {}) {
  const bs = new FakeBetterStack({
    telemetryToken: TELEMETRY,
    uptimeToken: UPTIME,
    ...(options.team === undefined ? {} : { team: options.team }),
  });
  const output: string[] = [];
  const delivered: SecretDelivery[] = [];
  const ctx: MonitoringContext = {
    env: "staging",
    args,
    root: ROOT,
    hosts: HOSTS,
    ...overlay(),
    environ,
    stdout: { write: (t) => output.push(t) },
    fetch: bs.fetch,
    now: () => new Date(Date.UTC(2026, 10, 21)),
    ...(options.deliver === false
      ? {}
      : {
          deliver: async (s: SecretDelivery) => {
            delivered.push(s);
          },
        }),
  };
  return { bs, ctx, output, delivered, text: () => output.join("") };
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

    // Secrets go to their services and never to the output.
    expect(first.delivered).toContainEqual({
      service: "watcher",
      variable: "FIN_HEARTBEAT_WATCHER_URL",
      value: expect.stringMatching(/^https:\/\/heartbeat\.example\.com\//),
    });
    expect(
      first.delivered.filter((d) => d.variable === "FIN_TELEMETRY_TOKEN").map((d) => d.service),
    ).toContain("cloudflared-admin-b");
    expect(
      first.delivered.find((d) => d.service === "edge" && d.variable === "FIN_DOCS_ERRORS_DSN")
        ?.value,
    ).toMatch(/^https:\/\/tok-applications-\d+@s\d+\.eu-nbg-2\.example\.com\/1$/);
    expect(first.delivered.some((d) => d.service === "ops")).toBe(true); // verify-daily's URL
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

  it("caps deletions without --confirm-delete equal to their number (MA-03)", async () => {
    const { bs, ctx, text } = setup(["--assert-empty-team", "fin-staging"]);
    for (const n of [1, 2, 3, 4])
      bs.seed("monitors", { pronounceable_name: `old-${n}`, url: "https://x.example.com" });
    const refused = await monitoringApply(ctx);
    expect(refused.exitCode).toBe(1);
    expect(text()).toContain(
      "refused: MA-03 this run would delete 4 objects; pass --confirm-delete 4",
    );
    expect(writes(bs)).toEqual([]);

    const wrong = setup(["--assert-empty-team", "fin-staging", "--confirm-delete", "3"]);
    for (const n of [1, 2, 3, 4]) wrong.bs.seed("monitors", { pronounceable_name: `old-${n}` });
    expect((await monitoringApply(wrong.ctx)).exitCode).toBe(1);
    expect(wrong.text()).toContain("MA-03 --confirm-delete 3 does not match the 4 deletion(s)");

    const confirmed = setup(["--assert-empty-team", "fin-staging", "--confirm-delete", "4"]);
    for (const n of [1, 2, 3, 4]) confirmed.bs.seed("monitors", { pronounceable_name: `old-${n}` });
    const result = await monitoringApply(confirmed.ctx);
    expect(result.exitCode).toBe(0);
    expect(result.deleted).toBe(4);
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

  it("lists what it could not deliver when no delivery hook is given, by name only", async () => {
    const { ctx, text } = setup(["--assert-empty-team", "fin-staging"], { deliver: false });
    const result = await monitoringApply(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.undelivered).toContain("watcher FIN_HEARTBEAT_WATCHER_URL");
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
