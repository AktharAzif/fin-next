# Runbook: `pnpm fin tunnel create <env> <public|admin>`

Creates one of the two tunnels (spec 01 §7.3; [FD-13]; EXECUTION §2.5 step 4) and hands its token to
its own connector service.

## What it does

1. Looks the tunnel up by name (`fin-next-<env>-public` or `fin-next-<env>-admin`). If it exists, it
   must be locally managed (`config_src: local`); a remotely managed one is refused, because a
   dashboard configuration could repoint a hostname (evict it and recreate it instead).
2. Creates it if missing: `POST /accounts/<account>/cfd_tunnel` with `config_src: local`.
3. Fetches its token and sets it as the **sealed** `TUNNEL_TOKEN` of its one connector service
   (`cloudflared-public` or `cloudflared-admin`), with the plain `FIN_TUNNEL_ROLE` and
   `FIN_TUNNEL_HOSTS` (host role to hostname, for the ingress map; the docs host is not in it). The
   standby services (`-b`) get no token. The token is never printed or logged.

4. Reads the connector's variables back until a read shows this write (its `FIN_VARIABLES_RUN`
   marker and the sealed `TUNNEL_TOKEN`); a write that never shows fails the run (exit 69).

The variable commit starts no deployment (`skipDeploys`, `pnpm-fin.md`). A connector that has never
been deployed takes the token at its first roll by `railway deploy`: nothing is deployed here. A
tunnel made anew for a connector that has a deployment is a rotation: the running connector holds
the old tunnel's token, so the plan redeploys it as a step of its own (`~ update redeploy
cloudflared-<role> [TUNNEL_TOKEN]`), waits for `SUCCESS` and reads back; the rotation is done only
then (`rotate-tunnel-token.md`). A rotation registers as one, so a rotation that failed or was
stopped after the tunnel was made and before its redeploy passed is in the run log: a re-run keeps
the tunnel, sets its token again and redeploys the connector, which finishes it. Otherwise
re-running is safe: the tunnel is kept and the same token is set again, and the running connector
is left alone, unless `--redeploy` asks for its redeploy.

## Run it

```sh
export FIN_OVERLAY_FILE=<overlay> FIN_CF_TOKEN_FILE=<operator token file> FIN_RAILWAY_TOKEN_FILE=<railway token file>
node ops/fin/src/main.ts tunnel create staging public --dry-run
node ops/fin/src/main.ts tunnel create staging public
node ops/fin/src/main.ts tunnel create staging admin
```

## Check it

- Cloudflare's tunnel page lists the tunnel as locally managed with no configuration.
- Once the connector runs, the tunnel shows one connection set from the connector's static egress
  address (the watcher's `connectors` check).
- Then run `routes apply`, which points the hostnames at the tunnels.

## If a token leaks

A tunnel token lets its holder run a connector and receive the tunnel's traffic. Follow
`rotate-tunnel-token.md` at once.
