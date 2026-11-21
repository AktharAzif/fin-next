// requirePerson (spec 02 §14.1, IF-04): the guard for the developer realm's person-scope app
// routes (Account security, the viewer, the first organisation). It reads the session through the
// library, applies the gate of §6.2 and then the step-up the route declares, always checking the
// session and the input before asking for a factor (S2-31). It returns the actor for recordAudit
// and, for an intent, the function that consumes it in the route's own transaction.
// `requireActor` (packages/orgs) and `requireStaff` (packages/staff) build on the same pieces.
import type { AuditActor } from "./audit/record.ts";
import type { GateState } from "./endpoint-policy.ts";
import { AuthRefusal } from "./errors.ts";
import { factorMethods } from "./gate.ts";
import type { UnitTx } from "./ports/db.ts";
import type { Realm } from "./realm.ts";
import type { RequestContext } from "./request.ts";
import type { BindField } from "./step-up/digest.ts";
import { paramsDigest } from "./step-up/digest.ts";
import {
  consumeIntent,
  createIntent,
  hasFreshProof,
  type IntentBinding,
  intentIdFrom,
  intentProblem,
  readIntent,
  refuseIntent,
} from "./step-up/intents.ts";

export type PersonStepUp =
  | { kind: "none" }
  | { kind: "window"; action: string }
  | {
      kind: "intent";
      action: string;
      body: Readonly<Record<string, unknown>>;
      /** The target ID the digest covers (a session, a browser row); the person by default. */
      target?: string;
      bind?: readonly BindField[];
    };

export interface PersonActor {
  actor: AuditActor;
  personId: string;
  email: string;
  sessionId: string;
  gate: GateState;
  /** Consumes the route's intent; call it in the action's transaction, after the input checks. */
  consume: () => Promise<void>;
}

export interface RequirePersonOptions {
  stepUp: PersonStepUp;
  /** The gate states the route may be reached at; `ok` only by default (§6.2). */
  reach?: readonly GateState[];
}

/**
 * Must run inside `realm.run(context, ...)`, so the route's action, its audit and the intent's
 * consumption share one unit of work.
 */
export async function requirePerson(
  realm: Realm,
  request: Request,
  context: RequestContext,
  options: RequirePersonOptions,
): Promise<PersonActor> {
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
    const reach = options.reach ?? ["ok"];
    if (!reach.includes(state.gate)) {
      realm.runtime.lines.write("auth.gate_refused", "warn", {
        realm: state.realm,
        state: state.gate,
      });
      if (state.gate === "hold")
        throw new AuthRefusal("second_factor_required", "gate.hold", { hold: true });
      throw new AuthRefusal("factor_step_required", `gate.${state.gate}`, {
        methods: factorMethods(state.realm, prior.factors),
      });
    }
    const base = {
      actor: { kind: "user", id: prior.person.id, via: "console" } as AuditActor,
      personId: prior.person.id,
      email: prior.person.email,
      sessionId: prior.session.id,
      gate: state.gate,
      consume: async () => undefined,
    };
    const stepUp = options.stepUp;
    if (stepUp.kind === "none") return base;
    if (prior.factors.count === 0)
      throw new AuthRefusal("second_factor_required", "step_up.no_factor", { hold: false });
    const methods = factorMethods(state.realm, prior.factors);
    if (stepUp.kind === "window") {
      state.line.stepUp = "window";
      if (!(await hasFreshProof(tx, state.realm, prior.session.id))) {
        state.line.stepUpOutcome = "required";
        throw new AuthRefusal("step_up_required", "step_up.window", {
          step_up_kind: "window",
          methods,
          reason_key: stepUp.action,
        });
      }
      return base;
    }
    const action = realm.runtime.actions.get(stepUp.action);
    if (action === undefined || action.realm !== state.realm) {
      throw new Error(`requirePerson: ${stepUp.action} is not a ${state.realm} step-up action`);
    }
    const binding: IntentBinding = {
      realm: state.realm,
      sessionId: prior.session.id,
      principalId: prior.person.id,
      organizationId: null,
      action: action.key,
      digest: paramsDigest({
        realm: state.realm,
        action: action.key,
        org: null,
        target: stepUp.target ?? prior.person.id,
        body: stepUp.body,
        bind: stepUp.bind ?? action.bind,
      }),
    };
    state.line.stepUp = "intent";
    const headerId = intentIdFrom(request.headers);
    if (headerId === null) {
      const created = await createIntent(tx, realm.runtime, {
        ...binding,
        reasonKey: action.reasonKey,
      });
      state.line.stepUpOutcome = "required";
      throw new AuthRefusal("step_up_required", "step_up.required", {
        intent_id: created.id,
        step_up_kind: "intent",
        methods,
        reason_key: action.reasonKey,
        expires_at: created.expiresAt.toISOString(),
      });
    }
    const problem = intentProblem(await readIntent(tx, headerId), binding);
    if (problem !== null) {
      state.line.stepUpOutcome = "invalid";
      throw refuseIntent(realm.runtime.lines, state.realm, action.key, problem);
    }
    const intentId = headerId;
    const result: PersonActor = { ...base };
    result.consume = async () => {
      const method = await consumeIntent(tx as UnitTx, intentId, binding, context.requestId);
      if (method === null) {
        throw new AuthRefusal(
          "step_up_invalid",
          "step_up.used",
          { reason: "used" },
          { rollback: true },
        );
      }
      result.actor = { ...result.actor, stepUp: { kind: "intent", method, ref: intentId } };
      state.line.stepUpOutcome = "passed";
    };
    return result;
  });
}
