// The Bun canary's setup file (DECISIONS CI-10): vitest.config.ts loads it for every test file only
// when the tests run under Bun, never on Node. It skips exactly the tests ./exclusions.ts lists,
// each with its reason as the skip's note and as one line in the job log, and fails the file's
// tests when an entry names a test the file no longer has.
import { relative, resolve, sep } from "node:path";
import { beforeEach } from "vitest";
import {
  bunCanaryExclusion,
  bunCanaryExclusionLine,
  staleBunCanaryExclusions,
} from "./exclusions.ts";

const REPOSITORY = resolve(import.meta.dirname, "../../../..");

/** A test file's path from the repository's root, as the exclusions name it. */
function fromRoot(filepath: string): string {
  return relative(REPOSITORY, filepath).split(sep).join("/");
}

interface Named {
  readonly type: string;
  readonly fullTestName?: string;
  readonly tasks?: readonly Named[];
}

/** The full name of every test under `task`. */
function testNames(task: Named, into = new Set<string>()): Set<string> {
  if (task.type === "test" && task.fullTestName !== undefined) into.add(task.fullTestName);
  for (const child of task.tasks ?? []) testNames(child, into);
  return into;
}

beforeEach((context) => {
  const { task } = context;
  const file = fromRoot(task.file.filepath);
  const stale = staleBunCanaryExclusions(file, testNames(task.file));
  if (stale.length > 0) {
    throw new Error(
      `the Bun canary's exclusions name tests ${file} no longer has: ${stale.map((entry) => JSON.stringify(entry.test)).join(", ")}`,
    );
  }
  const entry = bunCanaryExclusion(file, task.fullTestName ?? task.name);
  if (entry === undefined) return;
  process.stdout.write(bunCanaryExclusionLine(entry));
  context.skip(entry.reason);
});
