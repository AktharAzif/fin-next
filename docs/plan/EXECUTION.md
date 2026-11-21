# fin-next: how it gets built (execution plan)

Part of the fin-next plan (R13), with ARCHITECTURE.md and DECISIONS.md, committed to the public
repository `aktharazif/fin-next` (R12) as its first commit. Written on Saturday 21 Nov 2026 by the
delivery planner, revised the same day after the critics' review (DECISIONS.md, appendix A), and
revised again before the build starts to apply the owner's decisions made overnight (the next
section). It says how fin-next is built from scratch (R1) by AI agents, who also review it (R10,
R11), on the owner's timeline: Saturday 21 Nov auth and roles (R6), Sunday 22 Nov onboarding and
go-live (R7), Monday 23 Nov providers (R8), then two spill days and the hardening that leads to
production.

## How to read this file

- **IDs.**
  - Decisions are DECISIONS.md's IDs in square brackets, such as [FD-01]. DECISIONS.md is the only
    register; §10 lists when each owner decision is needed. `G-nn` is governance and nothing else.
  - `EX-nn`: a working rule this file sets for the build. It binds unless the owner overrides it.
  - `CR-nn`: a credential or account the owner provides (§0.3 and §2.9).
  - `NB-nn`: a rule of the security bar that no cut line touches (§1.6).
  - `S-nn`: the four front-door spikes of §2.6 (S-01 first thing on Saturday), each with its ID in
    ARCHITECTURE §11.11's catalogue: S-01 is SP-25, S-02 is FW-S2's browser checks, S-03 is SP-07,
    S-04 is SP-08's egress part. `SP-nn` are that catalogue; `FW-Snn` the framework spikes
    (ARCHITECTURE §3.4).
  - `L-<day>-nn`: a build lane. `AC-<day>-nn`: an acceptance criterion. `PG-nn`: a production gate.
    `RK-nn`: a risk. `CUT-nn`: a cut line. `H-nn`: a hardening workstream.
- **Names.** Every package, app and service name is the one in `tools/layout.json` and ARCHITECTURE
  §3.1 and §4.2. A lane table that names a path the layout does not list is a bug.
- **Hosts** are written `<app>.<zone>`; staging is `<staging-zone>`. The zone names themselves are in
  the private overlay ([G-09]); production's zones are [FD-10]'s.
- **Days and times.** Times are build-day targets on the build clock: Phase 0 starts at 08:00 on
  Saturday, and every other time is that start plus the hours between. The clock's time zone is not
  part of the plan ([G-09]). Package release ages are given in UTC only, because pnpm counts in UTC,
  and the plan never pairs a UTC time with a build-clock time. The owner's decisions are timed on the
  owner's clock, the same way.
- **Test labels** in acceptance criteria: `[U]` unit, `[I]` integration against a real Postgres 18,
  `[C]` contract or conformance suite, `[E2E]` Playwright against the built static apps and the API
  services' `test` images, `[STG]` checked on the deployed staging environment, `[CI]` a CI job or
  the merge gate.
- **Inputs.** The phase 1 notes A1 to A8; research notes B1 to B7; the front-door and cookie research
  C1 (same-host routing), C2 (cookies and CSRF) and C3 (the verdict, with the exact Better Auth and
  Hono settings for both shapes); the UI research D1 (the UI SDK), D2 (porting the old product's
  redesign layer) and D3 (the UI architecture on the SDK); the framework verdict; the critics'
  findings; the design brief (round 2 is authoritative) and the canvases' board plans. "Old D-nn" is
  a decision of the 19 Nov Railway plan. "The old product" is the private repository fin-next
  replaces.
- **Public repository.** Nothing here is a credential, an account or workspace ID, a token, a tunnel
  ID, a wallet reference, an internal address, a staff address, a zone name, a local path or a real
  person's data. Credentials are named by role and always typed into the secure prompt.

## The owner's decisions of 21 Nov applied in this file

These override every earlier draft. DECISIONS.md records each of them, with the owner's words, in the
blocks named in the last column.

| Time (the owner's clock) | The owner's decision | Where it lands here | Amends |
|---|---|---|---|
| 02:40 | **Cloudflare Tunnels for every host**, public hosts and Fin Admin alike. Separate public and admin tunnels and tokens, each token only in its own connector service's sealed variables. Railway services get no public domain and no TCP proxy. Connectors watched every minute (count, version, origin inside Railway's static egress). An evict runbook that deletes and recreates the tunnel. Cloudflare's headers trusted only from the connector peers. The on-demand database tunnel as researched. The proxied design is an option after launch | §2.5 (the setup steps), NB-07, AC-P0-07, AC-P0-08 | [FD-01], [FD-11], [FD-13], [FD-14], [FD-15], [FD-16] |
| 03:50 (supersedes 03:00 "Pages" and 03:10 "Origin Rules") | **Static apps on an assets-only "Workers static assets" deployment with no Worker script**: no `main`, no bindings, no `run_worker_first`; `not_found_handling: single-page-application`, `workers_dev: false`, `preview_urls: false`; security headers and the page policy from a static `_headers` file per app. **Hono stays only as the API and auth server on Railway.** No code runs at Cloudflare; leaving means serving the same `dist/` and `_headers` from any static host behind a path-routing proxy | §1.9, §2.5, §2.6, NB-14, AC-P0-14, AC-P0-15 | [FD-17], [FD-19], [SA-45]; amends [FW-01] (static files at Cloudflare's edge, not a Hono process) and [P-07] (`console`, `admin` and `verify` serve only their host's `/api/*`, and there is no `docs` service: the docs site has no `/api/` path, spec 01 S0-01); [UI-13] replaces [UI-05] (theme and sidebar in `localStorage`, not cookies) |
| 03:50 | **One origin per app.** A Workers route `<app>.<zone>/*` goes to the app's assets-only deployment; a zone route `<app>.<zone>/api/*` with no Worker falls through to the hostname's DNS origin, a proxied CNAME to the tunnel, whose ingress matches the host and `^/api/` and sends it to the app's API service, with a `http_status:404` catch-all. The same for `verify.<zone>` and for `admin.<zone>` on the admin tunnel behind Access, which covers the whole host. `developer.<zone>` (the docs) is assets-only, with no `/api/` route and no ingress rule; `api.<zone>` goes straight to the tunnel. Proven by S-01 first thing on Saturday; if it fails, per-app API hosts (`<app>-api.<zone>`) on the same site, with CORS and credentials | §2.5, §2.6 (S-01), §3.1 | [FD-18], [FD-01] |
| 03:50 | **Cookies and CSRF.** Host-only `__Host-` cookies on each app host (`Secure`, `HttpOnly`, `Path=/`, no `Domain`): the session cookie `SameSite=Strict`, every other auth cookie `Lax`. No CORS between an app and its API. CSRF: an exact `Origin` check, `Sec-Fetch-Site`, the `X-Fin-App` header and JSON-only bodies, plus Better Auth's origin check with exact `trustedOrigins`. Try it on the docs calls `api.<zone>` cross-origin, without credentials, with Sandbox keys only | §2.6 (S-02), §3.1 item 1, AC-SAT-23, AC-MON-12 | [SA-43], [SA-44], [AP-10] |
| 03:25 | **The single-page apps' UI is built on the UI SDK** (`@ui-sdk/react` and `@ui-sdk/core`, Apache-2.0). fin-next's `packages/ui` implements the Fin design system's components on the SDK; only the token values and the specs are used, and the old product's redesign branch is a reviewed starting point to port through fin-review. This replaces vendoring the design system's private source | §0.3 (decisions 1 and 2), §2.10 (P0-G), RK-05 | [UI-10] (supersedes [UI-01]), [UI-12], [G-04] (its one exception), [G-06] |
| 03:25 | **The sidebar's edge toggle**: a small round chevron button on the sidebar's right edge near the top, always visible: ‹ collapses, › expands. The logo is a plain 24px mark linking Home, with no hover swap. On the canvases now, in the code from Saturday | §3.5 (AppFrame, AdminFrame), AC-SAT-24 | [UI-11], superseding round 2's brand swap ([UI-09]) |

No longer used after the same decisions: static files served by a Hono process, Cloudflare Pages
and Origin Rules (their DNS-record and Host-header overrides are Enterprise-only, research notes C1
and C3). [FD-02] and [FW-03] are withdrawn, and [UI-01] and [UI-05] are superseded. The framework
conditions FW-C04 and FW-C06 keep their IDs and are rewritten, not withdrawn (ARCHITECTURE §3.4):
FW-C04 was the templated document with a per-request nonce and is now a static `index.html` with no
nonce; FW-C06 was the style nonce for injected styles and is now the UI SDK's constructed style
sheets under a nonce-less meta tag.

---

## 0. Summary

Three days is aggressive. The plan makes it possible by doing six things:

- running about eight build lanes in parallel on two machines, each with its own files;
- reviewing every change with fin-review from the first morning, with signed receipts and no
  exceptions for sensitive code (R10, R11);
- keeping the security bar fixed (§1.6), while cutting features and states, never controls;
- asking the owner for nine decisions (DECISIONS' short list) and a short list of credentials before
  10:00 on Saturday (§0.3), with every other decision taking its default at 09:00;
- proving the new front door (tunnels, assets-only static apps, one origin per app) from the first
  hour, with a fallback written down for each spike (§2.6);
- separating **staging-complete** (every R6 to R8 must-have deployed and tested on staging) from
  **production** (§7's gates, which take soaks, drills, warm-ups and vendor answers that no amount of
  parallel work can shorten).

### 0.1 The days

| Day | Must-have, deployed to staging by the end of the day | Stretch (to the next day's spill block or to hardening) | Hardened later (§6) |
|---|---|---|---|
| **Sat 21 Nov, Phase 0** (08:00 to 13:30) | Public repository with the plan as its first commit; the builder account and the `fin-review` OS user; rules files; minimal CI with `gate`, then the ruleset; fin-review MVP enforcing R11 with signed receipts; Railway staging with Postgres 18; the public and admin tunnels with their connectors (`cloudflared-db` at zero with no token; the db tunnel itself is built before production, H-05), and the watcher; the four front-door spikes S-01 to S-04; the assets-only static deployments with their routes, serving each app host; Better Stack receiving lines and errors; one email delivered through Cloudflare Email Sending from the `worker`'s static egress; every app host serving its SPA from Cloudflare, and every app host but `developer.` answering `/api/health` through its tunnel; `api.` answering `/health`; `/readyz` private | The fin-review doctor and self-test (afternoon) | fin-review v2 (cache, joins, sweep, the CI runner) |
| **Sat 21 Nov, R6** | Both realms: sign-up and sign-in with emailed code and passkey; TOTP and backup codes; the mandatory second factor for every staff member and every privileged developer ([SA-05]); step-up intents on every credential, member and role change; organisations, team, invitations; the 26 dashboard permissions, built-ins and custom roles; Fin Admin's granular staff permissions and prebuilt roles ([SA-12]); adding staff with an intent and an enrolment code; audit events with tests; security emails; the console and Fin Admin frames on the UI SDK with the edge toggle; the console's screens of §3.5 and Fin Admin's sign-in, second factor, step-up and Staff | Passwords and reset ([SA-06]); API keys and the edge's key check, if the realms are green at 18:00; Google sign-in; custom staff roles and the AdminRoleEditor; staff factor reset | Every remaining design state; visual regression; Access MFA in production |
| **Sun 22 Nov, R7** | Saturday's spill: Fin Admin's account, roles and audit screens, and API keys if they did not land; the public API foundation and the edge; the KYC domain with its state machines; the Sumsub adapter and the sandbox provider behind one port; inbound Sumsub webhooks stored and processed; the hosted verify pages and the selfie host as assets-only deployments; RFIs; developer webhooks and events; go-live from the wizard to the staff decision to Production unlocked; Fin Admin review screens; audit for every actor; the UI SDK moved to `0.1.0-beta.13` after 12:24 UTC | Owner companies sent to Sumsub ([KY-06]); Sumsub's ongoing signals as Fin Admin flags ([KY-13]); saved views; the docs site skeleton | Erasure and retention; the production Sumsub app; webhook analytics ([BC-02]) |
| **Mon 23 Nov, R8** | Money schema with Fin's double-entry ledger and holds; the `ProviderAdapter` interface with declared capabilities; the Fin simulator and the conformance suite; the MassPay adapter (sandbox) in `payments`, with the money jobs and the hook door there; virtual accounts, beneficiaries with sealed full numbers, transfers with per-transfer intents, Sandbox deposits; provider webhooks and reconciliation with automatic trips; the money API and screens; the read-only Fin Admin money view; the docs site as an assets-only deployment, with the reference and "Try it" calling `api.` cross-origin, without credentials, on Sandbox keys (R16) | Fin Admin money operations; a second adapter skeleton; docs guides beyond getting started | Real inbound deposits; MassPay live; value caps and the first-payout delay ([MO-19]); ledger drills |
| **Tue 24 and Wed 25 Nov** | Two spill days for the three days' must-haves | | |
| **Thu 26 Nov** | **Staging-complete**, 22:00 target (UNVERIFIED) | | |
| **From Fri 27 Nov** | Hardening (§6) | | Production gates PG-01 to PG-14 (§7) |

### 0.2 Requirement status at staging-complete

Each requirement is full, or partial with what is missing and the item that completes it. The C4
report at the end of each day carries this table, so a partial requirement is a recorded decision
([G-01]), never something left unsaid.

| Req | At staging-complete | What is missing, and where it is completed |
|---|---|---|
| R1 Production-ready, from scratch | Partial | Production readiness is §7's gates (PG-01 to PG-14). The ported design layer is [G-04]'s one exception, decided by the owner; [UI-12] asks whether its derived text may be public (§0.3, decision 2) |
| R2 Everything on Railway, including the database | Full for compute and the database. Off Railway by the owner's decisions: the apps' static files (assets-only deployments that run no code, [FD-17]), and the vault, the watcher ([OB-18]), the tunnels' edge, Access and email ([P-02]) | none: [P-02] was decided overnight |
| R3 Cloudflare Email Sending | Full on staging, sent only by `worker` from its static egress | Production: the beta acceptance ([EM-02]) and the two-week warm-up ([EM-08]) |
| R4 Cloudflare in front of Railway | Full: tunnels for every API host, assets-only static deployments for every app host, one origin per app, watched every minute | The evict drill and SP-04h in hardening (PG-05) |
| R5 Better Stack replaces Grafana and Sentry | Full on staging | Production team, paging and the responder gate (PG-09) |
| R6 Auth with roles | Partial if the Saturday stretch slips: custom staff roles and the AdminRoleEditor, the staff factor reset, passwords and Google | Sunday's spill block, then H-02 |
| R7 Onboarding and go-live, everything Sumsub covers | Partial under [KY-13]'s default: Sumsub's monitoring queues and AML re-screening schedules are not built; owner companies are a stretch | A design and spec in hardening, if the owner wants them; [KY-06] before production |
| R8 Provider integration | Partial: MassPay sandbox only; no second adapter; no real inbound deposits; Fin Admin money actions a stretch | PG-14 and H-01 |
| R9 Everything audited | Partial: the platforms' own audit is weekly for Railway until a narrow credential exists; Better Stack's audit log is not bought | [AU-06], [AU-05]; the watcher's GitHub check in H-04 |
| R10 fin-review, fast | Partial: local runs with signed receipts; no cache, CI lens, `ci-report` or e2e selection yet | H-03 |
| R11 Model and effort rules | Full for the models, the attack pass and tiers N and D, proven per session by the receipt's recorded model. Narrowed on tier S under [RV-06]'s default floor: a gating run there refuses `--effort high` (spec 07 §3.4) | The owner picking `high` everywhere for [RV-06] makes it full; the built-ins stay out until SP-12 passes |
| R12 Public repository | Full | none |
| R13 The plan first | Full | none |
| R14 The new designs | Partial: the frames and components on the UI SDK; verify pages, emails, docs, unlocked Production, Fin Admin money and AdminRoles have no boards and are built as marked pending compositions | The design lane each evening; H-02 for parity |
| R15 Bun or Node | Full: Node, with the Bun canary job | none |
| R16 The public API and the docs site | Partial: the reference with Try it on Sandbox keys and the getting-started guide only; other guides, the changelog and search wait; no docs board ([AP-12]) | H-08 |

**What this plan does not promise.** Production cannot open on Monday night. The earliest realistic
production date depends on the 7-day email soak, 7 days of a green watcher, the production sending
domains' two-week warm-up, a cold review of the whole codebase, drills, the responder gate,
production accounts and vendor answers (§7). The estimate is **production open to real developers not
before the week of 14 Dec 2026**, and live money later, both UNVERIFIED until the hardening shows its
pace.

### 0.3 Before Saturday 10:00, the owner provides

Everything below is given by the owner, in the owner's own sessions. A credential is typed into the
secure prompt or created in the provider's console, never pasted into a chat, a file in the
repository or a log. "Lives in" says where it ends up.

**Credentials and accounts, with their exact scope** (in the order they are needed):

| ID | What | Exact scope | Lives in | Needed by | Blocks if late |
|---|---|---|---|---|---|
| CR-21 | The private overlay: the staging zone's name; the old product's repository and zone names, the design system's private repository name, the redesign pull request's reference and the port's source commit (the public-safety check's refuse list); the seed inbox address; the Zero Trust team name; the Railway and Better Stack account, workspace and team IDs; the on-call roster and its time zone; the threat model's private annex (spec 08 §2.5); the private provider notes, which hold what Fin observed of a provider's behaviour, fees and account terms (ARCHITECTURE §12.12, spec 04 MS-30). The names Fin gives its own Better Stack teams, schedules and workspaces are public labels ([G-09]) | Not a credential, but never in the repository ([G-09]) | A file on the owner's machine outside the repository, read by `pnpm fin` and the public-safety check | 08:00 | The public-safety check, so the first commit |
| CR-01 | The repository `aktharazif/fin-next`, created public by the owner with Issues, Discussions, Wiki and Projects off; GitHub Pro on the owner's account ([CI-06]) | The owner's own GitHub account, repository admin. No agent ever holds this login | GitHub | 08:00 | Everything |
| CR-17 | The builder machine account (a separate GitHub user, collaborator with Write, no Admin) and its tokens; the `fin-builder` and `fin-review` OS users on both machines; an Ed25519 receipt-signing key pair per machine in the `fin-review` user's keychain | **Builder token:** a classic token with `public_repo` only (no `workflow`, no `admin:*`, no `repo_deployment`, no `delete_repo`), 30-day expiry; if SP-23 shows a collaborator's fine-grained token can reach this personal repository, instead: this repository only, Contents read and write, Pull requests read and write, Metadata read, nothing else. **CI lane token:** the same account, `public_repo` and `workflow`, 7-day expiry, held only by the CI lane's session. **`fin-review` token** (spec 07 §6.3, §9.3): pushes only `refs/fin-review/receipts/*`, re-runs `gate` and, from H-03, downloads CI runs' sealed artefacts (`public_repo`; the narrower form is SP-24's). **Receipt keys:** the private half never leaves the keychain; the public half goes to `docs/review/receipt-keys/` | GitHub; each machine's keychains | 08:15 | Merges, receipts |
| CR-02 | Claude Code signed in for the `fin-builder` and `fin-review` OS users on both machines | The owner's subscription; `claude-opus-5-5` and `claude-fable-5-2` both answering in a `fin-review` session (the doctor checks); no settings file that caps effort, sets a model alias or switches provider | Each OS user's login | 08:30 | Builders, fin-review |
| CR-04 | A new Railway workspace on Pro for staging: two-factor sign-in required for members; one project with only its default environment; PR environments off; static outbound IPs available | One **project token** for that project's default environment (deploy and configure services in it, nothing else). No workspace or account token is stored; if SP-03 shows a call needs one, the owner types a workspace token for that one run and revokes it after | Secure prompt for `pnpm fin`; the `staging` GitHub environment secret ([CI-03]) | 08:30 | Staging, S-01, S-04 |
| CR-05b | A new staging zone in a new Cloudflare account ([FD-09]), registered through Cloudflare's registrar so its nameservers are live at once; Zero Trust enabled on the Free plan with its team name | The owner's Cloudflare login, protected by a security key; Free zone plan | Cloudflare | 08:30 | The front door (fallback: the shared zone's `-next` names) |
| CR-05 | The operator token on the staging account, account-owned | **Zone permissions, the staging zone only:** Zone Read, Zone Settings Edit, DNS Edit, Workers Routes Edit, Transform Rules Edit, Configuration Rules Edit, Cache Rules Edit, Single Redirects Edit, Zone WAF Edit, Logs Edit. **Account permissions, the staging account only:** Cloudflare Tunnel Edit, Access: Apps and Policies Edit, Workers Scripts Edit (the static deployments and the watcher), Email Sending Edit, Account API Tokens Edit (to mint CR-08, CR-18 and CR-20), Account Settings Read. Expiry 24 hours (a new one each morning), a client IP filter to the operator's address where practical. Group names as Cloudflare's token page shows them; S-01 records any difference (UNVERIFIED) | Secure prompt, per run, never stored | 08:45 | S-01, the tunnels, routes, watcher, email |
| CR-09 | Better Stack: an organisation with the team `fin-staging` (data region `europe`, two-factor enforced, AI features and MCP off) | Two **team-scoped** tokens for `fin-staging` only: a Telemetry token and an Uptime token, for `pnpm fin monitoring apply`. No global token. Ingest tokens and error DSNs are made by `monitoring apply` and become sealed variables per service | Secure prompt, per run | 09:00 | Monitoring |
| CR-06 | Workers Paid on the staging Cloudflare account | The account's Workers plan (Email Sending to any recipient and the watcher's minute cron need it; static asset requests are free on any plan) | Cloudflare | 09:30 | S-03, email, the watcher |
| CR-08 | The email token and the seed inbox | Minted by `pnpm fin email token staging` with CR-05: account-owned, **Email Sending Edit only**, for the staging zone's `auth.` and `notify.` sending subdomains; client IP filter to `worker`'s static egress addresses (S-03 checks that it is honoured); expiry 180 days or less. The seed inbox is the owner's own mailbox, named in CR-21 | A sealed variable on `worker` only (and on S-03's throwaway service for that one run) | 10:00 | Security emails |
| CR-10 | The staging escrow `age` recipient | The public key only; the identity stays in the owner's password manager, with a printed copy | The public settings ([G-09]) | 10:00 | The first generated key |

**Later on Saturday** (full table in §2.9): CR-18, the watcher's read-only tokens, by 11:00; CR-20,
the static deploy token, minted by `pnpm fin` by 11:30; CR-07, the staff list and Access settings, by
12:00 (the staging identity provider by 22:00, [FD-05]); CR-15, the vault buckets and writer tokens,
by 12:00; CR-19, the canary key, from 13:00; CR-22, fin-review's ingest token and nightly heartbeat
URL, by 17:00; CR-13, the Sumsub sandbox request, at 18:00; CR-11, the first Fin Admin's address, at
20:00. CR-23 and CR-24 come with hardening (H-03).

**The nine decisions Saturday's morning work depends on** (DECISIONS' short list). Each has a
default. Two are **blocking**: the work that depends on them waits for an explicit yes. The other
seven take their default at 09:00 if the owner has not answered. Every other "before Saturday's
start" decision (24 more, DECISIONS' "also at the sitting" table) takes its default at 09:00 too, and
none of them blocks. [G-04]'s exception, [P-02], [FW-01] and [FD-14] were decided by the owner
overnight and are not asked again.

| # | Decision | Default | Blocks |
|---|---|---|---|
| 1 | [G-06] The starting dependency set, as amended overnight | Approve the set in [G-06]: the UI SDK (`@ui-sdk/react` and `@ui-sdk/core`, one exact version) in place of Radix, Phosphor, `clsx` and `tailwind-merge`, at the newest beta that has cleared the release age when the pull request runs (`0.1.0-beta.9` at P0-4's time, cleared at 03:02 UTC; `0.1.0-beta.10` from 09:47 UTC), then `0.1.0-beta.13` in a pull request of its own after 12:24 UTC on Sunday; `wrangler` at one exact version in `tools/static-deploy` only ([FD-19]), each install script its dependencies bring needing the owner's own yes before it gets an `allowBuilds` entry; the fonts as files in `packages/tokens` (no `@fontsource` package; spec 01 S0-14); no QR library (the Authenticator board shows the key for manual entry until an encoder is chosen, D3 §7.3). Alternative, only on an explicit yes: `0.1.0-beta.13` from Saturday under a dated exact-version exception | **Blocking**: nothing is installed without an explicit yes |
| 2 | [UI-12] May the ported design layer (from the old product's redesign branch), part of whose text comes from the design system's private source, the logo's paths, and the verbatim copies of `fin-motion.css`, the export's token file and its font files be public? | Yes: the text is kept; every private-document reference is stripped and sample domains become `example.com` in the port's first commit; the notices are extended (the design system as the source; the icon, flag and font notices); the logo stays under [G-03]'s reservation of brand assets. Alternatives: rewrite the comments; a clean rebuild from the specifications | **Blocking** for the port, so for every screen. Without a yes, screens are built fresh from the specs (D3 §4.2) and Saturday keeps only its must-have states |
| 3 | [FD-09] The staging zone | A new staging zone in a new Cloudflare account (CR-05b); fallback the shared zone's `-next` names, recorded as an accepted risk | The front door and S-01 |
| 4 | [OB-18] May the watcher stay a Cloudflare Worker under the owner's portability rule ("no vendor locked in items like workers")? | Yes: plain `fetch` calls on a minute cron, with no Workers-only binding, the one piece of Fin code that runs at Cloudflare; it holds no application traffic and no write credential. This departs from the owner's words. The non-Worker alternative: the same code on a small virtual machine at another provider, outside Railway, for a few US dollars a month per environment (UNVERIFIED), one more vendor and an operating system to patch. Better Stack's monitors alone cannot read Cloudflare's or Railway's configuration | The watcher, live before the first staging deploy |
| 5 | [SA-05] A mandatory second factor for privileged dashboard roles, evaluated per request across organisations (R6) | Yes | The identity spec at 10:00 |
| 6 | [SA-12] Fin Admin's granular permission catalogue and prebuilt roles (R6) | 26 permissions; Viewer, Compliance, Operator, Admin; custom roles | The staff spec at 11:00 |
| 7 | [AU-01] What R9 covers for reads | Audit every reveal of personal data, documents or bank numbers; list reads are log lines | The audit allowlists in the first migrations |
| 8 | [G-10] What agents may do without asking | The steward merges green pull requests with signed receipts in batches; never control paths, plausible highs, dependencies, staging deploys or production | Merges from 09:00 |
| 9 | [CI-14] Control paths need the owner's code-owner approval and typed confirmation | Control paths only, now including each app's `_headers` and static deployment settings and `tools/static-deploy/**`; other tier S paths rely on signed receipts | CODEOWNERS and the ruleset in the first hour |

**Also for the owner, not blocking.** [FD-19] reads the owner's "GitHub Actions builds, then uploads"
as covering staging. Who uploads production's static files is a question for the owner, needed
before production (§10): the operator's launcher (the answer put to the owner, so GitHub holds no
production credential, [CI-04]) or an Actions job in a `production` environment the owner approves.

---

## 1. How the work runs (every day)

### 1.1 Who does what

| Role | Who, and as which identity | May | May not |
|---|---|---|---|
| **Owner** | The person who owns `aktharazif/fin-next`, with the owner's GitHub account | Decide every owner decision; type every credential into the secure prompt; judge plausible critical and high findings; approve dependencies, control-path pull requests and staging deploys; deploy production as the operator | (Not needed for routine merges once [G-10] is given) |
| **Steward** | One agent session on machine A, as the `fin-builder` OS user with the builder account ([CI-13]) | Own the root files, the lockfile and `docs/plan/**` except `docs/plan/specs/**` (the spec lane's); keep the lane board; merge, in the merge batches, pull requests whose gate is green with a signed receipt; start the nightly review; write the end-of-day report | Write feature code; merge a control-path pull request without the owner; merge with an open blocking finding; merge a pull request it built |
| **Builder** | One agent session per lane, in its own git worktree and branch, as `fin-builder` | Change only the paths its lane owns (§1.3); open draft and ready pull requests; fix findings | Touch another lane's paths; add a dependency; edit control paths (only the CI lane edits `.github/**`, with its own token); read or print a secret |
| **Reviewer** | Sessions that fin-review starts, as the `fin-review` OS user | Read the change and the repository | Write files, run commands, reach the network, or read outside the tree and the engine (§1.7) |
| **Ops agent** | One session, as `fin-builder`, with the owner present for credentials | Run `pnpm fin` against staging; run the spikes; set up the tunnels, routes and static deployments; apply monitoring; deploy the watcher | Hold a credential beyond one command; touch production before §7 |
| **Spec writer** | One agent session on machine B (L-SPEC) | Keep `docs/plan/specs/**` current and write any new spec there, from this plan and the notes; read the old product's code ([G-04]) | Write code |
| **Design agent** | One session on the design canvases (outside the repository) | Draw the missing boards in light, dark and phone, on the canvases "Fin Dashboard · new design" and "Fin Admin · new design" (R14) | Change a design decision the owner has taken |

- **EX-01.** Two machines run the lanes. Each lane runs on one machine only, so two agents never work in
  the same worktree. The lane tables give the machine.
- **EX-02.** A builder never reviews its own work. Reviews are fresh sessions started by fin-review, with
  only the change, the repository and the procedure from `main`.

**Capacity** (UNVERIFIED until the first checkpoints measure it; [RV-20]). The owner's Claude
subscription carries every session, and its usage limit is not published, so the steward records
usage at each checkpoint.

| Machine | Builder sessions at once | Review sessions at once | Other | What stops first at a usage limit |
|---|---|---|---|---|
| A | 4 to 5 lanes | the `pr` gates of its own lanes, at most 3 at once | the steward | N-tier lanes stop new milestones first, then stretch lanes; tier S must-haves and their gates keep going (CUT-07) |
| B | 4 to 5 lanes, the spec lane and the ops agent | the `pr` gates of its own lanes, at most 3 at once | the design agent (outside the repository) | the same order |

### 1.2 Branches, pull requests and merges

- **EX-03. The plan is the first commit, then the rules come on in order** (§2.1). The initial commit
  adds `docs/plan/` and the root `README.md` only, the public repository's landing page, after the
  public-safety check has run locally over both with the overlay's
  refuse list (R13) and after the owner has confirmed [G-09]'s pre-publication step (spec 01 §3.1,
  step 0). Then pull request 1 adds a minimal `ci.yml`; after it merges the ruleset is
  switched on; then the merge guard and settings files; then the receipt requirement, in the same pull
  request that adds the checker. Until the builder account, the token split and signed receipts all
  exist, the server-side gate is advisory and every merge is the owner's own.
- **EX-04. Lane branches and milestones.**
  - Each lane works on `lane/<day>-<nn>-<name>` in its own worktree.
  - It opens a **draft** pull request at once. CI runs `plan` and `check` on drafts, and fin-review
    runs a `commit` review on each push ([RV-12]), so feedback arrives within minutes.
  - At a milestone (normally twice a day per lane) the builder marks the pull request ready. That runs
    the full CI and the `pr` gate, which reviews only what the `commit` reviews did not cover, plus one
    integration pass.
  - After a merge the lane continues on a fresh branch from the new `main`.
- **EX-05. How merges happen.**
  - The ruleset on `main` ([CI-01]): pull request required; required check `gate`; branches up to
    date; code-owner review; merge commits only; no force push or deletion; no bypass actors, the owner
    included.
  - The steward merges in **batches every 90 minutes** (and at each checkpoint), in tier order, with
    `gh pr merge <n> --merge --match-head-commit <sha>`, where `<sha>` is the full SHA of the reviewed
    head. When a pull request is updated from `main` and its own patch is unchanged, fin-review
    re-issues its receipt without a model session ([RV-20]).
  - A pull request with an open confirmed critical, high or medium finding, or an open plausible
    critical or high finding not yet judged by the owner, is never merged.
- **EX-06. The merge guard.** fin-next gets its own merge-guard hook in Phase 0, written fresh from the
  same rules (no push to `main`, merges only with both flags, no `--admin`, no edits to the hook or
  settings files, the public-safety check and gitleaks before any push). It and `.claude/settings.json`
  are committed by the owner, or by the steward in a fully reviewed control-path pull request (the
  owner's 19 Nov note). Agents for fin-next start in a fin-next checkout, so its hook applies.

### 1.3 File ownership

Each lane owns a set of paths, named from `tools/layout.json`. A lane that needs a change in another
lane's paths asks that lane, or the steward, through the lane board. Shared registries use
**fragments**, and **an area's lane owns its fragment files wherever they live**, so two lanes never
edit the same file.

| Shared thing | How lanes add to it without collisions | Owner of the index |
|---|---|---|
| Root files (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `.node-version`, `tools/layout.json`) | Only the steward edits them; `pnpm-workspace.yaml` and `tools/layout.json` are control paths. Phase 0 adds `packages/icons` and `packages/motion` to the layout (D3 §2) | Steward |
| Dependencies and `pnpm-lock.yaml` | A lane asks; the steward adds one dependency per pull request after the owner's yes ([G-06] covers the bootstrap set). Only `packages/ui/package.json` may list `@ui-sdk/*` | Steward |
| Each package's own root files (`package.json`, `index.ts`) | One lane per package owns them; other lanes in the package ask it | The package's first lane |
| Database migrations | `packages/db/migrations/<YYYYMMDDHHMMSS>_<area>_<what>.sql`, hand-written; the area's lane owns its files; a CI check refuses a name not later than the newest on `main`; no Drizzle journal | `packages/db` (P0-E) |
| Database grants | `packages/db/roles/grants/<area>.json`; a test per role | The area's lane |
| Audit event catalogue | `packages/audit/src/events/<area>.ts`; the index is generated and checked | The area's lane |
| Permission catalogues | `packages/access/src/catalogue/{dashboard,staff}/<area>.ts` | The area's lane |
| Door matrix | `packages/server/src/doors/<area>.ts`, assembled into the matrix | The area's lane |
| Monitoring catalogue and alerts | `ops/monitoring/catalog/<area>.ts` and `ops/monitoring/<env>/alerts/<area>.json` | The area's lane (the definition of done requires them) |
| OpenAPI fragments and route policy | `packages/contract/openapi/<area>.json` and each app's `src/server/policy/<area>.ts`, generated from the route schemas; the assembled files are built, never committed | The area's lane |
| Navigation | `packages/frame/src/nav/{console,admin}/<area>.ts`, filtered by permission | The area's lane |
| Email templates | `packages/email/src/templates/<area>/*` | The area's lane |
| Each app's static settings | `apps/<app>/static.json` (the assets-only settings `tools/static-deploy` reads: `not_found_handling`, `workers_dev: false`, `preview_urls: false`; no `main`, no bindings) and the `_headers` profile templates in `packages/web-host/src/static/` (`app`, `hosted`, `selfie`, `docs`: the page policy and headers, [SA-45]). No app holds a `_headers` file: the deploy renders each artefact's `_headers` and `env.json` from its profile and the environment's settings (spec 01 §7.4, DECISIONS SF-05; ARCHITECTURE §5.16). Both are control paths ([CI-14]). A header-matrix test renders every profile | `static.json`: P0-G, then the app's lane; the templates: P0-D, with each lane's changes through the lane board; always with the owner's approval |
| The static uploader | `tools/static-deploy/**`: the pinned `wrangler` and its wrapper ([FD-19]); a control path | P0-F |
| `routeTree.gen.ts` | Never committed; generated at build and typecheck | none |
| Playwright fixtures, seed and the test static server | `packages/testing/**` | L-SAT-08 on Saturday; the steward after Saturday |
| Each app's routes | By route folder, given in each day's lane table | The lane named there |

- **EX-07.** A generated index or assembled file is never edited by hand; CI regenerates it and fails on a
  difference. Ownership of a path moves only through the lane board, at a merge point. P0-D creates each
  app's API skeleton (`src/main.ts`, the server entry); P0-G adds the browser shells, `index.html`
  and `static.json` after it; both hand their app files to the day's app lane when their last
  pull request merges.

### 1.4 Specs first, and the old code

- **EX-08.** Every lane starts from its spec in `docs/plan/specs/`. The eight specs (01, Phase 0, to
  08, security, audit and observability) are committed with the plan; **the spec lane (L-SPEC, machine
  B)** keeps them current from this plan, the phase-1 notes and the spikes' results, and writes any
  further spec a lane needs in the same folder, in order of need: Saturday's sections re-read against
  the morning's spikes and decisions from 07:30 (access by 08:45; identity and email by 10:00; orgs and
  staff by 11:00; the console and Fin Admin screens by 12:00), and each next day's from 18:00 to 20:00.
  `docs/plan/specs/**` belongs to the spec lane; the rest of `docs/plan/**` is the steward's.
  Spec pull requests are tier D with a correctness lens; a lane may start from its spec's open pull
  request, and the spec merges before the lane's first ready pull request. A spec states the contract:
  types, statuses, refusals, audit events, emails, monitoring lines, screens and states, and the tests
  that prove them. Review lenses check code against the spec as well as the rules.
- **Old code** ([G-04]): builders work from specifications only and never read or copy the old
  product's code; the spec writer may read it. The similarity check runs locally at the ship step,
  never in public CI. **The one exception**, decided by the owner ([G-04]), is the design layer of the
  old product's redesign branch, ported into `packages/{tokens,icons,motion,ui}` by P0-G and reviewed by
  fin-review as new code ([UI-10]); whether its derived text goes public as it is, is [UI-12] (§0.3,
  decision 2). The similarity check skips the ported files the port's notice lists and flags a copy
  anywhere else. The old product's app
  glue (its frame, navigation, route states and theme code) is not ported: `packages/frame` is built
  fresh.

### 1.5 Definition of done for a pull request

A pull request is ready to merge when all of these hold:

1. `pnpm check` passes (lint, typecheck, unit tests, `layout:check`, generated-file checks,
   `monitoring:check`, `static:check`, the public-safety check), and the CI `gate` is green.
   `static:check` proves, on each built app: `index.html` carries `<meta property="csp-nonce">` with
   no `nonce` attribute and has no inline script, `style` attribute, handler or nonce; the built CSS
   starts with `@layer ui-sdk` and holds no `data:` URL; every rendered `_headers` has no
   `'unsafe-*'` and no `data:` outside the listed exceptions ([SA-45]); `static.json` has only the
   allowed keys; no `@ui-sdk/*` import outside `packages/ui`, and none of the refused SDK entries
   anywhere (D3 §2; [SA-45], [UI-10]).
2. Every important action it adds writes an audit event, with a test that fails when the event is not
   written, and a critical-table write without its audit row is refused by the database (R9).
3. Every unit of work it adds writes one structured line, shipped to Better Stack; every new failure
   mode has an alert, with a runbook that exists, or a written reason (R5).
4. Every journey it adds or changes has a Playwright test that fails when the journey breaks, and the
   pull request says what `e2e` printed.
5. Every screen it changes matches its board on the design canvas (R14), including the edge toggle and
   the 24px rail mark, and the board states it covers are in the state manifest.
6. A signed fin-review receipt for the head SHA, with every lens its tier needs, every session served by
   a model and effort R11 and the floor allow, and no open blocking finding.
7. No secret, address, account or tunnel ID, zone name or real person's data in the diff (the pre-push
   checks, gitleaks with Fin's shapes, the public-safety check).

### 1.6 The bar that never moves

Cut lines (§8.2) remove features, states and polish. They never remove any of these:

| ID | Rule |
|---|---|
| NB-01 | Every permission is checked on the server, per request; a page dialog is never the check |
| NB-02 | Every credential, member, role or money action takes a step-up intent bound to it, checked on the server; reveals take a factor shown in the last 5 minutes |
| NB-03 | No Fin Admin session without a second factor, and no staff first factor without an enrolment code; no privileged developer acts without a factor ([SA-05]) |
| NB-04 | Every important action writes its audit event in the same transaction, with a test, and the database refuses a critical commit without one |
| NB-05 | An unlisted sign-in endpoint answers 404; the mounted set equals the allowlist (test) |
| NB-06 | A public answer never says whether an account exists; every email Fin can be made to send has a per-recipient limit; a security notice is never dropped |
| NB-07 | No Railway service has a public domain or a TCP proxy. Every Railway host is reached only through the public or admin tunnel, each with its own token on its own connector service. Cloudflare's headers are trusted only from a current connector peer with the host's ingress proof; any other request gets 403. The connectors are watched every minute from outside Railway: count, version, and an origin address inside the connector service's static egress |
| NB-08 | Secrets live only in sealed Railway variables of the one service that needs them, in the `staging` GitHub environment for the deploy job, or are typed into the secure prompt; nothing secret in the repository, CI logs, images, static builds or telemetry |
| NB-09 | What leaves for Better Stack is scrubbed first; IDs only |
| NB-10 | Personal-data keys and provider credentials sit only on the services that call the provider; callers sign with private keys no callee holds |
| NB-11 | Every change to a tier S path gets the attack pass and both sceptic rounds before merge, in a signed receipt |
| NB-12 | Calls to URLs a person supplied go only through the SSRF-safe fetch, with no exception |
| NB-13 | Money: Fin's ledger is the balance; no provider call inside a database transaction; every payout's row is durable and its permanent idempotency key saved before the call |
| NB-14 | No code runs at Cloudflare for an app: every static deployment is assets-only (no script module, no bindings, no `run_worker_first`, `workers_dev` and preview URLs off), its deployed asset manifest equals the release manifest's, and the watcher checks both every minute |
| NB-15 | Every cookie is host-only `__Host-` (no `Domain`, never `SameSite=None`), the session cookie `Strict`; every unsafe request to an app's API passes the exact `Origin`, `Sec-Fetch-Site`, `X-Fin-App` and JSON-only checks before any handler, Better Auth's included; the page policy allows `script-src 'self'` only ([SA-43], [SA-44], [SA-45]) |

A feature that cannot meet these by the end of its day is not shipped behind a weaker check; it moves to
the next day (EX-25).

### 1.7 Review gates

**Tiers** come from `tools/layout.json` (ARCHITECTURE §3.1); an unmapped path counts as S. In short:
tier S is every package but the design system (`packages/{tokens,icons,motion,ui}`), the browser shell
(`packages/frame`) and the app contracts; the server code of every app (`apps/<app>/src/server/`, the
`/api/*` services); each app's `_headers` and `static.json` and `tools/static-deploy` (control paths, [CI-14]);
`apps/edge`, `apps/api`, `apps/payments` and `apps/connector`; the docs site's Try-it code; migrations and grants; `ops/**`; and the control
paths. Tier N is screens and their client code, the design system, the shell and the contracts, and
tests. Tier D is documentation outside `docs/review`.

**What runs when** (targets to measure in Phase 0):

| Event | fin-review mode | Scope | Lenses | Attack pass | Where it runs | Target p50 |
|---|---|---|---|---|---|---|
| Push to a lane pull request, drafts included | `commit` | delta since the last reviewed head | those whose paths the delta touches | if the delta touches S | the lane's machine | 10 min |
| Pull request marked ready | `pr` (the gate) | what the `commit` reviews did not cover, plus one integration pass over joins and one-hop callers | tier S: security, correctness, performance, quality, rules, test-truth; N: correctness, quality, performance, rules; D: correctness, rules | every tier S change, profiles by path | the lane's machine | 25 min, falling as coverage grows |
| Updated from `main` | receipt reuse | none when the patch-id and its neighbourhood are unchanged; else a delta of the affected joins | as needed | if S | the lane's machine | seconds |
| Fix pushed after findings | `commit` (delta rule) | the fix and the units it touches; any S file widens to its package | as the gate | if S | the lane's machine | 10 min |
| Push to `main` | `merge` | merge tree equals the reviewed head's tree | none, or delta lenses if not equal | as tier | CI (deterministic) | 3 min |
| Every night at 01:00 | `all` over every package changed that day (the whole tree on the first night); `sweep` by content key once the cache exists (H-03) | as named | all lenses | on S units | machine A | bounded by [RV-13]'s caps |
| Before production | `all --cold` | the whole repository, cache ignored | all lenses, joins, CI lens | on S | both machines | days |

- **EX-09. Where reviews run in the first days.** fin-review runs on the owner's two machines as the
  `fin-review` OS user, which holds the receipt-signing key; `gate` checks the signed receipt with
  `main`'s checker. CI-hosted review comes in H-03 ([RV-04], [RV-05]).
- **EX-10. Models and effort (R11).** Defaults: overall `claude-opus-5-5` at `xhigh`; attack pass
  `claude-fable-5-2` at `high`; the second sceptic on high and critical findings uses the attack model
  and effort. Only Opus or Fable may be selected, for the overall run and for the attack pass
  separately, each at `high` or above: 27 of the 36 option combinations are valid; effort below `high`
  is refused everywhere; (Fable overall, Opus attack) is refused, and (Opus overall, Fable attack) is
  allowed; no other model family is ever called. **No fallback, ever**: one retry with the same
  settings, then the lens is "could not check", which blocks ([RV-03], [RV-19]).
- **EX-11. No built-in reviews in any gate** until SP-12 proves every sub-agent of `/code-review` and
  `/security-review` runs on Opus or Fable; then they may run as extra, non-gating candidates whose
  sessions are recorded in the receipt ([RV-10]).
- **EX-12. Sibling search.** For each confirmed finding, the class's search runs across the repository
  in the same run, and its hits go to triage before merge.
- **EX-13. Findings in public.** The pull request shows counts by severity and lens and the receipt's
  hash. The text of a finding stays on the owner's machines, validated in code before a builder reads
  it ([RV-21]); a security finding found after merge goes to a private security advisory.

**Attack profiles by day** (each a defensive trace: "can this actor reach X; quote the guard on every
path"):

| Day | Profiles |
|---|---|
| Phase 0 | Pipeline attacker (workflow edits by a builder, cache poisoning, `pull_request_target`, unpinned actions, a forged receipt); public-repository leak; a neighbour on Railway's private network; a holder of a tunnel token; a request that does not come through a connector; a holder of the static deploy token replacing an app's assets with a script or different files; a path that the edge serves as static but the tunnel routes as `/api/` (or the reverse) after normalisation |
| Saturday | A member or staff user exceeding a granular role or acting on someone who outranks them; step-up bypass (a used intent, an intent for another action, a proof from another session, a replayed ceremony); a mailbox-only staff enrolment; account enumeration; session fixation, cookie tossing from a sibling host, and cookie scope; an unlisted Better Auth endpoint; invitation hijack by an unconfirmed address; giving more than one holds; removing the last admin; CSRF: a cross-site or sibling-host POST, a missing `Origin` or `X-Fin-App`, a form or `text/plain` body; a forged Access identity; a leaked service login writing a critical table |
| Sunday | Cross-organisation and cross-mode reads (IDOR); a forged or replayed Sumsub webhook; hosted-link token theft and reuse; personal data in logs, errors or events; upload abuse (type, size, magic bytes, Sandbox quota); SSRF through webhook endpoints; Sandbox mail abuse; a staff decision without permission; a final rejection restarted; the selfie host reading a link token |
| Monday | Payout replay and idempotency abuse; double spend under concurrency (holds); a forged or replayed MassPay webhook; ledger imbalance or a double posting; a lost provider answer treated as "no money moved"; a payout from a row a failover lost; provider names or bodies leaking to developers; a Sandbox key moving live money; a console-signed call skipping `payments`' checks; "Try it" leaking a key or sending a cookie |

### 1.8 Tests

| Layer | Tool | Runs | Notes |
|---|---|---|---|
| Unit | Vitest 5.1 on Node 26.13.1 | `pnpm check`, CI `check` | Pure logic: engines, state machines, validators, scrubbers, the R11 validator. The design system's components render static markup (`renderToStaticMarkup`), as the ported tests do; no DOM test package (a new one needs the owner's yes) |
| Integration | Vitest with a real Postgres 18 (service container in CI, compose locally) | CI `db` | Grants per role, the audit guard and sequencer, `LISTEN` and `NOTIFY`, leases, limits under concurrency, the `login` trigger. No PGlite |
| Contract and conformance | Vitest | CI `check` | Endpoint-policy sets; the door matrix; OpenAPI route and negative tests; `KycProvider` and `ProviderAdapter` conformance suites, which the fakes and the real adapters must pass |
| Journeys | Playwright 1.65.1 in the pinned container, against the built static apps served by the test-only static server in `packages/testing` (about 60 lines of Node built-ins: each app's real `_headers`, the SPA fallback, and `/api/*` forwarded to the API service's `test` image, as the zone routes do), with stand-ins for Sumsub, MassPay and email | CI `e2e` (4 shards to start), and locally before a round is called done | Passkeys through Playwright's virtual authenticator; clock control for countdowns; the canon as seed with `example.*` addresses; a `securitypolicyviolation` listener on every page; journeys on Chromium |
| Kit and page policy | Playwright on Chromium, Firefox and WebKit, against the kit route (`/__kit`, test build only) | CI `e2e` | D3 §8.2: every component in every state; the edge toggle, the organisation switcher, motion and reduced motion, toasts, drawers, the table, the OTP input; the computed-style assertions that prove the nonce-less meta and the `@layer ui-sdk` line work (D3 §7.5) |
| Seams | CI `seams` | every pull request | Every `release` image started with each seam variable set exits 78; a release static build carries no kit route |
| Release smoke | Playwright against staging's `release` images and the deployed static apps | After each staging deploy | A pre-enrolled smoke account with a read-only custom role; its passkey key and TOTP secret are staging credentials that rotate; no trace, HAR or screenshot uploaded; names printed, never IDs; Fin Admin checked by the owner, because Access stands in front; the header matrix on a deep link and an asset of each app |
| Visual and state coverage | Geometry checks from the specs and `toHaveScreenshot` against fin-next's own committed baselines, in the pinned container; the state manifest; the fidelity diff against the canvas renders locally only, at the ship step (the renders are private) | Hardening (H-02); geometry from Saturday | Must-have states are covered on their day; the rest by PG-03 |

### 1.9 Staging deploys

- **EX-14. Images.** Images are built in GitHub Actions from `main` only, from the `release` target,
  without secrets, pushed to public GHCR packages by digest, with artifact attestations, and deployed to
  Railway by digest. Railway never builds Fin's code. No `railway.json` or `railway.toml`.
- **EX-28. Static builds.** Each app's `dist/` (console, admin, verify, selfie, docs) is built in
  GitHub Actions from `main` only, without secrets, with `build.assetsInlineLimit: 0` and the previous
  release's hashed assets carried in (FW-C13), so an open tab keeps working across a deploy. Source maps go
  to Better Stack's error tracking from the build and are removed from `dist/` before any upload. The
  build is attested and recorded in the release manifest with the hash of its asset manifest ([FD-19]). Zone names are
  never in the build: under same-origin every page talks to `'self'`; the docs' `connect-src` for
  `api.` is rendered by the deploy step from the environment's settings and checked against the
  deploy's hostnames.
- **EX-29. Static deploys** ([FD-19]). A `deploy-static-staging` job uploads each attested `dist/` as
  an assets-only deployment with the pinned `wrangler` from `tools/static-deploy`. It runs in a GitHub
  environment of its own, `staging-static`, which holds only the static deploy token (CR-20) and is
  approved by the owner's account like `staging`; it never shares a job with the Railway deploy, so the
  `ops/fin` job keeps no npm dependency ([CI-03]). Before the upload it refuses a `static.json` with any
  key outside the allowlist; after it, it re-reads each deployment (no script module, no bindings,
  `workers_dev` and preview URLs off) and compares its asset manifest hash with the release manifest.
  Routes are not part of a static deploy: `pnpm fin provision` makes them once with the operator token
  (§2.5), so CR-20 holds Workers Scripts Edit only. Pull-request previews are off for every app.
  Who uploads production's files is the owner's question ([FD-19], before production); the answer put
  to the owner is the operator's launcher, with a token given at the secure prompt ([CI-04]), so
  GitHub holds no production credential. If SP-26 shows that Cloudflare's API alone can make
  an assets-only deployment, `pnpm fin static deploy` (Node built-ins, no dependency) replaces
  `wrangler`, [FD-19]'s alternative.
- **EX-15. Batched, owner-approved.** Staging deploys are **batched** ([CI-03]): after merges, the
  release workflow builds the images and the static builds; `deploy-staging` waits in the `staging`
  environment and `deploy-static-staging` in `staging-static`, and the owner's account approves both at
  each checkpoint (C1 to C4). The Railway deploy follows ARCHITECTURE §11.8's order, the only one; after
  the Railway services have rolled, the static deployments roll (verify, selfie, admin, console, docs),
  each checked by fetching `index.html`, a deep link and one hashed asset with the expected headers;
  then the smoke tests. The operator may also deploy staging by hand with `pnpm fin deploy staging`.
- **EX-16. Migrations.** Migrations are additive first and contract one release later; every migration
  sets `lock_timeout` and `statement_timeout` and passes squawk; each release declares its minimum
  schema version. API changes stay additive within a release, so a static app one release behind still
  works.

### 1.10 The daily rhythm

| Time | Checkpoint | What happens |
|---|---|---|
| 08:00 | **C1, triage** | The steward reports the nightly review and the staging state; the owner judges plausible critical and high findings and approves the waiting staging deploy; spill items are assigned to the 08:00 to 11:00 spill block |
| Every 90 minutes | Merge batch | The steward merges the batch in tier order; lanes update once per batch |
| 13:00 | **C2, midday** | Each lane's first milestone merged or explained; the owner approves the staging deploy; the day's riskiest lane is checked against its cut line |
| 18:00 | **C3, cut decision** | The steward compares must-haves with the time left and applies the day's cut lines (§8.2); stretch work stops if any must-have is red; the next day's specs start |
| 22:00 | **C4, deploy** | Last merges; the owner approves the staging deploy and the smoke runs; the end-of-day report with §0.2's table; the nightly review starts at 01:00 |

- **EX-17.** Each day keeps 08:00 to 11:00 of the next morning as a spill block for the previous day's
  must-haves. Lanes of the new day that do not depend on the spill start at 08:00 anyway.

---

## 2. Phase 0: bootstrap (Saturday 08:00 to 13:30)

Phase 0 builds a walking skeleton: every app host serves its static app from Cloudflare and, except
the docs host, its `/api/*` through a tunnel to Railway, every service logs to Better Stack, the connectors and the
static deployments are watched, and every change passes the merge gate. The auth lanes start during
Phase 0 on pure code (§3.3), so the day does not wait for it.

### 2.1 Order

| Step | Time | Who | Depends on | Delivers |
|---|---|---|---|---|
| P0-0 | 07:30 to 08:45 | Spec lane | the plan | Spec 02's access sections re-read against the morning's spikes and decisions, then identity and email by 10:00, each correction in `docs/plan/specs/` (EX-08) |
| P0-1 | 08:00 to 08:30 | Owner, steward | CR-01, CR-21 | **The owner sitting**: the short list of §0.3, with every other "before Saturday's start" decision defaulting at 09:00. The canvas snapshot and the `fin-motion.css` hash pinned (D3 §8.1); the file itself is copied only if [UI-12]'s answer covers it. The public-safety check run locally over `docs/plan/` and the root `README.md` with the overlay's refuse list; the repository created, public; the plan as the first commit (EX-03); repository settings applied (§2.2) |
| P0-1b | 08:15 to 09:00 | Owner | CR-17, CR-02 | The builder machine account added as a collaborator with its restricted token; the `fin-builder` and `fin-review` OS users on both machines; the receipt-signing keys created in the `fin-review` keychains and their public keys ready for `docs/review/receipt-keys/`; SP-23 (the builder token cannot push a workflow change) |
| P0-2 | 08:30 to 09:00 | Lane P0-B (CI) | P0-1b | **Pull request 1**: a minimal `ci.yml` whose `gate` runs `check` and refuses a change to control paths without the owner's approval; reviewed by hand-started sessions and the owner (EX-18); merged by the owner |
| P0-3 | 09:00 | Owner | P0-2 | The ruleset on `main` switched on ([CI-01]); CODEOWNERS in pull request 1 |
| P0-4 | 09:00 to 10:00 | Steward | P0-3, [G-06] | The rules files, the merge guard and `.claude/settings.json` (owner-committed or a fully reviewed control-path pull request); the workspace with the supply-chain settings proven (SP-01); the bootstrap dependency set installed ([G-06]), `tools/static-deploy` with the pinned `wrangler` first so that S-01 can use it, then the rest, with `@ui-sdk/*` at the newest beta that has cleared (EX-30); `tools/layout.json` with `packages/icons` and `packages/motion`; the public-safety, `static:check` and pre-push checks |
| P0-5 | 08:30 to 12:00 | Lane P0-C (fin-review) | P0-1b | The fin-review MVP, staged (§2.4); the receipt requirement switched on in the pull request that adds `check-receipt`, with AC-P0-03 run at once |
| P0-6 | 08:30 to 11:00 | Lane P0-B (CI) | P0-2 | The rest of the CI workflows (§2.3), each a control-path pull request, including the static builds in `release.yml` |
| P0-7 | 08:30 to 12:00 | Ops agent with the owner | CR-04, CR-05, CR-05b, CR-06, CR-08, CR-09 | The front door, step by step (§2.5), with the front-door spikes S-01 at 09:15, S-04 at 09:45 and S-03 at 10:15 (§2.6); the platform spikes; staging accounts; the watcher |
| P0-8 | 09:30 to 12:30 | Lanes P0-D, P0-E | P0-4 | `packages/server`, `packages/web-host` (the API host for the app services' `/api/*`), `packages/core`, telemetry, the app API skeletons; `packages/db`, `packages/crypto`, `packages/audit` with the guard and the sequencer; the kill-switch table (§2.10) |
| P0-9 | 09:30 to 12:15 | Lane P0-G | P0-4, [UI-12] | The design system on the UI SDK in two waves (D3 §9): **wave 0** (09:30 to 10:45) `@fin/tokens`, `@fin/icons`, `@fin/motion`, Button and IconButton (with the 24px size), Spinner, Tooltip, Field, InlineAlert, Logo, Badge, the Skeleton family, each app's `index.html`, `/theme.js`, stylesheet order and `static.json`, with the page-policy lines of the `_headers` profiles (in `packages/web-host/src/static/`, with P0-D); **wave 1** (10:45 to 12:15) AppShell, Sidebar with the edge toggle, the phone sheet, EnvironmentSwitch, the organisation switcher, DropdownMenu, AccountMenu, PageHeader, Tabs and TabLinks, EmptyState, ErrorState, Toaster, AuthLayout and AuthCard, `packages/frame` and AdminFrame |
| P0-10 | 10:00 to 12:00 | Lane P0-E with the identity lane | P0-4 | FW-S2: Better Auth 1.7.25 on Hono at `/api/auth/*` with the same-origin settings of §3.1, behind the allowlist, with passkeys and a step-up intent re-sent by `api()` |
| P0-11 | 12:15 to 13:00 | Lane P0-G | P0-9 | FW-S1, as the owner's decisions amend it: the page-policy and kit checks on the built apps under their real `_headers`, on Chromium, Firefox and WebKit, with the computed-style assertions (AC-P0-16). It replaces the nonce spike; L-SAT-06 starts on route stubs meanwhile |
| P0-12 | 12:00 to 13:30 | Ops agent, steward | P0-5 to P0-9 | The walking skeleton on staging (§2.5 steps 8 to 12), S-01b on the real console host, S-02 at 12:30 on the console host; Phase 0 exit (§2.11) |

- **EX-18. Reviewing Phase 0 before the fin-review MVP gates it** ([RV-01], [RV-10]). Until
  `check-receipt` is on `main` and the receipt requirement is switched on (P0-5), these replace the
  fin-review gate for every pull request, pull request 1 included:
  - **Hand-started sessions.** One security lens session and one attack session, each started by hand
    with the MVP's prompts as the `fin-review` OS user, on a model and effort that R11 and [RV-06]'s
    floor allow (EX-10); both are recorded in the pull request with their models and efforts.
  - **No built-in review command** takes part, as a reviewer or as a gate (EX-11, [RV-10]).
  - **The owner's read.** The owner reads every control-path file in the pull request (the list in
    [CI-14]: `.github/**`, `tools/fin-review/**`, `ops/fin/**`, each app's `_headers` and
    `static.json`, `tools/static-deploy/**`, `.claude/**` with the merge guard, and the rest) and the
    pull request records that read; the owner merges it (EX-03).
  - **The first night's review** (01:00 Sunday) runs `all --cold` over everything merged, so the
    bootstrap is fully reviewed by fin-review within 24 hours (§1.7, §3.4).
  - **If the MVP slips** past C2 (13:00), this rule stays in force for every pull request until the
    receipt requirement is on, and no tier S pull request merges without its hand-started attack
    session (§3.7).

### 2.2 Repository and rules files

**Repository settings** (applied by the owner, or by an agent's `gh api` script the owner runs with the
owner's account):

- public, personal account; Issues, Discussions, Wiki and Projects off; interaction limits set to
  collaborators only ([CI-15]);
- Actions allow only GitHub's own and listed actions; every action pinned to a full SHA (the repository
  setting); default `GITHUB_TOKEN` read-only; "Allow GitHub Actions to create and approve pull
  requests" off;
- fork pull requests need approval for all outside contributors; no secrets or write tokens for forks;
- secret scanning and push protection on; Dependabot alerts on; private vulnerability reporting on;
  CodeQL default setup;
- the `staging` and `staging-static` environments, each with the owner's account as the only required
  reviewer, deployment branch `main` only;
- the builder account as a collaborator (write);
- the ruleset of EX-05 after pull request 1 (P0-3).

Rulesets on a personal public repository are believed available on GitHub Free; code-owner review with
zero general approvals is SP-23 (UNVERIFIED). GitHub Pro is taken from Saturday ([CI-06]).

**Files written fresh, informed by the old rules:**

| File | What it says |
|---|---|
| `AGENTS.md` | The standing rules ([G-08]): process rules for Node on Railway; every important action audited; every change monitored on Better Stack; reviewed pull requests only, the merge command and the control paths; security enforced on the server (the NB rules); dependencies (ask first, registry facts, `pnpm add` only, catalog, never loosen a protection); screens from `@fin/ui`, and no `@ui-sdk/*` import outside `packages/ui`; no code at Cloudflare for an app (assets-only static deployments); nothing from another origin at run time except the selfie host's Sumsub exception; the public-repository rule (nothing secret, no staff addresses, no account or tunnel IDs, no zone names); rules for "Fin's own API routes", not server functions |
| `CLAUDE.md` | Imports `AGENTS.md`; nothing else |
| `CONTRIBUTING.md` | Layout and `tools/layout.json`, commands, lane and fragment rules (§1.3), how to write a spec, the definition of done |
| `CODEOWNERS` | The owner for every control path ([CI-14]), the `_headers` profile templates (`packages/web-host/src/static/**`), each app's `static.json` and `tools/static-deploy/**` included |
| `SECURITY.md` | How to report a vulnerability (private advisory); no bounty promise |
| `LICENSE` | Per [G-03]; third-party notices for the UI SDK (Apache-2.0), the glyphs and cues (MIT) and the fonts (OFL) beside the packages that carry them |
| `pnpm-workspace.yaml` | `minimumReleaseAge: 4320`, `minimumReleaseAgeStrict: true`, `minimumReleaseAgeIgnoreMissingTime: false`, `trustPolicy: no-downgrade`, `blockExoticSubdeps: true`, `strictDepBuilds: true`, `allowBuilds: {}`, `engineStrict: true`, the `catalog:` (`@ui-sdk/react` and `@ui-sdk/core` exact) |
| `.node-version`, `package.json` `engines` | Node 26.13.1; `>=26.13.1 <27` |
| `tsconfig.base.json` | `erasableSyntaxOnly`, `verbatimModuleSyntax`, relative `.ts` imports (option names checked with `tsc --showConfig`) |
| `.claude/hooks/merge-guard.mjs`, `.claude/settings.json` | EX-06 |
| `scripts/public-safety.mjs` | Refuses email addresses outside `example.*`, strings shaped like account IDs, tunnel IDs, tokens or private IP addresses, the canvas or artifact identifiers, and, from the overlay's refuse list, the zone names, the old repository's name, the design system's private repository name, the redesign pull request's reference and the port's source commit (in full, or any prefix of 7 or more characters), in tracked files; also the pre-push hook |
| `scripts/static-check.mjs` | `static:check` (§1.5, item 1) |
| `tools/layout.json` | ARCHITECTURE §3.1, machine-readable, with `packages/icons` and `packages/motion` |

- **EX-19. pnpm.** Pin pnpm 12.21.0 if every supply-chain setting is shown to refuse an install (SP-01);
  otherwise pin 11.28.12 ([P-06]). Install pnpm in CI from its checksummed release tarball, never
  through the npm wrapper's scripts.

### 2.3 CI (P0-2, P0-6)

All workflows: `permissions: {}` at the top, least per job, `timeout-minutes`,
`persist-credentials: false`, no `${{ }}` inside `run:`, actions pinned by SHA, runner `ubuntu-24.04`,
concurrency cancelling superseded pull-request runs, and no comment trigger. Every workflow file is a
control path, written by the CI lane with its own token and approved by the owner.

| Workflow | Jobs in Phase 0 | Added later |
|---|---|---|
| `ci.yml` (`pull_request`, `push: main`) | `plan` (fin-review's deterministic planner: tier from `tools/layout.json`, jobs to run, e2e selection; under 30 s); `check` (Biome, typecheck, unit, `layout:check`, generated-file checks, `monitoring:check`, `static:check`, public-safety); `db` (Postgres 18 service by digest); `build` (both image targets and each app's static `dist/`); `seams`; `e2e` (Playwright container by digest, sharded: journeys on Chromium against the built static apps and the `test` images; the kit and page-policy specs on three engines); `static-analysis` (zizmor, actionlint, gitleaks with Fin's shapes, squawk and the migration-order check, hadolint); `gate` (needs all; passes only if each job passed or was skipped because `plan` said so; verifies the signed receipt with `main`'s checker) | The reusable `review.yml` and `ci-report` (H-03) |
| `release.yml` (`push: main`) | Build each changed `release` image without cache, carrying the previous release's `/assets` where an image serves any; build each app's static `dist/` with the previous release's hashed assets carried in (EX-28); push images by digest to GHCR, attest images and static builds, write the release manifest; `deploy-staging` (Railway, `ops/fin` only) and `deploy-static-staging` (the pinned `wrangler`, EX-29), each waiting for the owner's approval in its own environment (EX-15) | |
| `dependencies.yml` | `pnpm audit`, signatures, OSV, dependency review on pull requests | |
| `containers.yml` | hadolint, build of both targets, SBOM, Grype, non-root and no-secret-file checks | |
| `codeql` | GitHub default setup | |
| `nightly.yml` | Full e2e, online zizmor audits, full-history gitleaks | the review sweep in CI (H-03) |
| `bun.yml` | One non-blocking job running the unit suite and the SSRF refusal tests on Bun 1.4.5 (R15) | |

- **EX-20.** `gate` is the only required status check. Fork pull requests never run a job that holds a
  credential; `pull_request_target` is never used.
- From the first day, fin-review's `plan` decides which CI jobs run: a docs-only change skips build,
  e2e and containers; an unmapped path runs everything; a test proves every path pattern maps. This is
  R10's "makes CI faster" in its first form.

### 2.4 fin-review MVP (P0-5)

The MVP lives in `tools/fin-review/` (Node 26 TypeScript, `node:` built-ins only, no dependency) with its
procedure in `docs/review/`. It is built in three slices, so the gate is real by late morning without
waiting for the whole engine.

| Slice | By | What |
|---|---|---|
| 1 | 10:30 | The R11 validator (a table test over all 36 combinations, accepting exactly the 27 valid ones, refusing the 9 Fable-with-Opus-attack ones, every effort below `high`, `ultracode`, `auto`, any alias outside {opus, fable} and bare model IDs, at the CLI, the config file and the CI inputs; a test that the second sceptic resolves to the attack model); the planner (`plan`: changed files, tier from `tools/layout.json`, lens list, attack yes or no, CI job flags); `commit` and `pr` with the lenses (security, correctness, performance, quality, rules, test-truth) and the attack pass with Saturday's profiles; the session lock-down ([RV-19]: exact model IDs, an allowlisted environment that refuses base URLs, provider switches, aliases and sub-agent models, read-only tools, deny rules, no settings files, the post-session `modelUsage` check); the signed receipt pushed to its ref, `gate` re-run by the engine, and `check-receipt` |
| 2 | 12:00 | Sceptics (one per finding; a second on the attack model for high and critical; the verdict table); `merge` mode; receipt reuse by patch-id ([RV-20]); finding validation ([RV-21]); `all` over named packages under a budget cap |
| 3 | afternoon | `fin-review doctor`: the Claude Code version, both model IDs answering, no settings file capping effort, background calls pinned or off (one session's `modelUsage` must name only the requested model, else it fails closed), and SP-12's check of the built-ins' sub-agent models; the self-test on a fixture with four planted items (an auth defect, a money-shaped defect, a performance defect and a text addressed to the reviewer), run with real agents: it passes at 3 of 4 with the miss logged while the gate is already on, and the miss is fixed before Sunday |

Sessions are separate `claude -p` runs from the pinned Claude Code CLI, as the `fin-review` OS user; no
new package is needed until the CI runner (H-03, [RV-11]). The cache, joins, `sweep`, `ci` and
`ci-report` come in H-03.

- **EX-21.** No Sonnet or Haiku anywhere in fin-review: bookkeeping is code. A refused or failed session
  retries once with the same settings, then marks its lens "could not check", which blocks the merge like
  any unfinished lens.

### 2.5 The front door on staging, step by step (P0-7, P0-12)

This applies the owner's 02:40 and 03:50 decisions ([FD-01], [FD-13], [FD-17], [FD-18]; ARCHITECTURE
§5). Every step
runs through `pnpm fin` with the operator token typed at the secure prompt, except where a step says
the owner does it in Cloudflare's console. Tokens are fetched and set by `pnpm fin`, never printed. The
shape below is the same-origin one; if S-01 fails, its fallback (§2.6) replaces steps 5, 6 and 8.

| Step | When | What | Needs | Proves |
|---|---|---|---|---|
| 1. The zone | 08:30 | The new staging zone active on Free, Universal SSL on; `pnpm fin zone apply staging` sets ARCHITECTURE §5.11's settings (TLS 1.2 minimum, TLS 1.3 on, 0-RTT off, Automatic SSL/TLS Custom, Always Use HTTPS off, Bot Fight Mode off, IP Geolocation on, Rocket Loader and every other content transform off) and the DMARC record | CR-05b, CR-05 | `pnpm fin verify` reports no drift |
| 2. S-01 | 09:15 to 09:45 | The no-Worker route spike on a throwaway host (§2.6), before any real host exists. Its result fixes the shape for steps 5, 6 and 8 | CR-04, CR-05 | §2.6 |
| 3. Railway services | 09:00 to 10:00 | `pnpm fin provision staging` (the thin first version against a written checklist, [P-13]) creates the services of §2.7 with no domain and no TCP proxy; static outbound IPs on `cloudflared-public`, `cloudflared-admin`, `api`, `worker` and `payments` (S-04 reads them back); outbound IPv6 off; draining and overlap as ARCHITECTURE §4.3 | CR-04 | `pnpm fin verify` lists no domain and no TCP proxy |
| 4. The tunnels | 09:45 | `pnpm fin tunnel create staging public` and `... admin`: locally managed (SP-04a), so no remote configuration applies. Each tunnel's token is set as a sealed variable on its own connector service only (`cloudflared-public`, `cloudflared-admin`); the standby services `cloudflared-public-b` and `cloudflared-admin-b` exist at 0 replicas with no token; `cloudflared-db` exists at 0 with no token, and the db tunnel itself is made with its Access TCP application before production (H-05; spec 01 S0-17) | CR-05 | The watcher, once live, sees each tunnel locally managed |
| 5. The ingress map | with the first connector image | The supervisor renders `cloudflared`'s configuration from `apps/connector`'s map and the hostnames in the connector service's non-secret settings. Public tunnel: the `console`, `verify` and `selfie` hosts with `path: ^/api/` to `console` and `verify` (the selfie host reaches only verify's selfie operations); the `api` host with no path rule to `edge`; no entry for `developer`, which has no `/api/` path (spec 01 S0-01), so the catch-all answers if its static route ever vanished. Admin tunnel: the `admin` host with `path: ^/api/` to `admin`, with `access.required`. Each entry sets `httpHostHeader`; each map ends with `http_status:404`. The supervisor refuses a hostname outside the zone, an unknown role or a target outside the map | The connector image | `cloudflared tunnel ingress rule` answers as expected for each host and for `/x/../api/y` and `//api/y` (S-01 (g)) |
| 6. DNS | 10:15 | Proxied CNAMEs to each tunnel's `<tunnel id>.cfargotunnel.com`: `console.`, `verify.`, `selfie.`, `developer.` and `api.` to the public tunnel, `admin.` to the admin tunnel; no `status.` record (the status page is production's, on the hosted zone, [OB-09], [FD-10]); no record for `db.` until the db tunnel and its Access TCP application exist (before production, H-05). Until then the operator works inside the database only through registered `pnpm fin task staging <name>` runs of `migrate`, never `railway connect`, which needs the TCP proxy NB-07 forbids (spec 01 S0-17, ARCHITECTURE §5.13, [FD-11]) | CR-05 | `tunnel-config-drift` finds each record pointing at its own tunnel |
| 7. Zone rules | 10:30 | Request Header Transform Rules adding each host's ingress proof (`Fin-Ingress-Proof`, the current and previous values sealed on the service). Cache Rules: bypass the cache for `starts_with(http.request.uri.path, "/api/")` on the app hosts and for everything on `api.`. Plain http: one Single Redirect (GET and HEAD to https, 308) and one WAF custom rule (any other method over http, 403) on the browser hosts; on `api.` plain http reaches the edge ([FD-03]). One rate rule on the API's `/v4/` prefix. The Free Managed Ruleset. No challenge action on `api.` or on any `/api/*` path | CR-05 | The rule sets' hash recorded for the watcher |
| 8. Static deployments and routes | 12:00 (P0-12) | `deploy-static-staging` uploads the first static builds (EX-29); `pnpm fin provision staging`'s routes step (`routes apply`) then sets the Workers route `<app>.<staging-zone>/*` to its assets-only deployment for each of `console`, `verify`, `selfie`, `developer` and `admin`, and the zone route `<app>.<staging-zone>/api/*` with **no Worker** ([FD-18]) for each of them but `developer`, which has no `/api/` path (spec 01 S0-01 and §7.5). Never `/api*` without the slash (it matches `/apix` and has a documented specificity issue). Each app's rendered `_headers` gives `index.html` `Cache-Control: no-cache` and `/assets/*` `public, max-age=31536000, immutable` | CR-20, CR-05 | AC-P0-14 |
| 9. Access | by 12:00 | The owner, in Zero Trust (CR-07): one self-hosted Access application on `admin.<staging-zone>` covering the whole host, static files and `/api/*` alike; an Allow policy with the exact staff list from the overlay; binding cookie on; HttpOnly, `SameSite=Lax`; session of 8 hours or less; `app_launcher_visible: false`; Access independent MFA required (TOTP allowed in staging). A one-time PIN is the identity method only until Google Workspace with 2-Step Verification is in place ([FD-05], by 22:00), which must happen before any provider credential reaches staging. The admin connector validates the Access token (`access.required`), and the admin API validates it again on every request | CR-07 | SP-04c, AC-SAT-12 |
| 10. The watcher | 11:00 to 12:00 | `pnpm fin watcher deploy staging` uploads the watcher Worker ([OB-18]) to the staging account with its read-only tokens, on a minute cron, heartbeat to Better Stack. It checks: each tunnel's connectors (the count equals the expected replicas; every `cloudflared` version equals the pin; every origin address is inside its connector service's static egress; the db tunnel, once it exists, at zero outside a registered run); each tunnel still locally managed with no remote configuration; every DNS record; the Transform, Cache, Redirect and WAF rules' hashes; the zone settings; the Access application and policy; Email Sending's settings; **every static deployment** (no script module, no bindings, `workers_dev` and preview URLs off, the asset manifest hash equal to the release manifest's, the route list exactly as rendered, each no-Worker `/api/*` route included); Railway's domains and TCP proxies if SP-21 passes; the vault | CR-18 | AC-P0-08, AC-P0-15 |
| 11. Connectors start | 12:00 | `cloudflared-public` and `cloudflared-admin` scaled to 1, only once the watcher is live; the watcher sees the expected count, version and origin. From the first request, each service's ingress check trusts a request only when its TCP peer is a current replica of its own connector services (re-resolved every 15 seconds, `::ffff:` normalised) and the host's ingress proof matches; anything else gets 403 `ingress.untrusted_peer`, which alerts, and its `CF-*` headers are dropped | step 10 | AC-P0-07 |
| 12. Evict prepared | 13:00 | The evict runbook ([FD-15], `docs/runbooks/evict-tunnel.md`): `pnpm fin tunnel prepare staging public --dry-run` lists what the blue and green swap would change. The drill, with times recorded, is in hardening (PG-05) | step 11 | The dry run's plan matches the runbook |

### 2.6 Spikes

**The front-door spikes** (the owner's 03:50 decision asks for S-01 first thing on Saturday). Each has
a pass rule and a fallback written down, so Phase 0 never stops on one. Results go into
`docs/plan/spikes.md`.

| Spike | When | What, and the pass rule | If it fails |
|---|---|---|---|
| **S-01** (SP-25) The no-Worker route falls through to the tunnel (C1 §5, [FD-18]) | 09:15 to 09:45, throwaway host `c1-spike.<staging-zone>` (and `c1-spike-admin.<staging-zone>` for (i)), its connector a throwaway Railway service. This is SP-25's one slot, host and connector placement; spec 01 §11 (which adds pass checks) and spec 02 §2.1 refer here | **Set-up:** confirm on the zone's Origin Rules page that only the destination-port override is offered (a screenshot for the record). Make a throwaway tunnel with one published route, host `c1-spike`, `path: ^/api/`, service `http_status:418`, its connector a throwaway Railway service from the pinned `cloudflared` image with static egress on (S-04 uses it), and its proxied CNAME. Make a throwaway assets-only deployment of `index.html` (body `STATIC-OK`) and `assets/a.js`, with `not_found_handling: single-page-application`, `workers_dev: false`, `preview_urls: false` and no script, made with the pinned `wrangler` from `tools/static-deploy` (if it cannot be installed by 09:15, through the console's static-upload flow instead, a provider console step allowed for a throwaway and recorded); route `c1-spike.<staging-zone>/*` to it and `c1-spike.<staging-zone>/api/*` to no Worker. **Pass when:** (a) `/` and (b) `/settings/team` show `STATIC-OK` with the test `_headers`; (c) `/api/ping` and (d) a JSON POST to `/api/auth/sign-in/email` answer 418; (e) a same-origin `fetch('/api/ping', { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })` in the page answers 418 with no OPTIONS and no 3xx; (f) `/api/ping` typed in the address bar answers 418, not the SPA; (g) `curl --path-as-is` on `/x/../api/ping`, `//api/ping` and `/api%2Fping`: the edge's choice (static or tunnel) and the tunnel's match agree for each, recorded with the pinned `cloudflared`'s normalisation; (h) the deployment's metrics show no Worker invocations; (i) on the second throwaway host `c1-spike-admin.<staging-zone>`, behind a throwaway Access application, `/` and `/api/` both meet Access, and no `workers.dev` or preview copy answers. **Teardown:** the routes, the deployment, the tunnel, its connector service and the DNS record. **S-01b** at P0-12 repeats (a) to (f) on the real `console.<staging-zone>` through `deploy-static-staging` and the provisioned routes | **(c) shows `STATIC-OK` or a Workers error, or an assets-only deployment cannot hold a route:** per-app API hosts on the same site, [FD-18]'s fallback with [SA-43]'s and [SA-44]'s settings (ARCHITECTURE §5.17; C3 §3). `console-api.`, `verify-api.` and `admin-api.` are proxied CNAMEs to their tunnels, with ingress by host and no path rule; the static apps are assets-only deployments on Workers custom domains; CORS for the exact app origin with credentials, `Access-Control-Max-Age: 7200` and `Vary: Origin`; cookies set by the API host; `Sec-Fetch-Site: same-site`; Better Auth's `baseURL` the API host and `trustedOrigins` the app origin; the passkey `rpID` the page host; absolute callback URLs; `connect-src 'self' https://<app>-api.<staging-zone>` rendered at deploy; one Access application covering `admin.` and `admin-api.` with `cors_headers`. The owner is told at C2. No lane's plan moves: `api()` takes its base URL from the per-environment `env.json` that the deploy step writes beside the static files (spec 01 S0-05 and §7.4, ARCHITECTURE §5.17), so no zone name enters a build. **(g) disagrees:** a WAF custom rule refuses paths containing `..`, `//`, `%2F`, `\` or `;` on the app hosts |
| **S-02** (FW-S2's browser checks) Cookies and CSRF in real browsers ([SA-43], [SA-44]; C2 §11, C3 §5 adapted to one origin) | 12:30 to 13:00 on `console.<staging-zone>`, once FW-S2's sign-in stub is deployed | On Chromium, Firefox, and WebKit on macOS, with third-party cookies blocked. **Pass when:** after sign-in, `__Host-fin.session_token` shows `Strict`, `HttpOnly`, `Secure`, `Path=/` and no `Domain`, and every other Fin cookie `Lax`; `get-session` carries the session with `Sec-Fetch-Site: same-origin`; after opening the console from a link on another site, `get-session` still carries it; a cross-site form POST and `fetch`, a POST from the sibling host `verify.`, a POST without `X-Fin-App`, a `text/plain` body and a request with no `Origin` are each refused with 403 `invalid_origin` and one `csrf.refused` line with its reason; the console's own calls never send OPTIONS; a passkey ceremony runs with `rpID` `console.<staging-zone>` (virtual authenticator). The Google round trip and emailed links are proven in Playwright against a mock identity provider | Stop and re-read before L-SAT-06's sign-in screens merge. The likely causes: an attribute set through `defaultCookieAttributes` instead of the per-cookie override, `BETTER_AUTH_TRUSTED_ORIGINS` set (the service refuses to start if it is), or the origin gate's order |
| **S-03** (SP-07) Email Sending from Railway | 10:15 to 10:45 | Run once on the `worker` service itself, before its first real image, with a one-line command from the pinned Node build image, so the send leaves from `worker`'s own static egress; the email token (CR-08) is its sealed variable. **Pass when:** one security template sent through the REST API reaches the seed inbox with DKIM, SPF and DMARC passing (the owner reads the headers, recorded); a send with the same token from another service's address is refused (the client IP filter is honoured); the `Ratelimit` headers, whether sends count towards the API-wide limit, the starting quota, and the token's other powers (editing suppressions, toggling preview, reading the activity log) are recorded | The outbox keeps the rows and security emails wait until it passes. If the IP filter is not honoured, that is recorded as an accepted staging risk, with the token's 180-day expiry and the watcher's settings check |
| **S-04** (SP-08's egress part) Static egress IPs | 09:45 to 10:00 | Static outbound on the services of §2.5 step 3 and on S-01's throwaway connector; the addresses read back by `pnpm fin verify` and written to the private overlay. **Pass when:** the throwaway connector's origin address, as Cloudflare's tunnel connection list shows it, equals its service's static egress (the watcher's origin check depends on this); the address is unchanged after one redeploy of that service; the price is recorded | The watcher's origin check widens to Railway's published ranges, recorded; provider allowlists (Sumsub, MassPay, the email token's filter) wait |

**The platform spikes** (ARCHITECTURE §11.11 and §5.15). Each failure has a fallback, so Phase 0 never
stops on one.

| Spike | Pass rule | If it fails |
|---|---|---|
| SP-01 pnpm 12.21.0 (P0-4) | Each supply-chain setting refuses as it should | pnpm 11.28.12 ([P-06]) |
| SP-03 Railway image by digest; project token | A service deploys `ghcr.io/...@sha256:...` through the API and reports that digest; the staging project token can update an image and deploy it | Immutable per-commit tags and a digest check; a workspace token per run from the secure prompt |
| SP-05 Postgres 18 | `SHOW server_version` 18.7 or later (18.6 recorded as an accepted staging risk); PITR on; the CA pinned; roles by SQL; the guarded `login` trigger | Ask Railway; the trigger off until fixed, with the privileged logins read from Postgres logs |
| SP-04a to SP-04g Tunnels | ARCHITECTURE §5.15: a locally managed tunnel from a token with the rendered map; the peer check across a connector redeploy; Access at the admin connector; keep-alive; `http2`; the watch sees count, version and origin; the supervisor's loopback metrics and watchdog | The remote-configuration fallback of ARCHITECTURE §5.3, hashed every minute; the proof header alone while the peer check is fixed |
| SP-06 Better Stack | One native JSON batch shipped and read; one error from the server client and one relayed from the browser through the app's own `/api/monitoring/envelope`, each with `release` and `environment`; one alert created by API | Stdout as the record; alerts by hand for the day |
| SP-26 Static deploys (before the first staging deploy) | ARCHITECTURE §5.15: the served headers equal the built `_headers` for `/`, a deep link and an asset; the single-page fallback; `workers_dev` and preview URLs off; whether Cloudflare's API alone can make an assets-only deployment | `wrangler` stays the uploader ([FD-19]) |
| SP-21 Railway read-only credential | A credential that cannot deploy reads every service's domains and TCP proxies | `pnpm fin deploy` refuses to finish while any exists, and `pnpm fin verify` checks daily, recorded as a gap |
| SP-23, SP-24 GitHub controls and receipt refs | ARCHITECTURE §11.11 | No agent token may push workflow files (the owner pushes the CI lane's commits); a `receipts` branch for receipts |
| FW-S1, as amended (P0-11) | The page-policy and kit checks on the built apps, served under their real `_headers` by the test static server, on Chromium, Firefox and WebKit: zero `securitypolicyviolation` events, the computed-style assertions hold (AC-P0-16), the page behind an open drawer does not scroll, and the built HTML has no inline script | FW-X7: `style-src 'self' 'unsafe-inline'` for styles only, scripts unchanged; not expected (D3 §7.2) |
| FW-S2 (P0-10) | Better Auth 1.7.25 on Hono at `/api/auth/*` with §3.1's settings: sign-in, the second factor and step-up work end to end, and unlisted paths answer 404 before the library sees them | Stop the identity lane's merges and re-read the installed source |

### 2.7 What exists on staging at the end of Phase 0

- **Railway:** a new staging workspace, one project, region `us-east4-eqdc4a`, two-factor sign-in
  required; no PR environments; **no public domain and no TCP proxy on any service**. Services
  `cloudflared-public`, `cloudflared-admin` (and their standby `-b` services at 0), `edge`, `api`,
  `worker`, `payments`, `console`, `admin` and `verify` (each of these three serves only its host's
  `/api/*`, [P-07]), `migrate` (task), `backup` (cron), `cloudflared-db` (0, no token) and `postgres`:
  15 services, three of them at 0 replicas (spec 01 §6.2), each Fin service answering `/healthz` and
  `/readyz` privately, with drain and overlap set. There is no `docs` service: the docs site has no
  `/api/` path, and its browser reports go to the edge (spec 01 S0-01, spec 05 §8.13).
- **Postgres 18** (standalone, PITR); one group role and two logins per service created by the first
  migration; `fin_owner` with no standing password; the superuser kept out of the services.
- **Cloudflare, the staging zone** ([FD-09]): `console.`, `verify.`, `selfie.`, `developer.` and
  `admin.` each with an assets-only static deployment on `/*`, and each of them but `developer.` with a
  no-Worker route on `/api/*` to its tunnel ([FD-17], [FD-18]); `api.` straight to the public tunnel; the Transform Rules adding each host's ingress proof; the Access application on `admin.`
  with the staff list (CR-07) and the binding cookie. Under S-01's fallback, the `<app>-api.` hosts
  instead; under [FD-09]'s fallback, the `-next` names.
- **The watcher**, live: connectors, tunnel configuration, DNS, zone, rule sets, Access, Email Sending,
  the static deployments and their routes, the vault, Railway's domains if SP-21 passed; its heartbeat
  green.
- **Better Stack:** team `fin-staging` (region `europe`), one source and one Errors application per
  service, uptime monitors on `api.`'s `/health`, on `/api/health` of `console.` and `verify.`, on the
  static pages of `console.`, `verify.` and `developer.`, and on Access's redirect at `admin.` (spec 01
  §8.4), the API canary, the quiet staging policy.
- **Email:** Cloudflare Email Sending onboarded for the staging zone's `auth.` and `notify.` sending
  subdomains; preview and drop-suppressed off by API.

### 2.8 Dependencies to approve ([G-06])

The bootstrap needs many packages at once. The owner approves the set of [G-06], as §0.3 (decision 1)
amends it, in the 08:00 sitting, after the steward prints each package's registry facts (name and
scope, age of the version, maintainers, install scripts, provenance, repository, dependencies,
licence). It is installed in a few grouped pull requests by layer, as a written one-time exception to
"one dependency change per pull request". Every later dependency follows the normal rule. The set has
TanStack Router and its plugin (not Start), Better Auth at 1.7.25, the UI SDK at one exact beta,
`wrangler` in `tools/static-deploy` only, and no phone-number, QR or class-name library; the lockfile check refuses the server-function and
server-component packages and Radix, and requires the `seroval` floor.

- **EX-22. Better Auth versions** ([SA-02]). Start on 1.7.25; FW-S2 runs on it. The identity lane reads
  the 1.7.26 and 1.7.27 release notes before its first merge. If either fixes an advisory that touches a
  mounted plugin, the owner decides between waiting and [SA-27]'s fast path. Otherwise all four packages
  move to 1.7.27 together on Monday 23 Nov after 10:53 UTC, through one dependency pull
  request gated by the endpoint-policy and pin tests. The release-age settings are never loosened.
- **EX-30. UI SDK versions** ([G-06], [UI-10]; D3 §3). `@ui-sdk/react` and `@ui-sdk/core` move
  together, exact, in the `catalog:`, at the newest beta that has cleared the release age when the pull
  request runs: `0.1.0-beta.9` at P0-4's time (both cleared at 03:02 UTC), or `0.1.0-beta.10` if the
  install runs after 09:47 UTC. On Sunday after 12:24 UTC: one dependency pull request to
  `0.1.0-beta.13`, with D3 §3.4's checks (registry facts, the decoded attestation's commit on `main`
  from `release.yml`, every changelog section, the kit and page-policy specs on three engines, the
  screenshot regression and a bundle-size diff), merged before Monday's money screens. Refused even
  inside `@fin/ui`: `@ui-sdk/*/agent`, `@ui-sdk/react/preferences`, `token-input`,
  `@ui-sdk/core/web.css`, every all-experimental entry and core's experimental grid, virtualiser,
  cell-range and lasso helpers. Dependabot groups `@ui-sdk/*` with a 3-day cooldown.

### 2.9 Credentials and accounts the owner provides, and when

Every value below goes into the secure prompt or into the provider's own console. None is written to
the repository, a file or a log. "Lives in" says where it ends up. The ones due before 10:00 are in
§0.3 with their exact scope; this table is the whole list.

| ID | What | Created by | Scope | Lives in | Needed by | Blocks |
|---|---|---|---|---|---|---|
| CR-01 | The repository `aktharazif/fin-next`, public, its settings, environment and ruleset; GitHub Pro | Owner (or the owner runs the agent's `gh api` script) | Admin of the repository | GitHub | Sat 08:00 | Everything |
| CR-02 | Claude Code signed in for the `fin-builder` and `fin-review` OS users on both machines | Owner | §0.3 | Each OS user's login | Sat 08:30 | Builders, fin-review |
| CR-03 | Anthropic Console organisation for CI review, with the data retention Fable needs, a "fin-next CI" workspace with a spend limit, and a Workload Identity Federation rule bound to the reusable review workflow at `main` | Owner | API, CI only | Federation rule IDs as Actions secrets ([RV-05]) | Hardening (H-03) | CI-hosted review only |
| CR-04 | Railway Pro staging workspace and its project token | Owner | §0.3 | Secure prompt for `pnpm fin`; the `staging` environment secret ([CI-03]) | Sat 08:30 | Staging |
| CR-05 | Cloudflare operator token on the staging account | Owner | §0.3 | Secure prompt, per run | Sat 08:45 | Front door, watcher, email |
| CR-05b | The new staging zone in a new Cloudflare account ([FD-09]), with Zero Trust on the Free plan | Owner | Staging | Cloudflare | Sat 08:30 | The zone (fallback: the shared zone's `-next` names) |
| CR-06 | Workers Paid on the staging Cloudflare account | Owner | Account | Cloudflare | Sat 09:30 | Email, the watcher |
| CR-07 | The staff list for the Access application, Access independent MFA settings, and Google Workspace as Access's identity provider ([FD-05]) | Owner, in Cloudflare Zero Trust (never in the repository) | Fin Admin | Cloudflare | Sat 12:00 (the identity provider by 22:00) | Fin Admin on staging |
| CR-08 | The email token and the seed inbox | Owner via `pnpm fin` with CR-05; the inbox is the owner's | §0.3 | Sealed variable on `worker` only | Sat 10:00 | Security emails |
| CR-09 | Better Stack organisation, team `fin-staging` and two team tokens | Owner | §0.3 | Secure prompt, per run; ingest tokens and DSNs become sealed variables per service | Sat 09:00 | Monitoring |
| CR-10 | The staging escrow `age` recipient (public key); the identity stays in the owner's password manager | Owner | Staging | The public settings ([G-09]) | Sat 10:00, before the first generated key | Generated keys |
| CR-11 | The first Fin Admin's address, typed at `pnpm fin staff bootstrap staging`, which shows the enrolment code once | Owner | Staging | Database only | Sat 20:00 | Fin Admin sign-in |
| CR-12 | Google OAuth client for staging (optional): JavaScript origin `https://console.<staging-zone>`, redirect URI exactly `https://console.<staging-zone>/api/auth/callback/google` (under S-01's fallback, on `console-api.`) | Owner | Staging | Sealed variable on `console` | Only if Google sign-in is built | Google sign-in |
| CR-13 | Sumsub: a new sandbox app token and secret for fin-next (not shared with the old product), least permissions, IP allowlist = `api` and `worker` static IPs, a webhook secret and the webhook URL on `api.`, the WebSDK allowed origin `https://selfie.<staging-zone>`; the same levels as today | Owner in Sumsub's dashboard | Sandbox | Sealed variables on `api` and `worker` | Request Sat 18:00; ready Sun 08:00, after the watcher and the staging identity provider are live | Sunday |
| CR-14 | MassPay: a new sandbox API key for fin-next, its webhook secret and webhook URL on `api.`, the IP allowlist with `payments`' static IPs if MassPay offers it, and the sandbox funding wallet reference | Owner with MassPay | Sandbox | Sealed variables on `payments` only | Request Sun 18:00; ready Mon 08:00 | Monday |
| CR-15 | Staging vault buckets (`fin-next-staging-*`) and one writer token per bucket | Owner via `pnpm fin` | Staging | Sealed variable on the one writer | Sat 12:00 (audit heads and dumps from the first deploy) | Backups off Railway, audit heads |
| CR-16 | Production accounts: Cloudflare account and zones, Railway production workspace, Better Stack team `fin-production`, vault and watch accounts, production OAuth client, Sumsub production app, MassPay live | Owner | Production | Per account | §7 | Production |
| CR-17 | The builder machine account and its tokens; the CI lane's token; the `fin-review` user's GitHub token (receipt refs, `gate` re-runs, from H-03 sealed artefacts); the `fin-builder` and `fin-review` OS users with the receipt-signing keys | Owner | §0.3 | GitHub; each machine's keychains | Sat 08:15 | Merges, receipts |
| CR-18 | The watcher's read-only tokens: Cloudflare (Zone Read, DNS Read, Rulesets Read, Workers Routes Read, Workers Scripts Read, Cloudflare Tunnel Read, Access Read, Analytics Read, Account Settings Read), the vault inventory, a GitHub token that reads repository administration settings, and a Railway Viewer-only user's token if SP-21 passes | Owner (Cloudflare's minted by `pnpm fin` with CR-05) | Staging (production's in its own watch account) | The watcher's secrets | Sat 11:00 | The watcher |
| CR-19 | The canary organisation's restricted Sandbox key for `api-canary` | Ops agent via the console, the owner present | Staging | Better Stack monitor secret | Sat 13:00 (once API keys land; `/health` until then) | The API canary |
| CR-20 | The static deploy token ([FD-19]) | `pnpm fin` with CR-05 | Account-owned; **Workers Scripts Edit** on the staging account only; nothing else (routes are made by `pnpm fin provision` with CR-05); 90-day expiry, rotated with the front door's secrets ([FD-12]). It can replace an app's static files, so it lives only in its own environment, behind the owner's approval, and the watcher checks every deployment every minute (NB-14) | The `staging-static` GitHub environment secret | Sat 11:30 | Static deploys |
| CR-21 | The private overlay | Owner | §0.3 | Outside the repository | Sat 08:00 | The first commit |
| CR-22 | fin-review's local telemetry: the ingest token of the Better Stack source `fin-review-local` in `fin-staging`, and the `review-nightly` heartbeat URL (spec 07 §12.2, §12.3) | `pnpm fin monitoring apply staging` with CR-09 makes the source and the heartbeat; the owner stores both as the `fin-review` user | Ingest to that one source; pings to that one heartbeat | Each machine's `fin-review` keychain; from H-03 the heartbeat URL also as an Actions secret | Sat 17:00 (spec 07 §13.4 pull request 10; the first nightly run at 01:00 Sunday) | fin-review's lines in Better Stack and the nightly heartbeat; until then the lines stay in each run's directory |
| CR-23 | The ingest token of the Better Stack source `fin-review-ci` in `fin-staging` (spec 07 §8, §12.2) | `pnpm fin monitoring apply staging` with CR-09 | Ingest to that one source | The Actions secret `FIN_REVIEW_INGEST_TOKEN`, passed by name to `review.yml`, whose `receipt` job ships with it | Hardening (H-03) | CI review lines in Better Stack |
| CR-24 | Each build machine's `age` identity, so the local engine can open CI's sealed findings (spec 07 §9.2, §9.3; S7-08, part of [RV-09]) | Owner, as the `fin-review` user on each machine | The private half opens findings sealed to that machine's recipient and nothing else; the public half goes to `docs/review/recipients/` in a control-path pull request | Each machine's `fin-review` keychain | Hardening (H-03), once the owner decides [RV-09] (by Tuesday 24 Nov) | `fin-review open` on that machine; the owner's offline key still opens every bundle |

- **EX-23.** Every provider credential of fin-next is new. The old product keeps its own, so revoking one
  never breaks the other, and fin-next's tools never manage anything named for the old product.

### 2.10 Phase 0 lanes

Paths are `tools/layout.json`'s.

| Lane | Machine | Owns | Delivers |
|---|---|---|---|
| Steward | A | root files, `docs/plan/**`, rules files, `.claude/**`, `scripts/**`, `tools/layout.json` | P0-1, P0-4 |
| L-SPEC Specs | B | `docs/plan/specs/**` | P0-0, then each day's spec updates (EX-08) |
| P0-B CI and release | B | `.github/**` (with its own token), the release build's previous-assets steps for images and static builds | P0-2, P0-6, the `deploy-static-staging` job; FW-C13 (tested in FW-S6) |
| P0-C fin-review | A | `tools/fin-review/**`, `docs/review/**` | P0-5 (§2.4) |
| P0-D Server, API host and core | B | `packages/server/**` (telemetry included), `packages/web-host/**`, `packages/core/**`, `ops/docker/**`, `apps/connector/**`, each app's `src/main.ts` and server entry | Configuration validated at boot; the ingress check (connector peer and ingress proof); the URL from the configured origin and the `Host` check; health and readiness; graceful shutdown with drain equal to Railway's; the background registry; the request line and `shipAfter`; scrubbers with tests; error reporting to Better Stack; the private-DNS cache; the SSRF-safe fetch with its refusal tests; Ed25519 caller signatures and the door matrix; `packages/web-host` as the API host the app services share: the front door of `/api/*` in FW-C03's order without static serving or document templating (health; ingress; a body limit; on Fin Admin the Access token on every request; the origin gate with the exact `Origin`, `Sec-Fetch-Site: same-origin`, `X-Fin-App` and JSON-only checks; `/api/auth/*` through the exact allowlist; the app's JSON routes; `Cache-Control: no-store` and the API page policy on every answer); the connector supervisor; the two image targets and the `seams` check |
| P0-E Data, crypto and audit | A | `packages/db/**`, `packages/crypto/**`, `packages/audit/**` | Pool and unit of work (no client held across a provider call; test hook); the migration runner with timestamp names; group roles and two logins per service with grant fragments and a test per role; the guarded `login` trigger; the audit table with `audit.record()`'s stamping and allowlist, the guard triggers, the sequencer and `recordAudit`; sealing, HKDF, keyed hashes and argon2id; lease rows, duty state and the kill-switch table; the checked `email.enqueue()` and `events.emit()` shells |
| P0-F Ops | B | `ops/fin/**`, `ops/environments/**` (public parts), `ops/monitoring/**`, `ops/watcher/**`, `ops/credentials.json`, `tools/static-deploy/**` | The spikes; `tools/static-deploy` (the pinned `wrangler` with the `static.json` allowlist, the source-map strip and the post-upload re-read); `pnpm fin` commands `provision` (with its routes step), `deploy`, `verify`, `zone apply`, `tunnel create`, `tunnel prepare`, `switch`, `staff bootstrap`, `email token`, `watcher deploy` and `monitoring apply` for staging; the tunnels and their Transform Rules; the watcher with its static-deployment checks; the monitoring catalogue and apply script with its guard |
| P0-G UI foundation | B | `packages/tokens/**`, `packages/icons/**`, `packages/motion/**`, `packages/ui/**`, `packages/frame/**`, `packages/app-contracts/**`, each app's `src/client/` shell, `index.html` and `static.json` | The port of the design layer from the old product's redesign branch on the UI SDK ([UI-10], [G-04]'s exception, [UI-12]), in one pull request per group (tokens; icons and cues; motion; foundation; overlays; inputs; data and shell); `fin-motion.css` byte for byte with its hash test only if [UI-12]'s answer covers it, otherwise Fin's own file rebuilt from the motion spec and the token values, with its own hash; the shell deltas built fresh (the edge toggle, the organisation switcher, AccountMenu's role caption, AdminFrame's header); `packages/frame` built fresh (RouterLink, both navigation trees, route states, `Enter`, `NavigationBar`, the theme bootstrap `/theme.js` with `localStorage`); each `index.html` with the nonce-less `<meta property="csp-nonce">`, `/theme.js` and `<body class="fin-shimmer">`; each stylesheet starting with `@layer ui-sdk;`; the kit route (test build only); FW-S1 |

The app files P0-D and P0-G create pass to the Saturday app lanes when their last Phase 0 pull request
merges (EX-07).

### 2.11 Phase 0 exit criteria

| ID | Statement |
|---|---|
| AC-P0-01 [CI] | The first commit on `main` holds only `docs/plan/` and the root `README.md`; every later commit on `main` is a merge commit of a pull request whose `gate` passed; control-path pull requests carry the owner's approval |
| AC-P0-02 [U] | The R11 validator accepts exactly the 27 valid combinations and refuses the 9 with `--model fable` and `--attack-model opus`, every effort below `high`, `ultracode`, `auto`, any alias outside {opus, fable} and bare model IDs, at the CLI, the config file and the CI inputs; the second sceptic resolves to the attack model |
| AC-P0-03 [CI] | A pull request whose receipt is missing, unsigned, signed by an unknown key, names another head, lacks a required lens, or records a session served by a model or effort outside R11 or the floor fails `gate`; a receipt posted as a comment counts as missing |
| AC-P0-04 [CI] | The fin-review self-test finds at least 3 of its 4 planted items with real agents, the miss logged and fixed by Sunday |
| AC-P0-05 [CI] | An install that breaks each supply-chain setting (a young version, a downgraded provenance, a git sub-dependency, an unlisted install script, a refused package from FW-C01 or Radix) fails |
| AC-P0-06 [CI] | The public-safety check fails on a planted staff-shaped address, a token-shaped string, a tunnel-ID-shaped string and a zone name from the refuse list; the pre-push hook refuses the same |
| AC-P0-07 [STG] | No Railway service has a public domain or a TCP proxy; `/api/health` answers through `console.` and `verify.` (and through `admin.` after Access), `/health` through `api.`, and no path of `developer.` reaches Railway; `/readyz` answers from the private network and is 404 through every public host; a request from a non-connector peer, or without the host's ingress proof, gets 403 with `ingress.untrusted_peer` |
| AC-P0-08 [STG] | The watcher lists each tunnel's connectors with the expected count, version and origin addresses; a connector run with a staging token from outside Railway pages the staging policy within 2 minutes |
| AC-P0-09 [STG] | One request line per request reaches Better Stack with `release` equal to the deployed SHA; a forced error appears in Better Stack Errors with `release` and `environment` |
| AC-P0-10 [STG] | One email sent through the outbox and Cloudflare Email Sending, by `worker`, reaches the seed inbox with DKIM, SPF and DMARC passing (checked by the owner and recorded) |
| AC-P0-11 [I] | Each service's database login is refused (42501) on every statement its grant fragment does not allow; no role can update or delete audit rows; a critical-table insert with no audit row in its transaction is refused at commit; a failing `login` trigger body does not block a login |
| AC-P0-12 [U] | Each scrubber removes every shape it knows (codes, tokens, cookies, email addresses, IP addresses, query strings, ID-bearing paths) |
| AC-P0-13 [CI] | The builder account's token cannot push a change to `.github/workflows/` (SP-23), and every `release` image exits 78 with any seam variable set |
| AC-P0-14 [STG] | On each app host, `/` and a deep link answer the SPA from its assets-only deployment with the app's `_headers` (the page policy, `no-cache` on `index.html`, `immutable` on a hashed asset); on each app host but `developer.`, `/api/health` reaches the app's API service through its tunnel, and on `developer.` every path, `/api/` included, is answered by the static deployment; a same-origin POST to `/api/*` sends no OPTIONS; no `/api/*` request ever returns the SPA |
| AC-P0-15 [STG] | Every static deployment has no script module, no bindings, `workers_dev` and preview URLs off, routes exactly as rendered, and an asset manifest equal to the release manifest's; changing one outside the deploy job (a drill on a throwaway file) pages within 2 minutes |
| AC-P0-16 [E2E] | Under each app's production `_headers`, the kit route raises no `securitypolicyviolation` on Chromium, Firefox or WebKit; a plain popover has no border, padding or fill; a layered utility beats the SDK's reset; `[data-slot][hidden]` stays hidden under a display class; no `style[id^="ui-sdk-"]` is in `<head>`; the page behind an open drawer does not scroll |
| AC-P0-17 [CI] | S-01 to S-04 and SP-26 are recorded in `docs/plan/spikes.md`, with the front-door shape they chose |

## 3. Saturday 21 Nov: auth and roles (R6)

### 3.1 Scope

**Must-have (deployed to staging by 23:59):**

1. **Two realms, one library:** a developer realm on the console and a staff realm on Fin Admin, each a
   Better Auth instance from one factory with its own secrets, cookies, passkey RP ID, schema and
   endpoint allowlist. Better Auth does authentication only; organisations, roles, permissions,
   step-up and audit are Fin code ([SA-10]). **The same-origin settings** ([SA-43], [SA-44]; C2 §8.3 and
   C3 §4), per realm, shown for the console:
   - `baseURL: "https://console.<zone>"` as a static setting, never derived from `Host`;
     `basePath: "/api/auth"`; `trustedOrigins` exactly `["https://console.<zone>"]`; the service
     refuses to start if `BETTER_AUTH_TRUSTED_ORIGINS` is set;
   - `cookiePrefix: "__Host-fin"` (`__Host-fin-admin` for Fin Admin; verify runs no Better Auth and
     sets its own `__Host-fin-verify.ls` and `__Host-fin-selfie.s`, spec 03 §2.4), `useSecureCookies: false`, `defaultCookieAttributes: { secure: true }`, and only
     `session_token` overridden to `SameSite=Strict`; every other cookie stays `Lax` (the OAuth state
     cookie must, because the provider's redirect back is a cross-site top-level navigation);
     `crossSubDomainCookies` is never set; `disableOriginCheck` and `disableCSRFCheck` are `false`;
     `storeStateStrategy: "database"`;
   - the passkey plugin's `rpID` is the app host and its `origin` the app's https origin;
   - Fin's origin gate runs ahead of Better Auth on every unsafe method: `Origin` present and equal
     to the app origin, `Sec-Fetch-Site` `same-origin` when present, `X-Fin-App` present, and a body
     only as `application/json` (named upload routes take `multipart/form-data`); a refusal is 403
     `invalid_origin` with one `csrf.refused` line naming the reason; the only exemption is
     `GET /api/auth/callback/google`, and `POST /api/auth/callback/*` is refused;
   - emailed links open the static page (the code in the fragment), which posts it with `fetch`; no
     API GET ever uses up a code; Better Auth's own link-building GET routes stay blocked in the
     endpoint policy;
   - the client calls relative `/api/auth` and adds `X-Fin-App` on every unsafe method, so reads stay
     simple requests;
   - a configuration test asserts every cookie the realm sets starts with `__Host-` and has no
     `Domain`, that `session_token` is `Strict` and `state` is `Lax`. Under S-01's fallback, [SA-43]'s
     and [SA-44]'s fallback settings apply instead (ARCHITECTURE §5.17).
2. **Developer sign-in:** sign-up with an 8-digit emailed code that proves the mailbox; sign-in with a
   passkey (autofill) or an emailed code; second factors passkey and TOTP with 10 backup codes; one live
   code per purpose and 3 tries per code ([SA-35]); sessions (24 h idle, 7 days maximum); sign out; sign
   out everywhere else; "Account security" with factors, sessions and trusted browsers ([SA-31]).
3. **Mandatory second factor:** every staff session without a factor reaches only enrolment; a new or
   reset staff member is pending and enrols only with the emailed code and an enrolment code
   ([SA-29]); the guard refuses every `aal1` staff request; the last factor cannot be removed. For the
   developer realm, per [SA-05], anyone holding a privileged role in any organisation is held at
   "Protect your account" with no "Skip", evaluated on every request.
4. **Step-up:** intents ([SA-08]) required by `requireActor({ permission, stepUp: "intent" })` and
   `requireStaff(...)` for: invite, edit, resend or cancel an invitation; change role; remove member;
   create, edit or delete a role; rename, create or delete an organisation; add, change or remove a
   factor; add, change or remove staff; reset a staff member's factors; create, edit or delete a staff
   role; set a kill switch. The window for reveals. The old product's step-ups that fall on Saturday's
   screens ([BC-01]).
5. **Organisations and team:** create and switch organisations (at most 10 as Super admin, [BC-06]);
   members; invitations (7-day expiry, hashed single-use token, tied to the exact confirmed address,
   per-sender and per-recipient limits, the same answer for unknown invitations); remove member, with
   the keys and secrets they made or saw listed and rolled ([SA-33]); the outrank rule and the
   team-change lock ([SA-32]); the last Super admin stays.
6. **Dashboard roles:** the 26-permission catalogue with its "needs" graph and step-up kinds; built-in
   Super admin and Admin; no other prebuilt role ([SA-11]); custom roles (up to 30 per organisation)
   with an editor; nobody gives more than they hold; nobody changes their own role.
7. **Fin Admin staff (R6):** Cloudflare Access in front of the whole `admin.` host with the staff list
   and the binding cookie; the Access token checked at the admin connector and by the admin API on
   every request before anything is served, against the staff session (the same person); a
   discoverable passkey signs staff in on its own, the emailed code serves enrolment ([SA-15]); the
   26 granular staff permissions and the prebuilt roles ([SA-12]); adding staff takes a step-up intent
   and an enrolment code; change role; remove (immediate, sessions ended); the staff-change lock and
   the outrank rule; the last Admin stays; staff sessions 12 h maximum, 60 min idle.
8. **Audit (R9):** every auth event in its scope (person, organisation, staff), in the same
   transaction, with a test each; the database's guard on the identity and staff tables; the address
   and device on every console and Fin Admin row ([BC-03]); the console's Audit log page reads the audit
   table only (one record per action).
9. **Security emails** through `email.enqueue()` and Cloudflare Email Sending (R3), from the `auth.`
   sending subdomain, lean templates, `Auto-Submitted: auto-generated`, never dropped ([SA-41]): new
   sign-in, factor added or removed, sessions ended, invitation, role changed, member removed (with what
   was rolled), staff added, staff first factor enrolled (to every Admin), role changed or removed.
10. **Limits in Postgres:** sign-in, code and step-up attempts and lockouts in logged tables ([DA-16]);
    email per recipient; sign-up velocity by address and network ([SA-40]); fail closed.
11. **Monitoring (R5):** one line per auth request and staff action; alerts for gate failures, any
    staff request served on an `aal1` session (must be zero), audit not written, the audit guard
    firing, security email not sent, spikes of failed sign-ins, `csrf.refused` jumping after a deploy,
    Access drift.
12. **Screens** of §3.5 in their must-have states, each with a journey test, built on the UI SDK
    through `@fin/ui` (R14): the console's, and Fin Admin's sign-in, second factor, step-up and Staff,
    inside AppFrame and AdminFrame with the sidebar's edge toggle. Fin Admin's account, roles and audit
    screens go to Sunday's spill block (§4.1).

**Stretch (in this order):**

1. **API keys and the edge's key check**, only if L-SAT-02 is green at C3 (18:00): the format with the
   per-deployment checksum salt, scopes bounded by the maker's role, create with a show-once secret,
   edit, roll and revoke with intents, "last used" ([BC-05]), audit and email; the edge's load shedding,
   key check and `GET /v4/whoami`. Otherwise first thing Sunday (08:00 to 11:00).
2. Passwords, reset and new password ([SA-06]), with the common-password refusal.
3. Custom staff roles with the AdminRoleEditor (if [SA-12] keeps them: then Sunday's spill).
4. The staff "reset second factors" screen (the server rule is must-have; the screen may slip).
5. Google sign-in in either realm (CR-12).

### 3.2 Lanes

| Lane | Machine | Owns | Starts | Delivers |
|---|---|---|---|---|
| L-SAT-01 Permission engine | B | `packages/access/**` (root files and the engine; each area's catalogue fragment belongs to its lane) | 09:00 (spec at 08:45) | The typed permission engine shared by both realms (`can`, `needsOf`, `missingNeed`, `givingProblem`, the outrank check, role-editor validation, labels), built-in and prebuilt roles; browser-safe; property tests. Pure code, finished by about midday |
| L-SAT-02 Identity realms | A | `packages/identity/**` | 10:00 (engine stubs), 12:30 (on P0-E) | The realm factory over Better Auth with §3.1's same-origin settings; the endpoint policy per realm with its set test; assurance levels; step-up windows and intents; trusted browsers; the mandatory-factor gate evaluated per request; emailed codes bound to the asking browser; one live code per purpose; same-answer responses; the limit store with logged lockouts; names validation; SP-10's pin tests; the cookie configuration test |
| L-SAT-03 Organisations | B | `packages/orgs/**` | 11:00 | Organisations, members, invitations, custom role CRUD, role changes, the team-change lock and the outrank rule; the credential roll on removal; audit fragments; security emails through `email.enqueue()` |
| L-SAT-04 Staff | A | `packages/staff/**` | 12:30 | Staff members and roles, add, change, remove and reset, enrolment codes, the staff-change lock, the last-Admin guard, the Access token check with a cached key set and a timeout, the same-person check, the hourly Access drift check, `pnpm fin staff bootstrap` |
| L-SAT-05 Email | B | `packages/email/**`, `apps/api/src/worker/email/**` | 10:00 | `EmailPort` and the Cloudflare adapter; `email.enqueue()`'s allowlists; the outbox sender in the worker with priorities, the token bucket, per-recipient limits, digests for notices and the daily budgets; the security templates; `email-outbox-age` |
| L-SAT-06 Console | A | `apps/console/**` except `src/client/routes/developers/keys/**` and the shared e2e fixtures | 12:30 (on route stubs until FW-S1 passes at 13:00) | Signed-out routes, Account security, Organisation, Team, Roles, RoleEditor, Audit log; the console's API at `/api/*` with `requireActor` and its route-policy fragments; FW-S4, FW-S5 and FW-S7's timing |
| L-SAT-07 Fin Admin | B | `apps/admin/**` | 13:30 | Sign-in, second factor (with enrolment), step-up, Staff (list, add with an enrolment code, change role, remove); Fin Admin's API at `/api/*` behind the Access check |
| L-SAT-08 Test harness | A | `packages/testing/**`, `playwright.config.ts`, shared `e2e/fixtures/**` | 09:00 | The canon seed with `example.*` addresses, the email-sink reader, the virtual-authenticator helper, a TOTP helper, the frozen clock, the Access stand-in, the test static server (each app's real `_headers`, the SPA fallback, `/api/*` forwarded), the `securitypolicyviolation` fixture, all in the `test` target only |
| L-SAT-09 Ops and monitoring | B | `ops/fin/**`, `ops/monitoring/**`, `ops/watcher/**` | after P0-7 | Auth alerts and catalogue fragments; staging deploys at the checkpoints; the Access application; the staff bootstrap run |
| L-SAT-10 Design | (canvas) | the Fin Admin and dashboard canvases | 08:30 | AdminRoles and AdminRoleEditor boards (light, dark, phone); ProtectAccount's states without "Skip"; AdminStaff's role picker and the enrolment-code step; the StepUp intent copy; the edge toggle drawn on every shell board. From 18:00: the hosted verify boards on `AuthLayout` ([KY-09]) |
| L-SAT-11 API keys and the edge (stretch) | A | `packages/keys/**`, `apps/edge/**`, `apps/console/src/client/routes/developers/keys/**` | after C3 if L-SAT-02 is green | Stretch item 1 |
| L-SAT-12 UI kit, wave 2 | B | `packages/{tokens,icons,motion,ui,frame}/**` (P0-G's paths, continued) | 13:00 | D3 §9's wave 2: OTPInput, Checkbox, RadioGroup, Switch, Select, Modal and ConfirmDialog (StepUp), SecretReveal and CopyField (backup codes; the enrolment code shown once), the authenticator QR drawn as SVG from an in-house encoder (manual key entry until it lands), Avatar, DetailList, the Table family, Drawer, DateRangePicker; the kit spec's cases for each |

Each app lane owns its own `e2e/<day>/` journey specs; L-SAT-08 owns only the shared fixtures.

### 3.3 Order

```
P0-4 workspace ──► L-SAT-01 engine (pure) ──► L-SAT-03 orgs ──► L-SAT-06 console screens
                                   │                                        ▲
P0-E db + audit ──► L-SAT-02 identity realms ──► L-SAT-04 staff ──► L-SAT-07 Fin Admin screens
                                   │                     ▲
P0-E outbox ──► L-SAT-05 email ────┘                     S-02 cookies (12:30) gates their sign-in merges
P0-G waves 0 and 1 ──► FW-S1 (13:00) ──► L-SAT-12 wave 2 ──────────────► 06, 07
L-SAT-08 harness ─────────────────────────────────────────────────────► every journey test
L-SAT-10 design ──► AdminRoles / AdminRoleEditor ──► Sunday's spill
C3 18:00: L-SAT-02 green? ──► L-SAT-11 API keys and the edge
```

- L-SAT-01 and L-SAT-05 start during Phase 0: they need only the workspace and their specs.
- L-SAT-02 starts on interface stubs of `packages/db` and `packages/audit` at 10:00 and rebases onto
  them when P0-E merges.
- Screens start from the shells and the route contracts in the specs, so they overlap with the server
  lanes. They merge after the server lanes they call.

### 3.4 Review gates for Saturday

- Every lane except L-SAT-10 is tier S, apart from client-only screen code and the design system (N).
- `commit` reviews on every push; the `pr` gate with the attack pass at each milestone; the Saturday
  attack profiles (§1.7).
- Extra checks for the day:
  - a **test-truth** check on every guard in `packages/identity`, `access`, `orgs` and `staff`: would
    the test fail if the guard were removed?
  - the **endpoint-policy set** reviewed against the installed Better Auth version's router, by reading
    the installed source;
  - the **cookie and CSRF settings** checked against §3.1 item 1 and C3 §3.4's cookie list, through the
    configuration test and the origin gate's refusal tests.
- The **nightly review** (01:00 Sunday) is `all --cold` over everything merged (EX-18).

### 3.5 Screens (from A8 §1.2-1.3; state counts from the canvases)

"Must-have states" are built and journey-tested on the day: the default, loading, load failed,
empty, no permission, step-up and refusal states, plus each board's states that carry a security
outcome. The rest of each board's states are in the state manifest as pending and are finished in
H-02 (PG-03 needs zero pending).

**The frames** follow the design brief's round 2 and the owner's 21 Nov decisions (D3 §5). The
sidebar's collapse control is the **edge toggle**: a 24px round secondary `IconButton` on the
sidebar's right border near the top (40px from the top in the console, under the 24px strip; 16px in
Fin Admin), always visible at 1280px and wider, as the canvases draw it ([UI-11]; D3 §5.2): **Collapse sidebar** (CaretLeft,
`aria-expanded="true"`) on the 224px sidebar and **Expand sidebar** (CaretRight,
`aria-expanded="false"`) on the 64px rail, in the same place, with `aria-controls` naming the
navigation and its own name as its tooltip; it comes right after the brand link in the Tab order, sits
under every overlay, and is hidden below 1280px and on phones. The choice is remembered per viewer in
`localStorage` (`fin-sidebar`, read and written in try/catch), mirrored to `data-sidebar` on `<html>`
by `/theme.js` before first paint. The brand is a link with no button and no hover swap: the Fin.com
lockup on the expanded sidebar, a plain 24px F mark centred in the 56px brand cell on the rail, both
linking Home. The header holds the organisation switcher and the EnvironmentSwitch on the left and
the AccountMenu (name, email, role caption, "Account security", Theme, "Log out") on the right, with no
balance. The theme is chosen in the AccountMenu and stored in `localStorage` by `/theme.js` ([UI-13]); Fin
Admin follows the system theme.

| Board | States | Route | Must-have states on Saturday |
|---|---|---|---|
| AppFrame | 17 | every signed-in route | default, orgMenu, accountMenu, navigating, frameLoading, notFound, notAllowed, error, offline, collapsed (the edge toggle), navOpen |
| Home | 3 | `/` | all |
| AdminFrame | 11 | every Fin Admin route | default, staffMenu, staging, loading, pageError, notFound, collapsed (the edge toggle) |
| SignIn | 31 | `/sign-in` | start, passkey, code sent, paused, load error, redirect messages (password states if [SA-06] keeps passwords) |
| SignInCode | 16 | `/sign-in/code` | code entry, wrong code, expired, resend countdown, other browser |
| TwoFactor | 17 | `/sign-in/two-factor` | authenticator, passkey, wrong code, locked |
| BackupCode | 11 | `/sign-in/backup-code` | entry, wrong, used up |
| SignUp | 13 | `/sign-up` | form, invite prefill, code sent; never says whether an account exists |
| VerifyEmail | 14 | `/verify-email` | main states |
| ResetPassword, NewPassword | 11 + 11 | `/reset-password…` | only if [SA-06] keeps passwords (stretch) |
| Invite | 11 | `/invite`, the token in the fragment (`/invite#t=<token>`, posted to `POST /api/invitations/open`; spec 02 §9.3, S2-15) | for you, other account, signed out, declined, cannot use, confirm it's you |
| NoAccess | 7 | `/no-access` | all |
| ProtectAccount | 11 | `/welcome/secure` | passkey first, authenticator, and the no-"Skip" gate per [SA-05] (new states from L-SAT-10) |
| Authenticator | 14 | `/welcome/authenticator` | QR (as SVG, no `data:` image) or the key for manual entry, code, backup codes |
| StepUp | 13 | dialog | every state, for windows and intents (it is the master for every step-up) |
| AccountSecurity | 21 | `/account/security` | factors, add and remove with an intent, backup codes, sessions, trusted browsers, sign out everywhere else, own activity |
| Organisation | 20 | `/settings/organisation` | rename, create, delete with typed confirm and step-up, switch |
| Team | 17 | `/settings/team` | members, invite, change role, remove (with what was rolled), refused, outranked |
| Roles | 12 | `/settings/roles` ([UI-07]) | list, built-in read-only, no permission |
| RoleEditor | 11 | role editor | create, edit, duplicate, needs auto-ticked, giving refused, step-up |
| AuditLog | 13 | its own page in the sidebar's footer (round 2) | list, drawer, filters, empty, no permission |
| ApiKeys, ApiKeyCreate, ApiKeyActions | 12 + 13 + 10 | `/developers/keys` | stretch on Saturday, if the realms are green at 18:00; otherwise Sunday's spill block |
| AdminSignIn | 16 | `/sign-in` | email, code, wrong code, not staff (same answer) |
| AdminSecondFactor | 16 | `/sign-in/factor` | passkey, authenticator, "no factor yet" forces set-up with the enrolment code |
| AdminStepUp | 9 | dialog | all |
| AdminStaff | 14 | `/staff` | list, add with an intent and the enrolment code shown once, change role, remove, refused, outranked, failed (no emailed-code step: [SA-13]) |

About 329 dashboard states and 92 Fin Admin states exist for Saturday on the canvases (A8 §1.3).
The must-have subset above is a minority of them; the rest wait in the state manifest as pending,
and PG-03 needs none pending. AdminAccount, AdminRoles, AdminRoleEditor and AdminAudit are in
Sunday's spill block (§4.5).

### 3.6 Acceptance criteria

| ID | Statement |
|---|---|
| AC-SAT-01 [U] | For random role pairs, `givingProblem` refuses every grant of a role holding a permission the actor lacks, in both catalogues; nobody can change their own role; an actor cannot change, remove or reset anyone whose current role is outside the actor's permissions |
| AC-SAT-02 [C] | For each realm, the set of mounted Better Auth paths equals the allowlist; an unlisted path, a double slash or an encoded path answers 404 before any limit is counted; `/change-email`, the library's link-building GET routes and the staff backup-code endpoints answer 404 |
| AC-SAT-03 [I] | A developer session made by an emailed code for a person who has a factor is `aal1` and reaches only the factor step; a trusted-browser session is `aal1` and writes no proof |
| AC-SAT-04 [I] | Every Fin Admin app API route refuses an `aal1` staff session (generated from the route policy, FW-C07); the count of served `aal1` staff requests is zero; a pending staff member cannot register a factor without a valid enrolment code, and the code works once |
| AC-SAT-05 [I] | Removing one's last factor is refused for staff, and for privileged developers under [SA-05]; an Admin of one organisation and a plain member of another is held at "Protect your account" in both |
| AC-SAT-06 [I] | Each step-up action of §3.1 item 4 is refused without an intent, with an intent for a different action or different parameters, with a used intent, with an expired one, and with one from another session; it succeeds once with a fresh intent; a passkey step-up presented by another user's passkey is refused |
| AC-SAT-07 [I] | An invitation cannot be accepted by a different address or an unconfirmed address, after 7 days, or twice; unknown and expired invitations get the same answer; changing a pending invitation's role takes an intent |
| AC-SAT-08 [I] | The last Super admin of an organisation and the last staff Admin cannot be removed or demoted, including by two concurrent demotions |
| AC-SAT-09 [I] | Sign-in and sign-up for a registered and an unknown address give identical responses |
| AC-SAT-10 [I] | Per-recipient email limits hold under 20 concurrent requests; the limiter fails closed when the database refuses; past the limit a security notice is folded into a digest and still sent; a restart keeps a paused address paused |
| AC-SAT-11 [I] | Every auth audit event has a test that fails when the write is removed; a rolled-back action leaves no audit row; an insert into members, roles, staff or proofs with no audit row is refused at commit; the chain verifies after the day's seed |
| AC-SAT-12 [I] | A staff request whose Access identity differs from the staff session's person is refused and logged as `staff.access_mismatch`; a staff sign-in with a trust cookie present gets no trusted session |
| AC-SAT-13 [I] | Every permission check in the console's and Fin Admin's app API routes refuses a role that lacks it (one test per route, generated from the route policy, FW-C07) |
| AC-SAT-14 [E2E] | Sign up with a code from the sink, add a passkey (virtual authenticator), sign out, sign in with the passkey; sign in with a code plus TOTP; sign in with a backup code |
| AC-SAT-15 [E2E] | Invite a member with a step-up intent; the invitee accepts in a second browser; change their role; create a custom role; a role that would give more than the actor holds is refused; remove the member and see what was rolled; each step appears in the Audit log with its address and device |
| AC-SAT-16 [E2E] | A member holding a custom read-only role made in the test sees no Team or Roles controls and gets the no-permission page on direct navigation |
| AC-SAT-17 [E2E] | Fin Admin: sign in with a code, forced factor enrolment with the enrolment code, the staff list; add a staff member with an intent and see the enrolment code once; the new member enrols with both codes; a Viewer sees decisions disabled and the server refuses them; change role; remove; sign in again with a passkey alone |
| AC-SAT-18 [E2E] | No page-policy violation on any Saturday page; the page behind an open drawer does not scroll; the built HTML has no inline script and its `csp-nonce` meta carries no nonce; first paint is in the stored theme with no flash |
| AC-SAT-19 [STG] | On staging, the release smoke signs in to the console with the read-only smoke account and opens the Audit log; the owner signs in to Fin Admin through Access, is held at the factor step until it is shown, and opens the Staff list (recorded); request lines with the release SHA appear in Better Stack |
| AC-SAT-20 [STG] | One sign-up on staging delivers its code and the "new sign-in" email to the seed inbox from the `auth.` subdomain, with DKIM, SPF and DMARC passing (owner check, recorded) |
| AC-SAT-21 [STG] | A drill sends 10 failed staff sign-ins; the failed-sign-in alert notifies the staging policy |
| AC-SAT-22 [CI] | Every Saturday pull request merged with a signed receipt showing the attack pass on its S files and sessions within R11 and the floor |
| AC-SAT-23 [U, E2E] | Every cookie the console and Fin Admin set starts with `__Host-`, has `Secure`, `HttpOnly` and `Path=/` and no `Domain`; `session_token` is `Strict` and every other cookie `Lax`; an unsafe request with a missing or foreign `Origin`, with `Sec-Fetch-Site` other than `same-origin`, without `X-Fin-App`, or with a form or `text/plain` body is refused with 403 and its reason, one test per reason; a cross-site page's form POST and a sibling host's `fetch` are refused in Chromium, Firefox and WebKit; the console's own calls send no OPTIONS |
| AC-SAT-24 [E2E] | The edge toggle collapses and expands the sidebar in both frames, keeps focus, sets `aria-expanded`, is remembered after a reload, is shown at rest on every page at 1280px and wider whether the sidebar is expanded or collapsed, is hidden from 1024 to 1279px (where the width forces the rail and the stored choice is ignored) and on phones ([UI-11]), sits under an open drawer's scrim, and matches the geometry of the specs (24 by 24, at the sidebar's width less 12px, 40px from the top in the console and 16px in Fin Admin); the rail's brand is a 24px mark linking Home with no hover swap |

### 3.7 Checkpoints and cut lines for Saturday

- **C2 13:00:** Phase 0 exit (§2.11), with FW-S1 and S-02 due at 13:00. If S-01 failed in the
  morning, the fallback shape is confirmed with the owner here. If the fin-review MVP has not merged,
  EX-18 continues and no tier S pull request merges without a hand-started attack session.
- **C3 18:00:** if L-SAT-02 is not merged with AC-SAT-02 to AC-SAT-06 green, CUT-01 applies; if it is,
  L-SAT-11 starts.
- **C4 22:00:** whatever is not on staging by 23:59 takes Sunday's 08:00 to 11:00 spill block.

## 4. Sunday 22 Nov: onboarding and go-live (R7)

### 4.1 Scope

"Everything Sumsub covers" is read as [KY-13] decides. By default: individual KYC, business KYB with
its people, documents, the liveness selfie, requests for information, review results, and the go-live
check of a developer's company and people, all through Sumsub, with the old product's statuses kept
exactly; plus Sumsub's ongoing signals (re-reviews, risk-level changes, company-structure changes) as
Fin Admin flags in a stretch lane. Sumsub's monitoring queues and AML re-screening schedules are
recorded as left out of R7 until designed (§0.2). If the owner chooses the full reading, L-SUN-12
becomes a must-have lane with designs first, and Fin Admin polish moves to Monday's spill block.

**Must-have:**

1. **Saturday's spill block (08:00 to 11:00):** Fin Admin's account, roles (AdminRoles, and the
   AdminRoleEditor if [SA-12] keeps custom staff roles) and audit screens; the staff factor-reset
   screen; API keys and the edge's key check if they did not land on Saturday.
2. **Public API foundation (R16):** the edge's load shedding and key check with uniform 401, the
   per-deployment checksum salt and constant-time comparison; scopes; limits in Postgres, failing
   closed; RFC 9457 problems with `code`, `next_actor`, `request_id`; `Idempotency-Key` on every create,
   with secret-bearing answers never stored ([AP-04]); cursor pagination; `Request-Id` and
   `Cache-Control` on every answer; CORS on `api.` for the docs origin only, with no credentials;
   OpenAPI fragments from the route schemas, with the route test and the negative test; plain http
   refused and a live key in it revoked ([FD-03]). Path major per [AP-01] (`/v4`).
3. **KYC domain** (`packages/kyc`): customers (individual, business), people (at most 20 per business,
   in the API too), documents (one size and type rule, with the Sandbox quota, [DA-13]), hosted links
   (hashed tokens), RFIs on the forms model only (legacy items as system forms), go-live requests; one
   table-driven state machine per entity, shared by the API, verify, Fin Admin and the sandbox; coupling
   rules in the machines (a staff decision closes an open RFI).
4. **One provider port, two providers:** `KycProvider` with the Sumsub adapter and a sandbox provider
   deciding by test values 0000 to 0005. Each call idempotent, a 10 s budget, no redirects,
   `Retry-After` honoured, no retry on 4xx, errors carry status and code only. A conformance suite both
   providers pass.
5. **Inbound Sumsub events:** the edge forwards the raw body to `api`'s hook door; the digest over the
   raw bytes checked; the event stored with de-duplication; 200 within a second; a worker job re-reads
   the review from Sumsub and applies it; the poll kept as a backstop with backoff. The review types and
   `applicantPersonalInfoChanged`, `applicantDeleted`, `applicantDeactivated` handled (re-read and
   record); other types logged and counted.
6. **Personal data:** live details in Sumsub as the record (old D13); name sealed; email and phone keyed
   hashes; masked forms; blind-index name search; only `api` and `worker` hold the seal and index keys
   and the Sumsub tokens; other apps call `api`'s signed door, whose operations declare their checks
   ([SA-36]). Values read back from Sumsub are validated before display, and refill only the browser that
   entered them.
7. **Hosted verify pages** on `verify.<zone>`, an assets-only deployment with its `/api/*` through the
   public tunnel to the `verify` service: the individual flow, the business steps and people page, a
   person's own link, the RFI form, expired and error pages, the "Sumsub is unavailable" page. A link
   carries its token only in the fragment (`https://verify.<zone>/c#<token>`, `/p#`, `/a#`; no
   `/test/` paths). On first open the static page reads the token, clears it from the address and the
   history, posts it once to `POST /api/link/open`, and receives the host-only `__Host-fin-verify.ls`
   link-session cookie bound to that browser ([SA-37]; spec 03 §2.4, §2.5); no path ever holds the
   token, and Logpush still redacts every verify and selfie path. **The selfie host** `selfie.<zone>`
   is an assets-only deployment of verify's second entry, with its own `_headers` carrying Sumsub's
   exact-host exception ([SA-26]; hosts from SP-11), opened as `/s#<sft id>.<secret>` with a one-time
   ticket that `POST /api/selfie/session` redeems for the SDK token and `__Host-fin-selfie.s`, and its
   `/api/*` reaching only verify's selfie operations; it never sees the link token (spec 03 §2.6). White-label rule,
   the page policy, `no-referrer`, `no-store` on every API answer.
8. **Developer webhooks and events:** `events.emit()` in the action's transaction; Standard Webhooks
   `v1` signing (`whsec_`); endpoints https only on 443 or 8443, enabled after a signed challenge
   ([AP-07]); delivery from `worker` through the SSRF-safe fetch with caps per endpoint and per target
   host; 15 tries over about 3 days ([BC-04]); endpoint pause, redeliver; Fin's test endpoint delivered
   in-process ([AP-20]); the Events list. The KYC machines emit the `person.*` and `document.updated`
   events from Sunday, as spec 03 §1.2 and spec 05 §5.1's catalogue require.
9. **Go-live:** the five-section wizard ("your Production request"), the company email code, people
   verified with a selfie, sent by a Super admin with an intent, the staff decision in Fin Admin
   (approve, request changes, decline, with preset reasons and an intent), then Production unlocked:
   Production keys can be made and the EnvironmentSwitch opens. Company review per [KY-05] (staff
   review, "documents" wording removed).
10. **Fin Admin review:** Production access requests, Customer approvals, Customers and a customer's
    detail with "Show details" and the document viewer (both a window, with the per-person budget,
    audited per view, streamed, never stored), customer decisions (approve and reject with an intent),
    Organisations (pause and restore Production access with an intent; the "Fin approves each customer"
    switch), RFIs, Forms, Reasons. The document viewer opens a file with a gated `POST`, which spends
    the budget and writes `staff.document_viewed`, and then loads a single-use same-origin URL, so no
    GET is audited and Fin Admin's policy needs no `blob:` or PDF frame (spec 03 §12.2, SD3-17, SP-27;
    [SA-44], [SA-45]).
11. **Audit for every actor (R9):** developer, customer through a link, a business's person, staff, and
    the system or provider, in the action's transaction. Staff decisions are audit events with
    structured fields; no second table.
12. **Restart rule:** a final rejection cannot be restarted by the developer without a staff decision
    ([KY-07]).
13. **Sandbox limits** ([SA-40]): Sandbox customer mail only to members' confirmed addresses (others
    shown in the console); daily mail budgets per organisation and new account; the Sandbox document
    quota.
14. **Monitoring:** one line per unit; alerts for Sumsub calls failing, the inbound queue stalled,
    signature failures, the poll stalled, hosted pages' API answering 5xx, the document viewer failing,
    each duty's success alert.
15. **The UI SDK to `0.1.0-beta.13`** after 12:24 UTC, in one dependency pull request (EX-30), merged
    before Monday.

**Stretch:**

1. A business's owner companies sent to Sumsub as company beneficiaries ([KY-06]).
2. Sumsub's ongoing signals as Fin Admin flags (L-SUN-12, [KY-13]).
3. Saved views and filters in Fin Admin lists.
4. The docs site skeleton (L-SUN-09), which becomes Monday's must-have.
5. The customer emailed when an RFI opens ([KY-08]).

(The people and document events for developers moved to must-have item 8.)

### 4.2 Lanes

| Lane | Machine | Owns | Starts | Delivers |
|---|---|---|---|---|
| L-SUN-00 Spill | A and B | the paths of the Saturday lanes it finishes | 08:00 | Item 1 |
| L-SUN-01 Edge and API platform | A | `apps/edge/**`, `apps/api/src/platform/**`, `packages/contract/**` | 08:00 (if not done Saturday) | Item 2; the public hook routes forwarding raw bodies to the hook doors |
| L-SUN-02 KYC domain | B | `packages/kyc/**` except `src/providers/**` | 08:00 (spec written Saturday evening) | Items 3, 6, 11, 12 |
| L-SUN-03 Providers | A | `packages/kyc/src/providers/**`, `apps/api/src/worker/kyc/**`, `apps/api/src/hooks/sumsub/**` | 08:00 | Items 4, 5; the conformance suite |
| L-SUN-04 Webhooks | B | `packages/events/**`, `apps/api/src/worker/webhooks/**` | 08:00 (pure code; can start Saturday evening) | Item 8 |
| L-SUN-05 Onboarding API routes | A | `apps/api/src/routes/{customers,people,documents,links,rfis,sandbox,events,webhook-endpoints}/**` | 11:00 | Routes, schemas, examples, problem codes, OpenAPI fragments |
| L-SUN-06 Verify | B | `apps/verify/**` (the static app, its selfie entry, both `static.json` files and the `verify` API; changes to the `hosted` and `selfie` profiles go to the owner of `packages/web-host/src/static/` through the lane board) | 10:00 (on the boards from L-SAT-10, [KY-09]) | Item 7 |
| L-SUN-07 Console onboarding | A | `apps/console/src/client/routes/{customers,developers/{simulator,webhooks,events},settings/go-live}/**` and their server routes | 11:00 | Screens of §4.5 (dashboard) |
| L-SUN-08 Fin Admin onboarding | B | `apps/admin/src/client/routes/{go-live,approvals,customers,documents,organisations,rfis,forms,reasons}/**` and their server routes | 11:00 | Screens of §4.5 (Fin Admin) |
| L-SUN-09 Docs site (stretch) | A | `apps/docs/**` | 14:00 | An assets-only deployment on `developer.<zone>` with no `/api/` path and no Railway service; its browser failure reports go to the edge at `api.<zone>/reports/docs` (spec 05 §8.13, D05-01); Scalar 1.78.1 bundled with no CDN, under the docs' fixed `_headers` policy (SP-14; any style exception is the docs' alone, recorded under [AP-11]); the "Try it" guard (Sandbox keys only, five layers, `credentials: "omit"`); getting started |
| L-SUN-10 Ops | B | `ops/fin/**`, `ops/monitoring/**` | 08:00 | Sumsub tokens set (CR-13) once the watcher and the staging identity provider are live; the webhook URL; the WebSDK origin on the selfie host; the verify and selfie routes; alerts |
| L-SUN-11 Design | (canvas) | canvases | 08:00 | The unlocked Production state of the dashboard (EnvironmentSwitch on Production, no strip, Production cues in confirms); verify boards if not done; the Fin Admin flags if [KY-13] needs them |
| L-SUN-12 Ongoing signals (stretch) | B | `packages/kyc/src/signals/**`, `apps/admin/src/client/routes/signals/**` | 14:00 | Stretch 2 |
| L-SUN-13 UI kit, wave 3 | B | `packages/{tokens,icons,motion,ui,frame}/**` | 11:00 | D3 §9's Sunday components (WizardLayout, `useWizard`, Stepper and WizardSuccess; FileUpload; Combobox; Flag; Timeline as Fin's own markup; CodeBlock; the document viewer's controls; verify's compositions on AuthLayout); item 15 after 12:24 UTC |

### 4.3 Order

```
Spill block 08:00-11:00 (Saturday's must-haves)          L-SUN-04 webhooks (pure) ─────────┐
L-SUN-01 edge + API platform ──► L-SUN-05 routes ──► L-SUN-09 docs reference              │
L-SUN-02 KYC domain ──┬────────► L-SUN-05                                                  ▼
L-SUN-03 providers ───┘──► inbound events job ──► go-live end to end ◄── L-SUN-07, L-SUN-08
L-SUN-02 + 03 ──► L-SUN-06 verify pages (selfie needs the Sumsub adapter and CR-13)
FW-S3 (Sunday 08:00, on the stub landing route deployed Saturday night) ──► L-SUN-06
L-SUN-13 wave 3 ──► 06, 07, 08;   12:24 UTC ──► UI SDK beta.13 pull request ──► Monday's screens
```

- The KYC domain and the webhook engine have no dependency on Saturday's screens. They start at 08:00
  even if the spill block is busy.
- Their specs (spec 03 for the KYC domain, spec 05 §5 for events, both in `docs/plan/specs/`) are
  brought up to date on Saturday evening by the spec lane from A5 and A7 (EX-08).
- FW-S3 measures verify's first load on a stub landing route that the UI lane builds and the ops lane
  deploys on Saturday night. Every app's static files are now served from Cloudflare's edge ([FD-17]),
  which settles [FW-03] (withdrawn) with the page policy still strict; a miss now comes only from
  JavaScript size or execution, and moves verify down the rest of its ladder before L-SUN-06 builds on
  it.

### 4.4 Review gates for Sunday

- Everything except client-only screen code and the design system is tier S.
- The attack pass uses the Sunday profiles (§1.7).
- Extra checks for the day:
  - a **join** check, by hand in the `pr` gate prompt until joins exist in fin-review: each status move
    has its audit event, its developer event and its email where one is due;
  - a **door** check: no import of the KYC crypto or provider modules outside `apps/api`, as a lint
    rule; every new door operation is in the matrix with its checks;
  - a **policy** check: only the selfie host's `_headers` names a Sumsub host, and only the docs'
    names `api.`.
- Nightly review at 01:00 Monday, incremental.

### 4.5 Screens

| Board | States | Must-have states on Sunday |
|---|---|---|
| AdminAccount (Saturday spill) | 14 | factors, sessions |
| AdminRoles (Saturday spill, new board) | to be drawn | list of prebuilt and custom roles, read-only for non-Admins |
| AdminRoleEditor (Saturday spill, new board) | to be drawn | if [SA-12] keeps custom staff roles |
| AdminAudit (Saturday spill) | 12 | list, drawer, filters |
| ApiKeys, ApiKeyCreate, ApiKeyActions (if not done Saturday) | 12 + 13 + 10 | list, create with the show-once secret, roll, revoke, edit, step-up, last used |
| Customers | 15 | list, filter chips, "Needs your attention", search, empty, no permission, load failed |
| NewCustomer (drawer) | 13 | type, details, review, submit failed, duplicate, step-up ([BC-01]) |
| Customer | 14 | the tabs Overview, Details, People, Documents, Activity (Money is Monday's) |
| CustomerDetails | 6 | masked, "Show details" with step-up, failed, Sumsub unavailable |
| CustomerDocuments | 4 | all |
| CustomerDialogs | 9 | delete, ask for information (Sandbox) |
| Simulator, SimulatorDialogs | 11 + 6 | create Sandbox customers, act on one, results inline, reset ([AP-16]) |
| GoToProduction | 15 | not started, draft, in review, changes requested, declined, approved, paused; only a Super admin sends |
| GoToProductionForm | 16 | every section, the company code, add a person |
| Webhooks, WebhookAdd, WebhookEndpoint, WebhookActions | 6 + 10 + 14 + 12 | list, add with the challenge, endpoint, deliveries, roll secret (shown once, intent), URL change (intent), pause, delete, Fin's test endpoint |
| Events | 11 | list, drawer, redeliver |
| Hosted verify pages | new boards ([KY-09]) | start, details, document, selfie (its own host), RFI, done, expired, error, unavailable; business steps and people |
| AdminGoLive ("Production access requests") | 20 | list, drawer, filters |
| AdminGoLiveRequest | 23 | sections, approve, request changes, decline with reasons, intent |
| AdminApprovals | 25 | list, approve, reject, refused |
| AdminCustomers, AdminCustomer | 22 + 20 | list, search, detail tabs, show details with step-up and the budget |
| AdminCustomerDecide, AdminCustomerRequest | 14 + 5 | approve, unapprove, reject, ask for information, accept, cancel |
| AdminDocument | 12 | image, PDF, zoom, failed, step-up |
| AdminOrganisations, AdminOrganisation | 13 + 15 | Production status, pause and restore with an intent, the approval switch |
| AdminRfis, AdminForms, AdminForm, AdminReasons | 12 + 8 + 18 + 17 | list, overdue, edit and publish a form, reasons read-only for non-Admins |

About 109 dashboard onboarding states, 53 Developers states and 224 Fin Admin states exist for Sunday
on the canvases (A8 §1.4).

### 4.6 Acceptance criteria

| ID | Statement |
|---|---|
| AC-SUN-01 [C] | The route test passes in both directions (every route documented, every documented route served); the negative test finds no internal path, header or code in the assembled document |
| AC-SUN-02 [I] | A key from another deployment (different checksum salt) is refused before any lookup; a flood of well-formed unknown keys is shed before Postgres; a revoked key is refused at once; every 401 is identical; a live key sent over plain http is refused and revoked |
| AC-SUN-03 [I] | A second `POST` with the same `Idempotency-Key` and body replays the first answer with `Idempotent-Replayed`; with a different body it gets 422; while the first runs, 409; a replay of a secret-bearing operation carries no secret and works only for the same key ID; no stored row matches a secret shape |
| AC-SUN-04 [U] | Every state machine refuses every move not in its table, and the tables equal the documented statuses |
| AC-SUN-05 [C] | The Sumsub adapter and the sandbox provider pass the same conformance suite (create or find an applicant, data, upload, review request, review read, SDK token, document stream, deactivate, webhook verify), including timeouts, 429 with `Retry-After`, and no retry on 4xx |
| AC-SUN-06 [I] | An inbound Sumsub event with a wrong digest is refused and logged; a valid one is stored and answered within one second; a replayed one is stored once; the job applies the re-read review and writes the system audit event |
| AC-SUN-07 [I] | An organisation's key, session or staff role cannot read or change another organisation's, or the other mode's, customer, person, document, RFI, link or webhook endpoint (one test per route and per mode, generated) |
| AC-SUN-08 [I] | No live customer row holds `details` or `answers` (CHECK constraint); every Fin field has a Sumsub home, is Sandbox-only, or is dropped (reverse-coverage test) |
| AC-SUN-09 [I] | A webhook endpoint whose name resolves to a private, loopback, link-local, CGNAT, ULA or metadata address, or to Fin's own zones, or that uses http or another port, is refused at save and at send; redirects are not followed; an endpoint that does not echo the challenge is not enabled; Fin's test endpoint is delivered in-process and never through `deliveryFetch` |
| AC-SUN-10 [I] | Every action by a developer, a customer link, a person link, staff and the system writes its audit event in its transaction, each with a test |
| AC-SUN-11 [I] | A final rejection cannot be restarted through the API or the dashboard without a staff decision |
| AC-SUN-12 [E2E] | An individual Sandbox customer made by API completes the hosted flow with test values, and the developer receives `customer.*` webhooks signed per Standard Webhooks, verified by a reference verifier, both at a stand-in endpoint and at Fin's test endpoint |
| AC-SUN-13 [E2E] | A business with two people completes the business steps and each person's link; after the first open no URL holds the link token; the selfie host loads the WebSDK stand-in under its own `_headers` exception and receives no link token; every other app's `_headers` names no Sumsub host |
| AC-SUN-14 [E2E] | Staff opens an RFI; the developer answers it; staff accepts; the customer is approved with an intent; the timeline and audit log show each step |
| AC-SUN-15 [E2E] | Go-live: the wizard, the company code, people with a selfie, sent by a Super admin with an intent; staff approves with an intent; Production unlocks; a Production key can be made; an Admin (not Super admin) cannot send |
| AC-SUN-16 [E2E] | "Show details" and the document viewer ask for step-up, write an audit event per view, answer with `Cache-Control: no-store`, and stop at the staff member's budget with a notice to the Admins |
| AC-SUN-17 [STG] | On staging, an API call with a Sandbox key creates a customer; with Sumsub's sandbox app, a live-mode staging customer reaches Sumsub and its review arrives by webhook, not only by the poll |
| AC-SUN-18 [STG] | Sumsub tokens and the seal and index keys exist only on `api` and `worker` (`pnpm fin verify` lists variable names per service, never values) |
| AC-SUN-19 [STG] | Alerts for inbound signature failures and the inbound queue stalling fire in a drill |
| AC-SUN-20 [I] | Sandbox customer mail to an address that is not a member's confirmed address is held and shown in the console, never sent; an organisation past its daily mail budget is refused, while security notices still go |
| AC-SUN-21 [STG] | `verify.` and `selfie.` serve their static apps on a deep link with their own `_headers` and route `/api/*` to `verify` through the tunnel; the watcher lists both deployments as assets-only |

### 4.7 Checkpoints and cut lines for Sunday

- **C1 08:00:** if Saturday's spill is more than the block can take, CUT-02 applies.
- **C2 13:00:** the Sumsub adapter's conformance and inbound events must be green; if not, CUT-03.
- **C3 18:00:** go-live end to end must be green in e2e; if not, CUT-04. The UI SDK pull request is
  opened after 12:24 UTC and merges before C4 if its checks are green; otherwise Monday's screens stay on
  beta.9 and the bump moves to the first spill day.

## 5. Monday 23 Nov: providers (R8)

### 5.1 Scope

**Must-have:**

1. **Money schema** (`packages/money`): neutral rows (holder, virtual account, beneficiary, transfer,
   deposit) with per-provider link tables keyed `(provider, instance, external_id)`; Fin's double-entry
   ledger, append-only by trigger, with holds (spendable = posted balance minus holds) and unique
   postings per `(transfer, posting kind)` and deposits per `(provider, instance, deposit reference)`
   ([MO-22]); an operation intent log; the provider event inbox; a method table per provider and
   environment.
2. **The `ProviderAdapter` interface:** integer minor units; effect-typed outcomes (`ok`, `refused`,
   `retry`, `unknown` with a resolution hint); declared capabilities and a routing step; stateless
   adapters with a checkpointed continuation; no provider name, status or body reaching a developer.
   Several providers sit behind it; MassPay is the first.
3. **The Fin simulator and the conformance suite**, built from the old fake's states and failure
   injections (lost answers, replays, forgotten keys, holds, locks, returns, deposits). Every adapter
   must pass it.
4. **The MassPay adapter** (sandbox), in `packages/money/src/providers/masspay/`, carrying the old
   adapter's rules as a specification: an "ok" rule per operation; errors as codes, never bodies;
   retries only on network errors, 429, 503 and 504 with the same key; the host guard; the payout driver
   (quote, commit, re-quote, stop) inside the adapter with checkpoints.
5. **The `payments` service** holds the MassPay credentials only, with its static outbound IPs, and
   owns the money jobs (`apps/payments/src/jobs/`) and the provider hook door
   (`apps/payments/src/hooks/`). `api` (for the public API), the console's API and Fin Admin's API call
   its money door with signed calls, and `payments` enforces each operation's declared checks itself,
   re-reading the key record for key-originated calls ([SA-36]). No money work runs in `worker` or
   `api`.
6. **Money domain:** provisioning a holder for an approved individual (businesses show "waiting for
   business enrolment", the owner's decision); one virtual account; beneficiaries with the full account
   number sealed in Fin plus last 4 and a fingerprint; transfers with a permanent per-transfer
   idempotency key saved before the call, a hold, the row confirmed on a replica before the call
   ([MO-18]), and the rule that a refused commit is read back before Fin says no money moved; cancel;
   Sandbox deposits and transfer simulations, refused in code on a live production instance ([MO-21]).
7. **Developer Sandbox backing** per [MO-05]: the Fin simulator for developers' Sandbox; MassPay's
   sandbox for staging's live mode and Fin's own conformance runs.
8. **Provider events and reconciliation:** MassPay webhooks verified (HMAC-SHA512 over the timestamp
   and raw body, 5-minute tolerance), stored as references, read back, de-duplicated; the status sweep by
   `next_check_at` with backoff ([MO-23]); orphan payouts every 5 minutes; the daily reconciliation
   writing `money.reconciliation_break`; the money switch tripped automatically on an idempotency
   mismatch, a transfer sent after its end, an orphan payout or breaks above the threshold ([OP-01]).
9. **Step-up and email:** adding a beneficiary takes an intent; sending money takes an intent bound to
   its amount, currency, beneficiary and source ([SA-08]); the console's Send money dialog reuses one
   server-issued transfer intent ID across retries and warns on a similar recent transfer ([MO-07]); a
   new beneficiary sends a security email to the organisation's Super admins and Admins.
10. **Audit (R9):** every transfer status change, holder state change, beneficiary registration per
    provider, reconciliation break and sealed-number reveal (API reads of full deposit instructions too),
    including changes driven by the provider or a scheduled run; the database's guard on beneficiaries,
    transfers and ledger entries; the ledger head anchored daily.
11. **Money API:** virtual accounts, balances, beneficiaries, transfers, a fee quote ([MO-16]), Sandbox
    simulations; `Idempotency-Key` on every create; live keys with money scopes must carry an address
    allowlist ([MO-20]).
12. **Screens** of §5.5 on `@fin/ui` at `0.1.0-beta.13` of the UI SDK, built from API-supplied methods
    and rails, not hard-coded MassPay rails; the console's money routes at `console.<zone>/api/money/*`.
13. **Fin Admin money view (read-only):** a holder's provider status, transfers with provider references
    (staff only), reconciliation breaks; built from the design system's patterns without a board, marked
    pending design parity ([MO-13]).
14. **Monitoring:** `provider.call` lines with provider, operation, outcome and effect; alerts per
    provider (calls failing, sync stalled, holder locked, transfers stuck, webhook signature failures,
    reconciliation breaks, orphan payouts, the money switch tripped).
15. **Docs (R16):** `developer.<zone>` as an assets-only deployment with the reference for onboarding
    and money and the getting-started guide. **Try it** ([AP-10]) calls `api.<zone>` cross-origin with
    `credentials: "omit"` and Sandbox keys only; the edge answers CORS for the docs origin alone, with
    no `Access-Control-Allow-Credentials`; the key is held in memory only, never stored; the docs'
    `connect-src` names `'self'` and `api.` only ([SA-45]).

**Stretch:**

1. Fin Admin money operations (retry, close, resolve-a-break) with intents and a design.
2. A second adapter skeleton passing the conformance suite's read-only part, to prove the interface.
3. Docs guides for money movement, idempotency, pagination and webhooks.
4. Real inbound deposits for the live path (needed before live money, PG-14).

### 5.2 Lanes

| Lane | Machine | Owns | Starts | Delivers |
|---|---|---|---|---|
| L-MON-01 Money core | A | `packages/money/src/{schema,ledger,domain}/**` and the package's root files | 08:00 (spec written Sunday evening) | Items 1, 6, 9, 10 |
| L-MON-02 Provider interface | B | `packages/money/src/{provider,conformance,providers/fin-simulator}/**` | 08:00 (can start Sunday evening; pure types) | Items 2, 3, 7 |
| L-MON-03 MassPay adapter and payments | A | `packages/money/src/providers/masspay/**`, `apps/payments/**` except `src/{hooks,jobs}/**` | 10:00 (on L-MON-02's types) | Items 4, 5 |
| L-MON-04 Money jobs and hooks | B | `apps/payments/src/{hooks,jobs}/**` | 11:00 | Item 8 |
| L-MON-05 Money API | A | `apps/api/src/routes/{virtual-accounts,balances,beneficiaries,transfers,quotes,sandbox/money}/**` | 12:00 | Item 11 |
| L-MON-06 Console money | B | `apps/console/src/client/routes/{customers/$id/money,virtual-accounts,transfers}/**` and their server routes | 12:00 | Screens of §5.5 |
| L-MON-07 Fin Admin money | B | `apps/admin/src/client/routes/money/**` and their server routes | 14:00 | Item 13 |
| L-MON-08 Docs | A | `apps/docs/**` | 08:00 | Item 15 |
| L-MON-09 Ops | B | `ops/fin/**`, `ops/monitoring/**` | 08:00 | `payments`' static IPs, CR-14 set, MassPay's webhook URL, alerts, the money switch's Cloudflare rule prepared, the docs host's static route and record checked |
| L-MON-10 Design | (canvas) | canvases | 08:00 | Fin Admin money view board (stretch), notes for multi-provider rails |
| L-MON-11 UI kit, money | B | `packages/{tokens,icons,motion,ui,frame}/**` | 08:00 | D3 §9's Monday components: AmountInput, AmountPair and QuoteLine; MoneyRoute; AssetIcon, NetworkIcon, AssetNetwork and RailIcon; TableAmount; the identifier helpers; the businesses' "coming" state; the L-drawer wizards |

### 5.3 Order

```
L-MON-02 interface + simulator + conformance ──► L-MON-03 MassPay adapter ──► payments service
          │                                                  │
L-MON-01 schema + ledger + domain ◄──────────────────────────┘
          │──► L-MON-04 jobs and hooks (sweep, inbox, reconciliation, trips)
          │──► L-MON-05 API ──► L-MON-06 console screens ──► money journeys
          └──► L-MON-07 Fin Admin view
L-MON-11 money components ──► L-MON-06
L-MON-08 docs: reference regenerated after L-SUN-05 and L-MON-05
Better Auth to 1.7.27 (one dependency pull request, after 10:53 UTC) ([SA-02])
```

- **EX-24.** The money core and the interface are pure code with the simulator. They can be fully tested
  before the MassPay adapter or CR-14 exists. The adapter and staging's MassPay sandbox calls come last.

### 5.4 Review gates for Monday

- Every money lane is tier S.
- The attack pass uses the Monday profiles (§1.7).
- **Concurrency check:** every transfer path has an integration test that runs it 20 times at once and
  asserts the ledger balances and holds are exact.
- **Join check:** each transfer status has its audit event, developer event and ledger posting.
- The MassPay adapter's review includes a **neutrality check**: no MassPay word, status or body outside
  its folder, as a lint rule over provider names from one list.
- Nightly review at 01:00 Tuesday, incremental; then the spill days begin.

### 5.5 Screens

| Board | States | Must-have states on Monday |
|---|---|---|
| CustomerMoney (one "Money" tab, round 2) | 25 | open, empty, balance reading and failed, instructions failed, no account, opening, needs details, refused, under review, closed, read only, not approved, business waiting, money off, loading, failed |
| AddBeneficiary | 15 | rail from the API, account, Fedwire ID, Sandbox fill helpers, review, intent, refused, first-payout delay notice |
| SendMoney | 25 | beneficiary, speed, amount with limit, review with fee, intent bound to the transfer, created, lost answer (the same transfer intent on retry), reused, similar recent transfer, rate limited, partner down, balance refused, money off |
| SimulateDeposit | 13 | Sandbox ACH, wire, plain deposit |
| TransferDetails | 19 | statuses, cancel, return in Sandbox, not found |
| VirtualAccounts, Transfers | 7 + 10 | list, empty, failed |
| Fin Admin money view | no board ([MO-13]) | read-only lists |

About 114 dashboard states exist for Monday (A8 §1.5).

### 5.6 Acceptance criteria

| ID | Statement |
|---|---|
| AC-MON-01 [C] | The simulator and the MassPay adapter pass the same conformance suite, including lost answers (`unknown` with a resolution hint), replays with the same key, quote expiry, holds and returns |
| AC-MON-02 [I] | For every posting, the ledger's debits equal its credits; spendable equals posted balance minus holds; a balance never goes below zero under 20 concurrent sends; the same return or deposit applied by the webhook, the sweep and the walk posts once |
| AC-MON-03 [I] | A payout whose provider answer is lost is never marked failed until the adapter's read-back says it did not happen; a retried request with the same key creates one transfer; the console's retries reuse one transfer intent ID; `submitPayout` is never called before the row is confirmed on a replica |
| AC-MON-04 [I] | No provider call happens inside a database transaction (the test hook fails any outbound call made while a transaction is open) |
| AC-MON-05 [I] | A MassPay webhook with a wrong signature, an old timestamp or a replayed body is refused or stored once; a valid one triggers a read-back and an audit event with a system actor |
| AC-MON-06 [I] | Reconciliation against the simulator with an injected difference writes `money.reconciliation_break`, raises its alert, and above the threshold trips the money switch, which then refuses new payouts |
| AC-MON-07 [I] | Developer-facing answers, events and screens contain no provider name, status or reference (lint plus a test over every money route's examples) |
| AC-MON-08 [I] | A full account number is stored only sealed; the API and screens show the last 4; a reveal needs step-up and writes an audit event, as does an API read of full deposit instructions |
| AC-MON-09 [I] | Adding a beneficiary and sending money are refused without an intent; a send's intent cannot be used for another transfer, another amount or another beneficiary, or twice |
| AC-MON-10 [I] | A Sandbox key cannot reach the MassPay adapter's live host; the live host is enabled only by a reviewed configuration change; `fundFromTreasury` and every `simulate*` are refused on a live production instance |
| AC-MON-11 [E2E] | In the console: open a virtual account, add a beneficiary (intent), simulate a deposit, send money (intent, fee shown), see the transfer complete through a Sandbox simulation; cancel another; each in the audit log |
| AC-MON-12 [E2E] | Docs: "Try it" with a Sandbox key calls `api.` cross-origin with no cookie and no credentials mode, and works; the edge's CORS answer names only the docs origin and carries no `Access-Control-Allow-Credentials`; a Production key is refused in the panel and at the API; the key is gone after reload; no request goes to any other origin and nothing is stored in any browser store |
| AC-MON-13 [STG] | A staging customer in live mode completes a transfer through MassPay's sandbox from `payments`' static IPs; the MassPay webhook arrives at `payments`' hook door through the edge and is verified |
| AC-MON-14 [STG] | MassPay credentials exist only on `payments`, and no money duty runs in `worker` (`pnpm fin verify`) |
| AC-MON-15 [STG] | `provider.call` lines appear in Better Stack; the "calls failing" alert fires in a drill |
| AC-MON-16 [I] | A call to `payments` signed as the console for a session that is not live, a member without the permission, or a missing intent is refused by `payments` itself; a forwarded key assertion for a revoked key is refused; a live money key without an address allowlist is refused |

### 5.7 Checkpoints and cut lines for Monday

- **C2 13:00:** the interface, the simulator and the conformance suite must be green; if not, CUT-05.
- **C3 18:00:** the console send-money journey must be green against the simulator; if not, CUT-06.

## 6. Spill days and hardening (from Tuesday 24 Nov)

Tuesday 24 and Wednesday 25 Nov are spill days for the three days' must-haves; **staging-complete** is
declared when H-01 is empty (target Thu 26 Nov 22:00, UNVERIFIED). The hardening workstreams then run
in parallel. The lanes keep the same ownership rules and review gates.

| ID | Workstream | Contents | Feeds gate |
|---|---|---|---|
| H-01 | Spill | Every must-have of §3 to §5 not yet on staging | PG-02 |
| H-02 | Screens to full coverage | Every board state in the state manifest reached by Playwright, a component test, or marked "not reachable" with a reason; the screenshot regression matrix in the pinned container; the local fidelity diff against the canvas renders, as a ratchet; motion and reduced-motion probes; design-parity sheets reviewed with the design system's checklist; the UI requests filed (the edge toggle, IconButton's 24px size, the 24px rail mark, the header's organisation switcher, AccountMenu's role caption, "Sandbox" alone, the motion layer); the stretch screens (passwords if kept, Google, the staff role editor, money operations); webhook analytics ([BC-02]); a manual VoiceOver and NVDA pass | PG-03 |
| H-03 | fin-review v2 | The content-hash cache and ledger; joins from static analysis; the class catalogue with static classes as lint rules; the reusable `review.yml` CI runner with Workload Identity Federation bound to it ([RV-04], [RV-05], [RV-11]); findings sealed to the owner's key; the `ci` lens and `ci-report`; per-run metrics to Better Stack with regression alerts; the self-test on every fin-review change; the CI attestation path for receipts | PG-01, PG-08 |
| H-04 | Security depth | The revocation journal; the production watcher in its watch account; GitHub settings hashed hourly; Railway's audit-log export (weekly, daily once a narrow credential exists, [AU-06]); the Cloudflare kill-switch rules ([OP-01]); value caps, the second approver and the first-payout delay ([MO-19]); the embargo path ([CI-16]); the privileged-login watch tuned; the static-deployment watch tuned and the static deploy token's rotation and leak runbook | PG-04, PG-05 |
| H-05 | Operations | The operator database route on staging: `cloudflared-db` with the db tunnel, its `db.` Access TCP application and a per-run service token, drilled once ([FD-11]; until then registered `pnpm fin task` runs, spec 01 S0-17); `pnpm fin rotate`, `escrow open`, `restore`, `restore-drill`, `reseal`, `reindex`, `rollback` (images and static deployments), `lock break`, `scale`, `killswitch` complete; the incident-response, restore, losing-Railway and failure-mode documents ([OP-02], [OP-03], [OP-04], [OP-07]); a rotation runbook per family and the runbook-existence check ([OP-06]); the credential inventory complete with its expiry warnings ([OP-05]) | PG-05, PG-09 |
| H-06 | Monitoring completeness | `monitoring:check` rules all on; every alert names its policy, meaning, first check and runbook; dashboards; heartbeats and success alerts per duty; the shadow count ([OB-16], SP-22); the daily canary and the weekly test page ([OB-17]); the staging status page | PG-09 |
| H-07 | Performance | A load test at the launch capacity of [OP-08]; an invalid-key flood with a pass number; 20 concurrent 20 MB uploads; a redeploy under load with zero 5xx at Cloudflare; the connection budget; audited-write throughput and commit latency with synchronous replication on; cold first loads of each app from two regions far from US East against [FW-04]'s budgets | PG-06 |
| H-08 | Docs | Guides for every area, the changelog with an Atom feed, search, error pages, response examples on every operation | PG-02 |
| H-09 | Personal data lifecycle | The erasure flow (deactivate and delete applicants, `erased_at`, the 90-day Sandbox retention), counsel's retention answer (old D18) | PG-07 |
| H-10 | The old staging | Under the shared-zone fallback only: the hostname cutover of §9.3, when parity holds; otherwise retiring the old staging is the old repository's own work | PG-12 |
| H-11 | Production build | §7.2's accounts and services, Postgres HA ([P-10]), the production zones chosen early ([FD-10]) and the sending domains' two-week warm-up started at once ([EM-08]), the production OAuth client, the production Sumsub app, the operator user and launcher, a throwaway environment provisioned from scratch ([OP-09]) | PG-10 |
| H-12 | Soaks and drills | The 7-day email soak; 7 days of the watcher green; the drill list (PG-05) | PG-04, PG-05 |
| H-13 | Cold review | `all --cold` with the owner's chosen models; every confirmed medium or above fixed | PG-01 |
| H-14 | Runtime | The Node upgrade runbook and base-image digest updates; the Bun canary job kept green or its failures recorded (R15) | PG-09 |
| H-15 | Portability | The owner's "no lock-in" test, once: the same `dist/` and `_headers` served from another static host behind a path-routing proxy in a throwaway environment, with the release smoke passing; the steps written into `docs/runbooks/leave-cloudflare-static.md` | PG-10 |

**Indicative order** (UNVERIFIED pace):

- **Tue 24 to Thu 26 Nov:** H-01 first; H-03, H-04 and H-05 alongside; the production zones chosen and
  the email warm-up started (H-11).
- **Fri 27 Nov to Fri 4 Dec:** H-02, H-06 to H-09 and H-15; the soaks (H-12) run from staging-complete;
  the production build (H-11) beside them; the cold review (H-13) once the code stops moving.
- **From the week of 14 Dec:** the production gates are checked; production opens on the owner's go
  (PG-13). Live money waits for PG-14.

---

## 7. What "production-ready" means here, and the gates

### 7.1 Definition

fin-next is production-ready (R1) when an outside developer can put real customers and real money
through it, and the people running it can contain any incident within minutes, without any of these
being untrue:

1. **Correct:** every requirement R1 to R16 has its tests; every journey has a browser test; every board
   state is covered; the conformance suites pass for every provider adapter.
2. **Secure:** the NB rules hold and are tested; every tier S path has had the attack pass; the whole
   codebase has had a cold review with no open confirmed finding at medium or above.
3. **Audited (R9):** every important action by every actor writes an audit event in its transaction,
   and the database refuses a critical commit without one; the chain verifies; its head and the ledger's
   live where Railway cannot rewrite them.
4. **Observable (R5):** every unit of work is shipped to Better Stack; every failure that matters pages
   in production; every scheduled duty has a heartbeat or a success alert; the daily canary arrives.
5. **Recoverable:** backups off Railway, restore and PITR drills done with times measured; the
   losing-Railway rebuild rehearsed; every generated key in escrow; every credential has a tested
   rotation and leak runbook.
6. **Operable:** deploys by digest and by attested static manifest, with rollback; kill switches
   tested; runbooks; the incident process; the responder gate met.
7. **Agreed:** vendors' terms accepted, counsel's answers recorded, and the owner's explicit go.

### 7.2 Production build (inputs to PG-10)

- Production's own Cloudflare account and zones ([FD-10]: main and pages on Pro, admin on Free), own
  login with security keys; the assets-only static deployments with their `/*` and no-Worker `/api/*`
  routes (or S-01's fallback hosts) on the production zones; the Railway production workspace with
  admin roles per the private overlay; Postgres HA with PITR ([P-10]); static outbound IPs; the tunnels
  and their connector services, with the evict drill done.
- Better Stack team `fin-production` with paging, on-call and a status page.
- Vault and watch accounts with their own logins (old D22, D29, D31).
- The production OAuth client (if Google sign-in is built), the production Sumsub app with IP
  allowlists, MassPay live (PG-14).
- Production `pnpm fin`, static deploys included, only from the operator user, where no coding agent
  runs, through a launcher outside the repository (old D37); production's static deploy token exists
  only there.
- The same image digests and static manifests that passed staging and soaked ([CI-17]); nothing
  rebuilt.

### 7.3 Gates between staging-complete and production

| ID | Gate | Evidence |
|---|---|---|
| PG-01 | Cold review | fin-review `all --cold` with the owner's models finished; every confirmed critical, high and medium finding fixed with a delta review; every plausible high judged by the owner; sibling searches done; fin-review in CI with signed or attested receipts |
| PG-02 | Feature complete | Every must-have and stretch item of §3 to §5 that the owner has not dropped in writing is on staging; §0.2's table has no partial row without a decision; docs guides published |
| PG-03 | Test complete | State manifest with zero pending; journeys, the kit spec on three engines and the screenshot regression green on three consecutive nightly runs; flake rate under the agreed limit |
| PG-04 | Soaks | 7 days of email on staging with no unexplained `email.send_failed`; production's sending domains warmed for two weeks with the placement test passing on production; 7 days of the watcher green; three clean nightly reviews; the shadow count under its limit for a week |
| PG-05 | Drills | A redeploy under load with zero 5xx at Cloudflare; scheduler failover within 90 s; a rogue connector detected within 2 minutes and the evict swap done with its times; a static deployment changed outside `pnpm fin` detected within 2 minutes and rolled back; an invalid-key flood within budget; a restore from a dump in a throwaway service; a PITR restore and an HA failover with times measured (SP-17); the losing-Railway rebuild rehearsed; every rotation runbook run once, a database login rotation among them; the leaked-email-token, Railway-leak, tunnel-leak and static-deploy-token-leak runbooks run; each kill switch toggled, the Cloudflare rules included; Fin Admin sign-in with email disabled; an audit head overwrite refused; a forged webhook refused; restore replays the revocation journal |
| PG-06 | Performance | A load test at [OP-08]'s launch capacity with p95 budgets met and no pool exhaustion or event-loop alerts; first loads within [FW-04]'s budgets from two far regions |
| PG-07 | Data and legal | The erasure flow live; counsel's answer on retention and the processor role recorded (old D18); a consent step naming each provider; the privacy notice lists every place personal data sits, including email and monitoring residues; the breach clock in the incident process |
| PG-08 | Supply chain and review integrity | Signed receipts checked by `gate`, with the CI attestation path; image and static-build attestations verified at deploy; the ruleset with no bypass actors and the GitHub settings watched; the deploy refuses a digest or a static manifest not in the release manifest; the builder account's token proven unable to change workflows; the UI SDK pinned at a version that passed EX-30's checks |
| PG-09 | Monitoring and operations | Every alert routed through production policies that page; each responder's phone has received a test page; the responder gate ([OB-06]); the daily canary arriving; the heartbeats live; the incident, restore, losing-Railway and failure-mode documents reviewed; service objectives set ([OP-08]) |
| PG-10 | Production accounts | §7.2 built; no production login is a member of the staging account and the reverse (read in each account); a throwaway environment provisioned from scratch with zero drift ([OP-09]); the portability drill done (H-15) |
| PG-11 | Vendors | Email Sending's beta terms and its token's suppression-editing scope accepted in writing ([EM-02]), and the second-sender decision ([EM-03]); the UI SDK's beta terms read and accepted; Railway's and Better Stack's SOC 2 reports and DPAs read; Railway told about the expected egress ([P-22]); Sumsub production levels, webhook and IP allowlist in place |
| PG-12 | The old staging | Under the shared-zone fallback only: the hostname cutover done and its rollback window closed |
| PG-13 | Owner's go | The owner's explicit, written go for production |
| PG-14 | Live money (after PG-13) | MassPay's answers on live limits, cut-offs, fees and businesses; egress allowlisting in place; real inbound deposits seen and posted; reconciliation running, alerting and tripping in production; value caps, the first-payout delay and the second approver set ([MO-19]); live money keys with address allowlists ([MO-20]); payouts confirmed durable before submission ([MO-18]); a security email on every new beneficiary; the live host enabled by a reviewed change and the live-money switch tested; a small live transfer drill end to end |

---

## 8. Risks and cut lines

### 8.1 Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| RK-01 | A day's must-haves do not fit the day | High | A slip per day | Spill blocks (EX-17); two spill days; independent next-day lanes start anyway; cut lines below; production dates not promised before the hardening shows its pace |
| RK-02 | Review throughput: tier S `pr` gates take 25 to 40 minutes each | High | Merges queue in the evening | `commit` reviews on every push so the gate covers less; receipt reuse on catch-ups; merge batches; gates split across machines; fast mode if [RV-14] allows |
| RK-03 | An owner input (a credential, a decision, a control-path approval, a staging deploy or a plausible-high judgement) comes later than the lane that needs it | Medium | Lanes stall; staging lags | §0.3's list before 10:00, with defaults at 09:00; §2.9's timetable; [G-10]'s pre-approvals; checkpoint approvals; lanes that need nothing from the owner first in each queue |
| RK-04 | A Better Auth release with a security fix is under the 3-day release age | Medium | Choice between waiting and an exception | EX-22; [SA-27]; never loosen the settings |
| RK-05 | The owner says no to publishing the ported design layer's derived text ([UI-12]), or limits it | Medium | Comments rewritten (about 2 hours), or screens built fresh: about three times the effort (D2 §9), with Saturday keeping only its must-have states | §0.3 decision 2 asked at 08:00; the rewrite and the fresh build from the specs and canvases are both planned (D3 §4.2), and the cut lines apply to the rest |
| RK-06 | A tunnel spike fails (a locally managed tunnel from a token, the peer check across a redeploy, Access at the connector) | Medium | Phase 0 takes longer | The remote-configuration fallback hashed every minute; the ingress proof alone while the peer check is fixed; the watch and the evict are needed either way |
| RK-07 | No merge queue on a personal repository; "up to date" forces re-runs | High | Slower merges | Merge batches; receipt reuse by patch-id ([RV-20]) |
| RK-08 | GitHub's concurrent jobs are not enough for two machines' pull requests | Low | CI queues | GitHub Pro from Saturday ([CI-06]); `plan` skips jobs; drafts run only `plan` and `check` |
| RK-09 | Anthropic rate limits, a usage limit, or refusals on attack prompts | Medium | The gate cannot finish | Defensive wording of attack prompts; one retry, then "could not check", which blocks; the owner is told; no fallback (R11); CUT-07 |
| RK-10 | Prompt injection through the public repository | Medium | A reviewer steered, a finding hidden | Reviewers read code, never pull request text; read-only tools and deny rules; findings validated in code; interaction limits; several lenses and two models; no AI review of forks |
| RK-11 | A secret, a zone name, a tunnel ID or a staff address committed to the public repository | Low | Disclosure | Pre-push checks, push protection, gitleaks with Fin's shapes, the public-safety check with the overlay's refuse list, secure prompt only; rotation runbook |
| RK-12 | Sumsub or MassPay sandbox credentials arrive late, or IP allowlisting needs the static IPs first | Medium | Sunday or Monday staging criteria slip | Request CR-13 and CR-14 the evening before; build against the sandbox provider and the simulator; staging acceptance moves to the spill block |
| RK-13 | Cloudflare Email Sending is a beta (testing period ends about 16 Apr 2027) and its token also edits suppressions | Certain | Production email risk | Accept for staging; [EM-02] and [EM-03] for production |
| RK-14 | Railway incidents or control-plane outages during the three days | Medium | Deploys blocked | Keep building and testing locally; deploy when back; acceptance moves |
| RK-15 | Railway's standalone Postgres image lags a security minor (18.6 against 18.7) | Medium | Staging runs an unpatched minor | Check the version in SP-05; ask Railway; production on HA, which is current |
| RK-16 | Designs missing for R6 to R8 (AdminRoles, AdminRoleEditor, verify pages, unlocked Production, Fin Admin money), and the design system diverging from the code (the edge toggle, IconButton's 24px size, the motion layer) | Certain | Screens without a board; UI requests outstanding | The design lane draws boards a day ahead; screens built from design-system patterns are marked pending parity; each divergence is a filed UI request (H-02) |
| RK-17 | "Everything Sumsub covers" grows beyond today's product | Medium | Sunday overflows | [KY-13] fixes the scope at the 08:00 sitting (default at 09:00); anything new needs a design and a spec first |
| RK-18 | A new staging zone cannot be registered on Saturday morning | Low | `-next` names, a later cutover, and the static deployments and their routes in the shared account, where the old product's tokens have authority | The fallback of [FD-09], recorded as an accepted risk |
| RK-19 | A tunnel token leaks from Railway's variables | Low | Interception of a share of traffic until evicted | One token per tunnel and service; the minute watch from outside Railway; the drilled blue and green evict; no provider credential on staging before the watcher is live |
| RK-20 | Review cost runs away (per-commit runs, cold sweeps, Fable at twice Opus's price) | Medium | Spend | Caps per pull request, day and month ([RV-13]); a cap reached is "could not check", never a pass; cost per run recorded |
| RK-21 | Agents collide on files or migrations | Medium | Broken merges | §1.3's ownership and fragments; generated files uncommitted; timestamp migrations with the order check; the steward owns root files |
| RK-22 | Flaky end-to-end tests hide real failures | Medium | False greens or reds | Retries once with the flake reported; three green nightlies required by PG-03 |
| RK-23 | The builder account's token can still push workflow changes (SP-23 fails) | Low | The gate's integrity | No agent holds a token that can; the owner pushes the CI lane's commits |
| RK-24 | S-01 fails: a no-Worker route does not fall through for an assets-only deployment, or such a deployment cannot hold a route | Low to medium | Cross-origin, same-site apps: CORS, preflights, cookies on the API host | C3 §3's settings written down as the fallback (§2.6); `api()`'s base URL from the deploy-time `env.json`, never the build; the owner told at C2 |
| RK-25 | The static deploy token or the staging Cloudflare account is used to replace an app's files or to add a script | Low | Code in the owner's apps, with their same-origin API | CR-20 holds Workers Scripts Edit only, behind the owner's approval in `staging-static` ([FD-19]); NB-14's minute watch over every deployment's script and manifest; routes set only with the operator token; production's token only in the operator's launcher |
| RK-26 | The UI SDK is a fast-moving beta with one npm maintainer and three committers; behaviour changes ship as "patch" releases | High | Regressions on a bump | Exact pins moved together (EX-30); every changelog section read; the kit and page-policy specs on three engines on every bump; every SDK import inside `@fin/ui`; `trustPolicy: no-downgrade` refuses a release without provenance; Apache-2.0 with no dependencies, so a fork is possible |
| RK-27 | Edge routing and the tunnel's ingress disagree on a normalised path (`..`, `//`, encoded slashes), or `cloudflared` changes its normalisation default | Low | A request routed to the wrong side | S-01 (g) on the pinned `cloudflared`; the WAF rule of §2.6 if they disagree; a new `cloudflared` is a reviewed change with S-01 (g) re-run |
| RK-28 | The first-load budgets are tight: D3 measured about 177 KB gzip for React, the router and the console frame's SDK parts before Fin's own code | Medium | Over [FW-04]'s 250 KB (console) or 150 KB (verify) | Route splitting; heavy controls out of first routes; Sentry's client after first paint; the budgets enforced in CI from the first app build |
| RK-29 | Cloudflare changes Workers static assets (product, limits or billing) | Low | Static hosting must move | Plain `dist/` and `_headers` only, no code; the portability drill (H-15) |
| RK-30 | The host-only session cookie also travels with every static request to Cloudflare | Certain | Low: it is `HttpOnly` and `Strict`, and the static deployment never reads it | Accepted (C2 §0); Logpush drops cookies; no cookie with a wider `Path` or `Domain` |

### 8.2 Cut lines

When a cut applies, the work moves; it is never shipped with a weaker check. Every cut is recorded in
the end-of-day report with what moved and where.

| ID | Trigger | Cut first, in this order | Moves to |
|---|---|---|---|
| CUT-01 | Sat 18:00: identity realms not green | Google sign-in; passwords; the staff factor-reset screen; custom staff roles and the AdminRoleEditor; the authenticator's QR drawing (manual key entry stays); API keys and the edge's key check | Passwords and Google to H-02; the rest to Sunday's spill block |
| CUT-02 | Sun 08:00: Saturday's spill exceeds the block | Sunday stretch items; then the Fin Admin Forms and Reasons screens (seeded defaults stay) | H-01 |
| CUT-03 | Sun 13:00: Sumsub adapter or inbound events not green | Live-mode staging acceptance (AC-SUN-17) moves; build on the sandbox provider; the poll stays the backstop | Monday's spill block |
| CUT-04 | Sun 18:00: go-live end to end not green | Fin Admin list polish (views, filters); the go-live form's optional sections keep their fields but not every state | H-02 |
| CUT-05 | Mon 13:00: interface, simulator or conformance not green | The MassPay adapter waits; the developer Sandbox runs on the simulator only; the Fin Admin money view moves | The spill days |
| CUT-06 | Mon 18:00: send-money journey not green | Fee quote route (the review shows "fee shown at confirmation" from the adapter); docs guides; the second adapter skeleton | H-01, H-08 |
| CUT-07 | Any day: the review queue is longer than 3 hours at 18:00, or a usage limit is near | The steward stops new milestones on N-tier lanes, then stretch lanes; tier S must-haves and their gates go first | Next day |
| CUT-08 | Any day: a vendor credential is missing at the day's start | Build against the simulator or sandbox provider; acceptance on staging moves | The next spill block |

**Never cut** (§1.6): server-side permission checks, step-up intents, the mandatory second factor and
enrolment codes, audit events with their tests and the database's guard, scrubbing, the tunnel trust
rules and the connector watch, the static-deployment watch, the cookie and CSRF rules, the attack pass
on tier S with signed receipts, SSRF-safe delivery, the money rules of NB-13, and the security
journeys' Playwright tests.

- **EX-25.** If a feature cannot meet the NB rules on its day, it is hidden (not routed, not in the
  navigation, refused by the server) until it can. The "money off" state in the designs is the pattern.

---

## 9. The old product until fin-next takes over

### 9.1 What runs side by side

| | The old product (in the old product's repository) | fin-next (`aktharazif/fin-next`) |
|---|---|---|
| Runs on | Its own platform and providers, run from its own repository | Railway for compute and Postgres; the apps' static files as assets-only deployments at Cloudflare; Cloudflare Tunnels in front; Cloudflare Email Sending; Better Stack |
| Repository rules | Its own rules: reviewed pull requests for the owner's feature work and staging fixes | Its own rules (§2.2) |
| Staging zone | The old product's staging zone and Cloudflare account | A new staging zone in a new Cloudflare account ([FD-09]); under the fallback, the same zone and account on `-next` hostnames |
| Access control | Its own | Its own Cloudflare Access application, in its own account |
| Railway, Better Stack | Not shared | A new staging workspace and the `fin-staging` team |
| Provider credentials | Its own | New sandbox credentials, never shared (EX-23) |
| Email | Its own sender | Cloudflare Email Sending, from the new zone's `auth.` and `notify.` subdomains |
| Data | Its staging data | Fresh (old D20). Nothing is copied |
| Keys | The old key format | The new format with a per-deployment checksum salt, so an old key is refused before any lookup |

- **EX-26.** No code is ported from the old repository (R1), apart from the design layer, [G-04]'s one
  exception. A feature merged there after 21 Nov becomes a spec item in
  fin-next's backlog, never a copied change.
- **EX-27.** fin-next's tools never create, change or delete anything named for the old product (its
  resources, deployments, access policies and DNS records). Under the fallback, the cutover
  (§9.3) is the only step that touches the old product's hostnames, and it is a reviewed change in each
  repository.

### 9.2 Hostnames

With the new staging zone (the default), fin-next's staging uses its final names from the first
deploy (`console.`, `api.`, `verify.`, `selfie.`, `developer.` and `admin.` on `<staging-zone>`, and
`db.` once the db tunnel exists, before production, [FD-11]), no passkey ever changes host, and
there is no hostname cutover. The owner retires the old product's staging from the old repository
once fin-next's staging reaches parity (the trigger defined in §9.3); until then it stays as
[G-09]'s pre-publication step left it.

Under the fallback ([FD-09]) the shared zone still carries the old product's staging hosts, so
fin-next uses a `-next` name (for example `api-next.`) for each of its hosts that the old product
also uses, and its final name for the rest, until the cutover; staff passkeys made on the `-next`
admin host stop working when the host moves, so staging staff re-enrol then (test accounts only),
rather than widening the RP ID to the zone, which would let any sibling host request staff
assertions.

### 9.3 The staging cutover (under the fallback only)

**Parity** (the trigger, checked by the steward and confirmed by the owner): every journey the old
staging offers has a passing fin-next journey test; PG-02's must-haves are on fin-next staging; the
owner has used fin-next staging for a day without a blocking issue.

**Steps:**

1. **Freeze** merges in the old repository except a fix for the cutover itself.
2. **Prepare in fin-next:** `pnpm fin hostnames plan staging` lists every change: the connector services'
   hostname settings for the final names; the static deployments' routes and custom domains; the
   Access application moved; the app settings that name hosts (public origins, the docs origin for the
   edge's CORS, `type` URLs, Better Auth's base URLs and passkey RP IDs); Sumsub's webhook URL and the
   WebSDK allowed origin; MassPay's webhook URL.
3. **In the old repository**, a reviewed pull request and its own deploy runbook release those names
   and the old product's access policy for them.
4. **In fin-next**, `pnpm fin hostnames move staging` writes the proxied CNAMEs for those names to the
   tunnels' `<tunnel id>.cfargotunnel.com`, sets the static routes on the final names, redeploys the
   connector services with the final hostnames in their ingress map, updates the provider URLs and
   origins, and redeploys the services whose settings name hosts.
5. **Redirects:** the old dashboard name to `console.` for 90 days (old D52); the `-next` names redirect
   to the final names for 14 days, then are removed.
6. **Check:** the release smoke runs on the final names; every monitor and the watcher are green; staff
   re-enrol their passkeys.
7. **Rollback window:** 14 days. Rolling back restores the old product's hostnames through the old
   repository and points the provider URLs back. fin-next's data is unaffected; the old product's data
   was never moved.
8. **After the window:** the old repository is archived; retiring its infrastructure is its own work
   and needs nothing from fin-next.

Developers who used the old staging keep nothing across the cutover: their staging keys, webhook
endpoints and test customers stay with the old product. The owner decides whether to tell them.

---

## 10. Owner decisions, by when they are needed

DECISIONS.md is the register; this table says when the build needs each answer. If an answer has not
come by its time, the build proceeds on the default in DECISIONS.md, except where it says **blocking**.

| Needed by | Decisions |
|---|---|
| Decided overnight (not asked again) | [G-04] (its exception), [P-02], [FW-01], [FD-14], [FD-17], [FD-18], [SA-43], [SA-44], [SA-45], [UI-10], [UI-11]; [FW-03] withdrawn; [UI-01] and [UI-05] superseded (by [UI-10], [UI-12] and [UI-13]) |
| Before Sat 10:00, the short list of §0.3 | [G-06] (**blocking**), [UI-12] (**blocking** for screens), [FD-09], [OB-18], [SA-05], [SA-12], [AU-01], [G-10], [CI-14] |
| Sat 08:00 sitting, defaults at 09:00 | [G-03], [G-07], [SA-06], [SA-14], [SA-18], [SA-20], [SA-30], [CI-03], [CI-06], [CI-08], [RV-06], [RV-07], [RV-12], [KY-13] with [KY-05] and [KY-06], [AP-01], [UI-03], [UI-04], [UI-06], [FW-04], [BC-01], [BC-03], [BC-06]; also [UI-13] and [FD-19]'s staging part, recommended for the same deadline |
| Sat 12:00 | [OB-11] (the staging watcher's tokens) |
| Sat 13:00 | [RV-13] (provisional review caps); the S-01 fallback, only if S-01 failed (§3.7) |
| Sat 18:00 | [KY-09] (the verify boards); [BC-05] (with API keys) |
| Sat 22:00 | [FD-05] (the staging Access identity provider, before CR-13 reaches staging) |
| Sun 08:00 | [FW-02]; [SA-27], with `@ui-sdk/*` added to its fast path (D3 Q4); [SA-39]; [KY-07]; [KY-11]; [AP-04]; [AP-07]; [AP-08]; [AP-16]; [UI-08]; [BC-02]; [BC-04]; [BC-07] |
| Mon 08:00 | [DA-12], [MO-03], [MO-04], [MO-05], [MO-08], [MO-13], [MO-16], [AP-11], [AP-12] |
| Tue 24 Nov | [RV-04], [RV-05], [RV-09], [RV-11]; [FD-10] (for the email warm-up) |
| Before production | [P-10], [P-14], [FD-03], [FD-04], [FD-05] (the MFA methods), [FD-06], [FD-08], [DA-08], [DA-10], [DA-11], [SA-21], [AU-03], [AU-05], [AU-06], [EM-02], [EM-03], [OB-06], [OB-07], [OB-09], [OB-10], [OB-11] (the watch account), [OB-12], [CI-17], [RV-13] (the sweep and cold cadence), [MO-19], [AP-19], [OP-04], [OP-08]; [FD-19] (who uploads production's static files) |

The first draft kept its own list of owner questions (EQ-01 to EQ-33). They now live only in
DECISIONS.md:

| Draft | Now | Draft | Now | Draft | Now |
|---|---|---|---|---|---|
| EQ-01 | [G-06] | EQ-12 | [RV-03], [RV-06], [RV-07], [RV-10], [RV-14] | EQ-23 | [SA-08] |
| EQ-02 | [UI-12] (superseding [UI-01]), [G-03] | EQ-13 | [RV-13] | EQ-24 | [AP-01], [UI-07], [AP-16] |
| EQ-03 | [SA-05] | EQ-14 | withdrawn: [G-04] stands | EQ-25 | [P-10] |
| EQ-04 | withdrawn: [SA-13] was decided on 19 Nov | EQ-15 | §2.9's credential table | EQ-26 | [FD-10], [G-09] |
| EQ-05 | [SA-12] | EQ-16 | [MO-05] | EQ-27 | [SA-16] |
| EQ-06 | [SA-11] | EQ-17 | [EM-02], [EM-03] | EQ-28 | [KY-05] |
| EQ-07 | [SA-06] | EQ-18 | [FD-09] | EQ-29 | [G-10] |
| EQ-08 | [SA-10] | EQ-19 | [FD-09] | EQ-30 | [G-07] |
| EQ-09 | withdrawn: [FD-01] was decided on 21 Nov | EQ-20 | [CI-06] | EQ-31 | [KY-13] |
| EQ-10 | [CI-03], [CI-04] (the CI production option withdrawn) | EQ-21 | [P-02] | EQ-32 | [KY-09] |
| EQ-11 | [RV-04], [RV-05], [RV-11] | EQ-22 | [AU-01] | EQ-33 | [MO-13] |

---

## 11. Estimates (all UNVERIFIED until measured)

| Item | Estimate | Basis |
|---|---|---|
| Pull requests merged | About 10 to 16 a day across lanes, about 30 to 45 over the three days | EX-04's milestone rhythm and the merge batches |
| fin-review per `pr` gate | Tier N about 15 to 30 USD, tier S about 30 to 60 USD, 25 to 40 minutes, falling as `commit` coverage and receipt reuse grow | B6 §6, from one old run; Phase 0 measures the first ten |
| Review spend | Likely several hundred USD a day during the build once reviews bill through the API, within [RV-13]'s caps | The gate estimate times the merge rate, plus `commit` reviews and the nightly review |
| Nightly review | Capped by [RV-13] | The first night is a cold run over the bootstrap |
| The design-layer port | About 21 to 34 agent-hours, 6 to 9 hours of wall clock over P0-G's waves and L-SAT-12 | D3 §4.3 |
| Platform, monthly | ARCHITECTURE §4.11's table: about 290 to 420 USD before review spend; static asset requests are free, and Workers Paid is already counted for email and the watcher | B2, B3, B4, C1 |
| Staging-complete | Target Thu 26 Nov 22:00 | Two spill days after Monday |
| Production open | Not before the week of 14 Dec 2026 | The soaks start at staging-complete; the production domains' two-week warm-up; the production build, the cold review and the drills run beside them |
| Live money | After PG-14, which depends on MassPay's answers | Vendor-led |

The steward records measured times, costs and usage per pull request and per night in the end-of-day
report. The plan's estimates are replaced by those numbers after the first ten runs.
