# No lines from a service

Alert: `no-logs-{service}` (one per service: edge, api, worker, payments, console, admin,
verify, backup, connector, watcher).

## What it means

Better Stack received no line from the service's source in its window (the window is in the
overlay). Either the service stopped, or it runs but its shipping stopped (a revoked or rotated
source token, a 402 from a spending cap, a network problem), or Better Stack's EU ingest is
delayed. When every `no-logs` alert fires at once, suspect Better Stack first.

## First check

1. Are the uptime monitors green? If they are, the service answers and only shipping is affected.
2. Railway's deployment state for the service, and its stdout for `telemetry.ship_failed` lines
   (the `status` says why: 401 or 403 the token, 402 the quota, 5xx Better Stack).
3. Better Stack's status page for EU ingest delays.

## Containment

1. A stopped service: redeploy it through `pnpm fin deploy staging` (never by hand in Railway).
2. A token problem: rotate the source's token (`rotate-betterstack`) and deploy the service.
3. A Better Stack delay: nothing to do but wait; lines stay on Railway's stdout copy. Do not deploy
   until it recovers.

## When to wake the owner

If a service is down and its monitor is red too, or the watcher's or connector's lines stopped
(nothing would then see a rogue connector). A Better Stack ingest delay with every monitor green
can wait.
