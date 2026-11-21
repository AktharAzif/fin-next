// requireStaff (spec 02 §14.1, IF-04): the guard of every Fin Admin app route. It runs inside the
// route's `realm.run`, so the guard, the action, its audit event and the intent it spends share
// one unit of work, and reads everything again on every request, never from a cache:
//   1. the staff session, through the realm (the library reads the session row and renews it;
//      the realm's before-hook applies the staff gate of §6.4 and the Access check of §10.5: a
//      removed member's session is ended, and one presented under another Access identity is ended
//      and refused). The `Set-Cookie` values the read produced go to the answer (§11.2), so a
//      renewed session's cookie lives as long as its row. With no session, an Access identity
//      the staff table does not list (or lists as removed) writes `staff.not_listed` (§18.1);
//   2. the same person, again here: the session's Access `sub` equals the verified token's `sub`,
//      and the member's address equals the token's address (case-insensitive), or the session is
//      ended, `staff.access_mismatch` is written and the answer is `403 access_mismatch`;
//   3. the gate state the route may be reached at: `ok` (aal2, an active member) unless the route
//      is one of the two `aal1_allowed` ones (§6.4); anything else at aal1 is
//      `403 factor_step_required`, and a pending member holds no permission at all;
//   4. the member's role, resolved now, and the route's permission (`403 forbidden`).
// The intent, when the route takes one, is asked for later, after the route's own checks (S2-31).
import type { StaffPermission } from "@fin/access";
import { AuthRefusal, type Realm, type RequestContext } from "@fin/identity";
import type { AuditActorInput } from "./audit/record.ts";
import { resolveStaffRole, type StaffRoleLookup, staffPermissionsOf } from "./catalogue.ts";
import type { RequestFacts, UnitTx } from "./ports.ts";
import { requireIntent, type StepUpRef, type StepUpRequest } from "./step-up.ts";

export type StaffGateState = "signed_out" | "pending" | "factor_step" | "ok";

export type FactorMethod = "passkey" | "authenticator";

export interface StaffFactors {
  passkeys: number;
  authenticator: boolean;
  count: number;
}

/** The staff member a guarded request acts as, read now. */
export interface StaffActor {
  staffId: string;
  email: string;
  sessionId: string;
  gate: Exclude<StaffGateState, "signed_out">;
  status: "pending" | "active";
  roleKey: string;
  role: StaffRoleLookup;
  /** Empty for a pending member (§6.4). */
  permissions: ReadonlySet<StaffPermission>;
  factors: StaffFactors;
  methods: readonly FactorMethod[];
  /** The audit actor, without a step-up until `stepUp` adds one. */
  actor: AuditActorInput;
  request: RequestFacts;
  /** The intent check for this request's action; call it after the route's own checks. */
  stepUp(tx: UnitTx, request: StepUpRequest): Promise<StepUpRef>;
}

export interface RequireStaffOptions {
  /** The permission the route needs; none for the staff member's own routes. */
  permission?: StaffPermission;
  /** The gate states the route may be reached at; `ok` only unless the route is aal1_allowed. */
  reach?: readonly Exclude<StaffGateState, "signed_out">[];
  /**
   * Collects the `Set-Cookie` values reading the session produced (a renewed session cookie, or
   * the clearing of a dead one), for the API half to copy onto an answer whose unit committed.
   */
  setCookies?: string[];
}

type RealmState = Parameters<Parameters<Realm["run"]>[1]>[1];

export function methodsOf(factors: StaffFactors): FactorMethod[] {
  const methods: FactorMethod[] = [];
  if (factors.passkeys > 0) methods.push("passkey");
  if (factors.authenticator) methods.push("authenticator");
  return methods;
}

/** The request facts every Fin Admin audit row carries ([BC-03]). */
export function requestFacts(context: RequestContext): RequestFacts {
  return {
    requestId: context.requestId,
    clientIp: context.clientIp,
    userAgent: context.userAgent === null ? null : context.userAgent.slice(0, 400),
  };
}

/**
 * Step 1: reads the staff session through the library, which renews it once its renewal age has
 * passed (§11.1), and returns the `Set-Cookie` values the read produced (§11.2).
 */
export async function readStaffSession(realm: Realm, request: Request): Promise<string[]> {
  const read = (await realm.api.getSession({
    headers: request.headers,
    returnHeaders: true,
  })) as { headers?: Headers | null } | null;
  return read?.headers?.getSetCookie() ?? [];
}

/**
 * §18.1, S2-24: a request with no live staff session from an Access identity the staff table does
 * not list, or lists as removed, writes `staff.not_listed` (the `admin-staff-refused` page): the
 * Access list let in someone who is not staff. A listed member who is signed out writes nothing.
 */
export async function noteNotListed(
  realm: Realm,
  tx: UnitTx,
  context: RequestContext,
): Promise<void> {
  const access = context.access ?? null;
  if (access === null) return;
  const member = await tx.query<{ status: string }>(
    "SELECT status FROM staff.member WHERE email = $1",
    [access.email.trim().toLowerCase()],
  );
  const status = member.rows[0]?.status;
  if (status === "active" || status === "pending") return;
  realm.runtime.lines.write("staff.not_listed", "warn", { reason: "request" });
}

/** Step 2: the session, its member and the verified Access identity are one person. */
async function samePerson(
  realm: Realm,
  tx: UnitTx,
  state: RealmState,
  context: RequestContext,
): Promise<void> {
  const prior = state.prior;
  if (prior === null) return;
  const access = context.access ?? null;
  if (
    access !== null &&
    prior.session.accessSub !== null &&
    prior.session.accessSub === access.sub &&
    prior.person.email === access.email.trim().toLowerCase()
  ) {
    return;
  }
  await tx.query("DELETE FROM staff.session WHERE id = $1", [prior.session.id]);
  realm.runtime.lines.write("staff.access_mismatch", "warn", { staffId: prior.person.id });
  throw new AuthRefusal("access_mismatch", "staff.access_mismatch");
}

export async function requireStaff(
  realm: Realm,
  request: Request,
  context: RequestContext,
  options: RequireStaffOptions = {},
): Promise<StaffActor> {
  if (realm.settings.realm !== "staff") throw new Error("requireStaff runs on the staff realm");
  return realm.run(context, async (tx, state) => {
    const setCookies = await readStaffSession(realm, request);
    const prior = state.prior;
    if (prior === null) {
      options.setCookies?.push(...setCookies);
      await noteNotListed(realm, tx, context);
      throw new AuthRefusal("unauthenticated", "gate.signed_out", {
        reason:
          typeof state.line.unauthenticated === "string"
            ? state.line.unauthenticated
            : "signed_out",
      });
    }
    await samePerson(realm, tx, state, context);
    // The same person: the renewal stands, whatever the checks below answer (§11.2).
    options.setCookies?.push(...setCookies);
    const gate = state.gate as StaffGateState;
    const factors: StaffFactors = {
      passkeys: prior.factors.passkeys,
      authenticator: prior.factors.authenticator,
      count: prior.factors.count,
    };
    const methods = methodsOf(factors);
    const reach = options.reach ?? ["ok"];
    if (gate === "signed_out" || !(reach as readonly string[]).includes(gate)) {
      realm.runtime.lines.write("auth.gate_refused", "warn", { realm: "staff", state: gate });
      // A working session on the pending member's enrolment route has nothing to redeem.
      if (gate === "ok") throw new AuthRefusal("forbidden", "gate.not_pending");
      throw new AuthRefusal("factor_step_required", `gate.${gate}`, {
        methods: gate === "factor_step" ? methods : [],
      });
    }
    const status = prior.person.status;
    if (status !== "active" && status !== "pending") {
      throw new AuthRefusal("unauthenticated", "gate.removed", { reason: "signed_out" });
    }
    const roleKey = prior.person.roleKey ?? "";
    const role = await resolveStaffRole(tx, roleKey);
    // A pending member holds no permission at all (§6.4); an unknown role allows nothing.
    const permissions = gate === "ok" ? staffPermissionsOf(role) : new Set<StaffPermission>();
    if (options.permission !== undefined && !permissions.has(options.permission)) {
      realm.runtime.lines.write("staff.permission_refused", "warn", {
        staffId: prior.person.id,
        permission: options.permission,
      });
      throw new AuthRefusal("forbidden", "staff.permission", { permission: options.permission });
    }
    const staffId = prior.person.id;
    const sessionId = prior.session.id;
    const facts = requestFacts(context);
    return {
      staffId,
      email: prior.person.email,
      sessionId,
      gate,
      status,
      roleKey,
      role,
      permissions,
      factors,
      methods,
      actor: { kind: "staff", id: staffId },
      request: facts,
      stepUp: (unit, step) =>
        requireIntent(
          realm,
          unit,
          request.headers,
          context.requestId,
          {
            sessionId,
            staffId,
            methods,
          },
          step,
        ),
    };
  });
}
