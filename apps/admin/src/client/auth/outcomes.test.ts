// Each realm answer lands in the board state it means (AdminSignIn, AdminSecondFactor).
import { ApiError } from "@fin/frame";
import { describe, expect, it } from "vitest";
import type { AuthAnswer, AuthFailure } from "./http.ts";
import {
  codeOutcome,
  enrolmentOutcome,
  enrolmentWindowClosed,
  factorOutcome,
  requestIdOf,
  sendOutcome,
  sessionEnded,
} from "./outcomes.ts";

const library = (status: number, code: string): AuthAnswer => ({
  ok: false,
  kind: "library",
  status,
  code,
});

const problem = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): AuthAnswer => ({
  ok: false,
  kind: "problem",
  status,
  problem: {
    type: `https://docs.example.com/errors/${code}`,
    title: code,
    status,
    code,
    request_id: "req_9",
    ...extra,
  },
  retryAfterSeconds: null,
});

const ok: AuthAnswer = { ok: true, status: 200, data: {} };
const network: AuthAnswer = { ok: false, kind: "network" };

describe("sending a code", () => {
  it.each([
    [ok, "sent"],
    [problem(429, "rate_limited"), "tooManyCodes"],
    [problem(400, "invalid", { fields: ["email"] }), "notWork"],
    [network, "offline"],
    [{ ok: false, kind: "unexpected", status: 502 } as AuthAnswer, "failed"],
  ] as const)("%o is %s", (answer, expected) => {
    expect(sendOutcome(answer)).toBe(expected);
  });
});

describe("signing in with the code", () => {
  it.each([
    [ok, "signedIn"],
    [library(400, "INVALID_OTP"), "wrong"],
    [library(400, "OTP_EXPIRED"), "expired"],
    [library(403, "TOO_MANY_ATTEMPTS"), "expired"],
    [problem(429, "rate_limited"), "locked"],
    [problem(401, "unauthenticated", { reason: "too_many_tries" }), "locked"],
    [network, "offline"],
    [problem(500, "internal"), "failed"],
  ] as const)("%o is %s", (answer, expected) => {
    expect(codeOutcome(answer)).toBe(expected);
  });
});

describe("an authenticator code", () => {
  it.each([
    [ok, "done"],
    [library(401, "INVALID_CODE"), "wrong"],
    // The realm's lockout and the limits leave the session alive: wait, not "signed out".
    [library(429, "ACCOUNT_TEMPORARILY_LOCKED"), "limited"],
    [problem(429, "rate_limited", { retry_after: 60 }), "limited"],
    // Only the fifth wrong try at a step-up ends the session (spec 02 §7.7).
    [problem(401, "unauthenticated", { reason: "too_many_tries" }), "tooManyTries"],
    [problem(401, "unauthenticated", { reason: "expired" }), "signedOut"],
    [problem(401, "unauthenticated", { reason: "signed_out" }), "signedOut"],
    [problem(403, "access_mismatch"), "signedOut"],
    [network, "offline"],
    [library(400, "TOTP_NOT_ENABLED"), "failed"],
  ] as const)("%o is %s", (answer, expected) => {
    expect(factorOutcome(answer)).toBe(expected);
  });
});

describe("an ended session", () => {
  it.each([
    [problem(401, "unauthenticated", { reason: "expired" }), true],
    [problem(401, "unauthenticated", { reason: "signed_out" }), true],
    [problem(401, "unauthenticated", { reason: "too_many_tries" }), true],
    [problem(403, "access_mismatch"), true],
    [problem(403, "forbidden", { reason: "enrolment_code_required" }), false],
    [problem(429, "rate_limited"), false],
    [library(429, "ACCOUNT_TEMPORARILY_LOCKED"), false],
    [library(401, "INVALID_CODE"), false],
    [network, false],
  ] as const)("%o is %s", (answer, expected) => {
    expect(sessionEnded(answer as AuthFailure)).toBe(expected);
  });
});

describe("the enrolment window", () => {
  it("is closed only when the realm says the enrolment code is needed", () => {
    expect(
      enrolmentWindowClosed(problem(403, "forbidden", { reason: "enrolment_code_required" })),
    ).toBe(true);
    expect(enrolmentWindowClosed(problem(403, "forbidden", { reason: "passkey_first" }))).toBe(
      false,
    );
    expect(enrolmentWindowClosed(ok)).toBe(false);
  });
});

describe("redeeming an enrolment code", () => {
  const refused = (status: number, code: string, reason?: string) =>
    new ApiError({
      kind: "problem",
      contract: "enrolment.redeem",
      status,
      problem: {
        type: "x",
        title: "x",
        status,
        code,
        request_id: "req_2",
        ...(reason === undefined ? {} : { reason }),
      },
    });

  it.each([
    [refused(403, "forbidden", "wrong"), "wrong"],
    [refused(400, "invalid"), "wrong"],
    [refused(403, "forbidden", "expired"), "expired"],
    [refused(403, "forbidden", "used"), "used"],
    [refused(403, "forbidden", "void"), "used"],
    [refused(403, "forbidden", "not_pending"), "used"],
    [refused(429, "rate_limited"), "tooMany"],
    // The session's end is not the code's: its own `reason` says nothing about the code.
    [refused(401, "unauthenticated", "expired"), "signedOut"],
    [refused(401, "unauthenticated", "signed_out"), "signedOut"],
    [refused(401, "access_required"), "signedOut"],
    [refused(403, "access_mismatch"), "signedOut"],
    [refused(500, "internal"), "failed"],
    [new ApiError({ kind: "network", contract: "enrolment.redeem" }), "offline"],
    [new Error("not an api error"), "failed"],
  ] as const)("%s", (error, expected) => {
    expect(enrolmentOutcome(error)).toBe(expected);
  });

  it("keeps the request ID and nothing else of the answer", () => {
    expect(requestIdOf(refused(500, "internal"))).toBe("req_2");
    expect(requestIdOf(problem(500, "internal"))).toBe("req_9");
    expect(requestIdOf(network)).toBeNull();
  });
});
