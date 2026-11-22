# An action refused because its audit event could not be written

Alert: `audit-not-written` (any `audit.write_failed`), one incident per service, SQLSTATE and audit
event.

## What it means

Every important action writes its audit event in its own transaction (spec 08 §3.3). Here the
event was refused, so the transaction rolled back and the action failed with a 500 that carries
only the request ID: nothing changed, and nothing is missing from the trail, but the person, key,
job or operator that tried it was refused, and every later try fails the same way until the cause
is fixed. The line names the reason (`sqlstate`), never the action's values. Two kinds of writer
write it, and each names the refused event in `auditEvent`: packages/audit's `recordAudit` (the
api tasks), and each area's own recorder (`packages/<area>/src/audit/record.ts`, such as
identity's for the sign-in, session, factor and staff enrolment events). A line without
`auditEvent` lost the event's name (one passed as `event` is dropped, since the envelope keeps
`event` as the line's own name): it carries `sqlstate` only, and the refused action is found from
the request (First check, step 2). Most often a release broke an event:

- `FA001`: the event is unknown or retired in `audit.event_type` (the registry was not synced
  after the release, or a retired name is still written).
- `FA002`: the event's fragment does not list this service's login in `roles`.
- `FA003`: an organisation or person event without its organisation or subject.
- `FA004`: the metadata's shape (not flat, a bad key, a string over 200 characters, over 4 KB).
- `FA005`, `FA006`: the refs, the event ID or another input's shape.
- `FA007`, `FA009`: the journal entry the event declares (spec 08 §3.10).
- `FA011`: no current epoch in `audit.head`. No migration, release or task causes it: the schema
  starts with epoch 1, and `audit.start_epoch()` ends an epoch only by starting the next in the
  same transaction. Only a `fin_owner` or superuser change to `audit.head` outside the audit
  functions leaves none, so it is a possible tamper with the chain's head (Containment, step 3),
  never a missed deploy step.
- `input`, `unknown` or a code outside the `FA` class (such as `42501`): only the area recorders
  write these. `input` is a recorder's own check refusing the event before any SQL; any other
  database refusal comes as its SQLSTATE, and `unknown` is an error that carried none (a lost
  connection, no ID returned). The area recorders write `FA` codes too. packages/audit writes `FA`
  codes only; its input refusals and other database errors write no `audit.write_failed`.

A commit the guard refused (`FA010`) is `database.audit_guard`, not this alert.

An incident is per service, SQLSTATE and audit event: its series is
`<service>/<sqlstate>/<auditEvent>`. A refusal that stands never hides a later, different one, so
an `FA011`, or an `FA002` on another event, opens its own incident and sends its own email while an
`FA004` stands on the same service. Each label is held to a closed set: the services the alert
reads, a five-character SQLSTATE (`FA004`, `42501`), and the audit events the code defines (the
events in packages/audit's `AUDIT_EVENTS` and those each area's own recorder writes). Any other
value, or none, is the one label `other`: a line without `auditEvent`, an `auditEvent` the code
does not define, and the area recorders' `input` and `unknown`. So no line can choose a label or
add one, and every line still opens or joins an incident; none is dropped. Read the value an
`other` stands for from the line itself. Lines that share an `other` label share an incident:
while one stands, a later refusal with the same service and SQLSTATE whose event is `other` too
joins it and sends no email, a foreign-event `FA002` among them. So while an `other` incident is
open, read each of its lines (First check, step 2), not only the incident, and treat any
foreign-event `FA002` among them as the email it did not send.

## First check

Find the refused action by IDs only, never by a name, an address or the action's values.

1. The `service`, `release` and `sqlstate` on the line, its `auditEvent` when it has one, and its
   `requestId` (an API action) or `runId` (a `migrate --task` run).
2. The `request` line with the same `requestId`: its `route`, `actor` and the `orgId`, `userId`,
   `staffId` or `keyId` it names. On a line without `auditEvent`, the action is what tells the
   refused event: for Fin's own routes the `route` names it; for a library path (`route` is
   `/api/auth/*`, or the line has no `route`) it is the `authPath` on the `auth.unhandled_error`
   line with the same `requestId`. For a task, the run registration with that `runId` and the
   `task.failed` line beside it.
3. Whether `release` is new: did it change the event's fragment, its `roles` or its metadata
   schema, and did migrate sync the registry after it (`migrate.done` for the release)?
4. Whether one service and one event (its `auditEvent`; without one, the `route`, or the
   `authPath` for a library path) refuse, or many (each its own incident, or the lines of one
   `other` incident): one is a bug in that caller; many at once is the registry. `FA011` is never
   routine: go to Containment, step 3.

## Containment

The refused action changed nothing, so there is nothing to undo: the work is to stop the refusals.

1. A release that broke an event (`FA001`, `FA002`, `FA004`, a journal code): roll the service back
   with `pnpm fin deploy` to the last release that recorded the event, then fix the fragment or
   the caller in a reviewed change. Never widen `roles` or loosen a schema by hand in the
   database: `audit.event_type` is migrate's sync.
2. A registry that was not synced (`FA001` right after a deploy): run the registered
   `migrate --migrate` step the deploy missed.
3. `FA011`, no current epoch: treat it as a change to `audit.head` made outside the code, as spec
   08 treats an epoch or head anomaly (`audit-epoch-unexpected`, `audit-head-moved-back`). Wake
   the owner at once. Review `privileged-login` history for `fin_owner` and superuser logins
   (`privileged-login.md`), compare `audit.head` with the ops bucket's restore, reset and
   failover markers and with who ran `audit-start-epoch`, and follow `audit-chain-broken.md` when
   it lands. Never start an epoch or set a head current by hand to clear it: `audit.start_epoch()`
   refuses with `FA011` itself, and a head made by hand hides what changed.
4. `FA002` for an event no fragment ever gives that service (a console login recording a money
   event): not a bug. Treat the service's process or its database login as compromised, review
   `privileged-login` history, and rotate the login (`privileged-login.md`).
5. Close it when the same action (its `route` or `authPath`) or task, tried again on the fixed
   release, writes its event and no new `audit.write_failed` comes from that `release` (for
   `FA011`, only once the owner has said how the head is restored); each incident recovers 15
   minutes after the last line of its service, SQLSTATE and event. Tell whoever was refused (by
   the IDs found above) to try again.

## When to wake the owner

At once for `FA011`, for `FA002` on an event no fragment gives the service, or for any refusal no
new release explains. Each opens its own incident and email even while another refusal stands on
the same service, unless it shares an `other` label with it (What it means). A refusal a release
caused can wait for the rollback, unless it blocks sign-in, a factor, a credential or a member
change for more than 15 minutes.
