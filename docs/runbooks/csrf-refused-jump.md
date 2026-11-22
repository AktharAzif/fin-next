# The origin gate refuses more than its baseline

Alert: `csrf-refused-jump` (notify only: `csrf.refused` above `@thresholds.csrf-refused-jump` in 15
minutes, per service).

## What it means

Every unsafe request to an app's API passes the origin gate first (AGENTS.md §3; spec 01 §8.9):
the exact `Origin`, `Sec-Fetch-Site` when present, the `X-Fin-App` header and a JSON body. Each
refusal writes `csrf.refused` with its `reason` (`origin_gate.origin`, `origin_gate.fetch_site`,
`origin_gate.app_header`, `origin_gate.content_type`) and the `route`. A few are expected traffic;
the threshold is the pre-deploy baseline in the private overlay. Above it, either the hosts and the
lists drifted apart (the service's configured origin is not the host its pages are served from, or
the pages send another `X-Fin-App`), so the app's own pages are refused, or something is sending
requests from another site.

## First check

1. The `service`, `reason`, `route` and `release` on the lines, and whether the count began with a
   release of the pages or of the API half.
2. One reason across many routes from the app's own pages is drift: compare `FIN_PUBLIC_ORIGIN` on
   the service with the host the pages are served on (by role, `<console>` or `<admin>`), and the
   `X-Fin-App` the client sends with the app's name.
3. Many reasons, few routes, no sign-in before them: requests from another site. The `request`
   lines with the same `requestId`s give the `cfRay`s to look up in Cloudflare's records.

## Containment

1. Drift from a release: roll back the pages or the service (`static-deploy.md`, `railway-deploy.md`),
   then fix the origin or the header in a reviewed change. Never widen the gate to quiet it.
2. Requests from another site: nothing to undo; the gate held. Confirm every one was refused.
3. Close it when the count falls below the threshold; the incident recovers 15 minutes later.

## When to wake the owner

If the app's own pages are refused for more than 15 minutes, or any unsafe request on that route
was answered without a refusal while the lines continue.
