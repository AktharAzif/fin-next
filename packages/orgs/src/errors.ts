// The refusals this area answers (spec 02 §14.1, §8.5, §9), beside the identity realm's AuthRefusal
// (the gate, step-up and limit codes). A refusal names its code, its status and the allowlisted
// problem extensions; its message is Fin's own words, never built from input. An OrgRefusal rolls
// the request's unit of work back: nothing a refused team change began is kept.

export type OrgProblemCode =
  | "organization_required"
  | "invalid"
  | "forbidden"
  | "outranked"
  | "giving_refused"
  | "not_found"
  | "invitation_unusable"
  | "conflict"
  | "last_top_role"
  | "already_member"
  | "approved_for_live"
  | "limit_reached"
  | "already_done";

export const ORG_PROBLEM_STATUS: Readonly<Record<OrgProblemCode, number>> = {
  organization_required: 400,
  invalid: 400,
  forbidden: 403,
  outranked: 403,
  giving_refused: 403,
  not_found: 404,
  invitation_unusable: 404,
  conflict: 409,
  last_top_role: 409,
  already_member: 409,
  approved_for_live: 409,
  limit_reached: 409,
  already_done: 409,
};

export const ORG_PROBLEM_TITLE: Readonly<Record<OrgProblemCode, string>> = {
  organization_required: "Choose an organisation first.",
  invalid: "Check what you entered.",
  forbidden: "Your role doesn't allow this.",
  outranked: "They can do things your role can't, so you can't change them.",
  giving_refused: "You can't give that role.",
  not_found: "Not found.",
  invitation_unusable: "This invitation can't be used.",
  conflict: "Something changed. Try again.",
  last_top_role: "Someone else must be a Super admin first.",
  already_member: "They're already on the team.",
  approved_for_live: "An organisation with Production access can't be deleted here.",
  limit_reached: "You've reached the limit.",
  already_done: "That's already done.",
};

export type OrgExtensions = Readonly<
  Record<string, string | number | boolean | null | readonly string[] | readonly FieldProblem[]>
>;

/** One refused field: its path and a code, never the value (spec 02 §14.1's `fields`). */
export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

export class OrgRefusal extends Error {
  readonly code: OrgProblemCode;
  readonly status: number;
  readonly extensions: OrgExtensions;
  /** A bounded reason for the request line, such as `team.outranked`. */
  readonly lineReason: string;
  constructor(code: OrgProblemCode, lineReason: string, extensions: OrgExtensions = {}) {
    super(code);
    this.name = "OrgRefusal";
    this.code = code;
    this.status = ORG_PROBLEM_STATUS[code];
    this.extensions = extensions;
    this.lineReason = lineReason;
  }
}

export function isOrgRefusal(error: unknown): error is OrgRefusal {
  return error instanceof OrgRefusal;
}

/** A schema refusal on one or more fields. */
export function invalid(fields: readonly FieldProblem[], lineReason = "body.invalid"): OrgRefusal {
  return new OrgRefusal("invalid", lineReason, { fields });
}

/** An ID that is not one, or a row this person cannot see: the same answer (spec 02 §9.1). */
export function notFound(lineReason = "not_found"): OrgRefusal {
  return new OrgRefusal("not_found", lineReason);
}
