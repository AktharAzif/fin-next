# Better Stack differs from ops/monitoring

Alert: `monitoring-drift` (the daily dry run, `run.done` `result=drift`).

The command behind this runbook is `pnpm fin monitoring apply staging` (spec 08 §7.11). Until the
root `package.json` gains a `fin` script, run it as `node ops/fin/src/main.ts monitoring apply
staging ...` from the repository root (`pnpm-fin.md`, which also covers the overlay, the credential
files, the run log and the exit codes). Its first recorded run is at the end of this page.

## What it means

`pnpm fin monitoring apply staging --dry-run` found a difference between Better Stack and the
files: someone changed an object by hand, an object was deleted or added (a source or an Errors
application the files do not name included), or Better Stack paused an alert itself (it does so
when a query keeps failing). A dry run that is refused (two objects with one name, a loud object
outside the files, an `ai_sre` member) reports drift too. A silenced alert is as bad as a missing
one.

A real run whose read-back differs is the same thing seen at once: Better Stack did not keep what
the run sent (it answered the write, but reading it back shows something else), or someone changed
it meanwhile. The run exits 1 and its `run.done` is `failed`, with `readBack.mismatched` naming
each object (`<kind>:<name>`).

## First check

1. Run the dry run by hand and read the difference (it prints names, roles and the parts that
   differ, never an ID, a hostname or one of the overlay's numbers: a changed threshold prints
   `value (not shown) -> <threshold:<name>>`).
2. For a paused alert, its `paused_reason` (the dry run's note) and whether its query fails.
3. After a read-back that differs: the lines under `read back:` name each object and the parts that
   differ (`alert clock-skew: differs in value`, `heartbeat watcher: missing`). Run the dry run
   again a minute later: a difference that is gone was a read Better Stack had not caught up with;
   one that stays is Better Stack refusing a field, or someone changing it.

## Containment

1. Re-apply the files: `pnpm fin monitoring apply staging` (deletions and pauses over three need
   `--confirm-delete <count>`; heartbeats are paused, never deleted).
2. A query Better Stack keeps pausing: fix the query in a reviewed change.
3. A field Better Stack will not keep (the read-back differs again on the same part): stop
   applying, and change the files or the apply in a reviewed change; never edit it by hand in
   Better Stack, which the next dry run reports as drift.

## When to wake the owner

If a security alert (`tunnel-connectors`, `static-deployment-changed`,
`cloudflare-config-changed`) was paused or deleted outside a run, or a read-back shows one of them
different after an apply. Other drift can wait.

## What the command does

pnpm fin keeps the run, the credentials and the overlay; ops/monitoring's own code, which pnpm fin
may not import (CI-14), plans and applies. pnpm fin runs ops/monitoring's entry point
(`ops/monitoring/src/apply-cli.ts`) as a child process with no argument and an empty environment,
and talks to it over an IPC channel:

- The team tokens are read by pnpm fin's credential handling from the files
  `FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE` and `FIN_BETTERSTACK_UPTIME_TOKEN_FILE` name
  (`ops/credentials.json`'s `betterstack-team-tokens`), and never leave pnpm fin: each Better Stack
  call the child makes comes to pnpm fin as a message, and pnpm fin sends it to Better Stack's API
  hosts only, with that product's token. A real run also needs `FIN_MONITOR_HEADER_FILE` (the
  secret header every monitor sends); a dry run without it does not compare the header.
- The overlay's hosts, zone, `thresholds` and `grace` go to the child over the channel, never in
  its argv or environment. MA-10 refuses the run, a dry run included, while any key the files name
  (`@thresholds.<key>`, `@grace.<key>`) has no value in the overlay; the refusal names each key.
- A dry run reads and never writes: pnpm fin refuses any write a dry run asks for. A real run takes
  the run lock first, writes `run.registered` (with the plan's counts) only once the plan has passed
  every rule and before the first write, one `run.step` per write Better Stack made, and `run.done`
  with the counts and the read-back. A refused plan, or one with nothing to change, registers
  nothing.
- Staging stays quiet: every alert, monitor and heartbeat must route to `staging-quiet`, and no
  other policy may be defined (monitoring:check's RT-01 first, then the plan's MA-06); anything that
  calls, texts or pushes is refused.
- After a run that wrote anything, everything is read back and compared with the files, as a dry
  run would: `read back: <n> object(s) compared, every one as the files say`, or exit 1 with each
  differing object named.
- Every run, a dry run included, writes one `monitoring.apply` line (names and counts only:
  `outcome`, `drift`, the counts, `readBackCompared`, `readBackMismatched`) to `lines.jsonl`,
  shipped to the `ops` source when `FIN_OPS_INGEST_HOST` and `FIN_OPS_INGEST_TOKEN_FILE` are set.
- The ingest tokens, DSNs and heartbeat URLs Better Stack makes are not delivered to the Railway
  services yet: the run lists each service and variable as not delivered (never the value). Better
  Stack keeps every one, so the run that wires delivery reads them again with `--redeliver`.

Exit codes: 0 done, or a dry run with nothing to change; 1 a dry run with differences, or a
read-back that differs; 69 Better Stack refused a call or did not answer; 77 a rule refused the
plan (monitoring:check, MA-02 to MA-10), nothing written; 78 the overlay or a credential file is
missing or invalid; 75 the run lock is held.

## The first recorded run

Run from a clean checkout of `main` on the operator machine. Before it: the overlay holds the
hosts by role, and the operator's credential files exist, each `chmod 600`:

```sh
export FIN_OVERLAY_FILE=<path to the staging overlay>
export FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE=<path to the Telemetry team token file>
export FIN_BETTERSTACK_UPTIME_TOKEN_FILE=<path to the Uptime team token file>
export FIN_MONITOR_HEADER_FILE=<path to the monitor header file>
```

The `ops` source does not exist before this run, so `FIN_OPS_INGEST_*` stay unset: the run's lines
stay in `lines.jsonl` beside the run log.

1. **Write the overlay keys.** In an editor, the file staying `chmod 600`, add
   `thresholds.auth-endpoint-unlisted` (the identity alert's threshold, spec 02 §18.2) under
   `"thresholds"` with its number. Then run the dry run (step 2) and read every `refused: MA-10 the
   run's settings have no value for <key>` line: add each key the same way, `thresholds.<name>`
   under `"thresholds"` (a ratio such as `5xx-rate-api` is a fraction, everything else a whole
   number) and `grace.<name>` under `"grace"` (whole seconds), until no MA-10 line is left. Then:

   ```sh
   node ops/fin/src/main.ts overlay check staging
   ```

   It proves the overlay is still valid; it prints no number (each shows as
   `<threshold:<name>>` wherever a command shows one).

2. **Dry run.**

   ```sh
   node ops/fin/src/main.ts monitoring apply staging --dry-run --assert-empty-team fin-staging
   ```

   Expect exit 1 (`dry run: nothing changed (differences found)`) and no `refused:` line. It proves
   that the files pass monitoring:check, that every overlay key they name has a value (MA-10), that
   the tokens read the `fin-staging` team (MA-02: `--assert-empty-team` speaks only for a team that
   holds no object at all; once the team holds one, drop it), that nothing routes anywhere but
   `staging-quiet`, and that nothing was written: Better Stack was only read, no run was registered
   and the lock was not taken. Read the plan: `+` lines for what will be made, `~` lines with the
   parts that differ. A refusal about Better Stack's own objects (a default policy that calls,
   MA-06; an `ai_sre` member, MA-08; two objects with one name) is removed or quieted in Better
   Stack's console with the owner's go-ahead, and the dry run repeated.

3. **Apply.**

   ```sh
   node ops/fin/src/main.ts monitoring apply staging --assert-empty-team fin-staging
   ```

   It prints the same plan, then one `created ...` line per object. It proves the writes happened
   inside a registered run: `run.registered` before the first write, one `run.step` for each write
   Better Stack made, and `run.done` at the end.

4. **Read-back.** The apply ends by reading everything back and comparing it with the files:
   `read back: <n> object(s) compared, every one as the files say` and exit 0. That proves Better
   Stack holds exactly what the files say, every object this run made and every one it left alone,
   compared field by field as the dry run compares them. A difference exits 1 instead (see First
   check). The `not delivered` list names the services' secrets waiting for delivery.

5. **Dry run again.**

   ```sh
   node ops/fin/src/main.ts monitoring apply staging --dry-run
   ```

   Expect exit 0 and `dry run: nothing changed`: a fresh read agrees with the files (A08-26,
   AC-P0-32's first part).

6. **Record it.**

   ```sh
   node ops/fin/src/main.ts log verify staging
   ```

   It proves the run log's chain is intact and prints its head. Record in the run's notes the
   time from `date -u`, the commit, the head, the apply's `run.done` (`result: ok`, its `steps`,
   `readBack.compared`, an empty `readBack.mismatched`) and the `monitoring.apply` lines of the
   three runs from `lines.jsonl`: names and counts only, nothing to mask.
