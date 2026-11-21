# A Railway service is exposed

Alert: `railway-exposed` (the watcher's `railway` check, once SP-21 gives a read-only Railway
credential; until then `pnpm fin verify staging` reads the same thing daily).

## What it means

A Railway service has a public domain (generated or custom) or a TCP proxy. Every request must
enter through a connector (spec 01 §6.3); an exposed service bypasses Cloudflare, the ingress
proof and Access.

## First check

1. Railway's workspace audit log: who added the domain or proxy, and when.
2. Whether it was a Railway default on a newly created service.

## Containment

1. Remove the domain or proxy at once in Railway (this is the one change made by hand, recorded
   in the incident), then run `pnpm fin verify staging` to confirm.
2. If it was added by a person, revoke their Railway token and review the project's members.
3. Treat any secret the exposed service could leak as exposed for the window, and rotate it.

## When to wake the owner

At once, always: an exposed service is a hole in the front door.
