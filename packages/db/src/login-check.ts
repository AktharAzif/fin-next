// The boot check (ARCHITECTURE §6.3, DECISIONS P-20): a service refuses to start when its database login
// is not the configured one, is a superuser or holds any role attribute beyond LOGIN, or can SET ROLE to
// anything but its own group. Run once from `main()` before the service reports ready.
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
  const settable = await q.query<{ rolname: string }>(
    `SELECT r.rolname FROM pg_catalog.pg_roles r
     WHERE r.rolname <> current_user AND pg_catalog.pg_has_role(current_user, r.oid, 'SET')
     ORDER BY r.rolname`,
  );
  const roles = settable.rows.map((row) => row.rolname);
  if (roles.length !== 1 || roles[0] !== expected.group) {
    throw new LoginCheckError("the login can SET ROLE to something other than its own group");
  }
}
