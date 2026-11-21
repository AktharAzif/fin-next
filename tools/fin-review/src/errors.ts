// Exit codes (spec 07 §2.1, S7-30) and the error classes the CLI maps onto them.

export const EXIT = {
  /** A receipt was written and it lists no blocker; for deterministic commands, success. */
  pass: 0,
  /** A receipt was written and it lists blockers. */
  blocked: 1,
  /** A required lens is refused, incomplete or budget_reached. */
  couldNotCheck: 2,
  /** An option was refused (R11, the effort floor, an unknown option). */
  usage: 64,
  /** An invalid receipt, schema, request or finding. */
  data: 65,
  /** GitHub, the git remote or the model API was unreachable after the retries. */
  unavailable: 69,
  /** Internal error; no receipt. */
  internal: 70,
  /** A run lock is held. */
  busy: 75,
  /** The environment or a settings or configuration file breaks the lock-down. */
  config: 78,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A committed or machine configuration file is missing or invalid: exit 78. */
export class ConfigError extends Error {
  readonly file: string;
  readonly details: readonly string[];
  constructor(file: string, details: readonly string[]) {
    super(`${file}: ${details.join("; ")}`);
    this.name = "ConfigError";
    this.file = file;
    this.details = details;
  }
}

/** Input data the engine cannot use (a revision that is not a commit, a bad manifest): exit 65. */
export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataError";
  }
}

/** An external program failed or misbehaved: exit 70. */
export class ProgramError extends Error {
  readonly program: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(program: string, message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "ProgramError";
    this.program = program;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}
