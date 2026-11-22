# Tunnel configuration or DNS drift

Alert: `tunnel-config-drift` (the watcher's `tunnel-config` and `dns` checks).

## What it means

Either a tunnel stopped being locally managed (someone gave it a remote configuration in the
dashboard, which would let Cloudflare's side change its ingress), or a host's DNS record is no
longer a proxied CNAME to its own tunnel: missing, not a CNAME, not proxied (traffic would bypass
Cloudflare's rules), duplicated, or pointing at another tunnel. The `detail` says which:
`remote_config`, `config_src_not_local`, `record_missing`, `record_not_cname`,
`record_not_proxied`, `record_wrong_tunnel`, `record_duplicate`, `tunnel_missing`,
`tunnel_duplicate`, `tunnel_unknown` (a record whose tunnel cannot be identified), `api_error` or
`api_forbidden` (the watcher could not read; it treats that as a failure).

## First check

1. The `target` names the tunnel role or the host role. Look for a registered `pnpm fin tunnel`
   or `pnpm fin routes apply` run in the ops bucket at that time.
2. Read Cloudflare's account audit log for the record or tunnel change and who made it.

## Containment

1. A record pointing elsewhere, or not proxied: run `pnpm fin routes apply staging`, which writes
   every CNAME from the tunnel IDs read at run time; the watcher's next run must pass `dns`.
2. A remotely managed tunnel: treat it as a possible takeover of the ingress. Delete the remote
   configuration, or recreate the tunnel as in `evict-tunnel.md`, and rotate the role's ingress
   proofs.
3. If the change was made by a person outside a run, revoke that member's token or session.

## When to wake the owner

At once if a record points at a tunnel that is not Fin's, or a tunnel became remotely managed
outside a registered run. A record briefly missing during a registered `routes apply` is not an
incident.
