// Small units: the header rules, the parameter vocabulary's secret refusals, the recipient hash,
// IDs and the backoff.
import { describe, expect, it } from "vitest";
import { checkHeaders, HeaderRefused } from "../src/headers.ts";
import { EMAIL_ID, newId } from "../src/ids.ts";
import { formatTime, param, secretShapeIn } from "../src/params.ts";
import { normaliseAddress, recipientHasher } from "../src/recipient-key.ts";
import { escapeHtml } from "../src/render.ts";
import { backoffMs, DEFAULT_LIMITS } from "../src/sender/limits.ts";

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
  ])("accepts %s", (value) => {
    expect(
      param.personName.safeParse(value.slice(0, 60)).success ||
        param.device.safeParse(value).success,
    ).toBe(true);
    expect(secretShapeIn(value)).toBeUndefined();
  });

  it.each([
    ["an email address", "someone@example.com"],
    ["a web address", "visit https://example.com"],
    ["a bare www", "www.example.com"],
    ["a long digit run", "call 5551234567"],
    ["an enrolment code", ["7KQ2", "M9XA", "4RTB", "Z8HC"].join("-")],
    ["an enrolment code run together", "7KQ2M9XA4RTBZ8HC"],
    ["a backup code", ["aB3dE", "f9GhK"].join("-")],
    ["a token", "abcdef0123456789abcdef"],
    ["a Cloudflare token", ["cfat", "abcdefghijklmnop"].join("_")],
  ])("refuses %s", (_what, value) => {
    expect(secretShapeIn(value)).toBeTypeOf("string");
    expect(param.personName.safeParse(value).success).toBe(false);
  });

  it("refuses untrimmed, over-long and invisible text", () => {
    expect(param.orgName.safeParse(" Acme").success).toBe(false);
    expect(param.orgName.safeParse("A".repeat(51)).success).toBe(false);
    expect(param.orgName.safeParse(`Acme${String.fromCodePoint(0x200b)}`).success).toBe(false);
  });

  it("accepts only 8-digit codes and UTC times", () => {
    expect(param.code.safeParse("01234567").success).toBe(true);
    expect(param.code.safeParse("0123456").success).toBe(false);
    expect(param.time.safeParse("2026-11-21T04:30:00.000Z").success).toBe(true);
    expect(param.time.safeParse("2026-11-21T10:00:00+05:30").success).toBe(false);
    expect(formatTime("2026-11-21T04:05:00.000Z")).toBe("21 Nov 2026, 04:05 UTC");
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
