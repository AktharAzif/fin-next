# Better Stack differs from ops/monitoring

Alert: `monitoring-drift` (the daily dry run, `run.done` `result=drift`).

## What it means

`pnpm fin monitoring apply staging --dry-run` found a difference between Better Stack and the
files: someone changed an object by hand, an object was deleted or added (a source or an Errors
application the files do not name included), or Better Stack paused an alert itself (it does so
when a query keeps failing). A dry run that is refused (two objects with one name, a loud object
outside the files, an `ai_sre` member) reports drift too. A silenced alert is as bad as a missing
one.

## First check

1. Run the dry run by hand and read the difference (it prints names and roles, never IDs or
   hostnames).
2. For a paused alert, its `paused_reason` (the dry run's note) and whether its query fails.

## Containment

1. Re-apply the files: `pnpm fin monitoring apply staging` (deletions over three need
   `--confirm-delete <count>`; heartbeats are paused, never deleted).
2. A query Better Stack keeps pausing: fix the query in a reviewed change.

## When to wake the owner

If a security alert (`tunnel-connectors`, `static-deployment-changed`,
`cloudflare-config-changed`) was paused or deleted outside a run. Other drift can wait.
