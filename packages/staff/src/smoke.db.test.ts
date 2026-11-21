import { afterAll, beforeAll, expect, it } from "vitest";
import { createStaffHarness, type StaffHarness, unique } from "../test/harness.ts";

let h: StaffHarness;

beforeAll(async () => {
  h = await createStaffHarness("sat04smoke");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

it("enrols an Admin through the real ceremonies", async () => {
  const email = unique("smoke.admin");
  const { staffId, browser } = await h.enrolled(email, "admin");
  const row = await h.admin.query<{ status: string }>(
    "SELECT status FROM staff.member WHERE id = $1",
    [staffId],
  );
  expect(row.rows[0]?.status).toBe("active");
  expect(browser.sessionToken()).not.toBeNull();
});
