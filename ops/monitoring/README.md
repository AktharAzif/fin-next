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
`pnpm check` fails on any finding. Rules MC-00 to MC-14 (MC-05 covers spec 01 §8.5's heartbeats
and the watcher's own until the duty registry exists; MC-09 comes with the credential inventory)
and RT-01 to RT-03 are listed at the top of `src/check.ts`. Every alert names a runbook in
`docs/runbooks/` with the four Phase 0 headings (What it means, First check, Containment, When to
wake the owner) that names the alert back. MC-12 scans every file under `staging/`, the
catalogue, this README, the runbooks and the watcher's settings.

## Applying

```sh
pnpm fin monitoring apply staging --dry-run
pnpm fin monitoring apply staging [--confirm-delete <count>] [--assert-empty-team fin-staging]
```

Credentials are files, read only inside the command: `FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE`
(Telemetry and Errors), `FIN_BETTERSTACK_UPTIME_TOKEN_FILE`, `FIN_MONITOR_HEADER_FILE` (the secret
monitor header; optional for a dry run). Hostnames come from the deploy configuration by host role,
thresholds and grace periods from the overlay (`thresholds.<key>`, `grace.<key>`).

The run checks the files first, prints the difference before changing anything, and refuses
tokens of any team but `fin-<env>` (the environment's, never a string in the files; MC-13 holds
the files to it). `--assert-empty-team` is accepted only for a product whose token reads no object
at all. It caps deletions and pauses together at 3 without `--confirm-delete <count>`, pauses
(never deletes) a heartbeat the files drop, never deletes a source or an Errors application,
refuses two Better Stack objects with one name, and refuses anything in staging that calls, texts
or pushes; a managed alert, monitor or heartbeat someone made loud, or gave a maintenance window
or a team wait, is put back and shown as drift. New tokens, DSNs and heartbeat URLs go to
`ctx.deliver` (Railway services' sealed variables only, MC-07) and are never printed; the
watcher's and `pnpm fin verify`'s own are read from Better Stack by those commands. The output
names objects, never their IDs, and masks the hostnames, the zones (`ctx.zones`) and the monitor
header, Better Stack's own error text included. Each change is printed by the part that changed
(`steps[0].step_members`, `metadata.runbook`), cut around its first difference, so no change
prints the same on both sides; a value, like an error text, is masked whole before it is cut, so
no cut leaves part of a hostname or zone. Anything that stops the writes (a refusal from Better
Stack, a call that gets no answer, a fault in the run) still has what was created before it
delivered; a read that gets no answer is tried once more, a write never is. A create that gets
no answer (or a server error) may have made its object: one with secrets is looked up by name,
and delivered when found; otherwise its variables are listed as not delivered, for `--redeliver`.
A list is read only to the end its pages name (`pagination.next` null); an answer without one
fails the run.

A dry run deletes and pauses nothing, so MA-03's cap is a note there, not a refusal. Its `drift`
(what the daily dry run reports) is true for any difference, for a source or an Errors
application the files do not name, and for a refusal Better Stack's own objects cause (two
objects with one name, a loud object outside the files, an `ai_sre` member): a refusal never
hides the drift it found.
