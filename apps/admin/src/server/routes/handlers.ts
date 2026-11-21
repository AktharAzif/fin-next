// Fin Admin's route handlers, one per route-policy entry (spec 02 §14.3). Each runs its work in the
// staff realm's unit of work (`realm.run`): requireStaff with the entry's permission and the
// assurance it may be reached at, then the action from @fin/staff, whose intent, audit event,
// revocation-journal entry and notices commit with it or not at all. The session read's
// `Set-Cookie` values go to the request's collector, which registerRoutes copies onto the answer.
// An answer that carries an enrolment code is sent once, with `Cache-Control: no-store` (every
// answer of the host has it).
import type { StaffPermission } from "@fin/access";
import type { Realm, RequestContext } from "@fin/identity";
import {
  addStaff,
  changeStaffRole,
  getStaffRole,
  type IssuedCode,
  listStaff,
  listStaffRoles,
  listSwitches,
  newEnrolmentCode,
  redeemCode,
  removeStaff,
  requireStaff,
  resetStaffFactors,
  revokeOtherStaffSessions,
  revokeStaffSession,
  type StaffActor,
  type StaffDeps,
  StaffRefusal,
  setSwitch,
  staffAccount,
  staffViewer,
  type UnitTx,
} from "@fin/staff";
import type { AdminPolicy, PolicyId } from "../policy/index.ts";
import { ADMIN_POLICIES } from "../policy/index.ts";
import { auditHandlers } from "./audit.ts";
import type { HandlerArgs, RouteAnswer, RouteHandler } from "./register.ts";

function codeAnswer(code: IssuedCode) {
  return {
    enrolmentCode: code.code,
    enrolmentCodeId: code.id,
    expiresAt: code.expiresAt.toISOString(),
  };
}

function policyOf(id: PolicyId): AdminPolicy {
  const policy = ADMIN_POLICIES.find((p) => p.id === id);
  if (policy === undefined) throw new Error(`no policy ${id}`);
  return policy;
}

/** Runs a guarded route's work: requireStaff as the policy says, then `fn`, in one unit. */
function guarded<T>(
  realm: Realm,
  id: PolicyId,
  fn: (tx: UnitTx, who: StaffActor, args: HandlerArgs) => Promise<T>,
): (args: HandlerArgs) => Promise<T> {
  const policy = policyOf(id);
  const permission = (policy.permission ?? undefined) as StaffPermission | undefined;
  const reach = policy.assurance === "aal1_allowed" ? (["pending"] as const) : (["ok"] as const);
  return (args) =>
    realm.run(args.context, async (tx) => {
      const who = await requireStaff(realm, args.c.req.raw, args.context, {
        ...(permission === undefined ? {} : { permission }),
        reach,
        setCookies: args.setCookies,
      });
      return fn(tx, who, args);
    });
}

const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const created = (body: unknown): RouteAnswer => ({ status: 201, body });
const str = (value: unknown): string => String(value);

export function adminHandlers(deps: StaffDeps): Readonly<Record<PolicyId, RouteHandler>> {
  const { realm } = deps;
  return {
    ...auditHandlers(deps, guarded),
    "viewer.get": async ({ c, context, setCookies }: HandlerArgs) =>
      ok(
        await staffViewer(realm, c.req.raw, context as RequestContext, deps.environment, {
          setCookies,
        }),
      ),

    "enrolment.redeem": async (args) => {
      const result = await guarded(realm, "enrolment.redeem", (tx, who, { input }) =>
        redeemCode(deps, tx, who, str(input.body.code)),
      )(args);
      if (!result.ok) {
        return {
          refusal: new StaffRefusal("invalid", `staff.enrolment.${result.reason}`, {
            reason: result.reason,
          }),
        };
      }
      return ok({ enrolmentOpenUntil: result.windowUntil.toISOString() });
    },

    "account.get": async (args) =>
      ok(await guarded(realm, "account.get", (tx, who) => staffAccount(tx, who))(args)),

    "account.session_revoke": async (args) =>
      ok(
        await guarded(realm, "account.session_revoke", (tx, who, { input }) =>
          revokeStaffSession(deps, tx, who, str(input.params.sessionId)),
        )(args),
      ),

    "account.sessions_revoke_others": async (args) =>
      ok(
        await guarded(realm, "account.sessions_revoke_others", (tx, who) =>
          revokeOtherStaffSessions(deps, tx, who),
        )(args),
      ),

    "staff.list": async (args) =>
      ok(
        await guarded(realm, "staff.list", (tx, who, { input }) =>
          listStaff(tx, who, { page: Number(input.query.page), size: Number(input.query.size) }),
        )(args),
      ),

    "staff.add": async (args) => {
      const added = await guarded(realm, "staff.add", (tx, who, { input }) =>
        addStaff(deps, tx, who, { email: str(input.body.email), roleKey: str(input.body.roleKey) }),
      )(args);
      return created({
        staffId: added.staffId,
        email: added.email,
        roleKey: added.roleKey,
        roleLabel: added.roleLabel,
        status: added.status,
        reactivated: added.reactivated,
        ...codeAnswer(added.enrolmentCode),
      });
    },

    "staff.role": async (args) =>
      ok(
        await guarded(realm, "staff.role", (tx, who, { input }) =>
          changeStaffRole(deps, tx, who, str(input.params.staffId), {
            roleKey: str(input.body.roleKey),
          }),
        )(args),
      ),

    "staff.remove": async (args) => {
      const removed = await guarded(realm, "staff.remove", (tx, who, { input }) =>
        removeStaff(deps, tx, who, str(input.params.staffId)),
      )(args);
      // The address leaves the Access list next (§10.1): the screen shows the reminder.
      return ok({ ...removed, accessListReminder: true });
    },

    "staff.reset_factors": async (args) => {
      const reset = await guarded(realm, "staff.reset_factors", (tx, who, { input }) =>
        resetStaffFactors(deps, tx, who, str(input.params.staffId)),
      )(args);
      return ok({
        staffId: reset.staffId,
        status: reset.status,
        ...codeAnswer(reset.enrolmentCode),
      });
    },

    "staff.enrolment_code": async (args) => {
      const issued = await guarded(realm, "staff.enrolment_code", (tx, who, { input }) =>
        newEnrolmentCode(deps, tx, who, str(input.params.staffId)),
      )(args);
      return created({ staffId: issued.staffId, ...codeAnswer(issued.enrolmentCode) });
    },

    "staff_roles.list": async (args) =>
      ok({ roles: await guarded(realm, "staff_roles.list", (tx) => listStaffRoles(tx))(args) }),

    "staff_roles.get": async (args) =>
      ok(
        await guarded(realm, "staff_roles.get", (tx, _who, { input }) =>
          getStaffRole(tx, str(input.params.roleKey)),
        )(args),
      ),

    "switches.list": async (args) =>
      ok({ switches: await guarded(realm, "switches.list", (tx) => listSwitches(tx))(args) }),

    "switches.set": async (args) =>
      ok(
        await guarded(realm, "switches.set", (tx, who, { input }) =>
          setSwitch(deps, tx, who, str(input.params.switchName), {
            state: input.body.state as "on" | "off",
            reasonCode: str(input.body.reasonCode),
          }),
        )(args),
      ),
  };
}
