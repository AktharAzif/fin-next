# fin-review

The review engine (spec 07). This first part holds the R11 options and their validator, the
session roles, the effort floor and the CI planner. It imports only `node:` built-ins, so it runs
from a sparse checkout with no install:

```
node tools/fin-review/src/main.ts help
node tools/fin-review/src/main.ts options [--model opus|fable] [--effort high|xhigh|max]
    [--attack-model opus|fable] [--attack-effort high|xhigh|max] [--fast] [--tier S|N|D [--advisory]]
node tools/fin-review/src/main.ts plan --base <sha> --head <sha> [--tree <dir>]
node tools/fin-review/src/main.ts plan --ci [--tree <dir>] [--output "$GITHUB_OUTPUT"]
```

Every option takes `--name value` or `--name=value`. A refused option prints
`fin-review: refused: <code>: <message>` on stderr and exits 64 before anything else happens; an
invalid file under `config/` makes every command exit 78 (spec 07 §2.1 lists every exit code).
Every command but `plan` and `help` also exits 78 (`environment_refused`) when its environment holds
a variable `config/env-refusals.json` refuses (spec 07 §3.5, §4.3): the names of §4.3's table and the
others the pinned Claude Code reads that change the model, effort, endpoint, credential or settings
source, and their families by pattern (every `ANTHROPIC_*` name but the CI federation inputs, every
`CLAUDE_CODE_USE_*`, `*_BASE_URL`, `*_PROXY`, `*_API_KEY`, `*_AUTH_TOKEN`, `*_MODEL`, effort,
thinking and fallback name, and `NODE_*`, `BUN_*`, `SSL_CERT_*`). `checkSettings` refuses any
settings key not listed as harmless, any `env` entry, and any `permissions` entry that would widen
spec 07 §4.2's grant.

Every line printed from data the engine read (a path, a package name, a JSON key, a program's
message) is escaped to printable ASCII, so it can start neither a terminal control sequence nor a
line that a CI log reads as a workflow command.

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

`plan` finds the merge base of `<base>` and `<head>` and reads `git diff --raw -z -M50` from it to
the head (the merge-base diff, with each side's mode), counts a rename or copy at both its paths,
takes each path's tier from `tools/layout.json` as it is at the base (so a pull request cannot
lower its own tier), maps each path to its CI classes (`config/ci-map.json`) and prints one line of
JSON:

```json
{"v":1,"event":"pull_request","base":"<sha>","head":"<sha>","tier":"S","changed":3,
 "classes":["server"],"everything":false,"reason":"classes",
 "jobs":{"check":true,"db":false,"build":true,"seams":true,"e2e":true,"e2e_shards":4,
         "static":true,"bun":true,"review":false,"selfTest":false,"containers":false},
 "e2e":{"apps":["console","admin"],"projects":["console-desktop","console-phone","...","admin-webkit"],
        "shards":4},
 "packages":["@fin/console","@fin/core"],"images":["fin-next-console"],"static":["console"],"layout":"ok"}
```

`everything` is true, with `reason`, for every event but `pull_request` (`event`: a push to `main`,
`workflow_dispatch`, `schedule`); a base and head with no single merge base (`history`: criss-cross
merges or unrelated histories, planned against every merge base, or the two trees, at tier S); a
missing or invalid `tools/layout.json` (`layout`); a changed symbolic link or submodule (`link`, at
tier S); any global input (`global`); a path no class maps (`unmapped`); and a folder under `apps/`
or `packages/` that is no package, or a package graph that cannot be read (`workspace`). `check` and
`static` always run.

- `e2e.apps` names the web apps under `apps/` whose e2e runs, and `e2e.projects` their Playwright
  projects, `<app>-<variant>` for each variant in `config/ci.json`'s `e2eProjects` (spec 06 §10.2).
  Only apps whose package exists at the head are named; with `everything`, all of them.
- `packages` lists the affected packages, from each `package.json`'s workspace dependencies at the
  base and at the head (`workspace:*`, pnpm's `workspace:<name>@<range>` alias, or a path into the
  workspace). It is `null` when the graph cannot be read: everything runs and every package counts.
- `images` and `static` come from the head's layout (on a pull request, from the base's as well), and
  only for packages that exist at the head, so a `planned` entry lists nothing until its package does.
- `jobs.review` is false until H-03's CI review job exists; `jobs.selfTest` is true when
  `tools/fin-review/**` or `docs/review/**` changed, or when there is no diff to tell.
- A path a symbolic link in either tree reaches also counts at the link's path. Tier D is
  documentation: a path the layout calls D that is not a documentation file (the `docs` class) is S.

## Tests

`node --test "test/**/*.test.ts"` (or `pnpm test` here) runs the whole suite in under ten seconds.
It needs `git` on `PATH`; the fixtures are built with `git fast-import` in temporary directories.

Programs start through `src/exec.ts` only: found on `PATH` in absolute directories outside the
working directory, never by a shell, with a timeout and an output cap. On POSIX systems each runs in
its own process group, which a timeout or the cap kills whole, so the call settles on time whatever
the program's own children do. In a blobless checkout (CI's), the blobs `plan` lacks are fetched in
one request.
