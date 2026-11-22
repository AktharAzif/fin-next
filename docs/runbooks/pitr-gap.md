# WAL archiving stalled: a point-in-time recovery gap

Alert: `wal-archiving-stalled`.

## What it means

The database probe (`job.run` with `job=db-probe`) reports no WAL archived for longer than the
threshold (`archiverLagS`), or archive failures rising. pgBackRest drops WAL rather than halting,
so recovery to a point inside the gap would be impossible.

## First check

1. The probe's `archiverFailed` count and Railway's PITR status for the Postgres service.
2. Railway's status page for storage incidents.

## Containment

1. Take a manual base backup at once through a registered task, so recovery has a new starting
   point after the gap.
2. Record the gap's start and end in the incident and the ops bucket.

## When to wake the owner

At once if the gap passes an hour, or archiving does not resume after the base backup.
