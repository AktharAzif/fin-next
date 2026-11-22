// The ops area's audit guards (spec 08 §3.5, D08-20), installed by migrations/*_ops_core.sql.
import { defineGuards } from "./types.ts";

export const guards = defineGuards([
  {
    table: "ops.kill_switch",
    ops: ["INSERT", "UPDATE OF state"],
    keyColumn: "name",
    events: ["switch.set", "switch.cleared", "switch.tripped"],
  },
]);
