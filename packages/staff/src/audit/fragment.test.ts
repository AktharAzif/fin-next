// The registry's copy of the staff area's events (spec 08 §3.2): packages/audit/src/events/staff.ts is
// what `migrate` syncs to audit.event_type, so audit.record() takes exactly what this package and
// the staff realm record (`migrate --task staff-bootstrap` included). It holds this package's
// events and @fin/identity's staff-realm events and nothing else, each matching field by field:
// category, scope, roles, actors, target prefix, metadata schema and revocation-journal entry.
// This package does not depend on @fin/audit, so its turbo.json lists the registry files read
// here among its test and typecheck inputs: an edit to the registry's copy alone reruns this test
// rather than replaying it from cache (layout:check's task-inputs rule holds the list complete).
import { STAFF_REALM_EVENTS } from "@fin/identity";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { events as fragment } from "../../../audit/src/events/staff.ts";
import { STAFF_EVENTS } from "./events.ts";

interface Spec {
  readonly category: string;
  readonly scope: string;
  readonly roles: readonly string[];
  readonly actors: readonly string[];
  readonly target: string;
  readonly metadata: z.ZodType;
  readonly journal?: { readonly kind: string; readonly when?: unknown };
}

/** What the registry and audit.record() read of an event; a target that is no one prefix is a label. */
function shape(spec: Spec) {
  return {
    category: spec.category,
    scope: spec.scope,
    roles: [...spec.roles].sort(),
    actors: [...spec.actors].sort(),
    prefix: /^[a-z]{3}$/.test(spec.target) ? spec.target : null,
    metadata: z.toJSONSchema(spec.metadata),
    journal: spec.journal?.kind ?? null,
    when: spec.journal?.when !== undefined,
  };
}

function shapes(events: Readonly<Record<string, Spec>>) {
  return Object.fromEntries(Object.entries(events).map(([name, spec]) => [name, shape(spec)]));
}

describe("the registry's staff fragment", () => {
  it("is this package's events and the staff realm's, exactly", () => {
    expect(shapes(fragment)).toEqual(shapes({ ...STAFF_REALM_EVENTS, ...STAFF_EVENTS }));
  });

  it("journals a role change exactly when this package does", () => {
    const ours = STAFF_EVENTS["staff.role_changed"].journal.when;
    const registered = fragment["staff.role_changed"].journal?.when;
    for (const metadata of [
      { fromRole: "admin", toRole: "viewer", reason: "changed", lowered: true },
      { fromRole: "viewer", toRole: "admin", reason: "changed", lowered: false },
    ] as const) {
      expect(registered?.(metadata)).toBe(ours(metadata));
    }
  });
});
