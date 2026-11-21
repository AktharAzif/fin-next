// The refusals Fin Admin's staff routes answer beyond the auth codes @fin/identity's AuthRefusal
// carries (spec 02 §14.1, §8.4, §8.5, §10): `limit_reached` (with `limit`) is the 31st custom staff
// role. Each is a problem document; the API half renders it.
export type StaffProblemCode =
  | "forbidden"
  | "outranked"
  | "giving_refused"
  | "already_staff"
  | "last_top_role"
  | "not_found"
  | "conflict"
  | "limit_reached"
  | "invalid";

const STATUS: Readonly<Record<StaffProblemCode, number>> = {
  forbidden: 403,
  outranked: 403,
  giving_refused: 403,
  already_staff: 409,
  last_top_role: 409,
  not_found: 404,
  conflict: 409,
  limit_reached: 409,
  invalid: 400,
};

export type StaffProblemExtensions = Readonly<
  Record<string, string | number | boolean | null | readonly string[] | readonly object[]>
>;

/** A staff route's refusal. The unit of work rolls back: nothing a refusal found stays written. */
export class StaffRefusal extends Error {
  readonly code: StaffProblemCode;
  readonly status: number;
  readonly extensions: StaffProblemExtensions;
  /** A bounded reason for the request line, e.g. `staff.last_top_role`. */
  readonly lineReason: string;
  constructor(code: StaffProblemCode, lineReason: string, extensions: StaffProblemExtensions = {}) {
    super(code);
    this.name = "StaffRefusal";
    this.code = code;
    this.status = STATUS[code];
    this.extensions = extensions;
    this.lineReason = lineReason;
  }
}
