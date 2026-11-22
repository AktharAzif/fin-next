// Operator tasks (spec 01 §6.6 "Operator tasks", S0-17): `pnpm fin task <env> <name>` starts a registered
// run of the `migrate` service with `--task <name>`, its parameters in FIN_TASK_PARAMS (a sealed variable
// removed after the run), as fin_owner with a password for that run only. A task's output is IDs only,
// and a task that changes data records its audit event with actor `operator`, `via: operator`, in the
// same transaction as the change.
import type { UnitTx } from "@fin/db";
import type { z } from "zod";

export interface TaskContext {
  /** The registered run's ID, the audit actor's ID. */
  runId: string;
  release: string;
  environment: "development" | "ci" | "staging" | "production";
}

export interface TaskResult {
  rowsChanged: number;
  /** IDs (never values) for the `task.done` line. */
  ids?: Readonly<Record<string, string | number>>;
}

export interface TaskDefinition<P> {
  name: string;
  /** A strict schema: an unknown or malformed parameter refuses the run before anything changes. */
  params: z.ZodType<P>;
  /**
   * True when the task's own audit event is the record of the run (audit-note); otherwise the runner
   * also records `operator.task_completed` with the rows changed.
   */
  recordsItself?: boolean;
  run(tx: UnitTx, params: P, context: TaskContext): Promise<TaskResult>;
}

/**
 * A refusal with its own code, which `migrate` prints as `task.failed`'s `code`. It lives here, with
 * the contract and away from the runner, so a task's module imports it without importing the
 * registry that lists the task.
 */
export class TaskError extends Error {
  override readonly name = "TaskError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function defineTask<P>(task: TaskDefinition<P>): TaskDefinition<P> {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(task.name)) throw new TypeError(`task name ${task.name}`);
  return task;
}
