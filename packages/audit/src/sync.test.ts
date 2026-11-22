// eventTypeRows() (spec 08 §3.2): the rows `migrate` syncs to audit.event_type come in code-point
// (byte) order, the same on every host, the order T08-02 reads them back in with
// `ORDER BY name COLLATE "C"` whatever collation the cluster was created with: never by a locale or
// `localeCompare`, whose ICU order puts "_" before "." and so differs from "C" for a name with an
// underscore where another has its dot.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { EventSpec } from "./define.ts";
import { eventTypeRows } from "./sync.ts";

const spec: EventSpec = {
  category: "operations",
  scope: "staff",
  roles: ["fin_worker"],
  actors: ["system"],
  target: "table",
  metadata: z.object({}).strict(),
};

describe("eventTypeRows", () => {
  it("orders names by code unit, never by a locale", () => {
    const names = ["backup_codes.regenerated", "b.x", "backup_code.used", "a.x", "B.x"];
    const events = Object.fromEntries(names.map((name) => [name, spec]));
    // A locale puts "a.x" before "B.x"; byte order, like COLLATE "C", the other way round.
    expect(eventTypeRows(events, {}).map((row) => row.name)).toEqual([
      "B.x",
      "a.x",
      "b.x",
      "backup_code.used",
      "backup_codes.regenerated",
    ]);
  });

  it('orders the names by code point, as COLLATE "C" does', () => {
    const names = ["test_thing.done", "test.thing", "backup_codes.regenerated", "backup_code.used"];
    const rows = eventTypeRows(Object.fromEntries(names.map((name) => [name, spec])), {});
    expect(rows.map((row) => row.name)).toEqual([
      "backup_code.used",
      "backup_codes.regenerated",
      "test.thing",
      "test_thing.done",
    ]);
  });

  it("gives the compiled registry in code-unit order", () => {
    const names = eventTypeRows().map((row) => row.name);
    // Array.prototype.sort with no comparator orders strings by UTF-16 code unit.
    expect(names).toEqual([...names].sort());
    expect(names.indexOf("backup_code.used")).toBeLessThan(
      names.indexOf("backup_codes.regenerated"),
    );
  });
});
