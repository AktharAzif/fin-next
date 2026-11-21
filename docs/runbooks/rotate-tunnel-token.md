# Runbook: rotate a tunnel token (staging)

A tunnel token lets whoever holds it run a connector for that tunnel and receive its traffic
([FD-13]). Rotate every 90 days, and **at once** after any Railway or Cloudflare security notice,
any sign that a `TUNNEL_TOKEN` value was exposed, or a `tunnel-connectors` alert naming a connector
from an unexpected address ([FD-12], spec 01 §9.3 and §9.7).

Until the blue and green evict commands exist (hardening, [FD-15]), staging rotates by deleting and
recreating the tunnel, with a short outage of the hosts on that tunnel.

## Steps (staging)

1. Contain: in Cloudflare, delete the tunnel `fin-next-staging-<role>` (with its connections). This
   drops every connector at once, the rogue one included. The hosts on it answer Cloudflare's error
   page from here until the connector runs on the new token.
2. `node ops/fin/src/main.ts tunnel create staging <role>`: a new locally managed tunnel, its token
   set sealed on the connector service. The variable commit starts no deployment (`skipDeploys`):
   the connector takes the token only at its next deployment, and `railway deploy` keeps a
   connector that already runs the release's image, so no `pnpm fin` command redeploys it yet.
   Wake the owner, who decides how the connector is redeployed; record that in the incident log.
3. `node ops/fin/src/main.ts routes apply staging`: the proxied CNAMEs move to the new tunnel's ID.
4. Check: the watcher shows the expected connector count, version and origin address for the new
   tunnel; `/api/health` answers through the console and verify hosts (or `/health` through the API
   host).
5. Record the rotation in the incident log if it was not a scheduled one, and wake the owner if a
   rogue connector was seen.

## Rollback

There is none to the old token: it is revoked with its tunnel. If step 2 or 3 fails, re-run it.
