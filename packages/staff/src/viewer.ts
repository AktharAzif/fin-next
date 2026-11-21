// Fin Admin's `GET /api/viewer` (spec 02 §14.4): reachable in every staff state (`aal1_allowed`),
// answering
//   { state: "signed_out", accessEmail }      no live session (the sign-in field is prefilled)
//   { state: "pending", email }               aal1, no factor yet: enrolment only
//   { state: "factor_step", email, methods }  aal1 with a factor
//   { state: "ok", staff, permissions, environment }
// The session, the same-person check and the role are read now, as on every route. A GET writes no
// audit row of its own and spends nothing.
import type { StaffPermission } from "@fin/access";
import { AuthRefusal, type Realm, type RequestContext } from "@fin/identity";
import {
  resolveStaffRole,
  STAFF_CATALOGUE,
  staffPermissionsOf,
  staffRoleLabel,
} from "./catalogue.ts";
import { type FactorMethod, methodsOf } from "./require-staff.ts";

export type StaffViewer =
  | { state: "signed_out"; accessEmail: string | null }
  | { state: "pending"; email: string }
  | { state: "factor_step"; email: string; methods: FactorMethod[] }
  | {
      state: "ok";
      staff: { id: string; email: string; roleKey: string; roleLabel: string };
      permissions: StaffPermission[];
      environment: string;
    };

export async function staffViewer(
  realm: Realm,
  request: Request,
  context: RequestContext,
  environment: string,
): Promise<StaffViewer> {
  return realm.run(context, async (tx, state) => {
    await realm.api.getSession({ headers: request.headers });
    const prior = state.prior;
    const access = context.access ?? null;
    if (prior === null) {
      return { state: "signed_out", accessEmail: access?.email.trim().toLowerCase() ?? null };
    }
    if (
      access === null ||
      prior.session.accessSub !== access.sub ||
      prior.person.email !== access.email.trim().toLowerCase()
    ) {
      await tx.query("DELETE FROM staff.session WHERE id = $1", [prior.session.id]);
      realm.runtime.lines.write("staff.access_mismatch", "warn", { staffId: prior.person.id });
      throw new AuthRefusal("access_mismatch", "staff.access_mismatch");
    }
    const factors = {
      passkeys: prior.factors.passkeys,
      authenticator: prior.factors.authenticator,
      count: prior.factors.count,
    };
    if (state.gate === "pending") return { state: "pending", email: prior.person.email };
    if (state.gate !== "ok") {
      return { state: "factor_step", email: prior.person.email, methods: methodsOf(factors) };
    }
    const roleKey = prior.person.roleKey ?? "";
    const role = await resolveStaffRole(tx, roleKey);
    const held = staffPermissionsOf(role);
    return {
      state: "ok",
      staff: {
        id: prior.person.id,
        email: prior.person.email,
        roleKey,
        roleLabel: staffRoleLabel(role),
      },
      permissions: STAFF_CATALOGUE.keys.filter((key) => held.has(key)),
      environment,
    };
  });
}
