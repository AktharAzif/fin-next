// What a unit of work is given by its caller (packages/server for requests and duties, the migrate
// service for runs): the clock, the release and IDs for stamping, and where its lines go. Nothing
// here reads the clock or the environment at module scope (ARCHITECTURE principle 14).

export interface Clock {
  now(): Date;
}

/** A line field: an ID, a name, a code, a count, or an object of counts (spec 08 §7.2). */
export type LineValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | Readonly<Record<string, number>>;

/**
 * A structured line (spec 08 §7.2). The writer in packages/server adds the envelope (`dt`, `service`,
 * `environment`, `release`, `replica`, `requestId` or `runId`), scrubs it and ships it; this package
 * only names the event, its level and its ID-only fields.
 */
export interface Line {
  event: string;
  level: "info" | "warn" | "error";
  fields: Readonly<Record<string, LineValue>>;
}

export interface LineSink {
  write(line: Line): void;
}

export interface UnitContext {
  clock: Clock;
  /** FIN_RELEASE: the commit SHA, stamped into audit rows. */
  release: string;
  /** `req_...` for a request unit. */
  requestId?: string;
  /** `job_...` for a duty or queue item, `run_...` for an operator run. */
  runId?: string;
  log: LineSink;
}

/** A sink that drops everything, for code paths that are tested for their effect only. */
export const discardLines: LineSink = { write: () => {} };
