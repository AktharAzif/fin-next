// `pnpm fin monitoring apply <env>` end to end: pnpm fin runs ops/monitoring's own entry point as a
// real child process, and every Better Stack call goes through pnpm fin to ops/monitoring's fake
// Better Stack (no network, no token: the tokens are built at run time).

import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadEnv } from "../../monitoring/src/config.ts";
import { buildDesired } from "../../monitoring/src/desired.ts";
import { FakeBetterStack } from "../../monitoring/test/fake-betterstack.ts";
import { runCli } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import {
  type NodeChild,
  type NodeChildEvents,
  type NodeExit,
  type Runtime,
  runNodeChild,
} from "../src/core/runtime.ts";
import {
  commandEnv,
  fakeRuntime,
  fakeToken,
  overlayFixture,
  privateValues,
  REPO_ROOT,
  tempDir,
  writePrivate,
} from "./helpers/fixtures.ts";

type Json = Record<string, unknown>;

const TELEMETRY = fakeToken("bstelemetry");
const UPTIME = fakeToken("bsuptime");
const HEADER = fakeToken("monitorheader");

/** Every overlay key the staging files name, with a value: a ratio for the 5xx rates. */
function monitoringNumbers(): { thresholds: Json; grace: Json } {
  const { config } = loadEnv(REPO_ROOT, "staging");
  if (config === undefined) throw new Error("no staging files");
  const thresholds: Json = { "api-v4": 100 };
  const grace: Json = {};
  for (const key of buildDesired(config, { hosts: {}, thresholds: {}, grace: {} }).missing) {
    const [family, name = ""] = key.split(/\.(.*)/s);
    if (family === "thresholds") thresholds[name] = /^5xx-rate-(?!min)/.test(name) ? 0.05 : 300;
    if (family === "grace") grace[name] = 60;
  }
  return { thresholds, grace };
}

interface Options {
  /** Changes the overlay (with every monitoring key) before it is written. */
  overlay?: (o: Json) => void;
  /** Whether FIN_MONITOR_HEADER_FILE is set (default yes). */
  header?: boolean;
  bs?: FakeBetterStack;
  /** Wraps the fake's fetch (to change what Better Stack does). */
  fetch?: (serve: FakeBetterStack["fetch"]) => FakeBetterStack["fetch"];
  node?: Runtime["node"];
  repoRoot?: string;
}

function harness(options: Options = {}) {
  const { env, dir } = commandEnv();
  const overlay: Json = { ...overlayFixture(), ...monitoringNumbers() };
  options.overlay?.(overlay);
  env.FIN_OVERLAY_FILE = writePrivate(dir, "overlay-monitoring.json", JSON.stringify(overlay));
  env.FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE = writePrivate(dir, "telemetry", TELEMETRY);
  env.FIN_BETTERSTACK_UPTIME_TOKEN_FILE = writePrivate(dir, "uptime", UPTIME);
  if (options.header !== false) env.FIN_MONITOR_HEADER_FILE = writePrivate(dir, "header", HEADER);
  const bs = options.bs ?? new FakeBetterStack({ telemetryToken: TELEMETRY, uptimeToken: UPTIME });
  const fetch = options.fetch === undefined ? bs.fetch : options.fetch(bs.fetch);
  const runtime = fakeRuntime({
    env,
    fetch: (url, init) => fetch(url, init),
    ...(options.node === undefined ? {} : { node: options.node }),
    ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
  });
  const stateDir = join(env.FIN_STATE_DIR ?? "", "staging");
  const read = (name: string) =>
    existsSync(join(stateDir, name)) ? readFileSync(join(stateDir, name), "utf8") : "";
  const jsonLines = (text: string) =>
    text
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Json);
  return {
    bs,
    runtime,
    env,
    stateDir,
    run: (argv: string[]) => runCli(["monitoring", "apply", "staging", ...argv], runtime),
    writes: () => bs.requests.filter((r) => r.method !== "GET"),
    records: () => jsonLines(read("runs.jsonl")),
    lines: () => jsonLines(read("lines.jsonl")),
    readable: () =>
      [
        runtime.out(),
        runtime.err(),
        read("runs.jsonl"),
        read("lines.jsonl"),
        read("lock.json"),
      ].join("\n"),
  };
}

type Harness = ReturnType<typeof harness>;

/** Nothing private anywhere a person or a log can read. */
function assertNoLeak(h: Harness, extra: readonly string[] = []): void {
  const text = h.readable();
  for (const value of [...privateValues(), TELEMETRY, UPTIME, HEADER, ...extra]) {
    assert.equal(text.includes(value), false, `leaked ${value.slice(0, 6)}...`);
  }
  // What Better Stack answers with: ingest tokens, ingest hosts, heartbeat URLs.
  assert.doesNotMatch(text, /tok-(?:sources|applications)-\d+/);
  assert.doesNotMatch(text, /eu-nbg-2\.example\.com/);
  assert.doesNotMatch(text, /heartbeat\.example\.com/);
}

/** How many objects the staging files describe. */
function desiredCount(): number {
  const { config } = loadEnv(REPO_ROOT, "staging");
  if (config === undefined) throw new Error("no staging files");
  const { thresholds, grace } = monitoringNumbers();
  return buildDesired(config, {
    hosts: { console: "c", admin: "a", verify: "v", selfie: "s", docs: "d", api: "x" },
    thresholds: thresholds as Record<string, number>,
    grace: grace as Record<string, number>,
  }).objects.length;
}

describe("pnpm fin monitoring apply", () => {
  it("is listed, and runs ops/monitoring's own entry point", async () => {
    const r = fakeRuntime();
    assert.equal(await runCli(["help"], r), EXIT.ok);
    assert.match(r.out(), /monitoring apply <env>/);
    const help = fakeRuntime();
    assert.equal(await runCli(["monitoring", "apply", "staging", "--help"], help), EXIT.ok);
    assert.match(help.out(), /--dry-run/);
    assert.match(help.out(), /--assert-empty-team <value>/);
    assert.match(help.out(), /runbook: docs\/runbooks\/monitoring-drift\.md/);
  });

  it("dry-runs read-only: the difference printed and masked, no write sent, no run registered", async () => {
    const h = harness({ header: false });
    const code = await h.run(["--dry-run", "--assert-empty-team", "fin-staging"]);
    assert.equal(code, EXIT.drift, h.runtime.err());
    const out = h.runtime.out();
    assert.match(out, /monitoring apply staging \(dry run\), team fin-staging/);
    assert.match(out, /\+ policy staging-quiet/);
    assert.match(out, /\+ monitor api-health/);
    assert.match(out, /\+ alert 5xx-rate-api/);
    assert.match(out, /dry run: nothing changed \(differences found\)/);
    assert.ok(h.bs.requests.length > 0, "the dry run read Better Stack");
    assert.deepEqual(h.writes(), []);
    assert.deepEqual(h.records(), []);
    assert.equal(existsSync(join(h.stateDir, "lock.json")), false);
    const lines = h.lines();
    assert.deepEqual(
      lines.map((l) => l.event),
      ["monitoring.apply"],
    );
    assert.equal(lines[0]?.dryRun, true);
    assert.equal(lines[0]?.outcome, "dry-run");
    assert.equal(lines[0]?.drift, true);
    assertNoLeak(h);
  });

  it("refuses while any overlay key the files name has no value, a dry run and a run alike (MA-10)", async () => {
    const without = (o: Json) => {
      delete (o.thresholds as Json)["process-restarts"];
    };
    const dry = harness({ overlay: without });
    assert.equal(await dry.run(["--dry-run", "--assert-empty-team", "fin-staging"]), EXIT.refused);
    assert.match(
      dry.runtime.out(),
      /refused: MA-10 the run's settings have no value for thresholds\.process-restarts/,
    );
    assert.deepEqual(dry.writes(), []);

    const real = harness({ overlay: without });
    assert.equal(await real.run(["--assert-empty-team", "fin-staging"]), EXIT.refused);
    assert.deepEqual(real.writes(), []);
    assert.deepEqual(real.records(), [], "a refused plan registers no run");
    assert.equal(real.lines().at(-1)?.outcome, "refused");

    // Written into the overlay, the key lets the plan through.
    const fixed = harness();
    assert.equal(await fixed.run(["--dry-run", "--assert-empty-team", "fin-staging"]), EXIT.drift);
    assert.doesNotMatch(fixed.runtime.out(), /MA-10/);
  });

  it("applies inside a registered run, records every write, and reads everything back", async () => {
    let registeredFirst: boolean | undefined;
    const h: Harness = harness({
      fetch: (serve) => async (url, init) => {
        if (registeredFirst === undefined && (init?.method ?? "GET") !== "GET") {
          registeredFirst = h.records().some((r) => r.event === "run.registered");
        }
        return serve(url, init);
      },
    });
    const code = await h.run(["--assert-empty-team", "fin-staging"]);
    assert.equal(code, EXIT.ok, h.runtime.err());
    assert.equal(registeredFirst, true, "run.registered before the first write");
    const writes = h.writes().length;
    assert.ok(writes > 100, `${writes} writes`);

    const records = h.records();
    assert.equal(records[0]?.event, "run.registered");
    assert.equal(records[0]?.command, "monitoring apply");
    assert.ok((((records[0]?.plan ?? {}) as Json).create as number) > 100);
    const steps = records.filter((r) => r.event === "run.step");
    assert.equal(steps.length, writes, "one run.step per write");
    assert.ok(steps.some((s) => s.kind === "policy" && s.name === "staging-quiet"));
    const done = records.at(-1);
    assert.equal(done?.event, "run.done");
    assert.equal(done?.result, "ok");
    assert.equal(done?.steps, writes);
    const compared = desiredCount();
    assert.deepEqual(done?.readBack, { compared, mismatched: [] });

    const out = h.runtime.out();
    assert.match(out, new RegExp(`read back: ${compared} object\\(s\\) compared, every one as`));
    // The secrets Better Stack made wait for --redeliver: named, never printed.
    assert.match(out, /not delivered/);
    const line = h.lines().find((l) => l.event === "monitoring.apply");
    assert.equal(line?.outcome, "applied");
    assert.equal(line?.readBackCompared, compared);
    assert.deepEqual(line?.readBackMismatched, []);
    assert.deepEqual(
      h.lines().map((l) => l.event),
      ["run.registered", "monitoring.apply", "run.done"],
    );
    assertNoLeak(h);

    // The next dry run finds nothing to change.
    const again = harness({ bs: h.bs });
    assert.equal(await again.run(["--dry-run"]), EXIT.ok, again.runtime.out());
    assert.match(again.runtime.out(), /dry run: nothing changed$/m);
  });

  it("fails a run whose read-back differs, naming the object and the part, never a value", async () => {
    const h = harness({
      // Better Stack takes the alert but keeps another threshold than the one sent.
      fetch: (serve) => async (url, init) => {
        const response = await serve(url, init);
        if (init?.method === "POST" && /\/alerts$/.test(new URL(url).pathname)) {
          const sent = JSON.parse(String(init.body)) as Json;
          if (sent.name === "process-restarts") {
            const item = h.bs.items("alerts").find((i) => i.attributes.name === "process-restarts");
            if (item !== undefined) item.attributes.value = 987_654;
          }
        }
        return response;
      },
    });
    assert.equal(await h.run(["--assert-empty-team", "fin-staging"]), EXIT.drift);
    const out = h.runtime.out();
    assert.match(out, /read back: 1 difference\(s\) from the files after the writes/);
    assert.match(out, /alert process-restarts: differs in value/);
    assert.equal(h.readable().includes("987654"), false);
    const done = h.records().at(-1);
    assert.equal(done?.result, "failed");
    assert.deepEqual(((done?.readBack ?? {}) as Json).mismatched, ["alert:process-restarts"]);
    const line = h.lines().find((l) => l.event === "monitoring.apply");
    assert.equal(line?.outcome, "mismatch");
    assert.equal(line?.level, "error");
  });

  it("prints a changed private number by its role, never its value", async () => {
    const first = harness();
    assert.equal(await first.run(["--assert-empty-team", "fin-staging"]), EXIT.ok);
    const changed = harness({
      bs: first.bs,
      overlay: (o) => {
        (o.thresholds as Json)["process-restarts"] = 4_321;
        (o.grace as Json).watcher = 97;
      },
    });
    assert.equal(await changed.run(["--dry-run"]), EXIT.drift);
    const out = changed.runtime.out();
    assert.match(
      out,
      /^~ alert process-restarts: value \(not shown\) -> <threshold:process-restarts>$/m,
    );
    assert.match(out, /^~ heartbeat watcher: grace \(not shown\) -> <grace:watcher>$/m);
    assert.equal(out.includes("4321"), false);
    assert.doesNotMatch(out, /\b97\b/);
  });

  it("keeps staging quiet: an alert that routes anywhere but staging-quiet is refused, nothing sent", async () => {
    const root = tempDir("fin-monitoring-root-");
    for (const dir of [
      ["ops", "monitoring"],
      ["ops", "watcher", "settings"],
      ["ops", "environments"],
      ["docs", "runbooks"],
    ]) {
      cpSync(join(REPO_ROOT, ...dir), join(root, ...dir), {
        recursive: true,
        filter: (source) => !source.includes("node_modules"),
      });
    }
    const file = join(root, "ops", "monitoring", "staging", "alerts", "platform.json");
    const json = JSON.parse(readFileSync(file, "utf8")) as { alerts: Json[] };
    const alert = json.alerts.find((a) => a.name === "process-restarts");
    if (alert === undefined) throw new Error("no process-restarts alert");
    alert.policy = "loud";
    writeFileSync(file, JSON.stringify(json));
    const h = harness({ repoRoot: root });
    assert.equal(await h.run(["--assert-empty-team", "fin-staging"]), EXIT.refused);
    assert.match(h.runtime.out(), /RT-01.*process-restarts.*routes to loud/);
    assert.deepEqual(h.bs.requests, [], "refused before Better Stack is read");
    assert.deepEqual(h.records(), []);
  });

  it("gives the child no token, and nothing private in its argv or environment", async () => {
    const sent: unknown[] = [];
    let script = "";
    const h = harness({
      node: (path, events) => {
        script = path;
        const child = runNodeChild(path, events);
        return {
          ...child,
          send: (message) => {
            sent.push(message);
            return child.send(message);
          },
        };
      },
    });
    assert.equal(await h.run(["--dry-run", "--assert-empty-team", "fin-staging"]), EXIT.drift);
    assert.equal(script, join(REPO_ROOT, "ops", "monitoring", "src", "apply-cli.ts"));
    const text = JSON.stringify(sent);
    assert.equal(text.includes(TELEMETRY), false);
    assert.equal(text.includes(UPTIME), false);
    assert.equal(text.includes("Bearer"), false);
    // The child's own process: no argument, no variable, no inherited Node flag.
    const dir = tempDir("fin-node-child-");
    const probe = join(dir, "probe.mjs");
    writeFileSync(
      probe,
      "process.send({ argv: process.argv.slice(2), env: Object.keys(process.env), execArgv: process.execArgv }, () => process.disconnect());\n",
    );
    const seen: Json[] = [];
    const child = runNodeChild(probe, {
      message: (m) => seen.push(m as Json),
      output: () => undefined,
    });
    assert.deepEqual(await child.exited, { code: 0, signal: null });
    // macOS adds its own text-encoding variable to every process; nothing else is there.
    const env = ((seen[0]?.env ?? []) as string[]).filter(
      (name) => name !== "__CF_USER_TEXT_ENCODING",
    );
    assert.deepEqual({ ...seen[0], env }, { argv: [], env: [], execArgv: [] });
  });
});

/** A stand-in child that sends `script`'s messages and reads the answers. */
function scripted(
  script: (send: (message: Json) => void, answers: Json[]) => Promise<void>,
): Runtime["node"] {
  return (_path: string, events: NodeChildEvents): NodeChild => {
    const exited = Promise.withResolvers<NodeExit>();
    const answers: Json[] = [];
    // As apply-cli.ts does: it says it is ready once it listens.
    queueMicrotask(() => events.message({ t: "ready" }));
    return {
      send: (message) => {
        const m = message as Json;
        if (m.t === "start") {
          void script((x) => events.message(x), answers).then(() =>
            exited.resolve({ code: 0, signal: null }),
          );
        } else answers.push(m);
        return true;
      },
      kill: () => exited.resolve({ code: null, signal: "SIGTERM" }),
      exited: exited.promise,
    };
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const RESULT = {
  outcome: "dry-run",
  dryRun: true,
  drift: false,
  created: 0,
  updated: 0,
  deleted: 0,
  paused: 0,
  delivered: 0,
  undelivered: [],
  refusals: 0,
};

describe("pnpm fin monitoring apply: what pnpm fin will not send", () => {
  it("refuses another host, a write in a dry run, and a write the child did not name", async () => {
    const answers: Json[] = [];
    const h = harness({
      header: false,
      node: scripted(async (send, seen) => {
        send({ t: "fetch", id: 1, method: "GET", url: "https://example.com/api/v3/sources" });
        send({
          t: "fetch",
          id: 2,
          method: "POST",
          url: "https://telemetry.betterstack.com/api/v3/sources",
          body: "{}",
        });
        send({ t: "register", id: 3, plan: { create: 1 } });
        for (let i = 0; i < 20 && seen.length < 3; i++) await tick();
        answers.push(...seen);
        send({ t: "result", result: RESULT });
      }),
    });
    assert.equal(await h.run(["--dry-run"]), EXIT.refused);
    assert.deepEqual(h.bs.requests, []);
    const byId = new Map(answers.map((a) => [a.id, a]));
    assert.equal(byId.get(1)?.error, "refused");
    assert.equal(byId.get(2)?.error, "refused");
    assert.match(String(byId.get(3)?.error), /a dry run registers no run/);
    const err = h.runtime.err();
    assert.match(err, /a call to a host other than Better Stack's APIs/);
    assert.match(err, /a write in a dry run/);
    assert.deepEqual(h.records(), []);

    const unnamed = harness({
      node: scripted(async (send, seen) => {
        send({ t: "register", id: 1, plan: { create: 1 } });
        for (let i = 0; i < 20 && seen.length < 1; i++) await tick();
        send({
          t: "fetch",
          id: 2,
          method: "POST",
          url: "https://telemetry.betterstack.com/api/v3/sources",
          body: "{}",
        });
        for (let i = 0; i < 20 && seen.length < 2; i++) await tick();
        send({ t: "result", result: { ...RESULT, outcome: "stopped", dryRun: false } });
      }),
    });
    assert.equal(await unnamed.run([]), EXIT.refused);
    assert.deepEqual(unnamed.writes(), []);
    assert.match(unnamed.runtime.err(), /a write the apply did not name first/);
    assert.equal(unnamed.records().at(-1)?.result, "failed");
  });

  it("fails, sending nothing, when the child ends before it is ready or without a result", async () => {
    const early = harness({
      node: () => ({
        send: () => true,
        kill: () => undefined,
        exited: Promise.resolve({ code: 1, signal: null }),
      }),
    });
    assert.equal(await early.run(["--dry-run"]), EXIT.internal);
    assert.match(early.runtime.err(), /the apply process ended before it was ready/);
    assert.deepEqual(early.bs.requests, []);

    const silent = harness({ node: scripted(async () => undefined) });
    assert.equal(await silent.run(["--dry-run"]), EXIT.internal);
    assert.match(silent.runtime.err(), /ended with exit 0 without a result/);
    assert.equal(silent.lines().at(-1)?.outcome, "error");
  });

  it("sends no write once the run is stopped, and keeps the stop's exit code", async () => {
    const h: Harness = harness({
      node: scripted(async (send, seen) => {
        send({ t: "register", id: 1, plan: { create: 2 } });
        for (let i = 0; i < 20 && seen.length < 1; i++) await tick();
        send({ t: "change", op: "create", kind: "urgency", key: "quiet" });
        send({
          t: "fetch",
          id: 2,
          method: "POST",
          url: "https://incidents.betterstack.com/api/v2/urgencies",
          body: JSON.stringify({ name: "quiet" }),
        });
        for (let i = 0; i < 20 && seen.length < 2; i++) await tick();
        send({ t: "changed", op: "create", kind: "urgency", key: "quiet", ok: true });
        await h.runtime.interrupt("SIGINT");
        send({ t: "change", op: "create", kind: "policy", key: "staging-quiet" });
        send({
          t: "fetch",
          id: 3,
          method: "POST",
          url: "https://incidents.betterstack.com/api/v2/policies",
          body: "{}",
        });
        for (let i = 0; i < 20 && seen.length < 3; i++) await tick();
        send({ t: "result", result: { ...RESULT, outcome: "stopped", dryRun: false, created: 1 } });
      }),
    });
    assert.equal(await h.run([]), EXIT.interrupted);
    assert.deepEqual(
      h.writes().map((w) => w.path),
      ["/api/v2/urgencies"],
    );
    const steps = h.records().filter((r) => r.event === "run.step");
    assert.deepEqual(
      steps.map((s) => `${s.kind}:${s.name}`),
      ["urgency:quiet"],
    );
    const done = h.records().at(-1);
    assert.equal(done?.event, "run.done");
    assert.equal(done?.result, "failed");
    assert.equal(done?.interrupted, "SIGINT");
    assert.match(h.runtime.err(), /the run was stopped/);
  });
});
