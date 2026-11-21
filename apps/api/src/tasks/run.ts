// Runs one operator task in one unit of work as fin_owner: parameters parsed strictly before anything
// changes, the task's changes and its audit event in the same transaction, then `task.done` with the
// task's name, the rows changed and IDs, or `task.failed` with a code. Never a value.
import { recordAudit } from "@fin/audit";
import type { FinDatabase, LineSink, UnitContext } from "@fin/db";
import { TASKS } from "./registry.ts";
import { type TaskContext, TaskError, type TaskResult } from "./types.ts";

export { TaskError };

export function parseTaskParams(text: string | undefined): unknown {
  if (text === undefined || text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TaskError("task_params", "FIN_TASK_PARAMS is not JSON");
  }
}

export async function runTask(
  db: FinDatabase,
  name: string,
  rawParams: unknown,
  context: TaskContext & { unit: UnitContext; log: LineSink },
): Promise<TaskResult> {
  // Only the registry's own names: `constructor` and the rest of Object.prototype are unknown too.
  const task = Object.hasOwn(TASKS, name) ? TASKS[name] : undefined;
  if (task === undefined) throw new TaskError("task_unknown", `no task named ${name}`);
  const parsed = task.params.safeParse(rawParams);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") ?? "";
    throw new TaskError("task_params", `FIN_TASK_PARAMS.${field} is missing or malformed`);
  }
  const taskContext: TaskContext = {
    runId: context.runId,
    release: context.release,
    environment: context.environment,
  };
  const result = await db.unit(context.unit, async (tx) => {
    const outcome = await task.run(tx, parsed.data, taskContext);
    if (task.recordsItself !== true) {
      await recordAudit(tx, {
        event: "operator.task_completed",
        actor: { kind: "operator", id: context.runId, via: "operator" },
        target: name,
        metadata: { task: name, rowsChanged: outcome.rowsChanged, release: context.release },
      });
    }
    return outcome;
  });
  context.log.write({
    event: "task.done",
    level: "info",
    fields: { task: name, rowsChanged: result.rowsChanged, ...(result.ids ?? {}) },
  });
  return result;
}
