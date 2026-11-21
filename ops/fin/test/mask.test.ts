import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { escapeCommandData, Masker } from "../src/core/mask.ts";
import { Output } from "../src/core/output.ts";
import { Secret } from "../src/core/secret.ts";
import { fakeRuntime } from "./helpers/fixtures.ts";

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

  it("masks a registered number only where it stands on its own", () => {
    const m = new Masker();
    m.register(1234, "<threshold>");
    m.register(30, "<grace>");
    assert.equal(m.mask("rate 1234 per 10 s"), "rate <threshold> per 10 s");
    assert.equal(m.mask("grace 30, retry in 30s"), "grace <grace>, retry in 30s");
    for (const text of ["11234", "1234.5", "2026-11-30T12:30:00Z", "1.30.2", "v1234", "x30"]) {
      assert.equal(m.mask(text), text, text);
    }
  });

  it("masks a JSON value field by field and keeps it valid JSON whatever is registered", () => {
    const m = new Masker();
    m.register("12", "<overlay:oncall.escalateAfterMinutes>");
    m.register(100, "<overlay:thresholds.api-v4>");
    m.register("console.zone.example", "<host:console>");
    const value = {
      seq: 12,
      count: 3,
      threshold: 100,
      host: "console.zone.example",
      nested: [{ "console.zone.example": "12" }],
      secret: new Secret("never-printed"),
    };
    const masked = m.maskValue(value);
    assert.deepEqual(masked, {
      seq: "<overlay:oncall.escalateAfterMinutes>",
      count: 3,
      threshold: "<overlay:thresholds.api-v4>",
      host: "<host:console>",
      nested: [{ "<host:console>": "<overlay:oncall.escalateAfterMinutes>" }],
      secret: "[redacted]",
    });
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
