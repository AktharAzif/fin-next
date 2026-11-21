# A service is serving 5xx answers

Alerts: `5xx-rate-{service}` (the ratio of 5xx answers, with a minimum count) and
`5xx-count-{service}` (the absolute count, whatever the ratio), for edge, api, payments, console,
admin and verify.

## What it means

The service's `request` lines show server errors above their threshold. The ratio catches a
service that fails a share of everything; the absolute count catches failures at low traffic,
where a ratio never reaches its minimum.

## First check

1. The top `route` by 5xx in the service's source, and whether it started with the last release.
2. The service's Errors application for the same window (the `errorId` on the lines).
3. Whether a dependency is down: `database-unreachable`, the connector count, the callee's health.

## Containment

1. A release regression: roll back (`pnpm fin rollback staging`, static half first).
2. A dependency outage: follow that alert's runbook; the 5xx clear with it.

## When to wake the owner

If the edge or api serve 5xx above the threshold for more than 10 minutes, or a release rollback
does not clear it. A short burst that clears can wait.
