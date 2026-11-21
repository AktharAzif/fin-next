// The small pieces: IDs, network keys, device summaries, Fin's cookies, enrolment codes, the
// audit payload's refusals (T-SAT-16's identity half) and the email parameters' refusals
// (T-SAT-41's identity half).
import { describe, expect, it } from "vitest";
import { REALM_EVENTS } from "./audit/events.ts";
import { auditPayload } from "./audit/record.ts";
import { AuditMetadataError, personalShapeOf } from "./audit/shapes.ts";
import { FIN_COOKIE_MAX_AGE, readCookie, serializeFinCookie } from "./cookies.ts";
import { deviceSummary } from "./device.ts";
import { REALM_TEMPLATES } from "./email/templates.ts";
import { ManualClock, systemClock } from "./ports/clock.ts";
import { isId, newId } from "./ports/ids.ts";
import { networkKey } from "./request.ts";
import {
  generateEnrolmentCode,
  hashEnrolmentCode,
  normaliseEnrolmentCode,
} from "./staff/enrolment.ts";
import { buildCatalogue, stepUpCatalogue } from "./step-up/actions/index.ts";

describe("newId", () => {
  it("makes time-ordered IDs of the database's shape", () => {
    const clock = new ManualClock("2026-11-21T10:00:00Z");
    const a = newId("usr", clock);
    clock.advance(1);
    const b = newId("usr", clock);
    expect(a).toMatch(/^usr_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(a < b).toBe(true);
    expect(isId(a, "usr")).toBe(true);
    expect(isId(a, "ses")).toBe(false);
    expect(isId("usr_ILOU", "usr")).toBe(false);
  });
});

describe("networkKey", () => {
  it("counts IPv4 per address and IPv6 per /48", () => {
    expect(networkKey("203.0.113.9")).toBe("v4:203.0.113.9");
    expect(networkKey("::ffff:203.0.113.9")).toBe("v4:203.0.113.9");
    expect(networkKey("2001:db8:abcd:12::1")).toBe(networkKey("2001:0db8:abcd:ffff::2"));
    expect(networkKey("2001:db8:abcd:12::1")).not.toBe(networkKey("2001:db8:abce::1"));
    expect(networkKey(null)).toBe("unknown");
  });
});

describe("deviceSummary", () => {
  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Chrome on Mac",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
      "Firefox on Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0",
      "Edge on Windows",
    ],
    [null, "A browser"],
  ])("summarises %s", (ua, summary) => {
    expect(deviceSummary(ua)).toBe(summary);
  });
});

describe("Fin's cookies", () => {
  it("are host-only __Host- cookies, Secure, HttpOnly, Path=/, Lax, with no Domain", () => {
    for (const realm of ["developer", "staff"] as const) {
      for (const cookie of Object.keys(
        FIN_COOKIE_MAX_AGE[realm],
      ) as (keyof (typeof FIN_COOKIE_MAX_AGE)[typeof realm])[]) {
        const value = serializeFinCookie(realm, cookie, "A".repeat(43));
        expect(value).toMatch(/^__Host-fin(-admin)?\./);
        expect(value).toContain("; Path=/; Secure; HttpOnly; SameSite=Lax");
        expect(value.toLowerCase()).not.toContain("domain=");
      }
    }
  });

  it("refuses a value that is not a token", () => {
    expect(() => serializeFinCookie("developer", "code_browser", "a;b")).toThrow();
  });

  it("reads one cookie from a header", () => {
    expect(readCookie("a=1; __Host-fin.code_browser=xyz; b=2", "__Host-fin.code_browser")).toBe(
      "xyz",
    );
    expect(readCookie(null, "a")).toBeNull();
  });
});

describe("enrolment codes ([SA-29], T-SAT-12)", () => {
  it("are 16 Crockford characters in four groups of four", () => {
    const code = generateEnrolmentCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(new Set(Array.from({ length: 50 }, generateEnrolmentCode)).size).toBe(50);
  });

  it("normalise typed input and hash to SHA-256", () => {
    const code = generateEnrolmentCode();
    const typed = code.toLowerCase().replace(/-/g, " ");
    expect(normaliseEnrolmentCode(typed)).toBe(code.replace(/-/g, ""));
    expect(normaliseEnrolmentCode("ILO0-0000-0000-0000")).toBe("1100000000000000");
    expect(normaliseEnrolmentCode("too-short")).toBeNull();
    expect(hashEnrolmentCode("A".repeat(16))).toHaveLength(32);
  });
});

describe("audit payloads", () => {
  const userId = newId("usr", systemClock);
  const sessionId = newId("ses", systemClock);

  it("builds audit.record's argument", () => {
    const payload = auditPayload(
      {
        event: "session.created",
        actor: { kind: "user", id: userId, via: "console" },
        target: sessionId,
        refs: [userId, sessionId],
        subjectUserId: userId,
        metadata: { method: "passkey", assurance: "aal2", trustedBrowser: false },
        context: { clientIp: "203.0.113.4", userAgent: "x".repeat(500) },
      },
      newId("aud", systemClock),
      "req_1",
      "test",
    );
    expect(payload).toMatchObject({
      event: "session.created",
      target_id: sessionId,
      ref_ids: [userId],
    });
    expect((payload.context as { user_agent: string }).user_agent).toHaveLength(400);
  });

  it.each([
    [
      "an address",
      { method: "passkey", assurance: "aal2", trustedBrowser: false, extra: "a@example.com" },
    ],
    [
      "an unknown key",
      { method: "passkey", assurance: "aal2", trustedBrowser: false, name: "Ada" },
    ],
    ["a bad enum", { method: "carrier_pigeon", assurance: "aal2", trustedBrowser: false }],
  ])("refuses metadata carrying %s", (_label, metadata) => {
    expect(() =>
      auditPayload(
        {
          event: "session.created",
          actor: { kind: "user", id: userId, via: "console" },
          target: sessionId,
          subjectUserId: userId,
          metadata,
        },
        newId("aud", systemClock),
        null,
        "test",
      ),
    ).toThrow(AuditMetadataError);
  });

  it("refuses a target of the wrong kind, a wrong actor and a missing subject", () => {
    const input = {
      event: "passkey.added" as const,
      actor: { kind: "user" as const, id: userId, via: "console" as const },
      target: sessionId,
      subjectUserId: userId,
      metadata: {},
    };
    expect(() => auditPayload(input, newId("aud", systemClock), null, "t")).toThrow(/pky_/);
    expect(() =>
      auditPayload(
        {
          ...input,
          target: newId("pky", systemClock),
          actor: { kind: "operator", id: null, via: "operator" },
        },
        newId("aud", systemClock),
        null,
        "t",
      ),
    ).toThrow(/operator/);
    const { subjectUserId: _s, ...noSubject } = input;
    expect(() =>
      auditPayload(
        { ...noSubject, target: newId("pky", systemClock) },
        newId("aud", systemClock),
        null,
        "t",
      ),
    ).toThrow(/subject/);
  });

  it.each([
    ["a.person@example.com", "email"],
    ["203.0.113.7", "ip"],
    ["https://example.com/a?b=c", "url_query"],
    ["123456789", "digits"],
    ["k3yshapedvaluek3yshapedvalue12", "token"],
  ])("finds the personal shape in %s", (value, shape) => {
    expect(personalShapeOf(value)).toBe(shape);
  });

  it("lets IDs and timestamps through", () => {
    expect(personalShapeOf(userId)).toBeNull();
    expect(personalShapeOf("2026-11-21T10:00:00.000Z")).toBeNull();
    expect(personalShapeOf("signed_out")).toBeNull();
  });

  it("names a person-scope subject for every identity event and a staff scope for the rest", () => {
    for (const [name, spec] of Object.entries(REALM_EVENTS)) {
      expect(spec.scope, name).toBe(name.startsWith("staff.") ? "staff" : "person");
    }
  });
});

describe("email parameters", () => {
  it("never admit an enrolment code, a backup code or a key secret", () => {
    const planted = {
      code: "ABCD-EFGH-JKMN-PQRS",
      backupCodes: ["abcde-fghij"],
      secret: ["fin", "live", "0123456789abcdef"].join("_"),
      token: "t".repeat(43),
    };
    for (const [name, spec] of Object.entries(REALM_TEMPLATES)) {
      expect(spec.params.safeParse(planted).success, name).toBe(false);
      for (const [key, value] of Object.entries(planted)) {
        expect(spec.params.safeParse({ [key]: value }).success, `${name}.${key}`).toBe(false);
      }
    }
  });
});

describe("the step-up catalogue", () => {
  it("refuses a key listed twice", () => {
    const action = {
      key: "account.name",
      realm: "developer" as const,
      kind: "window" as const,
      reasonKey: "x",
      bind: [],
    };
    expect(() => buildCatalogue([[action], [action]])).toThrow(/twice/);
    expect(stepUpCatalogue().get("account.passkey_remove")?.bind).toEqual([
      { name: "id", kind: "string" },
    ]);
  });
});
