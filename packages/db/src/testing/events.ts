// Registers audit event types directly, for the data layer's own tests: @fin/audit's registry sync is
// what fills audit.event_type in a real run, and it depends on this package, not the other way round.
import { createIdSource } from "../ids.ts";
import type { PgClient } from "../pg.ts";

export interface TestEventType {
  name: string;
  roles: readonly string[];
  scope?: "organisation" | "person" | "staff";
  category?: string;
  /** The revocation-journal kind the event declares (spec 08 §3.10), if any. */
  journalKind?: string;
  retired?: boolean;
}

export async function registerEventTypes(
  owner: PgClient,
  types: readonly TestEventType[],
): Promise<void> {
  for (const type of types) {
    await owner.query(
      `INSERT INTO audit.event_type (name, area, category, scope, roles, journal_kind, retired, synced_release)
       VALUES ($1, 'test', $2, $3, $4, $5, $6, 'test-release')
       ON CONFLICT (name) DO UPDATE SET roles = excluded.roles, scope = excluded.scope,
         category = excluded.category, journal_kind = excluded.journal_kind, retired = excluded.retired`,
      [
        type.name,
        type.category ?? "operations",
        type.scope ?? "staff",
        type.roles,
        type.journalKind ?? null,
        type.retired ?? false,
      ],
    );
  }
}

const ids = createIdSource({ now: () => Date.now() });

/** A well-formed `aud_` (or other prefix) ID for SQL-level tests. */
export function testId(prefix: string): string {
  return ids.newId(prefix);
}
