# Spec 03: customer onboarding and going to Production (Sunday 22 Nov, R7)

Status: the build specification for Sunday 22 Nov 2026, written on Saturday 21 Nov 2026 by the spec
lane (L-SPEC, EX-08). Builders work from this file alone, with ARCHITECTURE.md, DECISIONS.md and
EXECUTION.md beside it. It covers customer onboarding for individuals and businesses through Sumsub,
the hosted verify pages and the selfie host, requests for information and forms, the developer
organisation's Production request and Fin Admin's decisions, and the developer events and webhooks
that carry the results. It lives with the other specs in `docs/plan/specs/` (EXECUTION EX-08); no
copy is made under another path.

**How to read the references.**

- `[XX-nn]` is a decision in DECISIONS.md, cited as it stands there. Where a decision is still for the
  owner, this spec builds its **default** and says so; a later answer changes the code through a
  reviewed pull request.
- `SD3-nn` is a decision this spec makes where the plan is silent. Each is listed in this spec's
  Appendix C. SD3-02 and SD3-03, which change [SA-37] and [SA-26], are already folded into the
  register (DECISIONS.md appendix C, SF-07); the steward copies the rest into the register in the
  plan's first follow-up pull request. `SF-nn` is a row of DECISIONS.md appendix C.
- `AC-SUN-nn`, `L-SUN-nn`, `CUT-nn`, `RK-nn`, `NB-nn`, `EX-nn`, `CR-nn` and `H-nn` are EXECUTION.md's.
  `PG-nn` is a production gate (EXECUTION §7.3). `SP-nn` is a spike (ARCHITECTURE §11.11).
  `FW-Cnn` and `FW-Snn` are the framework conditions and spikes (ARCHITECTURE §3.4).
- "§n" alone means a section of this spec. "ARCHITECTURE §n" and "EXECUTION §n" name a section of
  those files. A flow such as F7 is one of ARCHITECTURE §2.3's.
- UNVERIFIED marks a fact not confirmed from a primary source, with what would confirm it.

**What wins where they disagree.** The plan's one order of precedence, highest first: (1) the
owner's decisions of 21 Nov 2026; (2) DECISIONS.md, appendix C included; (3) ARCHITECTURE.md;
(4) EXECUTION.md; (5) the specifications, and between two specifications the one that owns the area,
as README §8.3 lists the owners.

1. The owner's decisions of 21 Nov 2026, which DECISIONS.md records and spec 01 §1 lists as OD-1 to
   OD-6: tunnels for every host; the assets-only static deployments with a no-Worker route sending
   `<app>.<zone>/api/*` to the tunnel, one host per app with no CORS; host-only `__Host-` cookies,
   the session cookie `Strict` and the others `Lax`; the UI SDK; the sidebar edge toggle.
2. DECISIONS.md, appendix C included.
3. ARCHITECTURE.md.
4. EXECUTION.md.
5. The specifications. Between two of them, the one that owns the area holds. This spec owns
   onboarding, the KYC port and the Sumsub adapter, the hosted verify pages and the selfie host,
   requests for information, going to Production and Fin Admin's review rules. The siblings own
   theirs: spec 01 (the platform, the static hosts, `_headers`, the API halves' shared host), spec 02
   (the realms, step-up, permissions), spec 04 (money), spec 05 (API conventions, errors,
   idempotency, the route inventory, developer events and webhooks), spec 06 (components, frames and
   states), and spec 08 (the cross-cutting rules of audit, security email, personal data, scrubbing,
   secrets and observability).

A decision of this spec (SD3-nn) binds where everything above it is silent. One that differs from
ARCHITECTURE.md or EXECUTION.md binds only once that file is changed to match; until then that
file's text holds. One that would change a
register entry binds only as DECISIONS.md appendix C settles it: SD3-02 and SD3-03 are folded into
[SA-37] and [SA-26] (SF-07). A conflict with the register found later is settled the same way, and
the register holds until it is. Where this spec restates a sibling's rule it names the section;
where it needs a change in a sibling's file, §1.5 and §20.2 say so.

**Public repository.** This file holds no credential, token, account, workspace or tunnel ID, internal
address, staff address or real person's data. Hosts are written `<app>.<zone>`, where `<zone>` is the
zone that holds that host: under [FD-10]'s default the verify and selfie hosts sit on the hosted zone
and Fin Admin on the admin zone; staging puts every host on `<staging-zone>` ([FD-09]). Sample people
and companies come from the canon seed with `example.*` addresses.

## 0. Requirements this spec answers

| Req | What this spec does for it | Where |
|---|---|---|
| R1 | Builds onboarding from scratch, production-shaped from the first commit: no code from the old product, every rule tested, the production gates named | throughout; §21; PG-07, PG-11 |
| R2 | Every onboarding service, job and table runs on Railway, in the one Postgres | §2, §4, §7 |
| R3 | Every customer, person, company-code and go-live email goes through `email.enqueue()` and Cloudflare Email Sending | §17 |
| R4 | The verify and selfie hosts, their `/api/*` routes and Sumsub's webhook all come through Cloudflare and the public tunnel | §2 |
| R5 | Every unit of work writes its line to Better Stack; every new failure has an alert and a runbook | §18 |
| R6 | Staff decisions use Fin Admin's granular permissions, intents and windows; the Production request is sent by a Super admin with an intent | §11, §12, §15 |
| R7 | Individual KYC, business KYB with its people, documents, the liveness selfie, requests for information, review results, and going to Production, all through Sumsub | the whole spec |
| R8 | The `KycProvider` port follows the same pattern as the money adapters, so a second KYC provider is an implementation, not a rewrite; approval tells `payments` that a holder is owed | §6, §3.9 |
| R9 | Every action by every actor (developer, API key, customer link, person link, staff, the system, Sumsub) writes its audit event in its transaction | §16 |
| R10 | Every Sunday pull request passes fin-review's gate, with Sunday's attack profiles | §20.4 |
| R11 | The gate's receipts must show sessions within R11's model and effort rules | §20.4 |
| R12 | Nothing private is named; secrets are typed at the secure prompt | throughout |
| R13 | This file is part of the plan saved in the repository | this file |
| R14 | The console and Fin Admin screens follow the two canvases; the verify pages follow the boards [KY-09] adds | §13 |
| R15 | Everything runs on Node 26.13.1 ([P-05]) | §1.4 |
| R16 | The onboarding routes of the public API, their OpenAPI fragments and the Sandbox routes Try it calls | §9 |

## 1. Scope

### 1.1 Must-have on staging by the end of Sunday

The numbers are EXECUTION §4.1's items. Item 1 (Saturday's spill) and item 2 (the public API
foundation: the edge's key check, problem documents, idempotency, pagination, OpenAPI assembly) are
specified elsewhere; this spec uses them.

| Item | What | This spec |
|---|---|---|
| 3 | KYC domain: customers, people (at most 20 per business, in the API too), documents (one upload rule and the Sandbox quota), hosted links, RFIs on the forms model only, go-live requests; one table-driven state machine per entity; coupling rules in the machines | §3, §4, §5 |
| 4 | `KycProvider` with the Sumsub adapter and the sandbox provider, one conformance suite | §6 |
| 5 | Inbound Sumsub events stored, answered within a second, processed by the worker; the poll as the backstop | §7 |
| 6 | Personal data: Sumsub as the record for live data; sealed name; keyed hashes; masks; the blind index; only `api` and `worker` hold the keys and Sumsub's tokens | §8 |
| 7 | The hosted verify pages and the selfie host | §2, §12.3, §13.4 |
| 8 | Developer events and webhooks | §9.4, §10 |
| 9 | Go to Production, from the wizard to the staff decision to Production unlocked | §3.7, §14 |
| 10 | Fin Admin review screens | §12.2, §13.3, §15 |
| 11 | Audit for every actor | §16 |
| 12 | A final rejection is not restarted by the developer without a staff decision ([KY-07]) | §3.1 |
| 13 | Sandbox limits ([SA-40]) | §5.6, §17.2 |
| 14 | Monitoring | §18 |

### 1.2 Stretch, in this order

1. Owner companies on a Production request sent to Sumsub as company beneficiaries ([KY-06]): the
   table and the screen fields are must-have; the Sumsub link is stretch.
2. Sumsub's ongoing signals as Fin Admin flags: the `kyc.flag` table and the flags that the must-have
   paths raise are must-have; the Signals list screen (L-SUN-12) is stretch ([KY-13]).
3. (Moved to must-have: the `person.*` and `document.updated` events are in Spec 05 §5.1's catalogue,
   so the machines emit them from Sunday.)
4. Saved views and filters in Fin Admin lists beyond the defaults.
5. The docs site skeleton (L-SUN-09).
6. The customer emailed when an RFI opens ([KY-08]).

### 1.3 Left out of R7, by [KY-13]'s default

Sumsub's monitoring queues, AML re-screening schedules and any KYB level beyond the ten business types
are not built. EXECUTION §0.2 marks R7 partial with this list. Sanctions and PEP queues are worked in
Sumsub's own dashboard.

### 1.4 What Sunday uses from Saturday

| From | What this spec relies on | If it is late |
|---|---|---|
| `packages/server` | Door matrix and signed calls (ARCHITECTURE §7.9), unit of work, job claims and leases (ARCHITECTURE §4.6), the scheduler, kill-switch reads, `deliveryFetch` (ARCHITECTURE §7.11), the request line | L-SUN-00 finishes it first |
| `packages/web-host` | Spec 01 §4.4's shared host for API halves (ingress, body limits, the origin gate, the error envelope, health) and the `_headers` and `env.json` renderer (spec 01 §7.4) | as above |
| `packages/identity` | `requireActor` and `requireStaff` with `stepUp: "window"` or `stepUp: "intent"`, intents bound to a parameter digest (ARCHITECTURE §7.4) | none: NB-02 |
| `packages/access` | The 26 dashboard and 26 staff permissions of ARCHITECTURE §7.6 | none |
| `packages/audit` | `recordAudit()`, fragments, the guard triggers | none: NB-04 |
| `packages/email` | `email.enqueue()` with per-role template allowlists, per-recipient limits, the worker sender | security notices wait; never dropped |
| `packages/crypto` | Seal and open with AAD, HKDF subkeys, keyed hashes, the name blind index (ARCHITECTURE §6.6) | none |
| `packages/keys`, `apps/edge`, `apps/api/src/platform` | Spec 05 §3 and §4: key check, scopes, `GET /v4/whoami`, the live-status read on each live key, problem documents, idempotency, pagination, the route policy | first item of Sunday's spill block (L-SUN-01) |
| `packages/events` | Spec 05 §5: `events.emit()`, the event catalogue, endpoints and delivery | L-SUN-04, from 08:00 |
| `packages/testing` | The canon seed, the email sink, the clock, the Access stand-in, the virtual authenticator, and spec 01 §4.7's static host for journeys | L-SUN-03 adds the Sumsub stand-in (§20.2) |
| `packages/ui`, `packages/frame` | `@fin/ui` on the UI SDK, AppFrame, AdminFrame and the AuthLayout card; `@ui-sdk/*` pinned at the newest exact beta cleared when the install pull request runs ([G-06]: `0.1.0-beta.9` at P0-4, or `0.1.0-beta.10` only if the install pull request runs after 09:47 UTC), moved to `0.1.0-beta.13` by one dependency pull request after Sunday 12:24 UTC (research note D3 §3.3), so Sunday's screens must pass on both | screens start on pending compositions ([UI-03]) |

Node 26.13.1 runs every service, test and script (R15, [P-05]).

### 1.5 Changes this spec makes, for the steward to fold in

Spec 01 §1 already applies the owner's decisions OD-1 to OD-6 to the architecture (the static shape,
same-host routing, cookies, the UI SDK, the edge toggle). On top of that, this spec:

1. **Keeps link tokens in the URL fragment**, never in a path: `https://verify.<zone>/c#<token>`,
   `/p#<token>` and `/a#<token>`, with no `/test/` paths. The page posts the token to
   `POST /api/link/open` and receives `__Host-fin-verify.ls` (§2.4, §2.5; [SA-37] made stricter,
   SD3-02). This spec is the source for verify's paths, its exchange route and its cookies. The same
   change updates ARCHITECTURE F7, FW-C20, FW-C21, §5.2's request table and §7.12, DECISIONS [SA-26],
   [SA-37] and [SA-43], EXECUTION §4.1 item 7, the plan README's request table and spec 06 §7.3 to
   match, and closes spec 06 open item 10.
2. **Hands the selfie over with a one-time ticket** in the selfie host's fragment,
   `https://selfie.<zone>/s#<sft id>.<secret>`, redeemed once for the SDK token and
   `__Host-fin-selfie.s` (§2.6, SD3-03). Folded into the same files as item 1.
3. **Adds `img-src 'self' blob:` to the `hosted` profile** for the photo preview (SD3-04). It is
   the only `blob:` in any page policy: Fin Admin's document viewer needs none (item 6). [SA-45]'s
   list of exceptions and its policy test name it, and spec 06 §6.3 lists it.
4. **Points the `verify` monitor** of ARCHITECTURE §10.6 at `https://verify.<zone>/api/health`, as
   spec 01 §4.4 serves it (SD3-21).
5. **Proposes three additions to Spec 05**: `Rfi.items[].inputs[]` so the API can answer forms; the
   public code `provider_unavailable` (503) on `submitCustomer` and the upload routes; and the
   reading of `rfi_forms` below (§9.3).
6. **Opens a document for Fin Admin with a gated POST**, never an audited GET: `POST
   /api/documents/:id/view` passes the origin gate, spends the reveal budget, writes
   `staff.document_viewed` and returns a single-use URL that lives 60 seconds and is bound to the
   staff session; `GET /api/document-views/:viewId` streams the file once and writes nothing else
   (§12.2, §15.3, SD3-17). It adds a route-policy rule for every app: a GET may not declare `audit`
   or a budget, and a GET that redeems a minted URL requires `Sec-Fetch-Site: same-origin` (or
   `none`). The same change updates spec 02 §2.2, §2.3 and §14.1 and DECISIONS [SA-44]. Fin Admin's
   page policy keeps `img-src 'self'`, so spec 06 §6.3, S6-18 and open item 8 and DECISIONS [SA-45]
   drop the `blob:` they had held open for the viewer.

## 2. Hosts, routing and cookies for onboarding

Spec 01 builds the hosts, the static deployments, the Workers routes, the tunnel rows, the `_headers`
profiles and the API halves' shared host (spec 01 §4.4, §7.2 to §7.5, OD-2 to OD-4). This section
says only what verify and the selfie host add.

### 2.1 Hosts

| Host | Static deployment (spec 01 §7.4) | `/api/*` | `_headers` profile | Cookies |
|---|---|---|---|---|
| `verify.<zone>` | `fin-next-<env>-verify-static`, from `apps/verify` `dist/static/verify` | no-Worker route to the public tunnel, service `verify` | `hosted` | `__Host-fin-verify.ls` |
| `selfie.<zone>` | `fin-next-<env>-selfie-static`, from `apps/verify` `dist/static/selfie` | no-Worker route to the public tunnel, service `verify` | `selfie` | `__Host-fin-selfie.s` |
| `console.<zone>`, `admin.<zone>` | spec 01 §7.4 | their API halves (spec 02) | `app` | spec 02's realm cookies |
| `api.<zone>` | none | the whole host to the public tunnel, service `edge` (Spec 05 §2) | none | none |

Sumsub's webhook is `POST https://api.<zone>/hooks/kyc/sumsub`. If SP-25 fails, verify takes
spec 01 §7.12's split-host shape (`verify-api.<zone>`), and every route here keeps its path under `/api`.

### 2.2 What verify adds to the static shape

- **Two Vite entries** in `apps/verify`, laid out as spec 06 §1.2 gives them (spec 06 owns the app
  skeleton's files): `index.html` → `src/client/main.tsx` for every verify page, built by
  `vite.config.ts` into `dist/static/verify/`, and `selfie.html` → `src/selfie/main.tsx` for the
  selfie page alone, built by `vite.selfie.config.ts` into `dist/static/selfie/`, the selfie
  deployment holding only `selfie.html` and its assets ([FD-17]). Each document carries the
  nonce-less `<meta property="csp-nonce">` and a stylesheet that starts with `@layer ui-sdk;` (spec 01
  §1.1, FW-C06 as rewritten), and both builds use `build.assetsInlineLimit: 0` so nothing becomes a
  `data:` URL (research note D3 §7.3). A page's policy is fixed when its document loads, so the selfie
  page is its own entry and links between the two hosts are full document loads (research note D3
  §7.4).
- **The `hosted` profile** gains `img-src 'self' blob:` for the local preview of a photo the customer
  picked (made with `URL.createObjectURL`, revoked when the step closes; SD3-04). No other profile gets
  `blob:`, in any directive: [SA-45] lists this one exception, and its policy test refuses `blob:`
  anywhere but `img-src` in the `hosted` profile. Fin Admin's document viewer needs none (§12.2,
  SD3-17).
- **The `selfie` profile**, from Sunday, once SP-11 has recorded Sumsub's exact hosts (never a
  wildcard): `script-src 'self' https://static.sumsub.com`; `frame-src` the frame hosts;
  `connect-src 'self'` plus a host only if the WebSDK's builder calls it from the top page;
  `Permissions-Policy` allows `camera` and `microphone` for that frame host only. A test fails if any
  other profile names a Sumsub host ([SA-26], FW-C20). If SP-11 shows the builder writes `<style>`
  elements, the selfie profile alone takes FW-X7's style fallback.
- L-SUN-06 asks the owner of `packages/web-host/src/static/` for both profile changes through the lane
  board (§20.2).

### 2.3 The `verify` API half

`apps/verify/src/server` is a Hono API half on Railway with no database login (ARCHITECTURE §4.2),
served by spec 01 §4.4's shared host: ingress check, body limits, the origin gate, the error envelope,
`GET /api/health`, and `Cache-Control: no-store` on every answer. It serves two hosts, told apart by
`Host` (anything else is 421), and each host only its own routes (§12.3). On both hosts the origin
gate requires `X-Fin-App: verify` and an `Origin` equal to that host's own origin; refusals are spec
01 §4.4's `invalid_origin`, each writing one `csrf.refused` line with the refusal code and the route
pattern ([SA-44]), the `request` line also carrying `reason: origin_gate.<code>`.
`POST /api/documents` is the one route the policy names as a `multipart/form-data` upload.

### 2.4 Cookies

Set by the `verify` API half, exactly:

```
__Host-fin-verify.ls=<lks id>.<secret>; Max-Age=<seconds to the link's end, at most 86400>; Path=/; HttpOnly; Secure; SameSite=Strict
__Host-fin-selfie.s=<sft id>.<secret>;  Max-Age=900;                                            Path=/; HttpOnly; Secure; SameSite=Strict
```

- No `Domain`, never `SameSite=None`, never `Partitioned` (OD-4). A configuration test asserts each
  line.
- Verify runs no Better Auth: these are Fin's own cookies, under [SA-43]'s prefixes
  `__Host-fin-verify.*` (verify) and `__Host-fin-selfie.*` (the selfie host). These two names are
  the only ones; ARCHITECTURE §7.12, FW-C21, EXECUTION §4.1 item 7 and spec 06 §7.3 use them.
- Strict works here because only the page's own fetches read the cookie, and those are same-site even
  when the page was reached from an email (research note C3, rows 25 and 26).
- The secret is 32 random bytes, base64url; only its SHA-256 is stored.

### 2.5 The link token and the link session

1. A link URL is `https://verify.<zone>/c#<token>` (a customer link), `/p#<token>` (a person's own
   link) or `/a#<token>` (an assisted link). The token is 32 Crockford base32 characters (160 bits).
   It travels only in the fragment, so it never reaches Cloudflare, a log, a `Referer` or Sumsub's
   script (SD3-02). There are no `/test/` paths: the link record carries the mode.
2. The entry module reads `location.hash`, then at once calls
   `history.replaceState(null, "", location.pathname)`, before any other code runs, and posts
   `{ "token": "<token>" }` to `POST /api/link/open`.
3. The `verify` service calls `api`'s door `verify.link.open` (§11). `api` hashes the token
   with SHA-256, looks it up in `kyc.link` by `token_hash`, and refuses unless the link is unrevoked,
   unexpired, and the `hosted_verify` kill switch is off. Unknown, expired and revoked tokens get the
   same 404 `link_not_found` and take the same time (a constant-time lookup with a dummy hash compare).
4. On success `api`, in one transaction: sets `first_opened_at` if it is null and then
   `expires_at = least(expires_at, first_opened_at + interval '24 hours')`; inserts a
   `kyc.link_session` bound to the link, ending with the link; writes `customer.link_opened` (or
   `person.link_opened`); and returns the session's ID and secret with the link view (§12.3).
5. `verify` sets `__Host-fin-verify.ls` and answers `Cache-Control: no-store`. The page routes to the
   first step the link still needs. Later calls carry the cookie only.
6. A second browser may open the same token while the link lives; it gets its own link session. A new
   link of the same kind for the same subject revokes the previous link and ends its sessions
   (`revoked_reason = 'replaced'`). An assisted link revokes nothing.
7. Limits, counted in `api`: `POST /api/link/open` 20 per 10 minutes per client address and 10 per
   hour per token hash; a refusal is 429 `rate_limited` with `Retry-After` (SD3-23).
8. A load of `/c`, `/p` or `/a` with no fragment (a reload, or the selfie host's return) calls
   `GET /api/link` with the cookie; with no live link session it shows the expired page. No path on
   either host ever holds a bearer value, so Logpush's path redaction ([FD-08]) and the request line
   have nothing to remove; the redaction stays as depth.

### 2.6 The selfie hand-off

1. On verify, a selfie step (an RFI's selfie item for a customer, or the last step of a go-live
   person's link) calls `POST /api/selfie/start` with the item. `api` (door `verify.selfie.start`)
   refuses an assisted link (403 `customer_only`), checks the step is asked for, inserts a
   `kyc.selfie_ticket` (10 minutes, single use) and returns
   `https://selfie.<zone>/s#<sft id>.<secret>`.
2. The page makes a full document load of that URL. The selfie entry reads and clears the fragment
   the same way, and posts it to `POST https://selfie.<zone>/api/selfie/session`.
3. `api` (door `selfie.redeem`) marks the ticket redeemed (a second redeem gets 404
   `ticket_not_found`), mints a Sumsub SDK token with `mintSdkToken` (600 s), and returns it with the
   SDK's language and a return path. `verify` sets `__Host-fin-selfie.s` for 15 minutes.
4. The page loads Sumsub's WebSDK builder from `https://static.sumsub.com` (the exact path SP-11
   records) and launches it with the SDK token. Its token-expiry handler calls
   `POST /api/selfie/token` (door `selfie.refresh_token`, at most 3 refreshes per ticket).
5. When the SDK reports the applicant or action submitted, the page calls `POST /api/selfie/done`
   (door `selfie.done`). `api` reads the result from Sumsub (`readAction` for a customer's liveness
   action, `readReview` for a go-live person) and never trusts the browser's word: a review still at
   `init` is 409 `selfie_not_taken`; a retry answer is 409 `selfie_refused` and the page offers the
   SDK again; otherwise the selfie document is recorded (§3.3) and the answer carries the
   return path, `https://verify.<zone>/c` or `/p`, which the page loads in full.
6. The selfie page holds only the SDK token. It never sees the link token or the link-session cookie
   (another origin). Sandbox selfies never open the selfie host: verify offers "Use a test selfie",
   which the sandbox provider decides (§6.4).
7. A WebSDK error (for example `invalid-origin`) shows "We couldn't open the selfie screen. Fin has
   been told." and posts a `selfie.sdk_failed` report through `/api/monitoring/envelope`.

## 3. Domain: entities and state machines

Every machine is a table in `packages/kyc/src/machines/<entity>.ts`: `from`, `event`, `to`, the actor
kinds allowed, the guard, and the effects (audit event, developer event, email, job). One function per
machine, `transition(tx, entity, event, input)`, locks the row (`SELECT ... FOR UPDATE`), refuses a
move not in the table with 409 `transition_refused` (adding `current_status`), refuses a stale
expectation (`from` given and not matched) with 409 `status_changed`, applies the effects in the same
transaction, and returns the new row. The API, verify, Fin Admin, the sandbox provider and the worker
all call these functions; nothing else writes a status column. A unit test refuses every pair not in
the table (AC-SUN-04).

Actor kinds used below: `user` (console), `api_key`, `customer_link`, `person_link`, `staff`,
`system` (a job), `provider` (an inbound event applied by the worker).

### 3.1 Customer

Statuses, kept exactly ([KY-03], ARCHITECTURE §12.16): `incomplete`, `in_review`, `approved`, `action_required`,
`unapproved`, `rejected`. Labels and lines are in Appendix A.

**Reasons** (`status_reason`). Public, in `status_detail.reason`: `details_missing`,
`documents_missing`, `people_missing`, `selfie_missing`, `document_unreadable`, `document_expired`,
`document_not_accepted`, `selfie_failed`, `details_mismatch`, `checking`, `information_requested`,
`fin_reviewing`, and the new `person_rejected` (SD3-05). Internal, shown outside Fin as `checking`:
`fin_review` (waiting for a Fin approval) and `people_pending` (a business waiting for its people).
`publicStatusDetail()` gives an approval or a rejection no reason, maps the internal reasons to
`checking`, and replaces an unknown reason with the status's default. Next actors: `customer`,
`developer`, `fin`.

| From | Event | To, reason, next actor | Actors | Guard and effects |
|---|---|---|---|---|
| (none) | `create` | `incomplete`, `details_missing`, customer | `api_key`, `user` | `customer.created` (audit and developer event); live: first write queued (§7.4) |
| `incomplete` | `submit` | `in_review`, `checking`, fin | `api_key`, `user` (Simulator), `customer_link` | `missing()` is empty, else 400 `customer_incomplete` with `missing`; live: flush the transit queue (or 503 `provider_unavailable`), push every questionnaire, `requestReview`, poll in 60 s; sandbox: the sandbox provider schedules the outcome; `customer.submitted`, `customer.updated` |
| `in_review` | provider GREEN, switch off, individual | `approved` | `provider` | `customer.approved`; `money.customer_changed` (§3.9) |
| `in_review` | provider GREEN, switch off, business, every person `approved` | `approved` | `provider` | as above ([KY-11]) |
| `in_review` | provider GREEN, business, a person not yet `approved` | `in_review`, `people_pending`, fin | `provider` | re-evaluated when a person moves (§3.9) |
| `in_review` | provider GREEN, switch on | `in_review`, `fin_review`, fin | `provider` | waits in Customer approvals; `once` |
| `in_review` | provider RED RETRY | `incomplete`, mapped retry reason, customer | `provider` | the retry documents move to `retry`; `customer.updated` |
| `in_review`, `incomplete` | provider RED FINAL | `rejected`, `rejection_kind = final` | `provider` | `customer.rejected` |
| `in_review` | RFI opened | `action_required`, `information_requested`, customer | `staff`, `system` (sandbox 0004), `user` and `api_key` (Sandbox simulator only) | RFI `previous_status = in_review` |
| `in_review` | a person `rejected` (business) | `action_required`, `person_rejected`, developer | `provider` | SD3-05 |
| `in_review`, `action_required`, `unapproved` | staff or simulator `approve` | `approved` | `staff`, `user`/`api_key` (Sandbox) | staff: intent ([SA-17]); closes an open RFI (§3.9) |
| `in_review` | simulator `request_resubmission` | `incomplete`, the given retry reason | `user`/`api_key` (Sandbox) | |
| any but `rejected` | staff or simulator `reject` | `rejected` | `staff`, `user`/`api_key` (Sandbox) | staff picks `rejection_kind` (default `final`); Sandbox rejections are `restartable` (SD3-07); closes an open RFI |
| `in_review`, `approved`, `action_required` | staff or simulator `unapprove` | `unapproved`, `fin_reviewing`, fin | `staff`, `user`/`api_key` (Sandbox) | closes an open RFI |
| `approved` | RFI opened | `action_required`, `information_requested`, customer | `staff`, `system` (0004), Sandbox simulator | `previous_status = approved` |
| `approved` | provider re-review RED, or a person later `rejected` | `unapproved`, `fin_reviewing`, fin | `provider` | raises a `review_reopened` flag; never an automatic rejection (SD3-06) |
| `action_required` | RFI answered | `in_review`, `checking`, fin | `customer_link`, `api_key` | only from `action_required` |
| `action_required` | RFI accepted or withdrawn | the RFI's `previous_status` | `staff`, `system` | if that is `in_review`: live polls at once, Sandbox re-plays `decide` 10 s later |
| `action_required` (`person_rejected`) | the rejected person removed, every person left `approved`, the owner rule met | `in_review`, `people_pending`, fin, then re-evaluated | `api_key`, `customer_link` | §3.9 |
| `unapproved` | staff or simulator | `approved`, `action_required`, `in_review`, `rejected` | `staff`, Sandbox simulator | |
| `rejected` | `restart` | `incomplete`, `details_missing`, customer, `attempt + 1` | `api_key`, `user` | allowed only when `rejection_kind = restartable`, at most 3 in 24 hours (429 `restart_limit`); else 409 `restart_not_allowed` ([KY-07], SD3-07) |
| `rejected` | staff `allow_restart` | `rejected`, `rejection_kind = restartable` for one restart | `staff` | intent; reason; a restart then sets `rejection_kind` back to `final` on the next rejection |

- **Restart** clears `fields_present`, the sealed name, hashes, masks, tokens and (Sandbox) the sealed
  details; keeps `external_id`, type, and a business's people's names, emails, roles and shares; marks
  every document `replaced`; revokes every link; expires waiting RFIs; queues deactivation of every
  applicant of the old attempt (§7.5); makes new applicants under `cus_<id>-<attempt>` and
  `per_<id>-<attempt>`; returns a new customer link; writes `customer.restarted`.
- **Delete** (`DELETE`): in live only an `incomplete` customer (409 `customer_not_deletable`); in
  Sandbox any; and, from Monday, never one with a balance, a hold or a non-final transfer
  ([BC-07], checked through `payments`' door). It writes a tombstone (SD3-26): `deleted_at` set, the
  sealed name, hashes, masks, tokens and details blanked, links revoked, open RFIs withdrawn, an
  `erasure_request` recorded, deactivation of every applicant of every attempt queued, and
  `customer.deleted` written and emitted.
- **Updates** (`PATCH`, hosted page saves) are allowed only while `incomplete` or `action_required`
  (409 `customer_locked`), under the row lock.

### 3.2 Person

A business's owner or director (`customer_id` set), or a person on a Production request
(`go_live_request_id` set). Statuses: `incomplete`, `in_review`, `approved`, `rejected`; a retry is
`incomplete` with a retry reason. Roles: `shareholder`, `ubo`, `director`, `signatory`, `control`.

| From | Event | To | Actors | Guard and effects |
|---|---|---|---|---|
| (none) | `add` | `incomplete` | `api_key`, `customer_link`, `user` (go-live) | at most 20 per owner (409 `too_many_people`); email unique within the owner (409 `email_used`); shares total at most 100 (400 `ownership_over`); at least one role (400 `invalid_roles`); `customer.person_added` or `go_live.person_added` |
| `incomplete` | `submit` | `in_review` | `person_link`, `api_key` | live: flush, push the party data and questionnaire, link to the company applicant as a beneficiary if it exists, `requestReview`; go-live person: submitted by the WebSDK, then `requestReview` is not called (the level runs it) |
| `in_review` | provider GREEN | `approved` | `provider` | re-evaluates the business (§3.9) |
| `in_review` | provider RED RETRY | `incomplete` with the retry reason | `provider` | |
| `in_review` | provider RED FINAL | `rejected` | `provider` | re-evaluates the business |
| `incomplete`, `rejected` | `remove` | (deleted) | `api_key`, `customer_link`, `user` (go-live) | a person who is `in_review` or `approved` cannot be removed (409 `person_locked`); unlinks the beneficiary at Sumsub; queues deactivation; re-evaluates the business |

In Sandbox the sandbox provider decides a business's person from the last four digits of the person's
tax ID (§3.8). A go-live person is always live and always reaches Sumsub, whatever the
organisation's mode.

### 3.3 Document

Statuses: `submitted`, `accepted`, `retry` (with a retry reason), `rejected`, `replaced`.

| From | Event | To | Who |
|---|---|---|---|
| (none) | upload accepted | `submitted` | `api_key`, `customer_link`, `person_link`, `user` (assisted) |
| (none) | upload refused by Sumsub's instant check | none (no row; 422 `document_refused` with `reason`) | |
| `submitted` | review GREEN for its subject | `accepted` | `provider` |
| `submitted` | RED RETRY naming it | `retry` | `provider` |
| `submitted` | RED FINAL | `rejected` | `provider` |
| any | restart, or a form slot's file sent again | `replaced` | `system` |

A selfie is a `selfie` document with no file, its status from the liveness action (or, for a go-live
person, the review). Fin keeps no file in either mode: live files go to Sumsub, and Sandbox files are
checked by their first bytes and dropped.

### 3.4 Hosted link, link session and selfie ticket

| Kind | Path | Life | Made by | Opens |
|---|---|---|---|---|
| `customer` | `/c#<token>` | 7 days, shortened to 24 hours after the first open | API `POST .../links`, console (intent), restart | everything the customer still needs; scoped to one RFI when `rfi_id` is set |
| `person` | `/p#<token>` | the same | API `POST .../people/{id}/links`, the business pages, go-live (intent) | that person's steps only |
| `assisted` | `/a#<token>` | 30 minutes | console "Fill it in yourself" (intent) | as `customer`, never the selfie |

Link states are implicit: **live** (not revoked and not expired), **used** (`first_opened_at` set),
**replaced** (`revoked_reason = 'replaced'`), **revoked** (deleted, restarted, `rfi_closed`). A link
session lives until its link ends or `ended_at` is set. A selfie ticket is **issued**, **redeemed**
(once), **done**, or **expired** after 10 minutes; its selfie cookie lasts 15 minutes after redeem.

### 3.5 Requests for information, items and forms

**One model** ([KY-03]): every request asks for forms. The old fixed items are built-in **system
forms** with a `system_key`: `proof_of_address` (a file input, utility bill), `photo_id` (an
`id_document` input), `source_of_funds` (a `long_text` input), `selfie` (a `selfie` input). Only system
forms may hold a `selfie` input. A request holds at most 10 forms; a business is never asked for a form
with an `id_document` or `selfie` input (409 `form_takes_id`).

RFI statuses: `open`, `answered`, `accepted`, `more_needed`, `expired`, `withdrawn`. A customer has at
most one RFI that is `open`, `answered` or `more_needed` (409 `rfi_open`). Due 14 days ahead by
default (at most a year); it expires 14 days after `due_at`.

| From | Event | To | Effect on the customer | Actors |
|---|---|---|---|---|
| (none) | `open` | `open` | moves to `action_required` (§3.1); `previous_status` recorded (never `incomplete` or `rejected`; default `approved`) | `staff`; `system` (Sandbox 0004); Sandbox simulator (`user`, `api_key`); never the live API |
| `open`, `more_needed` | last form sent (link) or `POST /v4/rfis/{id}/answer` | `answered` | `action_required` to `in_review` | `customer_link`, `api_key` |
| `answered` (or `open`, accepting directly) | `accept` | `accepted` | back to `previous_status` | `staff`; `system` (Sandbox) |
| `answered` | `ask_more` with item IDs (all when none named) | `more_needed` | back to `action_required` | `staff`; `system` (Sandbox) |
| `open`, `more_needed`, `answered` | `withdraw` | `withdrawn` | back to `previous_status`; unsent form files `replaced` | `staff`; a staff customer decision (`closed_by_decision`) |
| `open`, `more_needed` | `due_at + 14 days` passes | `expired` | unchanged; unsent files `replaced` | `system` |
| `open`, `more_needed` | `change` (forms, message, due date) | unchanged; `revised_at` set | none | `staff` |

Item statuses: `open`, `answered`, `accepted`, `more_needed`. Link-side form states shown to the
customer: `todo`, `progress` (a draft saved), `sent`, `accepted`, `again`. A form slot holds 3 uploads;
a draft is shown back only to the link session that saved it; `sent_documents` keeps what was last
sent while Fin asks again. Extras: one sealed `note` (at most 2,000 characters) and at most 5
`extra_document`s, stored as items of kind `extra_note` and `extra_document`, never asked again.

**Form library** statuses: `draft`, `published`, `archived`. `version` counts publishes; an item keeps
the definition it was sent with (`form_snapshot`). Inputs (at most 30): `short_text`, `long_text`,
`number`, `date`, `dropdown`, `multiple_choice`, `yes_no`, `country`, `address`, `file` (PDF, JPEG,
PNG), `photo` (JPEG, PNG), `id_document` (passport, id_card, driving_licence, residence_permit), and
`selfie` (system forms only). Limits: name 80, description 140, label 120, help 200, option 80, 20
options.

### 3.6 Applicant mirror and applicant actions

`kyc.kyc_applicant.review_status` mirrors the provider's last answer: `init`, `pending`, `prechecked`,
`queued`, `completed`, `onHold`; with `review_answer` (`GREEN`, `RED`) and `reject_type` (`RETRY`,
`FINAL`) when completed. It is written only by the worker's apply step from a review it read itself.
A selfie liveness action (`kyc.kyc_action`) moves `pending` to `completed` with its own answer.

### 3.7 Production request, organisation live status and second approvals

`kyc.go_live_request.status`: `draft`, `in_review`, `changes_requested`, `approved`, `declined`.
`identity.organization.live_status`: `sandbox`, `in_review`, `changes_requested`, `approved`,
`declined`, `paused`; screens derive "Started" (`draft`) when the organisation is `sandbox` and its
latest request is a draft.

| Request from | Event | To | Who | Guard | Organisation live status |
|---|---|---|---|---|---|
| (none) | `start` | `draft` | `golive.edit` | no request in `draft`, `in_review` or `changes_requested` (409 `go_live_open`); an organisation whose request was declined cannot start another (409 `go_live_declined`, SD3-30) | `sandbox` |
| `draft`, `changes_requested` | `save_page` | same | `golive.edit` | in `changes_requested`, only the sections Fin asked about plus `agreement` (409 `go_live_not_asked`) | same |
| `draft`, `changes_requested` | `submit` | `in_review` | `golive.submit` (Super admin), intent | every page done (400 `go_live_unfinished` with `missing`); company email checked; at least one person; terms version current and both boxes ticked (400 `go_live_terms`) | `in_review` |
| `in_review` | first `approve` while a second approver is required | `in_review`, a `kyc.pending_approval` row | staff `golive.decide`, intent | every person `approved` (409 `people_unverified`) | unchanged |
| `in_review` | `approve` (only approver, or the second, different, staff member) | `approved` | staff `golive.decide`, intent | the same; a second approver must differ from the first (409 `same_approver`) | `approved` |
| `in_review` | `request_changes` (sections, message) | `changes_requested` | staff `golive.decide`, intent | at least one section; cancels a pending approval | `changes_requested` |
| `in_review` | `decline` (message optional) | `declined` | staff `golive.decide`, intent | cancels a pending approval | `declined` |
| (organisation) `approved` | `pause` | n/a | staff `organisations.pause`, intent | | `paused` |
| (organisation) `paused` | first `restore` while a second approver is required | n/a, a `kyc.pending_approval` row | staff `organisations.pause`, intent | | `paused` |
| (organisation) `paused` | `restore` (only, or second) | n/a | staff `organisations.pause`, intent | different staff | `approved` |

- **When a second approver is required** ([SA-39] default, SD3-09): when at least two active staff
  members hold `golive.decide` (for go-live) or `organisations.pause` (for a restore). A pending
  approval expires after 72 hours (`expired`), and its first approver may cancel it.
- **Unlocking:** `approved` sets `live_status = 'approved'` in the same transaction. The edge reads it
  with each live key (no cache), so `fin_live_` keys work on the next request; the console's
  EnvironmentSwitch opens; creating a Production key is allowed (`apiKey.live`; refused with 403
  `live_not_enabled` before approval). Pause makes live keys answer 403 `live_paused` at once.
- **Provider status** of the company applicant (`go_live_request.provider_status`): `null` (not sent),
  `init`, `sent` (data and people pushed; the check refused with 409, [KY-05]), `pending`,
  `completed:GREEN`, `completed:RED_RETRY`, `completed:RED_FINAL`. Staff decide whatever it says.

### 3.8 Sandbox outcomes and the simulator

The last four digits of an individual's or a person's `tax_id`, or of a business's
`registration_number`, pick the outcome after submit. The sandbox provider plays it on its next tick
(every minute, so 10 to 70 seconds):

| Digits | Outcome key | What happens |
|---|---|---|
| other | `default` | approved, or `in_review` with `fin_review` when the switch is on |
| `0000` | `approved` | approved |
| `0001` | `resubmit` | `incomplete`, `document_unreadable`; ID documents `retry`; a selfie `selfie_failed` |
| `0002` | `rejected` | `rejected`, `restartable` |
| `0003` | `stays_in_review` | stays until the simulator acts |
| `0004` | `approved_then_rfi` | approved; 30 s later an RFI for the `proof_of_address` system form; an answer is accepted at the next tick |
| `0005` | `waits_for_fin` | `in_review` with `fin_review` |

Simulator actions and the statuses each works in: `submit` (`incomplete`), `approve` (`in_review`,
`action_required`, `unapproved`), `request_resubmission` (`in_review`), `reject` (all but `rejected`),
`request_information` (`in_review`, `approved`, `unapproved`), `unapprove` (`in_review`, `approved`,
`action_required`). Anything else is 409 `transition_refused`, checked again under the lock. The
Sandbox data generator fills made-up details and specimen documents marked `test_data`, from the
canon's sets, never real people.

### 3.9 Coupling rules

These live in the machines, so every caller gets them:

1. A staff `approve`, `unapprove` or `reject` withdraws an open RFI with `closed_by_decision`, in the
   same transaction.
2. A business is re-evaluated whenever one of its people moves or is removed: if the company's own
   review is GREEN and every remaining person is `approved` and at least one holds `shareholder` or
   `ubo`, a `people_pending` business moves on as the GREEN rule says; any person `rejected` moves an
   `in_review` business to `action_required` (`person_rejected`) and an `approved` one to `unapproved`
   with a flag.
3. Every customer status change, delete, erasure and Sandbox reset calls
   `ops.enqueue_job('money.customer_changed', payload)` in the same transaction, then
   `NOTIFY payments_jobs` after commit, with spec 04 §10.1's payload (`customer_id`,
   `organization_id`, `mode`, `type`, `status`, `status_seq`, `country`, `event` one of
   `status_changed`, `deleted`, `erased`, `sandbox_reset`). This spec owns the calls; spec 04 owns the
   payload and the handler. `status_seq` increases by one on every status change of the customer.
4. Every status move writes its audit event, `customer.updated` plus the specific developer event, and
   its email where §17 says so, in one transaction. A move that changes neither the status nor the
   public `status_detail` emits no developer event. Re-applied provider answers are no-ops (`once`).
5. Restarting or deleting revokes every link and ends every link session of the subject.

### 3.10 "What Fin needs"

`checklist(customer)` returns one part per need, each `not_started`, `in_progress`, `sent` or
`asked_again`, computed from `fields_present`, documents and people, never from values. Individual
parts: `details`, `money`, `photo_id`, `proof_of_address`. Business parts: `company_details`,
`company_questions`, `company_documents`, `people`. `missing()` returns API names:
`details.<field>`, `answers.<field>`, `documents.<type>`, `people.owner`. The console, verify and the
API's `missing` use the same function.

## 4. Data model

One schema per area (ARCHITECTURE §6.1). `kyc` is written and read only by `api` and `worker`; the console, Fin
Admin and verify reach it only through `api`'s doors ([DA-07]). Conventions (ARCHITECTURE §6.2): IDs made by
`newId(prefix, clock)`; times `timestamptz`, written from the unit's `Clock`; checks of expiry use the
database's `now()`; every list read starts with `(organization_id, mode, ...)` and has its index,
proven by an `EXPLAIN` test.

### 4.1 New ID prefixes

Added to `packages/core/src/ids.ts` (the test refuses a duplicate): `kac` (applicant action), `kaw`
(applicant write), `sft` (selfie ticket), `goc` (go-live owner company), `gec` (go-live email code),
`pap` (pending approval), `snt` (staff note), `ers` (erasure request), `kfg` (KYC flag), `hem` (held
Sandbox email), `rsn` (preset reason), `tpl` (message template), `svw` (saved view), `dvw` (a staff
member's document view, §12.2). Existing ones used:
`cus`, `per`, `doc`, `lnk`, `lks`, `rfi`, `rit`, `frm`, `glr`, `kap`, `kie`, `evt`, `whe`, `whd`, `job`,
`eml`, `sti` (SD3-20).

### 4.2 `kyc` tables

`kyc.organization_setting`

| Column | Type | Notes |
|---|---|---|
| `organization_id` | text PK | |
| `fin_approves_customers` | bool not null default false | "Fin approves each customer"; never shown to the developer |
| `updated_at`, `updated_by_staff_id` | timestamptz, text | |

`kyc.customer`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `cus_` |
| `organization_id`, `mode` | text not null | `mode in ('sandbox','live')` |
| `type` | text not null | `individual`, `business` |
| `company_type` | text null | `llc`, `corporation`, `partnership`, `sole`, `listed`, `trust`, `foundation`, `nonprofit`, `charity`, `agency` |
| `status`, `status_reason`, `next_actor` | text | §3.1 |
| `status_seq` | int not null default 0 | plus one on every status change (spec 04 §10.1) |
| `rejection_kind` | text null | `final`, `restartable`; set only while `rejected` |
| `restart_granted_by_staff_id` | text null | the staff member who allowed one restart |
| `restarts_at` | timestamptz[] not null default '{}' | the last 24 hours' restarts |
| `external_id` | text null | at most 255, one line |
| `country` | text null | ISO 3166-1 alpha-2 |
| `attempt` | int not null default 1 | |
| `test_data` | bool not null default false | "Sandbox data" |
| `created_via` | text not null | `api`, `console`, `sandbox` |
| `name_sealed` | text null | `fdk<n>.` value, AAD `<org>:customer.name` |
| `email_hash`, `phone_hash` | bytea null | HMAC under `email-index:<org>:<mode>` and `phone-index:<org>:<mode>` |
| `email_masked`, `phone_masked` | text null | ARCHITECTURE §6.6 masks |
| `name_tokens` | bigint[] not null default '{}' | the blind index, GIN |
| `index_version` | smallint not null default 1 | |
| `fields_present` | text[] not null default '{}' | API names only, never values |
| `details_sealed`, `answers_sealed` | jsonb null | Sandbox only: `{ field: "fdk<n>..." }`, AAD `<org>:customer.details.<field>`; `CHECK (mode = 'sandbox' OR (details_sealed IS NULL AND answers_sealed IS NULL))` |
| `consent_version`, `consent_at`, `consent_by` | text, timestamptz, text | `consent_by in ('customer','developer')`; version is `END_CUSTOMER_CONSENT_VERSION` ([KY-12]) |
| `submitted_at`, `approved_at`, `rejected_at` | timestamptz null | |
| `deleted_at`, `erased_at` | timestamptz null | tombstone and erasure |
| `created_at`, `updated_at` | timestamptz not null | |

Indexes: unique `(organization_id, mode, external_id)` where `external_id is not null and deleted_at
is null`; `(organization_id, mode, created_at desc, id desc)` where `deleted_at is null`;
`(organization_id, mode, status, created_at desc, id desc)`; `(organization_id, mode, email_hash)`;
`(organization_id, mode, phone_hash)`; GIN `(name_tokens)`; partial `(updated_at)` where
`status = 'in_review' and status_reason = 'fin_review'` (Customer approvals).

`kyc.person`: `id` (`per_`); `organization_id`, `mode`; `customer_id` text null references
`kyc.customer`; `go_live_request_id` text null references `kyc.go_live_request`;
`CHECK (num_nonnulls(customer_id, go_live_request_id) = 1)`; `roles text[] not null`
(`cardinality(roles) >= 1`); `ownership_percent numeric(5,2) null` (0 to 100); `position text null`,
`relationship_started_on date null`, `owned_through_company_sealed text null` (go-live only); `status`,
`status_reason`, `attempt`; `name_sealed`, `email_hash`, `email_masked`, `phone_hash`, `phone_masked`,
`name_tokens`, `index_version`, `fields_present`; `details_sealed`, `answers_sealed` (Sandbox only,
the same CHECK); `test_data`; `submitted_at`, `approved_at`; `deleted_at`, `erased_at`; times. Unique
`(customer_id, email_hash)` and `(go_live_request_id, email_hash)` where `deleted_at is null`.

`kyc.document`: `id` (`doc_`); `organization_id`, `mode`; `customer_id` null, `person_id` null,
`CHECK (num_nonnulls(customer_id, person_id) = 1)`; `type text not null` (§5.6); `side text null`
(`front`, `back`); `country text null`; `status`, `reason`; `attempt int`; `rfi_item_id text null`;
`form_input_id text null`; `byte_size int not null`; `content_type text not null` (sniffed);
`provider text null`, `provider_image_id text null`, `provider_doc_type text null`,
`provider_doc_subtype text null`; `uploaded_via text` (`api`, `hosted_pages`, `assisted`); `test_data`;
`replaced_by text null`; times. Index `(customer_id, created_at)`, `(person_id, created_at)`.

`kyc.link`: `id` (`lnk_`); `organization_id`, `mode`; `kind` (`customer`, `person`, `assisted`);
`customer_id` not null; `person_id` null; `rfi_id` null; `token_hash bytea not null unique`;
`created_by_kind` (`api_key`, `user`, `system`), `created_by_id`; `expires_at`, `first_opened_at`,
`revoked_at`, `revoked_reason` (`replaced`, `restarted`, `deleted`, `rfi_closed`, `session_ended`);
`created_at`. Index `(customer_id, kind)` where `revoked_at is null`.

`kyc.link_session`: `id` (`lks_`); `link_id` not null; `secret_hash bytea not null`;
`entered_fields text[] not null default '{}'` (the refill rule, §8.2); `created_at`,
`last_seen_at`, `expires_at`, `ended_at`.

`kyc.selfie_ticket`: `id` (`sft_`); `organization_id`, `mode`; `link_session_id` not null;
`subject_kind` (`customer`, `person`), `subject_id`; `purpose` (`liveness_action`,
`developer_person_level`); `rfi_item_id` null; `external_action_id` null; `secret_hash`;
`expires_at` (10 minutes); `redeemed_at`; `session_secret_hash`, `session_expires_at` (15 minutes);
`token_refreshes smallint not null default 0`; `done_at`; `created_at`.

`kyc.form`: `id` (`frm_`); `system_key text null unique` (`proof_of_address`, `photo_id`,
`source_of_funds`, `selfie`); `name` (80), `description` (140); `status` (`draft`, `published`,
`archived`); `version int not null default 0`; `draft_definition jsonb`, `published_definition jsonb`
(the JSON Schema `packages/kyc/src/forms/definition.ts` exports: `{ inputs: [{ id, type, label, help,
required, options?, unit?, min?, max?, dates?, countries?, files?, ids? }] }`); `created_by_staff_id`,
`updated_by_staff_id`; `published_at`, `archived_at`; times. The four system forms are seeded by the
migration, published at version 1, and cannot be archived.

`kyc.rfi`: `id` (`rfi_`); `organization_id`, `mode`; `customer_id` not null; `status`; `source` (`fin`,
`partner`, `sandbox`; never shown to the developer); `opened_by_kind`, `opened_by_id`; `message text
null` (at most 2,000; Fin's staff's words, shown to the customer and the developer); `due_at`,
`expires_at`; `previous_status`; `revised_at`, `answered_at`, `decided_at`, `decided_by_kind`,
`decided_by_id`; `closed_reason text null` (`closed_by_decision`, `restarted`, `deleted`); times. Unique
`(customer_id)` where `status in ('open','answered','more_needed')`. Index `(organization_id, mode,
status, due_at)`.

`kyc.rfi_item`: `id` (`rit_`); `rfi_id`; `kind` (`form`, `extra_note`, `extra_document`); `form_id`,
`form_version`, `form_snapshot jsonb`; `status`; `answers_sealed text null` (sealed JSON of the non-file
inputs, both modes, AAD `<org>:rfi_item.answers`, SD3-12); `draft_sealed text null`,
`draft_link_session_id text null`; `sent_documents text[] not null default '{}'`; `added_later bool`;
times.

`kyc.kyc_applicant`: `id` (`kap_`); `organization_id`, `mode`; `subject_kind` (`customer`, `person`,
`go_live_request`), `subject_id`, `attempt`; `provider` (`sumsub`, `sandbox`); `external_user_id`
(unique with `provider`); `applicant_id text null`; `level text not null`; `review_status`,
`review_answer`, `reject_type`; `poll_at`, `poll_count int not null default 0`, `last_read_at`;
`deactivation_wanted_at`, `deactivated_at`; `sandbox_outcome`, `sandbox_next` (`decide`,
`request_information`, `accept_information`, `decide_selfie`), `sandbox_due_at`
(`CHECK (provider = 'sandbox' OR (sandbox_outcome IS NULL AND sandbox_next IS NULL AND sandbox_due_at
IS NULL))`); times. Indexes `(poll_at)` where `poll_at is not null`; `(sandbox_due_at)` where
`sandbox_due_at is not null`; `(deactivation_wanted_at)` where `deactivated_at is null and
deactivation_wanted_at is not null`.

`kyc.kyc_action`: `id` (`kac_`); `applicant_ref` (`kap_`); `external_action_id text not null unique`
(`cus_<id>[-<attempt>]-selfie-rit_<id>`); `rfi_item_id`; `status` (`pending`, `completed`);
`review_answer`, `reject_type`; times.

`kyc.applicant_write` (the sealed transit queue, ARCHITECTURE §6.5): `id` (`kaw_`); `organization_id`; `applicant_ref`
(`kap_`); `operation` (`person_data`, `company_data`, `questionnaire`, `metadata`, `beneficiary_link`,
`beneficiary_unlink`); `payload_sealed text not null` (AAD `<org>:applicant_write.payload`);
`link_session_id null` (the browser that entered it); `priority smallint` (0 for a submit flush);
`attempts`, `due_at`, `lease_until`, `leased_by`, `last_failure` (a bounded code); `created_at`. The row
is deleted when Sumsub accepts it. Left out of dumps ([DA-15]).

`kyc.inbound_event`: `id` (`kie_`); `provider`; `received_at`; `digest_alg`; `payload_digest bytea not
null unique` (SHA-256 of the raw body, the de-duplication key); `type`; `correlation_id`,
`external_user_id`, `applicant_id`, `external_action_id`, `level_name`, `review_status` (the allowlist,
SD3-16; nothing else from the body is stored); `status` (`received`, `processed`, `ignored`,
`failed`); `outcome` (a bounded code: `applied`, `stale`, `unknown_applicant`, `ignored_type`,
`no_change`); `attempts`, `due_at`, `lease_until`, `leased_by`, `processed_at`. Kept 30 days.

`kyc.go_live_request`: `id` (`glr_`); `organization_id`; `status`; `answers_sealed jsonb not null default
'{}'` (`{ page: "fdk<n>..." }`, AAD `<org>:go_live_request.answers.<page>`, SD3-27); `pages_done
text[]`; `company_email_hash bytea`, `company_email_masked text`, `company_email_checked_at`;
`terms_version`, `terms_accepted_at`, `terms_accepted_by_user_id`, `information_confirmed_at`; `sent_at`,
`sent_by_user_id`, `send_count int not null default 0`; `changes_sections text[]`, `changes_message
text`; `decline_message text`; `decided_at`, `decided_by_staff_id`; `provider_status text null`; times.
Unique `(organization_id)` where `status in ('draft','in_review','changes_requested')`.

`kyc.go_live_owner_company`: `id` (`goc_`); `go_live_request_id`; `name_sealed`; `country`;
`registration_number_sealed`; `ownership_percent numeric(5,2)`; `applicant_ref text null` (stretch,
[KY-06]); times. At most 10 per request.

`kyc.go_live_email_code`: `id` (`gec_`); `go_live_request_id`; `code_hash` (HMAC under the limit key);
`sent_to_hash`; `expires_at` (10 minutes); `tries smallint not null default 0` (at most 5); `used_at`;
`created_at`. One live code per request; swept after expiry. Left out of dumps.

`kyc.pending_approval`: `id` (`pap_`); `action` (`golive.approve`, `organisation.restore`);
`subject_id` (`glr_` or `org_`); `organization_id`; `first_staff_id`, `first_intent_id`, `first_at`;
`state` (`waiting`, `completed`, `cancelled`, `expired`); `completed_by_staff_id`, `completed_at`;
`expires_at` (72 hours). Unique `(action, subject_id)` where `state = 'waiting'`.

`kyc.staff_note`: `id` (`snt_`); `organization_id null`; `subject_kind`, `subject_id`; `staff_id`;
`body_sealed` (at most 2,000 characters before sealing, AAD `<org or fin>:staff_note.body`);
`created_at`. Audit metadata carries only the note's ID (SD3-10).

`kyc.erasure_request`: `id` (`ers_`); `organization_id`, `mode`; `subject_kind`, `subject_id`;
`requested_by_kind`, `requested_by_id`; `state` (`requested`, `deactivating`, `waiting_provider`,
`erased`, `failed`); `requested_at`, `deactivated_at`, `erased_at`; `last_failure`.

`kyc.flag`: `id` (`kfg_`); `organization_id`, `mode`; `subject_kind`, `subject_id`; `kind`
(`review_reopened`, `risk_level_changed`, `company_structure_changed`, `personal_info_changed`,
`read_back_invalid`, `write_refused`, `unknown_applicant`, `deactivated_at_provider`); `source_event_id
null`; `state` (`open`, `resolved`); `resolved_by_staff_id`, `resolved_at`; `created_at`.

`kyc.held_email` (Sandbox mail not sent, [SA-40], SD3-18): `id` (`hem_`); `organization_id`;
`template`; `subject_kind`, `subject_id`; `recipient_masked`; `created_at`. It never stores a link, a
code or an address in clear.

`kyc.sandbox_usage`: `organization_id`, `day date`, `documents int`, `bytes bigint`; primary key
`(organization_id, day)`. Logged (not `UNLOGGED`), so a restart keeps the count.

`kyc.document_view` (a staff member's single-use document URL, §12.2, SD3-17): `id` (`dvw_`, an
ordinary ID: it is not a bearer value, because only the staff session it is bound to can redeem it);
`organization_id`, `mode`; `document_id`; `staff_id`; `staff_session_hash bytea not null` (SHA-256 of
the staff session's ID); `delivery` (`inline`, `download`); `expires_at` (60 seconds after
`created_at`); `redeemed_at`; `created_at`. The insert and its `staff.document_viewed` row are one
transaction.

### 4.3 `staff` tables for reasons, templates and views (owned by `admin`)

`staff.reason_preset`: `id` (`rsn_`); `action` (the keys of Appendix B); `code` (lower case, digits and
underscores, starting with a letter, at most 40, unique per action, never changed); `wording` (at most
80); `position int`; `retired_at`, `retired_by_staff_id`; times. `other` is not a row: it is always last
and needs a note.

`staff.message_template`: `id` (`tpl_`); `audience` (`customer_rfi`, `developer_golive_changes`,
`developer_golive_decline`); `name` (60); `body` (2,000); `retired_at`, `retired_by_staff_id`; times.

`staff.saved_view` (stretch 4): `id` (`svw_`); `list` (`golive`, `approvals`, `organisations`,
`customers`, `rfis`, `audit`); `name` (60); `query jsonb` (filters and sort only, never search text);
`created_by_staff_id`; `created_at`. At most 50 per list; 30 changes an hour per staff member.

`api` reads `staff.v_reason_preset` and `staff.v_message_template` (narrow views) to validate a reason
code and fill a template inside a decision's transaction.

### 4.4 `events` tables

Spec 05 §5.5 defines `events.event`, `events.endpoint` and `events.delivery` and the checked
`events.emit()`. The onboarding machines call `events.emit()` with `subject_ids` holding the
customer's ID and, for RFI events, the RFI's ID, so `GET /v4/events?customer_id=` and `?rfi_id=` work.

### 4.5 `identity` and `ops` touches

- `identity.organization.live_status` (Saturday's column): `api` holds a column-level `UPDATE` grant
  on it and nothing else in `identity`.
- Views `api` and `worker` read: `identity.v_org_super_admins` (organisation ID, user ID, confirmed
  email for sending; worker only), `identity.v_member_confirmed_email_hashes` (organisation ID, email
  hash under the limit key; for the Sandbox mail rule), `identity.v_organization` (ID, name, live
  status).
- `ops.kill_switch` rows read: `hosted_verify`, `sumsub_writes` (ARCHITECTURE §15.1).
- `ops.job` kinds `api` enqueues: `money.customer_changed` (through spec 04's checked
  `ops.enqueue_job()`, claimed by `payments` from Monday), `kyc.deactivate_applicants`,
  `kyc.golive_push` (claimed by `worker`).

### 4.6 Grants (fragments)

| Fragment | Owner lane | Grants |
|---|---|---|
| `packages/db/roles/grants/kyc.json` | L-SUN-02 | `fin_api`: select, insert, update, delete on every `kyc` table; `fin_worker`: the same; every other role: nothing |
| `packages/db/roles/grants/admin_settings.json` | L-SUN-08 | `fin_admin`: full on `staff.reason_preset`, `staff.message_template`, `staff.saved_view`; `fin_api`: select on `staff.v_reason_preset`, `staff.v_message_template` |
| `packages/db/roles/grants/identity_kyc.json` | L-SUN-02 | `fin_api`: `UPDATE (live_status)` on `identity.organization`, select on `identity.v_organization` and `identity.v_member_confirmed_email_hashes`; `fin_worker`: select on `identity.v_org_super_admins` |

Each forbidden statement has a test that fails with SQLSTATE 42501 (ARCHITECTURE §6.3).

### 4.7 The audit guard

Deferred constraint triggers (ARCHITECTURE §8.2) refuse a commit that changes these without an audit row naming the
row: `kyc.customer` (`status`, `rejection_kind`, `restart_granted_by_staff_id`, `deleted_at`);
`kyc.person` (`status`); `kyc.link` (insert); `kyc.rfi` (insert, `status`); `kyc.go_live_request`
(`status`); `kyc.pending_approval` (insert, `state`); `kyc.document_view` (insert);
`kyc.organization_setting` (any change);
`identity.organization` (`live_status`). Each has a guard test (ARCHITECTURE §8.9). The webhook
tables' guards are Spec 05's.

### 4.8 Sealed values and hashes

All under ARCHITECTURE §6.6's families, held by `api` and `worker` only. AAD scopes: `customer.name`,
`customer.details.<field>`, `customer.answers.<field>`, `person.name`, `person.details.<field>`,
`person.answers.<field>`, `person.owned_through_company`, `rfi_item.answers`, `rfi_item.draft`,
`applicant_write.payload`, `go_live_request.answers.<page>`, `go_live_owner_company.name`,
`go_live_owner_company.registration_number` and `staff_note.body`. Index subkeys: `email-index`, `phone-index`, `name-index`, all
`:<org>:<mode>`. Go-live rows use mode `live`.

### 4.9 Retention

As ARCHITECTURE §6.8, plus: inbound events 30 days; selfie tickets, document views and go-live email codes until expiry plus 2
hours; link sessions until their link ends; pending approvals 90 days after they close; held Sandbox
emails 30 days; flags for the life of the customer; staff notes with the subject (erased with it).
Sandbox customers are deleted 90 days after their last change (the `sandbox-purge` duty, H-09).

### 4.10 Migrations

Hand-written, named `packages/db/migrations/<YYYYMMDDHHMMSS>_<area>_<what>.sql` with the timestamp
taken when the file is written (ARCHITECTURE §6.4): `kyc_core` (setting, customer, person, document),
`kyc_links` (link, session, selfie ticket, document view), `kyc_rfi_forms` (form with the four system forms, rfi,
item), `kyc_provider` (applicant, action, applicant write, inbound event, flag, erasure request),
`kyc_golive` (request, owner company, email code, pending approval), `kyc_misc` (staff note, held
email, Sandbox usage), `kyc_identity_views` (the `identity` views of §4.5, agreed with the identity
lane's owner), `kyc_guards` (the triggers of §4.7), `admin_settings` (with
Appendix B's seeds). Each sets `lock_timeout` and `statement_timeout` and passes squawk.

## 5. Fields, pages and documents

### 5.1 Where the catalogue lives

The field catalogue and its validators are browser-safe code in `packages/contract/src/fields/`
(Zod and pure functions, no Node import, a lint rule enforces it; SD3-13), used by `api`, by the
`verify` service and by verify's client, so the same checks run in the browser and on the server.
Each field has: its API name, its kind, its rule, whether it is required for submit, and its Sumsub
home (`fixedInfo.<f>`, `companyInfo.<f>`, `questionnaire:<id>.<section>.<item>`, `metadata:<key>`,
`sandbox_only` or `dropped`). The reverse-coverage test fails when a field has no home (AC-SUN-08).
The questionnaire item IDs come from `packages/kyc/src/providers/sumsub/generated/levels.json`, which
L-SUN-03 writes from Sumsub's sandbox app on Sunday morning with SP-11 and commits (it holds level
and question IDs, nothing secret).

### 5.2 An individual

| Group | Fields (API names; required unless marked) |
|---|---|
| Details | `first_name`, `middle_names` (optional), `last_name`, `date_of_birth` (YYYY-MM-DD, real, not in the future, 18 or older), `email`, `phone` (E.164), `country` (alpha-2, residence), `address_line1`, `address_line2` (optional), `city`, `state`, `postal_code`, `nationality` (alpha-2), `tax_id` |
| Answers | `employment_status`, `occupation`, `source_of_funds`, `purpose`, `monthly_amount` (Sumsub's choice values) |
| Documents | one photo ID (`passport`, `driving_licence`, `id_card` or `residence_permit`, with both sides where it has two) and one proof of address (`utility_bill`) |
| Hosted pages, in order | start (consent), `about`, `contact`, `address`, `tax`, `work`, `money`, photo ID, proof of address, review, done |

### 5.3 A business

| Group | Fields |
|---|---|
| Details | `legal_name`, `trading_name` (optional), `company_type`, `country` (of incorporation), `registration_number`, `date_of_incorporation`, `email`, `phone`, `tax_id`, `address_line1`, `address_line2` (optional), `city`, `state`, `postal_code`, `operates_at_registered_address` (yes or no; when no, the `operating_*` address fields), `website` (https; required for a trust) |
| Answers | `description`, `industry`, `purpose`, `source_of_funds`, `source_of_wealth`, `moves_money_for_others`, `annual_revenue`, `monthly_deposits`, `monthly_withdrawals`, `monthly_transactions`, `average_transaction` (optional), `regulated`, and the per-type questionnaire's items |
| Documents | the required set for its company type, from the level definition in `levels.json` (`COMPANY_DOCUMENTS` is generated from it, never hand-written) |
| People | at least one person holding `shareholder` or `ubo` (`people.owner`); at most 20 |
| Hosted pages, in order | start, `company`, `contact`, `address`, `operating` (only when not at the registered address), `business`, `money`, `amounts`, `regulation`, `risk`, `kyc`, `monitoring`, `history`, `ownership`, company documents, people, review, done |

### 5.4 A person

| Level | Pages | Fields |
|---|---|---|
| A business's person (`party`) | `contact_check`, `about`, `contact`, `address`, `tax`, `role`, `pep`, proof of address, photo ID, review, done | the individual's details, plus `roles`, `ownership_percent`, the PEP answers |
| A Production request's person (`developer_party`) | the same, then the selfie on the selfie host | plus `position`, `relationship_started_on`, `owned_through_company` |

### 5.5 Production request pages

Section and page keys, in order (the fields and their copy are drawn on GoToProductionForm; their API
names are below):

| Section | Page key | Fields |
|---|---|---|
| Company | `company` | `legal_name` (200), `trading_name`?, `company_type`, `country`, `registration_number`, `date_of_incorporation`, `years_in_operation` (count) |
| | `contact` | `company_email` (checked by a 6-digit code), `company_phone`, `website` (https), `linkedin_url` (https, a LinkedIn company page), `tax_id`, `industry` (name or NAICS code), `lei`? (20 letters and digits) |
| | `addresses` | registered `address_*` (no P.O. boxes), `operates_at_registered_address`, `operating_address_*` when no |
| Your business | `building` | `description` (50 to 2,000), `customer_kinds` (`individuals`, `businesses`), `customer_countries` (country and share rows totalling 100) |
| | `money` | `use_case` (14 choices), `use_case_other` (when "Something else"), `source_of_funds` (12 choices), `source_of_wealth` (8 choices), `moves_money_for_others`, `customers_move_money_for_others` (when yes) |
| | `amounts` | `annual_revenue`, `monthly_deposits`, `monthly_withdrawals` (USD), `monthly_transactions` (count), `average_transaction`? |
| Licences and compliance | `licences` | `regulated`; when yes `licences` (`msb`, `mtl`, `emi`, `vasp`, `psp`, `none`), `regulator`, `regulator_country`, `licence_number`, `aml_supervisor`, `aml_licence_number`? |
| | `aml` | `has_mlro`; when yes `mlro_name`, `mlro_title`, `mlro_email`, `mlro_phone`; `identity_verification` (`automated`, `manual`), `identity_vendor`?, `screening`, `screening_system`?, `monitoring`, `monitoring_system`?, `aml_audit_done`, then `aml_audit_date` or `aml_audit_planned`? |
| | `risk` | `high_risk_activities` (seven choices, "none of these" clears the rest), `high_risk_explain`?, `prohibited_countries`, `risk_low_pct`, `risk_medium_pct`, `risk_high_pct` (total 100), `refuses_anonymous`, `refuses_shell`, `investigations`?, `regulator_action`? |
| People | `people` | people (§5.4) and owner companies (`name`, `country`, `registration_number`, `ownership_percent`) |
| Agreement | `agreement` | `accept_terms`, `confirm_true`; `terms_version` is `DEVELOPER_TERMS_VERSION` (`2026-11`) for "Fin Developer Terms" and "Developer No-Nesting Terms" |

`?` marks an optional field. Go-live takes no documents ([KY-05]). The Developer Verification
applicant gets `companyInfo` (with `postalAddress`) and the metadata `number_of_years_in_operations` and
`company_linkedin` through `putMetadata`; the other answers stay sealed in Fin.

### 5.6 Documents and the upload rule

- **Types.** A person: `passport` (one side), `driving_licence`, `id_card`, `residence_permit` (two
  sides each), `utility_bill`, `selfie` (no file). A company: `articles_of_incorporation`,
  `certificate_of_incorporation`, `certificate_of_incumbency`, `power_of_attorney`,
  `proof_of_address`, `register_of_shareholders`, `register_of_directors`, `proof_of_source_of_funds`,
  `e_signature_certificate`, `business_licence`, `aml_policy`, `certificate_of_registration`,
  `partnership_agreement`, `register_of_partners`, `proof_of_nature_of_business`,
  `proof_of_tax_identification`, `proof_of_change_of_name`, `trust_agreement`,
  `tax_exempt_confirmation`, `proof_of_source_of_wealth`. A form's file: `rfi_file`.
- **One rule everywhere** ([DA-13]): at most 20 MB (413 `file_too_large`); JPEG, PNG, HEIC or PDF by
  their first bytes, whatever the name or declared type says (415 `unsupported_media_type`); a form's
  file input narrows the set to what the form allows. Whether Sumsub accepts HEIC is UNVERIFIED (SP-11);
  if not, HEIC is refused in live with 415 and the docs say so.
- **Sandbox quota** ([SA-40], SD3-14): 1,000 documents and 5 GB per organisation per UTC day, and 50
  documents per customer; past it, 409 `sandbox_quota` (Spec 05 §3.3.5). Sandbox files are sniffed and
  dropped.
- **Live upload**: streamed to Sumsub with `X-Return-Doc-Warnings: true`. An instant-check error is 422
  `document_refused` with `reason` (`document_unreadable`, `document_expired`,
  `document_not_accepted`); Sumsub 400 codes 1002 to 1005 and 1011 map to `document_unreadable`; a
  warning is returned in `warnings[]` and verify shows "This may be hard to read. Take it again if you
  can." with "Use it anyway".

### 5.7 Value rules

Phones are E.164 only (a plus and 8 to 15 digits; search also takes a leading `00`). Countries are
alpha-2 in Fin and alpha-3 at Sumsub (a region such as `US-CA` goes as `CA`). Dates are real and not
in the future. Percentages are 0 to 100. URLs are https. Choices are Sumsub's values. Names pass
`packages/identity/src/names.ts`. Any free value is at most 4,000 characters and one line unless the
field is a textarea. Unknown fields are refused (400 `invalid_field`). Values read back from Sumsub
pass the same rules before they are shown; a failure raises a `read_back_invalid` flag and shows a mask.

## 6. The KYC provider port

### 6.1 The interface

`packages/kyc/src/port.ts` ([KY-01], ARCHITECTURE §12.16). Every call returns an outcome in the money adapters'
shape (ARCHITECTURE §12.3), so a write that may have happened is never treated as one that did not:

```ts
export type KycOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "refused"; status: number; code: KycRefusal }          // 4xx: never retried
  | { kind: "retry"; afterMs: number | null; failure: KycFailure }  // 429, 5xx on idempotent calls
  | { kind: "unknown"; failure: KycFailure };                       // a timeout on a write that is not idempotent

export type KycRefusal =
  | "unauthorized" | "forbidden" | "not_found" | "conflict" | "invalid" | "document_refused"
  | "already_linked" | "review_not_allowed";
export type KycFailure =
  | "rate_limited" | "server_error" | "unavailable" | "timeout" | "network" | "invalid_response"
  | "host_refused";

export type ApplicantRef = { applicantRefId: `kap_${string}`; externalUserId: string; applicantId: string | null };
export type LevelKey =
  | "individual" | `business:${CompanyType}` | "party" | "developer" | "developer_party" | "liveness";

export interface KycProvider {
  readonly name: "sumsub" | "sandbox";
  ensureApplicant(ref: ApplicantRef, level: LevelKey, base: { type: "individual" | "company" }): Promise<KycOutcome<{ applicantId: string; created: boolean }>>;
  putPersonData(ref: ApplicantRef, data: PersonData): Promise<KycOutcome<void>>;
  putCompanyData(ref: ApplicantRef, data: CompanyData): Promise<KycOutcome<void>>;
  putQuestionnaire(ref: ApplicantRef, q: Questionnaire): Promise<KycOutcome<void>>;
  putMetadata(ref: ApplicantRef, items: ReadonlyArray<{ key: string; value: string }>): Promise<KycOutcome<void>>;
  uploadDocument(ref: ApplicantRef, doc: UploadInput): Promise<KycOutcome<{ imageId: string; errors: DocIssue[]; warnings: DocIssue[] }>>;
  linkBeneficiary(company: ApplicantRef, person: ApplicantRef, link: BeneficiaryLink): Promise<KycOutcome<{ linkId: string }>>;
  unlinkBeneficiary(company: ApplicantRef, linkId: string): Promise<KycOutcome<void>>;
  requestReview(ref: ApplicantRef): Promise<KycOutcome<{ accepted: boolean }>>;
  readReview(ref: ApplicantRef): Promise<KycOutcome<Review>>;
  readApplicantData(ref: ApplicantRef): Promise<KycOutcome<ApplicantData>>;   // the read places of §8.1 only
  readLabels(ref: ApplicantRef): Promise<KycOutcome<string[]>>;               // Fin Admin, with a reveal
  mintSdkToken(input: { externalUserId: string; level: LevelKey; ttlSeconds: 600; externalActionId?: string }): Promise<KycOutcome<{ token: string }>>;
  readAction(externalActionId: string): Promise<KycOutcome<ActionReview | null>>;
  fetchDocument(ref: ApplicantRef, imageId: string): Promise<KycOutcome<{ contentType: string; body: ReadableStream<Uint8Array> }>>;
  deactivateApplicant(ref: ApplicantRef): Promise<KycOutcome<void>>;
  verifyWebhook(raw: Uint8Array, headers: Headers, secrets: readonly Uint8Array[]): VerifiedHook | HookRefusal; // pure, no network
  listLevels(): Promise<KycOutcome<LevelInfo[]>>;
}
```

`readApplicantData`, `readLabels` and `unlinkBeneficiary` are added to ARCHITECTURE §12.16's list. Each provider call
writes one `provider.call` line (ARCHITECTURE §10.2) with `provider`, `operation`, `status`, `durationMs`,
`outcome`, `failure` and Fin's subject IDs. Only `apps/api` imports `packages/kyc/src/providers/**`
and the crypto modules (a lint rule; the Sunday door check of EXECUTION §4.4).

### 6.2 Call rules

A 10-second budget per call, the answer read included; `redirect: "manual"`; the base URL from the
adapter's allowlist in code (`https://api.sumsub.com` only); `Retry-After` honoured on 429; no retry of a
4xx, because Sumsub counts every 400, 403, 404 and 409 against a per-token bad-response limit; errors
carry the HTTP status and Sumsub's numeric code, never the body; idempotent by construction
(`ensureApplicant` looks up by `externalUserId` first; data calls replace).

### 6.3 The Sumsub adapter (`packages/kyc/src/providers/sumsub/`)

**Signing:** `X-App-Token`, `X-App-Access-Ts` (seconds) and `X-App-Access-Sig`, the hex HMAC-SHA256
of `ts + METHOD + path with query + body`, with `node:crypto`. Level names are encoded with spaces as
`+` and parentheses as `%28` and `%29`.

**Settings** (validated in `main()`, exit 78 on a bad one, never printing a value):

| Variable | Service | Notes |
|---|---|---|
| `SUMSUB_APP_TOKEN_WRITE`, `SUMSUB_SECRET_KEY_WRITE` | `api` | applicant writes at submit, uploads, SDK tokens |
| `SUMSUB_APP_TOKEN_READ`, `SUMSUB_SECRET_KEY_READ` | `api` | the read places of §8.1 |
| `SUMSUB_APP_TOKEN_DOCUMENTS`, `SUMSUB_SECRET_KEY_DOCUMENTS` | `api` | Fin Admin's document viewer |
| `SUMSUB_APP_TOKEN_WORKER`, `SUMSUB_SECRET_KEY_WORKER` | `worker` | inbound re-reads, polling, queued writes, go-live pushes, deactivation |
| `SUMSUB_WEBHOOK_SECRETS` | `api` | newest first, comma-separated; both accepted during a rotation |
| `SUMSUB_LEVEL_SET` | `api`, `worker` | `staging` or `production` |

All are sealed variables set by `pnpm fin` from the secure prompt (CR-13). In staging the four pairs
may hold the one sandbox token until the split exists ([KY-04]). The process refuses to start in
production with a token that begins `sbx:` and in staging with one that begins `prd:`.

**Calls:**

| Operation | Method and path | Notes |
|---|---|---|
| `ensureApplicant` | `GET /resources/applicants/-;externalUserId=<id>/one`, then `POST /resources/applicants?levelName=<level>` with `{ externalUserId, type }` | 404 on the lookup means none; a 409 on create leads to the lookup again |
| `putPersonData` | `PATCH /resources/applicants/{id}/fixedInfo` | |
| `putCompanyData` | `PATCH /resources/applicants/{id}/fixedInfo/companyInfo` | keeps its beneficiaries |
| `putMetadata` | `PATCH /resources/applicants` with `{ id, metadata: [{ key, value }] }` | metadata sent inside `companyInfo` is dropped by Sumsub |
| `putQuestionnaire` | `POST /resources/applicants/{id}/questionnaires` | one call per questionnaire; every questionnaire of the level is sent, empty ones included, or the check is refused |
| `uploadDocument` | `POST /resources/applicants/{id}/info/idDoc`, multipart `metadata` (`idDocType`, `idDocSubType`, `country` alpha-3) and `content`, header `X-Return-Doc-Warnings: true` | image ID in `X-Image-Id`; `errors` and `warnings` in the body |
| `linkBeneficiary` | `POST /resources/applicants/{companyId}/fixedInfo/companyInfo/beneficiaries` with `{ applicantId, types, shareSize, beneficiaryInfo? }` | on 409: read the company, delete the old link, post again (a link has no edit) |
| `unlinkBeneficiary` | `DELETE /resources/applicants/{companyId}/fixedInfo/companyInfo/beneficiaries/{linkId}` | |
| `requestReview` | `POST /resources/applicants/{id}/status/pending` | Developer Verification answers 409 until Sumsub's own steps are done: `accepted: false`, and the request's `provider_status` becomes `sent` ([KY-05]) |
| `readReview` | `GET /resources/applicants/{id}/status` | `reviewStatus`, `reviewResult.{ reviewAnswer, reviewRejectType, rejectLabels }`; labels are used to map a retry reason and then dropped |
| `readApplicantData`, `readLabels` | `GET /resources/applicants/{id}/one` and the status call | whether questionnaire answers come back on `/one` is UNVERIFIED (SP-11) |
| `mintSdkToken` | `POST /resources/accessTokens/sdk` with `{ userId, levelName, ttlInSecs: 600, externalActionId? }` | |
| `readAction` | `GET /resources/applicantActions/-;externalActionId=<id>` (the list form) | |
| `fetchDocument` | `GET /resources/applicants/{id}/one` for `inspectionId`, then `GET /resources/inspections/{inspectionId}/resources/{imageId}` | streamed; first bytes must be PNG, JPEG or PDF; at most 25 MB |
| `deactivateApplicant` | `PATCH /resources/applicants/{id}/presence/deactivated` | path UNVERIFIED (SP-11) |
| `listLevels` | `GET /resources/applicants/-/levels` | refuses a partial page |

**Levels** (Fin's own level names in its Sumsub app; the staging set, and production drops the
staging markers, UNVERIFIED until the production app exists, PG-11):

| Level key | Sumsub level | Applicant type |
|---|---|---|
| `individual` | `Orchestration - Individual full verification V2 (Staging - STANDARD)` | individual |
| `business:<type>` | `[Standard] Business Customer V2 - <Type> (Staging)` for Limited Liability Company, Corporation Inc Corp, Partnership, Sole Proprietorship, Publicly Listed Company, Trust, Private Foundation, Non-profit Organization, Charity, Public Agency or Authority | company |
| `party` | `Associated parties full verification (Staging - STANDARD)` | individual |
| `developer` | `Developer Verification` | company |
| `developer_party` | `Developer Verification Associated Parties` (the selfie runs in the WebSDK) | individual |
| `liveness` | `Liveliness check` (an applicant action) | n/a |

`packages/kyc/src/providers/sumsub/levels.ts` maps keys to names per level set, and
`levels-coverage.test.ts` fails when Fin stops collecting a required input of any level.

**`externalUserId`:** `cus_<id>`, `per_<id>` or `glr_<id>`, with `-<attempt>` after a restart (attempt 2
onwards). A selfie action is `cus_<id>[-<attempt>]-selfie-rit_<item id>`. Parsers are strict regular
expressions on Crockford base32; anything else is `unknown_applicant`.

**Retry reasons from labels:** SELFIE, FACE or LIVENESS give `selfie_failed`; EXPIR gives
`document_expired`; UNSATISFACTORY_PHOTOS, BAD_PROPORTIONS, LOW_QUALITY, BLACK_AND_WHITE,
DOCUMENT_DAMAGED, SCREENSHOTS, INCOMPLETE_DOCUMENT or BLURRED give `document_unreadable`; MISMATCH,
WRONG_ADDRESS, PROBLEMATIC_APPLICANT_DATA or DATA give `details_mismatch`; anything else gives
`document_not_accepted`.

**Beneficiary types:** `ubo` and `control` go as `ubo`, `shareholder` as `shareholder`, `director` as
`director`, `signatory` as `authorizedSignatory`. A go-live person also gets the metadata
`company_role` and `relationship_established_at`.

### 6.4 The sandbox provider (`packages/kyc/src/providers/sandbox/`)

It implements the same interface over `kyc.kyc_applicant` rows with `provider = 'sandbox'` (SD3-19).
`requestReview` records the outcome from the test value (§3.8) and sets `sandbox_next` and
`sandbox_due_at`; the `kyc-sandbox` duty, on each tick, turns due decisions into synthetic
`kyc.inbound_event` rows (`provider = 'sandbox'`), which the same worker loop applies, so Sandbox and
live share one pipeline. `readReview` returns the decided review; `uploadDocument` sniffs and drops the
file and returns warnings for a test value ending `0001`; `fetchDocument` is refused (Fin Admin shows
"Sandbox files aren't kept."); `mintSdkToken` is refused, because Sandbox selfies use "Use a test
selfie"; `readApplicantData` opens the sealed Sandbox values. Sandbox mode never calls Sumsub.

### 6.5 The conformance suite (`packages/kyc/src/conformance/`)

One suite, run against the Sumsub adapter (over the Sumsub stand-in's recorded answers) and the
sandbox provider (AC-SUN-05): ensure an applicant (new, existing, a 409 on create); each data call;
an upload (accepted, refused with errors, warnings); link and unlink a beneficiary; request a review
(accepted; Developer Verification's 409); read a review (each answer and reject type); mint an SDK
token; read an action; stream a document; deactivate; verify a webhook (right digest, wrong digest,
SHA-1 refused by default, unknown algorithm, too big); and the transport rules: a timeout on a read
is `retry`, on an upload is `unknown`; a 429 carries `afterMs` from `Retry-After`; a 4xx is never
retried; a redirect is not followed; a host outside the allowlist is `host_refused`. The real sandbox app is exercised by
the operator's `pnpm --filter @fin/kyc sumsub:smoke staging` (token at the secure prompt), never in CI,
and by AC-SUN-17 on staging.

## 7. Inbound events, polling and the transit queue

### 7.1 The hook door

1. `edge` receives `POST /hooks/kyc/sumsub` on `api.<zone>` with no API key, caps the body at 64 KB
   before reading it (413), limits per address, and forwards the raw bytes with `X-Payload-Digest`
   and `X-Payload-Digest-Alg` to `api`'s hook door, signed (ARCHITECTURE §7.9).
2. `api` verifies the digest over the raw bytes with each of `SUMSUB_WEBHOOK_SECRETS`, in constant time:
   `HMAC_SHA256_HEX` (the default when the header is absent) or `HMAC_SHA512_HEX`. `HMAC_SHA1_HEX` is
   refused by default; the owner may keep it (ARCHITECTURE §7.10), and only that recorded owner
   decision turns it on. A mismatch is 401 and a `sumsub.webhook_refused` line with the reason
   (`digest`, `alg`, `size`, `json`). With no secret configured the door answers 503 and writes
   `sumsub.webhook_unconfigured`.
3. `api` parses the JSON, keeps only the allowlisted fields (§4.2), inserts `kyc.inbound_event` with
   `ON CONFLICT (payload_digest) DO NOTHING`, sends `NOTIFY kyc_inbound`, and answers 200 within one
   second. A failure to store answers 500 so Sumsub resends (it resends five times, then may disable
   the webhook, which `sumsub-webhook-refused` and the poll cover).

### 7.2 Applying an event

The worker's `kyc-inbound` loop claims due events (ARCHITECTURE §4.6), finds the subject from `externalUserId` and
checks that the payload's `applicantId` equals Fin's stored one (otherwise `unknown_applicant`, a flag
and a line). It never trusts the payload's review: it reads the review back with the worker token,
then calls the machine with actor `provider`. Re-applying the same answer is a no-op.

| Type | What the worker does |
|---|---|
| `applicantReviewed`, `applicantWorkflowCompleted` | read the review; apply it to the customer, person or Production request |
| `applicantPending`, `applicantOnHold`, `applicantAwaitingUser`, `applicantAwaitingService` | read and mirror `review_status`; no status move |
| `applicantReset` | read; mirror; an approved customer moves to `unapproved` with `review_reopened` |
| `applicantWorkflowFailed` | read; mirror; a `kyc.workflow_failed` line (alerting with `sumsub-failing`) |
| `applicantActionPending`, `applicantActionReviewed`, `applicantActionOnHold` | `readAction`; update `kyc_action` and the selfie document |
| `applicantPersonalInfoChanged` | read the data and validate it; a failure raises `read_back_invalid`; on an approved customer, `personal_info_changed` |
| `applicantDeactivated`, `applicantActivated` | mirror; a deactivation Fin did not ask for raises `deactivated_at_provider` |
| `applicantDeleted`, `applicantPersonalDataDeleted` | set `erased_at` on the subject and `erased` on its erasure request (ARCHITECTURE §6.9) |
| `applicantLevelChanged`, `applicantRiskLevelChanged`, `companyStructureChanged` | raise `review_reopened`, `risk_level_changed` or `company_structure_changed` (the Signals screen is stretch 2) |
| anything else | `ignored_type`, counted |

Under workflows Sumsub holds `applicantReviewed` until the workflow completes; the handler does not
depend on order. Each applied event writes `job.run` (`job: "kyc-inbound"`) and, for a status move, the
machine's audit event with actor `provider`.

### 7.3 The poll, as the safety net

`kyc-poll` claims applicants whose `poll_at` is due (50 a tick per replica, `FOR UPDATE SKIP LOCKED`),
reads the review, applies it, and sets the next `poll_at` by backoff: 1, 5, 15 and 60 minutes after
submit, then hourly, until a final answer. A received webhook pushes `poll_at` to an hour later.
Production requests in `in_review` are read every 15 minutes. A review pending at Sumsub for more than
72 hours writes `kyc.review_stale` (alert `kyc-review-stale`).

### 7.4 The transit queue

- Every write of live personal data (a page save, `PATCH`, a person's data, a go-live company push)
  inserts a sealed `kyc.applicant_write` row in the same transaction as the domain change, with the
  link session that entered it, and sends `NOTIFY kyc_writes`.
- `kyc-applicant-writes` claims the oldest due row per applicant (one at a time per applicant, so
  writes keep their order), calls `ensureApplicant` the first time (and stores `applicant_id`), applies
  the operation with the worker token, and deletes the row. Backoff on `retry`: 10 s, 1, 5 and 15
  minutes, then hourly. A `refused` purges the row, raises `write_refused` for staff, and writes
  `kyc.write_refused`.
- **Submit flushes** the subject's rows in the request with the write token, within an 8-second budget,
  then pushes the questionnaires and requests the review. If a row remains, or Sumsub fails, the answer
  is 503 `provider_unavailable` with `Retry-After: 30`, and nothing moves.
- The `sumsub_writes` kill switch pauses the loop; submit and uploads answer 503
  `temporarily_unavailable`; saves keep queueing.

### 7.5 Deactivation, restart and erasure

`kyc-deactivations` (every 5 minutes) calls `deactivateApplicant` for every applicant with
`deactivation_wanted_at` set and `deactivated_at` null (restart, person removal, delete), and moves the
erasure request to `waiting_provider`. Sumsub's retention purges the data; its deletion webhooks set
`erased_at` (§7.2). The sandbox purge and the restore re-application are H-09.

### 7.6 Duties

| Duty | Runs in | Cadence | Heartbeat or success alert |
|---|---|---|---|
| `kyc-inbound` | worker | on `NOTIFY kyc_inbound`, and every minute | `duty-stalled-sumsub-inbound` |
| `kyc-applicant-writes` | worker | on `NOTIFY kyc_writes`, and every minute | `duty-stalled-applicant-writes` |
| `kyc-poll` | worker | every minute | `duty-stalled-sumsub-poll` |
| `kyc-sandbox` (decisions, 0004's request, expiring RFIs) | worker | every minute | `duty-stalled-sandbox` |
| `kyc-golive-push` (the `ops.job` kind) | worker | on wake | `duty-stalled-golive-push` |
| `kyc-deactivations` | worker | every 5 minutes | `duty-stalled-deactivations` |
| Sweeps: link sessions, selfie tickets, document views, email codes, held emails, pending approvals past 72 hours | worker | hourly (the existing sweep) | `duty-stalled-sweeps` |
| `erasure-sweep`, `sandbox-purge` | worker | daily | their heartbeats (ARCHITECTURE §10.7) |

## 8. Personal data

The rules of ARCHITECTURE §6.5 and ARCHITECTURE §6.6 apply as written. What Sunday adds:

### 8.1 Where Sumsub is read (the five places)

| Place | Door operation | Token | Gate | Audit |
|---|---|---|---|---|
| Console "Show details" | `console.customers.reveal` | read | `customers.read` and a window | `customer.details_shown` |
| Fin Admin "Show details" (with the review labels) | `admin.customers.reveal` | read | `customers.reveal`, a window and the budget | `staff.customer_details_shown` |
| Fin Admin's document viewer | `admin.documents.view_open` (the gated POST), then `admin.documents.file` (the single-use GET) | documents | `documents.view`, a window and the budget, all at the POST | `staff.document_viewed`, at the POST |
| A hosted page refilling a form | `verify.pages.read` | read | the link session, and the refill rule | none (a line) |
| An email to a customer or person | the worker's sender resolving the address | worker | the template's allowlist | the email's own event |

Each read is once per request, never cached, answered `no-store`, and capped at 300 per 10 minutes per
organisation (`kyc.pd_read` line per read; 429 past it). Sandbox reads open the sealed values instead.

### 8.2 The refill rule

A hosted page shows a field's value only when that field is in the current link session's
`entered_fields` (it was typed in this browser); a value still in the transit queue is opened from the
queue, else read from Sumsub. Any other field shows its mask, or "Already sent" for a value with no
mask. An assisted session never sees values the customer entered.

### 8.3 Search

- **The API** (`searchCustomers`, `POST /v4/customers/search`, [AP-18], Spec 05 §6.3): exactly one of
  `email`, `phone` or `name` in the body. **The console** (`POST /api/customers/search`) also takes an
  exact customer ID or external ID. Matching: the email hash; the phone hash (E.164, or a leading
  `00`); the name's blind index (every word start of 3 or more characters, 1 for CJK, at most 50
  candidates opened and filtered). Newest first. No infix and no typo match.
- **Limits:** 60 searches a minute per API key or member; email and phone searches also 10 an hour per
  organisation and searched value (keyed by the hash). A refusal is 429 `rate_limited`.
- **Fin Admin** searches by customer or organisation ID only.
- Search text never goes in a URL, a log, a cursor or an event.

### 8.4 Masks

Email `a•••@gmail.com` for a short list of common providers, otherwise `o•••@•••.com`; phone
`+44 •••• ••• 789`; date of birth `•• •• 1990`; tax ID and registration number `•••• 4821` (last four
kept only when Sumsub's record shows them, else `••••••••`); anything else `••••••••`. Answers to the
money and company questions are not personal and are never masked.

### 8.5 When Sumsub is down

Saves queue; submit and uploads answer 503 (`provider_unavailable` with `Retry-After`); verify shows
the "unavailable" page ("We can't take this right now. Your answers are saved. Try again in a few
minutes."); "Show details" and the viewer answer 502 `upstream_unavailable` and the screens say
"Details can't be shown right now." Each case has a Playwright test that reaches it with `page.route`.

## 9. The public API: onboarding routes (R16)

Sections 6.3 to 6.7 of Spec 05 are the inventory of record for the onboarding routes: their paths, operation
IDs, scopes, modes, idempotency classes, answers and codes, and Spec 05 §6.11 for the resource shapes.
Spec 05 §3 holds the conventions (problems, idempotency, pagination, rate limits, provider neutrality).
L-SUN-05 implements the routes as thin adapters over this spec's machines and doors. This section
fixes what the routes do and decides what Spec 05 left to this spec.

### 9.1 What each group does

| Group (Spec 05) | Behaviour from this spec |
|---|---|
| Customers (Spec 05 §6.3) | `createCustomer` runs `create` (§3.1); live personal fields go to the transit queue (§7.4), never to a `kyc` column. `updateCustomer` only while `incomplete` or `action_required`. `submitCustomer` runs `submit` with the flush of §7.4 and answers 503 `provider_unavailable` with `Retry-After` when it cannot flush. `createCustomerLink` mints a link (§3.4) and answers its URL once, with the token in the fragment. `restartCustomer` follows §3.1's restart rule. `deleteCustomer` writes the tombstone of §3.1. `searchCustomers` follows §8.3 |
| Documents and people (Spec 05 §6.4) | the upload rule of §5.6 (20 MB, first bytes, the Sandbox quota); `addPerson` enforces the 20-person cap and the share and email rules of §3.2; `createPersonLink` mints a person link |
| RFIs and events (Spec 05 §6.5) | `answerRfi` answers the request's forms by item and input ID (`items: { "<rit id>": { "inputs": { "<input id>": value }, "documents": { "<input id>": ["doc_..."] } } }`, plus `note` and `extra_documents`), and is refused with 409 `rfi_forms` when any form of the request has a selfie input, which only the customer's link can take (SD3-12) |
| Sandbox customers (Spec 05 §6.7) | `createTestCustomers` makes customers from the canon's Sandbox data with documents and people and submits them; the six simulations call the machines with actor `api_key`; `simulateRequestInformation` takes `forms` (published `frm_` IDs) or `items` (`proof_of_address`, `photo_id`, `source_of_funds`, `selfie`), which name the system forms of §3.5; `resetSandbox` deletes the organisation's Sandbox customers and their rows, writes `customer.sandbox_reset`, and enqueues `money.customer_changed` with `event: "sandbox_reset"` |

### 9.2 Additions proposed to Spec 05

- `Rfi.items[]` gains `form_version` and `inputs[] { id, type, label, required }`, so a developer can
  answer a form by API (an additive change to Spec 05 §6.11).
- The public code `provider_unavailable` (503, `next_actor: fin`, adds `Retry-After`) in
  `errors/customers.ts`, answered by `submitCustomer`, `uploadDocument` and `uploadPersonDocument` when
  Fin cannot reach Sumsub to flush or upload (ARCHITECTURE §6.5's transit-queue rule).
- `CustomerDetail` keeps `missing` only; the checklist stays a console and verify view.

### 9.3 Codes this spec decides

- `rfi_forms` (409) now means "this request includes a form only the customer's link can answer";
  `selfie_on_link_only` is not added.
- The old verify-only codes stay internal (the verify, console and Fin Admin halves only, never in the
  document): `selfie_not_taken`, `selfie_refused`, `customer_only`, `person_submitted`,
  `rfi_not_answered`, `rfi_not_waiting`, `status_changed`.
- Internal codes this spec adds, for the API halves: `link_not_found`, `ticket_not_found`,
  `go_live_open`, `go_live_declined`, `go_live_not_asked`, `go_live_unfinished`, `go_live_terms`,
  `email_code_wrong`, `email_code_expired`, `people_unverified`, `same_approver`, `approval_pending`,
  `reveal_budget_reached`, `reason_required`, `note_required`, `form_published`, `form_archived`.

### 9.4 Developer events

The catalogue, the `data` shapes, the groups and the payload are Spec 05 §5.1 and §5.2. The machines
emit them, in the action's transaction and mode:

| Event | Emitted when |
|---|---|
| `customer.created` | a customer is created (API, console, Sandbox data) |
| `customer.updated` | any change to status, `status_detail`, `external_id` or attempt, or a submit |
| `customer.approved`, `customer.action_required`, `customer.rejected` | a move into that status |
| `customer.deleted` | delete, Sandbox reset, the Sandbox purge |
| `person.updated`, `person.approved`, `person.rejected` | a business's person changes or moves |
| `document.updated` | a document moves to `accepted`, `retry` or `rejected` |
| `rfi.created` | an RFI opens |
| `rfi.updated` | answered, accepted, more needed, changed, withdrawn or expired |

No event names Fin's staff, a reason for a rejection, or the provider. Go-live has no developer event;
its outcome reaches the organisation by email and in the console.

## 10. Developer webhooks

Spec 05 §5 specifies the endpoints, their states and challenge, delivery and its schedule, Fin's test
receiver, the data, the audit events and the emails, built by L-SUN-04 in `packages/events`. This spec
adds only the console's Webhooks and Events screens (§12.1, §13.2), which call the door operations
`webhooks.*` (Spec 05 §5.6) with ARCHITECTURE §7.6's step-up kinds, and the events of §9.4.

## 11. Doors: what `api` accepts from the other services

Each row is an entry in `packages/server/src/doors/{kyc,golive,verify,admin_kyc}.ts` (the webhooks
fragment, `webhooks.ts`, is Spec 05 §5.6's), the
fragments of the door matrix (ARCHITECTURE §7.9). The callee (`api`) checks everything itself from its own views and
the database's clock ([SA-36]). "Session" means the console's forwarded session, membership, permission
and privileged hold; "staff" means the forwarded Access JWT, the staff session at `aal2`, the permission
and the proof (F6); "link" means `Fin-Caller-Link-Session` (`lks_<id>.<secret>`), which `api` hashes and
matches to a live link session. An operation not listed is refused with 403 and `api.outside_request`.

| Caller | Operations | Actor check | Step-up | Quota |
|---|---|---|---|---|
| `verify` | `verify.link.open` (token in the body) | none yet; the token | none | 20 per 10 minutes per address; 10 per hour per token hash |
| `verify` | `verify.link.view`, `verify.consent.give`, `verify.pages.read`, `verify.pages.save`, `verify.documents.upload` (streamed), `verify.documents.status`, `verify.submit`, `verify.people.add`, `verify.people.update`, `verify.people.remove`, `verify.people.send_link`, `verify.rfi.save_form`, `verify.rfi.send_form`, `verify.rfi.add_note`, `verify.rfi.add_documents`, `verify.link.email_me`, `verify.selfie.start` | link; the operation must fit the link's kind and scope (a person link reaches only its person; an RFI-scoped link only its request) | none | saves 120 per 10 minutes per session; uploads 30 per hour per session and the Sandbox quota; email me 3 an hour per session |
| `verify` (selfie host) | `selfie.redeem` (ticket in the body), `selfie.refresh_token`, `selfie.done` | the ticket, then the selfie session cookie's value as `Fin-Caller-Selfie-Session` | none | 10 per 10 minutes per address |
| `console` | `console.customers.list`, `.search`, `.counts`, `.get`, `.people`, `.documents`, `.activity`, `console.sandbox.held_mail` | session; `customers.read` | none | the read limit for search (§8.3) |
| `console` | `console.customers.create` | session; `customers.create` | window | |
| `console` | `console.customers.reveal` | session; `customers.read` | window | 300 per 10 minutes per organisation |
| `console` | `console.customers.link_create`, `.assisted_link_create` | session; `customers.create` | intent (SD3-08) | |
| `console` | `console.customers.restart` / `.delete` | session; `customers.restart` / `customers.delete` | intent | |
| `console` | `console.sandbox.create_customers`, `console.sandbox.act`, `console.sandbox.recent`, `console.forms.published` | session; `simulator.use` (and `customers.create` to create); Sandbox mode only | none | |
| `console` | `console.sandbox.reset` | session; `sandbox.reset`; Sandbox | intent | one running at a time |
| `console` | `console.golive.status` | session; any member | none | |
| `console` | `console.golive.get`, `.start`, `.save_page`, `.email_code_send`, `.email_code_check`, `.person_remove`, `.company_add`, `.company_remove` | session; `golive.edit` | none | email codes 3 an hour per request; 5 tries per code |
| `console` | `console.golive.person_add`, `.person_link` | session; `golive.edit` | intent | |
| `console` | `console.golive.submit` | session; `golive.submit` | intent | |
| `console` | `webhooks.*` (Spec 05 §5.6) | session; `webhooks.read`, `webhooks.manage`, `webhooks.roll_secret`, `webhooks.redeliver` | as §12.1 | |
| `admin` | `admin.golive.list`, `.get`, `admin.approvals.list`, `admin.customers.list`, `.get`, `admin.rfis.list`, `admin.organisations.list`, `.get`, `admin.forms.list`, `.get`, `admin.history.subject`, `admin.reasons.usage`, `admin.flags.list` | staff; the matching `*.read` | none | |
| `admin` | `admin.golive.approve`, `.request_changes`, `.decline` | staff; `golive.decide` | intent | |
| `admin` | `admin.pending_approval.cancel` | staff; the first approver only | none | |
| `admin` | `admin.customers.reveal` | staff; `customers.reveal` | window | the staff budget (§15.3) |
| `admin` | `admin.documents.view_open` | staff; `documents.view` | window | the staff budget |
| `admin` | `admin.documents.file` (the `dvw_` ID; streamed) | staff; `documents.view`; the view unredeemed, unexpired, of this staff member and bound to this staff session | none (checked at `view_open`) | none (spent at `view_open`) |
| `admin` | `admin.customers.approve`, `.unapprove`, `.reject`, `.allow_restart` | staff; `customers.decide` | intent | |
| `admin` | `admin.rfis.open`, `.accept`, `.ask_more`, `.withdraw`, `.change` | staff; `rfis.manage` | none ([SA-17]) | |
| `admin` | `admin.organisations.pause`, `.restore` | staff; `organisations.pause` | intent | |
| `admin` | `admin.organisations.set_approvals` | staff; `organisations.approvals` | intent | |
| `admin` | `admin.forms.create`, `.save`, `.publish`, `.archive` | staff; `forms.manage` | none | |
| `admin` | `admin.flags.resolve` | staff; `customers.decide` | none | |
| `edge` | `/internal/v4/*` (the routes of §9 and §10) | the forwarded key assertion: organisation, mode, scopes | none | ARCHITECTURE §13.6 |
| `edge` | `hooks.kyc.sumsub` (raw body) | the digest (§7.1) | none | per address at the edge |

Every operation that returns personal data writes a `kyc.pd_read` line (reader kind, organisation,
mode, count; never the values).

## 12. App API routes

Each app's routes are its same-origin `/api/*` (FW-C07): one policy fragment per area in
`apps/<app>/src/server/policy/<area>.ts` lists the guard, the permission, the step-up kind, the Zod
input schema (from `packages/app-contracts`) and the audit event; the route test fails on a route
missing from the policy. Every answer is `Cache-Control: no-store`. Every non-GET passes the origin
gate. Console routes are organisation routes: each takes `Fin-Organization` and `requireActor` (spec 02
IF-02), never the session's current organisation. A step-up route without a matching proof answers `step_up_required` with an intent ID and the
client re-sends once (F4).

**GETs change nothing that matters** (spec 02 §2.3, [SA-44]). The origin gate skips GET, and a
sibling page on the same site can make a GET that carries the `Strict` cookie, so no GET route may
declare an `audit` event, a budget or `stepUp: "intent"` (using up an intent is a change): whatever
is audited or counted happens at a gated POST. A GET that redeems a URL a POST minted (here, only
`GET /api/document-views/:viewId`) declares `fetchSite: "same-origin-or-none"`: `Sec-Fetch-Site`
must be present and `same-origin`, or `none` (the minted URL typed or pasted into a tab); anything
else, or no header, is 403 `invalid_origin` with one `csrf.refused` line (reason `fetch_site`) and
`reason: origin_gate.fetch_site` on the `request` line. The route-policy
test fails on a GET that declares `audit`, an intent or `limits` that spend a budget, and on a GET
that redeems a minted URL without `fetchSite`.

### 12.1 Console (`apps/console/src/server/routes/`)

| Route | Permission | Step-up | Door | Audit event |
|---|---|---|---|---|
| `GET /api/customers` (`status`, `attention`, `cursor`) | `customers.read` | none | `console.customers.list` | none (a line) |
| `GET /api/customers/counts` (an estimate, labelled so) | `customers.read` | none | `.counts` | none |
| `POST /api/customers/search` | `customers.read` | none | `.search` | none (a line) |
| `POST /api/customers` | `customers.create` | window | `.create` | `customer.created` |
| `GET /api/customers/:id`, `/people`, `/documents`, `/activity` | `customers.read` | none | `.get`, `.people`, `.documents`, `.activity` | none |
| `POST /api/customers/:id/reveal` | `customers.read` | window | `.reveal` | `customer.details_shown` |
| `POST /api/customers/:id/links` | `customers.create` | intent | `.link_create` | `customer.link_created` |
| `POST /api/customers/:id/assisted-links` | `customers.create` | intent | `.assisted_link_create` | `customer.assisted_link_created` |
| `POST /api/customers/:id/restart` | `customers.restart` | intent | `.restart` | `customer.restarted` |
| `DELETE /api/customers/:id` | `customers.delete` | intent | `.delete` | `customer.deleted` |
| `POST /api/customers/:id/simulate` (`action`, `reason`, `forms`) | `simulator.use`, Sandbox | none | `console.sandbox.act` | `customer.sandbox_action` |
| `POST /api/sandbox/customers` (`type`, `outcome`, `count` 1 to 5 in the console) | `simulator.use` and `customers.create`, Sandbox | none | `console.sandbox.create_customers` | `customer.test_data_created` |
| `GET /api/sandbox/recent`, `GET /api/sandbox/held-mail`, `GET /api/forms/published` | `simulator.use` (held mail: `customers.read`) | none | `.recent`, `.held_mail`, `console.forms.published` | none |
| `POST /api/sandbox/reset` | `sandbox.reset`, Sandbox | intent | `console.sandbox.reset` | `customer.sandbox_reset` |
| `GET /api/golive/status` | any member | none | `console.golive.status` | none |
| `GET /api/golive` | `golive.edit` | none | `.get` | none |
| `POST /api/golive/start` | `golive.edit` | none | `.start` | `go_live.started` |
| `PUT /api/golive/pages/:page` | `golive.edit` | none | `.save_page` | `go_live.answers_saved` |
| `POST /api/golive/company-email/code`, `/check` | `golive.edit` | none | `.email_code_send`, `.email_code_check` | `go_live.company_email_code_sent`, `go_live.company_email_checked` |
| `POST /api/golive/people`, `POST /api/golive/people/:id/link` | `golive.edit` | intent | `.person_add`, `.person_link` | `go_live.person_added`, `go_live.person_link_created` |
| `DELETE /api/golive/people/:id` | `golive.edit` | none | `.person_remove` | `go_live.person_removed` |
| `POST /api/golive/companies`, `DELETE /api/golive/companies/:id` | `golive.edit` | none | `.company_add`, `.company_remove` | `go_live.company_added`, `go_live.company_removed` |
| `POST /api/golive/submit` (`terms_version`, `accept_terms: true`, `confirm_true: true`) | `golive.submit` | intent | `.submit` | `go_live.terms_accepted`, `go_live.submitted` |
| `GET /api/webhooks`, `GET /api/webhooks/:id`, `GET /api/webhooks/:id/deliveries` | `webhooks.read` | none | `webhooks.*` | none |
| `POST /api/webhooks` | `webhooks.manage` | intent | `webhooks.*` | `webhook_endpoint.created` |
| `PATCH /api/webhooks/:id` (`url`) | `webhooks.manage` | intent | `webhooks.*` | `webhook_endpoint.url_changed` |
| `PATCH /api/webhooks/:id` (`enabled_events`, `description`, `status`) | `webhooks.manage` | window | `webhooks.*` | `webhook_endpoint.events_changed`, `webhook_endpoint.updated`, `webhook_endpoint.paused`, `webhook_endpoint.resumed` |
| `DELETE /api/webhooks/:id` | `webhooks.manage` | intent | `webhooks.*` | `webhook_endpoint.deleted` |
| `POST /api/webhooks/:id/roll-secret` | `webhooks.roll_secret` | intent | `webhooks.*` | `webhook_endpoint.secret_rolled` |
| `POST /api/webhooks/:id/test` | `webhooks.manage` | window | `webhooks.*` | `webhook_endpoint.test_sent` |
| `POST /api/webhooks/:id/deliveries/:delivery/retry` | `webhooks.redeliver` | window | `webhooks.*` | `webhook_delivery.retried` |
| `GET /api/events`, `GET /api/events/:id` | `webhooks.read` | none | `webhooks.*` | none |

### 12.2 Fin Admin (`apps/admin/src/server/routes/`)

Every route needs a valid Access token and an `aal2` staff session (Saturday). Decisions take
`reason_code` (an unretired preset for the action, or `other`, which needs `note`) and an optional
`note` (at most 2,000; sealed, SD3-10).

| Route | Permission | Step-up | Door | Audit event |
|---|---|---|---|---|
| `GET /api/golive-requests` (`view`, filters, `cursor`), `GET /api/golive-requests/:id` | `golive.read` | none | `admin.golive.list`, `.get` | none |
| `POST /api/golive-requests/:id/approve` | `golive.decide` | intent | `.approve` | `staff.go_live_first_approval` or `staff.go_live_approved` |
| `POST /api/golive-requests/:id/request-changes` (`sections[]`, `message`, `template_id`) | `golive.decide` | intent | `.request_changes` | `staff.go_live_changes_requested` |
| `POST /api/golive-requests/:id/decline` (`message`?) | `golive.decide` | intent | `.decline` | `staff.go_live_declined` |
| `POST /api/pending-approvals/:id/cancel` | the first approver | none | `admin.pending_approval.cancel` | `staff.approval_cancelled` |
| `GET /api/approvals` | `customers.read` | none | `admin.approvals.list` | none |
| `GET /api/customers`, `GET /api/customers/:id` | `customers.read` | none | `admin.customers.list`, `.get` | none |
| `POST /api/customers/:id/reveal` | `customers.reveal` | window | `.reveal` | `staff.customer_details_shown` |
| `POST /api/documents/:id/view` (`delivery`: `inline` or `download`) | `documents.view` | window | `admin.documents.view_open` | `staff.document_viewed` |
| `GET /api/document-views/:viewId` (fetch-site guard) | `documents.view` | none (the view is single-use, 60 seconds, this session's) | `admin.documents.file` | none (written at the POST) |
| `POST /api/customers/:id/approve`, `/unapprove`, `/reject` (`rejection_kind` for reject) | `customers.decide` | intent | `.approve`, `.unapprove`, `.reject` | `staff.customer_approved`, `staff.customer_unapproved`, `staff.customer_rejected` |
| `POST /api/customers/:id/allow-restart` | `customers.decide` | intent | `.allow_restart` | `staff.customer_restart_allowed` |
| `POST /api/customers/:id/rfis` (`form_ids[]`, `message`, `template_id`, `due_at`, `source`) | `rfis.manage` | none | `admin.rfis.open` | `staff.rfi_created` |
| `POST /api/rfis/:id/accept`, `/ask-more` (`item_ids[]`, `message`), `/withdraw`, `PATCH /api/rfis/:id` (change) | `rfis.manage` | none | `.accept`, `.ask_more`, `.withdraw`, `.change` | `staff.rfi_accepted`, `staff.rfi_more_needed`, `staff.rfi_withdrawn`, `staff.rfi_changed` |
| `GET /api/rfis` | `rfis.read` | none | `admin.rfis.list` | none |
| `GET /api/organisations`, `GET /api/organisations/:id` | `organisations.read` | none | `admin.organisations.list`, `.get` | none |
| `POST /api/organisations/:id/pause`, `/restore` | `organisations.pause` | intent | `.pause`, `.restore` | `staff.organization_paused`, `staff.organization_restore_requested` or `staff.organization_restored` |
| `POST /api/organisations/:id/approvals` (`on`) | `organisations.approvals` | intent | `.set_approvals` | `staff.fin_approval_enabled`, `staff.fin_approval_disabled` |
| `GET /api/forms`, `GET /api/forms/:id` | `rfis.read` (every role) | none | `admin.forms.list`, `.get` | none |
| `POST /api/forms`, `PUT /api/forms/:id`, `POST /api/forms/:id/publish`, `/archive` | `forms.manage` | none | `admin.forms.*` | `staff.form_created`, `staff.form_updated`, `staff.form_published`, `staff.form_archived` |
| `GET /api/reasons` | any staff | none | (admin's own tables) and `admin.reasons.usage` | none |
| `POST /api/reasons`, `PATCH /api/reasons/:id` (wording, position), `POST /api/reasons/:id/retire`, `/restore` | `reasons.manage` | none | none: `admin` writes `staff.reason_preset` | `staff.reason_preset_added`, `_renamed`, `_moved`, `_retired`, `_restored` |
| `GET /api/templates`, `POST`, `PATCH /api/templates/:id`, `/retire`, `/restore` | read: any staff; write: `templates.manage` | none | none | `staff.message_template_added`, `_changed`, `_retired`, `_restored` |
| `GET /api/history/:kind/:id` | the subject's `*.read` | none | `admin.history.subject` | none |
| `GET /api/flags`, `POST /api/flags/:id/resolve` | `customers.read`; `customers.decide` | none | `admin.flags.*` | `staff.flag_resolved` |

**Opening a document** (SD3-17, SP-27). The viewer never reads a file with an audited GET:

1. `POST /api/documents/:id/view` passes the origin gate (`Origin`, `Sec-Fetch-Site`, `X-Fin-App`,
   JSON), the window and the permission. `api`'s door `admin.documents.view_open`, in one
   transaction, spends one unit of the staff member's budget (§15.3; past it, 429
   `reveal_budget_reached`), inserts a `kyc.document_view` bound to the staff session, and writes
   `staff.document_viewed`. It answers `{ url: "/api/document-views/<dvw id>", expires_at }`.
2. The viewer sets an `img` to that URL (an image), or opens it in a new tab (a PDF, or any file
   with `delivery: "download"`). Both are same-origin requests, so `img-src 'self'` covers them and
   Fin Admin's policy needs no `blob:`.
3. `GET /api/document-views/:viewId` passes the fetch-site guard of §12, then `api`'s door
   `admin.documents.file` marks the view redeemed, refusing one that is redeemed, expired, another
   staff member's or another session's with the same 404 `not_found`, and streams the file from
   Sumsub with `Cache-Control: no-store`, `Content-Disposition: inline` or `attachment` as
   `delivery` says, the file's own `Content-Type` (images and PDF only), and no `Accept-Ranges`. It
   writes no audit row and spends nothing: both happened at the POST.
4. A view lives 60 seconds and is redeemed once. If SP-27 finds that an engine fetches a PDF tab
   twice, the same session may fetch that view again until its 60 seconds end, never after, and
   never another session.

A sibling page on the same site can neither mint a view (the POST fails the origin gate) nor redeem
one (its GET carries `Sec-Fetch-Site: same-site`, which the guard refuses), so it can neither burn a
budget nor plant a `staff.document_viewed` row.

### 12.3 Verify and selfie (`apps/verify/src/server/`)

Guard `requireLink` (the cookie, checked by `api`'s door on every call) for every route but
`POST /api/link/open`, `POST /api/selfie/session` and the monitoring routes. The verify host serves
only the first group, the selfie host only the second; the other host's paths answer 404.

| Host | Route | Door | Notes |
|---|---|---|---|
| verify | `POST /api/link/open` (`token`) | `verify.link.open` | sets the cookie (§2.5) |
| verify | `GET /api/link` | `verify.link.view` | `{ kind, mode, assisted, developer_name, subject_type, steps[], checklist[], rfi?, selfie_needed, consent_needed }`; never a value |
| verify | `POST /api/consent` (`consent_version`) | `verify.consent.give` | the version must equal `END_CUSTOMER_CONSENT_VERSION` |
| verify | `GET /api/pages/:page`, `PUT /api/pages/:page` | `verify.pages.read`, `.save` | refill rule (§8.2); saves validated by §5's catalogue |
| verify | `POST /api/documents` (multipart, at most 20 MB), `GET /api/documents` | `verify.documents.upload`, `.status` | streamed to `api`; the status list serves the desktop's "Received from your phone" (polled every 5 s, for 15 minutes at most) |
| verify | `POST /api/submit` | `verify.submit` | |
| verify | `POST /api/people`, `PATCH /api/people/:id`, `DELETE /api/people/:id`, `POST /api/people/:id/link` | `verify.people.*` | a business's customer link only; the link is emailed to the person |
| verify | `PUT /api/requests/items/:item`, `POST /api/requests/items/:item/send`, `POST /api/requests/note`, `POST /api/requests/documents` | `verify.rfi.*` | |
| verify | `POST /api/link/email-me` | `verify.link.email_me` | the link goes only to the address on record |
| verify | `POST /api/selfie/start` (`item_id`?) | `verify.selfie.start` | answers the selfie URL |
| selfie | `POST /api/selfie/session` (`ticket`), `POST /api/selfie/token`, `POST /api/selfie/done` | `selfie.redeem`, `.refresh_token`, `.done` | §2.6 |
| both | `POST /api/monitoring/envelope`, `POST /api/monitoring/csp`, `GET /api/health` | none | parsed, scrubbed and capped by per-replica buckets (ARCHITECTURE §10.5, [SA-42]); health never touches the database |

## 13. Screens (R14)

### 13.1 Words

Screens say Sandbox and Production; the API keeps `test` and `live` ([UI-08] default). "Go to
Production" (the route stays `/settings/go-live`); "your Production request" (or "the Production
request" where "your" reads wrong); Fin Admin's "Production access requests"; "Sandbox data",
"Sandbox customers", "Sample request from the Sandbox."; "Send test event" keeps "test". Statuses and
lines are in Appendix A. Functional copy (labels, columns, statuses, field errors, dialog questions)
comes from the boards; framing copy follows the design system's rules. Short sentences, British
spelling, never "project". No provider name on any developer or customer screen; Fin Admin names Sumsub
under "Staff only" chips.

### 13.2 Console (L-SUN-07)

Built on `@fin/ui` (the UI SDK underneath) inside AppFrame, with the sidebar edge toggle. Must-have
states are EXECUTION §4.5's; the rest wait in the state manifest.

| Board | Route | Needs | Must-have on Sunday |
|---|---|---|---|
| Customers | `/customers` (`?q`, `?status`, `?attention`) | `customers.read` | list, status chips with counts, "Needs your attention", search as you type (250 ms; longer for exact IDs, emails and phones), empty, no match, too many searches, no permission, load failed, loading skeleton |
| NewCustomer | `/customers?view=new` (a size L drawer wizard: Type, Details, Review; [UI-07]) | `customers.create` | each step, "Fill with Sandbox data", "Create and complete with Sandbox data" with an outcome, submit failed, duplicate external ID, step-up, created with the link card |
| Customer | `/customers/{id}` (`?tab=` `details`, `people`, `documents` or `activity`; Money is Monday's) | `customers.read` | header, Overview cards (Information requested, Start again, Send the link with the shown-once link and "Fill it in yourself", Simulate in Sandbox, What Fin needs), not found, loading |
| CustomerDetails | Details and People tabs | `customers.read` | masked, "Show details" with step-up, shown, failed, "Details can't be shown right now." |
| CustomerDocuments | Documents and Activity tabs | `customers.read` | all; Activity also lists held Sandbox emails |
| CustomerDialogs | delete; ask for information (Sandbox) | `customers.delete`; `simulator.use` | all |
| Simulator, SimulatorDialogs | `/developers/simulator` (`?tab=act`) | `simulator.use` | create Sandbox customers, act on one with its rule shown when it can't run, results inline, recent actions, test values, reset with step-up |
| GoToProduction | `/settings/go-live` | any member (the form needs `golive.edit`) | not started, started, in review, changes requested, approved ("Approved"), declined ("Not approved"), paused ("Production access paused"), role-limited, "only a Super admin can send it" |
| GoToProductionForm | `/settings/go-live?page=<key>` | `golive.edit` | every section page, the company code (sent, wrong, expired, checked), add a person (and the link shown once), add a company, read-only sent sections, changes-requested sections, agreement with step-up |
| Webhooks, WebhookAdd, WebhookEndpoint, WebhookActions | `/developers/webhooks`, `/developers/webhooks/{id}` | `webhooks.read` | list with the failing InlineAlert, add with the challenge, deliveries, roll secret (shown once, intent), URL change (intent), pause and resume, delete, Fin's test endpoint |
| Events | `/developers/events` | `webhooks.read` | list, drawer, redeliver |

The **unlocked Production** state (EnvironmentSwitch on Production, no Sandbox strip, Production cues in
confirms) is drawn by L-SUN-11 on Sunday; until then it is a pending composition. The Overview's "Start
again" card shows "Starting again needs Fin's agreement." with no button when the rejection is final.

### 13.3 Fin Admin (L-SUN-08)

Inside AdminFrame, with Saturday's StepUp. The six lists share one layout (views, search where named,
filters, results line with sort and "Copy link", table, side panel, paging); saved views are stretch 4,
the built-in views are must-have. Decision buttons are drawn for every role, disabled with the reason
when the role lacks the permission, and the server refuses either way ([SA-16]).

| Board | Route | Needs | Must-have on Sunday |
|---|---|---|---|
| AdminGoLive | `/go-live` (views "All", "Waiting on Fin" (the landing), "Changes requested") | `golive.read` | list, panel, filters, empty |
| AdminGoLiveRequest | `/go-live/{id}` (tabs Company, Business, Compliance, People, Agreement, History) | `golive.read` | sections, the "Staff only" company verification card, the Decision card (waiting for people, ready, decided), approve, request changes, decline with reasons and intent, the second-approver state (pending composition) |
| AdminApprovals | `/approvals` (views "All", "Waiting longest") | `customers.read` | list, approve, reject, refused, empty |
| AdminCustomers, AdminCustomer | `/customers`, `/customers/{id}` (tabs Overview, Details, Documents, Requests, People, Activity) | `customers.read` | list, ID search, panel, detail tabs, "Show details" with step-up and the budget, the open flags as an InlineAlert (pending composition) |
| AdminCustomerDecide, AdminCustomerRequest | dialogs | `customers.decide`; `rfis.manage` | approve, unapprove, reject (with "final" or "may start again"), allow one restart, ask for information, accept, ask for more, change, cancel |
| AdminDocument | viewer dialog | `documents.view` | image, zoom, PDF (opens in a new tab, SD3-17), failed, step-up, budget reached |
| AdminOrganisations, AdminOrganisation | `/organisations`, `/organisations/{id}` | `organisations.read` | Production status, pause and restore with an intent and the second approver, the approval switch |
| AdminRfis | `/rfis` (views "All", "Overdue", "Answered, to review") | `rfis.read` | list, overdue, panel |
| AdminForms, AdminForm | `/forms`, `/forms/{id}`, `/forms/new` | read: every role; edit: `forms.manage` | list, edit, preview, publish, archive; system forms read-only |
| AdminReasons | `/reasons` (`?tab=templates`) | read: every role; edit: `reasons.manage`, `templates.manage` | reasons per action, templates, read-only for non-Admins |

### 13.4 Verify and selfie (L-SUN-06)

Built on `@fin/ui`'s AuthLayout card, white-labelled with the developer organisation's name and
"Secured by Fin"; a Sandbox band ("Sandbox: nothing here is really checked.") on Sandbox links; no
provider named. The boards are KY-09's (drawn on Saturday evening); until they land, pending
compositions ([UI-03]).

| Path | Page | Must-have states |
|---|---|---|
| `/c`, `/p`, `/a` (with the fragment) | landing: the exchange, then the first step | opening, expired or replaced (`/expired`), unavailable, error |
| `/c/start` | consent (two boxes; version `END_CUSTOMER_CONSENT_VERSION`) | default, refused |
| `/c/details/:page` (`about`, `contact`, `address`, `tax`, `work`, `money`) | one page of fields, saved on Next | default, saving, field errors, save failed, refilled or masked |
| `/c/documents/photo-id`, `/c/documents/proof-of-address` | pick a type and side, preview, upload | uploading, refused with the reason, warning with "Use it anyway", too big, wrong type, failed |
| `/c/company/:page`, `/c/company/documents`, `/c/people`, `/c/people/:id` | the business steps and its people (add, roles, share, the link sent) | each, plus the people states "Link sent", "In review", "Verified", "Not verified" |
| `/c/review`, `/c/done` | what is missing, then submit | missing, submitting, Sumsub unavailable (503), done |
| `/c/handoff` | on a computer: "Email the link to me", then "Received from your phone" | sent, limit reached, received |
| `/c/request`, `/c/request/:item` | what Fin asked; a form; the note and extra documents | each form state (`todo`, `progress`, `sent`, `accepted`, `again`), sent |
| `/c/selfie` | before the selfie host; Sandbox "Use a test selfie" | start, opening, Sandbox |
| `/p/...` | a person's own pages (§5.4) and, for a go-live person, the selfie | as above |
| `/a/...` | as `/c`, with "You're filling this in for {customer}" and no selfie | assisted |
| `selfie.<zone>/s` | the WebSDK | loading, running, couldn't open, done (returns to verify) |

FW-S3 measures verify's first load on Sunday morning before L-SUN-06 builds on it; the budget is
[FW-04]'s (150 KB gzip of JavaScript on the landing route, p75 LCP 2.5 s). The UI SDK's sign-in set
with React leaves about 25 KB for Fin's code on that route (research note D3 §10), so the landing
route loads no Select, Combobox, Drawer or DateRangePicker and splits every later step by route.

### 13.5 Pending compositions and UI requests raised on Sunday

The hosted verify pages (until KY-09's boards land); the unlocked Production state; the
second-approver states on AdminGoLiveRequest and AdminOrganisation; "Allow one restart" and the final
or restartable choice on Reject; the flags InlineAlert and (stretch) the Signals list; the held Sandbox
email notice; the `person_rejected` status line. Each is built from `@fin/ui` primitives and tokens
only, marked pending in the state manifest, and listed as a UI request, and the design lane draws its
board the same day (L-SUN-11).

## 14. Going to Production, end to end

1. Any member opens Go to Production and sees the status banner. A member with `golive.edit` starts
   the request (`go_live.started`) and fills each page; each page saves when they move on
   (`go_live.answers_saved` with the page key). Answers are sealed per page in Fin.
2. **Company email:** "Check email" sends a 6-digit code to the typed company address
   (`golive.company_email_code`, from the `auth.` subdomain, a code template); it lives 10 minutes and
   allows 5 tries; a new code ends the old one; "Code from the email" checks it
   (`go_live.company_email_checked`). The address is kept as a hash and a mask.
3. **People:** "Add a person" (intent) adds a live person with the go-live fields and emails their own
   `/p#` link (`golive.person_link`, from the `notify.` subdomain), valid 7 days; the link is also shown
   once to copy. The person fills their pages and takes the selfie in the WebSDK on the selfie host
   (level `developer_party`); the person moves to `in_review`, and Sumsub's review moves them to
   `approved` or `rejected`. Owner companies are added with name, country, registration number and
   share (stretch 1 sends them to Sumsub as company beneficiaries).
4. **Send:** when every page is done, the company email checked and at least one person added, a Super
   admin ticks "I accept the terms" and "I confirm the information we've given is true and complete" and
   presses "Send for review" (intent bound to the request ID and the terms version). The request moves
   to `in_review`; the organisation's live status to `in_review`; `go_live.terms_accepted` and
   `go_live.submitted` are written; an `ops.job kyc.golive_push` is queued.
5. **The push** (worker): ensure the `developer` company applicant `glr_<id>`, put `companyInfo` with
   `postalAddress`, put the two metadata fields, link each person as a beneficiary with their types and
   metadata, then request the review; Developer Verification answers 409, so `provider_status` becomes
   `sent` ([KY-05]). The poll reads the company applicant every 15 minutes.
6. **Staff review** in Fin Admin: Approve stays unavailable, with the names of the people still
   verifying, until every person is `approved` (409 `people_unverified`). Approve, Request changes and
   Decline each take a reason and an intent; Request changes names sections and a message; Decline's
   message is optional. When a second approver is required, the first approval leaves the request
   `in_review` with a pending approval, and a different staff member completes it.
7. **Approved:** the request and the organisation's live status become `approved` in one transaction
   (`staff.go_live_approved`, with the org-scope mirror `organization.live_status_changed`). Every Super
   admin is emailed (`golive.decided`, security, never dropped). `fin_live_` keys work on the next
   request; Production keys can be made.
8. **Changes requested:** the developer may change only the named sections and the agreement, then send
   again ("Send again"). **Declined:** the request is final, its message is shown and emailed, and no new
   request can start (SD3-30).
9. **Pause and restore:** a staff member with `organisations.pause` pauses Production access (intent;
   live keys answer 403 `live_paused` at once; Super admins emailed). Restoring takes an intent and,
   once required, a second approver; it emails the Super admins again.

## 15. Fin Admin review rules

### 15.1 The reason dialog

Every staff decision (customer approve, unapprove, reject, allow restart; RFI open, accept, ask for
more, withdraw, change; go-live approve, request changes, decline; pause, restore; approvals on and off;
show details) shows the action's preset reasons, most used in the last 90 days first, the first marked
"Used most", at most four then "Show {n} more", and "Other" last, which makes the note required. The
note (optional otherwise, at most 2,000) is sealed in `kyc.staff_note`; the audit row keeps the reason
code, its wording at the time, the template used and the note's ID. A missing reason is 400
`reason_required`; "Other" without a note is 400 `note_required`. Messages to a customer or a developer
can start from a template; they are shown as written, apart from Fin's words, and escaped in emails.

### 15.2 "Fin approves each customer"

Per organisation (`kyc.organization_setting`), changed with `organisations.approvals`, an intent and a
reason; never shown to the developer. On: a live GREEN, or the Sandbox default outcome, leaves the
customer `in_review` with `fin_review`, and it waits in Customer approvals until staff approve or
reject. Turning it off approves nobody who is already waiting.

### 15.3 Reveal budgets ([SA-39])

Reveals ("Show details") and document views are counted together per staff member, each at its gated
POST (`POST /api/customers/:id/reveal`, `POST /api/documents/:id/view`; never at a GET, §12): 30 an
hour and 150 a day to start, set by `FIN_STAFF_REVEAL_BUDGET_HOUR` and `FIN_STAFF_REVEAL_BUDGET_DAY` on `api`
(SD3-32). Past either, the door answers 429 `reveal_budget_reached`, writes
`staff.reveal_budget_reached` (staff scope, actor `system`), alerts `reveal-budget-reached` (N) and
emails every Admin (`staff-kyc/reveal-budget`). The count lives in a logged `ops` window, so a restart keeps
it.

### 15.4 Flags

`kyc.flag` rows are raised by the paths in §7 and shown on Fin Admin's customer page as an InlineAlert
with the kind and the time; "Resolve" (`customers.decide`, a reason) closes one. The Signals list
(`/signals`, stretch 2, L-SUN-12) lists open flags across organisations with filters by kind.

## 16. Audit events (R9)

### 16.1 Rules

- Every name below goes into an `AUDIT_EVENTS` fragment with its category and scope, and
  `recordAudit()` accepts only those names (ARCHITECTURE §8.2). Fragments: `packages/audit/src/events/customers.ts`,
  `going-live.ts` and `staff-kyc.ts` (L-SUN-02), `staff-settings.ts` (L-SUN-08); the webhook events
  are Spec 05 §5.7's `webhooks.ts` (L-SUN-04). The names are spec 08 §3.4's (events) and §4.4's
  (templates), the canonical lists (spec 08 D08-33); this section and §17 use them.
- Each event is written in the same transaction as the change, through `audit.record()`, whose
  per-role allowlist lets `fin_api` record the customer, going-live and staff decision events;
  `fin_worker` the `provider` and `system` ones; `fin_admin` only `staff-settings.ts`'s.
- **Actor** `{ kind, id }` with `via` (ARCHITECTURE §8.2): `user` (console) with `via: "console"`, or `via:
  "hosted_pages"` and `link_id` on an assisted link; `api_key` with `via: "api"`, the key ID and the
  mode; `customer_link` and `person_link` with the link ID and the link session ID; `staff` with `via:
  "admin"`; `system` with `via: "job"`; `provider` with `via: "webhook"` or `"job"` (the poll). A
  stepped-up action adds the factor method and the intent or proof ID.
- **Metadata** is flat: IDs, statuses, codes, field and page names, counts, versions, the reason code
  and wording, a template ID, a note's ID, the idempotency key's hash. Never a value a person typed, a
  name, an address, a message, a note, a link, a token or a URL.
- **Mirrors** (SD3-11): a staff decision the organisation can see writes its staff-scope event and one
  organisation-scope event with actor `system`, `via: "admin"`, and no staff ID.
- Each event has a test that fails when it is not written (AC-SUN-10).

### 16.2 Organisation scope: customers (category `customers`)

| Event | Actors | Target | Metadata |
|---|---|---|---|
| `customer.created` | `api_key`, `user` | customer | `type`, `created_via`, `test_data`, `fields[]` |
| `customer.updated` | `api_key`, `user` | customer | `fields_changed[]` |
| `customer.details_entered` | `customer_link`, `user` (assisted) | customer | `page`, `fields[]` |
| `customer.consent_given` | `customer_link`, `user` (assisted) | customer | `consent_version` |
| `customer.link_created`, `customer.assisted_link_created` | `api_key`, `user` | link | `kind`, `customer_id`, `rfi_id`, `expires_at` |
| `customer.link_opened` | `customer_link` | link | `link_session_id`, `first_open` |
| `customer.link_emailed` | `customer_link` | customer | `template` |
| `customer.details_shown` | `user` | customer | `fields_count` |
| `customer.submitted` | `api_key`, `user` (Sandbox), `customer_link` | customer | `attempt` |
| `customer.status_changed` | `provider`, `system` | customer | `from`, `to`, `reason` (public), `next_actor`, `source` (`provider`, `sandbox`, `fin`) |
| `customer.document_added` | `api_key`, `customer_link`, `person_link`, `user` | document | `type`, `side`, `uploaded_via`, `byte_size` |
| `customer.document_status_changed` | `provider` | document | `from`, `to`, `reason` |
| `customer.person_added`, `customer.person_updated`, `customer.person_removed` | `api_key`, `customer_link` | person | `roles[]`, `fields_changed[]` |
| `customer.person_link_created` | `api_key`, `customer_link` | link | `person_id` |
| `person.details_entered`, `person.submitted`, `person.link_opened` | `person_link`, `api_key` | person | `page` |
| `person.status_changed` | `provider`, `system` | person | `from`, `to`, `reason` |
| `customer.rfi_opened` | `system` (via admin, or the Sandbox), `user`, `api_key` (Sandbox) | RFI | `form_ids[]`, `due_at` |
| `customer.rfi_draft_saved`, `customer.rfi_form_sent`, `customer.rfi_note_added`, `customer.rfi_documents_added` | `customer_link` | RFI | `item_id`, `documents_count` |
| `customer.rfi_answered` | `api_key`, `customer_link` | RFI | `items[]` |
| `customer.rfi_accepted`, `customer.rfi_more_needed`, `customer.rfi_changed`, `customer.rfi_cancelled` | `system` (via admin, or the Sandbox) | RFI | `item_ids[]`, `due_at` |
| `customer.rfi_expired` | `system` | RFI | `due_at` |
| `customer.selfie_started`, `customer.selfie_completed` | `customer_link`, `person_link`; `provider` for the result | document | `ticket_id`, `answer` |
| `customer.test_data_created` | `user`, `api_key` | organisation | `count`, `outcome`, `type` |
| `customer.sandbox_action` | `user`, `api_key` | customer | `action`, `from`, `to` |
| `customer.restarted` | `api_key`, `user` | customer | `attempt`, `link_id` |
| `customer.deleted` | `api_key`, `user`, `system` (purge, reset) | customer | `erasure_request_id` |
| `customer.erased` | `provider` | customer | `erasure_request_id` |
| `customer.sandbox_reset` | `user`, `api_key` | organisation | `customers_deleted`, `events_deleted`, `deliveries_deleted` |

### 16.3 Organisation scope: going to Production (category `going_live`)

| Event | Actors | Metadata |
|---|---|---|
| `go_live.started` | `user` | `request_id` |
| `go_live.answers_saved` | `user` | `page`, `fields[]` |
| `go_live.company_email_code_sent`, `go_live.company_email_checked` | `user` | `attempt` |
| `go_live.person_added`, `go_live.person_removed`, `go_live.person_link_created` | `user` | `person_id`, `roles[]` |
| `go_live.company_added`, `go_live.company_removed` | `user` | `company_id` |
| `go_live.terms_accepted` | `user` | `terms_version` |
| `go_live.submitted` | `user` | `send_count` |
| `go_live.person_status_changed` | `provider` | `person_id`, `from`, `to` |
| `go_live.provider_status_changed` | `provider`, `system` | `from`, `to` |
| `organization.live_status_changed` | `system` (via admin) | `from`, `to` |

### 16.4 Staff scope (category `staff`)

| Event | Actors | Metadata |
|---|---|---|
| `staff.customer_approved`, `staff.customer_unapproved`, `staff.customer_rejected` | `staff` | `customer_id`, `organization_id`, `from`, `to`, `rejection_kind`, `reason_code`, `reason_wording`, `note_id`, `rfi_closed_id` |
| `staff.customer_restart_allowed` | `staff` | `customer_id`, reason fields |
| `staff.customer_details_shown` | `staff` | `customer_id`, `labels_shown`, reason fields, `budget_used` |
| `staff.document_viewed` | `staff` | `document_id`, `customer_id`, `view_id`, `delivery`, `budget_used` |
| `staff.rfi_created`, `staff.rfi_accepted`, `staff.rfi_more_needed`, `staff.rfi_withdrawn`, `staff.rfi_changed` | `staff` | `rfi_id`, `form_ids[]`, `item_ids[]`, `source`, `template_id`, reason fields |
| `staff.form_created`, `staff.form_updated`, `staff.form_published`, `staff.form_archived` | `staff` | `form_id`, `version` |
| `staff.fin_approval_enabled`, `staff.fin_approval_disabled` | `staff` | `organization_id`, reason fields |
| `staff.go_live_first_approval`, `staff.go_live_approved`, `staff.go_live_changes_requested`, `staff.go_live_declined` | `staff` | `request_id`, `pending_approval_id`, `sections[]`, `template_id`, reason fields |
| `staff.organization_paused`, `staff.organization_restore_requested`, `staff.organization_restored` | `staff` | `organization_id`, `pending_approval_id`, reason fields |
| `staff.approval_cancelled`, `staff.approval_expired` | `staff`; `system` | `pending_approval_id` |
| `staff.flag_resolved` | `staff` | `flag_id`, `kind`, reason fields |
| `staff.reveal_budget_reached` | `system` | `staff_id`, `window` (`hour`, `day`) |
| `system.kyc_write_refused`, `system.kyc_unknown_applicant` | `system` | `applicant_ref`, `operation`, `status`, `code` |
| `staff.reason_preset_added`, `staff.reason_preset_renamed`, `staff.reason_preset_moved`, `staff.reason_preset_retired`, `staff.reason_preset_restored` | `staff` | `reason_id`, `action`, `code` |
| `staff.message_template_added`, `staff.message_template_changed`, `staff.message_template_retired`, `staff.message_template_restored` | `staff` | `template_id`, `audience` |
| `staff.saved_view_created`, `staff.saved_view_deleted` (stretch 4) | `staff` | `view_id`, `list` |

### 16.5 Webhooks

The webhook events are Spec 05 §5.7's; the console's routes in §12.1 name them.

## 17. Emails (R3)

### 17.1 Templates

Every email is queued with `email.enqueue()` in the action's transaction and sent only by `worker`
(ARCHITECTURE §9.4). Templates live in `packages/email/src/templates/{kyc,golive,staff-kyc}/` (owned as §20.1
says), are lean, in Fin's words, with typed values only in labelled boxes and never in a subject,
heading or preview. Templates that carry a link token or a code are marked `secret_bearing`, so their
row is deleted on send and left out of dumps.

| Template | Sending subdomain | To | When | Limit per recipient |
|---|---|---|---|---|
| `kyc/verification-link` (secret) | `notify.` | the customer's address on record (the worker reads it: Sumsub in live, sealed in Sandbox) | "Email the link to me" | 3 an hour, 12 a day |
| `kyc/person-link` (secret) | `notify.` | a business's person, at the address typed | added on the business pages, or "Send a new link" | 3 an hour, 12 a day |
| `kyc/rfi-opened` (stretch 6, [KY-08]) | `notify.` | a live customer | an RFI opens | 5 an hour, 12 a day |
| `kyc/rfi-changed`, `kyc/rfi-cancelled` | `notify.` | a live customer | Fin changes or withdraws an RFI | 5 an hour, 12 a day |
| `golive/company-email-code` (secret, code priority) | `auth.` | the typed company address | "Check email" | 5 an hour |
| `golive/person-link` (secret) | `notify.` | a go-live person, at the address typed | added, or a new link | 3 an hour, 12 a day |
| `golive/decided` (security) | `auth.` | every Super admin of the organisation | approved, changes requested, declined | never dropped ([SA-41]) |
| `golive/paused`, `golive/restored` (security) | `auth.` | every Super admin | pause, restore | never dropped |
| `staff-kyc/reveal-budget` (security) | `auth.` | every Admin | a budget reached | never dropped |

The webhook templates (`endpoint-changed`, `endpoint-paused`) are Spec 05 §5.7's. The customer is
never emailed an approval or a rejection: the product is white-labelled and the
developer tells them.

### 17.2 The Sandbox rule ([SA-40])

In Sandbox, `kycMail.enqueue()` (`packages/kyc/src/mail.ts`) sends a customer or person email only
when the recipient's limit-key hash matches a confirmed address of a member of the organisation
(`identity.v_member_confirmed_email_hashes`). Otherwise it inserts a `kyc.held_email` row (template,
subject, masked recipient) and sends nothing; the console shows it on the customer's Activity tab and
as a notice ("Held in Sandbox: an email to a•••@example.com wasn't sent, because Sandbox emails go only
to your team."). Each organisation and each new account has a daily mail budget, tighter before going
to Production, with the security-notice share kept.

## 18. Monitoring (R5)

### 18.1 Lines

Beside the standard `request`, `job.run` and `provider.call` lines (ARCHITECTURE §10.2), every one of these is in
an `ops/monitoring/catalog/<area>.ts` fragment with its kind and its alerts or a written reason for
none.

| Line | Kind | Written by | Fields beyond the common ones |
|---|---|---|---|
| `kyc.inbound_received` | unit | `api` hook door | `type`, `alg`, `outcome` (`stored`, `duplicate`) |
| `sumsub.webhook_refused` | failure | `api` | `reason` (`digest`, `alg`, `size`, `json`) |
| `sumsub.webhook_unconfigured` | failure | `api` | |
| `kyc.unknown_applicant` | failure | worker | `subjectKind` |
| `kyc.write_refused` | failure | worker, `api` | `operation`, `status`, `code` |
| `kyc.read_back_invalid` | failure | `api`, worker | `fieldsCount` |
| `kyc.review_stale` | failure | worker | `subjectKind`, `ageBucket` |
| `kyc.workflow_failed` | failure | worker | |
| `kyc.pd_read` | security | `api` | `reader` (`console`, `admin`, `verify`, `worker`), `orgId`, `mode`, `fieldsCount` |
| `kyc.transition_refused` | info | `api` | `entity`, `from`, `event` |
| `verify.link_refused` | security | `api` | `reason` (`unknown`, `expired`, `revoked`; logged only, never answered) |
| `selfie.sdk_failed` | failure | `verify` (from the browser's report, scrubbed) | `code` |
| `staff.reveal_budget_reached` | security | `api` | `staffId`, `window` |
| `golive.submitted`, `golive.decided` | info | `api` | `requestId`, `decision`, `waitedS` |
| `kyc.held_email` | info | `api` | `template` |

Never in a line: a name, an address, a value, a token (the fragment never reaches a server anyway), a
query string or a raw path. Verify's request lines carry the route template.

### 18.2 Alerts

Thresholds are in the private overlay ([OB-13]); staging is email only, production as marked. Each alert
carries `incident_cause`, `metadata.check`, `metadata.flow` and `metadata.runbook`, and the runbook
file must exist (ARCHITECTURE §10.8). Alert files: `ops/monitoring/<env>/alerts/{kyc,sumsub,verify,golive,admin_kyc}.json`. The webhook
alerts are Spec 05 §10.2's; origin-gate refusals are spec 01's `request` lines.

| Alert | Severity | Fires when | First check | Runbook |
|---|---|---|---|---|
| `sumsub-failing` | P | Sumsub calls fail (5xx, timeouts, network) above the threshold, or any 401 or 403 | Sumsub's status; the token's expiry; the IP allowlist against the static egress | `docs/runbooks/sumsub-failing.md` |
| `sumsub-rate-limited` | N | 429s from Sumsub | which token; the bad-response count | `sumsub-failing.md` |
| `sumsub-webhook-refused` | P | any digest refusal | the webhook secret's rotation state; the algorithm | `sumsub-webhook-refused.md` |
| `kyc-inbound-backlog` | N | the oldest unprocessed inbound event is older than the threshold | the worker's `kyc-inbound` loop; Sumsub reads | `kyc-inbound-backlog.md` |
| `applicant-write-backlog` | N, P past an hour | the oldest transit-queue row's age | Sumsub's write calls; the `sumsub_writes` switch | `applicant-write-backlog.md` |
| `sumsub-poll-stalled` | N | no `kyc-poll` success for three minutes | the worker's scheduler lease | `sumsub-poll-stalled.md` |
| `kyc-review-stale` | N | a review pending at Sumsub past 72 hours | Sumsub's dashboard for that applicant | `kyc-review-stale.md` |
| `go-live-queue-age` | N | a Production request `in_review` past the threshold | Fin Admin's queue; people still verifying | `go-live-queue-age.md` |
| `documents-failing` | N | the document viewer's Sumsub fetches fail | the documents token | `documents-failing.md` |
| `erasure-failing` | P | an erasure request or a deactivation stays failed | Sumsub's deactivation call | `erasure-failing.md` |
| `kyc-unknown-applicant`, `kyc-write-refused` | N | any | the flag in Fin Admin | `kyc-flags.md` |
| `selfie-failing` | N, above a volume | `selfie.sdk_failed` reports | the WebSDK's allowed origins; SP-11's hosts in `_headers` | `selfie-failing.md` |
| `verify-link-flood` | N | link-open refusals per address above the threshold | the WAF rate rule; the addresses | `verify-link-flood.md` |
| `5xx-rate-verify` | P | verify's 5xx ratio (ARCHITECTURE §10.8 group B) | the `api` door's health | `5xx-rate.md` |
| `reveal-budget-reached` | N | any | who and why, in the staff audit log | `reveal-budget-reached.md` |
| `duty-stalled-sumsub-inbound`, `-applicant-writes`, `-sumsub-poll`, `-sandbox`, `-golive-push`, `-deactivations` | N | no `job.run result=ok` for three cadences | the worker's lease and logs | `duty-stalled.md` |

### 18.3 Dashboard panels

On "Fin Services": Sumsub calls, failures and p95 by operation; inbound events received, refused,
backlog and age; the transit queue's depth and oldest row; poll lag; reviews pending by age; the
Production request queue; verify's requests and 5xx by route; link opens and refusals; selfie sessions
started, completed and failed; reveals and document views (counts only); held Sandbox emails. The webhook panels are
Spec 05 §10.4's.

### 18.4 The front door and the kill switches

The verify and selfie hosts are covered by the watcher's checks (ARCHITECTURE §5.9) and Logpush's redaction of every
path on those hosts (ARCHITECTURE §5.9; with fragments there is nothing to redact, but the rule stays). The `verify`
monitor (ARCHITECTURE §10.6) calls `https://verify.<zone>/api/health`. The `hosted_verify` switch makes every verify
door answer 503 `temporarily_unavailable` (the page shows "This page isn't available right now. Try
again later."); `sumsub_writes` pauses the transit queue and refuses submit and uploads (§7.4). Each has
a test that it stops what it names and nothing else.

## 19. Tests

Labels as EXECUTION: `[U]`, `[I]` (real Postgres 18), `[C]`, `[E2E]`, `[STG]`.

### 19.1 Unit and integration

| File | Proves |
|---|---|
| `packages/kyc/src/machines/*.test.ts` [U] | every machine refuses every pair not in its table; the tables equal §3 (AC-SUN-04) |
| `packages/kyc/src/machines/coupling.test.ts` [I] | each rule of §3.9, including the business re-evaluation and the closed RFI |
| `packages/contract/src/fields/*.test.ts` [U] | each rule of §5.7; the same verdicts in a browser build |
| `packages/kyc/src/fields/reverse-coverage.test.ts` [U] | every field has a Sumsub home, is Sandbox-only, or is dropped (AC-SUN-08) |
| `packages/kyc/src/providers/sumsub/levels-coverage.test.ts` [U] | Fin collects every required input of every level |
| `packages/kyc/src/providers/sumsub/signing.test.ts` [U] | the request signature on fixed vectors; level-name encoding; the strict `externalUserId` parser |
| `packages/kyc/src/conformance/*.test.ts` [C] | both providers pass the suite (AC-SUN-05) |
| `apps/api/test/hooks/sumsub.test.ts` [I] | a wrong digest, SHA-1 (by default), an unknown algorithm and a 65 KB body are refused and logged; a valid event is stored and answered within a second; a replay is stored once (AC-SUN-06) |
| `apps/api/test/worker/kyc-inbound.test.ts` [I] | every type of §7.2; a review is re-read, never taken from the payload; applying twice gives one status change, one audit row and one developer event |
| `apps/api/test/worker/kyc-poll.test.ts` [I] | the poll applies a review that no webhook announced, on the backoff schedule |
| `apps/api/test/worker/applicant-writes.test.ts` [I] | order per applicant; retry on 5xx; purge and flag on 4xx; submit's flush and its 503; the `sumsub_writes` switch |
| `apps/api/test/kyc/links.test.ts` [I] | unknown, expired and revoked tokens get one answer; the 24-hour shortening; a new link revokes the old one and ends its sessions; an RFI-scoped link opens only its request; a person link only its person |
| `apps/api/test/kyc/refill.test.ts` [I] | a second browser on the same link sees masks; an assisted session never sees the customer's values |
| `apps/api/test/kyc/restart.test.ts` [I] | final rejections refuse restart through the API and the console; Sandbox rejections allow 3 in 24 hours; "Allow one restart" allows exactly one; new attempts get new external IDs and the old applicants are queued for deactivation (AC-SUN-11) |
| `apps/api/test/kyc/golive.test.ts` [I] | the send rules; `people_unverified`; the second approver (two staff holding the permission, a different approver, expiry, cancel); unlocking sets the live status in the same transaction; pause refuses live keys at once |
| `apps/api/test/kyc/budgets.test.ts` [I] | the reveal budget, spent only at the two POSTs; a restart keeps the count |
| `apps/api/test/kyc/document-views.test.ts` [I] | a view is redeemed once; an expired view, another staff member's and another session's get the same 404; the redeem writes no audit row and spends no budget; `staff.document_viewed` is written at the POST, in the transaction that inserts the view |
| `apps/admin/src/server/policy.test.ts` [U] (generated from the route policy) | no GET declares `audit`, an intent or a budget; `GET /api/document-views/:viewId` declares `fetchSite` and refuses `same-site`, `cross-site` and a missing `Sec-Fetch-Site` with 403 `invalid_origin` (§12) |
| `apps/api/test/kyc/idor.test.ts` [I] (generated) | one test per route, per door operation and per mode: another organisation's or the other mode's customer, person, document, RFI, link, request or endpoint is 404 (AC-SUN-07) |
| `apps/api/test/kyc/personal-data.test.ts` [I] | no live row holds details (the CHECK); no line, event, audit row or problem document carries a value, name, address or token (scanned with the scrubbers' shapes) |
| `apps/api/test/audit/kyc-events.test.ts` [I] | one test per event of §16 that fails when the write is removed; mirrors carry no staff ID; the guard refuses each table of §4.7 without an audit row (AC-SUN-10) |
| `packages/db/test/grants/kyc.test.ts` [I] | every forbidden statement for every role fails with 42501 |
| Spec 05 §13's webhook tests (L-SUN-04) | AC-SUN-09; this spec adds only `apps/api/test/kyc/events.test.ts` [I]: each machine move emits the events of §9.4 with the right `subject_ids`, and none for a no-op |
| `apps/verify/src/server/*.test.ts` [I] | the origin gate's refusals on both hosts; the cookie lines; each host serves only its own routes; the rendered `hosted` and `selfie` profiles match the environment's hosts, and only `selfie` names a Sumsub host |
| `packages/kyc/src/mail.test.ts` [I] | the Sandbox rule holds mail for non-members; budgets; secret-bearing rows deleted on send (AC-SUN-20) |

### 19.2 Journeys (Playwright, against the `test` targets)

Run with the local static host from `packages/testing` (it serves `dist/` with each `_headers` file and
the single-page fallback, and proxies `/api/*` to the app's container), with stand-ins for Sumsub, its
WebSDK and email. Every page has the `securitypolicyviolation` listener. Failure states are reached with
`page.route` on named JSON routes.

| Spec | Journey |
|---|---|
| `apps/verify/e2e/sun/individual.spec.ts` | a Sandbox individual made by API completes consent, details, both documents and submit with test values; the URL never holds the token after the first load; the developer's endpoint and Fin's test endpoint receive signed `customer.*` webhooks (AC-SUN-12) |
| `apps/verify/e2e/sun/business.spec.ts` | a business with two people completes its steps and each person's link (AC-SUN-13) |
| `apps/verify/e2e/sun/selfie.spec.ts` | the selfie host loads the WebSDK stand-in under its exact-host exception, receives no link token or cookie; a ticket works once; a live customer's RFI selfie returns to verify (AC-SUN-13) |
| `apps/verify/e2e/sun/rfi-form.spec.ts` | an RFI's forms, a draft shown back only in the same browser, the note and extra documents |
| `apps/verify/e2e/sun/link-states.spec.ts` | expired, replaced, unavailable (503), error, the `hosted_verify` switch |
| `apps/verify/e2e/sun/handoff.spec.ts` | "Email the link to me" (from the sink) and "Received from your phone" |
| `apps/console/e2e/sun/customers.spec.ts` | list, search, filters, NewCustomer with Sandbox data, the link card, "Fill it in yourself" with an intent |
| `apps/console/e2e/sun/customer-page.spec.ts` | tabs; "Show details" with a window; delete and restart with intents; held Sandbox email shown |
| `apps/console/e2e/sun/simulator.spec.ts` | create Sandbox customers, each action and its refusal rule, reset with an intent |
| `apps/console/e2e/sun/go-to-production.spec.ts` | the wizard, the company code, people with a selfie, sent by a Super admin with an intent; an Admin cannot send; changes requested and sent again (AC-SUN-15) |
| `apps/console/e2e/sun/webhooks.spec.ts`, `events.spec.ts` | add with the challenge, roll the secret, change the URL with an intent, pause and resume, redeliver |
| `apps/admin/e2e/sun/production-access.spec.ts` | approve with an intent after the people verify; the second-approver path; Production unlocks and a Production key can be made (AC-SUN-15) |
| `apps/admin/e2e/sun/customer-review.spec.ts` | open an RFI, the developer answers, staff accept, approve with an intent; the timeline and the audit log show each step (AC-SUN-14) |
| `apps/admin/e2e/sun/reveal-and-documents.spec.ts` | "Show details" and the viewer ask for a factor, write an event per view, answer `no-store`, stop at the budget with a notice to the Admins; an image from a sibling host's page pointed at a view URL is refused and spends nothing (AC-SUN-16) |
| `apps/admin/e2e/sun/organisations.spec.ts`, `forms.spec.ts`, `reasons.spec.ts`, `approvals.spec.ts` | pause and restore; the approval switch; forms edit and publish; reasons read-only for non-Admins; a Viewer sees decisions disabled and the server refuses |

### 19.3 On staging

AC-SUN-17 to AC-SUN-19, and the release smoke adds: a Sandbox customer by API reaches `approved`; the
verify landing loads under its policy with no violation.

## 20. Build lanes

### 20.1 Lanes and the files they own

EXECUTION §4.2's lanes, with the ownership made exact. Paths are `tools/layout.json`'s; an area's lane
owns its fragments wherever they live (EXECUTION §1.3).

| Lane | Machine | Owns | Starts | Delivers |
|---|---|---|---|---|
| L-SUN-00 Spill | A and B | the paths of the Saturday lanes it finishes | 08:00 | Saturday's must-haves; API keys and the live-status check on key creation if they did not land |
| L-SUN-01 Edge and API platform | A | as Spec 05 §12 | 08:00 | the public API foundation; `POST /hooks/kyc/sumsub` forwarding the raw body with its 64 KB cap and per-address limit |
| L-SUN-02 KYC domain | B | `packages/kyc/**` except `src/providers/**`, `src/conformance/**`, `src/signals/**` and `scripts/**`; `packages/contract/src/fields/**`; `packages/db/migrations/*_kyc_*.sql`; `packages/db/src/schema/kyc/**`; `packages/db/roles/grants/{kyc,identity_kyc}.json`; `packages/audit/src/events/{customers,going-live,staff-kyc}.ts`; `packages/email/src/templates/{kyc,golive}/**`; `ops/monitoring/catalog/{kyc,golive}.ts`; `ops/monitoring/*/alerts/{kyc,golive}.json`; `packages/testing/src/canon/kyc.ts` (moved at 08:00) | 08:00 | §3, §4, §5, §8, §15's rules, §16's fragments, §17's templates; `packages/kyc/src/contracts/**` (statuses, door payload schemas) merged by 09:30 |
| L-SUN-03 Providers | A | `packages/kyc/src/{providers,conformance}/**`, `packages/kyc/scripts/**`, `apps/api/src/worker/kyc/**`, `apps/api/src/hooks/sumsub/**`, `packages/testing/src/stand-ins/sumsub/**` (moved at 08:00), `ops/monitoring/catalog/sumsub.ts`, `ops/monitoring/*/alerts/sumsub.json` | 08:00 | §6, §7; SP-11 with the owner; `levels.json` by 10:30 |
| L-SUN-04 Webhooks | B | as Spec 05 §12 | 08:00 | Spec 05 §5; the `webhooks.*` door operations the console calls |
| L-SUN-05 Onboarding API routes and doors | A | Spec 05 §12's L-SUN-05 paths (`apps/api/src/routes/{customers,people,documents,links,rfis,sandbox,events,webhook-endpoints}/**` and the contract fragments for `customers`, `documents`, `people`, `rfis`, `events`, `webhook-endpoints` and `sandbox`), plus `apps/api/src/doors/{kyc,golive,verify,admin_kyc}/**`, `packages/server/src/doors/{kyc,golive,verify,admin_kyc}.ts` and `apps/api/test/kyc/**` | 11:00 (door stubs from 09:30) | §9, §11 |
| L-SUN-06 Verify | B | `apps/verify/**` (both entries, the API half, `e2e/sun/`), `packages/app-contracts/src/verify/**`, `ops/monitoring/catalog/verify.ts`, `ops/monitoring/*/alerts/verify.json` | 10:00 (after FW-S3, on KY-09's boards or pending compositions) | §2, §12.3, §13.4 |
| L-SUN-07 Console onboarding | A | `apps/console/src/client/routes/{customers,developers/simulator,developers/webhooks,developers/events,settings/go-live}/**`, `apps/console/src/server/routes/{customers,sandbox,golive,webhooks,events}/**`, `apps/console/src/server/policy/{customers,sandbox,golive,webhooks,events}.ts`, `packages/frame/src/nav/console/{customers,developers}.ts` (EXECUTION §1.3), `apps/console/e2e/sun/**`, `packages/app-contracts/src/console/{customers,sandbox,golive,webhooks,events}.ts` | 11:00 | §12.1, §13.2 |
| L-SUN-08 Fin Admin onboarding | B | `apps/admin/src/client/routes/{go-live,approvals,customers,documents,organisations,rfis,forms,reasons}/**`, `apps/admin/src/server/routes/{golive,approvals,customers,documents,organisations,rfis,forms,reasons,templates,history,flags}/**`, their `apps/admin/src/server/policy/` fragments and `packages/frame/src/nav/admin/` fragments (EXECUTION §1.3), `apps/admin/e2e/sun/**`, `packages/app-contracts/src/admin/{golive,approvals,customers,documents,organisations,rfis,forms,reasons}.ts`, `packages/db/migrations/*_admin_settings_*.sql`, `packages/db/src/schema/admin-settings.ts`, `packages/db/roles/grants/admin_settings.json`, `packages/audit/src/events/staff-settings.ts`, `packages/email/src/templates/staff-kyc/**`, `ops/monitoring/catalog/admin_kyc.ts`, `ops/monitoring/*/alerts/admin_kyc.json` | 11:00 | §12.2, §13.3, §15's screens; SP-27 |
| L-SUN-09 Docs site (stretch) | A | `apps/docs/**` | 14:00 | the reference with Try it; guides for customers, people, requests for information, going to Production, and Sandbox test values generated from §3.8's constants |
| L-SUN-10 Ops | B | `ops/fin/**`, the `ops/monitoring/**` index files, dashboards and monitors, the runbooks of §18.2 under `docs/runbooks/` | 08:00 | CR-13 set by `pnpm fin` once the watcher and the staging identity provider are live; the verify and selfie static deployments and their routes as spec 01 §7.4 and §7.5 build them; the `verify` monitor on `/api/health`; the alerts applied |
| L-SUN-11 Design | canvas | the canvases | 08:00 | unlocked Production; the verify boards if not done; the second-approver, restart and flag states |
| L-SUN-12 Ongoing signals (stretch) | B | `packages/kyc/src/signals/**`, `apps/admin/src/{client,server}/routes/signals/**` | 14:00 | the Signals list (stretch 2) |

### 20.2 Ownership moves at 08:00

Through the lane board, at the first merge point (EX-07): `packages/testing/src/canon/kyc.ts` to
L-SUN-02 and `packages/testing/src/stand-ins/sumsub/**` (the API stand-in and the WebSDK stand-in, both
in the `test` image target only) to L-SUN-03; the static host for journeys
(`packages/testing/src/static-host.ts`) stays with the steward, who adds it in the 08:00 spill block if
Saturday did not. The connector map's `^/api/` rows belong to the lane that owns `apps/connector` (spec 01). L-SUN-06
asks the owner of `packages/web-host/src/static/` for the `hosted` profile's `img-src 'self' blob:` at
08:00 and the `selfie` profile's Sumsub hosts after SP-11.

### 20.3 Order

```
08:00 L-SUN-02 migrations + contracts (09:30) ──► domain machines ──► go-live, reviews, budgets
08:00 L-SUN-03 SP-11 (with CR-13) ──► adapter + sandbox provider ──► conformance (13:00, CUT-03) ──► inbound + poll + queue
08:00 L-SUN-04 webhooks (pure) ─────────────────────────────────────────► events wired to the machines (14:00)
09:30 contracts ──► L-SUN-05 doors and /v4 routes (11:00) ──► OpenAPI fragments
10:00 FW-S3 result ──► L-SUN-06 verify (selfie needs the adapter and CR-13)
11:00 L-SUN-07 console and L-SUN-08 Fin Admin, on door stubs, then the real doors
18:00 go-live end to end green in e2e (CUT-04)          22:00 staging deploy, release smoke
```

Merges go in this order within each batch: migrations and grants, domain, providers, doors and
routes, screens.

### 20.4 Review gates (R10, R11)

Everything but client-only screen code is tier S. Each pull request needs a signed fin-review receipt
whose sessions ran a model and effort R11 and the floor allow ([RV-03], [RV-06]), with the attack pass
on every tier S file and Sunday's attack profiles (EXECUTION §1.7): cross-organisation and cross-mode
reads, a forged or replayed Sumsub webhook, link-token theft and reuse, personal data in logs, errors
or events, upload abuse, SSRF through webhook endpoints, Sandbox mail abuse, a staff decision without
permission, a final rejection restarted. Extra Sunday checks: the join check (each status move has
its audit event, developer event and email where due) and the door check (a lint rule refuses
importing `packages/kyc/src/providers/**` or `packages/crypto` outside `apps/api`; every new door
operation is in the matrix).

## 21. Acceptance criteria

EXECUTION's AC-SUN-01 to AC-SUN-21 apply as written; this spec's tests that prove them are in §19.
These add to them, numbered after EXECUTION's last (AC-SUN-22 onwards; to be copied into EXECUTION
§4.6 under the same numbers):

| ID | Statement |
|---|---|
| AC-SUN-22 [I] | Unknown, expired and revoked link tokens get the same answer in the same time; the first open shortens the link to 24 hours; a new link ends the old link's sessions; no line, event or problem document holds a token |
| AC-SUN-23 [I] | A business whose own review is GREEN waits at `in_review` (`people_pending`, shown as `checking`) until every person is approved; a person's rejection moves it to `action_required` with `person_rejected`; removing that person and the rest approving moves it on ([KY-11]) |
| AC-SUN-24 [I] | A staff approve, unapprove or reject withdraws the open RFI in the same transaction |
| AC-SUN-25 [I] | Approving a Production request is refused while any person is not approved; with two staff holding `golive.decide`, one approval leaves it in review and the same staff member cannot complete it; the second approval sets the request and the organisation's live status together, and a `fin_live_` key works on the next request |
| AC-SUN-26 [I] | Pausing makes live keys answer 403 `live_paused` on the next request; restoring needs the second approver when required |
| AC-SUN-27 [I] | A staff member's reveals and document views stop at the budget with 429, an event, an alert line and an email to every Admin; the count survives a restart |
| AC-SUN-28 [I] | With Sumsub failing, saves still queue; submit answers 503 `provider_unavailable` with `Retry-After` and moves nothing; a 4xx purges the row and raises `write_refused`; the `sumsub_writes` switch pauses the queue and nothing else |
| AC-SUN-29 [I] | A second browser on the same link sees masks for fields the first entered; an assisted session never sees the customer's values |
| AC-SUN-30 [E2E] | A selfie ticket is redeemed once; the selfie page holds only the SDK token; `selfie.done` trusts only Sumsub's read-back |
| AC-SUN-31 [I] | Re-applying an inbound event or a polled review changes nothing the second time: one status move, one audit row, one developer event |
| AC-SUN-32 [I] | A review that no webhook announces is applied by the poll on its backoff schedule |
| AC-SUN-33 [I] | Deleting a customer leaves a tombstone with no name, hash, mask or token, revokes its links, withdraws its RFIs, queues deactivation of every applicant, and emits `customer.deleted`; `applicantPersonalDataDeleted` sets `erased_at` |
| AC-SUN-34 [C] | The onboarding OpenAPI fragments pass `vacuum`, name no provider ([AP-14]), and match the served routes both ways |
| AC-SUN-35 [I] | Every door operation of §11 is in the matrix with its checks; `verify` cannot call a console or Fin Admin operation; a console-signed call for another organisation is refused |
| AC-SUN-36 [E2E] | A Viewer in Fin Admin sees every decision disabled with its reason, and each decision route refuses the Viewer on the server |
| AC-SUN-37 [U] | The rendered `hosted` and `selfie` profiles match the environment's hosts; only `selfie` names a Sumsub host; no built HTML of either entry holds an inline script or a `style` attribute |

## 22. Spikes and decisions needed on Sunday

**Spikes:**

- **SP-11 Sumsub** (Sunday from 08:00, L-SUN-03 with the owner, CR-13): per-service tokens with IP
  allowlists; digests over the raw bytes; the WebSDK's allowed origin (`https://selfie.<zone>`), its
  script path and every host it frames or calls; Developer Verification's 409; webhook-secret
  rotation; and, for this spec: the deactivation path; whether `/one` returns questionnaire answers;
  whether HEIC is accepted; the company document sets per type and the questionnaire item IDs (written
  to `levels.json`); whether the WebSDK builder injects `<style>` elements (if so, the selfie host
  alone takes FW-X7's style fallback).
- **FW-S3** (Sunday 08:00): verify's first load from the static deployment.
- **SP-27 (new here) Document viewing under Fin Admin's policy** (Sunday 11:00, L-SUN-08), on
  Chromium, Firefox and WebKit: a view minted by `POST /api/documents/:id/view` and shown in an `img`
  from its single-use `GET /api/document-views/:viewId` URL; a PDF from such a URL in a new tab with
  `Content-Disposition: inline`; no `blob:`; each engine fetches the URL once (if one fetches a PDF
  tab twice, §12.2 item 4 applies); the image and the tab carry `Sec-Fetch-Site: same-origin`, and a
  fetch of the URL from a sibling host is refused. If browsers refuse the PDF, the fallback is
  `delivery: "download"` (recorded in the audit metadata), for the owner to accept. A new tab is a
  new document, so Fin Admin's own page policy stays as it is (research note D3 §7.4).

**Owner decisions this spec builds on their defaults** (entries whose status in DECISIONS.md is
OWNER MUST DECIDE; deadline Sunday unless noted): [KY-05], [KY-06] and [KY-13] (08:00 Saturday),
[KY-07], [KY-11], [SA-39] (the budgets and the second approver), [AP-04], [AP-07], [AP-08] (keeping
Fin's own engine, a confirmation), [AP-16], [UI-08], [BC-04], [BC-07], [FW-02].

**Register entries this spec follows that are not for the owner** (Recommended, or already decided,
in DECISIONS.md): [KY-08], [KY-10], [KY-12], [SA-17], [SA-26], [SA-37], [SA-40], [DA-13], [AP-18].

**Content the owner provides** (none of it blocks the build; placeholders are marked draft and never
shipped to production): the end-customer consent and privacy notice text and
`END_CUSTOMER_CONSENT_VERSION`; the "Fin Developer Terms" and "Developer No-Nesting Terms" pages for
`DEVELOPER_TERMS_VERSION` `2026-11`; in Sumsub's dashboard, the webhook URL on `api.<zone>`, the
WebSDK's allowed origin, and the same levels as the staging set (CR-13).

**Before production** (EXECUTION §7.3): the production Sumsub app with the same levels and
questionnaires, its webhook, the WebSDK's allowed origin on the production selfie host and the
per-service tokens with IP allowlists ([KY-04]; PG-11); owner companies sent to Sumsub ([KY-06]);
erasure completed end to end, the Sandbox purge, counsel's retention answer, a consent step that names
each provider and the privacy notice (H-09, [DA-08]; PG-07); a forged Sumsub webhook refused in the
drills (PG-05); every verify, console and Fin Admin state of Sunday's boards covered (PG-03).

## Appendix A. Status words

**Customer** (label, tone, line):

| Status | Label | Tone | Line |
|---|---|---|---|
| `incomplete` | Incomplete | warn | "Details, documents or the selfie are missing." (console: "Waiting for the customer to finish." or "Send again: {reason}") |
| `in_review` | In review | info | "We're checking the details." |
| `action_required` | Needs information | warn | "Fin needs more information." |
| `approved` | Approved | ok | "Approved." (console: "Approved on {date}.") |
| `unapproved` | Unapproved | mute | "Fin is reviewing this customer again." |
| `rejected` | Rejected | err | "Fin couldn't approve this customer." |

**Retry reasons** (individual / business): `document_unreadable` "The photo of the ID wasn't clear." /
"A document wasn't clear."; `document_expired` "The ID has expired." / "A document has expired.";
`document_not_accepted` "That document can't be used." (both); `selfie_failed` "The selfie didn't
match the ID." / "A person's selfie didn't match their ID."; `details_mismatch` "The details don't
match the ID." / "The company's details don't match its documents." New: `person_rejected` "A person
on this business couldn't be verified."

**Person:** console "Not finished", "In review", "Verified", "Not verified"; Fin Admin "Not finished",
"In review", "Approved", "Rejected"; a go-live person on the console "Checking", "Verified", "Not
verified", "Link sent {date}", "Link expired".

**Document:** console "Sent", "Accepted", "Send again", "Not accepted"; Fin Admin adds "Rejected" and
"Replaced".

**RFI:** "Open", "Answered", "Accepted", "More needed", "Expired", "Cancelled" (for `withdrawn`), with a
red "Overdue". Item: "Not started", "In progress", "Sent", "Accepted", "More needed".

**Production request and live status:** request "Draft", "In review", "Changes requested", "Approved",
"Not approved". Live status on the console and Fin Admin: `sandbox` "Not started", (derived) "Started",
`in_review` "In review", `changes_requested` "Changes requested", `approved` "Approved", `declined` "Not
approved", `paused` "Production access paused".

**Who acts next** (Fin Admin): "Fin", "The customer", "The developer", "Nobody".

## Appendix B. Seeded reasons and templates (SD3-15)

Written by the `admin_settings` migration; Admins change them afterwards on Reasons. Each action also
offers `other` ("Other", a note required).

| Action | Reasons (code: wording) |
|---|---|
| `customer.approve` | `checks_passed`: Checks passed; `answer_settles_it`: The answer to the request settles it; `review_error_corrected`: An earlier review was wrong |
| `customer.unapprove` | `new_information`: New information needs a fresh look; `risk_changed`: The customer's risk changed; `provider_flag`: Sumsub flagged the customer again; `partner_request`: A partner asked for a review |
| `customer.reject` | `sanctions_match`: Confirmed sanctions match; `fraud_suspected`: Fraud suspected; `documents_altered`: Documents look forged or altered; `prohibited_activity`: A prohibited activity; `no_answer`: No answer to a request for information |
| `customer.allow_restart` | `correctable_mistake`: The customer made a mistake they can correct; `review_error`: The rejection was a review error |
| `customer.request_information` | `proof_of_address`: Proof of address needed; `source_of_funds`: Source of funds needed; `id_unclear`: The ID needs checking again; `ownership_unclear`: The ownership needs explaining; `partner_request`: A partner asked |
| `customer.show_details` | `deciding_review`: To decide a review; `checking_answer`: To check an answer to a request; `partner_request`: A partner asked; `investigation`: An investigation |
| `rfi.accept` | `answer_complete`: The answer is complete; `answer_sufficient`: Enough to decide |
| `rfi.ask_again` | `answer_incomplete`: Part of it is missing; `document_unclear`: A document isn't clear; `answer_inconsistent`: The answer doesn't match the record |
| `rfi.change` | `asked_wrong_thing`: Fin asked for the wrong thing; `more_time`: The customer needs more time |
| `rfi.withdraw` | `no_longer_needed`: No longer needed; `asked_in_error`: Asked in error; `answered_elsewhere`: Answered another way; `customer_closed`: The customer is closing |
| `golive.approve` | `answers_verified`: Answers checked and the people verified; `known_business`: A known, regulated business |
| `golive.request_changes` | `answers_incomplete`: Some answers are missing; `answers_inconsistent`: Some answers don't agree; `people_incomplete`: Someone who owns or runs it is missing |
| `golive.decline` | `prohibited_business`: A business Fin can't serve; `sanctions_exposure`: Sanctions exposure; `unable_to_verify`: Fin couldn't verify the company; `out_of_scope`: Outside what Fin offers |
| `organisation.pause` | `compliance_review`: A compliance review; `suspicious_activity`: Suspicious activity; `partner_request`: A partner asked; `developer_request`: The organisation asked |
| `organisation.restore` | `review_cleared`: The review cleared it; `issue_fixed`: The issue is fixed |
| `organisation.approvals_on` | `higher_risk`: A higher-risk organisation; `new_business_model`: A new or changed business model; `partner_request`: A partner asked |
| `organisation.approvals_off` | `risk_reduced`: The risk has come down; `review_complete`: The review is complete |
| `flag.resolve` | `checked_no_action`: Checked; nothing to do; `acted_on`: Acted on it |

Templates: three for `customer_rfi` ("Proof of address", "Source of funds", "A clearer ID"), two for
`developer_golive_changes` ("Missing answers", "People to add"), one for `developer_golive_decline`
("We can't offer Production access"), each a short message in Fin's words that staff can change before
sending. There is no "missing documents" reason or template: going to Production takes no documents
([KY-05]).

## Appendix C. Spec decisions for the register

| ID | Decision |
|---|---|
| SD3-01 | Verify and selfie are two static hosts served by one `verify` API half, which tells them apart by `Host` and serves each only its own routes (spec 01's static shape applied to verify) |
| SD3-02 | Link tokens travel only in the URL fragment (`https://verify.<zone>/c#<token>`, `/p#`, `/a#`); no `/test/` paths, the link record carries the mode; the page posts the token to `POST /api/link/open` and gets `__Host-fin-verify.ls`. Recorded in DECISIONS as [SA-37]'s default |
| SD3-03 | The selfie hand-off is a one-time `sft_` ticket in the selfie host's fragment (`https://selfie.<zone>/s#<sft id>.<secret>`), redeemed once at `POST /api/selfie/session` for the SDK token and the 15-minute `__Host-fin-selfie.s` cookie ([SA-26], [SA-37]) |
| SD3-04 | Verify's static policy has no nonce: `style-src 'self'` with the UI SDK's constructed style sheets; `img-src 'self' blob:` in the `hosted` profile only, for the local photo preview, listed in [SA-45]'s exceptions and the only `blob:` its policy test allows |
| SD3-05 | A business waiting for its people uses the internal reason `people_pending` (public `checking`); a rejected person gives the new public reason `person_rejected` |
| SD3-06 | A provider re-review with RED, or a person rejected later, moves an approved customer to `unapproved` with a `review_reopened` flag; never an automatic rejection |
| SD3-07 | `rejection_kind` (`final`, `restartable`); Sandbox rejections are restartable; staff "Allow one restart" takes an intent ([KY-07] made concrete) |
| SD3-08 | Minting a hosted link (customer, assisted, person, go-live person) takes an intent; creating a customer takes a window |
| SD3-09 | A second approver is required when at least two active staff hold the deciding permission; pending approvals expire after 72 hours and the first approver may cancel ([SA-39] made concrete) |
| SD3-10 | Staff notes are sealed in `kyc.staff_note`; audit metadata holds only the note's ID |
| SD3-11 | A staff decision the organisation can see writes an organisation-scope mirror event with actor `system`, `via: "admin"` and no staff ID |
| SD3-12 | RFI typed answers are sealed in Fin in both modes; the API may answer any form except one with a selfie input |
| SD3-13 | The field catalogue and validators are browser-safe code in `packages/contract/src/fields/` |
| SD3-14 | The Sandbox document quota is 1,000 documents and 5 GB per organisation per UTC day, and 50 per customer |
| SD3-15 | Appendix B's reasons and templates are the seeds |
| SD3-16 | Only an allowlist of Sumsub's webhook fields is stored |
| SD3-17 | Fin Admin opens a document with a gated `POST /api/documents/:id/view` that spends the budget, writes `staff.document_viewed` and mints a single-use, session-bound URL for 60 seconds; the image or the PDF's new tab loads that URL with `Sec-Fetch-Site: same-origin` or `none`; no GET is audited or spends a budget; no `blob:` (SP-27, [SA-44]) |
| SD3-18 | Sandbox mail to non-members is held in `kyc.held_email` (no link, code or address in clear) and shown in the console |
| SD3-19 | The sandbox provider emits synthetic inbound events, so Sandbox and live share one pipeline |
| SD3-20 | The new ID prefixes of §4.1 |
| SD3-21 | The `verify` monitor calls `https://verify.<zone>/api/health` (spec 01 §4.4) |
| SD3-22 | `kyc.flag` holds staff-facing signals and refusals; the Signals list is stretch |
| SD3-23 | Verify's limits: link opens 20 per 10 minutes per address and 10 per hour per token hash; saves 120 per 10 minutes per session; uploads 30 per hour per session; "email me" 3 an hour per session |
| SD3-24 | Customer search: 60 a minute per key or member; email and phone searches 10 an hour per organisation and value |
| SD3-25 | Withdrawn: Spec 05 §5.3.2 defines the webhook endpoint states |
| SD3-26 | Deleting a customer writes a tombstone with personal fields blanked and queues deactivation; erasure completes from Sumsub's webhooks |
| SD3-27 | Production request answers are sealed per page |
| SD3-28 | Emails that carry a link token or a code are `secret_bearing`: deleted on send and left out of dumps |
| SD3-29 | The go-live company email code is sent from the `auth.` subdomain as a code template |
| SD3-30 | A declined Production request is final; the organisation cannot start another |
| SD3-31 | `POST /v4/sandbox/reset` needs a full-access Sandbox key |
| SD3-32 | Reveal budgets start at 30 an hour and 150 a day per staff member, set on `api` |
