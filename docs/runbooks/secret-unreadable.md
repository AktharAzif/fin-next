# A stored secret no configured key opens

Alert: `secret-unreadable` (pages: any `auth.secret_unreadable` line, one incident per service).

## What it means

An authenticator key (`kind: totp`) or a set of backup codes (`kind: backup_codes`) is stored
encrypted under one of the versions in the service's `BETTER_AUTH_SECRETS`, and none of the
versions the service holds now opens it (spec 02 §18.1). A person's factor step with that
authenticator is refused (the realm answers 500 for the step); the console's viewer shows their
backup codes' count as unknown. The `realm` says which: `developer` on console, `staff` on admin.
Usually a rotation removed a version that secrets were still stored under, or a service was given
another environment's value.

## First check

1. The `service`, `realm`, `kind` and `release` on the lines, and when they began.
2. The versions `BETTER_AUTH_SECRETS` holds on that service, by version number only (never the
   values): did a change just drop the version before the newest? Compare with the run log of the
   run that set it (`pnpm fin log verify staging`).
3. Whether it is every person's factor step (a version gone) or one person's (one row written
   under a version that never existed here).

## Containment

1. A version dropped too early: put the earlier version back beside the newest, newest first,
   through the same registered pnpm fin path that set it (never by hand in Railway's console), and
   redeploy the service. Secrets written under it open again.
2. One row: the person resets that factor (Fin Admin's reset of a staff member's factors, or the
   person's own recovery), which stores the factor again under the newest version.
3. Close it when no new line comes; the incident recovers 15 minutes after the last one.

## When to wake the owner

At once: people cannot finish their second factor. Wake them too if the versions the service holds
are not the ones the last recorded run set.
