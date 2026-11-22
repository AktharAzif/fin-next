// Fin Admin's audit log reads, without a database (spec 02 §14.3, §14.5, §16.4): the windows the
// Date filter and "Rejections this week" read in UTC, the events a view narrows to, the
// verification chip, the shape checks every read makes before any SQL, and the migration and grant
// fragment that hold the door's re-check (two SECURITY DEFINER reads, nothing on audit.event).
import { globSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { staffCatalogue } from "@fin/access";
import { describe, expect, it } from "vitest";
import { StaffRefusal } from "../errors.ts";
import {
  AUDIT_MAX_ACTIONS,
  AUDIT_MAX_ACTORS,
  checkQuery,
  eventsOf,
  REJECTION_EVENTS,
  type StaffAuditQuery,
  startOfUtcWeek,
  utcDay,
  verificationOf,
  windowOf,
} from "./log.ts";

const root = join(import.meta.dirname, "..", "..");
const sql = readFileSync(join(root, "migrations", "20261122081500_staff_audit_log.sql"), "utf8");
const grants = JSON.parse(readFileSync(join(root, "grants", "staff-audit.json"), "utf8")) as {
  area: string;
  grants: { on: string; name: string; privileges: string[]; to: string[] }[];
};

// Saturday 21 Nov 2026, 15:30:00 UTC.
const NOW = new Date("2026-11-21T15:30:00.000Z");
const id = (prefix: string, n: number) => `${prefix}_01jd${String(n).padStart(22, "0")}`;

function refusal(run: () => void): { code: string; path: unknown } {
  try {
    run();
  } catch (error) {
    if (error instanceof StaffRefusal) {
      const fields = error.extensions.fields as readonly { path: string }[] | undefined;
      return { code: error.code, path: fields?.[0]?.path };
    }
    throw error;
  }
  return { code: "none", path: undefined };
}

describe("the window a query reads (UTC)", () => {
  it("starts the week on Monday and the day at midnight", () => {
    expect(startOfUtcWeek(NOW).toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(startOfUtcWeek(new Date("2026-11-16T00:00:00.000Z")).toISOString()).toBe(
      "2026-11-16T00:00:00.000Z",
    );
    expect(startOfUtcWeek(new Date("2026-11-22T23:59:59.999Z")).toISOString()).toBe(
      "2026-11-16T00:00:00.000Z",
    );
  });

  it("reads each preset from now, with no end", () => {
    const from = (range: StaffAuditQuery["range"]) =>
      windowOf({ range }, NOW).from?.toISOString() ?? null;
    expect(from("today")).toBe("2026-11-21T00:00:00.000Z");
    expect(from("week")).toBe("2026-11-16T00:00:00.000Z");
    expect(from("7d")).toBe("2026-11-14T15:30:00.000Z");
    expect(from("30d")).toBe("2026-10-22T15:30:00.000Z");
    expect(from("month")).toBe("2026-11-01T00:00:00.000Z");
    expect(windowOf({}, NOW)).toEqual({ from: null, to: null });
    expect(windowOf({ range: "today" }, NOW).to).toBeNull();
  });

  it("reads custom days with the last day included", () => {
    const window = windowOf({ from: "2026-11-02", to: "2026-11-03" }, NOW);
    expect(window.from?.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(window.to?.toISOString()).toBe("2026-11-04T00:00:00.000Z");
  });

  it("keeps Rejections this week inside this week, whatever the Date filter says", () => {
    expect(windowOf({ show: "rejections" }, NOW).from?.toISOString()).toBe(
      "2026-11-16T00:00:00.000Z",
    );
    expect(windowOf({ show: "rejections", range: "30d" }, NOW).from?.toISOString()).toBe(
      "2026-11-16T00:00:00.000Z",
    );
    expect(windowOf({ show: "rejections", range: "today" }, NOW).from?.toISOString()).toBe(
      "2026-11-21T00:00:00.000Z",
    );
  });

  it("knows a real UTC day from a shape that only looks like one", () => {
    expect(utcDay("2026-02-28")?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(utcDay("2026-02-30")).toBeNull();
    expect(utcDay("2026-2-3")).toBeNull();
    expect(utcDay("yesterday")).toBeNull();
  });
});

describe("the events a query reads", () => {
  it("is every event without an Action filter, and the chosen ones with it", () => {
    expect(eventsOf({})).toBeNull();
    expect(eventsOf({ actions: [] })).toBeNull();
    expect(eventsOf({ actions: ["staff.member_added"] })).toEqual(["staff.member_added"]);
  });

  it("narrows to rejections for that view, and to nothing when the filter has none", () => {
    expect(eventsOf({ show: "rejections" })).toEqual([...REJECTION_EVENTS]);
    expect(eventsOf({ show: "rejections", actions: ["staff.member_added"] })).toEqual([]);
    expect(eventsOf({ show: "rejections", actions: ["staff.customer_rejected"] })).toEqual([
      "staff.customer_rejected",
    ]);
    expect(eventsOf({ show: "mine", actions: ["switch.set"] })).toEqual(["switch.set"]);
  });
});

describe("the verification chip (§14.5)", () => {
  it("is the step-up's proof, then the sign-in's method, then the session", () => {
    expect(verificationOf("staff.role_changed", "passkey", {}, "staff")).toBe("passkey");
    expect(verificationOf("switch.set", "totp", {}, "staff")).toBe("totp");
    expect(verificationOf("staff.signed_in", null, { method: "email_otp" }, "staff")).toBe(
      "email_otp",
    );
    expect(verificationOf("staff.step_up_passed", null, { method: "passkey" }, "staff")).toBe(
      "passkey",
    );
    expect(verificationOf("staff.signed_in", null, { method: "carrier pigeon" }, "staff")).toBe(
      "session",
    );
    expect(verificationOf("staff.signed_out", null, {}, "staff")).toBe("session");
  });

  it("never reads a factor added, removed or failed with as the proof", () => {
    for (const event of [
      "staff.factor_enrolled",
      "staff.factor_added",
      "staff.factor_removed",
      "staff.step_up_failed",
    ]) {
      expect(verificationOf(event, null, { method: "passkey" }, "staff")).toBe("session");
    }
  });

  it("is none for a failed sign-in, which proves nothing about the member it names", () => {
    // A wrong emailed code, or the member's address typed under another Access identity: no
    // session, and nothing verified.
    for (const metadata of [
      { method: "email_otp", reason: "wrong_code" },
      { method: "email_otp", reason: "access_mismatch" },
      { method: "passkey", reason: "passkey_failed" },
      {},
    ]) {
      expect(verificationOf("staff.sign_in_failed", null, metadata, "staff")).toBeNull();
    }
  });

  it("is none for the operator, the system or a provider", () => {
    for (const kind of ["operator", "system", "provider"]) {
      expect(verificationOf("staff.signed_in", null, { method: "passkey" }, kind)).toBeNull();
    }
  });
});

describe("the shape checks every read makes", () => {
  const ok: StaffAuditQuery = { limit: 50 };

  it("pass a plain query and every filter in its shape", () => {
    expect(
      refusal(() =>
        checkQuery({
          ...ok,
          show: "mine",
          actors: [id("stf", 1)],
          actions: ["staff.role_changed", "switch.set"],
          orgs: [id("org", 2)],
          from: "2026-11-01",
          to: "2026-11-21",
          cursor: id("aud", 3),
        }),
      ).code,
    ).toBe("none");
  });

  it("refuse the limits, a cursor both ways, and bad IDs, naming the field and never the value", () => {
    expect(refusal(() => checkQuery({ limit: 0 }))).toEqual({
      code: "invalid",
      path: "query.limit",
    });
    expect(refusal(() => checkQuery({ limit: 101 })).path).toBe("query.limit");
    expect(refusal(() => checkQuery({ limit: 2.5 })).path).toBe("query.limit");
    expect(
      refusal(() => checkQuery({ ...ok, cursor: id("aud", 1), before: id("aud", 2) })).path,
    ).toBe("query.before");
    expect(refusal(() => checkQuery({ ...ok, cursor: id("stf", 1) })).path).toBe("query.cursor");
    expect(refusal(() => checkQuery({ ...ok, before: "aud_x" })).path).toBe("query.before");
    expect(refusal(() => checkQuery({ ...ok, actors: [id("aud", 1)] })).path).toBe("query.actor");
    expect(refusal(() => checkQuery({ ...ok, orgs: ["Acme Remit"] })).path).toBe("query.org");
    expect(refusal(() => checkQuery({ ...ok, actions: ["DROP TABLE"] })).path).toBe("query.action");
  });

  it("refuse more filters than a read takes", () => {
    const actors = Array.from({ length: AUDIT_MAX_ACTORS + 1 }, (_, n) => id("stf", n));
    expect(refusal(() => checkQuery({ ...ok, actors })).path).toBe("query.actor");
    const actions = Array.from({ length: AUDIT_MAX_ACTIONS + 1 }, () => "staff.signed_in");
    expect(refusal(() => checkQuery({ ...ok, actions })).path).toBe("query.action");
  });

  it("refuse a preset with custom days, a day that is not one, and days out of order", () => {
    expect(refusal(() => checkQuery({ ...ok, range: "7d", from: "2026-11-01" })).path).toBe(
      "query.range",
    );
    expect(refusal(() => checkQuery({ ...ok, from: "2026-13-01" })).path).toBe("query.from");
    expect(refusal(() => checkQuery({ ...ok, to: "soon" })).path).toBe("query.to");
    expect(refusal(() => checkQuery({ ...ok, from: "2026-11-21", to: "2026-11-01" })).path).toBe(
      "query.to",
    );
  });
});

describe("the migration that holds the door's re-check", () => {
  const functions = [...sql.matchAll(/^CREATE FUNCTION (staff\.[a-z_]+)\(/gm)].map(
    (m) => m[1] ?? "",
  );

  it("defines the reader, the shared filter and the two reads, and revokes each from PUBLIC", () => {
    expect(functions).toEqual([
      "staff.audit_reader",
      "staff.audit_matches",
      "staff.audit_log",
      "staff.audit_entry",
    ]);
    for (const name of functions) {
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${name.replace(".", "\\.")}\\(`));
    }
    expect(sql).not.toMatch(/^GRANT /m);
  });

  it("runs the reads as their owner with a fixed search path, and only on staff rows", () => {
    const definers = sql.match(/SECURITY DEFINER SET search_path = pg_catalog, pg_temp/g) ?? [];
    expect(definers).toHaveLength(3);
    // Every read of audit.event names the staff scope.
    const reads = sql.split("FROM audit.event e").slice(1);
    expect(reads.length).toBeGreaterThanOrEqual(6);
    for (const read of reads) expect(read.slice(0, 400)).toContain("e.scope = 'staff'");
  });

  it("returns a page as one row, its count, beyond and past apart from the page's rows", () => {
    expect(sql).toMatch(
      /staff\.audit_log\([^)]*\) RETURNS TABLE \(items jsonb, total bigint, beyond boolean, past boolean\)/,
    );
  });

  it("lets through exactly the prebuilt roles the catalogue gives audit.read", () => {
    const listed = /held_role NOT IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    const prebuilt = listed.split(",").map((key) => key.trim().replace(/'/g, ""));
    const holders = staffCatalogue.builtIns
      .filter((role) => role.holds === "all" || role.holds.includes("audit.read"))
      .map((role) => role.key);
    expect(prebuilt).toEqual(holders);
  });
});

describe("the grant fragment", () => {
  it("is the only fragment in the repository that names the reads or their helpers", () => {
    // The database tests check the grants the staff platform applies; this checks every fragment
    // any area keeps, so a grant on these functions anywhere else fails here too.
    const repo = join(root, "..", "..");
    const fragments = [
      ...globSync("packages/*/grants/*.json", { cwd: repo }),
      ...globSync("packages/*/roles/grants/*.json", { cwd: repo }),
      ...globSync("apps/*/grants/*.json", { cwd: repo }),
    ];
    expect(fragments.length).toBeGreaterThan(3);
    const naming = fragments
      .filter((file) => readFileSync(join(repo, file), "utf8").includes("staff.audit_"))
      .map((file) => file.split(sep).join("/"));
    expect(naming).toEqual(["packages/staff/grants/staff-audit.json"]);
  });

  it("gives fin_admin EXECUTE on the two reads and nothing else", () => {
    expect(grants.area).toBe("staff-audit");
    expect(grants.grants).toEqual([
      {
        on: "function",
        name: "staff.audit_log(text, text, boolean, text[], text[], text[], timestamptz, timestamptz, text, text, integer)",
        privileges: ["EXECUTE"],
        to: ["fin_admin"],
      },
      {
        on: "function",
        name: "staff.audit_entry(text, text, text)",
        privileges: ["EXECUTE"],
        to: ["fin_admin"],
      },
    ]);
  });
});
