// The area's fragments agree with their sources (spec 02 §13.7, §13.8, §13.9, §16.3, §7.6): the guards
// migration says exactly what the registrations say; the grant fragment is packages/db's shape and
// names only objects this area's migrations make; the migrations carry the runner's header; the event
// fragment is spec 08 §3.4's list, flat and strict; the step-up fragment joins the realm's catalogue.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPgDatabase,
  createRealm,
  MemoryLineSink,
  readRealmSettings,
  systemClock,
} from "@fin/identity";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type * as z from "zod";
import { realmEnv } from "../test/harness.ts";
import { ORGS_EVENTS, REALM_WRITTEN_EVENTS } from "./audit/events.ts";
import { guardSql, ORGS_GUARDS } from "./guards.ts";
import { ORGS_ACTIONS } from "./step-up.ts";

const ROOT = join(import.meta.dirname, "..");
const migrations = readdirSync(join(ROOT, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sql = (name: string) => readFileSync(join(ROOT, "migrations", name), "utf8");

describe("the migrations", () => {
  it("are named and headed as the runner reads them", () => {
    expect(migrations).toEqual([
      "20261121130000_orgs_tables.sql",
      "20261121130100_orgs_views.sql",
      "20261121130200_orgs_guards.sql",
    ]);
    for (const name of migrations) {
      const body = sql(name)
        .split("\n")
        .filter((l) => !l.startsWith("--") && l.trim() !== "");
      expect(body[0], name).toMatch(/^SET LOCAL lock_timeout = '\d+s';$/);
      expect(body[1], name).toMatch(/^SET LOCAL statement_timeout = '\d+s';$/);
      expect(sql(name), name).not.toContain("\r");
    }
  });

  it("install exactly the registered guards", () => {
    const installed = sql("20261121130200_orgs_guards.sql")
      .split("\n")
      .filter((l) => l.startsWith("SELECT audit.install_guard("));
    expect(installed).toEqual(guardSql(ORGS_GUARDS));
    for (const guard of ORGS_GUARDS) {
      for (const event of guard.events) {
        if (event === "guard.never_allowed") continue;
        const known = Object.hasOwn(ORGS_EVENTS, event) || event.startsWith("browser.");
        expect(known, `${guard.table}: ${event}`).toBe(true);
      }
    }
  });
});

describe("the grant fragment", () => {
  const fragment = JSON.parse(readFileSync(join(ROOT, "grants", "orgs.json"), "utf8")) as {
    area: string;
    grants: { on: string; name: string; privileges: string[]; columns?: string[]; to: string[] }[];
  };
  const created = migrations.map(sql).join("\n");

  it("is packages/db's shape, for this area, granting to group roles only", () => {
    expect(fragment.area).toBe("orgs");
    const roles = new Set(["fin_console", "fin_api", "fin_readonly", "fin_worker", "fin_admin"]);
    for (const grant of fragment.grants) {
      expect(["schema", "table", "function"]).toContain(grant.on);
      for (const role of grant.to) expect(roles.has(role), role).toBe(true);
      if (grant.on === "schema") expect(grant.privileges).toEqual(["USAGE"]);
      if (grant.on === "function") expect(grant.privileges).toEqual(["EXECUTE"]);
      if (grant.columns !== undefined) {
        expect(grant.privileges.every((p) => ["SELECT", "INSERT", "UPDATE"].includes(p))).toBe(
          true,
        );
      }
    }
  });

  it("names only objects this area's migrations make", () => {
    for (const grant of fragment.grants.filter((g) => g.on !== "schema")) {
      const object = grant.name.split("(")[0] as string;
      const made =
        created.includes(`CREATE TABLE ${object} `) ||
        created.includes(`CREATE VIEW ${object} `) ||
        created.includes(`CREATE FUNCTION ${object}(`);
      expect(made, grant.name).toBe(true);
    }
  });

  it("never lets the console write live_status, delete an organisation or read a token hash", () => {
    const console = fragment.grants.filter((g) => g.to.includes("fin_console"));
    const org = console.filter((g) => g.name === "identity.organization");
    expect(org.some((g) => g.privileges.includes("DELETE"))).toBe(false);
    for (const g of org.filter(
      (x) => x.privileges.includes("UPDATE") || x.privileges.includes("INSERT"),
    )) {
      expect(g.columns, "column grants only").toBeDefined();
      expect(g.columns).not.toContain("live_status");
    }
    const readonly = fragment.grants.filter((g) => g.to.includes("fin_readonly"));
    const invitation = readonly.find((g) => g.name === "identity.invitation");
    expect(invitation?.columns).toBeDefined();
    expect(invitation?.columns).not.toContain("token_hash");
    expect(fragment.grants.some((g) => g.name.startsWith("audit."))).toBe(false);
  });
});

describe("the event fragment", () => {
  it("is spec 08 §3.4's orgs.ts list", () => {
    expect(Object.keys(ORGS_EVENTS).sort()).toEqual(
      [
        "organization.created",
        "organization.updated",
        "organization.deleted",
        "member.invited",
        "member.invitation_changed",
        "member.invitation_resent",
        "member.invitation_cancelled",
        "member.invitation_declined",
        "member.joined",
        "member.role_changed",
        "member.removed",
        "member.signed_in",
        "member.second_factor_added",
        "member.second_factor_removed",
        "member.name_changed",
        "role.created",
        "role.updated",
        "role.deleted",
      ].sort(),
    );
    for (const event of REALM_WRITTEN_EVENTS) expect(Object.hasOwn(ORGS_EVENTS, event)).toBe(true);
  });

  it("is organisation scope, recorded by fin_console, with flat strict metadata", () => {
    for (const [name, spec] of Object.entries(ORGS_EVENTS)) {
      expect(spec.scope, name).toBe("organisation");
      expect(spec.roles, name).toEqual(["fin_console"]);
      expect(["organisation", "team"]).toContain(spec.category);
      // Strict: an unknown key is refused.
      expect(spec.metadata.safeParse({ planted: 1 }).success, name).toBe(false);
      for (const [key, field] of Object.entries(spec.metadata.shape)) {
        expect(key, name).toMatch(/^[a-z][A-Za-z0-9_]{0,63}$/);
        const type = (field as z.ZodType)._zod.def.type;
        expect(["string", "number", "boolean", "enum", "array", "nullable", "int"]).toContain(type);
      }
    }
  });
});

describe("the step-up fragment", () => {
  it("joins the realm's catalogue with no key listed twice", () => {
    const pool = {
      connect: async () => Promise.reject(new Error("no database")),
    } as unknown as Pool;
    const lines = new MemoryLineSink();
    const db = createPgDatabase({ pool, clock: systemClock, release: "test", lines });
    const realm = createRealm({
      settings: readRealmSettings("developer", realmEnv()),
      db,
      clock: systemClock,
      lines,
      docsOrigin: "https://developer.example.com",
      actions: [ORGS_ACTIONS],
    });
    for (const action of ORGS_ACTIONS) {
      expect(realm.runtime.actions.get(action.key)).toEqual(action);
      expect(action.realm).toBe("developer");
      expect(action.reasonKey).toMatch(/^[a-z_]+$/);
    }
    expect(() =>
      createRealm({
        settings: readRealmSettings("developer", realmEnv()),
        db,
        clock: systemClock,
        lines,
        docsOrigin: "https://developer.example.com",
        actions: [ORGS_ACTIONS, ORGS_ACTIONS],
      }),
    ).toThrow(/listed twice/);
  });
});
