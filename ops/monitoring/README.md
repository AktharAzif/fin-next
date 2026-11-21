# ops/monitoring

Better Stack as code (spec 01 §8, spec 08 §7.11, OB-05). Files name things; IDs, tokens, ingest
hosts, DSNs and heartbeat URLs are resolved at run time and never committed or printed.

| Path | What |
|---|---|
| `staging/*.json` | sources, Errors applications, logs-to-metrics, monitors, heartbeats, the `staging-quiet` policy |
| `staging/alerts/<area>.json` | one alert fragment per area (`platform`, `email`, `database`) |
| `catalog/<area>.ts` | every event Fin writes, its kind and fields, and the alerts that watch it (listed in `catalog/index.ts`) |
| `src/check.ts` | `monitoring:check`: no network, a few milliseconds |
| `src/apply.ts` | `pnpm fin monitoring apply <env>`: exports `monitoringApply(ctx)` and `command` for ops/fin's dispatcher |

## monitoring:check

`pnpm --filter @fin/ops-monitoring monitoring:check`. It also runs inside this package's tests, so
`pnpm check` fails on any finding. Rules MC-00 to MC-14 and RT-01 to RT-03 are listed at the top
of `src/check.ts`. Every alert names a runbook in `docs/runbooks/` with the four Phase 0 headings
(What it means, First check, Containment, When to wake the owner) that names the alert back.

## Applying

```sh
pnpm fin monitoring apply staging --dry-run
pnpm fin monitoring apply staging [--confirm-delete <count>] [--assert-empty-team fin-staging]
```

Credentials are files, read only inside the command: `FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE`
(Telemetry and Errors), `FIN_BETTERSTACK_UPTIME_TOKEN_FILE`, `FIN_MONITOR_HEADER_FILE` (the secret
monitor header; optional for a dry run). Hostnames come from the deploy configuration by host role,
thresholds and grace periods from the overlay (`thresholds.<key>`, `grace.<key>`).

The run checks the files first, prints the difference before changing anything, refuses another
team's tokens, caps deletions at 3 without `--confirm-delete`, pauses (never deletes) a heartbeat
the files drop, never deletes a source or an Errors application, and refuses anything in staging
that calls, texts or pushes. New tokens, DSNs and heartbeat URLs go to `ctx.deliver` (the services'
sealed variables) and are never printed.
