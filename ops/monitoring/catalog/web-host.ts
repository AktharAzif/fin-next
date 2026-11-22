// The web-host area's events: the API half's front door (spec 02 §4.1, §10.5 and §18.1), written by
// packages/web-host. The alerts spec 02 §18.2 names for them are in the identity and staff areas'
// alert fragments (alerts/identity.json, alerts/staff.json), or the entry says why none.
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "auth.endpoint_blocked",
    kind: "security",
    level: "warn",
    writtenBy: "every API half, for a /api/auth/* path its realm does not list or blocks (404)",
    fields: { realm: "string", class: "string" },
    alerts: ["auth-endpoint-unlisted"],
  },
  {
    event: "access.keys_unavailable",
    kind: "failure",
    level: "error",
    writtenBy: "Fin Admin's API half, when Cloudflare Access's signing keys cannot be read (503)",
    fields: {},
    alerts: ["access-keys-unavailable"],
  },
  {
    event: "access.jwt_refused",
    kind: "security",
    level: "warn",
    writtenBy: "Fin Admin's API half, for a missing or invalid Access token (401)",
    fields: { reason: "string" },
    alerts: [],
    noAlert:
      "spec 02 §18.2 names no alert for it: the request is refused before any handler, and Access stands in front of the host",
  },
];
