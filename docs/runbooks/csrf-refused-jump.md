# Origin-gate refusals jumped above their baseline

Alert: `csrf-refused-jump` (notify only: `csrf.refused` on console, admin or verify above
`@thresholds.csrf-refused-jump`, the pre-deploy baseline, in 15 minutes), one incident per service.

## What it means

Every unsafe request to an app's API half passes the origin gate before any handler, the auth
library's included (spec 01 §4.4, spec 02 §2.3): `Origin` must equal the service's configured
origin exactly, `Sec-Fetch-Site` (when sent) must be `same-origin`, `X-Fin-App` must be the app's
name (`console`, `admin` or `verify`), and a body must be JSON. A refusal is answered
`403 invalid_origin` and written as one `csrf.refused` line with the `reason` and the `route`
pattern, never the origin, a header value or a query string. Two writers write it: web-host's gate
(`packages/web-host/src/origin-gate.ts`, every API half), with `reason` `origin_missing`,
`origin_mismatch`, `fetch_site`, `app_header` or `content_type`; and identity's realm on console
and admin, for a `GET` to an auth path whose `Sec-Fetch-Site` says another site sent it (a
provider's callback excepted), with `reason` `fetch_site`.

A few refusals are normal traffic: old tabs, browser extensions, someone's script. The threshold
is the pre-deploy baseline in the private overlay. A jump above it, usually right after a deploy,
means the hosts and the lists drifted apart (ARCHITECTURE §10.8 group B): the service's
`FIN_PUBLIC_ORIGIN` no longer equals the host the app is served from, or the app's client stopped
sending the `X-Fin-App` name the service expects, so every person's writes on that app now fail.
A jump with no deploy can be a page on another site trying to make people's browsers write to
Fin: the gate refused it, which is the gate working.

## First check

Find the requests by IDs only.

1. The `service`, `reason`, `route` and `release` on the lines, and whether the jump began with a
   deploy of the service or of the app's pages.
2. One `reason` across many routes is drift: `origin_mismatch` is the origin setting against the
   host; `app_header` is the client's header; `content_type` is a client sending another body type.
3. `FIN_PUBLIC_ORIGIN` on the service against the host role the app is served from in the deploy
   configuration, and the `X-Fin-App` name the app's client sends (the release's client code).
4. The request lines with the same `requestId`s: their `cfRay`. Look up a few Ray IDs in
   Cloudflare's own records for the host to see the `Origin` and `Referer`; never copy a query
   string. Many origins that are not Fin's, with no deploy, is a cross-site attempt.

## Containment

1. Drift from a deploy: deploy the previous release's manifest (`railway-deploy.md`, "If a deploy
   fails"), and the app's pages too if they changed (`static-deploy.md`, "Roll back"). Then fix the
   origin setting or the client's header in a reviewed change; the origin comes from the deploy
   configuration by host role, never typed into a service by hand.
2. Never loosen the gate to quiet the alert: no wildcard origin, no skipped header, no CORS.
3. A cross-site attempt: nothing to undo; check that every such request was answered 403 (the
   request lines' `status`) and that no other security alert came with it.
4. Close it when the count falls below the threshold; the incident recovers 15 minutes later.

## When to wake the owner

If people's writes on an app keep failing for more than 15 minutes after a rollback, or any request
the gate should have refused was answered with anything but 403. A cross-site attempt the gate
refused can wait for working hours.
