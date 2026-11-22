// T-SAT-24's staff half (spec 02 §10.8, §8.5; AC-SAT-08): the last active Admin stays. Two Admins
// demoting or removing each other at the same moment, each with a proved intent: the staff-change
// lock serialises them, the second reads the actor and the target again, and exactly one passes.
// The rule itself: a change that would leave no active Admin is `409 last_top_role`.
import type { RequestContext } from "@fin/identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Browser,
  createStaffHarness,
  DROP_TIMEOUT_MS,
  refusalOf,
  type SoftAuthenticator,
  type StaffHarness,
  unique,
} from "../test/harness.ts";
import { resolveStaffRole } from "./catalogue.ts";
import { memberForChange, takeStaffChangeLock } from "./lock.ts";
import { changeStaffRole, refuseLastActiveAdmin, removeStaff } from "./members.ts";
import type { UnitTx } from "./ports.ts";
import { requireStaff } from "./require-staff.ts";

type RouteFn = (tx: UnitTx, request: Request, context: RequestContext) => Promise<unknown>;

let h: StaffHarness;

beforeAll(async () => {
  h = await createStaffHarness("sat04last");
}, 120_000);

afterAll(async () => {
  await h?.close();
}, DROP_TIMEOUT_MS);

interface Admin {
  staffId: string;
  browser: Browser;
  authenticator: SoftAuthenticator;
}

/** Leaves no active Admin from an earlier test, then enrols two. */
async function twoAdmins(): Promise<[Admin, Admin]> {
  await h.fixture(
    "UPDATE staff.member SET status = 'removed', removed_at = now() WHERE role_key = 'admin' AND status = 'active'",
  );
  return [
    await h.enrolled(unique("admin.a"), "admin"),
    await h.enrolled(unique("admin.b"), "admin"),
  ];
}

/** Asks for the intent and proves it, so the re-send can go out at the same moment as another. */
async function provedIntent(who: Admin, request: { method: string; path: string }, fn: RouteFn) {
  const asked = await refusalOf(h.route(who.browser, request, fn));
  expect(asked.code).toBe("step_up_required");
  const intent = String(asked.extensions.intent_id);
  expect((await h.prove(who.browser, who.authenticator, intent)).status).toBe(200);
  return intent;
}

async function activeAdmins(): Promise<number> {
  const result = await h.admin.query<{ n: number }>(
    "SELECT count(*)::integer AS n FROM staff.member WHERE role_key = 'admin' AND status = 'active'",
  );
  return Number(result.rows[0]?.n);
}

async function race(
  pairs: { who: Admin; request: { method: string; path: string }; fn: RouteFn }[],
) {
  const intents: string[] = [];
  for (const pair of pairs) intents.push(await provedIntent(pair.who, pair.request, pair.fn));
  return Promise.allSettled(
    pairs.map((pair, i) =>
      h.route(pair.who.browser, { ...pair.request, intent: intents[i] as string }, pair.fn),
    ),
  );
}

describe("the last Admin (§10.8)", () => {
  it("survives two concurrent demotions: exactly one passes", async () => {
    const [a, b] = await twoAdmins();
    const demote =
      (target: Admin): RouteFn =>
      async (tx, req, ctx) =>
        changeStaffRole(
          h.deps,
          tx,
          await requireStaff(h.realm, req, ctx, { permission: "staff.role" }),
          target.staffId,
          { roleKey: "viewer" },
        );
    const results = await race([
      { who: a, request: { method: "PATCH", path: `/api/staff/${b.staffId}` }, fn: demote(b) },
      { who: b, request: { method: "PATCH", path: `/api/staff/${a.staffId}` }, fn: demote(a) },
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    // The loser re-read itself inside the lock: no longer an Admin, it holds no staff.role.
    expect((refused.reason as { code: string }).code).toBe("forbidden");
    expect(await activeAdmins()).toBe(1);
  });

  it("survives two concurrent removals: exactly one passes", async () => {
    const [a, b] = await twoAdmins();
    const remove =
      (target: Admin): RouteFn =>
      async (tx, req, ctx) =>
        removeStaff(
          h.deps,
          tx,
          await requireStaff(h.realm, req, ctx, { permission: "staff.remove" }),
          target.staffId,
        );
    const results = await race([
      {
        who: a,
        request: { method: "POST", path: `/api/staff/${b.staffId}/remove` },
        fn: remove(b),
      },
      {
        who: b,
        request: { method: "POST", path: `/api/staff/${a.staffId}/remove` },
        fn: remove(a),
      },
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await activeAdmins()).toBe(1);
    const removed = (await h.events("staff.member_removed")).filter(
      (e) => e.target_id === a.staffId || e.target_id === b.staffId,
    );
    expect(removed).toHaveLength(1);
  });

  it("refuses removing, demoting or resetting the one active Admin left; a pending Admin never counts", async () => {
    await h.fixture(
      "UPDATE staff.member SET status = 'removed', removed_at = now() WHERE role_key = 'admin' AND status = 'active'",
    );
    const only = await h.seedMember(unique("only.admin"), "admin", "active");
    const pending = await h.seedMember(unique("pending.admin"), "admin", "pending");
    const check = (staffId: string, change: Parameters<typeof refuseLastActiveAdmin>[3]) =>
      h.db.unit(async (tx) => {
        await takeStaffChangeLock(tx);
        const target = await memberForChange(tx, staffId);
        if (target === null) throw new Error("no member");
        await refuseLastActiveAdmin(tx, target, await resolveStaffRole(tx, target.roleKey), change);
      });
    const viewer = { newRole: { kind: "built_in", key: "viewer" } } as const;
    for (const change of ["remove", "reset", viewer] as const) {
      expect((await refusalOf(check(only, change))).code, JSON.stringify(change)).toBe(
        "last_top_role",
      );
    }
    // Staying an Admin loses nothing, and a pending Admin may always go.
    await check(only, { newRole: { kind: "built_in", key: "admin" } });
    await check(pending, "remove");
    // With a second active Admin, the first may go.
    await h.seedMember(unique("second.active"), "admin", "active");
    await check(only, "remove");
  });
});
