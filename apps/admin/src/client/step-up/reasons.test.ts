// "Use your second factor to {reason}." (spec 02 §15.5): the values come from the page, and a key
// or a value the page did not give says "continue".
import { describe, expect, it } from "vitest";
import { reasonSentence, stepUpSubject, withStepUpSubject } from "./reasons.ts";

describe("reasonSentence", () => {
  it("says the staff action with the page's own values", () => {
    expect(reasonSentence("staff.add", { email: "mei@example.com", role: "Operator" })).toBe(
      "Use your second factor to add mei@example.com to staff.",
    );
    expect(reasonSentence("staff.role", { email: "mei@example.com", role: "Viewer" })).toBe(
      "Use your second factor to change mei@example.com’s role to Viewer.",
    );
    expect(reasonSentence("staff.remove", { email: "mei@example.com" })).toBe(
      "Use your second factor to remove mei@example.com from staff.",
    );
    expect(reasonSentence("staff.enrolment_code", { email: "mei@example.com" })).toBe(
      "Use your second factor to make a new enrolment code for mei@example.com.",
    );
  });

  it("names the factor the realm's own keys are about", () => {
    expect(reasonSentence("add_factor", { factor: "passkey" })).toBe(
      "Use your second factor to add a passkey.",
    );
    expect(reasonSentence("add_factor", { factor: "authenticator" })).toBe(
      "Use your second factor to set up an authenticator app.",
    );
    expect(reasonSentence("remove_factor", { factor: "passkey", name: "Chrome on Mac" })).toBe(
      "Use your second factor to remove the passkey “Chrome on Mac”.",
    );
    expect(reasonSentence("sign_out_everywhere", {})).toBe(
      "Use your second factor to sign out your other devices.",
    );
  });

  it("says continue for a value the page did not give, or a key it does not know", () => {
    expect(reasonSentence("staff.add", {})).toBe("Use your second factor to continue.");
    expect(reasonSentence("staff.role", { email: "mei@example.com" })).toBe(
      "Use your second factor to continue.",
    );
    expect(reasonSentence("add_factor", {})).toBe("Use your second factor to continue.");
    expect(reasonSentence("something.new", { email: "mei@example.com" })).toBe(
      "Use your second factor to continue.",
    );
    expect(reasonSentence("toString", {})).toBe("Use your second factor to continue.");
  });
});

describe("withStepUpSubject", () => {
  it("holds the subject while the action runs, and clears it after, even on failure", async () => {
    const seen: unknown[] = [];
    await withStepUpSubject({ email: "a@example.com" }, async () => {
      seen.push(stepUpSubject().get());
    });
    expect(seen).toEqual([{ email: "a@example.com" }]);
    expect(stepUpSubject().get()).toEqual({});
    await expect(
      withStepUpSubject({ email: "b@example.com" }, async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(stepUpSubject().get()).toEqual({});
  });
});
