# Contributing to fin-next

Read `AGENTS.md` first: its rules bind every change. The plan lives in `docs/plan/` (README,
ARCHITECTURE, DECISIONS, EXECUTION and the specifications in `docs/plan/specs/`), and every lane
starts from its spec.

## Setting up

You need Node 26.13.1 (`.node-version`) and pnpm 12.21.0 (`packageManager`), each installed from
its release by checksum: never Corepack, never `npm i -g`. `package.json` also pins pnpm in
`devEngines.packageManager` with `onFail: "error"`, so another pnpm refuses to install here
rather than pnpm downloading the pinned one (SP-01). Then, once per clone:

```sh
pnpm install                          # under the supply-chain policy in pnpm-workspace.yaml
git config core.hooksPath .githooks   # the pre-push check
```

For integration tests and local development, Postgres 18 runs from `compose.yaml` (the image is
pinned by digest and listens on loopback only). Put a throwaway password in `.env.local`, which
git ignores, as `POSTGRES_PASSWORD=<a long random value>`, then `docker compose up -d`. Point
`FIN_TEST_DATABASE_URL` at it for `pnpm test:db`.

## Commands

| Command | What it does |
|---|---|
| `pnpm check` | Everything a pull request must pass: `turbo run lint typecheck test` (every package, and the root's Biome, TypeScript and `scripts/` tests), then `layout:check`, `supply-chain:check`, `public-safety`, `imports:check` and `static:check` |
| `pnpm lint`, `pnpm typecheck`, `pnpm test` | One of the above, across the workspace (`turbo run`) and the root |
| `pnpm test:db` | Integration tests (`*.db.test.ts`) against `FIN_TEST_DATABASE_URL` |
| `pnpm build` | `turbo run build` |
| `pnpm run layout:check` | Every file belongs to an entry in `tools/layout.json`; CODEOWNERS equals its control paths |
| `pnpm run supply-chain:check` | The workspace policy, the manifests, the lockfile and the pinned actions |
| `pnpm run public-safety` | No secret or private value in tracked files; set `FIN_OVERLAY_FILE` to add the overlay's refuse list |
| `pnpm run imports:check` | The import and portability rules of spec 01 §4.6 |
| `pnpm run static:check` | Each app's `static.json` and, once built, its static output |

Turborepo runs with telemetry off (`TURBO_TELEMETRY_DISABLED=1` in every script), a local cache in
`.turbo/cache` per checkout, and no remote cache or `TURBO_TOKEN`.

## Layout

`tools/layout.json` is the one source for every path's package name, tier, areas, lane and status,
and for the control paths. ARCHITECTURE §3.1 describes each entry.

- `apps/*`: the deployables. A web app (`console`, `admin`, `verify`) has its single-page app in
  `src/client/` and its Hono API half in `src/server/`; `docs` is static only.
- `packages/*`: the shared packages, each `@fin/<name>`, depended on only as `workspace:*`.
- `tools/fin-review`, `tools/static-deploy`, `ops/*`: the review engine, the static uploader, and
  the operations code (`pnpm fin`, monitoring, the watcher, backups, images, environments).
- `scripts/`, `.githooks/`: the repository checks and the pre-push hook (Node built-ins only).
- `docs/*`: the plan, flows, threat model, review procedure, operations, runbooks, API changelog.

An entry is `active` once its path exists, or `planned`. A lane creates a planned package without
editing `tools/layout.json` (a control path): `layout:check` warns that a planned path exists, and
the steward flips the entries to `active` at the Phase 0 exit. A new top-level directory under
`apps/` or `packages/`, or a file no entry covers, fails the check until the steward adds an entry.

Tiers: **S** (security-relevant: the attack pass and both sceptic rounds before merge), **N**
(normal), **D** (documents). An unmapped path counts as S.

## Lanes and file ownership

Each lane owns a set of paths (spec 01 §12, EXECUTION §1.3) and edits only those; a change to
another lane's paths goes through that lane or the steward, by the lane board.

- **The steward** owns the root files (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
  `turbo.json`, `tsconfig.base.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`,
  `compose.yaml`, `.node-version`, `.gitignore`), `tools/layout.json`, the rules files,
  `.githooks/`, `.gitleaks.toml`, `scripts/`, and `docs/plan/` outside `docs/plan/specs/`.
- **Dependencies** are added only by the steward, one per pull request, after the owner's yes.
  Only `packages/ui/package.json` may list `@ui-sdk/*`; only `tools/static-deploy/package.json`
  may list `wrangler`.
- **Each package's own root files** (`package.json`, `index.ts`) belong to the package's first
  lane; others ask it.
- **Shared registries use fragments**, one file per area, owned by the area's lane wherever it
  lives: migrations (`packages/db/migrations/<YYYYMMDDHHMMSS>_<area>_<what>.sql`), grants
  (`packages/db/roles/grants/<area>.json`), audit events (`packages/audit/src/events/<area>.ts`),
  permission catalogues, door matrices, monitoring catalogues and alerts, OpenAPI fragments,
  navigation and email templates. Generated and assembled files are never edited by hand or
  committed (`routeTree.gen.ts`, the assembled OpenAPI document, route policies).
- **Control paths** (`CODEOWNERS`) need the owner's approval, whoever owns them.

A package that has tests gives its `package.json` the scripts `lint` (`biome check .`),
`typecheck` (`tsc -p tsconfig.json`) and `test` (`vitest run`), and `test:db` when it has
integration tests; its `tsconfig.json` extends `../../tsconfig.base.json`. The root
`vitest.config.ts` picks up every package whose `test` script runs Vitest.

## Writing a spec

Specs live only in `docs/plan/specs/` and belong to the spec lane. A spec states the contract:
types, statuses, refusals, audit events, emails, monitoring lines, screens and states, and the
tests that prove them. A spec pull request is tier D; it merges before the lane's first ready pull
request.

## Tests that need a secret-shaped value

`public-safety` and gitleaks scan every tracked file, tests included, and never print what they
found. A test that needs a token-, ID- or private-address-shaped value builds it at run time (for
example by joining parts), and email fixtures use `example.com`, `example.org` or `example.net`.

## Definition of done for a pull request

A pull request is ready to merge when all of these hold (EXECUTION §1.5):

1. `pnpm check` passes (lint, typecheck, unit tests, `layout:check`, generated-file checks,
   `monitoring:check`, `static:check`, the public-safety check), and the CI `gate` is green.
   `static:check` proves, on each built app: `index.html` carries `<meta property="csp-nonce">`
   with no `nonce` attribute and has no inline script, `style` attribute, handler or nonce; the
   built CSS starts with `@layer ui-sdk` and holds no `data:` URL; every rendered `_headers` has no
   `'unsafe-*'` and no `data:` outside the listed exceptions (SA-45); `static.json` has only the
   allowed keys; no `@ui-sdk/*` import outside `packages/ui`, and none of the refused SDK entries
   anywhere.
2. Every important action it adds writes an audit event, with a test that fails when the event is
   not written, and a critical-table write without its audit row is refused by the database (R9).
3. Every unit of work it adds writes one structured line, shipped to Better Stack; every new
   failure mode has an alert, with a runbook that exists, or a written reason (R5).
4. Every journey it adds or changes has a Playwright test that fails when the journey breaks, and
   the pull request says what `e2e` printed.
5. Every screen it changes matches its board on the design canvas (R14), including the edge toggle
   and the 24px rail mark, and the board states it covers are in the state manifest.
6. A fin-review receipt for the head SHA, with every lens its tier needs, every session served by a
   model and effort R11 and the floor allow, and no open blocking finding. Until fin-review's gate
   is on, the hand-started sessions of EXECUTION EX-18 and the owner's read of every control-path
   file stand in for it; signed receipts come with hardening (the owner's trim of 21 Nov).
7. No secret, address, account or tunnel ID, zone name or real person's data in the diff (the
   pre-push checks, gitleaks with Fin's shapes, the public-safety check).

`monitoring:check`, `flows:check` and `threat-model:check` join `pnpm check` with the pull requests
that add their checkers (`ops/monitoring`, `docs/flows`, `docs/security`).
