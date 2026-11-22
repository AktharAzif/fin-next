// The console's route policy (spec 02 §14.1, FW-C07): every Fin route under /api is declared here
// with its guard, scope, permission, step-up kind and action, the fields its intent binds, the gate
// states that reach it, its body and query schemas, its path IDs, its limits and the audit events it
// writes. The router is built from these entries alone, and policy.test.ts walks the Hono app and
// fails on a route missing from the policy or without schemas, and on a GET that declares an audit
// event, a budget or a step-up (§2.3, [SA-44]).
import type { DashboardPermission } from "@fin/access";
import type { GateState } from "@fin/orgs";
import type * as z from "zod";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Guard = "public" | "requirePerson" | "requireActor";

export type Scope = "public" | "person" | "organization";

export type StepUpKind = "none" | "window" | "intent" | "intent_if_factor";

/** The ID prefixes a path parameter must carry; another shape is answered as `404 not_found`. */
export type PathId = "inv" | "mem" | "rol" | "ses" | "tbr" | "role_key" | "key_id";

export interface RoutePolicy {
  /** A stable name for the route, the key of its handler. */
  readonly id: string;
  readonly method: Method;
  /** The Hono pattern under /api, as the router registers it. */
  readonly path: string;
  readonly guard: Guard;
  readonly scope: Scope;
  /** The permission the role must hold now (organisation routes). */
  readonly permission?: DashboardPermission;
  /** Any one of these instead (the credentials list: `member.invite` or `member.role`). */
  readonly anyOf?: readonly DashboardPermission[];
  readonly stepUp: StepUpKind;
  /** The step-up action key (spec 02 §7.6) for a window or an intent. */
  readonly action?: string;
  /** The body fields the intent's digest covers, as the action catalogue lists them. */
  readonly bind?: readonly string[];
  /** Every route here needs a working session (`aal2`, or the gate's `ok` at `aal1`). */
  readonly assurance: "aal2_or_working" | "none";
  /** The gate states that reach the route; `ok` only unless listed (§6.2). */
  readonly reach?: readonly GateState[];
  /** Whether the route takes the team-change lock (§9.5). */
  readonly lock?: boolean;
  /** The path's IDs and the prefix each must carry. */
  readonly params?: Readonly<Record<string, PathId>>;
  /** The JSON body's schema, or "none" for a body-less request. */
  readonly body: z.ZodType | "none";
  /** The query's schema, or "none" when the route takes no query. */
  readonly query: z.ZodType | "none";
  /** The budgets (spec 02 §5.6) the route counts. */
  readonly limits: readonly string[];
  /** The audit events the route writes (spec 02 §16). */
  readonly audit: readonly string[];
  /** On a GET that redeems a minted URL only (§2.3); none on the console. */
  readonly fetchSite?: "same-origin-or-none";
}

export function route<const P extends RoutePolicy>(policy: P): P {
  return Object.freeze(policy);
}
