import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tokenBody } from "../src/cloudflare/email.ts";
import { EXIT } from "../src/core/errors.ts";
import { ACCOUNT_ID, uuid, ZONE } from "./helpers/fixtures.ts";
import { harness } from "./helpers/setup.ts";

interface TokenBody {
  name: string;
  policies: Array<{ permission_groups: unknown; resources: Record<string, string> }>;
  condition: { request_ip: { in: string[] } };
  not_before: string;
  expires_on: string;
}

describe("access apply", () => {
  it("creates the policy, then one self-hosted application over the whole staff host", async () => {
    const h = harness();
    assert.equal(await h.run(["access", "apply", "staging"]), EXIT.ok);
    assert.equal(h.cf.policies.length, 1);
    const policy = h.cf.policies[0];
    assert.equal(policy?.name, "fin-next-staging-staff");
    assert.equal(policy?.decision, "allow");
    assert.deepEqual(policy?.include, [
      { email: { email: "staff.member@example.com" } },
      { email_domain: { domain: "example.org" } },
    ]);
    assert.equal(h.cf.apps.length, 1);
    const app: Record<string, unknown> = h.cf.apps[0] ?? {};
    assert.equal(app.type, "self_hosted");
    assert.equal(app.domain, `staff.${ZONE}`);
    assert.deepEqual(app.destinations, [{ type: "public", uri: `staff.${ZONE}` }]);
    assert.equal(app.session_duration, "8h");
    assert.equal(app.app_launcher_visible, false);
    assert.equal(app.http_only_cookie_attribute, true);
    assert.equal(app.same_site_cookie_attribute, "lax");
    assert.equal(app.enable_binding_cookie, true);
    assert.deepEqual(app.allowed_idps, [uuid("1")]);
    assert.deepEqual(app.policies, [{ id: policy?.id, precedence: 1 }]);
    const order = h.sequence.filter((c) => c.startsWith("cf POST")).map((c) => c.split("/").at(-1));
    assert.deepEqual(order, ["policies", "apps"]);
    h.assertNoLeak([String(app.aud)]);
  });

  it("is idempotent, and updates the include when the overlay's list changes", async () => {
    const h = harness();
    await h.run(["access", "apply", "staging"]);
    const before = h.cf.writes().length;
    assert.equal(await h.run(["access", "apply", "staging"]), EXIT.ok);
    assert.equal(h.cf.writes().length, before);
    const h2 = harness((o) => {
      (o.access as { staff: string[] }).staff = ["staff.member@example.com", "second@example.com"];
    });
    h2.cf.policies.push(...h.cf.policies);
    h2.cf.apps.push(...h.cf.apps);
    assert.equal(await h2.run(["access", "apply", "staging"]), EXIT.ok);
    assert.equal(h2.cf.writes().length, 1);
    assert.match(h2.runtime.out(), /~ update access-policy fin-next-staging-staff \[include\]/);
  });

  it("refuses when another application covers the host, and never creates a login method", async () => {
    const h = harness();
    h.cf.apps.push({ id: uuid("2"), name: "someone-else", domain: `staff.${ZONE}` });
    assert.equal(await h.run(["access", "apply", "staging"]), EXIT.refused);
    const h2 = harness();
    h2.cf.idps = [];
    assert.equal(await h2.run(["access", "apply", "staging"]), EXIT.config);
    assert.match(h2.runtime.err(), /never creates one/);
    assert.equal(h2.cf.writes().length, 0);
  });

  it("refuses any other application that covers the staff host, by a path, a destination or a wildcard", async () => {
    const covering: Array<Record<string, unknown>> = [
      {
        domain: `staff.${ZONE}/assets`,
        destinations: [{ type: "public", uri: `staff.${ZONE}/assets` }],
      },
      { domain: `STAFF.${ZONE}/api/*` },
      { domain: `https://staff.${ZONE}` },
      {
        domain: `legacy.${ZONE}`,
        destinations: [
          { type: "public", uri: `legacy.${ZONE}` },
          { type: "public", uri: `staff.${ZONE}` },
        ],
      },
      { domain: `legacy.${ZONE}`, self_hosted_domains: [`legacy.${ZONE}`, `staff.${ZONE}/x`] },
      { domain: `*.${ZONE}` },
      { domain: `*staff.${ZONE}` },
    ];
    for (const shape of covering) {
      const h = harness();
      h.cf.apps.push({ id: uuid("2"), name: "someone-else-bypass", type: "self_hosted", ...shape });
      assert.equal(
        await h.run(["access", "apply", "staging"]),
        EXIT.refused,
        JSON.stringify(shape),
      );
      assert.match(h.runtime.err(), /another Access application \(someone-else-bypass\)/);
      assert.equal(h.cf.writes().length, 0);
    }
    // A bookmark only links, and an application on another host does not cover this one.
    const h = harness();
    h.cf.apps.push({ id: uuid("2"), name: "a-link", type: "bookmark", domain: `staff.${ZONE}` });
    h.cf.apps.push({
      id: uuid("3"),
      name: "other",
      type: "self_hosted",
      domain: `staffing.${ZONE}`,
    });
    assert.equal(await h.run(["access", "apply", "staging"]), EXIT.ok);
  });

  it("keeps the owner's MFA and other settings when it updates the application or the policy", async () => {
    const h = harness();
    await h.run(["access", "apply", "staging"]);
    const mfa = { allowed_authenticators: ["totp", "biometrics"], session_duration: "8h" };
    const app = h.cf.apps[0] as Record<string, unknown>;
    const policy = h.cf.policies[0] as Record<string, unknown>;
    app.mfa_config = mfa;
    app.session_duration = "24h";
    app.tags = ["owner-tag"];
    policy.mfa_config = mfa;
    policy.approval_required = true;
    const h2 = harness((o) => {
      (o.access as { staff: string[] }).staff = ["staff.member@example.com", "second@example.com"];
    });
    h2.cf.policies.push(...h.cf.policies);
    h2.cf.apps.push(...h.cf.apps);
    assert.equal(await h2.run(["access", "apply", "staging"]), EXIT.ok);
    const puts = h2.cf.writes().filter((c) => c.method === "PUT");
    assert.equal(puts.length, 2);
    const after = h2.cf.apps[0] as Record<string, unknown>;
    assert.equal(after.session_duration, "8h");
    assert.deepEqual(after.mfa_config, mfa);
    assert.deepEqual(after.tags, ["owner-tag"]);
    const afterPolicy = h2.cf.policies[0] as Record<string, unknown>;
    assert.deepEqual(afterPolicy.mfa_config, mfa);
    assert.equal(afterPolicy.approval_required, true);
    assert.equal((afterPolicy.include as unknown[]).length, 3);
    for (const put of puts) {
      const body = put.body as Record<string, unknown>;
      for (const key of ["id", "aud", "created_at", "updated_at"]) assert.equal(key in body, false);
    }
  });

  it("puts back the settings that would open the application, which it reported as unchanged", async () => {
    const h = harness();
    await h.run(["access", "apply", "staging"]);
    const app = h.cf.apps[0] as Record<string, unknown>;
    app.options_preflight_bypass = true;
    app.allow_authenticate_via_warp = true;
    app.cors_headers = { allow_all_origins: true, allow_credentials: true };
    app.self_hosted_domains = [`staff.${ZONE}`, `legacy.${ZONE}`];
    assert.equal(await h.run(["access", "apply", "staging", "--dry-run"]), 1);
    assert.match(
      h.runtime.out(),
      /~ update access-app fin-next-staging-admin \[allow_authenticate_via_warp, cors_headers, options_preflight_bypass, self_hosted_domains\]/,
    );
    assert.equal(await h.run(["access", "apply", "staging"]), EXIT.ok);
    const after = h.cf.apps[0] as Record<string, unknown>;
    assert.equal(after.options_preflight_bypass, false);
    assert.equal(after.allow_authenticate_via_warp, false);
    assert.equal("cors_headers" in after, false);
    assert.equal("self_hosted_domains" in after, false, "re-derived from the destinations");
    assert.equal(await h.run(["access", "apply", "staging"]), EXIT.ok);
    assert.match(h.runtime.out(), /= keep access-app fin-next-staging-admin/);
  });

  it("refuses an overlay that would admit nobody", async () => {
    const h = harness((o) => {
      o.access = { staff: [], allowDomains: [] };
    });
    assert.equal(await h.run(["access", "apply", "staging"]), EXIT.config);
  });
});

describe("email domains", () => {
  it("onboards both subdomains with preview and drop-suppressed off, and holds DMARC without a report address", async () => {
    const h = harness();
    assert.equal(await h.run(["email", "domains", "staging"]), 1);
    assert.deepEqual(
      h.cf.sending.map((d) => [d.name, d.preview_enabled, d.drop_suppressed_recipients]),
      [
        [`auth.${ZONE}`, false, false],
        [`notify.${ZONE}`, false, false],
      ],
    );
    assert.match(
      h.runtime.out(),
      /! create dmarc _dmarc.<email:auth> .*held: the overlay has no dmarc.rua/,
    );
    assert.equal(h.cf.dns.length, 0);
  });

  it("writes the environment's policy with aggregate reports on the subdomains' own records, never the zone's", async () => {
    const h = harness((o) => {
      (o.dmarc as Record<string, unknown>).rua = "mailto:reports@example.net";
    });
    h.cf.dns.push({
      id: "a".repeat(32),
      type: "TXT",
      name: `_dmarc.auth.${ZONE}`,
      content: '"v=DMARC1; p=reject;"',
    });
    h.cf.dns.push({
      id: "b".repeat(32),
      type: "TXT",
      name: `_dmarc.${ZONE}`,
      content: "v=DMARC1; p=quarantine",
    });
    assert.equal(await h.run(["email", "domains", "staging"]), EXIT.ok);
    const dmarc = Object.fromEntries(h.cf.dns.map((r) => [r.name, r.content]));
    // Staging's policy is p=reject ([BD-17]), which the overlay's dmarc.policy must equal.
    assert.equal(
      dmarc[`_dmarc.auth.${ZONE}`],
      "v=DMARC1; p=reject; rua=mailto:reports@example.net",
    );
    assert.equal(
      dmarc[`_dmarc.notify.${ZONE}`],
      "v=DMARC1; p=reject; rua=mailto:reports@example.net",
    );
    assert.equal(
      dmarc[`_dmarc.${ZONE}`],
      "v=DMARC1; p=quarantine",
      "the zone's own DMARC is untouched",
    );
    assert.equal(
      h.cf.writes().some((c) => JSON.stringify(c.body ?? "").includes(`"_dmarc.${ZONE}"`)),
      false,
    );
  });

  it("refuses a DMARC label that would be the zone's own", async () => {
    const h = harness((o) => {
      (o.dmarc as { records: string[] }).records = ["_dmarc"];
      (o.allowedNames as { labels: string[] }).labels.push("_dmarc");
      (o.neverTouch as { labels: string[] }).labels = ["www"];
    });
    assert.equal(await h.run(["email", "domains", "staging"]), EXIT.refused);
    assert.match(h.runtime.err(), /never written/);
  });
});

describe("email token", () => {
  it("mints one IP-filtered, account-only, 180-day token and sets it sealed on worker", async () => {
    const h = harness();
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    const mint = h.cf.writes().find((c) => c.path.endsWith("/tokens"));
    const body = mint?.body as TokenBody;
    assert.equal(body.name, "fin-next-staging-email");
    assert.equal(body.policies.length, 1);
    assert.deepEqual(body.policies[0]?.permission_groups, [{ id: "6".repeat(32) }]);
    assert.deepEqual(Object.keys(body.policies[0]?.resources ?? {}), [
      `com.cloudflare.api.account.${ACCOUNT_ID}`,
    ]);
    assert.deepEqual(body.condition, {
      request_ip: { in: ["203.0.113.10/32", "203.0.113.11/32"] },
    });
    const days = (Date.parse(body.expires_on) - Date.parse(body.not_before)) / 86_400_000;
    assert.equal(days, 180);
    const patch = h.rw.patches[0];
    assert.equal(h.rw.nameOf(patch?.serviceId ?? ""), "worker");
    assert.equal(patch?.variables.FIN_EMAIL_TOKEN?.isSealed, true);
    assert.equal(patch?.variables.FIN_EMAIL_FROM?.value, `account-security@auth.${ZONE}`);
    h.assertNoLeak([patch?.variables.FIN_EMAIL_TOKEN?.value ?? "", "203.0.113.10"]);
  });

  it("keeps an existing token, and with --rotate mints, sets, and only then revokes the old one", async () => {
    const h = harness();
    await h.run(["email", "token", "staging"]);
    const first = h.cf.tokens[0]?.id;
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    assert.equal(h.cf.tokens.length, 1);
    h.sequence.length = 0;
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.ok);
    assert.equal(h.cf.tokens.length, 1);
    assert.notEqual(h.cf.tokens[0]?.id, first);
    const writes = h.sequence.filter(
      (c) => c.startsWith("cf POST") || c.startsWith("cf DELETE") || c === "rw finPatch",
    );
    assert.deepEqual(
      writes.map((c) => c.split(" ").slice(0, 2).join(" ")),
      ["cf POST", "rw finPatch", "cf DELETE"],
    );
  });

  it("names the revoked tokens by ordinal, never by any part of their ID", async () => {
    const h = harness();
    await h.run(["email", "token", "staging"]);
    const old = h.cf.tokens[0]?.id ?? "";
    assert.equal(await h.run(["email", "token", "staging", "--rotate"]), EXIT.ok);
    assert.match(h.runtime.out(), /~ update token-revoke fin-next-staging-email #1/);
    const text = h.readable();
    assert.equal(text.includes(old), false);
    assert.equal(text.includes(`(${old.slice(0, 6)})`), false);
  });

  it("replaces a token that was minted but never set on worker, without --rotate", async () => {
    const h = harness();
    h.rw.failPatch = "the environment is locked";
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.unavailable);
    assert.equal(h.cf.tokens.length, 1);
    assert.equal(h.rw.patches.length, 0);
    const orphan = h.cf.tokens[0]?.id;
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    assert.match(h.runtime.out(), /never set on worker/);
    assert.equal(h.rw.patches.length, 1, "the new token is set");
    assert.equal(h.cf.tokens.length, 1, "the orphan is revoked");
    assert.notEqual(h.cf.tokens[0]?.id, orphan);
    // Once set, a plain run keeps it.
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    assert.equal(h.cf.tokens.length, 1);
    assert.equal(h.rw.patches.length, 1);
  });

  it("replaces a token that is no longer active, without --rotate", async () => {
    const h = harness();
    await h.run(["email", "token", "staging"]);
    const first = h.cf.tokens[0];
    if (first === undefined) throw new Error("no token");
    first.status = "expired";
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    assert.match(h.runtime.out(), /is expired/);
    assert.equal(h.cf.tokens.length, 1);
    assert.notEqual(h.cf.tokens[0]?.id, first.id);
    assert.equal(h.rw.patches.length, 2);
  });

  it("never mints without an IP filter", async () => {
    const h = harness((o) => {
      o.staticEgress = {};
    });
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.config);
    assert.match(h.runtime.err(), /never minted without its IP filter/);
    assert.equal(h.cf.writes().length, 0);
  });

  it("reads the egress from Railway when the overlay has none", async () => {
    const h = harness((o) => {
      o.staticEgress = {};
    });
    h.rw.egress.set("worker", ["198.51.100.7"]);
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok);
    const body = h.cf.writes().find((c) => c.path.endsWith("/tokens"))?.body as TokenBody;
    assert.deepEqual(body.condition.request_ip.in, ["198.51.100.7/32"]);
  });

  it("reads worker's egress from Railway when the overlay lists only other services' addresses", async () => {
    const h = harness((o) => {
      o.staticEgress = { api: ["198.51.100.5"], "cloudflared-public": ["198.51.100.6"] };
    });
    h.rw.egress.set("worker", ["198.51.100.7"]);
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
    const body = h.cf.writes().find((c) => c.path.endsWith("/tokens"))?.body as TokenBody;
    assert.deepEqual(body.condition.request_ip.in, ["198.51.100.7/32"]);
  });

  it("filters the token to worker's own addresses when the overlay lists other services' too", async () => {
    const h = harness((o) => {
      o.staticEgress = { worker: ["203.0.113.10"], api: ["198.51.100.5"] };
    });
    assert.equal(await h.run(["email", "token", "staging"]), EXIT.ok, h.runtime.err());
    const body = h.cf.writes().find((c) => c.path.endsWith("/tokens"))?.body as TokenBody;
    assert.deepEqual(body.condition.request_ip.in, ["203.0.113.10/32"]);
  });

  it("builds the token body with whole-second times", () => {
    const body = tokenBody(
      "fin-next-staging-email",
      "x",
      "g",
      ["192.0.2.1"],
      new Date("2026-11-21T06:00:00.123Z"),
      180,
    );
    assert.equal(body.not_before, "2026-11-21T06:00:00Z");
    assert.equal(body.expires_on, "2027-05-20T06:00:00Z");
  });
});
