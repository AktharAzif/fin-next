# fin-next: the plan

Status: revised on Saturday 21 Nov 2026; the build started the same day. This is the front page of
the fin-next plan (R13). It summarises [ARCHITECTURE.md](ARCHITECTURE.md),
[DECISIONS.md](DECISIONS.md), [EXECUTION.md](EXECUTION.md), the spike log [spikes.md](spikes.md) and
the eight specifications in [specs/](specs/). It also says where each of the owner's requirements,
R1 to R16, is answered. It decides nothing of its own. Where this page and a linked file disagree,
the linked file holds. Where linked files disagree with each other, the one order in section 8.3
decides, and DECISIONS.md is the only register of decisions.

**Public by design (R12).** This repository is public. Nothing in the plan is a credential, a token,
an account, workspace, team or tunnel ID, an internal address, a staff address, a zone name, a local
path or a real person's data. Hosts are written `<app>.<zone>`, and the staging zone is
`<staging-zone>`. Private values live outside the repository ([G-09], [OB-13]). Until hardening they
are kept only on the build machines (machine A and machine B), outside every repository, and
`pnpm fin` and the public-safety check read them there. The private overlay given at the secure
prompt, with its encryption and escrow, moves to hardening (D6).
"The old product" is the private repository fin-next replaces.

## Contents

1. [Executive summary](#1-executive-summary)
2. [The stack at a glance](#2-the-stack-at-a-glance)
3. [Hosts and routing](#3-hosts-and-routing)
4. [The decisions taken on 21 Nov 2026](#4-the-decisions-taken-on-21-nov-2026)
5. [Traceability: R1 to R16](#5-traceability-r1-to-r16)
6. [Timeline](#6-timeline)
7. [Before Saturday 10:00: what the owner provides](#7-before-saturday-1000-what-the-owner-provides)
8. [How to read the plan](#8-how-to-read-the-plan)

---

## 1. Executive summary

**What fin-next is.** Fin is a platform for developers. A developer's organisation uses Fin's public
API and the console to onboard its customers (individuals and businesses) through Sumsub, open
virtual accounts for them and send money through payment providers, MassPay first. Fin's staff review
customers and run operations in Fin Admin. fin-next rebuilds Fin from scratch (R1) in the public
repository `aktharazif/fin-next` (R12). This plan is committed before any code (R13).

**The shape.**

- **Railway runs every service and the database** (R2): Node 26 LTS everywhere (R15), Hono for the API
  and auth servers, and Postgres 18 for data, jobs, limits and locks.
- **Cloudflare is the only way in** (R4). Cloudflare Tunnels serve every host, and no Railway service
  has a public domain or a TCP proxy.
- **The browser apps are static files.** The console, Fin Admin, verify and the docs are served by
  assets-only deployments that run no code. On each app host, a route with no Worker sends `/api/*`
  to the app's Railway service, so the page and its API share one origin and need no CORS.
- **Email** goes through Cloudflare Email Sending, and only the `worker` service sends it (R3).
- **Better Stack** takes the logs, metrics, errors, uptime checks, heartbeats and paging. It replaces
  Grafana and Sentry (R5).
- **Two sign-in realms with Fin's own roles** (R6). The developer realm is the console and the staff
  realm is Fin Admin. Both lead with passkeys. Every staff member must have a second factor, and so
  must every developer with a privileged role, by [SA-05]. Adding someone takes a step-up.
- **Onboarding and money sit behind ports.** Onboarding runs through Sumsub behind a `KycProvider`
  port (R7). Money runs behind one `ProviderAdapter` interface (R8), with MassPay as the first adapter
  and a Fin simulator for Sandbox. Fin keeps its own double-entry ledger.
- **Audit** (R9). Every important action by every actor writes an audit event in the same
  transaction. The database refuses a critical write that carries no event, and the chain's heads are
  anchored outside Railway.
- **The screens and the API.** The screens are built fresh from the two new-design canvases, on the UI
  SDK (R14); nothing is ported from the old product ([UI-12]). The public API is `/v4` on
  `api.<zone>`, and the docs site's Try it sends Sandbox keys only (R16).

**How it is built.**

- AI agents build in about eight parallel lanes on two machines. Each lane owns its own files.
- Every change goes through a pull request that fin-review reviews (R10). Its model and effort can be
  chosen within R11's rules. Until hardening, the merge gate is fin-review's local run in the agents'
  sessions on each pull request's exact head, recorded in the pull request ([G-10]), and CI runs
  every other check. Signed receipts move to hardening (D6). fin-review's CI job comes once CI has an
  Anthropic credential, an owner step with no date yet, and that credential is never exposed to pull
  requests from forks.
- Saturday 21 Nov is Phase 0, then auth and roles (R6). Sunday is onboarding and going to Production
  (R7). Monday is providers (R8). Two spill days follow.
- The security bar never moves. A cut drops features and states, never controls.

**What is promised, and what is not.**

- Staging-complete is targeted for Thursday 26 Nov at 22:00.
- Production is not promised for any date. It waits for 14 production gates (PG-01 to PG-14): soaks,
  drills, a cold review of the whole codebase, the email warm-up and vendor answers. The estimate is
  that production opens to real developers in the week of 14 Dec 2026 at the earliest, and live money
  opens later. Both dates are UNVERIFIED.

**What the owner did first.** At the Saturday sitting on 21 Nov 2026, the owner answered the nine
decisions of section 7.2. At about 08:25 the owner answered "defaults": [G-06] is approved as
amended, and [OB-18], [SA-05], [SA-12], [AU-01], [G-10] and [CI-14] take their defaults. [UI-12] is
no (about 08:28): nothing is ported, and the UI is built fresh. [FD-09], the staging zone, was
decided by the owner at about 08:30: staging stays on the shared staging zone `<staging-zone>`, in
the existing Cloudflare account, with fin-next's own names, so CR-05b is not needed. In the same
08:25 answer the owner had the agents apply the repository settings, and trimmed Phase 0: the
builder account, the agents' own OS users, signed review receipts and the private overlay's ceremony
move to hardening (D6). At about 08:30 the owner also answered that fin-next's guard hooks start
fresh ("it should start fresh with ur recommendations"), so nothing is copied from the old product's
hooks. By the build's decision, Phase 0 has no `.claude` merge-guard hook, because the ruleset on
`main` already refuses a push to `main` and any merge but a merge commit ([BD-07]). At about 08:37
the owner gave section 7's staging credentials (Railway, Cloudflare and Better Stack) and the Sumsub
and MassPay sandbox credentials at the secure prompt. The Railway workspace and the Better Stack
team exist. Until the owner is back, those staging credentials are kept on the build machine, as
[SA-22] says. While the owner is away, from about 08:41, the steward's and the build's decisions are
listed in DECISIONS "Decided while the owner was away", for the owner's review.

## 2. The stack at a glance

Versions are the pins in ARCHITECTURE §3.3, read from the registries on 20 and 21 Nov 2026. The
repository waits three days after a release before it installs it, so some pins move by a reviewed
pull request once a newer version clears that age.

| Layer | Choice | Decisions | Where |
|---|---|---|---|
| Runtime (R15) | Node.js 26.13.1 LTS for production, tests, scripts and CI; Bun 1.4.5 only in one non-blocking canary job | [P-05], [CI-10] | ARCHITECTURE §3.2 |
| Workspace | pnpm 12.21.0 (fallback 11.28.12) with its supply-chain policy; Turborepo; TypeScript 7.0.2; Biome 2.6.8 | [P-06], [G-06] | ARCHITECTURE §3.1, §3.3, §7.13 |
| Compute and data (R2) | Railway Pro, one workspace per environment, one US East region; Postgres 18 (standalone with PITR in staging, HA with PITR in production); the outbox, jobs, limits and locks in Postgres; no Redis | [P-01], [P-03], [P-04], [P-09], [P-11] | ARCHITECTURE §4 |
| Images | One app Dockerfile with `test` and `release` targets; distroless Node 26 run image by digest; built and attested in CI, never by Railway | [P-08], [CI-05] | ARCHITECTURE §3.3, §4.10 |
| Servers | Hono 4.13.19 on `@hono/node-server`; Zod 4.6.7; `@hono/zod-openapi` 1.6.3; Drizzle ORM 0.45.4 with `pg` 8.23.1 | [P-07], [AP-02] | ARCHITECTURE §3.3, §3.5 |
| Auth (R6) | Better Auth 1.7.25 with the passkey plugin, moving to 1.7.27 on Monday, in two realms from one factory; Fin's own organisations, roles, permissions and step-up | [SA-01], [SA-02], [SA-03], [SA-10] | ARCHITECTURE §7; spec 02 §3 |
| Browser apps (R14) | Single-page apps (Shape B): React 19.3.1, Vite 8.3.8, TanStack Router 1.170.46, Tailwind 4.3.5; the Fin design system in `packages/ui` on the UI SDK (`@ui-sdk/react` and `@ui-sdk/core`, one exact beta) | [FW-01], [UI-10], [UI-11] | ARCHITECTURE §3.4; spec 06 |
| Static hosting (R4) | Cloudflare Workers static assets as assets-only deployments: no script, no binding, a single-page fallback, headers from each app's `_headers`, rendered at upload from its profile (SF-05); uploaded through Cloudflare's API by `tools/static-deploy`, with Node built-ins only and no `wrangler`, since SP-26's data points of 21 Nov show the API alone can make an assets-only deployment ([BD-16], SF-02) | [FD-17], [FD-19], [SA-45], [BD-16] | ARCHITECTURE §5.16; spec 01 §7.4 |
| Front door (R4) | Proxied Cloudflare DNS, WAF and rate rules; `cloudflared` 2026.11.1 tunnels (public, admin, and db for the operator only); Cloudflare Access over Fin Admin | [FD-01], [FD-05], [FD-13], [FD-14], [FD-18] | ARCHITECTURE §5; spec 01 §7 |
| Email (R3) | Cloudflare Email Sending through its REST API, behind `EmailPort`, sent only by `worker` from its static egress | [EM-01], [EM-04] | ARCHITECTURE §9 |
| Observability (R5) | Better Stack: logs, metrics from logs, dashboards, alerts, error tracking through the Sentry protocol (`@sentry/core`, `@sentry/react`), uptime, heartbeats, on-call and a status page; Fin's own log transport | [OB-01], [OB-03], [OB-04], [OB-05] | ARCHITECTURE §10; spec 08 §7 |
| Outside witnesses | An R2 vault for backups, audit heads, the revocation journal and escrow; the watcher, a Worker on a minute cron that is off the request path | [DA-09], [AU-03], [OB-11], [OB-18] | ARCHITECTURE §6.10, §8.4, §10.6 |
| Onboarding (R7) | Sumsub behind the `KycProvider` port; Fin's sandbox provider for Sandbox mode | [KY-01], [KY-13] | ARCHITECTURE §12.16; spec 03 |
| Money (R8) | The `ProviderAdapter` interface in the `payments` service; MassPay for live mode, the Fin simulator for Sandbox; Fin's double-entry ledger | [MO-01], [MO-02], [MO-05], [MO-06] | ARCHITECTURE §12; spec 04 |
| Public API and docs (R16) | `/v4` on `api.<zone>`, OpenAPI 3.1 from the route schemas, RFC 9457 errors; a static docs site with Scalar 1.78.1 bundled, without a CDN | [AP-01], [AP-02], [AP-03], [AP-09], [AP-10] | ARCHITECTURE §13; spec 05 |
| Tests | Vitest 5.1; Playwright 1.65.1 in a pinned container; a real Postgres 18 in development and CI | [CI-12] | ARCHITECTURE §11.4 |
| CI and review (R10, R11) | GitHub Actions pinned by commit SHA; fin-review, a deterministic Node CLI that starts Opus or Fable sessions. Until hardening, its result on each pull request's exact head is recorded in the pull request; signing receipts moves to hardening (D6) | [CI-01], [CI-02], [RV-02], [RV-03], [G-10] | ARCHITECTURE §11; spec 07 |
| Operations | `pnpm fin` (Node built-ins only) for Railway, Cloudflare, R2, Better Stack and GitHub; production deployed only by the operator | [P-13], [CI-04] | ARCHITECTURE §11.8, §15 |

Not used, by decision: Redis, `pg-boss`, OpenTelemetry SDKs, `tsx`, `@tanstack/react-start`, Radix,
Phosphor, `clsx`, `tailwind-merge`, Railway's CLI from npm (ARCHITECTURE §3.3) and `wrangler`
([BD-16]). No page loads a
script, style or font from another origin at run time. The recorded exceptions are Sumsub's WebSDK
on the selfie host ([SA-26]) and, if the owner agrees, Turnstile ([FD-06]) (ARCHITECTURE §1,
principle 9).

## 3. Hosts and routing

Every host is reached through Cloudflare. A browser app's files never reach Railway, and only `/api/*`
crosses a tunnel ([FD-01], [FD-17], [FD-18]; ARCHITECTURE §5.1 to §5.3). The diagram is in
ARCHITECTURE §2.1.

| Host | On staging ([FD-09]) | For | Files | `/api/*` | Tunnel, then service | Access |
|---|---|---|---|---|---|---|
| `console.<zone>` | `console.<staging-zone>` | Developers: the console | Assets-only deployment on route `console.<zone>/*` | Route `console.<zone>/api/*` with no Worker | Public, then `console` | None |
| `admin.<zone>` | `staff.<staging-zone>` | Fin staff: Fin Admin | Assets-only deployment on route `admin.<zone>/*` | Route `admin.<zone>/api/*` with no Worker | Admin, then `admin` (the Access token is also checked at the connector) | The whole host |
| `verify.<zone>` | `onboard.<staging-zone>` | A developer's customers, and a business's people: the hosted pages | Assets-only deployment | Route with no Worker | Public, then `verify` | None |
| `selfie.<zone>` | `selfie.<staging-zone>` | The same people: the liveness selfie only, with Sumsub's WebSDK ([SA-26]) | Assets-only deployment holding only the selfie document | Route with no Worker | Public, then `verify` | None |
| `developer.<zone>` | `docs.<staging-zone>` | The docs site | Assets-only deployment | None (see the note below) | None: the proxied CNAME points at the public tunnel, which has no ingress rule for this host and answers 404 ([FD-18], SF-01) | None |
| `api.<zone>` | `gateway.<staging-zone>` | Developers' servers, provider webhooks, and Try it | None | The whole host, with no route | Public, then `edge` | None |
| `db.<zone>` | `pg.<staging-zone>`, built in hardening (H-05, [FD-11]) | The operator only | None | An Access TCP application | db, then Postgres, only during a registered run | Yes |
| `status.<hosted zone>` | None: production only | The public status page, production only ([OB-09]) | None: Better Stack serves it | None | None: a DNS-only record, not proxied, on the hosted zone and never the main or the admin zone | None |

`auth.<zone>` and `notify.<zone>` are the email sending subdomains, not web hosts. The Host column's
generic names stand for the roles and for production. Staging keeps the sending subdomains
`auth.<staging-zone>` and `notify.<staging-zone>`, and gives the web hosts the names in the second
column, all on the shared staging zone ([FD-09]). They are final for staging. The steward chose them
within the owner's instruction, for the owner's review. By [FD-10]'s default (the owner decides it by
Tuesday 24 Nov), production uses three registrable domains: a main zone for the console and `api.`,
an admin zone for Fin Admin, and a hosted zone for verify, the selfie host, the docs and the status
page.

**The shared staging zone** ([FD-09]). It is the zone the old product's staging also uses, in the
same Cloudflare account. The old product's credentials could change fin-next's staging DNS, routes
and Access, and every host on the zone is same-site with every other, old and new. That is an
accepted risk for test data until the cutover, and every cookie is host-only and `__Host-` prefixed
anyway ([SA-43]). fin-next touches only its own names there: `pnpm fin` checks every staging write
against [FD-09]'s allow-list and refuses anything else, and it writes zone rules one at a time, never
a whole phase that holds the old product's rules ([BD-11]). fin-next's DMARC records sit on its two
sending subdomains, at `p=reject` ([BD-17]). The old product's records, the zone's apex DMARC record
included, are never touched.

**Note on `developer.<zone>`.** Spec 01 (S0-01, S0-03, §7.2) and spec 05 (§1.3, D05-01) decide that
the docs site has no `/api/*` path and no `docs` service, and that its browser reports go to
`api.<zone>/reports/docs`. That choice is folded in before the first commit: [P-07] and [FD-18]
record it (DECISIONS appendix C, SF-01), ARCHITECTURE has no `docs` service (§2, §3.1, §4.2, §5.2,
§5.3, §10.5, §11.8, §13.10), and EXECUTION provisions none: staging runs 15 Railway services, and
the docs host, `docs.<staging-zone>` on staging ([FD-09]), gets a static route but no `/api/*` route
and no ingress rule (EXECUTION §2.5, §2.7).

**Where requests go** (ARCHITECTURE §5.2):

| Request | Answered by |
|---|---|
| `https://console.<zone>/` | The console's static deployment: `index.html`, `no-cache` |
| `https://console.<zone>/settings/team` | The same: no file matches, so the single-page fallback answers with `index.html` |
| `https://console.<zone>/assets/app-3f9c.js` | The same: the hashed file, `immutable` |
| `https://console.<zone>/api/auth/sign-in/email` | The route with no Worker, then the public tunnel, then `console` |
| `https://admin.<zone>/` | Access first, then the admin static deployment |
| `https://admin.<zone>/api/staff` | Access, then the admin tunnel, then `admin` |
| `https://verify.<zone>/c#<token>` | The verify static deployment's `index.html`. The token is in the fragment, so it never leaves the browser; the app posts it to `POST /api/link/open` and gets the `__Host-fin-verify.ls` cookie ([SA-37], SF-07; spec 03 §2.5) |
| `https://selfie.<zone>/s#<sft id>.<secret>` | The selfie static deployment. The page posts the one-time ticket to `POST /api/selfie/session` on its own host ([SA-26], SF-07; spec 03 §2.6) |
| `https://developer.<zone>/reference` | The docs static deployment |
| `https://api.<zone>/v4/customers` | The public tunnel, then `edge` |
| `http://console.<zone>/` | A 308 redirect to https from a Single Redirect |

**The rules that make it work.**

- **Routes.** Each browser host has two Workers routes. `<host>/*` goes to the app's assets-only
  deployment. `<host>/api/*` has no Worker, so it falls through to the host's proxied CNAME to the
  tunnel. The API route is always written `/api/*` and never `/api*`. No route of a single-page app
  sits under `/api`.
- **Ingress.** Each tunnel's ingress is a fixed map in code. It matches a host role and `^/api/`, sends
  the request to one named service, and ends with `http_status:404`. No setting can point a public
  host at `payments` or Postgres (ARCHITECTURE §5.3).
- **Trust.** The API services trust Cloudflare's headers only from their own tunnel's connectors, and
  only when the per-host ingress proof is present (ARCHITECTURE §5.5).
- **Cookies** ([SA-43]). Every cookie is host-only and `__Host-` prefixed: `Secure`, `HttpOnly`,
  `Path=/`, with no `Domain`. The session cookie is `SameSite=Strict`, and every other auth cookie is
  `Lax`.
- **CSRF** ([SA-44]). Every unsafe request passes four checks: an exact `Origin` check,
  `Sec-Fetch-Site`, the `X-Fin-App` header and a JSON-only body. Better Auth's own origin check, with
  exact trusted origins, runs underneath. An app's API sends no CORS headers.
- **Try it** ([AP-10]). The docs call `api.<zone>` cross-origin, without credentials, with Sandbox keys
  only. The edge answers CORS for the docs origin alone.
- **Caching.** API answers set `Cache-Control: no-store`, and a Cache Rule bypasses the cache for
  `/api/`. On the app hosts and the docs host, a Response Header Transform Rule sets
  `Cache-Control: no-store` on any HTML answer under `/assets/`, so a missing chunk's single-page
  fallback is never cached as immutable ([BD-12]). Real assets keep `immutable`, and `index.html`
  keeps `no-cache`.
- **Paths.** One WAF custom rule on the app hosts and the docs host reads the raw path
  (`raw.http.request.uri.path`) and refuses `..`, `//`, `%2E`, `%2F`, `\`, `;` and `*.map` in it.
  The WAF sees a normalised path while the tunnel receives the raw one, so a rule on the normalised
  path let `..` through ([BD-13], amended by the build on 21 Nov).
- **The routing is proven.** SP-25 passed on 21 Nov, on a throwaway host (S-01;
  [spikes.md](spikes.md)): the route with no Worker hands `/api/*` to the tunnel. The per-app API
  hosts on the same site (`console-api.<zone>`, `verify-api.<zone>` and `admin-api.<zone>`, with
  exact single-origin CORS and credentials) stay documented as the fallback, not needed
  (ARCHITECTURE §5.17; EXECUTION §2.6, S-01).

## 4. The decisions taken on 21 Nov 2026

The owner set the scope on 21 Nov 2026 as requirements R1 to R16 ([G-01]), in a new public
repository with the plan first ([G-02]). While the plan was being written that night, the owner made
the decisions below (times on the owner's clock). They override every earlier draft and every research note, and the
plan applies them throughout (ARCHITECTURE "Decisions taken on 21 Nov 2026"; DECISIONS "The owner's
decisions of 21 Nov 2026, overnight" and appendix B; EXECUTION "The owner's decisions of 21 Nov
applied in this file"; spec 01 §1, where they appear as OD-1 to OD-6). The owner's answers at the
Saturday sitting, later that morning, are in section 7.2.

| Time | Decision | Recorded in | Status |
|---|---|---|---|
| about 02:40 | **Cloudflare Tunnels for every host**, Fin Admin included. No Railway public domain or TCP proxy. One public and one admin tunnel, each token only in its own connector service's sealed variables. Connectors watched every minute for count, version and an origin inside Railway's static egress. An evict runbook that deletes and recreates the tunnel. Cloudflare's headers trusted only from connector peers. The on-demand database tunnel as researched. The proxied design with Railway Edge Rules kept only as an option after launch | [FD-01], [FD-11], [FD-13], [FD-14], [FD-15], [FD-16], [P-03] | In force |
| about 03:00 | **The single-page app (Shape B) stays.** Hono stays only as the API and auth server on Railway. The apps are built to static files that Cloudflare serves, with `index.html` no-cache, hashed assets immutable and security headers from a `_headers` file per app. Nothing that cannot move to another static host. GitHub Actions builds and uploads with a pinned CLI | [FW-01], [FD-17], [FD-19], [SA-45], [P-02], [OB-18] | In force, except the hosting on Cloudflare Pages, which 03:50 replaced. On staging, Cloudflare's API replaces the pinned CLI ([BD-16]), and the uploads run from the operator machine until the owner is back ([BD-05]). Both are the build's decisions, for the owner's review |
| about 03:10 | One origin per app through Origin Rules, with `__Host-` cookies (session Strict, OAuth state Lax) and CSRF by `Origin` plus a custom header | [FD-18], [SA-43], [SA-44] | The routing is superseded at 03:50, because Origin Rules' DNS-record and Host-header overrides are Enterprise-only (research C1 and C3). The cookie, CSRF, spike and Try it parts hold |
| about 03:25 | **The UI is built on the UI SDK** (`@ui-sdk/react`, `@ui-sdk/core`). fin-next's `packages/ui` implements the Fin design system on it, using only the token values and specifications. The old product's redesign branch is a reviewed starting point, ported through fin-review (superseded: see Status). The design system's private source is not vendored | [UI-10], [UI-12], [G-04], [G-06] | In force, except its starting point to port, which the owner's no to [UI-12] (21 Nov, about 08:28) supersedes: nothing is ported, and the UI is built fresh from the canvases. Supersedes [UI-01] |
| about 03:25 | **The sidebar's edge toggle.** A small round chevron on the sidebar's right edge near the top, always visible: ‹ collapses and › expands. The logo is a plain 24px mark that links to Home, with no hover swap | [UI-11] | In force; amends round 2's brand swap ([UI-09]) |
| about 03:50 | **Assets-only static deployments, one host per app.** Each app's build is served by Workers static assets with no script, no binding and no `run_worker_first`, using `not_found_handling: single-page-application`, `workers_dev: false` and `preview_urls: false`. `<app>.<zone>/api/*` goes through a route with no Worker to the tunnel. No CORS between an app and its API. Cookies and CSRF as in section 3. No code runs at Cloudflare. `api.<zone>` goes straight to the tunnel. SP-25 proves the routing on Saturday, with per-app API hosts as the fallback | [FD-17], [FD-18], [FD-13], [FD-05], [SA-43], [SA-44], [AP-10] | In force; SP-25 passed on 21 Nov, so the per-app API hosts are not needed. Supersedes the 03:00 Pages hosting and the 03:10 Origin Rules routing |

**What changed in the register** (DECISIONS "How to read it"):

- **Decided overnight:** [G-04] (its confirmation; the one exception for the design layer was
  withdrawn at about 08:28 by [UI-12]'s no), [P-02], [FW-01], [FD-11], [FD-13], [FD-14], [FD-15],
  [FD-17], [FD-18], [SA-43], [SA-44], [SA-45], [UI-10] and [UI-11].
- **Confirmed or amended:** [P-03], [FD-01], [FD-16], [SA-26], [AP-10] and [UI-09].
- **Superseded:** [UI-01], [UI-05] and [SA-25].
- **Withdrawn:** [FD-02] and [FW-03].
- **New for the owner overnight:** [UI-12] and [OB-18], both decided at the Saturday sitting:
  [UI-12] no (about 08:28), and [OB-18] at its default (section 7.2).
- **Rewritten, under the same IDs:** the framework conditions FW-C04 and FW-C06 (ARCHITECTURE §3.4).
  FW-C04 was a templated document with a per-request nonce, and is now a static `index.html` with no
  nonce. FW-C06 was a style nonce for injected styles, and is now the UI SDK's constructed style
  sheets under a nonce-less meta tag. Neither condition is withdrawn: both still bind.
- **No longer used:** static files served by a Hono process, Cloudflare Pages and Origin Rules.
- **Theme and sidebar.** These choices now live in the browser's `localStorage`, not in cookies
  ([UI-13]).

## 5. Traceability: R1 to R16

"At staging-complete" is EXECUTION §0.2's forecast. A partial requirement is a recorded decision, with
the item that completes it.

| Req | The owner's requirement | Where it is covered (file and section) | Key decisions | At staging-complete |
|---|---|---|---|---|
| R1 | Production-ready, from scratch, in a new repository | ARCHITECTURE §1, §11.10, §14, §15; EXECUTION §7 (definition and PG-01 to PG-14); spec 01 §2, §3; spec 08 §10 | [G-01], [G-02], [G-04], [G-05] | Partial: production readiness is EXECUTION §7's gates |
| R2 | Everything on Railway, including the database | ARCHITECTURE §4; spec 01 §6; spec 08 §0.2 | [P-01], [P-02], [P-09], [OB-18] | Full for compute and the database. Off Railway by decision: the static files, the vault, the watcher, the tunnels' edge, Access and email |
| R3 | Cloudflare Email Sending | ARCHITECTURE §9; spec 01 §7.8; spec 08 §4; spec 02 §17, spec 03 §17 | [EM-01] to [EM-08] | Full on staging; production needs [EM-02] and the warm-up ([EM-08]) |
| R4 | Cloudflare in front of Railway | ARCHITECTURE §5; spec 01 §7; spec 08 §8.2; section 3 of this page | [FD-01], [FD-13] to [FD-19] | Full; the evict drill is in hardening (PG-05) |
| R5 | Better Stack replaces Grafana and Sentry | ARCHITECTURE §10; spec 01 §8; spec 08 §7; the monitoring section of each day's spec (spec 02 §18, spec 03 §18, spec 04 §30, spec 05 §10) | [OB-01] to [OB-17] | Full on staging; production paging and the responder gate are PG-09 |
| R6 | Saturday: auth with roles for the dashboard and Fin Admin; granular Fin Admin roles with prebuilt roles; a second factor to add someone; a second factor for every admin | ARCHITECTURE §7.1 to §7.7; EXECUTION §3; spec 02 (§6 the mandatory second factor, §7 step-up, §8.3 Fin Admin's catalogue and prebuilt roles, §10 staff management); spec 06 §8.2, §8.3 | [SA-04], [SA-05], [SA-11] to [SA-14], [SA-29], [SA-43], [SA-44] | Partial if Saturday's stretch slips: custom staff roles, staff factor reset, passwords and Google |
| R7 | Sunday: customer and business onboarding, and going live (Sumsub) | ARCHITECTURE §6.5, §12.16; EXECUTION §4; spec 03 (§3 domain, §6 the KYC port and Sumsub adapter, §14 going to Production); spec 06 §8.5 to §8.7 | [KY-01] to [KY-13], [SA-26], [SA-37] | Partial under [KY-13], decided at its default: Sumsub's monitoring queues and re-screening are not built |
| R8 | Monday: providers, MassPay first, behind an adapter for several providers | ARCHITECTURE §12; EXECUTION §5; spec 04 (§3 the interface, §5 capabilities, §21 MassPay, §22 the simulator, §23 conformance, §36 gates); spec 06 §8.8 | [MO-01] to [MO-23] | Partial: MassPay sandbox only; no second adapter or real inbound deposits yet (PG-14) |
| R9 | Everything completely audited | ARCHITECTURE §8, §6.3; spec 08 §3; the audit section of each spec (spec 02 §16, spec 03 §16, spec 04 §28, spec 05 §3.9, §4.10, §5.7); spec 07 §6.5 for reviews | [AU-01] to [AU-09] | Partial: Railway's own audit log is exported weekly; Better Stack's audit add-on is not bought |
| R10 | fin-review: quality, bugs and performance across the codebase and per commit and merge; a faster CI; fast itself | ARCHITECTURE §11.3, §11.6, §11.13; EXECUTION §1.7, §2.4; spec 07 (§2 the engine, §5 caching and budgets, §10 making CI fast, §12 speed targets) | [RV-01], [RV-02], [RV-12], [RV-20], [CI-02] | Partial: local runs, each recorded in its pull request on its exact head ([G-10]). Signed receipts move to hardening (D6), the cache comes in H-03, and the CI runner once CI has an Anthropic credential, an owner step with no date yet |
| R11 | Selectable model and effort (high or above); a separate attack model and effort (high or above); Opus or Fable only; a Fable run cannot use an Opus attack, while an Opus run may use a Fable attack | ARCHITECTURE §11.6; spec 07 §3 (options, validator, the 27 valid combinations), §4 (locked sessions) | [RV-03], [RV-06], [RV-07], [RV-19] | Full for the models, the attack pass and tiers N and D, proven per session by the models and efforts recorded in the pull request until hardening, then by each signed receipt (D6). Narrowed on tier S under [RV-06]'s floor, decided at its default on 21 Nov: a gating run there refuses `--effort high`, which gives only an advisory run with no receipt (spec 07 §3.4). Full everywhere only if the owner later changes [RV-06] to `high` everywhere |
| R12 | The public repository `aktharazif/fin-next` | ARCHITECTURE §11.1; spec 01 §3; spec 07 §8, §9 (sealed findings) | [G-02], [G-03], [G-09], [CI-01], [CI-08], [CI-15], [UI-12] | Full |
| R13 | The plan first, saved in the repository | This page; ARCHITECTURE, DECISIONS, EXECUTION, the spike log [spikes.md](spikes.md) and specs 01 to 08; spec 01 §3.1 (the plan merged as pull request 1, before any code) | [G-02] | Full |
| R14 | The new designs: the canvases "Fin Dashboard · new design" and "Fin Admin · new design" | ARCHITECTURE §3.4; spec 06 (§3 the design system, §4 the shell and the edge toggle, §8 the screens day by day, appendix A every board and state); the screens section of each day's spec | [UI-02], [UI-09] to [UI-13] | Partial: screens without a board are built as marked pending compositions; full parity in H-02 |
| R15 | Bun or Node, checked | ARCHITECTURE §3.2; spec 01 §4.1, §5.3 (the `bun` job in `ci.yml`) | [P-05], [CI-10] | Full: Node, with the Bun canary job |
| R16 | The public API, and a good docs site with Try it on Sandbox keys | ARCHITECTURE §13; spec 05 (§3 conventions, §6 routes, §8 the docs site, §9 Try it); spec 04 §25; spec 03 §9 | [AP-01] to [AP-20], [FD-18] | Partial: the reference with Try it and the getting-started guide; other guides, the changelog and search in H-08 |

Each specification also lists the requirements it touches, with sections, in its own requirement map
(section 8 links them).

## 6. Timeline

Times are build-day targets on the build clock: Phase 0 starts at 08:00 on Saturday, and every other
time is that start plus the hours between. The clock's time zone is not part of the plan ([G-09]);
package release ages are in UTC (EXECUTION, "How to read this file").

| When | What must be on staging by the end | Where |
|---|---|---|
| Sat 21 Nov, 08:00 to 13:30, Phase 0 | The public repository with the plan merged as pull request 1; the repository settings and the ruleset (the ruleset and part of the settings applied 21 Nov, the rest applied the same way and read back; spec 01 §3.2, §3.3); CI with `gate`, which then becomes the ruleset's required check ([BD-02]); the fin-review minimum, with R11's model and effort rules enforced in code; Railway staging with Postgres 18; the public and admin tunnels, the watcher and the assets-only static deployments; Better Stack receiving lines and errors; one email delivered. The front-door spike S-01 (SP-25) ran from 09:10 to 09:25 and passed ([spikes.md](spikes.md)). The builder account, the agents' own OS users, signed receipts and the private overlay's ceremony move to hardening (D6) | EXECUTION §2; spec 01; spec 07 §15 |
| Sat 21 Nov, R6 | Both realms with emailed codes and passkeys, TOTP and backup codes; the mandatory second factor; step-up intents; organisations, team, invitations and roles; Fin Admin's staff permissions and prebuilt roles; adding staff with an intent and an enrolment code; audit and security emails; the frames on the UI SDK with the edge toggle | EXECUTION §3; spec 02; spec 06 §8.2, §8.3 |
| Sun 22 Nov, R7 | Saturday's spill (08:00 to 11:00); the public API foundation and the edge; the KYC domain, the Sumsub adapter and the sandbox provider; inbound Sumsub webhooks, built and tested with signed fixtures and live once the owner registers the webhook (by Mon 23 Nov), with review results polled until then; the hosted verify pages and the selfie host; requests for information; developer webhooks and events; going to Production end to end; Fin Admin's review screens | EXECUTION §4; spec 03; spec 05 §6.3 to §6.7 |
| Mon 23 Nov, R8 | The money schema and ledger; the `ProviderAdapter` interface; the Fin simulator and the conformance suite; the MassPay adapter (sandbox) in `payments`; virtual accounts, beneficiaries and transfers; reconciliation; the money API and screens; the docs site with Try it on Sandbox keys | EXECUTION §5; spec 04; spec 05 §6.8, §8, §9 |
| Tue 24 and Wed 25 Nov | Two spill days for the three days' must-haves | EXECUTION §6 |
| Thu 26 Nov, 22:00 | **Staging-complete** (target, UNVERIFIED) | EXECUTION §0.1 |
| From Fri 27 Nov | Hardening, H-01 to H-15: screens to full coverage, fin-review v2, security depth, operations, monitoring, performance, docs, the personal-data lifecycle, the production build, soaks and drills, the cold review, portability. Also what moves to hardening from Phase 0 (D6): the builder account and its token, the agents' dedicated OS users, signed review receipts and the private overlay's ceremony | EXECUTION §6 |
| Week of 14 Dec 2026 at the earliest | The production gates are checked, and production opens on the owner's go (PG-13). Live money waits for PG-14 | EXECUTION §6, §7 |

**Every day** has four checkpoints: C1 triage at 08:00, C2 midday at 13:00, C3 the cut decision at
18:00 and C4 deploy at 22:00. Merge batches run every 90 minutes. The next morning's 08:00 to 11:00
block takes the previous day's spill (EXECUTION §1.10). The cut lines CUT-01 to CUT-06 and the risks
are in EXECUTION §8.

**Estimates (all UNVERIFIED until measured; EXECUTION §11):**

- about 30 to 45 pull requests merged over the three days;
- the platform at about 290 to 420 USD a month before review spend;
- review spend likely several hundred USD a day during the build once reviews bill through the API
  (CI's Anthropic credential, CR-03), within [RV-13]'s caps; until then the local runs use the
  owner's subscription and its usage limit.

## 7. Before Saturday 10:00: what the owner provides

This section follows EXECUTION §0.3 and DECISIONS "Owner decisions, by deadline". The owner gives
everything below in the owner's own sessions. A credential is typed into the secure prompt or created
in the provider's console. It is never pasted into a chat, a file in the repository or a log.

Before the plan is pushed to the public repository, the owner also takes [G-09]'s pre-publication
step (spec 01 §3.1, step 0), and the public-safety check runs over `docs/plan/` with [G-09]'s refuse
list, which is kept on the build machines (machine A and machine B) until hardening.

### 7.1 Credentials and accounts, with their exact scope

In the order they are needed.

Status, 21 Nov: the Railway workspace (one empty staging project) and the Better Stack team
`fin-staging` exist, and the owner gave the credentials at about 08:37. CR-04, CR-05 and CR-09 are
met. CR-06 is met (Workers Paid and R2 were already active). CR-05b is not needed ([FD-09]). CR-25
was not given as a token of its own: the operator token (CR-05) holds its R2 permission, so CR-25 is
covered by CR-05 until the owner is back (DECISIONS, the away-time section). CR-10 is still open
([BD-14]). Until the owner is back, the credentials given at about 08:37 are kept as local secret
files on the build machine, and `pnpm fin` reads them there ([SA-22]). Where a row below says "the
secure prompt", that applies again once the owner is back.

| ID | What | Exact scope | Lives in | Needed by |
|---|---|---|---|---|
| CR-21 | The private overlay, holding everything [G-09] lists: the staging zone's name; the old product's repository and zone names, the design system's private repository name, the redesign pull request's reference and source commit (the public-safety check's refuse list); the staff list (CR-07), the Zero Trust (Access) team name and the Access audience tags; the Cloudflare, Railway and Better Stack account, workspace, team, source and tunnel IDs that no API resolves from a name; the seed inbox address; the on-call roster, its time zone, quiet hours and escalation timings; the time zone of the build clock and of the owner's decision times; the threat model's private annex (spec 08 §2.5); the private provider notes, which hold what Fin observed of a provider's behaviour, fees and account terms (ARCHITECTURE §12.12, spec 04 MS-30); every numeric alert threshold and heartbeat grace period ([OB-13]); and spec 01 §9.2's additions, the static egress addresses and the database CA fingerprint. The names Fin gives its own objects, its Better Stack teams, schedules and workspaces included, are public labels and are not in it ([G-09]) | Not a credential, but never in the repository ([G-09]) | Until hardening, a file kept only on the build machines (machine A and machine B), outside every repository, which `pnpm fin` and the public-safety check (its refuse list) read there; never a GitHub secret, unless the owner adopts spec 01's S0-11 in DECISIONS appendix C. Giving it at the secure prompt, with its encryption and escrow, moves to hardening (D6) | 08:00 |
| CR-01 | The repository `aktharazif/fin-next`, created public; GitHub Pro ([CI-06]) | The owner's own GitHub account, as repository admin. Until hardening the agents use this login. They apply the repository settings with it, Issues, Discussions, Wiki and Projects off among them, as the owner decided at about 08:25 ("u do"). Those spec 01 §3.2 marks "applied 21 Nov" are on, and each other row is applied the same way and read back. It authors every pull request ([BD-02]). From hardening, no agent holds this login: the builder account replaces it for agents (D6) | GitHub | 08:00 |
| CR-17 | **Moves to hardening (D6).** The builder machine account (a separate GitHub user: a collaborator with Write and no Admin) and its tokens; the `fin-builder` and `fin-review` OS users on both machines; an Ed25519 receipt-signing key pair per machine. The scopes are kept for hardening | **Builder token:** a classic token with `public_repo` only (no `workflow`, no `admin:*`, no `repo_deployment`, no `delete_repo`) and a 30-day expiry. If SP-23 shows a collaborator's fine-grained token can reach this repository, use one instead: this repository only, with Contents read and write, Pull requests read and write, and Metadata read. **CI lane token:** the same account with `public_repo` and `workflow`, a 7-day expiry, held only by the CI lane's session. **`fin-review` token:** pushes only `refs/fin-review/receipts/*`, re-runs `gate` and, once CI reviews run (CR-03), downloads CI runs' sealed artefacts (`public_repo`; SP-24 tests a narrower form). **Receipt keys:** the private half never leaves the `fin-review` keychain, and the public half goes to `docs/review/receipt-keys/` | GitHub; each machine's keychains | Hardening, before production |
| CR-02 | Claude Code signed in for the agents' sessions on both machines. The dedicated `fin-builder` and `fin-review` OS users move to hardening (D6) | The owner's subscription, with both Opus and Fable answering in a `fin-review` session (the doctor checks). No settings file that caps effort, sets a model alias or switches provider | Until hardening, the login of the user the agents' sessions run as; then each OS user's login | 08:30 |
| CR-04 | A new Railway workspace on Pro for staging: two-factor sign-in required, one project with only its default environment, PR environments off, static outbound IPs available | One **project token** for that project's default environment, which can deploy and configure services in it and nothing else. The project token is the standing credential. The workspace token the owner gave at about 08:37 is a setup fallback only. The owner revokes it on Mon 23 Nov (agreed at about 08:49), and after setup no code, runbook or check depends on it. No other workspace or account token is stored. If SP-03 shows that a later call needs one, the owner types a workspace token for that one run and revokes it afterwards | The secure prompt for `pnpm fin` (until the owner is back, a local secret file on the build machine, [SA-22]); the `staging` GitHub environment's secret ([CI-03]) only once the approval-gated environments come, when the owner is back ([BD-05]) | 08:30; met 21 Nov |
| CR-05b | **Not needed ([FD-09]).** Staging uses the shared staging zone in the existing Cloudflare account, so no zone is registered and no account is made. The request was a new staging zone in a new Cloudflare account, with Zero Trust on the Free plan | None | None | Not needed ([FD-09]) |
| CR-05 | The operator token on the staging account, owned by the account | **Zone permissions, on the staging zone only:** Zone Read, Zone Settings Read (`pnpm fin` never changes a zone-wide setting on the shared zone, AC-P0-41), DNS Edit, Workers Routes Edit, Transform Rules Edit, Configuration Rules Edit, Cache Rules Edit, Single Redirects Edit, Zone WAF Edit. No Logs permission until Logpush is built in hardening ([FD-08], spec 01 S0-22). **Account permissions, on the staging account only:** Cloudflare Tunnel Edit, Access: Apps and Policies Edit, Workers Scripts Edit, Email Sending Edit, Account API Tokens Edit (to mint CR-08, CR-15's writer tokens, CR-18, CR-20, and the one-run static tokens for uploads from the operator machine until the owner is back, [BD-05], and for a rollback without CI), Account Settings Read. The staging zone and account are the ones the old product's staging also uses ([FD-09]), so these zone and account permissions also reach the old product's resources there. `pnpm fin` checks every staging write against [FD-09]'s allow-list in code and refuses anything that is not one of fin-next's names or under one of them, or one of its own account objects (tunnels, Workers scripts and R2 buckets named `fin-next-staging-`, the tokens it minted). The plan's expiry is 24 hours (a new token each morning) once the owner is back, with a client IP filter to the operator's address where practical. Until then the token the owner gave on 21 Nov stands, and it expires on Thu 26 Nov. It also holds CR-25's R2 permission, so `pnpm fin vault create staging` uses it for CR-25's part until the owner is back. Renewing it before Thu 26 Nov is an owner step (DECISIONS, the away-time section), and the renewal makes spec 01 §7.10's narrow tokens, CR-05 with this scope and CR-25. The group names follow Cloudflare's token page (UNVERIFIED): S-01's record ([spikes.md](spikes.md), run 1) does not cover them | The secure prompt, per run; until the owner is back, a local secret file on the build machine ([SA-22]) | 08:30; met 21 Nov |
| CR-25 | The R2 bucket-administration token on the staging account | Owned by the account; **Workers R2 Storage Edit** on the staging account only, to create the vault's buckets with their locks and lifecycle rules, and nothing else; a 24-hour expiry. The group name follows Cloudflare's token page (UNVERIFIED) | The secure prompt, per run, once the owner makes it with the renewal of CR-05 before Thu 26 Nov. It was not given as a token of its own on 21 Nov: until the owner is back, `pnpm fin vault create staging` uses CR-05, which holds this R2 permission, for CR-25's part | 08:30; covered by CR-05 until the owner is back |
| CR-15 (operator part) | The vault's `fin-next-staging-ops` and `-state` buckets and the operator's writer token for each, made by `pnpm fin vault create staging` with CR-25 and CR-05 before any other run (until the owner is back, with CR-05 alone, which covers CR-25's part); the `-escrow` bucket's writer token only once CR-10 is given ([BD-14]) | Each token reaches one bucket, object read and write only | The operator's tokens: the secure prompt, per run; until the owner is back, kept on the build machine like the credentials they are minted from ([SA-22]) | About 10:00, made by the first registered run (CR-25's part covered by CR-05 until the owner is back). No secret is escrowed on staging until CR-10 arrives ([BD-14]) |
| CR-10 | The staging escrow `age` recipient and the drill recipient ([DA-15]) | The public keys only. The escrow identity stays in the owner's password manager, with a printed copy, and the drill identity in the owner's password manager | The public settings ([G-09]) | Still open, an owner step. Until it is given, staging has no secret escrow and no encrypted dumps, Railway's PITR and volume backups cover staging, and a lost staging secret is regenerated ([BD-14]) |
| CR-09 | Better Stack: an organisation with the team `fin-staging` (data region `europe`, two-factor enforced, AI features and MCP off) | Three **team-scoped** tokens for `fin-staging` only: a Telemetry token and an Uptime token for `pnpm fin monitoring apply`, and a separate CI Telemetry token with which `finish-staging` registers releases and `sourcemaps-staging` uploads the build's browser maps ([CI-03], [FD-19]). No global token. Ingest tokens and error DSNs are made by `monitoring apply` and become sealed variables per service | The secure prompt, per run (until the owner is back, local secret files on the build machine, the CI Telemetry token among them, [SA-22]); the CI Telemetry token only as the `staging` GitHub environment's secret `BETTERSTACK_TELEMETRY_TOKEN` ([CI-03]). Until the owner is back, release registration and the browser maps' upload run from the operator machine, and the `staging` environment secret comes with the approval-gated environments ([BD-05]) | 09:00; met 21 Nov (the team exists, data region `europe`; the tokens were given at about 08:37) |
| CR-06 | Workers Paid on the staging Cloudflare account | The account's Workers plan. Email Sending to any recipient and the watcher's minute cron need it; static asset requests are free on any plan | Cloudflare | 09:30; met 21 Nov: the build found Workers Paid and R2 already active on the account, so neither email to any recipient nor the vault needs an add-on |
| CR-08 | The email token and the seed inbox | Minted by `pnpm fin email token staging` with CR-05: owned by the account, **Email Sending Edit only**, for the staging zone's `auth.` and `notify.` sending subdomains, with a client IP filter to `worker`'s static egress addresses (S-03 checks that the filter is honoured) and an expiry of 180 days or less. The seed inbox is the owner's own mailbox, named in CR-21 | A sealed variable on `worker` only | 10:00 |

**Later on Saturday** (EXECUTION §2.9):

| Time | Credential |
|---|---|
| 11:00 | CR-18, the watcher's read-only tokens; the Railway Viewer-only user's token waits for the owner (SP-21) |
| 12:00 | CR-07, the staff list (into the overlay) and the Access settings. On staging, Access lets the staff addresses in with a One-time PIN ([FD-05]; the steward's decision, for the owner's review). `pnpm fin` sets Access's MFA settings on the application itself; any that SP-09 shows exist only in the Zero Trust organisation's settings wait for the owner (EXECUTION §2.5, step 9) |
| 12:00 | CR-15's audit part: the worker's writer token. Its backups part, the backup's writer token, waits for CR-10 ([BD-14]) |
| From 13:00 | CR-19, the canary key, made by the ops agent alone while the owner is away |
| 17:00 | CR-22, fin-review's ingest token and nightly heartbeat URL |
| Given, about 08:49 | CR-11, the first Fin Admin's address: the owner's staff address, which this repository never names. The staff bootstrap makes the first staff admin from it. On staging its second factor is a TOTP authenticator, and Access's own factor is a second TOTP, each secret kept only in a local secret file on the build machine ([SA-04], [FD-05]), so agents can sign in and run Fin Admin's journeys; on production no agent holds a staff member's factor (the steward's decision, for the owner's review) |

CR-20, the static deploy token, waits for the `staging-static` environment, when the owner is back.
Until then each static upload from the operator machine uses a one-run static token minted with
CR-05 ([BD-05], spec 01 §6.9).

CR-13's Sumsub and CR-14's MassPay sandbox credentials came early, at about 08:37 on Saturday. The
Sumsub webhook comes later: the owner registers it in Sumsub's dashboard and gives its secret at the
secure prompt, by Mon 23 Nov. Until then onboarding polls Sumsub for review results ([KY-02]).

CR-23 (fin-review's CI ingest token) and CR-24 (each machine's `age` identity) come once CI has an
Anthropic credential (CR-03, below), with H-03b's CI runner, and EXECUTION §2.9 lists them.

**Owner steps from the decisions of 21 Nov, still open:**

- CR-10, the staging escrow `age` recipient and the drill recipient, for which staging's escrow and
  encrypted dumps wait ([BD-14]);
- the Sumsub webhook and its secret, by Mon 23 Nov;
- revoking the Railway workspace token, on Mon 23 Nov (CR-04);
- renewing the Cloudflare operator token before it expires on Thu 26 Nov. The renewal makes spec
  01 §7.10's narrow tokens, CR-05 and CR-25, and CR-25 stops being covered by CR-05;
- reading the DKIM, SPF and DMARC results of S-03's message and the first staging sign-up's emails
  in the seed inbox (AC-P0-10, AC-SAT-20), unless the owner decides otherwise (DECISIONS, the
  away-time section);
- the Railway Viewer-only member and its token, for SP-21 and CR-18 (until then `pnpm fin verify`
  checks Railway's domains and TCP proxies daily);
- in Sumsub's dashboard, the app token's IP allowlist and the WebSDK's allowed origin (CR-13,
  SP-11);
- Access's MFA settings, if SP-09 shows they are organisation-wide (CR-07);
- the Anthropic credential for fin-review's CI job (CR-03), with no date yet.

### 7.2 The nine decisions Saturday's start depended on

These are DECISIONS' short list. The owner decided all nine at the Saturday sitting, 21 Nov 2026. At
about 08:25 the owner answered "defaults": [G-06] is approved as amended, and [OB-18], [SA-05],
[SA-12], [AU-01], [G-10] and [CI-14] take their defaults, with [G-10] then amended by the steward,
for the owner's review (its entry). [UI-12] was decided otherwise at about 08:28,
and [FD-09] at about 08:30. Nothing waits on them now.

| # | Decision | Default | Decided |
|---|---|---|---|
| 1 | [G-06] The starting dependency set, as amended overnight | Approve the set in [G-06] as recorded, with no release-age exception. The UI SDK (`@ui-sdk/react` and `@ui-sdk/core`, one exact version) replaces Radix, Phosphor, `clsx` and `tailwind-merge`. It is installed at the newest exact beta that has cleared the three-day release age when the install pull request runs: `0.1.0-beta.9` at P0-4 (cleared at 03:02 UTC), or `0.1.0-beta.10` only if the install pull request runs after 09:47 UTC. It then moves to `0.1.0-beta.13` in a pull request of its own after 12:24 UTC on Sunday. `wrangler` was to be pinned in `tools/static-deploy`; since then, static uploads go through Cloudflare's API from `tools/static-deploy`, with no `wrangler` and so no install script ([BD-16], for the owner's review). `@types/react` and `@types/react-dom`, and the `overrides` entry that pins `@better-auth/core` ([SA-02]), are outside that set: the build approved them under the owner's away-time authority, each with a dated comment ([BD-09]), for the owner's review. The `overrides` pin is flagged for the owner's explicit review | Approved as amended |
| 2 | [UI-12] May the ported design layer (from the old product's redesign branch), part of whose text comes from the design system's private source, the logo's paths, and the verbatim copies of `fin-motion.css`, the export's token file and its font files be public? | Yes. Private-document references are stripped, sample domains become `example.com`, the notices are extended, and the logo stays under [G-03]'s reservation of brand assets: the default not taken | No ("actually NO", "follow the new design from artifacts"): nothing is ported, and the UI is built fresh on the UI SDK from the two new design canvases. The token values, Inter and Fira Mono, and the logo are reused as the canvases use them, the logo under [G-03]'s reservation |
| 3 | [FD-09] The staging zone | A new staging zone in a new Cloudflare account: the default not taken | The shared staging zone, `<staging-zone>`, on new names ([FD-09]). It stays in the existing Cloudflare account, as an accepted risk for test data, and fin-next uses its own names, not the `-next` ones. CR-05b is not needed |
| 4 | [OB-18] May the watcher stay a Cloudflare Worker under the owner's rule of "no vendor locked in items like workers"? | Yes: plain `fetch` calls on a minute cron, with no Workers-only binding, no application traffic and no write credential. This departs from the owner's words. The non-Worker alternative is the same code on a small virtual machine at another provider, outside Railway, for a few US dollars a month per environment (UNVERIFIED), with one more vendor and an operating system to patch. Better Stack's monitors alone cannot read Cloudflare's or Railway's configuration | Yes, the default |
| 5 | [SA-05] A mandatory second factor for privileged dashboard roles, checked on every request across organisations (R6) | Yes | Yes, the default |
| 6 | [SA-12] Fin Admin's granular permission catalogue and prebuilt roles (R6) | 26 permissions; Viewer, Compliance, Operator and Admin; custom roles | The default catalogue and roles |
| 7 | [AU-01] What R9 covers for reads | Audit every reveal of personal data, documents or bank numbers. List reads are log lines | The default |
| 8 | [G-10] What agents may do without asking | The steward merges green pull requests with signed receipts, in batches. Never control paths, plausible high findings, dependencies, staging deploys or production | The default, amended by the steward ([G-10]). Signed receipts move to hardening (D6), so the steward merges a pull request, in batches, once its CI is green and fin-review's local run on its exact head has passed and is recorded in the pull request (the head SHA, the models and efforts, and each finding with how it was settled), and the merge names that head (`--match-head-commit`). A control-path pull request merged while the owner is away is listed in the away-time log ([BD-02]). On staging only, agents may read the first staff admin's mailbox for Fin's and Cloudflare's sign-in emails, to sign in, and nothing else in it. The merge rule, the listing and the mailbox rule are the steward's, for the owner's review. While the owner is away, the owner's away-time authority covers everything up to and including staging. It excludes production, new spending or plan upgrades, any change to the old product's resources, and account deletion (DECISIONS "Decided while the owner was away") |
| 9 | [CI-14] Control paths need the owner's code-owner approval and typed confirmation | Control paths only, now including each app's `_headers`, its static deployment settings and `tools/static-deploy/**`. Other tier S paths rely on signed receipts, which move to hardening (D6); until then, on fin-review's recorded local run | The default. GitHub does not enforce the approval until hardening: the ruleset is on with 0 approvals and no code-owner review, because the owner's account authors every pull request, and the review cadence stands in ([BD-02], for the owner's review) |

Two defaults depart from the owner's literal words. The owner answered the sitting with "defaults"
(about 08:25), so [OB-18] (row 4) is decided at its default, and [FD-19]'s reading of "GitHub Actions
builds, then uploads" as covering staging only stands as recommended (today's staging deploys and
uploads run as [BD-05] and [BD-16] say). Two build decisions also change how staging's static files
are uploaded: from the operator machine until the owner is back ([BD-05]), and through Cloudflare's
API instead of the pinned CLI the owner asked for ([BD-16]). Both are in the away-time log for the
owner's review. Who uploads production's static files (the operator's launcher, so GitHub holds no
production credential, or an Actions job the owner approves) is still a question for the owner,
needed before production, not a settled reading.

The other 24 "before Saturday's start" decisions, in DECISIONS "Before Saturday's start: also at the
sitting", took their defaults at the sitting, and none of them blocked. Among them are the licence
([G-03]), the API path major `/v4` ([AP-01]) and the review's effort floor ([RV-06]), whose default
narrows R11 on tier S; only a later change by the owner to `high` everywhere would widen it.
Decisions due later, from Saturday to before production, are listed by deadline in DECISIONS and
EXECUTION §10.

## 8. How to read the plan

### 8.1 The files

| File | What it holds | Requirements it touches |
|---|---|---|
| [README.md](README.md) (this page) | The front page: summary, stack, hosts, the 21 Nov decisions, traceability, timeline and the owner's first inputs | R1 to R16 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The system: principles, the diagram and data flows, runtime and stack, Railway, the Cloudflare front door, data, security, audit, email, observability, CI/CD and review, provider adapters, the public API and docs, what is carried or dropped, and operating it | R1 to R16 (its "Requirement map") |
| [DECISIONS.md](DECISIONS.md) | The only register: 290 decisions with default, alternatives, rationale, status and deadline, 16 of them in the Build decisions (BD) group, made under the owner's away-time authority; the decisions taken while the owner was away, for the owner's review; the owner's decisions by deadline; the 19 Nov decisions mapped; the critics' findings (appendix A); the changes for the overnight decisions (appendix B) | R1 to R16 (its "Requirements and where they are decided") |
| [EXECUTION.md](EXECUTION.md) | How it is built: the days, how the work runs, Phase 0, Saturday, Sunday and Monday with lanes, order, review gates, screens, acceptance criteria and cut lines; hardening; the production gates PG-01 to PG-14; risks; the old product until fin-next takes over; decisions by when; estimates | R1 to R16 (§0.2) |
| [spikes.md](spikes.md) | The spike log: one row per spike run, with when it ran on the build clock, its result, what it showed and its follow-ups. S-01 (SP-25) is its first row; the build adds rows through pull requests | R4 (the front-door spikes), and each later row's own |
| [specs/01-phase0-platform.md](specs/01-phase0-platform.md) | Phase 0: the public repository and its rules, the monorepo scaffold, the fast CI skeleton, Railway staging, Cloudflare (tunnels, static deployments, routes, Access, email, the vault, the watcher), Better Stack, secrets, the platform's own audit, spikes SP-25 and SP-26 | R1 to R16 (§0.2) |
| [specs/02-auth-and-roles.md](specs/02-auth-and-roles.md) | Saturday: Better Auth configuration, the endpoint allowlist, sign-in methods, assurance and the mandatory second factor, step-up, both permission catalogues and roles, organisations and teams, staff management, sessions, API keys, data model, routes, screens, audit events, security emails, monitoring and tests | R1 to R6, R9 to R16 (§0.2) |
| [specs/03-onboarding-and-go-live.md](specs/03-onboarding-and-go-live.md) | Sunday: the onboarding domain and state machines, data model, the KYC provider port and the Sumsub adapter, inbound events, personal data, the onboarding API routes, developer webhooks, app routes, screens, going to Production end to end, Fin Admin review rules, audit, emails and monitoring | R1 to R16 (§0) |
| [specs/04-providers-and-money.md](specs/04-providers-and-money.md) | Monday: where money runs, the provider adapter interface, capabilities, routing, data model, sealed bank details, the ledger, virtual accounts, beneficiaries, transfers, money in, fees, idempotency, provider events, reconciliation, the MassPay adapter, the Fin simulator, the conformance suite, API routes, screens, audit and the gates for money | R1 to R16 ("Requirement map") |
| [specs/05-public-api-and-docs.md](specs/05-public-api-and-docs.md) | The public API's conventions, API keys, webhooks and events, the route inventory by day, the OpenAPI document, the docs site at `developer.<zone>`, and Try it with Sandbox keys only | R1 to R16 ("Requirement map") |
| [specs/06-ui.md](specs/06-ui.md) | The UI layer: the stack, the app skeleton, the design system on the UI SDK, the shell and the edge toggle, motion and skeletons, the page policy with no inline script, routes, the screens day by day mapped to the canvas boards, accessibility, tests, and every board and state (appendix A) | R1, R4 to R10, R12 to R16 (§0.2) |
| [specs/07-fin-review-and-ci.md](specs/07-fin-review-and-ci.md) | fin-review and CI: the engine and its modes, the R11 options and validator, locked sessions, content-hash caching and budgets, signed receipts, local and CI runs, sealed findings, making CI fast, the merge gate and speed targets | R1, R5 to R16 (§0.2) |
| [specs/08-security-audit-observability.md](specs/08-security-audit-observability.md) | Cross-cutting: the threat model, audit (registry, row, guard, chain, anchoring, journal), security emails, personal data and scrubbers, secrets and rotation, observability on Better Stack, incident runbooks, drills and the gates' evidence | R1 to R10, R12, R15, R16 (§0.2) |

### 8.2 Reading paths

- **The owner:** this page, then DECISIONS "Decided while the owner was away" (for review) and "Owner
  decisions, by deadline", then EXECUTION §0 and §7.
- **A builder:** EXECUTION §1 (how the work runs and the definition of done), then the day's
  specification (01 for Phase 0, 02 for Saturday, 03 for Sunday, 04 for Monday), with 05 and 06 for
  the API and the screens, and 08 for audit, monitoring and secrets. Builders build from the
  specifications and never read the old product's code ([G-04]).
- **A reviewer:** spec 07, then the security bar in EXECUTION §1.6 and the threat model in spec 08 §2.

### 8.3 Precedence

The plan has one order of precedence. It is written once, here, and DECISIONS.md and every
specification copy this sentence word for word in their opening section:

> The plan's one order of precedence, highest first: (1) the owner's decisions of 21 Nov 2026;
> (2) DECISIONS.md, appendix C included; (3) ARCHITECTURE.md; (4) EXECUTION.md; (5) the
> specifications, and between two specifications the one that owns the area, as README §8.3 lists
> the owners.

Where two texts disagree, the higher one binds.

1. **The owner's decisions of 21 Nov 2026**: those made overnight (section 4), which DECISIONS.md
   records in its table "The owner's decisions of 21 Nov 2026, overnight", and those of the Saturday
   sitting (section 7.2) and of later that morning, recorded in the Status of each entry they decide.
   DECISIONS quotes the owner's words in each block. Spec 01 §1 lists the overnight ones as OD-1 to
   OD-6.
2. **DECISIONS.md**, the only register, appendix C included. A decision that is still for the owner
   is built on its default, and a later answer changes the code through a reviewed pull request.
3. **ARCHITECTURE.md.**
4. **EXECUTION.md.**
5. **The specifications.** Between two specifications, the one that owns the area holds for that
   area (the table below). Spec 08 owns the cross-cutting rules of audit, security email, personal
   data, scrubbing, secrets and observability, and holds over a day's specification on them.

This page, the spike log ([spikes.md](spikes.md)), which records results and decides nothing, and
the research notes (section 8.5) rank below all five.

**Spec decisions.** Each specification takes its own decisions where the plan is silent, with the
prefixes in section 8.4. A spec decision that fills a gap binds as its spec says, and the steward
copies it into DECISIONS.md in a later pull request of the plan. A spec decision that would
change a register entry binds only once DECISIONS appendix C settles it. Appendix C settles every
such decision found before the first commit, as SF-01 to SF-10. Each is folded into the entry it
changes or not adopted, and each was also an open item for the owner. The four due before Saturday's
start (SF-01, SF-05, SF-09 and SF-10) took their defaults at the sitting on 21 Nov, though SF-10's
13 months still go to counsel before production; the others keep their deadlines (DECISIONS
appendix C):

| ID | Spec decision | Register entry | Settled as |
|---|---|---|---|
| SF-01 | No `docs` service; the docs site reports to the edge (S0-01, S0-03, D05-01, D08-32) | [P-07], [FD-18] | Folded |
| SF-02 | Static uploads through Cloudflare's API, with no `wrangler` (S0-04) | [FD-19], [G-06] | Not adopted in S0-04's `ops/fin` form: [BD-16] takes the API upload from `tools/static-deploy` instead, since SP-26's data points (21 Nov) show the API alone can make an assets-only deployment. It departs from the pinned CLI the owner asked for, so it is for the owner's review |
| SF-03 | The static deploy token in the `staging` environment (S0-18) | [FD-19] | Not adopted: it stays alone in `staging-static`, which comes when the owner is back ([BD-05]) |
| SF-04 | No `railway connect` in staging (S0-17) | [FD-11] | Folded, under the owner's "no TCP proxies" |
| SF-05 | Environment-neutral builds, with `_headers` and `env.json` rendered at deploy (S0-05) | [FD-17], [SA-45], [CI-14] | Folded |
| SF-06 | A `404-page` fallback for the docs (D05-32) | [FD-17] | Not adopted: the owner set the single-page fallback for every app |
| SF-07 | Link tokens and the selfie ticket only in the fragment (SD3-02, SD3-03) | [SA-37], [SA-26] | Folded |
| SF-08 | `'unsafe-inline'` styles on the docs while Scalar needs them (D05-03) | [SA-45], [AP-11] | Folded, applied only after the owner's yes under [AP-11] |
| SF-09 | The `since` review mode (S7-02); `import` (S7-03) withdrawn, since nothing is ported ([UI-12]) | [RV-02] | Folded |
| SF-10 | Audit context outside the hash chain, kept 13 months (D08-02, D08-34) | [BC-03] | Folded |

A spec decision that disagrees only with ARCHITECTURE.md or EXECUTION.md needs no row, but it does
not bind on its own: both rank above every specification, so their text holds and the spec yields
until that file is changed to match in a reviewed pull request. Where the higher file has already
been amended to match (spec 07 §1.3 lists such changes), the decision binds; the steward proposes
any other such change in a later pull request of the plan.

**Which specification owns which area.** A screen's behaviour (its API calls, refusals, audit events
and copy) belongs to the day's specification; its components, frame and states belong to spec 06.
Where neither of two disagreeing specifications owns the matter, the steward settles it in
DECISIONS.md before work that depends on it merges.

| Area | Owner |
|---|---|
| The repository and its rules, the monorepo, the CI skeleton, Railway, Cloudflare (tunnels, static deployments, routes, `_headers` profiles, Access, the email set-up, the vault, the watcher), Better Stack's set-up, Phase 0's secrets and spikes | Spec 01 |
| Sign-in in both realms, the second factor, step-up, permissions and roles, organisations and teams, staff management, sessions | Spec 02 |
| Onboarding, the KYC port and Sumsub, the hosted verify pages and the selfie host, requests for information, going to Production, Fin Admin's review rules | Spec 03 |
| Providers, money, the ledger and reconciliation | Spec 04 |
| The public API's conventions, API keys, webhooks and events, the OpenAPI document, the docs site and Try it | Spec 05 |
| The UI layer: components, frames, the routes' shape, the states' visual contract, the page policy's UI obligations, the UI test harness | Spec 06 |
| fin-review, the merge gate and the review parts of CI | Spec 07 |
| The threat model, audit, security email, personal data and the scrubbers, secrets and rotation, observability, incident runbooks and drills | Spec 08 |

### 8.4 IDs and marks

| Mark | Meaning | Kept in |
|---|---|---|
| `[XX-nn]` | A decision. Areas: `G` governance, `P` platform and runtime, `FD` front door, `DA` data, `SA` security and auth, `AU` audit, `EM` email, `OB` observability, `CI` CI/CD, `RV` review, `MO` money and providers, `KY` onboarding, `AP` public API and docs, `UI` screens and the design system, `FW` the web framework, `OP` operations, `BC` behaviour carried or changed from the old product, `BD` build decisions, made by the build session under the owner's away-time authority, for the owner's review. On this page each one links to its block | DECISIONS.md |
| `SF-nn` | A spec decision settled in the register before the first commit: folded into the entry it changes, or not adopted (section 8.3) | DECISIONS appendix C |
| `R1` to `R16` | The owner's requirements of 21 Nov 2026 ([G-01]) | Section 5 |
| `OD-1` to `OD-6` | The owner's decisions of 21 Nov, as spec 01 lists them. DECISIONS records the same decisions in its overnight table | Spec 01 §1 |
| `Dnn` (D1 to D57) | A decision of the 19 Nov plan, cited in a block as "Was Dnn" | DECISIONS §17 |
| `(D6)` | Marks work that the owner's trim of Phase 0 on 21 Nov moved to hardening, before production (section 1), as in "moves to hardening (D6)". It is not the 19 Nov decision D6 | Throughout |
| `(D9)` | Marks what follows from fin-review running locally, as the merge gate, until CI has an Anthropic credential (the owner, 21 Nov, about 08:49). It is not the 19 Nov decision D9 | ARCHITECTURE, DECISIONS |
| `EQ-nn` | An owner question of EXECUTION's first draft, with the decision that now answers it | EXECUTION §10 |
| `PG-nn` | A production gate, PG-01 to PG-14. `G-` belongs to governance alone | EXECUTION §7.3 |
| `SP-nn`, `S-nn` | A spike; EXECUTION's four front-door spikes (S-01 is SP-25) | ARCHITECTURE §11.11; EXECUTION §2.6; spec 01 §11 (SP-25, SP-26); spec 03 §22 (SP-27); results in [spikes.md](spikes.md) |
| `NF-n` | A new finding from a spike run (S-01 recorded NF-1 and NF-2) | [spikes.md](spikes.md) |
| `FW-Cnn`, `FW-Snn`, `FW-Xnn` | The framework verdict's conditions, spikes and reversal triggers | ARCHITECTURE §3.4 |
| `CR-nn` | A credential or account the owner provides | EXECUTION §0.3, §2.9 |
| `P0-n`, `P0-<letter>` | A Phase 0 step in order (P0-1 onwards), and a Phase 0 lane (P0-B to P0-G; spec 07 runs P0-C, one lane on machine A, as sessions P0-C1 to P0-C3) | EXECUTION §2.1, §2.10; spec 07 §13 |
| `EX-nn`, `NB-nn`, `RK-nn`, `CUT-nn`, `H-nn`, `L-<day>-nn` | Working rules, never-cut security rules, risks, cut lines, hardening workstreams (spec 07 splits H-03 into H-03a to H-03d), lanes | EXECUTION.md |
| `C1` to `C4` | The day's checkpoints: triage at 08:00, midday at 13:00, the cut decision at 18:00, deploy at 22:00 | EXECUTION §1.10 |
| `AC-<day>-nn` | A day's acceptance criterion: `AC-P0`, `AC-SAT`, `AC-SUN`, `AC-MON`. EXECUTION holds the first numbers; the day's specification adds later ones | EXECUTION §2.11, §3.6, §4.6, §5.6; spec 01 §13, spec 02 §21, spec 03 §21, spec 04 §35 |
| `AC-UI-nn`, `AC-RV-nn`, `A05-nn`, `A08-nn` | The acceptance criteria of spec 06, spec 07, spec 05 and spec 08. `A05-nn` and `A08-nn` keep their own numbering, and each names the EXECUTION criterion it carries where there is one | Spec 06 §12, spec 07 §16, spec 05 §14, spec 08 §13 |
| `T-SAT-nn`, `T-MON-nn`, `T-RV-nn`, `T05-nn`, `T08-nn` | A test that spec 02, spec 04, spec 07, spec 05 or spec 08 requires | Spec 02 §19, spec 04 §33, spec 07 §14, spec 05 §13, spec 08 §12 |
| `IF-nn` | An interface spec 02 provides to, or needs from, other specs and Phase 0 | Spec 02 §20.6 |
| `XC-nn` | A cross-spec contract: something another lane provides for Monday's money work | Spec 04 §38.2 |
| `MQ-nn` | A neutral MassPay adapter rule, each with its test; the observations behind it stay in a private provider note outside this repository | Spec 04 §21.6 |
| `CS-nn` | A scenario of the conformance suite that every provider adapter passes | Spec 04 §23 |
| `UR-nn` | A UI request to the design system: something it lacks, or where the code departs from it | Spec 06 §11.4; `packages/ui/UI-REQUESTS.md` |
| `TM-nn`, `TM-Lnn` | A threat-model attacker profile, and a stated limit of the threat model | Spec 08 §2; `docs/security/threat-model.json` |
| `F1` to `F24`, `F-<slug>` | A data flow; a new flow for the Flow Atlas | ARCHITECTURE §2.3; each spec's Flow Atlas section (spec 02 §18.5, for example) |
| `S0-nn`, `S2-nn`, `SD3-nn`, `MS-nn`, `D05-nn`, `S6-nn`, `S7-nn`, `D08-nn` | Decisions taken by specs 01 to 08 where the plan is silent. One that would change a register entry binds only through its `SF-nn` row | Each spec's decisions section |
| `CF-nn` | A critic's finding and how it was resolved | DECISIONS appendix A |
| Research notes A1 to A8, B1 to B7, C1 to C3, D1 to D3 | Working notes outside this repository. They are cited as "research note C1" or "D1 §9", so they are not confused with the checkpoints C1 to C4 or the 19 Nov decisions D1 to D57 | Section 8.5 |
| `§n`, `ARCH §n`, `EX §n`, `BRIEF §n` | A section of the same file, of ARCHITECTURE.md, of EXECUTION.md, or of the design brief (round 2 is its §11) | Throughout |
| UNVERIFIED | A fact not confirmed from a primary source; the named spike or test confirms it before dependent work merges | Throughout |
| SPIKE | A test that must pass before the work it shapes | ARCHITECTURE §11.11 |

### 8.5 Sources

The plan cites working notes by ID: the phase 1 notes A1 to A8, the research notes B1 to B7 (runtime,
Railway, Cloudflare, Better Stack, API and docs, review and CI, auth), C1 to C3 (same-host routing,
cookies and CSRF, and the verdict on both), D1 to D3 (the UI SDK, the old product's design layer,
from which nothing is ported ([UI-12]), and the UI architecture), and the framework verdict. These
notes are not in this repository. Where a note disagrees with the owner's decisions of 21 Nov, the
decisions hold. The design source is the two canvases (their boards, brief and shell rules), with
round 2 of the design brief ([UI-02]); the UI is built fresh from them ([UI-12]). By [UI-06],
decided at its default on 21 Nov, the canvas sources are kept in a private design repository.

<!-- decision-links:start -->
<!-- Each bracketed decision ID on this page links to its block in DECISIONS.md. -->

[AP-01]: DECISIONS.md#ap-01-the-path-major
[AP-02]: DECISIONS.md#ap-02-openapi-from-the-route-schemas
[AP-03]: DECISIONS.md#ap-03-errors-as-rfc-9457-problem-documents
[AP-09]: DECISIONS.md#ap-09-the-docs-stack
[AP-10]: DECISIONS.md#ap-10-try-it-with-sandbox-keys-only
[AP-11]: DECISIONS.md#ap-11-the-reference-page-as-an-exception
[AP-20]: DECISIONS.md#ap-20-fins-test-endpoint
[AU-01]: DECISIONS.md#au-01-what-r9-covers
[AU-03]: DECISIONS.md#au-03-write-once-audit-heads-outside-the-database
[AU-09]: DECISIONS.md#au-09-audit-outside-the-application
[BC-03]: DECISIONS.md#bc-03-address-and-device-on-audit-rows
[BD-02]: DECISIONS.md#bd-02-no-required-approval-on-main-until-hardening
[BD-05]: DECISIONS.md#bd-05-staging-deploys-from-the-operator-machine-until-the-owner-is-back
[BD-07]: DECISIONS.md#bd-07-no-merge-guard-hook-in-phase-0
[BD-09]: DECISIONS.md#bd-09-the-react-types-and-the-better-auth-core-pin
[BD-11]: DECISIONS.md#bd-11-zone-rules-one-rule-at-a-time
[BD-12]: DECISIONS.md#bd-12-no-long-cache-for-a-missing-asset
[BD-13]: DECISIONS.md#bd-13-one-waf-rule-refuses-ambiguous-paths
[BD-14]: DECISIONS.md#bd-14-no-secret-escrow-on-staging-for-now
[BD-16]: DECISIONS.md#bd-16-static-uploads-through-cloudflares-api-without-wrangler
[BD-17]: DECISIONS.md#bd-17-dmarc-on-the-staging-sending-subdomains
[CI-01]: DECISIONS.md#ci-01-rules-on-main
[CI-02]: DECISIONS.md#ci-02-the-ci-design
[CI-03]: DECISIONS.md#ci-03-staging-deploys-from-ci
[CI-04]: DECISIONS.md#ci-04-the-operator-deploys-production
[CI-05]: DECISIONS.md#ci-05-attested-images
[CI-06]: DECISIONS.md#ci-06-github-plan
[CI-08]: DECISIONS.md#ci-08-outside-contributions
[CI-10]: DECISIONS.md#ci-10-a-bun-canary-job
[CI-12]: DECISIONS.md#ci-12-real-postgres-in-development-and-ci
[CI-14]: DECISIONS.md#ci-14-control-paths-need-the-owner
[CI-15]: DECISIONS.md#ci-15-strangers-text-never-reaches-a-session
[DA-09]: DECISIONS.md#da-09-the-r2-vault
[DA-15]: DECISIONS.md#da-15-what-backups-hold-and-the-drill-key
[EM-01]: DECISIONS.md#em-01-cloudflare-email-sending-through-its-rest-api
[EM-02]: DECISIONS.md#em-02-accepting-email-sendings-beta-terms
[EM-04]: DECISIONS.md#em-04-only-the-worker-sends
[EM-08]: DECISIONS.md#em-08-sending-subdomains-and-warm-up
[FD-01]: DECISIONS.md#fd-01-the-front-doors-shape
[FD-02]: DECISIONS.md#fd-02-production-origin-tls
[FD-05]: DECISIONS.md#fd-05-fin-admin-behind-cloudflare-access
[FD-06]: DECISIONS.md#fd-06-turnstile
[FD-08]: DECISIONS.md#fd-08-cloudflare-logs-to-better-stack
[FD-09]: DECISIONS.md#fd-09-the-staging-zone
[FD-10]: DECISIONS.md#fd-10-the-production-zones-and-the-docs-domain
[FD-11]: DECISIONS.md#fd-11-the-operators-database-route
[FD-13]: DECISIONS.md#fd-13-the-tunnel-design
[FD-14]: DECISIONS.md#fd-14-a-tunnel-of-its-own-for-the-api
[FD-15]: DECISIONS.md#fd-15-the-evict-runbook
[FD-16]: DECISIONS.md#fd-16-the-proxied-option-for-after-launch
[FD-17]: DECISIONS.md#fd-17-static-files-on-cloudflare-assets-only-deployments
[FD-18]: DECISIONS.md#fd-18-one-host-per-app-api-through-a-no-worker-route-to-the-tunnel
[FD-19]: DECISIONS.md#fd-19-building-and-uploading-the-static-files
[FW-01]: DECISIONS.md#fw-01-the-web-framework-for-the-console-fin-admin-and-verify
[FW-03]: DECISIONS.md#fw-03-verifys-documents-cached-at-the-edge-on-a-trigger
[G-01]: DECISIONS.md#g-01-the-scope-is-the-owners-requirements-of-21-nov
[G-02]: DECISIONS.md#g-02-a-new-public-repository-plan-first
[G-03]: DECISIONS.md#g-03-the-repositorys-licence
[G-04]: DECISIONS.md#g-04-from-scratch-from-specifications
[G-05]: DECISIONS.md#g-05-staging-core-first-production-gates-after
[G-06]: DECISIONS.md#g-06-the-starting-dependency-set
[G-09]: DECISIONS.md#g-09-private-settings-stay-out-of-the-repository
[G-10]: DECISIONS.md#g-10-what-agents-may-do-without-asking
[KY-01]: DECISIONS.md#ky-01-a-provider-port-with-a-sandbox-provider
[KY-02]: DECISIONS.md#ky-02-inbound-events-first-polling-as-the-backstop
[KY-13]: DECISIONS.md#ky-13-what-everything-sumsub-covers-means-for-sunday
[MO-01]: DECISIONS.md#mo-01-the-provider-adapter
[MO-02]: DECISIONS.md#mo-02-fins-ledger-holds-and-reconciliation
[MO-05]: DECISIONS.md#mo-05-routing-by-mode
[MO-06]: DECISIONS.md#mo-06-the-payments-service
[MO-23]: DECISIONS.md#mo-23-the-status-sweep-backs-off
[OB-01]: DECISIONS.md#ob-01-better-stack-replaces-grafana-and-sentry
[OB-03]: DECISIONS.md#ob-03-fins-own-log-transport
[OB-04]: DECISIONS.md#ob-04-a-thin-error-client
[OB-05]: DECISIONS.md#ob-05-monitoring-as-code
[OB-09]: DECISIONS.md#ob-09-a-public-status-page
[OB-11]: DECISIONS.md#ob-11-the-watcher-and-its-tokens
[OB-13]: DECISIONS.md#ob-13-private-operating-details
[OB-17]: DECISIONS.md#ob-17-the-daily-canary-and-the-weekly-test-page
[OB-18]: DECISIONS.md#ob-18-the-watchers-form-under-the-portability-rule
[P-01]: DECISIONS.md#p-01-railway-for-all-compute-and-the-database
[P-02]: DECISIONS.md#p-02-what-stays-off-railway
[P-03]: DECISIONS.md#p-03-railway-workspaces-and-environments
[P-04]: DECISIONS.md#p-04-region
[P-05]: DECISIONS.md#p-05-runtime-node-26-lts
[P-06]: DECISIONS.md#p-06-pnpm-12
[P-07]: DECISIONS.md#p-07-the-service-topology
[P-08]: DECISIONS.md#p-08-images
[P-09]: DECISIONS.md#p-09-postgres-on-railway
[P-11]: DECISIONS.md#p-11-the-queue-and-jobs-in-postgres
[P-13]: DECISIONS.md#p-13-railway-configuration-through-pnpm-fin
[RV-01]: DECISIONS.md#rv-01-reviews-before-fin-review-runs-and-after
[RV-02]: DECISIONS.md#rv-02-fin-review-v2
[RV-03]: DECISIONS.md#rv-03-model-and-effort-options
[RV-06]: DECISIONS.md#rv-06-the-effort-floor-at-the-gate
[RV-07]: DECISIONS.md#rv-07-switching-the-attack-pass-off
[RV-12]: DECISIONS.md#rv-12-when-per-commit-review-runs
[RV-13]: DECISIONS.md#rv-13-review-spend-the-nightly-sweep-and-cold-runs
[RV-19]: DECISIONS.md#rv-19-each-session-runs-the-model-it-says
[RV-20]: DECISIONS.md#rv-20-catching-up-with-main-merge-batches-and-capacity
[SA-01]: DECISIONS.md#sa-01-better-auth-for-both-realms
[SA-02]: DECISIONS.md#sa-02-better-auth-versions
[SA-03]: DECISIONS.md#sa-03-passkeys-first
[SA-04]: DECISIONS.md#sa-04-a-mandatory-second-factor-for-every-staff-member
[SA-05]: DECISIONS.md#sa-05-a-mandatory-second-factor-for-privileged-dashboard-roles
[SA-10]: DECISIONS.md#sa-10-fin-owns-organisations-and-roles
[SA-11]: DECISIONS.md#sa-11-the-dashboards-permission-catalogue
[SA-12]: DECISIONS.md#sa-12-fin-admins-permission-catalogue-and-prebuilt-roles
[SA-14]: DECISIONS.md#sa-14-resetting-a-staff-members-factors
[SA-22]: DECISIONS.md#sa-22-secrets
[SA-25]: DECISIONS.md#sa-25-an-interim-style-exception-for-the-design-system
[SA-26]: DECISIONS.md#sa-26-sumsubs-selfie-page
[SA-29]: DECISIONS.md#sa-29-staff-enrolment-codes
[SA-37]: DECISIONS.md#sa-37-hosted-links-and-the-selfie-host
[SA-43]: DECISIONS.md#sa-43-cookies-host-only-the-session-strict-the-rest-lax
[SA-44]: DECISIONS.md#sa-44-csrf-the-layers-on-every-unsafe-request
[SA-45]: DECISIONS.md#sa-45-the-page-policy-from-a-static-_headers-file
[UI-01]: DECISIONS.md#ui-01-vendoring-the-design-systems-private-source-into-the-public-repository
[UI-02]: DECISIONS.md#ui-02-the-canvases-as-the-ui-source
[UI-05]: DECISIONS.md#ui-05-theme-and-sidebar-in-cookies
[UI-06]: DECISIONS.md#ui-06-the-canvas-sources-under-version-control
[UI-09]: DECISIONS.md#ui-09-sidebar-option-a
[UI-10]: DECISIONS.md#ui-10-the-ui-sdk-as-the-base-of-packagesui
[UI-11]: DECISIONS.md#ui-11-the-sidebars-edge-toggle
[UI-12]: DECISIONS.md#ui-12-the-ported-design-layer-in-a-public-repository
[UI-13]: DECISIONS.md#ui-13-theme-and-sidebar-choice-in-the-browser
<!-- decision-links:end -->
