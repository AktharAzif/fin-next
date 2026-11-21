// The mandatory-second-factor gate, evaluated on every request with a session, never cached
// (spec 02 §6.2 to §6.4, [SA-04], [SA-05], [SA-31]). The developer gate reads one call to
// `identity.person_gate(user_id)`; the staff gate reads the member and its factors, and the
// Access identity verified at the front door.

import { MINUTE } from "./ports/clock.ts";
import type { Queryable } from "./ports/db.ts";
import type { FactorFacts, PersonRow, SessionRow } from "./store.ts";

/** §8.2's privileged permissions; `identity.privileged_permission` holds the same set (S2-33). */
export const PRIVILEGED_PERMISSIONS = [
  "money.beneficiaries",
  "money.transfer",
  "webhooks.manage",
  "webhooks.roll_secret",
  "apiKey.live",
  "member.invite",
  "member.role",
  "role.manage",
  "organization.update",
  "organization.delete",
  "golive.submit",
] as const;

/** An aal1 session at the factor step or enrolment lives 10 minutes (§11.1, S2-07). */
export const FACTOR_STEP_LIFETIME_MS = 10 * MINUTE;
/** The first factor may be added only within 15 minutes of proving the mailbox (§6.3). */
export const FIRST_FACTOR_WINDOW_MS = 15 * MINUTE;

export interface PersonGateFacts {
  factorCount: number;
  privilegedAnywhere: boolean;
  productionMember: boolean;
}

export async function personGate(db: Queryable, userId: string): Promise<PersonGateFacts> {
  const result = await db.query<{
    factor_count: number;
    privileged_anywhere: boolean;
    production_member: boolean;
  }>("SELECT factor_count, privileged_anywhere, production_member FROM identity.person_gate($1)", [
    userId,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error("identity.person_gate returned no row");
  return {
    factorCount: Number(row.factor_count),
    privilegedAnywhere: row.privileged_anywhere,
    productionMember: row.production_member,
  };
}

export type DeveloperGate = "factor_step" | "hold" | "ok";

/** May this person be offered, or keep using, a trusted browser (§6.6)? */
export function trustedBrowserEligible(facts: PersonGateFacts): boolean {
  return !facts.privilegedAnywhere && !facts.productionMember;
}

/**
 * The developer gate (§6.2). A trusted-browser session counts as working only while its person
 * is still eligible: once privileged anywhere or a member of an organisation with Production
 * access, it is at the factor step from its next request (S2-40).
 */
export function developerGate(session: SessionRow, facts: PersonGateFacts): DeveloperGate {
  if (session.assurance === "aal1" && facts.factorCount > 0) {
    const trusted = session.trustedBrowserId !== null && trustedBrowserEligible(facts);
    if (!trusted) return "factor_step";
  }
  if (facts.factorCount === 0 && facts.privilegedAnywhere) return "hold";
  return "ok";
}

/** "Skip for now" shows only in state `ok` with no factor (§6.2). */
export function canSkipProtect(gate: DeveloperGate, facts: PersonGateFacts): boolean {
  return gate === "ok" && facts.factorCount === 0;
}

export type StaffGate = "pending" | "factor_step" | "ok";

export type StaffGateResult = { state: StaffGate } | { refused: "removed" | "access_mismatch" };

/**
 * The staff gate (§6.4): a removed member or a session whose member is not the Access identity
 * is refused outright; `aal1` is pending (no factor) or the factor step; `ok` needs `aal2`.
 */
export function staffGate(
  session: SessionRow,
  member: PersonRow,
  factors: FactorFacts,
  accessEmail: string | null,
): StaffGateResult {
  if (member.status === "removed") return { refused: "removed" };
  if (accessEmail === null || member.email !== accessEmail.toLowerCase()) {
    return { refused: "access_mismatch" };
  }
  if (session.assurance === "aal2" && factors.count > 0 && member.status === "active") {
    return { state: "ok" };
  }
  return { state: factors.count === 0 ? "pending" : "factor_step" };
}

/** Whether an aal1 factor-step or enrolment session has outlived its 10 minutes. */
export function factorStepExpired(session: SessionRow, now: Date): boolean {
  return now.getTime() - session.createdAt.getTime() > FACTOR_STEP_LIFETIME_MS;
}

/** The first-factor rule (§6.3): the mailbox was proved in this session within 15 minutes. */
export function mailboxFresh(session: SessionRow, now: Date): boolean {
  return (
    session.mailboxProvedAt !== null &&
    now.getTime() - session.mailboxProvedAt.getTime() <= FIRST_FACTOR_WINDOW_MS
  );
}

/** The factor methods a person can use at a step-up or the factor step. */
export function factorMethods(
  realm: "developer" | "staff",
  factors: FactorFacts,
): ("passkey" | "authenticator" | "backup_code")[] {
  const methods: ("passkey" | "authenticator" | "backup_code")[] = [];
  if (factors.passkeys > 0) methods.push("passkey");
  if (factors.authenticator) {
    methods.push("authenticator");
    if (realm === "developer") methods.push("backup_code");
  }
  return methods;
}
