// T-SAT-38's drift half (spec 02 §10.9): the worker's own login reads the active and pending
// members from `staff.access_list_view` (removed ones are gone from the list), and a difference with
// the Access policies pages with the counts only.
import { MemoryLineSink } from "@fin/identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaffHarness, DROP_TIMEOUT_MS, type StaffHarness, unique } from "../test/harness.ts";
import { runAccessDriftCheck, staffAccessList } from "./access-drift.ts";

let h: StaffHarness;

beforeAll(async () => {
  h = await createStaffHarness("sat04drift");
}, 120_000);

afterAll(async () => {
  await h?.close();
}, DROP_TIMEOUT_MS);

describe("the Access drift check", () => {
  it("compares the Allow list with the active and pending members, as the worker reads them", async () => {
    const active = unique("drift.active");
    const pending = unique("drift.pending");
    await h.seedMember(active, "viewer", "active");
    await h.seedMember(pending, "admin", "pending");
    await h.seedMember(unique("drift.removed"), "viewer", "removed");
    const worker = h.login("fin_worker_a", 1);
    const members = await staffAccessList({
      query: async (text, values) => {
        const result = await worker.query(text, values);
        return { rows: result.rows as never[], rowCount: result.rowCount ?? 0 };
      },
    });
    expect(members.sort()).toEqual([active, pending].sort());

    const lines = new MemoryLineSink();
    const agreed = await runAccessDriftCheck({
      readAllowList: async () => ({ emails: [active, pending], domains: [], other: 0 }),
      staffAddresses: async () => members,
      lines,
    });
    expect(agreed.drift).toBe(false);
    // An address added to Access before Fin Admin (or left after a removal) is drift.
    const drifted = await runAccessDriftCheck({
      readAllowList: async () => ({
        emails: [active, pending, unique("drift.extra")],
        domains: [],
        other: 0,
      }),
      staffAddresses: async () => members,
      lines,
    });
    expect(drifted).toMatchObject({
      drift: true,
      extra: 1,
      missing: 0,
      accessCount: 3,
      staffCount: 2,
    });
    expect(lines.named("access.drift")).toEqual([
      { accessCount: 3, staffCount: 2, missing: 0, extra: 1, domains: 0, other: 0 },
    ]);
    expect(JSON.stringify(lines.lines)).not.toContain("@");
  });
});
