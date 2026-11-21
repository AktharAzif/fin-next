# An action refused because its audit event could not be written

Alert: `audit-not-written` (any `audit.write_failed`).

## What it means

Every important action writes its audit event in its own transaction (spec 08 §3.3). Here the
event was refused, so the transaction rolled back and the action failed with a 500 that carries
only the request ID: nothing changed, and nothing is missing from the trail, but the person, key,
job or operator that tried it was refused, and every later try fails the same way until the cause
is fixed. The line names the refused event (`auditEvent`) and the reason (`sqlstate`), never the
action's values. Most often a release broke an event:

- `FA001`: the event is unknown or retired in `audit.event_type` (the registry was not synced
  after the release, or a retired name is still written).
- `FA002`: the event's fragment does not list this service's login in `roles`.
- `FA003`: an organisation or person event without its organisation or subject.
- `FA004`: the metadata's shape (not flat, a bad key, a string over 200 characters, over 4 KB).
- `FA005`, `FA006`: the refs, the event ID or another input's shape.
- `FA007`, `FA009`: the journal entry the event declares (spec 08 §3.10).
- `FA011`: no current audit epoch (a fresh or reset database that no `audit-start-epoch` task
  started).
- `input`, `unknown`: identity's recorder refused the input before any SQL, or the database
  failed with a code outside the `FA` class.

A commit the guard refused (`FA010`) is `database.audit_guard`, not this alert.

## First check

Find the refused action by IDs only, never by a name, an address or the action's values.

1. The `service`, `release`, `auditEvent` and `sqlstate` on the line, and its `requestId` (an
   API action) or `runId` (a `migrate --task` run).
2. The `request` line with the same `requestId`: its `route`, `actor` and the `orgId`, `userId`,
   `staffId` or `keyId` it names. For a task, the run registration with that `runId` and the
   `task.failed` line beside it.
3. Whether `release` is new: did it change the event's fragment, its `roles` or its metadata
   schema, and did migrate sync the registry after it (`migrate.done` for the release)?
4. Whether one service and one `auditEvent` refuse, or many: one is a bug in that caller; many
   at once is the registry or the epoch.

## Containment

The refused action changed nothing, so there is nothing to undo: the work is to stop the refusals.

1. A release that broke an event (`FA001`, `FA002`, `FA004`, a journal code): roll the service back
   with `pnpm fin deploy` to the last release that recorded the event, then fix the fragment or
   the caller in a reviewed change. Never widen `roles` or loosen a schema by hand in the
   database: `audit.event_type` is migrate's sync.
2. A registry that was not synced, or no epoch (`FA001` right after a deploy, `FA011`): run the
   registered `migrate --migrate` step or `audit-start-epoch` task the deploy missed.
3. `FA002` for an event no fragment ever gives that service (a console login recording a money
   event): not a bug. Treat the service's process or its database login as compromised, review
   `privileged-login` history, and rotate the login (`privileged-login.md`).
4. Close it when the same `route` or task, tried again on the fixed release, writes its event and
   no new `audit.write_failed` comes from that `release`; the alert recovers 15 minutes after the
   last line. Tell whoever was refused (by the IDs found above) to try again.

## When to wake the owner

At once for `FA002` on an event no fragment gives the service, or for any refusal no new release
explains. A refusal a release caused can wait for the rollback, unless it blocks sign-in, a
factor, a credential or a member change for more than 15 minutes.
