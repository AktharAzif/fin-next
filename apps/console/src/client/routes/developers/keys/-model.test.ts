// What the API keys page derives: each status's badge and line, the allowlist as typed, the form's
// own checks (the server checks again), what a server field refusal says, and the contracts' shapes.
import { describe, expect, it } from "vitest";
import { createKey, keyRow, keysList, rollKey } from "./-api.ts";
import {
  draftProblems,
  envLine,
  fieldSentence,
  KEYS_PAGE_SIZE,
  lastUsedLine,
  pageCountOf,
  pagesIn,
  parseAllowlist,
  SCOPE_ORDER,
  STATUS,
  statusLine,
  withinRole,
} from "./-model.ts";

const base = keyRow.parse({
  keyId: "K8D2M4P6Q1",
  name: "Payout worker",
  prefix: "fin_test_rk_K8D2M4P6Q1",
  mode: "test",
  kind: "rk",
  access: "Restricted · 2 scopes",
  scopes: ["customers:read", "money:read"],
  ipAllowlist: [],
  status: "active",
  createdAt: "2026-11-20T10:00:00.000Z",
  createdBy: { userId: "usr_1", name: "Maya Rivera" },
  expiresAt: null,
  revokedAt: null,
  revokedReason: null,
  rollingUntil: null,
  replacedBy: null,
  lastUsedAt: null,
  flags: { makerLacksPermissions: false, secretUnseen: false },
});

describe("statuses", () => {
  it("draws each status with its tone and line", () => {
    expect(STATUS.active).toEqual({ label: "Active", tone: "success" });
    expect(STATUS.rolling.tone).toBe("warning");
    expect(statusLine(base)).toBe("Expires never");
    expect(
      statusLine({ ...base, status: "rolling", rollingUntil: "2026-11-23T10:00:00.000Z" }),
    ).toMatch(/^Works until .+ when the overlap ends$/);
    expect(statusLine({ ...base, status: "expired", replacedBy: "W6N4R3T5V7" })).toBe(
      "Replaced by a rolled key",
    );
    expect(
      statusLine({ ...base, status: "revoked", revokedAt: "2026-11-21T10:00:00.000Z" }),
    ).toMatch(/^Revoked /);
    expect(lastUsedLine(base)).toBe("Never used");
  });
});

describe("the form", () => {
  const draft = {
    name: "Ledger sync",
    mode: "test" as const,
    kind: "rk" as const,
    scopes: ["customers:read"],
    allowlist: "",
    expiresIn: "90d" as const,
  };

  it("reads the allowlist as typed, by commas, spaces or lines", () => {
    expect(parseAllowlist(" 8.8.8.0/24, 2a00:1450::/32\n8.8.4.4 ")).toEqual([
      "8.8.8.0/24",
      "2a00:1450::/32",
      "8.8.4.4",
    ]);
    expect(parseAllowlist("")).toEqual([]);
  });

  it("checks the name, the scopes and the allowlist's length before sending", () => {
    expect(draftProblems(draft)).toEqual({});
    expect(draftProblems({ ...draft, name: "" }).name).toMatch(/up to 60 characters/);
    expect(draftProblems({ ...draft, name: "ledger.sync" }).name).toMatch(/web or email address/);
    expect(draftProblems({ ...draft, scopes: [] }).scopes).toMatch(/at least one scope/);
    expect(draftProblems({ ...draft, kind: "sk", scopes: [] })).toEqual({});
    const many = Array.from({ length: 21 }, (_, i) => `8.8.${i}.0/24`).join(",");
    expect(draftProblems({ ...draft, allowlist: many }).allowlist).toBeDefined();
  });

  it("says what a server field refusal means, naming an allowlist entry by its position", () => {
    expect(fieldSentence("ipAllowlist.2", "loopback")).toEqual({
      field: "allowlist",
      text: "Entry 3 is a range no request can come from.",
    });
    expect(fieldSentence("ipAllowlist", "required_for_money").text).toMatch(
      /needs an address allowlist/,
    );
    expect(fieldSentence("name", "web_address").field).toBe("name");
    expect(SCOPE_ORDER).toHaveLength(8);
    expect(envLine("x")).toBe("FIN_KEY=x");
  });
});

describe("paging and the role", () => {
  it("pages a mode's list by the server's largest page, at least one page", () => {
    expect(KEYS_PAGE_SIZE).toBe(100);
    expect(pageCountOf(0)).toBe(1);
    expect(pageCountOf(100)).toBe(1);
    expect(pageCountOf(101)).toBe(2);
    expect(pageCountOf(250)).toBe(3);
  });

  it("keeps the pages chosen in an organisation, and starts another at the first page", () => {
    const chosen = { orgId: "org_acme", test: 3, live: 2 };
    expect(pagesIn(chosen, "org_acme")).toBe(chosen);
    expect(pagesIn(chosen, "org_ito")).toEqual({ orgId: "org_ito", test: 1, live: 1 });
    // Before the viewer names an organisation, then once it does.
    expect(pagesIn({ orgId: "", test: 1, live: 1 }, "org_acme")).toEqual({
      orgId: "org_acme",
      test: 1,
      live: 1,
    });
  });

  it("reads whether the role holds a key, as an allowlist change asks", () => {
    const role = { manage: true, fullAccess: false, scopes: ["customers:read", "money:read"] };
    expect(withinRole(role, "rk", ["customers:read"])).toBe(true);
    expect(withinRole(role, "rk", ["customers:read", "money:write"])).toBe(false);
    expect(withinRole(role, "sk", [])).toBe(false);
    expect(withinRole({ ...role, fullAccess: true }, "sk", [])).toBe(true);
    expect(withinRole({ ...role, manage: false }, "rk", ["customers:read"])).toBe(false);
    expect(withinRole(undefined, "rk", ["customers:read"])).toBe(false);
  });
});

describe("the contracts", () => {
  it("name the routes the API half registers", () => {
    expect([keysList.method, keysList.path]).toEqual(["GET", "/keys"]);
    expect([createKey.method, createKey.path, createKey.creates]).toEqual(["POST", "/keys", true]);
    expect([rollKey.method, rollKey.path]).toEqual(["POST", "/keys/:keyId/roll"]);
  });
});
