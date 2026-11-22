import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CloudflareApi,
  CloudflareWriter,
  maskedDetail,
  type WriteTarget,
} from "../src/cloudflare/api.ts";
import { RefusedError } from "../src/core/errors.ts";
import { Guard } from "../src/core/guard.ts";
import { Masker } from "../src/core/mask.ts";
import { Output } from "../src/core/output.ts";
import { type Overlay, parseOverlay } from "../src/core/overlay.ts";
import { Run } from "../src/core/run.ts";
import { RunLog } from "../src/core/runlog.ts";
import { Secret } from "../src/core/secret.ts";
import {
  ACCOUNT_ID,
  fakeRuntime,
  fakeToken,
  hex,
  overlayFixture,
  tempDir,
  uuid,
  ZONE,
  ZONE_ID,
} from "./helpers/fixtures.ts";
import { FakeCloudflare, type Rule } from "./helpers/providers.ts";

const overlay = parseOverlay(overlayFixture(), "staging");
const Z = `/zones/${ZONE_ID}`;
const A = `/accounts/${ACCOUNT_ID}`;
const CONSOLE = `console.${ZONE}`;

function ruleBody(ref: string, expression: string): Record<string, unknown> {
  return { ref, description: "d", expression, action: "block", enabled: true };
}

/** The fixture overlay with its static egress replaced. */
function withEgress(staticEgress: Record<string, string[]>): Overlay {
  return parseOverlay({ ...overlayFixture(), staticEgress }, "staging");
}

/** A guard bound to the overlay's zone, as a command has it after reading the zone (bindZone). */
function bound(ov: Overlay = overlay): Guard {
  const guard = new Guard(ov);
  guard.bindZone({ id: ZONE_ID, name: ZONE, account: { id: ACCOUNT_ID, name: "fixture" } });
  return guard;
}

function setup(dryRun = false, ov: Overlay = overlay) {
  const token = fakeToken("w");
  const cf = new FakeCloudflare(token);
  const runtime = fakeRuntime({ fetch: cf.fetch });
  const masker = new Masker();
  const run = new Run(
    runtime,
    new RunLog(join(tempDir(), "s"), masker),
    new Output(runtime, masker),
    {
      command: "test",
      environment: "staging",
      dryRun,
    },
  );
  const api = new CloudflareApi(new Secret(token), runtime, masker);
  const writer = new CloudflareWriter(api, bound(ov), run, ov, {
    settings: ["0rtt"],
    now: () => runtime.now(),
    tokenServices: { "fin-next-staging-email": "worker" },
    identityProvider: "onetimepin",
  });
  return { api, cf, run, runtime, writer };
}

/** A rule set the fake holds as a phase entrypoint, read through the API so the writer knows it. */
async function readEntrypoint(
  s: ReturnType<typeof setup>,
  id: string,
  phase: string,
  rules: Rule[] = [],
): Promise<void> {
  s.cf.rulesets.set(id, { id, phase, rules });
  await s.api.getOptional(`${Z}/rulesets/phases/${phase}/entrypoint`);
}

/** One of the account's tunnels, read through the API so the writer knows it; returns its ID. */
async function readTunnel(s: ReturnType<typeof setup>, name: string, seed = "3"): Promise<string> {
  const id = uuid(seed);
  s.cf.tunnels.push({ id, name, config_src: "local", deleted_at: null });
  await s.api.list(`${A}/cfd_tunnel`, { name });
  return id;
}

const APP: WriteTarget = {
  kind: "access-app",
  name: "fin-next-staging-admin",
  host: `staff.${ZONE}`,
  policy: "fin-next-staging-staff",
};

function refused(fn: () => void, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof RefusedError && pattern.test(e.message));
}

describe("the Cloudflare writer", () => {
  it("refuses every write outside a registered run, and in a dry run", async () => {
    const { cf, writer } = setup();
    await assert.rejects(
      writer.write({ kind: "dns", name: `console.${ZONE}` }, "POST", `${Z}/dns_records`, {}),
      /outside a registered run/,
    );
    const dry = setup(true);
    dry.run.register();
    await assert.rejects(
      dry.writer.write({ kind: "dns", name: `console.${ZONE}` }, "POST", `${Z}/dns_records`, {}),
      /dry run/,
    );
    assert.equal(cf.calls.length + dry.cf.calls.length, 0);
  });

  it("checks the target with the guard before anything is sent", async () => {
    const { cf, run, writer } = setup();
    run.register();
    await assert.rejects(
      writer.write({ kind: "dns", name: `legacy.${ZONE}` }, "POST", `${Z}/dns_records`, {}),
      RefusedError,
    );
    await assert.rejects(
      writer.write(
        { kind: "route", pattern: `console.${ZONE}/api*` },
        "POST",
        `${Z}/workers/routes`,
        {},
      ),
      RefusedError,
    );
    assert.equal(cf.calls.length, 0);
    run.finish("ok");
  });

  it("refuses a whole-phase replace, a foreign rule ref and a non-rule endpoint", async () => {
    const s = setup();
    const { run, writer } = s;
    run.register();
    const rs = hex(32, "3");
    await readEntrypoint(s, rs, "http_request_firewall_custom", [
      { id: hex(32, "4"), ref: "fin_next_x" },
    ]);
    const rule: WriteTarget = { kind: "rule", ref: "fin_next_x", hosts: [CONSOLE], rulesetId: rs };
    const body = ruleBody("fin_next_x", `(http.host eq "${CONSOLE}")`);
    refused(() => writer.check(rule, "PUT", `${Z}/rulesets/${rs}`, body), /never replaced whole/);
    refused(
      () =>
        writer.check(
          rule,
          "PUT",
          `${Z}/rulesets/phases/http_request_dynamic_redirect/entrypoint`,
          body,
        ),
      /never replaced whole/,
    );
    refused(
      () =>
        writer.check(
          { kind: "rule", ref: "legacy_redirect", hosts: [], rulesetId: rs, id: hex(32, "4") },
          "PATCH",
          `${Z}/rulesets/${rs}/rules/${hex(32, "4")}`,
          ruleBody("legacy_redirect", `(http.host eq "${CONSOLE}")`),
        ),
      /fin_next_/,
    );
    refused(() => writer.check(rule, "POST", `${Z}/rulesets/${rs}`, body), /per-rule endpoint/);
    refused(
      () =>
        writer.check(
          { kind: "ruleset", phase: "p", refs: ["fin_next_x"], hosts: [] },
          "PATCH",
          `${Z}/rulesets`,
          {},
        ),
      /only ever created/,
    );
    writer.check(rule, "POST", `${Z}/rulesets/${rs}/rules`, body);
    writer.check(
      { ...rule, id: hex(32, "4") },
      "DELETE",
      `${Z}/rulesets/${rs}/rules/${hex(32, "4")}`,
    );
  });

  it("checks what a write sends and which object it names, not only the label it is given", async () => {
    const s = setup();
    const { writer } = s;
    const tunnel = await readTunnel(s, "fin-next-staging-public");
    const id = hex(32, "6");
    s.cf.dns.push({ id, type: "CNAME", name: CONSOLE, content: "old.example.net", proxied: true });
    await s.api.list(`${Z}/dns_records`, { name: CONSOLE });
    const dns: WriteTarget = { kind: "dns", name: CONSOLE };
    const record = (name: string) => ({
      type: "CNAME",
      name,
      content: `${tunnel}.cfargotunnel.com`,
      proxied: true,
    });
    for (const name of [`www.${ZONE}`, `_dmarc.${ZONE}`, `*.${ZONE}`, `staff.${ZONE}`]) {
      refused(() => writer.check(dns, "POST", `${Z}/dns_records`, record(name)), /body names/);
    }
    // The bulk endpoints are not the records endpoint, and an ID-addressed write needs its ID.
    for (const word of ["batch", "import", "export", "scan"]) {
      refused(
        () =>
          writer.check(dns, "POST", `${Z}/dns_records/${word}`, {
            deletes: [{ id: hex(32, "5") }],
          }),
        /DNS records endpoint/,
      );
    }
    refused(() => writer.check(dns, "DELETE", `${Z}/dns_records/${id}`), /object it names/);
    refused(
      () =>
        writer.check(
          { kind: "dns", name: `console.${ZONE}`, id: hex(32, "7") },
          "PATCH",
          `${Z}/dns_records/${id}`,
          record(`console.${ZONE}`),
        ),
      /object it names/,
    );
    writer.check(
      { kind: "dns", name: `console.${ZONE}`, id },
      "PATCH",
      `${Z}/dns_records/${id}`,
      record(`console.${ZONE}`),
    );
    // A rule needs Fin's hosts in its expression, and only Fin's.
    const rs = hex(32, "3");
    await readEntrypoint(s, rs, "http_request_firewall_custom");
    const rule: WriteTarget = { kind: "rule", ref: "fin_next_x", hosts: [CONSOLE], rulesetId: rs };
    for (const expression of ["true", "(not ssl)", `(http.host eq "legacy.${ZONE}")`]) {
      refused(
        () =>
          writer.check(
            { ...rule, hosts: [] },
            "POST",
            `${Z}/rulesets/${rs}/rules`,
            ruleBody("fin_next_x", expression),
          ),
        /host/,
      );
    }
    refused(
      () =>
        writer.check(
          rule,
          "POST",
          `${Z}/rulesets/${rs}/rules`,
          ruleBody("fin_next_other", `(http.host eq "${CONSOLE}")`),
        ),
      /body names/,
    );
    // Routes: the body's pattern is the target's, and a Worker is one of Fin's own.
    const route: WriteTarget = { kind: "route", pattern: `${CONSOLE}/*` };
    refused(
      () => writer.check(route, "POST", `${Z}/workers/routes`, { pattern: `*${ZONE}/*` }),
      /body names/,
    );
    refused(
      () =>
        writer.check(route, "POST", `${Z}/workers/routes`, {
          pattern: `${CONSOLE}/*`,
          script: "other-product",
        }),
      /fin-next-staging-/,
    );
    // Access: every domain the body names is the staff host, and the policy is an Allow of a list.
    const app = APP;
    const appBody = (domain: string, uris: string[]) => ({
      name: "fin-next-staging-admin",
      type: "self_hosted",
      domain,
      destinations: uris.map((uri) => ({ type: "public", uri })),
    });
    refused(
      () => writer.check(app, "POST", `${A}/access/apps`, appBody(`*.${ZONE}`, [`*.${ZONE}`])),
      /names .* other than the staff host/,
    );
    refused(
      () =>
        writer.check(
          app,
          "POST",
          `${A}/access/apps`,
          appBody(`staff.${ZONE}`, [`staff.${ZONE}`, `legacy.${ZONE}`]),
        ),
      /names .* other than the staff host/,
    );
    const policy: WriteTarget = { kind: "access-policy", name: "fin-next-staging-staff" };
    refused(
      () =>
        writer.check(policy, "POST", `${A}/access/policies`, {
          name: "fin-next-staging-staff",
          decision: "allow",
          include: [{ everyone: {} }],
        }),
      /Everyone/,
    );
    refused(
      () =>
        writer.check(policy, "POST", `${A}/access/policies`, {
          name: "fin-next-staging-staff",
          decision: "bypass",
          include: [{ email: { email: "a@example.com" } }],
        }),
      /decision/,
    );
  });

  it("mints a token only for this account, its declared groups and, for email, an IP filter", async () => {
    const s = setup();
    const { writer } = s;
    await s.api.list(`${A}/tokens/permission_groups`);
    const group = { name: "Email Sending Write", id: hex(32, "6") };
    const target: WriteTarget = {
      kind: "token",
      name: "fin-next-staging-email",
      permissionGroups: [group],
    };
    const body = (resources: Record<string, string>, groups: string[], ip?: string[]) => ({
      name: "fin-next-staging-email",
      policies: [{ effect: "allow", resources, permission_groups: groups.map((id) => ({ id })) }],
      ...(ip === undefined ? {} : { condition: { request_ip: { in: ip } } }),
      expires_on: "2027-05-20T06:00:00Z",
    });
    const own = { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: "*" };
    const egress = "203.0.113.10/32";
    writer.check(target, "POST", `${A}/tokens`, body(own, [group.id], [egress]));
    refused(
      () =>
        writer.check(
          target,
          "POST",
          `${A}/tokens`,
          body({ "com.cloudflare.api.account.*": "*" }, [group.id], [egress]),
        ),
      /this account only/,
    );
    refused(
      () =>
        writer.check(target, "POST", `${A}/tokens`, body(own, [group.id, hex(32, "8")], [egress])),
      /permission groups/,
    );
    refused(() => writer.check(target, "POST", `${A}/tokens`, body(own, [group.id])), /IP filter/);
  });

  it("lets a script write only an assets-only upload, never a module, a binding, a delete or workers.dev", () => {
    const { writer } = setup();
    const script: WriteTarget = { kind: "script", name: "fin-next-staging-console-static" };
    const base = `${A}/workers/scripts/fin-next-staging-console-static`;
    const form = (metadata: unknown) => {
      const f = new FormData();
      f.set("metadata", JSON.stringify(metadata));
      return f;
    };
    refused(() => writer.check(script, "DELETE", base), /never deleted/);
    refused(
      () =>
        writer.check(script, "POST", `${base}/subdomain`, {
          enabled: true,
          previews_enabled: true,
        }),
      /workers.dev and previews off/,
    );
    writer.check(script, "POST", `${base}/subdomain`, { enabled: false, previews_enabled: false });
    refused(
      () => writer.check(script, "PUT", base, form({ main_module: "index.js", assets: {} })),
      /assets only/,
    );
    refused(
      () =>
        writer.check(
          script,
          "PUT",
          base,
          form({ assets: { jwt: "j" }, bindings: [{ type: "kv_namespace", name: "K" }] }),
        ),
      /assets only/,
    );
    const withModule = form({ assets: { jwt: "j" } });
    withModule.set("index.js", "export default {}");
    refused(() => writer.check(script, "PUT", base, withModule), /assets only/);
    writer.check(script, "PUT", base, form({ assets: { jwt: "j" }, compatibility_date: "x" }));
  });

  it("keeps the settings endpoint literal and the raw send private to the writer", () => {
    const token = fakeToken("w");
    const runtime = fakeRuntime({ fetch: new FakeCloudflare(token).fetch });
    const masker = new Masker();
    const run = new Run(
      runtime,
      new RunLog(join(tempDir(), "s"), masker),
      new Output(runtime, masker),
      { command: "test", environment: "staging", dryRun: false },
    );
    const api = new CloudflareApi(new Secret(token), runtime, masker);
    const writer = new CloudflareWriter(api, bound(), run, overlay, {
      settings: ["0rtt", "x|.*"],
      now: () => runtime.now(),
    });
    refused(
      () =>
        writer.check({ kind: "setting", id: "x|.*" }, "PATCH", `${Z}/dns_records`, { value: 1 }),
      /setting's endpoint/,
    );
    assert.equal(typeof (api as unknown as Record<string, unknown>).sendWrite, "undefined");
  });

  it("deletes a stale route on a Fin host or a stale fin_next_ rule whatever its spelling", async () => {
    const s = setup();
    const { writer } = s;
    const id = hex(32, "9");
    const old = hex(32, "a");
    s.cf.routes.push(
      { id, pattern: `${CONSOLE}/api*` },
      { id: old, pattern: `${CONSOLE}/old/*` },
      { id: hex(32, "b"), pattern: `legacy.${ZONE}/*` },
    );
    await s.api.list(`${Z}/workers/routes`);
    writer.check(
      { kind: "route", pattern: `${CONSOLE}/api*`, id },
      "DELETE",
      `${Z}/workers/routes/${id}`,
    );
    writer.check(
      { kind: "route", pattern: `${CONSOLE}/old/*`, id: old },
      "DELETE",
      `${Z}/workers/routes/${old}`,
    );
    refused(
      () =>
        writer.check(
          { kind: "route", pattern: `legacy.${ZONE}/*`, id: hex(32, "b") },
          "DELETE",
          `${Z}/workers/routes/${hex(32, "b")}`,
        ),
      /never-touch/,
    );
    refused(
      () =>
        writer.check({ kind: "route", pattern: `${CONSOLE}/api*` }, "POST", `${Z}/workers/routes`, {
          pattern: `${CONSOLE}/api*`,
        }),
      /\/api\*/,
    );
    const rs = hex(32, "3");
    await readEntrypoint(s, rs, "http_request_firewall_custom", [{ id, ref: "fin_next_Old-Rule" }]);
    writer.check(
      { kind: "rule", ref: "fin_next_Old-Rule", hosts: [], rulesetId: rs, id },
      "DELETE",
      `${Z}/rulesets/${rs}/rules/${id}`,
    );
    refused(
      () =>
        writer.check(
          { kind: "rule", ref: "legacy_rule", hosts: [], rulesetId: rs, id },
          "DELETE",
          `${Z}/rulesets/${rs}/rules/${id}`,
        ),
      /fin_next_/,
    );
  });

  it("refuses another zone or account in the path", () => {
    const { writer } = setup();
    refused(
      () =>
        writer.check(
          { kind: "dns", name: `console.${ZONE}` },
          "POST",
          `/zones/${hex(32, "9")}/dns_records`,
        ),
      /DNS records endpoint/,
    );
    refused(
      () =>
        writer.check(
          { kind: "tunnel", name: "fin-next-staging-public" },
          "POST",
          `/accounts/${hex(32, "9")}/cfd_tunnel`,
        ),
      /only ever created/,
    );
  });

  it("allows only listed settings, Fin's own names and mintable permission groups", () => {
    const { writer } = setup();
    writer.check({ kind: "setting", id: "0rtt" }, "PATCH", `${Z}/settings/0rtt`, { value: "off" });
    refused(
      () =>
        writer.check({ kind: "setting", id: "ssl" }, "PATCH", `${Z}/settings/ssl`, {
          value: "off",
        }),
      /not a setting/,
    );
    refused(
      () =>
        writer.check({ kind: "setting", id: "0rtt" }, "PATCH", `${Z}/settings/0rtt`, {
          value: "off",
          other: 1,
        }),
      /only its value/,
    );
    refused(
      () => writer.check({ kind: "tunnel", name: "someone-else" }, "POST", `${A}/cfd_tunnel`),
      /fin-next-staging-/,
    );
    refused(
      () =>
        writer.check(
          {
            kind: "token",
            name: "fin-next-staging-email",
            permissionGroups: [{ name: "Account Settings Write", id: hex(32, "8") }],
          },
          "POST",
          `${A}/tokens`,
        ),
      /not mintable/,
    );
    refused(
      () =>
        writer.check(
          { kind: "token", name: "fin-next-staging-email", permissionGroups: [] },
          "PUT",
          `${A}/tokens/${hex(32, "4")}`,
        ),
      /never edited/,
    );
    refused(() => writer.check(APP, "DELETE", `${A}/access/apps/x`), /never deleted/);
    refused(
      () =>
        writer.check(
          { kind: "email-domain", name: `auth.${ZONE}` },
          "DELETE",
          `${Z}/email/sending/subdomains/x`,
        ),
      /never removed/,
    );
  });

  it("sends the token only in the Authorization header, and a refusal never carries it", async () => {
    const s = setup();
    const { cf, run, writer } = s;
    const tunnel = await readTunnel(s, "fin-next-staging-public");
    const cname = {
      type: "CNAME",
      name: CONSOLE,
      content: `${tunnel}.cfargotunnel.com`,
      proxied: true,
    };
    run.register();
    await writer.write({ kind: "dns", name: CONSOLE }, "POST", `${Z}/dns_records`, cname);
    assert.equal(cf.dns.length, 1);
    // A record read, then removed by someone else: the PATCH reaches Cloudflare and gets a 404.
    const gone = hex(32, "0");
    cf.dns.push({ id: gone, type: "CNAME", name: CONSOLE, content: "old.example.net" });
    await s.api.list(`${Z}/dns_records`, { name: CONSOLE });
    cf.dns = cf.dns.filter((r) => r.id !== gone);
    try {
      await writer.write(
        { kind: "dns", name: CONSOLE, id: gone },
        "PATCH",
        `${Z}/dns_records/${gone}`,
        cname,
      );
      assert.fail("should fail");
    } catch (error) {
      assert.match(String(error), /answered 404/);
      assert.equal(String(error).includes(cf.token), false);
      assert.equal(String(error).includes(hex(32, "0")), false, "names no object ID");
    }
    run.finish("ok");
  });
});

describe("the IDs a write carries", () => {
  it("are ones a read showed in the write's collection under the target's name, pattern or ref", async () => {
    const s = setup();
    const { writer } = s;
    // Another product's route, read: its ID under one of Fin's patterns is refused.
    const foreign = hex(32, "c");
    s.cf.routes.push({ id: foreign, pattern: `legacy.${ZONE}/*`, script: "other" });
    await s.api.list(`${Z}/workers/routes`);
    for (const id of [foreign, hex(32, "d")]) {
      refused(
        () =>
          writer.check(
            { kind: "route", pattern: `${CONSOLE}/old/*`, id },
            "DELETE",
            `${Z}/workers/routes/${id}`,
          ),
        /not read as the object/,
      );
    }
    // Another record's ID under the console host's name.
    const tunnel = await readTunnel(s, "fin-next-staging-public");
    const other = hex(32, "e");
    s.cf.dns.push({ id: other, type: "CNAME", name: `legacy.${ZONE}`, content: "x.example.net" });
    await s.api.list(`${Z}/dns_records`);
    refused(
      () =>
        writer.check(
          { kind: "dns", name: CONSOLE, id: other },
          "PATCH",
          `${Z}/dns_records/${other}`,
          {
            type: "CNAME",
            name: CONSOLE,
            content: `${tunnel}.cfargotunnel.com`,
            proxied: true,
          },
        ),
      /not read as the object/,
    );
    // A rule read under another ref, and a rule set never read as a phase entrypoint.
    const rs = hex(32, "3");
    const theirs = hex(32, "4");
    await readEntrypoint(s, rs, "http_request_firewall_custom", [
      { id: theirs, ref: "legacy_block" },
    ]);
    refused(
      () =>
        writer.check(
          { kind: "rule", ref: "fin_next_x", hosts: [], rulesetId: rs, id: theirs },
          "DELETE",
          `${Z}/rulesets/${rs}/rules/${theirs}`,
        ),
      /not read as the object/,
    );
    const custom = hex(32, "5");
    refused(
      () =>
        writer.check(
          { kind: "rule", ref: "fin_next_x", hosts: [CONSOLE], rulesetId: custom },
          "POST",
          `${Z}/rulesets/${custom}/rules`,
          ruleBody("fin_next_x", `(http.host eq "${CONSOLE}")`),
        ),
      /phase entrypoints/,
    );
    // A token and an Access application read under other names.
    const token = hex(32, "6");
    s.cf.tokens.push({ id: token, name: "other-product-token", status: "active" });
    await s.api.list(`${A}/tokens`);
    refused(
      () =>
        writer.check(
          { kind: "token", name: "fin-next-staging-email", permissionGroups: [], id: token },
          "DELETE",
          `${A}/tokens/${token}`,
        ),
      /not read as the object/,
    );
    const app = uuid("7");
    s.cf.apps.push({ id: app, name: "other-product-app" });
    await s.api.list(`${A}/access/apps`);
    refused(
      () => writer.check({ ...APP, id: app }, "PUT", `${A}/access/apps/${app}`, {}),
      /not read as the object/,
    );
  });

  it("forgets an object once it is deleted", async () => {
    const s = setup();
    const id = hex(32, "9");
    s.cf.routes.push({ id, pattern: `${CONSOLE}/old/*` });
    await s.api.list(`${Z}/workers/routes`);
    const route: WriteTarget = { kind: "route", pattern: `${CONSOLE}/old/*`, id };
    s.run.register();
    await s.writer.write(route, "DELETE", `${Z}/workers/routes/${id}`);
    refused(
      () => s.writer.check(route, "DELETE", `${Z}/workers/routes/${id}`),
      /not read as the object/,
    );
    s.run.finish("ok");
  });

  it("ties a token's groups to the names read, its IP filter to single egress addresses and its expiry to 180 days", async () => {
    const s = setup();
    const { writer } = s;
    await s.api.list(`${A}/tokens/permission_groups`);
    const own = { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: "*" };
    const mint = (groupId: string, extra: Record<string, unknown> = {}) => {
      const body: Record<string, unknown> = {
        name: "fin-next-staging-email",
        policies: [{ effect: "allow", resources: own, permission_groups: [{ id: groupId }] }],
        condition: { request_ip: { in: ["203.0.113.10/32", "203.0.113.11/32"] } },
        not_before: "2026-11-21T06:00:00Z",
        expires_on: "2027-05-20T06:00:00Z",
        ...extra,
      };
      return body;
    };
    const target = (name: string, id: string): WriteTarget => ({
      kind: "token",
      name: "fin-next-staging-email",
      permissionGroups: [{ name, id }],
    });
    const email = hex(32, "6");
    writer.check(target("Email Sending Write", email), "POST", `${A}/tokens`, mint(email));
    // Another group's ID under the mintable name it is declared with.
    const settings = hex(32, "8");
    refused(
      () =>
        writer.check(
          target("Email Sending Write", settings),
          "POST",
          `${A}/tokens`,
          mint(settings),
        ),
      /not the one read under that name/,
    );
    // The email group's ID under a name that needs no IP filter, sent without one.
    const unfiltered = mint(email);
    delete unfiltered.condition;
    refused(
      () => writer.check(target("Workers Scripts Write", email), "POST", `${A}/tokens`, unfiltered),
      /not the one read under that name/,
    );
    // A range, every address, a bare address, or an address that is not the overlay's egress.
    for (const entry of ["0.0.0.0/0", "203.0.113.0/24", "203.0.113.10", "198.51.100.7/32"]) {
      refused(
        () =>
          writer.check(
            target("Email Sending Write", email),
            "POST",
            `${A}/tokens`,
            mint(email, { condition: { request_ip: { in: [entry] } } }),
          ),
        /one IPv4 address \(\/32\)|static egress/,
      );
    }
    refused(
      () =>
        writer.check(
          target("Email Sending Write", email),
          "POST",
          `${A}/tokens`,
          mint(email, { condition: { request_ip: { in: ["203.0.113.10/32"], not_in: [] } } }),
        ),
      /only condition/,
    );
    // An expiry past 180 days, or already past.
    for (const expires of [
      "2099-01-01T00:00:00Z",
      "2027-05-21T06:00:00Z",
      "2026-11-20T06:00:00Z",
    ]) {
      refused(
        () =>
          writer.check(
            target("Email Sending Write", email),
            "POST",
            `${A}/tokens`,
            mint(email, { expires_on: expires }),
          ),
        /within 180 days/,
      );
    }
  });

  describe("a token's client IP filter is its own service's static egress", () => {
    const own = { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: "*" };
    const email = hex(32, "6");
    const mint = (name: string, entries: string[]) => ({
      name,
      policies: [{ effect: "allow", resources: own, permission_groups: [{ id: email }] }],
      condition: { request_ip: { in: entries } },
      not_before: "2026-11-21T06:00:00Z",
      expires_on: "2027-05-20T06:00:00Z",
    });
    const target = (name = "fin-next-staging-email"): WriteTarget => ({
      kind: "token",
      name,
      permissionGroups: [{ name: "Email Sending Write", id: email }],
    });
    const check = async (ov: Overlay, entries: string[], name?: string) => {
      const s = setup(false, ov);
      await s.api.list(`${A}/tokens/permission_groups`);
      s.writer.check(
        target(name),
        "POST",
        `${A}/tokens`,
        mint(name ?? "fin-next-staging-email", entries),
      );
    };

    it("refuses another service's address when the overlay lists the token's service", async () => {
      const ov = withEgress({ worker: ["203.0.113.10", "203.0.113.11"], api: ["198.51.100.5"] });
      await check(ov, ["203.0.113.10/32", "203.0.113.11/32"]);
      for (const entries of [["198.51.100.5/32"], ["203.0.113.10/32", "198.51.100.5/32"]]) {
        await assert.rejects(
          check(ov, entries),
          (e: unknown) =>
            e instanceof RefusedError && /worker's static egress addresses/.test(e.message),
        );
      }
    });

    it("takes single /32 addresses when the overlay lists only other services (read back from Railway)", async () => {
      const ov = withEgress({ api: ["198.51.100.5"], "cloudflared-public": ["198.51.100.6"] });
      await check(ov, ["198.51.100.7/32"]);
      for (const entry of ["0.0.0.0/0", "198.51.100.0/24", "198.51.100.7", "2001:db8::1/128"]) {
        await assert.rejects(
          check(ov, [entry]),
          (e: unknown) => e instanceof RefusedError && /one IPv4 address \(\/32\)/.test(e.message),
        );
      }
      await check(withEgress({}), ["198.51.100.7/32"]);
    });

    it("refuses a filter on a token the public settings tie to no service", async () => {
      await assert.rejects(
        check(overlay, ["203.0.113.10/32"], "fin-next-staging-other"),
        (e: unknown) => e instanceof RefusedError && /no service/.test(e.message),
      );
    });
  });

  it("attaches to Fin's application only the login method of the configured type, as read", async () => {
    const s = setup();
    const { writer } = s;
    const ours = uuid("8");
    s.cf.policies.push({ id: ours, name: "fin-next-staging-staff", decision: "allow" });
    // Another product's login method on the shared account.
    const other = uuid("7");
    s.cf.idps.push({ id: other, type: "github", name: "other product" });
    await s.api.list(`${A}/access/policies`);
    await s.api.list(`${A}/access/identity_providers`);
    const body = (idps: string[]) => ({
      name: "fin-next-staging-admin",
      type: "self_hosted",
      domain: `staff.${ZONE}`,
      allowed_idps: idps,
      policies: [{ id: ours, precedence: 1 }],
    });
    writer.check(APP, "POST", `${A}/access/apps`, body([uuid("1")]));
    for (const idps of [[other], [uuid("1"), other]]) {
      refused(() => writer.check(APP, "POST", `${A}/access/apps`, body(idps)), /login methods/);
    }
    // A writer told no login method type allows none.
    const untold = new CloudflareWriter(s.api, bound(), s.run, overlay, {
      now: () => s.runtime.now(),
    });
    refused(
      () => untold.check(APP, "POST", `${A}/access/apps`, body([uuid("1")])),
      /login methods/,
    );
  });

  it("attaches to Fin's application exactly the policy read under its name, and only login methods read", async () => {
    const s = setup();
    const { writer } = s;
    const ours = uuid("8");
    const everyone = uuid("9");
    s.cf.policies.push(
      { id: ours, name: "fin-next-staging-staff", decision: "allow" },
      { id: everyone, name: "other-product-everyone", decision: "allow" },
    );
    await s.api.list(`${A}/access/policies`);
    await s.api.list(`${A}/access/identity_providers`);
    const idp = uuid("1");
    const body = (policies: unknown[], idps: unknown[] = [idp]) => ({
      name: "fin-next-staging-admin",
      type: "self_hosted",
      domain: `staff.${ZONE}`,
      destinations: [{ type: "public", uri: `staff.${ZONE}` }],
      allowed_idps: idps,
      policies,
    });
    writer.check(APP, "POST", `${A}/access/apps`, body([{ id: ours, precedence: 1 }]));
    for (const policies of [
      [{ id: everyone, precedence: 1 }],
      [
        { id: ours, precedence: 1 },
        { id: everyone, precedence: 2 },
      ],
      [{ id: uuid("6"), precedence: 1 }],
      [],
    ]) {
      refused(
        () => writer.check(APP, "POST", `${A}/access/apps`, body(policies)),
        /exactly one policy/,
      );
    }
    for (const idps of [[], [uuid("6")]]) {
      refused(
        () =>
          writer.check(APP, "POST", `${A}/access/apps`, body([{ id: ours, precedence: 1 }], idps)),
        /login methods read/,
      );
    }
  });

  it("lets the preflight name the policy a checked POST will create, but never sends without its ID", async () => {
    const s = setup();
    const { run, writer } = s;
    await s.api.list(`${A}/access/identity_providers`);
    const policy: WriteTarget = { kind: "access-policy", name: "fin-next-staging-staff" };
    const policyBody = {
      name: "fin-next-staging-staff",
      decision: "allow",
      include: [{ email: { email: "a@example.com" } }],
    };
    const app = (id: string) => ({
      name: "fin-next-staging-admin",
      type: "self_hosted",
      domain: `staff.${ZONE}`,
      allowed_idps: [uuid("1")],
      policies: [{ id, precedence: 1 }],
    });
    refused(() => writer.check(APP, "POST", `${A}/access/apps`, app("")), /exactly one policy/);
    writer.check(policy, "POST", `${A}/access/policies`, policyBody);
    writer.check(APP, "POST", `${A}/access/apps`, app(""));
    run.register();
    await assert.rejects(
      writer.write(APP, "POST", `${A}/access/apps`, app("")),
      /exactly one policy/,
    );
    const created = await writer.write<{ id: string }>(
      policy,
      "POST",
      `${A}/access/policies`,
      policyBody,
    );
    await writer.write(APP, "POST", `${A}/access/apps`, app(created.id));
    run.finish("ok");
  });

  it("points a CNAME only at one of Fin's own tunnels, proxied, and writes TXT only as DMARC", async () => {
    const s = setup();
    const { writer } = s;
    const ours = await readTunnel(s, "fin-next-staging-public", "3");
    const theirs = await readTunnel(s, "other-product-tunnel", "4");
    const dns: WriteTarget = { kind: "dns", name: CONSOLE };
    const cname = (content: string, proxied = true) => ({
      type: "CNAME",
      name: CONSOLE,
      content,
      proxied,
    });
    writer.check(dns, "POST", `${Z}/dns_records`, cname(`${ours}.cfargotunnel.com`));
    for (const content of [
      `${theirs}.cfargotunnel.com`,
      `${uuid("5")}.cfargotunnel.com`,
      "origin.example.net",
    ]) {
      refused(
        () => writer.check(dns, "POST", `${Z}/dns_records`, cname(content)),
        /Fin's own tunnels/,
      );
    }
    refused(
      () => writer.check(dns, "POST", `${Z}/dns_records`, cname(`${ours}.cfargotunnel.com`, false)),
      /proxied/,
    );
    refused(
      () =>
        writer.check(dns, "POST", `${Z}/dns_records`, {
          type: "TXT",
          name: CONSOLE,
          content: "v=DMARC1; p=none",
        }),
      /DMARC/,
    );
    const name = `_dmarc.auth.${ZONE}`;
    const dmarc: WriteTarget = { kind: "dns", name };
    writer.check(dmarc, "POST", `${Z}/dns_records`, {
      type: "TXT",
      name,
      content: "v=DMARC1; p=none; rua=mailto:reports@example.com",
    });
    refused(
      () =>
        writer.check(dmarc, "POST", `${Z}/dns_records`, {
          type: "TXT",
          name,
          content: "v=spf1 include:example.net -all",
        }),
      /DMARC/,
    );
  });
});

describe("a provider error", () => {
  it("redacts a value only its write carries before the cut, and only where it stands alone", () => {
    const masker = new Masker();
    const redact = [{ value: "4321", placeholder: "<threshold:api-v4>" }];
    assert.equal(
      maskedDetail(
        masker,
        '20120 "requests_per_period":4321; no more than 4321. (14321, 4321.5, 2026-11-21T04:43:21Z)',
        400,
        redact,
      ),
      '20120 "requests_per_period":<threshold:api-v4>; no more than <threshold:api-v4>. (14321, 4321.5, 2026-11-21T04:43:21Z)',
    );
    // A cut that would land inside the number leaves no part of it.
    const cut = maskedDetail(masker, `${"y".repeat(398)} 4321`, 400, redact);
    assert.equal(cut.includes("43"), false);
    assert.equal(masker.size, 0, "nothing is registered with the masker");
  });

  it("is masked before it is cut, and its path names no ID", async () => {
    const token = fakeToken("m");
    const cf = new FakeCloudflare(token);
    const masker = new Masker();
    masker.register(ZONE, "<zone>");
    masker.register(ZONE_ID, "<zone-id>");
    const host = `onboard.${ZONE}`;
    const message = `${"y".repeat(400 - "20200 ".length - 15)}${host}`;
    cf.onRequest = () => FakeCloudflare.failure(400, 20200, message);
    const api = new CloudflareApi(new Secret(token), fakeRuntime({ fetch: cf.fetch }), masker);
    const id = "9a8b7c6d".repeat(4); // built at run time: no ID-shaped literal in a tracked file
    await assert.rejects(api.get(`${Z}/dns_records/${id}`), (e: unknown) => {
      const text = String(e);
      assert.equal(text.includes(id), false);
      assert.equal(text.includes(ZONE_ID), false);
      assert.equal(text.includes("zone.e"), false);
      assert.match(text, /\/dns_records\/<id>/);
      return true;
    });
  });
});
