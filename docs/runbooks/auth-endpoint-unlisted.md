# Requests for auth paths the realm does not list

Alert: `auth-endpoint-unlisted` (notify only: `auth.endpoint_blocked` with `class` `unlisted` above
its threshold in 15 minutes, per service).

## What it means

Every API half answers `/api/auth/*` only through its realm's endpoint allowlist (spec 02 §4.1,
F3). A path the allowlist does not list is answered 404 before the auth library sees it, and
written as `auth.endpoint_blocked` with `class: unlisted` and the `realm` (`developer` on console,
`staff` on admin, `none` on verify, which has no auth routes), never the path. Nothing reached the
library, so nothing was exposed. Many of them mean one of two things:

- a client or library change: a release of the app's pages, or of the auth library, calls a path
  the allowlist does not hold, so a sign-in, factor or session step now fails for everyone who
  reaches it;
- probing: something is trying the library's other paths to find one left open.

A `blocked` path (listed, and refused on purpose) is not counted. A line without a `class` is
counted, so a writer that loses the field still alerts.

## First check

Find the requests by IDs only; the path itself is never in Fin's lines.

1. The `service`, `realm` and `release` on the lines, and when the count began.
2. The `request` lines with the same `requestId`s: `status` 404, `reason` `policy.blocked`, and
   their `cfRay`. Look up a few Ray IDs in Cloudflare's own records for the host to see the path;
   never copy a query string.
3. Did a release of the app's pages or of its API half go out just before? Are `sign-in-failing` or
   `second-factor-step-failing` open too? A client change is usually one path, from the app's own
   pages, across many people.
4. Probing is usually many paths from few networks with no sign-in before them, and any request
   on verify (`realm` `none`).

## Containment

1. A release calling an unlisted path: roll it back, the pages first (`static-deploy.md`, "Roll
   back"), then the services (`railway-deploy.md`). Then change the client back, or list the path
   with its class and the session states it may reach in the realm's allowlist
   (`packages/identity/src/endpoint-policy.ts`), through a reviewed change. Never list a path to
   quiet the alert without reading what it does.
2. Probing: nothing to undo; the allowlist held. Check that every such request was answered 404
   (the `request` lines' `status`) and that no sign-in, factor or step-up alert came with it. If it
   goes on at a volume that slows the service, raise it with the owner.
3. Close it when the count falls below the threshold; the incident recovers 15 minutes later.

## When to wake the owner

At once if an unlisted path was answered with anything but 404, or sign-in fails with it. A
release's own unlisted call can wait for the rollback, and probing the allowlist refused can wait
for working hours.
