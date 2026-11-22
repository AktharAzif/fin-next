// The browser's scrub shapes (spec 08 §5.4, every row; spec 06 §2.3 step 1), then its own rows: one
// case per row, the strings no row may touch, and the runs that would make a pattern slow. The
// cases are @fin/core's (P0-D) for the same rows, so this table keeps passing once the guard imports
// `@fin/core/scrub` instead of its copy (with the email and query rows' changes that @fin/core
// still needs).
// Every secret-shaped value is built at run time, so the public-safety check never sees one in the
// file.
import { describe, expect, it } from "vitest";
import { BROWSER_SHAPES, SHAPES, scrubText } from "../src/report/scrub.ts";

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
/** Crockford's base32, a hosted link's token alphabet (spec 03 §2.5). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function pick(rand: () => number, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet.charAt(Math.floor(rand() * alphabet.length));
  return out;
}

const join = (...parts: string[]): string => parts.join("");
const dashes = "-".repeat(5);

// A linear-time check judges two things and fails only when both say quadratic: the time at 1 MB,
// and its growth from 128 KB, eight times less input. A quadratic part takes seconds or minutes at
// 1 MB and grows about 64 times, so it fails both. Each time is the fastest of three runs, the
// sizes taking turns, and it is the thread's CPU time, not the clock on the wall: what load adds
// is time spent waiting for a core, and it adds it unevenly: a linear shape's wall time at 1 MB
// went over a second inside a loaded `pnpm check`, while it takes under 100 ms alone and its CPU
// time grows about 8 to 9 times from 128 KB.
const SMALL_INPUT = 128 * 1024;
const LARGE_INPUT = 1024 * 1024;
/** The CPU time at 1 MB a linear shape stays far under: the slowest takes under 60 ms. */
const LIMIT_MS = 1000;
/**
 * Growth from 128 KB to 1 MB: about 8 times for a linear shape, about 64 for a quadratic one. 24
 * sits near their geometric mean (about 23), about a factor of three from each.
 */
const MAX_GROWTH = 24;
/** A floor under the 128 KB time, so a reading near clock resolution cannot inflate the growth. */
const FLOOR_MS = 5;

/** The CPU time this thread has used, in milliseconds. */
function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/** Fails when `scrub` is quadratic on the input `build` makes at 128 KB and at 1 MB. */
function expectLinearTime(
  name: string,
  build: (size: number) => string,
  scrub: (text: string) => unknown,
): void {
  const time = (text: string): number => {
    const t0 = threadCpuMs();
    scrub(text);
    return threadCpuMs() - t0;
  };
  const large = build(LARGE_INPUT);
  let largeMs = time(large);
  // The fastest of three runs can only be faster than the first, so a first run at 1 MB within
  // the limit already passes, and a linear shape is scrubbed once: six runs of every shape took
  // the file from about 20 s to 45 s inside a loaded `pnpm check`.
  if (largeMs <= LIMIT_MS) return;
  const small = build(SMALL_INPUT);
  let smallMs = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    smallMs = Math.min(smallMs, time(small));
    if (run > 0) largeMs = Math.min(largeMs, time(large));
  }
  const growth = largeMs / Math.max(smallMs, FLOOR_MS);
  const ms = (value: number): string => `${value.toFixed(1)} ms of CPU`;
  const seen = `${ms(smallMs)} at 128 KB, ${ms(largeMs)} at 1 MB, growth ${growth.toFixed(1)}`;
  expect(largeMs > LIMIT_MS && growth > MAX_GROWTH, `${name}: ${seen}`).toBe(false);
}

/** Builds an adversarial input: the unit repeated to the input's size, then the tail. */
type Fill = (unit: string, tail?: string) => string;

/** The Fill for inputs of `size` characters. */
const filler =
  (size: number): Fill =>
  (unit, tail = "") =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size) + tail;

/** A random IPv6 address: eight groups, or a `::` form keeping at least two of them. */
function ipv6(rand: () => number): string {
  const groups = Array.from({ length: 8 }, () => pick(rand, HEX, 1 + Math.floor(rand() * 4)));
  if (rand() < 0.4) return groups.join(":");
  const dropped = 1 + Math.floor(rand() * 6);
  const start = Math.floor(rand() * (8 - dropped + 1));
  return `${groups.slice(0, start).join(":")}::${groups.slice(start + dropped).join(":")}`;
}

interface Sample {
  /** The shape's name in SHAPES or BROWSER_SHAPES. */
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
      shape: "heartbeat-url",
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
      shape: "cookie",
      name: "__Secure- cookie",
      value: join("__Secure-x=", pick(rand, B64URL, 20)),
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
    // The browser's own row: the fragment, where Fin's links carry their tokens and codes.
    {
      shape: "fragment",
      name: "invitation link's token (spec 02 §9.3)",
      value: join("https://console.example.com/invite#t=", pick(rand, B64URL, 43)),
      token: "https://console.example.com/invite#[fragment]",
    },
    {
      shape: "fragment",
      name: "hosted link's token (spec 03 §2.5)",
      value: join("https://verify.example.com/c#", pick(rand, CROCKFORD, 32)),
      token: "https://verify.example.com/c#[fragment]",
    },
    {
      shape: "fragment",
      name: "selfie hand-over ticket (spec 03 §2.5)",
      value: join(
        "https://selfie.example.com/s#sft_",
        pick(rand, CROCKFORD.toLowerCase(), 26),
        ".",
        pick(rand, B64URL, 43),
      ),
      token: "https://selfie.example.com/s#[fragment]",
    },
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

  it("then the browser's own row, the fragment, which no server ever receives", () => {
    expect(BROWSER_SHAPES.map((shape) => shape.name)).toEqual(["fragment"]);
    for (const shape of BROWSER_SHAPES) {
      expect(shape.pattern.flags, shape.name).toContain("g");
      expect(shape.pattern.flags, shape.name).toContain("u");
    }
  });

  it("have a case in this table for every shape", () => {
    const covered = new Set(cases(1).map((sample) => sample.shape));
    expect([...covered].sort()).toEqual(
      [...SHAPES, ...BROWSER_SHAPES].map((shape) => shape.name).sort(),
    );
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
      "/v4/customers/:id",
      "req_01jd2k3m4n5p6q7r8s9t0v1w2x",
      "origin_gate.app_header",
      "cloudflared 2026.11.1",
      "code 12345",
      "12345678",
      "Sandbox · Team · Fin",
      "text with no secret",
      // A short fragment with no `=`: an element's ID, an issue number, a colour.
      "#root",
      "see #main-content",
      "issue #42",
      "color #1e293b",
      "/settings#team",
    ]) {
      expect(scrubText(keep), keep).toBe(keep);
    }
  });

  it("remove every address the table's row removes, the second of two run together among them", () => {
    const first = ["alice", "example.com"].join("@");
    const second = ["bob", "example.org"].join("@");
    for (const joiner of ["%2C", "%20", "%3B", "+", "-", "_", ", ", " "]) {
      const text = `mailto:${first}${joiner}${second}`;
      const expected = `mailto:[email]${joiner.replace(/^[%+_-]\S*$/u, "")}[email]`;
      expect(scrubText(text), text).toBe(expected);
      expect(scrubText(`Invite failed for ${text}`), text).not.toMatch(/alice|bob/u);
    }
    for (const [text, expected] of [
      [`x@y@${first}`, "x@y@[email]"],
      [`@${first}`, "@[email]"],
      [`a@b@${second}`, "a@b@[email]"],
      [`${first}@x`, "[email]@x"],
    ] as const) {
      expect(scrubText(text), text).toBe(expected);
    }
  });

  it("remove exactly what the table's email row removes, wherever addresses run together (property test)", () => {
    // The table's row as written. Pieces of address text and of what stands between addresses, with
    // no digit, colon, slash, `#` or `?`, so no other row can match: the scrub is then that row.
    const tableRow = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
    const pieces = [
      "a",
      "bo",
      "X",
      ".",
      "%",
      "+",
      "-",
      "_",
      "@",
      "ab.co",
      "@ab.co",
      "y.z",
      " ",
      ",",
    ];
    const rand = prng(3);
    for (let i = 0; i < 3000; i++) {
      const length = 1 + Math.floor(rand() * 16);
      const text = Array.from(
        { length },
        () => pieces[Math.floor(rand() * pieces.length)] ?? "",
      ).join("");
      expect(scrubText(text), text).toBe(text.replace(tableRow, "[email]"));
    }
  });

  it("remove a link's token or code from a URL's fragment, after a query string too", () => {
    const rand = prng(4);
    const token = pick(rand, B64URL, 43);
    const link = pick(rand, CROCKFORD, 32);
    const address = ["maya.rivera", "example.com"].join("@");
    for (const [text, expected] of [
      [
        `navigating to https://console.example.com/invite#t=${token}`,
        "navigating to https://console.example.com/invite#[fragment]",
      ],
      [
        `https://verify.example.com/p#${link} opened`,
        "https://verify.example.com/p#[fragment] opened",
      ],
      [`"/a#${link}"`, `"/a#[fragment]"`],
      [`/sign-in/code#e=${address}&c=12345678`, "/sign-in/code#[fragment]"],
      [`/sign-in/code#e=${encodeURIComponent(address)}&c=12345678`, "/sign-in/code#[fragment]"],
      [`/invite?from=mail#t=${token}`, "/invite?[query]#[fragment]"],
      [
        `https://verify.example.com/c?x=1#${link}`,
        "https://verify.example.com/c?[query]#[fragment]",
      ],
      // A code beside its key, however short.
      ["/verify-email#c=12345678", "/verify-email#[fragment]"],
      // The code row leaves `word [code]`, with a space, inside a fragment that holds a code word
      // and digits (an address with a birth date, or a code key): the rest goes too (R-17).
      [
        `https://console.example.com/sign-in/code#e=${encodeURIComponent(["crispin.19850412", "example.com"].join("@"))}&c=87654321`,
        "https://console.example.com/sign-in/code#[fragment]",
      ],
      [`/invite#otp=123456&t=${token}`, "/invite#[fragment]"],
      [`/a#pin-123456&b=code:1234567&t=${token}`, "/a#[fragment]"],
    ] as const) {
      expect(scrubText(text), text).toBe(expected);
    }
  });

  it("remove a fragment whole, whatever characters a fragment may hold", () => {
    const rand = prng(6);
    const token = pick(rand, B64URL, 43);
    const apostrophe = ["o'brien", "example.com"].join("@");
    const parenthesis = ["maya(work)", "example.com"].join("@");
    const accented = ["josé", "example.com"].join("@");
    for (const [text, expected] of [
      // RFC 3986's sub-delims `'`, `(` and `)`, which encodeURIComponent never escapes.
      [`/sign-in/code#e=${encodeURIComponent(apostrophe)}&c=12345678`, "/sign-in/code#[fragment]"],
      [`/sign-in/code#e=${apostrophe}&c=12345678`, "/sign-in/code#[fragment]"],
      [`/sign-in/code#e=${encodeURIComponent(parenthesis)}&c=12345678`, "/sign-in/code#[fragment]"],
      [`/sign-in/code#e=${parenthesis}&c=12345678`, "/sign-in/code#[fragment]"],
      ["#t=(token)", "#[fragment]"],
      // What the URL Standard leaves raw in a fragment besides them, a second `#` among them.
      [`/invite#t={${token}}|^\\`, "/invite#[fragment]"],
      [`/invite#t=a#${token}`, "/invite#[fragment]"],
      // A decoded fragment, or one built by hand, can hold any letter.
      [`/sign-in/code#e=${accented}&c=12345678`, "/sign-in/code#[fragment]"],
      // A closing quote or bracket right after a fragment goes with it; whitespace, `"`, `<`, `>`
      // and a backtick end it, as the URL Standard never leaves them raw in one.
      [`see ('/invite#t=${token}') now`, "see ('/invite#[fragment] now"],
      [`<a href="/invite#t=${token}">`, `<a href="/invite#[fragment]">`],
      [`\`/invite#t=${token}\``, "`/invite#[fragment]`"],
    ] as const) {
      expect(scrubText(text), text).toBe(expected);
    }
  });

  it("remove a fragment whole whichever character it holds, as a page's URL prints it", () => {
    // Every printable ASCII character and a space, a letter beyond ASCII and an emoji, each in a
    // sign-in link's address: as the URL parser leaves it in an href, and as encodeURIComponent
    // leaves it in a link built by hand.
    const characters = [
      ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)),
      "é",
      "\u{1f600}",
    ];
    for (const character of characters) {
      const address = [`a${character}b`, "example.com"].join("@");
      const parsed = new URL(`https://console.example.com/sign-in/code#e=${address}&c=12345678`);
      expect(scrubText(parsed.href), parsed.href).toBe(
        "https://console.example.com/sign-in/code#[fragment]",
      );
      const built = `/sign-in/code#e=${encodeURIComponent(address)}&c=12345678`;
      expect(scrubText(built), built).toBe("/sign-in/code#[fragment]");
      // A local part the code row reads as a code beside its word.
      const coded = [`pin-${character}123456`, "example.com"].join("@");
      const href = new URL(`https://console.example.com/sign-in/code#e=${coded}&c=12345678`).href;
      expect(scrubText(href), href).toBe("https://console.example.com/sign-in/code#[fragment]");
      const encoded = `/sign-in/code#e=${encodeURIComponent(coded)}&c=12345678`;
      expect(scrubText(encoded), encoded).toBe("/sign-in/code#[fragment]");
    }
  });

  it("remove a query string whole, whatever characters encodeURIComponent leaves in it", () => {
    const rand = prng(7);
    const token = pick(rand, B64URL, 43);
    const apostrophe = ["o'brien", "example.com"].join("@");
    for (const [text, expected] of [
      [`/verify?email=${encodeURIComponent(apostrophe)}&token=${token}`, "/verify?[query]"],
      [`/sign-in?e=${encodeURIComponent(apostrophe)}&c=12345678 sent`, "/sign-in?[query] sent"],
      [`/invite?from=o'brien#t=${token}`, "/invite?[query]#[fragment]"],
      // A closing single quote goes with the query; a double quote or `#` ends it.
      [`fetch('/x?e=1') failed`, "fetch('/x?[query] failed"],
      [`"/x?e=1"`, `"/x?[query]"`],
    ] as const) {
      expect(scrubText(text), text).toBe(expected);
    }
    for (const code of [...Array.from({ length: 0x7f - 0x21 }, (_, i) => 0x21 + i), 0xe9]) {
      const value = encodeURIComponent(`a${String.fromCharCode(code)}b`);
      const text = `/verify?e=${value}&token=${token}`;
      expect(scrubText(text), text).toBe("/verify?[query]");
    }
  });

  it("remove an address with an apostrophe in its local part whole, quotes around it kept", () => {
    const address = (local: string, domain = "example.com"): string => [local, domain].join("@");
    for (const [text, expected] of [
      [address("o'brien"), "[email]"],
      [address("mary.o'brien"), "[email]"],
      [`${address("O'Brien")}, ${address("d'arcy", "example.org")}`, "[email], [email]"],
      [`${address("ann")}'${address("o'neil")}`, "[email]'[email]"],
      [`'${address("alice")}'`, "'[email]'"],
      [`name='${address("o'brien")}'`, "name='[email]'"],
      [`''${address("x'y")}`, "''[email]"],
      [address("o'"), "[email]"],
      // An `@` with only quotes before it has no local part, as the table's row reads it.
      [address("'"), address("'")],
      [`it's ${address("bob")}`, "it's [email]"],
    ] as const) {
      expect(scrubText(text), text).toBe(expected);
    }
  });

  it("remove what the table's email row removes and an apostrophe inside a local part (property test)", () => {
    // The table's row, its local part also holding an apostrophe after its first character: the
    // part before an apostrophe (a first name, an initial) is the address's too.
    const row = /[A-Za-z0-9._%+-][A-Za-z0-9._%+'-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
    const pieces = ["a", "bo", ".", "+", "-", "@", "'", "''", "ab.co", "@ab.co", "'@ab.co", " "];
    const rand = prng(8);
    for (let i = 0; i < 3000; i++) {
      const length = 1 + Math.floor(rand() * 16);
      const text = Array.from(
        { length },
        () => pieces[Math.floor(rand() * pieces.length)] ?? "",
      ).join("");
      expect(scrubText(text), text).toBe(text.replace(row, "[email]"));
    }
  });

  it("remove a private key cut short, which has no END line", () => {
    const begin = join(dashes, "BEGIN ", "PRIVATE KEY", dashes);
    const end = join(dashes, "END ", "PRIVATE KEY", dashes);
    const body = pick(prng(5), B64, 64);
    expect(scrubText(`key ${begin}\n${body}\n${body.slice(0, 20)}`)).toBe("key [private-key]");
    expect(scrubText(`${begin}\n${body}\n${begin}\n${body}\n${end} after`)).toBe(
      "[private-key][private-key] after",
    );
  });

  it("remove an IPv6 address beside a colon, a port or a bracket", () => {
    const full = ["2001", "db8", "5e1b", "a600", "6d0a", "1c2e", "8e54", "2f11"].join(":");
    for (const [text, expected] of [
      [`ip:${full} x`, "ip:[ip] x"],
      ["client:2001:db8:3::5", "client:[ip]"],
      [`connect ETIMEDOUT ${full}:443`, "connect ETIMEDOUT [ip]"],
      ["addr 2001:db8::1: reset", "addr [ip]: reset"],
      ["[2001:db8::1]:8080", "[[ip]]:8080"],
      ["host=2001:db8::1,", "host=[ip],"],
      ["(2001:db8::1)", "([ip])"],
      ["fe80::1%en0.", "[ip]."],
    ] as const) {
      expect(scrubText(text), text).toBe(expected);
    }
    expect(scrubText("peer ::ffff:203.0.113.9 refused")).not.toMatch(/\d{1,3}\.\d{1,3}/);
  });

  it("keep runs of colons that are not addresses", () => {
    for (const keep of [
      "std::vector",
      "Foo::Bar",
      "Array::new",
      "io::Error",
      "at 09:48:23.123",
      "aa:bb:cc:dd:ee:ff",
      "ab:cd:ef:01:23:45:67",
      "ratio 16:9",
      "https://docs.example.net/x",
      "[x]:8080",
    ]) {
      expect(scrubText(keep), keep).toBe(keep);
    }
  });

  it("remove an IPv6 address whatever letter stands beside it", () => {
    const full = ["2001", "db8", "85a3", "0", "0", "8a2e", "370", "7334"].join(":");
    for (const [text, expected] of [
      [`ip=${full}x`, "ip=[ip]x"],
      ["2001:db8::1x", "[ip]x"],
      ["from 2001:db8:4f2a::17beZ", "from [ip]Z"],
      [`peer ${full}in pool`, "peer [ip]in pool"],
      ["x2001:db8::1", "x[ip]"],
      ["_2001:db8::1_", "_[ip]_"],
      ["in2001:db8::1in", "in[ip]in"],
      ["xfe80::1", "x[ip]"],
      ["fe80::1%en0x pool", "[ip] pool"],
      // A hex letter beside the address joins its run, and the whole run goes.
      ["a2001:db8::1", "[ip]"],
      [`${full}f`, "[ip]"],
      // A colon kept outside is a label's or a port's, never the address's neighbour.
      ["ip:::1", "ip:[ip]"],
      ["x:2001:db8::1:y", "x:[ip]:y"],
    ] as const) {
      expect(scrubText(text), text).toBe(expected);
      expect(scrubText(`(${text})`), text).toBe(`(${expected})`);
    }
  });

  it("remove an address after a percent escape or a zone, whatever ran on before it", () => {
    // Percent-encoded text whose colons stay literal (encodeURI, a URL as a library prints it): an
    // escape's hex digits stand right before the address. A zone ran on into the next address.
    const full = ["2001", "db8", "85a3", "0", "0", "8a2e", "370", "7334"].join(":");
    const v4 = ["10", "1", "2", "3"].join(".");
    const v4b = ["203", "0", "113", "7"].join(".");
    for (const [text, expected] of [
      [encodeURI("peer: 2001:db8::8a2e:7334"), "peer:%[ip]"],
      [`at%2009:48:23%20${full}:443`, "at%2009:48:23%[ip]"],
      ["load:%2001:db8::8a2e:7334", "load:%[ip]"],
      ["fe80::1%eth0:2001:db8::8a2e:7334", "[ip]%eth[ip]"],
      ["2001:db8::1%2C2001:db8::2", "[ip]%[ip]"],
      ["fe80::1%25eth0 up", "[ip] up"],
      ["x::1%eth0:2001:db8::1", "x::1%eth[ip]"],
      [encodeURI(`peer ${v4}`), "peer%20[ip]"],
      [encodeURI(`peer ${v4b} refused`), "peer%20[ip]%20refused"],
      [`x%30${v4b}`, "x%30[ip]"],
      [encodeURI(`via 2001:db8::1 ${v4}`), "via%[ip][ip]"],
    ] as const) {
      expect(scrubText(text), text).toBe(expected);
    }
    // A zone after a run that is kept stays, and so does what follows it.
    for (const keep of ["x::1%eth0", "at%2009:48:23", "ratio 16:9%20ok", "std::vector%3Cint%3E"]) {
      expect(scrubText(keep), keep).toBe(keep);
    }
  });

  it("remove an IPv4 address whatever letter or _ stands beside it", () => {
    for (const [text, expected] of [
      ["x203.0.113.7", "x[ip]"],
      ["203.0.113.7x", "[ip]x"],
      ["ip_198.51.100.4", "ip_[ip]"],
      ["peer192.0.2.10in pool", "peer[ip]in pool"],
      ["1.2.3.4.5", "[ip].5"],
    ] as const) {
      expect(scrubText(text), text).toBe(expected);
    }
    for (const keep of ["1234.5.6.7", "1.2.3.4567", "cloudflared 2026.11.1", "v26.13.1"]) {
      expect(scrubText(keep), keep).toBe(keep);
    }
  });

  describe("scrub 1 MB of an adversarial run for every shape in linear time", () => {
    // Each run repeats what starts a match and never finishes it, which is what makes an open part
    // quadratic. A quadratic part takes seconds here, or minutes; every linear one a few
    // milliseconds. The console guard scrubs on the page's main thread.
    const begin = join(dashes, "BEGIN ", "PRIVATE KEY", dashes);
    const end = join(dashes, "END ");
    const address = ["a", "b.co"].join("@");
    const runs: Record<string, (fill: Fill) => string> = {
      "private key, BEGIN after BEGIN": (fill) => fill(begin),
      "private key, a long body and no END": (fill) => `${begin}\n${fill("A")}`,
      "private key, ENDs of something else": (fill) => `${begin}${fill(`${end}X `)}`,
      "private key, a long header": (fill) => join(dashes, "BEGIN ", fill("A")),
      "age identity": (fill) => fill(["AGE", "SECRET", "KEY", "1"].join("-")),
      "Fin API key": (fill) => fill(["fin", "live", "sk", ""].join("_")),
      "Fin key-like": (fill) => fill(["fin", "test", ""].join("_")),
      "webhook secret": (fill) => fill(join("wh", "sec_")),
      "Cloudflare token": (fill) => fill(join("cf", "at_")),
      "JWT, eyJ after eyJ": (fill) => fill("eyJ"),
      "JWT, a short part after each": (fill) => fill("eyJabcdefgh."),
      "heartbeat URL, one long host": (fill) => `https://${fill(join("better", "stack"))}`,
      "heartbeat URL, a host and no path": (fill) =>
        fill(join("https://a.", "better", "stack.com/api/v1/")),
      "heartbeat URL, one host of dots": (fill) =>
        `https://${fill(join("a.", "better", "stack."))}`,
      "DSN, a login and no host": (fill) => fill("https://a@"),
      "DSN, one long login": (fill) => `https://${fill("a")}`,
      "DSN, starts": (fill) => fill("https://"),
      "Postgres URL, logins and no @": (fill) => fill(join("postgres", "://a:")),
      "Postgres URL, ql and a password": (fill) => fill(join("postgres", "ql://a:b")),
      "Postgres URL, one long password": (fill) => join("postgres", "://a:", fill("b")),
      "Postgres URL, no colon after the login": (fill) => fill(join("postgres", "://a")),
      "bearer, no token": (fill) => fill(join("bea", "rer ")),
      "bearer, a long gap": (fill) => join("bea", "rer", fill(" ")),
      "basic, no token": (fill) => fill(join("bas", "ic ")),
      "__Host- cookie, no =": (fill) => fill("__Host-a"),
      "__Secure- cookie, no =": (fill) => fill("__Secure-"),
      "cookie, one long name": (fill) => `__Host-${fill("a")}`,
      "Access cookie": (fill) => fill("CF_Authorization"),
      "ingress proof, a long gap": (fill) => join("fin-ingress-proof:", fill(" ")),
      "email, no @": (fill) => fill("a."),
      "email, letters and no @": (fill) => fill("a"),
      "email, @ after @": (fill) => fill("@a"),
      "email, a long domain": (fill) => `a@${fill("a.")}`,
      "email, a long local part": (fill) => `${fill("a%")}@`,
      "email, addresses run together": (fill) => fill(`${address}%2C`),
      "email, domains with no top level": (fill) => fill("a@b.c"),
      "email, apostrophes and no @": (fill) => fill("a'"),
      "email, quotes before each @": (fill) => fill("'@a.co"),
      "email, apostrophes between addresses": (fill) => fill(`a'${address}'`),
      "email, quotes and no local part": (fill) => fill("''@"),
      "IPv4, dots and no end": (fill) => fill("1.1.1."),
      "IPv4, escapes and dots": (fill) => fill("%201.1."),
      "IPv6, hex and colons and no end": (fill) => fill("a:", "g"),
      "IPv6, compressed runs": (fill) => fill("1::", "x"),
      "IPv6, compressed runs of letters": (fill) => fill("a::"),
      "IPv6, hex and no colon": (fill) => fill("0123456789abcdef"),
      "IPv6, zones": (fill) => fill("::1%a"),
      "IPv6, one long zone": (fill) => `::1%${fill("a")}`,
      "IPv6, one long zone and a colon": (fill) => `::1%${fill("g")}:`,
      "IPv6, zones that run on": (fill) => fill("::1%a:"),
      "IPv6, escapes between runs": (fill) => fill("1::1%20"),
      "IPv6, colons then a hex digit": (fill) => fill(":", "a"),
      "IPv6, a hex digit between colons": (fill) => `${fill(":")}a${fill(":")}`,
      "IPv6, colons and no hex": (fill) => fill(":"),
      "query string": (fill) => fill("?"),
      "query string, apostrophes": (fill) => fill("?'"),
      "ID-bearing path": (fill) => fill("/c/"),
      "long segment": (fill) => `/${fill("A1")}`,
      slashes: (fill) => fill("/"),
      "digits, then a letter": (fill) => fill("1", "a"),
      "code, no digits": (fill) => fill("code "),
      "fragment, # after #": (fill) => fill("#"),
      "fragment, short ones": (fill) => fill("#a"),
      "fragment, one long one": (fill) => `#${fill("a=")}`,
      "fragment, quotes and parentheses": (fill) => fill("#'()"),
      "fragment, ended by spaces": (fill) => fill("#a=b "),
      "fragment, code words and digits": (fill) => fill("#pin-123456"),
      "fragment, code tokens and no #": (fill) => fill(" [code]"),
    };
    for (const [name, run] of Object.entries(runs)) {
      it(name, () => {
        expectLinearTime(name, (size) => run(filler(size)), scrubText);
      });
    }
  });

  it("are idempotent", () => {
    for (const sample of cases(2)) {
      const once = scrubText(sample.value);
      expect(scrubText(once), sample.name).toBe(once);
    }
  });
});
