# fin-review

The review engine (spec 07): the R11 options and their validator, the session roles, the effort
floor and the CI planner; the locked local review sessions, the `pr` and `commit` review modes and
the minimal doctor. It imports only `node:` built-ins, so it runs from a sparse checkout with no
install:

```
node tools/fin-review/src/main.ts help
node tools/fin-review/src/main.ts options [--model opus|fable] [--effort high|xhigh|max]
    [--attack-model opus|fable] [--attack-effort high|xhigh|max] [--fast] [--tier S|N|D [--advisory]]
node tools/fin-review/src/main.ts plan --base <sha> --head <sha> [--tree <dir>]
node tools/fin-review/src/main.ts plan --ci [--tree <dir>] [--output "$GITHUB_OUTPUT"]
node tools/fin-review/src/main.ts pr --pr <n> [--repo <dir>] [R11 options] [--advisory]
node tools/fin-review/src/main.ts commit --pr <n> --since <sha> [--repo <dir>] [R11 options] [--advisory]
node tools/fin-review/src/main.ts doctor [--live]
```

`pr`, `commit` and `doctor` are described in `docs/review/README.md`, with the session lock-down,
the flags of the pinned Claude Code, the trimmed Phase 0's deviations and the doctor's last result.
The code: `src/runner/` (the session runner: `types.ts`, `cli.ts`, `settings.ts`, `env.ts`,
`check.ts`, `client.ts`, and `fake.ts` for tests), `src/review/` (`run.ts` the modes, `findings.ts`
validation, `verdicts.ts` the verdict table, `prompts.ts`, `procedure.ts`, `lenses.ts`, `attack.ts`,
`schema.ts`, `repo.ts`, `lock.ts`, `pool.ts`, `report.ts`, `commands.ts`), `src/units/`,
`src/plan/graph.ts` (one hop), `src/shard.ts`, `src/budget.ts`, `src/gh.ts`, `src/home.ts`,
`src/clock.ts` and `src/doctor.ts`. The configuration adds `config/client.json` (the pin),
`config/budgets.json` ([RV-13]'s provisional caps) and `config/lenses.json` (the lenses per tier).

Every option takes `--name value` or `--name=value`. A refused option prints
`fin-review: refused: <code>: <message>` on stderr and exits 64 before anything else happens; an
invalid file under `config/` makes every command exit 78 (spec 07 §2.1 lists every exit code).

## Options (R11, spec 07 §3)

| Option | Values | Default |
|---|---|---|
| `--model` | `opus`, `fable` | `opus` |
| `--effort` | `high`, `xhigh`, `max` | `xhigh` |
| `--attack-model` | `opus`, `fable` | `fable` |
| `--attack-effort` | `high`, `xhigh`, `max` | `high` |
| `--fast` | flag (Opus sessions only) | off |

Fable overall with an Opus attack is refused; Opus overall with a Fable attack is allowed, so 27
of the 36 combinations are valid. Values are compared exactly: no trimming, no case folding, no
aliases, no model IDs. The same validator (`src/options.ts`) reads the CLI, `config/defaults.json`,
`$FIN_REVIEW_HOME/config.json`'s `options`, CI inputs (strings), spool requests and receipts.

`attack` and `sceptic2` run on the attack model and effort; every other reviewing role runs on the
overall ones (`src/roles.ts`). [RV-06]'s floor (`config/floor.json`) refuses `--effort high` for a
tier S gating run (`floor_tier_s`); `options --tier S --effort high --advisory` shows what an
advisory run would do.

## plan (spec 07 §2.3.1, §10.1)

`plan` reads `git diff --name-status -z -M50 <base>...<head>`, counts a rename or copy at both its
paths, takes each path's tier from `tools/layout.json` as it is at the base (so a pull request
cannot lower its own tier), maps each path to its CI classes (`config/ci-map.json`) and prints one
line of JSON:

```json
{"v":1,"event":"pull_request","base":"<sha>","head":"<sha>","tier":"S","changed":3,
 "classes":["server"],"everything":false,"reason":"classes",
 "jobs":{"check":true,"db":false,"build":true,"seams":true,"e2e":true,"e2e_shards":4,
         "static":true,"bun":true,"containers":false},
 "e2e":{"apps":["console","admin"],"shards":4},"packages":["@fin/console","@fin/core"],
 "images":["fin-next-console"],"static":["console"],"layout":"ok"}
```

`everything` is true, with `reason`, for any global input (`global`), a path no class maps
(`unmapped`), a folder under `apps/` or `packages/` that is no package or an unreadable manifest
(`workspace`), a missing or invalid `tools/layout.json` (`layout`), and every event but
`pull_request` (`event`: a push to `main`, `workflow_dispatch`, `schedule`). `check` and `static`
always run. `e2e.apps` names the web apps under `apps/` whose e2e projects run. The affected
packages come from each `package.json`'s `workspace:` dependencies at the base and at the head.

## Tests

`node --test "test/**/*.test.ts"` (or `pnpm test` here) runs the whole suite in a few seconds. It
needs `git` on `PATH`; the fixtures are built with `git fast-import` in temporary directories.
