# Email is failing, late, stalled, over budget or misconfigured

Alerts: `email-not-sent`, `email-outbox-age`, `email-setting-changed`, `email-budget-reached`,
`email-delivery-stalled`.

## What it means

- `email-not-sent`: the worker's sender wrote `email.send_failed`; the `code` and `class` say
  which step failed and whether a sign-in code or security notice was affected.
- `email-outbox-age`: the oldest due row has waited past its threshold: the sender is behind or
  stopped (its loop's `job.run` lines with `job=email-send`).
- `email-setting-changed`: the watcher's `email` check found a sending domain with preview or
  drop-suppressed turned on, a sending domain gone, or one of fin-next's own DMARC records,
  `_dmarc.auth.<zone>` or `_dmarc.notify.<zone>` (target `_dmarc.auth` or `_dmarc.notify`),
  missing (`dmarc_missing`), doubled (`dmarc_duplicate`: any second TXT record at the name, since
  receivers differ on which records they read as DMARC and one that reads two applies no policy;
  the valid record beside it is still judged), not a valid DMARC record (`dmarc_invalid`: not
  DMARC at all, a tag repeated, `p` not the tag right after `v=DMARC1`, a tag that is not
  `name=value`, or a character other than printable ASCII, space or tab, such as a no-break space
  or a byte-order mark; receivers may then discard it or read a weaker `p` than the watcher
  would), or weaker than `p=reject` (`dmarc_weak`: a lower or missing `p`, a lower `sp` or `np`, a
  `pct` under 100, or a `t` other than `n`, under which receivers apply `p=reject` as
  quarantine). The zone's apex `_dmarc` is the old product's and is never read.
- `email-budget-reached` (notify only, one incident per `scope` and `share`): the sender wrote
  `email.budget_reached`. Either ordinary mail has used its part of the environment's daily budget
  and the first send went into the share kept for codes and security notices (`share: security`,
  the early warning, at three quarters of the budget with the default limits), or a daily budget
  refused a send (spec 08 §4.3; ARCHITECTURE §9.5): the environment's (`scope: environment`, with
  the `share` that refused: `ordinary`, `all`, `code_only`, `security_only`, `account_only`) or one
  organisation's ceiling (`scope: organisation`, `share: all`, with its `orgId`, [SA-40]). A refused
  row waits for the next UTC day, but a code ends and a security notice also pages as
  `security-email-unsent`.
- `email-delivery-stalled` (notify only, one incident per `reason`): worker wrote
  `email.delivery_stalled`. A database step of the email delivery path did not get what it waited
  for: `reason: lock_timeout` is a lock wait that ran out (SQLSTATE 55P03, after the worker
  login's lock timeout, or the delivery check's own), `reason: connect_timeout` a connection the
  worker's pool could not open or hand out in time. The `step` says where: the sender's `claim`
  (taking due rows), `row` (one claimed row, with its `emailId`), `digest`, `age` or `sweep`, or
  the delivery check's `check` (its run) or `check_state` (its record in `ops.duty_state`).
  Nothing is lost: a failed claim, digest, age or sweep ends that tick of the loop (its `job.run`
  line for `email-send` has `result: failed`), a stalled row writes `email.send_failed` and is
  claimed again when its lease ends, and a stalled check fails that run (its `job.run` line for
  `email-delivery-check` has `result: failed`) and runs again at its next turn. Mail waits while
  it lasts. What else fires depends on the step. A `row` stall leaves the loop reading the
  outbox's age, so a code or security notice that keeps stalling also pages as `email-outbox-age`
  once it has waited past that threshold. A `claim`, `digest`, `age` or `sweep` stall ends the
  tick before the age is read, so its `job.run` line carries no `oldestDueS`, `email-outbox-age`
  stays silent and nothing else in this group pages: this alert, which only notifies, is the one
  signal, and the owner is woken by hand (below). The plan gives this alert neither its name nor
  its severity: both are proposed, for the steward to confirm.

## First check

1. Cloudflare's status page, and the Email Sending token's expiry and IP filter (the credential
   inventory). A `401` or `403` code means the token.
2. The worker's lease and its last `job.run` line for the email loop.
3. For a setting change: `pnpm fin email verify staging` and Cloudflare's audit log.
4. For a stall, the `step` and `reason` on the `email.delivery_stalled` lines and when they
   began. `connect_timeout` points at the database or the pool: `database-unreachable` and
   `pool-exhausted` on worker (`database.md`). `lock_timeout` points at a lock on the tables the
   step uses: the outbox's tables in `email_private`, or for `check` also `email.template_grant`
   and `pg_catalog.pg_roles`, and for `check_state` `ops.duty_state` (`packages/email`'s README
   says how another login can hold these); a migration or a `migrate --task` run going at that
   time (its run registration), or a long transaction (the probe's longest transaction).
5. For a budget, which template: the `template` and `class` on the `email.budget_reached` lines,
   and the day's `email.sent` lines by `template`, which show the one that is flooding; for an
   organisation's ceiling, the `orgId`. Then what queues that template: a release that loops, a
   flood of sign-ups or invitations, or one organisation's own use.

## Containment

1. A token problem: rotate it (`rotate-email-token`): `pnpm fin email token staging --rotate`,
   which redeploys worker with the new token and reads it back before it revokes the old one.
2. A setting change: restore it with `pnpm fin email domains staging` and read it back; never
   remove a sending domain without restoring DMARC. A weakened or missing DMARC record lets
   anyone send as `auth.` or `notify.`: restore it at `p=reject` (BD-17) first, then look for
   mail sent in the window.
3. A stopped loop: restart worker through `pnpm fin deploy` (never by hand in Railway).
4. A stall: let a registered run that holds the lock finish, or end the holder through a
   registered task (`database.md`); for a connection timeout, follow `database.md`. Never raise the
   worker's lock timeout or pool timeout by hand: they are its role default (and the delivery
   check's own, in its code) and its pool settings.
   The loop and the check recover on their own once their statements succeed. Close it when no
   new `email.delivery_stalled` line comes and the `job.run` lines for `email-send` and
   `email-delivery-check` are no longer `failed`; the incident recovers 15 minutes after the last
   line.
5. A budget reached: stop the flood where it is queued (roll back a release that loops; an
   organisation at its ceiling is the ceiling working, [SA-40]). Never raise a budget or a share
   outside a reviewed change: they are the sender's limits in `packages/email`. The budgets start
   again at the next UTC day, and the rows they held are sent then. Close it when no new
   `email.budget_reached` line comes; the incident recovers an hour after the last line.

## When to wake the owner

At once if sign-in codes or security notices are failing (`class` `code` or `security`) for more
than 15 minutes, a budget refused a code or a security notice, a stall lasts past 15 minutes with
no run to explain it (a `claim`, `digest`, `age` or `sweep` stall pages nobody on its own, so this
is the step that wakes the owner for it), or a setting changed outside a registered run. Ordinary mail delays, and a
budget that held back only ordinary mail, can wait.
