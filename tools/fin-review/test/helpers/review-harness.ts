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

const CLAIM_HEADER = "# The fix a lens claims (at the head you are given)\n";

/** A fix check: the sceptic of a prior blocker a lens claimed fixed. */
export function isFixCheck(spec: SessionSpec): boolean {
  return spec.role.startsWith("sceptic") && spec.prompt.includes(CLAIM_HEADER);
}

/** The fix a fix check was shown, read back from its prompt's DATA block. */
export function claimedFix(spec: SessionSpec): { fixWhere: Record<string, unknown>; fixQuote: { path: string; text: string } } {
  const rest = spec.prompt.slice(spec.prompt.indexOf(CLAIM_HEADER) + CLAIM_HEADER.length);
  return JSON.parse(rest.slice(0, rest.indexOf("\n===== END DATA"))) as { fixWhere: Record<string, unknown>; fixQuote: { path: string; text: string } };
}

/** The JSON list a fix check's prompt holds under `header`; [] when it holds no such list. */
function shownList<T>(spec: SessionSpec, header: string): T[] {
  const at = spec.prompt.indexOf(header);
  if (at < 0) return [];
  const rest = spec.prompt.slice(at + header.length);
  return JSON.parse(rest.slice(0, rest.indexOf("\n\n# "))) as T[];
}

const ELSEWHERE_HEADER = "# Where the code the finding quotes now occurs more often than it did (files changed since it was reported)\n";

/** The files a fix check was told the code the blocker quotes moved or was copied to; [] when it was told of none. */
export function shownElsewhere(spec: SessionSpec): string[] {
  return shownList<string>(spec, ELSEWHERE_HEADER);
}

const STILL_HEADER = "# Where else the code the finding quotes occurs (files changed since that already held it when it was reported)\n";

/** The other files a fix check was told hold the code the blocker quotes, as they did then; [] when it was told of none. */
export function shownStill(spec: SessionSpec): string[] {
  return shownList<string>(spec, STILL_HEADER);
}

const REACHED_HEADER =
  "# Where else the code the finding quotes occurs (files unchanged since it was reported that changed code now reaches: a file now imports or re-exports from it, or a changed package manifest now names it)\n";

/** The unchanged files that changed code now reaches that a fix check was told hold the code the blocker quotes; [] when none. */
export function shownReached(spec: SessionSpec): string[] {
  return shownList<string>(spec, REACHED_HEADER);
}

const UNTOUCHED_HEADER = "# Where else the code the finding quotes occurs (files unchanged since it was reported)\n";

/** The files unchanged since the blocker was found that a fix check was told hold its quoted code, by name; [] when none. */
export function shownUntouched(spec: SessionSpec): string[] {
  return shownList<string>(spec, UNTOUCHED_HEADER);
}

const MORE_HEADER = "# How many more files unchanged since it was reported hold the code the finding quotes";

/** How many more unchanged files hold the quoted code than a fix check was shown by name; 0 when it was shown every one. */
export function shownMoreUntouched(spec: SessionSpec): number {
  const at = spec.prompt.indexOf(MORE_HEADER);
  if (at < 0) return 0;
  const rest = spec.prompt.slice(spec.prompt.indexOf("\n", at) + 1);
  return Number(rest.slice(0, rest.indexOf("\n")));
}

/** Every file a fix check was told by name holds the code the blocker quotes, all four lists. */
export function shownQuoted(spec: SessionSpec): string[] {
  return [...shownElsewhere(spec), ...shownStill(spec), ...shownReached(spec), ...shownUntouched(spec)];
}

const PATTERN_HEADER = "# A search pattern for each quote of the finding (white space allowed anywhere; for Grep with multiline on)\n";

/** The search pattern a fix check was given for each quote of the blocker. */
export function shownPatterns(spec: SessionSpec): Array<{ path: string; pattern: string }> {
  return shownList<{ path: string; pattern: string }>(spec, PATTERN_HEADER);
}

const RENAMED_HEADER = "# The paths git pairs files the finding names with (read as renamed since it was reported)\n";

/** The renames of the files a blocker names that a fix check was shown; [] when it was shown none. */
export function shownRenamed(spec: SessionSpec): Array<{ from: string; to: string }> {
  return shownList<{ from: string; to: string }>(spec, RENAMED_HEADER);
}

/** A fix check that finds the defect gone, quoting the claimed fix as its guard. */
export function fixHolds(spec: SessionSpec): FakeReply {
  return { kind: "result", output: { verdict: "REFUTED", guardQuotes: [claimedFix(spec).fixQuote], reason: "Every path to the defect passes through the fix." } };
}

/**
 * A script: the first handler that answers wins; otherwise a clean output, a confirming sceptic,
 * or a fix check that finds the claimed fix holds.
 */
export function script(...handlers: Handler[]): FakeScript {
  return (spec, attempt) => {
    for (const handler of handlers) {
      const reply = handler(spec, attempt);
      if (reply !== undefined) return reply;
    }
    if (isFixCheck(spec)) return fixHolds(spec);
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
