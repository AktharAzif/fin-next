// eventTypeRows() (spec 08 §3.2) orders the registry by code point, the order T08-02 reads it back in
// with `ORDER BY name COLLATE "C"`: never by `localeCompare`, whose ICU order puts "_" before "." and
// so differs from "C" for a name with an underscore where another has its dot.
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
  metadata: z.object({ deleted: z.number() }).strict(),
};

describe("eventTypeRows", () => {
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
});
