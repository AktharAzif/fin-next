# A process crashed, restarts too often, or was forced down

Alerts: `process-crash`, `process-restarts`, `shutdown-forced`.

## What it means

- `process-crash`: an unhandled exception or rejection ended a process
  (`process.uncaught_exception`, `process.unhandled_rejection`); the line carries the `errorId`.
- `process-restarts`: more `process.start` lines than the threshold in 15 minutes: a crash loop,
  memory kills, or a failing readiness check.
- `shutdown-forced`: draining ran out of time and the process stopped with work in flight.

## First check

1. The service's Errors application, filtered to the release, by the `errorId` on the line.
2. For restarts: the crash lines and `rss_mb` before each start; Railway's restart reason.
3. For a forced shutdown: the `background` count on the line, and `FIN_DRAIN_SECONDS` against
   Railway's draining time for the service.

## Containment

1. A crash introduced by a release: roll back (`pnpm fin rollback staging`, static half first as
   spec 01 §6.9 orders it).
2. A memory kill: roll back, then fix the leak in a reviewed change; never raise the limit by hand.
3. Record the `errorId` in the incident; never paste the error's text into a public place.

## When to wake the owner

If a crash loop keeps a service down for more than 15 minutes, or `api`, `edge` or the connector
crashes repeatedly. A single crash with the service back up can wait for working hours.
