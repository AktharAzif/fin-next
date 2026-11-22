# Staff enrolment refused above its threshold

Alert: `staff-enrolment-refused` (notify only: `staff.enrolment_refused` on admin above
`@thresholds.staff-enrolment-refused` in 15 minutes).

## What it means

A pending member enrols their first factor with a one-time enrolment code an Admin issued (spec 02
§6.5, F-staff-add-and-enrol). Each refusal writes `staff.enrolment_refused` with the member's
`staffId` and a `reason`: `wrong`, `expired`, `used` or `void` for a code that does not open the
enrolment window, `no_window` for a factor added outside the window the code opened, and in
production `passkey_first` for a first factor that is not a passkey. Here there were more refusals
than the threshold allows in 15 minutes: someone may be guessing enrolment codes, or a member is
stuck. Nothing was enrolled by a refused attempt, and the line never carries the code.

## First check

Find who by IDs only.

1. The refusals by `staffId` and `reason`. Many `wrong` for one member is guessing, or a member
   typing an old code; `expired` or `used` is a code that needs issuing again; `no_window` is a
   member whose window closed before they finished.
2. The request lines on admin with the same `requestId`s: the `route`, the `cfRay` and the times.
   Zero Trust's Access authentication logs around those times name the identities Access let in to
   the staff host: is the one behind the refusals the member's own?
3. Whether the member is expecting to enrol now: ask them through a channel you already know is
   theirs.

## Containment

1. A stuck member: issue a new enrolment code from Fin Admin and give it to them by a channel you
   trust.
2. Guessing from an identity that is not the member's: void the member's code by issuing a new one,
   or remove the pending member, and remove the guessing identity's Access entry with
   `pnpm fin access apply staging` (see `access-apply.md`). Revoke its Access sessions in Zero
   Trust.
3. Guessing under the member's own Access identity: treat that Access identity as taken over.
   Remove the pending member and their Access entry until the owner has spoken to them.
4. Close it when the refusals stop; the incident recovers 15 minutes after the count drops below
   the threshold.

## When to wake the owner

At once for guessing from an identity that is not the member's. A stuck member can wait for
working hours.
