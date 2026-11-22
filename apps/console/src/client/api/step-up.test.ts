import type { StepUpRequired } from "@fin/app-contracts";
import { ApiError, type StepUpController, type StepUpProof } from "@fin/frame";
import { describe, expect, it } from "vitest";
import { failureOf, invalidFields, problemField } from "./failures.ts";
import { isStepUpCancelled, reactToGate, stepUpOf, withIntent } from "./step-up.ts";

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new ApiError({
    kind: "problem",
    contract: "test.call",
    status,
    problem: { type: "t", title: code, status, code, ...extra },
  });
}

const askIntent = () =>
  problem(403, "step_up_required", {
    step_up_kind: "intent",
    intent_id: "sti_1",
    methods: ["passkey"],
    reason_key: "account.passkey_add",
  });

function controller(answer: "prove" | "close") {
  const settled: string[] = [];
  const notices: string[] = [];
  const asked: StepUpRequired[] = [];
  const stepUp = {
    request: async (required: StepUpRequired): Promise<StepUpProof | null> => {
      asked.push(required);
      if (answer === "close") return null;
      return { intentId: required.intent_id ?? null, settle: (o) => settled.push(o) };
    },
    notify: (notice: string) => notices.push(notice),
  } as unknown as StepUpController;
  return { stepUp, settled, notices, asked };
}

describe("withIntent", () => {
  it("runs once without a step-up when the first try passes", async () => {
    const { stepUp, asked } = controller("prove");
    await expect(
      withIntent(stepUp, { ask: async () => "first", proved: async () => "no" }),
    ).resolves.toBe("first");
    expect(asked).toEqual([]);
  });

  it("proves the intent, runs the sequence once with it and settles done", async () => {
    const { stepUp, settled, asked } = controller("prove");
    const seen: string[] = [];
    const value = await withIntent(stepUp, {
      ask: async () => {
        throw askIntent();
      },
      proved: async (intentId) => {
        seen.push(intentId);
        return "added";
      },
    });
    expect(value).toBe("added");
    expect(seen).toEqual(["sti_1"]);
    expect(asked).toHaveLength(1);
    expect(settled).toEqual(["done"]);
  });

  it("is cancelled when the person closes the dialog, and nothing runs", async () => {
    const { stepUp } = controller("close");
    let ran = false;
    const error = await withIntent(stepUp, {
      ask: async () => {
        throw askIntent();
      },
      proved: async () => {
        ran = true;
      },
    }).catch((e: unknown) => e);
    expect(isStepUpCancelled(error)).toBe(true);
    expect(ran).toBe(false);
  });

  it("settles invalid for step_up_invalid, failed otherwise, and never loops", async () => {
    for (const [code, outcome] of [
      ["step_up_invalid", "invalid"],
      ["internal", "failed"],
    ] as const) {
      const { stepUp, settled, asked } = controller("prove");
      await expect(
        withIntent(stepUp, {
          ask: async () => {
            throw askIntent();
          },
          proved: async () => {
            throw problem(code === "internal" ? 500 : 403, code);
          },
        }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(settled).toEqual([outcome]);
      expect(asked).toHaveLength(1);
    }
  });

  it("settles done for the person's own choice (a closed passkey prompt)", async () => {
    const { stepUp, settled } = controller("prove");
    const own = new Error("closed");
    await expect(
      withIntent(stepUp, {
        ask: async () => {
          throw askIntent();
        },
        proved: async () => {
          throw own;
        },
        settlesAsDone: (error) => error === own,
      }),
    ).rejects.toBe(own);
    expect(settled).toEqual(["done"]);
  });

  it("passes any other failure of the first try through", async () => {
    const { stepUp, asked } = controller("prove");
    const refused = problem(403, "forbidden");
    await expect(
      withIntent(stepUp, { ask: async () => Promise.reject(refused), proved: async () => {} }),
    ).rejects.toBe(refused);
    expect(asked).toEqual([]);
  });
});

describe("stepUpOf and reactToGate", () => {
  it("reads the step-up an error asks for", () => {
    expect(stepUpOf(askIntent())?.intent_id).toBe("sti_1");
    expect(stepUpOf(problem(403, "forbidden"))).toBeNull();
    expect(stepUpOf(new Error("x"))).toBeNull();
  });

  it("opens the dialog's notices, or Protect your account for a hold", () => {
    const { stepUp, notices } = controller("prove");
    let protect = 0;
    expect(reactToGate(stepUp, problem(403, "second_factor_required"), () => protect++)).toBe(true);
    expect(reactToGate(stepUp, problem(403, "fresh_session_required"), () => protect++)).toBe(true);
    expect(
      reactToGate(stepUp, problem(403, "second_factor_required", { hold: true }), () => protect++),
    ).toBe(true);
    expect(reactToGate(stepUp, problem(403, "forbidden"), () => protect++)).toBe(false);
    expect(notices).toEqual(["second_factor_required", "fresh_session_required"]);
    expect(protect).toBe(1);
  });
});

describe("failureOf", () => {
  it("tells the boards' failures apart", () => {
    expect(failureOf(new ApiError({ kind: "network", contract: "c" }))).toBe("offline");
    expect(failureOf(problem(401, "INVALID_CODE"))).toBe("wrongCode");
    expect(failureOf(problem(400, "OTP_EXPIRED"))).toBe("expired");
    expect(failureOf(problem(403, "TOO_MANY_ATTEMPTS"))).toBe("usedUp");
    expect(failureOf(problem(429, "ACCOUNT_TEMPORARILY_LOCKED"))).toBe("paused");
    expect(failureOf(problem(429, "rate_limited"))).toBe("rateLimited");
    expect(failureOf(problem(401, "PASSKEY_NOT_FOUND"))).toBe("passkeyRemoved");
    expect(failureOf(problem(403, "outranked"))).toBe("notAllowed");
    expect(failureOf(problem(404, "invitation_unusable"))).toBe("notFound");
    expect(failureOf(problem(503, "paused"))).toBe("switchedOff");
    expect(failureOf(problem(500, "internal"))).toBe("ourSide");
    expect(failureOf(new Error("x"))).toBe("ourSide");
  });

  it("reads a problem's own fields, and the fields a 400 names", () => {
    const refused = problem(400, "invalid", {
      fields: [
        { path: "name", code: "x" },
        { path: ["email"], code: "y" },
      ],
    });
    expect([...invalidFields(refused)]).toEqual(["name", "email"]);
    expect(problemField(problem(403, "giving_refused", { problem: "beyond" }), "problem")).toBe(
      "beyond",
    );
    expect(invalidFields(new Error("x")).size).toBe(0);
  });
});
