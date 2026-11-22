// The Access drift check (spec 02 §10.9, S2-11; T-SAT-38's comparison): what the Allow policies let
// in against the active and pending members; counts only, never an address; fail closed.
import { MemoryLineSink } from "@fin/identity";
import { describe, expect, it } from "vitest";
import {
  AccessDriftUnavailable,
  allowListOf,
  compareAccess,
  readAllowList,
  runAccessDriftCheck,
} from "./access-drift.ts";

const policies = (result: unknown[]) => ({ success: true, errors: [], result });
const allow = (include: unknown[]) => ({
  id: "p1",
  decision: "allow",
  include,
  exclude: [],
  require: [],
});

// IDs of the overlay's shape, made here at run time (never a real one).
const app = {
  accountId: "0".repeat(32),
  appId: ["00000000", "0000", "4000", "8000", "000000000000"].join("-"),
  token: "t".repeat(40),
};

describe("allowListOf", () => {
  it("reads the Allow policies' address and domain rules, and counts any other rule", () => {
    const list = allowListOf(
      policies([
        allow([
          { email: { email: "One@Example.com" } },
          { email: { email: "two@example.com" } },
          { email_domain: { domain: "Example.org" } },
          { everyone: {} },
        ]),
        { id: "p2", decision: "deny", include: [{ email: { email: "denied@example.com" } }] },
      ]),
    );
    expect(list).toEqual({
      emails: ["one@example.com", "two@example.com"],
      domains: ["example.org"],
      other: 1,
    });
  });

  it("refuses an answer that is not Cloudflare's shape", () => {
    expect(() => allowListOf({ success: false })).toThrow(AccessDriftUnavailable);
    expect(() => allowListOf(null)).toThrow(AccessDriftUnavailable);
  });
});

describe("compareAccess", () => {
  it("finds no drift when exactly the members are listed", () => {
    const result = compareAccess(
      { emails: ["a@example.com", "b@example.com"], domains: [], other: 0 },
      ["b@example.com", "A@example.com"],
    );
    expect(result).toEqual({
      drift: false,
      accessCount: 2,
      staffCount: 2,
      missing: 0,
      extra: 0,
      domains: 0,
      other: 0,
    });
  });

  it("counts members no rule covers, listed addresses that are no member's, and rules it cannot read", () => {
    expect(
      compareAccess({ emails: ["a@example.com", "gone@example.com"], domains: [], other: 0 }, [
        "a@example.com",
        "new@example.com",
      ]),
    ).toMatchObject({ drift: true, missing: 1, extra: 1 });
    expect(compareAccess({ emails: [], domains: [], other: 1 }, [])).toMatchObject({
      drift: true,
      other: 1,
    });
  });

  it("covers members by their address domain under staging's One-time PIN domain rule", () => {
    expect(
      compareAccess({ emails: [], domains: ["example.com"], other: 0 }, [
        "a@example.com",
        "b@example.com",
      ]),
    ).toMatchObject({ drift: false, domains: 1, missing: 0 });
    expect(
      compareAccess({ emails: [], domains: ["example.com"], other: 0 }, ["c@example.net"]),
    ).toMatchObject({ drift: true, missing: 1 });
  });
});

describe("runAccessDriftCheck", () => {
  it("writes access.drift with counts only, and nothing when the lists agree", async () => {
    const lines = new MemoryLineSink();
    const result = await runAccessDriftCheck({
      readAllowList: async () => ({ emails: ["a@example.com"], domains: [], other: 0 }),
      staffAddresses: async () => ["a@example.com", "b@example.com"],
      lines,
    });
    expect(result.drift).toBe(true);
    expect(lines.named("access.drift")).toEqual([
      { accessCount: 1, staffCount: 2, missing: 1, extra: 0, domains: 0, other: 0 },
    ]);
    expect(JSON.stringify(lines.lines)).not.toContain("example.com");
    lines.clear();
    await runAccessDriftCheck({
      readAllowList: async () => ({ emails: ["a@example.com"], domains: [], other: 0 }),
      staffAddresses: async () => ["a@example.com"],
      lines,
    });
    expect(lines.lines).toEqual([]);
  });

  it("reads the policies before touching the members, and fails closed when it cannot", async () => {
    let read = false;
    await expect(
      runAccessDriftCheck({
        readAllowList: async () => {
          throw new AccessDriftUnavailable("fetch");
        },
        staffAddresses: async () => {
          read = true;
          return [];
        },
        lines: new MemoryLineSink(),
      }),
    ).rejects.toBeInstanceOf(AccessDriftUnavailable);
    expect(read).toBe(false);
  });
});

describe("readAllowList", () => {
  it("asks Cloudflare's policies endpoint for the application, with the read-only token", async () => {
    const seen: { url: string; auth: string | null; redirect: string | undefined }[] = [];
    const send = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        auth: new Headers(init.headers).get("authorization"),
        redirect: init.redirect,
      });
      return new Response(
        JSON.stringify(policies([allow([{ email: { email: "a@example.com" } }])])),
        {
          status: 200,
        },
      );
    }) as unknown as typeof fetch;
    expect(await readAllowList(app, send)).toEqual({
      emails: ["a@example.com"],
      domains: [],
      other: 0,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${app.accountId}/access/apps/${app.appId}/policies?per_page=50`,
    );
    expect(seen[0]?.auth).toBe(`Bearer ${app.token}`);
    expect(seen[0]?.redirect).toBe("error");
  });

  it("fails closed on a bad setting, a failed fetch, a refusal or a bad body, never naming the token", async () => {
    const answer = (status: number, body: string) =>
      (async () => new Response(body, { status })) as unknown as typeof fetch;
    const reasons: string[] = [];
    for (const [settings, send] of [
      [{ ...app, accountId: "nope" }, answer(200, "{}")],
      [
        app,
        (async () => {
          throw new Error("network");
        }) as unknown as typeof fetch,
      ],
      [app, answer(403, "{}")],
      [app, answer(200, "not json")],
      [app, answer(200, JSON.stringify({ success: false }))],
    ] as const) {
      try {
        await readAllowList(settings, send);
        reasons.push("passed");
      } catch (error) {
        expect(error).toBeInstanceOf(AccessDriftUnavailable);
        expect(String((error as Error).message)).not.toContain(app.token);
        reasons.push((error as AccessDriftUnavailable).reason);
      }
    }
    expect(reasons).toEqual(["config", "fetch", "status", "shape", "shape"]);
  });
});
