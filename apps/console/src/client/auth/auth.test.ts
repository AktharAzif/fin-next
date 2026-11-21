import type { ConsoleViewer } from "@fin/app-contracts";
import { describe, expect, it } from "vitest";
import { hasFactor, welcomeRedirect } from "../components/welcome.ts";
import { stepFor, withNext } from "./after-sign-in.ts";
import { parseCodeLink, parseInvitationToken } from "./fragment.ts";
import { forgetEmail, looksLikeEmail, pendingEmail, rememberEmail } from "./pending.ts";
import { ceremonyOutcome } from "./webauthn.ts";

const routes = new Set(["/", "/settings/team", "/welcome/secure", "/sign-in"]);
const matches = (path: string) => routes.has(path);

function viewer(overrides: Partial<Extract<ConsoleViewer, { gate: "ok" }>> = {}): ConsoleViewer {
  return {
    gate: "ok",
    user: { id: "usr_1", name: "Maya Rivera", email: "maya@example.com" },
    assurance: "aal2",
    factors: { passkeys: 1, authenticator: false, backupCodesLeft: null },
    canSkipProtect: false,
    canTrustBrowser: false,
    memberships: [
      {
        orgId: "org_1",
        name: "Acme Remit",
        roleKey: "super_admin",
        roleLabel: "Super admin",
        roleKnown: true,
        liveStatus: "sandbox",
      },
    ],
    currentOrgId: "org_1",
    permissions: [],
    invitations: [],
    ...overrides,
  } as ConsoleViewer;
}

describe("the link fragments (spec 02 §5.2, §9.3)", () => {
  it("reads a sign-in link's address and 8-digit code", () => {
    expect(parseCodeLink("#e=maya%40example.com&c=12345678")).toEqual({
      email: "maya@example.com",
      code: "12345678",
    });
    expect(parseCodeLink("e=maya@example.com&c=12345678")?.code).toBe("12345678");
  });

  it("refuses anything else", () => {
    expect(parseCodeLink("")).toBeNull();
    expect(parseCodeLink("#e=maya@example.com&c=1234")).toBeNull();
    expect(parseCodeLink("#e=maya@example.com&c=1234567a")).toBeNull();
    expect(parseCodeLink("#e=not-an-address&c=12345678")).toBeNull();
    expect(parseCodeLink(`#e=${"a".repeat(260)}@example.com&c=12345678`)).toBeNull();
  });

  it("reads an invitation token, base64url only", () => {
    const token = "A".repeat(43);
    expect(parseInvitationToken(`#t=${token}`)).toBe(token);
    expect(parseInvitationToken("#t=short")).toBeNull();
    expect(parseInvitationToken("#t=has%20space-but-long-enough")).toBeNull();
  });
});

describe("the remembered address", () => {
  it("is kept in memory for the next page only", () => {
    rememberEmail("  maya@example.com ");
    expect(pendingEmail()).toBe("maya@example.com");
    forgetEmail();
    expect(pendingEmail()).toBeNull();
  });

  it("checks an address's shape", () => {
    expect(looksLikeEmail("maya@example.com")).toBe(true);
    expect(looksLikeEmail("maya@acme")).toBe(false);
    expect(looksLikeEmail("maya example.com")).toBe(false);
    expect(looksLikeEmail("a@b@example.com")).toBe(false);
    expect(looksLikeEmail("@example.com")).toBe(false);
  });
});

describe("where a person goes after signing in (spec 02 §5.9, §6.2)", () => {
  it("follows the gate", () => {
    expect(stepFor(null, null, matches)).toEqual({ kind: "go", href: "/sign-in" });
    expect(
      stepFor({ gate: "factor_step", email: "m@example.com", methods: ["passkey"] }, "/settings/team", matches),
    ).toEqual({ kind: "go", href: "/sign-in/two-factor?next=%2Fsettings%2Fteam" });
    expect(stepFor(viewer({ gate: "protect_account" }), null, matches)).toEqual({
      kind: "go",
      href: "/welcome/secure",
    });
  });

  it("makes the first organisation for a person with none", () => {
    expect(stepFor(viewer({ memberships: [], currentOrgId: null }), null, matches)).toEqual({
      kind: "firstOrganisation",
    });
  });

  it("sends a person whose every role is unknown to No access", () => {
    const unknown = viewer({
      currentOrgId: null,
      memberships: [
        { orgId: "org_2", name: "Studio Ito", roleKey: "member", roleLabel: "No access", roleKnown: false, liveStatus: "sandbox" },
      ],
    });
    expect(stepFor(unknown, null, matches)).toEqual({ kind: "go", href: "/no-access" });
  });

  it("keeps a safe next and drops an unsafe one", () => {
    expect(stepFor(viewer(), "/settings/team", matches)).toEqual({ kind: "go", href: "/settings/team" });
    expect(stepFor(viewer(), "//evil.example.com", matches)).toEqual({ kind: "go", href: "/" });
    expect(stepFor(viewer(), "/api/viewer", matches)).toEqual({ kind: "go", href: "/" });
    expect(withNext("/sign-in", "/")).toBe("/sign-in");
    expect(withNext("/sign-in", null)).toBe("/sign-in");
  });
});

describe("the welcome pages are for a person with no factor", () => {
  it("lets them stay, and sends anyone else on", () => {
    const none = viewer({ factors: { passkeys: 0, authenticator: false, backupCodesLeft: null } });
    expect(hasFactor(none)).toBe(false);
    expect(welcomeRedirect(none, null, matches)).toBeNull();
    expect(welcomeRedirect(viewer(), "/settings/team", matches)).toBe("/settings/team");
    expect(welcomeRedirect(null, null, matches)).toBe("/sign-in?next=%2Fwelcome%2Fsecure");
    expect(
      welcomeRedirect({ gate: "factor_step", email: "m@example.com", methods: [] }, null, matches),
    ).toBe("/sign-in/two-factor");
  });
});

describe("the browser's passkey errors", () => {
  it("reads the outcome from the error's name and code, never its message", () => {
    const named = (name: string, code?: string) => Object.assign(new Error("site text"), { name, code });
    expect(ceremonyOutcome(named("NotAllowedError"))).toBe("cancelled");
    expect(ceremonyOutcome(named("AbortError"))).toBe("aborted");
    expect(ceremonyOutcome(named("Error", "ERROR_CEREMONY_ABORTED"))).toBe("aborted");
    expect(ceremonyOutcome(named("SecurityError"))).toBe("unsupported");
    expect(ceremonyOutcome(named("InvalidStateError"))).toBe("failed");
    expect(ceremonyOutcome("x")).toBe("failed");
  });
});
