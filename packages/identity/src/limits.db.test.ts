// Limits in Postgres (spec 02 §5.6, [DA-16]; T-SAT-33, AC-SAT-10, AC-SAT-44): the per-recipient
// code allowance holds under 20 concurrent requests; a pause outlives a restart that empties the
// UNLOGGED counters; the limiter fails closed when the database refuses it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase, testRole } from "../test/db.ts";
import { createHarness, type Harness } from "../test/harness.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("limits");
  h = await createHarness(database, "developer");
});

afterAll(async () => {
  await database.drop();
});

const unique = (label: string) => `${label}.${Math.random().toString(36).slice(2, 8)}@example.com`;
const send = (email: string, browser = h.browser()) =>
  browser.post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });

describe("the per-recipient allowance", () => {
  it("holds under 20 concurrent requests", async () => {
    const email = unique("burst");
    const answers = await Promise.all(Array.from({ length: 20 }, () => send(email)));
    // 6 requests per address per 10 minutes pass the request limit (§5.6); the rest are 429.
    expect(answers.filter((a) => a.status === 200)).toHaveLength(6);
    expect(answers.filter((a) => a.status === 200).every((a) => a.json?.success === true)).toBe(
      true,
    );
    expect(answers.filter((a) => a.status === 429)).toHaveLength(14);
    const sent = (await h.outbox(email)).length;
    expect(sent).toBeGreaterThan(0);
    // Strangers' browsers share 3 an hour of the 5 (S2-38).
    expect(sent).toBeLessThanOrEqual(3);
  });

  it("keeps a paused address paused after the counters are emptied", async () => {
    const email = unique("paused");
    const browser = h.browser();
    for (let i = 0; i < 5; i += 1) expect((await send(email, browser)).status).toBe(200);
    expect((await h.outbox(email)).length).toBe(5);
    // The sixth uses up the allowance, which is recorded in the logged table.
    expect((await send(email, browser)).json).toEqual({ success: true });
    expect((await h.outbox(email)).length).toBe(5);
    const lock = await h.admin.query(
      "SELECT kind, locked_until > now() AS live FROM ops.lockout WHERE kind = 'code_email'",
    );
    expect(lock.rows).toContainEqual({ kind: "code_email", live: true });
    // A crash empties the UNLOGGED counters; the pause stays.
    await h.admin.query("TRUNCATE ops.rate_window");
    expect((await send(email, browser)).json).toEqual({ success: true });
    expect((await h.outbox(email)).length).toBe(5);
  });

  it("counts a network's code requests and answers 429 past them", async () => {
    const browser = h.browser();
    const answers = [];
    for (let i = 0; i < 7; i += 1) answers.push(await send(unique("network"), browser));
    expect(answers.slice(0, 6).every((a) => a.status === 200)).toBe(true);
    expect(answers[6]?.status).toBe(429);
    expect(answers[6]?.json).toMatchObject({ code: "rate_limited" });
    expect(Number(answers[6]?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(h.lines.named("limits.refused").at(-1)).toEqual({ bucket: "code_send" });
  });
});

describe("failing closed", () => {
  it("refuses with 503 and limits.store_failed when the store is refused", async () => {
    await h.admin.query(
      `REVOKE INSERT, UPDATE ON ops.rate_window FROM "${testRole("fin_console")}"`,
    );
    try {
      const answer = await send(unique("closed"));
      expect(answer.status).toBe(503);
      expect(answer.json).toMatchObject({ code: "unavailable" });
      expect(h.lines.named("limits.store_failed").length).toBeGreaterThan(0);
    } finally {
      await h.admin.query(
        `GRANT INSERT, UPDATE ON ops.rate_window TO "${testRole("fin_console")}"`,
      );
    }
  });
});
