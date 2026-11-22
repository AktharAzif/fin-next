# The auth limiter cannot reach its store

Alert: `rate-limiter-failing` (pages: any `limits.store_failed` line, one incident per service).

## What it means

The auth limiter keeps its counts in Postgres (spec 02 §5.6). When it cannot read or write them it
fails closed: the request is refused with 503 and `limits.store_failed` is written with the
`bucket`. While it lasts, sign-ins, codes and the other limited auth requests on that service are
refused for everyone. It is almost always the database, not the limiter.

## First check

1. The `service` and `bucket` on the lines; one bucket or every bucket.
2. `database-unreachable` and `pool-exhausted` for the same service, and the `process.health`
   lines' `dbOk`, `poolWaiting` and `poolIdle`.
3. The database itself (`database.md`): is it up, is a long transaction or a lock holding the
   limiter's tables?

## Containment

1. The database down or out of connections: follow `database.md`; the limiter recovers on its own
   when the store answers again.
2. A lock on the limiter's tables: end the session holding it (`database.md`).
3. Never turn the limiter off or let it fail open to restore sign-ins: that removes the guessing
   limits. Close it when no new line comes; the incident recovers 15 minutes after the last one.

## When to wake the owner

At once if sign-ins stay refused for more than 10 minutes, or the database looks healthy and the
lines continue.
