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
   a placeholder (`<zone>`, `<host:admin>`, `<overlay:cloudflare.accountId>`). Every value is
   masked, numbers included (thresholds, grace periods, the roster's timings), except what the plan
   publishes: the allow-list's labels, the DMARC record labels, policy and note, the environment's
   name and the comments directly under the top level, `allowedNames`, `neverTouch` and `dmarc`. A
   key that is not a plain name (a host or an address written as a key) is masked too and never
   printed. The check refuses an overlay for another environment, a host that is not one label below
   the zone, a host whose label is not on `allowedNames.labels`, a never-touch entry that is not a
   label under the zone (it accepts `legacy`, `legacy.`, `legacy.<zone>` and `@`), and an allowed
   name that is, or sits under, a never-touch label. `cloudflare.zoneId` and `access.allowDomains`
   are optional: the zone's ID is checked against Cloudflare at run time (below), and the domains
   serve the owner's staging decision that Access admits the company domain with a one-time PIN.
   `dmarc.policy`, when present, must equal `email.dmarcPolicy` in `ops/environments/staging.json`,
   which keeps `p=reject` on staging ([BD-17]).
2. Credentials are files too, each readable by its owner only, named by a variable and read inside
   the process: `FIN_CF_TOKEN_FILE` (the Cloudflare operator token), `FIN_RAILWAY_TOKEN_FILE` (the
   Railway project token), `FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE` and
   `FIN_BETTERSTACK_UPTIME_TOKEN_FILE`. Never paste a token on the command line or into a variable.
3. Every command prints names and placeholders only, and the commands that do not need the overlay
   (`log verify`, `lock status`, `lock break`) still mask with it when `FIN_OVERLAY_FILE` is set.
4. In GitHub Actions, `pnpm fin` first announces every overlay value and credential (each line of a
   multi-line value on its own) with `::add-mask::` on **standard error**. Standard output carries
   masked text only, so a step may capture it (a variable, a file, a summary, a comment). Never
   capture standard error: it holds the announced values in clear.
5. Run from a clean checkout. A run from a checkout with local changes is recorded as `dirty` in
   `run.registered` (and warned about), because the commit alone then does not say what ran.

## What a mutating command does

1. Without `--dry-run`, it takes the run lock first, before it reads anything, so no other run can
   change the provider between its reads and its writes (a held lock exits 75 at once). A dry run
   takes no lock.
2. Reads the provider's current state (read-only calls) and builds the plan. A Cloudflare command
   first reads the zone and checks that it is the overlay's zone in the overlay's account; until it
   has, the guard refuses every zone write.
3. Prints the plan: `+` create, `~` update with the fields that differ, `-` delete, `=` unchanged,
   `!` held (reported, not applied, with the reason).
4. With `--dry-run` it stops there: exit 0 when nothing differs, 1 when something would change.
5. Otherwise it writes `run.registered` (the operator, the command, its arguments and flags, the
   commit, whether the checkout was dirty, the plan) and ships that line, sends each change after
   the allow-list guard has passed it (one `run.step` each), and writes `run.done` with the result:
   `ok`, `refused` (a safety rule stopped it, exit 77) or `failed`. A run applies one plan. A plan
   with nothing to change leaves no record.
6. A plan that deletes anything is refused unless `--confirm-delete <n>` names exactly the number of
   deletions.
7. Ctrl-C or SIGTERM while a run holds the lock closes it: `run.done` with `failed` and
   `interrupted by <signal>`, the lock released, the lines kept and shipped, then exit 130 or 143.
   A second Ctrl-C exits at once. Re-run with `--dry-run` to see what the interrupted run left
   undone.

### The allow-list guard (BD-11)

Every Cloudflare write that names a host is checked before it is sent: the name must be under the
overlay's zone, its label on `allowedNames.labels` (`spikeOnly` only with `--spike`, `fallbackOnly`
only with `--fallback`); the apex, `@`, any wildcard, the zone's own `_dmarc` and every name on or
under a `neverTouch` label are refused. Workers route paths are exactly `/*` or `/api/*`. Zone rules
are written only through the per-rule endpoints and only when their `ref` starts with `fin_next_`.
Zone writes go only to the zone ID the guard checked against Cloudflare's own answer. A refusal
exits 77 and sends nothing.

## The run log and the run lock (interim, until the R2 vault exists)

The plan keeps registrations in the `fin-next-staging-ops` bucket and the lock in
`fin-next-staging-state`. Until `pnpm fin vault create` lands, both live on the operator's machine
under `FIN_STATE_DIR` (default `~/.local/state/fin-next/<env>/`):

- `runs.jsonl`: append-only, one masked record per line, each carrying the SHA-256 of the line
  before it.
- `head.json`: the log's head, the last record's seq and the SHA-256 of its line. The same head is
  on every `run.registered`, `run.done` and `lock.broken` line (`logSeq`, `logHead`), which the
  Actions log and the `fin-next-staging-ops` source keep off this machine.
- `lock.json`: the run lock, taken with an exclusive create. A second run exits 75 and names the
  holder. A run whose lock was broken and taken by another run stops writing (exit 75), and leaves
  the other run's lock alone.
- `lines.jsonl`: the runs' telemetry lines (spec 08 §7.2's envelope, service `ops`), written as
  they happen. They are also shipped to the `fin-next-staging-ops` source when
  `FIN_OPS_INGEST_HOST` and `FIN_OPS_INGEST_TOKEN_FILE` are set; a shipping problem is a warning
  and never changes a command's exit code.

### Checking the run log

```sh
node ops/fin/src/main.ts log verify staging
node ops/fin/src/main.ts log verify staging --head <logSeq>:<logHead>
```

The first form checks the chain and the head file and prints the head. The second also checks the
log against a head taken from a line that left the machine: the last `run.done` or `lock.broken`
line in Better Stack's `fin-next-staging-ops` source, or in the job's log.

What exit 1 catches: a line that is not a record; an edited or removed line anywhere but the end;
records removed from the end, or the whole log removed, while the head file is intact; and, with
`--head`, any change up to that record, even a rewrite of both the log and the head file. What it
cannot catch on its own: a consistent rewrite of the records after the last head that left the
machine. The chain has no key: it is a tamper signal until the year-locked ops bucket exists, not a
substitute for it. Exit 1 is an incident: someone or something changed the log.

### A stale lock

1. `node ops/fin/src/main.ts lock status staging` shows the holder: run ID, command, start time,
   process and machine.
2. Confirm that run is gone (its process is not running on that machine, and nobody is mid-change).
3. `node ops/fin/src/main.ts lock break staging --reason "<what happened>"`. The reason is one line
   of 8 to 300 characters; name roles, never a host or an ID (it is masked with the overlay when
   `FIN_OVERLAY_FILE` is set, and logged as typed otherwise, with a warning). The break is written
   to the run log with the holder and the reason, and as a `lock.broken` line.
4. Re-run the interrupted command with `--dry-run` first: every apply reads the current state, so
   the plan shows what the interrupted run left undone.

Wake the owner if the run log's chain is broken, or if a lock is held by a run nobody recognises.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done, or a dry run with nothing to change |
| 1 | a dry run with changes, changes held, drift found by a verify, or a run log that does not verify |
| 64 | usage: an unknown command, flag or environment |
| 65 | bad input data (a release manifest, an artefact) |
| 69 | a provider was unreachable or answered an error |
| 70 | internal error |
| 75 | the run lock is held, or this run lost it |
| 77 | refused by a safety rule; nothing more was sent |
| 78 | the overlay, the settings or a credential file is missing or invalid |
| 130, 143 | interrupted by SIGINT or SIGTERM; the run was closed as failed |
