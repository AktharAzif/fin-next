import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desiredRules, hostIn } from "../src/cloudflare/rules.ts";
import { EXIT } from "../src/core/errors.ts";
import { Secret } from "../src/core/secret.ts";
import { ZONE } from "./helpers/fixtures.ts";
import type { Rule } from "./helpers/providers.ts";
import { harness } from "./helpers/setup.ts";

const OTHER_PRODUCT_RULE: Rule = {
  id: "c".repeat(32),
  ref: "legacy_redirect",
  description: "the other product's redirect",
  expression: `(http.host eq "legacy.${ZONE}")`,
  action: "redirect",
  action_parameters: {
    from_value: { status_code: 301, target_url: { value: "https://example.com" } },
  },
  enabled: true,
};

function allRules(h: ReturnType<typeof harness>): Rule[] {
  return [...h.cf.rulesets.values()].flatMap((r) => r.rules);
}

describe("zone apply", () => {
  it("dry run: plans the rules and the new proofs, holds shared-zone settings, sends nothing", async () => {
    const h = harness();
    const code = await h.run(["zone", "apply", "staging", "--dry-run"]);
    assert.equal(code, 1);
    assert.equal(h.cf.writes().length, 0);
    assert.equal(h.rw.operations.length, 0, "a dry run reads nothing from Railway");
    const out = h.runtime.out();
    assert.match(out, /\+ create rule http_request_dynamic_redirect\/fin_next_https_browser_hosts/);
    assert.match(out, /~ update variable edge.FIN_INGRESS_PROOFS .*new proof for api/);
    assert.match(out, /~ update variable verify.FIN_INGRESS_PROOFS .*new proof for verify, selfie/);
    assert.match(out, /! update setting 0rtt .*held: the zone is shared/);
    assert.match(out, /dry run: nothing was sent/);
    assert.equal(h.records().length, 0);
    h.assertNoLeak();
  });

  it("applies: proofs reach the services sealed before any rule sends them, through per-rule endpoints only", async () => {
    const h = harness();
    const foreign = {
      id: "d".repeat(32),
      phase: "http_request_dynamic_redirect",
      rules: [{ ...OTHER_PRODUCT_RULE }],
    };
    h.cf.rulesets.set(foreign.id, foreign);
    const code = await h.run(["zone", "apply", "staging"]);
    assert.equal(code, 1, "the shared-zone settings stay held, so the run reports them");
    // The other product's rule is untouched, and Fin's redirect joined it through POST .../rules.
    assert.deepEqual(foreign.rules[0], OTHER_PRODUCT_RULE);
    assert.equal(foreign.rules.length, 2);
    assert.ok(
      h.cf
        .writes()
        .some(
          (c) =>
            c.method === "POST" &&
            c.path === `/zones/${"2".repeat(32)}/rulesets/${foreign.id}/rules`,
        ),
    );
    // No rule set was ever replaced whole, and the existing phase got no second entrypoint.
    assert.equal(h.cf.writes().filter((c) => c.method === "PUT").length, 0);
    const created = h.cf
      .writes()
      .filter((c) => c.path.endsWith("/rulesets") && c.method === "POST");
    assert.equal(
      created.some((c) => (c.body as { phase: string }).phase === "http_request_dynamic_redirect"),
      false,
    );
    // Every proof was set sealed, on the services that check it, before the first rule write.
    assert.equal(h.rw.patches.length, 4);
    const lastPatch = h.sequence.lastIndexOf("rw finPatch");
    const firstRuleWrite = h.sequence.findIndex((c) => /^cf (POST|PATCH) .*\/rulesets/.test(c));
    assert.ok(
      lastPatch >= 0 && firstRuleWrite > lastPatch,
      "every proof is set before the first rule write",
    );
    for (const p of h.rw.patches) assert.equal(p.variables.FIN_INGRESS_PROOFS?.isSealed, true);
    const verify = JSON.parse(
      h.rw.patches.find((p) => h.rw.nameOf(p.serviceId) === "verify")?.variables.FIN_INGRESS_PROOFS
        ?.value ?? "{}",
    );
    assert.deepEqual(Object.keys(verify).sort(), ["selfie", "verify"]);
    const proofRule = allRules(h).find((r) => r.ref === "fin_next_ingress_proof_verify");
    const headers = (proofRule?.action_parameters?.headers ?? {}) as Record<
      string,
      { value: string }
    >;
    const sent = headers["Fin-Ingress-Proof"]?.value;
    assert.equal(verify.verify[0], sent);
    assert.match(sent ?? "", /^[A-Za-z0-9_-]{43}$/);
    // Every Fin rule has a fin_next_ ref and names only Fin's hosts.
    for (const rule of allRules(h).filter((r) => r !== foreign.rules[0])) {
      assert.match(rule.ref ?? "", /^fin_next_/);
      assert.doesNotMatch(rule.expression ?? "", /legacy\./);
    }
    const records = h.records();
    assert.equal(records[0]?.event, "run.registered");
    assert.equal(records.at(-1)?.event, "run.done");
    assert.equal(records.at(-1)?.result, "ok");
    h.assertNoLeak([
      sent ?? "",
      ...h.rw.patches.map((p) => p.variables.FIN_INGRESS_PROOFS?.value ?? ""),
    ]);
  });

  it("is idempotent: a second run keeps the proofs and needs no Railway token", async () => {
    const h = harness();
    await h.run(["zone", "apply", "staging", "--only", "rules"]);
    const writes = h.cf.writes().length;
    delete h.env.FIN_RAILWAY_TOKEN_FILE;
    const code = await h.run(["zone", "apply", "staging", "--only", "rules"]);
    assert.equal(code, EXIT.ok);
    assert.equal(h.cf.writes().length, writes);
    assert.match(h.runtime.out(), /nothing to change/);
  });

  it("changes zone-wide settings only with --allow-shared-zone-settings", async () => {
    const h = harness();
    assert.equal(await h.run(["zone", "apply", "staging", "--only", "settings"]), 1);
    assert.equal(h.cf.writes().length, 0);
    assert.equal(
      await h.run([
        "zone",
        "apply",
        "staging",
        "--only",
        "settings",
        "--allow-shared-zone-settings",
      ]),
      0,
    );
    const patched = h.cf.writes().map((c) => c.path.split("/").at(-1));
    assert.deepEqual(patched.sort(), [
      "0rtt",
      "always_use_https",
      "automatic_https_rewrites",
      "email_obfuscation",
      "min_tls_version",
      "ssl_automatic_mode",
    ]);
    assert.equal(h.cf.settings.get("always_use_https")?.value, "off");
  });

  it("holds the rate rule while the overlay has no threshold", async () => {
    const h = harness((o) => {
      o.thresholds = {};
    });
    await h.run(["zone", "apply", "staging", "--only", "rules", "--dry-run"]);
    assert.match(
      h.runtime.out(),
      /! create rule http_ratelimit\/fin_next_api_v4_rate .*held: the overlay has no thresholds.api-v4/,
    );
  });

  it("deletes a stale fin_next_ rule only with --confirm-delete, and never another product's", async () => {
    const h = harness();
    await h.run(["zone", "apply", "staging", "--only", "rules"]);
    const waf = [...h.cf.rulesets.values()].find((r) => r.phase === "http_request_firewall_custom");
    waf?.rules.push({
      id: "e".repeat(32),
      ref: "fin_next_old_rule",
      expression: "(true)",
      action: "block",
    });
    waf?.rules.push({ ...OTHER_PRODUCT_RULE, id: "b".repeat(32), action: "block" });
    assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.refused);
    assert.match(h.runtime.err(), /--confirm-delete 1/);
    assert.equal(
      await h.run(["zone", "apply", "staging", "--only", "rules", "--confirm-delete", "1"]),
      EXIT.ok,
    );
    assert.equal(
      waf?.rules.some((r) => r.ref === "fin_next_old_rule"),
      false,
    );
    assert.equal(
      waf?.rules.some((r) => r.ref === "legacy_redirect"),
      true,
    );
  });
});

describe("the zone rules", () => {
  const proofs = new Map(
    ["api", "console", "admin", "verify", "selfie"].map((r) => [
      r as "api",
      new Secret("p".repeat(43)),
    ]),
  );
  const pair = (role: string, label: string) => ({
    role: role as "console",
    host: `${label}.${ZONE}`,
  });
  const rules = desiredRules({
    hosts: {
      browser: [
        pair("console", "console"),
        pair("admin", "staff"),
        pair("verify", "onboard"),
        pair("selfie", "selfie"),
        pair("docs", "docs"),
      ],
      apiPaths: [
        pair("console", "console"),
        pair("admin", "staff"),
        pair("verify", "onboard"),
        pair("selfie", "selfie"),
      ],
      api: `gateway.${ZONE}`,
    },
    proofs,
    rate: { pathPrefix: "/v4/", periodSeconds: 10, mitigationTimeoutSeconds: 10, threshold: 100 },
  });
  const byRef = (ref: string) => rules.find((r) => r.ref === ref);

  it("keeps the API host out of the plain-http rules ([FD-03])", () => {
    assert.doesNotMatch(byRef("fin_next_https_browser_hosts")?.expression ?? "", /gateway/);
    assert.doesNotMatch(byRef("fin_next_http_unsafe_block")?.expression ?? "", /gateway/);
    assert.match(
      byRef("fin_next_http_unsafe_block")?.expression ?? "",
      /not http.request.method in \{"GET" "HEAD"\}/,
    );
  });

  it("refuses the BD-13 path shapes on the raw path of the browser hosts", () => {
    const e = byRef("fin_next_path_refuse")?.expression ?? "";
    for (const piece of [
      'contains ".."',
      'contains "//"',
      'contains "%2f"',
      'contains "\\\\"',
      'contains ";"',
      'ends_with(lower(raw.http.request.uri.path), ".map")',
    ]) {
      assert.ok(e.includes(piece), piece);
    }
    assert.ok(
      e.startsWith(
        `(${hostIn([`console.${ZONE}`, `docs.${ZONE}`, `onboard.${ZONE}`, `selfie.${ZONE}`, `staff.${ZONE}`])}`,
      ),
    );
  });

  it("sends proofs on /api/ of the app hosts and on the whole API host", () => {
    assert.equal(
      byRef("fin_next_ingress_proof_api")?.expression,
      `(http.host eq "gateway.${ZONE}")`,
    );
    assert.match(
      byRef("fin_next_ingress_proof_console")?.expression ?? "",
      /starts_with\(http.request.uri.path, "\/api\/"\)/,
    );
    assert.equal(
      rules.some((r) => r.ref === "fin_next_ingress_proof_docs"),
      false,
      "the docs host has no /api/",
    );
  });

  it("limits the rate rule to the API host's /v4/ (the zone is shared)", () => {
    const r = byRef("fin_next_api_v4_rate");
    assert.equal(
      r?.expression,
      `(http.host eq "gateway.${ZONE}" and starts_with(http.request.uri.path, "/v4/"))`,
    );
    assert.deepEqual(r?.ratelimit, {
      characteristics: ["cf.colo.id", "ip.src"],
      period: 10,
      requests_per_period: 100,
      mitigation_timeout: 10,
    });
  });

  it("sets no-store on HTML answers under /assets/ (BD-12) and bypasses the cache for API traffic", () => {
    assert.match(
      byRef("fin_next_assets_html_no_store")?.expression ?? "",
      /http.response.content_type.media_type eq "text\/html"/,
    );
    assert.deepEqual(byRef("fin_next_api_bypass_cache")?.action_parameters, { cache: false });
    assert.deepEqual(byRef("fin_next_api_no_challenge")?.action_parameters, {
      bic: false,
      security_level: "essentially_off",
    });
  });

  it("refuses a hostname that is not a hostname inside an expression", () => {
    assert.throws(() => hostIn(['evil" or true or "x']), /only hostnames/);
  });
});
