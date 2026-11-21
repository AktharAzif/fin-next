import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { describe, it } from "node:test";
import { ConfigError } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import { hostOf, loadOverlay, parseOverlay, registerOverlay } from "../src/core/overlay.ts";
import { overlayFixture, privateValues, tempDir, writeOverlay, ZONE } from "./helpers/fixtures.ts";

type Fixture = ReturnType<typeof overlayFixture>;

function withChange(change: (o: Fixture) => void): Fixture {
  const o = overlayFixture();
  change(o);
  return o;
}

describe("the overlay", () => {
  it("loads a valid overlay and masks every private value", () => {
    const dir = tempDir();
    const m = new Masker();
    const o = loadOverlay({ FIN_OVERLAY_FILE: writeOverlay(dir) }, "staging", m);
    assert.equal(o.zone, ZONE);
    assert.equal(hostOf(o, "admin"), `staff.${ZONE}`);
    for (const value of privateValues()) {
      assert.equal(m.leaks(`x ${value} y`), true, `${value} should be masked`);
    }
    assert.equal(m.mask(`staff.${ZONE}`), "<host:admin>");
    assert.equal(m.mask(`auth.${ZONE}`), "<email:auth>");
    assert.equal(m.mask(`other.${ZONE}`), "other.<zone>");
  });

  it("leaves the plan's public labels readable", () => {
    const m = new Masker();
    registerOverlay(overlayFixture(), m);
    assert.equal(
      m.mask("console staff onboard gateway _dmarc.auth staging"),
      "console staff onboard gateway _dmarc.auth staging",
    );
    assert.equal(m.mask("legacy"), "legacy");
    assert.equal(m.mask(`legacy.${ZONE}`), "<never-touch>");
  });

  it("refuses an overlay for another environment", () => {
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => (o.environment = "production")),
          "staging",
        ),
      /this run is for "staging"/,
    );
  });

  it("refuses a host outside the zone, two labels deep, or not on the allow-list", () => {
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => (o.hosts.console = "console.other.example")),
          "staging",
        ),
      /not under the zone/,
    );
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => (o.hosts.console = `a.console.${ZONE}`)),
          "staging",
        ),
      /one label below/,
    );
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => (o.hosts.console = `unlisted.${ZONE}`)),
          "staging",
        ),
      /allowedNames.labels does not list/,
    );
  });

  it("refuses an overlay whose allow-list and never-touch list share a label", () => {
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => o.neverTouch.labels.push("console")),
          "staging",
        ),
      /share a label/,
    );
  });

  it("refuses bad shapes without echoing the value", () => {
    try {
      parseOverlay(
        withChange((o) => (o.cloudflare.zoneId = "not-an-id-but-private")),
        "staging",
      );
      assert.fail("should refuse");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /cloudflare.zoneId has the wrong shape/);
      assert.equal(error.message.includes("not-an-id-but-private"), false);
    }
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => (o.access.staff = ["not an email"])),
          "staging",
        ),
      /access.staff\[0\]/,
    );
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => Object.assign(o.hosts, { unknown: `x.${ZONE}` })),
          "staging",
        ),
      /not a known host role/,
    );
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => (o.staticEgress = { worker: ["not-an-ip"] })),
          "staging",
        ),
      /not an IP/,
    );
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => (o.thresholds = { "api-v4": -1 })),
          "staging",
        ),
      /positive integer/,
    );
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => Object.assign(o.dmarc, { rua: "https://x" })),
          "staging",
        ),
      /dmarc.rua/,
    );
  });

  it("refuses a missing, unreadable-by-others or invalid file", () => {
    const m = new Masker();
    assert.throws(() => loadOverlay({}, "staging", m), /FIN_OVERLAY_FILE is not set/);
    assert.throws(
      () => loadOverlay({ FIN_OVERLAY_FILE: "/nonexistent/overlay.json" }, "staging", m),
      /does not exist/,
    );
    const dir = tempDir();
    const path = writeOverlay(dir);
    chmodSync(path, 0o644);
    assert.throws(() => loadOverlay({ FIN_OVERLAY_FILE: path }, "staging", m), /others can read/);
    const bad = writeOverlay(tempDir(), "{");
    assert.throws(
      () => loadOverlay({ FIN_OVERLAY_FILE: bad }, "staging", m),
      /valid JSON|wrong shape|must be/,
    );
  });

  it("masks the values even when validation fails", () => {
    const m = new Masker();
    const dir = tempDir();
    const path = writeOverlay(
      dir,
      withChange((o) => (o.environment = "production")),
    );
    assert.throws(() => loadOverlay({ FIN_OVERLAY_FILE: path }, "staging", m));
    assert.equal(m.mask(ZONE), "<zone>");
  });
});
