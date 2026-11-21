# The review procedure

fin-review reviews every change with narrow, locked model sessions and decides in code what blocks a
merge (spec 07). This directory is the procedure: the prompts, the checklists, the schemas and the
attack profiles. The engine always reads them from its own copy of the repository, never from the
tree under review, so a pull request cannot change the procedure that judges it.

| File | What it is |
|---|---|
| `prompts/system.md` | Appended to every session's system prompt: the DATA rule (first line, verbatim from spec 07 §4.8), how to work, the output rules, the severities |
| `prompts/lens-<lens>.md` | The question and method of each lens: correctness, security, quality, performance, rules, joins, test-truth, infra, dependency |
| `prompts/attack.md` | The attack pass and its profile table |
| `prompts/sceptic.md`, `prompts/second-look.md` | The sceptic and the second look of §2.9 |
| `checklists/<lens>.md` | Each lens's items (`- **ID** text`); every list has ALL-01 |
| `schema/session-output.schema.json` | A lens, joins or attack session's output (§2.8); the engine narrows `lens`, `profile`, `checked[].item` and `priorBlockers[].id` per session |
| `schema/sceptic-output.schema.json`, `schema/second-look-output.schema.json`, `schema/doctor-output.schema.json` | The other sessions' outputs |
| `attack-profiles.json` | The Phase 0 and Saturday attack profiles and `generic` (§2.7); `prompts/attack.md` shows the same table and a test keeps them equal |
| `exclusions.json` | Files that are never units (§2.5), each only when its bytes are what its name says |
| `injection-patterns.json` | Rule 5's patterns (§2.8): free text in a finding that addresses a reviewer or a model |

## Running it

```
node tools/fin-review/src/main.ts doctor [--live]
node tools/fin-review/src/main.ts pr --pr <n> [--repo <dir>] [--model ... --effort ... --attack-model ... --attack-effort ... --fast] [--advisory]
node tools/fin-review/src/main.ts commit --pr <n> --since <sha> [the same options]
```

Run it from a clean shell: the engine refuses to start (exit 78) while any variable of
`tools/fin-review/config/env-refusals.json` is in its environment, which includes
`ANTHROPIC_BASE_URL` (other than `https://api.anthropic.com`) and `ANTHROPIC_AUTH_TOKEN`.

- **`pr`** reads the pull request's head SHA, its base branch and the repository's default branch
  with `gh api` (nothing else: never a title, body, comment or head branch name), fetches the head,
  the base and the default branch into a bare mirror under `$FIN_REVIEW_HOME/repos/` (default
  `~/.fin-review`; refused inside the repository), and writes the
  head's blobs, by the object IDs of its tree, as `$FIN_REVIEW_HOME/trees/<run-id>`. Nothing is
  checked out, so no `.gitattributes` encoding, filter or line-ending rule and no git configuration
  acts on the tree; it has no `.git`, a symbolic link is a plain file holding its target, and a
  submodule is an empty folder. The units, the import graph and every quote check read the same
  blobs, never the disk. A head the engine cannot show as it is ends the run with exit 65 before
  any session: a path with a control or format character or bytes that are not UTF-8, an empty,
  `.` or `..` segment, a segment a disk reads as `.git`, or two paths (or a path and a folder) that
  a disk ignoring case or Unicode normalisation takes for one; every file is also created
  exclusively, so a fold the check misses still fails closed. The change is everything on the head
  since its merge base with the default branch, and the tiers come from `tools/layout.json` on the
  default branch (spec 07 §2.4), whatever base the pull request names: one stacked on an unmerged
  branch is reviewed with that branch's changes and cannot lower its own tier through it. It plans
  the units (every changed path at the head, chunked past 1,200 lines; see below) and the change's
  tier (the highest of its paths'),
  refuses a gating run below the effort floor (exit 64, `floor_tier_s`) before any session, and runs
  the lenses of that tier (`tools/fin-review/config/lenses.json`), one `joins` pass over the patch,
  and on tier S the attack pass once per mapped profile, at most `maxSessions` (default 8) at once.
- **Units, by content.** A code file (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`,
  `.cjs`) is always a unit, whatever its name or bytes. A path that `exclusions.json` names is left
  out only when its bytes are what the name says (an image or a font by its magic bytes, the pnpm
  lockfile, a source map); a file with a NUL in its first 8,000 bytes is binary; every other file is
  a unit, decoded as UTF-8 with any invalid byte replaced, so one stray byte never takes it out of
  the review. A symbolic link is a unit holding its target, with the target one hop away; a
  submodule is never a unit. Every changed path that is not a unit (deleted, excluded, binary, a
  submodule, missing) is named with its reason in every lens's context, in `plan.json`,
  `result.json` (`notUnits`) and `summary.md`; test-truth also gets the text of every test the
  change deletes. On tier S or N, a binary file that is no image or font, and a submodule, block as a
  file no lens could review; a missing one always does.
- **`commit`** reviews the delta since `--since` (the last reviewed head), and the files that import
  the changed ones. It stays a delta only when spec 07 §2.3.2's conditions hold against the newest
  local, non-advisory `pr` or `commit` run of the same pull request at `--since`; otherwise it runs
  as `pr` and records `escalated`: `no_prior_run`, `not_ancestor`, `base_changed` (the prior run
  was reviewed from another default branch, or from a merge base the current one does not contain),
  `delta_lines` (over 400), `tier_raised`, `new_lens`, `new_profile` or `prior_could_not_check`.
  The delta's own tier picks its lenses, but a tier only goes up along the chain: the floor, the
  budget and the recorded `tier` are the higher of the delta's and the prior run's (`deltaTier`
  records the delta's).
- **Prior blockers.** Every run, `pr` and an escalated `commit` included, carries the blockers left
  open by the newest gating run of the pull request at the head or at one of its ancestors. Each is
  shown again (as `P1`, `P2`, ...) to the lens that found it, and it closes only when that lens marks
  it `fixed` with a `fixWhere` and a `fixQuote` from the same file, the quote within those lines and
  touching a line that changed since the blocker was found. Text that was already there cannot be a
  fix, so a run on an unchanged head, or a quote of an unrelated file, closes nothing; silence keeps
  a blocker open. No sceptic checks a fix claim in this slice.
- **Output.** stdout holds counts only. `$FIN_REVIEW_HOME/runs/<run-id>/` holds `state.json`,
  `plan.json`, each session's settings, MCP config and result, `findings.json` (every candidate,
  invalid ones included with their reasons), `summary.md` (the findings' text; invalid ones are never
  shown), `result.json` and `lines.jsonl` (`review.run`, `review.model_mismatch`, `review.refused`,
  `review.lock_broken`).
- **Exit codes**: 0 no blockers; 1 blockers; 2 could not check (a required lens or profile
  `refused`, `incomplete`, `budget_reached` or `cancelled`, or a sceptic hit a model mismatch or the
  budget); 64 refused options; 65 bad data (a head whose paths cannot be shown as they are); 69
  GitHub or the remote unavailable; 70 internal; 75 the
  pull request's lock is held; 78 the lock-down (environment, configuration, procedure or the pinned
  Claude Code).

## Severities

- **critical**: an actor can move or create money, take over an account, organisation or staff role,
  read another tenant's data or any secret, or run code on Fin's machines; or production data can be
  lost.
- **high**: a server-side guard or required check is missing or can be bypassed under a realistic
  condition; personal data or a credential can leak; a money, ledger or audit invariant can break. A
  missing audit event for an important action is high.
- **medium**: a real wrong outcome on some path without a security or money consequence; a test that
  cannot fail or does not prove what it claims.
- **low**: little consequence: dead code, a misleading name, a small inefficiency, a drifting comment.

## Finding validation (spec 07 §2.8)

In code, before any other session or any person sees a finding: the output matches its schema
(rule 1, the engine's own checker, no library); every `where.path` is a file of the reviewed head
(or of the base, for a deletion) inside what the session was given (its shard's units, their read
tests and one hop; the whole tree for `joins` and `attack`), its lines within the file (rule 2);
every quote is an exact substring of its file after CRLF becomes LF (rule 3); the length caps hold
(rule 4); `checked` names every checklist item, `done` is true, and an item marked `finding` comes
with at least one finding (rule 6). An output that breaks a rule is retried once in a fresh session;
a second failure makes the lens `incomplete`, which blocks. An invalid finding is recorded as
`invalid` and never shown or sent to a sceptic; the valid findings of the same output are kept.

Rule 5: before a sceptic, a second look, a later lens or a person sees a finding, each of its
free-text fields (`title`, `claim`, `scenario`, `testShouldFail`) that matches a pattern of
`injection-patterns.json` is replaced with `[withheld: text addressed to a reviewer]` and the finding
is marked `injectionSuspect`; the finding itself, with its paths, lines and quotes, stays. A sceptic's
or second look's reason is filtered the same way before a second look or a person sees it.

## The verdict table

Every validated finding at medium or above goes to its sceptics as soon as it is validated
(`combine()` in `tools/fin-review/src/review/verdicts.ts`, tested row by row):

| Severity | Verdicts so far | Outcome |
|---|---|---|
| low, medium | CONFIRMED | confirmed |
| low, medium | REFUTED with quoted guards | second look |
| low, medium | UNSURE | a second sceptic on the overall model; UNSURE again is plausible |
| high, critical | both CONFIRMED, or CONFIRMED and UNSURE | confirmed |
| high, critical | both UNSURE | plausible |
| high, critical | one REFUTED with guards, the other CONFIRMED or UNSURE | a third sceptic (overall model): CONFIRMED confirmed, UNSURE plausible, REFUTED with guards a second look |
| high, critical | both REFUTED with guards | second look |

The first sceptic runs on the overall model; the second sceptic of a high or critical finding on the
attack model at the attack effort ([RV-08]). A REFUTED verdict whose guard quotes do not validate
counts as UNSURE. A second look that cannot break the refutation leaves the finding `refuted`; one
that breaks it sends the finding through the table once more (broken twice, it is `plausible`). A
confirmed finding takes the highest severity a confirming sceptic gave, but one reported at medium or
above is never confirmed below medium: a confirmation keeps it in the gate, and only a refutation,
with quoted guards and a second look, takes it out.

**What blocks** (§2.11): a confirmed critical, high or medium finding; a plausible critical or high
finding; a medium or higher finding no sceptic could judge (`unverified`, fail-closed); a
`test-cannot-fail` finding on a tier S path at any severity; a required lens or attack profile that
is not `done`; a changed unit a required lens did not cover, or a changed file no lens could review
(above); a prior blocker not shown fixed.

## The locked session (spec 07 §4)

Each session is one `claude -p` process of the pinned Claude Code (`config/client.json`: 2.1.328,
at least 2.1.321) from `claudePath` in `$FIN_REVIEW_HOME/config.json` (default
`~/.local/bin/claude`), never found through `PATH`, with the prompt on stdin and the reviewed tree as
its working directory. Its model and effort come from `sessionModel(role, options)` and
`checkFloor`; `--fallback-model`, `--bare` and every other flag that could widen a session are never
passed (a test checks every role and every valid option combination).

The flags of spec 07 §4.1 against `claude --help` of 2.1.328 (read on 21 Nov 2026), which the
doctor's D2 re-checks on every run:

| Planned flag | In 2.1.328's --help | Passed |
|---|---|---|
| `-p` | yes | `-p` |
| `--model <modelId>` | yes | the exact model ID |
| `--effort <effort>` | yes | `high`, `xhigh` or `max` |
| `--output-format json` | yes | yes |
| `--json-schema <schema>` | yes | the schema without its top-level `$schema` and `$id` (below) |
| `--settings <file>` | yes | `runs/<run-id>/sessions/<id>/settings.json`, written fresh |
| `--setting-sources ""` | yes | yes: no user, project or local settings |
| `--strict-mcp-config` | yes | yes |
| `--mcp-config <file>` | yes | `runs/<run-id>/sessions/<id>/mcp.json`: `{"mcpServers":{}}` |
| `--tools Read,Grep,Glob` | yes | yes |
| `--disallowedTools ...` | yes | `Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,mcp__*` |
| `--restricted` | yes | yes |
| `--permission-prompts none` | yes | yes |
| `--max-turns <n>` | **no** | **not passed**. The parser accepts it, but it is not documented, so the engine does not rely on it; `--max-budget-usd` and the session timeout (SIGTERM, SIGKILL 10 s later) bound a session, and each session's result records its role's turn cap from `config/budgets.json` |
| `--max-budget-usd <x>` | yes | the role's cap from `config/budgets.json` |
| `--no-session-persistence` | yes | yes |
| `--exclude-dynamic-system-prompt-sections` | yes | yes |
| `--append-system-prompt-file <file>` | **no** | **replaced by `--append-system-prompt`** with the text of `prompts/system.md` (the parser accepts the file form, but it is not documented) |

`--json-schema`: 2.1.328 refuses a schema whose `$schema` names the 2020-12 meta-schema ("no schema
with key or ref"; found by `doctor --live` on 21 Nov 2026). The committed schemas keep their
`$schema`; the runner leaves the top-level `$schema` and `$id` out of the argument, and D2 proves the
CLI accepts every schema the engine passes (it checks the schema before it reads a prompt, so this
costs no model call). The engine still checks every output against the full schema itself.

### Trimmed Phase 0: what differs from spec 07 §4.3 and §4.2

The owner's decision of 21 Nov 2026 trims Phase 0: no `fin-review` OS user, no separate OAuth
token, no signed receipts, no spool, sealing, ledger or CI runs. fin-review runs locally, in agent
sessions on the build machine, as today's merge gate.

- **The session environment** is built from nothing, as §4.3 says, except that sessions run under
  the current user's Claude Code login: `HOME` is the engine's own, and `CLAUDE_CONFIG_DIR` is passed
  on when the engine has it (a scratch home or config directory would drop the login).
  `CLAUDE_CODE_OAUTH_TOKEN` is passed on when the engine has one (the spec's local credential). The
  rest is fixed: `PATH=/usr/bin:/bin`, `LANG=C.UTF-8`, `TMPDIR` a fresh empty
  `$FIN_REVIEW_HOME/scratch/<run>-<session>-a<attempt>/tmp` per attempt (deleted after it),
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`. Nothing else reaches a
  session: no `GITHUB_TOKEN`, no `ACTIONS_ID_TOKEN_REQUEST_*`, no ingest token (a test runs a fake
  `claude` and reads its environment).
- **Settings files**: `--setting-sources ""` (2.1.328 has it) together with `--restricted` keeps
  user, project and local settings out; only the engine's own `--settings` file and the managed
  settings apply. Observed on 2.1.328 on 21 Nov 2026 with two probe sessions: a `CLAUDE.md` planted in
  the reviewed tree was not loaded with these flags, and was loaded without them.
- **Deny rules**: the tree lies under the real home, so `Read(~/**)` and `Read(<home>/**)` would deny
  the tree itself. They are replaced, as §4.2 allows, by explicit denies of every entry beside the
  path from the home to the tree, level by level, and likewise inside `$FIN_REVIEW_HOME` (other
  runs' trees, `runs/`, `state/`, `scratch/`, `ledger/` and the mirrors in `repos/`).
- **Refusal of settings files** (§4.3's second half, the doctor's D3) comes with the full doctor;
  this slice refuses the engine's own environment only.
- **No receipts**: `pr` reads no coverage from a receipt chain, so it reviews every unit of the
  patch; `commit`'s last reviewed head is `--since` and its local run record, not a signed receipt;
  the open blockers every run carries come from the same local records.
  Run records live in `$FIN_REVIEW_HOME`, which any process of the same user can write; with no
  separate OS user, that is the trust the trimmed phase has.
- **Not yet in this slice**: de-duplication (§2.8); sceptics for low findings (lows are recorded `unverified` and never block); sibling sessions
  (§2.10); the dependency approval of §2.11 rule 5; reading the effort back (`effortObserved` is
  always `null`, so the effort is as requested).

## The doctor

`doctor` runs D1 (the version equals the pin), D2 (every runner flag is in `--help`, and the CLI
accepts every schema), D4 (no refused variable in the engine's environment) and, with `--live`, D5:
one locked session per model at effort `high` with a 0.50 USD budget, asked "Reply with the word
ready.", whose `modelUsage` must name only that model ID. It writes `$FIN_REVIEW_HOME/state/doctor.json`
and exits 0 when every check it ran passed, else 78.

**Result on 21 Nov 2026 (build machine, Claude Code 2.1.328)**, run as
`env -i HOME=... PATH=... CLAUDE_CONFIG_DIR=... node tools/fin-review/src/main.ts doctor --live`:

| Check | Result |
|---|---|
| D1 | pass: claude 2.1.328 equals the pin (minimum 2.1.321) |
| D2 | pass: all 17 runner flags are in --help; `--max-turns` and `--append-system-prompt-file` replaced; `--json-schema` accepts all 14 schemas |
| D4 | pass from a clean shell; **fail** from the agent session's own environment, which sets `ANTHROPIC_BASE_URL` (a loopback gateway) and `ANTHROPIC_AUTH_TOKEN` |
| D5 | **fail** for both `claude-opus-5-5` and `claude-fable-5-2`: "Not logged in · Please run /login" |

D5 fails because the machine's only Claude Code login for that user is an `env` block in the user
settings that sets a loopback `ANTHROPIC_BASE_URL` and an `ANTHROPIC_AUTH_TOKEN`: another endpoint and
another credential, both refused by [RV-19], and kept out of locked sessions by `--setting-sources ""`
and `--restricted`. Until the owner gives fin-review a first-party login (a `claude setup-token`
token exported as `CLAUDE_CODE_OAUTH_TOKEN` in the shell that runs the engine, or `claude auth login`
in the configuration directory it uses), no locked session can start on this machine, and every
`pr` or `commit` run ends `could_not_check` (exit 2). Before the field names of a successful result
were known from the doctor, two probe sessions outside the engine (through the agent's own login, on
21 Nov 2026) recorded them: `type`, `subtype`, `is_error`, `result`, `stop_reason`,
`terminal_reason`, `api_error_status`, `total_cost_usd`, `usage`, `modelUsage` (keyed by the exact
model ID: `claude-opus-5-5`, `claude-fable-5-2`), `structured_output`, `num_turns`, `duration_ms`,
`fast_mode_state`, `permission_denials`, `session_id` and `uuid`.
