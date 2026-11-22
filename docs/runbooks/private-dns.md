# Private DNS lookups are failing

Alert: `dns-lookup-failing`.

## What it means

A service could not resolve a `*.railway.internal` name (`dns.lookup_failed`). `packages/server`
keeps serving stale answers for up to 5 minutes, so calls keep working for a while; after that,
calls between services fail. The `target` names the service it was looking up.

## First check

1. Whether `stale` is true on the lines (still covered) and how long it has lasted.
2. Railway's private networking status, and whether the target service is deployed and healthy.

## Containment

1. A target service that is down or renamed: fix that service first; the lookups recover.
2. Railway's private network failing: nothing to do at Fin's side; post on the status page if the
   API is affected.

## When to wake the owner

If lookups fail past the 5-minute stale window and requests start failing (`5xx-rate-*` or the
monitors fire). Short failures covered by stale answers can wait.
