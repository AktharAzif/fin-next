# A stored secret no configured secret version opens

Alert: `secret-unreadable` (pages: any `auth.secret_unreadable` on console or admin), one incident
per service.

## What it means

Each realm encrypts the secrets it stores, an authenticator app's secret and a person's backup
codes, under its `BETTER_AUTH_SECRETS` (spec 02 §3.2): a list of versions, newest first, where the
newest encrypts and the older ones only decrypt. Console's developer realm and admin's staff realm
each hold their own list. Here a stored secret was opened with every configured version and none
worked. The line carries the `realm` and the `kind`, never the secret or whose it is:

- `kind: totp`: identity's authenticator code check (the before-hook, on console and admin) could
  not read the person's authenticator secret. The request was refused with a 500 whose request line
  has `reason: auth.secret_unreadable`: that person cannot finish a sign-in or a step-up with their
  authenticator until it is fixed, and every try writes another line.
- `kind: backup_codes`: console's viewer could not read a person's backup codes to count them. The
  viewer still answers, without the count, but a backup code that person types will fail the same
  way.

It almost always means a version was taken out of `BETTER_AUTH_SECRETS` while secrets it encrypted
are still stored (spec 08 §6.4 retires an old version only after the re-encrypt task has moved
everything off it, and that task is not built yet), or a service was given another realm's list
or a list typed wrongly. A stored value that was changed in the database reads the same way, so
one line for one person, with the configuration unchanged, is a possible tamper.

## First check

Find the requests by IDs only; no line carries the secret, the code or the person's address.

1. The `service`, `realm`, `kind` and `release` on each line, and when they began: with a deploy,
   or with a change to the service's sealed variables (the run log of the `pnpm fin` run that
   changed them, `pnpm-fin.md`).
2. The versions in the service's `BETTER_AUTH_SECRETS` against the last rotation's record: their
   number and order only, never a value. A version missing that the previous deploy had is the
   cause.
3. How many people: the request lines with the same `requestId`s name the `userId` or `staffId`.
   Many people at once is the configuration; one person, again and again, with no change to the
   configuration, is that person's stored value.
4. For a single person on admin, that member's recent factor audit events (`staff.factor_added`,
   `staff.factors_reset`) and `privileged-login` lines in the same hours.

## Containment

1. A version removed too soon: give the service the removed version back, after the newest (it
   then only decrypts), and deploy the service with `pnpm fin` (`railway-deploy.md`), never by hand
   in Railway's console. Keep it until the re-encrypt task has moved every stored secret off it.
   Never put an old version first: the newest must stay the one that encrypts.
2. The wrong list on a service (console's on admin, or the reverse): restore the service's own
   list the same way, then check the other service.
3. One person's value with the configuration unchanged: treat the row as changed outside the
   code. Do not delete or rewrite it by hand; have the person sign in with another factor or go
   through account recovery (a staff member's factors are reset by an Admin in Fin Admin), and wake
   the owner to review database access for the window (`privileged-login.md`).
4. Close it when no new `auth.secret_unreadable` comes and an authenticator sign-in on that realm
   works; the incident recovers 15 minutes after the last line.

## When to wake the owner

At once: people cannot finish a sign-in or a step-up with their authenticator, and the fix is a
change to a sealed secret. Wake them before any change to `BETTER_AUTH_SECRETS`, and at once for a
single person's value that no configuration change explains.
