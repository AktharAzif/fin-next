// The route policy (spec 02 §14.1, FW-C07): every Fin route under admin.<zone>/api/ is declared here
// with its guard, permission, step-up kind and action, the fields its intent binds, the assurance it
// may be reached at, its schemas, the limits it counts and the audit events it writes. The API half
// registers routes only from these entries (routes/register.ts), and policy.test.ts walks the Hono
// app and fails on any route without an entry or a schema, on a GET that declares an audit event,
// a budget or an intent, and on any change to the two routes reachable below aal2 (T-SAT-14).
import type { StaffPermission } from "@fin/access";
import type { z } from "zod";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RoutePolicy {
  /** A stable name, the key of the route's handler. */
  readonly id: string;
  readonly method: Method;
  /** The Hono path, `:name` for a path parameter. */
  readonly path: `/api/${string}`;
  /** Every Fin Admin route takes the staff guard behind the Access check (§14.3). */
  readonly guard: "requireStaff";
  readonly permission: StaffPermission | null;
  readonly scope: "staff";
  readonly stepUp: "none" | "window" | "intent";
  /** The step-up action (§7.6) when `stepUp` is not `none`. */
  readonly action: string | null;
  /** The request fields the intent's digest covers (§7.2): the action's own `bind` list. */
  readonly bind: readonly string[];
  /** `aal1_allowed` for exactly the two routes of §6.4; every other route needs aal2. */
  readonly assurance: "aal2_or_working" | "aal1_allowed";
  readonly params: z.ZodObject;
  readonly query: z.ZodObject | null;
  /** A strict object schema on every unsafe route; null on a GET. */
  readonly body: z.ZodObject | null;
  /** The Fin budgets the route counts (§5.6). */
  readonly limits: readonly string[];
  /** The audit events the route writes (§16.4). */
  readonly audit: readonly string[];
  /** The answer carries a secret shown once (an enrolment code): never replayed, never logged. */
  readonly secret: boolean;
  /**
   * A staff change (§10.8): the guard takes the staff-change lock before it reads the session, so
   * the session it renews is renewed inside the lock (@fin/staff's lock.ts).
   */
  readonly changeLock?: true;
  /** Only on a GET that redeems a minted URL (§2.3); none on Fin Admin yet. */
  readonly fetchSite?: "same-origin-or-none";
}

export function definePolicies<const T extends readonly RoutePolicy[]>(policies: T): T {
  const seen = new Set<string>();
  for (const policy of policies) {
    const key = `${policy.method} ${policy.path}`;
    if (seen.has(policy.id) || seen.has(key)) throw new Error(`route policy ${policy.id} twice`);
    seen.add(policy.id);
    seen.add(key);
  }
  return policies;
}
