# Runbook: rotate a tunnel token (staging)

A tunnel token lets whoever holds it run a connector for that tunnel and receive its traffic
([FD-13]). Rotate every 90 days, and **at once** after any Railway or Cloudflare security notice,
any sign that a `TUNNEL_TOKEN` value was exposed, or a `tunnel-connectors` alert naming a connector
from an unexpected address ([FD-12], spec 01 §9.3 and §9.7).

Until the blue and green evict commands exist (hardening, [FD-15]), staging rotates by deleting and
recreating the tunnel, with a short outage of the hosts on that tunnel.

## Steps (staging)

1. Contain: in Cloudflare, delete the tunnel `fin-next-staging-<role>` (with its connections). This
   drops every connector at once, the rogue one included, and revokes the old token with it. The
   hosts on it answer Cloudflare's error page from here until the connector runs on the new token.
2. `node ops/fin/src/main.ts tunnel create staging <role>`: the rotation, through `pnpm fin`. It
   makes a new locally managed tunnel, sets its token sealed on the connector service in a commit
   that starts no deployment, reads it back until it shows, then redeploys the connector as a step
   of its own (`~ update redeploy cloudflared-<role> [TUNNEL_TOKEN]`, a `run.step` and a
   `rotation.redeployed` line naming the service), waits for `SUCCESS` and reads back again. The
   rotation is done only then. Run it with `--dry-run` first to read the plan.
   - If any step after the run began fails or is stopped (the tunnel, the token fetch, the
     variables write or its read-back, the redeploy), the output says the rotation is not done and
     names the command that finishes it once the cause is fixed: `node ops/fin/src/main.ts tunnel
     create staging <role> --redeploy` (the tunnel is kept, its token set again, and the connector
     redeployed); `run.done` records the same as its `leftover`. A plain re-run finishes it too:
     the rotation registered as one, so the run log shows it unfinished, and the kept tunnel's
     connector is redeployed. A kept tunnel with no unfinished rotation in the run log redeploys
     nothing without `--redeploy`.
   - If the connector is set to an image its newest deployment does not run, the redeploy is
     refused (it would roll that image): run `railway deploy` for the release staging runs, then
     step 2 again with `--redeploy`. When Railway does not say which image that deployment runs
     (SP-03), the redeploy goes on only if the connector is set to the digest the registered
     deploys recorded for it, and is refused otherwise, the same way.
3. `node ops/fin/src/main.ts routes apply staging`: the proxied CNAMEs move to the new tunnel's ID.
4. Check: the watcher shows the expected connector count, version and origin address for the new
   tunnel; `/api/health` answers through the console and verify hosts (or `/health` through the API
   host).
5. Record the rotation in the incident log if it was not a scheduled one, and wake the owner if a
   rogue connector was seen.

## Rollback

There is none to the old token: it is revoked with its tunnel. If step 2 or 3 fails, re-run it
(step 2 with `--redeploy` once the tunnel exists).
