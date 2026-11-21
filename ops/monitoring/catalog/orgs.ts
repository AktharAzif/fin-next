// The organisations area's lines (spec 02 §18.1), written by packages/orgs through identity's
// line port. Its guards' auth.gate_refused and step_up.refused are identity's lines
// (identity.ts), and its changes are recorded as audit events. team-change-failing (N, spec 02
// §18.2) reads the request lines of the team and role routes, and comes with the area's alert
// fragment (alerts/orgs.json).
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
