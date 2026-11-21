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
  the group roles (`fin_api`, …), never to a login. `email.enqueue()` is owned by `fin_email_enqueue`
  (NOLOGIN; fin_owner is its one member), whose grants the runner applies the same way; it may use
  `email_private`, the worker's schema, and holds only what the function needs.
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
  unrecorded. The login function runs as the superuser and writes only the bootstrap's own table,
  checked under the insert's lock: a table of the record's name that fin_owner made while the record
  was gone is never written (none of its triggers or rules runs with the superuser's rights), the
  superuser's login goes ahead unrecorded and a fin_owner login is refused.
- `030_environment.sql`: `ops.environment`, written once from `FIN_ENVIRONMENT`. `audit.start_epoch()`
  refuses a reset in production and any start whose task names another environment (FA012), reading
  the bootstrap's one row only (`ONLY`, exactly one row).
- The bootstrap adopts an existing `ops.privileged_login` or `ops.environment` only if it is its own: a
  plain table owned by a superuser, with no inheritance, row-level security, policy, rule or trigger of
  anyone else's, checked after its `CREATE TABLE IF NOT EXISTS` so the table checked is the table
  adopted. Otherwise it stops (42501, naming the table): a superuser inspects the table through the
  catalog (never by reading or writing it, which could run fin_owner's code with the superuser's
  rights), drops it and bootstraps again.
- `040_audit_guard.sql`: the guard on the audit trail's protections. Every trigger calling
  `audit.append_only()` or `audit.require_event()`, those two functions, and the shape of every audit
  table (each column's type, collation, not-null, default, generation and identity; its constraints
  and unique indexes; row-level security, policies, rules, inheritance and other triggers) are
  recorded when a migration creates them, by name. Afterwards anyone but the superuser is refused DDL
  that would drop, disable, rename, re-target or replace a protected trigger or function, change an
  audit table's shape (a rename, a swap, a column added under a renamed one's name, a policy, a rule, a
  child table, a dropped unique index) or rewrite it or drop one of its columns, or rename, drop
  (even to add it again under its name in the same command) or rewrite a guard's key column. As a
  rewrite does not say which column it rewrites, a guarded table is never rewritten column by column
  (`ALTER COLUMN … TYPE` with a rewrite); a rewrite that keeps every value (a new column's default,
  persistence, access method) is allowed. An audit table may still gain a plain column (no default of
  its own or of its type, so the rows already written read null in it; not generated, not an
  identity; of a type a superuser owns, as fin_owner could change what rows read in a column of its
  own enum, domain or composite type), a constraint or an index, which joins the record; any other
  table, guarded business tables included apart from their guards, key columns and column rewrites,
  is the migrations' to change.
  A later change to a protection is a registered superuser run, not a migration; after a major-version
  upgrade the superuser runs `SELECT ops_guard.record_audit_protections()`. A migration adds a unique
  index to an audit table as a constraint (`ADD CONSTRAINT … UNIQUE`, or `EXCLUDE` for a partial
  one): DROP INDEX refuses a constraint's index before it starts, where a refused `DROP INDEX
  CONCURRENTLY` of a plain unique index has already left it dead.

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
may fail on purpose (a unique key mapped to a 409) inside `tx.savepoint()`. A savepoint whose
statement failed with its error caught throws `TransactionAbortedError` too, even when the client has
not yet read that the transaction failed.

## Tests

Unit tests run with `pnpm test`; integration tests (`*.db.test.ts`) with `pnpm test:db`, against
`FIN_TEST_DATABASE_URL` (a superuser URL to a loopback Postgres 18), both through the root
`vitest.config.ts` (the package has no Vitest configuration of its own). `createTestDatabase({ prefix })`
from `@fin/db/testing` gives each test file a fresh database, bootstrapped for the `ci` environment and
migrated. The roles are cluster-wide, turbo runs the packages' integration tests at the same time and
Vitest runs a package's files in parallel, so the test bootstrap sizes connection limits for
`TEST_REPLICAS` replicas, `database(group)` gives a file one pool per login, and each integration file
sets its own timeouts (`vi.setConfig`), as its database is made under the cluster-wide lock. `connect(login, applicationName, startupOptions)` takes startup settings
(`-c name=value`) as a client would send them. The TLS test starts its own throwaway cluster when
`FIN_TEST_PG_BINDIR` names the directory holding `initdb` and `pg_ctl`, and is skipped otherwise; the
same variable lets the roles test run `pg_dump` as the backup login.
