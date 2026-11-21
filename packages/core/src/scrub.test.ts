// T08-30, AC-P0-12, AC-P0-40. Every secret-shaped value here is built at run time, so the
// public-safety check and gitleaks never see one in the file (CONTRIBUTING.md).
import { describe, expect, it } from "vitest";
import {
  assertNoPersonalShapes,
  hasPersonalShape,
  scrubBreadcrumb,
  scrubEvent,
  scrubLine,
  scrubText,
  WITHHELD,
} from "./scrub.ts";
import { WITHHELD_FIELDS } from "./scrub-shapes.ts";

/** A small seeded generator, so a failing case can be replayed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UPPER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MIXED = `${UPPER}abcdefghijklmnopqrstuvwxyz`;
const B64URL = `${MIXED}-_`;
const B64 = `${MIXED}+/`;

function pick(rand: () => number, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet.charAt(Math.floor(rand() * alphabet.length));
  return out;
}

const join = (...parts: string[]): string => parts.join("");
const dashes = "-".repeat(5);

/** One generator per shape the scrubbers know, each with the token it must become. */
function samples(rand: () => number): { name: string; value: string; token: string }[] {
  const b64json = (obj: unknown): string => btoa(JSON.stringify(obj));
  return [
    {
      name: "private key",
      value: join(
        dashes,
        "BEGIN ",
        "PRIVATE KEY",
        dashes,
        "\n",
        pick(rand, B64, 64),
        "\n",
        dashes,
        "END ",
        "PRIVATE KEY",
        dashes,
      ),
      token: "[private-key]",
    },
    {
      name: "age identity",
      value: join(["AGE", "SECRET", "KEY", "1"].join("-"), pick(rand, UPPER, 58)),
      token: "[private-key]",
    },
    {
      name: "Fin API key",
      value: join(
        ["fin", "live", "sk"].join("_"),
        "_",
        pick(rand, UPPER, 10),
        pick(rand, MIXED, 38),
      ),
      token: "[api-key]",
    },
    { name: "webhook secret", value: join("wh", "sec_", pick(rand, B64, 32)), token: "[secret]" },
    {
      name: "Cloudflare token",
      value: join("cf", "at_", pick(rand, B64URL, 40)),
      token: "[token]",
    },
    {
      name: "JWT (Access token)",
      value: join(
        btoa('{"alg":"RS256","kid":"k1"}').replace(/=+$/, ""),
        ".",
        pick(rand, B64URL, 80),
        ".",
        pick(rand, B64URL, 86),
      ),
      token: "[token]",
    },
    {
      name: "tunnel token (base64 JSON with + and /)",
      value: b64json({ a: pick(rand, "0123456789abcdef", 32), t: "+/+/", s: pick(rand, B64, 44) }),
      token: "[token]",
    },
    {
      name: "heartbeat URL",
      value: join(
        "https://uptime.",
        "better",
        "stack.com/api/v1/heartbeat/",
        pick(rand, MIXED, 24),
      ),
      token: "[heartbeat-url]",
    },
    {
      name: "incoming webhook URL",
      value: join(
        "https://uptime.",
        "better",
        "stack.com/api/v1/incoming-webhook/",
        pick(rand, MIXED, 24),
      ),
      token: "[heartbeat-url]",
    },
    {
      name: "DSN",
      value: join("https://", pick(rand, MIXED, 24), "@", "s1.eu.example.net", "/", "4242"),
      token: "[dsn]",
    },
    {
      name: "Postgres URL with a password",
      value: join("postgres", "://fin_api_a:", pick(rand, MIXED, 24), "@db.example.net:5432/fin"),
      token: "postgres://[login]:[secret]@db.example.net:5432/fin",
    },
    {
      name: "bearer",
      value: join("Bea", "rer ", pick(rand, B64URL, 40)),
      token: "Bearer [secret]",
    },
    {
      name: "basic",
      value: join("Bas", "ic ", pick(rand, B64, 24), "=="),
      token: "Basic [secret]",
    },
    {
      name: "__Host- cookie",
      value: join("__Host-fin.session_token=", pick(rand, B64URL, 40)),
      token: "[cookie]",
    },
    {
      name: "__Secure- cookie",
      value: join("__Secure-x=", pick(rand, B64URL, 20)),
      token: "[cookie]",
    },
    {
      name: "Access cookie",
      value: join("CF_Author", "ization=", pick(rand, B64URL, 40)),
      token: "[cookie]",
    },
    {
      name: "ingress proof header",
      value: join("Fin-Ingress-Proof: ", pick(rand, B64URL, 43)),
      token: "Fin-Ingress-Proof: [secret]",
    },
    { name: "email", value: "someone.else+tag@example.com", token: "[email]" },
    { name: "IPv4", value: "203.0.113.7", token: "[ip]" },
    { name: "private IPv4", value: ["10", "1", "2", "3"].join("."), token: "[ip]" },
    { name: "IPv6 full", value: "2001:0db8:85a3:0000:0000:8a2e:0370:7334", token: "[ip]" },
    { name: "IPv6 compressed", value: "2001:db8::42", token: "[ip]" },
    { name: "IPv6 loopback", value: "::1", token: "[ip]" },
    { name: "IPv6 with zone", value: "fe80::1%en0", token: "[ip]" },
    {
      name: "Railway private IPv6",
      value: [["fd", "12"].join(""), "", "1"].join(":"),
      token: "[ip]",
    },
    { name: "query string", value: "/v4/customers?email=x&page=2", token: "/v4/customers?[query]" },
    {
      name: "hosted-link path",
      value: join("/c/", pick(rand, B64URL, 20)),
      token: "/c/[segment]",
    },
    {
      name: "ID-bearing path",
      value: join("/v4/customers/cus_01", pick(rand, "0123456789abcdefghjkmnpqrstvwxyz", 24)),
      token: "/v4/customers/[segment]",
    },
    {
      name: "token-bearing path",
      value: join("/invite/", pick(rand, "abcdef", 10), "9", pick(rand, B64URL, 30)),
      token: "/invite/[segment]",
    },
    { name: "long digits", value: "4111111111111111", token: "[digits]" },
    { name: "code beside code", value: "code: 123456", token: "code [code]" },
    { name: "code beside otp", value: "otp=12345678", token: "otp [code]" },
    { name: "code beside pin", value: "PIN 1234567", token: "PIN [code]" },
  ];
}

describe("scrubText", () => {
  for (const sample of samples(prng(1))) {
    it(`removes a ${sample.name}`, () => {
      const out = scrubText(`before ${sample.value} after`);
      expect(out).toBe(`before ${sample.token} after`);
      expect(hasPersonalShape(sample.value)).toBe(true);
    });
  }

  it("keeps what is not a shape", () => {
    for (const keep of [
      "2026-11-21T09:48:23.123Z",
      "/passkey/generate-authenticate-options",
      "/api/auth/two-factor/generate-backup-codes",
      "/v4/customers/:id",
      "req_01jd2k3m4n5p6q7r8s9t0v1w2x",
      "origin_gate.app_header",
      "cloudflared 2026.11.1",
      "aa:bb:cc:dd:ee:ff",
      "12:30:45",
      "code 12345",
      "text with no secret",
    ]) {
      expect(scrubText(keep)).toBe(keep);
      expect(hasPersonalShape(keep)).toBe(false);
    }
  });

  it("removes an IPv4-mapped IPv6 address without leaving its octets", () => {
    const out = scrubText("peer ::ffff:203.0.113.9 refused");
    expect(out).not.toMatch(/\d{1,3}\.\d{1,3}/);
    expect(out).toContain("[ip]");
  });

  it("is idempotent", () => {
    for (const sample of samples(prng(2))) {
      const once = scrubText(sample.value);
      expect(scrubText(once)).toBe(once);
    }
  });
});

describe("scrubLine", () => {
  it("withholds every listed field name at any depth, in any case and with _ or -", () => {
    for (const name of WITHHELD_FIELDS) {
      const variants = [name, name.toUpperCase(), `${name.slice(0, 1)}_${name.slice(1)}`];
      for (const key of variants) {
        const line = scrubLine({ event: "request", outer: { inner: [{ [key]: "anything" }] } });
        expect(line.outer).toEqual({ inner: [{ [key]: WITHHELD }] });
        expect(scrubLine({ event: "x", [key]: { deep: 1 } })[key]).toBe(WITHHELD);
      }
    }
  });

  it("keeps keys that end in Id", () => {
    const line = scrubLine({ event: "request", keyId: "abc", orgId: "org_1", code_id: "x" });
    expect(line).toEqual({ event: "request", keyId: "abc", orgId: "org_1", code_id: "x" });
  });

  it("keeps message when it equals event, and withholds any other message", () => {
    expect(scrubLine({ event: "request", message: "request" }).message).toBe("request");
    expect(scrubLine({ event: "request", message: "free text" }).message).toBe(WITHHELD);
  });

  it("never scrubs numbers", () => {
    const line = scrubLine({ event: "x", durationMs: 12345678901, amount: 4111111111111111 });
    expect(line.durationMs).toBe(12345678901);
    expect(line.amount).toBe(4111111111111111);
  });

  it("survives cycles and deep nesting", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const line = scrubLine({ event: "x", cyclic, deep });
    expect((line.cyclic as Record<string, unknown>).self).toBe("[cycle]");
    expect(JSON.stringify(line)).toContain("[depth]");
  });

  it("finds no planted shape in random lines and nested objects (property test)", () => {
    const rand = prng(20261121);
    const keys = ["route", "reason", "detail_text", "items", "note_list", "context", "status"];
    for (let round = 0; round < 300; round++) {
      const planted = samples(rand);
      const secrets: string[] = [];
      const build = (depth: number): unknown => {
        const kind = Math.floor(rand() * 4);
        if (depth > 3 || kind === 0) {
          const sample = planted[Math.floor(rand() * planted.length)];
          if (sample === undefined) return "";
          secrets.push(sample.value);
          return `${pick(rand, "abc ", 5)} ${sample.value} ${pick(rand, "xyz ", 5)}`;
        }
        if (kind === 1) return [build(depth + 1), build(depth + 1)];
        if (kind === 2) return rand() * 1000;
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < 3; i++) {
          obj[keys[Math.floor(rand() * keys.length)] ?? "k"] = build(depth + 1);
        }
        return obj;
      };
      const line = { event: "request", payload: build(0), text: build(0) };
      const scrubbed = JSON.stringify(scrubLine(line));
      for (const secret of secrets) {
        const core = secret.replace(/^[^A-Za-z0-9]+/, "");
        if (core.length < 6) continue;
        expect(scrubbed.includes(core), `round ${round} leaked a planted value`).toBe(false);
      }
    }
  });
});

describe("scrubEvent and scrubBreadcrumb", () => {
  const event = {
    event_id: "0123abcd",
    release: "a".repeat(40),
    environment: "staging",
    tags: { requestId: "req_01jd2k3m4n5p6q7r8s9t0v1w2x", fin_fixed_message: "false" },
    exception: {
      values: [
        {
          type: "TypeError",
          value: "cannot read someone@example.com",
          mechanism: { type: "generic", handled: true, data: { x: 1 } },
          stacktrace: {
            frames: [
              {
                filename: "/app/dist/main.js",
                lineno: 10,
                colno: 3,
                function: "handle",
                vars: { a: 1 },
              },
            ],
          },
        },
      ],
    },
    request: { cookies: { a: "b" }, headers: { cookie: "x" }, query_string: "a=b", data: "{}" },
    user: { email: "someone@example.com", ip_address: "203.0.113.4" },
    extra: { anything: true },
    server_name: "host-1",
    contexts: {
      device: { model: "x" },
      os: { name: "Linux", version: "6.1", kernel_version: "x" },
      runtime: { name: "node", version: "v26.13.1" },
    },
    breadcrumbs: [
      { category: "console", message: "someone@example.com" },
      { category: "navigation", data: { from: "/c/abcdefghijklmnopqrstu?x=1", to: "/settings" } },
    ],
  };

  it("drops request, user, extra, server_name, the device and most of the OS context", () => {
    const out = scrubEvent(event) as Record<string, unknown>;
    for (const key of ["request", "user", "extra", "server_name"]) expect(out[key]).toBeUndefined();
    expect(out.contexts).toEqual({
      os: { name: "Linux" },
      runtime: { name: "node", version: "v26.13.1" },
    });
  });

  it("keeps the type, the frames and the ID tags, and withholds a message unless it is Fin's", () => {
    const out = scrubEvent(event) as {
      exception: { values: Record<string, unknown>[] };
      tags: unknown;
    };
    const value = out.exception.values[0];
    expect(value?.type).toBe("TypeError");
    expect(value?.value).toBe(WITHHELD);
    expect(value?.stacktrace).toEqual({
      frames: [{ filename: "/app/dist/main.js", lineno: 10, colno: 3, function: "handle" }],
    });
    expect(out.tags).toEqual(event.tags);
    const fixed = scrubEvent({ ...event, tags: { fin_fixed_message: "true" } }) as typeof out;
    expect(fixed.exception.values[0]?.value).toBe("cannot read [email]");
  });

  it("keeps only navigation breadcrumbs, with no query or token", () => {
    const out = scrubEvent(event) as { breadcrumbs: unknown[] };
    expect(out.breadcrumbs).toEqual([
      { category: "navigation", data: { from: "/c/[segment]", to: "/settings" } },
    ]);
    expect(scrubBreadcrumb({ category: "fetch", data: { url: "/x" } })).toBeNull();
  });
});

describe("assertNoPersonalShapes", () => {
  it("passes IDs and codes and refuses shapes and withheld fields", () => {
    expect(() =>
      assertNoPersonalShapes({ orgId: "org_1", reason: "policy.blocked", n: 3 }),
    ).not.toThrow();
    expect(() => assertNoPersonalShapes({ note: "someone@example.com" })).toThrow();
    expect(() => assertNoPersonalShapes({ list: ["fine", "203.0.113.1"] })).toThrow();
    expect(() => assertNoPersonalShapes({ email: "x" })).toThrow();
  });
});
