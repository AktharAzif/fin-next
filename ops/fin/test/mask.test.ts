import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { escapeCommandData, Masker } from "../src/core/mask.ts";
import { Output, oneLine } from "../src/core/output.ts";
import { PrivateNumber, Secret } from "../src/core/secret.ts";
import { fakeRuntime } from "./helpers/fixtures.ts";
import { jobLog } from "./helpers/runner.ts";

/** The lines a GitHub runner would read: workflow commands are unescaped, other lines kept. */
function runnerView(text: string): { masks: string[]; lines: string[] } {
  const masks: string[] = [];
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("::add-mask::")) {
      masks.push(
        line
          .slice("::add-mask::".length)
          .replace(/%0A/g, "\n")
          .replace(/%0D/g, "\r")
          .replace(/%25/g, "%"),
      );
    } else if (line !== "") lines.push(line);
  }
  return { masks, lines };
}

describe("Masker", () => {
  it("replaces a registered value with its placeholder, case-insensitively", () => {
    const m = new Masker();
    m.register("zone.example", "<zone>");
    assert.equal(
      m.mask("host console.zone.example and CONSOLE.ZONE.EXAMPLE"),
      "host console.<zone> and CONSOLE.<zone>",
    );
  });

  it("prefers the longest value, so a host keeps its role", () => {
    const m = new Masker();
    m.register("zone.example", "<zone>");
    m.register("console.zone.example", "<host:console>");
    assert.equal(m.mask("https://console.zone.example/api/"), "https://<host:console>/api/");
  });

  it("masks short values only as whole tokens", () => {
    const m = new Masker();
    m.register("www", "<never-touch>");
    assert.equal(m.mask("www.zone and awwwards"), "<never-touch>.zone and awwwards");
  });

  it("ignores one-character values, which carry nothing private", () => {
    const m = new Masker();
    m.register("@", "<x>");
    m.register(7, "<y>");
    assert.equal(m.size, 0);
    assert.equal(m.mask("a@b 7"), "a@b 7");
  });

  it("masks the URL-encoded form of a value too", () => {
    const m = new Masker();
    m.register("someone@example.com", "<staff>");
    assert.equal(m.mask("?email=someone%40example.com"), "?email=<staff>");
  });

  it("escapes regular expression characters in values", () => {
    const m = new Masker();
    m.register("a.b+c(d)", "<v>");
    assert.equal(m.mask("x a.b+c(d) y aXb+c(d)"), "x <v> y aXb+c(d)");
  });

  it("masks a value inside JSON text, where quotes, backslashes and newlines are escaped", () => {
    const m = new Masker();
    const value = 'Acme "Private"\\Holdings\nline two of it';
    m.register(value, "<v>");
    const json = JSON.stringify({ account: value, error: `failed for ${value}` });
    const masked = m.mask(json);
    for (const part of ["Private", "Holdings", "line two of it"]) {
      assert.equal(masked.includes(part), false, part);
    }
  });

  it("masks every line of a multi-line value on its own", () => {
    const m = new Masker();
    m.register("responders: one person\nthe pager is off between 23:00 and 07:00", "<annex>");
    assert.equal(m.mask("the pager is off between 23:00 and 07:00"), "<annex>");
    assert.equal(m.mask("note: responders: one person"), "note: <annex>");
  });

  it("never masks a short number by value, so the tool's own numbers survive and nothing is disclosed", () => {
    const m = new Masker();
    m.register(12, "<overlay:thresholds.api-v4>");
    m.register(30, "<overlay:grace.backup-hourly>");
    m.register("17", "<overlay:oncall.escalateAfterMinutes>");
    m.register(99_999, "<overlay:grace.daily>");
    m.register("0.05", "<overlay:thresholds.ratio>");
    assert.equal(m.size, 0, "no short number is registered");
    assert.deepEqual(
      m.addMaskCommands(),
      [],
      "nor announced to the runner, which masks inside words",
    );
    for (const text of [
      "run log: 12 record(s), chain intact; head: record 12",
      "  0 to create, 0 to update, 12 to delete, 0 unchanged",
      "re-run with --confirm-delete 12 to allow it",
      "pid 30 since 2026-11-21T06:12:17.000Z, 17 staff, 99999 lines, 0.05 s",
    ]) {
      assert.equal(m.mask(text), text, text);
    }
  });

  it("announces no short value to the runner, which would mask it inside every word, and masks it as a token itself", () => {
    const m = new Masker();
    m.register("IST", "<overlay:clock.timeZone>");
    m.register("23:00", "<overlay:oncall.quietFrom>");
    m.register("zone.example", "<zone>");
    const announced = m.addMaskCommands();
    for (const short of ["IST", "23:00"]) {
      assert.equal(announced.includes(`::add-mask::${short}`), false, short);
    }
    assert.ok(announced.includes("::add-mask::zone.example"));
    // A longer form of a short value (URL-encoded) matches no ordinary word, so it is announced.
    assert.ok(announced.includes("::add-mask::23%253A00"));
    assert.equal(
      m.mask("quiet from 23:00 IST"),
      "quiet from <overlay:oncall.quietFrom> <overlay:clock.timeZone>",
    );
    assert.equal(
      m.mask("REGISTERED at 2026-11-21T23:00:00Z"),
      "REGISTERED at 2026-11-21T23:00:00Z",
    );
  });

  it("masks a long number (an ID) only where it stands on its own", () => {
    const m = new Masker();
    m.register(1_234_567, "<overlay:betterstack.teamId>");
    m.register("7654321", "<overlay:betterstack.sourceId>");
    assert.equal(m.mask("team 1234567"), "team <overlay:betterstack.teamId>");
    assert.equal(
      m.mask("GET /api/v1/teams/1234567/sources/7654321?x=1"),
      "GET /api/v1/teams/<overlay:betterstack.teamId>/sources/<overlay:betterstack.sourceId>?x=1",
    );
    assert.equal(m.mask('{"team":1234567}'), '{"team":<overlay:betterstack.teamId>}');
    const hash = `ab${"1234567"}cd${"0".repeat(55)}`;
    for (const text of [
      hash,
      "11234567",
      "12345678",
      "1234567.5",
      "1.1234567",
      "v1234567",
      "x7654321_",
    ]) {
      assert.equal(m.mask(text), text, text);
    }
  });

  it("masks a JSON value field by field, keeps the tool's own numbers, masks a registered ID held as a number, and stays valid JSON", () => {
    const m = new Masker();
    m.register("12", "<overlay:oncall.escalateAfterMinutes>");
    m.register(1_234_567, "<overlay:betterstack.teamId>");
    m.register("7654321", "<overlay:betterstack.sourceId>");
    m.register("console.zone.example", "<host:console>");
    const value = {
      seq: 12,
      team: 1_234_567,
      source: 7_654_321,
      other: 1_234_568,
      fraction: 1_234_567.5,
      count: 3,
      threshold: new PrivateNumber(100, "<threshold:api-v4>"),
      host: "console.zone.example",
      teamText: "1234567",
      nested: [{ "console.zone.example": "12", ids: [1_234_567, 99] }],
      secret: new Secret("never-printed"),
    };
    const masked = m.maskValue(value);
    assert.deepEqual(masked, {
      seq: 12,
      team: "<overlay:betterstack.teamId>",
      source: "<overlay:betterstack.sourceId>",
      other: 1_234_568,
      fraction: 1_234_567.5,
      count: 3,
      threshold: "<threshold:api-v4>",
      host: "<host:console>",
      teamText: "<overlay:betterstack.teamId>",
      nested: [{ "<host:console>": "12", ids: ["<overlay:betterstack.teamId>", 99] }],
      secret: "[redacted]",
    });
    assert.equal(JSON.stringify(masked).includes("1234567,"), false);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(masked)));
  });

  it("produces GitHub add-mask commands for every form, escaped as the runner unescapes them", () => {
    const m = new Masker();
    m.register("zone.example", "<zone>");
    assert.deepEqual(m.addMaskCommands(), ["::add-mask::zone.example"]);
    const m2 = new Masker();
    m2.register("50%off\nsecond line here", "<v>");
    const { masks, lines } = runnerView(m2.addMaskCommands().join("\n"));
    assert.deepEqual(lines, [], "every command stays one line");
    assert.ok(masks.includes("50%off\nsecond line here"));
    assert.ok(masks.includes("50%off"));
    assert.ok(masks.includes("second line here"));
    assert.equal(escapeCommandData("a%0A\r\n"), "a%250A%0D%0A");
  });
});

describe("Secret", () => {
  it("never prints its value", () => {
    const s = new Secret("very-secret-value");
    assert.equal(String(s), "[redacted]");
    assert.equal(`${s}`, "[redacted]");
    assert.equal(JSON.stringify({ s }), '{"s":"[redacted]"}');
    assert.equal(inspect(s), "[redacted]");
    assert.equal(inspect({ nested: s }), "{ nested: [redacted] }");
    assert.equal(s.reveal(), "very-secret-value");
  });

  it("compares in constant time without revealing", () => {
    assert.equal(new Secret("abc").equals(new Secret("abc")), true);
    assert.equal(new Secret("abc").equals(new Secret("abd")), false);
    assert.equal(new Secret("abc").equals(new Secret("abcd")), false);
  });
});

describe("PrivateNumber", () => {
  it("prints its role through every path, arithmetic included, and gives the number only to reveal()", () => {
    const n = new PrivateNumber(100, "<threshold:api-v4>");
    assert.equal(String(n), "<threshold:api-v4>");
    assert.equal(`rate ${n}`, "rate <threshold:api-v4>");
    assert.equal((n as unknown as number) + 1, "<threshold:api-v4>1");
    assert.equal(JSON.stringify({ n }), '{"n":"<threshold:api-v4>"}');
    assert.equal(inspect({ n }), "{ n: <threshold:api-v4> }");
    assert.ok(Number.isNaN(Number(n)));
    assert.equal(n.reveal(), 100);
    assert.deepEqual(new Masker().maskValue({ n }), { n: "<threshold:api-v4>" });
  });
});

describe("Output", () => {
  it("masks every line", () => {
    const runtime = fakeRuntime();
    const m = new Masker();
    m.register("zone.example", "<zone>");
    const out = new Output(runtime, m);
    out.info("zone.example");
    out.warn("w zone.example");
    out.error("e zone.example");
    assert.equal(runtime.out(), "<zone>\n");
    assert.equal(runtime.err(), "warning: w <zone>\nerror: e <zone>\n");
  });

  it("primes GitHub's masking on standard error before the first line, so standard output stays safe to capture", () => {
    const runtime = fakeRuntime({ env: { GITHUB_ACTIONS: "true" } });
    const m = new Masker();
    m.register("zone.example", "<zone>");
    const out = new Output(runtime, m);
    out.info("first");
    m.register("another-value", "<v>");
    out.info("second");
    assert.equal(runtime.out(), "first\nsecond\n");
    assert.equal(runtime.err(), "::add-mask::zone.example\n::add-mask::another-value\n");
  });

  it("prints exactly one line per call: line breaks, other controls and Unicode separators are escaped", () => {
    const runtime = fakeRuntime();
    const out = new Output(runtime, new Masker());
    out.info("a\n::stop-commands::x");
    out.warn("w\r\nnext\ttab");
    out.error(
      `e${String.fromCharCode(0x2028)}f${String.fromCharCode(0x2029)}g${String.fromCharCode(0x1b)}[2Jh${String.fromCharCode(0x85)}i${String.fromCharCode(0x7f)}`,
    );
    assert.equal(runtime.out(), "a\\n::stop-commands::x\n");
    assert.equal(
      runtime.err(),
      "warning: w\\r\\nnext\\ttab\nerror: e\\u2028f\\u2029g\\u001b[2Jh\\u0085i\\u007f\n",
    );
  });

  it("never prints a line the runner reads as a workflow command, in either form", () => {
    for (const [text, want] of [
      ["::stop-commands::x", "\\::stop-commands::x"],
      ["  ::add-mask::y", "  \\::add-mask::y"],
      [`${String.fromCharCode(0xa0)}::warning::z`, `${String.fromCharCode(0xa0)}\\::warning::z`],
      ["name ##[stop-commands]t here", "name #\\#[stop-commands]t here"],
      ["a::b is fine mid-line", "a::b is fine mid-line"],
    ] as const) {
      assert.equal(oneLine(text), want, text);
    }
    const runtime = fakeRuntime({ env: { GITHUB_ACTIONS: "true" } });
    const m = new Masker();
    const out = new Output(runtime, m);
    out.info("plan for x\n::stop-commands::zz");
    out.error("##[stop-commands]yy");
    m.register("zone.example", "<zone>");
    out.info("then zone.example");
    // The add-mask command still reaches the runner, and nothing turned command processing off.
    const view = jobLog(runtime.all());
    assert.equal(view.stopped, false);
    assert.deepEqual(view.masks, ["zone.example"]);
    assert.equal(view.text.includes("zone.example"), false);
  });

  it("announces a multi-line value line by line, and never prints one of its lines in clear", () => {
    const runtime = fakeRuntime({ env: { GITHUB_ACTIONS: "true" } });
    const m = new Masker();
    const pem = ["-----BEGIN CERTIFICATE-----", "MIIBfakefakefake", "-----END CERTIFICATE-----"];
    m.register(pem.join("\n"), "<overlay:db.caFingerprint>");
    const out = new Output(runtime, m);
    out.info("ok");
    const { masks, lines } = runnerView(runtime.err());
    assert.deepEqual(lines, [], "standard error holds only add-mask commands");
    for (const line of pem) {
      assert.ok(masks.includes(line), line);
      assert.equal(runtime.out().includes(line), false, line);
    }
  });
});
