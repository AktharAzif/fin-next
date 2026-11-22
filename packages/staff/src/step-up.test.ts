// The intent check's answers (spec 02 §7.5): an intent serves exactly one binding: this realm,
// this session and member, this action, this digest, unspent, unexpired and proved.
import { describe, expect, it } from "vitest";
import { intentIdFrom, intentProblem, type StaffBinding } from "./step-up.ts";

const digest = Buffer.alloc(32, 7);
const binding: StaffBinding = {
  sessionId: "sts_01jd0000000000000000000000",
  staffId: "stf_01jd0000000000000000000000",
  action: "staff.add",
  digest,
};
const row = {
  realm: "staff",
  session_id: binding.sessionId,
  principal_id: binding.staffId,
  organization_id: null,
  action: "staff.add",
  params_digest: Buffer.from(digest),
  proved_at: new Date(),
  consumed_at: null,
  live: true,
};

describe("intentProblem", () => {
  it("passes the one intent that fits", () => {
    expect(intentProblem(row, binding)).toBeNull();
  });

  it("names each way an intent does not fit, in §7.5's order", () => {
    expect(intentProblem(undefined, binding)).toBe("other_session");
    expect(intentProblem({ ...row, realm: "developer" }, binding)).toBe("other_session");
    expect(intentProblem({ ...row, session_id: "sts_01jd0000000000000000000001" }, binding)).toBe(
      "other_session",
    );
    expect(intentProblem({ ...row, principal_id: "stf_01jd0000000000000000000001" }, binding)).toBe(
      "other_session",
    );
    expect(intentProblem({ ...row, action: "staff.remove" }, binding)).toBe("other_action");
    expect(
      intentProblem(
        { ...row, organization_id: "org_01jd0000000000000000000000" } as never,
        binding,
      ),
    ).toBe("other_action");
    expect(intentProblem({ ...row, params_digest: Buffer.alloc(32, 8) }, binding)).toBe("digest");
    expect(intentProblem({ ...row, consumed_at: new Date() } as never, binding)).toBe("used");
    expect(intentProblem({ ...row, live: false }, binding)).toBe("expired");
    expect(intentProblem({ ...row, proved_at: null }, binding)).toBe("unproved");
  });
});

describe("intentIdFrom", () => {
  it("reads only an intent ID's shape from the header", () => {
    expect(
      intentIdFrom(new Headers({ "fin-step-up-intent": "sti_01jd0000000000000000000000" })),
    ).toBe("sti_01jd0000000000000000000000");
    expect(intentIdFrom(new Headers({ "fin-step-up-intent": "sti_x" }))).toBeNull();
    expect(
      intentIdFrom(new Headers({ "fin-step-up-intent": "asr_01jd0000000000000000000000" })),
    ).toBeNull();
    expect(intentIdFrom(new Headers())).toBeNull();
  });
});
