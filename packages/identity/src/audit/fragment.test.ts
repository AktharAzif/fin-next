// The registry's copy of this package's events (spec 08 §3.2): packages/audit/src/events/identity.ts,
// and the staff realm's half of staff.ts, are what `migrate` syncs to audit.event_type, so
// audit.record() takes exactly what this package records. Every event matches there field by field:
// category, scope, roles, actors, target prefix and metadata schema. This package does not depend
// on @fin/audit, so its turbo.json lists the registry files read here among its test and typecheck
// inputs: an edit to the registry's copy alone reruns this test rather than replaying it from
// cache (layout:check's task-inputs rule holds the list complete).
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { events as identityFragment } from "../../../audit/src/events/identity.ts";
import { events as staffFragment } from "../../../audit/src/events/staff.ts";
import { IDENTITY_EVENTS, STAFF_REALM_EVENTS } from "./events.ts";

interface Spec {
  readonly category: string;
  readonly scope: string;
  readonly roles: readonly string[];
  readonly actors: readonly string[];
  readonly target: string;
  readonly metadata: z.ZodType;
  readonly journal?: { readonly kind: string };
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
  };
}

function shapes(events: Readonly<Record<string, Spec>>) {
  return Object.fromEntries(Object.entries(events).map(([name, spec]) => [name, shape(spec)]));
}

describe("the registry's identity and staff-realm events", () => {
  it("are this package's person-scope events, exactly", () => {
    expect(shapes(identityFragment)).toEqual(shapes(IDENTITY_EVENTS));
  });

  it("hold this package's staff-realm events as they are declared here", () => {
    const realm = Object.keys(STAFF_REALM_EVENTS);
    const registered = Object.fromEntries(
      Object.entries(staffFragment).filter(([name]) => realm.includes(name)),
    );
    expect(Object.keys(registered).sort()).toEqual([...realm].sort());
    expect(shapes(registered)).toEqual(shapes(STAFF_REALM_EVENTS));
  });
});
