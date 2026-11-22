// Renders this package's grant fragments (grants/*.json) to SQL for the integration tests, with
// the role names mapped to the test's prefixed roles. The fragments are in the migration runner's
// shape (packages/db's grants.ts: `{ on, name, privileges, columns?, to }`), and the runner
// applies the same files in every environment.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GrantEntry {
  on: "schema" | "table" | "function";
  name: string;
  privileges: string[];
  columns?: string[];
  to: string[];
}

export interface GrantFragment {
  area: string;
  grants: GrantEntry[];
}

const PRIVILEGES: Readonly<Record<GrantEntry["on"], ReadonlySet<string>>> = {
  schema: new Set(["USAGE"]),
  table: new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]),
  function: new Set(["EXECUTE"]),
};
const SCHEMA = /^[a-z_]+$/;
const TABLE = /^[a-z_]+\.[a-z_]+$/;
const FUNCTION = /^[a-z_]+\.[a-z_]+\([a-z0-9_, ]*\)$/;
const COLUMN = /^[a-z_][a-z0-9_]*$/;

export function readFragments(dir: string): GrantFragment[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as GrantFragment);
}

function quoteObject(name: string): string {
  const [schema, rest = ""] = name.split(".");
  const paren = rest.indexOf("(");
  const object = paren < 0 ? rest : rest.slice(0, paren);
  const args = paren < 0 ? "" : rest.slice(paren);
  return `"${schema}"."${object}"${args}`;
}

/** The SQL for the fragments; `roleName` maps a fragment role (`fin_console`) to the test's role. */
export function renderGrants(
  fragments: readonly GrantFragment[],
  roleName: (role: string) => string,
): string {
  const statements: string[] = [];
  for (const fragment of fragments) {
    for (const grant of fragment.grants) {
      const allowed = PRIVILEGES[grant.on];
      if (allowed === undefined) throw new Error(`grant fragment ${fragment.area}: ${grant.on}`);
      for (const p of grant.privileges) {
        if (!allowed.has(p)) throw new Error(`grant fragment ${fragment.area}: privilege ${p}`);
      }
      const shape = grant.on === "schema" ? SCHEMA : grant.on === "table" ? TABLE : FUNCTION;
      if (!shape.test(grant.name) || (grant.columns ?? []).some((c) => !COLUMN.test(c))) {
        throw new Error(`grant fragment ${fragment.area}: object ${grant.name}`);
      }
      const to = grant.to.map((role) => `"${roleName(role)}"`).join(", ");
      if (grant.on === "schema") {
        statements.push(`GRANT USAGE ON SCHEMA "${grant.name}" TO ${to};`);
      } else if (grant.on === "function") {
        statements.push(`GRANT EXECUTE ON FUNCTION ${quoteObject(grant.name)} TO ${to};`);
      } else {
        const columns =
          grant.columns === undefined ? "" : ` (${grant.columns.map((c) => `"${c}"`).join(", ")})`;
        const privileges = grant.privileges.map((p) => `${p}${columns}`).join(", ");
        statements.push(`GRANT ${privileges} ON TABLE ${quoteObject(grant.name)} TO ${to};`);
      }
    }
  }
  return statements.join("\n");
}
