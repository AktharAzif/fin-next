# A Fin Admin session came under someone else's Access identity

Alert: `admin-access-mismatch` (pages: any `staff.access_mismatch` on admin).

## What it means

Every Fin Admin request carries two proofs of who is asking (spec 02 §10.5, F6): the Access token,
checked on every request, and the staff session. They must be the same person: the session's
Access `sub` must equal the verified token's, and the member's address must equal the token's.
Here they were not, so the session was ended, the request was refused with
`403 access_mismatch`, and (at sign-in) a `staff.sign_in_failed` audit event was written. The
line's `staffId` is the session's member.

It is written by identity's staff realm (at sign-in, and when a session is read), by the staff
guard and by the viewer. A passkey sign-in to a removed member's account writes it too. Two staff
members sharing one browser, or someone holding another member's session cookie behind their own
Access sign-in, look the same from here.

## First check

Find who by IDs only.

1. The `staffId` on the line: that member's status and factors on Fin Admin's staff list, and
   their recent `staff.signed_in` and `staff.sign_in_failed` audit events.
2. The request lines on admin with the same `requestId`: the `route`, the `cfRay`, and the time.
   Zero Trust's Access authentication logs around that time name the identities Access let in to
   the staff host.
3. Whether that identity is another member's: two members on one machine is a habit to correct; an
   identity that is no member's is `admin-staff-refused` as well.
4. How many: one line after a member signed in as someone else in the same browser is benign;
   repeated lines for one `staffId` from identities that are not theirs is a stolen session.

## Containment

1. Explained (two members on one browser): nothing more to undo; the session is already ended. Ask
   the members to keep separate browser profiles.
2. Not explained: treat the member's session as stolen. From Fin Admin, with a member you trust,
   reset the member's factors (their sessions end), and revoke the member's Access sessions in
   Zero Trust. If the other identity is not staff, remove its Access entry with
   `pnpm fin access apply staging` (see `access-apply.md`).
3. Check what the member's session did before it was ended: the staff audit events with that
   `staffId` as actor, by time.
4. Close it when no new line comes. The incident closes within about three minutes of the last
   line, and a later line opens a new incident with its own email, so an explained mismatch never
   hides a later one: work through each incident on its own.

## When to wake the owner

At once for a mismatch nobody can explain. One line two members explain can wait for working
hours.
