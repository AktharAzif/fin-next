import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RefusedError } from "../src/core/errors.ts";
import { Guard, type GuardFlags } from "../src/core/guard.ts";
import { type Overlay, parseOverlay } from "../src/core/overlay.ts";
import { ACCOUNT_ID, hex, overlayFixture, ZONE, ZONE_ID } from "./helpers/fixtures.ts";

const overlay = parseOverlay(overlayFixture(), "staging");

/** Cloudflare's answer for the overlay's zone. */
function zoneAnswer(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: ZONE_ID, name: ZONE, account: { id: ACCOUNT_ID, name: "fixture" }, ...change };
}

/** A guard already bound to the overlay's zone, as a command has it after reading the zone. */
function bound(o: Overlay = overlay, flags: GuardFlags = {}): Guard {
  const guard = new Guard(o, flags);
  guard.bindZone(zoneAnswer());
  return guard;
}

function refuses(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof RefusedError, `expected a RefusedError, got ${String(e)}`);
    assert.match(e.message, pattern);
    return true;
  });
}

describe("the allow-list guard (BD-11)", () => {
  const guard = bound();

  it("allows the overlay's labels and returns the label", () => {
    assert.equal(guard.checkName(`console.${ZONE}`, "dns"), "console");
    assert.equal(guard.checkName(`STAFF.${ZONE}.`, "dns"), "staff");
    assert.equal(guard.checkName(`_dmarc.auth.${ZONE}`, "dns"), "_dmarc.auth");
  });

  it("refuses the apex, @ and wildcards", () => {
    refuses(() => guard.checkName(ZONE, "dns"), /apex/);
    refuses(() => guard.checkName("@", "dns"), /apex/);
    refuses(() => guard.checkName(`*.${ZONE}`, "dns"), /wildcard/);
    refuses(() => guard.checkName(`*.console.${ZONE}`, "dns"), /wildcard/);
  });

  it("refuses the zone's own _dmarc record whatever the overlay says", () => {
    const o = overlayFixture();
    o.neverTouch.labels = ["www"];
    o.allowedNames.labels.push("_dmarc");
    const lenient = bound(parseOverlay(o, "staging"));
    refuses(() => lenient.checkName(`_dmarc.${ZONE}`, "dns"), /_dmarc record is never written/);
  });

  it("refuses names outside the zone, never-touch names and unlisted names", () => {
    refuses(() => guard.checkName("console.other.example", "dns"), /not under/);
    refuses(() => guard.checkName(`console.${ZONE}.evil.example`, "dns"), /not under/);
    refuses(() => guard.checkName(`legacy.${ZONE}`, "dns"), /never-touch/);
    refuses(() => guard.checkName(`www.${ZONE}`, "dns"), /never-touch/);
    refuses(() => guard.checkName(`unlisted.${ZONE}`, "dns"), /not on the overlay's allow-list/);
    refuses(() => guard.checkName(`x.console.${ZONE}`, "dns"), /not on the overlay's allow-list/);
    refuses(() => guard.checkName(`.${ZONE}`, "dns"), /not a valid name|apex/);
  });

  it("refuses every name under a never-touch label, even one the allow-list names", () => {
    // parseOverlay refuses such an allow-list; the guard holds on its own as well.
    const loose: Overlay = {
      ...overlay,
      allowedNames: {
        ...overlay.allowedNames,
        labels: [...overlay.allowedNames.labels, "api.legacy", "_dmarc.www", "_acme-challenge.app"],
      },
    };
    const g = bound(loose);
    for (const label of ["api.legacy", "_dmarc.www", "_acme-challenge.app"]) {
      refuses(() => g.checkName(`${label}.${ZONE}`, "dns"), /never-touch/);
    }
    assert.equal(g.checkName(`console.${ZONE}`, "dns"), "console");
  });

  it("allows spike-only and fallback-only names only behind their flags", () => {
    refuses(() => guard.checkName(`c1-spike.${ZONE}`, "dns"), /--spike/);
    refuses(() => guard.checkName(`console-api.${ZONE}`, "dns"), /--fallback/);
    const flagged = bound(overlay, { spike: true, fallback: true });
    assert.equal(flagged.checkName(`c1-spike.${ZONE}`, "dns"), "c1-spike");
    assert.equal(flagged.checkName(`console-api.${ZONE}`, "dns"), "console-api");
  });

  it("checks route patterns: allowed host, path /* or /api/*, never /api*", () => {
    guard.checkRoutePattern(`console.${ZONE}/*`);
    guard.checkRoutePattern(`console.${ZONE}/api/*`);
    refuses(() => guard.checkRoutePattern(`console.${ZONE}/api*`), /\/apix/);
    refuses(() => guard.checkRoutePattern(`console.${ZONE}/other/*`), /must be \/\* or \/api\/\*/);
    refuses(() => guard.checkRoutePattern(`*.${ZONE}/*`), /wildcard/);
    refuses(() => guard.checkRoutePattern(`${ZONE}/*`), /apex/);
    refuses(() => guard.checkRoutePattern(`legacy.${ZONE}/*`), /never-touch/);
    refuses(() => guard.checkRoutePattern("/*"), /<host>\/<path>/);
  });

  it("allows only fin_next_ rule refs", () => {
    guard.checkRuleRef("fin_next_https_redirect", "rule");
    refuses(() => guard.checkRuleRef(undefined, "rule"), /fin_next_/);
    refuses(() => guard.checkRuleRef("other_product_redirect", "rule"), /fin_next_/);
    refuses(() => guard.checkRuleRef("fin_next_Bad-Ref", "rule"), /fin_next_/);
  });

  it("allows only fin-next-<env>- names for Fin's own objects", () => {
    guard.checkOwnName("fin-next-staging-public", "tunnel");
    refuses(() => guard.checkOwnName("fin-next-production-public", "tunnel"), /fin-next-staging-/);
    refuses(() => guard.checkOwnName("other-tunnel", "tunnel"), /fin-next-staging-/);
  });
});

describe("the zone the guard is bound to", () => {
  it("refuses every zone check until the zone is checked against Cloudflare's answer", () => {
    const g = new Guard(overlay);
    assert.equal(g.zoneBound, false);
    refuses(() => g.checkName(`console.${ZONE}`, "dns"), /has not been checked/);
    refuses(() => g.checkRoutePattern(`console.${ZONE}/*`), /has not been checked/);
    refuses(() => g.checkRuleRef("fin_next_x", "rule"), /has not been checked/);
    refuses(() => g.checkZoneWrite("zone setting"), /has not been checked/);
    refuses(() => g.zoneId, /has not been checked/);
    // Account-level names need no zone.
    g.checkOwnName("fin-next-staging-public", "tunnel");
    assert.equal(g.bindZone(zoneAnswer()), ZONE_ID);
    assert.equal(g.zoneId, ZONE_ID);
    assert.equal(g.checkZoneWrite("zone setting"), ZONE_ID);
  });

  it("refuses a zone ID that belongs to another zone or another account", () => {
    refuses(
      () => new Guard(overlay).bindZone(zoneAnswer({ name: "other-zone.example" })),
      /names a zone other than the overlay's zone/,
    );
    refuses(
      () => new Guard(overlay).bindZone(zoneAnswer({ account: { id: hex(32, "9") } })),
      /an account other than the overlay/,
    );
    refuses(
      () => new Guard(overlay).bindZone(zoneAnswer({ id: hex(32, "3") })),
      /cloudflare.zoneId is not the ID of the overlay's zone/,
    );
    refuses(() => new Guard(overlay).bindZone({ id: "x" }), /unexpected shape/);
    const g = bound();
    refuses(() => g.bindZone(zoneAnswer({ id: hex(32, "3") })), /zoneId is not the ID/);
  });

  it("resolves the zone by name when the overlay names no zone ID", () => {
    const o = overlayFixture() as Record<string, unknown> & { cloudflare: Record<string, unknown> };
    Reflect.deleteProperty(o.cloudflare, "zoneId");
    const g = new Guard(parseOverlay(o, "staging"));
    const id = hex(32, "4");
    assert.equal(g.bindZone(zoneAnswer({ id, name: `${ZONE.toUpperCase()}.` })), id);
    assert.equal(g.zoneId, id);
  });
});
