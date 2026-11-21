# Email is failing, late or misconfigured

Alerts: `email-not-sent`, `email-outbox-age`, `email-setting-changed`.

## What it means

- `email-not-sent`: the worker's sender wrote `email.send_failed`; the `code` and `class` say
  which step failed and whether a sign-in code or security notice was affected.
- `email-outbox-age`: the oldest due row has waited past its threshold: the sender is behind or
  stopped (its loop's `job.run` lines with `job=email-send`).
- `email-setting-changed`: the watcher's `email` check found a sending domain with preview or
  drop-suppressed turned on, a sending domain gone, or one of fin-next's own DMARC records,
  `_dmarc.auth.<zone>` or `_dmarc.notify.<zone>` (target `_dmarc.auth` or `_dmarc.notify`),
  missing (`dmarc_missing`), doubled (`dmarc_duplicate`, which receivers treat as no record),
  not DMARC (`dmarc_invalid`), or weaker than `p=reject` (`dmarc_weak`: a lower `p` or `sp`, or a
  `pct` under 100). The zone's apex `_dmarc` is the old product's and is never read.

## First check

1. Cloudflare's status page, and the Email Sending token's expiry and IP filter (the credential
   inventory). A `401` or `403` code means the token.
2. The worker's lease and its last `job.run` line for the email loop.
3. For a setting change: `pnpm fin email verify staging` and Cloudflare's audit log.

## Containment

1. A token problem: rotate it (`rotate-email-token`): `pnpm fin email token staging`, then deploy
   worker.
2. A setting change: restore it with `pnpm fin email domains staging` and read it back; never
   remove a sending domain without restoring DMARC. A weakened or missing DMARC record lets
   anyone send as `auth.` or `notify.`: restore it at `p=reject` (BD-17) first, then look for
   mail sent in the window.
3. A stopped loop: restart worker through `pnpm fin deploy` (never by hand in Railway).

## When to wake the owner

At once if sign-in codes or security notices are failing (`class` `code` or `security`) for more
than 15 minutes, or a setting changed outside a registered run. Ordinary mail delays can wait.
