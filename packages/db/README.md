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
  values. The guard test compares every registration with the installed triggers.

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
`AuditGuardError`.

## Tests

Unit tests run with `pnpm test`; integration tests (`*.db.test.ts`) with `pnpm test:db`, against
`FIN_TEST_DATABASE_URL` (a superuser URL to a loopback Postgres 18). `createTestDatabase({ prefix })`
from `@fin/db/testing` gives each test file a fresh database, bootstrapped and migrated. The TLS test
starts its own throwaway cluster when `FIN_TEST_PG_BINDIR` names the directory holding `initdb` and
`pg_ctl`, and is skipped otherwise.
