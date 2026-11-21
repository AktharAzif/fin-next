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
    new CloudflareApi(new Secret(token), runtime),
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
    const rule: WriteTarget = { kind: "rule", ref: "fin_next_x", hosts: [] };
    refused(
      () => writer.check(rule, "PUT", `${Z}/rulesets/${hex(32, "3")}`),
      /never replaced whole/,
    );
    refused(
      () =>
        writer.check(rule, "PUT", `${Z}/rulesets/phases/http_request_dynamic_redirect/entrypoint`),
      /never replaced whole/,
    );
    refused(
      () =>
        writer.check(
          { kind: "rule", ref: "legacy_redirect", hosts: [] },
          "PATCH",
          `${Z}/rulesets/${hex(32, "3")}/rules/${hex(32, "4")}`,
        ),
      /fin_next_/,
    );
    refused(() => writer.check(rule, "POST", `${Z}/rulesets/${hex(32, "3")}`), /per-rule endpoint/);
    refused(
      () =>
        writer.check(
          { kind: "ruleset", phase: "p", refs: ["fin_next_x"], hosts: [] },
          "PATCH",
          `${Z}/rulesets`,
        ),
      /only ever created/,
    );
    writer.check(rule, "POST", `${Z}/rulesets/${hex(32, "3")}/rules`);
    writer.check(rule, "DELETE", `${Z}/rulesets/${hex(32, "3")}/rules/${hex(32, "4")}`);
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
    writer.check({ kind: "setting", id: "0rtt" }, "PATCH", `${Z}/settings/0rtt`);
    refused(
      () => writer.check({ kind: "setting", id: "ssl" }, "PATCH", `${Z}/settings/ssl`),
      /not a setting/,
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
            permissionGroups: ["Account Settings Write"],
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
        { kind: "dns", name: `console.${ZONE}` },
        "PATCH",
        `${Z}/dns_records/${hex(32, "0")}`,
        {},
      );
      assert.fail("should fail");
    } catch (error) {
      assert.match(String(error), /answered 404/);
      assert.equal(String(error).includes(cf.token), false);
    }
    run.finish("ok");
  });
});
