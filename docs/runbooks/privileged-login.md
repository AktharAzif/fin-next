# A privileged database login outside a registered run

Alert: `privileged-login` (`database.privileged_login` unless `registered` is true).

## What it means

A superuser or `fin_owner` login happened with no registered `pnpm fin` run to explain it. Only
registered migrate and task runs use those roles; anything else may be a leaked credential. A line
without `registered` (the matcher could not decide, or its writer regressed) alerts too: an
unknown registration is treated as none.

## First check

1. The `role` on the line and the login's time; the registered runs in the ops bucket around it.
2. Railway's audit log: who opened variables or a shell on the Postgres service.

## Containment

1. Rotate the role's password through a registered task (`rotate-db-login`, or Railway's
   regenerate for the superuser).
2. Review `audit.event` and the guard's refusals for the window.
3. Consider the Railway variable leak playbook if variables may have been read.

## When to wake the owner

At once, always.
