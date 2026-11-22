// The area's fragments agree with their sources: the migration carries the runner's header and the
// guard registrations name only this area's events; the grant fragment is packages/db's shape, grants
// to group roles only and never lets the edge or anyone but the worker near the hash; the audit
// fragment is spec 05 §4.10's five events, flat and strict; the email templates render with no key
// material and hide or refuse a planted secret; the step-up fragment is spec 02 §7.6's four actions;
// the names rule refuses what reads as a web address; the audit adapter refuses what the fragment does.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../email/src/render.ts";
import { keyAuditPayload, keyEventTypeRows } from "./audit.ts";
import { KEY_TEMPLATES } from "./email.ts";
import { checkKeyName } from "./names.ts";
import { KEYS_ACTIONS } from "./step-up.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "migrations");

describe("the migration", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
  it("is named and headed as the runner reads it, later than every earlier area's", () => {
    expect(files).toEqual(["20261122080000_keys_tables.sql"]);
    const body = readFileSync(join(MIGRATIONS, files[0] as string), "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("--") && l.trim() !== "");
    expect(body[0]).toBe("SET LOCAL lock_timeout = '5s';");
    expect(body[1]).toBe("SET LOCAL statement_timeout = '60s';");
  });

  it("guards the key table with this area's events only", () => {
    const sql = readFileSync(join(MIGRATIONS, files[0] as string), "utf8");
    const guards = sql.split("\n").filter((l) => l.startsWith("SELECT audit.install_guard("));
    expect(guards).toHaveLength(2);
    expect(guards[0]).toContain(
      "ARRAY['api_key.created', 'api_key.updated', 'api_key.rolled', 'api_key.revoked']",
    );
    expect(guards[1]).toContain("ARRAY['guard.never_allowed']");
  });
});

describe("the grant fragment", () => {
  const fragment = JSON.parse(readFileSync(join(ROOT, "grants", "keys.json"), "utf8")) as {
    area: string;
    grants: { on: string; name: string; privileges: string[]; columns?: string[]; to: string[] }[];
  };

  it("is for this area and grants to group roles only", () => {
    expect(fragment.area).toBe("keys");
    const roles = new Set([
      "fin_console",
      "fin_edge",
      "fin_payments",
      "fin_worker",
      "fin_readonly",
    ]);
    for (const grant of fragment.grants)
      for (const role of grant.to) expect(roles.has(role)).toBe(true);
  });

  it("lets only the console write keys, the worker re-hash, and nobody else read a hash", () => {
    const on = (role: string) => fragment.grants.filter((g) => g.to.includes(role));
    expect(on("fin_edge").map((g) => g.name)).toEqual([
      "keys",
      "keys.key_lookup",
      "keys.touch_last_used(text)",
    ]);
    expect(on("fin_payments").map((g) => g.name)).toEqual(["keys", "keys.key_lookup"]);
    const readonly = on("fin_readonly").find((g) => g.name === "keys.api_key");
    expect(readonly?.columns).not.toContain("hash");
    const consoleUpdate = on("fin_console").find((g) => g.privileges.includes("UPDATE"));
    expect(consoleUpdate?.columns).not.toContain("hash");
    expect(consoleUpdate?.columns).not.toContain("pepper_versions");
    expect(consoleUpdate?.columns).not.toContain("last_used_at");
    const worker = on("fin_worker").filter((g) => g.name === "keys.api_key");
    expect(worker.find((g) => g.privileges.includes("UPDATE"))?.columns).toEqual([
      "hash",
      "pepper_versions",
    ]);
  });
});

describe("the audit fragment", () => {
  it("is spec 05 §4.10's five events, category api_keys, organisation scope", () => {
    const rows = keyEventTypeRows();
    expect(rows.map((r) => r.name)).toEqual([
      "api_key.created",
      "api_key.updated",
      "api_key.rolled",
      "api_key.revoked",
      "api_key.exposed",
    ]);
    for (const row of rows) {
      expect(row.category).toBe("api_keys");
      expect(row.scope).toBe("organisation");
    }
    expect(rows.find((r) => r.name === "api_key.revoked")?.journal_kind).toBe("key_revoked");
    expect(rows.find((r) => r.name === "api_key.rolled")?.journal_kind).toBe("key_rolled");
    expect(rows.find((r) => r.name === "api_key.exposed")?.roles).toEqual(["fin_api"]);
  });

  it("refuses metadata the fragment does not allow, and a key's prefix anywhere", () => {
    const base = {
      event: "api_key.revoked" as const,
      actor: {
        kind: "user" as const,
        id: "usr_01jd0000000000000000000000",
        via: "console" as const,
      },
      target: "ABCDEFGHJK",
      organizationId: "org_01jd0000000000000000000000",
      mode: "test" as const,
      metadata: { key_id: "ABCDEFGHJK", reason: "member" as const, source: null },
    };
    const payload = keyAuditPayload(base, "aud_01jd0000000000000000000000", "req_1", "rel");
    expect(payload).toMatchObject({
      target_id: "ABCDEFGHJK",
      mode: "sandbox",
      event: "api_key.revoked",
    });
    expect(() =>
      keyAuditPayload(
        { ...base, metadata: { ...base.metadata, extra: 1 } as never },
        "aud_01jd0000000000000000000000",
        null,
        "rel",
      ),
    ).toThrow();
    expect(() =>
      keyAuditPayload(
        { ...base, target: ["fin", "test", "sk", "ABCDEFGHJK"].join("_") },
        "aud_x",
        null,
        "rel",
      ),
    ).toThrow();
    expect(() =>
      keyAuditPayload(
        {
          ...base,
          event: "api_key.exposed",
          metadata: { key_id: "ABCDEFGHJK", source: "plain_http" },
        },
        "aud_x",
        null,
        "rel",
      ),
    ).toThrow(/user actor/);
  });
});

describe("the email templates", () => {
  const LINKS = { console: "https://console.example.com" };
  const CONTEXT = { recipient: "person@example.com", environment: "ci", describe: () => undefined };

  it.each(Object.entries(KEY_TEMPLATES))(
    "%s renders its sample with one link to API keys",
    (_id, t) => {
      const r = renderTemplate(t, t.sample, CONTEXT, LINKS);
      expect(r.subject).not.toContain("Payout worker");
      expect(r.html).toContain('href="https://console.example.com/developers/keys"');
      expect((r.html.match(/<a /g) ?? []).length).toBe(1);
      expect(r.text).not.toMatch(/fin_(test|live)_/);
    },
  );

  it("hides a planted secret in the key's name and refuses it in the key's ID", () => {
    const t = KEY_TEMPLATES["api-keys/key-changed"];
    const secret = ["fin", "live", "sk", "0123456789ABCDEFGHJKabcdefghijklmnopqrstuvwxyz0123"].join(
      "_",
    );
    const hidden = renderTemplate(t, { ...t.sample, keyName: secret }, CONTEXT, LINKS);
    expect(hidden.text).not.toContain(secret);
    expect(() => renderTemplate(t, { ...t.sample, keyId: secret }, CONTEXT, LINKS)).toThrow();
  });
});

describe("the step-up fragment", () => {
  it("is spec 02 §7.6's four key actions, each an intent", () => {
    expect(KEYS_ACTIONS.map((a) => a.key)).toEqual([
      "key.create",
      "key.update",
      "key.roll",
      "key.revoke",
    ]);
    for (const action of KEYS_ACTIONS) {
      expect(action.kind).toBe("intent");
      expect(action.realm).toBe("developer");
    }
    expect(KEYS_ACTIONS[0].bind.map((b) => b.name)).toEqual([
      "name",
      "mode",
      "kind",
      "scopes",
      "ipAllowlist",
      "expiresIn",
    ]);
  });
});

describe("a key's name", () => {
  it.each([
    ["Payout worker", true],
    ["payments-prod", true],
    ["CI (contract tests) #2", true],
    ["ledger.sync", false],
    ["acme.com", false],
    ["ops@example.com", false],
    ["https://x", false],
    ["Batch 20261122", false],
    ["", false],
    ["a".repeat(61), false],
    [`bad${String.fromCodePoint(0x202e)}name`, false],
    [["fin", "test", "x"].join("_"), false],
  ])("%s → %s", (name, ok) => {
    expect(checkKeyName(name).ok).toBe(ok);
  });
});
