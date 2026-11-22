# Database grants differ from the matrix

Alert: `grants-drift` (`database.grants_drift`).

## What it means

The hourly drift check found a role whose live grants differ from the grant fragments in
`packages/db/roles/grants/` (`missing` or `extra` counts). An extra grant widens what a leaked
service login can do; a missing one breaks the service.

## First check

1. The `role` and counts on the line; the last migration's run registration.
2. `privileged-login` history for the hour before: grants change only as a privileged role.

## Containment

1. Re-apply the grants through the migration runner in a registered run.
2. If no run explains the change, treat the privileged credential as leaked (`privileged-login.md`).

## When to wake the owner

At once for extra grants with no registered run. A missing grant right after a migration can be
fixed by the next registered run.
