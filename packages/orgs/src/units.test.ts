// The area's pure pieces: the audit payload's refusals (spec 02 §16.1, T-SAT-16 for this fragment),
// the invitation cookie and token (§9.3), the first organisation's name (§5.9), the notices'
// display values (§17.1), the audit log's windows and devices (§14.5), and the credential registry's
// split by rolling permission (§9.4, S2-42).
import { randomBytes } from "node:crypto";
import type { DashboardPermission } from "@fin/access";
import { findTemplate } from "@fin/email";
import { describe, expect, it } from "vitest";
import { orgAuditPayload } from "./audit/record.ts";
import { deviceOf, startOfDay, windowOf } from "./audit-log.ts";
import { CredentialRegistry, type CredentialSource } from "./credentials.ts";
import { displayValue, ORG_TEMPLATES, orgNameForEmail } from "./email.ts";
import { firstOrganizationName } from "./organizations.ts";
import {
  InvitationCookie,
  isInvitationToken,
  maskAddress,
  newInvitationToken,
  tokenHash,
} from "./tokens.ts";

const ORG = "org_01jd0000000000000000000000";
const MEM = "mem_01jd0000000000000000000000";
const USR = "usr_01jd0000000000000000000000";

describe("the audit payload", () => {
  const base = {
    event: "member.joined" as const,
    actor: { kind: "user" as const, id: USR, via: "console" as const },
    target: MEM,
    organizationId: ORG,
    metadata: { roleKey: "admin" },
  };

  it("carries the organisation, the actor, the step-up and the context", () => {
    const payload = orgAuditPayload(
      {
        ...base,
        actor: {
          ...base.actor,
          stepUp: { kind: "intent", method: "totp", ref: "sti_01jd0000000000000000000000" },
        },
        refs: [USR, MEM, ORG],
        context: { clientIp: "2001:db8::1", userAgent: "x".repeat(500) },
      },
      "aud_01jd0000000000000000000000",
      "req_01jd0000000000000000000000",
      "test",
    );
    expect(payload).toMatchObject({
      organization_id: ORG,
      step_up_ref: "sti_01jd0000000000000000000000",
      ref_ids: [USR, ORG],
      context: { client_ip: "2001:db8::1" },
    });
    expect((payload.context as { user_agent: string }).user_agent).toHaveLength(400);
  });

  it("refuses an address, a token or a name in metadata, another target, actor or event", () => {
    const refuse = (input: Partial<typeof base> & Record<string, unknown>) =>
      expect(() =>
        orgAuditPayload({ ...base, ...input } as never, "aud_x", null, "test"),
      ).toThrow();
    refuse({ metadata: { roleKey: "someone@example.com" } });
    refuse({ metadata: { roleKey: "admin", name: "Ada" } as never });
    refuse({ target: "inv_01jd0000000000000000000000" });
    refuse({ actor: { kind: "staff", id: "stf_x", via: "console" } as never });
    refuse({ event: "member.unknown" as never });
    refuse({ organizationId: "not-an-org" });
    refuse({
      refs: Array.from(
        { length: 33 },
        (_, i) => `mem_01jd00000000000000000001${String(i).padStart(2, "0")}`,
      ),
    });
    refuse({ refs: ["someone@example.com"] });
  });
});

describe("the invitation's token and cookie", () => {
  const secrets = [
    { version: 2, value: randomBytes(32).toString("base64url") },
    { version: 1, value: randomBytes(32).toString("base64url") },
  ];

  it("makes 32-byte tokens, stores only their hash, and masks the address", () => {
    const token = newInvitationToken();
    expect(isInvitationToken(token)).toBe(true);
    expect(tokenHash(token)).toHaveLength(32);
    expect(tokenHash(token).toString("base64url")).not.toBe(token);
    expect(maskAddress("mona@example.com")).toBe("m•••@example.com");
  });

  it("signs with the newest secret, verifies with any, and refuses a tampered, foreign or stale value", () => {
    const now = new Date("2026-11-21T10:00:00Z");
    const id = "inv_01jd0000000000000000000000";
    const cookie = new InvitationCookie(secrets);
    const value = cookie.sign(id, now);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cookie.verify(value, now)).toBe(id);
    // An older secret still verifies what it signed; a realm without it does not.
    const old = new InvitationCookie([secrets[1] as (typeof secrets)[number]]).sign(id, now);
    expect(cookie.verify(old, now)).toBe(id);
    expect(
      new InvitationCookie([secrets[0] as (typeof secrets)[number]]).verify(old, now),
    ).toBeNull();
    expect(cookie.verify(`${value.slice(0, -3)}AAA`, now)).toBeNull();
    expect(cookie.verify(value.replace(id, "inv_01jd0000000000000000000001"), now)).toBeNull();
    expect(cookie.verify(value, new Date(now.getTime() + 86_401_000))).toBeNull();
    expect(cookie.verify(null, now)).toBeNull();
  });
});

describe("the first organisation's name", () => {
  it("comes from a work domain, else the first name, else a fallback", () => {
    expect(firstOrganizationName({ email: "ada@acme-payments.example.net", name: "" })).toBe(
      "Acme Payments",
    );
    expect(firstOrganizationName({ email: "ada@mail.northwind.example.org", name: "" })).toBe(
      "Northwind",
    );
    expect(firstOrganizationName({ email: "ada@example.com", name: "Ada Lovelace" })).toBe(
      "Ada's organisation",
    );
    expect(firstOrganizationName({ email: "ada@example.com", name: "" })).toBe("My organisation");
    expect(firstOrganizationName({ email: "ada@example.com", name: "Ada1234567" })).toBe(
      "My organisation",
    );
  });
});

describe("the notices", () => {
  it("are all in packages/email's orgs folder, sent by the console", () => {
    for (const id of ORG_TEMPLATES) expect(findTemplate(id)?.area, id).toBe("orgs");
  });

  it("carry a typed name only when the email's rule accepts it, and never drop the notice for one", () => {
    expect(displayValue("personName", "Ada Lovelace")).toBe("Ada Lovelace");
    // A name in a code's shape, which the email's name rule hides (a backup code; an enrolment code
    // run together).
    expect(displayValue("personName", "Ada12-Byron")).toBeUndefined();
    expect(orgNameForEmail("ACME2026PAYMENTS")).toBe("Your team on Fin");
    expect(orgNameForEmail("Acme Payments")).toBe("Acme Payments");
  });
});

describe("the audit log's window and devices", () => {
  it("reads today in the viewer's time zone, the ranges, and explicit bounds", () => {
    const now = new Date("2026-11-21T03:30:00Z");
    expect(startOfDay(now, "UTC").toISOString()).toBe("2026-11-21T00:00:00.000Z");
    expect(startOfDay(now, "Asia/Kathmandu").toISOString()).toBe("2026-11-20T18:15:00.000Z");
    expect(windowOf({ range: "7d", tz: "UTC", page: 1, size: 25 }, now).from?.toISOString()).toBe(
      "2026-11-14T03:30:00.000Z",
    );
    expect(windowOf({ range: "all", tz: "UTC", page: 1, size: 25 }, now)).toEqual({
      from: null,
      to: null,
    });
    const from = new Date("2026-11-01T00:00:00Z");
    expect(windowOf({ range: "today", tz: "UTC", from, page: 1, size: 25 }, now)).toEqual({
      from,
      to: null,
    });
    expect(deviceOf(null)).toBeNull();
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0) Firefox/130.0")).toBe("Firefox on Windows");
  });
});

describe("the credential registry", () => {
  const items = [
    { id: "live_1", label: "Production key", made: true, seen: true },
    { id: "test_1", label: "Sandbox key", made: true, seen: false },
  ];
  const calls: { ids: string[]; overlap: string }[] = [];
  const source: CredentialSource = {
    kind: "api_key",
    list: async () => items,
    rollPermission: (item) => (item.id.startsWith("live_") ? "apiKey.live" : "apiKey.sandbox"),
    roll: async (_tx, _org, ids, overlap) => {
      calls.push({ ids, overlap });
    },
  };

  it("refuses a kind registered twice", () => {
    const registry = new CredentialRegistry();
    registry.register(source);
    expect(() => registry.register(source)).toThrow(/twice/);
  });

  it("rolls at once only what the actor's permissions roll", async () => {
    const registry = new CredentialRegistry();
    registry.register(source);
    const held = new Set<DashboardPermission>(["apiKey.read", "apiKey.sandbox"]);
    const outcome = await registry.rollAll({} as never, ORG, USR, held, {
      kind: "user",
      id: USR,
      via: "console",
    });
    expect(outcome).toEqual({ listed: 2, rolledNow: 1, rollingWithinHour: 1 });
    expect(calls).toEqual([
      { ids: ["test_1"], overlap: "now" },
      { ids: ["live_1"], overlap: "1h" },
    ]);
  });
});
