// The browser's scrub shapes (spec 08 §5.4, every row; spec 06 §2.3 step 1): one case per row, the
// strings no row may touch, and the runs that would make a pattern slow. The cases are @fin/core's
// (P0-D) for the same rows, so this table keeps passing once the guard imports `@fin/core/scrub`
// instead of its copy. Every secret-shaped value is built at run time, so the public-safety check
// never sees one in the file.
import { describe, expect, it } from "vitest";
import { SHAPES, scrubText } from "../src/report/scrub.ts";

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
const HEX = "0123456789abcdefABCDEF";

function pick(rand: () => number, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet.charAt(Math.floor(rand() * alphabet.length));
  return out;
}

const join = (...parts: string[]): string => parts.join("");
const dashes = "-".repeat(5);

/** A random IPv6 address: eight groups, or a `::` form keeping at least two of them. */
function ipv6(rand: () => number): string {
  const groups = Array.from({ length: 8 }, () => pick(rand, HEX, 1 + Math.floor(rand() * 4)));
  if (rand() < 0.4) return groups.join(":");
  const dropped = 1 + Math.floor(rand() * 6);
  const start = Math.floor(rand() * (8 - dropped + 1));
  return `${groups.slice(0, start).join(":")}::${groups.slice(start + dropped).join(":")}`;
}

interface Sample {
  /** The shape's name in SHAPES. */
  shape: string;
  name: string;
  value: string;
  token: string;
}

/** One sample or more per row, each with the token it must become. */
function samples(rand: () => number): Sample[] {
  const b64json = (value: unknown): string => btoa(JSON.stringify(value));
  return [
    {
      shape: "private-key",
      name: "private key block",
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
      shape: "age-identity",
      name: "age identity",
      value: join(["AGE", "SECRET", "KEY", "1"].join("-"), pick(rand, UPPER, 58)),
      token: "[private-key]",
    },
    {
      shape: "fin-api-key",
      name: "Fin API key",
      value: join(
        ["fin", "live", "sk"].join("_"),
        "_",
        pick(rand, UPPER, 10),
        pick(rand, MIXED, 38),
      ),
      token: "[api-key]",
    },
    {
      shape: "fin-key-like",
      name: "malformed Fin key",
      value: join(["fin", "test"].join("_"), "_", pick(rand, MIXED, 20)),
      token: "[api-key]",
    },
    {
      shape: "webhook-secret",
      name: "webhook secret",
      value: join("wh", "sec_", pick(rand, B64, 32)),
      token: "[secret]",
    },
    {
      shape: "cloudflare-token",
      name: "Cloudflare token",
      value: join("cf", "at_", pick(rand, B64URL, 40)),
      token: "[token]",
    },
    {
      shape: "jwt-or-tunnel-token",
      name: "JWT",
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
      shape: "jwt-or-tunnel-token",
      name: "tunnel token (base64 JSON with + and /)",
      value: b64json({ a: pick(rand, "0123456789abcdef", 32), t: "+/+/", s: pick(rand, B64, 44) }),
      token: "[token]",
    },
    {
      shape: "heartbeat-url",
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
      shape: "dsn",
      name: "DSN (the relay's placeholder among them)",
      value: join("https://", pick(rand, MIXED, 24), "@", "relay.example.net", "/", "4242"),
      token: "[dsn]",
    },
    {
      shape: "postgres-url",
      name: "Postgres URL with a password",
      value: join("postgres", "://fin_api_a:", pick(rand, MIXED, 24), "@db.example.net:5432/fin"),
      token: "postgres://[login]:[secret]@db.example.net:5432/fin",
    },
    {
      shape: "bearer",
      name: "bearer",
      value: join("Bea", "rer ", pick(rand, B64URL, 40)),
      token: "Bearer [secret]",
    },
    {
      shape: "basic-auth",
      name: "basic",
      value: join("Bas", "ic ", pick(rand, B64, 24), "=="),
      token: "Basic [secret]",
    },
    {
      shape: "cookie",
      name: "__Host- cookie",
      value: join("__Host-fin.session_token=", pick(rand, B64URL, 40)),
      token: "[cookie]",
    },
    {
      shape: "access-cookie",
      name: "Access cookie",
      value: join("CF_Author", "ization=", pick(rand, B64URL, 40)),
      token: "[cookie]",
    },
    {
      shape: "ingress-proof",
      name: "ingress proof header",
      value: join("Fin-Ingress-Proof: ", pick(rand, B64URL, 43)),
      token: "Fin-Ingress-Proof: [secret]",
    },
    {
      shape: "email",
      name: "email",
      value: ["someone.else+tag", "example.com"].join("@"),
      token: "[email]",
    },
    { shape: "ipv4", name: "IPv4", value: "203.0.113.7", token: "[ip]" },
    {
      shape: "ipv6",
      name: "IPv6 full",
      value: "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      token: "[ip]",
    },
    {
      shape: "ipv6",
      name: "IPv6 compressed",
      value: "2001:db8:85a3::8a2e:370:7334",
      token: "[ip]",
    },
    { shape: "ipv6", name: "IPv6 short", value: "2001:db8::1", token: "[ip]" },
    { shape: "ipv6", name: "IPv6 loopback", value: "::1", token: "[ip]" },
    { shape: "ipv6", name: "IPv6 with zone", value: "fe80::1%en0", token: "[ip]" },
    { shape: "ipv6", name: "random IPv6", value: ipv6(rand), token: "[ip]" },
    {
      shape: "query-string",
      name: "query string",
      value: "/api/invitation?token=x&page=2",
      token: "/api/invitation?[query]",
    },
    {
      shape: "id-path",
      name: "hosted-link path",
      value: join("/c/", pick(rand, B64URL, 20)),
      token: "/c/[segment]",
    },
    {
      shape: "long-segment",
      name: "ID-bearing path",
      value: join("/customers/cus_01", pick(rand, "0123456789abcdefghjkmnpqrstvwxyz", 24)),
      token: "/customers/[segment]",
    },
    {
      shape: "long-segment",
      name: "token-bearing path",
      value: join("/invite/", pick(rand, "abcdef", 10), "9", pick(rand, B64URL, 30)),
      token: "/invite/[segment]",
    },
    { shape: "digits", name: "account number", value: "123456789012", token: "[digits]" },
    { shape: "digits", name: "phone number", value: "447700900123", token: "[digits]" },
    { shape: "code", name: "code beside code", value: "code: 123456", token: "code [code]" },
    { shape: "code", name: "code beside otp", value: "otp=12345678", token: "otp [code]" },
    { shape: "code", name: "code beside PIN", value: "PIN 1234567", token: "PIN [code]" },
  ];
}

const cases = (seed: number): Sample[] => samples(prng(seed));

describe("the browser's scrub shapes (spec 08 §5.4)", () => {
  it("hold every row of spec 08 §5.4, in @fin/core's order, each with the g and u flags", () => {
    expect(SHAPES.map((shape) => shape.name)).toEqual([
      "private-key",
      "age-identity",
      "fin-api-key",
      "fin-key-like",
      "webhook-secret",
      "cloudflare-token",
      "jwt-or-tunnel-token",
      "heartbeat-url",
      "dsn",
      "postgres-url",
      "bearer",
      "basic-auth",
      "cookie",
      "access-cookie",
      "ingress-proof",
      "email",
      "ipv4",
      "ipv6",
      "query-string",
      "id-path",
      "long-segment",
      "digits",
      "code",
    ]);
    for (const shape of SHAPES) {
      expect(shape.pattern.flags, shape.name).toContain("g");
      expect(shape.pattern.flags, shape.name).toContain("u");
    }
    // The rows spec 08 marks (i).
    for (const name of ["bearer", "ingress-proof", "code"]) {
      expect(SHAPES.find((shape) => shape.name === name)?.pattern.flags, name).toContain("i");
    }
  });

  it("have a case in this table for every shape", () => {
    const covered = new Set(cases(1).map((sample) => sample.shape));
    expect([...covered].sort()).toEqual(SHAPES.map((shape) => shape.name).sort());
  });

  for (const sample of cases(1)) {
    it(`remove a ${sample.name}`, () => {
      expect(scrubText(`before ${sample.value} after`)).toBe(`before ${sample.token} after`);
    });
  }

  it("keep what is not a shape", () => {
    for (const keep of [
      "2026-11-21T09:48:23.123Z",
      "at 09:48:23.123",
      "12:30:45",
      "ratio 16:9",
      "std::vector",
      "Foo::Bar",
      "aa:bb:cc:dd:ee:ff",
      "/passkey/generate-authenticate-options",
      "/api/auth/two-factor/generate-backup-codes",
      "/customers/$id",
      "req_01jd2k3m4n5p6q7r8s9t0v1w2x",
      "code 12345",
      "12345678",
      "Sandbox · Team · Fin",
      "text with no secret",
    ]) {
      expect(scrubText(keep), keep).toBe(keep);
    }
  });

  it("remove an IPv6 address beside a colon, a port or a bracket", () => {
    const full = ["2001", "db8", "5e1b", "a600", "6d0a", "1c2e", "8e54", "2f11"].join(":");
    for (const [text, expected] of [
      [`ip:${full} x`, "ip:[ip] x"],
      ["client:2001:db8:3::5", "client:[ip]"],
      [`connect ETIMEDOUT ${full}:443`, "connect ETIMEDOUT [ip]"],
      ["addr 2001:db8::1: reset", "addr [ip]: reset"],
      ["[2001:db8::1]:8080", "[[ip]]:8080"],
      ["(2001:db8::1)", "([ip])"],
    ] as const) {
      expect(scrubText(text), text).toBe(expected);
    }
    expect(scrubText("peer ::ffff:203.0.113.9 refused")).not.toMatch(/\d{1,3}\.\d{1,3}/);
  });

  it("scrub 256 KB of any adversarial run in linear time", () => {
    const size = 256 * 1024;
    for (const run of [
      "a".repeat(size),
      "a.".repeat(size / 2),
      "0123456789abcdef".repeat(size / 16),
      "a:".repeat(size / 2),
      "a::".repeat(size / 3),
      "eyJ".repeat(size / 3),
      "/".repeat(size),
      `/${"A1".repeat(size / 2)}`,
      "@a".repeat(size / 2),
      "1".repeat(size),
      "https://".repeat(size / 8),
      "?".repeat(size),
    ]) {
      const started = performance.now();
      scrubText(run);
      // A quadratic pattern takes seconds here; a linear one, a few milliseconds.
      expect(performance.now() - started, run.slice(0, 12)).toBeLessThan(1000);
    }
  });

  it("are idempotent", () => {
    for (const sample of cases(2)) {
      const once = scrubText(sample.value);
      expect(scrubText(once), sample.name).toBe(once);
    }
  });
});
