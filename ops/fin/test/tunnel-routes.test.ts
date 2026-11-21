import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXIT } from "../src/core/errors.ts";
import { uuid, ZONE } from "./helpers/fixtures.ts";
import { harness } from "./helpers/setup.ts";

const _ZONE_PATH = `/zones/${"2".repeat(32)}`;

describe("tunnel create", () => {
  it("creates a locally managed tunnel and sets its token sealed on its own connector only", async () => {
    const h = harness();
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.ok);
    assert.deepEqual(
      h.cf.tunnels.map((t) => [t.name, t.config_src]),
      [["fin-next-staging-public", "local"]],
    );
    assert.equal(h.rw.patches.length, 1);
    const patch = h.rw.patches[0];
    assert.equal(h.rw.nameOf(patch?.serviceId ?? ""), "cloudflared-public");
    assert.equal(patch?.variables.TUNNEL_TOKEN?.isSealed, true);
    assert.equal(patch?.variables.FIN_TUNNEL_ROLE?.value, "public");
    assert.equal(patch?.variables.FIN_TUNNEL_ROLE?.isSealed, undefined);
    const hosts = JSON.parse(patch?.variables.FIN_TUNNEL_HOSTS?.value ?? "{}");
    assert.deepEqual(hosts, {
      api: `gateway.${ZONE}`,
      console: `console.${ZONE}`,
      verify: `onboard.${ZONE}`,
      selfie: `selfie.${ZONE}`,
    });
    assert.equal("docs" in hosts, false, "the docs host has no ingress rule");
    const token = patch?.variables.TUNNEL_TOKEN?.value ?? "";
    assert.ok(token.length > 20);
    h.assertNoLeak([token, h.cf.tunnels[0]?.id ?? ""]);
    assert.match(h.runtime.out(), /<tunnel:public>|create tunnel fin-next-staging-public/);
  });

  it("re-running keeps the tunnel and sets the same token again", async () => {
    const h = harness();
    await h.run(["tunnel", "create", "staging", "admin"]);
    await h.run(["tunnel", "create", "staging", "admin"]);
    assert.equal(h.cf.tunnels.length, 1);
    assert.equal(h.rw.patches.length, 2);
    assert.equal(h.rw.nameOf(h.rw.patches[1]?.serviceId ?? ""), "cloudflared-admin");
  });

  it("refuses a remotely managed tunnel", async () => {
    const h = harness();
    h.cf.tunnels.push({
      id: uuid("4"),
      name: "fin-next-staging-public",
      config_src: "cloudflare",
      deleted_at: null,
    });
    assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.refused);
    assert.match(h.runtime.err(), /remotely managed/);
    assert.equal(h.cf.writes().length, 0);
    assert.equal(h.rw.patches.length, 0);
  });

  it("dry run: sends nothing and fetches no token", async () => {
    const h = harness();
    assert.equal(await h.run(["tunnel", "create", "staging", "public", "--dry-run"]), 1);
    assert.equal(h.cf.writes().length, 0);
    assert.equal(
      h.cf.calls.some((c) => c.path.endsWith("/token")),
      false,
    );
    assert.equal(h.rw.patches.length, 0);
  });

  it("never prints a prefix of the tunnel token when a long Railway error echoes it", async () => {
    const h = harness();
    // The fake's token for the first tunnel: "eyJ" + 30 "T" + the start of the tunnel ID.
    const token = `eyJ${"T".repeat(30)}3333`;
    for (const cut of [5, 12, 20, 30]) {
      h.rw.failPatch = `${"x".repeat(400 - cut)}${token} was rejected in ${token}`;
      assert.equal(await h.run(["tunnel", "create", "staging", "public"]), EXIT.unavailable);
    }
    const text = h.readable();
    assert.equal(text.includes("eyJTTT"), false, "a prefix of the token survived the cut");
    assert.equal(h.cf.tunnels.length, 1);
  });

  it("refuses an unknown tunnel role", async () => {
    const h = harness();
    assert.equal(await h.run(["tunnel", "create", "staging", "db"]), EXIT.usage);
  });
});

async function withTunnels() {
  const h = harness();
  await h.run(["tunnel", "create", "staging", "public"]);
  await h.run(["tunnel", "create", "staging", "admin"]);
  h.cf.calls.length = 0;
  h.sequence.length = 0;
  return h;
}

describe("routes apply", () => {
  it("writes the Workers routes first, then the proxied CNAMEs, never /api* and nothing on the API host", async () => {
    const h = await withTunnels();
    h.cf.routes.push({ id: "a".repeat(32), pattern: `legacy.${ZONE}/*`, script: "other-product" });
    assert.equal(await h.run(["routes", "apply", "staging"]), EXIT.ok);
    const patterns = h.cf.routes.map((r) => `${r.pattern} ${r.script ?? "-"}`).sort();
    assert.deepEqual(patterns, [
      `console.${ZONE}/* fin-next-staging-console-static`,
      `console.${ZONE}/api/* -`,
      `docs.${ZONE}/* fin-next-staging-docs-static`,
      `legacy.${ZONE}/* other-product`,
      `onboard.${ZONE}/* fin-next-staging-verify-static`,
      `onboard.${ZONE}/api/* -`,
      `selfie.${ZONE}/* fin-next-staging-selfie-static`,
      `selfie.${ZONE}/api/* -`,
      `staff.${ZONE}/* fin-next-staging-admin-static`,
      `staff.${ZONE}/api/* -`,
    ]);
    for (const r of h.cf.routes) assert.doesNotMatch(r.pattern, /\/api\*$/);
    const writes = h.sequence.filter((c) => !c.startsWith("cf GET"));
    const lastRoute = writes.map((c) => c.includes("/workers/routes")).lastIndexOf(true);
    const firstDns = writes.findIndex((c) => c.includes("/dns_records"));
    assert.ok(firstDns > lastRoute, "the DNS records come after the routes");
    const pub = h.cf.tunnels.find((t) => t.name.endsWith("public"))?.id;
    const adm = h.cf.tunnels.find((t) => t.name.endsWith("admin"))?.id;
    const dns = Object.fromEntries(
      h.cf.dns.map((r) => [r.name, `${r.type} ${r.content} ${r.proxied}`]),
    );
    assert.deepEqual(dns, {
      [`gateway.${ZONE}`]: `CNAME ${pub}.cfargotunnel.com true`,
      [`console.${ZONE}`]: `CNAME ${pub}.cfargotunnel.com true`,
      [`onboard.${ZONE}`]: `CNAME ${pub}.cfargotunnel.com true`,
      [`selfie.${ZONE}`]: `CNAME ${pub}.cfargotunnel.com true`,
      [`docs.${ZONE}`]: `CNAME ${pub}.cfargotunnel.com true`,
      [`staff.${ZONE}`]: `CNAME ${adm}.cfargotunnel.com true`,
    });
    h.assertNoLeak([pub ?? "", adm ?? ""]);
    assert.match(h.runtime.out(), /<tunnel:public>\.cfargotunnel\.com/);
  });

  it("deletes a stray route on a Fin host only with --confirm-delete, and holds a name another record type holds", async () => {
    const h = await withTunnels();
    h.cf.routes.push({ id: "b".repeat(32), pattern: `gateway.${ZONE}/*`, script: "something" });
    h.cf.dns.push({ id: "c".repeat(32), type: "A", name: `docs.${ZONE}`, content: "192.0.2.1" });
    assert.equal(await h.run(["routes", "apply", "staging"]), EXIT.refused);
    assert.equal(h.cf.writes().length, 0);
    assert.equal(await h.run(["routes", "apply", "staging", "--confirm-delete", "1"]), 1);
    assert.equal(
      h.cf.routes.some((r) => r.pattern.startsWith("gateway.")),
      false,
    );
    assert.match(h.runtime.out(), /! update dns <host:docs> .*held: a A record holds this name/);
    assert.equal(h.cf.dns.filter((r) => r.name === `docs.${ZONE}`).length, 1);
  });

  it("refuses, and leaves alone, another product's wildcard route that captures a Fin host", async () => {
    for (const pattern of [`*.${ZONE}/*`, `*gateway.${ZONE}/*`, `*${ZONE}/api/*`]) {
      const h = await withTunnels();
      h.cf.routes.push({ id: "d".repeat(32), pattern, script: "other-product-worker" });
      assert.equal(await h.run(["routes", "apply", "staging"]), EXIT.refused, pattern);
      assert.match(h.runtime.err(), /another route .* matches .*; resolve it by hand/);
      assert.equal(h.cf.writes().length, 0);
      assert.deepEqual(
        h.cf.routes.map((r) => r.pattern),
        [pattern],
      );
      h.assertNoLeak();
    }
    // A wildcard that matches none of Fin's hosts is the other product's business.
    const h = await withTunnels();
    h.cf.routes.push({ id: "d".repeat(32), pattern: `*legacy.${ZONE}/*`, script: "other" });
    assert.equal(await h.run(["routes", "apply", "staging"]), EXIT.ok);
  });

  it("deletes a stale route on a Fin host whatever its path, before any DNS write", async () => {
    const h = await withTunnels();
    h.cf.routes.push({ id: "e".repeat(32), pattern: `console.${ZONE}/api*`, script: "old" });
    h.cf.routes.push({ id: "f".repeat(32), pattern: `console.${ZONE}/old/*` });
    assert.equal(await h.run(["routes", "apply", "staging", "--confirm-delete", "2"]), EXIT.ok);
    assert.equal(
      h.cf.routes.some((r) => r.pattern.endsWith("/api*") || r.pattern.endsWith("/old/*")),
      false,
    );
    assert.equal(h.cf.dns.length, 6);
    assert.equal(h.records().at(-1)?.result, "ok");
  });

  it("names no DNS record ID when Cloudflare refuses a record write", async () => {
    const h = await withTunnels();
    const id = "9a8b7c6d".repeat(4); // built at run time: no ID-shaped literal in a tracked file
    h.cf.dns.push({
      id,
      type: "CNAME",
      name: `console.${ZONE}`,
      content: "old.example.net",
      meta: { read_only: true },
    });
    assert.equal(await h.run(["routes", "apply", "staging"]), EXIT.unavailable);
    assert.match(h.runtime.err(), /answered 400/);
    assert.equal(h.readable().includes(id), false);
    h.assertNoLeak();
  });

  it("refuses to run before the tunnels exist", async () => {
    const h = harness();
    assert.equal(await h.run(["routes", "apply", "staging"]), EXIT.config);
    assert.match(h.runtime.err(), /pnpm fin tunnel create staging public/);
  });

  it("is idempotent", async () => {
    const h = await withTunnels();
    await h.run(["routes", "apply", "staging"]);
    const writes = h.cf.writes().length;
    assert.equal(await h.run(["routes", "apply", "staging"]), EXIT.ok);
    assert.equal(h.cf.writes().length, writes);
  });
});
