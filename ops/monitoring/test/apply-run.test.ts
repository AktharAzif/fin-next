// The apply as pnpm fin runs it (apply-cli.ts): a fetch that authenticates for it, the run's hooks
// around every write, the read-back after the writes, staging's one quiet policy, and the
// overlay's numbers never printed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type MonitoringContext,
  monitoringApply,
  type PlanCounts,
  STAGING_QUIET,
  type WriteChange,
} from "../src/apply.ts";
import { type Channel, type ChildMessage, parseStart, runOverChannel } from "../src/apply-cli.ts";
import { BetterStackClient, PATHS } from "../src/betterstack.ts";
import { loadEnv } from "../src/config.ts";
import { buildDesired, type DesiredObject, ref } from "../src/desired.ts";
import { makePlan, type Remote } from "../src/plan.ts";
import { FakeBetterStack } from "./fake-betterstack.ts";

type Json = Record<string, unknown>;
const ROOT = join(import.meta.dirname, "..", "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "fin-monitoring-run-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const TELEMETRY = ["telemetry", "run", "token"].join("-");
const UPTIME = ["uptime", "run", "token"].join("-");
const HEADER = ["monitor", "run", "header"].join("-");
const ZONE = "example.net";
const HOSTS = Object.fromEntries(
  ["console", "admin", "verify", "selfie", "docs", "api"].map((r) => [r, `${r}-y.${ZONE}`]),
);

function numbers(): { thresholds: Record<string, number>; grace: Record<string, number> } {
  const { config } = loadEnv(ROOT, "staging");
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

/** A context as apply-cli.ts builds one: no token file, a fetch that authenticates for it. */
function forwarded(args: string[], bs = fake(), serve: FakeBetterStack["fetch"] = bs.fetch) {
  const output: string[] = [];
  const calls: { method: string; authorization: string | null }[] = [];
  const counts: PlanCounts[] = [];
  const changes: WriteChange[] = [];
  const writesBefore: number[] = [];
  const authenticate = async (input: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const product = new URL(input).hostname === "incidents.betterstack.com" ? UPTIME : TELEMETRY;
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${product}`);
    return serve(input, { ...init, headers });
  };
  const ctx: MonitoringContext = {
    env: "staging",
    args,
    root: ROOT,
    hosts: HOSTS,
    zones: [ZONE],
    ...numbers(),
    environ: {},
    fetchAuthenticates: true,
    monitorHeader: HEADER,
    stdout: { write: (t) => output.push(t) },
    fetch: authenticate,
    now: () => new Date(Date.UTC(2026, 10, 22)),
    hooks: {
      async beforeWrites(plan) {
        counts.push(plan);
        writesBefore.push(bs.requests.filter((r) => r.method !== "GET").length);
      },
      async writing(change, send) {
        changes.push(change);
        return send();
      },
    },
  };
  return { bs, ctx, output, calls, counts, changes, writesBefore, text: () => output.join("") };
}

function fake() {
  return new FakeBetterStack({ telemetryToken: TELEMETRY, uptimeToken: UPTIME });
}

const writes = (bs: FakeBetterStack) => bs.requests.filter((r) => r.method !== "GET");

describe("monitoring apply under pnpm fin", () => {
  it("reads no token file and sends no token of its own: the fetch authenticates", async () => {
    const run = forwarded(["--dry-run", "--assert-empty-team", "fin-staging"]);
    const result = await monitoringApply(run.ctx);
    expect(result.outcome).toBe("dry-run");
    expect(run.calls.length).toBeGreaterThan(0);
    expect(run.calls.every((c) => c.authorization === null)).toBe(true);
    expect(writes(run.bs)).toEqual([]);
    expect(run.counts).toEqual([]);
  });

  it("tells the run before the first write, and names every write", async () => {
    const run = forwarded(["--assert-empty-team", "fin-staging"]);
    const result = await monitoringApply(run.ctx);
    expect(result.outcome).toBe("applied");
    expect(run.counts).toHaveLength(1);
    expect(run.writesBefore).toEqual([0]);
    const made = writes(run.bs).length;
    expect(run.counts[0]?.create).toBe(made);
    expect(run.changes).toHaveLength(made);
    expect(run.changes[0]).toEqual({ op: "create", kind: "urgency", key: "quiet" });

    // A run with nothing to write registers nothing.
    const again = forwarded([], run.bs);
    const second = await monitoringApply(again.ctx);
    expect(second.outcome).toBe("unchanged");
    expect(again.counts).toEqual([]);
    expect(second.readBack).toBeUndefined();
  });

  it("writes nothing when the run cannot register", async () => {
    const run = forwarded(["--assert-empty-team", "fin-staging"]);
    const refusing: MonitoringContext = {
      ...run.ctx,
      hooks: {
        beforeWrites: async () => {
          throw new Error("another run holds the lock");
        },
        writing: (_change, send) => send(),
      },
    };
    await expect(monitoringApply(refusing)).rejects.toThrow(/another run holds the lock/);
    expect(writes(run.bs)).toEqual([]);
  });

  it("reads everything back after the writes, and passes only when all of it is as the files say", async () => {
    const run = forwarded(["--assert-empty-team", "fin-staging"]);
    const result = await monitoringApply(run.ctx);
    const { config } = loadEnv(ROOT, "staging");
    if (config === undefined) throw new Error("no config");
    const count = buildDesired(config, { hosts: HOSTS, ...numbers() }).objects.length;
    expect(result.exitCode).toBe(0);
    expect(result.readBack).toEqual({ compared: count, mismatched: [] });
    expect(run.text()).toContain(
      `read back: ${count} object(s) compared, every one as the files say`,
    );
  });

  it("fails a read-back that differs, naming objects and parts only", async () => {
    const bs = fake();
    // Better Stack answers every create, but keeps a monitor without its keyword and loses one
    // heartbeat altogether.
    const serve = async (input: string, init?: RequestInit) => {
      const response = await bs.fetch(input, init);
      if (init?.method === "POST") {
        const path = new URL(input).pathname;
        const sent = JSON.parse(String(init.body)) as Json;
        if (path === PATHS.monitors && sent.pronounceable_name === "console-sign-in") {
          const item = bs
            .items("monitors")
            .find((i) => i.attributes.pronounceable_name === "console-sign-in");
          if (item !== undefined) item.attributes.required_keyword = "something-else";
        }
        if (path === PATHS.heartbeats && sent.name === "watcher") {
          bs.store.set(
            "heartbeats",
            bs.items("heartbeats").filter((i) => i.attributes.name !== "watcher"),
          );
        }
      }
      return response;
    };
    const run = forwarded(["--assert-empty-team", "fin-staging"], bs, serve);
    const result = await monitoringApply(run.ctx);
    expect(result.outcome).toBe("mismatch");
    expect(result.exitCode).toBe(1);
    expect(result.drift).toBe(true);
    expect(result.readBack?.mismatched).toEqual(["monitor:console-sign-in", "heartbeat:watcher"]);
    expect(run.text()).toContain("monitor console-sign-in: differs in required_keyword");
    expect(run.text()).toContain("heartbeat watcher: missing");
    expect(run.text()).not.toContain("something-else");
    expect(run.text()).not.toContain(ZONE);
  });
});

describe("staging stays quiet (MA-06)", () => {
  const emptyRemote = (): Remote => ({
    objects: new Map(),
    teams: { telemetry: new Set(["fin-staging"]), uptime: new Set(["fin-staging"]) },
    counts: { telemetry: 1, uptime: 1 },
    policies: [],
    extraPolicies: [],
    urgenciesById: new Map(),
    unmanagedAlerts: [],
    strays: [],
    duplicates: [],
  });
  const options = { team: "fin-staging", headerValues: true, today: "2026-11-22" };
  const routed = (kind: "alert" | "monitor" | "heartbeat", policy: string): DesiredObject =>
    kind === "alert"
      ? {
          kind,
          key: "a",
          parent: "fin/a",
          body: { name: "a", escalation_target: { policy_id: ref("policy", policy, "number") } },
        }
      : { kind, key: "m", body: { name: "m", policy_id: ref("policy", policy) } };

  it("refuses an alert, monitor or heartbeat that routes anywhere but staging-quiet", () => {
    for (const kind of ["alert", "monitor", "heartbeat"] as const) {
      const desired = { objects: [routed(kind, "loud")], missing: [] };
      const plan = makePlan(desired, emptyRemote(), { ...options, quietPolicy: STAGING_QUIET });
      expect(plan.refusals, kind).toContain(
        `MA-06 ${kind} ${kind === "alert" ? "a" : "m"} routes to loud; everything here routes to staging-quiet`,
      );
      const quiet = { objects: [routed(kind, STAGING_QUIET)], missing: [] };
      expect(
        makePlan(quiet, emptyRemote(), { ...options, quietPolicy: STAGING_QUIET }).refusals,
      ).toEqual([]);
    }
  });

  it("refuses one with no policy, and a second policy in the files", () => {
    const desired = {
      objects: [
        { kind: "monitor", key: "m", body: { name: "m" } },
        { kind: "policy", key: "page-someone", body: { name: "page-someone" } },
      ] as DesiredObject[],
      missing: [],
    };
    const plan = makePlan(desired, emptyRemote(), { ...options, quietPolicy: STAGING_QUIET });
    expect(plan.refusals).toContain(
      "MA-06 monitor m routes to no policy; everything here routes to staging-quiet",
    );
    expect(plan.refusals).toContain(
      "MA-06 policy page-someone is defined; staging-quiet is the only policy here",
    );
  });

  it("holds the staging files as they are", async () => {
    const run = forwarded(["--dry-run", "--assert-empty-team", "fin-staging"]);
    const result = await monitoringApply(run.ctx);
    expect(result.refusals).toBe(0);
    expect(run.text()).not.toContain("MA-06");
  });
});

describe("the overlay's numbers are never printed", () => {
  it("shows a changed threshold, window or grace period by its placeholder", async () => {
    const first = forwarded(["--assert-empty-team", "fin-staging"]);
    expect((await monitoringApply(first.ctx)).outcome).toBe("applied");
    const next = forwarded(["--dry-run"], first.bs);
    const { thresholds, grace } = numbers();
    const changed: MonitoringContext = {
      ...next.ctx,
      thresholds: {
        ...thresholds,
        "clock-skew": 4321,
        "no-logs-api": 5432,
        "5xx-rate-min-count": 6543,
      },
      grace: { ...grace, watcher: 7654 },
    };
    await monitoringApply(changed);
    const text = next.text();
    expect(text).toContain("~ alert clock-skew: value (not shown) -> <threshold:clock-skew>");
    expect(text).toContain(
      "~ alert no-logs-api: query_period (not shown) -> <threshold:no-logs-api>",
    );
    expect(text).toContain("~ heartbeat watcher: grace (not shown) -> <grace:watcher>");
    expect(text).toMatch(
      /~ exploration fin\/5xx-rate-api: query \(not shown\) -> \(a query with <threshold:5xx-rate-min-count>\)/,
    );
    for (const n of ["4321", "5432", "6543", "7654"]) expect(text).not.toContain(n);
  });
});

describe("apply-cli.ts, the entry point pnpm fin runs", () => {
  /** A channel that answers each fetch from the fake, as pnpm fin forwards it. */
  function channel(bs: FakeBetterStack, start: Json) {
    const sent: ChildMessage[] = [];
    let listener: (message: unknown) => void = () => undefined;
    const ch: Channel = {
      send(message) {
        sent.push(message);
        if (message.t === "fetch") {
          const token =
            new URL(message.url).hostname === "incidents.betterstack.com" ? UPTIME : TELEMETRY;
          void bs
            .fetch(message.url, {
              method: message.method,
              headers: { authorization: `Bearer ${token}` },
              ...(message.body === undefined ? {} : { body: message.body }),
            })
            .then(async (r) =>
              listener({ t: "response", id: message.id, status: r.status, body: await r.text() }),
            );
        }
        if (message.t === "register") listener({ t: "ack", id: message.id });
        // As pnpm fin does: the start message only once the child listens.
        if (message.t === "ready") listener(start);
      },
      onMessage(l) {
        listener = l;
      },
    };
    return { ch, sent };
  }

  const start = (args: string[]): Json => ({
    t: "start",
    env: "staging",
    args,
    root: ROOT,
    hosts: HOSTS,
    zones: [ZONE],
    ...numbers(),
    monitorHeader: HEADER,
    now: "2026-11-22T06:00:00.000Z",
  });

  it("runs an apply over the channel: output, fetches, registration, each write named, the result", async () => {
    const bs = fake();
    const { ch, sent } = channel(bs, start(["--assert-empty-team", "fin-staging"]));
    expect(await runOverChannel(ch)).toBe(0);
    expect(sent[0]).toEqual({ t: "ready" });
    const kinds = new Set(sent.map((m) => m.t));
    expect([...kinds].sort()).toEqual([
      "change",
      "changed",
      "fetch",
      "out",
      "ready",
      "register",
      "result",
    ]);
    const result = sent.find((m) => m.t === "result");
    expect(result?.t === "result" && result.result.outcome).toBe("applied");
    const firstWrite = sent.findIndex((m) => m.t === "fetch" && m.method !== "GET");
    expect(sent.findIndex((m) => m.t === "register")).toBeLessThan(firstWrite);
    expect(sent[firstWrite - 1]).toEqual({
      t: "change",
      op: "create",
      kind: "urgency",
      key: "quiet",
    });
    // The output is masked here too, and no message carries a token.
    const text = JSON.stringify(sent.filter((m) => m.t !== "fetch"));
    expect(text).not.toContain(ZONE);
    expect(JSON.stringify(sent)).not.toContain(TELEMETRY);
  });

  it("reports a thrown error by name and masked message, and refuses a malformed start", async () => {
    const { ch, sent } = channel(fake(), start(["--no-such-flag"]));
    expect(await runOverChannel(ch)).toBe(1);
    expect(sent.at(-1)).toEqual({
      t: "error",
      name: "UsageError",
      message: "unknown argument --no-such-flag",
    });

    const bad = channel(fake(), { t: "start", env: "staging" });
    expect(await runOverChannel(bad.ch)).toBe(64);
    expect(bad.sent).toEqual([
      { t: "ready" },
      { t: "error", name: "UsageError", message: "the start message is malformed" },
    ]);
    expect(parseStart({ ...start([]), thresholds: { a: "300" } })).toBeUndefined();
    expect(parseStart({ ...start([]), now: "yesterday" })).toBeUndefined();
    expect(parseStart(start([]))?.env).toBe("staging");
  });

  it("refuses to run without pnpm fin's channel", () => {
    const run = spawnSync(
      process.execPath,
      [join(ROOT, "ops", "monitoring", "src", "apply-cli.ts")],
      {
        encoding: "utf8",
        env: {},
      },
    );
    expect(run.status).toBe(64);
    expect(run.stderr).toContain("runs only under pnpm fin monitoring apply <env>");
  });
});

describe("the Better Stack client without a token", () => {
  it("sends no Authorization header, so the forwarding fetch adds the team's", async () => {
    const seen: (string | null)[] = [];
    const client = new BetterStackClient("uptime", undefined, async (_input, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ data: [], pagination: { next: null } }));
    });
    await client.list(PATHS.monitors);
    expect(seen).toEqual([null]);
    expect(() => new BetterStackClient("uptime", " ", fetch)).toThrow(/empty or malformed/);
  });
});
