// What the API keys page derives: each status's badge and line, the allowlist as typed, the form's
// own checks (the server checks again), what a server field refusal says, and the contracts' shapes.
import { describe, expect, it } from "vitest";
import { createKey, keyRow, keysList, rollKey } from "./-api.ts";
import {
  draftProblems,
  envLine,
  fieldSentence,
  lastUsedLine,
  parseAllowlist,
  SCOPE_ORDER,
  STATUS,
  statusLine,
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

describe("the contracts", () => {
  it("name the routes the API half registers", () => {
    expect([keysList.method, keysList.path]).toEqual(["GET", "/keys"]);
    expect([createKey.method, createKey.path, createKey.creates]).toEqual(["POST", "/keys", true]);
    expect([rollKey.method, rollKey.path]).toEqual(["POST", "/keys/:keyId/roll"]);
  });
});
