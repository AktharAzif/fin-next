// The checks after every session (spec 07 §4.5) and the retries (§4.6): T-RV-10 and T-RV-11.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunOutcome } from "../src/exec.ts";
import { loadCommittedModels } from "../src/options.ts";
import { THROTTLE_WAITS_MS, checkAttempt, runWithRetries } from "../src/runner/check.ts";
import { FakeRunner, fakeSessionStream } from "../src/runner/fake.ts";
import type { FakeReply } from "../src/runner/fake.ts";
import type { SessionSpec } from "../src/runner/types.ts";
import { fakeClock } from "./helpers/review-fixture.ts";

const MODELS = loadCommittedModels();
const SCHEMA = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string", enum: ["ready"] } } };
const SPEC: SessionSpec = {
  id: "doctor-opus",
  role: "doctor",
  modelId: MODELS.opus,
  effort: "high",
  fast: false,
  treeDir: "/h/.fin-review/trees/t",
  prompt: "Reply with the word ready.",
  schema: SCHEMA,
  maxTurns: 1,
  maxBudgetUsd: 0.5,
  timeoutMs: 1000,
};

function exited(stdout: string, code = 0, stderr = ""): RunOutcome {
  return { kind: "exited", code, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function result(reply: Partial<Extract<FakeReply, { kind: "result" }>> = {}): RunOutcome {
  const full = { kind: "result" as const, output: { answer: "ready" }, ...reply };
  return exited(fakeSessionStream(SPEC, full), full.exitCode ?? (full.isError === true ? 1 : 0));
}

describe("checkAttempt (spec 07 §4.5)", () => {
  it("accepts a result with structured_output, the schema met and modelUsage naming only the requested model", () => {
    const check = checkAttempt(SPEC, result({ costUsd: 0.123456 }));
    assert.equal(check.ok, true, check.detail);
    assert.deepEqual(check.modelObserved, [MODELS.opus]);
    assert.equal(check.costMicroUsd, 123_456);
    assert.ok(check.resultFields.includes("modelUsage") && check.resultFields.includes("structured_output"));
  });

  it("a second model in modelUsage is model_mismatch, whatever else happened (T-RV-10)", () => {
    assert.equal(checkAttempt(SPEC, result({ models: [MODELS.opus, MODELS.fable] })).failure, "model_mismatch");
    assert.equal(checkAttempt(SPEC, result({ models: [MODELS.fable] })).failure, "model_mismatch");
    assert.equal(checkAttempt(SPEC, result({ models: [MODELS.fable], isError: true, resultText: "boom" })).failure, "model_mismatch");
    assert.equal(checkAttempt(SPEC, result({ models: [`${MODELS.opus}[1m]`] })).failure, "model_mismatch");
    // A model mismatch discards the output.
    assert.equal(checkAttempt(SPEC, result({ models: [MODELS.fable] })).output, undefined);
  });

  it("an empty modelUsage on an otherwise good result is model_mismatch: the model is not proven", () => {
    assert.equal(checkAttempt(SPEC, result({ models: [] })).failure, "model_mismatch");
  });

  it("an assistant message naming another model is model_mismatch though modelUsage names only the requested one (a forwarder serving another model)", () => {
    // The shape Claude Code 2.1.328 printed against a stand-in forwarder that answered every request
    // as another model: the init line and modelUsage name the requested model, the message does not.
    const stream = [
      { type: "system", subtype: "init", model: MODELS.opus, session_id: "s" },
      { type: "assistant", message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [] }, parent_tool_use_id: null, session_id: "s" },
      { type: "user", message: { role: "user", content: [] }, parent_tool_use_id: null, session_id: "s" },
      { type: "result", subtype: "success", is_error: false, result: "", modelUsage: { [MODELS.opus]: {} }, total_cost_usd: 0.01, structured_output: { answer: "ready" } },
    ];
    const check = checkAttempt(SPEC, exited(stream.map((line) => JSON.stringify(line)).join("\n")));
    assert.equal(check.failure, "model_mismatch");
    assert.match(check.detail, /an assistant message names claude-haiku-4-5, not /);
    assert.deepEqual(check.modelObserved, ["claude-haiku-4-5", MODELS.opus].sort());
    assert.equal(check.output, undefined, "a mismatch discards the output");
    // Any one message of several, an error included, and a message that names no model at all.
    assert.equal(checkAttempt(SPEC, result({ served: [MODELS.opus, MODELS.fable] })).failure, "model_mismatch");
    assert.equal(checkAttempt(SPEC, result({ served: [MODELS.fable], isError: true, resultText: "boom" })).failure, "model_mismatch");
    assert.equal(checkAttempt(SPEC, result({ served: [""] })).failure, "model_mismatch");
    // A client that started on another model, whatever it was served.
    assert.match(checkAttempt(SPEC, result({ initModel: MODELS.fable })).detail, /the client started on /);
  });

  it("a session that succeeded holds an assistant message naming the model; the client's own <synthetic> messages name none", () => {
    assert.match(checkAttempt(SPEC, result({ served: [] })).detail, /no assistant message names the model/);
    assert.equal(checkAttempt(SPEC, result({ served: ["<synthetic>"] })).failure, "model_mismatch");
    assert.equal(checkAttempt(SPEC, result({ served: ["<synthetic>", MODELS.opus] })).ok, true);
    // An API error is the client's own message: throttling stays throttling, not a mismatch.
    const throttled = checkAttempt(SPEC, result({ isError: true, apiErrorStatus: 429, resultText: "API Error: 429 rate limited", models: [], output: undefined }));
    assert.equal(throttled.failure, "throttled");
  });

  it("reads only a well-formed stream: one JSON object a line, and one result, last", () => {
    const good = fakeSessionStream(SPEC, { kind: "result", output: { answer: "ready" } });
    assert.equal(checkAttempt(SPEC, exited(good)).ok, true);
    const lines = good.trimEnd().split("\n");
    for (const bad of [
      [...lines, lines[0] ?? ""].join("\n"),
      [lines[lines.length - 1] ?? "", ...lines].join("\n"),
      ["not json", ...lines].join("\n"),
      ['"a string"', ...lines].join("\n"),
      lines.slice(0, -1).join("\n"),
    ]) {
      const check = checkAttempt(SPEC, exited(bad));
      assert.equal(check.failure, "exit", bad.slice(0, 80));
      assert.match(check.detail, /no stream with a result/);
    }
  });

  it("refuses a result whose modelUsage appears twice (the strict parser), as an exit failure", () => {
    const json = `{"type":"result","subtype":"success","is_error":false,"modelUsage":{"${MODELS.opus}":{}},"modelUsage":{"${MODELS.fable}":{}},"structured_output":{"answer":"ready"}}`;
    const check = checkAttempt(SPEC, exited(json));
    assert.equal(check.ok, false);
    assert.equal(check.failure, "exit");
    assert.match(check.detail, /duplicate key/);
  });

  it("classifies each failure", () => {
    assert.equal(checkAttempt(SPEC, { kind: "timeout", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }).failure, "timeout");
    assert.equal(checkAttempt(SPEC, { kind: "start", message: "ENOENT" }).failure, "exit");
    assert.equal(checkAttempt(SPEC, { kind: "output", stream: "stdout" }).failure, "exit");
    const aborted = checkAttempt(SPEC, { kind: "aborted", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    assert.equal(aborted.cancelled, true);
    assert.equal(checkAttempt(SPEC, exited("not json", 1, "Error: unknown option")).failure, "exit");
    assert.equal(checkAttempt(SPEC, exited('{"type":"system"}')).failure, "exit");
    assert.equal(checkAttempt(SPEC, result({ isError: true, apiErrorStatus: 429, resultText: "rate" })).failure, "throttled");
    assert.equal(checkAttempt(SPEC, result({ isError: true, apiErrorStatus: 529, resultText: "overloaded" })).failure, "throttled");
    assert.equal(checkAttempt(SPEC, result({ isError: true, resultText: "API Error: 529 overloaded_error" })).failure, "throttled");
    assert.equal(checkAttempt(SPEC, result({ subtype: "error_max_budget_usd", isError: true })).failure, "budget");
    assert.equal(checkAttempt(SPEC, result({ isError: true, resultText: "Not logged in · Please run /login" })).failure, "exit");
    assert.equal(checkAttempt(SPEC, result({ isError: true, resultText: "API Error: 400 Output blocked by content filtering policy" })).failure, "refusal");
    assert.equal(checkAttempt(SPEC, result({ stopReason: "refusal" })).failure, "refusal");
    assert.equal(checkAttempt(SPEC, result({ output: undefined })).failure, "refusal");
    assert.equal(checkAttempt(SPEC, result({ subtype: "error_max_structured_output_retries" })).failure, "schema");
    assert.equal(checkAttempt(SPEC, result({ subtype: "error_during_execution" })).failure, "exit");
    assert.equal(checkAttempt(SPEC, result({ exitCode: 3 })).failure, "exit");
  });

  it("checks the output against the session's schema and the caller's own rules", () => {
    const wrong = checkAttempt(SPEC, result({ output: { answer: "maybe" } }));
    assert.equal(wrong.failure, "schema");
    assert.deepEqual(JSON.parse(JSON.stringify(wrong.output)), { answer: "maybe" }, "a schema failure keeps the output for the caller");
    assert.equal(checkAttempt(SPEC, result({ output: { answer: "ready", extra: 1 } })).failure, "schema");
    const rejected = checkAttempt(SPEC, result(), () => "quote not in the file");
    assert.equal(rejected.failure, "schema");
    assert.equal(rejected.detail, "quote not in the file");
  });
});

describe("runWithRetries (spec 07 §4.6, T-RV-11)", () => {
  async function run(replies: FakeReply[], accept?: (output: unknown) => string | null) {
    const clock = fakeClock();
    const runner = new FakeRunner((_spec, attempt) => replies[Math.min(attempt, replies.length) - 1] ?? { kind: "timeout" }, clock);
    const out = await runner.run(SPEC, new AbortController().signal, accept);
    return { out, clock, attempts: runner.calls.length };
  }
  const ok: FakeReply = { kind: "result", output: { answer: "ready" } };

  it("a refusal is retried once, then the session fails as a refusal", async () => {
    const { out, attempts } = await run([{ kind: "result", stopReason: "refusal", output: { answer: "ready" } }]);
    assert.equal(attempts, 2);
    assert.equal(out.state, "failed");
    assert.equal(out.failure, "refusal");
  });

  it("invalid output is retried once; a good second attempt passes", async () => {
    const { out, attempts } = await run([{ kind: "result", output: { answer: "nope" } }, ok]);
    assert.equal(attempts, 2);
    assert.equal(out.state, "ok");
  });

  it("invalid output twice fails as schema and keeps the last output", async () => {
    const { out, attempts } = await run([{ kind: "result", output: { answer: "ready" } }], () => "bad quote");
    assert.equal(attempts, 2);
    assert.equal(out.failure, "schema");
    assert.ok(out.output !== undefined);
  });

  it("throttling is retried up to 4 attempts with waits of 15, 60 and 180 seconds", async () => {
    const throttled: FakeReply = { kind: "result", isError: true, apiErrorStatus: 429, resultText: "rate limited" };
    const { out, clock, attempts } = await run([throttled, throttled, throttled, throttled, ok]);
    assert.equal(attempts, 4);
    assert.equal(out.failure, "throttled");
    assert.deepEqual(clock.sleeps, [...THROTTLE_WAITS_MS]);
    assert.deepEqual(THROTTLE_WAITS_MS, [15_000, 60_000, 180_000]);
    const recovered = await run([throttled, throttled, ok]);
    assert.equal(recovered.out.state, "ok");
    assert.equal(recovered.attempts, 3);
    assert.deepEqual(recovered.clock.sleeps, [15_000, 60_000]);
  });

  it("a model mismatch is never retried (T-RV-10), and neither is a budget stop", async () => {
    const mismatch = await run([{ kind: "result", output: { answer: "ready" }, models: [MODELS.fable], served: [MODELS.fable] }, ok]);
    assert.equal(mismatch.attempts, 1);
    assert.equal(mismatch.out.failure, "model_mismatch");
    assert.equal(mismatch.out.output, undefined);
    assert.deepEqual(mismatch.out.modelObserved, [MODELS.fable]);
    // Served by another model with modelUsage naming the requested one: never retried either.
    const served = await run([{ kind: "result", output: { answer: "ready" }, served: [MODELS.fable] }, ok]);
    assert.equal(served.attempts, 1);
    assert.equal(served.out.failure, "model_mismatch");
    assert.deepEqual(served.out.modelObserved, [MODELS.fable, MODELS.opus].sort());
    const budget = await run([{ kind: "result", subtype: "error_max_budget_usd", isError: true }, ok]);
    assert.equal(budget.attempts, 1);
    assert.equal(budget.out.failure, "budget");
  });

  it("adds cost and tokens over every attempt and reports every model observed", async () => {
    const { out } = await run([{ kind: "timeout" }, { kind: "result", output: { answer: "ready" }, costUsd: 0.5 }]);
    assert.equal(out.state, "ok");
    assert.equal(out.attempts, 2);
    assert.equal(out.costMicroUsd, 500_000);
    assert.equal(out.effortObserved, null);
  });

  it("stops at once when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const clock = fakeClock();
    const out = await runWithRetries(SPEC, async () => ({ kind: "timeout", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }), { clock, signal: controller.signal, clientVersion: "x", apiHost: "api.anthropic.com" });
    assert.equal(out.state, "failed");
    assert.equal(out.failureDetail, "cancelled");
    assert.equal(out.attempts, 0);
  });
});
