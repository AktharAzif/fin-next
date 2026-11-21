import type { ConsoleViewer, StepUpRequired } from "@fin/app-contracts";
import { describe, expect, it } from "vitest";
import { adminGate, consoleGate } from "../src/boot/gates.ts";
import { createStepUpController } from "../src/step-up/step-up.tsx";

const required: StepUpRequired = {
  code: "step_up_required",
  step_up_kind: "intent",
  intent_id: "sti_1",
  methods: ["passkey"],
  reason_key: "team.invite",
};

describe("the StepUp controller", () => {
  it("refuses at once when no modal content is mounted", async () => {
    const controller = createStepUpController();
    await expect(controller.request(required)).resolves.toBeNull();
    expect(controller.state.get()).toBeNull();
  });

  it("hands the proof over and closes on done", async () => {
    const controller = createStepUpController();
    controller.attach(true);
    const pending = controller.request(required);
    expect(controller.state.get()).toEqual({ required, status: "asking" });
    controller.prove("sti_1");
    const proof = await pending;
    expect(proof?.intentId).toBe("sti_1");
    expect(controller.state.get()?.status).toBe("sending");
    proof?.settle("done");
    expect(controller.state.get()).toBeNull();
  });

  it("stays open saying it didn't work on invalid, and settles once", async () => {
    const controller = createStepUpController();
    controller.attach(true);
    const pending = controller.request(required);
    controller.prove("sti_1");
    const proof = await pending;
    proof?.settle("invalid");
    proof?.settle("done");
    expect(controller.state.get()?.status).toBe("invalid");
    controller.cancel();
    expect(controller.state.get()).toBeNull();
  });

  it("answers null on cancel, and refuses a second request while one is open", async () => {
    const controller = createStepUpController();
    controller.attach(true);
    const first = controller.request(required);
    await expect(controller.request(required)).resolves.toBeNull();
    controller.cancel();
    await expect(first).resolves.toBeNull();
  });

  it("closes an open request when the content unmounts", async () => {
    const controller = createStepUpController();
    controller.attach(true);
    const pending = controller.request(required);
    controller.attach(false);
    await expect(pending).resolves.toBeNull();
    expect(controller.state.get()).toBeNull();
  });
});

const base = {
  user: { id: "usr_1", name: "", email: "a@example.com" },
  assurance: "aal2" as const,
  factors: { passkeys: 0, authenticator: true, backupCodesLeft: 10 },
  canSkipProtect: false,
  canTrustBrowser: false,
  permissions: [],
  invitations: [],
};
const known = () => true;
const here = { pathname: "/settings/team", search: "?view=invite" };

describe("the first navigation (spec 06 §2.3 step 4)", () => {
  it("leaves auth routes alone", () => {
    expect(consoleGate(null, "auth", here, known)).toBeNull();
    expect(adminGate(null, "bare")).toBeNull();
  });

  it("routes the console's viewer by its gate", () => {
    expect(consoleGate(null, "app", here, known)).toBe(
      "/sign-in?next=%2Fsettings%2Fteam%3Fview%3Dinvite",
    );
    expect(
      consoleGate(
        { gate: "factor_step", email: "a@example.com", methods: ["passkey"] },
        "app",
        here,
        known,
      ),
    ).toBe("/sign-in/two-factor");
    const ok: ConsoleViewer = { ...base, gate: "ok", memberships: [], currentOrgId: null };
    expect(consoleGate({ ...ok, gate: "protect_account" }, "app", here, known)).toBe(
      "/welcome/secure",
    );
    expect(consoleGate(ok, "app", here, known)).toBeNull();
    const unknownRoles: ConsoleViewer = {
      ...ok,
      memberships: [
        {
          orgId: "org_1",
          name: "Acme",
          roleKey: "gone",
          roleLabel: "",
          roleKnown: false,
          liveStatus: "sandbox",
        },
      ],
    };
    expect(consoleGate(unknownRoles, "app", here, known)).toBe("/no-access");
  });

  it("routes Fin Admin's staff by state", () => {
    expect(adminGate(null, "app")).toBe("/sign-in");
    expect(adminGate({ state: "signed_out", accessEmail: null }, "app")).toBe("/sign-in");
    expect(
      adminGate({ state: "factor_step", email: "a@example.org", methods: ["passkey"] }, "app"),
    ).toBe("/sign-in/factor");
    expect(
      adminGate(
        {
          state: "ok",
          staff: { id: "s", email: "a@example.org", roleKey: "viewer", roleLabel: "Viewer" },
          permissions: [],
          environment: "production",
        },
        "app",
      ),
    ).toBeNull();
  });
});
