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
   masked except what the plan publishes: the allow-list's labels, the DMARC record labels, policy
   and note, the environment's name and the comments directly under the top level, `allowedNames`,
   `neverTouch` and `dmarc`. A key that is not a plain name (a host or an address written as a key)
   is masked too and never printed. Short numbers (thresholds, grace periods, the roster's timings)
   are protected by never being printed rather than by masking: masking them would also mask the
   tool's own counts (a log's record numbers, a plan's counts), which would show the value. A
   threshold prints as `<threshold:<name>>` and a grace period as `<grace:<name>>` wherever a
   command shows one. `thresholds` and `grace` hold the numbers ops/monitoring's files name
   (`@thresholds.<name>`, `@grace.<name>`; a name may start with a digit, `5xx-rate-api`): a
   threshold is a positive number (a ratio such as `5xx-rate-api` is a fraction; the zone's rate
   rule takes only a whole one), a grace period whole seconds. A number of six digits or
   more (an ID) is masked where it stands on its own: in text, and as a number in a run log record
   or a telemetry line. Pick private names that are not Fin's own
   words (for example an Access team that is not called `fin-next`): a private value is masked
   wherever it appears, Fin's own words included, and the placeholder would then show what it
   stands for. The check refuses an overlay for another environment, a host that is not one label below
   the zone, a host whose label is not on `allowedNames.labels`, a never-touch entry that is not a
   label under the zone (it accepts `legacy`, `legacy.`, `legacy.<zone>` and `@`), a never-touch
   entry written as a wildcard (`*.legacy`: a never-touch label already covers itself and every
   name under it, so write `legacy` instead; read as one name, `*.legacy` would protect nothing
   below it), and an allowed name that is, or sits under, a never-touch label. `cloudflare.zoneId` and `access.allowDomains`
   are optional: the zone's ID is checked against Cloudflare at run time (below), and the domains
   serve the owner's staging decision that Access admits the company domain with a one-time PIN.
   `dmarc.policy`, when present, must equal `email.dmarcPolicy` in `ops/environments/staging.json`,
   which keeps `p=reject` on staging ([BD-17]).
2. Credentials are files too, each readable by its owner only, named by a variable and read inside
   the process: `FIN_CF_TOKEN_FILE` (the Cloudflare operator token), `FIN_RAILWAY_TOKEN_FILE` (the
   Railway project token), `FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE` and
   `FIN_BETTERSTACK_UPTIME_TOKEN_FILE` (the Better Stack team tokens), and
   `FIN_MONITOR_HEADER_FILE` (the secret header every Better Stack monitor sends; `monitoring
   apply` needs it for a real run). Never paste a token on the command line or into a variable.
   `monitoring apply` runs ops/monitoring's own code as a child process and keeps every one of
   these in pnpm fin: the child gets no token, and nothing private in its argv or environment
   (`monitoring-drift.md`).
3. Every command prints names and placeholders only, and the commands that do not need the overlay
   (`log verify`, `log restart`, `lock status`, `lock break`) still mask with it when
   `FIN_OVERLAY_FILE` is set.
4. In GitHub Actions, `pnpm fin` first announces every overlay value and credential (each line of a
   multi-line value on its own) with `::add-mask::` on **standard error**, except values shorter
   than six characters: the runner masks inside words, so a short value would be starred all over
   the job log, which would show it (`pnpm fin` masks those itself, as whole words). Standard output
   carries masked text only, so a step may capture it (a variable, a file, a summary, a comment).
   Never capture standard error: it holds the announced values in clear. Every message is printed
   as one line: a line break, another control character or a Unicode line separator inside it is
   printed as an escape (`\n`, `\u001b`), and a `::` that would start a workflow command (or the
   older `##[` form) is printed with a backslash before it. So no name, argument or provider message
   can switch the runner's command processing off.
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
7. From just before a run takes the lock until it has released it, these close it: Ctrl-C (SIGINT,
   exit 130), SIGTERM (a CI cancel, exit 143), a closed terminal or dropped SSH session (SIGHUP,
   exit 129), a standard output or error that closes under it (a `| head` or a `| less` that quits,
   exit 70), and an error nothing caught (exit 70, with a fixed message). No further change starts.
   The change in flight gets up to three seconds to finish and is recorded as a step if it does
   (not after an uncaught error); a change that waits on a provider (a deploy, a migration) stops
   waiting at once. Then what the run must not leave behind is undone (`static deploy`'s one-run
   token, `railway deploy`'s superuser reference on `migrate`), and `run.done` is written with
   `failed`, `interrupted` (what stopped it) and, when a change had not finished in time, `inFlight`
   naming it (it may have been applied). The lock is released and the lines are kept and shipped.

   All of this takes five seconds at most. A repeated hangup (a closing terminal can send more than
   one) and any second signal within a second of the first belong to the same stop and change
   nothing. A second Ctrl-C or SIGTERM after that, Ctrl-\ (SIGQUIT, exit 131) at any time, and the
   five-second deadline close the run at once instead: the output names anything not yet undone to
   undo by hand, `run.done` is written with `forced` (what cut the wait short) and `inFlight` naming
   the change still in flight, the lock is released, and the process exits; lines not shipped yet
   stay in `lines.jsonl`. Re-run with `--dry-run` to see
   what the interrupted run left undone. Only SIGKILL (and a crash of Node or of the machine)
   leaves a run open; its lock then needs `lock break` (below).

   However a run closes, what its cleanup has not undone is recorded as well as printed, since the
   output may have had no reader (a closed terminal): `run.done` carries `leftover`, what to do by
   hand, and, when the cleanup failed, `cleanupFailed` and its `cleanupError`, masked like every
   field. A `run.leftover` line (level `error`) with the same fields is written just before
   `run.done`'s line, so it is kept in `lines.jsonl` and shipped with it. After a stop nobody saw,
   read the last `run.done` in `runs.jsonl` (`pnpm fin log verify <env>` first) or look for
   `run.leftover` in the `ops` source.

### The allow-list guard (BD-11)

Every Cloudflare write that names a host is checked before it is sent: the name must be under the
overlay's zone, its label on `allowedNames.labels` (`spikeOnly` only with `--spike`, `fallbackOnly`
only with `--fallback`); the apex, `@`, any wildcard, the zone's own `_dmarc` and every name on or
under a `neverTouch` label are refused. Workers route paths are exactly `/*` or `/api/*`. Zone rules
are written only through the per-rule endpoints and only when their `ref` starts with `fin_next_`.
Zone writes go only to the zone ID the guard checked against Cloudflare's own answer. A refusal
exits 77 and sends nothing.

### Railway variable writes: no deploy nobody asked for

The steward's ruling of 22 Nov. Every Railway variable write of every command keeps these:

1. **Provisioning and configuration** writes commit with `skipDeploys: true` and start nothing: the
   service takes them at its next deployment (`railway deploy`).
2. **Rotations** (a secret a running service holds: `email token` replacing a token, `tunnel
   create` making a tunnel anew, `zone apply` making a new ingress proof) commit with
   `skipDeploys: true`, then redeploy each service that has a deployment as a step of the plan
   of its own (`~ update redeploy <service> [<variables>]`, a `run.step` and a
   `rotation.redeployed` line naming the services), wait for `SUCCESS` and read back. The rotation
   is done only then, and only then is an old secret revoked or a rule written that sends the new
   one. Only a service with no deployment holds nothing: it takes the value at its next
   deployment, and nothing is deployed for it. A newest deployment of any status counts as holding
   the old value, `REMOVED` and `REMOVING` included: Railway marks an aborted deployment `REMOVED`
   while the one before it keeps serving, and no read the tooling has confirmed says whether
   anything still runs (`activeDeployments` is in neither Railway's API documentation nor SP-03).
   The plan says so for such a service, and its redeploy starts it again if it was taken down by
   hand. A redeploy is refused when the service is set to an image its newest deployment does not
   run (it would roll that image), and, when that deployment did not end `SUCCESS` (a `railway
   deploy` that failed at the service leaves it set to the failed release's image; an aborted one
   ended `REMOVED`) or Railway does not say which image it runs, unless the service is set to the
   digest the registered deploys recorded for it. The refusal names the service and the command to
   run first (`pnpm fin railway deploy <env>` for the release it should run), and revokes and
   sends nothing. A rotation is decided by what the service holds (`email token` reads `worker`'s
   variables, not only Cloudflare's list), and one left unfinished stays visible to the next run
   (`tunnel create` registers as a rotation, and a later run redeploys until one passes).
3. **Removals**: nothing deletes a variable, since Railway's `variableDelete` takes no
   `skipDeploys` and would start a deployment. A value no deployment may carry is overwritten with
   `inert` (`skipDeploys: true`) and waits for removal: `run.done` records it as
   `awaitingRemoval`, and `railway verify` lists it (`waits for removal`). It is removed only by a
   planned deployment that does not take it.
4. **Read-back**: every commit also sets the plain `FIN_VARIABLES_RUN` to `<run ID>:<n>`. A read
   proves a write only once it shows that marker, each sealed name (with a null value) and each
   plain value as written, read again every 2 seconds for 10 seconds at most; a read that only
   lacks what the write replaced proves nothing, since a read from before the write lacks it too.
   A deployment that should take a write starts only once a read shows it.

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
  and never changes a command's exit code. A line's `release` is the envelope's: the commit of the
  checkout `pnpm fin` ran from. The `deploy.*` lines name the release they deploy
  `deployedRelease`, and the Railway service a step rolled or stopped at `targetService`; search
  for those, not `release` or `service`, to follow a deploy.

### Checking the run log

```sh
node ops/fin/src/main.ts log verify staging
node ops/fin/src/main.ts log verify staging --head <logSeq>:<logHead>
```

The first form checks the chain and the head file and prints the head. The second also checks the
log against a head taken from a line that left the machine: the last `run.done` or `lock.broken`
line in Better Stack's `fin-next-staging-ops` source, or in the job's log.

What exit 1 catches: a line that is not a record; a last line without its newline (a write that
did not finish, even when it left a whole record); an edited or removed line anywhere but the end;
records removed from the end, or the whole log removed, while the head file is intact; and, with
`--head`, any change up to that record, even a rewrite of both the log and the head file. What it
cannot catch on its own: a consistent rewrite of the records after the last head that left the
machine. The chain has no key: it is a tamper signal until the year-locked ops bucket exists, not a
substitute for it. Exit 1 is an incident: someone or something changed the log.

The signal stays until someone acts on it. A mutating run does not start while the log does not
verify (exit 1, before it reads anything; a `--dry-run` still works), and a `lock break` refuses
too (exit 1, the lock left as it is): a stale lock and a damaged log often come together, after a
crash during an append, so the log is restarted first (below). Nothing is appended while the log's
end does not match the head file, or while its last line is not a whole record ending with its
newline (a torn line a crash or a full disk left). Otherwise the next record would chain past the
gap and the log would verify again, or it would be joined onto the torn line and lost. `log verify`
reports every state that stops an append, so whenever a run or a lock break refuses, `log restart`
is the way on.

### The run log does not verify

1. Wake the owner: it is an incident. Keep the state directory as it is until they have looked
   (copy it aside if in doubt), and compare it with the last `run.done` or `lock.broken` head in
   Better Stack's `fin-next-staging-ops` source or the job log (`log verify --head`).
2. Check that no run is in progress (`lock status`, and on that machine, its process).
3. With the owner's go-ahead, start a new log:

   ```sh
   node ops/fin/src/main.ts log restart staging --reason "<what happened>"
   ```

   The broken log and head file stay beside the new one as `runs.broken-<runId>.jsonl` and
   `head.broken-<runId>.json`, unchanged. The new log's first record, `log.restarted`, holds the
   reason, the operator, the problems found, and both heads of the old log: the one its lines give
   and the one its head file gave. A `log.restarted` line carries the same heads off the machine.
   Earlier shipped heads refer to the kept file, not to the new log. The reason follows the same
   rule as a lock break's.
4. Then `lock break` a stale lock if there is one, and re-run the interrupted command with
   `--dry-run` first.

### A stale lock

1. `node ops/fin/src/main.ts lock status staging` shows the holder: run ID, command, start time,
   process and machine.
2. Confirm that run is gone (its process is not running on that machine, and nobody is mid-change).
3. `node ops/fin/src/main.ts lock break staging --reason "<what happened>"`. The reason is one line
   of 8 to 300 characters; name roles, never a host or an ID (it is masked with the overlay when
   `FIN_OVERLAY_FILE` is set, and logged as typed otherwise, with a warning). The break is written
   to the run log with the holder and the reason, and as a `lock.broken` line. It refuses (exit 1)
   while the run log does not verify: follow "The run log does not verify" first.
4. Re-run the interrupted command with `--dry-run` first: every apply reads the current state, so
   the plan shows what the interrupted run left undone.

Wake the owner if the run log's chain is broken, or if a lock is held by a run nobody recognises.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done, or a dry run with nothing to change |
| 1 | a dry run with changes, changes held, drift found by a verify, or a run log that does not verify (a mutating run or a lock break then refuses before it does anything) |
| 64 | usage: an unknown command, flag or environment |
| 65 | bad input data (a release manifest, an artefact) |
| 69 | a provider was unreachable or answered an error |
| 70 | internal error, an uncaught error, or standard output or error closed under the command; a run holding the lock was closed as failed |
| 75 | the run lock is held, or this run lost it |
| 77 | refused by a safety rule; nothing more was sent |
| 78 | the overlay, the settings or a credential file is missing or invalid |
| 129, 130, 131, 143 | interrupted by SIGHUP, SIGINT, SIGQUIT or SIGTERM; the run was closed as failed |
