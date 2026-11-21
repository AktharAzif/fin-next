// The refusals the key lifecycle answers (spec 02 §12.3; spec 05 §4.4 to §4.6). A refusal names one
// of the console's problem codes, a bounded reason for the request line, and only the allowlisted
// problem extensions: `fields` (each with a path and a code, never the value), `permission` (what
// the role lacks), `limit`. The console maps it to its own problem answer; nothing the refused action
// began is kept.

export type KeyProblemCode =
  | "invalid"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "limit_reached"
  | "already_done";

export interface KeyFieldProblem {
  readonly path: string;
  readonly code: string;
}

export type KeyExtensions = Readonly<{
  fields?: readonly KeyFieldProblem[];
  permission?: string;
  limit?: number;
  reason?: string;
}>;

export class KeyRefusal extends Error {
  override readonly name = "KeyRefusal";
  readonly code: KeyProblemCode;
  /** A bounded reason for the request line, such as `keys.limit`. */
  readonly lineReason: string;
  readonly extensions: KeyExtensions;
  constructor(code: KeyProblemCode, lineReason: string, extensions: KeyExtensions = {}) {
    super(code);
    this.code = code;
    this.lineReason = lineReason;
    this.extensions = extensions;
  }
}

export function isKeyRefusal(error: unknown): error is KeyRefusal {
  return error instanceof KeyRefusal;
}

/** `400 invalid` naming one field and why. */
export function invalidField(path: string, code: string, lineReason = "keys.invalid"): KeyRefusal {
  return new KeyRefusal("invalid", lineReason, { fields: [{ path, code }] });
}
