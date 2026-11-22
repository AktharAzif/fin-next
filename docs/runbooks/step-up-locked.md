# Sessions ended by wrong tries at a step-up above its threshold

Alert: `step-up-locked` (notify only: `step_up.locked` on console or admin above
`@thresholds.step-up-locked` in 15 minutes, per service).

## What it means

Credential, member, role and money actions take a fresh factor bound to the action: the step-up
(spec 02 §7, F4). Each wrong code or failed passkey at a step-up counts against the session, and
the fifth ends it (§7.7): the realm writes `step_up.locked` with the `realm` (`developer` on
console, `staff` on admin), records `step_up.locked` (or `staff.step_up_locked`) in the audit log
with the session and the person, and for a developer emails the person that they were signed out.
Their next request answers 401 with `reason: too_many_tries`. The line carries the realm only;
the audit event carries the IDs.

One lock is a person who mistyped five times. More than the threshold in 15 minutes means either:

- someone holding signed-in sessions (stolen cookies, or an unattended browser) is guessing factor
  codes to pass a step-up, and each lock ended the session they held; or
- a step-up ceremony is failing for everyone: a release that breaks the passkey or authenticator
  check, or a clock fault that refuses every authenticator code.

Nothing was done by a locked step-up: the action needed the proof and never ran.

## First check

Find who by IDs only.

1. The `service` and `realm` on the lines, and when the count began.
2. The audit events `step_up.locked` (developer) or `staff.step_up_locked` (staff) in the same
   window: the persons and sessions, and the `step_up.failed` or `staff.step_up_failed` before
   each, with their `method` (`totp`, `backup_code`, `passkey`) and `reason`.
3. Many persons at once, all with one method, just after a release or a factor change: a broken
   ceremony. Look at the `step_up.refused` lines and the release; for authenticator codes alone,
   a clock fault (`clock-skew.md`).
4. One or a few persons, from networks they do not usually use (the `request` lines with the same
   `requestId`s and their `cfRay`): someone guessing with their sessions.

## Containment

1. A broken ceremony: roll the release back, the pages first (`static-deploy.md`, "Roll back"),
   then the services (`railway-deploy.md`). People sign in again after it.
2. Guessing on developer sessions: the sessions are already ended. Tell each person, through a
   channel you already know is theirs, to sign in again, check their trusted browsers and sessions
   in Account security, and revoke what they do not know.
3. Guessing on a staff session: treat the member's session as stolen. With a member you trust,
   reset the member's factors from Fin Admin (their sessions end) and revoke their Access sessions
   in Zero Trust until you have spoken to them.
4. Close it when the locks stop; the incident recovers 15 minutes after the count drops below the
   threshold.

## When to wake the owner

At once for a lock on admin that the member cannot explain, or for guessing across many developer
sessions. A release that broke the ceremony can wait for the rollback, and one person's own
mistyping can wait for working hours.
