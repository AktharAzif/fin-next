// Fin's error types (spec 08 §5.4, ARCHITECTURE §10.5, §13.2). A FinError carries a bounded code and
// a fixed message written by Fin, never one built from input, so safeError may keep its message.
// Anything else thrown is unexpected: its message is dropped before it is logged or reported.

/** A bounded code: the ReasonCode shape of spec 08 §7.2, at most 64 characters. */
export const BOUNDED_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){0,3}$/;

export function isBoundedCode(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && BOUNDED_CODE.test(value);
}

export interface FinErrorOptions {
  /** The HTTP status a handler answers with when this error reaches it. */
  status?: number;
  /** Allowlisted problem extensions; values are Fin's own, never input. */
  extensions?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  cause?: unknown;
}

/** An error whose code and message are Fin's own words. */
export class FinError extends Error {
  readonly code: string;
  readonly status: number;
  readonly extensions: Readonly<Record<string, string | number | boolean | readonly string[]>>;

  constructor(code: string, message: string, options: FinErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (!isBoundedCode(code)) throw new TypeError("a FinError code must be a bounded code");
    this.name = "FinError";
    this.code = code;
    this.status = options.status ?? 500;
    this.extensions = Object.freeze({ ...(options.extensions ?? {}) });
  }
}

/** A refusal answered to the caller as a problem document with its public code. */
export class Refusal extends FinError {
  constructor(code: string, status: number, message: string, options: FinErrorOptions = {}) {
    super(code, message, { ...options, status });
    this.name = "Refusal";
  }
}

/** A setting that is missing or malformed. It names the variable, never its value. */
export class ConfigError extends FinError {
  readonly variable: string;
  readonly problem: "missing" | "malformed" | "refused";

  constructor(variable: string, problem: "missing" | "malformed" | "refused") {
    if (!/^[A-Z][A-Z0-9_]*$/.test(variable)) {
      throw new TypeError("a ConfigError names an environment variable");
    }
    super("config.invalid", `${variable} is ${problem}`, { status: 500 });
    this.name = "ConfigError";
    this.variable = variable;
    this.problem = problem;
  }
}

/** A dependency Fin needs is unavailable; the answer is 503. */
export class UnavailableError extends FinError {
  constructor(code: string, message: string, options: FinErrorOptions = {}) {
    super(code, message, { ...options, status: 503 });
    this.name = "UnavailableError";
  }
}

export function isFinError(error: unknown): error is FinError {
  return error instanceof FinError;
}

/** The exit code for a configuration error (EX_CONFIG), as ARCHITECTURE §3.5 sets it. */
export const EXIT_CONFIG = 78;
