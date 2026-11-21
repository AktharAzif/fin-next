// The password screens' shared rules (spec 02 §5.7): the length asked before a request, the field's
// sentences, and what a refusal means; the reset pages' countdown.
import { ApiError } from "@fin/frame";
import { describe, expect, it } from "vitest";
import { countdownLabel } from "../routes/-passwords/ResetParts.tsx";
import {
  charactersShort,
  isPasswordPaused,
  PASSWORD_COMMON,
  PASSWORD_MIN_LENGTH,
  passwordError,
  passwordProblemOf,
} from "./passwords.ts";

function refusal(status: number, code: string, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError({
    kind: "problem",
    contract: "test",
    status,
    problem: {
      type: `https://developer.example.com/errors/${code}`,
      title: code,
      status,
      code,
      request_id: "req_test",
      ...extra,
    },
  });
}

describe("the password field", () => {
  it("asks for 12 characters, counted by character", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(charactersShort("correcthor")).toBe(2);
    expect(charactersShort("harbour 🌊 a")).toBe(1);
    expect(charactersShort("twelve chars")).toBe(0);
  });

  it("says how many characters are still needed, as the boards do", () => {
    expect(passwordError("short", "correcthor")).toBe("2 more characters needed.");
    expect(passwordError("short", "harbourli")).toBe("3 more characters needed.");
    expect(passwordError("short", "harbourligh")).toBe("1 more character needed.");
    expect(passwordError("common", "password1234")).toBe(PASSWORD_COMMON);
    expect(PASSWORD_COMMON).toBe("That password is too common. Choose one that’s harder to guess.");
  });

  it("reads the problem the server names, and nothing else", () => {
    expect(passwordProblemOf(refusal(400, "invalid", { problem: "password_common" }))).toBe(
      "common",
    );
    expect(passwordProblemOf(refusal(400, "invalid", { problem: "password_too_short" }))).toBe(
      "short",
    );
    expect(passwordProblemOf(refusal(400, "invalid", { problem: "password_too_long" }))).toBe(
      "long",
    );
    expect(passwordProblemOf(refusal(400, "invalid", { fields: [] }))).toBeNull();
    expect(passwordProblemOf(refusal(429, "rate_limited"))).toBeNull();
    expect(passwordProblemOf(new Error("x"))).toBeNull();
  });

  it("tells the pause after wrong passwords from any other limit", () => {
    expect(
      isPasswordPaused(
        refusal(429, "rate_limited", { reason: "password_paused", retry_after: 60 }),
      ),
    ).toBe(true);
    expect(isPasswordPaused(refusal(429, "rate_limited", { retry_after: 60 }))).toBe(false);
  });
});

describe("the reset pages' countdown", () => {
  it("is drawn m:ss", () => {
    expect(countdownLabel(45)).toBe("0:45");
    expect(countdownLabel(38)).toBe("0:38");
    expect(countdownLabel(5)).toBe("0:05");
    expect(countdownLabel(0)).toBe("0:00");
  });
});
