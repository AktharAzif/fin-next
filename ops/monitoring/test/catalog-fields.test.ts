// The catalogue names each field as its writers write it (spec 08 §7.2), so an alert that reads a
// field (MC-04 holds it to the catalogue) reads one a writer writes. Where a writer sits in this
// tree, the test reads its file for the key, so a rename on either side fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function declared(event: string): string[] {
  const entry = Object.values(fragments)
    .flat()
    .find((e) => e.event === event);
  return Object.keys(entry?.fields ?? {});
}

/** Each event, a file that writes it, and the fields that file writes under these names. */
const WRITTEN: readonly [event: string, file: string, fields: readonly string[]][] = [
  // The database probe's reading of the oldest unchained audit row.
  ["job.run", "apps/api/src/worker/probe/probe.ts", ["auditUnsequencedS"]],
  // The audit sequencer's own reading, on its once-a-minute line with the passes it ran.
  ["job.run", "packages/audit/src/sequencer.ts", ["oldestUnsequencedS", "runs"]],
  [
    "process.start",
    "packages/server/src/runtime.ts",
    ["node", "target", "port", "drainSeconds", "shipping", "reporting"],
  ],
  ["process.start", "apps/connector/src/main.ts", ["node", "tunnel", "version", "state"]],
  ["audit.write_failed", "packages/audit/src/record.ts", ["auditEvent", "sqlstate"]],
  ["deploy.static_step", "ops/fin/src/static/deploy.ts", ["deployedRelease"]],
  ["deploy.static_step", "tools/static-deploy/src/main.ts", ["deployedRelease"]],
  ["deploy.static_done", "ops/fin/src/static/deploy.ts", ["deployedRelease"]],
  ["deploy.static_done", "tools/static-deploy/src/main.ts", ["deployedRelease"]],
];

describe("the catalogue's fields", () => {
  it("are the names the writers write", () => {
    for (const [event, file, fields] of WRITTEN) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, `${file} writes ${event}`).toContain(`"${event}"`);
      for (const field of fields) {
        expect(new RegExp(`(?<![\\w$])${field}(?:\\s*:|,)`).test(text), `${file}: ${field}`).toBe(
          true,
        );
        expect(declared(event), `${event} declares ${field}`).toContain(field);
      }
    }
  });

  it("name what the identity lines write once their envelope names are gone", () => {
    // fix/audit-event-identity renames identity's `event` and `level` fields, which the envelope
    // owns (the telemetry drops a field of an envelope name): the catalogue holds the new names.
    expect(declared("audit.write_failed")).toEqual(["auditEvent", "sqlstate"]);
    expect(declared("auth.library_log")).toEqual(["realm", "libraryLevel"]);
  });
});
