# Runbook: `pnpm fin`, the overlay, the run log and the run lock

`pnpm fin` is the operator's tool for staging (spec 01 §6, §7, §9, §10; ARCHITECTURE §11.8). Every
command that can change a provider prints its plan first, runs only inside a registered run, and
takes `--dry-run`. Until the root `package.json` gains a `fin` script (a steward change), run it as
`node ops/fin/src/main.ts <command> <env> ...` from the repository root.

## Before any run

1. The private overlay is a file outside the repository, readable by its owner only (`chmod 600`):

   ```sh
   export FIN_OVERLAY_FILE=<path to the staging overlay>
   node ops/fin/src/main.ts overlay check staging
   ```

   `overlay check` validates the file and prints what it holds with every private value replaced by
   a placeholder (`<zone>`, `<host:admin>`, `<overlay:cloudflare.accountId>`). It refuses an overlay
   for another environment, a host that is not one label below the zone, a host whose label is not
   on `allowedNames.labels`, and an allow-list that shares a label with `neverTouch`.
2. Credentials are files too, each readable by its owner only, named by a variable and read inside
   the process: `FIN_CF_TOKEN_FILE` (the Cloudflare operator token), `FIN_RAILWAY_TOKEN_FILE` (the
   Railway project token), `FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE` and
   `FIN_BETTERSTACK_UPTIME_TOKEN_FILE`. Never paste a token on the command line or into a variable.
3. Every command prints names and placeholders only. In GitHub Actions it first registers every
   overlay value and credential with `::add-mask::`.

## What a mutating command does

1. Reads the provider's current state (read-only calls) and builds the plan.
2. Prints the plan: `+` create, `~` update with the fields that differ, `-` delete, `=` unchanged,
   `!` held (reported, not applied, with the reason).
3. With `--dry-run` it stops there: exit 0 when nothing differs, 1 when something would change.
4. Otherwise it takes the run lock, writes `run.registered`, sends each change after the allow-list
   guard has passed it (one `run.step` each), and writes `run.done` with the result.
5. A plan that deletes anything is refused unless `--confirm-delete <n>` names exactly the number of
   deletions.

### The allow-list guard (BD-11)

Every Cloudflare write that names a host is checked before it is sent: the name must be under the
overlay's zone, its label on `allowedNames.labels` (`spikeOnly` only with `--spike`, `fallbackOnly`
only with `--fallback`); the apex, `@`, any wildcard, the zone's own `_dmarc` and every
`neverTouch` label are refused. Workers route paths are exactly `/*` or `/api/*`. Zone rules are
written only through the per-rule endpoints and only when their `ref` starts with `fin_next_`.
A refusal exits 77 and sends nothing.

## The run log and the run lock (interim, until the R2 vault exists)

The plan keeps registrations in the `fin-next-staging-ops` bucket and the lock in
`fin-next-staging-state`. Until `pnpm fin vault create` lands, both live on the operator's machine
under `FIN_STATE_DIR` (default `~/.local/state/fin-next/<env>/`):

- `runs.jsonl`: append-only, one masked record per line, each carrying the SHA-256 of the line
  before it. Check it with `node ops/fin/src/main.ts log verify staging` (exit 1 when the chain is
  broken: treat that as an incident, the log was edited).
- `lock.json`: the run lock, taken with an exclusive create. A second run exits 75 and names the
  holder.
- `lines.jsonl`: the runs' telemetry lines (spec 08 §7.2's envelope, service `ops`). They are also
  shipped to the `fin-next-staging-ops` source when `FIN_OPS_INGEST_HOST` and
  `FIN_OPS_INGEST_TOKEN_FILE` are set.

### A stale lock

1. `node ops/fin/src/main.ts lock status staging` shows the holder: run ID, command, start time,
   process and machine.
2. Confirm that run is gone (its process is not running on that machine, and nobody is mid-change).
3. `node ops/fin/src/main.ts lock break staging --reason "<what happened>"`. The break is written to
   the run log with the holder and the reason.
4. Re-run the interrupted command with `--dry-run` first: every apply reads the current state, so
   the plan shows what the interrupted run left undone.

Wake the owner if the run log's chain is broken, or if a lock is held by a run nobody recognises.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done, or a dry run with nothing to change |
| 1 | a dry run with changes, changes held, or drift found by a verify |
| 64 | usage: an unknown command, flag or environment |
| 65 | bad input data (a release manifest, an artefact) |
| 69 | a provider was unreachable or answered an error |
| 70 | internal error |
| 75 | the run lock is held |
| 77 | refused by a safety rule; nothing was sent |
| 78 | the overlay, the settings or a credential file is missing or invalid |
