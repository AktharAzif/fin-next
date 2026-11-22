# ops/monitoring

Better Stack as code (spec 01 §8, spec 08 §7.11, OB-05). Files name things; IDs, tokens, ingest
hosts, DSNs and heartbeat URLs are resolved at run time and never committed or printed.

| Path | What |
|---|---|
| `staging/*.json` | sources, Errors applications, logs-to-metrics, monitors, heartbeats, the `staging-quiet` policy |
| `staging/alerts/<area>.json` | one alert fragment per area (`platform`, `audit`, `database`, `email`, `identity`, `staff`, `ops`) |
| `catalog/<area>.ts` | every event Fin writes, its kind and fields, and the alerts that watch it or are owed for it (listed in `catalog/index.ts`) |
| `catalog/owed.ts` | the alerts code or the catalogue names before their fragment lands, each with its lane and the date due; production's first deploy waits for a gate that refuses while any is listed (its header) |
| `src/check.ts` | `monitoring:check`: no network, a few milliseconds |
| `src/apply.ts` | the apply: `monitoringApply(ctx)`, its guards and its read-back |
| `src/apply-cli.ts` | the entry point `pnpm fin monitoring apply <env>` runs as a child process, over an IPC channel |

## monitoring:check

`pnpm --filter @fin/ops-monitoring monitoring:check`. It also runs inside this package's tests, so
`pnpm check` fails on any finding. Those tests read files outside the package (the code tree, the
runbooks, the flows' atlas, the watcher's settings, the audit writers), which Turborepo's hash
never sees, so `turbo.json` here turns their cache off and they run on every `pnpm check`. Rules
MC-00 to MC-15 (MC-05 covers spec 01 §8.5's heartbeats and the watcher's own until the duty
registry exists; MC-09 comes with the credential inventory) and RT-01 to RT-03 are listed at the
top of `src/check.ts`. Every alert names a runbook in
`docs/runbooks/` with the four Phase 0 headings (What it means, First check, Containment, When to
wake the owner) that names the alert back. MC-15 holds every alert name the code (a line list's
`alerts`, or text that calls a backquoted name an alert; see `alertsInCode`) or the catalogue (an
entry's `owed`, any alert-shaped word of a `noAlert`, a fragment file's own text) gives to a rule of
the environment or an entry of `catalog/owed.ts` with a lane and a due date, and fails for an owed
alert that has become a rule. An alert reads only fields that a writer of its events writes
(`test/alert-fields.test.ts`, which lists the exceptions by name with the reason); one whose field
no process writes yet is owed, not defined. MC-12 scans every file under `staging/`, the
catalogue, this README, the runbooks and the watcher's settings.

## Applying

```sh
pnpm fin monitoring apply staging --dry-run
pnpm fin monitoring apply staging [--confirm-delete <count>] [--assert-empty-team fin-staging]
```

ops/fin may not import this package (CI-14), so `pnpm fin` runs `src/apply-cli.ts` as a child
process with no argument and an empty environment, and keeps the run (the lock, `run.registered`
before the first write, a `run.step` per write, `run.done`), the credentials and the overlay. The
child holds no token: each Better Stack call it makes goes to pnpm fin as a message, and pnpm fin
sends it with the team token, to Better Stack's API hosts only, never a write in a dry run or
outside the registered run (`docs/runbooks/monitoring-drift.md`). Credentials are files, read by
pnpm fin: `FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE` (Telemetry and Errors),
`FIN_BETTERSTACK_UPTIME_TOKEN_FILE`, `FIN_MONITOR_HEADER_FILE` (the secret monitor header; optional
for a dry run). Hostnames come from the overlay by host role, thresholds and grace periods from the
overlay (`thresholds.<key>`, `grace.<key>`); a change to one prints its placeholder
(`<threshold:<key>>`, `<grace:<key>>`), never the number.

The run checks the files first, prints the difference before changing anything, and refuses
tokens of any team but `fin-<env>` (the environment's, never a string in the files; MC-13 holds
the files to it). `--assert-empty-team` is accepted only for a product whose token reads no object
at all. It caps deletions and pauses together at 3 without `--confirm-delete <count>`, pauses
(never deletes) a heartbeat the files drop, never deletes a source or an Errors application,
refuses two Better Stack objects with one name, and refuses anything in staging that calls, texts
or pushes, or routes to any policy but `staging-quiet` (MA-06); a managed alert, monitor or
heartbeat someone made loud, or gave a maintenance window or a team wait, is put back and shown as
drift. After a run that wrote anything, everything is read back and compared with the files again:
any object that differs fails the run, named with the parts that differ, a part Better Stack fixes
at creation (a source's `data_region`, a metric's `type`) included unless it differed before the
run (then it is reported as drift that only a recreation by hand fixes). New tokens, DSNs and
heartbeat URLs go to `ctx.deliver` (Railway services' sealed variables only, MC-07; pnpm fin does
not deliver yet, so they are listed by service and variable, and Better Stack keeps them for a
later `--redeliver`) and are never printed; the
watcher's and `pnpm fin verify`'s own are read from Better Stack by those commands. The output
names objects, never their IDs, and masks the hostnames, the zones (`ctx.zones`) and the monitor
header, Better Stack's own error text included, where each private number a refused write carried
(or its object held) also prints as its placeholder. Each change is printed by the part that changed
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
