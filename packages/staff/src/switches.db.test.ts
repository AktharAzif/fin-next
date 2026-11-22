// The kill switches from Fin Admin (spec 02 §14.3, S2-27; OP-01; spec 08 §3.4, §3.10): a member
// holding `switches.manage` sets and clears a switch through `ops.set_switch()` with an intent bound
// to the switch, the state and the reason; the event, its journal entry and the notice to every
// Admin commit with it; the guard on ops.kill_switch refuses any change without its event; the list
// is in code-point order.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaffHarness,
  DROP_TIMEOUT_MS,
  refusalOf,
  type StaffHarness,
  stepped,
  unique,
} from "../test/harness.ts";
import { instrument, markSetup, timed, timeTests } from "../test/timing.ts";
import { requireStaff } from "./require-staff.ts";
import { listSwitches, setSwitch } from "./switches.ts";

type Member = Awaited<ReturnType<StaffHarness["enrolled"]>>;

let h: StaffHarness;

timeTests("src/switches.db.test.ts");

/** The file's people, made once in its setup: the one Admin, an Operator, a Compliance member. */
let adminEmail: string;
let operator: Member;
let compliance: Member;

beforeAll(async () => {
  markSetup();
  h = await timed("createStaffHarness", () => createStaffHarness("sat04switch"));
  instrument(h);
  // The tests are about the switches, not how a member is made, and none needs fresh people: each
  // comes through the whole journey (a code sign-in, the enrolment code, a passkey registered),
  // here, once. The file's first realm requests, which pay a fresh process's cold paths and the
  // database's new connections, are paid here too, not by whichever test runs first.
  adminEmail = unique("switch.admin");
  await h.enrolled(adminEmail, "admin");
  operator = await h.enrolled(unique("switch.operator"), "operator");
  compliance = await h.enrolled(unique("switch.compliance"), "compliance");
}, 120_000);

afterAll(async () => {
  await h?.close();
}, DROP_TIMEOUT_MS);

describe("the kill switches", () => {
  it("are set and cleared by an Operator with an intent, recorded, journalled and told to every Admin", async () => {
    const set = (state: "on" | "off", reasonCode: string) =>
      stepped(
        h,
        operator.browser,
        operator.authenticator,
        { method: "POST", path: "/api/switches/signups" },
        async (tx, req, ctx) =>
          setSwitch(
            h.deps,
            tx,
            await requireStaff(h.realm, req, ctx, { permission: "switches.manage" }),
            "signups",
            { state, reasonCode },
          ),
      );
    const on = await set("on", "abuse_wave");
    expect(on).toMatchObject({
      name: "signups",
      state: "on",
      reasonCode: "abuse_wave",
      changedBy: { kind: "staff", id: operator.staffId },
    });
    const off = await set("off", "resolved");
    expect(off.state).toBe("off");
    const events = (await h.events()).filter((e) => e.target_id === "signups");
    expect(events.map((e) => [e.event, e.metadata.reasonCode, e.step_up_kind])).toEqual([
      ["switch.set", "abuse_wave", "intent"],
      ["switch.cleared", "resolved", "intent"],
    ]);
    const journal = await h.admin.query<{ kind: string }>(
      "SELECT kind FROM audit.journal_entry WHERE audit_event_id = ANY ($1) ORDER BY recorded_at",
      [events.map((e) => e.id)],
    );
    expect(journal.rows.map((r) => r.kind)).toEqual(["switch_set", "switch_cleared"]);
    const notices = await h.outbox("staff/staff-switch-changed");
    expect(notices.map((n) => [n.recipient, n.params.state])).toEqual([
      [adminEmail, "on"],
      [adminEmail, "off"],
    ]);
    expect(h.lines.named("switch.set").at(-1)).toMatchObject({
      switch: "signups",
      reasonCode: "abuse_wave",
      staffId: operator.staffId,
    });
  });

  it("refuses an unchanged state, an unknown switch, and anyone without switches.manage", async () => {
    const attempt = (who: Member, name: string, state: "on" | "off") =>
      refusalOf(
        h.route(
          who.browser,
          { method: "POST", path: `/api/switches/${name}` },
          async (tx, req, ctx) =>
            setSwitch(
              h.deps,
              tx,
              await requireStaff(h.realm, req, ctx, { permission: "switches.manage" }),
              name,
              { state, reasonCode: "drill" },
            ),
        ),
      );
    expect(await attempt(operator, "signups", "off")).toMatchObject({
      code: "conflict",
      extensions: { reason: "unchanged" },
    });
    expect(await attempt(operator, "no_such_switch", "on")).toMatchObject({ code: "not_found" });
    expect(await attempt(compliance, "signups", "on")).toMatchObject({
      code: "forbidden",
      extensions: { permission: "switches.manage" },
    });
    const listed = await h.route(
      operator.browser,
      { method: "GET", path: "/api/switches" },
      async (tx, req, ctx) => {
        await requireStaff(h.realm, req, ctx, { permission: "switches.manage" });
        return listSwitches(tx);
      },
    );
    expect(listed.map((s) => s.name)).toContain("live_money");
  });

  it("cannot be moved by Fin Admin's login without its event", async () => {
    const client = await h.login("fin_admin_a", 1).connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT ops.set_switch('live_keys', 'on', 'drill', '{\"kind\":\"staff\",\"id\":\"stf_01jd0000000000000000000000\"}'::jsonb)",
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "FA010" });
    } finally {
      client.release();
    }
    const state = await h.admin.query<{ state: string }>(
      "SELECT state FROM ops.kill_switch WHERE name = 'live_keys'",
    );
    expect(state.rows[0]?.state).toBe("off");
  });

  it("are listed by name in code-point order, the same on every server", async () => {
    // Three names that differ first at "-", "_" or a letter: code point puts them in that order,
    // while a bare ORDER BY under glibc's en_US.utf8 (CI's Postgres image) orders them otherwise
    // and a Mac, which sorts by bytes, never shows the difference. Seeded out of order.
    await h.fixture(
      `INSERT INTO ops.kill_switch (name, state, changed_by_kind, changed_at)
       SELECT n, 'off', 'system', now() FROM unnest($1::text[]) AS n`,
      [["provider_instance:mpa", "provider_instance:mp_c", "provider_instance:mp-b"]],
    );
    const operator = await h.enrolled(unique("switch.operator.three"), "operator");
    const listed = await h.route(
      operator.browser,
      { method: "GET", path: "/api/switches" },
      async (tx, req, ctx) => {
        await requireStaff(h.realm, req, ctx, { permission: "switches.manage" });
        return listSwitches(tx);
      },
    );
    const names = listed.map((s) => s.name);
    expect(names.filter((n) => n.startsWith("provider_instance:"))).toEqual([
      "provider_instance:mp-b",
      "provider_instance:mp_c",
      "provider_instance:mpa",
    ]);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});
