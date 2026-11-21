// The minimal doctor (spec 07 §4.7: D1, D2, D4, D5; T-RV-44's failure paths) with fakes.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DOCTOR_FLAGS_USED, DOCTOR_PROMPT, configEnvKeys, missingFlags } from "../src/doctor.ts";
import type { DoctorServices } from "../src/doctor.ts";
import type { RunOutcome } from "../src/exec.ts";
import { loadCommittedModels } from "../src/options.ts";
import { RUNNER_FLAGS } from "../src/runner/cli.ts";
import type { CliRunnerOptions } from "../src/runner/cli.ts";
import { fakeSessionStream } from "../src/runner/fake.ts";
import type { SessionSpec } from "../src/runner/types.ts";
import { TOOL_ROOT } from "./helpers/cli.ts";
import { countingRandom, fakeClock, readJson, reviewFixture, runFixtureCli } from "./helpers/review-fixture.ts";
import type { ReviewFixture } from "./helpers/review-fixture.ts";

const MODELS = loadCommittedModels();
const HELP = `Usage: claude [options]\n  -p, --print  Print\n${[...RUNNER_FLAGS, ...DOCTOR_FLAGS_USED].filter((flag) => flag !== "-p").map((flag) => `  ${flag} <x>  text`).join("\n")}\n    (choices: "text", "json", "stream-json")\n`;

/** What 2.1.328's debug log says when it applied no env from its configuration. */
const CLEAN_LOG = "2026-11-21T10:00:00.000Z [DEBUG] CA certs: Config fallback - globalEnv keys: , settingsEnv keys: none\n";

/**
 * The pinned CLI's answers: its version, its help, and for -p with no input, the no-input error;
 * with --debug-file, it first writes `log` there (D3's probe).
 */
function fakeClaude(args: readonly string[], version = "2.1.328", help = HELP, log: string | null = CLEAN_LOG) {
  if (args[0] === "--version") return { code: 0, stdout: `${version} (Claude Code)\n`, stderr: "" };
  if (args[0] === "--help") return { code: 0, stdout: help, stderr: "" };
  const debugFile = args.includes("--debug-file") ? args[args.indexOf("--debug-file") + 1] : undefined;
  if (debugFile !== undefined && log !== null) writeFileSync(debugFile, log);
  const schema = args[args.indexOf("--json-schema") + 1] ?? "";
  if (schema.includes("$schema")) return { code: 1, stdout: "", stderr: 'Error: --json-schema is not a valid JSON Schema: no schema with key or ref "x"\n' };
  return { code: 1, stdout: "", stderr: "Error: Input must be provided either through stdin or as a prompt argument when using --print\n" };
}

function services(overrides: Partial<DoctorServices> = {}): DoctorServices & { started: SessionSpec[] } {
  const started: SessionSpec[] = [];
  return {
    started,
    clock: fakeClock(),
    random: countingRandom(),
    runClaude: async (_path, args) => fakeClaude(args),
    startSession: async (spec): Promise<RunOutcome> => {
      started.push(spec);
      return { kind: "exited", code: 0, signal: null, stdout: Buffer.from(fakeSessionStream(spec, { kind: "result", output: { answer: "ready" } })), stderr: Buffer.alloc(0) };
    },
    ...overrides,
  };
}

describe("doctor", () => {
  let fx: ReviewFixture;
  before(() => {
    fx = reviewFixture();
  });
  after(() => fx.cleanup());

  it("without --live: D1, D2 and D4 pass, D5 is skipped, no session starts; doctor.json records it", async () => {
    const s = services();
    const run = await runFixtureCli(fx, ["doctor"], s);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^D1 pass: claude 2\.1\.328 equals the pin/m);
    assert.match(run.stdout, /^D2 pass: all 18 runner flags and the output format "stream-json" are in --help; replaced: --max-turns, --append-system-prompt-file; --json-schema accepts all 14 schemas$/m);
    assert.match(run.stdout, /^D4 pass: /m);
    assert.match(run.stdout, /^D5 skipped: /m);
    assert.equal(s.started.length, 0);
    const doc = readJson(join(fx.home, "state", "doctor.json"));
    assert.equal(doc["passed"], false);
    assert.equal(doc["live"], false);
    assert.equal(doc["clientVersion"], "2.1.328");
  });

  it("with --live: one locked session per model at high, 0.50 USD, answering ready with only its own model", async () => {
    const s = services();
    const run = await runFixtureCli(fx, ["doctor", "--live"], s);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^D5 pass: /m);
    assert.deepEqual(s.started.map((spec) => spec.modelId), [MODELS.opus, MODELS.fable]);
    for (const spec of s.started) {
      assert.equal(spec.effort, "high");
      assert.equal(spec.maxBudgetUsd, 0.5);
      assert.equal(spec.prompt, DOCTOR_PROMPT);
      assert.equal(spec.role, "doctor");
    }
    const doc = readJson(join(fx.home, "state", "doctor.json"));
    assert.equal(doc["passed"], true);
    const d5 = (doc["checks"] as Array<Record<string, unknown>>).find((check) => check["id"] === "D5");
    const fields = ((d5?.["data"] as Array<Record<string, unknown>>)[0]?.["resultFields"] as string[]) ?? [];
    assert.ok(fields.includes("modelUsage") && fields.includes("total_cost_usd") && fields.includes("structured_output"));
  });

  it("D5 fails when modelUsage names a second model, or the answer is not ready", async () => {
    const mismatch = services({
      startSession: async (spec) => ({ kind: "exited", code: 0, signal: null, stdout: Buffer.from(fakeSessionStream(spec, { kind: "result", output: { answer: "ready" }, models: [spec.modelId, "claude-haiku-9-9"] })), stderr: Buffer.alloc(0) }),
    });
    const bad = await runFixtureCli(fx, ["doctor", "--live"], mismatch);
    assert.equal(bad.code, 78);
    assert.match(bad.stdout, /^D5 fail: .*model_mismatch/m);
    // Served by another model: modelUsage names only the requested model, the assistant message does not.
    const served = services({
      startSession: async (spec) => ({ kind: "exited", code: 0, signal: null, stdout: Buffer.from(fakeSessionStream(spec, { kind: "result", output: { answer: "ready" }, served: ["claude-haiku-9-9"] })), stderr: Buffer.alloc(0) }),
    });
    const servedRun = await runFixtureCli(fx, ["doctor", "--live"], served);
    assert.equal(servedRun.code, 78, servedRun.stdout + servedRun.stderr);
    assert.match(servedRun.stdout, /^D5 fail: .*model_mismatch: an assistant message names claude-haiku-9-9/m);
    const notReady = services({
      startSession: async (spec) => ({ kind: "exited", code: 0, signal: null, stdout: Buffer.from(fakeSessionStream(spec, { kind: "result", output: { answer: "hello" } })), stderr: Buffer.alloc(0) }),
    });
    assert.equal((await runFixtureCli(fx, ["doctor", "--live"], notReady)).code, 78);
    const loggedOut = services({
      startSession: async (spec) => ({ kind: "exited", code: 1, signal: null, stdout: Buffer.from(fakeSessionStream(spec, { kind: "result", isError: true, resultText: "Not logged in", models: [] })), stderr: Buffer.alloc(0) }),
    });
    const out = await runFixtureCli(fx, ["doctor", "--live"], loggedOut);
    assert.equal(out.code, 78);
    assert.match(out.stdout, /Not logged in/);
  });

  it("D1 fails for another version; D2 for a flag --help lacks; D4 for a refused variable, and then D5 never starts", async () => {
    const old = await runFixtureCli(fx, ["doctor"], services({ runClaude: async (_p, args) => fakeClaude(args, "2.1.300") }));
    assert.equal(old.code, 78);
    assert.match(old.stdout, /^D1 fail: claude is 2\.1\.300; the pin is 2\.1\.328/m);
    const noFlag = await runFixtureCli(fx, ["doctor"], services({ runClaude: async (_p, args) => fakeClaude(args, "2.1.328", HELP.replace("--restricted", "--other")) }));
    assert.equal(noFlag.code, 78);
    assert.match(noFlag.stdout, /^D2 fail: --help does not document --restricted/m);
    const noStream = await runFixtureCli(fx, ["doctor"], services({ runClaude: async (_p, args) => fakeClaude(args, "2.1.328", HELP.replace('"stream-json"', '"ndjson"')) }));
    assert.equal(noStream.code, 78);
    assert.match(noStream.stdout, /^D2 fail: --help does not document "stream-json"/m);
    const s = services();
    const refused = await runFixtureCli(fx, ["doctor", "--live"], s, { ...fx.env, ANTHROPIC_AUTH_TOKEN: "secret-value", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" });
    assert.equal(refused.code, 78);
    assert.match(refused.stdout, /^D4 fail: transport direct; refused variables set: ANTHROPIC_AUTH_TOKEN \(credential\), ANTHROPIC_BASE_URL \(endpoint\)/m);
    assert.match(refused.stdout, /^D5 skipped: not started/m);
    assert.ok(!refused.stdout.includes("secret-value"));
    assert.equal(s.started.length, 0);
    assert.ok(!readFileSync(join(fx.home, "state", "doctor.json"), "utf8").includes("secret-value"));
  });

  it("D2 fails when the CLI refuses a schema the engine passes", async () => {
    const strict = services({
      runClaude: async (_p, args) =>
        args[0] === "-p" && (args[args.indexOf("--json-schema") + 1] ?? "").includes('"guardQuotes"')
          ? { code: 1, stdout: "", stderr: "Error: --json-schema is not a valid JSON Schema: bad\n" }
          : fakeClaude(args),
    });
    const run = await runFixtureCli(fx, ["doctor"], strict);
    assert.equal(run.code, 78);
    assert.match(run.stdout, /^D2 fail: --json-schema refuses sceptic$/m);
  });

  it("D3 fails for a settings file a session could read that sets a refused key, and then D5 never starts", async () => {
    mkdirSync(join(fx.userHome, ".claude"), { recursive: true });
    writeFileSync(join(fx.userHome, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "secret-value" } }));
    try {
      const s = services();
      const run = await runFixtureCli(fx, ["doctor", "--live"], s);
      assert.equal(run.code, 78, run.stdout + run.stderr);
      assert.match(run.stdout, /^D3 fail: .*\/\.claude\/settings\.json: sets refused keys: env\.ANTHROPIC_AUTH_TOKEN$/m);
      assert.match(run.stdout, /^D5 skipped: not started/m);
      assert.equal(s.started.length, 0);
      assert.ok(!run.stdout.includes("secret-value"));
    } finally {
      rmSync(join(fx.userHome, ".claude"), { recursive: true, force: true });
    }
    assert.match((await runFixtureCli(fx, ["doctor"], services())).stdout, /^D3 pass: /m);
  });

  it("D3 runs the locked client with an empty stdin and --debug-file, and fails when it applied env from its configuration", async () => {
    const probes: Array<{ args: readonly string[]; env: Record<string, string>; cwd: string }> = [];
    const recording = (log: string | null) =>
      services({
        runClaude: async (_p, args, options) => {
          if (options !== undefined) probes.push({ args, env: { ...options.env }, cwd: options.cwd });
          return fakeClaude(args, "2.1.328", HELP, log);
        },
      });
    const clean = await runFixtureCli(fx, ["doctor"], recording(CLEAN_LOG));
    assert.equal(clean.code, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /^D3 pass: .*the locked client applied no env from its configuration; server-managed settings: unknown/m);
    const [probe] = probes;
    assert.ok(probe !== undefined, "the probe ran with the session environment");
    for (const flag of ["--setting-sources", "--restricted", "--strict-mcp-config", "--settings", "--debug-file"]) assert.ok(probe.args.includes(flag), flag);
    assert.ok(!probe.args.includes("--fallback-model"));
    assert.deepEqual(Object.keys(probe.env).sort(), ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER", "HOME", "LANG", "PATH", "TMPDIR"]);
    assert.ok(probe.cwd.startsWith(join(realpathSync(fx.home), "trees")), probe.cwd);
    assert.ok(!existsSync(probe.cwd), "the probe's tree is removed");
    // The client took provider variables from its global configuration's env: D3 fails, D5 never starts.
    const s = recording("x [DEBUG] CA certs: Config fallback - globalEnv keys: CLAUDE_CODE_USE_BEDROCK,ANTHROPIC_BASE_URL, settingsEnv keys: none\n");
    const dirty = await runFixtureCli(fx, ["doctor", "--live"], s);
    assert.equal(dirty.code, 78);
    assert.match(dirty.stdout, /^D3 fail: the client applied env from its configuration: global CLAUDE_CODE_USE_BEDROCK, global ANTHROPIC_BASE_URL$/m);
    assert.match(dirty.stdout, /^D5 skipped: not started/m);
    assert.equal(s.started.length, 0);
    // A log that does not say what it applied fails closed, and so does no log.
    assert.match((await runFixtureCli(fx, ["doctor"], recording("nothing here\n"))).stdout, /^D3 fail: the probe's debug log does not say which configuration env the client applied$/m);
    assert.match((await runFixtureCli(fx, ["doctor"], recording(null))).stdout, /^D3 fail: the probe wrote no debug log$/m);
    // A --help that lacks --debug-file fails D2.
    const noDebug = await runFixtureCli(fx, ["doctor"], services({ runClaude: async (_p, args) => fakeClaude(args, "2.1.328", HELP.replace("--debug-file", "--other")) }));
    assert.match(noDebug.stdout, /^D2 fail: --help does not document --debug-file$/m);
    assert.deepEqual(configEnvKeys("globalEnv keys: none, settingsEnv keys: none"), { globalEnv: [], settingsEnv: [] });
    assert.deepEqual(configEnvKeys("globalEnv keys: A,B, settingsEnv keys: C"), { globalEnv: ["A", "B"], settingsEnv: ["C"] });
  });

  it("D3 fails for an env block in the global configuration ($HOME/.claude.json), which sessions would otherwise take", async () => {
    writeFileSync(join(fx.userHome, ".claude.json"), JSON.stringify({ numStartups: 3, env: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BASE_URL: "https://example.com" } }));
    try {
      const s = services();
      const run = await runFixtureCli(fx, ["doctor", "--live"], s);
      assert.equal(run.code, 78, run.stdout + run.stderr);
      assert.match(run.stdout, /^D3 fail: .*\/\.claude\.json: sets refused keys: env\.CLAUDE_CODE_USE_BEDROCK, env\.ANTHROPIC_BASE_URL$/m);
      assert.match(run.stdout, /^D2 fail: --json-schema not probed: a settings or configuration file a session could read is refused \(D3\)$/m, "no client is started with that configuration");
      assert.ok(!run.stdout.includes("example.com"));
      assert.equal(s.started.length, 0);
    } finally {
      rmSync(join(fx.userHome, ".claude.json"), { force: true });
    }
  });

  it("D4 and D5 under the pool transport: the transport is reported, and D5 runs through it", async () => {
    const configDir = join(fx.userHome, "pool-config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ theme: "dark", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:41234/", ANTHROPIC_AUTH_TOKEN: "pool-token-value" } }));
    const pool = { ...fx.env, FIN_REVIEW_TRANSPORT: "pool", ANTHROPIC_BASE_URL: "http://127.0.0.1:41234/", ANTHROPIC_AUTH_TOKEN: "pool-token-value", CLAUDE_CONFIG_DIR: configDir };
    const seen: CliRunnerOptions[] = [];
    try {
      const s = services({
        startSession: async (spec, options) => {
          seen.push(options);
          return { kind: "exited", code: 0, signal: null, stdout: Buffer.from(fakeSessionStream(spec, { kind: "result", output: { answer: "ready" } })), stderr: Buffer.alloc(0) };
        },
      });
      const run = await runFixtureCli(fx, ["doctor", "--live"], s, pool);
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /^D4 pass: transport pool \(forwarder 127\.0\.0\.1:41234\); /m);
      assert.match(run.stdout, /^D5 pass: .*\(transport pool\)$/m);
      assert.equal(seen[0]?.transport?.kind, "pool");
      assert.ok(seen[0]?.extraDenied.includes(realpathSync(configDir)), "the forwarder's configuration folder is denied to sessions");
      assert.ok(!run.stdout.includes("pool-token-value"));
      const doc = readJson(join(fx.home, "state", "doctor.json"));
      assert.equal(doc["transport"], "pool");
      assert.ok(!readFileSync(join(fx.home, "state", "doctor.json"), "utf8").includes("pool-token-value"));
      // A forwarder that serves another model and says so: Claude Code 2.1.328 keys modelUsage by
      // the model it asked for, so only the assistant message shows it, and D5 fails on it.
      const mapped = services({
        startSession: async (spec) => ({ kind: "exited", code: 0, signal: null, stdout: Buffer.from(fakeSessionStream(spec, { kind: "result", output: { answer: "ready" }, served: ["claude-haiku-9-9"] })), stderr: Buffer.alloc(0) }),
      });
      const pooled = await runFixtureCli(fx, ["doctor", "--live"], mapped, pool);
      assert.equal(pooled.code, 78, pooled.stdout + pooled.stderr);
      assert.match(pooled.stdout, /^D5 fail: .*model_mismatch: an assistant message names claude-haiku-9-9.*\(transport pool\)$/m);
      const mappedDoc = readJson(join(fx.home, "state", "doctor.json"));
      const d5 = (mappedDoc["checks"] as Array<Record<string, unknown>>).find((check) => check["id"] === "D5");
      assert.deepEqual((d5?.["data"] as Array<Record<string, unknown>>)[0]?.["modelObserved"], ["claude-haiku-9-9", MODELS.opus].sort());
      // A base URL that is not a loopback forwarder fails D4, and nothing starts.
      const far = services();
      const remote = await runFixtureCli(fx, ["doctor", "--live"], far, { ...pool, ANTHROPIC_BASE_URL: "https://example.com:443/" });
      assert.equal(remote.code, 78);
      assert.match(remote.stdout, /^D4 fail: the transport cannot be used: FIN_REVIEW_TRANSPORT: ANTHROPIC_BASE_URL must be http/m);
      assert.equal(far.started.length, 0);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("D1 fails when claudePath names no file, and the run starts nothing", async () => {
    writeFileSync(join(fx.home, "config.json"), JSON.stringify({ claudePath: join(fx.userHome, "no-such-claude") }));
    try {
      const s = services();
      const run = await runFixtureCli(fx, ["doctor", "--live"], s);
      assert.equal(run.code, 78);
      assert.match(run.stdout, /^D1 fail: claudePath does not name a file that exists$/m);
      assert.equal(s.started.length, 0);
    } finally {
      rmSync(join(fx.home, "config.json"), { force: true });
    }
  });

  it("refuses a FIN_REVIEW_HOME inside the engine's repository and creates nothing there", async () => {
    const inside = join(TOOL_ROOT, "..", "..", `.fr-doctor-test-${process.pid}`);
    const run = await runFixtureCli(fx, ["doctor"], services(), { ...fx.env, FIN_REVIEW_HOME: inside });
    assert.equal(run.code, 78);
    assert.match(run.stderr, /must not lie inside the repository under review or the engine's repository/);
    assert.ok(!existsSync(inside));
  });

  it("refuses an unknown option (64)", async () => {
    assert.equal((await runFixtureCli(fx, ["doctor", "--deep"], services())).code, 64);
  });

  it("matches flags as whole tokens of --help", () => {
    assert.deepEqual(missingFlags("  -p, --print\n  --model <m>\n  --effort <e>\n", ["-p", "--model", "--effort", "--max-turns"]), ["--max-turns"]);
    assert.deepEqual(missingFlags("  --tools-extra <x>\n", ["--tools"]), ["--tools"]);
    assert.deepEqual(missingFlags("  --setting-sources <sources>\n  --settings <file-or-json>\n", ["--settings", "--setting-sources"]), []);
  });
});
