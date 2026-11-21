# Evict a tunnel's connectors

Alerts: `tunnel-connectors` (the watcher's `connectors` check). Also used when a tunnel token is
seen anywhere (a branch, a log, an artefact), when a connector service's variables are exposed, or
on a Railway or Cloudflare security notice. Spec 08 §8.2 is the full procedure; this page is the
Phase 0 form, before the blue and green commands exist (spec 01 §9.7).

## What it means

A tunnel (`public` or `admin`) has a connector Fin did not start: the wrong number of connectors,
a `cloudflared` version other than the pinned one, or an origin address outside the static egress
addresses of that tunnel's connector services. Treat it as a leaked tunnel token until proved
otherwise: a rogue connector receives and can answer a share of the requests for every host of
that tunnel (typed codes, session cookies, API keys, Access tokens).

The `detail` on `watcher.check_failed` says which: `count_mismatch`, `version_mismatch`,
`origin_unexpected`, `tunnel_missing`, `tunnel_duplicate`, or `api_error` and `api_forbidden`
(the watcher could not read the tunnel, which it treats as a failure; `api_forbidden` usually
means its read-only token expired).

## First check

1. Read the `watcher.check_failed` lines for the last 10 minutes: the `target` names the tunnel
   role, the `detail` the reason.
2. Compare with Railway: is a `cloudflared-<role>` deployment rolling right now (a deploy briefly
   shows two connectors)? Was there a registered `pnpm fin deploy` or tunnel run in the ops
   bucket? A count that settles within two minutes during a registered deploy is not an incident.
3. `version_mismatch` alone, with the right count and origins, after a connector image change,
   means the image pin and the watcher's settings disagree: fix the settings by a reviewed change.
4. Any `origin_unexpected`, or a count above the replicas outside a deploy: go to Containment now.

## Containment

Keep the evidence first, then cut the tunnel (staging has no standby tunnel yet).

1. Record the connector list: `pnpm fin tunnel status staging <role> --record` (connector IDs,
   versions, origin addresses and first-seen times, encrypted to the ops bucket). If the command
   is not built yet, the operator copies the list from Cloudflare's tunnel page into the incident
   record, never into the repository.
2. Export Railway's audit log.
3. Delete the tunnel at Cloudflare (with its connections). Every `/api/*` path of the role's hosts
   then fails at Cloudflare while the static files still load; this is the intended outage.
4. Create a new locally managed tunnel `fin-next-staging-<role>` with `pnpm fin tunnel create
   staging <role>`, which sets its token as the connector service's sealed `TUNNEL_TOKEN` without
   printing it, and repoint the role's CNAMEs with `pnpm fin routes apply staging`.
5. Rotate the role's ingress proofs (`rotate-ingress-proof`): they travelled with every request.
6. Confirm: the watcher's next run passes `connectors` for the role, the monitors are green, and
   `ingress.untrusted_peer` is at zero.
7. Within 4 hours, assess exposure for the window (spec 08 §8.2 step 10): end developer and hosted
   link sessions for the public tunnel, staff and Access sessions for the admin tunnel.

## When to wake the owner

At once for any `origin_unexpected`, a count above the expected replicas outside a registered
run, or a token seen outside its service. A `version_mismatch` during a registered connector
deploy can wait for working hours.
