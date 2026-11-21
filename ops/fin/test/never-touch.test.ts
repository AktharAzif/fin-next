// Planted tests for the never-touch list (the steward's request of 22 Nov). An overlay once held a
// never-touch entry spelled `*.X` whose base label X was not listed. The guard reads a label as
// covering itself and every name under it, so `*.X`, read as one literal name, protected nothing
// below X. The overlay check refuses such an entry and names the fix (write the base label); with
// X written in its place the check passes and the guard refuses X and every name under it, in any
// case. A wildcard stays refused when X is listed beside it (it fails closed; remove the wildcard).

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.ts";
import { ConfigError, EXIT, RefusedError } from "../src/core/errors.ts";
import { Guard } from "../src/core/guard.ts";
import { neverTouchWildcardBase, type Overlay, parseOverlay } from "../src/core/overlay.ts";
import {
  ACCOUNT_ID,
  fakeRuntime,
  overlayFixture,
  tempDir,
  writeOverlay,
  ZONE,
  ZONE_ID,
} from "./helpers/fixtures.ts";

/** The planted base label: not in the fixture's lists, and under none of its never-touch labels. */
const X = "retired";
/** What the operator must write instead of the wildcard. */
const WRITE_THE_BASE = /write the base label instead \(the entry without its leading \*\.\)/;

/** The fixture with these never-touch entries added. */
function withNeverTouch(...entries: string[]): ReturnType<typeof overlayFixture> {
  const o = overlayFixture();
  o.neverTouch.labels.push(...entries);
  return o;
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

/** `pnpm fin overlay check staging` against this overlay: its exit code and what it printed. */
async function overlayCheck(raw: unknown): Promise<{ code: number; out: string; err: string }> {
  const dir = tempDir();
  const env = { FIN_OVERLAY_FILE: writeOverlay(dir, raw), FIN_STATE_DIR: join(dir, "state") };
  const r = fakeRuntime({ env });
  const code = await runCli(["overlay", "check", "staging"], r);
  return { code, out: r.out(), err: r.err() };
}

/** A guard bound to the overlay's zone, as a command has it after reading the zone. */
function bound(overlay: Overlay): Guard {
  const guard = new Guard(overlay);
  guard.bindZone({ id: ZONE_ID, name: ZONE, account: { id: ACCOUNT_ID, name: "fixture" } });
  return guard;
}

function refusesNeverTouch(fn: () => unknown, name: string): void {
  assert.throws(
    fn,
    (e: unknown) => {
      assert.ok(e instanceof RefusedError, `expected a RefusedError, got ${String(e)}`);
      assert.match(e.message, /is on, or under, the overlay's never-touch list/);
      return true;
    },
    name,
  );
}

describe("a never-touch entry spelled *.X", () => {
  it("is read as a wildcard over X, in any spelling the list accepts for X", () => {
    for (const entry of [
      `*.${X}`,
      ` *.${X.toUpperCase()} `,
      `*.${X}.`,
      `*.${X}.${ZONE}`,
      `*.${X}.${ZONE.toUpperCase()}.`,
    ]) {
      assert.equal(neverTouchWildcardBase(entry, ZONE), X, entry);
    }
    assert.equal(neverTouchWildcardBase(`*.a.${X}`, ZONE), `a.${X}`);
    for (const entry of [X, "*", `*.${ZONE}`, "*.@", `*.*.${X}`, `**.${X}`, `a.*.${X}`]) {
      assert.equal(neverTouchWildcardBase(entry, ZONE), undefined, entry);
    }
  });

  it("fails the check when X is not listed, with a message that names the fix and not the label", async () => {
    for (const entry of [`*.${X}`, `*.${X.toUpperCase()}`, `*.${X}.${ZONE}.`]) {
      const raw = withNeverTouch(entry);
      const index = raw.neverTouch.labels.length - 1;
      const error = refusal(raw);
      assert.equal(error.exitCode, EXIT.config);
      assert.match(
        error.message,
        new RegExp(`neverTouch\\.labels\\[${index}\\] is a wildcard \\(\\*\\.<label>\\)`),
        entry,
      );
      assert.match(error.message, WRITE_THE_BASE, entry);
      assert.match(error.message, /a never-touch label covers itself and every name under it/);
      assert.equal(error.message.toLowerCase().includes(X), false, "the label is not echoed");

      const check = await overlayCheck(raw);
      assert.equal(check.code, EXIT.config, entry);
      assert.match(check.err, WRITE_THE_BASE, entry);
      assert.doesNotMatch(check.out, /valid/);
      assert.equal(`${check.out}\n${check.err}`.toLowerCase().includes(X), false);
    }
  });

  it("stays refused when X is listed too, with a message that says to remove it", async () => {
    for (const entries of [
      [`*.${X}`, X],
      [X, `*.${X}`],
      [X, `*.a.${X}`],
    ]) {
      const error = refusal(withNeverTouch(...entries));
      assert.match(
        error.message,
        /is a wildcard \(\*\.<label>\) that a listed never-touch label already covers: remove it/,
        entries.join(" "),
      );
      assert.doesNotMatch(error.message, WRITE_THE_BASE);
      assert.equal((await overlayCheck(withNeverTouch(...entries))).code, EXIT.config);
    }
  });

  it("would protect nothing below X if it were read as one literal name, which is why it fails", () => {
    // An overlay the check refuses, built by hand: the guard reads `*.retired` as one name.
    const parsed = parseOverlay(overlayFixture(), "staging");
    const literal: Overlay = {
      ...parsed,
      allowedNames: { ...parsed.allowedNames, labels: [...parsed.allowedNames.labels, `api.${X}`] },
      neverTouch: { labels: [...parsed.neverTouch.labels, `*.${X}`] },
    };
    assert.equal(bound(literal).checkName(`api.${X}.${ZONE}`, "dns"), `api.${X}`);
  });
});

describe("a never-touch base label X", () => {
  it("passes the check, and the guard refuses X, a.X and a.b.X", async () => {
    const raw = withNeverTouch(X);
    const overlay = parseOverlay(raw, "staging");
    assert.ok(overlay.neverTouch.labels.includes(X));
    const check = await overlayCheck(raw);
    assert.equal(check.code, EXIT.ok, check.err);
    assert.match(check.out, /overlay for staging: valid/);
    assert.match(check.out, /never-touch: 6$/m);

    const guard = bound(overlay);
    for (const label of [X, `a.${X}`, `a.b.${X}`]) {
      refusesNeverTouch(() => guard.checkName(`${label}.${ZONE}`, "dns"), label);
      refusesNeverTouch(() => guard.checkRoutePattern(`${label}.${ZONE}/*`), label);
    }
    // A label that only ends with X's letters is not under X.
    assert.throws(() => guard.checkName(`a${X}.${ZONE}`, "dns"), /not on the overlay's allow-list/);
  });

  it("refuses names under X even when the allow-list names them, and whatever the flags", () => {
    const parsed = parseOverlay(withNeverTouch(X), "staging");
    const loose: Overlay = {
      ...parsed,
      allowedNames: {
        labels: [...parsed.allowedNames.labels, `a.${X}`],
        spikeOnly: [...parsed.allowedNames.spikeOnly, `a.b.${X}`],
        fallbackOnly: [...parsed.allowedNames.fallbackOnly, X],
      },
    };
    const guard = new Guard(loose, { spike: true, fallback: true });
    guard.bindZone({ id: ZONE_ID, name: ZONE, account: { id: ACCOUNT_ID } });
    for (const label of [X, `a.${X}`, `a.b.${X}`]) {
      refusesNeverTouch(() => guard.checkName(`${label}.${ZONE}`, "dns"), label);
    }
  });
});

describe("a write under a never-touch label, whatever its case", () => {
  const names = [
    `${X.toUpperCase()}.${ZONE}`,
    `Retired.${ZONE.toUpperCase()}.`,
    `A.${X}.${ZONE}`,
    `a.ReTiReD.${ZONE}`,
    `A.B.${X.toUpperCase()}.${ZONE.toUpperCase()}`,
    ` a.B.rEtIrEd.${ZONE}. `,
  ];

  it("is refused when the overlay writes the label in any case", () => {
    for (const entry of [
      X,
      X.toUpperCase(),
      "ReTiReD",
      `${X.toUpperCase()}.${ZONE.toUpperCase()}.`,
    ]) {
      const overlay = parseOverlay(withNeverTouch(entry), "staging");
      const guard = bound(overlay);
      for (const name of names) {
        refusesNeverTouch(() => guard.checkName(name, "dns"), `${entry}: ${name}`);
      }
      refusesNeverTouch(
        () => guard.checkRoutePattern(`A.${X.toUpperCase()}.${ZONE}/api/*`),
        `${entry}: route`,
      );
    }
  });

  it("is refused by the guard on its own, from a never-touch label in upper case", () => {
    // The parser lowers every label; the guard lowers them again rather than trust it.
    const parsed = parseOverlay(overlayFixture(), "staging");
    const upper: Overlay = {
      ...parsed,
      allowedNames: { ...parsed.allowedNames, labels: [...parsed.allowedNames.labels, `a.${X}`] },
      neverTouch: { labels: [...parsed.neverTouch.labels, X.toUpperCase()] },
    };
    const guard = bound(upper);
    for (const name of names) refusesNeverTouch(() => guard.checkName(name, "dns"), name);
  });
});
