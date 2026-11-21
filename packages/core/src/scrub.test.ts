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
const HEX = "0123456789abcdefABCDEF";

/** A random IPv6 address: eight groups, or a `::` form keeping at least two of them. */
function ipv6(rand: () => number): string {
  const groups = Array.from({ length: 8 }, () => pick(rand, HEX, 1 + Math.floor(rand() * 4)));
  if (rand() < 0.4) return groups.join(":");
  const dropped = 1 + Math.floor(rand() * 6);
  const start = Math.floor(rand() * (8 - dropped + 1));
  const left = groups.slice(0, start).join(":");
  const right = groups.slice(start + dropped).join(":");
  return `${left}::${right}`;
}

interface Sample {
  name: string;
  value: string;
  token: string;
  /**
   * A run of digits inside a word belongs to the word (a digest such as the release, or an ID),
   * so DIGITS keeps spec 08's `\b` and such a sample is planted beside non-letters only.
   */
  wordBound?: true;
}

/** One generator per shape the scrubbers know, each with the token it must become. */
function samples(rand: () => number): Sample[] {
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
    { name: "random IPv6", value: ipv6(rand), token: "[ip]" },
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
    { name: "long digits", value: "4111111111111111", token: "[digits]", wordBound: true },
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

  it("removes an IPv6 address beside a colon: a label before it, a port or a colon after it", () => {
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
    const line = scrubLine({ event: "x", message: "x", detail: `peer ip:${full} refused` });
    expect(JSON.stringify(line)).not.toContain("2f11");
    expect(line.detail).toBe("peer ip:[ip] refused");
  });

  it("keeps runs of colons that are not addresses", () => {
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

  it("removes an IPv6 address whatever letter stands beside it", () => {
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

  it("removes an IPv4 address whatever letter or _ stands beside it", () => {
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

  it("scrubs 1 MB of an adversarial input for every shape in linear time", () => {
    // Four times the largest body Fin accepts. Each input repeats what starts a match and never
    // finishes it, which is what makes an open-ended part quadratic.
    const size = 1024 * 1024;
    const fill = (unit: string, tail = ""): string =>
      unit.repeat(Math.ceil(size / unit.length)).slice(0, size) + tail;
    const begin = join(dashes, "BEGIN ", "PRIVATE KEY", dashes);
    const end = join(dashes, "END ");
    const runs: Record<string, string> = {
      "private key, BEGIN after BEGIN": fill(begin),
      "private key, a long body and no END": `${begin}\n${fill("A")}`,
      "private key, ENDs of something else": `${begin}${fill(`${end}X `)}`,
      "private key, a long header": join(dashes, "BEGIN ", fill("A")),
      "age identity": fill(["AGE", "SECRET", "KEY", "1"].join("-")),
      "Fin API key": fill(["fin", "live", "sk", ""].join("_")),
      "Fin key-like": fill(["fin", "test", ""].join("_")),
      "webhook secret": fill(join("wh", "sec_")),
      "Cloudflare token": fill(join("cf", "at_")),
      "JWT, eyJ after eyJ": fill("eyJ"),
      "JWT, a short part after each": fill("eyJabcdefgh."),
      "heartbeat URL, one long host": `https://${fill(join("better", "stack"))}`,
      "heartbeat URL, a host and no path": fill(join("https://a.", "better", "stack.com/api/v1/")),
      "heartbeat URL, one host of dots": `https://${fill(join("a.", "better", "stack."))}`,
      "DSN, a login and no host": fill("https://a@"),
      "DSN, one long login": `https://${fill("a")}`,
      "Postgres URL, logins and no @": fill(join("postgres", "://a:")),
      "Postgres URL, ql and a password": fill(join("postgres", "ql://a:b")),
      "Postgres URL, one long password": join("postgres", "://a:", fill("b")),
      "Postgres URL, no colon after the login": fill(join("postgres", "://a")),
      "bearer, no token": fill(join("bea", "rer ")),
      "bearer, a long gap": join("bea", "rer", fill(" ")),
      "basic, no token": fill(join("bas", "ic ")),
      "__Host- cookie, no =": fill("__Host-a"),
      "__Secure- cookie, no =": fill("__Secure-"),
      "cookie, one long name": `__Host-${fill("a")}`,
      "Access cookie": fill("CF_Authorization"),
      "ingress proof, a long gap": join("fin-ingress-proof:", fill(" ")),
      "email, no @": fill("a."),
      "email, @ after @": fill("@a"),
      "email, a long domain": `a@${fill("a.")}`,
      "IPv4, dots and no end": fill("1.1.1."),
      "IPv6, hex and colons and no end": fill("a:", "g"),
      "IPv6, compressed runs": fill("1::", "x"),
      "IPv6, hex and no colon": fill("0123456789abcdef"),
      "IPv6, zones": fill("::1%a"),
      "IPv6, colons then a hex digit": fill(":", "a"),
      "IPv6, a hex digit between colons": `${fill(":")}a${fill(":")}`,
      "IPv6, colons and no hex": fill(":"),
      "query string": fill("?"),
      "ID-bearing path": fill("/c/"),
      "long segment": `/${fill("A1")}`,
      slashes: fill("/"),
      "digits, then a letter": fill("1", "a"),
      "code, no digits": fill("code "),
      letters: fill("a"),
    };
    for (const [name, run] of Object.entries(runs)) {
      const t0 = performance.now();
      scrubText(run);
      // A quadratic part takes seconds here, or minutes; every linear one a few milliseconds.
      expect(performance.now() - t0, name).toBeLessThan(1000);
    }
  });

  it("is idempotent", () => {
    for (const sample of samples(prng(2))) {
      const once = scrubText(sample.value);
      expect(scrubText(once)).toBe(once);
    }
  });
});

/** Each withheld name's words, to spell it as code does: taxId, TaxId, tax_id, TAX_ID, tax-id. */
const WORDS: Readonly<Record<string, readonly string[]>> = {
  name: ["name"],
  firstname: ["first", "name"],
  lastname: ["last", "name"],
  fullname: ["full", "name"],
  displayname: ["display", "name"],
  holdername: ["holder", "name"],
  email: ["email"],
  emailaddress: ["email", "address"],
  phone: ["phone"],
  address: ["address"],
  street: ["street"],
  postcode: ["post", "code"],
  zip: ["zip"],
  dob: ["dob"],
  dateofbirth: ["date", "of", "birth"],
  ip: ["ip"],
  ipaddress: ["ip", "address"],
  clientip: ["client", "ip"],
  useragent: ["user", "agent"],
  password: ["password"],
  secret: ["secret"],
  token: ["token"],
  code: ["code"],
  otp: ["otp"],
  cookie: ["cookie"],
  authorization: ["authorization"],
  apikey: ["api", "key"],
  key: ["key"],
  accountnumber: ["account", "number"],
  iban: ["iban"],
  taxid: ["tax", "id"],
  ssn: ["ssn"],
  note: ["note"],
  message: ["message"],
  body: ["body"],
  query: ["query"],
  querystring: ["query", "string"],
  url: ["url"],
  headers: ["headers"],
  details: ["details"],
  answers: ["answers"],
};

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** Every spelling of a withheld name that code and JSON use. */
function spellings(name: string): string[] {
  const words = WORDS[name] ?? [name];
  const [first = "", ...rest] = words;
  return [
    name,
    name.toUpperCase(),
    `${name.slice(0, 1)}_${name.slice(1)}`,
    first + rest.map(capital).join(""),
    words.map(capital).join(""),
    words.join("_"),
    words.join("_").toUpperCase(),
    words.join("-"),
  ];
}

describe("scrubLine", () => {
  it("withholds every listed field name at any depth, in every spelling code uses", () => {
    expect(Object.keys(WORDS).sort()).toEqual([...WITHHELD_FIELDS].sort());
    for (const name of WITHHELD_FIELDS) {
      for (const key of spellings(name)) {
        const line = scrubLine({ event: "request", outer: { inner: [{ [key]: "anything" }] } });
        expect(line.outer, key).toEqual({ inner: [{ [key]: WITHHELD }] });
        expect(scrubLine({ event: "x", [key]: { deep: 1 } })[key], key).toBe(WITHHELD);
        expect(() => assertNoPersonalShapes({ [key]: "anything" }), key).toThrow();
      }
    }
  });

  it("withholds a tax ID under the names code gives it, though they end in Id", () => {
    const line = scrubLine({
      event: "x",
      taxId: "12-3456789",
      tax_id: "12-3456789",
      TaxId: "AB123456C",
      applicant: { taxId: "123-45-6789", tax_id: "123-45-6789" },
    });
    expect(line).toEqual({
      event: "x",
      taxId: WITHHELD,
      tax_id: WITHHELD,
      TaxId: WITHHELD,
      applicant: { taxId: WITHHELD, tax_id: WITHHELD },
    });
    for (const key of ["taxId", "tax_id", "TaxId", "TAX_ID"]) {
      expect(() => assertNoPersonalShapes({ [key]: "123-45-6789" }), key).toThrow();
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

  it("scrubs what an object's toJSON returns, and keeps no function to call later", () => {
    const token = join("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxIn0", ".", "abcdefgh");
    const session = {
      id: "s1",
      toJSON: () => ({ email: "jane.doe@example.com", password: "hunter2", token }),
    };
    const line = scrubLine({ event: "thing.done", message: "thing.done", session });
    const text = JSON.stringify(line);
    expect(text).not.toContain("jane.doe");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain(token);
    expect(line.session).toEqual({
      email: WITHHELD,
      password: WITHHELD,
      token: WITHHELD,
    });
    const withFunction = scrubLine({ event: "x", nested: { run: () => "x", n: 1 } });
    expect(withFunction.nested).toEqual({ n: 1 });
  });

  it("writes a Date, a Map, a Set, bytes, an error and a bigint as data it has scrubbed", () => {
    const line = scrubLine({
      event: "x",
      at: new Date(Date.UTC(2026, 10, 21, 9, 0, 0)),
      byPeer: new Map([["203.0.113.9", 3]]),
      seen: new Set(["a@example.com", "ok"]),
      bytes: new TextEncoder().encode("hunter2"),
      failure: Object.assign(new TypeError("for jane@example.com"), { detail: "Jane Doe" }),
      big: 4111111111111111n,
    });
    expect(line.at).toBe("2026-11-21T09:00:00.000Z");
    expect(line.byPeer).toEqual({ "[ip]": 3 });
    expect(line.seen).toEqual(["[email]", "ok"]);
    expect(line.bytes).toBe("[binary]");
    expect(line.failure).toEqual({ errorName: "TypeError" });
    expect(line.big).toBe("[digits]");
    expect(() => JSON.stringify(line)).not.toThrow();
  });

  it("scrubs shapes in keys at every depth", () => {
    const key = join(["fin", "live", "sk"].join("_"), "_", "0123456789", "A".repeat(38));
    const line = scrubLine({
      event: "x",
      message: "x",
      sent: { "jane.doe@example.com": "ok" },
      byIp: { "203.0.113.9": 3 },
      [key]: 1,
    });
    const text = JSON.stringify(line);
    expect(text).not.toContain("jane.doe");
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain(key);
    expect(line.sent).toEqual({ "[email]": "ok" });
    expect(line["[api-key]"]).toBe(1);
  });

  it("finds no planted shape in random lines, keys and nested objects (property test)", () => {
    const rand = prng(20261121);
    const keys = ["route", "reason", "detail_text", "items", "note_list", "context", "status"];
    // Shapes are planted between neighbours a log line really has: spaces, a label's colon, an
    // assignment, list and call punctuation, a host and port, a sentence's end; and glued to a
    // word, as text run together leaves them.
    const glued = ["x", "in", "Z", "_"];
    const before = [" ", ":", "=", ",", "(", "[", "ip:", "for ", ...glued];
    const after = [" ", ":", ",", ")", "]", ";", ".", ":443", ...glued];
    const choose = (list: readonly string[], sample: Sample): string => {
      const usable = sample.wordBound ? list.filter((item) => !glued.includes(item)) : list;
      return usable[Math.floor(rand() * usable.length)] ?? " ";
    };
    for (let round = 0; round < 300; round++) {
      const planted = samples(rand);
      const secrets: string[] = [];
      const plant = (): string => {
        const sample = planted[Math.floor(rand() * planted.length)];
        if (sample === undefined) return "";
        secrets.push(sample.value);
        return `${pick(rand, "abc ", 5)}${choose(before, sample)}${sample.value}${choose(after, sample)}${pick(rand, "xyz ", 5)}`;
      };
      const build = (depth: number): unknown => {
        const kind = Math.floor(rand() * 5);
        if (depth > 3 || kind === 0) return plant();
        if (kind === 1) return [build(depth + 1), build(depth + 1)];
        if (kind === 2) return rand() * 1000;
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < 3; i++) {
          // A key is sometimes a planted shape itself: a map keyed by an address or a token.
          const key =
            kind === 4 && i === 0 ? plant() : (keys[Math.floor(rand() * keys.length)] ?? "k");
          obj[key] = build(depth + 1);
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

  it("drops frames a message line could have written, and keeps only a class name as the type", () => {
    const out = scrubEvent({
      tags: { fin_fixed_message: "false" },
      exception: {
        values: [
          {
            type: "Refused for Jane Doe hunter2-Password",
            value: "x",
            stacktrace: {
              frames: [
                { filename: "12 Acacia Avenue, Leeds", function: "Jane Doe", lineno: 1, colno: 1 },
                { filename: "/app/dist/main.js", function: "Jane Doe of 12 High St", lineno: 2 },
                { filename: "/app/dist/main.js", function: "Foo.bar [as baz]", lineno: 3 },
                {
                  filename: "node:internal/process/task_queues",
                  function: "process.processTicksAndRejections",
                  lineno: 95,
                },
              ],
            },
          },
        ],
      },
    }) as { exception: { values: { type: string; stacktrace: { frames: unknown[] } }[] } };
    const value = out.exception.values[0];
    expect(value?.type).toBe("Error");
    expect(value?.stacktrace.frames).toEqual([
      { filename: "/app/dist/main.js", lineno: 2 },
      { filename: "/app/dist/main.js", function: "Foo.bar [as baz]", lineno: 3 },
      {
        filename: "node:internal/process/task_queues",
        function: "process.processTicksAndRejections",
        lineno: 95,
      },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/Jane|Acacia|hunter2/);
  });

  it("keeps only navigation breadcrumbs, with no query or token", () => {
    const out = scrubEvent(event) as { breadcrumbs: unknown[] };
    expect(out.breadcrumbs).toEqual([
      { category: "navigation", data: { from: "/c/[segment]", to: "/settings" } },
    ]);
    expect(scrubBreadcrumb({ category: "fetch", data: { url: "/x" } })).toBeNull();
    expect(
      scrubBreadcrumb({ category: "navigation", data: { from: "/a?x=1\nb", to: "/b#t\nc" } }),
    ).toEqual({ category: "navigation", data: { from: "/a", to: "/b" } });
  });

  it("cuts a long breadcrumb's query in linear time", () => {
    const size = 1024 * 1024;
    for (const from of [`${"?".repeat(size)}\nx`, "#\n".repeat(size / 2), "/".repeat(size)]) {
      const t0 = performance.now();
      scrubBreadcrumb({ category: "navigation", data: { from } });
      expect(performance.now() - t0, from.slice(0, 4)).toBeLessThan(1000);
    }
  });

  it("applies the field rule to tags and keeps a mechanism only by its SDK name", () => {
    const out = scrubEvent({
      tags: {
        fin_fixed_message: "false",
        requestId: "req_01jd2k3m4n5p6q7r8s9t0v1w2x",
        email: "x",
        "jane.doe@example.com": "1",
      },
      exception: {
        values: [
          { type: "Error", mechanism: { type: "jane.doe@example.com handled", handled: false } },
          { type: "Error", mechanism: { type: "auto.node.onuncaughtexception", handled: false } },
        ],
      },
    }) as { tags: Record<string, unknown>; exception: { values: { mechanism: unknown }[] } };
    expect(out.tags).toEqual({
      fin_fixed_message: "false",
      requestId: "req_01jd2k3m4n5p6q7r8s9t0v1w2x",
      email: WITHHELD,
      "[email]": "1",
    });
    expect(out.exception.values.map((value) => value.mechanism)).toEqual([
      { handled: false },
      { type: "auto.node.onuncaughtexception", handled: false },
    ]);
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

  it("refuses a shape in a key, and checks what toJSON would store", () => {
    expect(() => assertNoPersonalShapes({ recipients: { "jane.doe@example.com": "ok" } })).toThrow(
      "key",
    );
    expect(() =>
      assertNoPersonalShapes({ at: { toJSON: () => ({ who: "jane.doe@example.com" }) } }),
    ).toThrow();
    expect(() => assertNoPersonalShapes({ at: new Date(0), count: 3n })).not.toThrow();
  });
});
