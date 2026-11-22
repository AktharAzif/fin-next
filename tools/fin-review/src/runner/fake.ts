// The fake runner (tests only; spec 07 §4): a script answers each attempt with what `claude -p`
// would have printed, and the answer goes through the same checks and retries as a real session
// (runner/check.ts), so model mismatches, refusals, throttling and invalid output are exercised
// end to end without a network.

import type { Clock } from "../clock.ts";
import type { RunOutcome } from "../exec.ts";
import { API_HOST } from "./cli.ts";
import { SYNTHETIC_MODEL, runWithRetries } from "./check.ts";
import type { OutputCheck, SessionResult, SessionRunner, SessionSpec } from "./types.ts";

export interface FakeResult {
  readonly kind: "result";
  /** The structured output; omit for none. */
  readonly output?: unknown;
  /** modelUsage's keys (the models the client asked for); default: the requested model only. */
  readonly models?: readonly string[];
  /**
   * The model each assistant message names (what the endpoint said served it); default: the
   * requested model, or the client's own `<synthetic>` message for an error.
   */
  readonly served?: readonly string[];
  /** The model the client's init line names; default: the requested model. */
  readonly initModel?: string;
  readonly isError?: boolean;
  readonly subtype?: string;
  readonly stopReason?: string;
  readonly apiErrorStatus?: number | null;
  readonly resultText?: string;
  readonly costUsd?: number;
  readonly exitCode?: number;
}

export type FakeReply =
  | FakeResult
  | { readonly kind: "timeout" }
  | { readonly kind: "raw"; readonly stdout: string; readonly exitCode: number; readonly stderr?: string }
  | { readonly kind: "start-failure"; readonly message: string };

export type FakeScript = (spec: SessionSpec, attempt: number) => FakeReply | Promise<FakeReply>;

export interface FakeCall {
  readonly spec: SessionSpec;
  readonly attempt: number;
}

/**
 * A fixed version 4 UUID for the fake stream, `n` in its last field. Built when called, so the
 * repository holds no UUID-shaped text (public-safety refuses one: real tunnel and service IDs are UUIDs).
 */
function fakeUuid(n: number): string {
  return ["0".repeat(8), "0".repeat(4), `4${"0".repeat(3)}`, `8${"0".repeat(3)}`, String(n).padStart(12, "0")].join("-");
}

/**
 * Claude Code's stream-json output for a scripted reply, as 2.1.328 prints it: the init line, one
 * assistant message per served model, and the result last (the field names recorded from 2.1.328).
 */
export function fakeSessionStream(spec: SessionSpec, reply: FakeResult): string {
  const served = reply.served ?? [reply.isError === true ? SYNTHETIC_MODEL : spec.modelId];
  const init = { type: "system", subtype: "init", model: reply.initModel ?? spec.modelId, session_id: fakeUuid(0), uuid: fakeUuid(2) };
  const messages = served.map((model, index) => ({
    type: "assistant",
    message: { id: `msg_fake_${index}`, type: "message", role: "assistant", model, content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    parent_tool_use_id: null,
    session_id: fakeUuid(0),
  }));
  return [init, ...messages].map((line) => `${JSON.stringify(line)}\n`).join("") + fakeResultLine(spec, reply);
}

/** The result line alone (the last line of the stream). */
function fakeResultLine(spec: SessionSpec, reply: FakeResult): string {
  const models = reply.models ?? [spec.modelId];
  const cost = reply.costUsd ?? 0.01;
  const modelUsage: Record<string, unknown> = {};
  for (const id of models) {
    modelUsage[id] = { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 100, costUSD: cost / Math.max(1, models.length) };
  }
  const result: Record<string, unknown> = {
    type: "result",
    subtype: reply.subtype ?? "success",
    is_error: reply.isError ?? false,
    duration_ms: 1000,
    duration_api_ms: 900,
    num_turns: 2,
    result: reply.resultText ?? (reply.output === undefined ? "" : JSON.stringify(reply.output)),
    stop_reason: reply.stopReason ?? "end_turn",
    session_id: fakeUuid(0),
    total_cost_usd: cost,
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5, output_tokens: 20 },
    modelUsage,
    permission_denials: [],
    terminal_reason: "completed",
    fast_mode_state: "off",
    api_error_status: reply.apiErrorStatus ?? null,
    uuid: fakeUuid(1),
  };
  if (reply.output !== undefined) result["structured_output"] = reply.output;
  return `${JSON.stringify(result)}\n`;
}

function toOutcome(spec: SessionSpec, reply: FakeReply): RunOutcome {
  switch (reply.kind) {
    case "timeout":
      return { kind: "timeout", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    case "start-failure":
      return { kind: "start", message: reply.message };
    case "raw":
      return { kind: "exited", code: reply.exitCode, signal: null, stdout: Buffer.from(reply.stdout, "utf8"), stderr: Buffer.from(reply.stderr ?? "", "utf8") };
    case "result":
      return {
        kind: "exited",
        code: reply.exitCode ?? (reply.isError === true ? 1 : 0),
        signal: null,
        stdout: Buffer.from(fakeSessionStream(spec, reply), "utf8"),
        stderr: Buffer.alloc(0),
      };
    default: {
      const unreachable: never = reply;
      throw new TypeError(`unknown fake reply ${JSON.stringify(unreachable)}`);
    }
  }
}

/** A runner whose sessions answer from `script`. */
export class FakeRunner implements SessionRunner {
  readonly calls: FakeCall[] = [];
  private readonly script: FakeScript;
  private readonly clock: Clock;

  constructor(script: FakeScript, clock: Clock) {
    this.script = script;
    this.clock = clock;
  }

  run(spec: SessionSpec, signal: AbortSignal, accept?: OutputCheck): Promise<SessionResult> {
    return runWithRetries(
      spec,
      async (attempt) => {
        this.calls.push({ spec, attempt });
        return toOutcome(spec, await this.script(spec, attempt));
      },
      { clock: this.clock, signal, clientVersion: "fake", apiHost: API_HOST },
      accept,
    );
  }
}
