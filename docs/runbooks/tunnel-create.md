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

Re-running is safe: the tunnel is kept and the same token is set again (Railway redeploys the
connector).

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
