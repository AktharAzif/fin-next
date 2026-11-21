import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../src/core/args.ts";
import { RefusedError, UsageError } from "../src/core/errors.ts";
import {
  type Change,
  canonical,
  checkDeletes,
  differingFields,
  formatPlan,
  pending,
  summarize,
} from "../src/core/plan.ts";
import { loadSettings, mustBeSealed, parseSettings } from "../src/core/settings.ts";
import { REPO_ROOT } from "./helpers/fixtures.ts";

const SPEC = {
  positionals: [{ name: "role", description: "the tunnel", values: ["public", "admin"] }],
  flags: [
    { name: "dry-run", kind: "boolean" as const, description: "" },
    { name: "confirm-delete", kind: "integer" as const, description: "" },
    { name: "release", kind: "string" as const, description: "" },
    { name: "only", kind: "string" as const, description: "", values: ["settings", "rules"] },
  ],
};

describe("parseArgs", () => {
  it("parses positionals and every flag form", () => {
    const a = parseArgs(["public", "--dry-run", "--confirm-delete", "2", "--release=abc"], SPEC);
    assert.deepEqual(a.positionals, ["public"]);
    assert.equal(a.flags.get("dry-run"), true);
    assert.equal(a.flags.get("confirm-delete"), 2);
    assert.equal(a.flags.get("release"), "abc");
  });

  it("refuses unknown, repeated, valueless and malformed flags", () => {
    assert.throws(() => parseArgs(["public", "--dryrun"], SPEC), UsageError);
    assert.throws(() => parseArgs(["public", "--dry-run", "--dry-run"], SPEC), /twice/);
    assert.throws(() => parseArgs(["public", "--dry-run=yes"], SPEC), /takes no value/);
    assert.throws(() => parseArgs(["public", "--release"], SPEC), /needs a value/);
    assert.throws(() => parseArgs(["public", "--release", "--dry-run"], SPEC), /needs a value/);
    assert.throws(() => parseArgs(["public", "--confirm-delete", "two"], SPEC), /whole number/);
    assert.throws(
      () => parseArgs(["public", "--only", "everything"], SPEC),
      /one of settings, rules/,
    );
  });

  it("refuses a wrong number or value of arguments", () => {
    assert.throws(() => parseArgs([], SPEC), /expected 1 argument/);
    assert.throws(() => parseArgs(["public", "extra"], SPEC), /expected 1 argument/);
    assert.throws(() => parseArgs(["private"], SPEC), /public, admin/);
  });
});

describe("plans", () => {
  const changes: Change[] = [
    { kind: "dns", name: "console", action: "create", detail: "CNAME" },
    { kind: "dns", name: "staff", action: "keep" },
    { kind: "rule", name: "fin_next_old", action: "delete" },
    { kind: "setting", name: "0rtt", action: "update", fields: ["value"], held: "shared zone" },
  ];

  it("summarises, formats and lists what would be sent", () => {
    assert.deepEqual(summarize(changes), { create: 1, update: 0, delete: 1, keep: 1, held: 1 });
    const lines = formatPlan("zone", changes);
    assert.equal(lines[1], "  + create dns console CNAME");
    assert.equal(lines[4], "  ! update setting 0rtt [value] (held: shared zone)");
    assert.equal(pending(changes).length, 2);
  });

  it("refuses deletions without the exact --confirm-delete count", () => {
    assert.throws(() => checkDeletes(changes, undefined), RefusedError);
    assert.throws(() => checkDeletes(changes, 2), /--confirm-delete 1/);
    checkDeletes(changes, 1);
    checkDeletes(
      changes.filter((c) => c.action !== "delete"),
      undefined,
    );
  });

  it("compares objects canonically", () => {
    assert.equal(
      canonical({ b: 1, a: [1, { d: 2, c: 3 }] }),
      canonical({ a: [1, { c: 3, d: 2 }], b: 1 }),
    );
    assert.deepEqual(differingFields({ a: 1, b: { x: 1 } }, { a: 1, b: { x: 2 }, c: 3 }), [
      "b",
      "c",
    ]);
  });
});

/** The parts of the staging file these tests change. */
interface StagingRaw {
  email: { dmarcPolicy: string; token: { service: string } };
  railway: { deployOrder: string[]; connectorOrder: string[] };
  tunnels: { public: { standby: string } };
  staticOrder: string[];
  static: Record<string, unknown>;
}

function stagingRaw(): StagingRaw {
  return JSON.parse(readFileSync(join(REPO_ROOT, "ops", "environments", "staging.json"), "utf8"));
}

describe("the public settings", () => {
  it("loads ops/environments/staging.json", () => {
    const s = loadSettings(REPO_ROOT, "staging");
    assert.equal(s.tunnels.public.name, "fin-next-staging-public");
    assert.equal(s.static.selfie?.app, "verify");
    assert.equal(s.zone.shared, true);
    assert.equal(mustBeSealed(s, "TUNNEL_TOKEN"), true);
    assert.equal(mustBeSealed(s, "FIN_HEARTBEAT_WATCHER_URL"), true);
    assert.equal(mustBeSealed(s, "FIN_SERVICE"), false);
  });

  it("keeps staging's sending subdomains at DMARC p=reject ([BD-17])", () => {
    assert.equal(loadSettings(REPO_ROOT, "staging").email.dmarcPolicy, "reject");
    for (const policy of ["none", "quarantine"]) {
      const raw = stagingRaw();
      raw.email.dmarcPolicy = policy;
      assert.throws(() => parseSettings(raw, "staging"), /email.dmarcPolicy must be reject/);
    }
  });

  it("requires every caller key to be sealed, the rotated ones included", () => {
    const s = loadSettings(REPO_ROOT, "staging");
    for (const name of ["FIN_CALLER_KEY_1", "FIN_CALLER_KEY_2", "FIN_CALLER_KEY_10"]) {
      assert.equal(mustBeSealed(s, name), true, name);
    }
    assert.equal(mustBeSealed(s, "FIN_CALLER_PUBLIC_KEYS"), false);
  });

  it("runs both backup schedules of spec 01 §6.2: nightly and hourly", () => {
    const services = loadSettings(REPO_ROOT, "staging").railway.services;
    assert.equal(services.backup?.cron, "17 3 * * *");
    assert.equal(services["backup-hourly"]?.cron, "5 * * * *");
    assert.equal(services["backup-hourly"]?.image, services.backup?.image);
    assert.equal(services["backup-hourly"]?.startCommand, "dist/main.js --hourly");
  });

  it("never takes a name every object inherits for a service or a static deployment", () => {
    for (const change of [
      (raw: StagingRaw) => raw.railway.deployOrder.push("constructor"),
      (raw: StagingRaw) => raw.railway.connectorOrder.push("toString"),
      (raw: StagingRaw) => (raw.email.token.service = "hasOwnProperty"),
      (raw: StagingRaw) => (raw.tunnels.public.standby = "valueOf"),
      (raw: StagingRaw) => raw.staticOrder.push("hasOwnProperty"),
    ]) {
      const raw = stagingRaw();
      change(raw);
      assert.throws(
        () => parseSettings(raw, "staging"),
        /no service|does not exist|no static deployment/,
      );
    }
    const raw = stagingRaw();
    raw.static = JSON.parse(`{"__proto__": ${JSON.stringify(raw.static.console)}}`);
    assert.throws(
      () => parseSettings(raw, "staging"),
      /static has a key that is not a deployment name/,
    );
  });

  it("holds no private value: no zone, no ID, no address", () => {
    const text = readFileSync(join(REPO_ROOT, "ops", "environments", "staging.json"), "utf8");
    assert.doesNotMatch(text, /[0-9a-f]{32}/);
    assert.doesNotMatch(text, /@[a-z0-9-]+\./);
    assert.doesNotMatch(text, /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app)\b(?!\/)/);
  });

  it("refuses names outside fin-next-<env>- and dangling references", () => {
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, "ops", "environments", "staging.json"), "utf8"),
    );
    raw.tunnels.public.name = "other-tunnel";
    assert.throws(() => parseSettings(raw, "staging"), /tunnels.public.name/);
    const raw2 = JSON.parse(
      readFileSync(join(REPO_ROOT, "ops", "environments", "staging.json"), "utf8"),
    );
    raw2.railway.deployOrder.push("ghost");
    assert.throws(() => parseSettings(raw2, "staging"), /ghost/);
    const raw3 = JSON.parse(
      readFileSync(join(REPO_ROOT, "ops", "environments", "staging.json"), "utf8"),
    );
    raw3.email.token.expiryDays = 365;
    assert.throws(() => parseSettings(raw3, "staging"), /between 1 and 180/);
  });
});
