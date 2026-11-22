// The staff migrations and grants as the runner reads them (spec 02 §13.9, DA-04): named
// `<YYYYMMDDHHMMSS>_staff_<what>.sql`, later than @fin/identity's (whose tables they stand on),
// opening with the runner's `SET LOCAL` timeouts; the guard statements are exactly src/guards.ts's;
// the grant fragment is the runner's format and names only grantee roles.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardSql, STAFF_GUARDS } from "./guards.ts";

const root = join(import.meta.dirname, "..");
const files = readdirSync(join(root, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const identity = readdirSync(join(root, "..", "identity", "migrations")).sort();

describe("the staff migrations", () => {
  it("are named for the runner and run after the identity realm's", () => {
    expect(files).toEqual(["20261121140000_staff_fin.sql", "20261121140100_staff_bootstrap.sql"]);
    for (const file of files) {
      expect(file).toMatch(/^\d{14}_staff_[a-z0-9_]+\.sql$/);
      expect(file > (identity.at(-1) ?? "")).toBe(true);
      const sql = readFileSync(join(root, "migrations", file), "utf8");
      const statements = sql
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      expect(statements[0]).toMatch(/^SET LOCAL lock_timeout = '\d+s'$/);
      expect(statements[1]).toMatch(/^SET LOCAL statement_timeout = '\d+s'$/);
      expect(sql).not.toContain("\r");
    }
  });

  it("install exactly the guards src/guards.ts registers", () => {
    const sql = readFileSync(join(root, "migrations", files[0] as string), "utf8");
    const installed = sql
      .split("\n")
      .filter((line) => line.startsWith("SELECT audit.install_guard("));
    expect(installed).toEqual(STAFF_GUARDS.map(guardSql));
  });

  it("give staff.bootstrap_admin to nobody but its owner", () => {
    const sql = readFileSync(join(root, "migrations", files[1] as string), "utf8");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = pg_catalog, pg_temp");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION staff\.bootstrap_admin\([^)]*\) FROM PUBLIC;/);
    expect(sql).not.toMatch(/GRANT .*bootstrap_admin/);
  });
});

describe("the staff grant fragment", () => {
  it("is the runner's format, for grantee roles only", () => {
    const fragment = JSON.parse(readFileSync(join(root, "grants", "staff.json"), "utf8")) as {
      area: string;
      grants: {
        on: string;
        name: string;
        privileges: string[];
        to: string[];
        columns?: string[];
      }[];
    };
    expect(fragment.area).toBe("staff");
    for (const grant of fragment.grants) {
      expect(["schema", "table", "function"]).toContain(grant.on);
      for (const role of grant.to) {
        expect(["fin_admin", "fin_api", "fin_worker", "fin_readonly"]).toContain(role);
      }
      expect(grant.name).not.toContain("bootstrap_admin");
    }
    // The worker's one staff grant is the drift check's view.
    expect(fragment.grants.filter((g) => g.to.includes("fin_worker") && g.on === "table")).toEqual([
      { on: "table", name: "staff.access_list_view", privileges: ["SELECT"], to: ["fin_worker"] },
    ]);
  });
});
