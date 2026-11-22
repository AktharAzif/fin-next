// The hashes `pnpm fin` records must equal what the watcher recomputes (ops/watcher/src/hash.ts):
// these vectors pin the canonical form both sides use.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { accessPolicyHash, canonicalJson, rulesetHash } from "../src/cloudflare/hash.ts";
import { harness } from "./helpers/setup.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("the watcher's hashes", () => {
  it("canonical JSON sorts keys at every depth and drops undefined keys", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [1, { z: 1, y: undefined }], c: null } }),
      '{"a":{"c":null,"d":[1,{"z":1}]},"b":1}',
    );
    assert.equal(canonicalJson(undefined), "null");
  });

  it("hashes a rule set by the rule fields only, in order", () => {
    const rules = [
      {
        id: "x",
        version: "3",
        last_updated: "t",
        ref: "fin_next_a",
        expression: "(true)",
        action: "block",
        enabled: true,
      },
      { id: "y", ref: "legacy", description: "d", expression: "(false)", action: "skip" },
    ];
    assert.equal(
      rulesetHash(rules),
      sha(
        '[{"action":"block","enabled":true,"expression":"(true)","ref":"fin_next_a"},{"action":"skip","description":"d","expression":"(false)","ref":"legacy"}]',
      ),
    );
    assert.equal(rulesetHash([]), sha("[]"));
    assert.notEqual(rulesetHash(rules), rulesetHash([...rules].reverse()));
  });

  it("hashes the policies by precedence, then name", () => {
    const a = { id: "1", name: "b", decision: "allow", precedence: 2, include: [] };
    const b = {
      id: "2",
      name: "a",
      decision: "allow",
      precedence: 1,
      include: [{ email: { email: "x@example.com" } }],
    };
    assert.equal(
      accessPolicyHash([a, b]),
      sha(
        '[{"decision":"allow","include":[{"email":{"email":"x@example.com"}}],"name":"a","precedence":1},{"decision":"allow","include":[],"name":"b","precedence":2}]',
      ),
    );
    assert.equal(accessPolicyHash([a, b]), accessPolicyHash([b, a]));
  });

  it("zone apply and access apply record them in run.done, and never print them", async () => {
    const h = harness();
    await h.run(["zone", "apply", "staging", "--only", "rules"]);
    await h.run(["access", "apply", "staging"]);
    const done = h.records().filter((r) => r.event === "run.done");
    const hashes = done[0]?.rulesetHashes as Record<string, string>;
    assert.equal(Object.keys(hashes).length, 7);
    const waf = [...h.cf.rulesets.values()].find((r) => r.phase === "http_request_firewall_custom");
    assert.equal(hashes.http_request_firewall_custom, rulesetHash(waf?.rules ?? []));
    assert.match(String(done[1]?.accessPolicyHash), /^[0-9a-f]{64}$/);
    // A hash whose only unknown is a private value (a threshold, a staff address) can be
    // brute-forced offline, so stdout and stderr (a public job log in Actions) never carry one.
    const printed = `${h.runtime.out()}\n${h.runtime.err()}`;
    assert.doesNotMatch(printed, /[0-9a-f]{64}/);
    for (const hash of [...Object.values(hashes), String(done[1]?.accessPolicyHash)]) {
      assert.equal(printed.includes(hash), false);
    }
  });

  it("records the hash of fin-next's own rules only, whatever else the phase holds", async () => {
    const h = harness();
    const legacy = {
      id: "c".repeat(32),
      ref: "legacy_redirect",
      description: "the other product's redirect",
      expression: '(http.host eq "legacy.zone.example")',
      action: "redirect",
      enabled: true,
    };
    const phase = { id: "d".repeat(32), phase: "http_request_dynamic_redirect", rules: [legacy] };
    h.cf.rulesets.set(phase.id, phase);
    await h.run(["zone", "apply", "staging", "--only", "rules"]);
    const done = h.records().find((r) => r.event === "run.done");
    const hashes = done?.rulesetHashes as Record<string, string>;
    const own = phase.rules.filter((r) => r.ref?.startsWith("fin_next_"));
    assert.equal(own.length, 1);
    assert.equal(hashes.http_request_dynamic_redirect, rulesetHash(own));
    assert.notEqual(hashes.http_request_dynamic_redirect, rulesetHash(phase.rules));
  });
});
