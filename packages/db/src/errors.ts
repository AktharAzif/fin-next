// Errors the data layer raises. Messages are fixed or name a table, a file or a variable only, never a
// value, so they are safe to log after `safeError`.

export class DatabaseConfigError extends Error {
  override readonly name = "DatabaseConfigError";
  readonly variable: string;
  constructor(variable: string, problem: string) {
    super(`${variable}: ${problem}`);
    this.variable = variable;
  }
}

/** A commit refused by an audit guard (SQLSTATE FA010): a critical write without its audit event. */
export class AuditGuardError extends Error {
  override readonly name = "AuditGuardError";
  readonly table: string;
  constructor(table: string) {
    super(`audit guard refused the commit on ${table}`);
    this.table = table;
  }
}

/** A statement that would change session state on a pooled client (only SET LOCAL is allowed). */
export class SessionStateError extends Error {
  override readonly name = "SessionStateError";
  constructor() {
    super("session-level SET, RESET or DISCARD is refused on a pooled client; use SET LOCAL");
  }
}

/** An outbound call started while the unit of work holds a database client. */
export class ClientHeldAcrossCallError extends Error {
  override readonly name = "ClientHeldAcrossCallError";
  constructor(what: string) {
    super(`${what} started while the unit of work holds a database client`);
  }
}

export class NestedUnitError extends Error {
  override readonly name = "NestedUnitError";
  constructor() {
    super("a unit of work cannot open another; use tx.savepoint()");
  }
}

export class UnitClosedError extends Error {
  override readonly name = "UnitClosedError";
  constructor() {
    super("the unit of work has ended; its transaction cannot be used");
  }
}

export class MigrationError extends Error {
  override readonly name = "MigrationError";
  readonly file: string | undefined;
  readonly code: string;
  constructor(code: string, message: string, file?: string) {
    super(message);
    this.code = code;
    this.file = file;
  }
}

export class LoginCheckError extends Error {
  override readonly name = "LoginCheckError";
  constructor(problem: string) {
    super(`database login check failed: ${problem}`);
  }
}
