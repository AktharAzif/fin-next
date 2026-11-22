# A commit refused for a write without its audit event

Alert: `audit-guard` (pages: any `database.audit_guard` line, one incident per service).

## What it means

The database refused a commit with `FA010`: a transaction wrote to a critical table and carried
no audit row for it (spec 08 §3.14, NB-04). The unit of work (`packages/db`, and identity's own)
wrote `database.audit_guard` with the `table` only, rolled the action back and answered 500 with
the request ID. Nothing was changed, so nothing is unaudited; but an action that should work does
not, and the code that wrote to the table has lost its audit event. It must never happen in
working code: every important action records its event in the same transaction.

## First check

1. The `service`, `table` and `release` on the line, and when the lines began.
2. The `request` line with the same `requestId` (its `route`) or the `job.run` line with the same
   `runId`: which route or duty wrote to the table.
3. Did a release go out just before? A route or duty that changed in it, or a new write to that
   table, is the usual cause. `audit-not-written` open at the same time points at the audit
   writer instead (its own runbook, `audit-not-written.md`).

## Containment

1. A release that brought it: roll the service back (`railway-deploy.md`); the action works again
   on the earlier release, which recorded its event.
2. Then fix the code in a reviewed change: the write and its audit event in one transaction, with
   the test that fails when the event is missing. Never relax the guard or the table's trigger to
   quiet the alert.
3. Close it when no new line comes; the incident recovers 15 minutes after the last one.

## When to wake the owner

At once if it continues after the rollback, if the table is a money, credential or member table,
or if `table` names one no release changed (the guard or the table changed outside the code).
