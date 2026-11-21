# An uptime monitor is down

Monitors: `api-health`, `api-unauthenticated`, `console-sign-in`, `console-api-health`,
`verify`, `verify-api-health`, `admin`, `docs`. Each checks a host role's path every minute from
two regions with a confirmation period, sends the secret monitor header, and emails
`staging-quiet`.

## What it means

A host did not answer as expected from both regions after confirmation:

| Monitor | Expects | A failure points at |
|---|---|---|
| `api-health` | 200 from `/health` on the api host | the public tunnel, the edge |
| `api-unauthenticated` | 401 from `/v4/whoami` with no key | the edge's key check (a 200 is serious) |
| `console-sign-in` | the app shell on `/sign-in` | the console's static deployment or its route |
| `console-api-health` | 200 from `/api/health` | the no-Worker route, the tunnel, the console API half |
| `verify` | the app shell on `/` | the hosted pages' static deployment |
| `verify-api-health` | 200 from `/api/health` | the tunnel, the verify API half |
| `admin` | 302 to the Access sign-in | Access in front of Fin Admin (a 200 is serious) |
| `docs` | the app shell on `/` | the docs site's static deployment |

## First check

1. The static half or the API half? A static monitor failing alone points at the deployment and
   its route (`static-deployment-changed`); an `/api` monitor alone at the tunnel or the service.
2. The watcher's connector check (`tunnel-connectors`) and the service's `no-logs` alert.
3. Cloudflare's status page.

## Containment

1. `admin` answering 200, or `api-unauthenticated` answering 200: a protection is gone. Turn on the
   `ks-api-all` kill switch for the api host (`pnpm fin killswitch staging ks-api-all on`) or
   restore Access (`pnpm fin access apply staging`) at once.
2. A service down: redeploy through `pnpm fin deploy staging`; a tunnel with no connector: follow
   `evict-tunnel.md`'s recreate steps.
3. A static deployment broken: re-run the approved `deploy-static-staging` job for the release.

## When to wake the owner

At once if `admin` or `api-unauthenticated` answer 200. Otherwise if a monitor stays down for more
than 15 minutes.
