// T08-01: defineEvents and the generator refuse a duplicate name, a bad name, an unknown category, scope
// or role, a non-strict or nested metadata schema, and empty roles.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuditRegistryError,
  defineEvents,
  type EventSpec,
  isFlatStrictObject,
  mergeFragments,
} from "./define.ts";
import { events as platform } from "./events/platform.ts";
import { fragmentFiles, loadFragments, render } from "./gen.ts";

const ok: EventSpec = {
  category: "operations",
  scope: "staff",
  roles: ["fin_worker"],
  actors: ["system"],
  target: "table",
  metadata: z.object({ deleted: z.number() }).strict(),
};

function refuses(spec: Partial<EventSpec> & Record<string, unknown>, name = "test.thing"): void {
  expect(() => defineEvents("test", { [name]: { ...ok, ...spec } as EventSpec })).toThrow(
    AuditRegistryError,
  );
}

describe("defineEvents (T08-01)", () => {
  it("accepts a well-formed fragment and remembers its area", () => {
    const events = defineEvents("test", { "test.thing": ok });
    expect(Object.keys(events)).toEqual(["test.thing"]);
    expect(Object.isFrozen(events)).toBe(true);
  });

  it("refuses a bad name", () => {
    for (const name of [
      "thing",
      "Test.thing",
      "test.thing.more.deep",
      "test..thing",
      "test.thing1",
    ]) {
      refuses({}, name);
    }
  });

  it("refuses an unknown category, scope, role or actor, and empty roles or actors", () => {
    refuses({ category: "misc" as never });
    refuses({ scope: "global" as never });
    refuses({ roles: ["postgres"] as never });
    refuses({ roles: ["fin_worker", "fin_worker"] });
    refuses({ roles: [] });
    refuses({ actors: [] });
    refuses({ actors: ["root"] as never });
    refuses({ journal: { kind: "everything" as never } });
    refuses({ target: "" });
  });

  it("refuses metadata that is not a strict object of flat fields", () => {
    refuses({ metadata: z.object({ a: z.string() }) as never });
    refuses({ metadata: z.object({ a: z.object({ b: z.string() }).strict() }).strict() as never });
    refuses({ metadata: z.object({ a: z.array(z.object({ b: z.string() })) }).strict() as never });
    refuses({ metadata: z.object({ a: z.record(z.string(), z.string()) }).strict() as never });
    refuses({ metadata: z.object({ "Bad-Key": z.string() }).strict() as never });
    refuses({ metadata: z.string() as never });
  });

  it("accepts every flat field shape the row allows", () => {
    expect(
      isFlatStrictObject(
        z
          .object({
            a: z.string(),
            b: z.number().int(),
            c: z.boolean(),
            d: z.null(),
            e: z.enum(["x", "y"]),
            f: z.literal("q"),
            g: z.array(z.string()).max(50),
            h: z.string().nullable(),
            i: z.number().optional(),
          })
          .strict(),
      ),
    ).toBe(true);
  });

  it("loads the platform fragment with spec 08 §3.4's eight events", () => {
    expect(Object.keys(platform).sort()).toEqual([
      "audit.epoch_started",
      "audit.failover_recorded",
      "audit.restore_replayed",
      "operator.credential_rotated",
      "operator.escrow_opened",
      "operator.task_completed",
      "switch.tripped",
      "system.sweep_completed",
    ]);
    expect(platform["switch.tripped"].journal).toEqual({ kind: "switch_set" });
  });
});

describe("the generator", () => {
  it("refuses a name defined twice and a fragment whose area is not its file name", () => {
    const a = defineEvents("alpha", { "test.thing": ok });
    const b = defineEvents("beta", { "test.thing": ok });
    expect(() =>
      mergeFragments([
        { file: "alpha.ts", events: a },
        { file: "beta.ts", events: b },
      ]),
    ).toThrow(/already defined by alpha.ts/);
    expect(() => mergeFragments([{ file: "gamma.ts", events: a }])).toThrow(/must be alpha.ts/);
    expect(() => mergeFragments([{ file: "alpha.ts", events: { "test.thing": ok } }])).toThrow(
      /not made with defineEvents/,
    );
  });

  it("indexes every fragment in src/events and names each event's area", async () => {
    expect(fragmentFiles()).toContain("platform.ts");
    expect(fragmentFiles()).not.toContain("_index.gen.ts");
    const text = render(await loadFragments());
    expect(text).toContain('import { events as platform } from "./platform.ts";');
    expect(text).toContain('"switch.tripped": "platform",');
    const kebab = render([
      { file: "going-live.ts", events: defineEvents("going-live", { "test.thing": ok }) },
    ]);
    expect(kebab).toContain('import { events as goingLive } from "./going-live.ts";');
  });
});
