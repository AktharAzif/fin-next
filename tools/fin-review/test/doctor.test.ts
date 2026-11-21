// The minimal doctor (spec 07 §4.7: D1, D2, D4, D5; T-RV-44's failure paths) with fakes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DOCTOR_PROMPT, missingFlags } from "../src/doctor.ts";
import type { DoctorServices } from "../src/doctor.ts";
import type { RunOutcome } from "../src/exec.ts";
import { loadCommittedModels } from "../src/options.ts";
import { RUNNER_FLAGS } from "../src/runner/cli.ts";
import { fakeResultJson } from "../src/runner/fake.ts";
import type { SessionSpec } from "../src/runner/types.ts";
import { countingRandom, fakeClock, readJson, reviewFixture, runFixtureCli } from "./helpers/review-fixture.ts";
import type { ReviewFixture } from "./helpers/review-fixture.ts";

const MODELS = loadCommittedModels();
const HELP = `Usage: claude [options]\n  -p, --print  Print\n${RUNNER_FLAGS.filter((flag) => flag !== "-p").map((flag) => `  ${flag} <x>  text`).join("\n")}\n`;

/** The pinned CLI's answers: its version, its help, and for -p with no input, the no-input error. */
function fakeClaude(args: readonly string[], version = "2.1.328", help = HELP) {
  if (args[0] === "--version") return { code: 0, stdout: `${version} (Claude Code)\n`, stderr: "" };
  if (args[0] === "--help") return { code: 0, stdout: help, stderr: "" };
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
      return { kind: "exited", code: 0, signal: null, stdout: Buffer.from(fakeResultJson(spec, { kind: "result", output: { answer: "ready" } })), stderr: Buffer.alloc(0) };
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
    assert.match(run.stdout, /^D2 pass: all 17 runner flags are in --help; replaced: --max-turns, --append-system-prompt-file; --json-schema accepts all 14 schemas$/m);
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
      startSession: async (spec) => ({ kind: "exited", code: 0, signal: null, stdout: Buffer.from(fakeResultJson(spec, { kind: "result", output: { answer: "ready" }, models: [spec.modelId, "claude-haiku-9-9"] })), stderr: Buffer.alloc(0) }),
    });
    const bad = await runFixtureCli(fx, ["doctor", "--live"], mismatch);
    assert.equal(bad.code, 78);
    assert.match(bad.stdout, /^D5 fail: .*model_mismatch/m);
    const notReady = services({
      startSession: async (spec) => ({ kind: "exited", code: 0, signal: null, stdout: Buffer.from(fakeResultJson(spec, { kind: "result", output: { answer: "hello" } })), stderr: Buffer.alloc(0) }),
    });
    assert.equal((await runFixtureCli(fx, ["doctor", "--live"], notReady)).code, 78);
    const loggedOut = services({
      startSession: async (spec) => ({ kind: "exited", code: 1, signal: null, stdout: Buffer.from(fakeResultJson(spec, { kind: "result", isError: true, resultText: "Not logged in", models: [] })), stderr: Buffer.alloc(0) }),
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
    const s = services();
    const refused = await runFixtureCli(fx, ["doctor", "--live"], s, { ...fx.env, ANTHROPIC_AUTH_TOKEN: "secret-value", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" });
    assert.equal(refused.code, 78);
    assert.match(refused.stdout, /^D4 fail: refused variables set: ANTHROPIC_AUTH_TOKEN \(credential\), ANTHROPIC_BASE_URL \(endpoint\)/m);
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

  it("refuses an unknown option (64)", async () => {
    assert.equal((await runFixtureCli(fx, ["doctor", "--deep"], services())).code, 64);
  });

  it("matches flags as whole tokens of --help", () => {
    assert.deepEqual(missingFlags("  -p, --print\n  --model <m>\n  --effort <e>\n", ["-p", "--model", "--effort", "--max-turns"]), ["--max-turns"]);
    assert.deepEqual(missingFlags("  --tools-extra <x>\n", ["--tools"]), ["--tools"]);
    assert.deepEqual(missingFlags("  --setting-sources <sources>\n  --settings <file-or-json>\n", ["--settings", "--setting-sources"]), []);
  });
});
