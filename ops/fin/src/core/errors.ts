// Exit codes and the errors `pnpm fin` maps onto them (sysexits, as tools/fin-review uses).
// Every message is masked before it is printed (core/mask.ts), so an error may name a host or an
// ID internally; what reaches a terminal or a log never does.

export const EXIT = {
  ok: 0,
  /** `verify` found drift, or a plan holds changes that were not applied. */
  drift: 1,
  /** A usage error: an unknown command, flag or environment. */
  usage: 64,
  /** Input data that cannot be used: a bad release manifest, a bad artefact. */
  data: 65,
  /** A provider API was unreachable or answered an error after the retries. */
  unavailable: 69,
  /** An internal error. */
  internal: 70,
  /** The run lock is held by another run. */
  busy: 75,
  /** A safety rule refused the run: the allow-list, a never-touch name, a foreign rule. */
  refused: 77,
  /** The overlay, a settings file or a credential file is missing or invalid. */
  config: 78,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The base class: an error with the exit code it maps to. */
export class FinError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "FinError";
    this.exitCode = exitCode;
  }
}

export class UsageError extends FinError {
  constructor(message: string) {
    super(message, EXIT.usage);
    this.name = "UsageError";
  }
}

export class ConfigError extends FinError {
  constructor(message: string) {
    super(message, EXIT.config);
    this.name = "ConfigError";
  }
}

export class DataError extends FinError {
  constructor(message: string) {
    super(message, EXIT.data);
    this.name = "DataError";
  }
}

/** A safety rule refused a write before anything was sent (BD-11 and the rules around it). */
export class RefusedError extends FinError {
  constructor(message: string) {
    super(message, EXIT.refused);
    this.name = "RefusedError";
  }
}

export class BusyError extends FinError {
  constructor(message: string) {
    super(message, EXIT.busy);
    this.name = "BusyError";
  }
}

/** A provider call failed. `status` is the HTTP status, or 0 when no answer came. */
export class ProviderError extends FinError {
  readonly provider: string;
  readonly status: number;
  readonly codes: readonly number[];
  constructor(provider: string, message: string, status: number, codes: readonly number[] = []) {
    super(message, EXIT.unavailable);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.codes = codes;
  }
}
