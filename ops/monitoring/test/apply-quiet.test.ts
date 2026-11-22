// MA-06 as monitoringApply wires it: in staging the plan refuses anything that routes anywhere but
// staging-quiet, and a second policy, even when files that monitoring:check would refuse (RT-01)
// reach the plan. monitoring:check is replaced here by one that finds nothing, so the plan's own
// rule is what refuses; the real check runs first in every other test (apply-run.test.ts).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type MonitoringContext,
  monitoringApply,
  planOptionsFor,
  STAGING_QUIET,
} from "../src/apply.ts";
import type * as Check from "../src/check.ts";
import { loadEnv } from "../src/config.ts";
import { buildDesired } from "../src/desired.ts";
import { FakeBetterStack } from "./fake-betterstack.ts";

// Hoisted above the imports by Vitest, so apply.ts reads this module.
vi.mock("../src/check.ts", async (load) => ({
  ...(await load<typeof Check>()),
  checkMonitoring: () => [],
}));

type Json = Record<string, unknown>;
const ROOT = join(import.meta.dirname, "..", "..", "..");
const root = mkdtempSync(join(tmpdir(), "fin-monitoring-quiet-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TELEMETRY = ["telemetry", "quiet", "token"].join("-");
const UPTIME = ["uptime", "quiet", "token"].join("-");
const HOSTS = Object.fromEntries(
  ["console", "admin", "verify", "selfie", "docs", "api"].map((r) => [r, `${r}-q.example.net`]),
);

/** A copy of the staging files with one alert routed to a second, loud policy. */
function loudRoot(): string {
  cpSync(join(ROOT, "ops", "monitoring", "staging"), join(root, "ops", "monitoring", "staging"), {
    recursive: true,
  });
  const dir = join(root, "ops", "monitoring", "staging");
  const policies = JSON.parse(readFileSync(join(dir, "policies.json"), "utf8")) as {
    policies: Json[];
  };
  const quiet = policies.policies.find((p) => p.name === STAGING_QUIET);
  policies.policies.push({ ...quiet, name: "loud" });
  writeFileSync(join(dir, "policies.json"), JSON.stringify(policies));
  const file = join(dir, "alerts", "identity.json");
  const alerts = JSON.parse(readFileSync(file, "utf8")) as { alerts: Json[] };
  const alert = alerts.alerts.find((a) => a.name === "auth-endpoint-unlisted");
  if (alert === undefined) throw new Error("no auth-endpoint-unlisted alert");
  alert.policy = "loud";
  writeFileSync(file, JSON.stringify(alerts));
  return root;
}

function numbers(at: string) {
  const { config } = loadEnv(at, "staging");
  if (config === undefined) throw new Error("no config");
  const thresholds: Record<string, number> = {};
  const grace: Record<string, number> = {};
  for (const key of buildDesired(config, { hosts: HOSTS, thresholds: {}, grace: {} }).missing) {
    const [family, name = ""] = key.split(/\.(.*)/s);
    if (family === "thresholds") thresholds[name] = 300;
    if (family === "grace") grace[name] = 30;
  }
  return { thresholds, grace };
}

describe("monitoringApply in staging (MA-06)", () => {
  it("refuses an alert routed anywhere but staging-quiet, and a second policy, writing nothing", async () => {
    const at = loudRoot();
    const bs = new FakeBetterStack({ telemetryToken: TELEMETRY, uptimeToken: UPTIME });
    const output: string[] = [];
    const ctx: MonitoringContext = {
      env: "staging",
      args: ["--assert-empty-team", "fin-staging"],
      root: at,
      hosts: HOSTS,
      zones: ["example.net"],
      ...numbers(at),
      environ: {},
      fetchAuthenticates: true,
      monitorHeader: ["quiet", "header"].join("-"),
      stdout: { write: (t) => output.push(t) },
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        const token = new URL(input).hostname === "incidents.betterstack.com" ? UPTIME : TELEMETRY;
        headers.set("authorization", `Bearer ${token}`);
        return bs.fetch(input, { ...init, headers });
      },
      now: () => new Date(Date.UTC(2026, 10, 22)),
    };
    const result = await monitoringApply(ctx);
    expect(result.outcome).toBe("refused");
    expect(result.exitCode).toBe(1);
    const text = output.join("");
    expect(text).toContain(
      "refused: MA-06 alert auth-endpoint-unlisted routes to loud; everything here routes to staging-quiet",
    );
    expect(text).toContain(
      "refused: MA-06 policy loud is defined; staging-quiet is the only policy here",
    );
    expect(bs.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("gives staging's plan the quiet policy, and no other environment's", () => {
    const base = { team: "fin-x", headerValues: true, today: "2026-11-22" };
    expect(planOptionsFor("staging", base).quietPolicy).toBe(STAGING_QUIET);
    expect(planOptionsFor("production", base).quietPolicy).toBeUndefined();
  });
});
