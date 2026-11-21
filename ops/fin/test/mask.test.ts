import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { Masker } from "../src/core/mask.ts";
import { Output } from "../src/core/output.ts";
import { Secret } from "../src/core/secret.ts";
import { fakeRuntime } from "./helpers/fixtures.ts";

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
    assert.equal(m.size, 0);
    assert.equal(m.mask("a@b"), "a@b");
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

  it("produces GitHub add-mask commands for every value", () => {
    const m = new Masker();
    m.register("zone.example", "<zone>");
    assert.deepEqual(m.addMaskCommands(), ["::add-mask::zone.example"]);
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

  it("primes GitHub's masking before the first line in Actions", () => {
    const runtime = fakeRuntime({ env: { GITHUB_ACTIONS: "true" } });
    const m = new Masker();
    m.register("zone.example", "<zone>");
    const out = new Output(runtime, m);
    out.info("first");
    m.register("another-value", "<v>");
    out.info("second");
    assert.equal(
      runtime.out(),
      "::add-mask::zone.example\nfirst\n::add-mask::another-value\nsecond\n",
    );
  });
});
