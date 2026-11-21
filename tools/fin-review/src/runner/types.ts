// The session runner's interface (spec 07 §4). Implementations: runner/cli.ts (local `claude -p`
// sessions) and runner/fake.ts (tests only). Both run their attempts through runner/check.ts, so
// the checks after a session and the retries are the same code whichever runner starts it.

import type { Effort } from "../options.ts";
import type { Role } from "../roles.ts";

export type SessionFailure = "exit" | "timeout" | "schema" | "refusal" | "throttled" | "model_mismatch" | "budget";

export const SESSION_FAILURES: readonly SessionFailure[] = [
  "exit",
  "timeout",
  "schema",
  "refusal",
  "throttled",
  "model_mismatch",
  "budget",
];

export interface SessionSpec {
  /** Unique within the run; lower case, digits, dots and dashes. */
  readonly id: string;
  readonly role: Role;
  readonly lens?: string;
  readonly profile?: string;
  readonly shard?: number;
  /** The exact model ID (never an alias). */
  readonly modelId: string;
  readonly effort: Effort;
  /** Fast mode as requested; the runner turns it on for Opus sessions only. */
  readonly fast: boolean;
  /** The session's working directory: the reviewed tree. */
  readonly treeDir: string;
  /** The whole user message (spec 07 §4.8). */
  readonly prompt: string;
  /** The output schema. */
  readonly schema: object;
  /** The role's turn cap; recorded, not passed (the pinned CLI documents no turn flag). */
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
}

export interface SessionResult {
  readonly id: string;
  readonly state: "ok" | "failed";
  readonly failure?: SessionFailure;
  /** A short reason for a failure, for the run directory (never model text). */
  readonly failureDetail?: string;
  /** The structured output, unvalidated; absent for a model mismatch (its output is discarded). */
  readonly output?: unknown;
  /** The keys of modelUsage and the models the assistant messages name (not `<synthetic>`), across every attempt. */
  readonly modelObserved: string[];
  readonly effortObserved: Effort | null;
  readonly costMicroUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadTokens: number;
  readonly durationMs: number;
  readonly attempts: number;
  readonly clientVersion: string;
  readonly apiHost: string;
}

/**
 * Checks a session's structured output beyond its JSON schema (spec 07 §2.8 rules 1 to 4 and 6):
 * null when it is acceptable, else a short reason. An unacceptable output counts as invalid
 * output, which is retried once (§4.6).
 */
export type OutputCheck = (output: unknown) => string | null;

export interface SessionRunner {
  run(spec: SessionSpec, signal: AbortSignal, accept?: OutputCheck): Promise<SessionResult>;
}
