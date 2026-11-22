# A write to a critical table without its audit event

Alert: `audit-guard` (any `database.audit_guard`), one incident per service.

## What it means

Every critical table (the sign-in, session, factor, staff, organisation and kill switch tables, and
the area tables that join later) carries the audit guard: a deferred constraint trigger that, at
commit, looks for the audit event the change must record in the same transaction (spec 08 §3.5).
Here a commit came without it. Postgres refused the commit with `FA010`, naming the table only, so
nothing was written: the whole transaction rolled back and the action failed with a 500 that
carries only the request ID. Fin's unit of work caught the refusal and wrote
`database.audit_guard` with the `table` and nothing else, never a value of the row.

Two writers in this tree write the line: identity's unit of work (`packages/identity`, on console
and admin, for every sign-in, factor, staff and organisation change), and `packages/db`'s (the
operator tasks `migrate --task` runs). The other services read by the rule write it once their own
units of work commit to a guarded table.

It means one of two things:

- a bug: a release added or changed a path that writes a guarded table without recording its event
  (a new route, a library path whose event is recorded elsewhere, a task with `recordsItself` that
  does not), so every try of that action now fails;
- a compromised process: something running inside a Fin service wrote the table through Fin's own
  database code without the event. A leaked login used directly from outside Fin is refused the
  same way, but that refusal is in Postgres's own log only (spec 08 TM-L10), not in this line.

An incident is per service. While one is open, a later refusal from the same service on another
table joins it and sends no email, so read every line of an open incident, not only the first.

## First check

Find the refused action by IDs only, never by a value of the row.

1. The `table`, `service` and `release` on each line, and its `requestId` (an API action) or
   `runId` (a `migrate --task` run).
2. The `request` line with the same `requestId`: its `route`, `actor` and the `orgId`, `userId`
   or `staffId` it names. For a library path (`route` `/api/auth/*`), the `authPath` on the
   request line tells which step. For a task, its run registration and the `task.failed` line with
   the same `runId`.
3. Whether `release` is new, and whether it changed that route, step or task, or the table's guard
   registration (`packages/<area>/src/guards.ts`, `packages/db/src/guards/`) and its migration.
4. `privileged-login` lines in the same minutes, and Postgres's own log for `FA010` refusals no
   Fin line explains: those are a login used directly.
5. Whether the table is one this service ever writes: a staff table refused on console, or an
   identity table on a service that has no realm, is never a bug in a route.

## Containment

The refused action changed nothing, so there is nothing to undo: the work is to stop the
refusals.

1. A release that broke the path: roll the service back with `pnpm fin deploy` to the last release
   that recorded the event, then make the path record its event in the same transaction, in a
   reviewed change with a test that fails without the event.
2. Never drop, disable or defer around the guard to get the action through, and never write the
   missing event by hand: the guard is the database's record that no critical change skips the
   trail.
3. No release explains it, the table is one the service never writes, or `privileged-login` fired
   too: treat the service's process and its database login as compromised. Rotate the login
   through a registered task and review the window as `privileged-login.md` says, and consider the
   Railway variable leak playbook.
4. Close it when the action, tried again on the fixed release, commits with its event and no new
   `database.audit_guard` comes from that service; the incident recovers 15 minutes after the last
   line. Tell whoever was refused (by the IDs found above) to try again.

## When to wake the owner

At once for any refusal no new release explains, for a table the service never writes, or when
`privileged-login` fired in the same minutes. A refusal a release caused can wait for the
rollback, unless it blocks sign-in, a factor, a credential or a member change for more than 15
minutes.
