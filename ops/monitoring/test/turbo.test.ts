// This package's tests read files outside it (the code tree for MC-01, the runbooks, the flows'
// atlas, the watcher's settings, the audit writers) and it depends on no workspace package, so
// Turborepo's hash for its `test` task never sees those files change. ops/monitoring/turbo.json
// turns that task's cache off, so `pnpm check` runs these tests every time instead of replaying
// a pass over files that have since changed.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TURBO = join(ROOT, "node_modules", ".bin", "turbo");
const TASK = "@fin/ops-monitoring#test";

it("Turborepo never replays a cached pass of this package's tests", { timeout: 60_000 }, () => {
  expect(existsSync(TURBO), "Turborepo is installed (pnpm install)").toBe(true);
  const run = spawnSync(
    TURBO,
    ["run", "test", "--filter=@fin/ops-monitoring", "--dry=json", "--no-update-notifier"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", TURBO_NO_UPDATE_NOTIFIER: "1" },
    },
  );
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  const summary = JSON.parse(run.stdout) as {
    tasks: { taskId: string; resolvedTaskDefinition: { cache: boolean } }[];
  };
  const task = summary.tasks.find((t) => t.taskId === TASK);
  expect(task, `${TASK} is in the dry run`).toBeDefined();
  expect(task?.resolvedTaskDefinition.cache).toBe(false);
});
