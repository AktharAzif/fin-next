// The Bun canary's exclusions (DECISIONS CI-10, R15; EXECUTION H-14): the one place that names a
// test the canary does not run under Bun, each by its file and exact full name, with the reason.
// The canary runs every other test. Nothing here changes a test on Node: the canary's setup file
// (./setup.ts), which reads this list, is loaded only when the tests run under Bun
// (vitest.config.ts), and every test listed here runs and asserts in full on Node.
//
// An entry is for a difference in Bun itself or in what the canary's machine has, never for a Fin
// bug: Fin runs on Node alone (ARCHITECTURE §3.2). The setup file reports each excluded test with
// its reason in the job log, and fails a file under Bun when an entry names a test the file no
// longer has, so the list cannot go stale quietly.

/** One test the canary does not run under Bun. */
export interface BunCanaryExclusion {
  /** The test file, from the repository's root, with `/` between segments. */
  readonly file: string;
  /** The test's full name as Vitest gives it: its describe blocks and its own name, joined by ` > `. */
  readonly test: string;
  /** Why it cannot run under Bun. */
  readonly reason: string;
}

const NO_NODE_FOR_THE_RUN =
  "no `node` in the Bun canary for the Dockerfile step the test runs: the RUN's `node ops/docker/harness-scan.mjs` finds only Bun beside the test's runtime";

const RELEASE_RUN =
  "the RUN fails when the scan finds the harness or no output, and passes a clean one";

export const BUN_CANARY_EXCLUSIONS: readonly BunCanaryExclusion[] = [
  {
    file: "packages/server/src/http/serve.test.ts",
    test: "startHttpServer > answers what the adapter cannot parse through the front door, inside the request unit",
    reason:
      "Bun's own HTTP server answers `GET *` before the adapter: its parser refuses a target that is not a path with a bare 400, where Node's hands it to the front door",
  },
  {
    file: "packages/server/src/build/release-image.test.ts",
    test: `the Dockerfiles' release builds > ops/docker/app.Dockerfile, APP=api: ${RELEASE_RUN}`,
    reason: NO_NODE_FOR_THE_RUN,
  },
  {
    file: "packages/server/src/build/release-image.test.ts",
    test: `the Dockerfiles' release builds > ops/docker/connector.Dockerfile: ${RELEASE_RUN}`,
    reason: NO_NODE_FOR_THE_RUN,
  },
];

/** The entry that excludes `test` in `file`, matched exactly; undefined when none does. */
export function bunCanaryExclusion(
  file: string,
  test: string,
  list: readonly BunCanaryExclusion[] = BUN_CANARY_EXCLUSIONS,
): BunCanaryExclusion | undefined {
  return list.find((entry) => entry.file === file && entry.test === test);
}

/** The entries for `file` that name none of `tests` (the full names the file has): stale ones. */
export function staleBunCanaryExclusions(
  file: string,
  tests: ReadonlySet<string>,
  list: readonly BunCanaryExclusion[] = BUN_CANARY_EXCLUSIONS,
): BunCanaryExclusion[] {
  return list.filter((entry) => entry.file === file && !tests.has(entry.test));
}

/** The line the setup file writes for an excluded test, so the job log says what and why. */
export function bunCanaryExclusionLine(entry: BunCanaryExclusion): string {
  return `bun.canary.excluded file=${entry.file} test=${JSON.stringify(entry.test)} reason=${JSON.stringify(entry.reason)}\n`;
}
