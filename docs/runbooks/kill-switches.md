# A kill switch was set or cleared by a person

Alert: `switch-changed` (notify only: any `switch.set` or `switch.cleared` on admin).

## What it means

A kill switch stops one kind of work at once, without a deploy (ARCHITECTURE §15.1, F23): live
money, live keys, sign-ups, hosted verify, outbound webhooks or Sumsub writes. Here a person moved
one from Fin Admin's switches route (spec 02 §14.3): a member holding `switches.manage` confirmed a
step-up intent bound to the switch, the new state and a preset reason, and `ops.set_switch()` set
it (`switch.set`, the work stops) or cleared it (`switch.cleared`, the work starts again). The
audit event, a revocation-journal entry when set, and the `staff-switch-changed` notice to every
Admin were written in the same unit. The line carries the `switch`, the `reasonCode` and the
`staffId`, never typed text.

A switch set is expected during an incident; this alert makes sure everyone who should know does.
A switch that an alert trips by itself is `switch.tripped` (`ops.trip_switch()`), not this alert.

## First check

Find who and why by IDs only.

1. The staff audit log in Fin Admin: the `switch.set` or `switch.cleared` event, its actor, the
   switch as its target, the `reasonCode`, and the step-up intent it carried.
2. The line's `staffId` against the staff list: is the member active, and did they hold
   `switches.manage` through their role?
3. Is there an open incident or a planned change that explains it? Ask the member through a
   channel you already know is theirs, not one the change could have touched.
4. Whether the switch now refuses what it names: `switch.refused` lines and the `request` lines
   for the work it stops.

## Containment

1. Explained by an incident or a planned change: nothing to undo. Leave the switch as the incident
   needs it and record the change in the incident's notes.
2. Not explained: treat the member's account as possibly taken over. Set the switch back from Fin
   Admin with a member you trust (it takes its own step-up intent), then, from Fin Admin's staff
   screen, reset the member's factors or remove them, and remove their Access entry
   (`pnpm fin access revoke`) if the account is not theirs to use.
3. A switch cleared during an incident it was meant to contain: set it again first, then find out
   why it was cleared.
4. Close it when the switch is where it should be and the reason is recorded; the incident recovers
   15 minutes after the last change.

## When to wake the owner

At once for a change nobody can explain, or for a live money or live keys switch moved outside an
incident. An explained change during working hours can wait for the next review.
