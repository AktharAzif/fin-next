# The edge's key check cannot read Postgres

Alert: `rate-limiter-failing`.

## What it means

The edge checks every `/v4` key against Postgres and fails closed (spec 05 §2.1, §3.7): when one of
its statements fails, the request is refused with 503 `temporarily_unavailable` and
`Retry-After: 5`, never let through. Two lines raise the alert:

- `key.lookup_failed`: step 15's one statement failed or did not read. It reads the key record
  from `keys.key_lookup`, the address's refused-key window from `ops.rate_window` and the
  `live_keys` switch together, so while it fails every keyed request is refused.
- `rate_limiter.failed`: a window's count in `ops.rate_window` failed. `policy` is `key` for a
  working key's window (600 calls a minute) and `refused_keys` for a refused key's address window.

`code` on both is the error's SQLSTATE when Postgres answered, a Node error code when the
connection failed, or the error's name.

## First check

1. The `code` on the lines: `42501` is a grant the edge's login lacks; a connection code or
   `57P01` points at Postgres or the pool; a name such as `Error` is a statement whose answer did
   not read, so look at the last release and migration.
2. Whether `database-unreachable` or `pool-exhausted` is open, and `dbOk` on the edge's
   `process.health` lines.
3. Whether it started with the last release or migration, and whether `grants-drift` is open.

## Containment

1. Postgres down or unreachable: follow `database.md`; the key check recovers with it.
2. A grant missing after a migration: `grants-drift` names it; roll the release back
   (`pnpm fin rollback staging`) or restore the grant through a reviewed migration.
3. Never turn the check off or let keys through while it fails: it stays closed by design.

## When to wake the owner

At once if it lasts more than 5 minutes: every keyed API call is refused while step 15 fails, and
working keys over their window cannot be counted. A burst that clears within a minute can wait.
