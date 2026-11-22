// The organisations area's lines (spec 02 §18.1), written by packages/orgs through identity's
// line port. Its guards' auth.gate_refused and step_up.refused are identity's lines
// (identity.ts), and its changes are recorded as audit events. Spec 02 §18.2's alert for the area,
// team-change-failing, reads the request lines of the team and role routes: the request entry
// (platform.ts) owes it, and owed.ts lists it with its lane and date until the area's alert
// fragment (alerts/orgs.json) defines it.
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "org.switched",
    kind: "info",
    level: "info",
    writtenBy: "packages/orgs, when a developer's session switches to another organisation",
    fields: { orgId: "string", userId: "string" },
    alerts: [],
  },
];
