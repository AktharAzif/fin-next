# ops/watcher

The one Worker with code (spec 01 §7.11, OB-11, OB-18): `fin-next-<env>-watcher`, a `* * * * *`
cron, off the request path, read-only tokens only. Web APIs and plain `fetch` only, no Workers-only
binding, so it moves to any scheduled runner without a rewrite.

Every minute it runs the Phase 0 checks, writes one `watcher.run` line and one
`watcher.check_failed` line per failure (`check`, `target`: a role or a name, `detail`: a code) to
its Better Stack source, then pings its heartbeat (the failure URL when its lines did not ship or
its settings are broken). A check that cannot read its API fails.

| Check | Passes when | Alert |
|---|---|---|
| `connectors` | each tunnel has its replicas, every connector on 2026.11.1, every origin in its services' static egress | `tunnel-connectors` |
| `tunnel-config` | each tunnel is locally managed | `tunnel-config-drift` |
| `dns` | each host is one proxied CNAME to its own tunnel | `tunnel-config-drift` |
| `routes` | the zone's Workers routes equal spec 01 §7.5 exactly | `static-deployment-changed` |
| `static` | each static deployment is assets only (no module, handler, binding, schedule, domain, workers.dev or preview); no other script in the account | `static-deployment-changed` |
| `rules` | each rule set phase hashes to the last registered run's hash | `cloudflare-config-changed` |
| `zone` | spec 01 §7.6's settings, Universal SSL on, Bot Fight Mode off | `cloudflare-config-changed` |
| `access` | Fin Admin's application (session, cookies, MFA) and its policy hash | `cloudflare-config-changed` |
| `email` | both sending domains with preview and drop-suppressed off; `_dmarc` exists | `email-setting-changed` |

## Settings and secrets

`settings/<env>.json` is the public part, by host role. `pnpm fin watcher deploy` adds the private
part at run time (account ID, zone and hostnames, static egress addresses, the registered rule set
and Access policy hashes from `src/hash.ts`, which `rules apply` and `access apply` must use) and
uploads it as the plain value `FIN_WATCHER_SETTINGS`, with four secrets: `FIN_CF_TOKEN` (the
read-only token), `FIN_TELEMETRY_HOST`, `FIN_TELEMETRY_TOKEN` and `FIN_HEARTBEAT_WATCHER_URL`.

## Deploying

```sh
pnpm fin watcher deploy staging --dry-run
pnpm fin watcher deploy staging
```

`deploy/deploy.ts` exports `watcherDeploy(ctx)` and `command` for ops/fin's dispatcher. Credentials
are files: `FIN_CLOUDFLARE_OPERATOR_TOKEN_FILE` (the upload), `FIN_WATCHER_CF_TOKEN_FILE` (the
read-only token the Worker holds), `FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE` and
`FIN_BETTERSTACK_UPTIME_TOKEN_FILE` (to read the source's ingest token and the heartbeat URL). It
strips the types with Node's own `module.stripTypeScriptTypes`, uploads the modules through the
Workers API (no wrangler), sets the schedule, turns workers.dev and previews off, and reads it all
back. Run it again after every registered `rules apply` or `access apply`, so its hashes match.
