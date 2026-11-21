// GET /api/viewer (spec 02 §14.4): who the session is, where the gate holds it, and what it may do in
// the organisation the SPA opens. At the factor step it answers only the address and the methods; a
// signed-out request is `401 unauthenticated` (the guard's). Everything is read now, on this request,
// never cached: a permission taken from a role is gone from the next viewer.
import type { Realm, UnitTx } from "@fin/identity";
import {
  customRolesOfMany,
  type Guarded,
  labelOf,
  lookupRole,
  membershipsOfPerson,
  methodsOf,
  type Orgs,
  pendingInvitationsFor,
  permissionsFor,
} from "@fin/orgs";
import { symmetricDecrypt } from "better-auth/crypto";

export type ConsoleViewer =
  | {
      gate: "factor_step";
      email: string;
      methods: ("passkey" | "authenticator" | "backup_code")[];
    }
  | {
      gate: "ok" | "protect_account";
      user: { id: string; name: string; email: string };
      assurance: "aal1" | "aal2";
      factors: { passkeys: number; authenticator: boolean; backupCodesLeft: number | null };
      canSkipProtect: boolean;
      canTrustBrowser: boolean;
      memberships: {
        orgId: string;
        name: string;
        roleKey: string;
        roleLabel: string;
        roleKnown: boolean;
        liveStatus: string;
      }[];
      currentOrgId: string | null;
      permissions: string[];
      invitations: { invitationId: string; orgName: string; roleLabel: string; expiresAt: string }[];
    };

/** How many backup codes the person has left, or null without an authenticator (§5.4). */
async function backupCodesLeft(realm: Realm, tx: UnitTx, userId: string): Promise<number | null> {
  const row = await tx.query<{ backup_codes: string | null; verified: boolean }>(
    "SELECT backup_codes, verified FROM identity.two_factor WHERE user_id = $1",
    [userId],
  );
  const stored = row.rows[0];
  if (stored === undefined || !stored.verified) return null;
  if (stored.backup_codes === null || stored.backup_codes === "") return 0;
  // The library keeps them encrypted under the realm's secrets; only their count leaves here.
  const context = (await realm.auth.$context) as unknown as { secretConfig: unknown };
  const plain = await symmetricDecrypt({
    key: context.secretConfig as Parameters<typeof symmetricDecrypt>[0]["key"],
    data: stored.backup_codes,
  });
  const codes: unknown = JSON.parse(plain);
  return Array.isArray(codes) ? codes.length : 0;
}

export async function viewerOf(orgs: Orgs, tx: UnitTx, who: Guarded): Promise<ConsoleViewer> {
  const { person } = who;
  if (person.gate === "factor_step") {
    return { gate: "factor_step", email: person.email, methods: methodsOf(person.factors) };
  }
  const memberships = await membershipsOfPerson(tx, person.id);
  const roles = await customRolesOfMany(
    tx,
    memberships.map((m) => m.orgId),
  );
  const resolved = memberships.map((m) => {
    const role = lookupRole(roles.get(m.orgId) ?? new Map(), m.roleKey);
    return { membership: m, role, known: typeof role !== "string" };
  });
  const current =
    resolved.find((r) => r.known && r.membership.orgId === person.currentOrganizationId) ??
    resolved.find((r) => r.known);
  return {
    gate: person.gate === "hold" ? "protect_account" : "ok",
    user: { id: person.id, name: person.name, email: person.email },
    assurance: person.assurance,
    factors: {
      passkeys: person.factors.passkeys,
      authenticator: person.factors.authenticator,
      backupCodesLeft: await backupCodesLeft(orgs.realm, tx, person.id),
    },
    canSkipProtect: person.gate === "ok" && person.factors.count === 0,
    canTrustBrowser:
      person.factors.authenticator && !person.privilegedAnywhere && !person.productionMember,
    memberships: resolved.map((r) => ({
      orgId: r.membership.orgId,
      name: r.membership.orgName,
      roleKey: r.membership.roleKey,
      roleLabel: labelOf(r.role),
      roleKnown: r.known,
      liveStatus: r.membership.liveStatus,
    })),
    currentOrgId: current?.membership.orgId ?? null,
    permissions: current === undefined ? [] : [...permissionsFor(current.role)],
    invitations: await pendingInvitationsFor(orgs, tx, person.email),
  };
}
