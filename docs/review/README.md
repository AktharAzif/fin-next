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
`ANTHROPIC_BASE_URL` (other than `https://api.anthropic.com`) and `ANTHROPIC_AUTH_TOKEN`. The one
exception is the pool transport (decision BD-22, `tools/fin-review/src/transport.ts`), for a
machine where Claude Code reaches Claude through a local pool forwarder: with
`FIN_REVIEW_TRANSPORT=pool` in the engine's own environment (never an option or a request), exactly
`ANTHROPIC_BASE_URL` (http or https to `127.0.0.1`, `[::1]` or `localhost`, an explicit port, no
path beyond `/`), `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CONFIG_DIR` are accepted and passed into each
session in place of the login; every other model, effort, provider and credential variable is still
refused, the modelUsage check still decides which model ran, and every record says
`transport: "pool"` (`"direct"` otherwise). `tools/fin-review/README.md` shows how to start it.

Run it from a clean checkout of the default branch: a pull request is never judged by its own
procedure (spec 07 §0.3). A gating `pr` or `commit` is refused (exit 78, `engine_not_default`)
unless the checkout the engine runs from has no change, untracked or ignored file under
`tools/fin-review`, `docs/review`, `AGENTS.md` and `CONTRIBUTING.md`, and holds there exactly what
the default branch holds; `--advisory` runs anyway and is recorded as advisory. What is compared is
what the engine runs, not git's view of it: every file under those paths is hashed on the disk as a
git blob (no git, filter or configuration involved) and compared with the commit; an index entry
git would not compare with the disk (assume-unchanged, skip-worktree) is refused; `git status` runs
with its stat checks at full strength; and the bytes the engine loaded from `config/` and
`docs/review/` are compared with the commit's, so a file changed and put back between load and
check is caught too. The rules lens gets `AGENTS.md` and `CONTRIBUTING.md` from those verified
bytes. (The engine's own modules are checked on the disk only: what Node loaded cannot be hashed
from inside it.) Until fin-review is on the default branch, every run is advisory. Every record
holds `engine`: the engine's commit, the procedure hash of §4.8 (the SHA-256 of the sorted
`<path> <blob id>` lines of every file under `docs/review/` and `tools/fin-review/config/`, from
the bytes on the disk) and whether it was the default branch's engine copy.

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
  branch is reviewed with that branch's changes and cannot lower its own tier through it. Tiers are
  counted exactly as `plan` counts them (one function, `changeTiers` in `src/plan/plan.ts`): tier D
  only for a documentation file (a file under a D folder that is not one counts as S), a changed
  symbolic link or submodule at tier S, a path a link on the head, the default branch or a merge
  base reaches also at the link's path, and tier S for a head with several merge bases (the change is
  then the union of the diffs since each) or a link reach that cannot be bounded. It plans
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
  change deletes. On tier S or N, a binary file and a submodule block as a file no lens could review;
  a missing one always does. Only a file excluded by its name and its bytes (an image or font
  extension whose bytes are laid out as that format, the lockfile, a source map) is exempt: a binary
  file whose first bytes merely look like an image or a font blocks like any other.
- **`commit`** reviews the delta since `--since` (the last reviewed head), and the files that import
  the changed ones. It stays a delta only when spec 07 §2.3.2's conditions hold against the newest
  local, non-advisory `pr` or `commit` run of the same pull request at `--since`; otherwise it runs
  as `pr` and records `escalated`: `no_prior_run`, `not_ancestor`, `procedure_changed` (another
  procedure hash), `base_changed` (the prior run was reviewed from another default branch, or from
  a merge base the current one does not contain),
  `delta_lines` (over 400), `tier_raised`, `new_lens`, `new_profile`, `prior_could_not_check`,
  `history_ambiguous` (the head has several merge bases with the default branch) or `prior_gap` (the
  run at `--since` left a blocker that is no finding open: a changed path no lens could review, or a
  lens that was not done; no delta can show it gone, so only a full review can).
  The delta's own tier picks its lenses, but a tier only goes up along the chain: the floor, the
  budget and the recorded `tier` are the higher of the delta's and the prior run's (`deltaTier`
  records the delta's).
- **Prior blockers.** Every run, `pr` and an escalated `commit` included, carries the blockers left
  open by the newest gating run of the pull request at the head or at one of its ancestors. Each is
  shown again (as `P1`, `P2`, ...) to the lens that found it, and it closes only when that lens marks
  it `fixed` with a `fixWhere` and a `fixQuote` from the same file, that file one the blocker itself
  names (or that file renamed since, found with git's rename detection), the quote within those lines
  and touching a line that changed since the blocker was found (compared with the file before its
  rename, so a file moved as it was has no changed line). Text that was already there cannot be a
  fix, so a run on an unchanged head, a changed line of another file, or the same text moved to a
  new file closes nothing; silence keeps a blocker open. A claim counts only in an output the engine
  accepted whole: a lens that ended `incomplete` closes nothing, though its valid findings still
  count. No sceptic checks a fix claim in this slice.
- **Output.** stdout holds counts only. `$FIN_REVIEW_HOME/runs/<run-id>/` holds `state.json`,
  `plan.json`, each session's settings, MCP config and result, `findings.json` (every candidate,
  invalid ones included with their reasons), `summary.md` (the findings' text; invalid ones are never
  shown), `result.json` and `lines.jsonl` (`review.run`, `review.model_mismatch`, `review.refused`,
  `review.lock_broken`).
- **Exit codes**: 0 no blockers; 1 blockers; 2 could not check (a required lens or profile
  `refused`, `incomplete`, `budget_reached` or `cancelled`, or a sceptic hit a model mismatch or the
  budget); 3 advisory (below); 64 refused options; 65 bad data (a head whose paths cannot be shown
  as they are); 69 GitHub or the remote unavailable; 70 internal; 75 the pull request's lock is
  held; 78 the lock-down (environment, transport, settings files, configuration, procedure, the engine copy or
  the pinned Claude Code). A session whose prompt would pass the runner's 4 MB cap (one unit that is
  never cut, such as a large JSON file) is not started; its lens is `incomplete`, so the run records
  that it could not check.
- **Advisory runs** (`--advisory`: below the effort floor, or without the default branch's engine
  copy) are never a gate result: they exit 3 whatever they find, `result.json` says
  `result: "advisory"` with what they found in `outcome`, stdout says `advisory (<outcome>; not a
  gate result)`, and no later `commit` takes one as its last reviewed head. Exit 3 is this slice's
  addition to spec 07 §2.1's table, which defines 0 and 1 by a receipt an advisory run never writes.

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
  the current user's Claude Code login: `HOME` is the engine's own (a scratch home would drop the
  login). `CLAUDE_CONFIG_DIR` is never passed: `config/env-refusals.json` refuses it, so the engine
  does not start with it set, and a session's configuration is always `$HOME/.claude`, which the
  home's sibling denies cover. `CLAUDE_CODE_OAUTH_TOKEN` is passed on when the engine has one (the
  spec's local credential). The
  rest is fixed: `PATH=/usr/bin:/bin`, `LANG=C.UTF-8`, `TMPDIR` a fresh empty
  `$FIN_REVIEW_HOME/scratch/<run>-<session>-a<attempt>/tmp` per attempt (deleted after it),
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`. Nothing else reaches a
  session: no `GITHUB_TOKEN`, no `ACTIONS_ID_TOKEN_REQUEST_*`, no ingest token (a test runs a fake
  `claude` and reads its environment). Under the pool transport the session gets exactly
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CONFIG_DIR` in place of the login (and
  never `CLAUDE_CODE_OAUTH_TOKEN`), so its configuration is the forwarder's folder, which the deny
  rules cover and which may not hold `$FIN_REVIEW_HOME`; the result records the forwarder's
  `host:port` as its API host.
- **Settings files**: `--setting-sources ""` (2.1.328 has it) together with `--restricted` keeps
  user, project and local settings out; only the engine's own `--settings` file and the managed
  settings apply. Observed on 2.1.328 on 21 Nov 2026 with two probe sessions: a `CLAUDE.md` planted in
  the reviewed tree was not loaded with these flags, and was loaded without them.
- **Deny rules**: the tree lies under the real home, so `Read(~/**)` and `Read(<home>/**)` would deny
  the tree itself. They are replaced, as §4.2 allows, by explicit denies of every entry beside the
  path from the home to the tree, level by level, and likewise inside `$FIN_REVIEW_HOME` (other
  runs' trees, `runs/`, `state/`, `scratch/`, `ledger/` and the mirrors in `repos/`).
- **Refusal of settings files** (§4.3's second half): before any session, `pr`, `commit` and the
  doctor's D3 read every settings and configuration source the pinned client could read for a
  session, and refuse (exit 78, `settings_refused`, file and key names only) one that sets a key
  `config/env-refusals.json` refuses, any `env` block, or a widened permission, or that cannot be
  read, converted or parsed. The session's configuration folder is `$HOME/.claude` under the direct
  transport and `$CLAUDE_CONFIG_DIR` under pool. The sources, as 2.1.328 itself names them:
  - the user settings, `settings.json` in that folder (under pool its `env` may set only the pool's
    own `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, to the very values the session gets);
  - the global configuration, `$HOME/.claude.json` (direct) or `$CLAUDE_CONFIG_DIR/.claude.json`
    (pool), and the legacy `.config.json` in the folder: the client applies their `env` to itself at
    start whatever `--setting-sources` says, so a non-empty `env` there, or a key §4.3 refuses, is
    refused (the client's own state in the file is not held to the settings allowlist);
  - `remote-settings.json` in the folder, the client's cache of server-managed settings, which the
    engine cannot check, so it is refused; server-managed settings not cached cannot be read
    locally at all, and D3 reports them as unknown;
  - the managed settings, `managed-settings.json` and every `.json` in `managed-settings.d/` under
    `/Library/Application Support/ClaudeCode` (macOS) or `/etc/claude-code` (Linux), and on macOS the
    managed-preferences plists `/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist`
    and `/Library/Managed Preferences/com.anthropic.claudecode.plist`, converted with
    `/usr/bin/plutil -convert json` as the client converts them;
  - on Windows the client reads the policy keys `HKLM` and `HKCU\SOFTWARE\Policies\ClaudeCode`, and
    under WSL the Windows side's managed settings and keys too; the engine cannot read those, so it
    refuses to run there.

  `--setting-sources ""` already keeps user settings out of a session; this is the second layer,
  and the only one for the global configuration's `env` and the managed settings. A machine whose
  user settings carry a gateway's `env` block therefore cannot run gating reviews as that user
  under the direct transport.
- **The pinned client**: `claudePath` (default `~/.local/bin/claude`) is usually a link an updater
  re-points. A run resolves it once to the file it names, checks that file's version against the
  pin, starts every session from that file, and refuses an attempt when the file is no longer the
  one it checked (its device, inode, size or times changed).
- **Programs and folders**: `git` and `gh` come only from absolute PATH folders outside the
  repository under review and the engine's checkout, whatever folder a call runs in, and every git
  call runs with the same fixed prefix and an environment less `GIT_*`. `$FIN_REVIEW_HOME` is refused
  inside the repository under review or the engine's repository however it is spelled (decided on
  the disk, links and case included), by `doctor` too, before anything under it is read. Its
  `config.json` (default `~/.fin-review/config.json`) is the one file for `claudePath`,
  `maxSessions` and the machine's option defaults, which are validated whether or not the variable
  is set.
- **No receipts**: `pr` reads no coverage from a receipt chain, so it reviews every unit of the
  patch; `commit`'s last reviewed head is `--since` and its local run record, not a signed receipt;
  the open blockers every run carries come from the same local records.
  Run records live in `$FIN_REVIEW_HOME`, which any process of the same user can write; with no
  separate OS user, that is the trust the trimmed phase has.
- **Not yet in this slice**: de-duplication (§2.8); sceptics for low findings (lows are recorded `unverified` and never block); sibling sessions
  (§2.10); the dependency approval of §2.11 rule 5; reading the effort back (`effortObserved` is
  always `null`, so the effort is as requested).

## The doctor

`doctor` runs D1 (the version of the file `claudePath` names equals the pin), D2 (every runner flag
and the doctor's own `--debug-file` is in `--help`, and the CLI accepts every schema; the schemas are
not probed while a settings or configuration source is refused), D3 (no settings or configuration
source a session could read sets a refused key, as above; then the pinned client, started with the
locked argument list, the session environment of the transport and an empty stdin, so it stops
before any model call, must report in its `--debug-file` log that it took no `env` from its global
configuration or its user settings (`globalEnv keys` and `settingsEnv keys` empty); server-managed
settings are recorded as unknown), D4 (the transport, and no refused variable in the engine's
environment; the doctor reports it here instead of being refused at the start) and, with `--live`,
D5: one locked session per model through the transport at effort `high` with a 0.50 USD budget,
asked "Reply with the word ready.", whose `modelUsage` must name only that model ID. D5 never starts
when another check failed. It writes `$FIN_REVIEW_HOME/state/doctor.json` (with `transport`) and
exits 0 when every check it ran passed, else 78.

**Result on 21 Nov 2026 (build machine, Claude Code 2.1.328)**, run as
`env -i HOME=... PATH=... CLAUDE_CONFIG_DIR=... node tools/fin-review/src/main.ts doctor --live`,
before D3 existed and before `CLAUDE_CONFIG_DIR` was refused (both now end such a run with 78 on
that machine, whose user settings carry the gateway's `env` block):

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
token exported as `CLAUDE_CODE_OAUTH_TOKEN` in the shell that runs the engine) and runs it as a user
whose `~/.claude/settings.json` holds no refused key, no gating run could start on this machine.
The pool transport (decision BD-22, above) is the answer for the trimmed phase: the forwarder's
three variables, checked, reach the sessions, and nothing else does. On 21 Nov 2026 D3's probe was
run by hand against 2.1.328 on that machine, both as `direct` and as `pool`: the client stopped at
"Input must be provided" with no model call, and its log read `globalEnv keys: , settingsEnv keys:
none`, the clean answer D3 requires. Before the field names of a successful result
were known from the doctor, two probe sessions outside the engine (through the agent's own login, on
21 Nov 2026) recorded them: `type`, `subtype`, `is_error`, `result`, `stop_reason`,
`terminal_reason`, `api_error_status`, `total_cost_usd`, `usage`, `modelUsage` (keyed by the exact
model ID: `claude-opus-5-5`, `claude-fable-5-2`), `structured_output`, `num_turns`, `duration_ms`,
`fast_mode_state`, `permission_denials`, `session_id` and `uuid`.
