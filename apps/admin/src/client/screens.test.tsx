// The screens' data and their static parts: the contracts read what the API halves answer, the
// loaders fail to the page's own state, the account's factor rows keep the last factor, times say
// UTC, and the pieces drawn before data (skeletons, the role picker, the "or" rule) carry their
// accessible names.
import type { StaffViewer } from "@fin/app-contracts";
import { ApiError } from "@fin/frame";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { factorRows, LAST_FACTOR, loadAccount, removeFactorReason } from "./account/load.ts";
import {
  accountAnswer,
  addStaff,
  changeStaffRole,
  listStaff,
  redeemEnrolmentCode,
  removeStaff,
  type StaffRole,
} from "./api/contracts.ts";
import { OrDivider } from "./components/OrDivider.tsx";
import { RolePicker } from "./components/RolePicker.tsx";
import { formatTimeUtc, formatUtc } from "./format.ts";
import { nextStepFor } from "./sign-in/after-sign-in.ts";
import { byEmail, loadStaff } from "./staff/load.ts";
import { lastSignedIn, StaffSkeleton } from "./staff/StaffPage.tsx";

const OK_VIEWER: StaffViewer = {
  state: "ok",
  staff: { id: "stf_1", email: "nadia@example.com", roleKey: "admin", roleLabel: "Admin" },
  permissions: ["staff.read", "staff.add"],
  environment: "staging",
};

function viewerStore(viewer: StaffViewer | null) {
  return { get: () => viewer } as never;
}

const member = (email: string) => ({
  id: `stf_${email}`,
  email,
  roleKey: "viewer",
  roleLabel: "Viewer",
  status: "active" as const,
  lastSignedInAt: "2026-11-18T09:05:00.000Z",
  factors: ["passkey" as const],
});

describe("the contracts", () => {
  it("name their routes under /api without repeating it, and creates carry an idempotency key", () => {
    expect(listStaff.path).toBe("/staff");
    expect(addStaff).toMatchObject({ method: "POST", path: "/staff", creates: true });
    expect(changeStaffRole).toMatchObject({ method: "PATCH", path: "/staff/:staffId" });
    expect(removeStaff).toMatchObject({ method: "POST", path: "/staff/:staffId/remove" });
    expect(redeemEnrolmentCode).toMatchObject({ method: "POST", path: "/enrolment/redeem" });
  });

  it("read the add answer with the code once, and refuse an answer without it", () => {
    const answer = {
      staff: { ...member("mei@example.com"), status: "pending", lastSignedInAt: null, factors: [] },
      enrolmentCode: "ABCD-EFGH-JKMN-PQRS",
      expiresAt: "2026-11-16T10:30:00.000Z",
    };
    expect(addStaff.output.safeParse(answer).success).toBe(true);
    const { enrolmentCode: _code, ...without } = answer;
    expect(addStaff.output.safeParse(without).success).toBe(false);
  });

  it("read the account's factors and sessions", () => {
    expect(
      accountAnswer.safeParse({
        passkeys: [],
        authenticator: { enabled: true, enabledAt: "2026-11-16T10:00:00.000Z" },
        sessions: [],
      }).success,
    ).toBe(true);
  });
});

describe("loadStaff", () => {
  it("reads nothing without staff.read", async () => {
    const api = vi.fn();
    const viewer = { ...OK_VIEWER, permissions: ["records.read"] };
    expect(await loadStaff({ api, viewer: viewerStore(viewer) })).toEqual({ kind: "notAllowed" });
    expect(api).not.toHaveBeenCalled();
  });

  it("reads the list and the roles together, by address", async () => {
    const api = vi.fn(async (contract: { name: string }) =>
      contract.name === "staff.list"
        ? { staff: [member("ravi@example.com"), member("ines@example.com")], total: 2 }
        : { roles: [] },
    );
    const data = await loadStaff({ api: api as never, viewer: viewerStore(OK_VIEWER) });
    expect(data).toMatchObject({ kind: "ready", total: 2 });
    if (data.kind === "ready") {
      expect(data.staff.map((m) => m.email)).toEqual(["ines@example.com", "ravi@example.com"]);
    }
  });

  it("fails to the page's own state, with the request ID", async () => {
    const api = vi.fn(async () => {
      throw new ApiError({
        kind: "problem",
        contract: "staff.list",
        status: 500,
        problem: { type: "x", title: "x", status: 500, code: "internal", request_id: "req_5" },
      });
    });
    expect(await loadStaff({ api: api as never, viewer: viewerStore(OK_VIEWER) })).toEqual({
      kind: "failed",
      requestId: "req_5",
      offline: false,
    });
  });

  it("sorts by address", () => {
    expect(byEmail([member("b@example.com"), member("a@example.com")]).map((m) => m.email)).toEqual(
      ["a@example.com", "b@example.com"],
    );
  });
});

describe("the account", () => {
  const account = {
    passkeys: [
      {
        id: "pky_1",
        name: "Chrome on Mac",
        createdAt: "2026-11-16T10:00:00.000Z",
        lastUsedAt: null,
      },
    ],
    authenticator: { enabled: false, enabledAt: null },
    sessions: [],
  };

  it("keeps the last factor, with the reason", () => {
    const rows = factorRows(account);
    expect(rows.map((r) => r.kind)).toEqual(["passkey"]);
    expect(removeFactorReason(rows)).toBe(LAST_FACTOR);
    const both = factorRows({ ...account, authenticator: { enabled: true, enabledAt: null } });
    expect(both.map((r) => r.name)).toEqual(["Chrome on Mac", "Authenticator app"]);
    expect(removeFactorReason(both)).toBeNull();
  });

  it("fails to the page's own state", async () => {
    const api = vi.fn(async () => {
      throw new ApiError({ kind: "network", contract: "account.get" });
    });
    expect(await loadAccount({ api: api as never })).toEqual({
      kind: "failed",
      requestId: null,
      offline: true,
    });
  });
});

describe("after a sign-in step", () => {
  it("goes where the viewer now belongs", () => {
    expect(nextStepFor(OK_VIEWER)).toBe("/");
    expect(nextStepFor({ state: "pending", email: "a@example.com" })).toBe("/sign-in/factor");
    expect(nextStepFor({ state: "factor_step", email: "a@example.com", methods: [] })).toBe(
      "/sign-in/factor",
    );
    expect(nextStepFor({ state: "signed_out", accessEmail: null })).toBe("/sign-in");
    expect(nextStepFor(null)).toBe("/sign-in");
  });
});

describe("times", () => {
  it("say UTC, in British order", () => {
    expect(formatUtc("2026-11-18T09:05:00.000Z")).toBe("18 Nov 2026, 09:05 UTC");
    expect(formatTimeUtc("2026-11-16T10:30:00.000Z")).toBe("10:30 UTC");
    expect(formatUtc("not a time")).toBeNull();
    expect(lastSignedIn({ ...member("a@example.com"), lastSignedInAt: null })).toBe("Not yet");
  });
});

describe("static parts", () => {
  it("draws the Staff skeleton with shapes and a header, never a spinner", () => {
    const html = renderToStaticMarkup(<StaffSkeleton />);
    expect(html).toContain(">Staff</h1>");
    expect(html).toContain("data-skeleton");
    expect(html).not.toContain("fin-ico-spin");
  });

  it("draws the role picker as named radios, a refused one disabled with its reason", () => {
    const roles: StaffRole[] = [
      {
        key: "viewer",
        label: "Viewer",
        summary: "Sees everything.",
        builtIn: true,
        permissions: [],
      },
      { key: "admin", label: "Admin", summary: "Does everything.", builtIn: true, permissions: [] },
    ];
    const html = renderToStaticMarkup(
      <RolePicker
        label="Role"
        value="viewer"
        onChange={() => {}}
        choices={[
          { role: roles[0] as StaffRole, disabledReason: null },
          { role: roles[1] as StaffRole, disabledReason: "Only an Admin can give the Admin role." },
        ]}
      />,
    );
    expect(html).toContain("<legend");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    const input = (value: string) =>
      html.match(new RegExp(`<input[^>]*value="${value}"[^>]*/>`))?.[0] ?? "";
    expect(input("viewer")).toContain('checked=""');
    expect(input("viewer")).not.toContain("disabled");
    expect(input("admin")).toContain('disabled=""');
    expect(input("admin")).toContain("-admin-reason");
    expect(html).toContain("Only an Admin can give the Admin role.");
  });

  it("hides the or rule from screen readers", () => {
    expect(renderToStaticMarkup(<OrDivider />)).toContain('aria-hidden="true"');
  });
});
