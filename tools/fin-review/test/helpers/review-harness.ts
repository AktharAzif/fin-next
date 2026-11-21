// The fake-session harness of the review-mode tests (review-*.test.ts): scripted sessions, the
// services a run is given, and readers of the run directory. Each test file builds its own fixture,
// so the files run in parallel.

import assert from "node:assert/strict";
import { join } from "node:path";
import { loadCommittedModels } from "../../src/options.ts";
import { FakeRunner } from "../../src/runner/fake.ts";
import type { FakeReply, FakeScript } from "../../src/runner/fake.ts";
import type { SessionSpec } from "../../src/runner/types.ts";
import type { ReviewServices } from "../../src/review/commands.ts";
import type { EngineCopy } from "../../src/review/engine-copy.ts";
import { cleanOutput, countingRandom, fakeClock, readJson, runDirs } from "./review-fixture.ts";
import type { FakeClock, ReviewFixture } from "./review-fixture.ts";

export const MODELS = loadCommittedModels();
export const CONFIRMED = { verdict: "CONFIRMED", guardQuotes: [], reason: "The comparison is plain ===." };
/** The engine that runs the tests stands in for the default branch's engine copy. */
export const ENGINE_COPY: EngineCopy = { commit: "e".repeat(40), procedureHash: "a".repeat(64), problems: [] };

export type Handler = (spec: SessionSpec, attempt: number) => FakeReply | undefined;

/** A script: the first handler that answers wins; otherwise a clean output or a confirming sceptic. */
export function script(...handlers: Handler[]): FakeScript {
  return (spec, attempt) => {
    for (const handler of handlers) {
      const reply = handler(spec, attempt);
      if (reply !== undefined) return reply;
    }
    if (spec.role.startsWith("sceptic")) return { kind: "result", output: CONFIRMED };
    if (spec.role === "second-look") return { kind: "result", output: { verdict: "STANDS", quotes: [], reason: "Every path passes the guard." } };
    return { kind: "result", output: cleanOutput(spec) };
  };
}

export interface Harness {
  readonly services: ReviewServices;
  readonly runners: FakeRunner[];
  readonly clock: FakeClock;
}

export function harness(fx: ReviewFixture, fake: FakeScript, random = countingRandom()): Harness {
  const clock = fakeClock();
  const runners: FakeRunner[] = [];
  return {
    clock,
    runners,
    services: {
      clock,
      random,
      facts: (n) => fx.facts(n),
      clientVersion: async () => "2.1.328",
      engineCopy: async () => ENGINE_COPY,
      makeRunner: (options) => {
        assert.equal(options.models.opus, MODELS.opus);
        const runner = new FakeRunner(fake, clock);
        runners.push(runner);
        return runner;
      },
    },
  };
}

export function calls(h: Harness): Array<{ spec: SessionSpec; attempt: number }> {
  return h.runners.flatMap((runner) => runner.calls);
}

export function lastRun(fx: ReviewFixture): string {
  const dirs = runDirs(fx.home);
  const last = dirs[dirs.length - 1];
  assert.ok(last !== undefined, "a run directory");
  return last;
}

export function findingsOf(runDir: string): Array<Record<string, unknown>> {
  return (readJson(join(runDir, "findings.json"))["findings"] as Array<Record<string, unknown>>) ?? [];
}
