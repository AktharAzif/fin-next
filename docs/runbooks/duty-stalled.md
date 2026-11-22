# A duty stopped pinging its heartbeat

Heartbeats: `scheduler-worker`, `scheduler-payments`, `email-delivery-check`, `verify-daily`.
(`watcher` has `watcher-down.md`; `backup-nightly` and `backup-hourly` have `backup.md`.)

## What it means

A duty did not ping its heartbeat within its period and grace, or pinged its failure URL:

- `scheduler-worker`, `scheduler-payments`: no replica holds the scheduler lease, so no duty runs.
- `email-delivery-check`: the daily or per-release delivery check did not send (S0-09).
- `verify-daily`: the scheduled `pnpm fin verify staging` did not run or failed.

## First check

1. The duty's last `job.run` line (`result`, `skipReason`): `leased` means another replica holds
   it, `switch` a kill switch, `disabled` a setting.
2. The service's `no-logs` alert and Railway's deployment state.
3. For `verify-daily`: the scheduled job's last log.

## Containment

1. A stopped service: redeploy through `pnpm fin deploy staging`.
2. A lease stuck on a dead replica: the lease expires on its own; if not, end it through a
   registered task.
3. `verify-daily`: run `pnpm fin verify staging` by hand and fix what it reports.

## When to wake the owner

If a scheduler has been down for more than 15 minutes (nothing runs), or the delivery check fails
two days in a row.
