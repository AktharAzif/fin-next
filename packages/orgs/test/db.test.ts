// The integration template's grants (db.ts): every entry of @fin/identity's and this area's
// fragments, both in the runner's shape, renders to a statement for each of its roles, and an
// entry in any other shape is refused rather than skipped, so the template never loses a grant
// without a word.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DbFragment, renderGrants, templateGrantSql, testRole } from "./db.ts";

const ROOT = join(import.meta.dirname, "..");
const SOURCES = [join(ROOT, "node_modules", "@fin", "identity", "grants"), join(ROOT, "grants")];

function fragments(dir: string): DbFragment[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as DbFragment);
}

/** The object as the SQL names it: `"ops"."rate_window"`, `"audit"."record"(jsonb)`, `"ops"`. */
function quoted(grant: DbFragment["grants"][number]): string {
  if (grant.on === "schema") return `SCHEMA "${grant.name}"`;
  const kind = grant.on === "function" ? "FUNCTION" : "TABLE";
  return `${kind} ${grant.name.replace(/^([a-z_]+)\.([a-z_]+)/, '"$1"."$2"')}`;
}

describe("the template's grants", () => {
  const lines = templateGrantSql().split("\n");

  it("render every entry of @fin/identity's and this area's fragments, for each role", () => {
    const entries = SOURCES.flatMap(fragments).flatMap((f) => f.grants);
    expect(entries.length).toBeGreaterThan(0);
    for (const grant of entries) {
      const columns =
        grant.columns === undefined ? "" : ` (${grant.columns.map((c) => `"${c}"`).join(", ")})`;
      const privileges = grant.privileges.map((p) => `${p}${columns}`).join(", ");
      for (const to of grant.to) {
        const statement = `GRANT ${privileges} ON ${quoted(grant)} TO "${testRole(to)}";`;
        expect(lines, statement).toContain(statement);
      }
    }
  });

  it("let the console's login count on the limiter's table", () => {
    expect(lines).toContain(
      `GRANT SELECT, INSERT, UPDATE ON TABLE "ops"."rate_window" TO "${testRole("fin_console")}";`,
    );
  });

  it("refuse an entry in any other shape rather than skip it", () => {
    const old = { role: "fin_console", privileges: ["SELECT"], tables: ["ops.rate_window"] };
    expect(() =>
      renderGrants([{ area: "old", grants: [old as unknown as DbFragment["grants"][number]] }]),
    ).toThrow(/old: an entry not in the runner's shape/);
  });

  it("give a column list to each privilege, as the runner does", () => {
    const sql = renderGrants([
      {
        area: "columns",
        grants: [
          {
            on: "table",
            name: "identity.organization",
            privileges: ["SELECT", "UPDATE"],
            columns: ["name"],
            to: ["fin_console"],
          },
        ],
      },
    ]);
    expect(sql.split("\n")).toContain(
      `GRANT SELECT ("name"), UPDATE ("name") ON TABLE "identity"."organization" TO "${testRole("fin_console")}";`,
    );
  });
});
