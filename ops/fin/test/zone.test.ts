import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desiredRules, hostIn } from "../src/cloudflare/rules.ts";
import { EXIT } from "../src/core/errors.ts";
import { Secret } from "../src/core/secret.ts";
import { hex, ZONE } from "./helpers/fixtures.ts";
import { FakeCloudflare, type Rule } from "./helpers/providers.ts";
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

  it("never writes the rate rule while the zone is shared ([FD-09])", async () => {
    const h = harness();
    await h.run(["zone", "apply", "staging", "--only", "rules", "--dry-run"]);
    assert.doesNotMatch(h.runtime.out(), /fin_next_api_v4_rate/);
    assert.match(h.runtime.out(), /rate rule: not written while the zone is shared/);
  });

  it("writes every required rule even when Cloudflare refuses a rate rule", async () => {
    const h = harness();
    h.cf.onRequest = (call) => {
      const body = call.body as { ratelimit?: unknown; rules?: Array<{ ratelimit?: unknown }> };
      const rate = body?.ratelimit !== undefined || body?.rules?.some((r) => r.ratelimit);
      return call.method === "POST" && rate
        ? FakeCloudflare.failure(400, 20120, "rate limiting rules cannot match on host")
        : undefined;
    };
    assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.ok);
    const refs = new Set(allRules(h).map((r) => r.ref));
    for (const ref of [
      "fin_next_api_no_challenge",
      "fin_next_api_bypass_cache",
      "fin_next_assets_html_no_store",
      "fin_next_path_refuse",
    ]) {
      assert.ok(refs.has(ref), ref);
    }
  });

  it("keeps the run log, the plan and the timestamps whole whatever the private threshold equals", async () => {
    // Each threshold equals a number the run itself writes: a log seq (10, 16), the plan's count
    // of creates (11 on the shared zone, 12 with the rate rule) and the month of every timestamp
    // (11). None of them may be rewritten, and the run log must stay readable and intact.
    const cases = [
      { shared: true, threshold: 10, creates: 11 },
      { shared: true, threshold: 11, creates: 11 },
      { shared: false, threshold: 12, creates: 12 },
      { shared: false, threshold: 16, creates: 12 },
    ];
    for (const { shared, threshold, creates } of cases) {
      const h = harness(
        (o) => {
          o.thresholds = { "api-v4": threshold };
        },
        (s) => {
          (s.zone as Record<string, unknown>).shared = shared;
        },
      );
      h.env.GITHUB_ACTIONS = "true";
      const label = `shared ${shared}, threshold ${threshold}`;
      assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.ok, label);
      assert.match(h.runtime.out(), new RegExp(`\\b${creates} to create\\b`), label);
      const records = h.records();
      assert.ok(records.length >= threshold, `${label}: the log reaches seq ${threshold}`);
      records.forEach((r, i) => {
        assert.equal(r.seq, i + 1, label);
        assert.match(String(r.at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, label);
      });
      assert.equal(records.at(-1)?.result, "ok", label);
      assert.equal(records.at(-1)?.steps, records.length - 2, label);
      assert.equal(await h.run(["log", "verify", "staging"]), EXIT.ok, label);
      const text = h.readable();
      assert.equal(text.includes("<threshold:"), false, `${label}: no number became a placeholder`);
      assert.equal(
        h.runtime.out().split("\n").includes(`::add-mask::${threshold}`),
        false,
        `${label}: the runner is never told to mask a short number`,
      );
    }
  });

  it("masks the private threshold in the provider errors of the rate rule's own writes", async () => {
    const echo = "the plan allows no more than 4321 requests here";
    // Not shared: the rate rule is written, and Cloudflare echoes its threshold in a refusal.
    const h = harness(
      (o) => {
        o.thresholds = { "api-v4": 4321 };
      },
      (s) => {
        (s.zone as Record<string, unknown>).shared = false;
      },
    );
    h.cf.onRequest = (call) => {
      const body = call.body as { ratelimit?: unknown; rules?: Array<{ ratelimit?: unknown }> };
      const rate = body?.ratelimit !== undefined || body?.rules?.some((r) => r.ratelimit);
      return rate ? FakeCloudflare.failure(400, 20120, echo) : undefined;
    };
    assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.unavailable);
    assert.match(h.runtime.err(), /no more than <threshold:api-v4> requests/);
    assert.equal(h.readable().includes("4321"), false);
    assert.equal(await h.run(["log", "verify", "staging"]), EXIT.ok);

    // Shared: a rate rule of Fin's left from before is deleted, and its refusal is masked too.
    const s = harness((o) => {
      o.thresholds = { "api-v4": 4321 };
    });
    await s.run(["zone", "apply", "staging", "--only", "rules"]);
    const old = {
      id: hex(32, "9"),
      phase: "http_ratelimit",
      rules: [
        {
          id: hex(32, "8"),
          ref: "fin_next_api_v4_rate",
          expression: `(http.host eq "gateway.${ZONE}")`,
          action: "block",
          ratelimit: { period: 10, requests_per_period: 4321, mitigation_timeout: 10 },
        },
      ],
    };
    s.cf.rulesets.set(old.id, old);
    s.cf.onRequest = (call) =>
      call.method === "DELETE" ? FakeCloudflare.failure(400, 20120, echo) : undefined;
    assert.equal(
      await s.run(["zone", "apply", "staging", "--only", "rules", "--confirm-delete", "1"]),
      EXIT.unavailable,
    );
    assert.match(s.runtime.err(), /no more than <threshold:api-v4> requests/);
    assert.equal(s.readable().includes("4321"), false);
    s.assertNoLeak();
  });

  it("masks a long provider error before it cuts it, so no part of a private value survives", async () => {
    const h = harness();
    // Cloudflare's rules engine echoes the expression it could not parse; the cut at 400
    // characters lands inside a hostname, after "onboard.zone.exa".
    for (const cut of [3, 8, 14]) {
      const echoed = `http.host in {"console.${ZONE}" "onboard.${ZONE}"}`;
      const at = echoed.indexOf(`onboard.${ZONE}`) + "onboard.".length + cut;
      const message = `${"y".repeat(400 - "20200 ".length - at)}${echoed}`;
      h.cf.onRequest = (call) =>
        call.method === "POST" ? FakeCloudflare.failure(400, 20200, message) : undefined;
      assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.unavailable);
    }
    const text = h.readable();
    for (let n = 6; n < ZONE.length; n++) {
      assert.equal(text.includes(ZONE.slice(0, n)), false, `a prefix of the zone: ${n} chars`);
    }
    h.assertNoLeak();
  });

  it("refuses while a proxied wildcard record would carry a proof to another origin", async () => {
    const h = harness();
    h.cf.dns.push({
      id: "a".repeat(32),
      type: "CNAME",
      name: `*.${ZONE}`,
      content: "legacy-origin.example.net",
      proxied: true,
    });
    assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.refused);
    assert.match(h.runtime.err(), /wildcard record \*\.<zone> answers for .*<host:api>/);
    assert.equal(h.cf.writes().length, 0);
    assert.equal(h.rw.patches.length, 0);
    h.assertNoLeak();
    // Once every proof host has a record of its own, the wildcard no longer answers for it.
    for (const label of ["gateway", "console", "staff", "onboard", "selfie"]) {
      h.cf.dns.push({
        id: hex(32, String(label.length)),
        type: "CNAME",
        name: `${label}.${ZONE}`,
        content: "t.cfargotunnel.com",
        proxied: true,
      });
    }
    assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.ok);
  });

  it("names no rule or rule set ID when Cloudflare refuses a rule write", async () => {
    const h = harness();
    await h.run(["zone", "apply", "staging", "--only", "rules"]);
    const waf = [...h.cf.rulesets.values()].find((r) => r.phase === "http_request_firewall_custom");
    const rule = waf?.rules.find((r) => r.ref === "fin_next_path_refuse");
    if (waf === undefined || rule === undefined) throw new Error("no WAF rule");
    rule.expression = "(false)";
    h.cf.onRequest = (call) =>
      call.method === "PATCH"
        ? FakeCloudflare.failure(400, 20021, `rule ${rule.id} cannot be changed`)
        : undefined;
    assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.unavailable);
    const text = h.readable();
    assert.equal(text.includes(rule.id), false, "the rule ID");
    assert.equal(text.includes(waf.id), false, "the rule set ID");
    assert.match(h.runtime.err(), /fin_next_path_refuse/);
  });

  it("deletes a stale rule whose ref is Fin's but not in today's spelling", async () => {
    const h = harness();
    await h.run(["zone", "apply", "staging", "--only", "rules"]);
    const waf = [...h.cf.rulesets.values()].find((r) => r.phase === "http_request_firewall_custom");
    waf?.rules.push({ id: "e".repeat(32), ref: "fin_next_Old-Rule", expression: "(true)" });
    assert.equal(
      await h.run(["zone", "apply", "staging", "--only", "rules", "--confirm-delete", "1"]),
      EXIT.ok,
    );
    assert.equal(
      waf?.rules.some((r) => r.ref === "fin_next_Old-Rule"),
      false,
    );
    assert.equal(h.records().at(-1)?.result, "ok");
  });

  it("holds the run lock while it plans, so an overlapping run cannot apply a stale plan", async () => {
    const h = harness();
    let overlapping: number | undefined;
    h.cf.onRequest = async () => {
      if (overlapping !== undefined) return undefined;
      overlapping = -1;
      overlapping = await h.run(["zone", "apply", "staging", "--only", "rules"]);
      return undefined;
    };
    assert.equal(await h.run(["zone", "apply", "staging", "--only", "rules"]), EXIT.ok);
    assert.equal(overlapping, EXIT.busy, "the second run finds the lock taken before it reads");
    assert.equal(h.rw.patches.length, 4, "one set of proofs, from one plan");
    const proof = allRules(h).find((r) => r.ref === "fin_next_ingress_proof_api");
    const headers = proof?.action_parameters?.headers as Record<string, { value: string }>;
    const edge = h.rw.patches.find((p) => h.rw.nameOf(p.serviceId) === "edge");
    assert.equal(
      JSON.parse(edge?.variables.FIN_INGRESS_PROOFS?.value ?? "{}").api[0],
      headers["Fin-Ingress-Proof"]?.value,
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
      'contains "%2e"',
      'contains "%2f"',
      'contains "%5c"',
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

  it("refuses every raw path the edge would normalise differently from the tunnel (BD-13, AC-P0-23)", () => {
    // Evaluates the rule's own path clauses: each `contains` on the raw path (lower-cased or not)
    // and the `.map` ending, as Cloudflare would on the raw path.
    const e = byRef("fin_next_path_refuse")?.expression ?? "";
    const raw = "raw\\.http\\.request\\.uri\\.path";
    const clauses = [
      ...e.matchAll(new RegExp(`(lower\\()?${raw}\\)? contains "((?:[^"\\\\]|\\\\.)*)"`, "g")),
    ].map((m) => ({
      lower: m[1] !== undefined,
      needle: (m[2] ?? "").replace(/\\(.)/g, "$1"),
    }));
    assert.ok(clauses.length >= 7);
    const refused = (path: string) =>
      clauses.some((c) => (c.lower ? path.toLowerCase() : path).includes(c.needle)) ||
      path.toLowerCase().endsWith(".map");
    for (const path of [
      "/x/../api/ping",
      "/x/%2e%2e/api/ping",
      "/x/%2E%2E/api/ping",
      "/x/.%2e/api/ping",
      "/x/%2e./api/ping",
      "/x//api/ping",
      "/x/%2F/api/ping",
      "/x\\api",
      "/x/%5C/api/ping",
      "/x;y",
      "/assets/app.js.map",
    ]) {
      assert.equal(refused(path), true, path);
    }
    for (const path of ["/", "/settings/keys", "/assets/app-3f2a.js", "/api/health", "/a.b/c"]) {
      assert.equal(refused(path), false, path);
    }
  });

  it("orders an optional rate rule after every required rule, and holds it without a threshold", () => {
    const withRate = desiredRules({
      hosts: {
        browser: [pair("console", "console")],
        apiPaths: [pair("console", "console")],
        api: `gateway.${ZONE}`,
      },
      proofs,
      rate: { pathPrefix: "/v4/", periodSeconds: 10, mitigationTimeoutSeconds: 10 },
    });
    assert.equal(withRate.at(-1)?.ref, "fin_next_api_v4_rate");
    assert.match(withRate.at(-1)?.held ?? "", /no thresholds.api-v4/);
    const shared = desiredRules({
      hosts: {
        browser: [pair("console", "console")],
        apiPaths: [pair("console", "console")],
        api: `gateway.${ZONE}`,
      },
      proofs,
    });
    assert.equal(
      shared.some((r) => r.phase === "http_ratelimit"),
      false,
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
