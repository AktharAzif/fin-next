// Enrolment codes on Postgres 18 (spec 02 §6.5, [SA-29]; T-SAT-12, T-SAT-34's code half): a code
// this package issues is the one @fin/identity's realm redeems (the same normalisation and hash),
// one live code per member, alive 30 minutes, once; its event carries the request's address.
import { redeemEnrolmentCode } from "@fin/identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaffHarness, DROP_TIMEOUT_MS, type StaffHarness, unique } from "../test/harness.ts";
import { ENROLMENT_CODE_LIFETIME_MS, issueEnrolmentCode } from "./enrolment-codes.ts";

let h: StaffHarness;

beforeAll(async () => {
  h = await createStaffHarness("sat04codes");
}, 120_000);

afterAll(async () => {
  await h?.close();
}, DROP_TIMEOUT_MS);

const request = {
  requestId: "req_01jd0000000000000000000000",
  clientIp: "2001:db8::42",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0",
};

describe("enrolment codes", () => {
  it("issued here are redeemed by the realm once, and a new one voids the live one", async () => {
    const staffId = await h.seedMember(unique("code.member"), "viewer", "pending");
    const issuer = await h.seedMember(unique("code.issuer"), "admin", "active");
    const issue = () =>
      h.db.unit((tx) =>
        issueEnrolmentCode(tx, h.deps, {
          memberId: staffId,
          reason: "added",
          actor: { kind: "staff", id: issuer },
          request,
        }),
      );
    const first = await issue();
    const second = await issue();
    expect(second.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(ENROLMENT_CODE_LIFETIME_MS);
    expect(second.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      ENROLMENT_CODE_LIFETIME_MS - 60_000,
    );
    const rows = await h.admin.query<{ id: string; voided: boolean }>(
      "SELECT id, voided_at IS NOT NULL AS voided FROM staff.enrolment_code WHERE member_id = $1 ORDER BY issued_at, id",
      [staffId],
    );
    expect(rows.rows).toEqual([
      { id: first.id, voided: true },
      { id: second.id, voided: false },
    ]);
    const [event] = (await h.events("staff.enrolment_code_issued")).filter(
      (e) => e.target_id === second.id,
    );
    expect(event).toMatchObject({
      actor_kind: "staff",
      actor_id: issuer,
      actor_via: "admin",
      ref_ids: [staffId],
    });
    const context = await h.admin.query<{ client_ip: string }>(
      "SELECT host(client_ip) AS client_ip FROM audit.event_context WHERE event_id = $1",
      [event?.id],
    );
    expect(context.rows[0]?.client_ip).toBe("2001:db8::42");

    // The realm's redemption (a pending member's aal1 session) reads the same hash.
    await h.fixture(
      `INSERT INTO staff.session (id, user_id, token, expires_at, assurance, absolute_expires_at, created_via, access_sub)
       VALUES ('sts_01jd0000000000000000000000', $1, 'token-for-the-test', now() + interval '10 minutes', 'aal1',
               now() + interval '10 minutes', 'email_otp', 'sub')`,
      [staffId],
    );
    const redeem = (code: string) =>
      h.db.unit((tx) =>
        redeemEnrolmentCode(
          tx,
          { clock: h.realm.runtime.clock, audit: h.realm.runtime.audit, lines: h.lines },
          { memberId: staffId, sessionId: "sts_01jd0000000000000000000000", code },
        ),
      );
    expect(await redeem(first.code)).toMatchObject({ ok: false });
    expect(await redeem(second.code.toLowerCase().replace(/-/g, " "))).toMatchObject({ ok: true });
    expect(await redeem(second.code)).toEqual({ ok: false, reason: "used" });
    // Only its hash was ever stored.
    const stored = await h.admin.query<{ code_hash: Buffer }>(
      "SELECT code_hash FROM staff.enrolment_code WHERE id = $1",
      [second.id],
    );
    expect(stored.rows[0]?.code_hash.toString("utf8")).not.toContain(second.code.replace(/-/g, ""));
  });
});
