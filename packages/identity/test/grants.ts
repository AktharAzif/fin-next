// Renders this package's grant fragments (grants/*.json) to SQL for the integration tests, with
// the role names mapped to the test's prefixed roles. The migration runner's renderer
// (packages/db, P0-E) reads the same fragments in production.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GrantEntry {
  role: string;
  privileges: string[];
  tables?: string[];
  functions?: string[];
  table?: string;
  columns?: string[];
}

export interface GrantFragment {
  area: string;
  grants: GrantEntry[];
}

const PRIVILEGES = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "EXECUTE"]);
const OBJECT = /^[a-z_]+\.[a-z_]+(\([a-z0-9_, ]*\))?$/;
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
  const usage = new Map<string, Set<string>>();
  const addUsage = (role: string, object: string) => {
    const schema = object.split(".")[0] as string;
    const set = usage.get(role) ?? new Set<string>();
    set.add(schema);
    usage.set(role, set);
  };
  for (const fragment of fragments) {
    for (const grant of fragment.grants) {
      for (const p of grant.privileges) {
        if (!PRIVILEGES.has(p)) throw new Error(`grant fragment ${fragment.area}: privilege ${p}`);
      }
      const role = `"${roleName(grant.role)}"`;
      const privileges = grant.privileges.join(", ");
      for (const table of grant.tables ?? []) {
        if (!OBJECT.test(table))
          throw new Error(`grant fragment ${fragment.area}: object ${table}`);
        statements.push(`GRANT ${privileges} ON TABLE ${quoteObject(table)} TO ${role};`);
        addUsage(grant.role, table);
      }
      for (const fn of grant.functions ?? []) {
        if (!OBJECT.test(fn)) throw new Error(`grant fragment ${fragment.area}: function ${fn}`);
        statements.push(`GRANT ${privileges} ON FUNCTION ${quoteObject(fn)} TO ${role};`);
        addUsage(grant.role, fn);
      }
      if (grant.table !== undefined) {
        const columns = grant.columns ?? [];
        if (!OBJECT.test(grant.table) || columns.some((c) => !COLUMN.test(c))) {
          throw new Error(`grant fragment ${fragment.area}: columns of ${grant.table}`);
        }
        statements.push(
          `GRANT ${privileges} (${columns.map((c) => `"${c}"`).join(", ")}) ON TABLE ${quoteObject(grant.table)} TO ${role};`,
        );
        addUsage(grant.role, grant.table);
      }
    }
  }
  for (const [role, schemas] of usage) {
    for (const schema of schemas)
      statements.unshift(`GRANT USAGE ON SCHEMA "${schema}" TO "${roleName(role)}";`);
  }
  return statements.join("\n");
}
