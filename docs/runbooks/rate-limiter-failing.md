# The auth limiter cannot read or write its counts

Alert: `rate-limiter-failing` (pages: any `limits.store_failed` on console or admin), one incident
per service.

## What it means

The auth limiter keeps its counts in Postgres, never in a process (spec 02 §5.6): fixed windows in
`ops.rate_window` and lockouts in `ops.lockout`. It runs in identity's realms on console
(developer) and admin (staff), and on the organisation routes that use them. When a read or a write
of those tables fails, the limiter fails closed: it writes `limits.store_failed` with the `bucket`
(`code_send`, `code_sign_in`, `factor_code`, `staff_code_send`, `step_up_intents` and the others in
`packages/identity/src/limits.ts`), and the request is refused with `503 unavailable` and
`retry_after: 5`; its request line has `reason: limits.store_failed`. While this lasts, sign-ins,
code requests, factor steps and every other limited step on that service are refused for
everyone. Nothing is let through unlimited.

The usual causes are Postgres itself (down, or the service's pool full), a lock held on one of the
two tables (a migration or a long transaction), or a grant on them that the service's login lost.
The API's own limiter (spec 05, on edge and api) is not read by this alert: it joins with the keys
lane.

## First check

1. Whether `database-unreachable` or `pool-exhausted` is open for the same service, Railway's
   Postgres state, and the probe's longest transaction (`database.md`). If one is open,
   `database.md` leads and this alert follows it.
2. The `bucket` on the lines: every bucket at once is the database or the tables; one bucket alone
   points at that bucket's own statement (a release that changed it).
3. Whether a migration or a `migrate --task` run was going (its run registration) when the lines
   began: one holding a lock on `ops.rate_window` or `ops.lockout` past the service's lock timeout
   refuses every limited request until it ends.
4. `grants-drift` for the service's role, and the last migration's run: a grant on the two tables
   that the login lost fails every try the same way.

## Containment

1. Postgres down or pools full: follow `database.md`. Nothing at the limiter needs changing; it
   recovers on its own once its statements succeed.
2. A lock held by a run: let a registered run finish or end it through a registered task
   (`pg_stat_activity`, as `database.md` says); never end a session by hand as a privileged login.
3. A lost grant: re-apply the grants through the migration runner in a registered run
   (`grants-drift.md`).
4. A release that broke one bucket's statement: deploy the previous release's manifest
   (`railway-deploy.md`, "If a deploy fails"), then fix it in a reviewed change.
5. Never turn the limiter off or let a request through when its count cannot be read: failing
   closed is the design. Close it when no new `limits.store_failed` comes and a sign-in on that
   service works; the incident recovers 10 minutes after the last line.

## When to wake the owner

At once if sign-ins stay refused for more than 10 minutes, or a grant on the limiter's tables
changed with no registered run. A lock held by a known run can wait for the run to end.
