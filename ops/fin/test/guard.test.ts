import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RefusedError } from "../src/core/errors.ts";
import { Guard } from "../src/core/guard.ts";
import { parseOverlay } from "../src/core/overlay.ts";
import { overlayFixture, ZONE } from "./helpers/fixtures.ts";

const overlay = parseOverlay(overlayFixture(), "staging");

function refuses(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof RefusedError, `expected a RefusedError, got ${String(e)}`);
    assert.match(e.message, pattern);
    return true;
  });
}

describe("the allow-list guard (BD-11)", () => {
  const guard = new Guard(overlay);

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
    const lenient = new Guard(parseOverlay(o, "staging"));
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

  it("allows spike-only and fallback-only names only behind their flags", () => {
    refuses(() => guard.checkName(`c1-spike.${ZONE}`, "dns"), /--spike/);
    refuses(() => guard.checkName(`console-api.${ZONE}`, "dns"), /--fallback/);
    const flagged = new Guard(overlay, { spike: true, fallback: true });
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
