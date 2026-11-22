# @fin/db

The data layer (spec 01 §6.6, §6.10; ARCHITECTURE §3.5, §4.5, §6; lane P0-E): the pg pool and the unit
of work, the migration runner and `migrate --bootstrap`, the grant matrix, the audit guard
registrations, and typed access to Phase 0's `ops` tables.

## Adding to the schema (every area's lane)

- **A migration** is `migrations/<YYYYMMDDHHMMSS>_<area>_<what>.sql`, hand-written, later than the newest
  file on `main`, beginning with `SET LOCAL lock_timeout = '…';` and `SET LOCAL statement_timeout = '…';`.
  The runner applies pending files in name order in one transaction under `LOCK TABLE
  ops.schema_migrations IN EXCLUSIVE MODE`, records each file's SHA-256 and refuses a changed applied
  file. A file whose first line is `-- fin:non-transactional` holds exactly one statement.
- **Grants** go in `roles/grants/<area>.json` (`{ area, grants: [{ on, name, privileges, columns?, to }] }`).
  The runner applies them exactly: everything Fin's roles hold on an object fin_owner owns is revoked and
  re-granted from the fragments, so a statement no fragment allows fails with SQLSTATE 42501. Grant to
  the group roles (`fin_api`, …), never to a login.
- **A guarded table** (a write that must carry its audit event, spec 08 §3.5) is registered in
  `src/guards/<area>.ts` with `defineGuards`, and the area's migration calls
  `audit.install_guard('<table>'::regclass, ARRAY[<ops>], '<key column>', ARRAY[<events>])` with the same
  values. The guard test compares every registration with the installed triggers. Installing the same
  guard again leaves it in place; a guard, once installed, is changed or removed only by the superuser.

## The superuser's bootstrap

`migrate --bootstrap` runs `bootstrap/010_roles.sql` first, then the other `NNN_<what>.sql` files in name
order, in one transaction:

- `020_privileged_login.sql`: the privileged-login record (ARCHITECTURE §6.3, P-19). A superuser's login
  is never refused; a fin_owner login whose record cannot be written (a read-only start, a lock held on
  the table past the function's one-second lock timeout) is refused, so no fin_owner login goes
  unrecorded.
- `030_environment.sql`: `ops.environment`, written once from `FIN_ENVIRONMENT`. `audit.start_epoch()`
  refuses a reset in production and any start whose task names another environment (FA012).
- `040_audit_guard.sql`: the guard on the audit trail's protections. Every trigger calling
  `audit.append_only()` or `audit.require_event()`, and those two functions, are recorded when a
  migration creates them; afterwards anyone but the superuser is refused DDL that would drop, disable,
  rename, re-target or replace one, and the rewrite or a dropped column of an append-only table. Adding
  (tables, columns, indexes, functions, guards) is never refused. A later change to a protection is a
  registered superuser run, not a migration.

## The unit of work

```ts
const db = createDatabase({ pool: createPool(poolSettingsFromEnv(process.env, "api"), log) });
await db.unit(context, async (tx) => {
  await tx.query("…");          // one transaction; SET LOCAL only
  await recordAudit(tx, { … }); // @fin/audit, in the same transaction
});
```

No outbound call may start while a unit holds its client: `assertNotHoldingClient("provider call")`
refuses one, and `installFetchGuard()` from `@fin/db/testing` makes every `fetch` inside a unit fail in
tests. A commit the audit guard refuses writes `database.audit_guard` (the table only) and throws
`AuditGuardError`. A unit whose transaction failed (a statement's error caught and the work carried on)
throws `TransactionAbortedError` rather than returning as if it had committed: run a statement that
may fail on purpose (a unique key mapped to a 409) inside `tx.savepoint()`.

## Tests

Unit tests run with `pnpm test`; integration tests (`*.db.test.ts`) with `pnpm test:db`, against
`FIN_TEST_DATABASE_URL` (a superuser URL to a loopback Postgres 18). `createTestDatabase({ prefix })`
from `@fin/db/testing` gives each test file a fresh database, bootstrapped for the `ci` environment and
migrated. The roles are cluster-wide and turbo runs the packages' integration tests at the same time,
so the test bootstrap sizes connection limits for `TEST_REPLICAS` replicas and `database(group)` gives a
file one pool per login. `connect(login, applicationName, startupOptions)` takes startup settings
(`-c name=value`) as a client would send them. The TLS test starts its own throwaway cluster when
`FIN_TEST_PG_BINDIR` names the directory holding `initdb` and `pg_ctl`, and is skipped otherwise; the
same variable lets the roles test run `pg_dump` as the backup login.
