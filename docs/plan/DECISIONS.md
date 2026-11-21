# fin-next: decision register

Status: the register for the owner, Saturday 21 Nov 2026. It was revised the same day after the
critics' review (appendix A), and again to take in the decisions the owner made overnight, between
about 02:40 and 03:50 on 21 Nov (the table "The owner's decisions of 21 Nov 2026, overnight" and
appendix B). It is the only register: ARCHITECTURE.md and EXECUTION.md cite these IDs in square
brackets, and EXECUTION.md's "needed by" table keys on them. It lives at `docs/plan/DECISIONS.md`
and is committed with them before any code (R13). The repository is public: nothing here names a
credential, an account, workspace, zone or tunnel ID, an internal address, a staff address, a zone
name, a local path or a real person.

## How to read it

- **IDs** have an area prefix: `G` governance, `P` platform and runtime, `FD` front door, `DA` data,
  `SA` security and auth, `AU` audit, `EM` email, `OB` observability, `CI` CI/CD, `RV` review
  (fin-review), `MO` money and providers, `KY` onboarding (KYC and KYB), `AP` public API and docs,
  `UI` screens and the design system, `FW` the web framework, `OP` operations, `BC` behaviour carried
  or changed from the old product. "Was Dnn" names the 19 Nov decision a row carries; §17 maps every
  19 Nov decision. `CF-nn` is a critic finding (appendix A).
- **Other IDs used here.**
  - `PG-nn` is a production gate, PG-01 to PG-14, kept in EXECUTION §7.3. The `G` prefix belongs to
    governance alone. No gate uses it: EXECUTION's gates were renamed from `G-` to `PG-` so that
    [G-01] to [G-10] mean one thing everywhere.
  - `SP-nn` is a spike (ARCHITECTURE §11.11).
  - `FW-Cnn`, `FW-Snn` and `FW-Xnn` are the framework verdict's conditions, spikes and reversal
    triggers (ARCHITECTURE §3.4).
  - `R1` to `R16` are the owner's requirements of 21 Nov ([G-01]).
  - `SF-nn` is a specification's decision settled in this register before the first commit, either
    folded into the entry it changes or not adopted (appendix C). The plan's one order of precedence
    is in README §8.3: the owner's decisions of 21 Nov, then this register, then the specification
    that owns the area, then ARCHITECTURE.md, then EXECUTION.md.
- **Status** is one of:
  - **DECIDED (owner, 21 Nov 2026, about hh:mm)**: a decision the owner made overnight on 21 Nov.
    The block quotes it in a line headed "The owner's decision".
  - **Decided by the owner**, with the date and source: an earlier answer.
  - **Recommended**: the architect's call, which the owner may overturn at any time.
  - **OWNER MUST DECIDE**.
  - **Superseded** or **Withdrawn**: kept for traceability, with what replaced it.

  A block can mix them, for example an owner's decision built out with recommended details. Its
  status line then says which part is which.
- **Times.** The owner's overnight decisions carry the build's local time, given without a time zone,
  as EXECUTION gives build times ([G-09], [OB-13]). Registry and release times are UTC.
- **Deadline** is the latest point the answer is needed: **before Saturday's start** (one sitting at
  08:00 on Saturday), **Saturday** (by a stated time), **Sunday**, **Monday**, **Tuesday 24 Nov** (the
  start of hardening), or **production** (before production holds real data or moves real money,
  checked at the gates PG-01 to PG-14).
- **If an owner decision is not answered by its deadline, builders proceed on the default**; for the
  08:00 sitting, the defaults apply at 09:00. A later answer changes the code through a reviewed pull
  request. The exceptions are marked **blocking**: work that depends on them waits. The short list
  below names the few that truly block Saturday's start.
- **Counts:** 274 decisions.
  - 58 are decided, by the owner or on the owner's delegation. 20 of them cite one of the owner's
    overnight decisions of 21 Nov in their status. 14 of those became decided overnight: [G-04] (its
    confirmation), [P-02], [FW-01], [FD-11], [FD-13], [FD-14], [FD-15], [FD-17], [FD-18], [SA-43],
    [SA-44], [SA-45], [UI-10] and [UI-11]. The other six were decided before and are confirmed or
    amended: [P-03], [FD-01], [FD-16], [SA-26], [AP-10] and [UI-09].
  - 120 are recommended.
  - 91 are for the owner, some of them confirming or completing an earlier answer:
    - 33 before Saturday's start, 9 of them on the short list;
    - 5 on Saturday;
    - 13 on Sunday;
    - 9 on Monday;
    - 5 by Tuesday 24 Nov;
    - 29 before production (three of them also have a Saturday part: [FD-05], [OB-11], [RV-13];
      [FD-19]'s staging part is recommended).
  - 5 are superseded or withdrawn ([SA-25], [FD-02], [UI-01], [UI-05], [FW-03]).

  Each block below gives the decision, the default, the alternatives, the rationale, the status and
  the deadline. "Carried" means a 19 Nov answer that still holds.

## Requirements and where they are decided

| Requirement | Decisions |
|---|---|
| R1 Production-ready, from scratch, in a new repository | [G-01], [G-02], [G-04], [G-05]; the production gates PG-01 to PG-14 |
| R2 Everything on Railway, including the database | [P-01], [P-02], [P-09], [OB-18] |
| R3 Cloudflare Email Sending | [EM-01] to [EM-08] |
| R4 Cloudflare in front of Railway | [FD-01], [FD-13] to [FD-19] |
| R5 Better Stack replaces Grafana and Sentry | [OB-01] to [OB-17] |
| R6 Auth with roles for the dashboard and Fin Admin (Saturday 21 Nov) | [SA-04], [SA-05], [SA-11] to [SA-14], [SA-29], [SA-43], [SA-44] |
| R7 Customer and business onboarding, and go-live, with Sumsub (Sunday 22 Nov) | [KY-01] to [KY-13], [SA-26], [SA-37] |
| R8 Providers behind an adapter, MassPay first (Monday 23 Nov) | [MO-01] to [MO-23] |
| R9 Everything completely audited | [AU-01] to [AU-09] |
| R10 fin-review: quality, bugs and performance, per commit and merge, fast, and a faster CI | [RV-01], [RV-02], [RV-12], [RV-20], [CI-02] |
| R11 Selectable model and effort, with a separate attack pass | [RV-03], [RV-06], [RV-07], [RV-19] |
| R12 The public repository `aktharazif/fin-next` | [G-02], [G-03], [G-09], [CI-01], [CI-08], [CI-15], [UI-12] |
| R13 The plan first, saved in the repository | [G-02]; this file |
| R14 The new designs | [UI-02], [UI-09] to [UI-13] |
| R15 Bun or Node, checked | [P-05], [CI-10] |
| R16 The public API, and a docs site with Try it on Sandbox keys | [AP-01] to [AP-20], [FD-18] |

## The owner's decisions of 21 Nov 2026, overnight

The owner made these while the plan was being written. They override anything earlier that
disagrees, in this file and in the research behind it. Each is recorded, with the owner's words, in
the blocks named.

| Time | The owner's decision, in short | Recorded in | What it replaces |
|---|---|---|---|
| about 02:40 | Cloudflare Tunnels for **all** hosts, the public ones and Fin Admin (behind Access, with a token check on every request); no Railway public domain and no TCP proxy; one public and one admin tunnel, each token only in its own connector service's sealed variables; connectors watched every minute, alerting on any connector that is not from Railway's egress or does not match the expected count and version; an evict runbook that deletes and recreates the tunnel; Cloudflare's headers trusted only from the connector peers; the proxied DNS and Railway Edge Rules design kept as an option after launch; the on-demand database tunnel as researched | [FD-01], [FD-11], [FD-13], [FD-14], [FD-15], [FD-16], [P-03] | The first draft's proxied front door |
| about 03:00 | The single-page app (Shape B) stays. Hono stays, but only as the API and auth server on Railway, reached through the tunnels | [FW-01] | Each app's Hono process serving its own files and a templated document; FW-Q1 |
| about 03:00 | The console, Fin Admin, verify and the docs built to static files and served by Cloudflare, with `index.html` no-cache and hashed assets immutable; security headers from a static `_headers` file per app (`script-src 'self'` with no inline script, the style policy the framework verdict allows with FW-X7's fallback, verify's selfie keeping its Sumsub exception); nothing that cannot move to another static host ("we can use anything from cf that we can easily migrate. no vendor locked in items like workers"); GitHub Actions builds and uploads with a pinned CLI; builds hold no secrets | [FD-17], [FD-19], [SA-45], [P-02], [OB-18] | Its hosting on Pages was superseded at about 03:50 |
| about 03:00, superseded about 03:50 | Hosting on Cloudflare Pages; each app's API on a host of its own (`console-api.<zone>`), cross-origin on the same site with CORS and credentials; pull-request previews public, Fin Admin's behind Access or off | [FD-17], [FD-18] | The per-app API hosts are now [FD-18]'s fallback; previews are off |
| about 03:10, superseded about 03:50 | One origin per app through Origin Rules: `/api/*` sent to the tunnel by a DNS-record override | [FD-18] | Superseded: the override is Enterprise-only. Its cookie, CSRF, spike and Try it parts hold, in [SA-43], [SA-44], [FD-18] and [AP-10] |
| about 03:25 | The apps' UI is built on the UI SDK (vercel-labs/ui: `@ui-sdk/react` and `@ui-sdk/core`). fin-next's `packages/ui` implements the Fin design system on it; only the design system's token values and specifications are used; the old product's redesign branch is a reviewed starting point, ported through fin-review | [UI-10], [UI-12], [G-04], [G-06] | [UI-01]'s vendoring of the design system's private, Radix-based source |
| about 03:25 | The sidebar's collapse control is an edge toggle: a small round chevron on the sidebar's right edge near the top, always visible. The logo is a plain 24px mark linking Home, with no hover swap. Canvases now, code later | [UI-11] | Round 2's brand-cell hover swap ([UI-09]) |
| about 03:50 | Each app's static build served by an assets-only Workers static assets deployment with no script. Per app host, a Workers route to it and a no-Worker route for `/api/*` that falls through to the tunnel, whose ingress matches the host and `^/api/`; Fin Admin the same on the admin tunnel, with Access over the whole host. No CORS between an app and its API. Host-only `__Host-` cookies, the session Strict and every other auth cookie Lax. CSRF by an exact Origin check, `Sec-Fetch-Site`, the `X-Fin-App` header and JSON-only bodies, under Better Auth's origin check with exact trusted origins. No code runs at Cloudflare. The spike first thing on Saturday, with per-app API hosts as the fallback. The docs assets-only too; `api.<zone>` straight to the tunnel; Try it cross-origin, without credentials, Sandbox keys only | [FD-17], [FD-18], [FD-13], [FD-05], [SA-43], [SA-44], [AP-10] | The 03:10 Origin Rules routing; the 03:00 Pages hosting; FW-C09's all-`Lax` cookies; [UI-05]'s cookies; the parts of FW-C02 to FW-C06, FW-C10, FW-C13 and FW-C16 that served files from Railway ([FW-01]) |

## Owner decisions, by deadline

### Before Saturday's start: the short list

These nine truly block the start: work waits for them, the owner must act before the first lane can
begin, or Phase 0's first lanes build on them. Each has a default. The two marked **blocking** hold
work back until they are answered; the others take their default at 09:00.

| # | ID | Question | Default | Why it is on the short list |
|---|---|---|---|---|
| 1 | G-06 | Approve the starting dependency set, amended overnight | Approve the set in [G-06]: the UI SDK in place of Radix, Phosphor, `clsx` and `tailwind-merge`, at the newest exact beta cleared when the install runs: 0.1.0-beta.9 at P0-4 (09:00 to 10:00 build time, 03:30 to 04:30 UTC; cleared at 03:02 UTC), or 0.1.0-beta.10 if the install runs after 09:47 UTC; then 0.1.0-beta.13 after 12:24 UTC on Sunday, in its own pull request. No exception; `wrangler` pinned in `tools/static-deploy` | **Blocking**: nothing is installed without it |
| 2 | UI-12 | May the ported design layer, part of whose text comes from the design system's private source, the logo's paths, and the verbatim copies of `fin-motion.css`, the export's token file and its font files be public? | Yes, with private-document references and sample domains stripped and the notices extended | **Blocking** for the design-layer port, and so for every screen |
| 3 | FD-09 | The staging zone | A new staging zone in a new Cloudflare account; fallback `-next` names on the shared zone | The owner makes the zone and the account; SP-25 and the tunnels need them in the first hour |
| 4 | OB-18 | May the watcher stay a Cloudflare Worker under "no vendor locked in items like workers"? | Yes: portable `fetch` code on a minute cron, with no Workers-only binding. This departs from the owner's 03:00 words. The non-Worker alternative is the same code on a small virtual machine at another provider, outside Railway, on a minute timer: the smallest instance costs a few US dollars a month per environment (UNVERIFIED; the steward prints the price at the sitting), plus one more vendor account and an operating system to patch. Better Stack's own monitors alone need no new host, but they cannot read Cloudflare's or Railway's configuration, so the connector and static-deployment checks would go | Phase 0 builds the watcher before the first staging deploy |
| 5 | SA-05 | A mandatory second factor for privileged dashboard roles, checked per request across organisations (R6) | Yes | Saturday's first identity lane builds it |
| 6 | SA-12 | Fin Admin's permission catalogue and prebuilt roles (R6) | 26 permissions; Viewer, Compliance, Operator, Admin; custom roles | The staff realm and its first migration build it on Saturday |
| 7 | AU-01 | What R9 covers for reads | Audit every reveal of personal data, documents or bank numbers; list reads are log lines | The audit allowlists are in the first migrations |
| 8 | G-10 | What agents may do without asking | The steward merges green pull requests with signed receipts in batches; never control paths, plausible highs, dependencies, staging deploys or production | It sets how every merge runs from the first hour |
| 9 | CI-14 | Control paths need the owner's code-owner approval and typed confirmation | Control paths only, now including each app's `_headers` and static deployment settings; other tier S paths rely on signed receipts | CODEOWNERS and the ruleset are set in Phase 0's first hour |

**Two defaults depart from the owner's literal words.** The owner sees both at the sitting:

- [OB-18] (row 4) keeps the watcher a Worker, although the owner's 03:00 words were "no vendor
  locked in items like workers". Row 4 and the block give the non-Worker alternative and its cost.
- [FD-19] reads the owner's "GitHub Actions builds, then uploads" as covering staging. In production,
  the plan has the operator's launcher upload the exact `dist/` that passed staging, so GitHub holds
  no production credential ([CI-04]). That reading is not assumed: the production upload is a
  question for the owner, listed under Production below. Nothing before production waits on it.

### Before Saturday's start: also at the sitting (defaults at 09:00; nothing waits)

| ID | Question | Default |
|---|---|---|
| G-03 | The repository's licence | No open-source licence; "all rights reserved"; the ported design layer under its own notice ([UI-12]) |
| G-07 | Keep the Flow Atlas and the canvas-mirroring duties | Keep both; publish the atlas after production |
| SA-06 | Keep passwords in the dashboard | Keep them (the designs draw them) |
| SA-14 | How a staff member who lost every factor gets back in | An Admin-only `staff.reset_factors` with an intent and a new enrolment code |
| SA-18 | Keep `sk` and `rk` in API keys (the canvas draws keys without them) | Keep them |
| SA-20 | The longest roll overlap for an API key | 24 hours (drop the old 7-day option) |
| SA-30 | Developer account recovery and email changes | Recovery by another Super admin or by staff with `accounts.recover`, a 72-hour wait and notices; email change blocked |
| CI-03 | Railway deploys to staging from CI, approved by the owner's account in batches at checkpoints (the static uploads are already from Actions, [FD-19]) | Yes; otherwise the operator deploys staging |
| CI-06 | GitHub Pro (40 concurrent jobs) | Pro from Saturday |
| CI-08 | Outside contributions and Issues | Fork pull requests need approval and get no AI review; Issues and Discussions off; interaction limits |
| RV-06 | The effort floor the gate accepts | Lenses `xhigh` on tier S, `high` elsewhere; the attack pass and second sceptic `high`. This narrows R11 on tier S: a gating run there refuses `--effort high` (advisory only), unless the owner picks `high` everywhere |
| RV-07 | May the attack pass be turned off | No |
| RV-12 | Review every push, drafts included | Yes; the gate then covers only what commit reviews did not |
| KY-13 | What "everything Sumsub covers" means for Sunday, with KY-05 and KY-06 | Today's product plus Sumsub's ongoing signals as Fin Admin flags (a stretch lane); monitoring queues and re-screening recorded as left out |
| KY-05 | How a developer's company is reviewed for go-live | Staff review with every person verified; Sumsub's API-driven level when it exists |
| KY-06 | Owner companies on a Production request | Send them to Sumsub as company beneficiaries (Sunday stretch 1) |
| AP-01 | The API path major | `/v4` |
| UI-03 | A design-system batch before Saturday, or marked pending compositions | Pending compositions, upstreamed after |
| UI-04 | Who draws the missing boards, and whether they must exist before code | Builders compose from primitives, marked pending; boards follow the same day |
| UI-06 | Put the canvas sources under version control | A private design repository |
| FW-04 | The first-load budgets | Verify 150 KB gzip and p75 LCP 2.5 s; console 250 KB gzip |
| BC-01 | Keep every step-up the old product asked for | Yes |
| BC-03 | Address and device on every console and Fin Admin audit row | Yes |
| BC-06 | At most 10 organisations as Super admin per person | Keep |

**Closed overnight.** Decided: [G-04] (the from-scratch rule, with the owner's one exception),
[P-02] (Cloudflare pieces that move easily are allowed), [FW-01] (Shape B) and [FD-14] (two
tunnels). Withdrawn: [FW-03]. Superseded: [UI-01], whose open part is now [UI-12]. New for the
owner: [UI-12] and [OB-18].

### Saturday

| ID | Question | Default | By |
|---|---|---|---|
| OB-11 | The staging watcher's read-only tokens (Cloudflare, vault, GitHub, Railway if SP-21 passes) | As listed; Railway checked by `pnpm fin verify` until a read-only credential exists | 12:00 |
| RV-13 | Provisional review spend caps | Caps per pull request, day and month, revised after ten runs; a cap reached blocks | 13:00 |
| BC-05 | Keep an API key's "last used" | Keep, rounded to the minute | 18:00 (with API keys) |
| KY-09 | The hosted verify pages' design source | New boards on `AuthLayout`, drawn Saturday evening | 18:00 |
| FD-05 | The staging Access identity provider | Google Workspace with 2-Step Verification before provider credentials reach staging | 22:00 |

### Sunday

| ID | Question | Default |
|---|---|---|
| SA-27 | A standing fast path past the three-day release age for security releases (Better Auth, TanStack Router, Hono, Vite, React) | Yes, one exact-version exception per release |
| SA-39 | Staff insider controls | Reveal budgets per person; a second approver for go-live and restoring access once a second staff member exists |
| KY-07 | May a developer restart a final rejection | No; staff may allow it; retry rejections 3 a day |
| KY-11 | Does a business wait for its people before approval | Yes |
| AP-04 | Idempotency: which POSTs require a key, how long keys live, and secret-bearing answers | Money required; all POST and DELETE accept; 24 hours sealed; money keys permanent; no secret stored |
| AP-07 | Webhook changes | `timestamp`, 15 s, 410 disables, 15 tries, https on 443 or 8443 with a challenge, a cap per target host |
| AP-08 | Confirm Fin's own webhook delivery | Yes |
| AP-16 | Add `POST /v4/sandbox/reset` | Yes |
| UI-08 | The API keeps `test` and `live` words while screens say Sandbox and Production | Yes |
| FW-02 | Must verify work without JavaScript | No (a yes would also need a server for verify's documents, which [FD-17] does not have) |
| BC-02 | Restore webhook analytics | Yes, in H-02 |
| BC-04 | Fifteen delivery tries | Yes, over about 3 days |
| BC-07 | Refuse deleting an organisation or customer that holds money | Yes, widened from the old rule |

### Monday

| ID | Question | Default |
|---|---|---|
| DA-12 | Organisation deletion keeps money and audit records for the retention period | Yes, with personal fields blanked |
| MO-03 | Seal full beneficiary account numbers in Fin (reverses 20 Nov) | Yes |
| MO-04 | Seal the Fedwire identification type and number (reverses 20 Nov) | Yes |
| MO-05 | Sandbox mode on the Fin simulator; live mode on MassPay (reverses 20 Nov) | Yes |
| MO-08 | `amount` and `currency` instead of `amount_cents` | Yes |
| MO-13 | Fin Admin's money views and actions | Views built from design-system patterns, plus retry, close and resolve-a-break with an intent; no staff payouts |
| MO-16 | A fee quote route, `POST /v4/transfers/quote` | Yes; drop `quotes:write` |
| AP-11 | The Scalar reference page as a recorded exception to the `@fin/ui` rule and to the page policy (`style-src 'unsafe-inline'` and `img-src data:` in the docs profile alone) | Yes; the policy part is **blocking** for uploading `/reference` |
| AP-12 | Draw a docs board first, or theme Scalar from tokens | Theme from tokens; no board |

### Tuesday 24 Nov

| ID | Question | Default |
|---|---|---|
| RV-04 | fin-review in CI as the authoritative gate | Yes, from H-03; signed local receipts until then |
| RV-05 | The CI credential for model calls | Workload Identity Federation bound to the reusable review workflow at `main` |
| RV-09 | Where sealed findings' key lives; whether non-security findings may be public | An `age` key held by the owner offline; everything sealed, counts public |
| RV-11 | The Claude Agent SDK as a dependency of `tools/fin-review` (CI runner) | Yes (proprietary licence, large binary) |
| FD-10 | The production zones and the docs domain | Three registrable domains: main, admin, pages; chosen early for the email warm-up |

### Production

Each is checked at the production gates PG-01 to PG-14 (EXECUTION §7.3).

| ID | Question | Default |
|---|---|---|
| P-10 | Synchronous replication on production's HA Postgres | Yes, not strict |
| P-14 | Recovery targets (D21) | RPO about 1 minute and RTO 2 hours inside Railway; about 1 hour (high-value schemas) and 24 hours after losing Railway; UNVERIFIED until measured |
| FD-03 | Plain http on `api.` | Refuse, revoke a live key seen in clear, email the organisation |
| FD-04 | Cloudflare plans | Staging Free; production main and hosted zones Pro, admin zone Free |
| FD-05 | Access MFA methods for Fin Admin | Security keys and biometrics only; AMR matching off |
| FD-06 | Turnstile on the email-sending and password forms | Yes, with a page-policy exception on those pages |
| FD-08 | Logpush of zone logs to Better Stack | Yes, fields allowlisted, verify and invitation paths redacted; no Access logs |
| FD-19 | Who uploads production's static files, given the owner's "GitHub Actions builds, then uploads" | The operator's launcher, by content hash, with a token at the secure prompt, so GitHub holds no production credential ([CI-04]); the other answer is an Actions job in a `production` environment that the owner's account approves |
| DA-08 | Retention periods and the processor or controller question (D18) | The table in ARCHITECTURE §6.8, subject to counsel |
| DA-10 | Hardware keys for production escrow (D32) | Two hardware keys and a sealed printed copy |
| DA-11 | What the vault keeps in clear (D39) | Only ID-only records the checks read |
| SA-21 | GitHub's secret scanning partner programme | Join; the edge verifies, `api` revokes by key ID |
| AU-03 | Write-once audit heads in R2 with an Indefinite lock (D10) | Yes |
| AU-05 | Better Stack's audit-log add-on | No at launch; the daily canary and drift check instead |
| AU-06 | Where the Railway audit-log export runs | Weekly from the operator's machine; daily once a narrow credential exists |
| EM-02 | Written acceptance of Email Sending's beta terms and its token scope | (the owner's signature) |
| EM-03 | A cold-standby second email sender | Decide between a built, switchable second adapter and a written acceptance |
| OB-06 | On-call responders | No single responder without automatic containment, a 15-minute target and a written acceptance; weekly test page |
| OB-07 | Log retention | 30 days staging, 90 days production |
| OB-09 | A public status page at launch | Yes |
| OB-10 | Coding agents reading Better Stack | No standing token |
| OB-11 | The production watch account and its Railway user | A separate watch account; read-only tokens; a Viewer-only Railway user if SP-21 passes |
| OB-12 | A production Playwright journey monitor | Yes, every 15 minutes, read-only canary account |
| CI-17 | The staging soak before production | 24 hours with the release smoke passed |
| RV-13 | The nightly sweep's budget and the cold-run cadence | A nightly budget, a 10% cold sample, a cold full run before production and after model changes |
| MO-19 | Value caps, a second approver, a first-payout delay | Caps per organisation, customer and beneficiary; thresholds set before live money |
| AP-19 | The deprecation notice | 12 months |
| OP-04 | Losing Railway: the target and who decides | A fresh Railway workspace in another region, else a VM; the owner decides after 4 hours down with no estimate |
| OP-08 | Service objectives and launch capacity | Set by the owner; numbers in the private overlay |

## 1. Governance

### G-01 The scope is the owner's requirements of 21 Nov
- **Decision:** R1 to R16 are the scope: production-ready code from scratch in a new repository;
  Railway for everything including the database; Cloudflare Email Sending; a Cloudflare proxy in
  front; Better Stack for all monitoring; auth with roles on Saturday, onboarding and go-live on
  Sunday, provider integration on Monday; everything audited; fin-review; a public repository; the
  plan first; the new designs; Bun or Node checked; the public API and docs.
- **Default:** as stated. What each requirement looks like at staging-complete, full or partial, is
  recorded in EXECUTION §0.2 and carried in the end-of-day report. A requirement left partial is a
  recorded decision with the item that completes it, never something left unsaid (R7's reading is
  [KY-13]).
- **Alternatives:** none; this is the brief.
- **Rationale:** the owner's words of 21 Nov. They supersede the 19 Nov phase order (D1).
- **Status:** Decided by the owner, 21 Nov 2026 · **Deadline:** decided

### G-02 A new public repository, plan first
- **Decision:** fin-next lives in the public repository `aktharazif/fin-next` on the owner's personal
  account; the plan (this register and ARCHITECTURE.md) is committed before code.
- **Default:** as stated.
- **Alternatives:** the old private organisation repository; a private fin-next (both superseded).
- **Rationale:** R1, R12 (unlimited CI minutes), R13. Supersedes D40.
- **Status:** Decided by the owner, 21 Nov 2026 · **Deadline:** decided

### G-03 The repository's licence
- **Decision:** what licence a public repository carries.
- **Default:** no open-source licence: a `LICENSE` saying all rights are reserved and the source is
  public for review and CI; the design layer ported from the old product under its own notice, with
  the third-party icon, flag and font notices it carries ([UI-12]); Fin's name, logo and other brand
  assets reserved.
- **Alternatives:** MIT or Apache-2.0 for the code with brand assets excluded; a source-available
  licence.
- **Rationale:** the repository is public for CI (R12), not as an open-source decision; adding an open
  licence later is easy, withdrawing one is not.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start. The first commit carries the
  default in words: the root `README.md` says all rights are reserved. The `LICENSE` file follows with
  Phase 0's root files (EXECUTION §2.2; spec 01 §3.8)

### G-04 From scratch, from specifications
- **Decision:** no code is copied from the old product, with one exception the owner made on 21 Nov:
  the design layer (the design system's tokens and components, rebuilt on the UI SDK on the old
  product's redesign branch) is ported as fin-next's `packages/ui` and reviewed by fin-review as new
  code ([UI-10], [UI-12]). For everything else, builders work from the specifications, designs and
  decisions only; writers of specifications may read the old code. A similarity check against the old
  tree runs at the ship step on the owner's machine, never in public CI (the old repository is
  private, so a CI check would need a token to it or print its code into public logs). It skips the
  ported files that the port's notice lists, and flags anything else.
- **Default:** as stated. The draft's EQ-14 ("builders may read the old code, with a CI similarity
  check") is withdrawn in favour of this rule.
- **Alternatives:** let builders read the old code (faster, but copies creep in and R1 says "from
  scratch"); if the owner chooses it, the copy check still stays local at the ship step.
- **Rationale:** the owner's "everything in fin-next is new" and "builders from specs only, with a copy
  check" (19 Nov), re-read under R1. The owner's 03:25 decision names the one reviewed starting point.
- **Status:** Decided by the owner, 19 Nov 2026; the exception DECIDED (owner, 21 Nov 2026, about
  03:25: the redesign branch "is a reviewed starting point to port through fin-review"). The
  confirmation under R1 that was asked for at the 08:00 sitting is closed: the 03:25 decision applies
  the rule and makes one exception to it · **Deadline:** decided

### G-05 Staging core first, production gates after
- **Decision:** each day's features are complete on staging, which carries the whole security core;
  production adds the gates in ARCHITECTURE §11.10, which EXECUTION §7.3 tracks as PG-01 to PG-14;
  none is assumed.
- **Default:** as stated.
- **Alternatives:** full production hardening before any feature (does not fit three days).
- **Rationale:** the only honest way to square "production-ready" (R1) with a three-day build.
- **Status:** Decided by the owner, 19 Nov 2026 (was D44), carried · **Deadline:** decided

### G-06 The starting dependency set
- **Decision:** approve the packages fin-next starts with as one set, each with its registry facts
  printed by the steward before the sitting and recorded in its pull request, installed in a few
  grouped pull requests by layer as a written one-time exception to "one dependency change per pull
  request":
  - toolchain: TypeScript 7.0.2, Biome 2.6.8, Turborepo 2.11.11 (2.11.13 once it clears), Vitest
    5.1.0 (5.1.1 once it clears), `@playwright/test` 1.65.1, `@types/node` 26.6.6;
  - server: `hono` 4.13.19, `@hono/node-server` 2.1.9 (2.1.11 once it clears), `pg` 8.23.1,
    `drizzle-orm` 0.45.4 with `drizzle-kit` 0.31.11 (drafts only, outside the repository), `zod`
    4.6.7, `@hono/zod-openapi` 1.6.3;
  - errors: `@sentry/core` and `@sentry/react` 11.14.0 (11.16.0 once it clears), `@sentry/vite-plugin`;
  - web apps: `react` and `react-dom` 19.3.1, `@tanstack/react-router` 1.170.46 with
    `@tanstack/router-plugin` 1.169.0, `vite` 8.3.8 with `@vitejs/plugin-react` 6.3.0, and
    `tailwindcss` 4.3.5 with its Vite plugin;
  - the UI SDK ([UI-10]): `@ui-sdk/react` and `@ui-sdk/core`, together at one exact version: the
    newest beta that has cleared the three-day release age when the install pull request runs. At
    P0-4 (09:00 to 10:00 build time, 03:30 to 04:30 UTC) that is 0.1.0-beta.9, cleared at 03:02 UTC
    on Saturday 21 Nov; if the install runs after 09:47 UTC, it is 0.1.0-beta.10. Then 0.1.0-beta.13
    in a dependency pull request of its own once it clears, after 12:24 UTC on Sunday 22 Nov. Both
    have no runtime dependency and no install script, are Apache-2.0 and are published with
    provenance; they have one npm maintainer.
    No font package: Inter's variable woff2 and Fira Mono 400 and 500 are committed as files from
    the team export, with their OFL notice, in `packages/tokens` (spec 01 S0-14), and the lockfile
    check refuses `@fontsource*`. No Radix, Phosphor, `clsx` or `tailwind-merge`: the ported layer
    carries its own icon path data and class merger, and a lint rule refuses those imports;
  - static deploys ([FD-19]): `wrangler` at one exact version that clears the release age, in
    `tools/static-deploy` only, never in an app or a server image. The steward prints the install
    scripts its dependencies bring (UNVERIFIED which; `workerd` and `esbuild` are the likely ones),
    and each needs the owner's yes before it gets an `allowBuilds` entry;
  - auth: `better-auth`, `@better-auth/core`, `@better-auth/passkey`, `@better-auth/drizzle-adapter`
    at 1.7.25, and `@simplewebauthn/browser` 13.3.0;
  - docs (Monday): `@scalar/api-reference` 1.78.1 exactly.
  The lockfile check refuses `@tanstack/react-start`, `@tanstack/start-*`, `@vitejs/plugin-rsc`,
  `react-server-dom-*` and `@rsbuild/core`, and requires `seroval` and `seroval-plugins` at 1.6.11
  or later. No phone-number library: phones are E.164 only.
- **Default:** approve. Licences outside MIT, ISC, BSD, Apache-2.0 and 0BSD are named: Sentry's new
  CLI (FSL-1.1-Apache-2.0, through the Vite plugin) and, in H-03, the Claude Agent SDK (proprietary;
  [RV-11]). The steward prints `wrangler`'s licence and its dependencies' with their registry facts.
- **Alternatives:**
  - one dependency per pull request (about 40 serial pull requests before the scaffold builds);
  - an exact-version exception for `@ui-sdk/*` 0.1.0-beta.13 on Saturday (published on 19 Nov at
    12:23 UTC with provenance), which saves one SDK upgrade; it needs the owner's yes and a dated
    comment, as AGENTS.md says.
- **Rationale:** a new repository cannot start without its base set; the registry checks and pnpm's
  policy still apply to every package. Starting on the newest beta that clears loosens no protection.
- **Status:** OWNER MUST DECIDE (**blocking**: nothing is installed without it). Spec 01's set
  without `wrangler` is not adopted (appendix C, SF-02) · **Deadline:** before Saturday's start

### G-07 The Flow Atlas and the design canvas
- **Decision:** whether fin-next keeps the old duties to chart every flow and update it with each
  change, and to mirror every screen change on the design canvas.
- **Default:** keep both. `docs/flows/atlas.json` and `flows:check` in `pnpm check`, with each alert,
  heartbeat and monitor naming its flow; the atlas is published only after production. Canvas
  mirroring stays a rule: a screen change updates its board, including dark and phone.
- **Alternatives:** drop the atlas; keep publishing it from `main` as the old product does.
- **Rationale:** alerts point at flows and the check is cheap; the rules files written in Phase 0 need
  the answer, so it moves from Sunday to the 08:00 sitting (it was EQ-30 in the draft).
- **Status:** OWNER MUST DECIDE (low) · **Deadline:** before Saturday's start

### G-08 AGENTS.md for fin-next
- **Decision:** fin-next's standing rules for coding agents.
- **Default:** carry the old rules, re-expressed for Node, Railway and Better Stack: process rules
  replace the Workers rules (principle 14); monitoring through Better Stack with the catalogue and
  `monitoring:check`; doors and signed calls; deploys only through `pnpm fin`; the dependency rules;
  the review rules of [RV-01] and [RV-02]; the builder identities and control paths of [CI-13] and
  [CI-14]. Rules phrased for "server functions" become rules for "Fin's own API routes" (FW-E6), for
  example "`stepUp` in `requireActor` for Fin's own API routes". The Workers rules become: no Fin code
  runs at Cloudflare except the watcher ([OB-18]), and the static deployments stay assets-only
  ([FD-17]).
- **Alternatives:** start from the superseded fin-next attempt's AGENTS.md (a good base for the
  monitoring section).
- **Rationale:** the rules encode years of the old product's lessons; only their platform words change.
- **Status:** Recommended · **Deadline:** before Saturday's start

### G-09 Private settings stay out of the repository
- **Decision:** what lives only in the private overlay given at the secure prompt, or only in the
  platforms themselves: the zone names (staging and production), the old product's repository and
  zone, the design system's private repository, the old product's redesign pull request reference
  and the port's source commit, the staff list, the Access team name and audience tags, account,
  workspace, team and tunnel IDs, Better Stack team and source IDs, seed inbox addresses, the
  on-call roster, its time zone, quiet hours and escalation timings, the time zone of the build
  clock and of the owner's decision times (the plan gives build-clock times, counted from Phase 0's
  08:00 start, or UTC, and never pairs the two), the threat model's private annex (spec 08 §2.5: the
  stated limits about responders and the pager, and when the owner is reachable), the private
  provider notes (what Fin observed of a provider's behaviour, fees and account terms; ARCHITECTURE
  §12.12, spec 04 MS-30), and every numeric alert threshold ([OB-13]). **Fin's own labels are
  public:** the names Fin gives its own objects (the Better Stack teams `fin-staging` and
  `fin-production` with their policies, schedules, sources and Errors applications, the Railway
  project, the CI review workspace, the vault buckets and the static deployments) appear in the plan
  and the code. Knowing one grants nothing; each object's ID stays private, and so does every name
  Fin does not choose (the zones, the Access team).
- **Default:** as stated; the public settings files name things, and `pnpm fin` resolves IDs at run
  time. Public keys (`age` recipients, the receipt-signing public keys, certificate pins) may sit in
  the public settings (they were EQ-26b in the draft). The public-safety check refuses the zone names,
  the old repository's name, the design system's private repository name, the redesign pull
  request's reference and the port's source commit (in full, or any prefix of 7 or more characters),
  all held in the overlay as its refuse list. It runs locally over `docs/plan/` before the first
  commit and on every push. The port's notice (`packages/ui/PORTED.md`) names fin-next and source
  paths only: the port check and the ship-step similarity check read the source commit from the
  overlay at run time. Before the plan is made public, the owner confirms, outside this repository,
  that the old product's staging is behind Access or on its dependencies' current security releases;
  the sitting's notes record it (spec 01 §3.1, step 0). The plan names nothing of the old product's
  deployment beyond what the cutover needs (EXECUTION §9).
- **Alternatives:** an encrypted file in the repository (still publishes ciphertext and its shape).
- **Rationale:** R12; the 19 Nov settings file held the staff list, the first draft named the real
  staging zone and the operator's habits, and a later draft named a second private repository, the
  port's source commit and details of the old product's deployment; a last pass before the first
  commit found time-zone labels, two stated limits that say when nobody is watching, and CR-21 calling
  Fin's own labels private while the plan used them (CF-36).
- **Status:** Recommended · **Deadline:** before Saturday's start

### G-10 What agents may do without asking
- **Decision:** the pre-approvals that let the build run through the day and night.
- **Default:**
  - The steward merges, in the fixed merge batches ([RV-20]), every pull request whose `gate` is green
    with a valid signed receipt, without asking each time.
  - Never covered: a control-path pull request ([CI-14]: the owner's approval and typed confirmation);
    a plausible critical or high finding (the owner judges it); a dependency change (the owner's yes);
    a staging deploy (the owner's account approves it at a checkpoint, [CI-03]); anything in
    production.
- **Alternatives:** the owner approves each merge.
- **Rationale:** the draft's EQ-29, recorded here as the one register asks; agents cannot approve
  deployments or control paths with the builder account anyway.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

## 2. Platform and runtime

### P-01 Railway for all compute and the database
- **Decision:** every service and the database run on Railway.
- **Default:** as stated.
- **Alternatives:** none under R2.
- **Rationale:** R2. Carries D2 (Railway Postgres).
- **Status:** Decided by the owner, 21 Nov 2026 · **Deadline:** decided

### P-02 What stays off Railway
- **Decision:** whether "everything on Railway" allows the deliberate off-Railway pieces.
- **The owner's decision (about 03:00):** "use cloudflare pages which saves speed and bandwidth. we
  can use anything from cf that we can easily migrate. no vendor locked in items like workers."
- **Default:** yes: compute (the tunnel connectors included) and the database on Railway; Cloudflare
  holds the front door (DNS, the tunnels' edge, WAF), the static builds ([FD-17]), Access, email, the
  R2 vault (backups, audit heads, escrow) and the watcher ([OB-18]); Better Stack the monitoring;
  Sumsub and MassPay their own services; GitHub the code, CI and images. Each Cloudflare piece must
  move easily: the static files are plain files, and the vault is reached through R2's S3 API.
  Request Railway's SOC 2 report, pen-test summary and DORA pack before production.
- **Alternatives:** backups and audit heads in Railway buckets (no object lock; deletable by one leaked
  Railway credential); the watcher on Railway (silenced by a Railway compromise).
- **Rationale:** recovery copies and witnesses must sit where a Railway compromise cannot reach them.
- **Status:** DECIDED (owner, 21 Nov 2026, about 03:00): Cloudflare pieces that move easily are
  allowed, and the static files are among them. The one piece of Fin code at Cloudflare, the watcher,
  is put to the owner as [OB-18] · **Deadline:** decided

### P-03 Railway workspaces and environments
- **Decision:** two Railway Pro workspaces (staging, production), each with one project and its default
  environment; production's admin roles as the private overlay lists, two-factor sign-in enforced; no
  PR environments; no public domains (generated or custom) and no TCP proxies on any service; no
  workspace SSH keys in production; staging starts with fresh data;
  "Railway VPC" means Railway's private networking.
- **Default:** as stated.
- **Alternatives:** one workspace with two environments (every Member reads production's variables on
  Pro; environment RBAC needs a 2,000 USD monthly commitment).
- **Rationale:** the access boundary on Pro is the workspace.
- **Status:** Decided by the owner, 19 Nov 2026 (was D6, D19, D20, D22), carried; "NO public domains
  and NO TCP proxies" reaffirmed 21 Nov 2026, about 02:40 · **Deadline:** decided

### P-04 Region
- **Decision:** every service in `us-east4-eqdc4a`, no multi-region.
- **Default:** as stated.
- **Alternatives:** `europe-west4-drams3a` for EU residency (only before the production database is
  created; a volume is locked to its region).
- **Rationale:** MassPay's API is US-hosted; one region keeps static egress addresses stable.
- **Status:** Decided by the owner, 19 Nov 2026 (old plan), carried; reopen only before the production
  database exists · **Deadline:** decided

### P-05 Runtime: Node 26 LTS
- **Decision:** Node.js 26.13.1 LTS for production, tests, scripts and CI; Bun only in a non-blocking CI
  canary job.
- **Default:** as stated.
- **Alternatives:** Bun as the runtime; Bun for installs, tests or scripts (all rejected in
  ARCHITECTURE §3.2).
- **Rationale:** Bun's heap cap, AsyncLocalStorage, OpenTelemetry and undici `dispatcher` gaps are still
  open; no backports; Node is LTS to April 2029; the speed gain is small for a network-bound service.
- **Status:** Decided by the owner, 19 Nov 2026 (was D17); re-checked for R15 on 21 Nov, holds ·
  **Deadline:** decided

### P-06 pnpm 12
- **Decision:** the package manager version.
- **Default:** pnpm 12.21.0 if SP-01 shows each supply-chain setting refusing as it should; otherwise
  pnpm 11.28.12 (supported to April 2027). Installed from the release tarball by checksum, never
  through Corepack or `npm i -g`.
- **Alternatives:** stay on 11 from the start.
- **Rationale:** pnpm 12 is a three-month-old rewrite enforcing the policy; prove it first.
- **Status:** Recommended · **Deadline:** before Saturday's start (SP-01 in the first hour)

### P-07 The service topology
- **Decision:** `cloudflared-public` and `cloudflared-admin` (with standby `-b` services at 0 replicas
  for the evict swap), `edge`, `api`, `worker`, `payments`, `console`, `admin`, `verify`,
  `migrate`, `backup`, and `cloudflared-db` on demand (ARCHITECTURE §2.2, §4.2). The edge is the
  public API gateway: key checks, load shedding, CORS for Try it, `whoami`, and the public hook routes.
  `console`, `admin` and `verify` serve only `/api/*` on their app hosts ([FD-18]): the app's auth
  realm (the console and Fin Admin), Fin's app API routes and the browser report endpoints. Their
  static files are served by Cloudflare ([FD-17]). There is no `docs` service: the docs site is
  static only, with no `/api/*` path, and its browser failure reports go to the edge at
  `api.<zone>/reports/docs` (appendix C, SF-01). The console and Fin Admin own only their realms;
  every domain read and write goes through `api`'s door; money, its jobs and its provider hook door
  live in `payments`; `verify` holds no database login.
  Every caller-to-callee operation is in the door matrix. Package and app names come from
  `tools/layout.json`, which ARCHITECTURE and EXECUTION both cite.
- **Default:** as stated.
- **Alternatives:** merge `edge` into `api` (unauthenticated parsing beside the data keys, and the key
  pepper on the service with the personal-data keys); merge `payments` into `api` (the raw provider key
  beside personal-data keys); run money jobs in `worker` (the money grants and provider reach on a
  second service); let the console and Fin Admin write domain tables directly; a `docs` service that
  takes the docs site's reports at `developer.<zone>/api/*`, so the docs page reports to its own
  origin (one more service, for reports only).
- **Rationale:** carries D11 (edge and api separate) and D23 (personal-data keys only on api and its
  worker), extended to provider credentials; a leak of one service's variables gives the least. The
  first EXECUTION draft had no edge and put money jobs in worker; builders follow lane tables, so the
  layout is now one file.
- **Status:** Recommended; the docs service dropped before the first commit (appendix C, SF-01) ·
  **Deadline:** before Saturday's start

### P-08 Images
- **Decision:** images are built in GitHub Actions without secrets or a build cache, from two targets
  of one Dockerfile: `test` (with the development seams, refusing to start in staging or production)
  and `release` (without them, the only target pushed, attested and deployed). Release images go to
  public GHCR packages, kept at least 90 days, and are deployed by digest. The app services' images
  hold no static files, which Cloudflare serves, so the previous release's hashed assets ride in each
  static upload instead ([FD-17]). The run image is distroless `nonroot`; server bundles carry their
  source maps inside the image, unserved; Railway's image auto-updates are off.
- **Default:** as stated.
- **Alternatives:** private GHCR packages (a registry token stored at Railway); Railway building from
  GitHub (Railway's builders then see the variables, which is how sealed values leaked in October).
- **Rationale:** carries D15, changed for a public repository; the images hold nothing secret and the
  code is public. GHCR is a run-time dependency, because Railway pulls on every restart or move.
- **Status:** Recommended · **Deadline:** before Saturday's start

### P-09 Postgres on Railway
- **Decision:** Postgres 18 on Railway's template: standalone with PITR in staging; HA (primary, two
  replicas, three etcd, three HAProxy) with PITR in production; daily, weekly and monthly volume
  backups; a nightly `age`-encrypted dump to the R2 vault; restore drills.
- **Default:** as stated.
- **Alternatives:** none under R2.
- **Rationale:** carries D2.
- **Status:** Decided by the owner, 19 Nov 2026 (was D2), carried · **Deadline:** decided

### P-10 Replication mode in production
- **Decision:** asynchronous (Railway's default) or synchronous replication for production's HA cluster.
- **Default:** Patroni's synchronous mode with `synchronous_mode: true` and `synchronous_mode_strict:
  false`, so the cluster keeps accepting writes if its only synchronous standby is lost, with
  `sync-standby-missing` paging when it is. The database is then outside Railway's support scope (it
  already is once Fin creates roles by SQL). Whatever the mode, money transactions are confirmed on a
  replica before a provider is called ([MO-18]). Commit latency and audited-write throughput are
  measured with it on (H-07). Railway is asked how HA nodes are placed and whether it switches the
  leader over before patching the primary.
- **Alternatives:** asynchronous, within support scope: a failover can lose up to about 1 MiB of
  committed WAL, including money rows and audit events already anchored outside; strict synchronous
  mode, which stops all writes when the only synchronous replica is lost.
- **Rationale:** money and audit cannot quietly lose committed rows, and a strict mode would turn one
  replica's loss into an outage.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### P-11 The queue and jobs in Postgres
- **Decision:** outbox and job tables in Fin's own code: per-item claims with `FOR UPDATE SKIP
  LOCKED`; one loop per queue with fixed concurrency and its own still-running guard; a priority for
  codes and security email with a reserved share; handler budgets under half the lease, renewed for
  long items, with fencing when a renewal fails; `NOTIFY` as a hint with a 5-second poll; lease rows
  for the schedulers; `ops.duty_state` so an overdue duty runs instead of being skipped; a success
  alert per duty in addition to the scheduler's heartbeat; no Redis. Webhook delivery moves to its
  own `worker-deliveries` service if the load test shows contention.
- **Default:** as stated; `pg-boss` is the fallback if the owner prefers a library.
- **Alternatives:** Redis with BullMQ (a dual write, outside PITR, another service); `pg-boss` or
  `graphile-worker` (single-maintainer dependencies).
- **Rationale:** jobs commit atomically with the business write and are covered by backups; one slow
  endpoint must never delay a sign-in code, and a scheduler's heartbeat proves only that the ticker
  runs.
- **Status:** Recommended · **Deadline:** before Saturday's start

### P-12 No PgBouncer at launch
- **Decision:** connection pooling, and how scaling changes connection limits.
- **Default:** none at launch (`max_connections` is 500; the production budget uses about 21%);
  PgBouncer in transaction mode for the web tier only if the budget passes 60%. `pnpm fin scale`
  recomputes each role's `CONNECTION LIMIT` and the budget before it changes a replica count, so a
  scale-up during an incident can connect.
- **Alternatives:** PgBouncer from day one.
- **Rationale:** fewer moving parts; `LISTEN`, locks and migrations need direct connections anyway.
- **Status:** Recommended · **Deadline:** production (review the measured budget)

### P-13 Railway configuration through `pnpm fin`
- **Decision:** `pnpm fin` drives Railway's GraphQL API with `fetch` from a public settings file and a
  private overlay. A thin first version (deploy and verify) on Saturday, with staging provisioned once
  by hand against a checklist; full `pnpm fin provision` before production, proven by provisioning a
  throwaway environment from scratch and running the smoke tests and drills on it ([OP-09]). No
  Railway infrastructure as code and no Config as Code files.
- **Default:** as stated.
- **Alternatives:** Railway's TypeScript infrastructure as code (`.railway/railway.ts`, the npm
  `railway` package and its CLI; plan and apply with drift detection built in).
- **Rationale:** one deploy tool and no new dependency (D3); Config as Code stops being read on
  1 Dec 2026; the first full provision must not be production's.
- **Status:** Decided by the owner, 19 Nov 2026 (was D3), changed · **Deadline:** before Saturday's start

### P-14 Recovery targets
- **Decision:** the recovery point and time objectives.
- **Default:** inside Railway, RPO about 1 minute while WAL archiving is healthy (the probe pages when
  it is not) and RTO 2 hours, following the numbered restore runbook ([OP-03]); after losing Railway,
  RPO about 1 hour for the high-value schemas (the hourly dump) and 24 hours for the rest, and a
  rebuild within a day on the target of [OP-04]; after losing Cloudflare, the site and the recovery
  copy are out of reach together (an accepted concentration). All UNVERIFIED until SP-17 and a staging
  drill measure them.
- **Alternatives:** tighter targets need a second database copy off Railway (a cost and a new path).
- **Rationale:** what the design can deliver, said with its conditions; a target nobody has measured
  is not a target.
- **Status:** OWNER MUST DECIDE (open since 19 Nov, was D21) · **Deadline:** production

### P-15 Heap sizing
- **Decision:** how Node sizes its heap under Railway's memory limit.
- **Default:** `--max-old-space-size-percentage=70` if SP-02 shows the limit is a cgroup limit Node
  sees; otherwise an explicit `--max-old-space-size` per service from its configured limit.
- **Alternatives:** Node's default (about half of the container, up to 2 GB).
- **Rationale:** a known heap gives a clean abort instead of an out-of-memory kill.
- **Status:** Recommended · **Deadline:** before Saturday's start

### P-16 Node's permission model
- **Decision:** whether production runs `node --permission`.
- **Default:** run `--permission-audit` in staging, read the violations, decide before production.
- **Alternatives:** never; or on from the start.
- **Rationale:** a "seat belt" that makes a compromised dependency's `child_process` or disk write fail
  loudly; every library must work under it first.
- **Status:** Recommended · **Deadline:** production

### P-17 Debugging distroless containers, and heap snapshots
- **Decision:** how to debug without a shell, and whether processes write heap snapshots.
- **Default:** no heap snapshots in release images on any service (a snapshot of a key-holding service
  holds the keys in clear, and an attacker who can push a process towards its heap limit would choose
  when one is written). Break-glass: a logged, reverted deploy of the debug image with the flag set,
  writing to a memory-backed path and encrypting to the operator's `age` recipient before the file
  leaves the container, never served over HTTP. No `railway ssh` (there is no shell, which also stops
  a stolen workspace session reading the environment).
- **Alternatives:** snapshots near the heap limit on every service (the first draft); a shell in the run
  image (rejected).
- **Rationale:** security first, with a documented escape.
- **Status:** Recommended · **Deadline:** before Saturday's start

### P-18 Database TLS pins and the superuser on HA
- **Decision:** how services pin the database's certificate on HA, and where the superuser password
  lives.
- **Default:** SP-05 and SP-17 read every HA member's certificate and CA and fail over under watch. If
  the members' CAs differ, services pin the bundle of all members' CAs (updated when members change)
  and check the hostname against the member names; if that proves impractical, `require` inside
  WireGuard is recorded as an accepted risk. The superuser rotates only through Railway's coordinated
  Regenerate, which stores the value in the template's variables, so the threat model says the
  superuser password lives in the cluster's own variables (sealed, if that is possible without
  leaving support scope); a failover and a `pg_rewind` are tested after a rotation.
- **Alternatives:** change the superuser password by SQL and keep it only in escrow (may break
  Patroni's own management, rewind and replication logins).
- **Rationale:** a pin to one volume's CA could break TLS for every service at the first failover.
- **Status:** Recommended · **Deadline:** production (staging's standalone pin on Saturday)

### P-19 The `login` event trigger, guarded
- **Decision:** the safety rules for the privileged-login trigger.
- **Default:** `IF pg_is_in_recovery() THEN RETURN` (the trigger also fires on hot standbys, where an
  insert cannot run), an exception handler that never raises (a failing trigger blocks every login),
  Patroni's own sessions classified by role and `application_name` and counted rather than paged, a CI
  test on real Postgres 18 that a failing trigger body does not block a login, and the disable path
  (`event_triggers = off`, which needs the superuser) in the restore and incident runbooks.
- **Alternatives:** no trigger, and rely on Postgres logs alone.
- **Rationale:** one bug in the watch must not lock out every service and Patroni itself.
- **Status:** Recommended · **Deadline:** before Saturday's start

### P-20 Two logins per service
- **Decision:** how database passwords rotate without an outage.
- **Default:** each service has two login roles (for example `fin_api_a`, `fin_api_b`) that inherit one
  NOLOGIN group role holding the grants; to rotate, set a new password on the idle login, switch the
  service's variable, deploy, then disable the old login. The grant matrix, the boot check ("member of
  exactly its group") and `CONNECTION LIMIT` follow; one rotation is drilled (PG-05).
- **Alternatives:** one login per service, and an outage at every rotation (new connections fail
  between `ALTER ROLE` and the redeploy).
- **Rationale:** pools open connections all the time, so a single password cannot change in place.
- **Status:** Recommended · **Deadline:** before Saturday's start

### P-21 A cache for Railway's private DNS
- **Decision:** how services resolve `*.railway.internal`.
- **Default:** a `lookup` in `packages/server` for `*.railway.internal` only, with a short cache and
  stale-if-error answers for up to 5 minutes, used by `pg` and internal `fetch`, with
  `dns.lookup_failed` lines that alert. SP-08 measures the answers for several replicas.
- **Alternatives:** Node's default, which does not cache.
- **Rationale:** Railway's private DNS failed for about 5 minutes on 30 Sep 2026; every internal call
  and new database connection depends on it.
- **Status:** Recommended · **Deadline:** before Saturday's start

### P-22 Railway egress
- **Decision:** how Fin stays clear of Railway's egress throttle.
- **Default:** measure egress per service in staging for a week and project production from it; tell
  Railway in writing about the expected egress before production; `pnpm fin verify` alerts when a
  month's egress passes 70 GB; egress is its own line in the cost table.
- **Alternatives:** wait for Railway to notice.
- **Rationale:** Railway may throttle above 100 GB a month; PITR uploads alone may be 60 to 150 GB, and
  every response now leaves through the connectors. A throttle would slow archiving, which can drop
  WAL.
- **Status:** Recommended · **Deadline:** production

## 3. The front door

### FD-01 The front door's shape
- **Decision:** how Cloudflare sits in front of Railway (R4).
- **The owner's decision (about 02:40):** "Front door: cloudflared tunnels for ALL hosts. This covers
  the public hosts (console, api, developer, verify) and Fin Admin (admin, behind Cloudflare Access
  with a JWT check on every request). Railway services get NO public domains and NO TCP proxies."
- **Default:** Cloudflare Tunnels for all hosts:
  - a public tunnel carries `api.` whole, and the `/api/*` paths of `console.`, `verify.`, `selfie.`
    and `developer.`;
  - an admin tunnel carries the `/api/*` paths of Fin Admin, behind Access, with a token check on every
    request;
  - the static files of those app hosts are served by Cloudflare's assets-only deployments and never
    reach Railway ([FD-17], [FD-18]);
  - each tunnel's token lives only in its own connector service's sealed variables; no Railway public
    domain and no TCP proxy on any service; connectors checked every minute for count, version and
    origin address; an evict runbook that drops every connector at once; Cloudflare's headers trusted
    only from the connector peers; the on-demand database tunnel for the operator, as researched.

  The design details are [FD-13] to [FD-15].
- **Alternatives:** proxied DNS to Railway custom domains locked by Railway Edge Rules and a per-host
  origin key (the first draft's recommendation), now an option to revisit after launch ([FD-16]).
- **Rationale:** the owner's decision. No public origin exists to find or to authenticate; plain http
  still reaches the app; the interception risk of a tunnel token is met by the controls around it.
- **Status:** DECIDED (owner, 21 Nov 2026, about 02:40): tunnels for all hosts. Amended about 03:50:
  on the app hosts only `/api/*` goes through a tunnel ([FD-18]) · **Deadline:** decided

### FD-02 Production origin TLS
- **Decision:** Cloudflare's SSL mode to a Railway origin.
- **Default:** withdrawn. Under [FD-01] no Railway origin is reachable through Cloudflare's proxy:
  Cloudflare reaches the connectors over the tunnel, and the connector-to-app leg is plain http inside
  Railway's WireGuard network.
- **Alternatives:** returns only if [FD-16] is ever revisited.
- **Rationale:** the question belonged to the proxied design.
- **Status:** Withdrawn, 21 Nov 2026 (moot under [FD-01]) · **Deadline:** none

### FD-03 Plain http on the API host
- **Decision:** what happens to a plain http call to `api.`.
- **Default:** it reaches the edge through the tunnel with `CF-Visitor` naming `http`. The edge refuses
  it with 403 `https_required`, checks whether the bearer is a real key and, if so, revokes a live key
  at once and emails the organisation's Super admins and Admins that it crossed the internet in clear
  and was revoked, with the audit event and `key-sent-in-clear`; a Sandbox key gets the email without
  the revocation.
- **Alternatives:** force a roll with a 1-hour overlap instead of revoking; notify staff only (the old
  product's behaviour, which leaves the organisation unaware and the key working).
- **Rationale:** a key sent in clear has crossed the internet readable by anyone on the path.
- **Status:** OWNER MUST DECIDE (revoke, or force a roll) · **Deadline:** production

### FD-04 Cloudflare plans
- **Decision:** Cloudflare's plan per zone.
- **Default:** staging Free. Production: the main zone (console, API) and the hosted zone (verify,
  selfie, docs) on Pro (20 to 25 USD a month each: managed and OWASP rule sets, 20 custom rules,
  host-matching rate rules, custom block bodies); the admin zone on Free, behind Access.
- **Alternatives:** Business (200 USD a month: counting by response code, more fields).
- **Rationale:** Free's single rate rule cannot match on host; the admin zone has Access in front.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### FD-05 Fin Admin behind Cloudflare Access
- **Decision:** the outer door of Fin Admin.
- **Default:**
  - One self-hosted Access application covers the whole admin host, static files and `/api/*` alike
    (owner, about 03:50: the admin host is "behind Access, which covers the whole host"). The app and
    its API share one origin, so the application needs no CORS settings.
  - An exact staff address list; an HTTP-only, `SameSite=Lax` cookie; the binding cookie on.
  - Access's independent MFA required: security keys and platform biometrics in production, TOTP
    also in staging. AMR matching off in production.
  - Google Workspace with 2-Step Verification as the identity provider in production, and in staging
    before any provider credential reaches staging. A one-time PIN alone is never the way in where
    real provider credentials exist, because whoever arrives first with the mailbox would enrol
    Access's own factor.
  - The token is validated at the admin connector and again by the app on every `/api/*` request,
    before anything else, and must name the same person as the staff session (owner, about 02:40: "a
    JWT check on every request"). The static files sit behind Access at Cloudflare's edge and hold no
    data; SP-25 proves that `/` and `/api/` both meet Access, and that no `workers.dev` or preview copy
    of the files answers.
  - When the Access session ends, the app's next call is redirected to the team domain and fails as a
    network error. The app then probes its own origin with `redirect: "manual"` and reloads (FW-C08).
- **Alternatives:** TOTP allowed in production; AMR matching on (the identity provider's factor
  counts); one-time PINs in staging throughout.
- **Rationale:** R6 wants a second factor for every admin; Access's own factor makes the door itself
  ask, and the PIN-only path made one mailbox enough.
- **Status:** Decided by the owner, 19 Nov 2026 (Access, identity provider), and 21 Nov 2026, about
  02:40 and about 03:50 (a token check on every request; Access over the whole host). The MFA methods
  and the staging identity provider are OWNER MUST DECIDE · **Deadline:** Saturday 22:00 (the staging
  identity provider, before CR-13 reaches staging); production (the MFA methods)

### FD-06 Turnstile
- **Decision:** whether the forms that make Fin send email or test a password use Turnstile.
- **Default:** yes before production (sign-up, emailed-code requests, password reset, Fin Admin's code
  request, verify's "email the link to me"), with `https://challenges.cloudflare.com` allowed for
  scripts and frames on those pages only; the forms ship first with Postgres limits alone. A page with
  Turnstile is a full document load with its own path rule in the app's `_headers` ([SA-45]), because
  a single-page app's policy is fixed when its document loads.
- **Alternatives:** no Turnstile; rely on Postgres limits and Cloudflare's rate rules.
- **Rationale:** it adds a third-party origin to a few pages (an exception to the page rules), from the
  vendor already terminating Fin's TLS.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### FD-07 Bot features off
- **Decision:** Cloudflare's bot features.
- **Default:** Bot Fight Mode off on any zone serving `api.` (zone-wide, cannot be skipped, challenges
  API clients and webhook senders, injects a script); Super Bot Fight Mode off at launch; Browser
  Integrity Check off and Security Level `essentially_off` on `api.`.
- **Alternatives:** Super Bot Fight Mode on the browser hosts later, with skip rules for `api.`.
- **Rationale:** a challenge page breaks JSON clients and webhook senders.
- **Status:** Recommended · **Deadline:** before Saturday's start

### FD-08 Cloudflare logs to Better Stack
- **Decision:** whether Cloudflare's HTTP request and firewall logs go to Better Stack.
- **Default:** yes, through Logpush with a Transformer keeping an allowlist of fields (no client
  address, query string, cookie, user agent or ID-bearing path segment), every path on the verify and
  selfie hosts and on the console's invitation routes redacted with a test, and the 530 and 1033 rates
  (a tunnel with no healthy connector) alerting; Access request logs not shipped (they need Zero
  Trust's paid tier). Static requests on the app hosts appear too, carrying the session cookie
  ([SA-43]); the allowlist never takes a cookie.
- **Alternatives:** no edge logs.
- **Rationale:** they show WAF blocks and tunnel errors Fin's processes never see; within the free 25 GB
  a month.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### FD-09 The staging zone
- **Decision:** where fin-next's staging hosts live while the old product still serves its staging
  zone.
- **Default:** a new staging zone in a new Cloudflare account of its own, with final names from day
  one, so the old product's tokens, deployments and access policies have no authority over fin-next
  and no cookie of one is same-site with the other. All staging hosts share that zone (test data
  only, an accepted risk). If a new zone cannot be had on Saturday morning, the fallback is the
  19 Nov `-next` names on the shared zone (D42) as an accepted risk until a new zone exists; then staff
  passkeys made on the `-next` admin host are re-enrolled at the cutover, and the cutover's trigger
  and 14-day rollback window are EXECUTION §9's (they were EQ-18 and EQ-19).
- **Alternatives:** the `-next` names on the shared zone for the whole build.
- **Rationale:** sharing a zone and an account with the old product gives its credentials authority over
  fin-next's DNS, Access and hostnames. Under [FD-18] the zone also holds a Workers route for every app
  host, so on a shared zone the old product's credentials and route rights could re-point fin-next's
  hosts.
  The routing spike (SP-25) runs on this zone in the first hour, so the zone must exist by then.
- **Status:** Decided by the owner, 19 Nov 2026 (was D42: `-next` names); the new zone and account are
  OWNER MUST DECIDE · **Deadline:** before Saturday's start

### FD-10 The production zones and the docs domain
- **Decision:** which registrable domains production uses.
- **Default:** three: `<zone>` for the console and the API; `<admin zone>`, Fin Admin's own; `<hosted
  zone>` for verify, the selfie host, the docs and the status page ([OB-09]). So the selfie host's
  third-party script, the docs site's bundle and the host Better Stack serves are never same-site with
  the console or Fin Admin. Every cookie is host-only and
  `__Host-` prefixed ([SA-43]), and each app host's routes ([FD-18]) sit on its own zone. Chosen early
  in hardening, because the sending domains need two weeks of warm-up ([EM-08]).
- **Alternatives:** one zone for everything (the origin gate is then the only barrier between them).
- **Rationale:** passkey RP IDs and error `type` URLs are permanent once used, and same-site hosts share
  SameSite protection.
- **Status:** OWNER MUST DECIDE · **Deadline:** Tuesday 24 Nov (for the warm-up); production at the
  latest, before the first production passkey and the first served error

### FD-11 The operator's database route
- **Decision:** how the operator reaches Postgres.
- **The owner's decision (about 02:40):** "The on-demand database tunnel for operator access stays as
  researched."
- **Default:** `cloudflared-db` at 0 replicas, scaled to 1 only for a registered `pnpm fin db` run,
  behind an Access TCP application with a service token per run; the watcher pages on any db connector
  outside a registered run. Postgres has no TCP proxy in staging either, so `railway connect` is
  never used: until `cloudflared-db` exists, operator work inside the database runs as registered
  `migrate --task` runs (appendix C, SF-04).
- **When it is built** (this entry is the one place it is decided): Phase 0 creates the
  `cloudflared-db` service at 0 replicas with no token. The db tunnel, its `db.` record and its
  Access TCP application are not created in Phase 0; they are built in hardening, before
  production (ARCHITECTURE §5.13; spec 01 §7.3).
- **Alternatives:** `railway connect` everywhere, or in staging until the db tunnel exists. It needs
  a TCP proxy, which the owner ruled out at 02:40, prints the password and bypasses Access.
- **Rationale:** no standing route to the database; a leaked token reaches nothing outside a run.
- **Status:** DECIDED (owner, 21 Nov 2026, about 02:40); the staging rule is Recommended (appendix C,
  SF-04) · **Deadline:** decided (built before production)

### FD-12 Rotating tunnel tokens and ingress proofs
- **Decision:** how the front door's secrets rotate.
- **Default:** tunnel tokens every 90 days and at once after any Railway or Cloudflare security notice,
  by the blue and green swap of [FD-15] (a refreshed secret does not evict running connectors);
  ingress proofs every 90 days with two accepted values (add the new value to the service, deploy,
  switch the Transform Rule, remove the old value). Both, and the static-deploy token of [FD-19], are
  in the credential inventory ([OP-05]).
- **Alternatives:** rotation on suspicion only.
- **Rationale:** both are Railway variables, which can leak. This replaces the first draft's origin-key
  rotation.
- **Status:** Recommended · **Deadline:** production

### FD-13 The tunnel design
- **Decision:** how the tunnels of [FD-01] are built.
- **The owner's decisions:** about 02:40: "Separate tunnels and tokens: one public tunnel and one admin
  tunnel. Each token lives only in its own cloudflared service's sealed variables"; "Connector
  monitoring every minute: alert on any connector that isn't from Railway's egress or doesn't match
  the expected count and version"; "Cloudflare headers are trusted only from the cloudflared peers".
  About 03:50: "the tunnel's ingress matches the hostname plus `^/api/` and sends it to that app's API
  service on Railway, with a catch-all `http_status:404`".
- **Default:**
  - **Connector services** `cloudflared-public` and `cloudflared-admin`: 1 replica in staging and 2 in
    production, overlap 15 s, draining 35 s, restart Always, static egress on, image
    `fin-next-connector` pinned by digest (`cloudflared` 2026.11.1 and Fin's connector supervisor).
  - **The supervisor** runs `cloudflared --no-autoupdate --loglevel info --transport-loglevel warn
    --protocol http2` with metrics on `127.0.0.1` only (so `/config` and `/debug/pprof` are never
    served to neighbours), exits after repeated `/ready` failures so Railway restarts it, answers only
    `/healthz` and `/readyz` for Railway's deploy check, and writes `connector.health` lines.
  - **The ingress map is code:** host roles to fixed services, `httpHostHeader` per host, and a
    `http_status:404` catch-all. On the app hosts (console, verify, selfie and developer on the public
    tunnel; Fin Admin on the admin tunnel) a rule matches the hostname **and** the path `^/api/`;
    `api.` is matched by hostname alone. Static paths never reach a connector, because Cloudflare
    serves them ([FD-17], [FD-18]); if one did, the catch-all refuses it. Hostnames come from
    non-secret settings; no setting can target any other service. Tunnels are locally managed, so no
    remote configuration applies (SP-04a); the fallback is a remote configuration pushed only by
    `pnpm fin`, validated, kept for rollback and hashed every minute. SP-25 checks that the edge and
    `cloudflared` see the same path for `/x/../api/y` and `//api/y` on the pinned version.
  - **The admin connector** enforces the Access token (`access.required`).
  - **Ingress trust:** a request is tunnel traffic only when its TCP peer is a current replica of the
    service's own connector service (internal DNS refreshed every 15 s, `::ffff:` normalised) **and**
    the host's ingress proof from a Transform Rule matches.
  - **`/readyz`** refuses any request that arrives through a connector.
  - **QUIC** only if SP-04e proves outbound UDP 7844 works from Railway.
- **Alternatives:** remotely managed tunnels configured in the dashboard; the peer check alone; the
  proof header alone; whole app hosts sent to the tunnel, with each app serving its own files (the
  shape before [FD-17]).
- **Rationale:** a tunnel token or a Tunnel-write token must not be able to repoint a public hostname
  at a private address, and an address that another service inherits must not inherit trust.
- **Status:** DECIDED (owner, 21 Nov 2026, about 02:40 and about 03:50) for the separate tunnels and
  tokens, the minute watch, the peer-only trust and the host-and-path match. The rest is Recommended
  (it builds the owner's [FD-01]) · **Deadline:** decided (built in Phase 0)

### FD-14 A tunnel of its own for the API
- **Decision:** whether `api.` gets its own tunnel, separate from the browser hosts.
- **The owner's decisions:** "one public tunnel and one admin tunnel" (about 02:40); "`api.<zone>` (the
  public API) goes straight to the tunnel" (about 03:50).
- **Default:** no third tunnel: `api.` is on the public tunnel. The fixed ingress map, the ingress
  proofs and the blue and green evict limit what a bad configuration or a leaked token can do.
- **Alternatives:** a third tunnel for `api.` alone, which halves the blast radius of a configuration
  error or a leaked public token, at the cost of two more connector services. It stays recorded, and
  the owner may reopen it before production.
- **Rationale:** the public tunnel carries the API, the app hosts' `/api/*` paths and every provider
  webhook, which is why the question was raised. The owner placed `api.` on it twice.
- **Status:** DECIDED (owner, 21 Nov 2026, about 02:40 and about 03:50) · **Deadline:** decided

### FD-15 The evict runbook
- **Decision:** how every connector of a tunnel is dropped without taking the service down.
- **Default:** a blue and green swap: create the replacement tunnel with the same map; put its token on
  the standby connector services; wait for connectors from the expected static addresses; flip the
  proxied CNAMEs; delete the old tunnel and its connections. Drilled in staging with times recorded.
  If Railway's API is down, deleting the tunnel at Cloudflare stops the leak and the service together.
- **Alternatives:** delete and recreate in place (an outage while the new token reaches Railway, which
  is impossible while Railway's API is down).
- **Rationale:** the owner asked for an evict runbook; a tunnel ID change moves every CNAME, so the order
  matters.
- **Status:** DECIDED (owner, 21 Nov 2026, about 02:40: "An evict runbook: delete and recreate the
  tunnel, which drops every connector at once"). The blue and green order, which ends in that delete
  without an outage, is Recommended · **Deadline:** production (the drill); the commands in hardening

### FD-16 The proxied option, for after launch
- **Decision:** what remains of the first draft's front door.
- **Default:** recorded as an option to revisit after launch: proxied DNS to Railway custom domains,
  locked by Railway Edge Rules and a per-host secret header. If revisited: Cloudflare's address ranges
  are shared by every Cloudflare customer's Workers, so an "only from Cloudflare" rule proves nothing
  and the header would be the only control; the origin certificate leg would need Full (strict) or
  Origin Pull; plain http would never reach the app.
- **Alternatives:** drop it entirely.
- **Rationale:** the owner's decision of 21 Nov keeps it as an option, not the design.
- **Status:** DECIDED (owner, 21 Nov 2026, about 02:40: "The proxied-DNS-plus-Railway-Edge-Rules
  design is now an option to revisit after launch, not the primary.") · **Deadline:** decided

### FD-17 Static files on Cloudflare: assets-only deployments
- **Decision:** how the browser apps' files are served: the console, Fin Admin, verify (with the
  selfie document) and the docs site.
- **The owner's decisions:** about 03:00: "Static files go on CLOUDFLARE PAGES, not a Hono process";
  `index.html` no-cache and hashed assets immutable; "NO Pages Functions, NO Workers, NO Workers-only
  bindings, nothing that can't move to another static host". About 03:50, replacing the Pages part:
  "The owner chose the ASSETS-ONLY static deployment. Each app's static build (console, admin, verify,
  docs) is served by Cloudflare's 'Workers static assets' with NO Worker script: no `main`, no
  bindings, no `run_worker_first`. It uses `not_found_handling: single-page-application`,
  `workers_dev: false`, `preview_urls: false`, and the same `_headers` file for the CSP and security
  headers." And: "Portability: no code runs at Cloudflare."
- **Default:**
  - One assets-only deployment per app per environment, holding the app's Vite `dist/` and its
    `_headers` ([SA-45]). No script, no binding, no `run_worker_first`. `not_found_handling:
    "single-page-application"`. `workers_dev: false` and `preview_urls: false`, so no copy of the files
    sits on `workers.dev` or a preview host, outside Access.
  - `index.html` is `Cache-Control: no-cache`; hashed assets are `public, max-age=31536000,
    immutable`. Each upload also carries the previous release's hashed assets, so a tab opened before a
    release keeps loading its chunks (FW-C13).
  - The selfie document has a deployment of its own on the selfie host, holding only `selfie.html`
    and its assets ([SA-26]).
  - Pull-request previews are off. Builds hold no secret, no private setting and no environment
    setting: each app's `_headers` and `env.json` are rendered at upload ([SA-45]; appendix C, SF-05).
  - Moving away means serving the same `dist/` and `_headers` from any static host, with a
    path-routing proxy for `/api/*` ([FD-18]). The only Cloudflare-specific parts are the deployment
    settings and the route patterns.
  - UNVERIFIED: that asset requests through a route never count as Worker invocations on the Workers
    Free plan. SP-25 reads the metrics.
- **Alternatives:**
  - Cloudflare Pages (the 03:00 decision). It cannot share a host with `/api/*` on the Free or Pro
    plans, because Origin Rules' DNS-record and Host overrides are Enterprise-only.
  - Each app's Hono process serving its files on Railway (the framework verdict's first form): Railway
    egress, and a server on every document request.
  - The Load Balancing add-on in front of Pages: paid routing, which the owner ruled out at 03:00.
- **Rationale:** one host per app with no code at Cloudflare. Static requests are free and unlimited,
  and documents and assets come from Cloudflare's edge, which also settles [FW-03].
- **Status:** DECIDED (owner, 21 Nov 2026, about 03:50), superseding the 03:00 hosting on Cloudflare
  Pages. The cache rules and the portability rule DECIDED (owner, about 03:00) and kept. The
  previous-assets carry, the selfie host's own deployment and the environment-neutral builds
  (appendix C, SF-05) are Recommended. Spec 05's `404-page` for the docs is not adopted (appendix C,
  SF-06) · **Deadline:** decided

### FD-18 One host per app: `/api/*` through a no-Worker route to the tunnel
- **Decision:** how a browser app and its own API share one origin.
- **The owner's decision (about 03:50):** "Routing per app host, for example `console.<zone>`: a
  Workers route `console.<zone>/*` goes to the assets-only deployment; a zone route
  `console.<zone>/api/*` has NO Worker ('None'), so it falls through to the hostname's DNS origin, a
  proxied CNAME to the public tunnel; the tunnel's ingress matches the hostname plus `^/api/` and sends
  it to that app's API service on Railway, with a catch-all `http_status:404`." The same for verify,
  and for Fin Admin on the admin tunnel behind Access. "No CORS between an app and its API (same
  origin)." The docs host is assets-only too, and `api.<zone>` goes straight to the tunnel.
- **Default:**
  - **Per app host** (`console.`, `verify.`, `selfie.`, and Fin Admin's host on the admin tunnel;
    which zone each host sits on is [FD-10]'s):
    - the host is a proxied CNAME to its tunnel;
    - a Workers route `<app host>/*` goes to the app's assets-only deployment ([FD-17]);
    - a zone route `<app host>/api/*` has no Worker. It is never written `/api*`, which also matches
      `/apix` and has a documented specificity bug;
    - the tunnel's ingress matches the host and `^/api/` ([FD-13]);
    - a Cache Rule bypasses the cache for paths starting `/api/`, and every API answer sets
      `Cache-Control: no-store`;
    - the zone's WAF and rate rules cover both halves of the host, and Access covers both on Fin
      Admin ([FD-05]).
  - **`developer.<zone>`** (the docs) has the Workers route to its assets-only deployment and a
    proxied CNAME to the public tunnel, but no `/api/*` route and no ingress rule: a request that
    misses the route gets the tunnel's 404 (appendix C, SF-01).
  - **`api.<zone>`** is a proxied CNAME straight to the public tunnel, with no Workers route. Try it on
    the docs calls it cross-origin, without credentials, with Sandbox keys only ([AP-10]).
  - **The apps** call relative `/api/...`, and no route of a single-page app sits under `/api`. A
    request for `/api` with no slash gets the app's document, which is harmless.
  - **The spike, SP-25,** first thing on Saturday, on a throwaway host of the staging zone, before any
    app host is made (about 15 minutes; no credential printed, any token asked for at the secure
    prompt):
    1. Origin Rules offer only the destination port on the staging zone's plan (a screenshot for the
       owner).
    2. A tunnel route on the host for `^/api/` answers a distinctive status code.
    3. An assets-only deployment on `<host>/*`, made with the pinned `wrangler`, plus the no-Worker
       `<host>/api/*` route: `/` and a deep path give the static file; `/api/...` gives the tunnel's
       status for a GET, a JSON POST, a same-origin `fetch` in a browser (no OPTIONS and no redirect)
       and an address typed into the address bar.
    4. Recommended additions: on an Access-protected throwaway host, `/` and `/api/` both meet Access,
       and no `workers.dev` or preview copy answers; `/x/../api/y` and `//api/y` reach the same place
       at the edge and at the connector; the deployment's metrics show no invocations.
    5. Teardown, and the results in `docs/plan/spikes.md`.
  - **The fallback,** if the no-Worker route does not fall through, or the assets-only deployment is
    refused on a route: per-app API hosts on the same site (`console-api.<zone>`, `verify-api.<zone>`,
    and `admin-api.` on the admin tunnel under the same Access application as Fin Admin's host),
    cross-origin with exact single-origin CORS and credentials. The cookies, CSRF checks and Better
    Auth settings for that shape are in [SA-43] and [SA-44].
- **Alternatives:**
  - Origin Rules' DNS-record override (the 03:10 decision): Enterprise-only.
  - The host pointed at the tunnel, with an Origin Rule sending static paths to Pages: Enterprise-only
    too.
  - The Load Balancing add-on with one custom rule: paid routing.
  - `cloudflared` proxying static paths back out to Pages: a hairpin through Railway, which defeats
    the point of static hosting.
- **Rationale:** one origin per app means no CORS and no preflights; `Sec-Fetch-Site: same-origin`
  refuses sibling hosts on its own; the passkey RP ID default is right; and no code runs at Cloudflare.
- **Status:** DECIDED (owner, 21 Nov 2026, about 03:50), superseding the 03:10 Origin Rules routing
  and its fallback (a); the spike and the fallback DECIDED with it. Step 4 of the spike, the Cache Rule,
  the `/api/` spelling and the docs host's shape (appendix C, SF-01) are Recommended ·
  **Deadline:** decided (SP-25 first thing on Saturday)

### FD-19 Building and uploading the static files
- **Decision:** how static builds reach Cloudflare, with which credential, and how a change to them
  is caught.
- **The owner's decision (about 03:00):** "Deploy: GitHub Actions builds, then uploads to Pages with a
  pinned CLI. Pull-request previews are acceptable (they are public, so builds must contain no
  secrets)." The 03:50 decision moved the upload from Pages to the assets-only deployments and turned
  previews off.
- **Default:**
  - GitHub Actions builds each app's `dist/` with no secret in scope, and the release manifest records
    its content hash ([CI-02]). Source maps go to Better Stack's error tracking from the build and are
    removed from `dist/` before the upload.
  - Staging: a `deploy-static-staging` job uploads the files with the pinned `wrangler` from
    `tools/static-deploy` ([G-06]). It runs in a GitHub environment of its own, which holds only the
    static-deploy token and is approved by the owner's account like `staging` ([CI-03]). It never
    shares a job with the Railway deploy, so the `ops/fin` job keeps no npm dependency.
  - Production, a question for the owner: the owner's words are "GitHub Actions builds, then
    uploads". The answer put to the owner is that the operator's launcher uploads the exact `dist/`
    that passed staging, by content hash, with a token given at the secure prompt ([CI-04]), so
    GitHub holds no production credential. The other answer is an Actions job in a `production`
    environment that the owner's account approves, holding a production static-deploy token.
  - The token can edit Workers scripts on that one account and nothing else; the routes are made once
    by `pnpm fin provision` with the operator's token. A token that can upload a version could also
    upload code onto the app's routes, so it is an interception credential like a tunnel token. The
    watcher checks every minute that each deployment has no script module and no binding, that
    `workers_dev` and previews are off, and that the zone's routes match the map, and pages on any
    difference ([OB-11]). The token rotates with the front door's secrets ([FD-12]).
- **Alternatives:**
  - `pnpm fin` uploading through Cloudflare's assets API with `fetch`, with no dependency (UNVERIFIED
    that an assets-only version can be made that way). SP-26 tests it. Moving to it is the owner's
    call, because the owner asked for a pinned CLI (appendix C, SF-02).
  - `wrangler` inside the Railway deploy job, beside every staging secret.
  - Uploads from GitHub Actions for production too (the other answer above), which would put a
    production credential in GitHub.
- **Rationale:** the owner's pinned CLI and build in Actions, kept apart from the job that holds
  Railway's secrets. The operator's production upload follows the 19 Nov decision (D37), which came
  before the owner's 03:00 words, so it is asked again rather than read into them.
- **Status:** Recommended for staging, building the owner's 03:00 deploy decision. The production
  upload is OWNER MUST DECIDE. Spec 01's upload without `wrangler` (S0-04) and its token in `staging`
  (S0-18) are not adopted (appendix C, SF-02 and SF-03) · **Deadline:** before Saturday's start for
  staging (SP-25 uses the pinned `wrangler`); production for the production upload

## 4. Data

### DA-01 One database, one schema per area
- **Decision:** one Postgres database per environment with one schema per area (`identity`, `staff`,
  `keys`, `kyc`, `money`, `events`, `email`, `audit`, `ops`). Each area has one owning service. Other
  services reach it only through that service's door, or through a narrow view granted for one
  purpose (ARCHITECTURE §6.1).
- **Default:** as stated.
- **Alternatives:** one shared schema with table grants; a database per service, which would turn a
  change, its audit event and its outbox rows into a distributed write.
- **Rationale:** grants and doors make "who can touch what" testable, and one database keeps each
  change, its event and its audit row in one transaction.
- **Status:** Recommended · **Deadline:** before Saturday's start

### DA-02 IDs
- **Decision:** IDs take the form `<prefix>_<26 Crockford base32 characters>`. They are time-ordered,
  made inside a request or job from the injected `Clock`, and listed in one prefix catalogue that has
  a duplicate test. A path ID of the wrong shape gets a 404 without a lookup. API key IDs are 10
  Crockford characters inside the key.
- **Default:** as stated.
- **Alternatives:**
  - UUIDv7: logs and support lose the type at a glance.
  - Database sequences: they leak volumes and need a round trip.
- **Rationale:** the API and the docs already promise prefixed opaque IDs (`cus_`, `evt_`, `trf_`).
  Time order gives cheap time windows on the primary key.
- **Status:** Recommended · **Deadline:** before Saturday's start

### DA-03 Database roles and grants
- **Decision:**
  - `postgres` is used only to provision and for break-glass, and rotates only through Railway's
    Regenerate ([P-18]).
  - `fin_owner` owns the schemas and the guard functions and runs migrations. It is not a superuser
    and has no standing password: each registered run sets one with `VALID UNTIL` ([AU-08]).
  - Each service has a NOLOGIN group role holding its grants and two login roles in it ([P-20]), plus
    `fin_backup`, `fin_readonly` and `fin_probe` (`pg_monitor` only).
  - The grant matrix is one fragment per area, rendered to SQL, with per-role tests (SQLSTATE 42501),
    a boot check and an hourly drift check.
  - Shared tables are written only through checked functions ([DA-14]).
  - Logins as `postgres` or `fin_owner` outside a registered run are caught by a guarded `login`
    event trigger ([P-19]) into `ops.privileged_login`, a table owned by the superuser and
    append-only, plus a log line, and paged.
- **Default:** as stated (§6.3). The trigger depends on SP-05.
- **Alternatives:** one application role for every service, as on the old Workers, so that any leak
  reaches every table.
- **Rationale:** "assume variables leak". Each leak should reach only its own service's tables, and the
  table that catches a privileged login must not belong to the login it catches. Once roles are created
  by SQL, Railway's support scope ends; that is accepted and recorded.
- **Status:** Decided by the owner, 19 Nov 2026 (per-service database roles in the staging core, D44),
  carried and extended · **Deadline:** decided

### DA-04 Migrations
- **Decision:**
  - Hand-written SQL files named `<YYYYMMDDHHMMSS>_<area>_<what>.sql`, append-only, from a fresh
    baseline. Drizzle may draft a file outside the repository; no Drizzle Kit journal or snapshot is
    committed.
  - The runner applies every unapplied file in name order, refuses a changed applied file, and ignores
    applied files it does not know; a CI check refuses a new file not later than the newest on `main`.
  - Each file sets `lock_timeout` and `statement_timeout`, and squawk lints it. A file may be
    non-transactional for `CREATE INDEX CONCURRENTLY`.
  - Changes expand, then contract, and every contract accepts N-1.
  - The `migrate` service runs before any service rolls, writes `migrate.done release=<sha>`, and the
    deploy confirms it through `api`'s private health. Each release declares its minimum schema
    version and its `/readyz` fails below it.
  - Rollback never runs `migrate`. A `risky` migration records a PITR timestamp and takes a manual
    backup first.
- **Default:** as stated (§6.4).
- **Alternatives:** Drizzle Kit's `push`, or its generated files and journal (two lanes editing one
  journal at once); `NNNN_` numbers (two lanes pick the same one); migrations from the operator's
  machine (the 19 Nov design).
- **Rationale:** parallel lanes, no operator machine in the deploy path, and no release that runs ahead
  of its schema or behind it.
- **Status:** Recommended · **Deadline:** before Saturday's start

### DA-05 Personal data, with Sumsub as the record
- **Decision:** as approved on 19 Nov:
  - Sumsub holds a live customer's personal data.
  - Fin keeps IDs and statuses, the sealed display name, keyed hashes, masks and the name blind
    index. Matches are word starts in any order, newest first, with no infix or typo match, and CJK
    names match from 1 character. Fin also keeps `fields_present` and `erased_at`.
  - The applicant is created at the first write that carries personal data.
  - Go-live answers stay sealed in Fin.
  - `review_labels` is not kept: Fin Admin reads labels live.
  - Sandbox personal data stays in Fin, sealed, and is deleted 90 days after the last change.
  - Email domains are masked, except common providers.
- **Default:** as stated, built for the first time in fin-next (§6.5, §6.6).
- **Alternatives:** none open.
- **Rationale:** fewer copies of personal data, and Sumsub's own controls for its screening queues.
- **Status:** Decided by the owner, 19 Nov 2026 (was D13), carried · **Deadline:** decided

### DA-06 Key families for sealing and hashing
- **Decision:**
  - Personal data is sealed with AES-256-GCM using HKDF subkeys per organisation and AAD per field
    (`fdk<n>.` values).
  - HMAC indexes are keyed per use, organisation and mode.
  - Money has its own seal and fingerprint families, held by `payments` only.
  - Limit and cursor keys are separate.
  - Keys are versioned. Re-seal and dual-write index rotations run as one-off Railway tasks, and a
    retired key stays in escrow for at least 89 days.
- **Default:** as stated (§6.6, §7.8).
- **Alternatives:**
  - Postgres `pgcrypto`: keys reach the database and its logs.
  - A cloud KMS: a new vendor and a call per value.
- **Rationale:** a sealed value cannot move between fields or organisations, and a leak of one
  service's variables does not open another domain's data.
- **Status:** Recommended · **Deadline:** before Saturday's start

### DA-07 Only `api` and `worker` hold the personal-data keys
- **Decision:** the seal and index keys and Sumsub's tokens are held only by `api` and `worker`. The
  console, Fin Admin and verify reach personal data only through `api`'s door. The door re-checks the
  caller's session, staff session or link session itself, limits reads per organisation (300 per 10
  minutes to start) and per person, and writes a line per read.
- **Default:** as stated.
- **Alternatives:** the old shape, with the keys on four Workers.
- **Rationale:** carries D23. The door re-checks rather than trusting an assertion ([SA-36]).
- **Status:** Decided by the owner, 19 Nov 2026 (was D23), carried and strengthened · **Deadline:**
  decided

### DA-08 Retention, and the question for counsel
- **Decision:**
  - The retention periods.
  - What erasure cannot remove.
  - Whether Fin is a processor or a controller for end customers' data.
- **Default:** the table in ARCHITECTURE §6.8, subject to counsel:
  - audit events for the life of the service;
  - money records for at least 5 years after the relationship ends, with personal fields blanked;
  - sandbox customers for 90 days;
  - developer events for 13 months;
  - webhook deliveries for 30 days;
  - logs for 30 days in staging and 90 in production.

  The residues that erasure cannot reach at once are listed in the privacy notice.
- **Alternatives:** counsel's answer replaces the defaults.
- **Rationale:** on 19 Nov the owner agreed to ask counsel. The answer sets the money and audit
  periods and the limits of erasure.
- **Status:** Decided by the owner, 19 Nov 2026 (ask counsel, was D18). Counsel's answer is OWNER
  MUST DECIDE · **Deadline:** production

### DA-09 The R2 vault
- **Decision:**
  - Backups, audit heads, the revocation journal, escrow ciphertext and operator records go in
    Cloudflare R2.
  - There are five buckets per environment, each with one writer, and locks per bucket.
  - Staging's buckets are in the staging Cloudflare account (an accepted risk).
  - Production's buckets are in a separate vault account with a security-key login and no standing
    admin token.
  - The watcher keeps an inventory of locked objects (in staging from the first deploy; in production
    from the separate watch account).
- **Default:** as stated (§6.10).
- **Alternatives:**
  - Backblaze B2 (the 19 Nov alternative).
  - Railway buckets: no object lock, and reachable by a leaked Railway credential.
- **Rationale:** carries D29, and the owner's acceptance of R2's limits: a bucket admin can lift a
  lock rule, probably without an audit entry.
- **Status:** Decided by the owner, 19 Nov 2026 (was D29), carried · **Deadline:** decided

### DA-10 Escrow
- **Decision:** every generated key and password is encrypted with `age` to an offline identity per
  environment before it is set on Railway. Staging's identity is in the owner's password manager,
  with a printed copy. The open question is how production's identity is held.
- **Default:** production uses two hardware keys plus a sealed printed copy.
- **Alternatives:**
  - the password manager for production too;
  - a single hardware key.
- **Rationale:**
  - D5, the staging part, was answered on 19 Nov.
  - The owner deferred the hardware keys (D32) to before production.
- **Status:** Decided by the owner, 19 Nov 2026, for staging (was D5). Production's hardware is OWNER
  MUST DECIDE (was D32) · **Deadline:** production

### DA-11 What the vault keeps in clear
- **Decision:** which vault objects are stored unencrypted.
- **Default:** only the ID-only records that the checks read: audit heads, journal entries,
  manifests, run registrations and markers. A field allowlist with a test enforces this. Everything
  else is `age`-encrypted.
- **Alternatives:** encrypt the heads too. The watcher and `pnpm fin verify` would then need a
  decryption key online.
- **Rationale:** the checks must read heads without a secret, and the records hold IDs only.
- **Status:** OWNER MUST DECIDE (open since 19 Nov, was D39) · **Deadline:** production

### DA-12 What deleting an organisation keeps
- **Decision:** what deleting an organisation does to its money and audit records.
- **Default:**
  - Keep the following for the retention period of [DA-08], with personal fields blanked:
    transfers, ledger entries, beneficiaries' non-personal fields and audit events.
  - Money rows have no foreign key to customers.
- **Alternatives:** cascade-delete. This breaks AML record keeping, reconciliation and the audit
  chain.
- **Rationale:** record-keeping duties outlive an organisation, and the chain cannot lose rows.
- **Status:** OWNER MUST DECIDE · **Deadline:** Monday

### DA-13 One upload rule, and a Sandbox quota
- **Decision:** one size and file-type rule for uploads through the API, the hosted pages and forms,
  and a quota on Sandbox documents.
- **Default:** 20 MB. JPEG, PNG, HEIC or PDF, checked by their first bytes. The rule is the same
  everywhere (413 `file_too_large`). Sandbox documents have a quota per organisation by count and by
  bytes ([SA-40]).
- **Alternatives:** 10 MB.
- **Rationale:** one rule instead of three; 20 MB fits phone photos and multi-page scans; without a
  quota anyone could store unlimited sealed "documents" in Postgres with a free Sandbox key.
- **Status:** Recommended · **Deadline:** Sunday

### DA-14 Shared tables written through checked functions
- **Decision:** no service inserts raw rows into another area's tables. `email.enqueue()`,
  `events.emit()` and `audit.record()` are `SECURITY DEFINER` functions with `search_path` pinned that
  check a per-role allowlist: the templates a role may send (payments: money templates only), the
  developer event types a role may emit (payments: transfer, virtual account and beneficiary events
  only), and the audit events a role may record. Each refusal has a test.
- **Default:** as stated (§6.3).
- **Alternatives:** insert-only grants on the shared tables (the first draft), which still let any
  service queue any template to any address or emit `customer.approved` for any organisation.
- **Rationale:** a look-alike sign-in notice, a used-up allowance or a forged developer event is a real
  attack with only an insert right.
- **Status:** Recommended · **Deadline:** before Saturday's start

### DA-15 What backups hold, and the drill key
- **Decision:** the contents of the dumps and how the drill identity is handled.
- **Default:** a nightly full dump plus `pg_dumpall --roles-only`, and an hourly dump of the
  high-value schemas (`money`, `audit`, `keys`, `identity`, `staff`), each `age`-encrypted; dumps leave
  out session, verification, proof, intent, rate-window, idempotency and outbox data, which a restore
  would throw away anyway. The drill identity's private key enters only the one-off drill task for the
  length of a registered drill, and the recipient is rotated after each drill through a reviewed
  change to the settings file. Production restores the newest dump weekly in an automated check and
  runs a full drill monthly; staging monthly and quarterly.
- **Alternatives:** a standing drill key on Railway (one leaked value decrypts 70 days of dumps);
  monthly checks only.
- **Rationale:** a junk dump of the right size passes a freshness check but not a restore, and a dump
  should not carry session material.
- **Status:** Recommended · **Deadline:** production (the staging dump on Saturday)

### DA-16 Which limits survive a restart
- **Decision:** which rate and lockout state is logged.
- **Default:** lockouts, password pauses, per-code attempt counts, step-up locks and per-recipient
  email limits live in logged tables; only coarse per-address request windows live in an `UNLOGGED`
  table. A test proves a restart keeps a paused address paused.
- **Alternatives:** every window unlogged (the first draft).
- **Rationale:** unlogged tables are emptied after a crash and are not replicated, so a failover would
  hand an attacker a fresh guessing budget everywhere at once.
- **Status:** Recommended · **Deadline:** before Saturday's start

## 5. Security and auth

### SA-01 Better Auth for both realms
- **Decision:**
  - Both realms use Better Auth 1.7 for authentication: proving who someone is, their second factors
    and their sessions. One `createRealm()` factory builds them.
  - Authorisation is Fin's own code: organisations, members, roles, permissions and step-up. So is
    audit.
- **Default:** as stated (§7.1).
- **Alternatives:**
  - A hand-rolled staff realm, as in the old product's staff realm and the phase-1 auth notes: a
    smaller library surface, but a second set of ceremonies to harden.
  - A hosted identity service (WorkOS, Clerk and the like): sessions and personal data at a vendor,
    and a third-party origin on the sign-in pages.
  - Auth.js: no parity for passkeys and second factors.
- **Rationale:** one hardened set of ceremonies serves both realms. The old product's hardening
  carries over, and only a few plugins are mounted.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-02 Better Auth versions
- **Decision:**
  - Start on 1.7.25 (FW-S2 runs on it). The identity lane reads the 1.7.26 and 1.7.27 release notes
    before its first merge.
  - Move all four packages to 1.7.27 together on Monday 23 Nov, after it clears the three-day release
    age at 10:53 UTC, in one dependency pull request gated by the endpoint-policy and pin tests. If
    either release fixes an advisory that touches a mounted plugin, the owner decides between waiting
    and [SA-27]'s fast path.
  - All Better Auth packages move together through one Dependabot group.
  - `@better-auth/core` is pinned through one `overrides` entry, an exact version with a dated
    comment, approved with [G-06], because `overrides` is a protected key.
  - Never a 1.8 beta. SP-10 re-reads the session paths on every bump.
- **Default:** as stated.
- **Alternatives:** 1.7.26 in between (it clears only at 17:56 UTC on Saturday, after Phase 0); an
  older 1.7 release, which the library no longer supports.
- **Rationale:** the library supports only its newest release, and it published 39 advisories in 2026.
  One sequence in every file.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-03 Passkeys first
- **Decision:**
  - Every sign-in page, enrolment and step-up dialog leads with the passkey, with browser autofill
    on the email field.
  - Passkeys are stored with resident key and user verification required.
  - Attestation is `none`.
  - The RP ID is the app's own host and the expected origin is its origin, set explicitly in every
    realm ([SA-43]).
- **Default:** as stated (§7.2).
- **Alternatives:** the library's defaults, which are weaker.
- **Rationale:** a passkey resists phishing, and with user verification it is a second factor by
  itself.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-04 A mandatory second factor for every staff member
- **Decision:**
  - Every staff session must reach `aal2`.
  - An `aal1` staff session reaches only the factor endpoints.
  - A staff member with no factor yet is pending, holds no permission, and may register a first factor
    only with the emailed code and an enrolment code that never travels by email ([SA-29]).
  - In production the first staff factor is a passkey.
  - Removing the last factor is refused. Staff get no trusted browser and no backup codes.
  - Adding someone needs `staff.add` and a step-up intent.
- **Default:** as stated (§7.3, §7.4).
- **Alternatives:** none under R6.
- **Rationale:** R6: "Every admin must have a second factor, and it is not optional", and "adding
  someone needs a second factor". The enrolment code closes the gap where one mailbox yielded a full
  staff account.
- **Status:** Decided by the owner, 21 Nov 2026 (R6); the enrolment code is Recommended ([SA-29]) ·
  **Deadline:** decided

### SA-05 A mandatory second factor for privileged dashboard roles
- **Decision:** whether R6's "every admin must have a second factor" also covers the dashboard's
  privileged roles, and how the rule is applied.
- **Default:** yes. Anyone who holds a privileged role in **any** organisation (Super admin, Admin, or a
  custom role holding a permission marked privileged in §7.6) is held at "Protect your account", with
  no "Skip for now", until a factor exists. The rule is evaluated on every request against the
  organisation the request targets and every organisation the person belongs to, and at the moments an
  invitation to a privileged role is accepted and a role edit adds a privileged permission. Everyone
  else may skip, but every step-up action refuses them until they add a factor.
- **Alternatives:**
  - Staff only: the old product's optional factor for developers.
  - Every developer.
  - The active organisation only (the first draft), which lets an Admin elsewhere act with a mailbox
    session if a route takes the organisation from the request.
- **Rationale:** an organisation's admins can mint Production keys, move money and change the team. R6's
  words fit them as well.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### SA-06 Passwords in the dashboard
- **Decision:** whether the developer realm keeps email-and-password sign-in.
- **Default:** keep it, because the canvases draw it. Under these rules:
  - passwords are hashed with argon2id ([SA-07]);
  - common passwords are refused;
  - an address pauses after repeated wrong passwords;
  - a password alone never enrols a first factor.
- **Alternatives:** passkeys, emailed codes and Google only. That is a smaller surface with no
  password storage, but the password boards go.
- **Rationale:** dropping passwords later is cheap. Dropping them now changes screens before
  Saturday.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### SA-07 Password hashing
- **Decision:** argon2id through Node's built-in `crypto.argon2` (m = 19,456 KiB, t = 2, p = 1, a
  32-byte tag, PHC strings), wired through Better Auth's hash hooks. SP-02 measures its time on a
  Railway vCPU.
- **Default:** as stated.
- **Alternatives:**
  - the library's default scrypt;
  - a native argon2 package, which is a new dependency with an install script.
- **Rationale:** it meets OWASP's minimum argon2id profile, with no new dependency.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-08 Step-up: windows and intents
- **Decision:** what a "fresh second factor" means on the server.
- **Default:**
  - **An intent** for every action that mints a credential or moves money, in both realms: keys,
    members and invitations, roles, staff and staff roles, factors, recoveries and resets, webhook
    endpoints and their secrets and URLs, beneficiaries, transfers, go-live decisions and the kill
    switches. The server stores the session, the user, the action and a digest of its parameters for 5
    minutes; the ceremony completes that intent; the proof is used once, by the matching action.
  - **A transfer's intent binds its amount, currency, beneficiary and source**, from the first money
    merge on Monday.
  - **The 5-minute window** for reveals only ("Show details", documents, a full bank number).
- **Alternatives:** the 5-minute window for everything (the first draft: after one harmless "Show
  details", script in the page could mint a Production key, invite an Admin and add a beneficiary
  with no further prompt); the window now and per-transfer proofs only before live money.
- **Rationale:** the old staff flow bound its code to the exact change; intents restore that binding
  for every credential and every payment.
- **Status:** Decided by the owner (step-up checked on the server within 5 minutes, AGENTS.md); the
  intent binding is Recommended, and stricter · **Deadline:** before Saturday's start

### SA-09 The endpoint allowlist
- **Decision:**
  - Each realm's mounted endpoints are listed as `public`, `session`, `step_up_self`, `step_up_org`
    or `blocked`, and matched exactly before the router.
  - Anything unlisted answers 404.
  - A test fails when an upgrade adds a path.
  - Moving an endpoint out of `blocked` needs the owner's approval.
  - The library's GET routes that act on a token (`/verify-email`, `/reset-password/<token>`) stay
    blocked: Fin's emailed links open a static page, which posts the code ([SA-35]).
- **Default:** as stated (§7.5).
- **Alternatives:** none.
- **Rationale:** an upgrade can mount new endpoints, so each new sign-in endpoint is a decision.
- **Status:** Decided by the owner (a standing rule in AGENTS.md), carried · **Deadline:** decided

### SA-10 Fin owns organisations and roles
- **Decision:** organisations, members, invitations, roles and permissions are Fin's own tables and
  code, not Better Auth's organisation plugin.
- **Default:** as stated.
- **Alternatives:** the organisation plugin with dynamic access control, as in the old product.
- **Rationale:**
  - Step-up and audit sit on every membership change, in one place.
  - The staff realm needs the same engine.
  - The plugin had advisories in 2026.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-11 The dashboard's permission catalogue
- **Decision:**
  - The dashboard's 26 permissions in 9 groups: the 22 the owner approved as designed on 19 Nov, plus
    the 4 money permissions added on 20 Nov, with the 20 Nov wording.
  - The built-in Super admin and Admin roles. Up to 30 custom roles.
  - The privileged mark used by [SA-05], and the step-up kind of each permission (§7.6).
- **Default:** no new prebuilt dashboard roles. The Saturday browser test that checks a lesser member
  uses a custom read-only role made in the test.
- **Alternatives:** presets such as "Developer" or "Read only" (the draft's EQ-06).
- **Rationale:** the roles stay as designed. R6 asks for prebuilt roles in Fin Admin, not in the
  dashboard.
- **Status:** Decided by the owner, 19 Nov 2026 (organisation roles as designed), carried. "No new
  prebuilt roles" is Recommended · **Deadline:** decided

### SA-12 Fin Admin's permission catalogue and prebuilt roles
- **Decision:** Fin Admin's permissions, prebuilt roles and custom staff roles (R6: as granular as the
  dashboard's).
- **Default:**
  - The 26 permissions in §7.6: the first draft's 23, plus `staff.reset_factors`, `accounts.recover`
    and `switches.manage`.
  - Prebuilt Viewer, Compliance, Operator (with `switches.manage`) and Admin roles; custom staff roles
    allowed.
  - Admin-only: `staff.role`, `staffRoles.manage`, `staff.reset_factors`, `accounts.recover`.
  - The old three roles map onto these without widening anyone's access.
- **Alternatives:**
  - Five presets (Viewer, Analyst, Approver, Compliance lead, Admin), as in the phase-1 onboarding
    notes.
  - Prebuilt roles only, with no custom roles.
- **Rationale:** granular enough for R6, and small enough to review.
- **Status:** OWNER MUST DECIDE (names and sets) · **Deadline:** before Saturday's start

### SA-13 Staff changes need a step-up intent only
- **Decision:**
  - Adding, removing or changing staff and staff roles needs the permission and a step-up intent.
  - There is no emailed code, and no approvals (two-person approval comes with [SA-39] when the team
    grows).
  - Nobody changes their own role, and nobody acts on someone who outranks them ([SA-32]).
- **Default:** as stated. The Fin Admin canvas's code step goes from the board.
- **Alternatives:** keep the emailed code that the canvas still draws.
- **Rationale:** the owner's 19 Nov answers: "keep it simple", with the guards.
- **Status:** Decided by the owner, 19 Nov 2026 · **Deadline:** decided

### SA-14 Resetting a staff member's factors
- **Decision:** how a staff member who has lost every factor gets back in.
- **Default:**
  - An Admin with `staff.reset_factors` and a step-up intent resets the member's factors; the member's
    sessions end; the member is pending again, with no permission.
  - The reset shows the Admin a new enrolment code to hand over out of band ([SA-29]); at the next
    sign-in the member registers a factor with the emailed code and the enrolment code within 30
    minutes.
  - The reset is audited and emailed to the member and to every Admin.
  - The last Admin is reset through `pnpm fin staff bootstrap`, with a recorded reason.
- **Alternatives:** only the operator, through `pnpm fin`; backup codes for staff.
- **Rationale:** R6 makes the factor mandatory, so recovery is needed, and it must never be
  self-service or rest on a mailbox alone. The first draft had no permission for it in the catalogue.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### SA-15 Staff sign-in methods
- **Decision:**
  - Two layers. Cloudflare Access decides who reaches Fin Admin. Fin Admin's staff realm then signs
    staff in with one of:
    - a discoverable passkey on its own, which reaches `aal2` by itself;
    - an 8-digit code, emailed only to addresses on the staff list, for enrolment and as the fallback,
      always followed by a passkey or authenticator;
    - Google, through an internal client of the company's Workspace, with the domain checked: built,
      but off until the client exists.
  - The Access identity and the staff session must be the same person on every request.
  - Staff sessions are shorter than developers'. Staff see their sessions and can sign out everywhere.
- **Default:** as stated (§7.1, §7.2). A drill proves Fin Admin sign-in works with email disabled.
- **Alternatives:** the emailed code before every sign-in (the first draft: an email outage would lock
  staff out of the tool they need in the incident).
- **Rationale:** the owner's 19 Nov answer on Fin Admin's own sign-in, made independent of the email
  vendor.
- **Status:** Decided by the owner, 19 Nov 2026, carried; passkey-alone sign-in is Recommended ·
  **Deadline:** before Saturday's start

### SA-16 What a role cannot open is hidden
- **Decision:**
  - Navigation hides what a role cannot open.
  - Actions a role cannot take are shown disabled, with the reason.
  - The server refuses either way.
- **Default:** as stated.
- **Alternatives:** show everything and refuse on use.
- **Rationale:** quiet screens, and the server stays the check.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-17 Customer decisions step up
- **Decision:** in Fin Admin, approving, unapproving and rejecting customers and people
  (`customers.decide`) needs a step-up intent. Request-for-information actions do not.
- **Default:** as stated.
- **Alternatives:** no step-up for customer decisions, as in the old product.
- **Rationale:** a customer decision gates money movement.
- **Status:** Recommended · **Deadline:** Sunday

### SA-18 The API key format
- **Decision:** a key is `fin_<test|live>_<sk|rk>_` followed by three parts:
  - a 10-character Crockford key ID;
  - a 32-character base62 secret;
  - a 6-character base62 CRC-32 checksum over a short per-deployment salt and everything before it.

  `sk` is full access and `rk` is restricted.
- **Default:** keep `sk` and `rk`. The canvas draws keys without them, and the console shows "Full
  access" or "Restricted · n scopes".
- **Alternatives:** keep the kind only in the key record, as the canvas looks.
- **Rationale:**
  - With the kind in the key, the docs panel, secret scanners and developers can see what a leaked
    key can do.
  - The salt is the owner's D56.
- **Status:** Decided by the owner, 19 Nov 2026 (the salt, was D56). Keeping `sk` and `rk` is OWNER
  MUST DECIDE (a confirmation) · **Deadline:** before Saturday's start

### SA-19 Key checks at the edge, with load shedding
- **Decision:**
  - Load shedding first, before any database work: per-replica token buckets per address and in all,
    and a local filter of key IDs recently found not to exist. It refuses work; it never decides about
    a person.
  - Then the edge reads the narrow `keys.key_lookup` view on every request, with no positive cache, so
    a revocation takes effect at once.
  - The edge's pool is 8 per replica, with its own alert on waiting clients; a Cloudflare rule on
    refused-key rates in production where the plan allows; the flood is in the performance gate with a
    pass number.
- **Default:** as stated (§7.7, §13.6).
- **Alternatives:** D12's option A, a published table with a 30-second cache, which was built for
  Workers KV; no shedding (a modest botnet with well-formed keys could hold the pool and, because the
  limiter fails closed, stop the API for everyone: the checksum salt is public).
- **Rationale:** there is no KV to imitate, and one indexed read in the same region is cheap, as long as
  floods never reach it.
- **Status:** Recommended. This changes D12, which the owner approved on 19 Nov with the direct read
  "later" · **Deadline:** before Saturday's start

### SA-20 The longest overlap when rolling a key
- **Decision:** how long an old key keeps working after a roll.
- **Default:** now, 1 hour or 24 hours, and never longer than the old key would have lived. The old
  7-day option is dropped.
- **Alternatives:** keep 7 days.
- **Rationale:** a replacement never gets more than what it replaces, and a short window bounds a
  leaked key's life.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### SA-21 GitHub's secret scanning partner programme
- **Decision:** whether Fin joins the programme, so that a key pushed to any public repository is
  reported to `api.<zone>/hooks/github/secret-scanning` (F19).
- **Default:**
  - Join before production holds live keys, with one pattern per mode.
  - The edge verifies GitHub's signature with GitHub's key set, cached and refreshed at most once per
    interval whatever identifier arrives, limits the route per address, checks each token's checksum
    and HMAC, and calls `api`'s key-revoke door with the key ID alone. `api` revokes a live key at
    once. The pepper stays off `api`.
  - The repository never holds a key-shaped string with a valid checksum.
- **Alternatives:** rely on developers to report leaks.
- **Rationale:** a public key format invites copies in public code; the first draft had `api` verify
  an HMAC whose pepper it does not hold.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### SA-22 Secrets
- **Decision:**
  - `pnpm fin` generates every secret and escrows it first, then sets it as a sealed Railway
    variable on the services listed (§7.8) and nowhere else.
  - Fin never stores operator credentials. They are given at the secure prompt.
  - The scrubbers know every secret's shape.
- **Default:** as stated.
- **Alternatives:** none.
- **Rationale:** the secrets rules in AGENTS.md and "assume variables leak".
- **Status:** Decided by the owner (standing rules, 19 Nov), carried · **Deadline:** decided

### SA-23 Signed calls between services
- **Decision:**
  - Every internal call carries `Fin-Caller-Signature: v2`: an **Ed25519** signature (from
    `node:crypto`) over the request's parts, the body hash, **the callee as audience** and a nonce,
    valid for ±60 s. The caller holds its private key; callees hold public keys only.
  - Door operations that are not idempotent keep a replay table of nonces for the window.
  - The door matrix (`packages/server/src/doors/matrix.ts`) lists every caller, callee and operation
    with its checks, including `payments` to `api`'s holder door, `edge` to `api`'s key-revoke door,
    and every inbound provider hook with its secret and limit. It is a tested file like the grant
    matrix; anything not in it is refused.
  - Keys are per caller, versions `n` and `n-1` accepted, rotated by two ordered deploys.
- **Default:** as stated (§7.9).
- **Alternatives:** HMAC keys held by caller and callee (the first draft: every verifier could pose as
  that caller to every other verifier, and a call signed for one door replayed at another); private
  networking alone.
- **Rationale:** carries D11 (edge and api apart, with signed calls), extended to every caller, so that a
  leak of any one service's variables cannot mint calls as another service.
- **Status:** Decided by the owner, 19 Nov 2026 (was D11: signed calls), carried; the asymmetric scheme
  and the matrix are Recommended · **Deadline:** before Saturday's start

### SA-24 `deliveryFetch` for URLs a person supplied
- **Decision:** the only way to call a URL that a person supplied.
  - It resolves the name and refuses the connection if any address is private, loopback, link-local,
    CGNAT, unique-local (including Railway's own range), documentation, multicast, or an embedded IPv4
    form; it connects to the address it checked.
  - It refuses IP literals, `localhost`, `*.local`, `*.internal` and Fin's own zones before resolving,
    with no exception (Fin's test endpoint is delivered in-process, [AP-20]).
  - https only, in both modes; ports 443 and 8443 only.
  - No redirects. 5 s to connect and 15 s in all. IPv6 egress is off.
  - Tests cover each range and port.
- **Default:** as stated (§7.11).
- **Alternatives:** a plain `fetch` with a hostname check, which DNS rebinding defeats; http allowed in
  Sandbox.
- **Rationale:** webhooks are a server-side request forgery path into Railway's private network, and an
  unwritten exception in the guard is how guards get holes.
- **Status:** Recommended · **Deadline:** Sunday

### SA-25 An interim style exception for the design system
- **Decision:** the first draft's `style-src-attr 'unsafe-inline'` exception and nonce'd bootstrap.
- **Default:** superseded twice. First by FW-C05 and FW-C06 ([FW-01]), which carried a style nonce to
  Radix through the `csp-nonce` meta. Then, overnight on 21 Nov, by [SA-45] and [UI-10]: every
  document is a static file with no nonce ([FD-17]), there is no Radix, and the UI SDK writes its CSS
  as constructed style sheets when the page carries a `csp-nonce` meta with no nonce, so
  `style-src 'self'` needs no exception. React sets inline sizes through the CSSOM. If FW-S1 finds a
  violation, the fallback is `style-src 'self' 'unsafe-inline'` with scripts unchanged (FW-X7), which
  the owner allowed at about 03:00.
- **Alternatives:** none needed.
- **Rationale:** the exception existed only for server-rendered style attributes, and nothing is
  rendered on a server.
- **Status:** Superseded, 21 Nov 2026 (by [FW-01], then by [SA-45]) · **Deadline:** none

### SA-26 Sumsub's selfie page
- **Decision:** only the selfie host loads Sumsub's WebSDK: `selfie.<hosted zone>`, served by an
  assets-only deployment of its own that holds only the selfie document, at `/s`, opened as
  `https://selfie.<zone>/s#<sft id>.<secret>` with a one-time ticket in the fragment ([FD-17]; spec 03
  §2.6, SD3-03). The page posts the ticket to `POST /api/selfie/session`, which redeems it once for
  the Sumsub SDK token and the host-only `__Host-fin-selfie.s` cookie; there is no `/test/` path. Its `_headers` policy allows Sumsub's exact script host (`https://static.sumsub.com`) and
  the exact frame and connection hosts SP-11 records, never a `*.sumsub.com` wildcard, with the camera
  and microphone allowed for that frame. Its own `/api/*` reaches verify's API through the public
  tunnel ([FD-18]). Every other page keeps the fixed policy ([SA-45]), and a test fails if any other
  document names a Sumsub host.
- **Default:** as stated ([SA-37]).
- **Alternatives:** the selfie on the verify host at a path carrying the link token (the first draft:
  Sumsub's script could read the token from the page).
- **Rationale:** the owner's exception of 18 Nov, kept to one origin that holds no link token. The
  owner's 03:00 decision keeps it: "verify's selfie page keeps its own Sumsub exception".
- **Status:** Decided by the owner, 18 Nov 2026, carried, and kept 21 Nov 2026, about 03:00; its own
  origin and deployment, and the ticket in the fragment (appendix C, SF-07), are Recommended ·
  **Deadline:** Sunday

### SA-27 A fast path for security releases
- **Decision:** whether security releases may skip the three-day release age.
- **Default:** yes, for Better Auth, TanStack Router, Hono, Vite and React (FW-Q5 merged here), with one
  exact-version exception per release. Each has the owner's yes and a dated comment, and is removed once
  the three days pass.
- **Alternatives:** always wait three days.
- **Rationale:** Better Auth supports only its newest release, and a fix can matter within hours.
  AGENTS.md allows exactly this shape of exception with the owner's yes.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday

### SA-28 Two accounts for staff who are also developers
- **Decision:** someone who is both staff and a developer has two separate accounts and passkeys,
  under different RP IDs.
- **Default:** as stated.
- **Alternatives:** link the accounts.
- **Rationale:** a developer session can never become a staff session.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-29 Staff enrolment codes
- **Decision:** what a new or reset staff member needs before a first factor registers.
- **Default:** an enrolment code that never travels by email: shown once to the adding or resetting
  Admin (or to the operator by `pnpm fin staff bootstrap`), handed over out of band, alive 30 minutes,
  stored hashed, single use and bound to that staff member; required with the emailed code; the
  account pending with no permission until a factor registers; every Admin emailed when it does; a
  passkey as the first factor in production.
- **Alternatives:** the emailed code alone (the first draft: one mailbox, or a reset followed by mailbox
  access, yielded a full `aal2` staff account with whatever role it was given).
- **Rationale:** R6's "adding someone needs a second factor" covers the adder; this covers the person
  added.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-30 Developer account recovery, and email changes
- **Decision:** what happens when a developer loses every factor, and whether the email address can
  change.
- **Default:**
  - No self-service removal of a factor by email, ever.
  - Recovery by another Super admin of the same organisation, with a step-up intent, a 72-hour wait and
    notices at the start and the end, only when the person belongs to that organisation alone; in
    every other case (the person belongs to another organisation too, or there is no other Super
    admin), by Fin staff holding `accounts.recover`, with an intent, a recorded identity check, the
    same wait and notices, and a second staff approver once two staff members hold the permission.
    The Super admins of every organisation where the person holds a privileged role are told at the
    start and may cancel during the wait; the recovery records its organisation. Every session ends
    and the person enrols again (refined by spec 02 S2-41, 21 Nov 2026: the account is global, so one
    organisation must not strip the factors that protect another).
  - Changing the email address stays blocked (`/change-email` in the blocked list). If it is opened
    later: an intent, confirmation from both mailboxes, notices to both, and every session ended.
- **Alternatives:** a support reset by email; email change through the library's default flow.
- **Rationale:** with factors mandatory for admins, an ad-hoc reset or email path would make the mailbox
  the only factor again.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### SA-31 Trusted browsers
- **Decision:** what "trust this browser" means.
- **Default:** never for anyone who holds a privileged role in any organisation or belongs to an
  organisation with Production access, and never for staff. Elsewhere: a server-side row (person,
  browser, created, last used), shown in Account security, for 30 days, revoked on any factor change,
  password reset, "sign out everywhere", role elevation and gaining Production access. Eligibility is
  re-checked on every request, so a row never outlives the condition that allowed it (spec 02 S2-40).
  A trusted-browser session is `aal1` and never writes a proof. The library's own trust cookie is not
  relied on.
- **Alternatives:** the library's 30-day signed cookie (the first draft), which cannot be listed or
  revoked.
- **Rationale:** a privileged member must never sign in with only an emailed code or a password.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-32 Who may act on whom
- **Decision:** the rules for acting on other people in both engines.
- **Default:** nobody gives a role holding a permission they lack, or changes their own role; an actor
  may change, remove or reset a person, or edit or cancel an invitation, only when both the target's
  current role and the new one are within the actor's permissions; nobody edits a role held by anyone
  who outranks them, or by themselves; the last holder of the top role stays; every team change takes
  the organisation's team-change lock and every staff change the staff-change lock; property tests,
  and a test with two concurrent demotions.
- **Alternatives:** the giving and last-holder rules alone (the first draft: a custom role with
  `member.role` or `staff.remove` could demote every Super admin but the last and end up strongest).
- **Rationale:** the old product refused when the target's role held a permission the actor lacked;
  that rule is carried.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-33 Credentials made or seen by someone who leaves
- **Decision:** what happens to keys and secrets when a member is removed or demoted.
- **Default:** list every API key and webhook signing secret the member created or was shown (Fin
  records who saw each secret); roll them by default, at once when the actor holds the permission
  that rolls the credential and otherwise with a 1-hour overlap, flagged for a Super admin (spec 02
  S2-42); write a
  revocation-journal entry; email the remaining Super admins and Admins; flag any key whose maker no
  longer holds the permissions behind its scopes.
- **Alternatives:** warn only, as the old product did; do nothing (the first draft).
- **Rationale:** a removed member who saw a full-access key or a webhook secret could keep using it, or
  forge signed events to the organisation's endpoint.
- **Status:** Recommended · **Deadline:** before Saturday's start (with API keys)

### SA-34 Edits that widen a credential
- **Decision:** which edits step up.
- **Default:** a step-up intent, an audit event and an email for changing a webhook endpoint's URL,
  editing a key (address allowlist, expiry, scopes), and changing, resending or cancelling a pending
  invitation; a key edit never grants more scope or life than the key had.
- **Alternatives:** step-up only on create and delete.
- **Rationale:** a new URL sends every signed event to a new receiver, and a wider key gives it more than
  it had: a replacement never gets more than what it replaces.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-35 One-time codes and factor replay
- **Decision:** the rules for codes, TOTP and passkeys.
- **Default:** one live code per address and purpose; at most 3 tries per code; codes hashed at rest; a
  sign-in link's landing page never submits by itself; a TOTP code accepted once per time step across
  sign-in and step-up (Fin keeps the last accepted step if the library does not); a passkey challenge
  used once; a signature-counter regression refused. SP-10's pin tests prove each on the installed
  version.
- **Alternatives:** the library's defaults, unpinned.
- **Rationale:** the old staff realm refused a reused TOTP step and a reused challenge in Fin's own
  code; moving staff to the library must not drop the property.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-36 Door operations declare their checks
- **Decision:** what a callee checks for itself.
- **Default:** every door operation declares its permission, step-up kind, mode, live requirement and
  quota in the door matrix, and the callee enforces them from its own read-only views with the
  database's time: live session, user, membership, permission, an unused intent or a fresh window; the
  staff session, the Access token and the proof for staff operations; live status, kill switches and
  daily quotas inside `payments`; for key-originated calls, the edge's assertion forwarded unchanged
  and the key record re-read by `payments`. Door volume is capped per calling service across
  organisations, with an alert. The threat model states the remaining limit.
- **Alternatives:** callees that trust the caller's assertion (the first draft for `payments`).
- **Rationale:** anything able to sign as the console could otherwise add a beneficiary and send money
  for any organisation, around the edge's quotas.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-37 Hosted links and the selfie host
- **Decision:** how the link token is kept out of URLs, logs and third-party scripts.
- **Default** (settled by spec 03 §2.4 to §2.6, its SD3-02 and SD3-03, which are recorded here):
  - A hosted link carries its token only in the URL fragment: `https://verify.<zone>/c#<token>` (a
    customer link), `/p#<token>` (a person's own link) or `/a#<token>` (an assisted link). The token
    is 32 Crockford base32 characters. There are no `/test/` paths: the link record carries the mode.
    The fragment never reaches Cloudflare, a log, a `Referer`, a link scanner's request or Sumsub's
    script, and no bearer value ever appears in a path.
  - On first open the static page ([FD-17]) reads the token, replaces its own address with the bare
    path before any other code runs, and posts the token to `POST /api/link/open`. `verify` exchanges
    it through `api`'s door for a link session and sets the host-only, HttpOnly, `Strict`
    `__Host-fin-verify.ls` cookie bound to that browser. Later calls carry the cookie only.
  - The link's life shortens to 24 hours after its first open; refill values return only to the
    browser that entered them.
  - The selfie step runs on its own origin, opened as `https://selfie.<zone>/s#<sft id>.<secret>`
    with a ticket that lives 10 minutes and is redeemed once at `POST /api/selfie/session` for the
    Sumsub SDK token and the `__Host-fin-selfie.s` cookie (15 minutes); the page receives nothing
    else ([SA-26]). Exact Sumsub hosts.
  - Logpush redacts the verify and selfie hosts' paths, with a test, as depth: they hold no bearer
    value.
- **Alternatives:** the token in every API path (the first draft, FW-C21's first form), where it lands
  in Cloudflare's logs and is readable by Sumsub's script on the selfie page; the token in the first
  path only (`/c/<token>`, Sandbox `/test/<token>`) exchanged at `POST /api/link-sessions` and then
  dropped from the address, which still sends it to Cloudflare and its logs on every first open.
- **Rationale:** the token is a 7-day bearer credential that can read back what the customer entered.
- **Status:** Recommended; spec 03's settlement folded in before the first commit (appendix C,
  SF-07) · **Deadline:** Sunday

### SA-38 Test seams never ship
- **Decision:** how the email sink, the Access stand-in, the provider stand-ins, relaxed limits and the
  controllable clock are kept out of what deploys.
- **Default:** two targets from one Dockerfile: `test` with the seams, refusing to start in staging or
  production, and `release` without them; a CI job starts every release image with each seam variable
  set and expects exit 78; release builds hard-code their allowlists (the Access issuer built from a
  team name, never a URL; the email provider Cloudflare only); a small smoke of real journeys runs
  against release images on staging.
- **Alternatives:** seams compiled out by markers alone, with e2e against the same image.
- **Rationale:** either the released image keeps seams a variable can switch on, or the tests do not
  exercise what ships; two targets give both.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-39 Staff insider controls
- **Decision:** what stops one staff member doing too much on their own.
- **Default:** a budget of reveals and document views per staff member per hour and per day, with an
  alert and a notice to every Admin when reached; once a second staff member exists, a second approver
  for approving go-live and for restoring Production access; the Access list compared with the staff
  table every hour, paging on any difference; removal from Fin first, then from the Access list, with
  the person's Access sessions revoked.
- **Alternatives:** audit alone.
- **Rationale:** audit tells you afterwards; budgets and a second approver stop it.
- **Status:** OWNER MUST DECIDE (the budgets and the second approver) · **Deadline:** Sunday

### SA-40 Sandbox and sign-up abuse limits
- **Decision:** what a stranger with a free Sandbox key can make Fin do.
- **Default:** in Sandbox, mail to customers and people only to confirmed addresses of the
  organisation's members (other mail shown in the console); daily mail budgets per organisation and per
  new account, tighter before go-live, with a breaker that keeps the security-notice share; a Sandbox
  document quota by count and bytes; webhook endpoints https only on ports 443 and 8443, proven by a
  challenge before they are enabled, with a delivery cap per target host across organisations; sign-up
  velocity limits by address and network from the first day.
- **Alternatives:** per-recipient limits only (the first draft), which let anyone burn the sending
  quota and reputation sign-in codes depend on.
- **Rationale:** anyone can sign up and mint a Sandbox key.
- **Status:** Recommended · **Deadline:** Sunday (sign-up limits Saturday)

### SA-41 Security notices are never dropped
- **Decision:** what happens when a security notice reaches its limit.
- **Default:** past the limit, notices fold into a digest that is still sent; a suppressed notice counts
  towards `security-email-unsent`; notices are ranked by what changed, so a Production key, a
  beneficiary and a member or role change bypass per-kind caps; an action that mints a credential is
  refused when its notice cannot be queued. Each has a test.
- **Alternatives:** a per-kind limit that drops (the first draft: five Sandbox keys would hide the
  Production key's email).
- **Rationale:** the notice that matters must never be the one dropped.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-42 Reports from browsers are untrusted
- **Decision:** how the envelope relay, the page-policy report endpoint and the docs failure endpoint
  treat what they receive.
- **Default:** parse and scrub on the server with the same scrubbers as server lines; allow only known
  item types and sizes; cap by address and in all with per-replica buckets (verify and docs hold no
  database login); alerts from these endpoints notify only, above a volume threshold.
- **Alternatives:** scrub in the browser and forward (the first draft), which the sender controls.
- **Rationale:** a stranger must not plant personal data in Better Stack or page anyone at will.
- **Status:** Recommended · **Deadline:** before Saturday's start

### SA-43 Cookies: host-only, the session Strict, the rest Lax
- **Decision:** the attributes of every cookie Fin sets in a browser, and the Better Auth settings that
  produce them.
- **The owner's decisions:** about 03:10: "Cookies are host-only `__Host-` on each app host: `Secure`,
  `HttpOnly`, `Path=/`, the session cookie `SameSite=Strict`, and the OAuth state cookie `Lax`." About
  03:50: "Cookies are host-only `__Host-` on the app host: the session cookie Strict, every other auth
  cookie Lax."
- **Default:**
  - Every cookie is host-only on its app host and `__Host-` prefixed: `Secure`, `HttpOnly`, `Path=/`,
    no `Domain`, never `SameSite=None`, never `Partitioned`.
  - The session cookie is `SameSite=Strict`. Every other auth cookie is `Lax`: the OAuth state, the
    passkey challenge, the first-factor and second-factor steps, and Fin's browser markers. Some of them
    are read on Google's return, a cross-site top-level navigation, where a Strict cookie is not sent.
  - Prefixes per realm: `__Host-fin.*` on the console, `__Host-fin-admin.*` on Fin Admin,
    `__Host-fin-verify.*` on verify and `__Host-fin-selfie.*` on the selfie host. Verify runs no
    Better Auth and sets exactly two cookies of its own, both `Strict`: the link session
    `__Host-fin-verify.ls` and the selfie session `__Host-fin-selfie.s` ([SA-37]; spec 03 §2.4).
  - Better Auth, per realm: `baseURL` is the app's own origin as a fixed string, never taken from
    `Host`; `basePath` is `/api/auth`; `trustedOrigins` is set explicitly to `[<app origin>]` (the
    console's is `["https://console.<zone>"]`), never left empty for the library to trust `baseURL`
    alone; `cookiePrefix` as above with `useSecureCookies: false` and
    `defaultCookieAttributes: { secure: true }`, so no `__Secure-` sits in front of `__Host-`;
    `cookies.session_token.attributes.sameSite` is `"strict"`, and
    `defaultCookieAttributes.sameSite` is never set; `crossSubDomainCookies` is never set; the
    origin and CSRF checks are on; the OAuth state is stored in the database; the passkey `rpID` is the
    app's host and its `origin` the app's origin. The service refuses to start if
    `BETTER_AUTH_TRUSTED_ORIGINS` is set. Google's redirect address is
    `https://<app host>/api/auth/callback/google`.
  - The session cookie also rides every static request to the app host. Cloudflare's static serving
    ignores it, and no log keeps cookies ([FD-08]).
  - Fin sets no theme or sidebar cookie: the browser remembers those ([UI-13]).
  - Accepted side effect: a Google sign-in in a browser that already has a session opens the person's
    first organisation, because the Strict cookie is not sent on Google's return. If Google
    re-authentication ever becomes a step-up, the session cookie moves to `Lax`; no CSRF layer depends
    on Strict.
  - A configuration test asserts that every cookie the app sets starts with `__Host-` and has no
    `Domain`, that the session cookie is Strict, and that the state cookie is Lax. It also reads the
    trusted origins the built instance actually uses (the resolved set in the installed library's
    context, whose field name is read from its source) and asserts that the set is exactly the app's
    origin; under [FD-18]'s fallback, exactly the app's origin and the API host's.
  - Under [FD-18]'s fallback the same cookies are set by the API host, and `baseURL` is the API host;
    the passkey `rpID` and `origin` stay the page's, and every callback address is an absolute address
    on the page's host.
- **Alternatives:** every cookie `Lax` (FW-C09's first form); `Domain=<zone>` cookies shared across
  hosts, which any sibling host could then read or plant.
- **Rationale:** a host-only `__Host-` cookie cannot be planted by a sibling subdomain, and a Strict
  session cookie stays off every cross-site request.
- **Status:** DECIDED (owner, 21 Nov 2026, about 03:10, kept and widened about 03:50), superseding
  FW-C09's all-`Lax` cookie line and [UI-05]'s cookies. The Better Auth settings and the test are
  Recommended · **Deadline:** decided

### SA-44 CSRF: the layers on every unsafe request
- **Decision:** how an app's API refuses a request that its own page did not make.
- **The owner's decision (about 03:50):** "CSRF is covered by an exact Origin check, Sec-Fetch-Site,
  the X-Fin-App header and JSON-only bodies, plus Better Auth's origin check with exact
  trustedOrigins." (About 03:10: "an Origin check plus a custom header, on top of SameSite".)
- **Default:** a Hono middleware ahead of Better Auth and every route checks every unsafe request
  (POST, PUT, PATCH, DELETE), in this order, failing closed:
  1. `Origin` must equal the app's origin exactly; a missing or `null` `Origin` is refused.
  2. `Sec-Fetch-Site`, when present, must be `same-origin`.
  3. `X-Fin-App: <app>` must be present. Forms cannot set headers.
  4. A body must be `application/json`, except on named upload routes (`multipart/form-data`); a
     body-less POST, such as sign-out, carries no content type.

  A refusal answers 403 `invalid_origin` and writes one `csrf.refused` line with the reason and the
  route pattern. Better Auth's own origin check, with exact `trustedOrigins`, runs underneath. The only
  exemption is `GET /api/auth/callback/google`; `POST /api/auth/callback/*` is refused. Every API
  answer sets `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. An app's API sends no
  CORS headers. Hono's `csrf()` is not relied on. Each refusal reason has a unit test, and Playwright
  proves that a cross-site POST and a POST from a sibling host are refused.

  **GETs.** The gate skips GET, and a sibling page on the same site can make a GET that carries the
  `Strict` session cookie, so a GET never changes state, except the token-bound auth GETs and the
  redeeming of a single-use URL that a gated POST minted (Fin Admin's document view, spec 03 §12.2,
  SD3-17). No GET route declares an audit event, a budget or a step-up intent: what is audited or
  counted happens at the gated POST. A GET that redeems a minted URL declares
  `fetchSite: "same-origin-or-none"`: `Sec-Fetch-Site` must be present and `same-origin`, or `none`
  (the URL opened directly in a tab); anything else is 403 `invalid_origin` with reason `fetch_site`.
  The route-policy test (FW-C07) fails on a GET that declares `audit`, a budget or an intent, and on
  a redeeming GET without `fetchSite`.

  Under [FD-18]'s fallback the API also answers CORS for exactly the page's origin, with credentials,
  the listed methods and headers and a `maxAge` of 7200, and step 2 accepts `same-site` instead. A
  redeeming GET then accepts `same-site` too; it stays harmless, because the audit event and the
  budget sit at the POST and the minted URL is bound to the session that minted it.
- **Alternatives:** Better Auth's origin check alone, which accepts a request with `Referer` but no
  `Origin`; SameSite alone, which does nothing against a sibling subdomain.
- **Rationale:** sibling hosts are same-site, so SameSite cannot stop them. These layers are the
  defence, and SameSite is depth.
- **Status:** DECIDED (owner, 21 Nov 2026, about 03:50; the Origin check and the custom header since
  about 03:10). The order, the refusal answer and the tests are Recommended · **Deadline:** decided

### SA-45 The page policy from a static `_headers` file
- **Decision:** the content security policy and the other security headers of every page, now that no
  server writes the pages ([FD-17]).
- **The owner's decision (about 03:00, kept about 03:50):** "Security headers, including the CSP, come
  from a static `_headers` file per app, so they can be ported to any host: `script-src 'self'` with no
  inline script; the style policy as the framework verdict allows (FW-X7 fallback: `'unsafe-inline'`
  for styles only); verify's selfie page keeps its own Sumsub exception."
- **Default:**
  - Each app's `_headers` gives every document `default-src 'none'; script-src 'self'; style-src
    'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src
    'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self';
    frame-ancestors 'none'`, with `Strict-Transport-Security` at the exact value for the zone's class
    (ARCHITECTURE §5.8: `includeSubDomains; preload` on the admin and hosted zones, which are
    submitted to the preload list; `includeSubDomains` without `preload` on the main and staging
    zones, because `api.` must stay reachable over plain http for [FD-03]), `X-Content-Type-Options: nosniff`, a
    `Referrer-Policy` (`no-referrer` on verify and the selfie host), a `Permissions-Policy` and
    `Cross-Origin-Opener-Policy: same-origin`. API answers keep `default-src 'none';
    frame-ancestors 'none'`.
  - No inline script, no inline handler, no `eval`. The theme is set by an external `/theme.js`
    ([UI-13]).
  - Styles: `style-src 'self'` with no nonce. Each `index.html` carries `<meta property="csp-nonce">`
    with no `nonce` attribute, so the UI SDK adopts constructed style sheets, which no policy blocks;
    each app's stylesheet starts with `@layer ui-sdk;`. React sets inline sizes through the CSSOM, and
    no code calls `setAttribute("style")`. FW-S1 proves it; if it finds a violation, FW-X7's fallback,
    `style-src 'self' 'unsafe-inline'` for styles only, applies. Scripts stay `'self'` either way.
  - Listed exceptions only: the docs site's `connect-src` adds `api.<zone>` for Try it ([AP-10]); the
    docs site's `style-src 'unsafe-inline'` and `img-src data:` for Scalar's run-time styles and
    images, in the `docs` profile alone and only once the owner's yes is recorded under [AP-11]
    (spec 05 §8.11); the selfie document adds Sumsub's listed hosts ([SA-26]); a page with Turnstile
    adds Turnstile's host if [FD-06] says yes; verify's `hosted` profile adds `img-src 'self' blob:`
    for the local preview of a photo the customer picked (spec 03 §2.2, SD3-04). Fin Admin's document
    viewer needs no exception: its images and PDFs load from a single-use same-origin URL under
    `img-src 'self'` (spec 03 §12.2, SD3-17), so Fin Admin's policy has no `blob:` and no
    `frame-src`. The docs exception is not FW-X7's fallback, which the owner's 03:00
    words accepted for every app if FW-S1 fails; those words do not cover `data:`, so the docs
    exception needs a yes of its own.
  - One source per profile: every app's `_headers`, the docs site's included, is rendered from its
    profile in `packages/web-host/src/static/` (spec 01 §7.4); no app holds a second headers file.
    The header-matrix test (FW-C05) renders every profile and refuses any other origin, any
    `unsafe-*`, `data:`, `blob:` or `ws:`, except each listed exception in its own profile and
    directive: `'unsafe-inline'` only in the docs profile's `style-src` (or in every `style-src` once
    FW-X7 is recorded), `data:` only in the docs profile's `img-src`, `blob:` only in the `hosted`
    profile's `img-src`.
  - Reports go to the app's own `/api/` report endpoint ([SA-42]); the docs host has none, so its
    pages report to the edge (spec 05 §8.13).
  - A Playwright fixture fails any test on a `securitypolicyviolation`, run against the built files
    with the production `_headers`.
- **Alternatives:** a per-request nonce (needs a server for every document); `'unsafe-inline'` styles
  from the start (the old product's level, kept as the fallback).
- **Rationale:** a static file can be served by any host; the UI SDK's constructed sheets make the
  strict style policy possible without a nonce.
- **Status:** DECIDED (owner, 21 Nov 2026, about 03:00, kept about 03:50). The nonce-less meta and
  `style-src 'self'` as the first try are Recommended; the docs exception waits for [AP-11]
  (appendix C, SF-08) · **Deadline:** decided

## 6. Audit

### AU-01 What R9 covers
- **Decision:** how far "everything completely audited" goes.
- **Default:** an audit row for each of these:
  - every write by any actor: a developer, an API key, a customer or person on a hosted link, staff,
    the operator, or the system;
  - every reveal of personal data, documents or bank numbers, including API reads of a virtual
    account's full deposit instructions;
  - every sign-in, sign-out and session change, and every change to a sign-in method;
  - every important action in AGENTS.md's sense.

  These are log lines rather than audit rows: list reads, key checks at the edge, and provider calls
  (their state changes are audited). The operator's SQL and the platforms' own changes are covered by
  [AU-08] and [AU-09].
- **Alternatives:** an audit row for every read too: a row per list view.
- **Rationale:** R9 asks for a trail of actions and disclosures. Reads that disclose nothing are logged,
  not chained. (It was EQ-22 in the draft.)
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### AU-02 The audit chain, enforced by the database
- **Decision:**
  - `audit.event` is append-only. Rows are inserted only through `audit.record()`, a `SECURITY
    DEFINER` function owned by `fin_owner`, which stamps the database login, `application_name`,
    backend PID, transaction ID and server time into the hashed row and checks the event name against
    a per-role allowlist.
  - Deferred constraint triggers on the critical tables (members, roles, staff, proofs and intents,
    keys, live status, approval columns, beneficiaries, transfers, ledger entries) refuse a commit with
    no audit row from the same transaction.
  - Ledger entries are append-only by trigger, and a daily ledger head is anchored beside the audit
    head.
  - No lock on the write path: rows are inserted unchained, and one sequencer in the worker gives
    `seq` and hashes in a fixed order each second; append-only triggers protect unchained rows; an
    alert fires when rows wait too long; audited writes are load-tested at launch traffic.
  - Staff decisions are audit events with structured metadata. There is no separate decision table.
- **Default:** as stated (§8.2, §8.3).
- **Alternatives:** the first draft: chaining under a lock on `audit.head` in every audited
  transaction, with D47's revocation of advisory-lock functions. Any login could still stall every
  audited write by holding its transaction open (per-role timeouts are settings a session may change
  for itself), and the guarantee lived in application code.
- **Rationale:** a leaked service login, which the plan assumes, must not be able to change a critical
  table without a trail or to name another actor unnoticed, and no session should be able to stall
  sign-ins, role changes and money writes.
- **Status:** D47's intent (no service login can stall audit writes) was decided on the owner's
  delegation, 19 Nov 2026; this mechanism replaces D47's and is Recommended · **Deadline:** before
  Saturday's start

### AU-03 Write-once audit heads outside the database
- **Decision:**
  - Each minute that the chain moved, the worker writes a write-once head to the R2 audit bucket
    (`If-None-Match: *`, with the head hash in the name).
  - Each head also goes to Better Stack as an `audit.head` line.
  - The chain is verified every hour.
  - The bucket lock is one year in staging. Production's lock is the open part.
- **Default:** Indefinite in production.
- **Alternatives:** a fixed lock, such as 7 years.
- **Rationale:**
  - There are two outside witnesses.
  - The watcher's inventory covers R2's limit: a lock can be lifted by whoever edits the bucket.
- **Status:** OWNER MUST DECIDE (open since 19 Nov, was D10) · **Deadline:** production

### AU-04 The revocation journal and restore markers
- **Decision:**
  - Every action that removes access also writes a write-once journal object, with IDs and the time
    only.
  - Before a restored database serves, a restore writes a marker, then:
    - ends every session;
    - replays credential removals;
    - prints the entries that shift control, for the owner to confirm;
    - re-applies erasures;
    - re-anchors the chain.
  - Production refuses a reset.
- **Default:** as stated (§8.5).
- **Alternatives:** restore without replay. A revoked key or a removed member would come back.
- **Rationale:** a restore must never undo a revocation.
- **Status:** Recommended · **Deadline:** before Saturday's start

### AU-05 Better Stack's audit-log add-on
- **Decision:** whether to buy Better Stack's own audit log.
- **Default:** no at launch. Revisit when a second person gets access. Until then, the controls are the
  daily drift check of the monitoring configuration and the daily canary alert that must arrive
  ([OB-17]), which shows within a day if the pager was silenced.
- **Alternatives:** buy it, for about 208 to 250 USD a month; check Better Stack's configuration hourly
  (needs a standing token that can read ingest tokens).
- **Rationale:** with one person holding access, a drift check and a canary find the same changes.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### AU-06 Exporting Railway's audit log
- **Decision:** where the export of Railway's workspace audit log runs, and with which credential. The
  log is kept for 30 days on Pro, and only admins can read it.
- **Default:** weekly, from the operator's machine through `pnpm fin verify`, to the ops bucket, with
  the token given at the secure prompt; daily, from an online job, once a credential exists that can
  read it and cannot deploy ([OB-11]). An incident exports it at once ([OP-02]). Deployment events
  also reach Better Stack in real time.
- **Alternatives:** a daily export from an online job with a standing token that can deploy.
- **Rationale:** a weekly run fits inside the 30 days and needs no standing token; real-time deployment
  events cover the worst case between exports.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### AU-07 Security emails for every access change
- **Decision:** every action that changes access sends its security email as well as writing its event
  (§8.7). Each email comes from the security sending subdomain, uses Fin's own words with typed values
  only in labelled boxes, and is held to the per-recipient limits, past which it folds into a digest
  and is never dropped ([SA-41]).
- **Default:** as stated.
- **Alternatives:** none.
- **Rationale:** "people are told when access changes".
- **Status:** Decided by the owner (a standing rule in AGENTS.md), carried · **Deadline:** decided

### AU-08 Privileged access to the database
- **Decision:** how `fin_owner` and the operator's sessions are audited.
- **Default:** `fin_owner` has no standing password: each registered run sets one with `VALID UNTIL` the
  end of the run; `ops.privileged_login` is owned by the superuser, append-only and also written as a
  log line; every statement by `fin_owner` and `fin_readonly` is logged by Postgres
  (`log_statement = 'all'` set per role); `pnpm fin db` keeps a statement transcript in the ops bucket.
- **Alternatives:** a standing `fin_owner` password in the migrate service's variables (the first
  draft), with the privileged-login table owned by the login it watches.
- **Rationale:** the operator's SQL was recorded only as a login.
- **Status:** Recommended · **Deadline:** before Saturday's start

### AU-09 Audit outside the application
- **Decision:** what watches the platforms' own changes.
- **Default:** the watcher hashes the GitHub ruleset, repository settings, environments, collaborators,
  deploy keys and Actions settings hourly with a read-only token and pages on change outside a
  registered run; the owner exports the account's security log weekly; the audit verifier lists every
  epoch and pages on any but the expected one in production; every opening of a sealed number is
  audited, by API too.
- **Alternatives:** the ruleset as the only control (the first draft).
- **Rationale:** the ruleset is the merge control, so a change to it must be seen.
- **Status:** Recommended · **Deadline:** before Saturday's start (the watcher's GitHub check in
  hardening)

## 7. Email

### EM-01 Cloudflare Email Sending through its REST API
- **Decision:**
  - Send through Cloudflare Email Sending's REST API: one `fetch` with a bearer token, behind
    `EmailPort`.
  - No SDK, and no Worker relay.
- **Default:** as stated (§9.2).
- **Alternatives:**
  - A Worker relay with the send binding: a second deploy path, and a second credential with the
    same power.
  - SMTP submission: a new dependency.
- **Rationale:** R3 names the vendor, and the REST path adds the least.
- **Status:** Decided by the owner, 21 Nov 2026 (R3). The REST path is Recommended · **Deadline:**
  decided

### EM-02 Accepting Email Sending's beta terms
- **Decision:** Email Sending was still a public beta on 21 Nov. Staging uses it now (R3 names the
  vendor). Production email through it needs the owner's written acceptance of:
  - the beta terms;
  - the token-scope finding: the send permission also edits suppressions (§9.7).
- **Default:** the owner's signed acceptance, recorded in the ops bucket and in the plan.
- **Alternatives:** wait for general availability before production.
- **Rationale:** under R3, D30's gate ("production only if GA, or the owner accepts the beta in
  writing") becomes this acceptance.
- **Status:** OWNER MUST DECIDE (D30's production gate) · **Deadline:** production

### EM-03 A second sender
- **Decision:** whether a cold-standby second email adapter is built before production.
- **Default:** decide before production between a built, tested second adapter behind `EmailPort`,
  switchable by a setting (Postmark was the 19 Nov candidate), and a written acceptance that a
  Cloudflare withdrawal or account action stops every email until a new sender exists. Fin Admin no
  longer depends on email to sign in ([SA-15]).
- **Alternatives:** choose a vendor only, and build when needed (the first draft).
- **Rationale:** sign-in codes depend on one beta product.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### EM-04 Only the worker sends
- **Decision:**
  - Only `worker` holds the email token and sends.
  - Every other service calls `email.enqueue()` in its own transaction ([DA-14]).
  - Codes and security templates are claimed first, with a reserved share of concurrency and of a
    token bucket kept below Cloudflare's API-wide limit.
  - `email-outbox-age` alerts on how long codes and security rows wait.
  - A row with a one-time code is deleted once sent.
- **Default:** as stated (§9.4).
- **Alternatives:** each service sends its own mail.
- **Rationale:** one token, one place for limits and budgets. A burst of ordinary mail must never hold
  sign-in codes for the 5 minutes Cloudflare blocks a token after 1,200 calls.
- **Status:** Recommended · **Deadline:** before Saturday's start

### EM-05 Deliverability
- **Decision:**
  - Lean security templates, with `Auto-Submitted: auto-generated` and no `List-Unsubscribe`.
  - A separate security sending subdomain ([EM-08]).
  - Gmail Postmaster Tools, and a placement test.
  - DMARC moves from `none` to `reject` before production, after its aggregate reports are read.
- **Default:** as stated (§9.6).
- **Alternatives:** none open.
- **Rationale:** sign-in emails were landing in Gmail's Promotions tab.
- **Status:** Decided by the owner, 19 Nov 2026 (was D46), carried · **Deadline:** decided

### EM-06 Message preview off
- **Decision:** on the sending domain, Cloudflare's message preview and "drop suppressed recipients"
  are off. They are set by API and checked.
- **Default:** as stated.
- **Alternatives:** leave the defaults on.
- **Rationale:**
  - With preview on, every sign-in code would be readable in the dashboard for about 7 days.
  - With dropping on, a suppressed address fails silently.
- **Status:** Recommended · **Deadline:** before Saturday's start

### EM-07 Email monitoring from analytics
- **Decision:**
  - Every 5 minutes, read counts from Cloudflare's GraphQL analytics with a read-only token, never
    selecting addresses or subjects.
  - Alert on:
    - complaints;
    - failures;
    - DMARC failures;
    - a mismatch between Cloudflare's count and Fin's;
    - a setting change.
- **Default:** as stated (§9.8).
- **Alternatives:** per-message events through a Cloudflare Queue. They carry recipients and
  subjects.
- **Rationale:** counts are enough to page on, and they hold no personal data.
- **Status:** Recommended · **Deadline:** before Saturday's start

### EM-08 Sending subdomains and warm-up
- **Decision:** how Fin's mail streams are kept apart, and how production's reputation is built.
- **Default:** two sending subdomains per zone, each its own Cloudflare sending domain with its own
  suppressions and analytics alerts: `auth.` for codes and security notices, `notify.` for invitations
  and the white-labelled mail to developers' customers. Production's domains carry real low-volume mail
  for at least two weeks before launch, with Postmaster Tools verified and the placement test passing
  on production; the quota increase is asked for with the warm-up figures.
- **Alternatives:** one sending domain (the first draft), where customer complaints would hurt sign-in
  codes; the staging soak as the only warm-up.
- **Rationale:** the staging soak proves templates, not production's reputation.
- **Status:** Recommended · **Deadline:** production (the warm-up starts once [FD-10] is chosen)

## 8. Observability

### OB-01 Better Stack replaces Grafana and Sentry
- **Decision:** Better Stack covers:
  - logs, and metrics from logs;
  - dashboards and alerts;
  - error tracking through the Sentry protocol;
  - uptime monitors and heartbeats;
  - on-call, incidents and the status page.
- **Default:** as stated (§10).
- **Alternatives:** none under R5.
- **Rationale:** R5. It carries D8 and D9.
- **Status:** Decided by the owner, 21 Nov 2026 (R5) · **Deadline:** decided

### OB-02 Teams, region and AI features
- **Decision:**
  - One organisation with two teams, `fin-staging` and `fin-production`.
  - Team tokens per product, and no global token kept.
  - Data region `europe` for every source and Errors application.
  - Two-factor sign-in enforced.
  - Every AI feature off.
- **Default:** as stated (§10.1).
- **Alternatives:** none open.
- **Rationale:** D8. Its region name, `germany`, is now `europe`. AI features stay off because the
  sub-processor list names an AI vendor.
- **Status:** Decided by the owner, 19 Nov 2026 (was D8), carried · **Deadline:** decided

### OB-03 Fin's own log transport
- **Decision:**
  - Each process keeps one batch per unit of work and scrubs each line.
  - It writes the line to stdout, then after the response POSTs Better Stack's native JSON, gzipped.
  - The queue is bounded.
  - A failure is swallowed, leaving `telemetry.ship_failed`, and `telemetry.recovered` reports the
    gap.
- **Default:** as stated (§10.3).
- **Alternatives:**
  - `@logtail/*`: dependencies, and buffering of its own.
  - OpenTelemetry logs: a larger dependency tree.
- **Rationale:** Railway has no log drain, so the direct shipment is the record.
- **Status:** Recommended · **Deadline:** before Saturday's start

### OB-04 A thin error client
- **Decision:**
  - Servers use a thin client on `@sentry/core`, with no automatic instrumentation.
  - Browsers use `@sentry/react` through the app's own `/api/monitoring/envelope`.
  - A DSN is accepted only in Better Stack's shape.
- **Default:** as stated (§10.5).
- **Alternatives:** `@sentry/node`: automatic instrumentation and the OpenTelemetry tree.
- **Rationale:** one small dependency, and nothing leaves the page's own origin.
- **Status:** Recommended · **Deadline:** before Saturday's start

### OB-05 Monitoring as code
- **Decision:**
  - The configuration lives in `ops/monitoring/<env>/`.
  - `pnpm fin monitoring apply` is a Node script against Better Stack's APIs. It is idempotent by
    name, deletes what the files do not list, and refuses unsafe routing.
  - `monitoring:check` runs in `pnpm check`.
  - No Terraform, and no Better Stack identifier committed.
- **Default:** as stated (§10.11).
- **Alternatives:** Terraform with Better Stack's providers. Its state would hold ingest tokens and
  heartbeat URLs.
- **Rationale:** carries D9.
- **Status:** Decided by the owner, 19 Nov 2026 (was D9), carried · **Deadline:** decided

### OB-06 Who is on call
- **Decision:** production's responders.
- **Default:** production does not open with a single responder unless containment is automatic (the
  kill switches and their trips, [OP-01]), a written response target is met (acknowledge a page within
  15 minutes, day and night), and the owner accepts the bus-factor risk in writing; otherwise a second
  trained responder with a break-glass production role and a sealed escrow procedure (was D38). Either
  way, a weekly test page must be acknowledged and quiet hours never suppress a P alert. The roster
  itself is in the private overlay ([OB-13]).
- **Alternatives:** a single responder with no written target.
- **Rationale:** a money platform needs a stop within minutes at any hour, and an escalation step
  needs someone different to reach (the current roster's limits are in the threat model's private
  annex, spec 08 §2.5).
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### OB-07 Log retention
- **Decision:** how long Better Stack keeps logs.
- **Default:** 30 days in staging, 90 days in production, and errors for 90 days.
- **Alternatives:** longer production retention, at a cost.
- **Rationale:** lines hold IDs only, and 90 days covers an investigation.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### OB-08 No tracing at launch
- **Decision:** no distributed tracing and no OpenTelemetry SDKs at launch. Request IDs and the
  per-unit lines carry the correlation.
- **Default:** as stated. Revisit when a trace would answer a question that the lines cannot.
- **Alternatives:** OpenTelemetry tracing from the start.
- **Rationale:** fewer dependencies. On Bun it would not run at all.
- **Status:** Recommended · **Deadline:** production

### OB-09 A public status page
- **Decision:** whether production has a public status page at launch.
- **Default:** yes: `status.<hosted zone>` as a DNS-only CNAME to Better Stack, with no custom script
  and no analytics. It is never on the main or the admin zone: a host that another company serves
  would be same-site with the console and `api.`, could set `Domain` cookies for the whole zone, and
  would be a takeover target if the page were ever removed while the record stayed. Under
  [FD-10]'s single-zone alternative it takes a registrable domain of its own. The watcher's
  dangling-record check names its record, and the sibling-host CSRF tests include its host
  (ARCHITECTURE §5.2, §5.9, §7.12).
- **Alternatives:** no status page until there are customers.
- **Rationale:** developers can see an outage without asking.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### OB-10 Coding agents and Better Stack
- **Decision:** whether coding agents get a token or an MCP connection to Better Stack.
- **Default:** no standing token and no MCP connection. For an investigation, the owner gives a
  read-only token at the secure prompt, revoked afterwards.
- **Alternatives:** a standing read-only token for agents.
- **Rationale:** a read-only token can read ingest tokens and heartbeat URLs.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### OB-11 The watcher and its tokens
- **Decision:** where the watcher runs, which tokens it holds, and from when.
- **Default:**
  - A Cloudflare Worker on a minute cron ([OB-18] asks whether it may stay one), **live from the first
    staging deploy**: in the staging Cloudflare account for staging (decided on 19 Nov) and in a
    separate watch account for production.
  - Read-only tokens only: Cloudflare (including Tunnel Read), the vault inventory, a GitHub token that
    reads repository administration settings, and for Railway an account token of a dedicated user who
    holds only the project Viewer role, if SP-21 shows it can read domains and TCP proxies. Never a
    workspace or project token, because those can deploy.
  - It checks the connectors, the tunnel configuration, Railway domains and TCP proxies, the zone, the
    Access policy, Email Sending, the vault, Railway's deployment webhook and the GitHub settings. It
    also checks the static deployments: each has no script module and no binding, `workers_dev` and
    previews are off, and the zone's Workers routes match the map exactly, with no Worker on the
    `/api/*` routes ([FD-19]). Its Cloudflare token adds Workers Scripts Read and Workers Routes Read.
  - Railway's project webhooks for deployment events go to Better Stack, and a deploy outside a
    registered window pages, classified by digest.
- **Alternatives:** the watcher only before production (the first draft, which left staging's tunnels
  unwatched from Saturday to Monday); a workspace token in the watcher (rejected).
- **Rationale:** the watcher must stay standing after a compromise of what it watches, must hold nothing
  that can change it, and must watch the tunnels from the first day they exist.
- **Status:** OWNER MUST DECIDE (open since 19 Nov, was D26, D27 and D31; staging's placement was decided
  on 19 Nov) · **Deadline:** Saturday 12:00 (staging, before the first staging deploy); production (the
  watch account and the Railway user)

### OB-12 A production journey monitor
- **Decision:** whether a scripted sign-in journey runs against production.
- **Default:** yes. A Playwright journey runs every 15 minutes on a canary account with a read-only role,
  no organisation data and no Production keys. It notifies rather than pages.
- **Alternatives:** uptime monitors and the API canary only.
- **Rationale:** it catches a sign-in that renders but no longer works.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### OB-13 Private operating details
- **Decision:** what the public repository says about how Fin is run.
- **Default:** the rules only. The on-call roster, its time zone, quiet hours, escalation timings, the
  numeric thresholds of every alert, and the service objectives' numbers live in the private overlay;
  alert files name their thresholds and `pnpm fin monitoring apply` fills the values in.
- **Alternatives:** publish the thresholds and roster (the first draft did), which tells an attacker when
  to act and how to stay under each alert.
- **Rationale:** public repository, private operations (principle 12).
- **Status:** Recommended · **Deadline:** before Saturday's start

### OB-14 Health beyond `/health`
- **Decision:** what proves a service works, not just that it answers.
- **Default:** an `api-canary` monitor every minute from two regions (`GET /v4/whoami` with a restricted
  Sandbox key of a canary organisation, expecting 200); `dbOk` and `doorOk` in each `process.health`
  line, alerting when false; an absolute 5xx count beside the ratio; a success alert per scheduled duty;
  the clock offset against the database, alerting.
- **Alternatives:** `/health` and the 5xx ratio alone.
- **Rationale:** at launch traffic a broken pool or door keeps `/health` green and may never reach a
  ratio's minimum count.
- **Status:** Recommended · **Deadline:** before Saturday's start

### OB-15 Database and HA monitoring
- **Decision:** what the database probe watches.
- **Default:** every minute, as `fin_probe` (`pg_monitor` only): `pg_stat_archiver` (a page when no WAL
  has been archived for 5 minutes or failures rise, because pgBackRest drops WAL rather than halting);
  `pg_stat_replication` (`replica-missing`, `replication-lag`, `sync-standby-missing`); the timeline,
  for `failover-detected`, whose runbook is the audit failover procedure; long transactions;
  connections; size. `pnpm fin verify` reads Railway's PITR status. A PITR-gap runbook takes a manual
  base backup and records the gap.
- **Alternatives:** Railway's dashboards only.
- **Rationale:** the RPO claim depends on archiving that nothing watched.
- **Status:** Recommended · **Deadline:** before Saturday's start (the probe); production (the HA alerts)

### OB-16 Alert load and the apply guard
- **Decision:** how one responder is kept from alert fatigue, and how the apply script is kept from
  deleting production's alerts.
- **Default:** production rules evaluated in shadow on staging with a weekly "would have paged" count
  that must stay under an agreed number before production; `no-logs` alerts grouped and downgraded while
  the uptime monitors are green; each P alert's need and runbook reviewed at the production gate. The
  apply script prints the dry run first, refuses when the team name does not match the environment,
  refuses to delete more than a few objects without `--confirm-delete <count>`, and pauses heartbeats
  rather than deleting them.
- **Alternatives:** about 40 paging alerts with no measure (the first draft); an apply script that
  deletes whatever the files do not list.
- **Rationale:** an EU ingest delay at Better Stack would page every `no-logs` alert at once, and a
  wrong token or an empty file would delete production's alerts and change heartbeat URLs.
- **Status:** Recommended · **Deadline:** production (the shadow count); before Saturday's start (the
  apply guard)

### OB-17 The daily canary and the weekly test page
- **Decision:** how Fin knows the pager still works.
- **Default:** once a day a synthetic `canary.daily` line must arrive as a notification on the on-call
  phones; once a week a test page must be acknowledged; the watcher alerts if the canary did not
  arrive.
- **Alternatives:** an hourly check of Better Stack's configuration with a standing token.
- **Rationale:** a stolen Better Stack login could otherwise silence the pager for a week.
- **Status:** Recommended · **Deadline:** production

### OB-18 The watcher's form under the portability rule
- **Decision:** whether the watcher ([OB-11]) may stay a Cloudflare Worker, code on a minute cron,
  given the owner's "no vendor locked in items like workers" (about 03:00).
- **Default:** keep it a Worker, the one piece of Fin code that runs at Cloudflare. It is plain `fetch`
  calls on a cron with no Workers-only binding: its state goes to the vault through R2's S3 API, not a
  binding. It runs in the staging account for staging (decided on 19 Nov) and in a separate watch
  account for production. It holds no application traffic and no write credential, and it moves to
  any scheduled runner outside Railway without a rewrite.
- **Alternatives:**
  - a scheduled GitHub Actions workflow: a 5-minute minimum and best-effort timing, so the owner's
    minute watch of the connectors ([FD-13]) would be lost;
  - Better Stack's own monitors and heartbeats alone: no new host or code to run, but they cannot read
    Cloudflare's or Railway's configuration, so the connector count, version and egress checks
    ([FD-13]) and the static deployments' no-script check ([FD-19]) would go;
  - a small virtual machine at another provider, outside Railway, running the same code on a minute
    timer: the nearest match to the owner's words. It keeps every check, at the price of the smallest
    instance, a few US dollars a month per environment (UNVERIFIED; the steward prints the current
    price at the sitting), plus one more vendor account and an operating system to patch.
- **Rationale:** the minute watch must run outside Railway and outside what it watches. The Worker
  form was chosen on 19 Nov, before the owner's 03:00 rule, so the rule's reach is put to the owner.
  The default departs from the owner's literal words, so the short list says so and prices the
  alternative.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start (Phase 0 builds the watcher
  before the first staging deploy)

## 9. CI/CD

### CI-01 Rules on `main`
- **Decision:** a ruleset, switched on after the first minimal CI pull request merges (EXECUTION §2.1):
  - a pull request is required;
  - the required check is `gate`;
  - branches must be up to date before merging;
  - code-owner review is required (CODEOWNERS names the owner for the control paths, [CI-14]);
  - merge commits only; no force push and no deletion;
  - no bypass actors, the owner included.
- **Default:** as stated (§11.1). If SP-23 shows code-owner review cannot be required while general
  approvals stay at zero, every pull request needs one approval from the owner, given in the merge
  batches.
- **Alternatives:** D7's GitHub Team with organisation controls, which needs an organisation-owned
  repository.
- **Rationale:** R12's personal public repository gets rulesets for free; with distinct authors (the
  builder account), the owner's approval means something.
- **Status:** Recommended (supersedes D7) · **Deadline:** before Saturday's start

### CI-02 The CI design
- **Decision:**
  - Workflows: `ci.yml` (plan, check with `layout:check`, db, build, seams, e2e shards, static, the Bun
    canary, gate), the reusable `review.yml` (H-03), `dependencies.yml`, `containers.yml`, `release.yml`
    and `nightly.yml`.
  - `release.yml` also builds each app's static `dist/` and records its content hash in the release
    manifest; the upload is [FD-19]'s job.
  - A pinned runner, and the fewest permissions per job; no workflow triggered by a comment.
  - Turborepo's local cache through `actions/cache`, and no remote build cache.
  - Release builds never restore a cache.
  - Affected-only selection is used only for expensive work.
- **Default:** as stated (§11.2, §11.3).
- **Alternatives:** a remote build cache, which is a poisoning path on a public repository.
- **Rationale:** R10's "makes CI faster", without trusting what an untrusted run wrote.
- **Status:** Recommended · **Deadline:** before Saturday's start

### CI-03 Staging deploys from CI
- **Decision:** whether CI deploys staging, and who approves.
- **Default:** yes, batched.
  - `deploy-staging` runs in the `staging` GitHub environment, `main` only, with the **owner's account**
    as the required reviewer, which no agent holds ([CI-13]).
  - The owner approves the waiting deployment at the day's checkpoints (C1 to C4); merges accumulate in
    between. The operator may also deploy staging by hand with `pnpm fin deploy staging`.
  - The job runs only `ops/fin` (no npm dependency, no cache), verifies attestations first, prints
    names not IDs, masks the rest and uploads nothing. The environment holds the staging Railway project
    token and staging's Better Stack tokens, including the Telemetry token that reaches only the
    staging team. Whoever controls this job holds every staging secret, which is why staging holds test
    data and sandbox credentials only.
  - The static uploads are not this job: the owner's 03:00 decision already has GitHub Actions upload
    them, in a job and environment of their own ([FD-19]). This item asks about the Railway deploy
    only.
- **Alternatives:** automatic deploys after every merge with no reviewer and a wait timer; the operator
  deploys staging from their machine and CI holds no secret, as D16 said.
- **Rationale:** R12 gives environment protection on a public repository; an approval only means
  something from an account agents cannot use. Production stays with the operator ([CI-04]). (This
  settles the draft's EQ-10, whose CI-production option is withdrawn.)
- **Status:** OWNER MUST DECIDE (revises D16 for staging) · **Deadline:** before Saturday's start

### CI-04 The operator deploys production
- **Decision:**
  - The operator deploys production from the operator user, where no coding agent runs.
  - A launcher outside the repository runs the deploy, with tokens from the secure prompt. It refuses a
    release without a recorded staging `deploy.done` and release-smoke pass for the same digests at
    least the soak time old ([CI-17]).
  - Production gets exactly the digests that passed staging. GitHub has no production environment.
    The static builds that passed staging are uploaded the same way, by content hash ([FD-19]).
  - `pnpm fin rollback production` needs only the Railway token and never runs `migrate`; a failed step
    stops, leaves the previous deployment serving and prints the mixed state; `pnpm fin lock break
    --reason` breaks a stale lock with a record.
- **Default:** as stated (§11.8).
- **Alternatives:** a protected `production` environment in GitHub (the draft's EQ-10 option,
  withdrawn).
- **Rationale:** carries D37. A steered agent or CI job cannot reach production, and a 3 a.m. rollback
  needs one credential, not five.
- **Status:** Decided by the owner, 19 Nov 2026 (was D37), carried · **Deadline:** decided

### CI-05 Attested images
- **Decision:** each image is attested with `actions/attest` to the public Sigstore instance. `pnpm
  fin deploy` verifies the attestation, the workflow and the `push` to `main` before it deploys.
- **Default:** as stated (§11.7).
- **Alternatives:** deploy by digest without provenance.
- **Rationale:** a digest proves sameness, and an attestation proves where the image came from.
  Carries D15's "deployed by digest".
- **Status:** Recommended · **Deadline:** before Saturday's start

### CI-06 GitHub plan
- **Decision:** GitHub Free (20 concurrent jobs) or Pro (40) for the owner's account.
- **Default:** Pro from Saturday, so that two machines' pull requests run without queueing (4 USD a
  month).
- **Alternatives:** Free, with fewer e2e shards and review jobs at once.
- **Rationale:** a pull request uses about 12 jobs at once (§11.2); the first draft's EQ-20 ("only if
  needed") is withdrawn.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### CI-07 No merge queue
- **Decision:** no merge queue. "Up to date before merging", receipt reuse by patch-id ([RV-20]) and
  merge batches take its place.
- **Default:** as stated.
- **Alternatives:** move the repository to an organisation to get a queue.
- **Rationale:** personal-account repositories have no merge queue.
- **Status:** Recommended · **Deadline:** before Saturday's start

### CI-08 Outside contributions
- **Decision:** what forks, Issues and Discussions may do.
- **Default:**
  - Fork pull requests need approval to run, and get no AI review and no secrets; no agent session
    checks one out.
  - Issues, Discussions, Wiki and Projects are off; interaction limits are set to collaborators only
    ([CI-15]).
  - Private vulnerability reporting is on.
- **Alternatives:** accept fork pull requests and Issues as normal.
- **Rationale:** text from strangers must not reach an agent or a credential.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### CI-09 Workflow lockfiles later
- **Decision:** adopt GitHub's workflow lockfiles ("require lockfile") once `gh-actions-lock`
  reaches 1.0. Until then, actions are pinned by SHA, enforced by the repository setting and zizmor.
- **Default:** as stated.
- **Alternatives:** adopt them now.
- **Rationale:** the tooling is not stable yet.
- **Status:** Recommended · **Deadline:** production

### CI-10 A Bun canary job
- **Decision:** a non-blocking CI job that runs these under Bun 1.4.5:
  - the shared packages' tests;
  - the known-answer crypto tests;
  - the server-side request forgery refusal tests.
- **Default:** as stated.
- **Alternatives:** no Bun at all.
- **Rationale:** R15 asks for Bun to be checked, and the job keeps that evidence current.
- **Status:** Recommended · **Deadline:** Sunday

### CI-11 Signed review receipts
- **Decision:** how review receipts are made trustworthy, and from when.
- **Default:** from Phase 0. The engine, running as the `fin-review` OS user, signs each receipt with an
  Ed25519 key (from `node:crypto`) held in that user's keychain, out of the builders' reach; the public
  keys are in `docs/review/receipt-keys/` (a control path). Receipts are pushed to
  `refs/fin-review/receipts/<head sha>`, never posted as comments, and the engine re-runs the pull
  request's `gate`, which runs `main`'s checker over the signature. In CI (H-03), the reusable review
  workflow at `main` attests its receipt with `actions/attest`, and the checker accepts only that
  workflow at `refs/heads/main`. The production deploy refuses an unsigned receipt.
- **Alternatives:** unsigned JSON receipts posted to the pull request until production (the first draft:
  anyone can comment on a public pull request, and a comment re-triggers no workflow).
- **Rationale:** the owner accepted signed receipts before production on 19 Nov; without them the
  server-side gate is advisory, so they come first.
- **Status:** Decided by the owner, 19 Nov 2026 (signed receipts, was D24); signing from Phase 0 and
  the mechanism are Recommended · **Deadline:** before Saturday's start

### CI-12 Real Postgres in development and CI
- **Decision:** Postgres 18 in Docker Compose locally and as a CI service. There is no in-process
  substitute for the suites that need grants, locks, `LISTEN` or the audit chain.
- **Default:** as stated.
- **Alternatives:** PGlite for speed.
- **Rationale:** those suites test Postgres behaviour itself.
- **Status:** Recommended · **Deadline:** before Saturday's start

### CI-13 Agents' GitHub credentials
- **Decision:** what GitHub identity agents use.
- **Default:** from Phase 0, a builder machine account, a collaborator with write access and no admin.
  Its token cannot change workflow files, settings, environments or secrets, and cannot approve a
  deployment: a fine-grained token if GitHub allows one for a collaborator on a personal repository,
  otherwise a classic token with `public_repo` scope only (SP-23). Agent sessions run as a separate OS
  user whose git and `gh` credentials are the builder account's. Only the CI lane's session holds a
  second token that may change workflow files, and its pull requests are control paths. The owner's
  full login lives only in the owner's own sessions and the operator user.
- **Alternatives:** the owner's existing `gh` login for agents (D57's "for now"), which can push
  workflow changes, merge, approve the staging environment and edit the ruleset.
- **Rationale:** one steered builder session must not be able to change the rules that review it, or
  merge anything into a public repository that deploys staging.
- **Status:** Decided by the owner, 19 Nov 2026 (was D57: the current login for now); the builder
  account from Phase 0 is Recommended · **Deadline:** before Saturday's start

### CI-14 Control paths need the owner
- **Decision:** which pull requests need the owner, and how.
- **Default:** control paths (`.github/**`, `tools/fin-review/**`, `tools/layout.json`,
  `docs/review/**`, `.claude/**`, `CODEOWNERS`, the rules files, `pnpm-workspace.yaml`, the
  supply-chain and public-safety scripts, `ops/fin/**`, `ops/docker/**`, each app's `_headers` and
  static deployment settings, and `tools/static-deploy/**`) need the owner's code-owner
  approval, `main`'s checker also refuses them without it, and the ship step needs the owner's typed
  confirmation. They are never covered by a pre-approval ([G-10]). Other tier S paths rely on the
  signed receipt with its attack pass.
- **Alternatives:** the owner's approval on every tier S path as well.
- **Rationale:** on `pull_request` GitHub runs the pull request's own workflow file, so the files that
  define the gate need a human the agents cannot impersonate; restoring the typed confirmation of the
  19 Nov design.
- **Status:** OWNER MUST DECIDE. "Each app's `_headers`" covers the profiles in
  `packages/web-host/src/static/` and their renderer (appendix C, SF-05) · **Deadline:** before
  Saturday's start

### CI-15 Strangers' text never reaches a session
- **Decision:** how prompt injection through the public repository is kept out of agents.
- **Default:** interaction limits set to collaborators only, renewed before they expire and watched;
  agents list pull requests by allowed author and never load titles, bodies, comments or branch names;
  no agent checks out a fork's pull request; reviewer sessions read code, never pull request text, and
  their findings are validated in code ([RV-21]).
- **Alternatives:** rely on Issues being off.
- **Rationale:** strangers can still open fork pull requests and comment, and the steward runs `gh` all
  day.
- **Status:** Recommended · **Deadline:** before Saturday's start

### CI-16 Security fixes before production, and pre-push checks
- **Decision:** how a fix to deployed code avoids being public before production runs it, and how
  secrets are stopped before they reach a public branch.
- **Default:** from the first production deploy, a security fix is prepared in the advisory's private
  fork and reviewed locally, then merged with neutral commit text only when the operator is ready to
  deploy production within the hour, with the soak shortened by the owner's typed confirmation and the
  counts withheld until deployed. The public-safety check and gitleaks run as a local pre-push hook on
  both machines and in the merge guard from Phase 0, with CI as the backstop; anything that reaches a
  public branch is rotated.
- **Alternatives:** build from the private fork on a trusted runner and deploy before merging (heavier:
  images would need a private registry).
- **Rationale:** every image is built from public `main`, so each fix is public before production runs
  it; GitHub's push protection knows neither Fin's token shapes nor its private names.
- **Status:** Recommended · **Deadline:** before Saturday's start (pre-push); production (the embargo)

### CI-17 The staging soak before production
- **Decision:** how long a release must have run on staging before production takes it.
- **Default:** 24 hours, with the release smoke passed, unless the owner shortens it by typed
  confirmation for a security fix ([CI-16]).
- **Alternatives:** no minimum; a longer soak.
- **Rationale:** nothing else enforced that a digest passed staging and soaked.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

## 10. Review (fin-review)

### RV-01 Reviews before fin-review runs, and after
- **Decision:** how changes are reviewed while fin-review is being built.
- **Default:** until the fin-review MVP merges (Phase 0), each pull request gets one security lens
  session and one attack session on allowed models, started by hand with the MVP's prompts, plus the
  owner's own read of any CI or fin-review file, recorded in the pull request; no built-in review command
  takes part ([RV-10]). From the MVP's merge, fin-review runs every review locally with signed receipts
  ([CI-11]): lenses on Opus 5.5 at `xhigh`, the attack pass on Fable 5.2 at `high` for every tier S
  change, two sceptics apart for high and critical findings, one sibling search per confirmed class.
  Merges happen only through the ship step. From H-03 the same engine also runs in CI.
- **Default:** as stated (§11.6).
- **Alternatives:** the built-in review commands as the bootstrap review (the first draft's EX-18).
- **Rationale:** this carries the per-PR review shape the owner set for the fast build on 19 Nov and
  D41, under R11.
- **Status:** Recommended · **Deadline:** before Saturday's start

### RV-02 fin-review v2
- **Decision:**
  - A deterministic Node CLI in `tools/fin-review`. It covers planning, tiers (from
    `tools/layout.json`), units, content keys, sharding, R11 validation, verdicts, signed receipts,
    sealing and the cache ledger. It starts narrow model sessions only for judgement.
  - Modes: `plan`, `commit`, `pr`, `merge`, `sweep`, `all`, `ci`, `dependency`, `trial`, `ship`,
    `since <ref>` (the nightly run until the ledger exists, and "everything since a commit") and
    `import` (the design layer's port only), the last two from spec 07 (appendix C, SF-09).
  - It covers every tracked file, CI and itself included. A change to the tooling is judged by `main`'s
    copy.
- **Default:** as stated (§11.6). The MVP (validator, planner, `commit`, `pr`, signed receipts and
  their checker, sceptics, `merge`) lands in Phase 0 and Saturday; the cache, joins, `sweep`, `ci` and
  the CI runner come in H-03.
- **Alternatives:** the old staged workflow, kept as the engine.
- **Rationale:** R10 asks for speed across the whole codebase, per commit and per merge; on 19 Nov the
  owner said fin-review covers CI and the whole repository, itself included.
- **Status:** Recommended; two modes added before the first commit (appendix C, SF-09) ·
  **Deadline:** before Saturday's start (the MVP); Tuesday 24 Nov (v2)

### RV-03 Model and effort options
- **Decision:**
  - `--model opus|fable` and `--effort high|xhigh|max`.
  - `--attack-model opus|fable` and `--attack-effort high|xhigh|max`.
  - Of the 36 combinations, 27 are valid: Fable overall refuses an Opus attack (the 9 combinations of
    `--model fable --attack-model opus`); Opus overall with a Fable attack is allowed.
  - Refused at the CLI, the configuration file and the CI inputs: every effort below `high`,
    `ultracode`, `auto`, any alias outside {opus, fable}, other model families and bare model IDs.
  - The second sceptic resolves to the attack model, with a test.
  - Each session is locked to its model and effort and checked after it runs ([RV-19]).
- **Default:** `opus` at `xhigh`, with a `fable` attack at `high`.
- **Alternatives:** none under R11.
- **Rationale:** R11. The defaults are the 19 Nov practice. (The first EXECUTION draft said "36 valid
  combinations", which a correct validator could never meet.)
- **Status:** Decided by the owner, 21 Nov 2026 (R11). The defaults are Recommended · **Deadline:**
  decided

### RV-04 CI as the review gate
- **Decision:** whether fin-review in CI is the authoritative merge gate.
- **Default:** yes, from H-03, once SP-12's CI part passes. Until then the gate is the signed local
  receipt ([CI-11]); afterwards local receipts count only during a GitHub or Anthropic outage, marked as
  such.
- **Alternatives:** local receipts as the gate for good.
- **Rationale:** a gate that agents cannot quietly skip, run from `main`'s copy of the engine.
- **Status:** OWNER MUST DECIDE · **Deadline:** Tuesday 24 Nov

### RV-05 The credential CI uses for model calls
- **Decision:** how CI review jobs authenticate to Anthropic.
- **Default:** Workload Identity Federation, with the rule bound to the reusable `review.yml` at
  `refs/heads/main` (`job_workflow_ref`), the repository's and owner's numeric IDs and the allowed events,
  so a branch's own workflow cannot spend the workspace and a renamed repository cannot match; a CI
  workspace with its own spend limit, and an alert on spend outside review runs. The federation IDs are
  kept as Actions secrets, so they are masked.
- **Alternatives:** an API key stored as a secret; a subscription token (a one-year credential in a
  public repository's secrets); a rule matching any run of the repository by name (the first draft).
- **Rationale:** nothing long-lived to leak, and nothing a branch can use.
- **Status:** OWNER MUST DECIDE · **Deadline:** Tuesday 24 Nov

### RV-06 The effort floor at the gate
- **Decision:** the lowest effort the gate accepts.
- **Default:** lens sessions and the first sceptic at `xhigh` or above on tier S and `high` or above
  elsewhere; the attack pass and the second sceptic at `high` or above everywhere, which R11 sets for
  them.
- **Alternatives:** `high` everywhere (R11's minimum, the draft's EQ-12); `xhigh` everywhere.
- **Rationale:** sensitive paths keep the 19 Nov depth, other changes get R11's speed, and the attack
  pass's own default (`high`) passes its own floor. One answer in every file.
- **Cost:** the default narrows R11 on tier S. R11 allows any effort of `high` or above, but a gating
  run on tier S refuses `--effort high` (only an advisory run, with no receipt, accepts it). Only
  `high` everywhere keeps R11's full range on every tier (spec 07 §3.4).
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### RV-07 Switching the attack pass off
- **Decision:** whether the attack pass can be switched off.
- **Default:** no. It runs on every tier S change, and only there. A tier S receipt without it fails the
  gate.
- **Alternatives:** an owner-only `off` for an outage of the attack model, with the run marked.
- **Rationale:** tier S covers sign-in, keys, money and personal data.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### RV-08 A second sceptic on the attack model
- **Decision:** the second sceptic of a high or critical finding runs on the attack model, so that
  two models judge it when the models differ.
- **Default:** as stated.
- **Alternatives:** both sceptics on the overall model.
- **Rationale:** D47 put the second sceptic on Fable. Under R11, "the attack model" generalises that.
- **Status:** Decided on the owner's delegation, 19 Nov 2026 (was D47). Generalised, Recommended ·
  **Deadline:** decided

### RV-09 Sealed findings
- **Decision:** where findings live in a public repository, and where the key that opens them is kept.
- **Default:**
  - Locally, findings stay on the owner's machines, readable by the builders only after validation; the
    pull request shows counts by lens and severity and the receipt's hash.
  - In CI, findings are sealed with `age` to the owner's key before they leave the job; non-security
    findings are sealed too; the pull request, logs and summary show counts only.
  - The private key is held offline by the owner, on a hardware key or in the password manager.
  - A security issue found after merge goes to a private security advisory.
- **Alternatives:** correctness and quality findings as public pull request comments.
- **Rationale:** anyone can read a public repository's logs and artifacts, and Fin moves money.
- **Status:** OWNER MUST DECIDE · **Deadline:** Tuesday 24 Nov

### RV-10 The built-in review commands
- **Decision:** the built-in `/code-review` and `/security-review` take no part in any gate or in the
  bootstrap review until SP-12, moved into Phase 0's `fin-review doctor`, proves every one of their
  sub-agents runs on Opus or Fable. Even then they are extra, non-gating candidates, and their sessions
  and observed models are recorded in the receipt.
- **Default:** as stated.
- **Alternatives:** run them in every `pr` gate and as the bootstrap review (the first EXECUTION draft's
  EX-11 and EX-18).
- **Rationale:** R11 allows only Opus or Fable, and the built-ins' sub-agent models cannot be set.
- **Status:** Recommended · **Deadline:** before Saturday's start

### RV-11 The Claude Agent SDK as a dependency
- **Decision:** whether `tools/fin-review` may depend on `@anthropic-ai/claude-agent-sdk` for the CI
  runner.
- **Default:** yes, with these limits: only in `tools/fin-review`; at an exact version at least three
  days old; installed for the review job only. It has a proprietary licence and a large binary. The local
  MVP starts sessions with the pinned Claude Code CLI and needs no new package.
- **Alternatives:** `claude -p` from a pinned Claude Code binary in CI too: the same licence, and less
  control over settings.
- **Rationale:** the locked-down session settings that R11 needs are set through the SDK.
- **Status:** OWNER MUST DECIDE · **Deadline:** Tuesday 24 Nov

### RV-12 When per-commit review runs
- **Decision:** whether every push is reviewed.
- **Default:** every push to a lane pull request gets a `commit` review, drafts included, and the `pr`
  gate at ready reviews only what those reviews did not cover, plus one integration pass ([RV-20]).
- **Alternatives:** skip drafts and review only ready pull requests (cheaper; the gate then reviews the
  whole patch).
- **Rationale:** early feedback in minutes, and a faster gate; cost is capped by [RV-13].
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### RV-13 Review spend, the nightly sweep and cold runs
- **Decision:** what reviews may spend, and how often the whole codebase is reviewed cold.
- **Default:**
  - Caps per pull request, per day and per month, provisional from Saturday 13:00 and set after the
    first ten measured runs; reaching a cap is "could not check", which blocks, never a pass; the
    `review-cost-high` alert; review spend is a line in the cost table.
  - A nightly sweep budget (H-03), with a random 10% cold sample each night.
  - A cold `all` run before production, and after any model or procedure change.
- **Alternatives:** a monthly cap only.
- **Rationale:** at 30 to 60 USD per tier S gate and 10 to 16 gates a day, review spend can pass the
  platform's monthly cost in a day. This replaces D14's import-programme budget.
- **Status:** OWNER MUST DECIDE (supersedes D14) · **Deadline:** Saturday 13:00 (provisional caps);
  production (the sweep and cold cadence)

### RV-14 Fast mode
- **Decision:** fast mode is off by default and can be switched on per run. It changes only speed
  and price, never the model or the effort.
- **Default:** as stated.
- **Alternatives:** on for per-commit runs.
- **Rationale:** about twice the price, for wall time only.
- **Status:** Recommended · **Deadline:** Sunday

### RV-15 The Cyber Verification Program, later
- **Decision:** apply to the program only if Opus 5.5 or Fable 5.2 refuse attack prompts often
  enough to block merges. Until then, a refused lens blocks and the owner is told.
- **Default:** as stated.
- **Alternatives:** apply now.
- **Rationale:** attack prompts are phrased as defensive tracing of Fin's own code, and refusals are
  measured first.
- **Status:** Recommended · **Deadline:** production

### RV-16 Reusing cached results
- **Decision:** a cached result is reused only at the same model and the same or a stronger effort.
  Opus and Fable results never satisfy each other.
- **Default:** as stated.
- **Alternatives:** reuse across models.
- **Rationale:** a cache must never weaken a review.
- **Status:** Recommended · **Deadline:** Sunday

### RV-17 No interactive review action
- **Decision:** no `claude-code-action`, and no `@claude` replies on pull requests.
- **Default:** as stated.
- **Alternatives:** the action for interactive help.
- **Rationale:** it needs write permissions, and it installs at run time, outside the pnpm gate.
- **Status:** Recommended · **Deadline:** before Saturday's start

### RV-18 A rules digest
- **Decision:** the rules lens reads AGENTS.md and CONTRIBUTING.md in full. The other lenses read a
  generated digest, with a test that the digest names every rule heading.
- **Default:** as stated.
- **Alternatives:** every lens reads both files in full.
- **Rationale:** the same rules, at a fraction of the tokens.
- **Status:** Recommended · **Deadline:** Sunday

### RV-19 Each session runs the model it says
- **Decision:** how fin-review proves R11 for every session.
- **Default:** exact model IDs only, and a retired ID blocks; the session environment built from an
  allowlist, refusing to run when an API base URL other than the vendor's, a cloud-provider switch, a
  gateway, a model-alias remap, a sub-agent model or effort and model variables are present; background
  calls pinned to the same model or turned off, proven by the doctor reading one session's `modelUsage`;
  no fallback anywhere (one retry with the same settings, then the lens blocks); the receipt records the
  API host, the CLI or SDK version, the resolved model ID, and the effort as "requested" until it can be
  read back.
- **Alternatives:** trusting the requested model (the first draft dropped only `ANTHROPIC_MODEL`).
- **Rationale:** each setting above changes what answers while a receipt would still say Opus.
- **Status:** Recommended · **Deadline:** before Saturday's start

### RV-20 Catching up with `main`, merge batches and capacity
- **Decision:** how "up to date before merging" stays cheap.
- **Default:** when a pull request is updated from `main` and its own patch-id is unchanged, and no change
  on `main` touches its files or their one-hop callers and imports, the receipt is re-issued for the new
  head with no model session; resolved conflicts and changed joins get a delta review. The steward
  merges in batches every 90 minutes during the build; `pr` gates are split between both machines;
  EXECUTION §1.1 keeps a capacity table of sessions per machine, and a usage limit is a cut line.
- **Alternatives:** a full re-review after every update from `main`.
- **Rationale:** each merge forces every other open pull request to update; without reuse, catch-ups
  would re-review code already reviewed and queue merges for hours.
- **Status:** Recommended · **Deadline:** before Saturday's start

### RV-21 Review isolation and finding validation
- **Decision:** how local review sessions are contained, and how their output is checked.
- **Default:** sessions run as the `fin-review` OS user with Read, Grep and Glob only, deny rules for
  every path outside the tree and the engine, and no Bash, web or MCP tools; the deterministic engine
  signs, out of the sessions' reach; findings are validated in code (a fixed schema, the file exists,
  quoted text is a substring of that file, length caps, no free-text instruction field) before a builder
  reads them.
- **Alternatives:** sessions as the owner's OS user with no deny rules (the first draft), where an
  injected reviewer could read SSH keys or token files into a finding.
- **Rationale:** the CI design already had these controls; local runs need them too.
- **Status:** Recommended · **Deadline:** before Saturday's start

## 11. Money and providers

### MO-01 The provider adapter
- **Decision:**
  - A neutral `ProviderAdapter` (§12.3) with effect-typed outcomes: `ok`, `refused`, `retry`, or
    `unknown` with a hint for resolving it.
  - Capabilities are declared.
  - Adapters are stateless and save their state through checkpoints.
  - Link tables are kept per provider.
  - No provider name reaches a developer.
  - One conformance suite covers every adapter.
  - Fin owns the money facts.
- **Default:** as stated.
- **Alternatives:** a thin wrapper around MassPay's calls, as in the old product.
- **Rationale:** R8 asks for several providers, and the old MassPay rules generalise to any provider.
- **Status:** Recommended · **Deadline:** Monday

### MO-02 Fin's ledger, holds and reconciliation
- **Decision:**
  - The ledger is double-entry and append-only by trigger, in minor units, with holds and an anchored
    daily head.
  - Spendable money is the ledger's available balance minus holds, and never more than the provider's
    balance minus open holds.
  - Reconciliation:
    - a status sweep by `next_check_at` with backoff ([MO-23]);
    - orphan payouts every 5 minutes;
    - a daily balance check;
    - a daily ledger walk;
    - other orphans daily.
  - Each break is an audit event and an alert; breaks above a threshold and orphan payouts trip the money
    switch ([OP-01]).
- **Default:** as stated (§12.8, §12.11).
- **Alternatives:** the provider's balance as the truth, as in the old product.
- **Rationale:** several providers, R9's audit, and no provider's event delivery assumed complete.
- **Status:** Recommended · **Deadline:** Monday

### MO-03 Sealing full account numbers in Fin
- **Decision:** whether Fin keeps a beneficiary's full account number.
- **Default:** yes. It is sealed with `payments`' own key family and opened only in memory, for
  three things:
  - to register it with a provider;
  - to run an ownership check;
  - to show it to someone with the permission and a fresh factor.

  Each opening is audited. The API still answers the last four digits only.
- **Alternatives:** keep the 20 Nov rule that only MassPay holds the number. A beneficiary could then
  never be registered at a second provider, on a new rail, or again after a provider loses data.
- **Rationale:** R8's several providers.
- **Status:** OWNER MUST DECIDE (reverses 20 Nov) · **Deadline:** Monday

### MO-04 Sealing Fedwire identification
- **Decision:** whether Fin keeps the Fedwire identification type and number per beneficiary.
- **Default:** yes, sealed under their own field names.
- **Alternatives:**
  - never keep them (20 Nov);
  - model the number as the holder's, as MassPay does.
- **Rationale:** a provider may keep one identification number per holder rather than per
  beneficiary (the private provider note, ARCHITECTURE §12.12), so the number a wire carries must
  come from Fin's row. Without the values in Fin, Fedwire beneficiaries cannot move to another
  provider.
- **Status:** OWNER MUST DECIDE (reverses 20 Nov) · **Deadline:** Monday

### MO-05 Routing by mode
- **Decision:** what backs the developer Sandbox.
- **Default:**
  - Sandbox mode runs on the Fin simulator.
  - Live mode runs on MassPay: its sandbox in staging, and MassPay live in production.
- **Alternatives:** the 20 Nov setup, with the developer Sandbox on MassPay's sandbox through Fin's
  one key and shared wallet.
- **Rationale:**
  - MassPay's sandbox terms allow synthetic data only, and developers type whatever they like.
  - The simulator is instant, simulates deposits and returns, and has no shared balance to run out.
- **Status:** OWNER MUST DECIDE (reverses the 20 Nov setup) · **Deadline:** Monday

### MO-06 The payments service
- **Decision:** `payments` owns:
  - the money schema;
  - its own seal and fingerprint keys;
  - the provider credentials;
  - the static egress addresses MassPay allowlists;
  - the provider hook door (`apps/payments/src/hooks/`);
  - the money jobs and their scheduler lease (`apps/payments/src/jobs/`).

  No money work runs in `worker` or `api`. Other services call its money door with signed assertions,
  and `payments` enforces each operation's declared checks itself ([SA-36]).
- **Default:** as stated (§12.2).
- **Alternatives:** money inside `api`, which would put the raw provider key beside the personal-data
  keys; money jobs in `worker` (the first EXECUTION draft), which would give a second service money
  grants and provider reach.
- **Rationale:** a provider credential is treated as able to move every balance Fin holds at that
  provider, whatever the provider documents, so it sits on one service only.
- **Status:** Recommended · **Deadline:** Monday

### MO-07 Provider IDs from the idempotency scope, and one intent per send
- **Decision:** the provider's business ID and idempotency key are derived from the developer's
  idempotency scope (organisation, mode, key) plus an attempt number. Every transfer has an idempotency
  key: the API requires one, and the console's Send money dialog asks the server for one transfer intent
  ID when it opens and reuses it across every retry, warning when a similar transfer was sent recently.
  Orphan payouts are looked for every 5 minutes.
- **Default:** as stated (§12.7).
- **Alternatives:** IDs derived from Fin's row ID; a new key per console attempt (the first draft: a
  member who could not see the transfer and sent again would pay twice).
- **Rationale:** if a failover loses the row, a retry maps to the same payout instead of paying twice.
- **Status:** Recommended · **Deadline:** Monday

### MO-08 `amount` and `currency`
- **Decision:** how the API expresses money.
- **Default:** `amount` in integer minor units with an ISO 4217 `currency`, in place of
  `amount_cents`.
- **Alternatives:** keep `amount_cents`.
- **Rationale:** several providers and rails. It changes before any developer depends on it.
- **Status:** OWNER MUST DECIDE · **Deadline:** Monday

### MO-09 Businesses wait
- **Decision:** business customers route to no provider until a provider supports business
  enrolment (409 `not_supported`). The "business as a user" fallback is not shipped.
- **Default:** as stated.
- **Alternatives:** ship the fallback.
- **Rationale:** the owner's choice.
- **Status:** Decided by the owner, 20 Nov 2026, carried · **Deadline:** decided

### MO-10 Holder names
- **Decision:**
  - A beneficiary's holder name is kept in Fin only, sealed ("kept for your records").
  - Payouts go out in the customer's name.
  - Third-party payees wait for MassPay's confirmation and an owner decision.
- **Default:** as stated.
- **Alternatives:** none open.
- **Rationale:** the first provider has no field for a beneficiary's holder name (the private
  provider note, ARCHITECTURE §12.12).
- **Status:** Decided by the owner, 20 Nov 2026, carried · **Deadline:** decided

### MO-11 USD only at launch
- **Decision:** only USD at launch. The interface carries a currency everywhere, so other currencies
  can follow.
- **Default:** as stated.
- **Alternatives:** none open.
- **Rationale:** the owner's money rules for the redesign.
- **Status:** Decided by the owner, 20 Nov 2026, carried · **Deadline:** decided

### MO-12 The gates before live money
- **Decision:** live money waits for every gate in §12.15:
  - MassPay's allowlist and answers;
  - a consent step that names the provider;
  - the beneficiary security email;
  - real inbound deposits;
  - reconciliation, its automatic trips, and the ledger with its anchored head;
  - the live host enabled only by a reviewed change, and the live-money kill switch tested;
  - the request-for-information journey;
  - live limits, value caps, the first-payout delay and the second approver ([MO-17], [MO-19]);
  - address allowlists on live money keys ([MO-20]);
  - commit durability before payouts ([MO-18]);
  - the per-transfer step-up intent ([SA-08]);
  - the responder gate ([OB-06]);
  - signed receipts.
- **Default:** as stated.
- **Alternatives:** none.
- **Rationale:** each gate closes a way to lose money or mislead a customer.
- **Status:** Recommended · **Deadline:** production

### MO-13 Fin Admin's money views and actions
- **Decision:** what staff see and may do with money.
- **Default:**
  - Views for `money.read`: provider status, transfers and reconciliation breaks, built from
    design-system patterns without a board, read-only, marked pending design parity (the draft's
    EQ-33).
  - Retry, close and resolve-a-break for `money.operate`, each with a step-up intent.
  - No payouts started by staff.
- **Alternatives:** views only; staff payouts behind two people.
- **Rationale:** staff must be able to clear breaks without being able to move money.
- **Status:** OWNER MUST DECIDE · **Deadline:** Monday

### MO-14 Inbound deposits before live
- **Decision:** real inbound deposits work before live money, through the webhook, pay-in polling and
  the ledger walk.
- **Default:** as stated.
- **Alternatives:** none.
- **Rationale:** without them, a deposit to a virtual account would go unseen.
- **Status:** Recommended · **Deadline:** production

### MO-15 No silent failover
- **Decision:** a payout that may have happened at one provider is never sent to another. Routing
  rules are data, and each decision is recorded.
- **Default:** as stated (§12.6).
- **Alternatives:** automatic failover on errors.
- **Rationale:** a payout sent twice is money lost.
- **Status:** Recommended · **Deadline:** Monday

### MO-16 A fee quote route
- **Decision:** whether the API offers a fee quote.
- **Default:** `POST /v4/transfers/quote`, which places no hold and calls the adapter's
  `pricePayout`. The unused `quotes:write` scope is dropped.
- **Alternatives:** no quote route, keeping or dropping the scope.
- **Rationale:** a developer should see the fee before sending, and the console's review needs the
  same figure.
- **Status:** OWNER MUST DECIDE · **Deadline:** Monday

### MO-17 Limits
- **Decision:** the starting money quotas for Sandbox (§13.6). Live limits are set from MassPay's
  answers before production.
- **Default:** as stated.
- **Alternatives:** none open.
- **Rationale:** MassPay's live limits and cut-offs are not yet known.
- **Status:** Recommended. Live limits are needed by production · **Deadline:** production

### MO-18 A payout only after its row is durable
- **Decision:** how a failover is kept from losing a transfer the provider then pays.
- **Default:** before `submitPayout`, the transfer and its hold are confirmed on a replica: synchronous
  commit for money transactions where [P-10] allows it, otherwise a read of the row on a replica before
  the call.
- **Alternatives:** rely on [MO-07] alone (it saves an API client that retries with the same key, not a
  member who sends again).
- **Rationale:** with asynchronous replication a failover can lose a committed transfer and its hold after
  the provider paid.
- **Status:** Recommended · **Deadline:** Monday (built); production (proven on HA)

### MO-19 Value caps, a second approver and a first-payout delay
- **Decision:** the money limits beyond counts.
- **Default:** daily value caps per organisation, per customer and per beneficiary; an optional second
  approver above a threshold an organisation sets; a delay, with a notice to the Super admins and
  Admins, before a new beneficiary's first payout. Built in hardening; the thresholds set by the owner
  before live money.
- **Alternatives:** 100 transfers a day and a per-transfer cap only (the first draft).
- **Rationale:** a stolen session or key could otherwise empty a balance in one day within the count.
- **Status:** OWNER MUST DECIDE (the thresholds) · **Deadline:** production

### MO-20 Address allowlists on live money keys
- **Decision:** whether a live key with a money scope may work from anywhere.
- **Default:** no: a live key with `money:write` or `beneficiaries:write` must carry an IP allowlist;
  `payments` re-checks it from the key record.
- **Alternatives:** optional allowlists for every key.
- **Rationale:** a leaked money key should not work from the attacker's network.
- **Status:** Recommended · **Deadline:** Monday

### MO-21 Treasury funding and simulations are locked in live production
- **Decision:** whether `fundFromTreasury` and the `simulate*` operations can ever run on a live
  production instance.
- **Default:** never: refused in code on a live production instance, with a test; the Fin simulator can
  never be the routed adapter of a live production instance.
- **Alternatives:** configuration only.
- **Rationale:** `fundFromTreasury` spends Fin's own funds.
- **Status:** Recommended · **Deadline:** Monday

### MO-22 No double posting, and no deleting what holds money
- **Decision:** uniqueness of postings and deposits, and when deletion is refused.
- **Default:** unique constraints on `(transfer, posting kind)` and on `(provider, instance, deposit
  reference)`, so a webhook, the sweep and the ledger walk cannot apply the same return or deposit twice;
  an organisation or customer with a balance, a hold or a non-final transfer cannot be deleted.
- **Alternatives:** idempotent handlers alone.
- **Rationale:** three paths can see the same provider fact.
- **Status:** Recommended · **Deadline:** Monday

### MO-23 The status sweep backs off
- **Decision:** how often a non-final transfer is read from the provider.
- **Default:** when its `next_check_at` is due, backing off 1, 2, 5, 10 and 30 minutes and then hourly,
  within a per-provider call budget; a webhook resets the backoff; one full pass a day.
- **Alternatives:** every non-final transfer every minute (the first draft: a 95-minute sandbox payout
  read 95 times, with calls growing with volume).
- **Rationale:** the sweep is a safety net, not the main path.
- **Status:** Recommended · **Deadline:** Monday

## 12. Onboarding (KYC and KYB)

### KY-01 A provider port, with a sandbox provider
- **Decision:**
  - `packages/kyc` has a `KycProvider` port, with Sumsub as the live implementation.
  - Fin's sandbox provider decides outcomes from the test values. Sandbox mode never calls Sumsub.
  - Calls follow the same rules as money calls: idempotent, a 10-second budget, no redirects, and no
    retry of a 4xx.
- **Default:** as stated (§12.16).
- **Alternatives:** Sumsub called directly, with sandbox branches throughout, as in the old product.
- **Rationale:** one pipeline for both modes, and a second KYC provider later.
- **Status:** Recommended · **Deadline:** Sunday

### KY-02 Inbound events first, polling as the backstop
- **Decision:** Sumsub's webhooks are stored, answered within a second, and processed by the worker,
  which reads the review back. Polling with backoff stays as the safety net.
- **Default:** as stated.
- **Alternatives:** polling as the main path, as today (about 20 reviews a minute).
- **Rationale:** throughput, and Sumsub's 10-second answer limit.
- **Status:** Recommended · **Deadline:** Sunday

### KY-03 One applicant table, and one request-for-information model
- **Decision:**
  - One `kyc_applicant` table, in place of Sumsub columns on three tables.
  - One request-for-information model: the old fixed items become built-in system forms.
- **Default:** as stated.
- **Alternatives:** carry both models.
- **Rationale:** half the code paths.
- **Status:** Recommended · **Deadline:** Sunday

### KY-04 Sumsub tokens per holder
- **Decision:**
  - Four Sumsub tokens: `api-write`, `api-read`, `api-documents` and `worker`.
  - Each has the fewest permissions, is limited to its holder's static egress addresses, and
    expires in 180 days.
  - Staging may use its one sandbox token for document downloads until the separate token exists.
- **Default:** as stated (§6.5).
- **Alternatives:** one shared token. Tripping Sumsub's bad-response limit would then lock out every
  service.
- **Rationale:** carries D51.
- **Status:** Decided by the owner, 19 Nov 2026 (was D51), carried. The split is needed by
  production · **Deadline:** production

### KY-05 How a developer's company is reviewed for go-live
- **Decision:** how the company behind a Production request is reviewed. Today, Sumsub's Developer
  Verification answers 409 until steps are done in Sumsub's own pages.
- **Default:**
  - Staff review the company on its answers, with every person approved by Sumsub, and a second
    approver once a second staff member exists ([SA-39]).
  - Ask Sumsub for an API-driven Developer Verification level, and move to it when it exists.
  - The "documents" wording and the missing-documents reasons go, because go-live takes no documents
    (owner, 18 Nov).
- **Alternatives:**
  - embed Sumsub's WebSDK for the company's own steps, which adds a third-party script to another page;
  - staff-only review for good.
- **Rationale:** R7's "everything Sumsub covers", without widening the page policy. Put to the owner
  with [KY-13] as one question.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start (with [KY-13])

### KY-06 Owner companies on a Production request
- **Decision:** what happens to the developer's corporate owners, which the old product never sent.
- **Default:** send them to Sumsub as company beneficiaries of the go-live applicant: Sunday's first
  stretch item, required before production.
- **Alternatives:** drop the field.
- **Rationale:** an ownership structure with no review is a gap. Put to the owner with [KY-13].
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start (with [KY-13])

### KY-07 Restarting a final rejection
- **Decision:** whether a developer may restart a customer whose rejection is final.
- **Default:**
  - No. Staff may allow one restart, audited, with a reason.
  - A rejection that asks for a retry still allows 3 restarts a day.
- **Alternatives:** the old rule: 3 restarts a day for any rejection.
- **Rationale:** a sanctions or fraud rejection should not become a fresh attempt.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday

### KY-08 An email when a request for information opens
- **Decision:** the customer is emailed when Fin opens a request for information, as they already
  are when it changes or is cancelled.
- **Default:** as stated.
- **Alternatives:** the developer's webhook only.
- **Rationale:** consistency, and a quicker answer.
- **Status:** Recommended · **Deadline:** Sunday

### KY-09 The design source for the hosted verify pages
- **Decision:** what the verify pages are built from. The two R14 canvases do not draw them.
- **Default:** new boards on the design system's `AuthLayout`, drawn by the design lane on Saturday
  evening before Sunday's screens. Until then, pending compositions ([UI-03]).
- **Alternatives:** carry the older canvas's 7 Verify boards, and add business, person and request-form
  frames (the draft's EQ-32).
- **Rationale:** one design language across sign-in and the hosted pages.
- **Status:** OWNER MUST DECIDE · **Deadline:** Saturday 18:00

### KY-10 Erasure and the 90-day purge
- **Decision:**
  - Deleting a customer:
    - deactivates every Sumsub applicant;
    - records an erasure request;
    - emits `customer.deleted`;
    - keeps a tombstone and a journal entry.
  - Sumsub's deletion webhooks clear what is left.
  - Sandbox customers are deleted 90 days after their last change.
- **Default:** as stated (§6.9).
- **Alternatives:** none open.
- **Rationale:** D13's 90-day purge, and an erasure path the old product lacked.
- **Status:** Decided by the owner, 19 Nov 2026 (the 90-day purge, D13). The erasure flow is
  Recommended · **Deadline:** Sunday

### KY-11 A business waits for its people
- **Decision:** whether a business is approved only when its people are.
- **Default:** yes, in live and Sandbox alike. A person's rejection holds the business at
  `action_required`.
- **Alternatives:** the old behaviour: a business can be approved with an owner still unverified.
- **Rationale:** KYB depends on the beneficial owners being verified.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday

### KY-12 The end customer's consent version
- **Decision:** the hosted pages record an end-customer consent and privacy-notice version of their
  own, not the developer terms version.
- **Default:** as stated.
- **Alternatives:** keep the developer terms version.
- **Rationale:** the end customer consents to different terms.
- **Status:** Recommended · **Deadline:** Sunday

### KY-13 What "everything Sumsub covers" means for Sunday
- **Decision:** how far R7 reaches beyond today's product: ongoing monitoring, AML re-screening, risk
  levels and re-verification, together with the company review ([KY-05]) and owner companies ([KY-06]).
- **Default:** today's product in full (individual KYC, business KYB with its people, documents, the
  liveness selfie, requests for information, review results, go-live), plus Sumsub's ongoing signals
  (re-reviews, risk-level changes and company-structure changes) as Fin Admin flags built from
  design-system patterns and marked pending design, as a Sunday stretch lane. Monitoring queues and AML
  re-screening schedules are recorded as left out of R7 until they are designed, and R7 is marked
  partial in EXECUTION §0.2 with that list.
- **Alternatives:** the full reading on Sunday: a lane for ongoing monitoring and re-screening, with
  designs drawn first (costs most of Sunday's spare capacity and pushes Fin Admin polish to Monday); the
  narrow reading with no ongoing signals at all.
- **Rationale:** the first draft read R7 as today's product without asking; the owner decides, with the
  cost of each reading in front of them. (It was EQ-31 in the draft.)
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

## 13. Public API and docs

### AP-01 The path major
- **Decision:** the API's path version.
- **Default:** keep `/v4`, which the designs, the console's copy and the docs anchors use, and
  reserve a `Fin-Version` date header now.
- **Alternatives:** start a new product at `/v1`.
- **Rationale:** continuity costs nothing. `Fin-Version` carries later breaking changes.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### AP-02 OpenAPI from the route schemas
- **Decision:** each route is defined once with Zod schemas through `@hono/zod-openapi`. The schemas
  validate requests and generate one OpenAPI 3.1 fragment per area, which is committed; the assembled
  document is built, compared with `main`'s in CI, and read by the docs build.
- **Default:** as stated (§13.8).
- **Alternatives:** one committed `openapi.json` (the first draft: every lane edits it); a hand-written
  document with route tests, as in the old product.
- **Rationale:** one source of truth, every contract change visible in the pull request, and no file two
  lanes edit at once.
- **Status:** Recommended · **Deadline:** before Saturday's start

### AP-03 Errors as RFC 9457 problem documents
- **Decision:** error answers are RFC 9457 problem documents with these members:
  - `type`, a page per code;
  - `title`, `status` and `detail`;
  - `code`, `next_actor` and `request_id`;
  - the `errors` array;
  - an allowlist of extensions.
- **Default:** as stated (§13.2).
- **Alternatives:** Fin's own error shape.
- **Rationale:** a standard that client libraries understand.
- **Status:** Recommended · **Deadline:** before Saturday's start

### AP-04 Idempotency
- **Decision:** which requests require or accept an `Idempotency-Key`, how long keys live, and what a
  stored answer may hold.
- **Default:** following draft-08:
  - required on every POST that moves money or reserves anything;
  - accepted on every other POST and DELETE;
  - stored for 24 hours for other writes, sealed with `api`'s seal key, in a table that dumps leave out;
  - money keys bound for good to the transfer they created;
  - secret-bearing operations (creating a webhook endpoint, rolling its secret, making a hosted link)
    store only the resource ID and a marker; a replay answers without the secret, and only to the same
    API key ID; a test proves no stored row matches a secret shape.
- **Alternatives:** required on every create; stored bodies in clear (the first draft: a day of
  show-once secrets readable by several roles and replayable by any key of the organisation).
- **Rationale:** retries are safe where it matters, and a stored answer never becomes a second copy of a
  secret.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday

### AP-05 Opaque cursors
- **Decision:**
  - A cursor is base64url of a version, the sort key, the ID and a hash of the filters, with a
    truncated HMAC.
  - Lists are keyset-paged, newest first.
  - Lists have no total counts.
- **Default:** as stated (§13.4).
- **Alternatives:** offsets, or readable cursors.
- **Rationale:** a cursor cannot be edited or reused with other filters, and it reveals nothing.
- **Status:** Recommended · **Deadline:** Sunday

### AP-06 Rate-limit headers
- **Decision:** `RateLimit-Policy` and `RateLimit` in the syntax of draft-11, with no
  `X-RateLimit-*`. A 429 carries `Retry-After` and `violated_policies`.
- **Default:** as stated (§13.6).
- **Alternatives:** the legacy headers.
- **Rationale:** one standard, named in the docs as a draft that may change.
- **Status:** Recommended · **Deadline:** before Saturday's start

### AP-07 Changes to webhooks
- **Decision:** whether webhooks move to the Standard Webhooks conventions now, and how endpoints are
  enabled:
  - the body field `timestamp` instead of `created_at`;
  - a 15-second timeout instead of 10;
  - 410 Gone disables the endpoint;
  - 15 tries over about 3 days ([BC-04]);
  - https only, on ports 443 and 8443, with a signed challenge the endpoint must echo before it is
    enabled and again when its URL changes ([SA-40]);
  - a delivery cap per target host across organisations;
  - endpoint verification for live endpoints at go-live, later.
- **Default:** yes to all.
- **Alternatives:** keep the old behaviour.
- **Rationale:** the change is free before any developer depends on it, and Fin must not be made to send
  three days of retries at a third party.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday

### AP-08 Fin's own webhook delivery
- **Decision:**
  - Keep Fin's own delivery engine in Postgres, with the gaps closed:
    - a cap per endpoint and a cap per target host;
    - an email when an endpoint keeps failing;
    - a pause at the end of the retry window, holding deliveries rather than failing them.
  - Any service adopted later must be self-hosted.
- **Default:** as stated (§13.7).
- **Alternatives:** a self-hosted delivery server (Svix OSS, Hookdeck Outpost).
- **Rationale:** no vendor holds signing secrets, and nothing new needs Redis or a queue.
- **Status:**
  - Self-hosted only: Decided by the owner, 19 Nov 2026.
  - Keeping Fin's own: OWNER MUST DECIDE (a confirmation; the working choice since 19 Nov).

  **Deadline:** Sunday

### AP-09 The docs stack
- **Decision:**
  - Scalar's API reference 1.78.1, bundled with Vite into same-origin assets and themed from Fin's
    tokens, served by the docs site's assets-only deployment on `developer.` ([FD-17]).
  - Static guides in restricted Markdown, rendered by a small in-repo renderer.
  - Search over a build-time index, with the `fuse.js` that Scalar already resolves.
- **Default:** as stated (§13.10).
- **Alternatives:**
  - guides inside Scalar's introduction;
  - a Markdown library;
  - hosted search.
- **Rationale:** D43 (Scalar, self-hosted and bundled, with guides) with no new dependency for guides
  or search.
- **Status:** Decided by the owner, 19 Nov 2026 (was D43). The renderer and search are Recommended ·
  **Deadline:** Monday

### AP-10 Try it, with Sandbox keys only
- **Decision:** Scalar's own Try it panel, with five layers (§13.11):
  - a guard in the page;
  - the page policy, whose `connect-src` names `api.<zone>` ([SA-45]);
  - CORS for the docs origin only;
  - the edge refusing any key that is not Sandbox from the docs origin;
  - the per-deployment checksum salt.

  The key stays in memory only. The call goes to `api.<zone>` cross-origin, without credentials.
- **Default:** as stated.
- **Alternatives:** a separate Sandbox-only API host, kept as the fallback.
- **Rationale:** carries D54 (Sandbox keys only) and D55 (Scalar's own panel, with Fin's controls).
- **Status:** Decided by the owner, 19 Nov 2026 (was D54 and D55), carried; DECIDED again (owner, 21
  Nov 2026, about 03:50: "Try-it calls `api.<zone>` cross-origin, without credentials, using Sandbox
  keys only") · **Deadline:** decided

### AP-11 The reference page as an exception
- **Decision:** whether the Scalar reference page is a recorded exception to two rules:
  - "every interactive control comes from `@fin/ui`";
  - the static page policy ([SA-45], FW-C05): Scalar 1.78.1 writes styles at run time and draws
    images from `data:` URLs, so the docs site's profile needs `style-src 'self' 'unsafe-inline'` and
    `img-src 'self' data:`.
- **Default:**
  - the `@fin/ui` part: yes, for `/reference` alone. Every other docs page uses `@fin/ui`.
  - the policy part: yes, in the `docs` profile alone (spec 01 §7.4, spec 05 §8.11), site-wide until
    `!` detach is proven for the policy header and then on `/reference` alone; re-checked by SP-14 and
    at every Scalar bump, and a value no violation needs is dropped. **Blocking** for that part only:
    the pull request that records the owner's yes adds the two values to the profile, and until then
    the docs are uploaded with `style-src 'self'` and `img-src 'self'` and without `/reference`
    (the guides, error pages and changelog are served; R16's Try it is partial).
- **Alternatives:** build the reference from `@fin/ui` instead of Scalar (the strict policy holds, at
  the cost of rebuilding the reference and its Try it panel, [AP-10]); allow `'unsafe-inline'`
  styles but not `data:` images, if SP-14 shows Scalar renders acceptably without them.
- **Rationale:** Scalar is Vue, and the owner chose it (D43). The old product's docs ran with both
  values; styles and images cannot run script, and scripts stay `'self'`. The owner's 03:00 words
  accepted `'unsafe-inline'` styles only as FW-X7's fallback and said nothing of `data:`, so the policy
  part needs the owner's own yes.
- **Status:** OWNER MUST DECIDE (both parts; the policy part is blocking for uploading `/reference`)
  · **Deadline:** Monday (08:00 sitting)

### AP-12 A docs board, or a theme from tokens
- **Decision:** whether a docs board is drawn before the docs are built.
- **Default:** no board. Theme Scalar's CSS variables from Fin's tokens, light and dark, and mirror
  the result on the canvas afterwards.
- **Alternatives:** draw a board first.
- **Rationale:** the docs are Monday's last item.
- **Status:** OWNER MUST DECIDE · **Deadline:** Monday

### AP-13 One OpenAPI linter
- **Decision:** `vacuum`, a release binary checked by checksum, with Fin's rules. `oasdiff` checks
  breaking changes and drafts the changelog.
- **Default:** as stated (§13.8).
- **Alternatives:** Spectral, which brings an npm dependency tree.
- **Rationale:** no new package, and one linter.
- **Status:** Recommended · **Deadline:** Monday

### AP-14 Never naming a provider
- **Decision:** no provider is named in an answer, an error, an event or the docs. A build check over
  every provider name enforces this.
- **Default:** as stated.
- **Alternatives:** drop the check now that the repository is public.
- **Rationale:** developers see Fin's own words. The check stays useful because the code can name
  providers but the contract cannot.
- **Status:** Recommended · **Deadline:** Sunday

### AP-15 SDKs, collections and `llms.txt` later
- **Decision:** no SDKs, Postman collection or `llms.txt` at launch.
- **Default:** as stated. Revisit after launch.
- **Alternatives:** generate them from the OpenAPI document now.
- **Rationale:** the committed document is enough for anyone to generate them.
- **Status:** Recommended · **Deadline:** production

### AP-16 Resetting the Sandbox through the API
- **Decision:** whether the API adds `POST /v4/sandbox/reset`, to match the Simulator.
- **Default:** yes, for Sandbox keys only, with `sandbox.reset` behind it in the console.
- **Alternatives:** the console only.
- **Rationale:** the designs show it, and tests need it.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday

### AP-17 Event filters and paging back
- **Decision:**
  - `GET /v4/events` filters by type and creation time.
  - Lists page backward with `ending_before` where the screens page both ways.
- **Default:** as stated.
- **Alternatives:** none.
- **Rationale:** the designs need both.
- **Status:** Recommended · **Deadline:** Sunday

### AP-18 Searching by POST
- **Decision:** a search by email, phone or name moves from query strings to `POST
  /v4/customers/search`. `GET` lists filter only by IDs, statuses and dates.
- **Default:** as stated.
- **Alternatives:** query strings.
- **Rationale:** personal data never sits in a URL, and so never in a log.
- **Status:** Recommended · **Deadline:** Sunday

### AP-19 The deprecation notice
- **Decision:** the notice before a deprecated operation is retired.
- **Default:** at least 12 months, with `Deprecation` and `Sunset` headers. Organisations whose keys
  called the operation in the last 30 days are emailed.
- **Alternatives:** 6 months.
- **Rationale:** integrations change slowly.
- **Status:** OWNER MUST DECIDE · **Deadline:** production

### AP-20 Fin's test endpoint
- **Decision:** how a developer sees a signed delivery without a receiver of their own.
- **Default:** a test endpoint is an endpoint row with a flag, for Sandbox endpoints only; the worker
  delivers to it in-process, through the same signing code, into the same receiver handler, never over
  the network; the receiver has no public route; `deliveryFetch` keeps refusing Fin's own zones with no
  exception; one answer for an unknown and a wrong endpoint.
- **Alternatives:** a public `POST /hooks/test/<endpoint_id>` route (the first draft), which needed an
  unwritten exception in the SSRF guard and an unauthenticated route that opens a sealed secret.
- **Rationale:** the old product's "Add Fin's test endpoint" keeps working, and the guard keeps no hole.
- **Status:** Recommended · **Deadline:** Sunday

## 14. Screens, the design system and the web framework

### UI-01 Vendoring the design system's private source into the public repository
- **Decision:** whether the design system's private, Radix-based `packages/tokens` and `packages/ui`,
  the logo artwork and the motion layer would be vendored into fin-next at a pinned commit.
- **Default:** superseded. The owner chose the UI SDK as the base ([UI-10]), and only the design
  system's token values and specifications are used, so nothing of its private source is vendored,
  and the vendoring notice, sync script and drift check go. The narrower question this leaves,
  whether the ported design layer's derived text may be public, is [UI-12].
- **Alternatives:** none open.
- **Rationale:** the owner's decision of 21 Nov, about 03:25, replaces the suggestion to vendor the
  design system's private source, and with it the question of putting private source into a public
  repository.
- **Status:** Superseded, 21 Nov 2026, about 03:25 (by [UI-10]; the open part is [UI-12]) ·
  **Deadline:** none

### UI-02 The canvases as the UI source
- **Decision:** screens are built from the two R14 canvases ("Fin Dashboard · new design" and "Fin
  Admin · new design") and the design system's specifications and token values, implemented on
  the UI SDK ([UI-10]). Round 2 of the brief (20 Nov) and the owner's overnight decisions of 21 Nov
  ([UI-11]) win over earlier boards.
- **Default:** as stated (§3.4).
- **Alternatives:** none under R14.
- **Rationale:** R14. This supersedes D45, the 18 Nov design review.
- **Status:** Decided by the owner, 21 Nov 2026 (R14) and 20 Nov 2026 (the design system as the UI
  source) · **Deadline:** decided

### UI-03 Pending compositions
- **Decision:** what a builder does when the design system lacks a piece.
- **Default:** compose it only from design-system primitives and tokens, mark it pending with a UI
  request to the design system, and upstream it afterwards.
- **Alternatives:** a design-system batch of the roughly 40 open UI requests before Saturday.
- **Rationale:** otherwise those requests block parts of nearly every screen across the three days.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### UI-04 Who draws the missing boards
- **Decision:** who draws the boards that R6 to R8 need and the canvases lack, and whether they must
  exist before code. The missing boards are AdminRoles, AdminRoleEditor, unlocked Production, the
  verify pages, the docs site and money charts.
- **Default:** builders compose from primitives ([UI-03]). The boards follow the same day and are
  mirrored on the canvases.
- **Alternatives:** draw every board before its code.
- **Rationale:** keeps the days' order without inventing a design language.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### UI-05 Theme and sidebar in cookies
- **Decision:** the theme and the sidebar's collapse live in cookies, and the app server writes them
  into the templated document as closed-set attributes (FW-C04).
- **Default:** superseded. Under [FD-17] no server writes the document: it is a static file. The
  choices move to the browser ([UI-13]), and Fin sets no theme or sidebar cookie ([SA-43]).
- **Alternatives:** none open.
- **Rationale:** there is no templated document to write them into.
- **Status:** Superseded, 21 Nov 2026, about 03:50 (by [FD-17] and [UI-13]) · **Deadline:** none

### UI-06 The canvas sources under version control
- **Decision:** where the canvas sources, boards, brief and tools are kept.
- **Default:** a private design repository. Re-read the canvases once round 2 is published.
- **Alternatives:** `design/` in fin-next, which would make them public.
- **Rationale:** today the sources are on one disk only.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### UI-07 Routes the redesign moves
- **Decision:**
  - The audit log is its own page at `/audit-log`.
  - Roles are at `/settings/roles`.
  - New customer is a drawer at `?view=new`.
  - `/settings/go-live` stays.
  - The old paths redirect.
- **Default:** as stated.
- **Alternatives:** keep the old paths.
- **Rationale:** round 2 moves the audit log and roles. A drawer keeps the list in place.
- **Status:** Recommended · **Deadline:** before Saturday's start

### UI-08 The API's words and the screens' words
- **Decision:** the API keeps `test` and `live` (key prefixes, `mode` values, `live_not_enabled`)
  while screens say Sandbox and Production.
- **Default:** yes. The docs explain the mapping once.
- **Alternatives:** rename the API's words too, which breaks every key and docs anchor.
- **Rationale:** the renames are screen copy (20 Nov), and keys are long-lived.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday

### UI-09 Sidebar Option A
- **Decision:** the design system's sidebar (Option A). Option B, the two-level rail, stays a
  labelled proposal and is not built.
- **Default:** as stated.
- **Alternatives:** none open.
- **Rationale:** the owner's redesign brief. Round 2's collapsed brand cell, whose mark cross-faded to
  a sidebar glyph on hover, is superseded by the edge toggle ([UI-11]).
- **Status:** Decided by the owner, 20 Nov 2026; its hover swap superseded 21 Nov 2026, about 03:25 ·
  **Deadline:** decided

### UI-10 The UI SDK as the base of `packages/ui`
- **Decision:** what the single-page apps' components are built on.
- **The owner's decision (about 03:25):** "The single-page apps' UI is built on the UI SDK"
  (vercel-labs/ui; the npm packages `@ui-sdk/react` and `@ui-sdk/core`; Apache-2.0). "fin-next's
  `packages/ui` implements the Fin design system's components (the canvases, the team export's specs
  and tokens, the motion layer) ON the UI SDK." It replaces vendoring the design system's private
  source: "Only the token VALUES and the specs are used." The old product's redesign branch "is a
  reviewed starting point to port through fin-review".
- **Default:**
  - `@ui-sdk/react` and `@ui-sdk/core` pinned exactly, to the same version, and upgraded on purpose in
    dependency pull requests of their own ([G-06]).
  - fin-next's `@fin/ui` implements the design system on the SDK, from the canvases, the team export's
    specifications and token values and the motion layer. It starts from the redesign branch's
    design layer, which already builds 46 of the export's 48 components on the SDK, ported through
    fin-review as new code ([G-04], [UI-12]).
  - Screens import `@fin/ui` only, never the SDK.
  - The SDK's gaps are Fin's own composites: Table, WizardLayout, MoneyRoute, CopyField, Skeleton,
    Stepper and the status blocks. Toast, Drawer, OTPInput and DateRangePicker sit on SDK parts, with
    Fin's own rules.
  - The port follows the decisions newer than the redesign branch: the edge toggle ([UI-11]), the
    header organisation switcher, Audit log in the sidebar footer, one Money tab, wizards in an L
    drawer, the motion layer with its selectors remapped to the SDK's attributes, and the static page
    policy ([SA-45]).
  - No Radix, Phosphor, `clsx` or `tailwind-merge`.
- **Alternatives:** vendoring the design system's private, Radix-based source ([UI-01], superseded);
  building the components on the SDK from the specifications alone, without the port (about three
  times the work).
- **Rationale:** the owner's decision. The SDK is headless, has no runtime dependency or install
  script, and is published with provenance. It is a beta with one npm maintainer, so it is pinned
  exactly and wrapped once.
- **Status:** DECIDED (owner, 21 Nov 2026, about 03:25), superseding [UI-01]'s vendoring. The pins,
  the gap list and the port's order are Recommended · **Deadline:** decided

### UI-11 The sidebar's edge toggle
- **Decision:** how a person collapses and expands the sidebar.
- **The owner's decision (about 03:25):** "Sidebar collapse control: an EDGE TOGGLE, a small round
  chevron button on the sidebar's right edge near the top, always visible: ‹ collapses, › expands. The
  logo is a plain 24px mark linking Home, with no hover swap. This applies to the canvases now and to
  the code later."
- **Default:**
  - The button is named "Collapse sidebar" or "Expand sidebar", with `aria-expanded`, `aria-controls`
    naming the navigation, a tooltip, and a 2px nudge in its direction from the motion layer.
  - It shows at 1280px and wider, the widths where the sidebar is expanded or collapsed by the
    person's choice. From 1024px to 1279px the width forces the 64px rail, the toggle is hidden and
    the stored choice is ignored; below 1024px the phone keeps the sheet, with no toggle. This is the
    brief's rule (round 2, §11 item 4, with shell-v2 §10), which the canvases draw. Fin Admin has the
    same toggle.
  - "Always visible", the owner's words, means shown at rest, not only on hover or focus, on every
    page, at every width where the sidebar is expanded or collapsed by choice: 1280px and wider.
  - The choice is remembered per viewer in the browser ([UI-13]) and applies at 1280px and wider only.
  - The motion layer's brand swap (`.fin-brand-swap`) is dropped. The toggle is filed as a UI request
    to the design system ("Sidebar collapse toggle") and drawn on the Sidebar boards.
- **Alternatives:** round 2's brand cell as the expand button, with the mark cross-fading to a sidebar
  glyph on hover.
- **Rationale:** the owner's decision.
- **Status:** DECIDED (owner, 21 Nov 2026, about 03:25), superseding round 2's brand-cell hover swap
  ([UI-09]). The widths are Recommended, from the brief; the owner may overturn them (spec 06 §14,
  open item 4), and an overturn changes [UI-11], spec 06 §4.2 and S6-06, ARCHITECTURE §3.4 and
  AC-SAT-24 together · **Deadline:** decided

### UI-12 The ported design layer in a public repository
- **Decision:** whether the old product's design layer may go into the public fin-next as it is.
  Part of its text, mostly comments, class strings and accessible copy, is taken from the design
  system's private source, and it carries the logo's paths and references to private design
  documents. The measured share is in the research behind this plan, which stays outside the
  repository. The owner's 03:25 decision names the redesign branch as the starting point and says
  only the token values and specifications are used; both hold only if the owner says this derived
  text may be public.
- **The question also covers three verbatim copies** from the design system's private export and
  canvases, which the plan would otherwise commit without an answer:
  - `fin-motion.css`, vendored byte for byte from the pinned canvas snapshot into `packages/motion`,
    with a hash test (ARCHITECTURE §3.4; spec 06 §5.1);
  - the export's token file, kept as a verbatim pin for the drift test (`packages/tokens`);
  - the export's woff2 font files (Inter and Fira Mono, under the OFL) with their notices.
- **Under a no**, each is rebuilt with no verbatim copy: `fin-motion.css` from the motion spec and
  the token values, with the hash test pinning Fin's own file; the drift test pins token names and
  values only; the fonts come from each font's upstream release.
- **Default:** yes. Keep the text; strip every private-document reference and change sample domains
  to `example.com` in the port's first commit; extend the notices (the design system as the source,
  plus the third-party icon, flag and font notices the layer carries); keep the logo under [G-03]'s
  reservation of brand assets.
- **Alternatives:**
  - rewrite the comments (about 2 hours) and keep the class strings, which the specifications dictate
    anyway;
  - a clean rebuild from the specifications (about three times the cost of the port).
- **Rationale:** the design system is the owner's own work, and a repository that is public for CI
  publishes whatever it holds (R12).
- **Status:** OWNER MUST DECIDE (**blocking** for the design-layer port, and so for screens) ·
  **Deadline:** before Saturday's start

### UI-13 Theme and sidebar choice in the browser
- **Decision:** where the theme and the sidebar choice are remembered, now that the document is a
  static file.
- **Default:** in `localStorage`, per host, read and written inside try/catch, as conveniences only. An
  external, render-blocking `/theme.js` in `<head>` (allowed by `script-src 'self'`, never inline) sets
  `data-theme` on `<html>` before the first paint, so there is no flash, and the themed skeleton is in
  the static HTML. Each app remembers its own choice.
- **Alternatives:** cookies written into a templated document ([UI-05], superseded: there is no server
  for the document); the system theme only.
- **Rationale:** the page policy allows no inline script, and a static file cannot be templated.
- **Status:** Recommended · **Deadline:** before Saturday's start

### FW-01 The web framework for the console, Fin Admin and verify
- **Decision:** the framework for the three browser apps.
- **The owner's decision (about 03:00):** "Framework: the single-page app (Shape B) stays." "Hono
  stays, but only as the API and auth server on Railway, reached through the cloudflared tunnels."
- **Default:** **Shape B for all three**: each app a Vite 8, React 19.3.1 single-page app with TanStack
  Router 1.170.46 on the UI SDK ([UI-10]), built to hashed static files that Cloudflare serves
  ([FD-17]). Each app's own Hono process on Node 26.13.1, on Railway, serves only `/api/*` on the
  app's host ([FD-18]): the app's auth realm and Fin's app API routes (Zod-validated JSON, Fin's
  guards, signed calls to `api` and `payments`). No React on the server, no server functions, no React
  Server Components. It binds conditions FW-C01 to FW-C22 and verify's ladder (ARCHITECTURE §3.4), the
  spikes FW-S1 to FW-S7 and the reversal triggers FW-X1 to FW-X8, amended overnight on 21 Nov:
  - FW-C02: the host package keeps the front door, the origin gate, the error envelope, health and
    readiness, the scrubbing console and the route-policy helper. Static serving and templating leave
    it.
  - FW-C03: the front door loses its static-file and document steps. On Fin Admin the Access token is
    checked on every `/api/*` request, and Access at the edge guards the static files ([FD-05]).
  - FW-C04: the document is a static `index.html` with no nonce, carrying the nonce-less `csp-nonce`
    meta, the themed skeleton and an external `/theme.js` ([UI-13]).
  - FW-C05: the page policy comes from each app's `_headers`, with `style-src 'self'` and no nonce
    ([SA-45]).
  - FW-C06: rewritten under the same ID: injected styles pass as constructed style sheets under the
    UI SDK's nonce-less meta. There is no Radix and no `__webpack_nonce__`.
  - FW-C09: its cookie line is replaced by [SA-43], and its checks by [SA-44], which add `X-Fin-App`.
  - FW-C10: the redirect on a missing session cookie before any JavaScript runs goes, because no code
    runs where the document is served. The first API call decides, behind the skeleton.
  - FW-C13: the previous release's hashed assets ride in each static upload, not in each image.
  - FW-C16: readiness no longer waits for a templated document.
  - FW-C17: journeys run against the built `dist/` with the production `_headers` and the API servers,
    behind a local path-routing proxy that mirrors [FD-18].
  - FW-C20 and FW-C21: as [SA-26] and [SA-37].
  - FW-S1 tests the UI SDK's overlays and inputs (Drawer, Modal, Select, DropdownMenu, Toast, Tooltip,
    OTP input, Table) under the static policy: no violation, and scroll locked. FW-S3 measures
    edge-served static documents.
  - Verify's ladder starts at its old step 2, so [FW-03] is withdrawn. FW-X1's step 3 (verify rendered
    on a server) would also reopen [FD-17] for verify. FW-X7 is [SA-45]'s fallback.
- **Alternatives:**
  - TanStack Start (6.8 of 10 weighted): it decodes every client-referenced server function's body with
    `seroval` before any guard runs (verified in the installed source); its CSRF registration is silent
    in production; server-rendered style attributes need a page-policy exception; first-load failure
    states need server fault switches compiled out of production.
  - React Router framework mode, 8.5 (6.3) or 7.18 (6.0): every loader is a public `.data` endpoint, its
    CSRF check passes a request with no `Origin`, a heavy 2026 advisory record, the same style-attribute
    conflict, and a major version due within months of launch.
- **Rationale:** the panel's judge, 21 Nov (scores and reasons merged into ARCHITECTURE §3.4): the
  smallest server surface where attackers have no session; `script-src 'self'` with no nonce
  plumbing; every failure state reachable with one `page.route`; the design system fits with no
  exception; a tie on speed this weekend, because the router is the same. Costs: a skeleton on cold
  loads, Fin-owned glue (smaller now that no server templates documents), two files per feature. The
  owner then confirmed it.
- **Status:** DECIDED (owner, 21 Nov 2026, about 03:00), which closes FW-Q1; the hosting amended about
  03:50 ([FD-17]). The amended conditions are Recommended · **Deadline:** decided

### FW-02 Verify without JavaScript
- **Decision:** must verify work without JavaScript, apart from the selfie step? (FW-Q2)
- **Default:** no. Sumsub's steps need JavaScript anyway. A yes moves verify alone to React Router 8.5
  with progressive forms (FW-X2), accepting a second router and its review cost. A yes now also needs
  a server for verify's documents, which [FD-17] does not have.
- **Alternatives:** yes.
- **Rationale:** the selfie and any Sumsub SDK step are JavaScript-only.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday (before the verify work)

### FW-03 Verify's documents cached at the edge, on a trigger
- **Decision:** if verify missed its budget because of the round trip from far regions, could verify's
  documents drop the style nonce, so they could be cached at Cloudflare's edge? (FW-Q3)
- **Default:** withdrawn. Under [FD-17] every app's documents and assets are already static files at
  Cloudflare's edge, with no nonce ([SA-45]). Verify's ladder starts at what was its step 2.
- **Alternatives:** none needed.
- **Rationale:** the question belonged to documents templated on Railway.
- **Status:** Withdrawn, 21 Nov 2026, about 03:50 (moot under [FD-17]) · **Deadline:** none

### FW-04 First-load budgets
- **Decision:** the starting budgets CI enforces. (FW-Q4)
- **Default:** verify's landing route at most 150 KB gzip of JavaScript, with p75 LCP of at most 2.5 s
  on a throttled mid-range phone from two regions far from US East; the console's first route at most
  250 KB gzip. Revised after FW-S3.
- **Alternatives:** other numbers.
- **Rationale:** a skeleton-first app needs a measured bound on what runs before it paints.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

## 15. Operations

### OP-01 Kill switches
- **Decision:** how one kind of work is stopped in minutes, without a deploy.
- **Default:** database switches read on every request with no cache (live money, in all or per
  provider instance; live keys; sign-ups; hosted verify; outbound webhooks; Sumsub writes), set from Fin
  Admin with `switches.manage` and a step-up intent or by `pnpm fin switch`, audited and emailed;
  automatic trips of the money switch on an idempotency mismatch, a transfer sent after its end, an
  orphan payout or reconciliation breaks above a threshold; prepared, disabled Cloudflare WAF rules
  toggled by `pnpm fin killswitch` with the Cloudflare token alone, for when Railway cannot be reached;
  a test for each switch and a drill for the Cloudflare rules. The switch table and its reads land on
  Saturday, the money trips on Monday, the Cloudflare rules in hardening.
- **Alternatives:** the instance's `liveEnabled` flag alone (a reviewed pull request and a deploy: 25 to
  40 minutes of review, and impossible while Railway's API is down); per-organisation pauses only.
- **Rationale:** a double payout or a misbehaving adapter at night needs a stop within minutes.
- **Status:** Recommended · **Deadline:** before Saturday's start (the design); production (all of it)

### OP-02 Incident response
- **Decision:** how incidents are run.
- **Default:** `docs/operations/incident-response.md`: SEV1 to SEV3 mapped to P and N; an incident
  commander named in the roster, with a hand-off rule; a first-15-minutes checklist
  (acknowledge, kill switch, status page, export Railway's audit log at once, snapshot logs); message
  templates; vendor contacts in the private overlay; the 72-hour personal-data breach clock with
  counsel; a blameless review within 5 working days, stored privately with its action items; playbooks
  for a Railway variable leak, a tunnel token leak, leaked API keys at scale, a double payout or
  idempotency mismatch, a reconciliation break, personal-data exposure, a failover with lost commits,
  an email outage, a Better Stack outage, a Cloudflare outage, Railway down, and the owner unreachable.
- **Alternatives:** runbooks per alert only.
- **Rationale:** the first draft had no incident process at all.
- **Status:** Recommended · **Deadline:** production

### OP-03 The restore runbook
- **Decision:** the steps of a database restore, with times.
- **Default:** `docs/operations/restore.md` (ARCHITECTURE §15.3): trip the money switch; restore to a
  sibling; re-enable PITR; HA or single-node until a date; re-pin the CA and swap hosts with `/readyz`
  refusing until the marker is complete; quarantine `applicant_write` rows (re-read each applicant
  first) and side-effecting jobs; run the ledger walk and orphan listing over the lost window before
  unfreezing money; tell developers about missing events. Measured in SP-17 and a staging drill.
- **Alternatives:** restore by the platform's button and improvise the rest.
- **Rationale:** a restore re-sends stale queues and loses transfers whose payouts happened.
- **Status:** Recommended · **Deadline:** production

### OP-04 Losing Railway
- **Decision:** where Fin is rebuilt, who decides when, and how much is lost.
- **Default:** a fresh Railway workspace in another region by default, otherwise a VM running the same
  images under Docker Compose (`ops/environments/dr.json`); the hourly dump of the high-value schemas
  ([DA-15]) bounds money and audit loss to about an hour; when Railway has been down for more than 4
  hours with no estimate, the owner decides between waiting and rebuilding; a reconciliation against
  MassPay before money moves again; rehearsed once before production.
- **Alternatives:** "rebuild within a day" with no target or rehearsal (the first draft).
- **Rationale:** recent outages ran 8 hours platform-wide and 4.3 hours in US East.
- **Status:** OWNER MUST DECIDE (the target and the invocation rule) · **Deadline:** production

### OP-05 The credential inventory and expiry warnings
- **Decision:** how no credential expires unnoticed.
- **Default:** `ops/credentials.json` listing every credential's name, holder, issuer, dates, cadence and
  runbook (never a value), validated by `monitoring:check`; a daily worker duty, and in production the
  watcher, notifies at 30 and 14 days and pages at 7 days before expiry; a heartbeat per rotation
  cadence; staggered expiries.
- **Alternatives:** failure-time alerts only (the first draft: an expired email token stops every
  sign-in code, an expired R2 token silently stops backups).
- **Rationale:** Sumsub tokens, the email token, R2 tokens and others expire on fixed dates.
- **Status:** Recommended · **Deadline:** before Saturday's start (the file); production (complete)

### OP-06 Rotation runbooks for every family
- **Decision:** which runbooks exist before production.
- **Default:** `docs/runbooks/rotate-<family>.md` for every family in ARCHITECTURE §7.8 (tunnel tokens,
  ingress proofs, caller keys with their two ordered deploys, the pepper and its re-hash, the Better
  Auth secrets and their re-encryption, seal and index keys, database logins, MassPay, Sumsub, the email
  token, R2, the staging Railway token in GitHub, Better Stack tokens and heartbeat URLs, the
  receipt-signing key, the canary key), each with the order, the verification, the rollback, the number
  of deploys and the Railway-down fallback; a check that every alert's runbook and every inventory row's
  runbook exists; each run once before production.
- **Alternatives:** runbooks for the seal keys and the email token only (the first draft).
- **Rationale:** a rotation without a runbook is an outage waiting to happen.
- **Status:** Recommended · **Deadline:** production

### OP-07 The failure-mode table
- **Decision:** one place that says what happens when each dependency fails.
- **Default:** `docs/operations/failure-modes.md`, one row per dependency (Railway's control plane,
  region and private network; the Postgres primary; the connectors; Cloudflare's edge, Access and Email
  Sending; R2; Better Stack; Sumsub; MassPay; GitHub and GHCR), with the impact, the detection, the
  response, whether it needs a deploy, and its alert and runbook; reviewed at each production gate.
- **Alternatives:** none written.
- **Rationale:** a response that needs a deploy is no response while Railway is down.
- **Status:** Recommended · **Deadline:** production

### OP-08 Service objectives and launch capacity
- **Decision:** what "working" means in numbers, and how much traffic the launch must carry.
- **Default:** launch capacity (requests per second at the edge, organisations, onboardings and
  transfers per day) sizing the load test; objectives for API availability, API p95 latency, a sign-in
  code within 60 seconds, a webhook's first attempt within 10 seconds and transfer status freshness;
  paging tied to burn rate; the status page showing the same components. The numbers are set by the
  owner and kept in the private overlay.
- **Alternatives:** "a load test sized to launch traffic" with no numbers (the first draft).
- **Rationale:** an alert with no objective behind it is a guess.
- **Status:** OWNER MUST DECIDE (the numbers) · **Deadline:** production

### OP-09 Provisioning from scratch before production
- **Decision:** whether the first full run of `pnpm fin provision` may be production's.
- **Default:** no: before production, a throwaway environment (or staging rebuilt) is provisioned from
  scratch with `pnpm fin provision`, then the smoke tests and drills run on it, and `pnpm fin verify`
  reports no drift against the settings file.
- **Alternatives:** provision production first.
- **Rationale:** staging is provisioned by hand on Saturday.
- **Status:** Recommended · **Deadline:** production

## 16. Behaviour carried or changed from the old product

Each of these would have changed or disappeared without a decision (ARCHITECTURE §14.6).

### BC-01 The old product's step-ups
- **Decision:** whether every step-up the old product asked for stays.
- **Default:** keep every one: creating a customer, filling in a customer's details, creating a customer
  link, opening a virtual account, simulating deposits, accepting an invitation, changing one's name,
  sending a test event, pausing or resuming an endpoint, redelivering, editing an endpoint's events and
  deleting an invitation. Windows for those that mint or move nothing; intents for the rest.
- **Alternatives:** the first draft's shorter list, with "when in doubt, ask for the factor" left to
  builders.
- **Rationale:** cheap, because the StepUp master already draws them.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### BC-02 Webhook analytics
- **Decision:** whether the Delivery health tiles and charts and the endpoint's Analytics tab come back.
- **Default:** restore them in H-02, from an aggregate route over the deliveries table; until then the
  screens show the deliveries list.
- **Alternatives:** drop them (they were left out silently in the first draft).
- **Rationale:** developers used them to see a failing endpoint at a glance.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday

### BC-03 Address and device on audit rows
- **Decision:** whether every audit row shows the address and device, as the old audit log did.
- **Default:** store the client address and a user agent of at most 400 characters for every audit
  row made by a console or Fin Admin actor, and keep the search by a person, key or address. They
  live in `audit.event_context`, linked to the row but outside the hash chain, and are kept 13
  months, so the chain itself holds no personal data (spec 08, D08-02 and D08-34; appendix C, SF-10).
- **Alternatives:** sign-in and security events only (the first draft); the address and device inside
  the chained row, kept for the life of the audit trail.
- **Rationale:** the old audit log showed "{address} · {device}" on every row; this is personal data
  under the retention table.
- **Status:** OWNER MUST DECIDE (the storage outside the chain is Recommended, appendix C, SF-10) ·
  **Deadline:** before Saturday's start

### BC-04 Fifteen delivery tries
- **Decision:** the number of webhook delivery tries.
- **Default:** 15 tries over about 3 days, so the boards' "Try 2 of 15" stays right.
- **Alternatives:** 10 tries (the first draft), and change the boards' copy.
- **Rationale:** the boards and the old product agree on 15.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday

### BC-05 An API key's "last used"
- **Decision:** whether keys show when they were last used.
- **Default:** keep it, rounded to the minute, written after the response at most once a minute per key.
- **Alternatives:** drop it.
- **Rationale:** developers find unused keys with it.
- **Status:** OWNER MUST DECIDE · **Deadline:** Saturday (with API keys)

### BC-06 Ten organisations as Super admin
- **Decision:** the limit on organisations one person may hold as Super admin.
- **Default:** keep the old limit of 10.
- **Alternatives:** no limit.
- **Rationale:** a sign-up flood should not make thousands of organisations per person.
- **Status:** OWNER MUST DECIDE · **Deadline:** before Saturday's start

### BC-07 Organisations that cannot be deleted
- **Decision:** when deleting an organisation is refused.
- **Default:** keep "an organisation approved for live can't be deleted here", and widen it: no
  organisation or customer with a balance, a hold or a non-final transfer can be deleted ([MO-22]).
- **Alternatives:** the old rule alone.
- **Rationale:** deletion must never strand money.
- **Status:** OWNER MUST DECIDE · **Deadline:** Sunday

## 17. The 19 Nov decisions, and later owner answers, mapped

### 17.1 D1 to D57

The 19 Nov register of the Railway plan, numbered D1 to D57. "Holds" means the owner's answer stands
in fin-next.

| 19 Nov | Subject | In fin-next |
|---|---|---|
| D1 | The plan and its phase order | Superseded by the new plan (R13, [G-01]) |
| D2 | Where Postgres lives | Holds: [P-09] |
| D3 | What drives Railway's configuration | Holds, with a thin first version: [P-13] |
| D4 | The dependency changes | Replaced by a new starting set: [G-06] |
| D5 | How top secrets are held | Holds for staging; production is open: [DA-10] |
| D6 | Railway layout and plan | Holds: [P-03] |
| D7 | GitHub organisation settings and Team | Superseded by rules on a personal public repository: [CI-01] |
| D8 | Better Stack setup | Holds (region `europe`): [OB-02]; responders: [OB-06] |
| D9 | Monitoring as code | Holds: [OB-05] |
| D10 | The audit head store | Open: [AU-03] |
| D11 | Edge and api apart, with signed calls | Holds, extended to every caller with Ed25519 signatures and the door matrix: [P-07], [SA-23], [SA-36] |
| D12 | The edge's key store | Changed to a direct lookup: [SA-19] |
| D13 | Personal-data choices | Holds: [DA-05], [KY-10] |
| D14 | Review budget and models | Superseded (the import programme is gone): [RV-13] |
| D15 | Where images are built | Changed (public GHCR, no registry credential): [P-08], [CI-05] |
| D16 | Whether CI may hold a secret | Revised for staging, with the owner's account approving in batches: [CI-03]; the review credential: [RV-05] |
| D17 | Runtime | Holds, re-checked for R15: [P-05] |
| D18 | Counsel on retention and the processor or controller role | Open: [DA-08] |
| D19 | "Railway VPC" | Holds: [P-03] |
| D20 | Staging data | Holds (start fresh): [P-03] |
| D21 | Recovery targets | Open: [P-14] |
| D22 | Production accounts | Holds: [P-03], [DA-09], [OB-11] |
| D23 | Who holds the personal-data keys | Holds, strengthened: [DA-07] |
| D24 | Signed review receipts | Holds, brought forward to Phase 0: [CI-11] |
| D25 | Fin Admin's identity provider | Holds: [FD-05] |
| D26 | Watching Better Stack's configuration | The daily canary and the drift check: [OB-17], [AU-05] |
| D27 | The watcher's Railway token | Open (a Viewer-only user if SP-21 passes): [OB-11] |
| D28 | Who owns the recurring duties | Holds: the owner, until there is a team ([OB-06] for on-call) |
| D29 | Storage vendor (R2) | Holds: [DA-09] |
| D30 | Email provider | Decided by R3: [EM-01]; the beta acceptance and a second sender are open: [EM-02], [EM-03] |
| D31 | Where the watcher runs | Holds for staging, now live from the first staging deploy; production is open: [OB-11] |
| D32 | Hardware keys for production escrow | Open: [DA-10] |
| D33 | Closing the AWS project account | Dropped: fin-next has no AWS account |
| D34 | What to keep from staging AWS | Dropped: old-repository work |
| D35 | Whether "no AWS" covers vendors that run on AWS | Dropped: fin-next has no AWS account of its own, and each vendor's sub-processors are read under that vendor's decision |
| D36 | Whether the AWS phase-out covers money movement | Holds: no AWS anywhere (ARCHITECTURE §14.4) |
| D37 | Where production's `pnpm fin` runs | Holds: [CI-04] |
| D38 | Production staffing | Holds, with the responder gate: [OB-06], [P-03] |
| D39 | What the vault keeps in clear | Open: [DA-11] |
| D40 | A new repository, or the same one | Superseded by a public repository: [G-02] |
| D41 | How changes are reviewed | Changed by R10 and R11: [RV-01] to [RV-03] |
| D42 | Staging hostnames | Kept as the fallback; a new staging zone is the default: [FD-09] |
| D43 | API docs | Holds, with Try it narrowed by D54: [AP-09] |
| D44 | Security profile per environment | Holds: [G-05] |
| D45 | The 18 Nov design review | Superseded by R14's canvases: [UI-02] |
| D46 | Security email deliverability | Holds: [EM-05] |
| D47 | The review audit's choices | The audit lock fix's intent holds, by a sequencer instead of a lock: [AU-02]. The second sceptic holds: [RV-08]. The rest was import-programme work, dropped |
| D48 | The email switch on today's Workers | Dropped: old-repository work |
| D49 | The old repository's exceptions | Dropped: old-repository work |
| D50 | Which Flow Atlas is published during the move | Dropped for the old repository; fin-next's own atlas: [G-07] |
| D51 | A Sumsub token for the document viewer | Holds: [KY-04] |
| D52 | The old dashboard hostname's redirect | Holds only under the shared-zone fallback: [FD-09] |
| D53 | The owner's standing notes on merging | Done (not a repository change); the ship-step rule: [RV-01] |
| D54 | Which keys Try it takes | Holds (Sandbox keys only): [AP-10] |
| D55 | Scalar's own Try it panel | Holds: [AP-10] |
| D56 | A per-deployment checksum salt | Holds: [SA-18] |
| D57 | Where GitHub credentials live | Replaced from Phase 0 by a builder machine account: [CI-13] |

### 17.2 Owner answers without a D number

| Date | Answer | In fin-next |
|---|---|---|
| 18 Nov | Sumsub's selfie page may load Sumsub's WebSDK and frame | Holds: [SA-26] |
| 18 Nov | No documents are uploaded when going live | Holds: [KY-05] |
| 19 Nov | AWS is phased out entirely | Holds: fin-next never has AWS (§14.4) |
| 19 Nov | Staging's vault and watcher share the staging Cloudflare account (an accepted risk); production's are separate | Holds: [DA-09], [OB-11] |
| 19 Nov | Organisation roles and invitations as designed | Holds: [SA-11] |
| 19 Nov | Staff roles editable in Fin Admin with a fresh factor and two guards; no approvals ("keep it simple") | Holds: [SA-13], with the outrank rule ([SA-32]); R6 adds prebuilt staff roles ([SA-12]) |
| 19 Nov | Fin Admin's own staff sign-in behind Access | Holds: [SA-15], [FD-05] |
| 19 Nov | Webhooks: any service adopted must be self-hosted | Holds: [AP-08] |
| 19 Nov | fin-review covers CI and the delivery pipeline, and every tracked file including itself | Holds: [RV-02] |
| 19 Nov | Speed levers: parallel work, Sonnet for bookkeeping, the retro beside core; no "save" mode | Parallel work holds. Sonnet is withdrawn by R11 ([RV-03]). No "save" mode holds |
| 19 Nov, 13:00 | Everything in fin-next is new; no copied code | Holds, with the owner's one exception of 21 Nov (the design layer): [G-04] |
| 19 Nov, 13:20 | A clean, private new repository | Superseded by [G-02] |
| 19 Nov, 14:30 | A fast fresh build: the per-PR review shape, builders from specifications only, with a copy check | Holds: [G-04], [RV-01] |
| 19 Nov | Full depth stays; the old repository stays open for features, each change ported | Superseded: nothing is ported in a from-scratch build |
| 19 Nov | Old-repository staging deploys pre-approved | Dropped: old-repository work |
| 20 Nov | fin-next dropped; the move to happen in place | Superseded on 21 Nov by R1 and R12: [G-02] |
| 20 Nov | Money: what Fin keeps and never keeps | Holder names hold: [MO-10]. "Never kept" is proposed for reversal: [MO-03], [MO-04] |
| 20 Nov | Businesses wait for enrolment; USD only | Holds: [MO-09], [MO-11] |
| 20 Nov | The developer Sandbox on MassPay's sandbox | Proposed for reversal: [MO-05] |
| 20 Nov | The design system as the UI source; the renames ("Log out", "Go to Production", "Sandbox data"); sidebar Option A | Holds: [UI-02], [UI-08], [UI-09]; built on the UI SDK ([UI-10]); round 2's hover swap superseded by [UI-11] |
| 21 Nov | R1 to R16 | Current: [G-01] |
| 21 Nov, about 02:40 | Front door: cloudflared tunnels for all hosts; separate public and admin tunnels and tokens; a connector watch every minute; an evict runbook; Cloudflare headers trusted only from connector peers; the proxied design an option after launch; the database tunnel as researched | Holds: [FD-01], [FD-11], [FD-13], [FD-14], [FD-15], [FD-16] |
| 21 Nov, about 03:00 | The single-page app (Shape B) stays; Hono only as the API and auth server on Railway | Holds: [FW-01] |
| 21 Nov, about 03:00 | Static files on Cloudflare Pages; a `_headers` file per app; `index.html` no-cache and hashed assets immutable; nothing that cannot move to another host; builds in GitHub Actions uploaded with a pinned CLI; "anything from cf that we can easily migrate" | Pages superseded at about 03:50 ([FD-17]). The rest holds: [SA-45], [FD-17], [FD-19], [P-02], [OB-18] |
| 21 Nov, about 03:00 | Per-app API hosts, cross-origin on the same site with CORS | Now [FD-18]'s fallback |
| 21 Nov, about 03:10 | Same-host routing with Origin Rules; host-only `__Host-` cookies, the session Strict and the state cookie Lax; an Origin check and a custom header; a 15-minute spike | Origin Rules superseded at about 03:50 ([FD-18]). The rest holds: [SA-43], [SA-44], [FD-18] |
| 21 Nov, about 03:25 | The UI SDK as the apps' base; the old product's redesign branch as the reviewed starting point | Holds: [UI-10], [G-04]; supersedes [UI-01]; the open part is [UI-12] |
| 21 Nov, about 03:25 | The sidebar's edge toggle; a plain 24px logo; no hover swap | Holds: [UI-11] |
| 21 Nov, about 03:50 | Assets-only static deployments; one host per app with a no-Worker `/api/*` route; the cookie and CSRF rules; the spike and its fallback; `api.` straight to the tunnel; Try it without credentials | Holds: [FD-17], [FD-18], [SA-43], [SA-44], [FD-14], [AP-10] |

## Appendix A. Critic findings and how each was resolved

Three critics reviewed the first drafts of ARCHITECTURE, DECISIONS, EXECUTION and the framework
verdict on 21 Nov 2026: a security critic (CF-01 to CF-38), an operations critic (CF-39 to CF-77)
and a consistency critic (CF-78 to CF-97). Every blocker and every major finding is resolved; every
minor one is resolved too, in some cases in part, as the row says. "Arch" is ARCHITECTURE.md and
"Exec" is EXECUTION.md.

| ID | Sev. | Finding | How it was resolved | Where |
|---|---|---|---|---|
| CF-01 | blocker | The owner decided tunnels for all hosts; the drafts still built proxied DNS and left the tunnel's own controls unplanned | Front door rewritten as tunnels: public, admin and db tunnels, each token on its own service; no domain or TCP proxy, checked by the watcher; an ingress map fixed in code with a 404 catch-all; a connector watch from outside Railway from the first staging deploy; a blue and green evict, drilled; metrics on loopback with a watchdog; trust only from a current connector peer **and** a per-host proof; the Access token checked at the admin connector and in the app; SP-04, NB-07 and AC-P0-07 replaced; the shared Workers ranges recorded for the proxied option | Arch §2.1, §4.2, §5; [FD-01], [FD-13] to [FD-16]; Exec §1.6, §2 |
| CF-02 | blocker | `gate` is defined by the pull request's own workflow; agents hold the owner's full login; receipts are unsigned and posted by comment | A builder machine account whose token cannot change workflows, settings or environments; only the CI lane's session may change workflow files; CODEOWNERS and code-owner review on control paths, refused by `main`'s checker without the owner's approval, plus typed confirmation; receipts signed with Ed25519 by the `fin-review` OS user from Phase 0, carried in a ref, never in comments; control paths excluded from pre-approvals; the gate stated as advisory until all of this exists | Arch §11.1, §11.6; [CI-11], [CI-13], [CI-14], [G-10] |
| CF-03 | blocker | EXECUTION had no edge service and put key checks, hooks and money jobs in the wrong services; tier S names drifted | EXECUTION rebuilt on ARCHITECTURE's layout: `apps/edge` lane, worker code in `apps/api/src/worker/`, money jobs and hook door in `apps/payments`; `tools/layout.json` as the one source of names and tiers for both documents | Arch §3.1; [P-07]; Exec §1.3, §2.8, §3.2, §5.2 |
| CF-04 | major | A new or reset staff member enrolled on an emailed code alone; PIN-only Access; no reset permission | Enrolment codes that never travel by email, pending accounts with no permission, every Admin told, a passkey first factor in production; `staff.reset_factors` (Admin-only, intent); Google Workspace with 2-Step Verification for staging Access before provider credentials | Arch §5.10, §7.3, §7.6; [SA-29], [SA-14], [FD-05] |
| CF-05 | major | HMAC caller keys let every verifier pose as the caller; no audience; no payments-to-api operations | Ed25519 signatures with the callee as audience and a nonce, a replay table for non-idempotent operations, and the door matrix as a tested file including `payments` to `api`'s holder door | Arch §7.9; [SA-23] |
| CF-06 | major | Doors trusted the caller; the edge's assertion was everything; the stated limit understated the console | Every door operation declares its checks and the callee enforces them from its own views with database time; `payments` re-reads the key record; quotas and switches inside `payments`; door volume caps; the stated limit corrected | Arch §7.9, §12.2; [SA-36] |
| CF-07 | major | One step-up proof opened every sensitive action for 5 minutes | Step-up intents bound to the action and a digest of its parameters, used once, for everything that mints a credential or moves money, in both realms; per-transfer intents from the first money merge; windows only for reveals. (The consistency critic's suggestion to keep the window until live money was superseded by this.) | Arch §7.4; [SA-08]; Exec §5.1, AC-MON-09 |
| CF-08 | major | The mandatory factor was evaluated for the active organisation only; trusted browsers undefined | Evaluated per request against the target organisation and every organisation the person holds a privileged role in, at invitation acceptance and role elevation; trusted browsers as server-side rows, none for privileged people or Production organisations, `aal1`, never a proof, with tests | Arch §7.3; [SA-05], [SA-31] |
| CF-09 | major | No rule stopped acting on someone who outranks you; last-holder check untested under concurrency | The outrank rule in both engines, team-change and staff-change locks, property tests and a two-concurrent-demotions test | Arch §7.6; [SA-32] |
| CF-10 | major | Keys and webhook secrets made or seen by a removed member kept working | Listed and rolled by default with the shortest overlap; who saw each secret recorded; a journal entry; admins emailed; keys whose maker lost the permissions flagged | Arch §7.6; [SA-33] |
| CF-11 | major | The audit guarantee lived in application code; `fin_owner` was standing and owned the table watching it | `audit.record()` stamps login, application, backend, transaction and time and checks a per-role allowlist; deferred guard triggers refuse critical commits without an audit row; ledger append-only with an anchored head; `fin_owner` per-run passwords; the privileged-login table owned by the superuser; SP-05 records where the HA superuser password lives | Arch §6.3, §8.2; [AU-02], [AU-08], [P-18] |
| CF-12 | major | The head lock let any login stall all audited writes | Chaining taken off the write path: rows inserted with no lock and sequenced by the worker; append-only triggers protect unchained rows; an alert on unsequenced rows; a load test | Arch §8.3; [AU-02] |
| CF-13 | major | Stored idempotent bodies held show-once secrets | Secret-bearing operations store only the resource ID and a marker; replays without the secret, same key ID only; stored bodies sealed and left out of dumps; a test for secret shapes | Arch §13.3; [AP-04], [DA-15] |
| CF-14 | major | The link token sat in every API path and next to Sumsub's script; `*.sumsub.com` | The token exchanged for a host-only cookie and a token-free path; refill only to the entering browser; the selfie on its own origin at a one-time path with only the SDK token; exact Sumsub hosts; Logpush path redaction with a test; the link's life shortened after first use | Arch §7.12, FW-C21; [SA-37], [SA-26], [FD-08] |
| CF-15 | major | Test seams in the released image, or tests that do not exercise it | `test` and `release` image targets; a CI job starting release images with each seam variable expecting exit 78; hard-coded allowlists in release; a release smoke on staging | Arch §3.5; [SA-38], [P-08] |
| CF-16 | major | A free Sandbox key could burn mail reputation, store unlimited documents and aim retries at third parties | Sandbox customer mail only to members' confirmed addresses; daily budgets per organisation and new account with a breaker; a Sandbox document quota; endpoint challenge, https on 443 or 8443, a cap per target host; sign-up velocity limits | Arch §7.5, §7.11, §13.7; [SA-40], [DA-13], [AP-07] |
| CF-17 | major | A per-kind limit could hide the notice that matters | Notices never dropped: digests past the limit, ranking by what changed, refusal of a credential action whose notice cannot be queued, `security-email-unsent` | Arch §7.5, §9.5; [SA-41] |
| CF-18 | major | Lost commits and double pays, no value caps, treasury and simulations not locked, no uniqueness, deletion with money | Replica confirmation before payouts; one server-issued transfer intent across console retries and a similar-transfer warning; orphan checks every 5 minutes; value caps, a second approver, a first-payout delay; address allowlists for live money keys; treasury and simulations refused in live production; unique postings and deposits; deletion refused while money is held | Arch §12.4, §12.7, §12.12, §13.6; [MO-18] to [MO-22], [MO-07] |
| CF-19 | major | Built-ins in the gate and bootstrap; a fallback allowed; R11's proof could be fooled by base URLs, aliases or background models | Built-ins out of every gate until SP-12 (now in Phase 0's doctor) proves their models; no fallback anywhere; an allowlisted session environment refusing base URLs, provider switches, aliases and sub-agent models; background calls pinned or off; the receipt records host, version, model and requested effort | Arch §11.6; [RV-10], [RV-19] |
| CF-20 | major | Security fixes are public before production runs them; branches are public before checks | An embargo path through the advisory's private fork, merged only when production can deploy within the hour; public-safety and gitleaks as pre-push hooks and in the merge guard; rotation of anything that reaches a public branch | Arch §11.8, §7.13; [CI-16] |
| CF-21 | major | Strangers' text reaches agents; local reviewers could read secrets into findings | Interaction limits watched; pull requests listed by author, text never loaded; no fork checkout where agents run; review sessions as the `fin-review` OS user with deny rules; findings validated in code | Arch §11.1, §11.6; [CI-15], [RV-21] |
| CF-22 | major | A CI production option; the staging token's power; public logs; the smoke account | The CI production option deleted; the deploy job runs only `ops/fin` with no npm dependency or cache, verifies attestations first, prints names, uploads nothing; approval from the owner's account, which agents do not hold; the smoke account read-only, no traces, rotating credentials | Arch §11.4, §11.8; [CI-03], [CI-04] |
| CF-23 | major | No recovery rule for developers; email change unmentioned; TOTP and challenge reuse unpinned | Recovery by another Super admin or by staff with `accounts.recover`, a 72-hour wait and notices; `/change-email` blocked; one live code per purpose, 3 tries, hashed, a landing page that never submits; TOTP once per step, single-use challenges, counter regression refused, in SP-10 | Arch §7.2, §7.5; [SA-30], [SA-35] |
| CF-24 | minor | Edits that widen or redirect a credential were not stepped up; three tests missing | Intents, audit and email for URL changes, key edits and invitation edits; key edits never widen; tests for another user's passkey, staff trust cookies and staff backup-code endpoints | Arch §7.3, §7.4; [SA-34] |
| CF-25 | minor | A flood of forged well-formed keys could hold the edge's pool | Per-replica buckets and a negative filter before Postgres, a larger edge pool with its alert, a Cloudflare rule on refused-key rates where the plan allows, and the flood in the performance gate | Arch §7.7, §13.6; [SA-19] |
| CF-26 | minor | F19 put the pepper on `api`; GitHub key fetches by caller-supplied ID; a key in clear only notified staff | The edge verifies and calls a key-revoke door by ID; GitHub's key set cached and refreshed at most once per interval; a per-address limit; a live key seen in clear revoked and the organisation emailed | Arch §2.3 F19, §5.6, §7.7; [SA-21], [FD-03] |
| CF-27 | minor | Unlogged windows reset on failover | Lockouts, pauses, per-code attempts and recipient limits in logged tables; a restart test | Arch §7.5; [DA-16] |
| CF-28 | minor | Heap snapshots of key-holding services | Off in every release image; a break-glass procedure with memory-backed paths and encryption to the operator | Arch §3.5; [P-17] |
| CF-29 | minor | Fin Admin served static files before the Access check; AC-P0-07 required `/readyz` through public hosts | The Access check before static serving, in the header-matrix test; AC-P0-07 checks `/health` publicly and `/readyz` privately, with a test that `/readyz` is 404 through every public host | Arch §3.4 FW-C03, §4.3; Exec AC-P0-07 |
| CF-30 | minor | Raw inserts into the outbox and events | `email.enqueue()` and `events.emit()` as checked functions with per-role allowlists, each refusal tested | Arch §6.3, §9.4; [DA-14] |
| CF-31 | minor | Report endpoints trusted the browser's scrubbing; verify and docs had no limit path | Server-side parsing and scrubbing, allowlisted types and sizes, caps by address and in all with per-replica buckets; notify-only alerts with a volume threshold | Arch §10.5; [SA-42] |
| CF-32 | minor | The federation rule matched any run of the repository | Bound to the reusable `review.yml` at `refs/heads/main`, the repository and owner IDs and the allowed events; spend outside reviews alerts | Arch §11.6; [RV-05] |
| CF-33 | minor | Staff insider controls stopped at audit | Reveal budgets with alerts and notices; a second approver for go-live and restoring access once a second staff member exists; Access list and staff table compared hourly; removal revokes Access sessions | Arch §5.10, §7.6; [SA-39] |
| CF-34 | minor | Staging shared a zone and account with the old product; production hosts same-site | A new staging zone in its own account by default; production on three registrable domains; every cookie `__Host-` | Arch §5.2; [FD-09], [FD-10] |
| CF-35 | minor | R9 gaps outside the application | GitHub settings hashed hourly by the watcher and the security log exported weekly; operator statement transcripts and statement logging; a daily canary for Better Stack; API reads of full numbers audited; the verifier pages on unexpected epochs | Arch §8.1, §8.4, §8.8; [AU-08], [AU-09], [OB-17] |
| CF-36 | minor | The plan named the real staging zone, the old repository, the operator's habits and the thresholds | Zone and repository replaced by placeholders and added to the public-safety refuse list in the overlay; the roster, time zone, quiet hours and numeric thresholds moved to the private overlay; build times given without a time zone. A last pass removed the remaining time-zone labels and the UTC pairings that implied the zone, moved the responder and pager limits (TM-L11, TM-L12) and the owner-availability remarks to the threat model's private annex, and amended [G-09] and CR-21: Fin's own labels are public, IDs are private | [G-09], [OB-13]; Exec §9, CR-21; spec 08 §2.5 |
| CF-37 | minor | The drill key's handling; dumps carrying session rows | The drill key only in a one-off drill task, the recipient rotated after each drill; dumps leave out session, verification, proof, intent, window, idempotency and outbox data | Arch §4.5; [DA-15] |
| CF-38 | minor | The test receiver was unauthenticated and needed an unwritten SSRF exception; inbound hooks unspecified | Test endpoints as flagged rows delivered in-process, Sandbox only, no public route; every inbound hook in the door matrix with its secret and limit | Arch §7.9, §13.7; [AP-20] |
| CF-39 | blocker | The same front-door decision, with the operational pieces: services, watchdog, static egress, configuration as code, `/readyz` through connectors, monitors, rotation, QUIC, cost, cutover | As CF-01, plus: connector settings and replicas, static egress on connectors, configuration validated with the previous kept, `/readyz` refused through connectors, `tunnel-connectors`, `tunnel-config-drift`, `ingress.untrusted_peer` and 530 and 1033 rates, tunnel-token rotation, `http2` unless QUIC is proven, connectors in the cost table, the cutover as CNAMEs to the tunnel | Arch §4, §5, §10.8, §4.11; [FD-12], [FD-13] |
| CF-40 | major | One public tunnel is one blast radius; evict untimed and impossible while Railway's API is down | The blue and green evict with standby services, drilled with times; validated configuration changes; the Railway-down fallback stated; the owner asked whether `api.` gets its own tunnel | Arch §5.14; [FD-14], [FD-15] |
| CF-41 | major | pgBackRest drops WAL silently | The probe reads `pg_stat_archiver` every minute and pages; `pnpm fin verify` reads PITR status; `fin_probe` with `pg_monitor` in the grant matrix; a PITR-gap runbook | Arch §4.5; [OB-15] |
| CF-42 | major | No real restore steps; stale queues; lost money rows | A numbered restore runbook with times: switches, sibling restore, PITR, HA, CA and hosts, quarantine of applicant writes and jobs, ledger walk and orphans before unfreezing, developer notice; RTO UNVERIFIED until measured | Arch §15.3; [OP-03], [P-14] |
| CF-43 | major | Losing Railway had no target, no rehearsal and a 24-hour money loss | A named target and `dr.json`, an hourly dump of high-value schemas, an invocation rule, a reconciliation after rebuild, a rehearsal before production | Arch §15.4; [OP-04], [DA-15] |
| CF-44 | major | One CA pin on HA; superuser rotation against Railway's Regenerate | Every member's certificate read in SP-05 and SP-17, a CA bundle if they differ, else `require` as an accepted risk; superuser rotation only through Regenerate, its location recorded, failover and rewind tested | Arch §4.5; [P-18] |
| CF-45 | major | The login trigger could lock everyone out and fails on standbys | Guarded with `pg_is_in_recovery()` and a never-raising handler; Patroni sessions counted; a CI test; the disable path in the runbooks | Arch §6.3; [P-19] |
| CF-46 | major | No HA alerts; P-10 underspecified; placement unknown | Replication, missing replica, sync standby and failover alerts from the probe; `synchronous_mode` on, not strict; latency measured; Railway asked about placement and switchover | Arch §4.5, §10.8; [P-10], [OB-15] |
| CF-47 | major | No incident response process | An incident document with severities, commander, first 15 minutes, templates, contacts in the overlay, the legal clock, private reviews and the twelve playbooks asked for | Arch §15.2; [OP-02] |
| CF-48 | major | No global stop for money without a deploy | Database kill switches read on every request, set from Fin Admin or `pnpm fin switch`; prepared Cloudflare rules toggled with the Cloudflare token alone; automatic money trips; a test per switch | Arch §15.1; [OP-01] |
| CF-49 | major | One responder, and the escalation reaches them again | A production gate: a second trained responder, or automatic containment plus a 15-minute target and the owner's written acceptance; a weekly test page; quiet hours never suppress P alerts | Arch §10.9; [OB-06], [OB-17]; Exec PG-09 |
| CF-50 | major | Image swaps visible only weekly without a Viewer token | Railway deployment webhooks to Better Stack, paging outside a registered window by digest; the watcher checks the webhook exists; the export daily once a narrow credential exists; the deleted-webhook case recorded | Arch §4.10; [OB-11], [AU-06] |
| CF-51 | major | Fixed expiries with only failure-time alerts | `ops/credentials.json` validated by `monitoring:check`; daily expiry checks at 30, 14 and 7 days; rotation heartbeats; staggered expiries | Arch §15.6; [OP-05] |
| CF-52 | major | Database password rotation was an outage | Two logins per service in one group role; the matrix, boot check and limits follow; one rotation drilled | Arch §4.5, §6.3; [P-20] |
| CF-53 | major | Rotation runbooks missing for most families; runbook links unchecked | A runbook per family with order, verification, rollback, deploy count and Railway-down fallback; a check that every alert's and inventory row's runbook exists; MassPay and Sumsub overlaps in SP-13 and SP-11 | Arch §15.6, §10.8; [OP-06] |
| CF-54 | major | Migrate completion, rollback, risky migrations and concurrent indexes | A minimum schema version per release in `/readyz`; `migrate.done` confirmed through `api`'s private health; rollback never runs `migrate` and the runner ignores unknown applied files; `risky` migrations record PITR and back up; non-transactional files; all in SP-03 | Arch §6.4; [DA-04] |
| CF-55 | major | The CI deploy lacked tokens; approval models conflicted; approvals meant nothing; the order omitted `edge` | One approval model (the owner's account, batched at checkpoints); agents on a builder account that cannot approve; the deploy order single in Arch §11.8 and cited by Exec; the R2 writes the CI deploy cannot make are skipped and the watcher's checks named | Arch §11.8; [CI-03], [CI-13] |
| CF-56 | major | Nothing enforced the soak; rollback needed many credentials; half deploys and stale locks undefined | The launcher refuses a release without staging `deploy.done` and smoke at least the soak time old; `pnpm fin rollback` with the Railway token alone; a failed step's end state; `pnpm fin lock break`; staged changes reported | Arch §11.8; [CI-04], [CI-17] |
| CF-57 | major | `/health` stays green while the service is broken | An `api-canary` with a restricted Sandbox key from two regions; `dbOk` and `doorOk` alerts; an absolute 5xx count beside the ratio | Arch §10.6, §10.8; [OB-14] |
| CF-58 | major | Duties covered only by the scheduler's heartbeat | A success alert per duty at three times its cadence; `monitoring:check` requires one; each duty its own loop and guard | Arch §4.6; [P-11] |
| CF-59 | major | One worker for everything; leases never renewed; no fencing | Per-queue loops with fixed concurrency; a priority and reserved share for security email; per-item claims, lease renewal and fencing; a `worker-deliveries` split if the load test shows contention | Arch §4.6; [P-11] |
| CF-60 | major | Cloudflare's API-wide limit could hold all codes; no outbox-age alert | A token bucket below the limit with a reserved share for codes and security mail; `email-outbox-age`; SP-07 reads `Ratelimit` headers | Arch §9.4; [EM-04] |
| CF-61 | major | One sending domain for codes and customer mail; production without reputation | `auth.` and `notify.` sending subdomains each with their own suppressions and alerts; a two-week production warm-up; DMARC aggregate reports read before `reject`; a quota request with the figures | Arch §9.6; [EM-08], [EM-05] |
| CF-62 | major | Staff sign-in depended on email | A discoverable passkey signs staff in on its own; the emailed code for enrolment; a drill with email disabled; EM-03 decided as built-or-accepted before production | Arch §7.2, §9.9; [SA-15], [EM-03] |
| CF-63 | major | Railway may throttle egress above 100 GB | Measured in staging, Railway told in writing, an alert at 70 GB, egress its own cost line | Arch §4.11; [P-22] |
| CF-64 | major | Review spend excluded; caps that cause outages | Review spend in the cost table with daily and monthly caps and `review-cost-high`; no hard Railway limit; no Better Stack cap that stops ingest, or an 80% alert; static IPs, GitHub Pro and 20% contingency added | Arch §4.11; [RV-13] |
| CF-65 | minor | Private DNS failures; Node does not cache | A `*.railway.internal` lookup cache with stale-if-error, alerting on failures; replicas measured in SP-08 | Arch §4.4; [P-21] |
| CF-66 | minor | Rate rules counted provider hooks; scaling broke connection limits | `/hooks/` excluded from Cloudflare's rate rule; `pnpm fin scale` recomputes limits first | Arch §5.7, §4.5; [P-12] |
| CF-67 | minor | The status sweep read every non-final transfer every minute | `next_check_at` with backoff and a per-provider budget; a daily full pass | Arch §12.11; [MO-23] |
| CF-68 | minor | Missed daily duties were skipped | `ops.duty_state` and overdue runs | Arch §4.6; [P-11] |
| CF-69 | minor | An ingest delay would page every `no-logs` alert; about 40 P alerts | Shadow mode on staging with a weekly count gated at production; `no-logs` grouped and downgraded while monitors are green; each P alert reviewed | Arch §10.12; [OB-16] |
| CF-70 | minor | The apply script could delete production's alerts | Dry run first, team-name check, a deletion limit without `--confirm-delete`, heartbeats paused not deleted | Arch §10.11; [OB-16] |
| CF-71 | minor | Drill cadence, staging heartbeat, roles not dumped, drill recipient | Weekly automated restore and monthly drill in production, monthly and quarterly in staging, with the reason recorded; staging heartbeat about 100 days; `pg_dumpall --roles-only`; the recipient rotated through a reviewed change | Arch §4.5, §10.7; [DA-15] |
| CF-72 | minor | No clock-skew signal | The offset from the database's `now()` in every health line, with an alert | Arch §3.5, §10.2 |
| CF-73 | minor | GHCR is a run-time dependency | In the failure-mode table; SP-03 checks Railway's caching; packages kept at least 90 days | Arch §4.10; [P-08] |
| CF-74 | minor | No failure-mode table | `docs/operations/failure-modes.md`, reviewed at each production gate | Arch §15.5; [OP-07] |
| CF-75 | minor | The first full provision would be production's | A throwaway environment provisioned from scratch with smoke tests, drills and zero drift before production | Arch §11.8; [OP-09], [P-13] |
| CF-76 | minor | No SLOs or capacity targets | Launch capacity and objectives set by the owner, burn-rate paging, the status page's components | Arch §15.7; [OP-08] |
| CF-77 | minor | The previous assets had no build step; the head lock under synchronous replication | The release build pulls the previous manifest's images and copies their assets, with a test; the head lock is gone (the sequencer), and audited-write throughput is measured with synchronous replication | Arch §11.7, §8.3 |
| CF-78 | blocker | The same front-door decision, with exact edits to FD-01 to FD-12 and EXECUTION | As CF-01 and CF-39: FD-01 decided, FD-02 withdrawn, FD-03 re-scoped, FD-12 rewritten; P0-F delivers the connector services; the connector watch from the watcher; `pnpm fin tunnel` commands; tunnel spikes replace F1 to F4; AC-P0-07 rewritten; NB-07 and PG-05 updated; Tunnel and Zero Trust scopes in CR-05. The watch runs in the watcher outside Railway rather than as a worker duty, as CF-01 asks | Arch §5; Exec §1.6, §2.5, §2.7, §2.9 |
| CF-79 | blocker | The framework verdict's edits FW-E1 to FW-E8 were not applied | Applied: FW-01 as Shape B, recommended by the judge for the owner's confirmation, with FW-C01 to C22 and the ladder; Arch §3.4 replaced; FW-C05's policy in §7.12; SA-25 superseded; react-start swapped for react-router and router-plugin with the lockfile refusals and the `seroval` floor; "server function" now "app API route"; FW-S1 and FW-S2 in Phase 0; the host package given to P0-D; the counts quoted | Arch §3.3, §3.4, §7.12; [FW-01], [SA-25], [G-06]; Exec §2.1 |
| CF-80 | blocker | EXECUTION would build a different system | As CF-03, plus `backup` and the connector services in Exec's service list, the deploy order cited from Arch §11.8, the tier S list from `tools/layout.json`, one name per package, and lanes for `packages/core` and `packages/crypto` | Arch §3.1; Exec §1.7, §2.5, §2.8 |
| CF-81 | major | "36 valid combinations" | 27 valid; the 9 forbidden ones refused with every bad effort and string; a test that the second sceptic uses the attack model | Arch §11.6; [RV-03]; Exec AC-P0-02 |
| CF-82 | major | Built-ins in the gate and the bootstrap review | As CF-19: out of the gate and EX-18; hand-started lens and attack sessions until the MVP; non-gating later | [RV-10], [RV-01]; Exec EX-11, EX-18 |
| CF-83 | major | Up-to-date plus per-head receipts multiplied reviews; no capacity budget | Receipt reuse by patch-id when neither the patch nor its one-hop neighbourhood changed; merge batches every 90 minutes; gates split across machines; a capacity table; a usage limit as a cut line | Arch §11.6; [RV-20]; Exec §1.1, CUT-07 |
| CF-84 | major | Receipts posted as comments were forgeable and re-ran nothing | As CF-02: signed receipts in a ref, the engine re-runs `gate` with its own token, a receipt from any other source counts as missing. (A ref is used instead of a commit status, because the signature, not the channel, is the control.) | Arch §11.6; [CI-11] |
| CF-85 | major | Saturday was not achievable as written | Re-baselined: Fin Admin beyond sign-in, factor, step-up and Staff moves to Sunday's spill; API keys and the edge's key check on Saturday only if the realms are green at 18:00; FW-S1 12:30 to 13:30 with stubs meanwhile; one 08:00 sitting with defaults at 09:00; two spill days, staging-complete Thu 26 Nov; production estimate moved, still UNVERIFIED | Exec §0, §2.1, §3, §6, §11 |
| CF-86 | major | Saturday's specs had no owner or slot | A spec lane on machine B from 07:30 writing Saturday's specs in order of need, owning `docs/plan/specs/**` (EX-08), reviewed as tier D with a correctness lens; the next day's specs 18:00 to 20:00 as a named lane | Exec §1.4, §2.1 |
| CF-87 | major | Shared generated files, migration names and fragment ownership | `routeTree.gen.ts` not committed; OpenAPI and route policy from per-area fragments; no Drizzle journal; timestamp migration names with an order check; grant fragments per area; a lane owns its fragments wherever they live; ownership overlaps removed; one owner per package's root files; the steward owns `packages/testing` after Saturday | Arch §3.1, §6.4, §13.8; Exec §1.3 |
| CF-88 | major | The fin-review MVP did not fit its slot, was not fast, and its model check could fail | Staged: validator, planner, `commit`, `pr`, signed receipts and checker by 10:30; sceptics and `merge` by 12:00; the doctor and self-test in the afternoon (3 of 4 passes, miss logged); the gate reviews only what commit reviews did not cover; background model pinned or off, checked by the doctor | Arch §11.6; [RV-12], [RV-19]; Exec §2.4 |
| CF-89 | major | The ruleset came before the gate existed; the hook was written by an agent | The order: the plan commit; PR 1 with a minimal `ci.yml`; then the ruleset; then the hook and settings by the owner or a fully reviewed pull request; then the receipt requirement with AC-P0-03 at once | Exec §2.1; [CI-01] |
| CF-90 | major | The real staging zone and old repository named; EQ-14 against G-04 | Placeholders, the names in the overlay's refuse list, the public-safety check run locally over `docs/plan/` before the first commit; EQ-14 dropped for G-04 with the copy check local | [G-04], [G-09]; Exec §9 |
| CF-91 | major | Two registers with conflicting defaults | DECISIONS is the only register; Exec §10 is a "needed by" table keyed by these IDs; each pair resolved (SA-11 with a custom read-only role in AC-SAT-16; SA-08 by CF-07's intents; CI-03 with G-10; fin-review CI in H-03 with RV deadlines moved; RV-06 one rule, `xhigh` lenses on tier S, chosen over the suggested `high` everywhere so the 19 Nov depth stays on sensitive paths; drafts reviewed per RV-12; CI-06 Pro; KY-09 by Saturday 18:00; KY-06 stretch; F21 to KY-05; SA-13 decided and EQ-04 removed; API keys conditional on Saturday in both documents; AU-06 weekly then daily; P-02 and G-07 before the start; no phone library; one SameSite rule) | Every file |
| CF-92 | major | R7 was read narrowly without asking | KY-13 puts the reading, KY-05 and KY-06 to the owner at 08:00 as one question with the cost of each reading; by default a stretch lane for Sumsub's ongoing signals and R7 marked partial with the list | [KY-13]; Arch §12.16; Exec §0.2, §4.1 |
| CF-93 | major | Partial requirements were not listed | A requirement-status table at staging-complete in Exec §0.2, carried in the end-of-day report; G-01 says a partial requirement is a recorded decision | [G-01]; Exec §0.2 |
| CF-94 | major | Behaviour changed from the old product without decisions | Arch §14.6 and BC-01 to BC-07: old step-ups kept, webhook analytics restored in H-02, address and device on every console audit row, 15 tries, "last used", the 10-organisation limit and the deletion rule carried | Arch §14.6; [BC-01] to [BC-07] |
| CF-95 | major | The test endpoint could never be reached through `deliveryFetch` | As CF-38: test endpoints flagged and delivered in-process; both cases in AC-SUN-09 and AC-SUN-12 | Arch §13.7; [AP-20]; Exec §4.6 |
| CF-96 | minor | Better Auth's version sequence differed across files, and 1.7.26 clears after Phase 0 | FW-S2 on 1.7.25; one sequence everywhere: 1.7.25 now, read 1.7.26 and 1.7.27 notes before the first auth merge, all four to 1.7.27 on Monday unless an advisory takes the fast path | Arch §3.3; [SA-02], [G-06] |
| CF-97 | minor | Several FW conditions did not fit the plan | FW-C03 names the tunnel's connector service; FW-C16 "where the app has one"; FW-C13 owned by the CI lane and tested in FW-S6; FW-S3 on a stub landing route deployed Saturday night; FW-S1 from 12:30 to 13:30 | Arch §3.4; Exec §2.1, §4 |

## Appendix B. Changes for the owner's overnight decisions of 21 Nov

After the critics' review, the owner made the decisions in the table near the top of this file. This
appendix lists what each changed here, so the register can be checked against them. The routing,
cookie and UI SDK research behind the changes was read on 21 Nov 2026 and is summarised in the blocks.

| Where | Change |
|---|---|
| How to read it | The DECIDED status for overnight decisions; times without a time zone; `PG-nn` for production gates, never `G-`; new counts |
| Requirements | A map from R1 to R16 to the decisions |
| Owner decisions, by deadline | A short list of nine for Saturday's start; the rest of that sitting's items take their defaults at 09:00; [FW-03] and [FD-14] leave the Sunday and production tables |
| [G-03] | The licence's notice covers the ported design layer, not a vendored design system |
| [G-04] | Decided, with the owner's one exception: the design layer is ported from the old product's redesign branch |
| [G-06] | The UI SDK replaces Radix, Phosphor, `clsx` and `tailwind-merge`; `wrangler` pinned in `tools/static-deploy`; the beta.13 exception as an alternative |
| [G-08], [G-09] | The Workers rules re-expressed; tunnel IDs, the design system's repository name and the port's source commit stay private; a pre-publication step for the old product's staging |
| [P-02] | Decided by the owner's portability rule; the watcher put to the owner as [OB-18] |
| [P-03] | The owner's "no public domains and no TCP proxies" reaffirmed |
| [P-07], [P-08] | The app services serve only `/api/*`; images carry no static files |
| [FD-01], [FD-05], [FD-11], [FD-13] to [FD-16] | The owner's words and times; only `/api/*` crosses a tunnel on the app hosts; Access over the whole admin host; the database tunnel, the evict runbook and the two tunnels decided |
| [FD-06], [FD-08], [FD-09], [FD-10], [FD-12] | Turnstile's path rule; cookies on static requests; why a shared zone is worse now; cookies per [SA-43]; the static-deploy token rotated |
| [FD-17], [FD-18], [FD-19] | New: assets-only static hosting; one host per app, with SP-25 and the fallback; the static uploads |
| [SA-03], [SA-09], [SA-37] | The passkey RP ID per app host; the library's token GETs stay blocked; the link exchange from a static page |
| [SA-25], [SA-26] | No nonce anywhere; the selfie host's own deployment |
| [SA-43], [SA-44], [SA-45] | New: cookies, CSRF, and the page policy from `_headers` |
| [OB-11], [OB-18] | The watcher checks the static deployments and routes; whether it may stay a Worker is put to the owner |
| [CI-02], [CI-03], [CI-04], [CI-14] | The static build, its upload job, production uploads by the operator, and `_headers` as a control path |
| [AP-09], [AP-10] | The docs site served assets-only; Try it reaffirmed |
| [UI-01], [UI-05] | Superseded |
| [UI-02], [UI-09] | Built on the UI SDK; the hover swap superseded |
| [UI-10] to [UI-13] | New: the UI SDK, the edge toggle, the question of the ported text in public, and the theme kept in the browser |
| [FW-01], [FW-02], [FW-03] | Shape B decided, with its conditions amended; a verify without JavaScript would now need a server too; [FW-03] withdrawn |
| §17.2 | A row for each overnight decision |

Three critic findings read differently now. CF-29's "the Access check before static serving" is done
by Access at Cloudflare's edge, since the app no longer serves its own files ([FD-05]). CF-79's style
nonce for Radix is gone with Radix ([UI-10], [SA-45]). CF-34's "every cookie `__Host-`" is kept, and
made exact by [SA-43].

## Appendix C. Spec decisions settled in the register before the first commit

The eight specifications take their own decisions where the plan is silent: `S0-nn` (spec 01),
`S2-nn` (spec 02), `SD3-nn` (spec 03), `MS-nn` (spec 04), `D05-nn` (spec 05), `S6-nn` (spec 06),
`S7-nn` (spec 07) and `D08-nn` (spec 08). The plan has one order of precedence (README §8.3): the
owner's decisions of 21 Nov 2026, then this register, then the specification that owns the area,
then ARCHITECTURE.md, then EXECUTION.md. Under it:

- a spec decision that fills a gap binds as its spec says, and the steward copies it into this
  register in the plan's first follow-up pull request;
- a spec decision that would change an entry of this register binds only once it is settled here.

This appendix settles every such decision found before the first commit. Each row has an ID,
`SF-nn`, and is one of two kinds:

- **Folded:** the entry named now says what the row says, and its status line cites the row. The
  spec decision binds.
- **Not adopted:** the entry holds, because the owner's words or a stronger reason stand behind it.
  The spec's text yields, and the spec marks the decision so.

Every row is also an open item for the owner, who may confirm or overturn it by the deadline shown.
Until the owner answers, builders follow the column "Binds now". [UI-11]'s widths, which spec 06's
S6-06 first changed, are already in [UI-11] and need no row.

| ID | Spec decisions | Register entries | Kind | Binds now | For the owner, by |
|---|---|---|---|---|---|
| SF-01 | S0-01 and S0-03 (spec 01); D05-01 (spec 05); D08-32 (spec 08) | [P-07], [FD-18] | Folded | There is no `docs` service. `developer.<zone>` has a Workers route to its assets-only deployment and a proxied CNAME to the public tunnel, but no `/api/*` route and no ingress rule, so a request that misses the route gets the tunnel's 404. The docs site's browser failure reports go to the edge at `POST https://api.<zone>/reports/docs`, which feeds the Errors application `fin-next-<env>-docs-web`. This was [P-07]'s listed alternative, and it follows the owner's 03:50 words that the docs are assets-only | Confirm or overturn with [P-07], before Saturday's start |
| SF-02 | S0-04 (spec 01): static uploads through Cloudflare's API from `ops/fin` with Node built-ins, and no `wrangler` | [FD-19], [G-06] | Not adopted | The owner's 03:00 words ("uploads ... with a pinned CLI") and [FD-19] hold: the pinned `wrangler` in `tools/static-deploy`, approved with [G-06]. SP-26 still runs, as the test of [FD-19]'s listed alternative, and records whether the API alone can make an assets-only deployment. Spec 01 §4.8, §7.4 and S0-04 yield where they say otherwise | Whether to move to the API upload if SP-26 passes: the owner, when SP-26 reports (Saturday) |
| SF-03 | S0-18 (spec 01): the static deploy token CR-20 in the `staging` environment | [FD-19] | Not adopted | CR-20 sits in the `staging-static` environment, which holds nothing else, which only `deploy-static-staging` uses, and which the owner's account approves like `staging`. Whoever controls one deploy job then holds only that job's secrets. Spec 01 §9.4, §9.5 and S0-18 now say so | None: this keeps the register's rule |
| SF-04 | S0-17 (spec 01): no `railway connect` in staging | [FD-11] | Folded | Postgres has no TCP proxy in staging either, as the owner's 02:40 words ("NO TCP proxies") require, so [FD-11]'s staging interim of `railway connect` is dropped. Until `cloudflared-db` exists, operator work inside the database runs as registered `migrate --task` runs | Confirm, Saturday (spec 01 §15, item 5) |
| SF-05 | S0-05 (spec 01): environment-neutral builds, with `_headers` and `env.json` rendered at deploy | [FD-17], [SA-45], [CI-14] | Folded | Each app's build holds no host, zone or other environment setting. `pnpm fin` renders each app's `_headers` and `env.json` at upload time from its profile in `packages/web-host/src/static/`, with the environment's settings and the private overlay, as [SA-45] says. [CI-14]'s control path "each app's `_headers`" covers those profiles and their renderer. This settles spec 06 §14, open item 1 | Confirm with [CI-14], before Saturday's start |
| SF-06 | D05-32 (spec 05), as first drafted: the docs deployment uses `not_found_handling: "404-page"` | [FD-17] | Not adopted | The owner's 03:50 words give every app, the docs included, `not_found_handling: single-page-application`, and spec 01 §7.4's invariant checks it. The docs deployment keeps that setting, and D05-32 now says so: an unknown path gets the home page with status 200, which the shell shows as "Page not found" with `noindex` | Only if the owner wants real 404 answers on the docs site: Monday, with [AP-11] and [AP-12] |
| SF-07 | SD3-02 and SD3-03 (spec 03) | [SA-37], [SA-26] | Folded | A hosted link carries its token only in the address's fragment (`https://verify.<zone>/c#<token>`, `/p#`, `/a#`). The page reads it, clears it from the address and posts it to `POST /api/link/open`. There are no `/test/` paths: the link record carries the mode. The selfie host receives a one-time ticket the same way (`https://selfie.<zone>/s#<ticket>`) and posts it to its own `/api/selfie/session`. [SA-37] left the fragment to Sunday's specification, and this is that settlement | Confirm, Sunday, with [SA-37] |
| SF-08 | D05-03 (spec 05): one page policy for the docs site, with `style-src 'self' 'unsafe-inline'` while Scalar needs it | [SA-45], [AP-11] | Folded, with a condition | [SA-45] lists the docs exception (`style-src 'unsafe-inline'` and `img-src data:`, in the `docs` profile alone) and applies it only once the owner's yes is recorded under [AP-11]. Until then the docs profile keeps the strict policy and the header-matrix test refuses both. Scripts stay `'self'` either way | The yes or no under [AP-11], Monday |
| SF-09 | S7-02 and S7-03 (spec 07) | [RV-02] | Folded | fin-review has two more modes: `since <ref>` (the nightly run until the ledger exists, and "everything since a commit") and `import` (the design layer's port only, [G-04]'s one exception) | Confirm with [RV-02], before Saturday's start |
| SF-10 | D08-02 and D08-34 (spec 08) | [BC-03] | Folded | [BC-03]'s client address and user agent are stored in `audit.event_context`, linked to the audit row but outside the hash chain, kept 13 months, and only for console and Fin Admin actors. The chain keeps no personal data for the life of the service | Confirm with [BC-03], before Saturday's start; the 13 months with counsel under [DA-08], before production |

A spec decision that disagrees only with ARCHITECTURE.md or EXECUTION.md needs no row: the owning
spec holds over both, and the steward corrects their text in the plan's first follow-up pull
request. Where two specs disagree, the spec that owns the area holds; README §8.3 lists the owners.
