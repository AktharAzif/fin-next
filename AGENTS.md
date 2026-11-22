# AGENTS.md: the standing rules for fin-next

These rules bind every agent and every person who changes this repository (DECISIONS G-08). The
plan in `docs/plan/` is the source of truth; where these rules and the plan differ, the plan's order
of precedence holds (the owner's decisions first) and this file is fixed to match. `CLAUDE.md`
imports this file and adds nothing.

## 1. How changes reach `main`

- **Pull requests only.** Nobody pushes to `main`, force-pushes, or rewrites shared history. Work on
  your own branch in your own worktree, open a pull request into `main`, and let it be reviewed.
- **Merging** is done by the owner, or by the steward in a merge batch, only when `gate` is green
  and no blocking finding is open, always with both safety flags:
  `gh pr merge <n> --merge --match-head-commit <sha>`, where `<sha>` is the full SHA of the head
  that was reviewed. Never `--admin`, never squash or rebase merges, never a merge of your own
  pull request.
- **Control paths** (DECISIONS CI-14) need the owner's approval: everything `CODEOWNERS` lists,
  which is exactly `controlPaths` in `tools/layout.json` (`layout:check` fails when they differ).
  An agent never edits `.github/**` unless it is the CI lane, and never edits `.claude/**`,
  `CODEOWNERS` or the rules files outside a steward pull request.
- **Review before merge.** Until fin-review's gate is switched on, every pull request after the
  plan's gets the hand-started security and attack sessions of EXECUTION EX-18, and the owner reads
  every control-path file. No built-in review command counts as a review. A builder never reviews
  its own work. Signed review receipts, the builder machine account and the separate OS users come
  with hardening, not in Phase 0 (the owner's trim of 21 Nov).
- **Stay in your lane.** A lane edits only the paths `tools/layout.json` and the lane tables give
  it; anything else goes through the lane board. Shared registries use per-area fragment files.
- **Before you push**, `pnpm check` passes and the pre-push hook runs (enable it once per clone
  with `git config core.hooksPath .githooks`). Never use `git stash` in a shared checkout; commit
  work in progress on your branch instead.

## 2. The platform

- **Node on Railway.** Node 26.13.1 runs everything: production, tests, scripts and CI. Every
  server is a Hono app on Node on Railway. A web app's server half (`src/server/**`) answers only
  `<app host>/api/*` and its private health; it is reached only through a cloudflared tunnel. No
  Railway service has a public domain or a TCP proxy (NB-07).
- **Process rules** (ARCHITECTURE principle 14). Nothing at module scope reads the clock, makes a
  random value or an ID, starts a timer or opens a connection. Time comes from the injected
  `Clock`. Nothing in process memory decides about a person or must agree across replicas: limits,
  locks, claims and sessions live in Postgres (load shedding is the one exception). A request holds
  one unit of work and never holds a pooled database client across outbound I/O. Use Web APIs and
  `AsyncLocalStorage` in app code; one runtime entry file per deployable (`server.node.ts`).
- **No Fin code runs at Cloudflare for an app** (NB-14). The browser apps are single-page apps whose
  static builds are served by **assets-only** Workers static assets deployments with **no script**:
  no `main`, no module, no binding, no `run_worker_first`, `workers_dev` and preview URLs off. No
  route under `/api` exists in any single-page app; `<app host>/api/*` falls through to the tunnel.
  The watcher (`ops/watcher`) is the only Worker with code, and it is off the request path. Builds
  are environment-neutral: no app commits or builds a `_headers` or `env.json`; the deploy renders
  both from the profiles in `packages/web-host/src/static/` (a control path).
- **Hosts by role.** Code names hosts by role (`console`, `admin`, `verify`, `docs`, `api`) and reads
  each real hostname from configuration at deploy time. Committed files never contain a real zone
  name: write `<staging-zone>` or `<zone>`. Fin Admin sits behind Cloudflare Access, and its API
  half checks the Access token on every request as well.
- **Nothing from another origin at run time** in a browser: fonts, icons and scripts all come from
  the app's own origin. The one exception is Sumsub's WebSDK on the selfie host (SA-26), and only in
  the `selfie` header profile.
- **Deploys** go only through `pnpm fin` and the release workflows, never by hand in a console
  (the spikes' recorded throwaways excepted).

## 3. Security is enforced on the server

The bar that never moves (EXECUTION §1.6, NB-01 to NB-15) applies to every change. In short:

- Every permission is checked on the server, per request, by permission name. A page or dialog only
  mirrors the check. Anything unlisted, unknown or unsure fails closed.
- Credential, member, role and money actions take a step-up intent bound to the action, checked on
  the server. No Fin Admin session without a second factor.
- **Cookies** are host-only `__Host-` cookies on each app host, `Path=/`, `Secure`, `HttpOnly`,
  never with `Domain=` and never `crossSubDomainCookies`. The session cookie is `SameSite=Strict`;
  every other auth cookie is `Lax`.
- **CSRF**: every unsafe request to an app's API passes, before any handler and Better Auth's
  included, an exact `Origin` check against the configured origin, `Sec-Fetch-Site` (when present)
  `same-origin`, the `X-Fin-App` header equal to the app's name, and JSON-only bodies (uploads named
  by the route policy excepted). Better Auth also runs its own origin check with exactly the app's
  origin in `trustedOrigins`. An API half sends no CORS headers.
- Calls to a URL a person supplied go only through the SSRF-safe fetch. Each service holds only its
  own secrets; callers sign with private keys no callee holds.
- The page policy allows `script-src 'self'` only; no inline script, style attribute, event handler
  or nonce in any built page.

## 4. Every important action is audited, every change is monitored

- **Audit** (R9, NB-04). Every important action writes its audit event in the same database
  transaction as the action, whoever acted (a developer, an API key, a customer on a hosted link, a
  staff member, the operator, a job or a provider event), with a test that fails when the event is
  not written. The database refuses a commit to a critical table that carries no audit row.
- **Monitoring on Better Stack** (R5). Every unit of work writes one structured line, scrubbed
  first and carrying IDs only, shipped to Better Stack after the response. Every new failure mode
  gets an alert in `ops/monitoring` that names a runbook that exists, or a written reason why not.
  A change that adds work without its line and its alert is not done. Errors go through
  `reportError` with `safeError`, never `console.error(error)`.

## 5. Dependencies

- **Ask first.** No dependency is added, removed or moved without the owner's yes. The steward
  prints the registry facts first (`pnpm view <name>@<version> time maintainers scripts
  dist.attestations repository dependencies license`) and records them in the pull request.
- **One version per package, exact, in the catalog.** Every external dependency is `catalog:` in a
  manifest and one exact version in `pnpm-workspace.yaml`'s `catalog:`. Add it with `pnpm add`, so
  the lockfile is pnpm's own. Every `@fin/*` dependency is `workspace:*`: the `@fin` scope on npm
  belongs to someone else. Every workspace package is `"private": true`.
- **Never loosen a protection.** `pnpm-workspace.yaml`'s policy (`minimumReleaseAge: 4320`,
  `minimumReleaseAgeStrict`, `minimumReleaseAgeIgnoreMissingTime: false`, `trustPolicy:
  no-downgrade`, `blockExoticSubdeps`, `strictDepBuilds`, `engineStrict`) is never changed, and no
  exclusion, pnpmfile, `.npmrc` or override is added to get an install through. A version younger
  than three days waits. An install script runs only with an `allowBuilds` entry the owner approved,
  with a dated comment; `false` means the script never runs.
- **Refused** (`supply-chain:check` and `imports:check` fail on them): `@tanstack/react-start` and
  every server-function or server-component package, Radix, Phosphor, `clsx`, `tailwind-merge`,
  `@fontsource*`, `tsx`, `@logtail/*`, OpenTelemetry SDKs, Redis clients and the rest of
  ARCHITECTURE §3.3's "not used" list. `wrangler` lives only in `tools/static-deploy`.
- **The UI.** Screens import controls only from `@fin/ui`. Nothing imports `@ui-sdk/*` outside
  `packages/ui`, and only `packages/ui/package.json` lists it. The refused SDK entries (`agent`,
  `preferences`, `token-input`, `web.css`, the experimental entries and helpers) are refused there
  too. The UI is built fresh on the UI SDK from the design canvases; nothing is ported from the old
  product (G-04, UI-12).

## 6. Code

- TypeScript runs under Node's type stripping: `erasableSyntaxOnly` (no enums, namespaces or
  parameter properties), `verbatimModuleSyntax`, and relative imports that name the `.ts` or `.tsx`
  file. No `paths` aliases, never `preserveSymlinks`.
- Portability: no `bun:*`, `Bun.*` or `drizzle-orm/bun-sql`; `node:http`, `node:https`, `node:net`,
  `node:dns`, `node:cluster` and `node:worker_threads` only in `packages/server`, `apps/connector`
  and one test-support file, `packages/testing/src/http/node.ts` (`@fin/testing` is a devDependency
  only, imported only from tests and test support); no `node:*` and no server package in client
  code; `ops/fin`, `tools/fin-review`, `tools/static-deploy` and `packages/web-host/src/static` use
  Node built-ins only, and the watcher Web APIs only (spec 01 §4.6).
- **What `imports:check` guarantees** (BD-19). It refuses the imports these rules forbid and, in
  the Node-side areas and the control paths, the plain spellings of loading or running code
  (static and dynamic `import`, `require` and `require.resolve`, `createRequire`, `eval`,
  `Function`, `process.binding` and `getBuiltinModule`, and the forms its tests list), so that
  honest code there stays readable and portable. It is a lint against mistakes, not a sandbox:
  deliberately obfuscated loading (a constructor reached by destructuring, `arguments`, `with`, a
  computed key built at run time, a trick on the lexer) cannot be excluded by a lexer, and is a
  review finding by definition, which fin-review's lenses treat as critical. The control-path
  approval rule returns in hardening (BD-02).
- The rules here are Fin's own API routes, never "server functions": for example, `stepUp` in
  `requireActor` for Fin's own API routes.
- Tests come with the code: unit tests `*.test.ts` (Vitest), integration tests `*.db.test.ts`
  against real Postgres 18 (never PGlite), journeys with Playwright. No placeholder that pretends to
  work.

## 7. The repository is public

Commit nothing secret or private, in files, paths, commit messages or pull request text:

- no credential, token, key or password, even an expired one;
- no account, zone, tunnel, project, service, workspace, team or environment ID;
- no staff or personal email address (fixtures use `example.com`, `example.org` and `example.net`);
- no real zone or host name (write `<staging-zone>`), no private IP address, no local path;
- no private repository or organisation name, and no claude.ai artifact identifier;
- no real person's data.

`pnpm run public-safety` checks the tracked files (it prints where and which rule, never the value);
with `FIN_OVERLAY_FILE` set it also checks the overlay's refuse list. The pre-push hook runs it over
what a push would publish, with gitleaks and `.gitleaks.toml` when gitleaks is installed. A value
you need in a test is built at run time. A credential reaches a command only from a file read
inside that command (`"$(cat <file>)"`) or the secure prompt; it is never echoed, printed, logged,
copied or committed. If a secret leaks, say so at once: it is rotated, not just deleted.
