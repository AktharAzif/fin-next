# A Fin Admin member was added, changed, removed or reset

Alert: `staff-changed` (notify only: any `staff.changed` on admin).

## What it means

Every change to Fin Admin's people is noticed out of band (spec 02 §10.2, F-staff-add-and-enrol):
a member added (`kind` `added`, a pending member with an enrolment code), their role changed
(`role_changed`, their sessions end), removed (`removed`, their sessions end), or their factors
reset (`reset`, they enrol again with a new code). Each change took a step-up intent bound to it,
and wrote its staff audit event and the notice to every Admin in the same unit of work. The line
carries the `kind`, the member's `staffId` and the acting member's `actorId`, never an address.

Most changes are expected; this alert makes sure everyone who should know does. The operator's
bootstrap of the first Admin (the `staff-bootstrap` task that `migrate --task` runs) writes its
own audit event, `staff.bootstrapped`, not this line.

## First check

Find who and why by IDs only.

1. The staff audit events: the one for the change (`staff.member_added`,
   `staff.role_changed`, `staff.member_removed` or `staff.factors_reset`), its actor, its target,
   and the step-up intent it carried.
2. The `actorId` against the staff list: is the acting member active, and does their role hold the
   permission the change needs?
3. Whether it was planned: someone joining or leaving, a role agreed, a lost device. Ask the acting
   member through a channel you already know is theirs, not one the change could have touched.
4. For an addition, the Access list: the order is the Access list first and Fin Admin second, so
   the new member's address should already be there (`access-apply.md`).

## Containment

1. Expected: nothing to undo. For a removal, finish the second act: remove the address from the
   overlay's `access.staff`, run `pnpm fin access apply staging`, then revoke their Access sessions
   in Zero Trust.
2. Not expected: treat the acting member's account as possibly taken over. With a member you trust,
   undo the change from Fin Admin (each undo takes its own step-up intent), then reset the acting
   member's factors or remove them, and remove their Access entry if the account is not theirs to
   use.
3. A role raised to Admin that nobody agreed: lower it first, then find out how it was raised.
4. Close it when the change is explained or undone. The incident closes within about three minutes
   of the last change of its kind, and every later change opens a new incident with its own email,
   one series per kind (`added`, `role_changed`, `removed`, `reset`, and `other` for any other
   value), so an expected change never hides the next one: explain or undo each on its own.

## When to wake the owner

At once for a change nobody can explain, above all a new Admin or a removed one. An explained
change can wait for the next review.
