// T-SAT-21's meta-test (spec 02 §16.1, AC-SAT-11): every event this package's fragments declare
// has an integration test that asserts it is written by its action, or a recorded reason why
// another lane's code writes it. A new event with neither fails here.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REALM_EVENTS, type RealmEventName } from "./events.ts";

const SRC = join(import.meta.dirname, "..");

/** Events whose action lives in another lane's route; this package gives the route its pieces. */
const WRITTEN_ELSEWHERE: Partial<Record<RealmEventName, string>> = {
  "user.name_changed":
    "PATCH /api/account/name is L-SAT-06's route; it records the event after requirePerson's window",
};

function dbTests(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".db.test.ts"))
        out.push({ file: entry.name, text: readFileSync(path, "utf8") });
    }
  };
  walk(SRC);
  return out;
}

describe("every audit event of the identity fragments", () => {
  const tests = dbTests();

  it.each(Object.keys(REALM_EVENTS) as RealmEventName[])(
    "%s is asserted by an integration test",
    (event) => {
      if (WRITTEN_ELSEWHERE[event] !== undefined) return;
      const asserting = tests.filter(
        (t) => t.text.includes(`event: "${event}"`) || t.text.includes(`"${event}"`),
      );
      expect(
        asserting.map((t) => t.file),
        `no integration test asserts ${event}`,
      ).not.toEqual([]);
    },
  );

  it("records a reason for every event written elsewhere", () => {
    for (const [event, reason] of Object.entries(WRITTEN_ELSEWHERE)) {
      expect(Object.keys(REALM_EVENTS)).toContain(event);
      expect(reason?.length ?? 0).toBeGreaterThan(20);
    }
  });
});
