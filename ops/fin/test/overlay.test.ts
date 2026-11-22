import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { describe, it } from "node:test";
import { ConfigError } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import {
  hostOf,
  loadOverlay,
  neverTouchLabel,
  parseOverlay,
  registerOverlay,
  registerOverlayFile,
  thresholdOf,
} from "../src/core/overlay.ts";
import { overlayFixture, privateValues, tempDir, writeOverlay, ZONE } from "./helpers/fixtures.ts";

type Fixture = ReturnType<typeof overlayFixture>;

function withChange(change: (o: Fixture) => void): Fixture {
  const o = overlayFixture();
  change(o);
  return o;
}

/** The fixture plus the free-form private keys spec 01 §9.2 places in the overlay. */
function richOverlay(): Record<string, unknown> {
  return {
    ...overlayFixture(),
    grace: { "backup-hourly": 3900, "api-heartbeat": 305 },
    oncall: {
      roster: [{ name: "first responder", quietHours: "23-07", note: "roster-note-private" }],
      escalateAfterMinutes: 17,
    },
    providerNotes: { railway: { note: "private-fee-terms-observed" } },
    annex: {
      _comment: "annex-comment-private",
      limits: { note: "owner-unreachable-window" },
      text: "responders: only the owner\nthe owner is unreachable 01:00-07:00",
    },
    db: {
      caFingerprint: "-----BEGIN CERTIFICATE-----\nMIIBfakefakefake\n-----END CERTIFICATE-----",
    },
    betterstack: { teamId: 2_345_678 },
  };
}

function refusal(raw: unknown): ConfigError {
  try {
    parseOverlay(raw, "staging");
  } catch (error) {
    assert.ok(error instanceof ConfigError, String(error));
    return error;
  }
  assert.fail("the overlay should be refused");
}

describe("the overlay", () => {
  it("loads a valid overlay and masks every private value", () => {
    const dir = tempDir();
    const m = new Masker();
    const o = loadOverlay({ FIN_OVERLAY_FILE: writeOverlay(dir) }, "staging", m);
    assert.equal(o.zone, ZONE);
    assert.equal(hostOf(o, "admin"), `staff.${ZONE}`);
    assert.equal(thresholdOf(o, "api-v4").reveal(), 100);
    assert.equal(`${thresholdOf(o, "api-v4")}`, "<threshold:api-v4>");
    assert.throws(() => thresholdOf(o, "constructor"), /no thresholds.constructor/);
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
      m.mask("console staff onboard gateway _dmarc.auth staging reject"),
      "console staff onboard gateway _dmarc.auth staging reject",
    );
    assert.equal(m.mask("legacy"), "legacy");
    assert.equal(m.mask(`legacy.${ZONE}`), "<never-touch>");
  });

  it("protects the private numbers by type, never by value, so no counter equal to one is masked", () => {
    const m = new Masker();
    registerOverlay(richOverlay(), m);
    // The thresholds, grace periods and the roster's timings are short numbers: matching them by
    // value would mask (and so disclose them through) the tool's own counters.
    for (const n of [100, 3900, 305, 17]) {
      assert.equal(m.leaks(`record ${n} of ${n}`), false, String(n));
      assert.equal(m.addMaskCommands().includes(`::add-mask::${n}`), false, String(n));
    }
    assert.deepEqual(m.maskValue({ seq: 100, steps: 17, plan: { create: 305 } }), {
      seq: 100,
      steps: 17,
      plan: { create: 305 },
    });
    // The one the code reads prints its role wherever it goes; a long number (an ID) is masked.
    const o = parseOverlay(richOverlay(), "staging");
    assert.equal(
      m.mask(`~ update rule api-v4 [threshold] ${thresholdOf(o, "api-v4")}`),
      "~ update rule api-v4 [threshold] <threshold:api-v4>",
    );
    assert.deepEqual(m.maskValue({ threshold: thresholdOf(o, "api-v4") }), {
      threshold: "<threshold:api-v4>",
    });
    assert.equal(m.mask("team 2345678 answered"), "team <overlay:betterstack.teamId> answered");
    assert.ok(m.addMaskCommands().includes("::add-mask::2345678"));
  });

  it("exempts comments and notes only at the paths the plan publishes", () => {
    const m = new Masker();
    registerOverlay(richOverlay(), m);
    for (const value of [
      "roster-note-private",
      "private-fee-terms-observed",
      "annex-comment-private",
      "owner-unreachable-window",
      "first responder",
      "the owner is unreachable 01:00-07:00",
      "MIIBfakefakefake",
    ]) {
      assert.equal(m.leaks(`x ${value} y`), true, value);
    }
    // dmarc.note and the allow-list's comment are the plan's own words.
    assert.equal(m.leaks("x fixture y"), false);
  });

  it("never shows a key that is not a plain name, in a placeholder or a refusal", () => {
    // Maps written the wrong way round: the private value sits in key position.
    const address = ["198", "51", "100", "77"].join(".");
    const hostKey = "console.private-zone.example";
    const sender = "auth.private-sender.example";
    const cases: Array<[Record<string, unknown>, string, RegExp, string]> = [
      [
        withChange((o) => Object.assign(o, { staticEgress: { [address]: ["worker"] } })),
        address,
        /staticEgress holds a key that is not a service's name/,
        "worker",
      ],
      [
        withChange((o) => Object.assign(o.hosts, { [hostKey]: "console" })),
        hostKey,
        /hosts holds a key that is not a host role/,
        "console",
      ],
      [
        withChange((o) => Object.assign(o, { emailSubdomains: { [sender]: "auth" } })),
        sender,
        /emailSubdomains holds a key that is not a sending subdomain's name/,
        "auth",
      ],
    ];
    for (const [overlay, key, message, value] of cases) {
      const error = refusal(overlay);
      assert.match(error.message, message);
      assert.equal(error.message.includes(key), false, key);
      const m = new Masker();
      registerOverlay(overlay, m);
      assert.equal(m.leaks(`x ${key} y`), true, `${key} is masked like a value`);
      const placeholder = m.mask(value);
      assert.notEqual(placeholder, value);
      assert.equal(placeholder.includes(key), false, `${placeholder} names no private key`);
      assert.equal(m.mask(error.message).includes(key), false);
    }
  });

  it("takes ops/monitoring's thresholds (a ratio too) and grace periods, each printing its role", () => {
    const raw = withChange((o) =>
      Object.assign(o, {
        thresholds: { "api-v4": 100, "5xx-rate-api": 0.05, "5xx-rate-min-count": 20 },
        grace: { watcher: 120 },
      }),
    );
    const o = parseOverlay(raw, "staging");
    assert.equal(thresholdOf(o, "5xx-rate-api").reveal(), 0.05);
    assert.equal(`${thresholdOf(o, "5xx-rate-api")}`, "<threshold:5xx-rate-api>");
    assert.equal(o.grace.watcher?.reveal(), 120);
    assert.equal(`${o.grace.watcher}`, "<grace:watcher>");
    // A name that starts with a digit is a plain name: the plan's own alert names stay readable.
    const m = new Masker();
    registerOverlay(raw, m);
    assert.equal(m.mask("+ alert 5xx-rate-api"), "+ alert 5xx-rate-api");
    for (const [change, message] of [
      [{ thresholds: { "api-v4": 0 } }, /thresholds.api-v4 must be a positive number/],
      [{ thresholds: { "12345": 3 } }, /thresholds holds a key that is not an overlay key's name/],
      [{ thresholds: { "Clock-Skew": 3 } }, /thresholds holds a key that is not/],
      [{ grace: { watcher: 1.5 } }, /grace.watcher must be a positive integer/],
      [{ grace: { watcher: "60" } }, /grace.watcher must be a positive integer/],
      [{ grace: [] }, /grace must be an object/],
    ] as const) {
      assert.match(refusal(withChange((o) => Object.assign(o, change))).message, message);
    }
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

  it("normalises never-touch entries, so a trailing dot, the zone or spaces still protect the name", () => {
    for (const entry of [
      "legacy2.",
      `legacy2.${ZONE}.`,
      `legacy2.${ZONE}`,
      " legacy2",
      "LEGACY2 ",
    ]) {
      assert.equal(neverTouchLabel(entry, ZONE), "legacy2", entry);
      const o = withChange((x) => {
        x.neverTouch.labels.push(entry);
        x.allowedNames.labels.push("legacy2");
      });
      assert.throws(() => parseOverlay(o, "staging"), /share a label/, entry);
      const clean = withChange((x) => x.neverTouch.labels.push(entry));
      assert.ok(parseOverlay(clean, "staging").neverTouch.labels.includes("legacy2"), entry);
    }
    assert.equal(neverTouchLabel(ZONE, ZONE), "@");
    // `*.legacy2` is not a label either; its refusal names the fix (never-touch.test.ts).
    assert.equal(neverTouchLabel("*.legacy2", ZONE), undefined);
    for (const entry of ["legacy 2", "", "a..b", "*", `*.${ZONE}`]) {
      assert.equal(neverTouchLabel(entry, ZONE), undefined, entry);
      assert.throws(
        () =>
          parseOverlay(
            withChange((x) => x.neverTouch.labels.push(entry)),
            "staging",
          ),
        /neverTouch.labels\[\d+\] is not a label under the zone/,
        entry,
      );
    }
  });

  it("refuses an allowed name that sits under a never-touch label", () => {
    for (const label of ["api.legacy", "_dmarc.www", "_acme-challenge.app"]) {
      assert.throws(
        () =>
          parseOverlay(
            withChange((o) => o.allowedNames.labels.push(label)),
            "staging",
          ),
        /share a label/,
        label,
      );
    }
  });

  it("accepts the DMARC policy only as none, quarantine or reject, and normalises p=", () => {
    assert.equal(parseOverlay(overlayFixture(), "staging").dmarc.policy, "reject");
    assert.throws(
      () =>
        parseOverlay(
          withChange((o) => (o.dmarc.policy = "p=off")),
          "staging",
        ),
      /dmarc.policy must be one of none, quarantine, reject/,
    );
  });

  it("takes the allowed domains and the zone ID as optional", () => {
    const o = parseOverlay(
      withChange((x) => {
        Reflect.deleteProperty(x.access, "allowDomains");
        Reflect.deleteProperty(x.cloudflare, "zoneId");
      }),
      "staging",
    );
    assert.deepEqual(o.access.allowDomains, []);
    assert.equal(o.cloudflare.zoneId, undefined);
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
      /not a host role/,
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
      /thresholds.api-v4 must be a positive number/,
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

  it("registers the values for a command that does not need the overlay, without validating it", () => {
    const m = new Masker();
    const path = writeOverlay(
      tempDir(),
      withChange((o) => (o.environment = "production")),
    );
    assert.deepEqual(registerOverlayFile({ FIN_OVERLAY_FILE: path }, m), { registered: true });
    assert.equal(m.mask(ZONE), "<zone>");
    assert.equal(registerOverlayFile({}, new Masker()).registered, false);
  });
});
