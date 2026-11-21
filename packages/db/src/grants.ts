// The grant matrix (ARCHITECTURE §6.3, DECISIONS DA-03): one fragment per area in
// packages/db/roles/grants/<area>.json, owned by the area's lane, rendered to SQL by the runner.
//
// Applying is exact, not additive: for every object in Fin's schemas that the applying role owns, the
// runner revokes everything from PUBLIC and from Fin's roles, then grants what the fragments say, in
// the migration's transaction. So live grants equal the matrix after every run, a grant removed from a
// fragment is removed from the database, and a fragment naming an object that does not exist fails the
// run. Objects the superuser owns (ops.privileged_login) are applied by `migrate --bootstrap`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MigrationError } from "./errors.ts";
import { escapeIdentifier } from "./pg.ts";
import {
  FIN_ROLES,
  FIN_SCHEMAS,
  GRANTEE_ROLES,
  type GranteeRole,
  SERVICE_LOGINS,
} from "./roles.ts";
import type { Queryable } from "./unit.ts";

const roleSchema = z.enum(GRANTEE_ROLES);
const qualified = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
const signature = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\((?:[a-z][a-z0-9_ ]*(?:\[\])?(?:, [a-z][a-z0-9_ ]*(?:\[\])?)*)?\)$/,
  );
const roles = z.array(roleSchema).min(1);

const entrySchema = z.discriminatedUnion("on", [
  z.strictObject({
    on: z.literal("schema"),
    name: z.enum(FIN_SCHEMAS),
    privileges: z.tuple([z.literal("USAGE")]),
    to: roles,
  }),
  z.strictObject({
    on: z.literal("table"),
    name: qualified,
    privileges: z.array(z.enum(["SELECT", "INSERT", "UPDATE", "DELETE"])).min(1),
    columns: z
      .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
      .min(1)
      .optional(),
    to: roles,
  }),
  z.strictObject({
    on: z.literal("function"),
    name: signature,
    privileges: z.tuple([z.literal("EXECUTE")]),
    to: roles,
  }),
]);

const fragmentSchema = z.strictObject({
  $comment: z.string().optional(),
  area: z.string().regex(/^[a-z][a-z0-9-]*$/),
  grants: z.array(entrySchema),
});

export type GrantEntry = z.infer<typeof entrySchema>;
export interface GrantFragment {
  file: string;
  area: string;
  grants: GrantEntry[];
}

export type ObjectKind = "schema" | "table" | "function";

/**
 * The roles applying revokes from and the drift check reads: the grantees, plus the logins and the
 * backup role, which never hold a privilege directly (logins inherit their group's).
 */
export const MANAGED_ROLES: readonly string[] = [...GRANTEE_ROLES, ...SERVICE_LOGINS, "fin_backup"];

/** One privilege of one role on one object: the unit the matrix and the drift check compare. */
export interface Privilege {
  kind: ObjectKind;
  /** `ops`, `ops.kill_switch`, `ops.kill_switch(holder)` for a column, or a function signature. */
  object: string;
  privilege: string;
  role: GranteeRole;
}

export function parseFragment(file: string, text: string): GrantFragment {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MigrationError("grants_invalid", `${file}: not valid JSON`, file);
  }
  const parsed = fragmentSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MigrationError(
      "grants_invalid",
      `${file}: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "invalid"}`,
      file,
    );
  }
  for (const entry of parsed.data.grants) {
    if (
      entry.on === "table" &&
      entry.columns !== undefined &&
      entry.privileges.some((p) => p !== "SELECT" && p !== "UPDATE" && p !== "INSERT")
    ) {
      throw new MigrationError(
        "grants_invalid",
        `${file}: column grants are SELECT, INSERT or UPDATE`,
        file,
      );
    }
    if (entry.on !== "schema") {
      const schema = entry.name.split(".")[0] ?? "";
      if (!(FIN_SCHEMAS as readonly string[]).includes(schema)) {
        throw new MigrationError(
          "grants_invalid",
          `${file}: ${entry.name} is outside Fin's schemas`,
          file,
        );
      }
    }
  }
  return { file, area: parsed.data.area, grants: parsed.data.grants };
}

export function loadFragments(dir: string): GrantFragment[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const fragments = files.map((name) => parseFragment(name, readFileSync(join(dir, name), "utf8")));
  const areas = new Set<string>();
  for (const fragment of fragments) {
    if (`${fragment.area}.json` !== fragment.file) {
      throw new MigrationError(
        "grants_invalid",
        `${fragment.file}: area must match the file name`,
        fragment.file,
      );
    }
    if (areas.has(fragment.area)) {
      throw new MigrationError("grants_invalid", `${fragment.file}: duplicate area`, fragment.file);
    }
    areas.add(fragment.area);
  }
  return fragments;
}

/** The matrix as a flat, sorted, de-duplicated list of privileges. */
export function expandMatrix(fragments: readonly GrantFragment[]): Privilege[] {
  const seen = new Map<string, Privilege>();
  for (const fragment of fragments) {
    for (const entry of fragment.grants) {
      for (const privilege of entry.privileges) {
        const objects =
          entry.on === "table" && entry.columns !== undefined
            ? entry.columns.map((column) => `${entry.name}(${column})`)
            : [entry.name];
        for (const object of objects) {
          for (const role of entry.to) {
            const item: Privilege = { kind: entry.on, object, privilege, role };
            seen.set(privilegeKey(item), item);
          }
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => privilegeKey(a).localeCompare(privilegeKey(b)));
}

export function privilegeKey(p: Privilege): string {
  return `${p.kind} ${p.object} ${p.privilege} ${p.role}`;
}

function quoteQualified(name: string): string {
  const [schema, object] = name.split(".");
  return `${escapeIdentifier(schema ?? "")}.${escapeIdentifier(object ?? "")}`;
}

function quoteSignature(name: string): string {
  const open = name.indexOf("(");
  // The argument list passed the signature pattern: lower-case type names, commas and brackets only.
  return `${quoteQualified(name.slice(0, open))}${name.slice(open)}`;
}

interface OwnedObjects {
  schemas: Set<string>;
  tables: Set<string>;
  functions: Set<string>;
  sequences: Set<string>;
}

/** The objects in Fin's schemas the current role owns, by the names the fragments use. */
async function ownedObjects(q: Queryable): Promise<OwnedObjects> {
  const schemas = await q.query<{ name: string }>(
    `SELECT n.nspname AS name FROM pg_catalog.pg_namespace n
     WHERE n.nspname = ANY ($1) AND n.nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)`,
    [FIN_SCHEMAS],
  );
  const relations = await q.query<{ name: string; kind: string }>(
    `SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS kind
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY ($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)`,
    [FIN_SCHEMAS],
  );
  const functions = await q.query<{ name: string }>(
    `SELECT p.oid::pg_catalog.regprocedure::text AS name
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY ($1)
       AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)`,
    [FIN_SCHEMAS],
  );
  return {
    schemas: new Set(schemas.rows.map((r) => r.name)),
    tables: new Set(relations.rows.filter((r) => r.kind !== "S").map((r) => r.name)),
    sequences: new Set(relations.rows.filter((r) => r.kind === "S").map((r) => r.name)),
    functions: new Set(functions.rows.map((r) => normaliseSignature(r.name))),
  };
}

/**
 * The fragments' form of a function signature: the `regprocedure` text (schema-qualified, argument
 * types only) with ", " between arguments and `timestamptz` for `timestamp with time zone`.
 */
export function normaliseSignature(text: string): string {
  return text
    .replace(/"/g, "")
    .replace(/\s*,\s*/g, ", ")
    .replace(/timestamp with time zone/g, "timestamptz");
}

export interface ApplyOptions {
  /**
   * What to do with a fragment entry for an object that does not exist yet: the bootstrap skips them
   * (it runs before the migrations), the migration run refuses them.
   */
  missing: "skip" | "error";
}

/**
 * Renders and runs the revokes and grants for every object the current role owns. Returns the
 * statements it ran (names only), for the migrate line's counts and the tests.
 */
export async function applyGrants(
  q: Queryable,
  fragments: readonly GrantFragment[],
  options: ApplyOptions = { missing: "error" },
): Promise<string[]> {
  const owned = await ownedObjects(q);
  const everyone = ["PUBLIC", ...MANAGED_ROLES.map((r) => escapeIdentifier(r))].join(", ");
  const statements: string[] = [];
  for (const schema of [...owned.schemas].sort()) {
    statements.push(`REVOKE ALL ON SCHEMA ${escapeIdentifier(schema)} FROM ${everyone}`);
  }
  for (const table of [...owned.tables].sort()) {
    statements.push(`REVOKE ALL ON TABLE ${quoteQualified(table)} FROM ${everyone}`);
  }
  for (const sequence of [...owned.sequences].sort()) {
    statements.push(`REVOKE ALL ON SEQUENCE ${quoteQualified(sequence)} FROM ${everyone}`);
  }
  for (const fn of [...owned.functions].sort()) {
    statements.push(`REVOKE ALL ON FUNCTION ${quoteSignature(fn)} FROM ${everyone}`);
  }
  for (const fragment of fragments) {
    for (const entry of fragment.grants) {
      const to = entry.to.map((r) => escapeIdentifier(r)).join(", ");
      if (entry.on === "schema") {
        if (!owned.schemas.has(entry.name)) continue;
        statements.push(`GRANT USAGE ON SCHEMA ${escapeIdentifier(entry.name)} TO ${to}`);
      } else if (entry.on === "table") {
        if (!owned.tables.has(entry.name)) {
          if (options.missing === "skip" || (await exists(q, "table", entry.name))) continue;
          throw new MigrationError(
            "grants_unknown_object",
            `${fragment.file}: no table ${entry.name}`,
            fragment.file,
          );
        }
        const columns =
          entry.columns === undefined
            ? ""
            : ` (${entry.columns.map((c) => escapeIdentifier(c)).join(", ")})`;
        statements.push(
          `GRANT ${entry.privileges.map((p) => `${p}${columns}`).join(", ")} ON TABLE ${quoteQualified(entry.name)} TO ${to}`,
        );
      } else {
        if (!owned.functions.has(entry.name)) {
          if (options.missing === "skip" || (await exists(q, "function", entry.name))) continue;
          throw new MigrationError(
            "grants_unknown_object",
            `${fragment.file}: no function ${entry.name}`,
            fragment.file,
          );
        }
        statements.push(`GRANT EXECUTE ON FUNCTION ${quoteSignature(entry.name)} TO ${to}`);
      }
    }
  }
  for (const statement of statements) await q.query(statement);
  return statements;
}

async function exists(q: Queryable, kind: "table" | "function", name: string): Promise<boolean> {
  const result =
    kind === "table"
      ? await q.query<{ found: boolean }>(
          `SELECT pg_catalog.to_regclass($1) IS NOT NULL AS found`,
          [name],
        )
      : await q.query<{ found: boolean }>(
          `SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS found`,
          [name],
        );
  return result.rows[0]?.found === true;
}

/**
 * The live privileges of Fin's grantee roles (and PUBLIC, as the role "PUBLIC") on every object in
 * Fin's schemas, in the matrix's form: the drift check (`database.grants_drift`) and AC-P0-39's
 * "exactly its grants" test compare this with `expandMatrix`.
 */
export async function livePrivileges(
  q: Queryable,
): Promise<{ kind: ObjectKind; object: string; privilege: string; role: string }[]> {
  const result = await q.query<{
    kind: ObjectKind;
    object: string;
    privilege: string;
    role: string;
  }>(
    `WITH grantees AS (
       SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname = ANY ($2)
       UNION ALL SELECT 0, 'PUBLIC'
     )
     SELECT 'schema'::text AS kind, n.nspname::text AS object, a.privilege_type::text AS privilege,
            g.rolname::text AS role
     FROM pg_catalog.pg_namespace n, LATERAL aclexplode(n.nspacl) a JOIN grantees g ON g.oid = a.grantee
     WHERE n.nspname = ANY ($1)
     UNION ALL
     SELECT 'table', ns.nspname || '.' || c.relname, a.privilege_type, g.rolname
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace,
          LATERAL aclexplode(c.relacl) a JOIN grantees g ON g.oid = a.grantee
     WHERE ns.nspname = ANY ($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     UNION ALL
     SELECT 'table', ns.nspname || '.' || c.relname || '(' || att.attname || ')', a.privilege_type, g.rolname
     FROM pg_catalog.pg_attribute att
     JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace,
          LATERAL aclexplode(att.attacl) a JOIN grantees g ON g.oid = a.grantee
     WHERE ns.nspname = ANY ($1) AND att.attnum > 0 AND NOT att.attisdropped
     UNION ALL
     SELECT 'function', p.oid::pg_catalog.regprocedure::text, a.privilege_type, g.rolname
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace,
          LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a JOIN grantees g ON g.oid = a.grantee
     WHERE ns.nspname = ANY ($1)`,
    [FIN_SCHEMAS, MANAGED_ROLES],
  );
  return result.rows
    .map((row) =>
      row.kind === "function" ? { ...row, object: normaliseSignature(row.object) } : row,
    )
    .sort((a, b) =>
      `${a.kind} ${a.object} ${a.privilege} ${a.role}`.localeCompare(
        `${b.kind} ${b.object} ${b.privilege} ${b.role}`,
      ),
    );
}

/** One role membership: `member` is granted `role`, with the grant's options. */
export interface Membership {
  member: string;
  role: string;
  admin: boolean;
  inherit: boolean;
  set: boolean;
}

/**
 * The memberships Fin's roles must have, and the only ones (P-20, ARCHITECTURE §6.3): each service
 * login in exactly its group, `fin_backup` in pg_read_all_data and `fin_probe` in pg_monitor (inherited,
 * never SET), and nothing else for any Fin role, as member or as the role granted.
 */
export function expectedMemberships(): Membership[] {
  return [
    ...SERVICE_LOGINS.map((login) => ({
      member: login,
      role: login.replace(/_[ab]$/, ""),
      admin: false,
      inherit: true,
      set: true,
    })),
    { member: "fin_backup", role: "pg_read_all_data", admin: false, inherit: true, set: false },
    { member: "fin_probe", role: "pg_monitor", admin: false, inherit: true, set: false },
  ].sort((a, b) => membershipKey(a).localeCompare(membershipKey(b)));
}

export function membershipKey(m: Membership): string {
  return `${m.member} ${m.role} admin=${m.admin} inherit=${m.inherit} set=${m.set}`;
}

/** The live memberships in which a Fin role is the member or the role granted, one per grant. */
export async function liveMemberships(q: Queryable): Promise<Membership[]> {
  const result = await q.query<Membership>(
    `SELECT DISTINCT m.rolname::text AS member, g.rolname::text AS role, a.admin_option AS admin,
            a.inherit_option AS inherit, a.set_option AS set
     FROM pg_catalog.pg_auth_members a
     JOIN pg_catalog.pg_roles m ON m.oid = a.member
     JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
     WHERE m.rolname = ANY ($1) OR g.rolname = ANY ($1)`,
    [FIN_ROLES],
  );
  return result.rows.sort((a, b) => membershipKey(a).localeCompare(membershipKey(b)));
}

export interface GrantDrift {
  role: string;
  missing: number;
  extra: number;
}

/**
 * Per role, how many matrix privileges and expected memberships are missing live, and how many live
 * ones the matrix and the expected memberships lack (`database.grants_drift`). A membership counts
 * against its member: a login granted pg_write_all_data shows as one extra on that login.
 */
export async function grantDrift(
  q: Queryable,
  fragments: readonly GrantFragment[],
): Promise<GrantDrift[]> {
  const drift = new Map<string, GrantDrift>();
  const bump = (role: string, field: "missing" | "extra") => {
    const row = drift.get(role) ?? { role, missing: 0, extra: 0 };
    row[field] += 1;
    drift.set(role, row);
  };

  const expected = new Set(expandMatrix(fragments).map(privilegeKey));
  const live = new Set(
    (await livePrivileges(q)).map((p) => `${p.kind} ${p.object} ${p.privilege} ${p.role}`),
  );
  const roleOf = (key: string) => key.split(" ").at(-1) ?? "unknown";
  for (const key of expected) if (!live.has(key)) bump(roleOf(key), "missing");
  for (const key of live) if (!expected.has(key)) bump(roleOf(key), "extra");

  const wanted = new Map(expectedMemberships().map((m) => [membershipKey(m), m]));
  const held = new Map((await liveMemberships(q)).map((m) => [membershipKey(m), m]));
  for (const [key, m] of wanted) if (!held.has(key)) bump(m.member, "missing");
  for (const [key, m] of held) if (!wanted.has(key)) bump(m.member, "extra");

  return [...drift.values()].sort((a, b) => a.role.localeCompare(b.role));
}
