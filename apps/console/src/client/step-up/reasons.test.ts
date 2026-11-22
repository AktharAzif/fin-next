// The StepUp line's values belong to the call that asked (spec 02 §15.5): two actions in flight at
// once never lend each other their target, and a call's values never outlive it.
import { describe, expect, it } from "vitest";
import { reasonLine, valuesFor, withReasonValues } from "./reasons.ts";

/** A call that stays in flight until `settle` is called. */
function held(): { promise: Promise<void>; settle: () => void } {
  let settle = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe("the reason values of calls in flight", () => {
  it("never names another call's target while two calls of one reason are in flight", async () => {
    const a = held();
    const b = held();
    const first = withReasonValues(
      "invitation.resend",
      { email: "a@example.com" },
      () => a.promise,
    );
    const second = withReasonValues(
      "invitation.resend",
      { email: "b@example.com" },
      () => b.promise,
    );
    // Either call's step-up could be the one asking: the line names neither address.
    expect(reasonLine("invitation.resend")).toBe("Use your second factor to continue.");
    expect(valuesFor("invitation.resend")).toEqual({});
    a.settle();
    await first;
    // Only the second is left in flight: the line is its own.
    expect(reasonLine("invitation.resend")).toBe(
      "Use your second factor to send the invitation to b@example.com again.",
    );
    b.settle();
    await second;
    expect(reasonLine("invitation.resend")).toBe("Use your second factor to continue.");
  });

  it("gives each reason the values of the call that asks with it", async () => {
    const resend = held();
    const remove = held();
    const one = withReasonValues(
      "invitation.resend",
      { email: "ana@example.com" },
      () => resend.promise,
    );
    const two = withReasonValues(
      "invitation.cancel",
      { email: "bob@example.com" },
      () => remove.promise,
    );
    expect(reasonLine("invitation.resend")).toBe(
      "Use your second factor to send the invitation to ana@example.com again.",
    );
    expect(reasonLine("invitation.cancel")).toBe(
      "Use your second factor to delete the invitation for bob@example.com.",
    );
    // A reason no call in flight asks with names nothing.
    expect(reasonLine("member.remove")).toBe("Use your second factor to continue.");
    resend.settle();
    remove.settle();
    await Promise.all([one, two]);
  });

  it("drops only the settled call's values, whatever order the calls settle in", async () => {
    const a = held();
    const b = held();
    const first = withReasonValues("member.remove", { name: "Alice" }, () => a.promise);
    const second = withReasonValues("member.remove", { name: "Bob" }, () => b.promise);
    a.settle();
    await first;
    b.settle();
    await second;
    // Nothing is in flight: no stale values are left for a later step-up.
    expect(reasonLine("member.remove")).toBe("Use your second factor to continue.");
    expect(valuesFor("member.remove")).toEqual({});
  });

  it("drops a call's values when it fails too", async () => {
    await expect(
      withReasonValues("member.remove", { name: "Alice" }, async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(reasonLine("member.remove")).toBe("Use your second factor to continue.");
  });
});
