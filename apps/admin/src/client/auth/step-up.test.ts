// A library call through the root StepUp dialog (spec 02 §7.1, §7.5): proved once, sent again
// once with the intent, the outcome told to the dialog, and never a loop.
import type { StepUpProof } from "@fin/frame";
import { describe, expect, it, vi } from "vitest";
import type { AuthAnswer, AuthFailure } from "./http.ts";
import { type Attempt, attemptOf, stepUpRequiredOf, withStepUp } from "./step-up.ts";

function stepUpRequired(intentId?: string): AuthFailure {
  return {
    ok: false,
    kind: "problem",
    status: 403,
    problem: {
      type: "https://docs.example.com/errors/step_up_required",
      title: "Use your second factor to continue.",
      status: 403,
      code: "step_up_required",
      step_up_kind: "intent",
      methods: ["passkey", "authenticator"],
      reason_key: "add_factor",
      ...(intentId === undefined ? {} : { intent_id: intentId }),
    },
    retryAfterSeconds: null,
  };
}

const invalid: AuthFailure = {
  ok: false,
  kind: "problem",
  status: 403,
  problem: { type: "x", title: "x", status: 403, code: "step_up_invalid", reason: "used" },
  retryAfterSeconds: null,
};

function dialog(proof: "prove" | "close") {
  const settle = vi.fn();
  const request = vi.fn(
    async (): Promise<StepUpProof | null> =>
      proof === "close" ? null : { intentId: "sti_proved", settle },
  );
  return { request, settle };
}

describe("withStepUp", () => {
  it("passes an answer that needs no step-up straight through", async () => {
    const stepUp = dialog("prove");
    const attempt = vi.fn(async (): Promise<Attempt<string>> => ({ ok: true, value: "done" }));
    expect(await withStepUp(stepUp, attempt)).toEqual({ ok: true, value: "done" });
    expect(stepUp.request).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("asks for the named intent, then sends again once with it, and tells the dialog", async () => {
    const stepUp = dialog("prove");
    const attempt = vi
      .fn<(intentId: string | null) => Promise<Attempt<string>>>()
      .mockResolvedValueOnce({ ok: false, failure: stepUpRequired("sti_1") })
      .mockResolvedValueOnce({ ok: true, value: "added" });
    expect(await withStepUp(stepUp, attempt)).toEqual({ ok: true, value: "added" });
    expect(stepUp.request).toHaveBeenCalledWith(
      expect.objectContaining({ intent_id: "sti_1", reason_key: "add_factor" }),
    );
    expect(attempt.mock.calls.map(([intent]) => intent)).toEqual([null, "sti_proved"]);
    expect(stepUp.settle).toHaveBeenCalledWith("done");
  });

  it("does nothing more when the person closes the dialog", async () => {
    const stepUp = dialog("close");
    const attempt = vi.fn(
      async (): Promise<Attempt<string>> => ({
        ok: false,
        failure: stepUpRequired("sti_1"),
      }),
    );
    expect(await withStepUp(stepUp, attempt)).toEqual({ ok: false, cancelled: true });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("says invalid once and stops when the re-sent call is refused for its intent", async () => {
    const stepUp = dialog("prove");
    const attempt = vi
      .fn<(intentId: string | null) => Promise<Attempt<string>>>()
      .mockResolvedValueOnce({ ok: false, failure: stepUpRequired("sti_1") })
      .mockResolvedValue({ ok: false, failure: invalid });
    const result = await withStepUp(stepUp, attempt);
    expect(result).toEqual({ ok: false, failure: invalid });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(stepUp.request).toHaveBeenCalledTimes(1);
    expect(stepUp.settle).toHaveBeenCalledWith("invalid");
  });

  it("asks for the intent when the first answer names none (a passkey's options are a GET)", async () => {
    const stepUp = dialog("prove");
    const askIntent = vi.fn(async (): Promise<AuthAnswer> => stepUpRequired("sti_made"));
    const attempt = vi
      .fn<(intentId: string | null) => Promise<Attempt<string>>>()
      .mockResolvedValueOnce({ ok: false, failure: stepUpRequired() })
      .mockResolvedValueOnce({ ok: true, value: "added" });
    expect(await withStepUp(stepUp, attempt, askIntent)).toEqual({ ok: true, value: "added" });
    expect(askIntent).toHaveBeenCalledOnce();
    expect(stepUp.request).toHaveBeenCalledWith(expect.objectContaining({ intent_id: "sti_made" }));
  });

  it("tells the dialog failed when the re-sent call fails for another reason", async () => {
    const stepUp = dialog("prove");
    const lastFactor: AuthFailure = {
      ok: false,
      kind: "problem",
      status: 409,
      problem: { type: "x", title: "x", status: 409, code: "last_factor" },
      retryAfterSeconds: null,
    };
    const attempt = vi
      .fn<(intentId: string | null) => Promise<Attempt<string>>>()
      .mockResolvedValueOnce({ ok: false, failure: stepUpRequired("sti_1") })
      .mockResolvedValueOnce({ ok: false, failure: lastFactor });
    expect(await withStepUp(stepUp, attempt)).toEqual({ ok: false, failure: lastFactor });
    expect(stepUp.settle).toHaveBeenCalledWith("failed");
  });
});

describe("stepUpRequiredOf", () => {
  it("reads only a well-formed step_up_required", () => {
    expect(stepUpRequiredOf(stepUpRequired("sti_1"))?.intent_id).toBe("sti_1");
    expect(stepUpRequiredOf(invalid)).toBeNull();
    expect(stepUpRequiredOf({ ok: false, kind: "network" })).toBeNull();
  });

  it("turns an answer into an attempt", () => {
    expect(attemptOf({ ok: true, status: 200, data: 1 })).toEqual({ ok: true, value: 1 });
    expect(attemptOf({ ok: false, kind: "network" })).toEqual({
      ok: false,
      failure: { ok: false, kind: "network" },
    });
  });
});
