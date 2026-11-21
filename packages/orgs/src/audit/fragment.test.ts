// The registry's copy of this area's events (spec 08 §3.2): packages/audit/src/events/orgs.ts is what
// `migrate` syncs to audit.event_type, so audit.record() takes exactly what this package records.
// Every event matches there field by field: category, scope, roles, actors, target prefix, metadata
// schema and revocation-journal entry.
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { events as fragment } from "../../../audit/src/events/orgs.ts";
import { ORGS_EVENTS } from "./events.ts";

interface Spec {
  readonly category: string;
  readonly scope: string;
  readonly roles: readonly string[];
  readonly actors: readonly string[];
  readonly target: string;
  readonly metadata: z.ZodType;
  readonly journal?: { readonly kind: string; readonly when?: unknown };
}

function shape(spec: Spec) {
  return {
    category: spec.category,
    scope: spec.scope,
    roles: [...spec.roles].sort(),
    actors: [...spec.actors].sort(),
    target: spec.target,
    metadata: z.toJSONSchema(spec.metadata),
    journal: spec.journal?.kind ?? null,
    when: spec.journal?.when !== undefined,
  };
}

function shapes(events: Readonly<Record<string, Spec>>) {
  return Object.fromEntries(Object.entries(events).map(([name, spec]) => [name, shape(spec)]));
}

describe("the registry's orgs fragment", () => {
  it("is this package's events, exactly", () => {
    expect(shapes(fragment)).toEqual(shapes(ORGS_EVENTS));
  });

  it("journals a lowered role exactly when this package does", () => {
    const changed = [
      { fromRole: "admin", toRole: "member", reason: "changed", lowered: true },
      { fromRole: "member", toRole: "admin", reason: "changed", lowered: false },
    ] as const;
    const ourChange = changed.map((m) => ORGS_EVENTS["member.role_changed"].journal?.when?.(m));
    expect(ourChange).toEqual([true, false]);
    expect(changed.map((m) => fragment["member.role_changed"].journal?.when?.(m))).toEqual(
      ourChange,
    );
    const updated = [
      { added: [], removed: ["apiKeys.manage"], holders: 2, renamed: false },
      { added: ["apiKeys.manage"], removed: [], holders: 2, renamed: true },
    ];
    const ourUpdate = updated.map((m) => ORGS_EVENTS["role.updated"].journal?.when?.(m));
    expect(ourUpdate).toEqual([true, false]);
    expect(updated.map((m) => fragment["role.updated"].journal?.when?.(m))).toEqual(ourUpdate);
  });
});
