# The watcher is not running

Alert: the `watcher` heartbeat is late or failed.

## What it means

Nothing is watching the front door: the watcher pings its heartbeat at the end of every minute's
run, and pings the failure URL when it could not ship its lines to Better Stack (so a run whose
failures nobody would see still raises this). Either its cron stopped, the Worker was deleted or
replaced, its Cloudflare read token expired or was revoked, or its Better Stack source token is
wrong.

## First check

1. Look for `watcher.run` lines in the `fin-next-staging-watcher` source. Lines present but the
   heartbeat late: the heartbeat URL secret is wrong. No lines: the Worker is not running or
   cannot ship.
2. In Cloudflare, check `fin-next-staging-watcher` still exists, has its `* * * * *` schedule, and
   that its recent invocations do not all fail.
3. Check the watcher's read-only token has not expired (the credential inventory).

## Containment

1. Redeploy it: `pnpm fin watcher deploy staging` (it re-uploads the script, its settings, its
   secrets and its schedule, and reads them back).
2. If the Worker was replaced by something else, treat the account as compromised: read
   Cloudflare's audit log, rotate the operator and static deploy tokens, and run `pnpm fin verify
   staging` by hand until the watcher is back.

## When to wake the owner

If the Worker was deleted or changed outside a registered run, at once. A late heartbeat during a
Cloudflare or Better Stack incident can wait for working hours, with `pnpm fin verify staging`
run by hand meanwhile.
