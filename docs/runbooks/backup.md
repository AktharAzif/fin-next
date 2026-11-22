# Backups are stale or failing

Alerts: `backup-stale` (the watcher's vault inventory finds the newest dump older than its period,
or far smaller than the last), and the `backup-nightly` and `backup-hourly` heartbeats.

## What it means

The backup service did not produce a good dump in its period. Point-in-time recovery still covers
the database, but the off-platform copy is behind.

## First check

1. The backup service's last `job.run` line (`result`, `durationMs`) and Railway's cron runs.
2. Its R2 writer token's expiry (the credential inventory) and the bucket's free space.

## Containment

1. A token problem: rotate the backups bucket's writer token (`rotate-r2`), then trigger the
   backup through a registered run.
2. A failing dump: run it once by hand through `pnpm fin task` and keep its output in the incident.

## When to wake the owner

If no good dump exists for more than a day, or a dump is far smaller than the last (possible data
loss upstream). A single late hourly dump can wait.
