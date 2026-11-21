// requireStaff (spec 02 §14.1, IF-04): the guard of every Fin Admin app route. It runs inside the
// route's `realm.run`, so the guard, the action, its audit event and the intent it spends share
// one unit of work, and reads everything again on every request, never from a cache:
//   1. the staff session, through the realm (the library reads the session row; the realm's
//      before-hook applies the staff gate of §6.4 and the Access check of §10.5: a removed member's
//      session is ended, and one presented under another Access identity is ended and refused);
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
 * Reads the request's staff session through the realm (step 1), or null when there is none.
 * Must run inside `realm.run`.
 */
export async function staffSessionOf(
  realm: Realm,
  request: Request,
  context: RequestContext,
): Promise<{ state: RealmState; tx: UnitTx } | null> {
  return realm.run(context, async (tx, state) => {
    await realm.api.getSession({ headers: request.headers });
    return state.prior === null ? null : { state, tx };
  });
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
    await realm.api.getSession({ headers: request.headers });
    const prior = state.prior;
    if (prior === null) {
      throw new AuthRefusal("unauthenticated", "gate.signed_out", {
        reason:
          typeof state.line.unauthenticated === "string"
            ? state.line.unauthenticated
            : "signed_out",
      });
    }
    await samePerson(realm, tx, state, context);
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
