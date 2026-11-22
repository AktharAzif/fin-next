# The email delivery check stalled

Alert: `email-delivery-stalled` (pages: any failed `email-delivery-check` run, or one whose run
could not be recorded).

## What it means

The worker's `email-delivery-check` duty queues the `ops/delivery-check` email after each release
and once a day (spec 01 S0-09), and records each run in `ops.duty_state`. The alert counts its
`job.run` lines (job `email-delivery-check`, not the `sent` line) with `result: failed` or
`dutyState: failed`. The `code` names the failure:

- `pg_55P03`, a lock timeout: two sessions hold a relation `email.enqueue()` reads
  (`email.template_grant`, or `pg_authid` and `pg_db_role_setting` behind `pg_roles`), so the
  check waited out its 5 s lock timeout. Every other service's `email.enqueue()` waits behind the
  same hold, sign-in codes included, and fails with `55P03` too (`packages/email/README.md`).
- a connection error or timeout (`pg_ETIMEDOUT`, `pg_ECONNREFUSED`, `error` with no code): the
  worker could not reach the database in time.
- `dutyState: failed` with `dutyStateCode`: the email was queued, but `ops.duty_state` could not be
  written (often `pg_55P03` on it), so the duty reads as failing.

The `email-delivery-check` heartbeat stops a day later if the check keeps failing; this alert says
so at once.

## First check

1. The `code`, `dutyState` and `dutyStateCode` on the delivery check's `job.run` lines, and when
   they began.
2. For `pg_55P03`: the sessions holding or waiting on `email.template_grant`, `pg_authid`,
   `pg_db_role_setting` or `ops.duty_state` (`database.md`: `pg_locks` joined to
   `pg_stat_activity`, by role and application name, never the query text in a note).
3. For a connection error: `database-unreachable`, `pool-exhausted`, and the worker's
   `process.health` lines.
4. Are `email-outbox-age` or `email-not-sent` open too? Codes and notices are then late as well.

## Containment

1. A held lock: end the session holding it (`database.md`), and find which login held it; a
   service login holding these relations is a fault to fix in a reviewed change.
2. The database unreachable: follow `database.md`; the next run (after the next release, or the
   next day) checks again.
3. Close it when a run succeeds; the incident recovers 15 minutes after the last failed line.

## When to wake the owner

At once if sign-in codes are failing with it (`email-not-sent` with `class` `code`, or `55P03` on
console or admin), or a lock on these relations comes back after it was ended.
