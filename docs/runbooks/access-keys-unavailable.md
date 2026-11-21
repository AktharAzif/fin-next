# Fin Admin cannot read Cloudflare Access's signing keys

Alert: `access-keys-unavailable` (any `access.keys_unavailable`).

## What it means

Fin Admin's API half checks the Cloudflare Access token on every request, before any handler
(spec 02 §10.5, F6). It verifies the token with Access's signing keys, read from the team's
certificate endpoint, whose address is built from the `FIN_ACCESS_TEAM` setting and never read as
a URL, and kept for at most 5 minutes. Here the keys could not be read: the fetch failed, took
longer than 5 seconds, or answered with no usable key. The check fails closed, so every admin API
request that needed the keys was refused with 503 `access_unavailable`: staff cannot use Fin
Admin, and nothing was let through. Each later request tries the fetch again. The line carries
only the envelope.

A wrong audience (`FIN_ACCESS_AUD`) or a bad token is not this alert: those are
`access.jwt_refused` lines with their `reason`.

## First check

Find the refusals by IDs only.

1. Cloudflare's status page for Access (Zero Trust).
2. How wide it is: the `request` lines on admin with `reason` `access.keys_unavailable`, by
   `replica`. Every replica and every request is the endpoint or the setting; one replica once is a
   passing network fault.
3. The admin service's `FIN_ACCESS_TEAM` against the team name in Zero Trust's settings, and
   whether a release or a change to the service's variables came just before (the run log, and
   Railway's audit log for the admin service).
4. Whether admin reaches the internet at all: `dns.lookup_failed` or other outbound failures on
   admin; Railway's network status.

## Containment

1. Cloudflare's outage: nothing to change in Fin. Staff wait, and the refusals stop when Access
   answers. Never turn the check off or let a request past it.
2. A wrong team name: correct the admin service's `FIN_ACCESS_TEAM` and redeploy admin with
   `pnpm fin deploy`. A change no registered run explains is someone else changing the service's
   variables: read Railway's audit log and treat the Railway token as exposed
   (`rotate-railway-token.md`).
3. A release that broke the fetch: roll admin back with `pnpm fin deploy` to the last release that
   answered, and fix it in a reviewed change.
4. Close it when admin's `request` lines answer staff again and no new line comes; the incident
   recovers 10 minutes after the last line.

## When to wake the owner

At once if it lasts more than 15 minutes while Cloudflare's status shows nothing, or the team name
changed outside a registered run. A short outage that Cloudflare's status explains can wait for
working hours.
