// The registry in the database (spec 08 §3.2): after every migration run, `migrate` (as fin_owner)
// upserts audit.event_type from the compiled AUDIT_EVENTS. It adds and updates rows and never deletes
// one; a row whose values are unchanged is left alone, so a second run changes nothing (T08-02).
import type { Queryable } from "@fin/db";
import type { EventSpec } from "./define.ts";
import { AUDIT_EVENT_AREAS, AUDIT_EVENTS } from "./events/_index.gen.ts";

export interface EventTypeRow {
  name: string;
  area: string;
  category: string;
  scope: string;
  roles: string[];
  retired: boolean;
}

export function eventTypeRows(
  events: Readonly<Record<string, EventSpec>> = AUDIT_EVENTS,
  areas: Readonly<Record<string, string>> = AUDIT_EVENT_AREAS,
): EventTypeRow[] {
  return Object.entries(events)
    .map(([name, spec]) => ({
      name,
      area: areas[name] ?? "unknown",
      category: spec.category,
      scope: spec.scope,
      roles: [...spec.roles].sort(),
      retired: spec.retired === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SyncResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

export async function syncEventTypes(
  q: Queryable,
  release: string,
  rows: readonly EventTypeRow[] = eventTypeRows(),
): Promise<SyncResult> {
  const result = await q.query<{ inserted: boolean }>(
    `INSERT INTO audit.event_type AS t (name, area, category, scope, roles, retired, synced_release)
     SELECT r.name, r.area, r.category, r.scope, r.roles, r.retired, $2
     FROM jsonb_to_recordset($1::jsonb) AS r(name text, area text, category text, scope text, roles text[], retired boolean)
     ON CONFLICT (name) DO UPDATE SET
       area = excluded.area, category = excluded.category, scope = excluded.scope,
       roles = excluded.roles, retired = excluded.retired, synced_release = excluded.synced_release
     WHERE (t.area, t.category, t.scope, t.roles, t.retired)
       IS DISTINCT FROM (excluded.area, excluded.category, excluded.scope, excluded.roles, excluded.retired)
     RETURNING (xmax = 0) AS inserted`,
    [JSON.stringify(rows), release],
  );
  const inserted = result.rows.filter((r) => r.inserted).length;
  const updated = result.rows.length - inserted;
  return { inserted, updated, unchanged: rows.length - result.rows.length };
}
