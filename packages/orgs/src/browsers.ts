// Trusted browsers a team change revokes (spec 02 §6.6, [SA-31], S2-40): any role elevation, the
// person's own removal, and joining an organisation with Production access. Each revoked row writes
// the identity area's `browser.trust_revoked` with its reason, in the change's transaction; the
// trusted-browser table's guard refuses a revocation without it (§13.8).
import type { UnitTx } from "@fin/identity";
import type { OrgAuditActor, RequestFacts } from "./audit/record.ts";
import type { Orgs } from "./orgs.ts";

export type TrustRevocation = "role_elevated" | "production_access" | "removed";

export async function revokeTrustedBrowsers(
  orgs: Orgs,
  tx: UnitTx,
  userIds: readonly string[],
  reason: TrustRevocation,
  actor: OrgAuditActor,
  context: RequestFacts,
): Promise<number> {
  if (userIds.length === 0) return 0;
  const revoked = await tx.query<{ id: string; user_id: string }>(
    `UPDATE identity.trusted_browser SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = ANY($1::text[]) AND revoked_at IS NULL
      RETURNING id, user_id`,
    [[...new Set(userIds)], reason],
  );
  for (const row of revoked.rows) {
    await orgs.realm.runtime.audit(tx, {
      event: "browser.trust_revoked",
      actor,
      target: row.id,
      refs: [row.user_id],
      subjectUserId: row.user_id,
      metadata: { reason },
      context,
    });
  }
  return revoked.rows.length;
}
