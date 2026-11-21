import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CloudflareApi, CloudflareWriter, type WriteTarget } from "../src/cloudflare/api.ts";
import { RefusedError } from "../src/core/errors.ts";
import { Guard } from "../src/core/guard.ts";
import { Masker } from "../src/core/mask.ts";
import { Output } from "../src/core/output.ts";
import { parseOverlay } from "../src/core/overlay.ts";
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
  ZONE,
  ZONE_ID,
} from "./helpers/fixtures.ts";
import { FakeCloudflare } from "./helpers/providers.ts";

const overlay = parseOverlay(overlayFixture(), "staging");
const Z = `/zones/${ZONE_ID}`;
const A = `/accounts/${ACCOUNT_ID}`;
const CONSOLE = `console.${ZONE}`;

function ruleBody(ref: string, expression: string): Record<string, unknown> {
  return { ref, description: "d", expression, action: "block", enabled: true };
}

function setup(dryRun = false) {
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
  const writer = new CloudflareWriter(
    new CloudflareApi(new Secret(token), runtime, masker),
    new Guard(overlay),
    run,
    overlay,
    ["0rtt"],
  );
  return { cf, run, writer };
}

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

  it("refuses a whole-phase replace, a foreign rule ref and a non-rule endpoint", () => {
    const { run, writer } = setup();
    run.register();
    const rs = hex(32, "3");
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

  it("checks what a write sends and which object it names, not only the label it is given", () => {
    const { writer } = setup();
    const dns: WriteTarget = { kind: "dns", name: CONSOLE };
    const record = (name: string) => ({ type: "CNAME", name, content: "x.example.net" });
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
    const id = hex(32, "6");
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
    const app: WriteTarget = {
      kind: "access-app",
      name: "fin-next-staging-admin",
      host: `staff.${ZONE}`,
    };
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

  it("mints a token only for this account, its declared groups and, for email, an IP filter", () => {
    const { writer } = setup();
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
    writer.check(target, "POST", `${A}/tokens`, body(own, [group.id], ["192.0.2.1/32"]));
    refused(
      () =>
        writer.check(
          target,
          "POST",
          `${A}/tokens`,
          body({ "com.cloudflare.api.account.*": "*" }, [group.id], ["192.0.2.1/32"]),
        ),
      /this account only/,
    );
    refused(
      () =>
        writer.check(
          target,
          "POST",
          `${A}/tokens`,
          body(own, [group.id, hex(32, "8")], ["192.0.2.1/32"]),
        ),
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
    const writer = new CloudflareWriter(api, new Guard(overlay), run, overlay, ["0rtt", "x|.*"]);
    refused(
      () =>
        writer.check({ kind: "setting", id: "x|.*" }, "PATCH", `${Z}/dns_records`, { value: 1 }),
      /setting's endpoint/,
    );
    assert.equal(typeof (api as unknown as Record<string, unknown>).sendWrite, "undefined");
  });

  it("deletes a stale route on a Fin host or a stale fin_next_ rule whatever its spelling", () => {
    const { writer } = setup();
    const id = hex(32, "9");
    writer.check(
      { kind: "route", pattern: `${CONSOLE}/api*`, id },
      "DELETE",
      `${Z}/workers/routes/${id}`,
    );
    writer.check(
      { kind: "route", pattern: `${CONSOLE}/old/*`, id },
      "DELETE",
      `${Z}/workers/routes/${id}`,
    );
    refused(
      () =>
        writer.check(
          { kind: "route", pattern: `legacy.${ZONE}/*`, id },
          "DELETE",
          `${Z}/workers/routes/${id}`,
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
    refused(
      () =>
        writer.check(
          { kind: "access-app", name: "fin-next-staging-admin", host: `staff.${ZONE}` },
          "DELETE",
          `${A}/access/apps/x`,
        ),
      /never deleted/,
    );
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
    const { cf, run, writer } = setup();
    run.register();
    await writer.write({ kind: "dns", name: `console.${ZONE}` }, "POST", `${Z}/dns_records`, {
      type: "CNAME",
      name: `console.${ZONE}`,
      content: "x",
    });
    assert.equal(cf.dns.length, 1);
    try {
      await writer.write(
        { kind: "dns", name: `console.${ZONE}`, id: hex(32, "0") },
        "PATCH",
        `${Z}/dns_records/${hex(32, "0")}`,
        { type: "CNAME", name: `console.${ZONE}`, content: "x" },
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

describe("a provider error", () => {
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
