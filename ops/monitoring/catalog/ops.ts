// The operator's lines (spec 08 §7.2's ops.ts): what `pnpm fin` writes beyond spec 01 §8.9's run
// and deploy lines (platform.ts), through its run's `line` (service `ops`, shipped to the ops
// source), and the static deploy's lines, which tools/static-deploy also prints in its job log.
// Every one is written by a run an operator or a release workflow started and is watching.
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "railway.verify",
    kind: "unit",
    level: "info",
    writtenBy:
      "pnpm fin railway verify, once per run: the drifts it found (level warn when there are any) and their service and check names",
    fields: { drift: "number", checks: "string[]" },
    alerts: [],
  },
  {
    event: "deploy.static_step",
    kind: "unit",
    level: "info",
    writtenBy:
      "pnpm fin static deploy, one per static deployment uploaded; tools/static-deploy prints the same in its job log (that line has no envelope, and names the release `deployedRelease` all the same: `release` is the envelope's)",
    fields: {
      deployment: "string",
      deployedRelease: "string",
      files: "number",
      uploaded: "number",
      assetManifestHash: "string",
    },
    alerts: [],
  },
  {
    event: "deploy.static_done",
    kind: "unit",
    level: "info",
    writtenBy:
      "pnpm fin static deploy once every deployment is uploaded, and tools/static-deploy in its job log (as above)",
    fields: { deployedRelease: "string", deployments: "number" },
    alerts: [],
  },
  {
    event: "run.leftover",
    kind: "failure",
    level: "error",
    writtenBy:
      "pnpm fin, just before run.done, when a run's cleanup has not undone what the run must not leave (a token made for one run, the superuser reference on migrate): what to undo by hand, and whether the cleanup failed",
    fields: {
      command: "string",
      leftover: "string",
      cleanupFailed: "boolean",
      cleanupError: "string",
    },
    alerts: [],
    noAlert:
      "Written by a run an operator or a release workflow is watching, which prints the same at its end, and kept in the run log and run.done; staging defines no alert on pnpm fin's own failures (deploy.failed has none either). What it names is bounded and caught again without it: the token made for one run expires within the hour, and a superuser reference left on migrate refuses the next railway deploy and is reported by railway verify's superuser reference check; run.done in the run log records the same instruction",
  },
  {
    event: "lock.broken",
    kind: "security",
    level: "warn",
    writtenBy:
      "pnpm fin lock break, when an operator breaks a stale run lock with a reason: the run that held it and the run log's new head",
    fields: {
      holderRunId: "string",
      holderCommand: "string",
      logSeq: "number",
      logHead: "string",
    },
    alerts: [],
    noAlert:
      "An operator's own deliberate command, whose reason the run log keeps; the line carries the log's head off the machine so the break cannot be rewritten unseen, which is its purpose, not a fault to alert on",
  },
  {
    event: "log.restarted",
    kind: "security",
    level: "warn",
    writtenBy:
      "pnpm fin log restart, when an operator keeps a run log that does not verify and starts a new one: the problems' count and the old and new heads",
    fields: {
      problems: "number",
      previousHead: "object",
      previousHeadFile: "object",
      logSeq: "number",
      logHead: "string",
    },
    alerts: [],
    noAlert:
      "Run only by an operator already handling a run log that does not verify (pnpm-fin.md); the line carries the old and new heads off the machine, so the restart is on record where the log cannot rewrite it",
  },
];
