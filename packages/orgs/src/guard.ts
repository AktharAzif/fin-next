// The console's guards (spec 02 §14.1, IF-04). `personGuard` reads the session through the library
// (refreshing it, with the Set-Cookie the refresh makes), applies the gate of §6.2 to the routes'
// reach, and returns the person with `confirm()`, which asks for or checks and consumes the route's
// step-up. `requireActor` adds the organisation from `Fin-Organization` (never the session, S2-10),
// the membership, and the role's permissions read now, on this request, so a permission taken from
// a role stops at the next request.
//
// The order is §7.1's and S2-31's: the session, the membership, the permission, then the route's own
// outrank, giving and input checks inside the team-change lock, and only then `confirm()`, so nobody
// proves a factor for something they cannot do. Both run inside `realm.run(context, ...)`, so the
// action, its audit events, its notices and the intent's consumption share one unit of work.
import type { DashboardPermission, RoleLookup } from "@fin/access";
import {
  AuthRefusal,
  hasFreshProof,
  paramsDigest,
  type Realm,
  type RequestContext,
  type UnitTx,
} from "@fin/identity";
import type { OrgAuditActor, ProofMethod, RequestFacts } from "./audit/record.ts";
import { notFound, OrgRefusal } from "./errors.ts";
import { isId } from "./ids.ts";
import {
  consumeIntent,
  createIntent,
  intentIdFrom,
  intentProblem,
  refuseIntent,
} from "./intents.ts";
import {
  type CustomRole,
  customRolesOf,
  lockOrganization,
  lookupRole,
  type MemberRow,
  membershipOf,
  type OrganizationRow,
  organizationById,
  permissionsFor,
} from "./store.ts";

/** The realm request state `realm.run` binds (its type, from the realm's own signature). */
export type RealmState = Parameters<Parameters<Realm["run"]>[1]>[1];
export type GateState = RealmState["gate"];
export type FactorMethod = "passkey" | "authenticator" | "backup_code";

export const ORGANIZATION_HEADER = "fin-organization";

/** The step-up a route declares (§7.6); `intent_if_factor` is the invitation's accept. */
export type StepUpRule =
  | { kind: "none" }
  | { kind: "window"; action: string }
  | { kind: "intent"; action: string }
  | { kind: "intent_if_factor"; action: string };

export interface Factors {
  passkeys: number;
  authenticator: boolean;
  count: number;
}

export interface Person {
  id: string;
  email: string;
  name: string;
  sessionId: string;
  assurance: "aal1" | "aal2";
  currentOrganizationId: string | null;
  gate: GateState;
  factors: Factors;
  privilegedAnywhere: boolean;
  productionMember: boolean;
  trustedBrowser: boolean;
}

export interface Guarded {
  person: Person;
  actor: OrgAuditActor;
  context: RequestFacts;
  requestId: string;
  /** `Set-Cookie` values the session's refresh produced, for the answer (§11.2). */
  setCookies: string[];
  state: RealmState;
  /**
   * Asks for, or checks and consumes, the route's step-up. Call it after the route's own checks and
   * before its first write; it throws the step-up refusal (which commits the new intent).
   */
  confirm(binding: {
    body: Readonly<Record<string, unknown>>;
    target: string | null;
    organizationId: string | null;
  }): Promise<void>;
}

export interface OrgActor extends Guarded {
  organization: OrganizationRow;
  member: MemberRow;
  role: RoleLookup;
  permissions: ReadonlySet<DashboardPermission>;
  roles: Map<string, CustomRole>;
}

export interface GuardOptions {
  /** The gate states the route may be reached at; `ok` only by default (§6.2). */
  reach?: readonly GateState[];
  stepUp: StepUpRule;
}

export interface ActorOptions extends GuardOptions {
  permission?: DashboardPermission;
  anyOf?: readonly DashboardPermission[];
  /** Take the team-change lock (§9.5): the organisation's row, before the membership is read. */
  lock?: boolean;
}

export function methodsOf(factors: Factors): FactorMethod[] {
  const methods: FactorMethod[] = [];
  if (factors.passkeys > 0) methods.push("passkey");
  if (factors.authenticator) methods.push("authenticator", "backup_code");
  return methods;
}

function gateRefusal(realm: Realm, state: RealmState, person: Person | null): AuthRefusal {
  realm.runtime.lines.write("auth.gate_refused", "warn", {
    realm: "developer",
    state: state.gate,
  });
  if (state.gate === "hold")
    return new AuthRefusal("second_factor_required", "gate.hold", { hold: true });
  return new AuthRefusal("factor_step_required", `gate.${state.gate}`, {
    methods: person === null ? [] : methodsOf(person.factors),
  });
}

/** The person-scope guard: the session, the gate and the route's step-up (§6.2, §7). */
export async function personGuard(
  realm: Realm,
  request: Request,
  context: RequestContext,
  tx: UnitTx,
  state: RealmState,
  options: GuardOptions,
): Promise<Guarded> {
  const safeMethod = request.method === "GET" || request.method === "HEAD";
  if (options.stepUp.kind !== "none" && safeMethod) {
    // A GET never makes or spends an intent or opens on a window (§2.3, [SA-44]); the route
    // policy's test refuses such a route, and so does this.
    throw new Error(`personGuard: a GET may not declare a step-up (${options.stepUp.action})`);
  }
  const read = (await realm.api.getSession({ headers: request.headers, returnHeaders: true })) as {
    headers: Headers | null;
  } | null;
  const setCookies = read?.headers?.getSetCookie() ?? [];
  const prior = state.prior;
  if (prior === null) {
    throw new AuthRefusal("unauthenticated", "gate.signed_out", {
      reason:
        typeof state.line.unauthenticated === "string" ? state.line.unauthenticated : "signed_out",
    });
  }
  const facts = prior.facts;
  const person: Person = {
    id: prior.person.id,
    email: prior.person.email,
    name: prior.person.name,
    sessionId: prior.session.id,
    assurance: prior.session.assurance,
    currentOrganizationId: prior.session.currentOrganizationId,
    gate: state.gate,
    factors: {
      passkeys: prior.factors.passkeys,
      authenticator: prior.factors.authenticator,
      count: prior.factors.count,
    },
    privilegedAnywhere: facts?.privilegedAnywhere === true,
    productionMember: facts?.productionMember === true,
    trustedBrowser: prior.session.trustedBrowserId !== null && prior.session.trustedBrowserLive,
  };
  const reach = options.reach ?? ["ok"];
  if (!reach.includes(state.gate)) throw gateRefusal(realm, state, person);

  const actor: OrgAuditActor = { kind: "user", id: person.id, via: "console" };
  const rule = options.stepUp;
  const guarded: Guarded = {
    person,
    actor,
    context: { clientIp: context.clientIp, userAgent: context.userAgent },
    requestId: context.requestId,
    setCookies,
    state,
    confirm: async (binding) => {
      if (rule.kind === "none") return;
      if (rule.kind === "intent_if_factor" && person.factors.count === 0) return;
      if (person.factors.count === 0) {
        throw new AuthRefusal("second_factor_required", "step_up.no_factor", { hold: false });
      }
      const methods = methodsOf(person.factors);
      if (rule.kind === "window") {
        state.line.stepUp = "window";
        if (!(await hasFreshProof(tx, "developer", person.sessionId))) {
          state.line.stepUpOutcome = "required";
          throw new AuthRefusal("step_up_required", "step_up.window", {
            step_up_kind: "window",
            methods,
            reason_key: rule.action,
          });
        }
        state.line.stepUpOutcome = "passed";
        return;
      }
      const action = realm.runtime.actions.get(rule.action);
      if (action === undefined || action.realm !== "developer") {
        throw new Error(`personGuard: ${rule.action} is not a developer step-up action`);
      }
      const intentBinding = {
        sessionId: person.sessionId,
        principalId: person.id,
        organizationId: binding.organizationId,
        action: action.key,
        digest: paramsDigest({
          realm: "developer",
          action: action.key,
          org: binding.organizationId,
          target: binding.target,
          body: binding.body,
          bind: action.bind,
        }),
      };
      state.line.stepUp = "intent";
      const intentId = intentIdFrom(request.headers);
      if (intentId === null) {
        const created = await createIntent(
          tx,
          { clock: realm.runtime.clock, limits: realm.runtime.limits },
          { ...intentBinding, reasonKey: action.reasonKey },
        );
        state.line.stepUpOutcome = "required";
        throw new AuthRefusal("step_up_required", "step_up.required", {
          intent_id: created.id,
          step_up_kind: "intent",
          methods,
          reason_key: action.reasonKey,
          expires_at: created.expiresAt.toISOString(),
        });
      }
      const problem = await intentProblem(tx, intentId, intentBinding);
      if (problem !== null) {
        state.line.stepUpOutcome = "invalid";
        throw refuseIntent(realm.runtime.lines, action.key, problem);
      }
      const method: ProofMethod | null = await consumeIntent(tx, intentId, intentBinding);
      if (method === null) {
        // Lost a race with a concurrent re-send of the same intent: nothing of this one is kept.
        state.line.stepUpOutcome = "invalid";
        realm.runtime.lines.write("step_up.refused", "warn", {
          realm: "developer",
          action: action.key,
          reason: "used",
        });
        throw new AuthRefusal(
          "step_up_invalid",
          "step_up.used",
          { reason: "used" },
          { rollback: true },
        );
      }
      actor.stepUp = { kind: "intent", method, ref: intentId };
      state.line.stepUpOutcome = "passed";
    },
  };
  return guarded;
}

/** The organisation a request names, as `Fin-Organization` carries it (S2-10, §9.1). */
export function organizationIdOf(request: Request): string {
  const raw = request.headers.get(ORGANIZATION_HEADER);
  if (raw === null || raw.trim() === "") {
    throw new OrgRefusal("organization_required", "org.header_missing");
  }
  const id = raw.trim();
  // An ID of another shape is answered as an unknown one.
  if (!isId(id, "org")) throw notFound("org.not_found");
  return id;
}

/**
 * The organisation-scope guard (§14.1): the person guard, then the organisation, the membership and
 * the role's permissions read now, then the route's permission. A missing header is
 * `400 organization_required`; an organisation the person does not belong to, or a deleted one, is
 * `404 not_found`, the same answer as an unknown ID.
 */
export async function requireActor(
  realm: Realm,
  request: Request,
  context: RequestContext,
  tx: UnitTx,
  state: RealmState,
  options: ActorOptions,
): Promise<OrgActor> {
  const guarded = await personGuard(realm, request, context, tx, state, options);
  const orgId = organizationIdOf(request);
  const organization =
    options.lock === true ? await lockOrganization(tx, orgId) : await organizationById(tx, orgId);
  if (organization === null) throw notFound("org.not_found");
  const member = await membershipOf(tx, orgId, guarded.person.id);
  if (member === null) throw notFound("org.not_member");
  state.line.orgId = orgId;
  const roles = await customRolesOf(tx, orgId);
  const role = lookupRole(roles, member.roleKey);
  const permissions = permissionsFor(role);
  const wanted = options.permission !== undefined ? [options.permission] : (options.anyOf ?? []);
  if (wanted.length > 0 && !wanted.some((p) => permissions.has(p))) {
    throw new OrgRefusal("forbidden", "policy.permission", {
      permission: options.permission ?? wanted.join(" "),
    });
  }
  return { ...guarded, organization, member, role, permissions, roles };
}
