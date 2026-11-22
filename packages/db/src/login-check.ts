// The boot check (ARCHITECTURE §6.3, DECISIONS P-20): a service refuses to start when its database login
// is not the configured one, is a superuser or holds any role attribute beyond LOGIN, or is a member of
// anything but its own group, which itself must be a member of nothing. Membership is what counts, not
// only SET ROLE: a grant made WITH INHERIT TRUE, SET FALSE (pg_write_all_data, pg_read_all_data, another
// group) hands the login every privilege of the role without letting it SET ROLE. Run once from `main()`
// before the service reports ready.
import { LoginCheckError } from "./errors.ts";
import type { ServiceGroup } from "./roles.ts";
import type { Queryable } from "./unit.ts";

export interface LoginFacts {
  login: string;
  group: ServiceGroup;
}

export async function assertServiceLogin(q: Queryable, expected: LoginFacts): Promise<void> {
  if (!new RegExp(`^${expected.group}_[ab]$`).test(expected.login)) {
    throw new LoginCheckError("the configured login is not one of its group's");
  }
  const who = await q.query<{
    current_user: string;
    session_user: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT current_user, session_user, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls
     FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  );
  const facts = who.rows[0];
  if (facts === undefined) throw new LoginCheckError("the login has no role row");
  if (facts.current_user !== expected.login || facts.session_user !== expected.login) {
    throw new LoginCheckError("connected as another role than the configured login");
  }
  if (
    facts.rolsuper ||
    facts.rolcreaterole ||
    facts.rolcreatedb ||
    facts.rolreplication ||
    facts.rolbypassrls
  ) {
    throw new LoginCheckError("the login holds a role attribute beyond LOGIN");
  }
  // Every role the login is a member of, directly or through another role, whatever the grant's
  // INHERIT and SET options: exactly its group.
  const member = await q.query<{ rolname: string }>(
    `SELECT r.rolname FROM pg_catalog.pg_roles r
     WHERE r.rolname <> current_user AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
     ORDER BY r.rolname`,
  );
  const roles = member.rows.map((row) => row.rolname);
  if (roles.length !== 1 || roles[0] !== expected.group) {
    throw new LoginCheckError("the login is a member of something other than its own group");
  }
  const settable = await q.query<{ rolname: string }>(
    `SELECT r.rolname FROM pg_catalog.pg_roles r
     WHERE r.rolname <> current_user AND pg_catalog.pg_has_role(current_user, r.oid, 'SET')
     ORDER BY r.rolname`,
  );
  const sets = settable.rows.map((row) => row.rolname);
  if (sets.length !== 1 || sets[0] !== expected.group) {
    throw new LoginCheckError("the login can SET ROLE to something other than its own group");
  }
}
