// The gates as pure functions (spec 02 §6.2, §6.4, §6.6, §10.5): a trusted browser counts only
// while its row is live and its person eligible; a staff session holds only under the Access
// identity it was made under, subject and address both.
import { describe, expect, it } from "vitest";
import { developerGate, type PersonGateFacts, staffGate } from "./gate.ts";
import type { FactorFacts, PersonRow, SessionRow } from "./store.ts";

const at = new Date("2026-11-21T10:00:00Z");

const session: SessionRow = {
  id: "ses_0000000000000000000000000a",
  userId: "usr_0000000000000000000000000a",
  token: "token",
  expiresAt: at,
  absoluteExpiresAt: at,
  assurance: "aal1",
  createdVia: "email_otp",
  createdAt: at,
  mailboxProvedAt: at,
  trustedBrowserId: null,
  trustedBrowserLive: false,
  currentOrganizationId: null,
  stepUpFailures: 0,
  accessSub: null,
  enrolmentOpenUntil: null,
};

const facts: PersonGateFacts = {
  factorCount: 1,
  privilegedAnywhere: false,
  productionMember: false,
};

describe("the developer gate", () => {
  const trusted = { ...session, trustedBrowserId: "tbr_0000000000000000000000000a" };

  it("counts an aal1 trusted-browser session as working only while its row is live", () => {
    expect(developerGate({ ...trusted, trustedBrowserLive: true }, facts)).toBe("ok");
    expect(developerGate({ ...trusted, trustedBrowserLive: false }, facts)).toBe("factor_step");
    expect(developerGate(session, facts)).toBe("factor_step");
  });

  it("drops the trust once the person is privileged anywhere or has Production access", () => {
    const live = { ...trusted, trustedBrowserLive: true };
    expect(developerGate(live, { ...facts, privilegedAnywhere: true })).toBe("factor_step");
    expect(developerGate(live, { ...facts, productionMember: true })).toBe("factor_step");
  });

  it("holds a privileged person with no factor, and lets aal2 work", () => {
    expect(developerGate(session, { ...facts, factorCount: 0, privilegedAnywhere: true })).toBe(
      "hold",
    );
    expect(developerGate(session, { ...facts, factorCount: 0 })).toBe("ok");
    expect(developerGate({ ...session, assurance: "aal2" }, facts)).toBe("ok");
  });
});

describe("the staff gate", () => {
  const member: PersonRow = {
    id: "stf_0000000000000000000000000a",
    email: "staff.member@example.com",
    name: "",
    twoFactorEnabled: false,
    status: "active",
    roleKey: "viewer",
  };
  const factors: FactorFacts = {
    passkeys: 1,
    authenticator: false,
    authenticatorPending: false,
    count: 1,
  };
  const staffSession = { ...session, assurance: "aal2" as const, accessSub: "sub-original" };
  const access = { email: "Staff.Member@example.com", sub: "sub-original" };

  it("holds the session only under the Access subject and address it was made under", () => {
    expect(staffGate(staffSession, member, factors, access)).toEqual({ state: "ok" });
    expect(staffGate(staffSession, member, factors, { ...access, sub: "sub-other" })).toEqual({
      refused: "access_mismatch",
    });
    expect(
      staffGate(staffSession, member, factors, { ...access, email: "other@example.com" }),
    ).toEqual({ refused: "access_mismatch" });
    expect(staffGate(staffSession, member, factors, null)).toEqual({ refused: "access_mismatch" });
  });

  it("refuses a removed member and keeps aal1 at the factor step or pending", () => {
    expect(staffGate(staffSession, { ...member, status: "removed" }, factors, access)).toEqual({
      refused: "removed",
    });
    const aal1 = { ...staffSession, assurance: "aal1" as const };
    expect(staffGate(aal1, member, factors, access)).toEqual({ state: "factor_step" });
    expect(staffGate(aal1, member, { ...factors, passkeys: 0, count: 0 }, access)).toEqual({
      state: "pending",
    });
  });
});
