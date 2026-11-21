// Small units: the header rules, the parameter vocabulary's secret refusals, the recipient hash,
// IDs and the backoff.
import { describe, expect, it } from "vitest";
import { checkHeaders, HeaderRefused } from "../src/headers.ts";
import { EMAIL_ID, newId } from "../src/ids.ts";
import {
  displayText,
  formatTime,
  HIDDEN_VALUE,
  nameSecretShapeIn,
  param,
  secretShapeIn,
} from "../src/params.ts";
import { normaliseAddress, recipientHasher } from "../src/recipient-key.ts";
import { escapeHtml } from "../src/render.ts";
import {
  type BudgetGroup,
  backoffMs,
  budgetRefusal,
  budgetScopes,
  checkLimits,
  DEFAULT_LIMITS,
  type SenderLimits,
} from "../src/sender/limits.ts";

describe("checkHeaders", () => {
  it("accepts Fin's headers and Cloudflare's allowlisted names in any case", () => {
    expect(() =>
      checkHeaders({
        "auto-submitted": "auto-generated",
        "X-Entity-Ref-ID": "a",
        "X-Fin-Category": "code",
      }),
    ).not.toThrow();
  });

  it.each<[Record<string, string>, string]>([
    [{ "Message-ID": "<x@example.com>" }, "platform-controlled"],
    [{ From: "a@example.com" }, "an API field"],
    [{ "List-Unsubscribe": "<https://example.com/u>" }, "refused by Fin"],
    [{ "X-Bad Name": "v" }, "a bad X- name"],
    [{ "X-Fine": "" }, "an empty value"],
    [{ "X-Fine": "a\r\nBcc: someone@example.com" }, "a line break"],
    [{ "X-Fine": "x".repeat(2049) }, "a value over 2,048 bytes"],
    [{ "X-A": "1", "x-a": "2" }, "a name twice"],
  ])("refuses %j (%s)", (headers, _why) => {
    expect(() => checkHeaders(headers)).toThrow(HeaderRefused);
  });

  it("refuses more than 16 KB of headers in all", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 10; i++) many[`X-H${i}`] = "v".repeat(2000);
    expect(() => checkHeaders(many)).toThrow(HeaderRefused);
  });
});

describe("display values", () => {
  it.each([
    "Ada Lovelace",
    "Smith-Jones",
    "Anne-Marie O'Neil",
    "Chrome 131 on Windows",
    "Example Payments Ltd",
  ])("accepts %s as it is", (value) => {
    expect(param.personName.parse(value)).toBe(value);
    expect(param.device.parse(value)).toBe(value);
    expect(displayText(80).parse(value)).toBe(value);
    expect(secretShapeIn(value)).toBeUndefined();
  });

  it.each([
    ["an email address", "someone@example.com"],
    ["a web address", "visit https://example.com"],
    ["a bare www", "www.example.com"],
    ["a long digit run", "call 5551234567"],
    ["an enrolment code", ["7KQ2", "M9XA", "4RTB", "Z8HC"].join("-")],
    ["an enrolment code run together", "7KQ2M9XA4RTBZ8HC"],
    ["an enrolment code run together, in lower case", "7kq2m9xa4rtbz8hc"],
    ["a backup code", ["aB3dE", "f9GhK"].join("-")],
    ["a token", ["abcdef", "0123456789", "abcdef"].join("")],
    ["a Cloudflare token", ["cfat", "abcdefghijklmnop"].join("_")],
  ])("refuses %s in a display value Fin builds, and hides it in a device label", (_what, value) => {
    expect(secretShapeIn(value)).toBeTypeOf("string");
    expect(displayText(80).safeParse(value).success).toBe(false);
    // A device label comes from the browser's user agent, which whoever signs in chooses: it is
    // never carried, but it never refuses the notice (and with it the action) either.
    expect(param.device.parse(value)).toBe(HIDDEN_VALUE);
  });

  // Spec 02 §8.6 lets a name hold letters, numbers and simple punctuation: a name it allows never
  // refuses the notice about that person, team or role (and so the action), and one in no code's
  // shape is mailed as it is.
  it.each([
    ["personName", "Ann McKay-Jones"],
    ["personName", "Anna McKay-Smith"],
    ["personName", "Leonard McCoy-Smith"],
    ["orgName", "DeVos-Group"],
    ["orgName", "DeWit-Jones"],
    ["orgName", "Acme-Payments-2025"],
    ["orgName", "Northwind-Trading-2026"],
    ["orgName", "Web3Infrastructure"],
    ["orgName", "Acme Bank Card 2025"],
    ["orgName", "MoneyJarCompany"],
    ["orgName", "Acme2025Payments"],
    ["roleLabel", "Level2-Support-Admins"],
  ] as const)("mails the ordinary %s %s as it is", (field, value) => {
    expect(param[field].parse(value)).toBe(value);
  });

  // A name in the shape of an enrolment or backup code is hidden, as a code passed into a name by
  // mistake must be (T08-23); the notice still goes, without the name.
  it.each([
    ["personName", "Tier2-Agent"],
    ["personName", "Abcd1-Efgh2"],
    ["personName", "Agent-007ab"],
    ["orgName", "Team1-Alpha"],
    ["orgName", "Team7-Alpha"],
    ["orgName", "Cloud-Ops42"],
    ["orgName", "Alpha-12345"],
    ["orgName", "ACME2025PAYMENTS"],
    ["orgName", "acme2025payments"],
    ["orgName", "Web3 Data Team Peak"],
    ["orgName", "Acme Bank Web3 Team"],
    ["orgName", "Bank 4ACH Team Desk"],
    ["roleLabel", "Tier1-Admin"],
    ["roleLabel", "Admin-Tier2"],
    ["roleLabel", "Team1-Leads"],
    ["roleLabel", "Team4-Alpha"],
    ["roleLabel", "Level-2Team"],
  ] as const)("hides the %s %s, which has a code's shape, and never refuses", (field, value) => {
    expect(param[field].parse(value)).toBe(HIDDEN_VALUE);
  });

  it.each([
    ["a Fin key", ["fin", "live", "sk", "0123456789ABCDEFGHIJabcdef"].join("_")],
    ["a webhook secret", ["whsec", "abcdefghijklmnop0123"].join("_")],
    ["a Cloudflare token", ["cfut", "abcdefghijklmnop"].join("_")],
    ["a JWT", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJl"].join(".")],
    ["a private key", ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ")],
    ["an address", "someone@example.com"],
    ["a web address", "www.example.com"],
    ["a phone number", "Call 5551234567"],
    ["an enrolment code", ["ABCD", "EFGH", "JK3M", "NPQR"].join("-")],
    ["an enrolment code run together", "7KQ2M9XA4RTBZ8HC"],
    ["an enrolment code run together, in lower case", "7kq2m9xa4rtbz8hc"],
    ["a backup code", ["a1B2c", "D3e4F"].join("-")],
    ["an untrimmed name", " Acme"],
    ["an over-long name", "A".repeat(61)],
    ["an invisible character", `Acme${String.fromCodePoint(0x200b)}`],
    ["a bidirectional override", `Acme${String.fromCodePoint(0x202e)}moc.live`],
    ["a line break", "Acme\nVisit us"],
    ["a lone surrogate", `Acme${String.fromCharCode(0xd800)}`],
    ["an empty name", ""],
  ])("hides %s in a name, never carrying it and never refusing the notice", (_what, value) => {
    for (const field of ["personName", "orgName", "roleLabel"] as const) {
      expect(param[field].parse(value), field).toBe(HIDDEN_VALUE);
    }
  });

  it("hides with a value every name field and the device label accept as they are", () => {
    for (const field of ["personName", "orgName", "roleLabel", "device"] as const) {
      expect(param[field].parse(HIDDEN_VALUE), field).toBe(HIDDEN_VALUE);
    }
    expect(secretShapeIn(HIDDEN_VALUE)).toBeUndefined();
  });

  it("still refuses a name or a device label that is not a string at all", () => {
    for (const field of ["personName", "orgName", "roleLabel", "device"] as const) {
      expect(param[field].safeParse(42).success, field).toBe(false);
      expect(param[field].safeParse(null).success, field).toBe(false);
    }
  });

  it("accepts only 8-digit codes and UTC times", () => {
    expect(param.code.safeParse("01234567").success).toBe(true);
    expect(param.code.safeParse("0123456").success).toBe(false);
    expect(param.time.safeParse("2026-11-21T04:30:00.000Z").success).toBe(true);
    expect(param.time.safeParse("2026-11-21T10:00:00+05:30").success).toBe(false);
    expect(formatTime("2026-11-21T04:05:00.000Z")).toBe("21 Nov 2026, 04:05 UTC");
  });
});

// Every code Fin issues, in every form Fin and the library print it, is hidden in every name field
// (T08-23, SA-29). The codes' own rules (packages/identity: crypto/backup-codes.ts and
// staff/enrolment.ts, each with its property test there) are what make that hold: a backup code is
// 10 characters of a-z, 0-9 and A-Z that mix letters and digits, printed `xxxxx-xxxxx`; an
// enrolment code is 16 Crockford characters with a group of four that mixes a letter and a digit,
// printed `XXXX-XXXX-XXXX-XXXX`. These draw codes by exactly those rules, the fewest digits or
// letters the rules allow included, and run each through every name field.
describe("the codes Fin issues, passed into a name", () => {
  const NAME_FIELDS = ["personName", "orgName", "roleLabel"] as const;
  const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const DIGITS = "0123456789";
  const CROCKFORD_LETTERS = "ABCDEFGHJKMNPQRSTVWXYZ";

  /** A small seeded generator (mulberry32), so a failure replays. */
  function seeded(seed: number): (n: number) => number {
    let a = seed >>> 0;
    return (n) => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
  }
  const pick = (next: (n: number) => number, from: string) => from[next(from.length)] as string;

  function expectHidden(value: string): void {
    expect(nameSecretShapeIn(value), value).toBeTypeOf("string");
    for (const field of NAME_FIELDS) {
      expect(param[field].parse(value), `${field}: ${value}`).toBe(HIDDEN_VALUE);
    }
  }

  it("hides a backup code with a single digit or a single letter, in every place", () => {
    const next = seeded(1);
    for (let place = 0; place < 10; place += 1) {
      for (const [one, rest] of [
        [DIGITS, LETTERS],
        [LETTERS, DIGITS],
      ] as const) {
        const raw = Array.from({ length: 10 }, (_, i) => pick(next, i === place ? one : rest));
        expectHidden(`${raw.slice(0, 5).join("")}-${raw.slice(5).join("")}`);
      }
    }
  });

  it("hides 5,000 backup codes drawn by the issuing rule", () => {
    const next = seeded(2);
    const alphabet = LETTERS + DIGITS;
    let drawn = 0;
    while (drawn < 5_000) {
      const raw = Array.from({ length: 10 }, () => pick(next, alphabet)).join("");
      if (!/\d/.test(raw) || !/[A-Za-z]/.test(raw)) continue;
      drawn += 1;
      expectHidden(`${raw.slice(0, 5)}-${raw.slice(5)}`);
    }
  });

  /** An enrolment code's four groups in each form it is printed or typed in. */
  function enrolmentForms(groups: readonly string[]): string[] {
    const joined = groups.join("");
    return [
      groups.join("-"),
      groups.join(" "),
      joined,
      groups.join("-").toLowerCase(),
      joined.toLowerCase(),
    ];
  }

  it("hides an enrolment code whose one mixed group has one digit or one letter, in every place", () => {
    const next = seeded(3);
    for (let group = 0; group < 4; group += 1) {
      for (let place = 0; place < 4; place += 1) {
        for (const [one, rest] of [
          [DIGITS, CROCKFORD_LETTERS],
          [CROCKFORD_LETTERS, DIGITS],
        ] as const) {
          // Every other group is all letters or all digits: no other group mixes.
          const groups = Array.from({ length: 4 }, (_, g) => {
            const pure = next(2) === 0 ? CROCKFORD_LETTERS : DIGITS;
            return Array.from({ length: 4 }, (_, i) =>
              g === group ? pick(next, i === place ? one : rest) : pick(next, pure),
            ).join("");
          });
          for (const form of enrolmentForms(groups)) expectHidden(form);
        }
      }
    }
  });

  it("hides 5,000 enrolment codes drawn by the issuing rule, in every form", () => {
    const next = seeded(4);
    const alphabet = CROCKFORD_LETTERS + DIGITS;
    let drawn = 0;
    while (drawn < 5_000) {
      const groups = Array.from({ length: 4 }, () =>
        Array.from({ length: 4 }, () => pick(next, alphabet)).join(""),
      );
      if (!groups.some((g) => /\d/.test(g) && /[A-Z]/.test(g))) continue;
      drawn += 1;
      for (const form of enrolmentForms(groups)) expectHidden(form);
    }
  });
});

describe("the recipient hash", () => {
  const key = { version: 1, secret: new Uint8Array(32).fill(7) };
  const hash = recipientHasher(key);

  it("normalises case, Unicode form and the domain's IDNA, keeping dots and plus tags", () => {
    expect(normaliseAddress("Person@EXAMPLE.com")).toBe("person@example.com");
    expect(normaliseAddress("p.e+tag@example.com")).toBe("p.e+tag@example.com");
    expect(normaliseAddress("x@bücher.example")).toBe("x@xn--bcher-kva.example");
    expect(normaliseAddress("no-at-sign")).toBeUndefined();
    expect(hash("address", "Person@Example.COM")).toBe(hash("address", "person@example.com"));
    expect(hash("address", "p.e@example.com")).not.toBe(hash("address", "pe@example.com"));
  });

  it("is 32 hex characters and depends on the key", () => {
    const h = hash("address", "person@example.com");
    expect(h).toMatch(/^[0-9a-f]{32}$/u);
    const other = recipientHasher({ version: 2, secret: new Uint8Array(32).fill(8) });
    expect(other("address", "person@example.com")).not.toBe(h);
    expect(hash("customer", "cus_x")).not.toBe(hash("person", "cus_x"));
  });

  it("refuses a short key", () => {
    expect(() => recipientHasher({ version: 1, secret: new Uint8Array(16) })).toThrow();
  });
});

describe("the daily budget's shares", () => {
  const ORG_A = "org_01jd00000000000000000000aa";
  const ORG_B = "org_01jd00000000000000000000bb";

  /** The budget's counters, raised as `takeBudget` would. */
  function day(limits: SenderLimits = DEFAULT_LIMITS, start: Record<string, number> = {}) {
    const counts: Record<string, number> = { ...start };
    const send = (group: BudgetGroup, orgId?: string): boolean => {
      const scopes = budgetScopes(group, orgId);
      const seen = Object.fromEntries(scopes.read.map((s) => [s, counts[s] ?? 0]));
      if (budgetRefusal(group, seen, limits, orgId) !== undefined) return false;
      for (const s of scopes.raise) counts[s] = (counts[s] ?? 0) + 1;
      return true;
    };
    const flood = (group: BudgetGroup, orgId?: string): number => {
      let n = 0;
      while (n < 10_000 && send(group, orgId)) n += 1;
      return n;
    };
    return { counts, send, flood };
  }

  it("keeps a part of the security share that no organisation's notices may spend", () => {
    // Ordinary mail has used its part first, then one organisation's bypass notices run.
    const d = day(DEFAULT_LIMITS, { environment: 1500 });
    expect(d.flood("security", ORG_A)).toBe(DEFAULT_LIMITS.dailySecurityPerOrganisation);
    // Another organisation's notice, and a notice that names no organisation, still go.
    expect(d.send("security", ORG_B)).toBe(true);
    expect(d.send("security")).toBe(true);
  });

  it("never lets organisations' notices and codes together take the account share", () => {
    const limits = DEFAULT_LIMITS;
    for (const order of ["orgs first", "codes first"] as const) {
      const d = day(limits, { environment: 1500 });
      const orgs = Array.from({ length: 40 }, (_, i) => `org_01jd${String(i).padStart(22, "0")}`);
      if (order === "codes first") d.flood("code");
      for (const org of orgs) d.flood("security", org);
      d.flood("code");
      expect(d.flood("security"), order).toBeGreaterThanOrEqual(limits.dailyAccountSecurityReserve);
    }
  });

  it("still leaves codes their own part when organisations' notices run first", () => {
    const d = day(DEFAULT_LIMITS, { environment: 1500 });
    for (let i = 0; i < 40; i++) d.flood("security", `org_01jd${String(i).padStart(22, "0")}`);
    d.flood("security");
    expect(d.flood("code")).toBeGreaterThanOrEqual(DEFAULT_LIMITS.dailyCodeOnlyReserve);
  });

  it("refuses limits in which one organisation could spend all of what organisations may", () => {
    expect(() => checkLimits(DEFAULT_LIMITS)).not.toThrow();
    const share =
      DEFAULT_LIMITS.dailySecurityOnlyReserve - DEFAULT_LIMITS.dailyAccountSecurityReserve;
    expect(() => checkLimits({ ...DEFAULT_LIMITS, dailySecurityPerOrganisation: share })).toThrow();
    expect(() =>
      checkLimits({ ...DEFAULT_LIMITS, dailySecurityPerOrganisation: share - 1 }),
    ).not.toThrow();
    expect(() =>
      checkLimits({
        ...DEFAULT_LIMITS,
        dailyAccountSecurityReserve: DEFAULT_LIMITS.dailySecurityOnlyReserve + 1,
      }),
    ).toThrow();
    // Ordinary mail's ceiling per organisation stays below ordinary mail's part in the same way.
    const ordinary = DEFAULT_LIMITS.dailyBudget - DEFAULT_LIMITS.dailySecurityReserve;
    expect(() => checkLimits({ ...DEFAULT_LIMITS, dailyPerOrganisation: ordinary })).toThrow();
    const d = day();
    expect(d.flood("ordinary", ORG_A)).toBe(DEFAULT_LIMITS.dailyPerOrganisation);
    expect(d.send("ordinary", ORG_B)).toBe(true);
    expect(d.send("ordinary")).toBe(true);
  });
});

describe("ids and backoff", () => {
  it("makes time-ordered email IDs of the database's shape", () => {
    const a = newId("eml", { now: () => 1_700_000_000_000 });
    const b = newId("eml", { now: () => 1_700_000_000_001 });
    expect(a).toMatch(EMAIL_ID);
    expect(a.slice(4, 14) < b.slice(4, 14)).toBe(true);
    expect(newId("job", { now: () => 0 })).toMatch(/^job_0{10}[0-9a-hjkmnp-tv-z]{16}$/u);
  });

  it("grows, caps and jitters the backoff", () => {
    expect(backoffMs(DEFAULT_LIMITS, 1, () => 0)).toBe(15_000);
    expect(backoffMs(DEFAULT_LIMITS, 1, () => 1)).toBe(30_000);
    expect(backoffMs(DEFAULT_LIMITS, 3, () => 1)).toBe(120_000);
    expect(backoffMs(DEFAULT_LIMITS, 30, () => 1)).toBe(DEFAULT_LIMITS.retryCapMs);
  });

  it("escapes every character that matters in HTML", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&=\``)).toBe(
      "&lt;a href&#61;&quot;x&quot; onclick&#61;&#39;y&#39;&gt;&amp;&#61;&#96;",
    );
  });
});
