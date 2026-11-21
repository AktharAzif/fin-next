// The permission engine's types (spec 02 §8.1). One engine, two catalogues: checks are by
// permission, never by role, and a role Fin does not know allows nothing.

/** The developer realm's organisations (the dashboard) and Fin's own staff (Fin Admin). */
export type Realm = "dashboard" | "staff";

/** The role editor's hint for how an action asks for a second factor; the route policy decides. */
export type StepUpKind = "none" | "window" | "intent";

/**
 * How the generated summary sentence names a permission (spec 02 §8.2). A permission that opens a
 * page is something a role can `see`; any other permission `does` something. A `does` phrase may
 * cover a `see` permission it needs, which the sentence then leaves out as said already ("manage
 * webhooks" says that the role sees them).
 */
export type SummaryPhrase<P extends string = string> =
  | { readonly see: string }
  | { readonly does: string; readonly covers?: P };

/** One permission as an area's catalogue fragment writes it. */
export interface PermissionSpec {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Direct needs only; the closure is computed. */
  readonly needs: readonly string[];
  readonly stepUp: StepUpKind;
  /** [SA-05]'s privileged mark: dashboard only. */
  readonly privileged: boolean;
  /** The role editor's "Sandbox" chip. */
  readonly sandboxOnly: boolean;
  /** Only the top role holds it: no custom role may (Super admin only, or staff Admin-only). */
  readonly restricted: boolean;
  readonly summary: SummaryPhrase;
}

/** One group of the role editor, as an area's catalogue fragment writes it. */
export interface GroupSpec {
  readonly key: string;
  readonly label: string;
  /**
   * The summary sentence's "Can't ..." phrase, said when a role holds none of the group's
   * permissions other than the ones it can `see` (the team's "change the team").
   */
  readonly cant?: string;
  readonly permissions: readonly PermissionSpec[];
}

/** A built-in (dashboard) or prebuilt (staff) role: an immutable row in code. */
export interface BuiltInRole<P extends string = string, R extends string = string> {
  readonly key: R;
  readonly label: string;
  readonly summary: string;
  readonly holds: "all" | readonly P[];
}

/** One permission of an assembled catalogue. */
export interface PermissionDef<P extends string = string> {
  readonly key: P;
  /** The key of the group it sits in. */
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly needs: readonly P[];
  readonly stepUp: StepUpKind;
  readonly privileged: boolean;
  readonly sandboxOnly: boolean;
  readonly restricted: boolean;
  readonly summary: SummaryPhrase<P>;
}

/** One group of an assembled catalogue, in the role editor's order. */
export interface PermissionGroup<P extends string = string> {
  readonly key: string;
  readonly label: string;
  readonly cant?: string;
  readonly permissions: readonly P[];
}

/** An assembled, checked and frozen catalogue. Built only by `assembleCatalogue`. */
export interface Catalogue<P extends string = string, R extends string = string> {
  readonly realm: Realm;
  /** The role editor's groups, in order. */
  readonly groups: readonly PermissionGroup<P>[];
  readonly permissions: Readonly<Record<P, PermissionDef<P>>>;
  /** Every permission, in the role editor's order. */
  readonly keys: readonly P[];
  /** Each permission's transitive needs, in catalogue order. */
  readonly closure: Readonly<Record<P, readonly P[]>>;
  /** Each permission's transitive dependents (what needs it), in catalogue order. */
  readonly dependents: Readonly<Record<P, readonly P[]>>;
  readonly builtIns: readonly BuiltInRole<P, R>[];
  /** The role only its own holders may give: `super_admin`, or staff `admin`. */
  readonly topRoleKey: R;
  /** No custom role may hold these. */
  readonly restricted: readonly P[];
  /** The ID prefix of the realm's custom roles: `rol` (dashboard) or `srl` (staff). */
  readonly customRolePrefix: string;
  /** The permission that moves people off a role being deleted (`member.role`, `staff.role`). */
  readonly movePermission: P;
}

/** The permission keys of a catalogue. */
export type PermissionOf<C> = C extends Catalogue<infer P, string> ? P : never;

/** The built-in role keys of a catalogue. */
export type RoleKeyOf<C> = C extends Catalogue<string, infer R> ? R : never;

/** A custom role as its table stores it. Stored permission names are not trusted. */
export interface CustomRoleRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly string[];
}

/** A role Fin knows: a built-in by key, or a custom role read from its table. */
export type RoleRef<R extends string = string> =
  | { readonly kind: "built_in"; readonly key: R }
  | ({ readonly kind: "custom" } & CustomRoleRecord);

/**
 * What a stored role key resolves to: a role, a custom role that no longer exists (`gone`), or a
 * key Fin does not know (`unknown`). Both of the last two allow nothing.
 */
export type RoleLookup<R extends string = string> = RoleRef<R> | "gone" | "unknown";

/** Why a role may not be given (spec 02 §8.5). */
export type GivingProblem =
  | "unknown_role"
  | "gone"
  | "beyond"
  | "top_only"
  | "self"
  | "outranked"
  | "unchanged";

/** Why an actor may not remove, reset, resend or cancel for a target (spec 02 §8.5). */
export type ActingProblem = "self" | "outranked";

/** Why a custom role may not be edited or deleted (spec 02 §8.4). */
export type EditingProblem = "gone" | "built_in" | "self" | "outranked";

/**
 * Why a custom role may not be deleted with the given move (spec 02 §8.4): an editing problem
 * about the role itself (`gone` is the role), or one about the move: none given, the move
 * permission missing, the role to move to gone meanwhile (`move_gone`), or another reason that
 * role may not be given.
 */
export type DeletionProblem =
  | EditingProblem
  | Exclude<GivingProblem, "gone">
  | "move_gone"
  | "move_required"
  | "move_forbidden";

/** Why a role editor's draft is refused (spec 02 §8.1, §8.4). */
export type RoleProblem =
  | "name"
  | "name_taken"
  | "reads_as_built_in"
  | "description"
  | "empty"
  | "restricted"
  | "beyond"
  | "missing_need";
