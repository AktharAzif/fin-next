# A Fin Admin member enrolled their first factor

Alert: `staff-enrolled` (notify only: any `staff.enrolled` on admin).

## What it means

A member added to Fin Admin is pending: they hold no permission until they enrol a first factor
(spec 02 §6.5, §10.3, F-staff-add-and-enrol). To enrol they redeem the one-time enrolment code an
Admin issued, which opens a short enrolment window on their session, and add a passkey or an
authenticator inside it. Here a member did: they are active now, their session is at `aal2`, and
from now on they hold their role's permissions. The `staff.factor_enrolled` audit event and the
notice to every active Admin were written in the same unit. The line carries the member's
`staffId` and the `method` (`passkey` or `totp`), never an address or a code.

## First check

Find who by IDs only.

1. The `staffId` against Fin Admin's staff list, and who added the member and when, from the
   staff audit events (`staff.member_added`, or `staff.factors_reset` for someone enrolling again).
2. Who issued the enrolment code and when (`staff.enrolment_code_issued`), and when it was redeemed
   (`staff.enrolment_code_redeemed`): the code goes to the member by a channel the issuing Admin
   chose, so a redemption long after the issue, or by a member nobody was expecting, is the thing
   to look at.
3. Whether the member expected to enrol now: ask them through a channel you already know is
   theirs.

## Containment

1. Expected: nothing to do.
2. Not expected: someone else may have used the code. With a member you trust, reset the member's
   factors from Fin Admin (their sessions end and the factor is gone), and issue a new code by a
   channel you trust; or remove the member if they should not be there. Revoke their Access
   sessions in Zero Trust.
3. Read what the session did after enrolling: the staff audit events with that `staffId` as
   actor, by time.
4. Close it when the enrolment is explained or undone. The incident closes within about three
   minutes of the last line, and a later enrolment opens a new incident with its own email, so an
   expected enrolment never hides an unexpected one: explain or undo each on its own.

## When to wake the owner

At once for an enrolment nobody expected, above all for an Admin. An expected one needs nothing.
