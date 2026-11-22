# A security notice could not be sent

Alert: `security-email-unsent` (any `email.security_unsent`, one incident per `reason`).

## What it means

A security notice tells a person that their access changed: a sign-in method, a factor, a key, a
team or role, a money recipient (spec 08 §4.1). Notices are never dropped: past a recipient's
allowance they fold into a digest that is still sent. This line says one could not be sent, or
not queued, so a person may not know about a change to their account; if the change was not
theirs, nothing else has told them. The line names the `template`, the outbox row (`emailId`),
the provider's `code` and the `reason`, never the address or a parameter:

- `suppressed`: the address is on the sending domain's suppression list (an earlier hard bounce or
  complaint). The row has ended (`final: true`).
- `invalid_recipient`: the address bounced (`code` `bounced`), or the person or member the row
  names no longer resolves to an address (`unresolvable`). The row has ended.
- `failed`: with `final: false`, the row has failed its fifth attempt and keeps trying (a security
  row never ends on a failure that can be retried); with `final: true`, it ended on a refusal that
  is never retried, or on a template no running release could render within 7 days. The `code`
  says which.
- `budget`: the daily budgets refused it (spec 08 §4.3): the environment's share for security
  notices, or the organisation's own ceiling for them. The row waits for the next UTC day
  (`final: false`) and is sent then.
- `not_allowed`, `enqueue_failed` (written by console or admin, with no `emailId`): the notice could
  not be queued, so the action that needed it rolled back and was refused. Nobody's access changed;
  the caller got an error.

A waiting row writes the line once, and once more if it then ends.

## First check

Find the notice and the change behind it by IDs only, never by an address or a name.

1. The `reason`, `code`, `template`, `final` and `service` on the line, and its `emailId` (or, for
   a queue-time line, its `requestId`).
2. `failed`: the `email.send_failed` lines for the same `emailId`, one per attempt with its `code`.
   If `email-not-sent` is open too, mail is failing for everyone: work `email.md` first.
3. `budget`: the day's `email.budget_reached` lines (`email-budget-reached`): which `scope` and
   `share` refused, and the `orgId` when one organisation reached its ceiling.
4. `not_allowed`, `enqueue_failed`: the `request` line with the same `requestId` (its `route`,
   `actor` and IDs) and the `release`. `not_allowed` means the service's role may not send that
   template; `enqueue_failed` means the database refused the write.
5. The change itself. The template names the action (`orgs/member-role-changed` is a role change,
   `identity/sign-in-methods-changed` a sign-in method). While the row waits (`final: false`) its
   `params` hold the IDs of the organisation, person or key: read them in a registered read-only
   session (ARCHITECTURE F18), never the `recipient` column. Once the row has ended it is deleted:
   find the action's audit event of that kind just before the line, by the organisation or person
   in its refs.
6. Whether that change was expected: the audit event's actor, and the session or key that made it.

## Containment

1. A change the person did not make (an unknown session, device or key): treat it as a takeover
   and act on the change before the email: end the person's sessions, revoke the key or factor, or
   undo the role change, as that area's runbook says.
2. `suppressed` or `invalid_recipient` on an expected change: nothing more goes to that address.
   Never lift a suppression or resend by hand to push a notice through; the person's activity page
   still shows the change, and the person corrects their own address.
3. `failed`: fix what the `code` names (the token: `rotate-email-token.md`; Cloudflare or the
   sender: `email.md`). A waiting row is sent by itself once the sender recovers; nothing is
   resent by hand.
4. `budget`: a flood of other mail used the share. Stop it as `email.md` says for
   `email-budget-reached`; the row is sent at the next UTC day. Never raise a budget outside a
   reviewed change: the budgets are the sender's limits in `packages/email`.
5. `not_allowed` after a release: roll the service back with `pnpm fin deploy` and fix the
   template's grant in a reviewed change. `enqueue_failed`: the database (`database.md`).
6. Close it when the cause is fixed and no new line comes for that `reason`; the incident recovers
   15 minutes after the last line. A `failed` or `budget` row that still waits is closed only once
   `email.sent` is seen for its `emailId`.

## When to wake the owner

At once if the change behind the notice was not expected, or if `failed` or `budget` hold notices
back for more than an hour. A single `suppressed` or `invalid_recipient` notice on an expected
change can wait for working hours.
