# The console's team or role routes are failing

Alert: `team-change-failing` (notify only: any `request` line on console with `statusClass` 5xx on
a team or role route).

## What it means

An organisation's members, invitations and roles are read and changed through the console's team
and role routes (spec 02 §14.2, F4): `/api/team`, `/api/team/members/...`,
`/api/team/invitations/...`, `/api/roles` and `/api/roles/...`. Here one of them answered with a
server error: a member could not be listed, invited, given a role or removed, or a role could not
be read, made, changed or deleted. Each change runs its guard, its action, its audit event and any
email in one unit of work, so a 5xx left no half-done change: the unit rolled back.

The rule matches the routes by their templates, the same list as the console's route policy, so a
new team or role route is added to the rule in the same change.

## First check

1. The last deploy: did the errors begin with a release of the console's API half?
2. The `request` lines: the `route`, the `status` (500 is an unexpected error, 503 a dependency
   that is down), the `reason` and the `errorId`.
3. The console's Errors application for those `errorId`s.
4. A 503: whether `database-unreachable` or `pool-exhausted` is open, or a `limits.store_failed`
   line has the same `requestId` (the limiter fails closed).
5. An `audit.write_failed` line with the same `requestId`: the action was refused because its
   audit event could not be written (`audit-not-written.md`).

## Containment

1. A release regression: roll back (`railway-deploy.md`; the pages too if they changed with it,
   `static-deploy.md`).
2. A dependency outage: follow that alert's runbook; the routes recover with it.
3. Close it when the errors stop; the incident recovers 15 minutes after the last 5xx.

## When to wake the owner

If the errors go on for more than 15 minutes, or a rollback does not clear them: people cannot
manage their team. A short burst that clears can wait for working hours.
