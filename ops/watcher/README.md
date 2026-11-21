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
| `routes` | the Workers routes on fin-next's hosts equal spec 01 §7.5 exactly, and no other route reaches one of them (exactly or through a wildcard) | `static-deployment-changed` |
| `static` | each static deployment is assets only (no module, handler, binding, schedule, domain, workers.dev or preview) and serves the version its last registered upload read back; no other `fin-next-` Worker exists; no Worker is bound to a custom domain on a fin-next host | `static-deployment-changed` |
| `rules` | in each phase `rules apply` writes, the hash of fin-next's own rules (ref `fin_next_`) equals the last registered run's; no `fin_next_` rule elsewhere; no other product's rule names a fin-next host | `cloudflare-config-changed` |
| `zone` | spec 01 §7.6's settings, Universal SSL on, Bot Fight Mode off | `cloudflare-config-changed` |
| `access` | Fin Admin's application (whole host, session, cookies, MFA) and its policy hash; no other application covers the admin host or a path under it | `cloudflare-config-changed` |
| `email` | both sending domains with preview and drop-suppressed off; `_dmarc.auth.<zone>` and `_dmarc.notify.<zone>` each one DMARC record at `p=reject` (BD-17), with no weaker `sp` and no partial `pct` | `email-setting-changed` |

The account and the zone are shared with the old product's staging (FD-09). Its own Workers,
routes, custom domains, Access applications, DNS records (the zone's apex `_dmarc` among them) and
zone rules are not fin-next's and never fail a check, unless they reach one of fin-next's hosts.
Every alert opens one incident per `target`, so a failure that can stand for a while (an unset
version, say) has a target of its own and never hides a later, different one.

## Settings and secrets

`settings/<env>.json` is the public part, by host role. `pnpm fin watcher deploy` adds the private
part at run time (account ID, zone and hostnames, static egress addresses, the registered rule set
and Access policy hashes, and each static deployment's registered version) and uploads it as the
plain value `FIN_WATCHER_SETTINGS`, with four secrets: `FIN_CF_TOKEN` (the read-only token),
`FIN_TELEMETRY_HOST`, `FIN_TELEMETRY_TOKEN` and `FIN_HEARTBEAT_WATCHER_URL`.

What the registered runs record, so the watcher compares like with like:

- `rules apply`: per phase in `rulesetPhases`, `finRulesetHash(entrypoint.rules)` from
  `src/hash.ts`, the hash of the phase's `fin_next_` rules only (an empty phase hashes as `[]`).
- `access apply`: `accessPolicyHash(application.policies)`.
- the static deploy: per deployment, the active version its re-read finds (the first deployment of
  `GET .../workers/scripts/<name>/deployments`, its one version at 100 %). Every upload makes a new
  version, so the watcher must be redeployed after every registered static deploy, as after every
  registered `rules apply` or `access apply`. Until a value is registered the watcher reports
  `hash_unset` or `version_unset`, and the deploy prints a note for each.

## Deploying

```sh
pnpm fin watcher deploy staging --dry-run
pnpm fin watcher deploy staging
```

`deploy/deploy.ts` exports `watcherDeploy(ctx)` and `command` for ops/fin's dispatcher. Credentials
are files: `FIN_CLOUDFLARE_OPERATOR_TOKEN_FILE` (the upload), `FIN_WATCHER_CF_TOKEN_FILE` (the
read-only token the Worker holds), `FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE` and
`FIN_BETTERSTACK_UPTIME_TOKEN_FILE` (to read the source's ingest token and the heartbeat URL).
Before anything is uploaded it proves the Worker's token is read-only: it refuses the operator's
own token, verifies the Worker's token is an active token of the account, reads its permission
groups with the operator token and refuses any that is not a Read group, and refuses a token with
no expiry or one more than a year away (spec 08 §6.5's yearly rotation). A name two Better Stack
sources or heartbeats share is refused too. It strips the types with Node's own
`module.stripTypeScriptTypes`, uploads the modules through the Workers API (no wrangler), sets the
schedule, turns workers.dev and previews off, and reads it all back. Run it again after every
registered `rules apply`, `access apply` or static deploy, so its hashes and versions match.
