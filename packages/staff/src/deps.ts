// What the staff routes run on, built once per process inside main() (never at module scope).
import type { Realm } from "@fin/identity";
import { createRecordStaffAudit, type RecordStaffAudit } from "./audit/record.ts";
import { createEnqueueStaffNotice, type EnqueueStaffNotice } from "./email.ts";
import type { Clock, LineSink } from "./ports.ts";

export interface StaffDeps {
  /** The staff realm (@fin/identity's createRealm with STAFF_ACTIONS among its actions). */
  realm: Realm;
  clock: Clock;
  lines: LineSink;
  audit: RecordStaffAudit;
  notify: EnqueueStaffNotice;
  /** `development`, `test`, `staging` or `production`: the viewer's environment badge. */
  environment: string;
}

export function createStaffDeps(input: {
  realm: Realm;
  clock: Clock;
  lines: LineSink;
  environment: string;
}): StaffDeps {
  if (!input.realm.runtime.actions.has("staff.add")) {
    throw new Error("the staff realm was built without STAFF_ACTIONS");
  }
  return {
    ...input,
    audit: createRecordStaffAudit({ clock: input.clock, lines: input.lines }),
    notify: createEnqueueStaffNotice({ clock: input.clock, lines: input.lines }),
  };
}
