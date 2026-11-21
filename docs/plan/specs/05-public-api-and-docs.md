# 05. The public API and the docs site (R16)

| | |
|---|---|
| Status | Specification for builders, written on Saturday 21 Nov 2026 from ARCHITECTURE.md §13, DECISIONS.md section 13 (`AP-`), EXECUTION.md and the owner's decisions of 21 Nov 2026 |
| Part of | The fin-next plan (R13). Builders build from this file and the sections it cites. They never read the old product's code ([G-04]) |
| Requirements touched | R1 to R16, all named in the requirement map below |
| Lanes | L-SAT-11 (API keys and the edge, Saturday stretch, else Sunday's spill block), L-SUN-01 (edge and API platform), L-SUN-04 (webhooks), L-SUN-05 (onboarding API routes), L-MON-05 (money API), L-SUN-09 then L-MON-08 (docs site), the ops lanes L-SUN-10 and L-MON-09, and H-08 (docs, from Tuesday). §12 gives each lane its files |
| Exit | §14: A05-01 to A05-40, which carry EXECUTION's AC-SUN-01, 02, 03, 07, 09, 12 and AC-MON-07, 08, 12 |

---

## How to read it

**Precedence.** The plan's one order of precedence, highest first: (1) the owner's decisions of
21 Nov 2026; (2) DECISIONS.md, appendix C included; (3) ARCHITECTURE.md; (4) EXECUTION.md; (5) the
specifications, and between two specifications the one that owns the area, as README §8.3 lists
the owners. The owner's decisions are those DECISIONS.md records as the owner's: the overnight
ones, which spec 01 §1 lists as OD-1 to OD-6, and the answers of Saturday morning, which spec 01
§1.2 lists. The decisions taken while the owner was away are register entries, for the owner's
review. Among the specifications, this file owns the public API's conventions, API keys, webhooks and
events, the OpenAPI document, the docs site and Try it; the sibling owns any other area (spec 01 for
the platform and the static hosts, spec 02 for sign-in and roles, spec 03 for onboarding, spec 04
for money); and spec 08 owns the cross-cutting rules of audit, security email, personal data,
scrubbing, secrets and observability. A decision of this file (D05-nn, §16) binds where everything
above it is silent; one that differs from ARCHITECTURE.md or EXECUTION.md binds only once that file
is changed to match. One that would change a register entry binds only as DECISIONS appendix C
settles it: D05-01 is folded into [P-07] (SF-01), D05-03 waits for the owner's yes under [AP-11]
(SF-08), and D05-32's first form, a `404-page` fallback, is not adopted (SF-06). A conflict with the
register found later is settled the same way, and the register holds until it is. Where this file
repeats a rule it cites the section and keeps it short; where it differs from ARCHITECTURE or
EXECUTION, the change is named, and the higher file holds until it is amended to match.

| Mark | Meaning |
|---|---|
| `[AP-04]` | A decision in DECISIONS.md, the only register |
| `§3.4`, `ARCH §13.3` | A bare `§` is a section of this file; `ARCH §` is a section of ARCHITECTURE.md |
| `spec 01 §7.4`, `spec 04 §25` | A section of a sibling spec in `docs/plan/specs/`. Spec 02 is Saturday's auth and roles spec (R6) and spec 03 Sunday's onboarding spec (R7) |
| `OD-n`, `S0-nn` | Spec 01's record of the owner's overnight decisions of 21 Nov, and spec 01's own decisions |
| `MS-nn` | A decision of spec 04 |
| `D05-nn` | A decision this file takes where the plan is silent (§16). D05-01, D05-03 and D05-32 are already settled in DECISIONS appendix C (SF-01, SF-08, SF-06); the steward enters the rest in DECISIONS.md as AP-21 onwards, in a later pull request of the plan |
| `SF-nn` | A spec decision settled in the register before the first commit, folded or not adopted (DECISIONS appendix C) |
| `T05-nn` | A test this file requires (§13) |
| `A05-nn` | An acceptance criterion of this file (§14), each naming the EXECUTION criterion it implements |
| `PG-nn` | A production gate (EXECUTION §7.3). Production gates use `PG-` only; `G-` belongs to governance |
| `SP-nn`, `S-01`, `NF-1` | A spike (ARCH §11.11, spec 01 §11). S-01 is the run of SP-25 (EXECUTION §2.6), logged in `docs/plan/spikes.md` with its findings, NF-1 among them |
| UNVERIFIED | Not confirmed from a primary source; the named spike or test confirms it before work that depends on it merges |

| Placeholder | Stands for |
|---|---|
| `<zone>` | A Fin zone. In production [FD-10] may put the docs host on its own registrable domain; `<zone>` in `developer.<zone>` then means that domain. Nothing in this file depends on the docs and the API being same-site |
| `<staging-zone>` | The staging zone, shared with the old product's staging ([FD-09]) |
| `<app>.<zone>` | A host, for example `api.<zone>`, which is `gateway.<staging-zone>` on staging ([FD-09]) |
| `<docs origin>`, `<api origin>`, `<console origin>` | `https://developer.<zone>`, `https://api.<zone>`, `https://console.<zone>`, read from configuration at run time, never written in the repository ([G-09]) |

**Public by design (R12).** This file names no credential, token, account or tunnel ID, zone name,
internal address or real person. It contains no key-shaped string with a valid checksum, and no
webhook secret: test vectors are built at run time from stated inputs.

### Requirement map

| Req | What this spec gives it | Where |
|---|---|---|
| R1 Production-ready, from scratch | A contract written fresh from this file, with a test behind every rule; production items gated (PG-02, PG-06, PG-08) | §13, §14 |
| R2 Everything on Railway | `edge`, `api`, `worker` and `payments` serve the API and send webhooks from Railway; only the static docs files and Cloudflare's edge are off it ([P-02]) | §2 |
| R3 Cloudflare Email Sending | Key, webhook and deprecation notices go through `email.enqueue()` and the worker's Cloudflare adapter (ARCH §9) | §4.10, §5.7, §3.6 |
| R4 Cloudflare in front of Railway | `api.<zone>` straight to the public tunnel; `developer.<zone>` an assets-only static deployment with no code (OD-2, OD-3) | §2, §8.1 |
| R5 Better Stack | One line per request and per delivery, alerts, monitors and heartbeats for the edge, the platform, webhooks and the docs | §10 |
| R6 Roles and second factors | A key never does more than its maker's role; every key and endpoint change takes a step-up intent in the console ([SA-34]) | §4.4, §4.6, §5.3 |
| R7 Onboarding | The customer, people, document, link, RFI and Sandbox routes | §6, Sunday rows |
| R8 Providers behind an adapter | The money routes, provider-neutral, routed by mode ([MO-05]); details in spec 04 §25 | §3.10, §6, Monday rows |
| R9 Everything audited | Every write through the API audited in its transaction with `via: "api"`; key and endpoint lifecycles audited | §3.9, §4.10, §5.7 |
| R10 fin-review | Every path here is tier S except docs content; the Monday attack profile "Try it leaking a key" | §11, §12 |
| R11 Model and effort rules | Applies through fin-review (ARCH §11.6); nothing here changes it | none |
| R12 Public repository | No valid-checksum key anywhere in the tree; provider names out of the contract; zone names only at deploy | §4.1, §3.10, §8.2 |
| R13 Plan first | This file is part of the plan in `docs/plan/` | none |
| R14 New designs | The console's API keys, Webhooks and Events boards are spec 02's and spec 03's screens; the docs site has no board and is themed from tokens ([AP-12]) | §8.10 |
| R15 Bun or Node | Node 26.13.1 for every service; the key format and the Try-it guard are plain Web-API TypeScript that runs in browsers and in the Bun canary job | §4.1, §9 |
| R16 Public API and docs with Try it on Sandbox keys | The whole file | all |

---

## 0. Summary

- **One host, one major version.** `https://api.<zone>/v4/...` for Sandbox and Production; the
  key's prefix picks the mode ([AP-01]). JSON only, snake_case, prefixed opaque IDs, RFC 9457
  problem documents, `Idempotency-Key` per draft-08, opaque cursors, draft-11 rate-limit headers, a
  reserved `Fin-Version` date header (§3).
- **Keys** are `fin_<test|live>_<sk|rk>_` + a 10-character Crockford ID + a 32-character base62
  secret + a 6-character base62 CRC-32 checksum over a public per-deployment salt ([SA-18]). The edge
  sheds load first, then checks shape and checksum, then reads the key in one statement with no
  positive cache ([SA-19]). Every refusal is the same 401 (§4).
- **Webhooks** are Standard Webhooks `v1`, thin payloads, an outbox in the action's transaction,
  endpoints enabled only after a signed challenge, 15 tries over about 3 days, 410 Gone disables the
  endpoint ([AP-07]), sent only
  through `deliveryFetch` from the worker's static addresses (§5).
- **59 operations**: 1 on Saturday (`whoami`), 40 on Sunday (onboarding, events, webhook endpoints,
  Sandbox customers), 18 on Monday (money and Sandbox money) (§6).
- **OpenAPI 3.1** (declared `3.1.1`) generated from the Zod route schemas with `@hono/zod-openapi`
  1.6.3, one committed fragment per area, assembled at build, checked by route parity, a negative
  test, `oasdiff` and `vacuum` (§7).
- **The docs site** at `developer.<zone>` is static files on an assets-only deployment with no code
  and no `/api/` path (OD-2, spec 01 §2): guides from restricted Markdown, the reference on Scalar
  `@scalar/api-reference` 1.78.1 bundled with no CDN, build-time search with `fuse.js`, error pages,
  a changelog with an Atom feed (§8).
- **Try it** sends only this deployment's Sandbox keys, enforced five ways: the page guard, the page
  policy, CORS for the docs origin only, the edge refusing every non-Sandbox key from that origin
  before any lookup, and the per-deployment salt (§9).

---

## 1. Scope

### 1.1 This spec owns

| Area | Packages and apps | Sections |
|---|---|---|
| API conventions, errors, idempotency, pagination, versioning, rate-limit headers, CORS | `apps/edge`, `apps/api/src/platform`, `packages/contract` | §3 |
| API keys: format, salts, hashing, scopes, allowlists, lifecycle rules, the edge's check, leak handling | `packages/keys`, `apps/edge` | §4 |
| Developer events and webhooks | `packages/events`, `apps/api/src/worker/webhooks` | §5 |
| The route inventory and its contract | `packages/contract`, `apps/api/src/routes/*` | §6, §7 |
| The docs site and Try it | `apps/docs`, `apps/edge/src/reports` | §8, §9 |

### 1.2 Other specs own

| What | Owner | This spec's interface to it |
|---|---|---|
| Customers, people, documents, links, RFIs, go-live, the sandbox provider and its test values | Spec 03 (R7) | The routes, scopes and refusal codes in §6; the error fragments in §3.3.5 |
| Money domain, the money door, money audit events and money refusals | Spec 04 (R8) | The money routes of §6.8 and §6.9; spec 04 §25 is the source for their bodies and shapes |
| The console's API keys, Webhooks, Events and Simulator screens; step-up ceremonies; the realm | Spec 02 (R6) and spec 03 | `packages/keys` lifecycle functions (§4.6) and `packages/events` endpoint functions (§5.3), called by the console's API half |
| Tunnels, the ingress check, static deployments, `_headers` rendering, `env.json`, the static upload path | Spec 01 §7 | The docs host's settings (§8.1) and its policy template (§8.11) |
| `deliveryFetch`, caller signatures, the door matrix, the unit of work, telemetry | `packages/server` (spec 01, P0-D) | Used as ARCH §7.9, §7.11 and §10 say |
| The audit chain and `recordAudit` | `packages/audit` (spec 01, P0-E) | Fragments `api-keys.ts` and `webhooks.ts` (§4.10, §5.7) |

### 1.3 What the owner's 21 Nov decisions changed in ARCH §13

ARCHITECTURE already follows OD-2 and OD-3 (spec 01 §1), [FD-18] and DECISIONS appendix C (SF-01): it
has no `docs` service, no docs server and no failure path on the docs host (ARCH §3.1, §4.2, §5.2,
§10.5, §13.10). This table records what an earlier draft said and what holds now, so a reader of the
old draft finds the change; none of the left column's texts is in ARCHITECTURE any more.

| Earlier draft | Now (ARCHITECTURE and this spec agree) | This spec |
|---|---|---|
| A `docs` service on Railway, a small static server for the docs, and a docs-side failure path | There is no `docs` service. `developer.<zone>` is assets-only, with a proxied CNAME to the public tunnel but no `/api/*` route, no ingress rule and no service (ARCH §5.2, [FD-18], SF-01) | The docs site is static only. Browser failure reports go to the edge at `POST <api origin>/reports/docs`, which feeds the Errors application `fin-next-<env>-docs-web` (§8.13, D05-01; ARCH §10.5) |
| `connect-src` fixed at build time | Builds carry nothing environment-specific; `env.json` and `_headers` are rendered at deploy (ARCH §5.16, spec 01 S0-05) | One build for every environment; the reference reads the API origin and the salt from `/env.json` (§8.2, D05-02) |
| `developer.<hosted zone>` | Hosts written `<app>.<zone>` (ARCH §5.2) | `developer.<zone>`, read as [FD-10] assigns it |

---

## 2. Hosts and the request path

| Host and path | DNS (spec 01 §7.2) | Answered by | Notes |
|---|---|---|---|
| `api.<zone>/*` | Proxied CNAME to the public tunnel | Tunnel ingress role `api` to `http://edge.railway.internal:8080` | Every path: `/health`, `/v4/*`, `/hooks/*`, `/reports/docs`; anything else 404 |
| `developer.<zone>/*` | Proxied CNAME to the public tunnel | Workers route to the assets-only deployment `fin-next-<env>-docs-static` | No code runs. There is no ingress rule for `developer`, so if the route ever vanished the tunnel's `http_status:404` answers and the watcher alerts (§10) |

On staging they are `gateway.<staging-zone>` and `docs.<staging-zone>` ([FD-09]). The flows are F1
(a public API call) and F2 (Try it) of ARCH §2.3; F9 delivers webhooks; F19 takes GitHub's leak
reports.

### 2.1 The edge's pipeline, in this order

Every step that refuses answers a problem document (§3.3) with the headers of §3.2 and writes the
`request` line (§10.1). The order is normative; `apps/edge/src/app.ts` composes it and a test
(T05-07) asserts it.

| # | Step | Refusal |
|---|---|---|
| 1 | `GET /healthz`, `GET /readyz` (private callers only, ARCH §4.3); `GET /health` (public, never touches the database) | `/readyz` through a tunnel: 404 |
| 2 | Ingress check (ARCH §5.5): the TCP peer is a current `cloudflared-public` replica and the host's `Fin-Ingress-Proof` matches; only then are `CF-*` headers trusted | 403, `ingress.untrusted_peer` |
| 3 | `Host` equals the configured API host; the target starts with one `/` and holds no `\` | 421; 400 `invalid_request` |
| 4 | Make `req_<26>`; ignore any `Request-Id` the caller sent | none |
| 5 | Load shedding ([SA-19], §3.7): per-replica token bucket for the address, then for the replica in all | 429 `rate_limited`, `Retry-After: 1`, `outcome: shed` |
| 6 | Plain http (`CF-Visitor` scheme `http`) on any path | 403 `https_required`; after the answer, §4.8 |
| 7 | `POST /hooks/kyc/sumsub`, `POST /hooks/money/{provider}/{instance}`, `POST /hooks/github/secret-scanning`, `POST /reports/docs`: their own handlers, no API key, no CORS (spec 03, spec 04, §4.8, §8.13) | each handler's own |
| 8 | Anything not under `/v4/`: 404 `not_found` | 404 |
| 9 | CORS for the docs origin (§3.8): an `OPTIONS` preflight is answered here and never forwarded | none |
| 10 | Route lookup in the contract's route table (method and path template); an unknown route, or a path ID of the wrong shape ([DA-02]) | 404 `not_found` |
| 11 | `Fin-Version` (§3.6) | 400 `api_version_unknown`; 410 `api_version_retired` |
| 12 | From the docs origin, when `Authorization` is present: it is `Bearer` and a well-formed `fin_test_` key whose checksum verifies with this salt (§9, layer 4). A missing header goes on to step 13 | 403 `sandbox_key_required` |
| 13 | `Authorization: Bearer <key>` present; shape and checksum with this deployment's salt (§4.1) | 401 `unauthenticated` |
| 14 | Negative filter: the key ID was found not to exist in the last 60 seconds (load shedding only) | 401 `unauthenticated` |
| 15 | One statement: the key record from `keys.key_lookup`, the address's refused-key window, the organisation's live status and the switches the edge reads (§4.9) | none |
| 16 | Constant-time HMAC compare across the key's pepper chain; revoked; expired; IP allowlist | 401 `unauthenticated`, or 429 `rate_limited` once the address's refused-key window is full |
| 17 | Live key: organisation not live; paused; the `live_keys` switch | 403 `live_not_enabled`; 403 `live_paused`; 503 `temporarily_unavailable` |
| 18 | Route policy (§6.1): key kind, scopes, mode, live money | 403 `forbidden`; 403 `sandbox_only` |
| 19 | The key's window, 600 calls a minute (§3.7) | 429 `rate_limited` |
| 20 | `Content-Type` and body size (§3.1), read while streaming | 415 `unsupported_media_type`; 413 `body_too_large`, `file_too_large` |
| 21 | `GET /v4/whoami` is answered here (§6.2). Every other route is forwarded to `api` at `/internal/v4/...` with the Ed25519 caller assertion (ARCH §7.9); `api` forwards money routes unchanged to `payments` (F11) | `api` unreachable or past 30 s (60 s for money writes): 503 `temporarily_unavailable`, `Retry-After: 5` (D05-28) |
| 22 | Answer: drop every header `api` sent that starts with `Fin-` except `Fin-Version`; drop `content-encoding` and `content-length` (ARCH §7.9); add §3.2's headers | none |
| 23 | After the answer: `keys.touch_last_used()` at most once a minute per key ([BC-05]); the `request` line | none |

---

## 3. API conventions

ARCH §13.1 is the normative list. This section adds what a builder needs to implement it.

### 3.1 Requests and answers

| Rule | Detail |
|---|---|
| Base | `<api origin>/v4/...`, https only (§2.1 step 6) |
| Request bodies | `application/json` (a `; charset=utf-8` parameter is allowed), at most 256 KB counted while reading; an empty body reads as `{}`. Multipart only on the two upload routes: at most 20 MB per file and 20 MB plus 64 KB per body, JPEG, PNG, HEIC or PDF checked by their first bytes ([DA-13]); the routes validate fields by hand because the generator validates JSON and forms only (ARCH §13.8) |
| Unknown input | Unknown body fields, unknown query parameters and duplicated query parameters are refused with 400 `invalid_request` (D05-21). The old product's `search` and `email` query parameters are refused with a `detail` that points to `POST /v4/customers/search` ([AP-18]) |
| Answers | `application/json; charset=utf-8`; errors `application/problem+json`; snake_case; every resource carries `object`; lists are `object: "list"` |
| IDs | `<prefix>_<26 lowercase Crockford base32>`, time-ordered ([DA-02]), matched by `^[a-z]{3}_[0-9a-hjkmnp-tv-z]{26}$`. API key IDs are 10 uppercase Crockford characters inside the key (§4.1). Upper case in a path ID is refused, never folded |
| Time | RFC 3339 UTC with `Z`, at most millisecond precision, for example `2026-11-23T09:30:00.000Z`. Dates alone (date of birth) are `YYYY-MM-DD` |
| Money | `amount` in integer minor units with `currency` (ISO 4217, upper case); fees `fee`, totals `total`; never floats ([MO-08]). USD only at launch ([MO-11]) |
| Booleans and nulls | A field that has no value is present with `null`, never absent, so the schema is stable |
| Deleted | `{ "id": "...", "object": "<type>", "deleted": true }` |

### 3.2 Headers

| Header | Direction | Rule |
|---|---|---|
| `Authorization: Bearer <key>` | request | The only credential. Keys in a query string or body are never read |
| `Idempotency-Key` | request | §3.4 |
| `Fin-Version` | both | §3.6. Sent on every answer |
| `Content-Type` | both | §3.1 |
| `Request-Id: req_<26>` | answer | Every answer, the edge's own included; repeated as `request_id` in problem documents |
| `Idempotent-Replayed: true` | answer | On a replay only |
| `RateLimit-Policy`, `RateLimit` | answer | §3.7, every `/v4` answer with a working key |
| `Retry-After` | answer | Every 429 and 503, and 409 `idempotency_request_in_progress` |
| `Deprecation`, `Sunset`, `Link` | answer | §3.6, on deprecated operations only |
| `Cache-Control: no-store` | answer | Every answer |
| `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` | answer | Every answer (ARCH §7.12) |
| `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` | answer | Every https answer. The API host (`api.`, which is `gateway.` on staging) is on the main zone in production and on the staging zone in staging, so it takes that zone class's value, with no `preload` (ARCH §5.8, [SA-45]); the header-matrix test asserts the exact value |
| `Vary: Origin` | answer | Every `/v4` answer, preflights included |
| CORS headers | answer | §3.8, for the docs origin only |
| `Fin-Release` | never | The public API does not say which release answered (D05-29) |

### 3.3 Errors (RFC 9457, [AP-03])

#### 3.3.1 The document

```json
{
  "type": "https://developer.<zone>/errors/idempotency_key_reused",
  "title": "This Idempotency-Key was used for another request",
  "status": 422,
  "detail": "Send a new Idempotency-Key for a different request.",
  "code": "idempotency_key_reused",
  "next_actor": "developer",
  "request_id": "req_01jd2k3m4n5p6q7r8s9t0v1w2x"
}
```

| Member | Rule |
|---|---|
| `type` | `<docs origin>/errors/<code>`, from the `FIN_DOCS_ORIGIN` setting of `edge`, `api` and `payments`. The setting is required; a service without a valid https value exits 78 outside development and CI |
| `title` | One per code, stable once served, British English, sentence case, no full stop, at most 60 characters |
| `status` | Equals the HTTP status |
| `detail` | Fin's own words for this occurrence. Never echoes input, a name, an address or a value the caller sent |
| `code` | snake_case, stable, in the OpenAPI enum of public codes |
| `next_actor` | `developer`, `customer` or `fin` |
| `request_id` | As the `Request-Id` header |
| `errors` | Only on validation refusals: an array of items, each with exactly one of `pointer` (a JSON Pointer into the body, `#/amount`) or `parameter` (a query, path or header name), plus `detail` and `code` (D05-22) |
| extensions | Only `missing`, `field`, `current_status`, `item`, `reason`, `customer_id`, `violated_policies`. Anything else a domain adds is dropped by `toProblem()` |
| `instance` | Not sent |

`errors[].code` is one of `required`, `invalid_type`, `invalid_format`, `invalid_value`, `too_small`,
`too_large`, `too_short`, `too_long`, `not_allowed` (an unknown field or parameter) and `invalid`.
`packages/contract/src/issues.ts` maps Zod 4 issues: `invalid_type` with an undefined input becomes
`required`; `too_big` becomes `too_large` for numbers and `too_long` for strings and arrays;
`too_small` likewise `too_small` or `too_short`; `unrecognized_keys` becomes one `not_allowed` item
per key; `invalid_format`, `invalid_value` stay; `custom` becomes `invalid`. Issue paths become
pointers with `~0` and `~1` escaping.

#### 3.3.2 How code raises one

- A public refusal is raised only with `refuse(code, { detail?, extensions? })` from
  `packages/contract/src/refuse.ts`. `code` is typed to the union of public codes, so an unknown code
  does not compile.
- `toProblem(error, ctx)` turns a `FinRefusal` into the document; anything else becomes 500
  `internal` with no message, is logged with `safeError`, and is reported with an `errorId`
  (ARCH §10.5). Provider failures are 502 `upstream_unavailable`.
- `payments` answers `api` with problem documents built the same way; `api` passes them through after
  checking the code is public and the extensions are on the allowlist, and otherwise answers 500.

#### 3.3.3 The catalogue

`packages/contract/src/errors/<area>.ts` exports entries of this type; the assembled `ERROR_CODES`
is built by discovery of those files (no hand-edited index):

```ts
export type ErrorEntry = {
  code: string;                       // snake_case
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 502 | 503;
  title: string;                      // the rule in §3.3.1
  nextActor: "developer" | "customer" | "fin";
  visibility: "public" | "internal";  // internal codes never reach the document or a developer
  adds: readonly Extension[];         // always present on this code
  mayAdd: readonly Extension[];       // sometimes present
  page: { meaning: string; fix: string; example: Record<string, unknown> };  // the /errors/<code> page
};
```

Tests (T05-20): every public code has an entry and a page; every `refuse("...")` literal in
`apps/{edge,api,payments}/src` and `packages/{contract,keys,events,kyc,money}/src` is a catalogue
code; every public catalogue code appears in at least one such literal; `adds` and `mayAdd` match
what the throws pass; no title or `detail` names a provider (§3.10).

#### 3.3.4 Platform codes (L-SUN-01 and L-SAT-11; `errors/platform.ts`)

| Code | Status | Title | `next_actor` | Adds |
|---|---|---|---|---|
| `invalid_request` | 400 | The request is not valid | developer | `errors` |
| `idempotency_key_missing` | 400 | This request needs an Idempotency-Key | developer | |
| `idempotency_key_invalid` | 400 | The Idempotency-Key is not valid | developer | |
| `cursor_invalid` | 400 | The cursor can't be used | developer | |
| `api_version_unknown` | 400 | Fin doesn't know this API version | developer | |
| `unauthenticated` | 401 | Send a valid API key | developer | |
| `forbidden` | 403 | This key can't do that | developer | |
| `https_required` | 403 | Call the API over https | developer | |
| `sandbox_key_required` | 403 | Use a Sandbox key here | developer | |
| `live_not_enabled` | 403 | Production isn't enabled yet | developer | |
| `live_paused` | 403 | Production access is paused | developer | |
| `sandbox_only` | 403 | This works in the Sandbox only | developer | |
| `not_found` | 404 | Not found | developer | |
| `idempotency_request_in_progress` | 409 | The first request is still running | developer | |
| `api_version_retired` | 410 | This API version has been retired | developer | |
| `body_too_large` | 413 | The request body is too large | developer | |
| `file_too_large` | 413 | The file is too large | developer | |
| `unsupported_media_type` | 415 | The content type isn't supported | developer | |
| `idempotency_key_reused` | 422 | This Idempotency-Key was used for another request | developer | |
| `rate_limited` | 429 | Too many requests | developer | `violated_policies` (absent on a shed answer) |
| `internal` | 500 | Something went wrong on Fin's side | fin | |
| `upstream_unavailable` | 502 | A service Fin uses didn't answer | fin | |
| `temporarily_unavailable` | 503 | This is unavailable for a moment | fin | |

The `unauthenticated` detail is one fixed sentence for every reason: "Send a valid API key as
`Authorization: Bearer fin_test_...` or `fin_live_...`. A key with an address allowlist works only
from those addresses." From the docs origin it adds: "Try it calls from your browser's address."
The old product's `live_key_refused` is not carried; `sandbox_key_required` replaces it.

#### 3.3.5 Domain codes (owned by the area lanes)

| Fragment | Lane | Codes (carried from the old product unless marked) |
|---|---|---|
| `errors/customers.ts`, `documents.ts`, `people.ts`, `rfis.ts`, `sandbox.ts` | L-SUN-05 with spec 03 | 400 `customer_incomplete`, `details_missing`, `invalid_count`, `invalid_document`, `invalid_document_type`, `invalid_field`, `invalid_forms`, `invalid_items`, `invalid_link`, `invalid_note`, `invalid_ownership`, `invalid_reason`, `invalid_roles`, `invalid_side`, `invalid_status`, `invalid_type`, `ownership_over`, `rfi_incomplete`, `too_many_documents`; 409 `company_type_missing`, `customer_locked`, `customer_not_deletable`, `customer_not_rejected`, `customer_submitted`, `email_used`, `external_id_used`, `form_takes_id`, `not_business`, `person_locked`, `rfi_closed`, `rfi_forms`, `rfi_open`, `transition_refused`, `restart_not_allowed` (new, [KY-07]), `too_many_people` (new, 20 a business), `sandbox_quota` (new, [DA-13], D05-31); 422 `document_refused`, `document_unreadable`, `invalid_answers`; 429 `restart_limit`. Spec 03 decides which of the old verify-only codes (`selfie_*`, `person_submitted`, `rfi_not_answered`, `rfi_not_waiting`, `status_changed`) stay public |
| `errors/webhooks.ts` | L-SUN-04 | 400 `invalid_url` (adds `reason`), `invalid_events`, `invalid_description`, `invalid_held_deliveries`; 409 `too_many_endpoints`, `endpoint_paused`, `endpoint_not_verified` (new), `not_sendable` |
| `errors/money.ts` | L-MON-05 with spec 04 | Spec 04 §25 is the list. It includes 400 `invalid_beneficiary`, `invalid_transfer`; 409 `account_not_ready`, `beneficiary_exists`, `beneficiary_removed`, `beneficiary_not_ready`, `insufficient_funds`, `money_locked`, `not_approved`, `not_cancellable`, `not_simulatable`, `not_supported`, `rail_unavailable`, `rail_unsupported`; 429 `beneficiary_limit`, `deposit_limit`, `transfer_limit`. The old `money_not_enabled` and `deposit_unavailable` are not carried (spec 04 §25.6, MS-24): a live money call while live money is off, or while the live instance is disabled, is 403 `sandbox_only` (§3.3.4; ARCHITECTURE §13.1 rule 6) |

Codes never in the public catalogue: `step_up_required`, `second_factor_required`, `invalid_origin`
and the app halves' codes (spec 01 §4.4), which belong to the console, Fin Admin and verify.

### 3.4 Idempotency ([AP-04])

#### 3.4.1 Classes

Each route's policy (§6.1) names one class:

| Class | Header | Who keeps it | Answer to a replay |
|---|---|---|---|
| `required_permanent` | Required; 400 `idempotency_key_missing` without it | The owning domain, bound for good to the resource it created (spec 04 §16.1) | The resource as it is now, 200, `Idempotent-Replayed: true`. A concurrent duplicate meets the unique index and is answered the same way; money never answers 409 in progress (spec 04 §16.1) |
| `accepted_permanent` | Optional; when sent, bound for good | The owning domain (beneficiary create, MS-17) | As above |
| `accepted` | Optional | `api`'s store for 24 hours (§3.4.3) | The stored status and body, `Idempotent-Replayed: true` |
| `accepted_by_state` | Optional; validated, not stored | Nobody: the operation is idempotent by state (spec 04 §16.1: open a virtual account, cancel, remove, simulations) | The operation's own answer |
| `none` | Ignored on GET, PATCH and the read-only POSTs (`searchCustomers`, `quoteTransfer`) | Nobody | n/a |

#### 3.4.2 The key and its scope

- 1 to 255 visible ASCII characters (0x21 to 0x7E). The draft's quoted Structured Field String form
  is accepted: one pair of surrounding quotes is removed and `\"` and `\\` unescaped. Anything else is
  400 `idempotency_key_invalid`. The docs recommend a UUIDv4 or v7.
- Scope: `(organization_id, mode, SHA-256(key))`. The API key's ID is not in the scope, so two keys
  of one organisation share it. The raw key is never stored, logged or audited; money audit events
  carry `idempotency_key_sha256` (§3.9).
- Fingerprint, for `accepted`: SHA-256 of the UTF-8 bytes of
  `METHOD + "\n" + route template + "\n" + JCS(path params) + "\n" + hex(SHA-256(JCS(body)))`, where
  JCS is RFC 8785 (`packages/contract/src/jcs.ts`) and an empty body is `{}`. Multipart bodies use
  `JCS({ fields: <text fields>, file_sha256: <hex SHA-256 of the file bytes> })` so a client's new
  boundary on a retry does not count as a new request (D05-23). Spec 04 §16.1 defines the money
  request hash.
- Refused before execution (validation, auth, rate limit, version) means nothing is stored, so the
  request can be retried.

#### 3.4.3 The store (`apps/api/src/platform/idempotency.ts`)

Table `api.idempotency_record`, logged (a crash must not forget a key), left out of dumps
(`--exclude-table-data`), swept hourly by the worker duty `idempotency.sweep`:

| Column | Type | Notes |
|---|---|---|
| `organization_id` | text | part of the primary key |
| `mode` | text | `test` or `live`; part of the primary key |
| `key_sha256` | bytea | part of the primary key |
| `fingerprint` | bytea | §3.4.2 |
| `api_key_id` | text | the key that made the first request |
| `state` | text | `running` or `done` |
| `lease_until` | timestamptz | `now() + 120 s` while running |
| `status_code` | smallint | when done |
| `response_sealed` | bytea | the body, sealed with `api`'s seal key under the HKDF subkey `idempotency`; null for secret-bearing routes |
| `resource_id` | text | the created resource, for secret-bearing routes |
| `secret_bearing` | boolean | |
| `created_at`, `expires_at` | timestamptz | `expires_at = created_at + 24 h` |

The procedure, in `api`, for a route of class `accepted`:

1. Transaction A: `INSERT ... ON CONFLICT DO NOTHING` a `running` row. If a row exists:
   - `done` and the fingerprint matches: replay (below);
   - `done` and the fingerprint differs: 422 `idempotency_key_reused`;
   - `running` with `lease_until` in the future: 409 `idempotency_request_in_progress`,
     `Retry-After: 1` (422 `idempotency_key_reused` if the fingerprint differs);
   - `running` with the lease passed: take the lease (`UPDATE ... SET lease_until = now() + 120 s
     WHERE lease_until < now()`) and execute. Because transaction B below commits the change and the
     `done` row together, a lapsed lease means the first attempt changed nothing in the database. A
     route that calls a provider before transaction B passes the provider a key derived from the
     record it is working on (spec 03), so the re-execution meets the same provider request.
2. Transaction B: the domain change, its audit and developer events, and the update of the row to
   `done` with the answer, in one unit of work.
3. If the idempotency store cannot be read or written, the request fails closed with 503
   `temporarily_unavailable` and the alert `idempotency-store-failing` (§10.2).

**Secret-bearing routes** (`createWebhookEndpoint`, `rollWebhookSecret`, `createCustomerLink`,
`createPersonLink`, `restartCustomer`; D05-30 adds the last): the stored row holds only
`resource_id` and the marker. A replay answers only to the same `api_key_id` (another key gets 422
`idempotency_key_reused`), with the original status, `Idempotent-Replayed: true` and the resource as
it is now without its secret: `secret` absent from a webhook endpoint, `url` set to `null` in a link
and in a restarted customer's `link`. T05-24 proves no stored row matches a key, `whsec_` or link
token shape.

### 3.5 Pagination ([AP-05], [AP-17])

| Rule | Detail |
|---|---|
| Parameters | `limit` (integer 1 to 100, default 50; above 100 becomes 100; 0, negative or not an integer is 400 `invalid_request`); `cursor` (older items); `ending_before` (newer items). Both at once is 400 `invalid_request` |
| Answer | `{ "object": "list", "data": [...], "has_more": true, "next_cursor": "...", "previous_cursor": "..." }`. `next_cursor` is null when nothing older remains, `previous_cursor` null on the first page. `has_more` is about the direction asked for |
| Order | Newest first, `(created_at DESC, id DESC)`, keyset on a matching index, never `OFFSET`, on every list (D05-14) |
| Counts | None. The old customer list's `counts` and `total` are not carried; the console's counts come from its own app routes, labelled as estimates ([AP-05]) |
| Filters | Only IDs, statuses, types and creation times in query strings. Time filters are `created_gte` and `created_lt` (RFC 3339) |

**The cursor** (`apps/api/src/platform/pagination.ts`; `payments` has the same code through
`packages/contract/src/cursor.ts`, D05-24):

```
payload  = 0x01                                  // format version
         | direction (0x00 older, 0x01 newer)
         | created_at as int64 microseconds since the epoch, big-endian
         | length of the item ID (1 byte) | the item ID in ASCII
         | first 8 bytes of SHA-256(JCS({ route, organization_id, mode, filters }))
         | key version n (1 byte)
cursor   = base64url_nopad( payload | first 16 bytes of HMAC-SHA256(FIN_CURSOR_KEY_<n>, payload) )
```

A cursor longer than 200 characters, with a bad MAC, an unknown key version, another route,
organisation, mode or filter set, or a format version other than 1 is 400 `cursor_invalid`. Keys
`n` and `n-1` are accepted during a rotation; older cursors fail with 400 (ARCH §7.8). A cursor holds no
personal data and no search text; a name search's cursor holds the blind-index position only.

### 3.6 Versioning and deprecation ([AP-01], [AP-19])

- **The path major is `/v4`.** Inside it, changes are additive only, by GitHub's written lists of
  breaking and additive changes (ARCH §13.5).
- **`Fin-Version`.** `packages/contract/src/version.ts` exports
  `FIN_API_VERSION = "2026-11-23"`, `SUPPORTED_VERSIONS = ["2026-11-23"]`, `RETIRED_VERSIONS = []`
  and `RELEASED = false` (D05-25). Every answer carries `Fin-Version: 2026-11-23`. A request may send
  it: a supported date is accepted; a retired one is 410 `api_version_retired`; anything else
  (unknown or malformed) is 400 `api_version_unknown`.
- **Before production** (`RELEASED = false`): a breaking change is allowed with a changelog entry
  marked `breaking: true` (§8.9), because no developer depends on the contract yet. The owner sets
  `RELEASED = true` in the production pull request (PG-02); from then on `oasdiff breaking` fails any
  error-level change without a new version date and its translation layer, or a deprecation entry.
- **Deprecation.** A route policy may carry `deprecated: { at, sunset, changelog }`. Its answers then
  carry `Deprecation: @<unix seconds of at>` (RFC 9745), `Sunset: <HTTP-date>` (RFC 8594, never
  earlier than `at` plus 12 months) and `Link: <<docs origin>/changelog#<changelog>>;
  rel="deprecation"`. The worker's daily duty `deprecation.notify` emails the Super admins and Admins
  of every organisation whose keys called a deprecated operation in the last 30 days, from the table
  `api.deprecated_operation_use (organization_id, mode, operation_id, last_called_at)`, which `api`
  updates after the answer at most once an hour per row, for deprecated operations only. Built in
  H-08; there is no deprecated operation at launch.

### 3.7 Rate limits ([SA-19], [AP-06], ARCH §13.6)

- **Load shedding first**, before any database work: per-replica token buckets per address (IPv6 by
  /64) and in all, and the negative filter of key IDs recently found not to exist. Shedding decides
  nothing about a person. Its rates and burst sizes are settings from the private overlay
  ([OB-13]), with development defaults in `apps/edge/src/shed.ts`.
- **Then windows in Postgres**, failing closed (an error answers no request and alerts
  `rate-limiter-failing`):

| Policy name | Limit | Window | Partition (never sent) | Applies to |
|---|---|---|---|---|
| `key` | 600 | 60 s fixed | key ID | every `/v4` call with a working key |
| `refused_keys` | 30 | 60 s fixed | address or IPv6 /64 | refused keys only: past it, a refused key gets 429 instead of 401; never applied to a working key |
| `restarts_day` | 3 | UTC day | customer | `restartCustomer` (spec 03) |
| `beneficiaries_day` | 10 | UTC day | customer | `addBeneficiary` (spec 04 §17) |
| `transfers_day` | 100 | UTC day | organisation and mode | `createTransfer` (spec 04 §17) |
| `deposits_day` | 20 | UTC day | organisation | the two Sandbox deposit routes (spec 04 §17) |
| `quotes` | 60 | 60 s fixed | organisation and mode | `quoteTransfer` (spec 04 §17) |

- **Headers**, in draft-11 syntax: `RateLimit-Policy: "key";q=600;w=60` and
  `RateLimit: "key";r=<remaining>;t=<seconds to the window's end>`. A route with a domain quota adds
  its item after the edge's: `api` and `payments` append items to the headers they answer with, and
  the edge prefixes `"key"`. Daily windows give `w=86400` and `t` to the next UTC midnight. `pk` is
  never sent. No `X-RateLimit-*` headers.
- **A 429** carries `Retry-After` (seconds, the smallest `t` among violated policies) and
  `rate_limited` with `violated_policies` naming them. A shed 429 has `Retry-After: 1` and no
  `violated_policies`.
- **Cloudflare's own 429** (production rate rules, ARCH §5.7) is `application/json`, carries no
  `Request-Id`, and has the body `{"type":"<docs origin>/errors/rate_limited","title":"Too many
  requests","status":429,"code":"rate_limited","next_actor":"developer"}`. The rate-limits guide says
  so.

### 3.8 CORS (the docs origin only)

`apps/edge/src/cors.ts`, under `/v4/` only:

| Case | Answer |
|---|---|
| `OPTIONS` with `Origin` equal to `FIN_DOCS_ORIGIN` exactly and `Access-Control-Request-Method` in the list | 204 with `Access-Control-Allow-Origin: <docs origin>`, `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE`, `Access-Control-Allow-Headers: authorization, content-type, idempotency-key, fin-version`, `Access-Control-Max-Age: 7200`, `Vary: Origin`; never forwarded; no key needed |
| `OPTIONS` from any other origin, or asking for another method or header | 204 with no `Access-Control-*` header and `Vary: Origin`; `reason: cors_refused` |
| Any other method with `Origin` equal to the docs origin | the answer adds `Access-Control-Allow-Origin: <docs origin>` and `Access-Control-Expose-Headers: Request-Id, Idempotent-Replayed, RateLimit, RateLimit-Policy, Retry-After, Fin-Version, Deprecation, Sunset` |
| Any other origin, or none | no CORS header |

Never `Access-Control-Allow-Credentials`, never `*`, never a reflected origin. Spec 01 §4.5's Phase 0
skeleton lists three allowed headers; L-SUN-01 adds `fin-version` and the expose list (D05-27). The
header list grows only by a reviewed change after SP-14 records what Scalar 1.78.1 sends (§15).

### 3.9 Audit for writes through the API (R9)

Every write through the API writes its audit event in the same transaction as the change
(ARCH §8.2), through the area's domain function, with this metadata added by
`apps/api/src/platform/audit-context.ts` (and the same fields in `payments`):

| Field | Value |
|---|---|
| actor | `{ kind: "api_key", id: <key ID> }` |
| `via` | `"api"` |
| `mode` | `"test"` or `"live"` |
| `request_id` | `req_...` |
| `idempotency_key_sha256` | money events only, hex |

Reads are not audited, except the disclosures [AU-01] names: an API read of a virtual account's full
deposit instructions writes `virtual_account.instructions_revealed` (spec 04 §11.4). Key checks at
the edge are `request` lines, not audit rows.

### 3.10 Provider neutrality ([AP-14])

No provider is named in an answer, a title, a detail, an event, the OpenAPI document, an example or
the docs site. `packages/contract/src/provider-names.ts` holds the one list (every adapter's provider
name, lower case). Checks: a unit test over the error catalogue and the event catalogue; the
assembled document (T05-33); the built docs site (T05-50); spec 04's lint over every money route's
examples (AC-MON-07).

---

## 4. API keys

### 4.1 Format ([SA-18])

```
fin_<mode>_<kind>_<id><secret><checksum>
  mode     test | live                       ("test" is Sandbox, "live" is Production; [UI-08])
  kind     sk | rk                           (full access | restricted)
  id       10 characters, Crockford base32 upper case: 0-9 A-H J K M N P-T V-Z
  secret   32 characters, base62
  checksum 6 characters, base62, left-padded with "0"
```

- **Length** 60 characters. **Regex** (`KEY_REGEX` in `packages/keys/src/format.ts`):
  `^fin_(test|live)_(sk|rk)_([0-9A-HJKMNP-TV-Z]{10})([0-9A-Za-z]{32})([0-9A-Za-z]{6})$`.
- **Base62 alphabet**, in this order: `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`.
- **Checksum** (D05-08): `body` is everything before the checksum
  (`fin_<mode>_<kind>_<id><secret>`); the checksum is base62 of the unsigned CRC-32 (IEEE 802.3, the
  polynomial `zlib` uses) of the ASCII bytes of `salt + ":" + body`, as a big-endian number, left-padded
  with `0` to 6 characters (CRC-32's largest value fits: 62^6 exceeds 2^32).
- **Salts** (`packages/keys/src/salts.ts`; public, not secret):

  | Environment | Salt |
  |---|---|
  | development | `fin-dev-1` |
  | ci | `fin-ci-1` |
  | staging | `fin-stg-1` |
  | production | `fin-prod-1` |

  `KNOWN_SALTS` lists every salt ever used. A deployment's salt is the setting `FIN_KEY_SALT`, which
  must be the salt for its `FIN_ENVIRONMENT` (exit 78 otherwise). A salt changes only by appending a
  new one (`fin-prod-2`) and re-issuing keys; old salts stay in `KNOWN_SALTS` for leak checks.
- **Browser-safe.** `format.ts`, `crc32.ts` (a table-driven CRC-32 in plain TypeScript),
  `base62.ts`, `crockford.ts` and `salts.ts` import nothing but each other; `@fin/keys/format` is the
  only subpath the docs site imports. A lint rule refuses `node:*` in them. T05-01 compares
  `crc32.ts` with `node:zlib`'s `crc32` over 10,000 random inputs.
- **Display.** The console shows `fin_<mode>_<kind>_<id>` as the key's prefix, "Full access" for `sk`
  and "Restricted · n scopes" for `rk`. The key ID is safe to log and show; the secret and checksum
  never are.
- **The repository never holds a key-shaped string whose checksum verifies under any salt in
  `KNOWN_SALTS`.** `packages/keys/scripts/check-key-shapes.ts` runs in `pnpm check` over every tracked
  file (T05-03). Fixtures are generated at run time by `packages/testing`; examples in the docs and the
  document use `fin_test_sk_...` or `$FIN_KEY`.

```ts
// packages/keys/src/format.ts
export type KeyMode = "test" | "live";
export type KeyKind = "sk" | "rk";
export type ParsedKey = { mode: KeyMode; kind: KeyKind; id: string; secret: string; checksum: string; body: string };
export function parseKey(raw: string): ParsedKey | null;              // shape only
export function checksumOf(body: string, salt: string): string;      // 6 characters
export function verifyChecksum(raw: string, salt: string): boolean;   // shape and checksum
export function buildKey(mode: KeyMode, kind: KeyKind, id: string, secret: string, salt: string): string;
```

### 4.2 Generation and storage

- `packages/keys/src/generate.ts` (Node only): the ID is 10 Crockford characters from
  `crypto.getRandomValues` (50 bits); the secret is 32 base62 characters by rejection sampling over
  random bytes (no modulo bias), about 190 bits. An ID that already exists in `keys.api_key` is drawn
  again.
- **Stored hash** (D05-09): `HMAC-SHA256(pepper_v, UTF-8 bytes of body)`, over the whole body so the
  mode, kind and ID are bound to the secret. **The pepper chain:** a key moved to a newer pepper
  without its secret stores `HMAC(pepper_w, stored_hash)`, and `pepper_versions` lists the chain in
  order (`[1, 2]`). Peppers are `API_KEY_PEPPER_<n>` (at least 32 bytes) on the edge (verify), the
  console (create) and the worker (re-hash) only (ARCH §7.8); `API_KEY_PEPPER_IN_USE` names the one new
  keys use. The worker's duty `keys.rehash` moves keys to the newest pepper.
- **Shown once**, in the console's create and roll dialogs (spec 02). Fin keeps only the hash.

### 4.3 Sandbox against Production

| | Sandbox key (`fin_test_`) | Production key (`fin_live_`) |
|---|---|---|
| Works | From sign-up | Only after Fin approves the organisation's go-live (F21); 403 `live_not_enabled` before, 403 `live_paused` while paused |
| Customers | Decided by the sandbox provider from test values (spec 03) | Verified by Sumsub |
| Money | The Fin simulator ([MO-05]) | Refused with 403 `sandbox_only` on every money route until live money is enabled (PG-14); then the routed provider, and 403 `sandbox_only` again whenever the deployment's live provider instance is disabled (ARCHITECTURE §13.1 rule 6, spec 04 §25.6) |
| Sandbox routes (`/v4/sandbox/*`) | Yes | 403 `sandbox_only` |
| Try it on the docs site | Yes, with this deployment's salt | 403 `sandbox_key_required` (§9) |
| Mail to customers and people | Only to confirmed addresses of the organisation's members ([SA-40]) | As addressed |
| Webhook endpoints | https on 443 or 8443 with the challenge, or Fin's test receiver | https on 443 or 8443 with the challenge; no test receiver |
| Address allowlist | Optional | Required on a key with `money:write` or `beneficiaries:write` ([MO-20]) |
| Plain http | Refused; the organisation is emailed | Refused; the key is revoked at once and the organisation emailed ([FD-03]) |
| Data | Separate. An ID from the other mode answers 404 `not_found` | |
| Words | The API says `test` and `live`; screens and docs prose say Sandbox and Production, explained once in the authentication guide ([UI-08]) | |

### 4.4 Kinds and scopes

| Scope | Opens | The maker must hold (ARCH §7.6) |
|---|---|---|
| `customers:read` | list, search and get customers, people, documents, RFIs | `customers.read` |
| `customers:write` | create, change, delete, submit and restart customers; links; people; documents; answer RFIs | `customers.read`, `customers.create`, `customers.restart`, `customers.delete` |
| `events:read` | list and get events | `webhooks.read` |
| `money:read` | virtual accounts, balances, beneficiaries, transfers (reads); the fee quote (MS-22) | `customers.read`, `money.read` |
| `money:write` | open a virtual account; send and cancel transfers | `customers.read`, `money.read`, `money.transfer` |
| `beneficiaries:write` | add and remove beneficiaries | `customers.read`, `money.read`, `money.beneficiaries` |
| `sandbox:simulate` | Sandbox customers and the customer simulations; with `money:read`, the transfer simulations | `customers.read`, `simulator.use` |
| `sandbox:deposit` | Sandbox deposits and simulated bank deposits | `customers.read`, `simulator.use`, `money.read`, `money.simulate` |

- **Full access (`sk`)** opens every route of its mode. Making or rolling one needs every scope's
  permissions for that mode, plus `webhooks.manage`, `webhooks.roll_secret` and `webhooks.redeliver`,
  plus `sandbox.reset` for a Sandbox key. Restricted keys (`rk`) need the permissions behind each of
  their scopes. Making a Sandbox key needs `apiKey.sandbox`; a Production key `apiKey.live`
  (spec 02).
- **Full-access-only routes:** every webhook endpoint route (a signing secret is a credential) and
  `resetSandbox` (it deletes the organisation's Sandbox data, D05-12).
- **Sandbox-only scopes** (`sandbox:simulate`, `sandbox:deposit`) cannot be put on a Production key.
- The unused `quotes:write` is not carried ([MO-16]). Unknown scopes are refused at create.
- A refusal is 403 `forbidden` whose `detail` names what is missing: "This key needs the money:read
  scope." or "Use a full-access key for this."
- `KEY_SCOPE_NEEDS`, `FULL_ACCESS_NEEDS` and `scopesAllowedFor(mode)` live in
  `packages/keys/src/scopes.ts`; spec 02's permission engine reads them; T05-05 checks every route
  policy names only these scopes.

### 4.5 Address allowlists

- Up to 20 entries, each an IPv4 or IPv6 address or CIDR range, kept normalised as `cidr[]`.
- Refused at save (400 in the console, with the entry's position): private, loopback, link-local,
  CGNAT, unique-local, documentation, multicast and reserved ranges (they can never be a caller's
  address through Cloudflare); IPv4 prefixes shorter than /16 and IPv6 shorter than /32; any range
  covering Cloudflare's shared Workers egress address `2a06:98c0:3600::103`, which stands for every
  Worker on Cloudflare (D05-11).
- Matched against `CF-Connecting-IP`, trusted only for tunnel traffic (ARCH §5.5). A miss is the uniform
  401. `payments` re-checks the allowlist from the key record on money writes ([MO-20], [SA-36]).

### 4.6 Lifecycle (functions in `packages/keys/src/lifecycle.ts`, called by the console's API half)

| Rule | Value |
|---|---|
| Expiry | 30 days, 90 days, a year or never, chosen at create |
| Roll | A new key with the same scopes, allowlist and expiry; the old key keeps working for now, 1 hour or 24 hours ([SA-20]), never past its own expiry; `replaced_by` and `rolling_until` set |
| Edit | The name changed; scopes only narrowed; expiry only shortened; the allowlist changed. Every edit, a name alone included, takes a step-up intent, is audited and emailed (ARCH §7.7, [SA-34]) |
| Limit | 50 working keys per organisation, a rolling old key not counted |
| Step-up | An intent for create, every edit (the name included), roll and revoke (ARCH §7.4, §7.7, spec 02) |
| Last used | `last_used_at` rounded down to the minute, written after the answer at most once a minute per key ([BC-05]) |
| Statuses (derived, shown by the console) | `active`; `rolling` (until `rolling_until`); `expired` (`expires_at` passed); `revoked` |
| When a maker leaves or is demoted | Spec 02 lists and by default rolls the keys they made or saw ([SA-33]); a key whose maker no longer holds the permissions behind its scopes is flagged in the console |
| A notice that cannot be queued | The action is refused ([SA-41]) |

### 4.7 Verification at the edge

The edge runs §2.1 steps 12 to 19 with `packages/keys/src/verify.ts`:

- Hash even when the record is missing, so the timing of an unknown key is close to a wrong one.
- A record missing any field reads as unknown. Any non-null `revoked_at` is revoked. An unreadable
  `expires_at` is expired. A `pepper_versions` entry the edge does not hold refuses the key and raises
  `pepper-missing` (§10.2).
- The refusal reason goes into the `request` line as `keyReason` (`malformed`, `checksum`,
  `other_deployment` (the checksum verifies under another known salt), `unknown`, `revoked`,
  `expired`, `ip_not_allowed`, `pepper_missing`, `missing`). The answer never says which: every
  refusal is the same 401 body apart from `request_id` (T05-08).
- There is no positive cache: a revocation stops the key on the next request.

### 4.8 Keys that leak

**Plain http** ([FD-03], ARCH §5.6). After the 403 `https_required` answer, if the bearer passes the
shape and checksum, the edge calls `api`'s door operation `keys.exposed` with `{ key_id, source:
"plain_http" }`. `api` (`packages/keys/src/exposure.ts`): a live key is revoked at once
(`revoked_reason: "sent_in_clear"`), audited `api_key.revoked` with the system as actor, and
`api-keys/key-exposed` is emailed to the Super admins and Admins; a Sandbox key gets the audit event
`api_key.exposed` and the same email, and keeps working. Line `key.sent_in_clear`; alert
`key-sent-in-clear` (§10.2).

**GitHub's secret scanning partner programme** ([SA-21], before production holds live keys):

- Two patterns registered with GitHub: `fin_live_api_key`
  `\bfin_live_(?:sk|rk)_[0-9A-HJKMNP-TV-Z]{10}[0-9A-Za-z]{38}\b` and `fin_test_api_key` the same with
  `test`.
- `POST /hooks/github/secret-scanning` on the edge (`apps/edge/src/hooks/github.ts`): body capped at
  1 MB, limited per address; the ECDSA P-256 SHA-256 signature in `Github-Public-Key-Signature`
  verified with the key named by `Github-Public-Key-Identifier` from GitHub's published key set,
  cached and refreshed at most once per 10 minutes whatever identifier arrives; then for each
  `{ token, type, url, source }`: shape, checksum against every salt in `KNOWN_SALTS`, the HMAC with
  the pepper. A match calls `keys.exposed` with `{ key_id, source: "secret_scanning" }`; `api`
  revokes the key whatever its mode (D05-10, recorded in [SA-21]), audits, emails and writes
  `key.leaked`. The answer is
  200 within 10 seconds; work past that runs after the answer. Never logged: the token or its URL.
- Feedback to GitHub (`true_positive` by token hash) is optional and later.

### 4.9 Data

| Object | Shape | Grants (`packages/db/roles/grants/keys.json`) |
|---|---|---|
| `keys.api_key` | `id` (the 10-character key ID, primary key), `organization_id`, `mode`, `kind`, `name`, `scopes text[]`, `ip_allowlist cidr[]`, `hash bytea`, `pepper_versions smallint[]`, `created_by` (`usr_`), `created_at`, `expires_at`, `revoked_at`, `revoked_reason` (`member`, `maker_removed`, `sent_in_clear`, `leaked_public`, `organisation_deleted`), `replaced_by`, `rolling_until`, `last_used_at`, `seen_by text[]` (who was shown the secret, [SA-33]) | `fin_console` insert, update (create, edit, roll, revoke); `fin_api` execute `keys.revoke_exposed(key_id, reason)` only; `fin_worker` update `hash`, `pepper_versions` only; `fin_edge` and `fin_payments` select on the view only |
| `keys.key_lookup` (view) | `id`, `organization_id`, `mode`, `kind`, `scopes`, `ip_allowlist`, `hash`, `pepper_versions`, `expires_at`, `revoked_at`, `rolling_until`, `org_live_status` (`not_enabled`, `enabled`, `paused`, derived from `identity.organization.live_status`: `approved` is `enabled`, `paused` is `paused`, every other value is `not_enabled`; spec 03 §3.7) | as above |
| `keys.touch_last_used(key_id)` | `UPDATE ... SET last_used_at = date_trunc('minute', now()) WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < date_trunc('minute', now()))` | `fin_edge` execute |

The edge's one statement (§2.1 step 15) reads the view row, the address's `refused_keys` window from
`ops.rate_window` and the `live_keys` switch from `ops.kill_switch` together; its SQL lives in
`packages/keys/src/lookup.ts` with an `EXPLAIN` test. There is no database switch for the whole
public API ([OP-01], ARCHITECTURE §15.1): all of `api.` but `/hooks/` is stopped by the
prepared Cloudflare rule `killswitch-api` (spec 08 §8.6), unless the owner first adds such a
switch to [OP-01].

### 4.10 Audit events and emails (`packages/audit/src/events/api-keys.ts`; category `api_keys`, scope `organisation`)

This spec owns these names; spec 08 §3.4 and §4.4 list them as the canonical catalogue (spec 08
D08-33), and spec 02 §12.3, §16.5 and §17.2 use them.

| Event | Written by | Metadata (IDs and names only) |
|---|---|---|
| `api_key.created` | console | `key_id`, `mode`, `kind`, `scopes`, `expires_at`, `allowlist_count`, `shown_to` |
| `api_key.updated` | console | `key_id`, `changed` (field names), `scopes_removed`, `expiry_shortened`, `allowlist_count` |
| `api_key.rolled` | console | `key_id`, `new_key_id`, `overlap` (`now`, `1h`, `24h`: the request's value, spec 02 §12.3), `shown_to` |
| `api_key.revoked` | console, or `api` for exposures | `key_id`, `reason`, `source` (for exposures: `plain_http`, `secret_scanning`) |
| `api_key.exposed` | `api` | `key_id`, `source`; a Sandbox key sent over plain http, which is not revoked (a reported one is, §4.8) |

| Template (`packages/email/src/templates/api-keys/`) | To | When |
|---|---|---|
| `key-changed` | every member (ARCH §7.7) | created, edited (a name alone included), rolled, revoked; a security notice, never dropped ([SA-41]) |
| `key-exposed` | Super admins and Admins | sent over plain http or reported by GitHub; says what happened and whether the key was revoked; no key material |

Each event has a test that fails when it is not written (AGENTS rule); each email a test that it is
queued in the same transaction.

---

## 5. Webhooks and events

### 5.1 The event catalogue ([AP-07])

`packages/contract/src/schemas/event-catalogue.ts` (L-SUN-04) holds each type, its emitting role,
its group and its `data` schema; `packages/events` and the OpenAPI `webhooks` section are built from
it.

| Type | Emitted by (`events.emit()` refuses other roles) | When | `data` |
|---|---|---|---|
| `customer.created` | `fin_api`, `fin_worker` | a customer is created (API, console, Sandbox) | `{ object: "customer", id, type, status, status_detail }` |
| `customer.updated` | `fin_api`, `fin_worker` | details, `status_detail` or a non-final status change | as above |
| `customer.approved`, `customer.action_required`, `customer.rejected` | `fin_api`, `fin_worker` | the status moves there | as above |
| `customer.deleted` | `fin_api`, `fin_worker` | deleted by the developer, or the 90-day Sandbox purge | `{ object: "customer", id, type, deleted: true }` |
| `person.updated`, `person.approved`, `person.rejected` | `fin_api`, `fin_worker` | a business's person changes or is decided (new) | `{ object: "person", id, customer_id, status }` |
| `document.updated` | `fin_api`, `fin_worker` | a document's status changes (new) | `{ object: "document", id, customer_id, person_id, status }` |
| `rfi.created`, `rfi.updated` | `fin_api`, `fin_worker` | | `{ object: "rfi", id, customer_id, status }` |
| `virtual_account.created`, `virtual_account.closed` | `fin_payments` | spec 04 §11 | `{ object: "virtual_account", id, customer_id, status }` |
| `beneficiary.created`, `beneficiary.deleted` | `fin_payments` | spec 04 §12 | `{ object: "beneficiary", id, customer_id, rail, status }` |
| `transfer.created`, `transfer.updated`, `transfer.completed`, `transfer.failed`, `transfer.returned` | `fin_payments` | spec 04 §13, §14 | `{ object: "transfer", id, customer_id, direction, kind, status, reason }` |
| `webhook.test` | `fin_api` | `sendTestEvent` | `{ object: "webhook_endpoint", id }` |

- **Groups** for `enabled_events`: `customer.*`, `person.*`, `document.*`, `rfi.*`,
  `virtual_account.*`, `beneficiary.*`, `transfer.*`, and `*` (every subscribable type).
  `webhook.test` is not subscribable; a test always reaches its endpoint.
- **Normalised** on save: duplicates removed, names a group covers removed, `["*"]` alone if present;
  an unknown name or group is 400 `invalid_events`.
- **Thin:** `data` holds IDs and statuses only; never a name, an email, an amount or an account number
  (T05-30).
- **No ordering promise.** The webhooks guide tells developers to read the resource again when order
  matters and to drop a `webhook-id` they have seen.
- Every event is listed by `GET /v4/events`, whether or not an endpoint took it. Events are kept 13
  months (ARCH §6.8).

### 5.2 Payload and signing (Standard Webhooks `v1`, ARCH §7.10)

- **Body**, the exact bytes sent on every attempt: `JSON.stringify({ id, type, timestamp, data })` in
  that key order, where `timestamp` is the event's creation time in RFC 3339 with milliseconds. `id`
  equals `webhook-id`. The `Event` resource of `GET /v4/events` keeps `created_at`; only the webhook
  body uses `timestamp` (D05-36).
- **Headers:** `webhook-id` (the event ID; for a challenge, the delivery ID, §5.3.3),
  `webhook-timestamp` (Unix seconds of this attempt), `webhook-signature` (`v1,<base64 of
  HMAC-SHA256(secret bytes, id + "." + timestamp + "." + body)>`), `content-type: application/json`,
  `user-agent: Fin-Webhooks/1`.
- **Secret:** `whsec_` plus standard base64 (with padding) of 32 random bytes, 50 characters in all;
  the HMAC key is the 32 decoded bytes. Unique per endpoint. Sealed at rest with `api`'s seal key
  (`packages/crypto`), opened only by the worker to sign and by `api` to show it once. Never logged,
  audited or stored in an idempotency row.
- **Roll:** for 24 hours after a roll both secrets sign; `webhook-signature` carries the new
  signature first, then a space, then the old one.
- **Signing** is `node:crypto` in `packages/events/src/signing.ts`; no library. Receivers are told to
  allow ±5 minutes on `webhook-timestamp`.
- **The fixed vector** (T05-31; the guides' Node and Python verifiers are tested against it in CI):
  secret bytes `0x00, 0x01, ..., 0x1f`; `webhook-id` `evt_00000000000000000000000000`;
  `webhook-timestamp` `1764000000`; body
  `{"id":"evt_00000000000000000000000000","type":"webhook.test","timestamp":"2025-11-24T16:00:00.000Z","data":{"object":"webhook_endpoint","id":"whe_00000000000000000000000000"}}`;
  expected signature `v1,0pIoJaZPZmz1dJvLsfXRZQ/pnUOpdhK3RCPo6OxRfsM=`. The test builds the `whsec_`
  string from the bytes at run time; no secret-shaped literal is committed.

### 5.3 Endpoints

#### 5.3.1 The resource

`WebhookEndpoint`: `id` (`whe_`), `object: "webhook_endpoint"`, `url` (null for Fin's test
receiver), `fin_test_receiver` (boolean), `description` (at most 200 characters, through
`packages/identity/src/names.ts`'s free-text rule), `enabled_events`, `status` (`verifying`,
`unverified`, `active`, `failing`, `paused`, `disabled`), `paused_reason` (`developer` or `failing`
while `paused`, otherwise null), `failing_since`, `verified_at`, `created_at`, `updated_at`.
`WebhookEndpointWithSecret` adds `secret` and is answered only by create and roll.

Limits: 10 endpoints per organisation and mode (409 `too_many_endpoints`).

#### 5.3.2 States (D05-16)

| From | Event | To | Side effects |
|---|---|---|---|
| (none) | created with a `url` | `verifying` | the challenge (§5.3.3) is queued |
| (none) | created with `fin_test_receiver: true` (Sandbox only; a live key gets 403 `sandbox_only`) | `active` | `verified_at` now |
| `verifying` | the challenge is answered | `active` | `verified_at`; audit `webhook_endpoint.verified` |
| `verifying` | the third challenge try fails | `unverified` | audit `webhook_endpoint.verification_failed` |
| `unverified` | `PATCH { "status": "active" }` | `verifying` | challenge queued again |
| any | `PATCH { "url": ... }` | `verifying` | step-up intent in the console ([SA-34]); pending deliveries held as `paused`; audit `webhook_endpoint.url_changed`; email |
| `active` | 5 failed attempts in a row | `failing` | `failing_since` |
| `failing` | a 2xx | `active` | `failing_since` null |
| `active`, `failing` | `PATCH { "status": "paused" }` | `paused` (`developer`) | pending deliveries become `paused` |
| `active`, `failing` | a delivery ends its 15th try with no success at this endpoint since that delivery's first try | `paused` (`failing`) | its pending deliveries become `paused`; email `endpoint-paused` |
| `active`, `failing` | an attempt answered 410 Gone | `disabled` ([AP-07]) | its pending deliveries become `paused` (held); new events create none for it; audit `webhook_endpoint.disabled`; email `endpoint-paused` |
| `paused`, `disabled` | `PATCH { "status": "active", "held_deliveries": "send" or "skip" }` | `active` if paused by the `developer`; `verifying` if paused for `failing`, or if `disabled` (the challenge runs again) | held deliveries go back to `pending` with a fresh schedule, or become `skipped`; `held_deliveries` is required when any are held, else 400 `invalid_held_deliveries` |
| any | `DELETE` | (deleted) | its deliveries are deleted; audit; email |

Events create deliveries only for endpoints in `active` or `failing` (as `pending`) and in `paused`
(as `paused`, so a resume can send them). `verifying`, `unverified` and `disabled` endpoints get none:
a `disabled` endpoint keeps only what it held when the 410 came.

#### 5.3.3 The challenge ([AP-07], [SA-40])

Sent by the worker through `deliveryFetch`, at once, then 10 seconds and 60 seconds after a failure,
each with a 15-second limit (D05-17). It is a delivery row of kind `challenge`, signed like any
delivery:

```json
{ "id": "whd_...", "type": "webhook_endpoint.challenge", "timestamp": "...",
  "data": { "object": "webhook_endpoint", "id": "whe_...", "challenge": "<43 base64url characters of 32 random bytes>" } }
```

The endpoint passes by answering 2xx within 15 seconds with either `application/json`
`{ "challenge": "<the same value>" }` or `text/plain` holding exactly the value (whitespace trimmed),
in the first 1 KB. Anything else is a failed try. The challenge type is not an event: it is not in
the catalogue, not subscribable and not listed by `GET /v4/events`. Standard Webhooks' endpoint
verification extension replaces it for live endpoints later (ARCH §13.7).

#### 5.3.4 URL rules (`packages/events/src/url-rules.ts`), at save and before every attempt

`https` only; port 443 or 8443 (explicit or default); no user or password; no fragment; at most 2,048
characters; the host not an IP literal, not `localhost`, and not ending in `.localhost`, `.local`,
`.internal`, `.lan`, `.home.arpa`, `.arpa`, `.test`, `.invalid` or `.example`; not under any zone in
the setting `FIN_OWN_ZONES`; then `deliveryFetch`'s resolution checks (ARCH §7.11), which also run at save
time. A refusal is 400 `invalid_url` with `reason` one of `scheme`, `port`, `credentials`, `host`,
`own_zone`, `private_address`, `too_long`. The URL is never logged, audited or sent to Better Stack:
developers sometimes put tokens in it.

#### 5.3.5 Fin's test receiver ([AP-20])

An endpoint row with `fin_test_receiver = true` and no URL, Sandbox only. The worker delivers to it
in-process through the same signing code into `packages/events/src/test-receiver.ts`, which verifies
the signature as a developer's server would and records `response_code` 200 (valid) or 401 (invalid)
with `signature_valid`. It has no route; `deliveryFetch` keeps refusing Fin's own zones with no
exception.

### 5.4 Delivery

| Rule | Value |
|---|---|
| Attempt | `POST` through `deliveryFetch` from the worker's static addresses; connect 5 s, 15 s in all; redirects not followed; at most 1 KB of the answer kept |
| Success | Any 2xx. A 3xx is a failure (`outcome: redirect`) |
| 410 Gone | Disables the endpoint ([AP-07]), §5.3.2 |
| 429, 503 with `Retry-After` | The next try waits for the later of the schedule and `Retry-After`, capped at 12 hours |
| Tries | 15 ([BC-04]) |
| Schedule (`RETRY_DELAYS_S` in `packages/events/src/schedule.ts`) | at once, then 5 s, 5 min, 30 min, 1 h, 2 h, 3 h, 4 h, 5 h, 6 h, 8 h, 10 h, 10 h, 12 h, 12 h after each failure: about 3 days 1 hour |
| Jitter | each delay times a uniform factor in [0.9, 1.1] (the 5 s delay in [4 s, 6 s]) |
| Endpoint marked failing | after 5 failed attempts in a row |
| A delivery's end | `failed` when its 15th try fails and the endpoint has had a success since that delivery's first try; otherwise the endpoint pauses and the delivery is held (§5.3.2) |
| Caps (D05-18) | 5 deliveries in flight per endpoint; 20 in flight per target host across every organisation; 600 attempts per minute per target host (a window in `ops.rate_window` keyed by a hash of the host). A capped delivery waits; its try is not counted |
| Kill switch | While `outbound_webhooks` is on, nothing is claimed and no try is counted; `switch.refused` lines |
| Manual retry (`retryDelivery`) | On `retrying`: one attempt now, not counted unless it succeeds; on `pending`: its first attempt now; on `succeeded`, `failed` or `skipped`: a new delivery of the same event with `retry_of`. 409 `endpoint_paused` while the endpoint is paused or disabled, 409 `not_sendable` for a challenge |
| Retention | Deliveries 30 days, then deleted by the daily `webhook.sweep` |
| Addresses | The worker's static outbound addresses are published in the webhooks guide, noting Railway may share them with other customers (ARCH §4.4) |

**The dispatcher** (`apps/api/src/worker/webhooks/`): woken by `LISTEN events_due` or every 5 s;
claims up to 50 due deliveries with `FOR UPDATE SKIP LOCKED` under the caps, sets `in_flight_until =
now() + 60 s`, sends at most 20 at once per worker replica, applies each outcome in its own
transaction, writes a `webhook.delivery` line per attempt and a `job.run` line (`job:
webhook.dispatch`) per pass, and pings the `webhook-dispatcher` heartbeat every 60 s (§10.3).

**Delivery statuses** (public): `pending`, `retrying`, `succeeded`, `failed`, `paused`, `skipped`.

### 5.5 Data (schema `events`, migrations `packages/db/migrations/<ts>_events_*.sql`)

| Table | Columns |
|---|---|
| `events.event` | `id` (`evt_`), `organization_id`, `mode`, `type`, `data jsonb`, `subject_ids text[]` (for filters: the customer and RFI IDs), `created_at` |
| `events.endpoint` | `id` (`whe_`), `organization_id`, `mode`, `url`, `url_host` (lower case, for caps), `fin_test_receiver`, `description`, `enabled_events text[]`, `status`, `paused_reason`, `consecutive_failures`, `failing_since`, `verified_at`, `secret_sealed`, `previous_secret_sealed`, `previous_secret_until`, `seen_by text[]` ([SA-33]), `created_by`, `created_at`, `updated_at` |
| `events.delivery` | `id` (`whd_`), `organization_id`, `mode`, `endpoint_id`, `event_id` (null for a challenge), `kind` (`event`, `test`, `challenge`), `event_type`, `status`, `attempts`, `next_attempt_at`, `in_flight_until`, `last_attempt_at`, `delivered_at`, `response_code`, `duration_ms`, `last_outcome`, `response_snippet` (at most 1 KB, control characters removed; shown to the developer only), `signature_valid` (test receiver), `retry_of`, `created_at` |

`events.emit(tx, { organizationId, mode, type, data, subjectIds })` is a checked SQL function
([DA-14]) that refuses a type not allowed for `current_user`, inserts the event and one delivery per
matching endpoint in one statement, and `NOTIFY events_due`. Indexes: `delivery (status,
next_attempt_at)`, `delivery (endpoint_id, created_at DESC, id DESC)`, `event (organization_id, mode,
created_at DESC, id DESC)`, `event USING gin (subject_ids)`, each with an `EXPLAIN` test.

Grants (`packages/db/roles/grants/events.json`): `fin_api` and `fin_worker` read and write;
`fin_payments` execute `events.emit` only; nobody else.

### 5.6 The console's use

The console's Webhooks and Events screens (spec 03, L-SUN-07) call `api`'s door operations
`webhooks.*` (`packages/server/src/doors/webhooks.ts`), which call the same `packages/events`
functions as the public routes, with the console's step-up kinds of ARCH §7.6 (`webhooks.manage`: intent
to create, delete or change the URL; window to pause, resume or change events; `webhooks.roll_secret`:
intent; `webhooks.redeliver`: window). Webhook analytics come back in H-02 from an aggregate app route
([BC-02]); there is no public route for them.

### 5.7 Audit events and emails (`packages/audit/src/events/webhooks.ts`; category `webhooks`, scope `organisation`)

This spec owns these names; spec 08 §3.4 and §4.4 list them as the canonical catalogue (spec 08
D08-33), and spec 03 §12.1 and §16.5 use them.

| Event | Metadata (never the URL or the secret) |
|---|---|
| `webhook_endpoint.created` | `endpoint_id`, `mode`, `test_receiver`, `events` (names), `shown_to` |
| `webhook_endpoint.updated` | `endpoint_id`, `changed` (field names) |
| `webhook_endpoint.events_changed` | `endpoint_id`, `from`, `to` (names) |
| `webhook_endpoint.url_changed` | `endpoint_id` |
| `webhook_endpoint.secret_rolled` | `endpoint_id`, `shown_to` |
| `webhook_endpoint.deleted` | `endpoint_id` |
| `webhook_endpoint.test_sent` | `endpoint_id`, `event_id` |
| `webhook_endpoint.verified`, `webhook_endpoint.verification_failed` | `endpoint_id`, `tries` (system actor) |
| `webhook_endpoint.paused` | `endpoint_id`, `reason` (`developer` with the actor; `failing` with the system actor) |
| `webhook_endpoint.disabled` | `endpoint_id`, `response_code` (410; system actor) |
| `webhook_endpoint.resumed` | `endpoint_id`, `held` (`send`, `skip`, `none`) |
| `webhook_delivery.retried` | `endpoint_id`, `delivery_id`, `new_delivery_id` |

| Template (`packages/email/src/templates/webhooks/`) | To | When |
|---|---|---|
| `endpoint-changed` | Super admins and Admins | created, URL changed, secret rolled, deleted (a signing secret is a credential; D05-20); a security notice ([SA-41]) |
| `endpoint-paused` | Super admins and Admins | paused for `failing`, or disabled by a 410 Gone (the email says which) |

---

## 6. The routes: the endpoint inventory by day

### 6.1 The route policy

Every operation has one row in `packages/contract/src/policy/<area>.ts`, joined to its `createRoute`
object by `operationId` (a test fails when either is missing):

```ts
export type RoutePolicy = {
  operationId: string;
  area: string;                                   // the fragment name
  day: "sat" | "sun" | "mon";
  answeredBy: "edge" | "api" | "payments";        // payments: api forwards the assertion unchanged
  keyKind: "any" | "full_access";
  scopes: readonly Scope[];                       // all required, for a restricted key
  mode: "any" | "sandbox_only";
  liveMoney: boolean;                             // a live key is refused with sandbox_only until PG-14
  idempotency: "none" | "accepted" | "accepted_by_state" | "accepted_permanent" | "required_permanent";
  secretBearing: boolean;
  quotas: readonly QuotaPolicyName[];             // RateLimit items beyond "key"
  body: "none" | "json" | "multipart";
  deprecated?: { at: string; sunset: string; changelog: string };
};
```

The edge enforces `keyKind`, `scopes`, `mode` and `liveMoney` (§2.1 step 18); `api` re-checks them
from the assertion; `payments` re-reads the key record for money ([SA-36]). Every `/v4` operation can
also answer 400 `invalid_request`, 401, 403 `forbidden`, `live_not_enabled`, `live_paused`, 404, 413
and 415 where it takes a body, 429, 500 and 503; the tables list only the codes beyond these.
Statuses, reasons and fields keep the old product's shapes (ARCH §12.16) apart from money's `amount` and
`currency` and the webhook body's `timestamp`. `operationId`s keep the old product's names, so the
docs anchors stay stable; summaries use the new words ("Sandbox customers") (D05-13). Four
operations are new: `searchCustomers`, `listVirtualAccounts`, `quoteTransfer`, `resetSandbox`.

Key: `any` any working key; `full` a full-access key only; a scope name a restricted key needs.
Idempotency: `none`, `acc` accepted, `state` accepted by state, `perm?` accepted and permanent,
`perm!` required and permanent; a trailing `S` marks a secret-bearing route.

### 6.2 Saturday (stretch, L-SAT-11; else Sunday's spill block): 1 operation

| operationId | Method and path | Key | Mode | Idem. | 2xx | Beyond the common codes |
|---|---|---|---|---|---|---|
| `getApiKey` | `GET /v4/whoami` (answered by the edge) | any | any | none | 200 `ApiKey` | none |

### 6.3 Sunday, customers (L-SUN-05 with spec 03): 9 operations

| operationId | Method and path | Key | Mode | Idem. | 2xx | Beyond the common codes |
|---|---|---|---|---|---|---|
| `createCustomer` | `POST /v4/customers` | `customers:write` | any | acc | 201 `Customer` | 409 `external_id_used` (adds `customer_id`); 422 `invalid_answers` |
| `listCustomers` | `GET /v4/customers` (`status`, `type`, `external_id`, `created_gte`, `created_lt`, paging) | `customers:read` | any | none | 200 list of `Customer` | 400 `cursor_invalid` |
| `searchCustomers` (new, [AP-18]) | `POST /v4/customers/search` (body exactly one of `email`, `phone` (E.164), `name`; `limit`, `cursor`) | `customers:read` | any | none | 200 list of `Customer` | 400 `cursor_invalid` |
| `getCustomer` | `GET /v4/customers/{id}` | `customers:read` | any | none | 200 `CustomerDetail` | none |
| `updateCustomer` | `PATCH /v4/customers/{id}` | `customers:write` | any | none | 200 `Customer` | 409 `customer_locked`; 422 `invalid_answers` |
| `deleteCustomer` | `DELETE /v4/customers/{id}` | `customers:write` | any | acc | 200 `Deleted` | 409 `customer_not_deletable` |
| `submitCustomer` | `POST /v4/customers/{id}/submit` | `customers:write` | any | acc | 200 `Customer` | 400 `customer_incomplete` (adds `missing`); 409 `customer_submitted`; 502 |
| `createCustomerLink` | `POST /v4/customers/{id}/links` | `customers:write` | any | acc S | 201 `Link` | 409 `customer_locked` |
| `restartCustomer` | `POST /v4/customers/{id}/restart` | `customers:write` | any | acc S | 200 `RestartedCustomer` | 409 `customer_not_rejected`, `restart_not_allowed`; 429 `restart_limit` |

### 6.4 Sunday, documents and people (L-SUN-05 with spec 03): 9 operations

| operationId | Method and path | Key | Mode | Idem. | 2xx | Beyond the common codes |
|---|---|---|---|---|---|---|
| `uploadDocument` | `POST /v4/customers/{id}/documents` (multipart: `type`, `side`, `country`, `file`) | `customers:write` | any | acc | 201 `UploadedDocument` | 409 `company_type_missing`, `customer_locked`, `sandbox_quota`; 413 `file_too_large`; 422 `document_refused`, `document_unreadable`; 502 |
| `listDocuments` | `GET /v4/customers/{id}/documents` | `customers:read` | any | none | 200 list of `Document` | none |
| `addPerson` | `POST /v4/customers/{id}/people` | `customers:write` | any | acc | 201 `Person` | 400 `invalid_roles`, `invalid_ownership`, `ownership_over`; 409 `not_business`, `email_used`, `too_many_people` |
| `listPeople` | `GET /v4/customers/{id}/people` | `customers:read` | any | none | 200 list of `Person` | none |
| `getPerson` | `GET /v4/customers/{id}/people/{person_id}` | `customers:read` | any | none | 200 `Person` | none |
| `updatePerson` | `PATCH /v4/customers/{id}/people/{person_id}` | `customers:write` | any | none | 200 `Person` | 409 `person_locked` |
| `removePerson` | `DELETE /v4/customers/{id}/people/{person_id}` | `customers:write` | any | acc | 200 `Deleted` | 409 `person_locked` |
| `uploadPersonDocument` | `POST /v4/customers/{id}/people/{person_id}/documents` (multipart) | `customers:write` | any | acc | 201 `UploadedDocument` | as `uploadDocument` |
| `createPersonLink` | `POST /v4/customers/{id}/people/{person_id}/links` | `customers:write` | any | acc S | 201 `Link` | 409 `person_locked` |

### 6.5 Sunday, requests for information and events (L-SUN-05): 5 operations

| operationId | Method and path | Key | Mode | Idem. | 2xx | Beyond the common codes |
|---|---|---|---|---|---|---|
| `listRfis` | `GET /v4/rfis` (`customer_id`, `status`, `created_gte`, `created_lt`, paging) | `customers:read` | any | none | 200 list of `Rfi` | 400 `cursor_invalid` |
| `getRfi` | `GET /v4/rfis/{id}` | `customers:read` | any | none | 200 `Rfi` | none |
| `answerRfi` | `POST /v4/rfis/{id}/answer` | `customers:write` | any | acc | 200 `Rfi` | 400 `rfi_incomplete` (adds `missing`), `invalid_document`, `invalid_note`, `too_many_documents`; 409 `rfi_closed`, `rfi_forms` |
| `listEvents` | `GET /v4/events` (`type` (a name or a group), `customer_id`, `rfi_id`, `created_gte`, `created_lt`, paging; D05-15) | `events:read` | any | none | 200 list of `Event` | 400 `invalid_events`, `cursor_invalid` |
| `getEvent` | `GET /v4/events/{id}` | `events:read` | any | none | 200 `EventDetail` | none |

### 6.6 Sunday, webhook endpoints (L-SUN-05 routes on L-SUN-04's `packages/events`): 9 operations

| operationId | Method and path | Key | Mode | Idem. | 2xx | Beyond the common codes |
|---|---|---|---|---|---|---|
| `createWebhookEndpoint` | `POST /v4/webhook_endpoints` (`url` or `fin_test_receiver: true`; `description`; `enabled_events`) | full | any | acc S | 201 `WebhookEndpointWithSecret` | 400 `invalid_url`, `invalid_events`, `invalid_description`; 403 `sandbox_only`; 409 `too_many_endpoints` |
| `listWebhookEndpoints` | `GET /v4/webhook_endpoints` | full | any | none | 200 list of `WebhookEndpoint` | none |
| `getWebhookEndpoint` | `GET /v4/webhook_endpoints/{id}` | full | any | none | 200 `WebhookEndpoint` | none |
| `updateWebhookEndpoint` | `PATCH /v4/webhook_endpoints/{id}` (`url`, `description`, `enabled_events`, `status`, `held_deliveries`) | full | any | none | 200 `WebhookEndpoint` | 400 `invalid_url`, `invalid_events`, `invalid_description`, `invalid_status`, `invalid_held_deliveries` |
| `deleteWebhookEndpoint` | `DELETE /v4/webhook_endpoints/{id}` | full | any | acc | 200 `Deleted` | none |
| `rollWebhookSecret` | `POST /v4/webhook_endpoints/{id}/roll_secret` | full | any | acc S | 200 `WebhookEndpointWithSecret` | none |
| `sendTestEvent` | `POST /v4/webhook_endpoints/{id}/test` | full | any | acc | 202 `TestEventSent` | 409 `endpoint_paused`, `endpoint_not_verified` |
| `listDeliveries` | `GET /v4/webhook_endpoints/{id}/deliveries` (`status`, `event_type`, paging) | full | any | none | 200 list of `WebhookDelivery` | 400 `cursor_invalid` |
| `retryDelivery` | `POST /v4/webhook_endpoints/{id}/deliveries/{delivery_id}/retry` | full | any | acc | 202 `DeliveryRetry` | 409 `not_sendable`, `endpoint_paused` |

### 6.7 Sunday, Sandbox customers (L-SUN-05 with spec 03): 8 operations

| operationId | Method and path | Key | Mode | Idem. | 2xx | Beyond the common codes |
|---|---|---|---|---|---|---|
| `createTestCustomers` | `POST /v4/sandbox/customers` (`type`, `outcome`, `count` 1 to 50, `company_type`) | `sandbox:simulate` | sandbox | acc | 201 list of `Customer` | 400 `invalid_count` |
| `simulateSubmit` | `POST /v4/sandbox/customers/{id}/submit` | `sandbox:simulate` | sandbox | acc | 200 `Customer` | 409 `transition_refused` (adds `current_status`) |
| `simulateApprove` | `POST /v4/sandbox/customers/{id}/approve` | `sandbox:simulate` | sandbox | acc | 200 `Customer` | 409 `transition_refused` |
| `simulateRequestResubmission` | `POST /v4/sandbox/customers/{id}/request_resubmission` (`reason`) | `sandbox:simulate` | sandbox | acc | 200 `Customer` | 400 `invalid_reason`; 409 `transition_refused` |
| `simulateReject` | `POST /v4/sandbox/customers/{id}/reject` | `sandbox:simulate` | sandbox | acc | 200 `Customer` | 409 `transition_refused` |
| `simulateRequestInformation` | `POST /v4/sandbox/customers/{id}/request_information` (`forms` or `items`) | `sandbox:simulate` | sandbox | acc | 200 `Customer` | 400 `invalid_items`, `invalid_forms`; 409 `form_takes_id`, `rfi_open` |
| `simulateUnapprove` | `POST /v4/sandbox/customers/{id}/unapprove` | `sandbox:simulate` | sandbox | acc | 200 `Customer` | 409 `transition_refused` |
| `resetSandbox` (new, [AP-16]) | `POST /v4/sandbox/reset` | full | sandbox | acc | 200 `SandboxReset` | none |

`resetSandbox` deletes the organisation's Sandbox customers, their people, documents, links, RFIs,
events and deliveries, and (from Monday, spec 04) its Sandbox money rows; endpoints and keys stay.
Spec 03 defines what it writes (audit `customer.sandbox_reset`). Its answer is `{ "object":
"sandbox_reset", "deleted": { "customers": n, "events": n } }`.

### 6.8 Monday, money (L-MON-05 with spec 04 §25): 13 operations

This spec owns the names and conventions here: the operation IDs, paths, scopes and the paging and
filter parameters of §3.5 (README §8.3). Spec 04 §25 owns the bodies, answers, codes and the money
door operations behind each route, and the 2xx column below follows it. Every money route is `liveMoney: true` (403 `sandbox_only` with a live key until PG-14) and
answered by `payments` through `api`.

| operationId | Method and path | Key | Idem. | 2xx |
|---|---|---|---|---|
| `getVirtualAccount` | `GET /v4/customers/{id}/virtual_account` (full deposit instructions; audited reveal, spec 04 §11.4) | `money:read` | none | 200 `VirtualAccount` |
| `openVirtualAccount` | `POST /v4/customers/{id}/virtual_account` | `money:write` | state | 201 `VirtualAccount` for a new account, 200 the existing one |
| `listVirtualAccounts` (new) | `GET /v4/customers/{id}/virtual_accounts` (never instructions) | `money:read` | none | 200 list of `VirtualAccount` |
| `getBalance` | `GET /v4/customers/{id}/balance` | `money:read` | none | 200 `Balance` |
| `addBeneficiary` | `POST /v4/customers/{id}/beneficiaries` | `beneficiaries:write` | perm? | 201 `Beneficiary` |
| `listBeneficiaries` | `GET /v4/customers/{id}/beneficiaries` (`include_removed`, paging) | `money:read` | none | 200 list of `Beneficiary` |
| `getBeneficiary` | `GET /v4/customers/{id}/beneficiaries/{beneficiary_id}` | `money:read` | none | 200 `Beneficiary` |
| `removeBeneficiary` | `DELETE /v4/customers/{id}/beneficiaries/{beneficiary_id}` | `beneficiaries:write` | state | 200 `Beneficiary` (`status: "removed"`) |
| `quoteTransfer` (new, [MO-16]) | `POST /v4/transfers/quote` (holds nothing; spec 04 §15.3) | `money:read` (MS-22) | none | 200 `TransferQuote` |
| `createTransfer` | `POST /v4/transfers` | `money:write` | perm! | 201 `Transfer` (a replay 200) |
| `listTransfers` | `GET /v4/transfers` (`customer_id`, `status`, `direction`, `created_gte`, `created_lt`, paging with `ending_before`, as the Transfers screens page both ways, [AP-17]) | `money:read` | none | 200 list of `Transfer` |
| `getTransfer` | `GET /v4/transfers/{id}` | `money:read` | none | 200 `Transfer` |
| `cancelTransfer` | `POST /v4/transfers/{id}/cancel` | `money:write` | state | 200 `Transfer` |

### 6.9 Monday, Sandbox money (L-MON-05 with spec 04 §14.3 and §25): 5 operations

| operationId | Method and path | Key | Mode | Idem. | 2xx |
|---|---|---|---|---|---|
| `simulateDeposit` | `POST /v4/sandbox/customers/{id}/deposit` (`amount`, `currency`, `external_id`) | `sandbox:deposit` | sandbox | perm! | 201 `Transfer` |
| `simulateBankDeposit` | `POST /v4/sandbox/customers/{id}/bank_deposit` (`rail`, `amount`, `currency`, `external_id`) | `sandbox:deposit` | sandbox | perm! | 201 `Transfer` |
| `simulateTransferCompleted` | `POST /v4/sandbox/transfers/{id}/complete` | `sandbox:simulate` and `money:read` | sandbox | state | 200 `Transfer` |
| `simulateTransferFailed` | `POST /v4/sandbox/transfers/{id}/fail` | `sandbox:simulate` and `money:read` | sandbox | state | 200 `Transfer` |
| `simulateTransferReturned` | `POST /v4/sandbox/transfers/{id}/return` (`reason`) | `sandbox:simulate` and `money:read` | sandbox | state | 200 `Transfer` |

**Totals:** 1 + 9 + 9 + 5 + 9 + 8 + 13 + 5 = 59 operations: Saturday 1, Sunday 40, Monday 18.

### 6.10 Not in the document

| Route | Host | Owner |
|---|---|---|
| `GET /health` | `api.` | L-SUN-01 |
| `POST /hooks/kyc/sumsub` | `api.` | spec 03 (forwarded raw to `api`'s hook door, F8) |
| `POST /hooks/money/{provider}/{instance}` | `api.` | spec 04 §18 (forwarded raw to `payments`' hook door, F12) |
| `POST /hooks/github/secret-scanning` | `api.` | §4.8 |
| `POST /reports/docs` | `api.` | §8.13 |
| `/healthz`, `/readyz` | private only | spec 01 |
| `/internal/v4/*` and every door | private only | ARCH §7.9 |

Each is in the negative test's list (T05-34) and, for the hooks, in the door matrix with its secret
and limit (ARCH §7.9).

### 6.11 Resource shapes (components)

Defined once in `packages/contract/src/schemas/<area>.ts` with `.openapi("<Name>")`. Domain specs
own the meaning of each status; this table fixes the field names the contract publishes.

| Component | Fields |
|---|---|
| `ApiKey` | `object: "api_key"`, `id` (the key ID), `livemode`, `kind` (`secret` or `restricted`), `scopes` (`["*"]` for full access), `organization` (`org_`) |
| `Customer` | `id`, `object: "customer"`, `type` (`individual`, `business`), `status` (`incomplete`, `in_review`, `approved`, `action_required`, `unapproved`, `rejected`), `status_detail` (`reason`, `next_actor`), `external_id`, `country`, `company_type`, `test_data`, `attempt`, `created_at`, `updated_at`, `submitted_at`, `approved_at` |
| `CustomerDetail` | `Customer` plus `missing` (`details.<field>`, `answers.<field>`, `documents.<type>`, `people.owner`) |
| `RestartedCustomer` | `Customer` plus `missing` and `link` |
| `Link` | `object: "link"`, `kind` (`customer`, `person`), `customer_id`, `person_id`, `rfi_id`, `url`, `expires_at` |
| `Person` | `id`, `object: "person"`, `customer_id`, `roles`, `ownership_percent`, `status` (`incomplete`, `in_review`, `approved`, `rejected`), `status_detail` (`reason`), `test_data`, `created_at`, `submitted_at` |
| `Document`, `UploadedDocument` | `id`, `object: "document"`, `type`, `side`, `country`, `status` (`submitted`, `accepted`, `retry`, `rejected`, `replaced`), `reason`, `customer_id`, `person_id`, `test_data`, `created_at`; `UploadedDocument` adds `warnings` (`code`, `detail`) |
| `Rfi` | `id`, `object: "rfi"`, `customer_id`, `status` (`open`, `answered`, `accepted`, `more_needed`, `expired`, `withdrawn`), `message`, `due_at`, `items` (`id`, `kind`, `code`, `label`, `status`, `document_id`, `form_id`, `documents`), `note_added`, `extra_documents`, `created_at` |
| `Event`, `EventDetail` | `id`, `object: "event"`, `type`, `created_at`, `data`; `EventDetail` adds `deliveries` (`id`, `endpoint_id`, `status`, `attempts`, `response_code`, `duration_ms`, `next_attempt_at`, `delivered_at`) |
| `WebhookEndpoint`, `WebhookEndpointWithSecret` | §5.3.1 |
| `WebhookDelivery` | `id`, `object: "webhook_delivery"`, `event_id`, `endpoint_id`, `event_type`, `kind` (`event`, `test`, `challenge`), `status`, `attempts`, `max_attempts` (15), `response_code`, `duration_ms`, `next_attempt_at`, `last_attempt_at`, `delivered_at`, `retry_of`, `created_at` |
| `TestEventSent` | `object: "event"`, `id`, `type: "webhook.test"`, `endpoint_id` |
| `DeliveryRetry` | `id`, `object: "webhook_delivery"`, `status`, `retry_of` |
| `SandboxReset` | §6.7 |
| `VirtualAccount`, `Balance`, `Beneficiary`, `Transfer`, `TransferQuote` | Spec 04 §25, using `amount`, `fee`, `total`, `currency` in minor units, and `object` values `virtual_account`, `balance`, `beneficiary`, `transfer`, `transfer_quote` |
| `List<T>` | `object: "list"`, `data`, `has_more`, `next_cursor`, `previous_cursor` |
| `Deleted` | §3.1 |
| `Problem` | §3.3.1, with `code` an enum of every public code |

---

## 7. The OpenAPI document ([AP-02], [AP-13])

### 7.1 Where it is defined

```
packages/contract/
  src/version.ts                 FIN_API_VERSION, SUPPORTED_VERSIONS, RETIRED_VERSIONS, RELEASED
  src/common.ts                  id(prefix), Money, Timestamp, List(), Deleted, shared params and headers
  src/problem.ts, refuse.ts, issues.ts, jcs.ts, cursor.ts, route-policy.ts
  src/provider-names.ts          §3.10
  src/docs-links.ts              §8.12 (browser-safe; no imports)
  src/routes/<area>.ts           createRoute() objects, one export per operationId
  src/policy/<area>.ts           RoutePolicy rows (§6.1)
  src/schemas/<area>.ts          components
  src/schemas/event-catalogue.ts §5.1
  src/errors/<area>.ts           §3.3.3
  src/document/base.ts           info, servers, security, tags, x-tagGroups, shared components
  scripts/fragments.ts           writes openapi/<area>.json
  scripts/assemble.ts            writes dist/openapi.json (never committed)
  openapi/<area>.json            committed fragments
  vacuum/ruleset.yaml            §7.4
```

Areas: `platform`, `keys`, `customers`, `documents`, `people`, `rfis`, `events`, `webhook-endpoints`,
`sandbox`, `money`, `sandbox-money`. Nothing discovers areas from a hand-edited index: scripts and
tests glob `src/routes/*.ts`. In `apps/api`, each `src/routes/<area>/index.ts` exports
`register(app)`; `src/routes/index.gen.ts` is generated at build and typecheck (never committed) and
`src/platform/router.ts` mounts it under `/internal/v4`.

### 7.2 Generation

- `pnpm openapi:fragments`: for each area, a fresh `OpenAPIHono` with stub handlers registers that
  area's routes; `app.getOpenAPI31Document({ openapi: "3.1.1", info })` produces the paths and the
  components they use; the script adds the policy as extensions (`x-fin-scopes`, `x-fin-key-kind`,
  `x-fin-sandbox-only`, `x-fin-idempotency`), sorts every key, and writes 2-space JSON with a final
  newline.
- `pnpm openapi:build`: merges `src/document/base.ts` with every fragment into `dist/openapi.json`.
  Two fragments defining one component name with different content fail the build. The docs build
  reads only this file.
- **The base document:** `openapi: "3.1.1"`; `info.title: "Fin API"`, `info.version:
  FIN_API_VERSION`, a short description pointing to the guides; `servers: [{ "url": "{api_origin}",
  "variables": { "api_origin": { "default": "https://api.fin.invalid", "description": "Your Fin API
  origin, shown in the dashboard" } } }]` (the reference page replaces it from `env.json`, §8.6,
  D05-02); one security scheme `bearer` (`type: http`, `scheme: bearer`, description "A Fin API key.
  Try it on this site takes Sandbox keys only (fin_test_...)"); tags per area with `x-tagGroups`
  (Basics: API keys; Onboarding: Customers, Documents, People, Requests for information; Events and
  webhooks: Events, Webhook endpoints; Money: Virtual accounts, Beneficiaries, Transfers; Sandbox);
  shared headers `Request-Id`, `RateLimit`, `RateLimit-Policy`, `Retry-After`, `Fin-Version`,
  `Idempotent-Replayed`; shared parameters `IdempotencyKey`, `FinVersion`, `Limit`, `Cursor`,
  `EndingBefore`; shared responses `Unauthenticated`, `Forbidden`, `RateLimited`, `Internal`,
  `Unavailable`; the `webhooks` object, one entry per subscribable event type plus `webhook.test`,
  from the event catalogue.
- Multipart routes are described with `multipart/form-data` schemas and validated by hand in the
  handler.

### 7.3 Examples

Every request body and every success answer has an example (vacuum enforces it). Examples use the
canon's sample data with `example.*` addresses, `fin_test_sk_...` (never 60 characters), `whsec_...`
(never 50), IDs of the right shape, and no provider name. T05-35 runs every example through its
schema.

### 7.4 CI

| Check | Command (flags confirmed against the pinned binaries' `--help` when wired) | Fails on |
|---|---|---|
| Regenerate and diff | `pnpm openapi:fragments && git diff --exit-code packages/contract/openapi` | any difference |
| Breaking changes | `oasdiff breaking main.json head.json --fail-on ERR` (oasdiff v1.39.0, a release binary checked by checksum, never the npm placeholder of that name) | an error-level change, unless `RELEASED` is false and the pull request adds a changelog entry with `breaking: true` |
| Changelog draft | `oasdiff changelog main.json head.json --format markdown` into the job summary | nothing; the lane copies it into `docs/api-changelog/` |
| Lint | `vacuum lint --ruleset packages/contract/vacuum/ruleset.yaml dist/openapi.json` (vacuum v0.42.1, by checksum) | any error |
| Changelog present | `packages/contract/scripts/changelog-check.ts` | from `RELEASED = true`: a contract change with no new entry |

Fin's vacuum rules: every operation has `operationId`, `summary`, at least one tag and at least one
4xx answer of `application/problem+json`; properties are snake_case; no request schema allows
`additionalProperties: true`; examples are valid; every success answer has an example; `operationId`
values are unique and camelCase.

### 7.5 Tests

| Test | What it proves |
|---|---|
| Route parity (T05-32) | The edge's own routes (`GET /v4/whoami`) plus `api`'s routes under `/internal/v4` (as `/v4`), read from the Hono apps' route lists, equal the document's operations, both ways |
| Negative (T05-34) | No path `/health`, `/healthz`, `/readyz`, `/hooks/*`, `/internal/*`, `/door/*`, `/reports/*` or `/api/*`; no header `Fin-Caller-*`, `Fin-Ingress-Proof` or `Fin-Release`; no server but the variable one; no internal error code; no provider name; no valid-checksum key |
| Error pages (T05-20, T05-52) | Every public code has a catalogue entry and a built `/errors/<code>` page; no page for a code nothing raises |
| Docs anchors (T05-54) | Every entry of `DOCS_LINKS` resolves to a built page and an element with that ID |
| Policy join (T05-04) | Every `createRoute` has a policy row and the reverse; every scope is in `SCOPES` |

---

## 8. The docs site at `developer.<zone>`

### 8.1 Hosting (OD-2, OD-3; spec 01 §7)

- **Static only.** `apps/docs` builds to `apps/docs/dist/static/`, uploaded through Cloudflare's API
  by `tools/static-deploy`, with Node built-ins only ([FD-19], [BD-16]), as the assets-only deployment
  `fin-next-<env>-docs-static` (spec 01 §6.9 and §7.4; no `main`, no bindings, no
  `run_worker_first`, `workers_dev: false`, `preview_urls: false`; spec 01 SP-26). On staging the
  upload runs from the operator machine until the owner is back, and in `deploy-static-staging` after
  that ([BD-05]). No code runs at Cloudflare, and nothing on Railway serves the docs pages; the edge
  only takes their failure reports (§8.13).
- **The same invariant as every static deployment.** The docs deployment carries spec 01 §7.4's
  invariant unchanged, as the owner's 03:50 decision says for each app's static build, the docs
  included ([FD-17], OD-2): `not_found_handling: "single-page-application"` and `html_handling:
  "auto-trailing-slash"`. Neither is a per-deployment setting, so the watcher's `static` check
  compares the docs deployment with the same values as the other four and raises
  `static-deployment-changed` on any difference.
- **Its entry in `ops/environments/<env>.json`** (`static` section, spec 01 §7): `{ "app": "docs",
  "hostRole": "developer", "apiPath": false }`. `apiPath: false` means no `developer.<zone>/api/*`
  route and no ingress rule.
- **Unknown paths** (D05-32). The single-page fallback answers any path that matches no file with the
  root `index.html` (the home page) and status 200; that includes `developer.<zone>/api/*`, which has
  no route of its own. The exception is a path that [BD-13]'s edge rule refuses (a raw path holding
  `..`, `//`, `%2E`, `%2F`, `\` or `;`, or ending `.map`; spec 01 §7.6, AC-P0-23): it never reaches
  the static deployment. Every built page's `<html>` carries `data-page`
  (`home`, `guide:<slug>`, `reference`, `errors`, `changelog`) and a `<link rel="canonical">` to its
  own path. When `data-page` is `home` and `location.pathname` is not `/`, the page is the fallback:
  the shell (`src/shell/main.ts`) hides the home content, shows the home page's built "Page not
  found" section (hidden until then; links to the home page, the guides and the API reference, and
  the search button), sets the title to "Page not found", and adds `<meta name="robots"
  content="noindex">`. The legacy-anchor redirect (§8.12) runs only when the path is `/`. Without
  JavaScript the reader sees the home page, a useful place to land. The answer's status stays 200: a
  search engine may read it as a soft 404, and the `noindex` and the canonical link to `/` keep stray
  URLs out of the index. That is the recorded cost of keeping the owner's setting (D05-32, T05-61).
- **Portability.** Moving away means serving `dist/static/` with its `_headers` and `_redirects`
  from any static host, with the same single-page fallback.
- **Previews.** None. `preview_urls: false` holds on every deployment, the docs included ([FD-17]),
  so a pull request never gets a public docs preview. Reviewers run the build with `packages/testing`'s
  static host (spec 01 §4.7), which applies the same `_headers` and the same fallback.

### 8.2 Build

One build for every environment (spec 01 S0-05, D05-02). Build inputs: the assembled
`packages/contract/dist/openapi.json`, the error catalogue, the event catalogue, the Sandbox test
values (from spec 03's `packages/kyc` export used by the console's Simulator too), `RETRY_DELAYS_S`,
`SCOPES`, the rate-limit policies, `docs/api-changelog/*.md` and `apps/docs/content/**`.

`pnpm --filter @fin/docs build` (`apps/docs/build/build.ts`):

1. `vite build` (Vite 8.3.8) of the JavaScript and CSS entries with `build.manifest: true`,
   `build.assetsInlineLimit: 0`, hashed files under `assets/`, hidden source maps kept out of
   `dist/static/` (spec 01 §4.4's rule).
2. Render every page's HTML from templates (`build/layout.ts`), with links to the hashed assets
   from the manifest. Every value is HTML-escaped; no page carries an inline script, an inline
   event handler or a `style` attribute.
3. Write `openapi.json` (the assembled document), `search-index.json`, `changelog.xml` and
   `_redirects` (from `content/redirects.json`; empty at launch) into `dist/static/`. The docs build
   writes no headers file: `_headers` is spec 01 §7.4's `docs` profile (§8.11).
4. Run the post-build checks (T05-50).

**At deploy**, spec 01's renderer writes `_headers` from the `docs` profile in
`packages/web-host/src/static/`, plus `env.json` and `robots.txt`, with the environment's values.
`env.json`:

```json
{ "environment": "staging", "release": "<sha>", "apiOrigin": "https://gateway.<staging-zone>",
  "docsOrigin": "https://docs.<staging-zone>", "consoleOrigin": "https://console.<staging-zone>",
  "statusOrigin": null, "keySalt": "fin-stg-1", "indexable": false }
```

The fields `environment`, `release`, `apiOrigin`, `docsOrigin` and `consoleOrigin` are the shared
`env.json` schema of every app (`packages/frame/src/env/`, spec 01 §7.4); `statusOrigin`, `keySalt`
and `indexable` are the docs site's own additions to it.

`robots.txt` is `User-agent: *` and `Disallow: /` unless `indexable` (production), then `Allow: /`.
Pages read `env.json` once at start; if it fails to load or validate, the reference is not mounted
and Try it does not exist on that page load (§9.2). Guides and samples never contain an origin: samples use `$FIN_API_URL` and `$FIN_KEY`,
and the getting-started guide shows the environment's API origin by filling a `<code
data-env="apiOrigin">` placeholder from `env.json` (without JavaScript it reads "your API origin, shown
in the dashboard").

### 8.3 Pages

| URL | Built from | Script | Notes |
|---|---|---|---|
| `/` | `content/home.md` | shell | Getting-started cards, the guide list, the API reference link; the legacy-anchor redirect (§8.12); the hidden "Page not found" section that the single-page fallback shows (§8.1) |
| `/guides/<slug>` | `content/guides/<slug>.md` | shell | One URL per guide, readable without JavaScript |
| `/reference` | `src/reference/` | reference | Scalar; the only page with Try it |
| `/errors` and `/errors/<code>` | the error catalogue | shell | One page per public code: meaning, fix, status, an example document, what it adds; kept for every code ever served |
| `/changelog` and `/changelog.xml` | `docs/api-changelog/*.md` | shell; none for the feed | Atom feed |
| `/openapi.json` | the assembled document | none | `Cache-Control` as §8.11 |
| `/search-index.json` | the build | none | §8.7 |
| `/env.json`, `/robots.txt`, `_headers` | the deploy | none | `_headers` (and the built `_redirects`) are read by Cloudflare, not served |
| `/assets/*` | Vite | n/a | hashed, immutable |
| any other path | the single-page fallback: the root `index.html` | shell | Status 200; the shell draws "Page not found" (§8.1, D05-32). There is no `404.html` |

**The frame** (static HTML, styled with `@fin/tokens`): a 56px top bar with the 24px Fin mark
linking `/`, "Docs", a "Staging" badge when `env.json` says so (and the `X-Robots-Tag` header outside
production), the search button (Ctrl or Cmd+K), links "Guides", "API reference", "Changelog" and
"Dashboard" (to `consoleOrigin`, opening in the same tab); a left navigation of guides on guide pages
(a drawer on phones); content at most 760px wide; a footer with the status page link when `statusOrigin` is set. Light and dark
follow `prefers-color-scheme` only; there is no theme switch (D05-04).

### 8.4 Guides

| Slug | Title | Sections (anchor IDs) | Day |
|---|---|---|---|
| `getting-started` | Getting started | `getting-started-key`, `getting-started-first-call`, `getting-started-customer` | Monday (must-have) |
| `authentication` | Authentication | `authentication-bearer`, `authentication-keys`, `authentication-modes`, `authentication-scopes`, `authentication-refused`, `authentication-rolling`, `authentication-allowlists`, `authentication-leaks` | Monday stretch, else H-08 |
| `customers` | Customers | `customers-statuses`, `customers-individuals`, `customers-businesses`, `customers-people`, `customers-documents`, `customers-link`, `customers-restart`, `customers-search` | H-08 |
| `requests-for-information` | Requests for information | `rfis-how`, `rfis-answer`, `rfis-forms` | H-08 |
| `going-to-production` | Going to Production | `production-request`, `production-review`, `production-keys`, `production-checklist` | H-08 |
| `money-movement` | Money movement | `money-virtual-accounts`, `money-deposits`, `money-beneficiaries`, `money-quotes`, `money-transfers`, `money-statuses`, `money-cancel`, `money-simulations` | Monday stretch, else H-08 |
| `sandbox` | Sandbox and test values | `sandbox-test-values`, `sandbox-customers`, `sandbox-simulate`, `sandbox-money`, `sandbox-reset`, `sandbox-try-it` | H-08 |
| `webhooks` | Webhooks | `webhooks-endpoints`, `webhooks-challenge`, `webhooks-signing`, `webhooks-retries`, `webhooks-events`, `webhooks-ordering`, `webhooks-test-receiver`, `webhooks-addresses` | Monday stretch, else H-08 |
| `errors` | Errors and request IDs | `errors-problem`, `errors-codes`, `errors-request-id` | H-08 |
| `idempotency` | Retries and idempotency | `idempotency-which`, `idempotency-key`, `idempotency-replays`, `idempotency-expiry` | Monday stretch, else H-08 |
| `pagination` | Pagination | `pagination-cursors`, `pagination-both-ways`, `pagination-filters` | Monday stretch, else H-08 |
| `rate-limits` | Rate limits and quotas | `rate-limits-headers`, `rate-limits-quotas`, `rate-limits-cloudflare` | H-08 |
| `versioning` | Versioning and the changelog | `versioning-policy`, `versioning-header`, `versioning-deprecation`, `versioning-changelog` | H-08 |

Generated tables, from the same constants the code uses, inserted by directives: `{{table:events}}`,
`{{table:retry-delays}}`, `{{table:test-values}}`, `{{table:errors}}`, `{{table:scopes}}`,
`{{table:rate-limits}}`, `{{table:idempotency}}` (the class of every operation). Code from
directives: `{{sample:<operationId>}}` (§8.8), `{{verifier:node}}`, `{{verifier:python}}` (§5.2's
vector). Copy follows the design rules: short sentences, British spelling, Sandbox and Production in
prose, `test` and `live` only for key prefixes and fields ([UI-08]), "Sandbox customers", never the
word "project".

### 8.5 The Markdown subset (`apps/docs/build/markdown.ts`, in-repo, no dependency, [AP-09])

| Allowed | Rule |
|---|---|
| Front matter | `title`, `description`, `order`, `legacy_anchors` (old anchors this page answers) |
| Headings | `#` once (the title); `##` and `###` must carry an explicit `{#id}` (lower case, hyphens), unique per page |
| Text | paragraphs, `*em*`, `**strong**`, inline code |
| Lists | `-` and `1.`, one level of nesting |
| Tables | pipe tables with a header row |
| Code | fenced blocks with a language from `bash`, `json`, `js`, `ts`, `python`, `http`, `text`; no highlighting until a package is approved |
| Links | relative paths, `#anchors` and `https://` only; internal links must resolve (T05-51) |
| Notes | a blockquote starting `Note:` |
| Directives | §8.4 |
| Anything else | refused with the file and line: raw HTML (every `<` and `&` outside code is escaped), images, `javascript:` or `data:` links, footnotes |

### 8.6 The reference page (`apps/docs/src/reference/`)

`@scalar/api-reference` 1.78.1, pinned exactly, imported from npm and bundled by Vite with its
`style.css`; never `@scalar/hono-api-reference` or a CDN ([AP-09]). Vue, so the page is the recorded
exception to "every interactive control comes from `@fin/ui`" ([AP-11]); the page's own frame and
its loading and failure states use `@fin/tokens` styling and plain elements.

Mounting (`main.ts`): fetch `/env.json` and validate it; then `createApiReference("#reference",
config)` with:

| Option | Value | Why |
|---|---|---|
| `url` | `/openapi.json` | the document is never inlined into HTML (the November 2026 Scalar integration advisories) |
| `servers` | `[{ url: env.apiOrigin, description: "Sandbox, with a fin_test_ key" }]` | one build for every environment |
| `customFetch` | the guard (§9) | layer 1 |
| `persistAuth` | `false` | the key stays in memory |
| `persistSelectedClient` | `false` | it defaults to true and writes local storage |
| `proxyUrl` | `""` | no Scalar proxy |
| `telemetry` | `false` | |
| `withDefaultFonts` | `false` | fonts come from Fin's origin |
| `agent`, `mcp` | `{ disabled: true }` | the bundled agent code stays off |
| `showDeveloperTools` | `"never"` | |
| `hideClientButton` | `true` | |
| `hideDarkModeToggle` | `true` | the system setting decides; nothing stored |
| `documentDownloadType` | `"json"` | |
| `layout`, `theme` | `"modern"`, `"default"` | with Fin's variable map (§8.10) |
| `defaultHttpClient` | `{ targetKey: "shell", clientKey: "curl" }` | |
| `hiddenClients` | every client but `shell/curl`, `node/fetch` and `python/requests` | the three of the old product |
| `authentication` | `{ preferredSecurityScheme: "bearer" }`; no `token` prefilled | never prefill a key |
| `externalUrls` | every field `""` | |
| `generateOperationSlug`, `redirect` | operation anchors `#<operationId>` mapped to the anchor 1.78.1 renders | §8.12 |

Every option name and its shape is read from the installed 1.78.1 types before the lane writes the
file (SP-14). An option missing from 1.78.1 whose default would store something or call another origin
blocks the page until a reviewed bump that has it. A render failure is reported as stage `render`
(§8.13), through the Vue app's error handler set before mount if 1.78.1 exposes one, else a window
error listener (SP-14 records which). Scalar's bump is monthly, reviewed, with a diff of the shipped
bundle ([AP-09]).

### 8.7 Search

- `search-index.json`, built at build time: one entry per guide section, operation (method, path,
  summary, `operationId`), event type and error code: `{ id, kind, title, text (at most 200
  characters), url }`.
- The palette is `@fin/ui`'s command palette (a Dialog over the UI SDK's `command` primitive), opened
  by the search button or Ctrl or Cmd+K. If `packages/ui` does not have it when the lane starts, it is
  a UI request and the lane builds a marked pending composition from `@fin/ui` primitives ([UI-03]).
- Matching in the browser with `fuse.js` at the exact version `@scalar/api-reference` 1.78.1
  resolves, added as a direct dependency at that version through the dependency rules. Options:
  `keys: [{ name: "title", weight: 0.7 }, { name: "text", weight: 0.3 }]`, `threshold: 0.35`,
  `ignoreLocation: true`, `minMatchCharLength: 2`, 20 results at most.
- No WebAssembly (which needs `'wasm-unsafe-eval'`), no web worker, no hosted search.

### 8.8 Code samples

- **Reference:** Scalar's own generator, limited to the three clients above.
- **Guides:** `apps/docs/build/samples.ts`, Fin's own small generator (D05-06), renders curl, Node
  `fetch` and Python `requests` for an operation and its example at build time, using `$FIN_API_URL`
  and `$FIN_KEY`, and adding `Idempotency-Key: $(uuidgen)` (curl) or a `crypto.randomUUID()` (Node)
  or `uuid.uuid4()` (Python) on routes whose class is `required_permanent`. Each guide code block has
  a copy button (`@fin/ui`).
- **Verifiers:** hand-written Node (`node:crypto`, `timingSafeEqual`) and Python (`hmac`,
  `hashlib`, `compare_digest`) webhook verifiers, run in CI against §5.2's vector (T05-31). The guide
  also points to the official Standard Webhooks libraries.
- No sample holds a key-shaped string with a valid checksum or a secret-shaped `whsec_` value.

### 8.9 The changelog

- One file per entry: `docs/api-changelog/<YYYY-MM-DD>-<slug>.md`, front matter `date`, `title`,
  `kind` (`added`, `changed`, `deprecated`, `removed`, `fixed`), `breaking` (boolean), `operations`
  (operationIds), then a restricted-Markdown body.
- `/changelog` lists entries newest first with anchors `#<slug>`; `/changelog.xml` is Atom 1.0 with
  entry IDs `urn:fin:changelog:<date>-<slug>`.
- The first entry, "First version", is written in H-08 before production.

### 8.10 Theme and design (R14, [AP-12])

- The canvases have no docs board, and the design brief leaves the docs site out of its scope. The
  default of [AP-12] applies: no board first; the docs use `@fin/tokens` (light and dark), Inter and
  Fira Mono from Fin's own origin, the 24px mark, and the design system's spacing and type scale. The
  design lane mirrors the result on the canvas afterwards (G-07's duty).
- `src/reference/theme.css` maps tokens onto Scalar's variables (`--scalar-color-1` to `-3`,
  `--scalar-color-accent`, `--scalar-background-1` to `-3`, `--scalar-background-accent`,
  `--scalar-border-color`, `--scalar-font`, `--scalar-font-code`, and the `--scalar-sidebar-*` set)
  under `.light-mode` and `.dark-mode`, unlayered so it wins over Scalar's cascade layers. Variable
  names are re-read at every Scalar bump.
- The site stylesheet starts with `@layer ui-sdk;` and imports `@fin/tokens` as spec 01 §4.4 and
  research note D3 §2 order it; each HTML page carries `<meta property="csp-nonce">` with no nonce
  attribute, so the UI SDK adopts constructed style sheets.
- Phone widths (390px and 360px) and both colour schemes are tested (T05-58).

### 8.11 Headers and the page policy (R16, [SA-45], [AP-11])

**One source.** The docs site's `_headers` is spec 01 §7.4's `docs` profile, rendered at deploy by
spec 01's renderer from `packages/web-host/src/static/` with the environment's values, like the other
four static deployments. `apps/docs` holds no headers file or template of its own, and this section
does not define a second policy: it explains the profile and shows what the renderer writes for
staging. Where the two ever differ, spec 01 §7.4 and the renderer are right, and this section is
corrected.

The profile is `app` with these changes, and no others (the list in spec 01 §7.4):

| Header | `docs` profile | Why |
|---|---|---|
| `connect-src` | `'self' <api origin>` | Try it calls the API host cross-origin, without credentials ([AP-10], §9) |
| `style-src` | `'self' 'unsafe-inline'` | The listed docs exception: Scalar 1.78.1 writes its theme and its parts' styles at run time ([AP-11], below) |
| `img-src` | `'self' data:` | The listed docs exception: Scalar 1.78.1 draws images from `data:` URLs ([AP-11], below) |
| `form-action` | `'none'` | The docs have no form |
| `report-to`, `Reporting-Endpoints` | none | The docs host has no `/api/`; violations reach the edge through §8.13's `csp` stage |
| `Referrer-Policy` | `no-referrer` | Nothing on the docs site needs a referrer |
| `Permissions-Policy` | the `hosted` profile's list: every feature denied, passkeys included | `clipboard-write` is not in the list, so copy buttons work |

Rendered for staging, once the owner's yes on the exception is recorded:

```
/*
  Cache-Control: no-cache
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://gateway.<staging-zone>; manifest-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Strict-Transport-Security: max-age=63072000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: <the hosted profile's list, spec 01 §7.4>
  X-Robots-Tag: noindex, nofollow
/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
```

- `Strict-Transport-Security` takes the zone class's value (ARCH §5.8, [SA-45]): the staging docs
  host, on the staging zone, renders `max-age=63072000; includeSubDomains` as above; the production
  docs host, on the hosted zone ([FD-10]), renders `max-age=63072000; includeSubDomains; preload`.
  The header-matrix test asserts the exact value for each.
- `X-Robots-Tag` appears outside production only, as in every profile. `/env.json`, `/openapi.json`
  and `/search-index.json` take `no-cache` from `/*`, so they need no rule of their own.
- **A missing asset** (NF-1). The single-page fallback answers a missing `/assets/*` path with the
  home page and status 200, and the `/assets/*` rule gives that answer `immutable`, so a deploy-skew
  race could cache HTML under a chunk URL for a year. On the app hosts, the docs host among them, a
  Response Header Transform Rule sets `Cache-Control: no-store` on a `text/html` answer under
  `/assets/` ([BD-12], spec 01 §7.6). Real assets keep `immutable`, and pages keep `no-cache`.
- **The docs exception** ([SA-45], FW-C05, [AP-11]). `style-src 'unsafe-inline'` and `img-src data:`
  are allowed in the `docs` profile alone, in those two directives alone. They are not FW-X7's
  fallback (which applies to every profile only if FW-S1 fails) and they are not covered by the
  owner's 03:00 words, which accepted `'unsafe-inline'` styles only as that fallback and `data:` not
  at all. So they need the owner's yes, asked under [AP-11] at Monday's 08:00 sitting. Only the pull
  request that records that yes in [AP-11]'s status adds them to the `docs` profile (a control path,
  [CI-14]); until then the profile renders `style-src 'self'` and `img-src 'self'`, as the table above
  would without its two exception rows. Until then, and if the answer is no, the guides, error pages
  and changelog are uploaded and served, and `/reference` is built and tested locally but left out of
  the upload; R16's Try it is then partial, recorded in EXECUTION §0.2.
- **Why the values, and when they go.** The old product's docs build found that Scalar 1.78.1 needs
  both, and works without `eval` after one feature test. SP-14 re-checks it for fin-next: it mounts
  the reference under the `app` profile's strict `style-src 'self'` and `img-src 'self'`, records
  every violation, and records whether Scalar's `data:` images come from its bundled stylesheet or
  from code at run time. A value that no violation needs is dropped from the profile in the same pull
  request. Both are re-checked at every Scalar bump.
- **One policy for the whole site** (D05-03): every docs document carries the same policy, because a
  second matching `Content-Security-Policy` rule would be joined to the first with a comma and the
  browser would enforce both. `!` detach holds on an assets-only deployment for `Cache-Control`
  (SP-26's data points from S-01's run, 21 Nov). Narrowing the exception to `/reference` alone (a
  `/reference` rule with `! Content-Security-Policy`, guide pages kept strict) waits for T05-59 to
  show `/reference` carrying exactly one policy; it is then a change to spec 01's `docs` profile, in a
  reviewed pull request. Scripts stay `'self'` with no inline script anywhere, before and after.
- **`!` detach is honoured** (S-01's run, 21 Nov; spec 01 §7.4), so spec 01's fallback for it (no
  `Cache-Control` on `/*`, and a rule for each emitted path class) is not needed. Unknown paths
  outside `/assets/`, answered by the single-page fallback (§8.1), keep `no-cache` from `/*`.
- **The policy test.** FW-C05's header-matrix test, which renders every profile, allows the docs
  exception exactly: `'unsafe-inline'` only in the `docs` profile's `style-src`, `data:` only in its
  `img-src`, and `connect-src` naming only `'self'` and the environment's API origin. It fails if any
  other profile carries either value (unless FW-X7 has been recorded, and then only `style-src
  'unsafe-inline'`), and if the `docs` profile carries `'unsafe-eval'`, `'unsafe-hashes'`,
  `'wasm-unsafe-eval'`, `data:` in any other directive, `blob:`, `ws:` or any other origin. T05-50 runs
  the same rule over the docs build with the profile rendered for a test environment.

### 8.12 Anchors: the contract with the console

`packages/contract/src/docs-links.ts` (browser-safe, no imports, owned by the docs lane) exports
`DOCS_LINKS`, a map from a stable key to a docs path and anchor. The console builds every docs link
as its own `env.json`'s docs origin followed by that path, and never writes a docs URL by hand. One
entry, `getSandboxKey`, goes the other way: the docs link to the console's API keys page using
`env.json`'s `consoleOrigin`. Initial entries, from the console's copy:

| Key | Console label | Target |
|---|---|---|
| `createCustomer` | "Create a customer" | `/reference#createCustomer` |
| `individuals` | "Individuals" | `/guides/customers#customers-individuals` |
| `businesses` | "Businesses" | `/guides/customers#customers-businesses` |
| `customerLink` | "The customer's link" | `/guides/customers#customers-link` |
| `answerRfi` | "Answer a request for information" | `/guides/requests-for-information#rfis-answer` |
| `simulate` | "Simulate in the Sandbox", "Simulate an action", "How the simulator works" | `/guides/sandbox#sandbox-simulate` |
| `askForInformation` | "Ask for information by API" | `/reference#simulateRequestInformation` |
| `makeSandboxCustomers` | "Make Sandbox customers" | `/reference#createTestCustomers` |
| `testValues` | "Sandbox and test values" | `/guides/sandbox#sandbox-test-values` |
| `webhookEndpointsApi` | "Webhook endpoints API" | `/reference#createWebhookEndpoint` |
| `checkingSignatures` | "Checking signatures" | `/guides/webhooks#webhooks-signing` |
| `retries` | "Retries" | `/guides/webhooks#webhooks-retries` |
| `events` | "Events" | `/guides/webhooks#webhooks-events` |
| `getSandboxKey` | (Try it's "Get a Sandbox key") | `<console origin>/developers/keys` |

- **Legacy anchors.** The old single-page docs used fragment anchors on `/` (`#getting-started-key`,
  `#authentication-scopes`, `#webhooks-signing` and the rest). A fragment never reaches a server, so
  `/` carries a module (`src/shell/legacy-anchors.ts`) that maps each to its new page and section with
  `location.replace`, built from every guide's `legacy_anchors`. `#<operationId>` on `/` goes to
  `/reference#<operationId>`.
- **Operation anchors** are `/reference#<operationId>`; Scalar's `redirect` option (or a hash rewrite
  before mount) turns them into the anchor 1.78.1 renders, recorded by SP-14.
- A heading anchor once published is kept, or redirected, for as long as any console build links to
  it (T05-54).

### 8.13 Failure reports from docs pages (D05-01, D05-05)

There is no `/api/` on the docs host, so the pages report to the edge:

- **Sender** (`src/shell/report.ts`, loaded first by every page): on a failed load of `/env.json`,
  `/openapi.json` or `/search-index.json` (stage `document`), a Scalar render failure (`render`), a
  window error (`script`), an unhandled rejection (`rejection`) or a `securitypolicyviolation`
  (`csp`, ignoring `eval` probes and browser extensions), it sends `fetch(<api origin>/reports/docs,
  { method: "POST", mode: "no-cors", credentials: "omit", keepalive: true, headers: {
  "content-type": "text/plain" }, body })`, at most 5 a page, deduplicated. Body (JSON text, at most
  8 KB): `{ "stage", "page" (home, guide:<slug>, reference, errors, changelog, not_found), "release",
  "name" (at most 60), "message" (at most 300), "frames" (at most 10 same-origin `asset:line:col`),
  "directive", "blocked" (an origin only) }`. Never a key, a URL with a query, or the panel's state.
  The docs site loads no `@sentry/*` code, because Try it holds a key.
- **Receiver** (`apps/edge/src/reports/docs.ts`): `POST /reports/docs` only; `Origin` must equal the
  docs origin (else 403); `text/plain`, at most 8 KB (else 413); per-replica token buckets per
  address and in all (excess dropped, counted as `browser-reports-lost`); parsed, every field checked
  against its allowed shape and length, scrubbed with the server scrubbers ([SA-42]); written as a
  `page_failed` line; stages `script`, `rejection` and `render` also go to Better Stack Errors through
  the thin client with the docs release. The answer is always 204 with `Cache-Control: no-store`, no
  CORS headers, and no body.

### 8.14 Budgets and deploy skew

- `/reference` JavaScript at most 600 KB gzip on first load (Scalar 1.78.1 is about 480 KB); guide
  pages at most 60 KB gzip before search opens, the palette and `fuse.js` loaded on first use. CI
  fails over budget (T05-56).
- Deploy skew: the static artefact carries the previous release's `assets/` (spec 01 §5.5). A
  `vite:preloadError` reloads the page once. A chunk that is missing even so gets the fallback page
  with `Cache-Control: no-store`, never `immutable` ([BD-12], §8.11).

---

## 9. Try it, with Sandbox keys only ([AP-10], ARCH §13.11)

### 9.1 The five layers

| # | Layer | Where | Rule | Tests |
|---|---|---|---|---|
| 1 | The page guard | `apps/docs/src/try-it/guard.ts` (tier S) | Scalar's `customFetch` (algorithm below) sends only to the docs origin (GET, no `Authorization`) and the API origin under `/v4/`, and only with `Authorization: Bearer` + a key matching `^fin_test_(sk\|rk)_[0-9A-HJKMNP-TV-Z]{10}[0-9A-Za-z]{38}$` whose checksum verifies with `env.keySalt`; anything else is answered in the browser and never sent | T05-40 |
| 2 | The page policy | spec 01 §7.4's `docs` profile (§8.11) | `connect-src 'self' <api origin>` and nothing else | T05-50, T05-45 |
| 3 | CORS | `apps/edge/src/cors.ts` | Only for `Origin` equal to the docs origin, under `/v4/`, never credentials | T05-41 |
| 4 | The edge's docs-origin rule | `apps/edge/src/docs-origin.ts` | With `Origin` equal to the docs origin, every key that is not a well-formed `fin_test_` key with this deployment's salt gets 403 `sandbox_key_required` before any lookup, count or forward. A browser always sends `Origin` on a cross-origin call, and a script on the page cannot forge it | T05-42 |
| 5 | The salt | `packages/keys` | Staging's panel and edge refuse a production key, and production's a staging key, before any lookup | T05-02, T05-43 |

### 9.2 The guard

```ts
// apps/docs/src/try-it/guard.ts
import { verifyChecksum } from "@fin/keys/format";

const SANDBOX_BEARER = /^Bearer (fin_test_(?:sk|rk)_[0-9A-HJKMNP-TV-Z]{10}[0-9A-Za-z]{38})$/;

export function makeGuard(env: { docsOrigin: string; apiOrigin: string; keySalt: string }) {
  return async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const auth = request.headers.get("authorization");
    // headersMention: true when any header value other than Authorization contains the text
    if (/fin_live_/i.test(url.href) || headersMention(request.headers, "fin_live_")) return refusal();
    if (url.origin === env.docsOrigin) {
      if (auth !== null || request.method !== "GET") return refusal();
      return fetch(request, { credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error" });
    }
    if (url.origin !== env.apiOrigin || !url.pathname.startsWith("/v4/")) throw new TypeError("Try it calls only the Fin API");
    const match = auth === null ? null : SANDBOX_BEARER.exec(auth);
    if (match === null || !verifyChecksum(match[1], env.keySalt)) return refusal();
    const headers = new Headers(request.headers);
    if (request.method === "POST" && !headers.has("idempotency-key")) headers.set("idempotency-key", crypto.randomUUID());
    return fetch(new Request(request, {
      headers, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error",
    }));
  };
}
```

- `refusal()` answers locally: status 403, `content-type: application/problem+json`, the
  `sandbox_key_required` document with `type` `<docs origin>/errors/sandbox_key_required` and the
  detail "Try it takes this environment's Sandbox keys only. They start fin_test_. Nothing was sent.",
  and no `request_id`.
- If `env.json` does not load or validate, the reference is never mounted, so there is no Try it: the
  page shows its failure state ("Couldn't load the API reference" with "Try again") and reports stage
  `document` (§8.13).
- The guard adds an `Idempotency-Key` to a POST that has none (D05-07); the idempotency guide says so.
- The key lives only in Scalar's in-memory state: no storage of any kind, and a reload drops it.

### 9.3 Easier, without widening it

- A "Get a Sandbox key" link beside the authentication field and in the getting-started guide, to
  `DOCS_LINKS.getSandboxKey`.
- Response examples on every operation (§7.3).
- The `unauthenticated` detail from the docs origin explains that an address allowlist sees the
  browser's address (§3.3.4).
- Try-it calls count against the same limits as any call; the edge's `request` line marks them
  `fromDocs: true`.
- The fallback, if the owner ever wants live keys structurally unreachable from the docs, is a
  separate Sandbox-only API host ([AP-10]); not built.

### 9.4 What stays true

A script that ran on the docs origin could read a typed key and send it away by navigation, which
`connect-src` does not cover. With Sandbox keys only, the worst it can do is use a Sandbox key. The
controls are: no third-party script, the fixed policy, the zone features that inject scripts kept off
and watched (ARCH §5.8), an exact Scalar pin with a reviewed bundle diff, and tier S review of the guard
and the reference mount. The authentication guide tells developers never to paste a Production key
into any website.

---

## 10. Monitoring (R5)

Alert files: `ops/monitoring/catalog/<area>.ts` and `ops/monitoring/<env>/alerts/<area>.json` for
areas `edge`, `keys`, `platform`, `webhooks`, `docs`. Thresholds are named in the files and filled
from the private overlay ([OB-13]). Staging notifies by email; production pages where marked P
(ARCH §10.8). Every alert names its meaning, its first check and its runbook.

### 10.1 Lines

| Line | Service | Fields beyond ARCH §10.2's common set |
|---|---|---|
| `request` | edge | `route`, `status`, `actor` (`api_key`, `anonymous`, `provider_webhook`, `browser_report`), `orgId`, `keyId`, `mode`, `outcome`, `reason`, `keyReason` (§4.7), `fromDocs`, `corsPreflight`, `finVersion`, `rateLimited`, `violatedPolicies`, `forwardMs` |
| `request` | api, payments | `route`, `operationId`, `idempotency` (`none`, `new`, `replayed`, `in_progress`, `mismatch`, `lease_taken`), `orgId`, `keyId`, `mode` |
| `key.sent_in_clear`, `key.leaked`, `key.exposure_failed` | edge, api | `keyId`, `mode`, `source`, `revoked` |
| `secret_scanning.refused` | edge | `reason` (`signature`, `key_unknown`, `too_large`) |
| `webhook.delivery` | worker | `deliveryId`, `endpointId`, `eventType`, `kind`, `attempt`, `outcome` (`succeeded`, `failed`, `timeout`, `connection`, `redirect`, `blocked_url`, `gone`, `throttled`, `signing_failed`, `challenge_failed`), `status`, `durationMs`, `capped` |
| `job.run` | worker | `job`: `webhook.dispatch`, `webhook.challenge`, `webhook.sweep`, `idempotency.sweep`, `keys.rehash`, `deprecation.notify` |
| `page_failed` | edge | `stage`, `page`, `release`, `errorName`, `frames`, `directive`, `blockedOrigin` |

Never in a line: a key, a secret, a webhook URL or its host, an idempotency key, a body, a query string,
an address.

### 10.2 Alerts

| Alert | Source | Kind | Meaning, first check |
|---|---|---|---|
| `api-health`, `api-canary`, `api-unauthenticated` | monitors (ARCH §10.6) | P | The API host, the tunnel, the edge, the database and `api` answer; first check the connector count and the edge's `process.health` |
| `5xx-rate-edge`, `5xx-rate-api`, `5xx-rate-payments` | lines | P | Errors served to developers; first check `error.unexpected` by `operationId` |
| `db-or-door-down-edge` | `process.health` | P | The edge cannot reach Postgres or `api`; the 503 `temporarily_unavailable` count rises |
| `rate-limiter-failing` | edge, api | P | The window store failed and the API refuses; check Postgres |
| `idempotency-store-failing` | api | P | Writes refused with 503 because the store failed |
| `pepper-missing` | edge | P | A key names a pepper the edge does not hold; check `API_KEY_PEPPER_<n>` on the edge |
| `keys-not-rehashed` | worker | N | Keys still on a retired pepper after the rotation window |
| `bad-key-flood`, `load-shedding` | edge | N | Refused keys or shed requests above the threshold; check the addresses' spread in Logpush |
| `key-sent-in-clear` | edge | N | A key arrived over plain http; check the revocation and the email went |
| `key-leaked` | api | N | GitHub reported a key; check it was revoked and the email went |
| `secret-scanning-refused` | edge | N | Reports failing GitHub's signature check |
| `edge-pool-waiting` | edge | N | The edge's pool has waiting clients |
| `api-latency` | lines | N | p95 by `operationId` over budget |
| `webhook-dispatcher-stalled` | heartbeat | P | No dispatch pass for 3 minutes; check the worker's scheduler lease |
| `webhook-signing-failed` | worker | P | A secret could not be opened; check the seal keyring |
| `webhook-deliveries-failing` | worker | N | Many endpoints failing at once; check egress and `deliveryFetch` refusals |
| `webhook-backlog` | worker | N | Due deliveries older than the threshold |
| `webhook-host-capped` | worker | N | A target host is at its cap across organisations (possible abuse) |
| `docs` uptime, `docs-openapi` uptime | monitors | N | `developer.<zone>/` answers with the keyword; `/openapi.json` answers 200 and parses |
| `docs-failing` | `page_failed` lines | N | Page failures above a volume threshold; notifies only ([SA-42]) |
| `browser-reports-lost` | edge | N | Reports dropped by the caps |

### 10.3 Monitors and heartbeats

`api-health`, `api-canary` (every minute from two regions, `GET /v4/whoami` with a restricted
Sandbox key of a canary organisation, [OB-14]), `api-unauthenticated` (401 with Fin's `type`), `docs`
(`developer.<zone>/` with a keyword) and `docs-openapi` are ARCH §10.6's. Heartbeat `webhook-dispatcher`
every 60 s. The watcher's static-deployment checks (spec 01 §8.7) include `fin-next-<env>-docs-static`: its
routes, and spec 01 §7.4's invariant with no exception (the single-page fallback, `workers_dev` and
`preview_urls` off, no script content).

### 10.4 Dashboard panels ("Fin Services")

Edge key outcomes by `keyReason`; shedding; Try-it calls (`fromDocs`); requests, 5xx and p95 by
`operationId`; idempotency outcomes; webhook attempts by outcome, backlog, dispatcher lag, capped
hosts; page failures by stage.

---

## 11. Security notes for review

Every path here is tier S (ARCH §11.6) except `apps/docs/content/**`, `apps/docs/src/shell/**` and the
guide templates (tier N). The attack pass uses these profiles (EXECUTION §1.7):

| Profile | The guard that answers it |
|---|---|
| A leaked key's holder probing whether it works | the uniform 401 (§4.7); no positive cache |
| A flood of well-formed unknown keys (the salt is public) | load shedding and the negative filter before Postgres (§3.7) |
| Cross-organisation or cross-mode reads (IDOR) | every read scoped `(organization_id, mode, ...)` from the assertion; T05-36 generated per route and mode |
| A restricted key reaching a route beyond its scopes | the edge, `api` and `payments` each check (§6.1) |
| A Sandbox key moving live money | `liveMoney` and `mode` in the policy; the routed instance by mode ([MO-05]) |
| Idempotency abuse: replaying another key's secret-bearing answer | the same-key rule and no stored secret (§3.4.3) |
| A forged cursor or one reused with other filters | the MAC and the filter hash (§3.5) |
| SSRF through a webhook URL, DNS rebinding, a redirect | `deliveryFetch` at save and at every attempt; no redirects (§5.3.4) |
| Using Fin to flood a third party with retries | the challenge, the host caps, 410 Gone disables (§5.3, §5.4) |
| A removed member forging signed events | secrets rolled on removal ([SA-33]); `seen_by` |
| "Try it" leaking a key | the five layers (§9) and the storage and network tests (T05-45, T05-46) |
| Personal data or secrets in logs, events, cursors or errors | thin events; scrubbers; the line rules (§10.1); T05-30, T05-24 |
| A provider's name or error reaching a developer | §3.10 |
| A stranger planting data in Better Stack through the docs reports | origin check, caps, scrubbing, notify-only alerts (§8.13) |

---

## 12. Lanes and file ownership

Paths come from `tools/layout.json` (spec 01 §4.3). An area's lane owns its fragments wherever they
live (EXECUTION §1.3). A lane that needs another lane's file asks through the lane board.

| Lane | Starts | Owns | Delivers |
|---|---|---|---|
| L-SAT-11 API keys and the edge (stretch; else L-SUN-00 from Sunday 08:00) | Saturday after C3 if L-SAT-02 is green | `packages/keys/**`; `apps/edge/**` (moves to L-SUN-01 at its last merge); `apps/console/src/client/routes/developers/keys/**` and `apps/console/src/server/routes/keys/**`; fragments `packages/contract/src/{routes,policy,schemas,errors}/keys.ts` and `openapi/keys.json`, `packages/audit/src/events/api-keys.ts`, `packages/email/src/templates/api-keys/**`, `packages/db/migrations/<ts>_keys_*.sql`, `packages/db/roles/grants/keys.json`, `packages/server/src/doors/keys.ts`, `ops/monitoring/catalog/keys.ts`, `ops/monitoring/<env>/alerts/keys.json` | §4; `getApiKey`; §2.1 steps 1 to 6 and 12 to 19 |
| L-SUN-01 Edge and API platform | Sunday 08:00 | `apps/edge/**` except `src/reports/**`; `apps/api/src/platform/**`; `packages/contract/**` except other areas' fragments and `src/docs-links.ts`; fragments `errors/platform.ts`, `openapi/platform.json`, `packages/db/migrations/<ts>_platform_*.sql` (idempotency, deprecated-operation use), `packages/db/roles/grants/platform.json`, `packages/server/src/doors/platform.ts`, `ops/monitoring/catalog/{edge,platform}.ts` and their alerts | the rest of §2.1 (steps 7 to 11 and 20 to 23), §3, §7, the hook routes forwarding raw bodies; T05-07 to T05-29, T05-32 to T05-36 |
| L-SUN-04 Webhooks | Sunday 08:00 (pure code may start Saturday evening) | `packages/events/**`; `apps/api/src/worker/webhooks/**`; fragments `packages/contract/src/schemas/event-catalogue.ts`, `errors/webhooks.ts`, `packages/audit/src/events/webhooks.ts`, `packages/email/src/templates/webhooks/**`, `packages/db/migrations/<ts>_events_*.sql`, `packages/db/roles/grants/events.json`, `packages/server/src/doors/webhooks.ts`, `ops/monitoring/catalog/webhooks.ts` and its alerts | §5; T05-30, T05-31, T05-37 to T05-39 |
| L-SUN-05 Onboarding API routes | Sunday 11:00 | `apps/api/src/routes/{customers,people,documents,links,rfis,sandbox,events,webhook-endpoints}/**`; contract fragments for `customers`, `documents`, `people`, `rfis`, `events`, `webhook-endpoints`, `sandbox` (routes, policy, schemas, errors, openapi) | §6.3 to §6.7 |
| L-MON-05 Money API | Monday 12:00 | `apps/api/src/routes/{virtual-accounts,balances,beneficiaries,transfers,quotes,sandbox/money}/**`; contract fragments `money`, `sandbox-money` | §6.8, §6.9 with spec 04 §25 |
| L-SUN-09 Docs site (stretch), then L-MON-08 | Sunday 14:00; Monday 08:00 | `apps/docs/**`; `apps/edge/src/reports/**`; `packages/contract/src/docs-links.ts`; `docs/api-changelog/**`; `ops/monitoring/catalog/docs.ts` and its alerts | §8, §9; T05-40 to T05-58 and T05-61. Sunday: Scalar bundled with no CDN, the policy, the guard and its five layers, getting started. Monday: the reference for onboarding and money with Try it, the getting-started guide; stretch: error pages, money movement, idempotency, pagination and webhooks guides |
| L-SUN-10, L-MON-09 Ops | Sunday and Monday 08:00 | `ops/fin/**`, `ops/monitoring/**` index files | The docs site's builds deployed through the staging static deploy (`tools/static-deploy`, [BD-16]), from the operator machine until the owner is back ([BD-05]) and through `deploy-static-staging` after that, onto the static deployment and route that Phase 0 already made for its placeholder (EXECUTION §2.5 step 8, AC-P0-14, spec 01 §7.4 and §7.5): these lanes replace the placeholder's content, not the deployment or the route. The docs host's monitors (the `docs-web` Errors application already exists from Phase 0, spec 01 §8.2), the GitHub app registration for secret scanning (before production), the worker's static addresses for the webhooks guide |
| H-08 Docs | From Tuesday | `apps/docs/content/**`, `docs/api-changelog/**` | Every guide, the changelog and its first entry, search, the error pages, response examples on every operation |

**Requests to other lanes** (through the lane board): `apps/connector` keeps no `developer` ingress
rule (spec 01); `packages/web-host/src/static/`'s `docs` profile renders exactly spec 01 §7.4's row
and §8.11's table, and FW-C05's header-matrix test allows the docs exception exactly as §8.11 says
(P0-D; each app's `_headers` settings are a control path, [CI-14]); `packages/testing`'s static host
serves the docs with the same single-page fallback as every app, so no docs option is needed
(L-SAT-08); `tools/layout.json` marks `apps/docs/src/reference/**` tier S beside `src/try-it/**` (the
steward; a control path); the console lanes import `DOCS_LINKS`.

**File tree of the docs app**

```
apps/docs/
  package.json, vite.config.ts
  build/        build.ts, env.ts, layout.ts, markdown.ts, tables.ts, samples.ts, search-index.ts,
                changelog.ts, error-pages.ts, checks.ts
  content/      home.md, guides/<slug>.md, redirects.json
  src/shell/    main.ts, env.ts, report.ts, legacy-anchors.ts, search.tsx, copy.tsx, styles.css
  src/reference/ main.ts, theme.css (tier S)
  src/try-it/   guard.ts, refusal.ts (tier S)
  test/         unit tests
  e2e/sun/, e2e/mon/, e2e/h08/   journeys
```

---

## 13. Tests

Labels as EXECUTION: `[U]` unit, `[I]` integration on Postgres 18, `[C]` contract, `[B]` build check,
`[E2E]` Playwright 1.65.1 against `test` images and the static host, `[STG]` staging. Every test
fails when the rule it names breaks.

| ID | Label | What | Owner |
|---|---|---|---|
| T05-01 | U | `crc32.ts` equals `node:zlib` `crc32` on 10,000 random inputs; `checksumOf` pads to 6; `parseKey` refuses every off-by-one length and every character outside its alphabet | L-SAT-11 |
| T05-02 | U | A key built with one salt fails `verifyChecksum` under every other salt; `KNOWN_SALTS` has no duplicate | L-SAT-11 |
| T05-03 | B | `check-key-shapes.ts` fails on a planted valid-checksum key in a temporary tracked file, under each salt, and passes on the tree | L-SAT-11 |
| T05-04 | C | Every `createRoute` has one policy row and the reverse; scopes are in `SCOPES`; full-access-only routes are exactly the webhook routes and `resetSandbox` | L-SUN-01 |
| T05-05 | U | `KEY_SCOPE_NEEDS` and `FULL_ACCESS_NEEDS` match §4.4; Sandbox scopes are refused on live keys; an unknown scope is refused | L-SAT-11 |
| T05-06 | I | The pepper chain verifies after a re-hash; a key whose pepper the edge lacks is refused and raises `pepper-missing` | L-SAT-11 |
| T05-07 | I | The pipeline order of §2.1: a request failing two steps gets the earlier step's refusal, for each adjacent pair | L-SUN-01 |
| T05-08 | I | The 401 body is byte-identical apart from `request_id` for `malformed`, `checksum`, `other_deployment`, `unknown`, `revoked`, `expired`, `ip_not_allowed` and `missing`; timings within a set bound | L-SAT-11 |
| T05-09 | I | A revoked key is refused on the very next request (no positive cache) | L-SAT-11 |
| T05-10 | I | A flood of well-formed unknown keys is shed before Postgres (a statement counter stays flat) | L-SAT-11 |
| T05-11 | I | IP allowlists: a match passes, a miss is 401, refused entries of §4.5 are refused at save | L-SAT-11 |
| T05-12 | I | Live gating: `live_not_enabled`, `live_paused`, the `live_keys` switch; a Sandbox key unaffected | L-SAT-11 |
| T05-13 | I | Plain http: 403 `https_required`; a live key revoked with audit and email; a Sandbox key emailed, audited `api_key.exposed`, not revoked | L-SAT-11 |
| T05-14 | I | Secret scanning: a bad signature is refused; a valid report revokes the key in either mode, audits, emails; the key set is fetched at most once per 10 minutes whatever identifiers arrive | L-SAT-11 |
| T05-15 | I | Each `api_keys` audit event is written by its action (one test per event) | L-SAT-11 |
| T05-16 | I | `last_used_at` written at most once a minute per key, after the answer | L-SAT-11 |
| T05-17 | U | Problem documents: `status` equals the HTTP status; `type` is the docs URL; `request_id` equals the header; unknown extensions dropped; an unexpected error is 500 `internal` with no message and a reported `errorId` | L-SUN-01 |
| T05-18 | U | Zod issues map to `errors[]` items with `pointer` or `parameter` and the issue codes of §3.3.1 | L-SUN-01 |
| T05-19 | I | Unknown body fields, unknown and duplicated query parameters are 400; `search` and `email` query parameters get the pointer to search | L-SUN-01 |
| T05-20 | C | The catalogue test of §3.3.3 | L-SUN-01 |
| T05-21 | I | Idempotency `accepted`: same key and body replays with `Idempotent-Replayed`; another body 422; while running 409 with `Retry-After: 1`; a lapsed lease re-executes once; refusals before execution are not stored | L-SUN-01 |
| T05-22 | U | The key syntax: bare and quoted forms; 0 and 256 characters and non-visible characters refused with `idempotency_key_invalid` | L-SUN-01 |
| T05-23 | U | Fingerprints: JCS makes key order irrelevant; multipart retries with a new boundary match | L-SUN-01 |
| T05-24 | I | Secret-bearing replays carry no secret and work only for the same key ID; no row of `api.idempotency_record` matches a key, `whsec_` or link-token shape | L-SUN-01 |
| T05-25 | I | The store failing answers 503 and raises `idempotency-store-failing` | L-SUN-01 |
| T05-26 | U, I | Cursors: tampering, another route, organisation, mode or filters give `cursor_invalid`; both directions return the right pages under inserts; `limit` coercion; keyset `EXPLAIN` uses the index | L-SUN-01 |
| T05-27 | I | `RateLimit-Policy` and `RateLimit` on every working-key answer; domain items appended after `"key"`; 429 with `Retry-After` and `violated_policies`; the limiter failing refuses and alerts | L-SUN-01 |
| T05-28 | U | `Fin-Version`: echoed; supported accepted; retired 410; unknown and malformed 400 | L-SUN-01 |
| T05-29 | I | Every answer, the edge's own 404s and 429s included, carries `Request-Id`, `Cache-Control: no-store`, `Fin-Version` and §3.2's security headers, and no `Fin-Release` | L-SUN-01 |
| T05-30 | U | Every event type's `data` schema holds IDs, statuses, types and reasons only (a schema walk refuses names, emails, amounts and numbers) | L-SUN-04 |
| T05-31 | U | Signing reproduces §5.2's vector; the guides' Node and Python verifiers accept it and refuse a changed byte, an old timestamp and the old secret after 24 hours | L-SUN-04 |
| T05-32 | C | Route parity (§7.5) | L-SUN-01 |
| T05-33 | C | The assembled document has no provider name | L-SUN-01 |
| T05-34 | C | The negative test (§7.5) | L-SUN-01 |
| T05-35 | C | Every example validates against its schema; vacuum and the regenerate-and-diff pass | L-SUN-01 |
| T05-36 | I | Isolation, generated per route and per mode: another organisation's or the other mode's object answers 404 and nothing changes (AC-SUN-07) | L-SUN-05, L-MON-05 |
| T05-37 | I | Endpoint states of §5.3.2, one test per row; the challenge passes with JSON and text answers and fails otherwise | L-SUN-04 |
| T05-38 | I | Delivery: the schedule with jitter bounds; 410 disables, and re-enabling runs the challenge again; `Retry-After` honoured; 5 failures mark failing; the end-of-window pause holds deliveries; resume send and skip; manual retry rules; caps per endpoint and host; the kill switch; 30-day sweep | L-SUN-04 |
| T05-39 | I | `deliveryFetch` refuses private, loopback, link-local, CGNAT, ULA, Railway, documentation and multicast addresses, IP literals, Fin's zones, http and other ports, at save and at send; the test receiver is reached in-process only (AC-SUN-09) | L-SUN-04 with `packages/server` |
| T05-40 | U | The guard refuses a live key, a malformed key, a wrong checksum, another salt, a key in a URL or another header, another origin (throws), a docs-origin request with `Authorization`, and sends a valid Sandbox key with `credentials: "omit"`, `cache: "no-store"`, `referrerPolicy: "no-referrer"`, `redirect: "error"`; adds an `Idempotency-Key` to a bare POST | L-SUN-09 |
| T05-41 | I | CORS: the docs origin gets the preflight and the headers; other origins, other methods and other headers get none; no `Access-Control-Allow-Credentials` ever; preflights never reach `api` | L-SUN-01 |
| T05-42 | I | From the docs origin: a live key, a malformed key and a wrong-salt Sandbox key get 403 `sandbox_key_required` with no database statement | L-SUN-01 |
| T05-43 | E2E | On a docs build served with the staging salt, a key with the production salt is refused in the panel and never sent | L-MON-08 |
| T05-44 | E2E | Try it: a Sandbox key gets an answer from `/v4/whoami` and `POST /v4/customers` (AC-MON-12) | L-MON-08 |
| T05-45 | E2E | During a Try-it session no request reaches any origin but the docs origin and the API origin (route interception logs every request) | L-MON-08 |
| T05-46 | E2E | After a session, local storage, session storage, IndexedDB, cookies and the Cache API are empty; a reload drops the key | L-MON-08 |
| T05-47 | E2E | A live key is refused in the panel; the same request sent directly with the docs `Origin` is refused by the edge | L-MON-08 |
| T05-48 | E2E | No `securitypolicyviolation` on any docs page; `env.json` failing to load leaves the reference unmounted with its failure state, and reports stage `document` | L-MON-08 |
| T05-49 | E2E | A problem's `type` from Try it opens its `/errors/<code>` page | L-MON-08 |
| T05-50 | B | The built site with `_headers` rendered from spec 01 §7.4's `docs` profile for a test environment: exactly one `Content-Security-Policy` rule per path; FW-C05's policy rule as §8.11 states it (`'unsafe-inline'` only in `style-src`, `data:` only in `img-src`, no other `unsafe-*`, `data:`, `blob:`, `ws:` or origin but the API's), and the build fails if `apps/docs` holds a headers file of its own; no inline script, handler or `style` attribute in any HTML; no `data:` or `http:` URL in CSS built from Fin's sources, and in Scalar's bundled stylesheet only `data:image/` URLs and no `http:` URL; no `*.map`; no provider name; no valid-checksum key or `whsec_` value | L-SUN-09 |
| T05-51 | B | The Markdown renderer: refusals of §8.5 with file and line; escaping; unique anchors; every internal link resolves | L-SUN-09 |
| T05-52 | B | One `/errors/<code>` page per public code and none other | L-MON-08 |
| T05-53 | E2E | Guide pages render and read without JavaScript (`javaScriptEnabled: false`) | L-MON-08 |
| T05-54 | B, E2E | Every `DOCS_LINKS` target exists; in a browser each scrolls into view; legacy anchors on `/` land on their sections | L-MON-08 |
| T05-55 | E2E | Search finds an operation by summary, an event by type and an error by code, and opens it | H-08 |
| T05-56 | B | Bundle budgets of §8.14 | L-SUN-09 |
| T05-57 | I | `/reports/docs`: wrong origin 403; over 8 KB 413; a planted address, key or email in any field never reaches the shipped line; caps drop and count | L-MON-08 |
| T05-58 | E2E | Phone widths 390px and 360px, light and dark, for home, a guide, the reference, an error page | L-MON-08 |
| T05-59 | STG | The header matrix on staging: `/`, a guide, `/reference`, `/assets/<file>`, `/env.json` and an unknown path each carry the `docs` profile's headers once; an unknown path and `docs.<staging-zone>/api/x` each answer the home page with status 200 from the static host (never the tunnel), and in a browser show "Page not found" with `noindex`; `fin-next-staging-docs-static` reads back with spec 01 §7.4's invariant and is not reachable on `workers.dev` | L-MON-09 |
| T05-60 | STG | The release smoke calls `GET /v4/whoami` with the smoke organisation's Sandbox key and opens the reference | L-MON-09 |
| T05-61 | E2E | On the static host with the single-page fallback, `/no-such-page` and `/guides/no-such-guide` answer 200 with the home page; the shell shows "Page not found" with its links, sets that title and adds `noindex`; the legacy-anchor redirect does not run; `/` itself still shows the home content | L-MON-08 |

---

## 14. Acceptance criteria

| ID | Label | Statement | EXECUTION |
|---|---|---|---|
| A05-01 | U | Keys are built and parsed per §4.1 and the TypeScript CRC-32 matches Node's | |
| A05-02 | I | A key from another deployment is refused before any lookup; a flood of well-formed unknown keys is shed before Postgres; a revoked key is refused at once; every 401 is identical; a live key sent over plain http is refused and revoked | AC-SUN-02 |
| A05-03 | I | `GET /v4/whoami` answers a working key of each kind and mode with `ApiKey` | |
| A05-04 | I | Each route refuses a restricted key without its scope, a restricted key on a full-access route, and a live key on a Sandbox route or, before PG-14, a money route | |
| A05-05 | I | Address allowlists and live gating behave as §4.3 and §4.5 | |
| A05-06 | I | Every key lifecycle action and exposure writes its audit event and queues its email in the same transaction | |
| A05-07 | I | A second POST with the same `Idempotency-Key` and body replays with `Idempotent-Replayed`; another body gets 422; while the first runs, 409; a secret-bearing replay carries no secret and works only for the same key ID; no stored row matches a secret shape | AC-SUN-03 |
| A05-08 | I | Money routes follow spec 04 §16.1: required keys, permanent binding, replays 200 with `Idempotent-Replayed` | AC-MON-03 (part) |
| A05-09 | U, I | Cursors cannot be edited or reused, page both ways and never use `OFFSET` | |
| A05-10 | I | Every error is a problem document whose `type` resolves to a built page, with `status`, `code`, `next_actor` and `request_id` right | |
| A05-11 | I | Rate-limit headers on every working-key answer; 429 with `Retry-After`; the limiter fails closed | |
| A05-12 | U | `Fin-Version` per §3.6 | |
| A05-13 | I | `Request-Id`, `Cache-Control: no-store` and the security headers on every answer, including the edge's own | |
| A05-14 | C | Route parity both ways and the negative test pass | AC-SUN-01 |
| A05-15 | CI | Fragments regenerate with no diff; `oasdiff` and `vacuum` pass | |
| A05-16 | I | No key, session or role reads or changes another organisation's or the other mode's objects, per route and mode | AC-SUN-07 |
| A05-17 | I | Every write through the API is audited with `via: "api"`, the key ID, the mode and the request ID | AC-SUN-10 (part) |
| A05-18 | U | Webhook signing matches the fixed vector; the guides' verifiers pass it | |
| A05-19 | I | Endpoint URLs are refused for every rule of §5.3.4 at save and at send; redirects are not followed; an endpoint that does not answer the challenge is not enabled; the test receiver is in-process | AC-SUN-09 |
| A05-20 | I | Delivery follows §5.4: 15 tries on the schedule, 410 disables, the end-of-window pause holds deliveries and emails, caps hold | |
| A05-21 | E2E | A Sandbox customer made by API completes the hosted flow; the developer receives `customer.*` webhooks verified by a reference verifier at a stand-in endpoint and at Fin's test receiver | AC-SUN-12 |
| A05-22 | I | Events are written in the action's transaction; `events.emit` refuses a type for the wrong role | |
| A05-23 | I | Answers, events, examples and the docs name no provider | AC-MON-07 |
| A05-24 | I | An API read of full deposit instructions writes its audit event | AC-MON-08 (part) |
| A05-25 | E2E | Try it with a Sandbox key calls the API host and works; a Production key is refused in the panel and at the API; the key is gone after reload; no request goes to another origin and nothing is stored | AC-MON-12 |
| A05-26 | U | The guard refuses every case of T05-40 | |
| A05-27 | I | CORS goes to the docs origin only; the edge refuses every non-Sandbox key from it before lookup | |
| A05-28 | B | The built docs pass T05-50 | |
| A05-29 | E2E | Every `DOCS_LINKS` target opens in view | |
| A05-30 | E2E | Guide pages read without JavaScript | |
| A05-31 | E2E | Search finds operations, events and errors (H-08) | |
| A05-32 | I | Docs failure reports are accepted only from the docs origin, capped and scrubbed | |
| A05-33 | STG | T05-59's header matrix passes on staging | |
| A05-34 | E2E | The docs pass at phone widths in light and dark | |
| A05-35 | STG | `api-canary`, `api-health`, `api-unauthenticated`, `docs` and `docs-openapi` are green; a drill of `key-sent-in-clear` and `webhook-dispatcher-stalled` fires | |
| A05-36 | B | Every public code has a page; every page's code is raised (H-08 for the full set) | |
| A05-37 | I | `resetSandbox` deletes only the calling organisation's Sandbox data and needs a full-access Sandbox key | |
| A05-38 | I | `searchCustomers` finds by email, phone and name, and no personal data reaches a URL, a line or a cursor | |
| A05-39 | I | `listEvents` filters by type or group, customer, RFI and creation time | |
| A05-40 | STG | The getting-started guide and the reference for every Sunday and Monday operation are live on `docs.<staging-zone>` (R16 at staging-complete per EXECUTION §0.2) | |

By day: Saturday A05-01 to A05-06 (stretch); Sunday A05-07, A05-09 to A05-22, A05-27, A05-37 to
A05-39; Monday A05-08, A05-23 to A05-26, A05-28, A05-29, A05-32 to A05-35, A05-40; H-08 A05-30,
A05-31, A05-36.

---

## 15. Spikes and unverified facts

| Item | Status | Confirmed by | If it fails |
|---|---|---|---|
| Scalar 1.78.1's option names and shapes (§8.6), the request headers it sends (for CORS), the anchor format it renders, how to catch a render failure, and that a Try-it session leaves every store empty | SPIKE | SP-14, rescoped to the assets-only deployment: Monday 08:00, before L-MON-08's first ready pull request | a reviewed bump to the first version that passes, or the storage test fails the lane |
| That Scalar 1.78.1 needs `style-src 'unsafe-inline'` and `img-src data:` (found by the old product's docs build), and where its `data:` images come from | UNVERIFIED for fin-next | SP-14: the reference mounted under the strict `style-src 'self'` and `img-src 'self'`, every violation recorded | a value no violation needs is dropped from the `docs` profile (§8.11) |
| `_headers` `!` detach on an assets-only deployment, for `Content-Security-Policy` as well as `Cache-Control`, and that the `/*` rules apply to a single-page fallback answer | `Cache-Control`: confirmed on 21 Nov (SP-26's data points from S-01's run). The rules apply to a single-page fallback answer by its request path (S-01 (b) with the test `_headers`, and NF-1). `Content-Security-Policy`: UNVERIFIED | S-01's run, 21 Nov; T05-59 for `Content-Security-Policy` | For `Content-Security-Policy`: the docs exception stays site-wide (§8.11) |
| `html_handling: auto-trailing-slash` serving `guides/<slug>.html` at `/guides/<slug>` | UNVERIFIED | T05-59 | generate `guides/<slug>/index.html` |
| `@hono/zod-openapi` 1.6.3 emitting a `3.1.1` document from `getOpenAPI31Document` with the components named | UNVERIFIED | L-SUN-01's first fragment | post-process the version field in `fragments.ts` |
| oasdiff v1.39.0 and vacuum v0.42.1 flag names | UNVERIFIED | when CI wires them | adjust flags, not rules |
| Whether Cloudflare Logpush includes assets-only requests in `http_requests` | UNVERIFIED | the ops lane, with [FD-08] | docs request visibility from zone analytics only |
| A cross-origin `no-cors` POST with `keepalive` from the docs page reaching the edge with `Origin` set | UNVERIFIED (spec-read) | T05-57 in Chromium, Firefox and WebKit | send with `mode: "cors"` and a simple content type |

The routing checks of spec 01's SP-25 for `/api/`, (c) to (g), do not apply to the docs host, which
has no `/api/` path. Its checks (a) and (b), the static answer with the test `_headers` for `/` and
for a deep link, passed on 21 Nov on S-01's throwaway host (`c1-spike.<staging-zone>`), not on the
docs host, which T05-59 checks on staging; and SP-26's data point from the same run shows
`! Cache-Control` detaching on an assets-only deployment (§8.11).

---

## 16. Decisions this spec makes (for the register)

| ID | Decision | Instead of |
|---|---|---|
| D05-01 | Docs failure reports go to the edge at `POST /reports/docs`, outside `/v4` and the document | `POST /failed/<stage>` on a docs server that OD-2 removed |
| D05-02 | One docs build for every environment; `env.json` gives the API origin, docs origin, console origin and salt at run time; the document's server is a variable that the reference replaces; samples use `$FIN_API_URL` | per-environment builds |
| D05-03 | One page policy for the whole docs site: spec 01 §7.4's `docs` profile, the only header source, with the docs exception (`style-src 'unsafe-inline'`, `img-src data:`) while Scalar needs it and only with the owner's yes under [AP-11]; narrowed to `/reference` once `!` detach is proven for `Content-Security-Policy` (T05-59; it holds for `Cache-Control`, §8.11) | a split policy before that is proven; a docs-owned headers template that differs from spec 01's profile |
| D05-04 | The docs follow the system colour scheme with no theme switch, so nothing is stored | `localStorage` theme ([UI-13] for the apps) |
| D05-05 | No `@sentry/*` on the docs site | the apps' browser error client |
| D05-06 | Fin's own build-time sample generator | a direct `@scalar/snippetz` dependency |
| D05-07 | The guard adds an `Idempotency-Key` to a POST that has none | Scalar's experimental request hook |
| D05-08 | The checksum is CRC-32 (IEEE) over `salt + ":" + body`, base62 in the stated alphabet order, padded to 6; salts `fin-dev-1`, `fin-ci-1`, `fin-stg-1`, `fin-prod-1` | unstated |
| D05-09 | The stored hash covers the whole key body, not the secret alone | secret only |
| D05-10 | GitHub-reported keys are revoked in both modes, as [SA-21] records; plain http revokes live keys only ([FD-03]) | live only for both |
| D05-11 | Allowlist entries must be public unicast, IPv4 at least /16, IPv6 at least /32, not Cloudflare's shared Workers address | any range |
| D05-12 | `resetSandbox` needs a full-access Sandbox key | a scope |
| D05-13 | `operationId`s keep the old names; four new operations named here | renames |
| D05-14 | Every list pages both ways with `previous_cursor`, newest first; no counts | per-list rules |
| D05-15 | Event filters `type`, `customer_id`, `rfi_id`, `created_gte`, `created_lt` | `created[gte]` style |
| D05-16 | Endpoint states add `verifying`, `unverified` and `disabled` (410 Gone, [AP-07]) and a `paused_reason`; resuming after `failing`, or re-enabling a `disabled` endpoint, verifies again; resume `send` restarts the schedule | three states |
| D05-17 | The challenge is three tries (0 s, 10 s, 60 s), 15 s each, answered by echo in JSON or text | one try |
| D05-18 | Caps: 5 in flight per endpoint, 20 per target host, 600 attempts a minute per host | unstated |
| D05-19 | The test receiver is made with `fin_test_receiver: true` (Sandbox only) | a URL |
| D05-20 | Endpoint creation, URL change, secret roll and deletion email Super admins and Admins as security notices | no email |
| D05-21 | Unknown and duplicated query parameters are refused | ignored |
| D05-22 | `errors[]` items carry `pointer` or `parameter`, `detail` and a fixed issue `code` | pointer only |
| D05-23 | JCS fingerprints; multipart by fields plus file hash; insert-first rows with a 120 s lease; fail closed | unstated |
| D05-24 | The cursor's byte layout and a 16-byte truncated MAC, binding route, organisation, mode and filters | unstated |
| D05-25 | `Fin-Version` starts at `2026-11-23`; `RELEASED` gates `oasdiff` | unstated |
| D05-26 | Rate-limit policy names and UTC-day windows for daily quotas; a shed 429 names no policy | unstated |
| D05-27 | CORS allows `fin-version`, exposes `Deprecation` and `Sunset`, `Max-Age` 7200 | spec 01's skeleton list |
| D05-28 | `api` unreachable or slow answers 503 `temporarily_unavailable` with `Retry-After: 5` | 500 |
| D05-29 | The public API sends no `Fin-Release` | FW-C13's app rule |
| D05-30 | `restartCustomer` is secret-bearing (it returns a link) | not marked |
| D05-31 | The Sandbox document quota answers 409 `sandbox_quota` (spec 03 confirms) | unstated |
| D05-32 | The docs deployment keeps the single-page fallback that OD-2 and [FD-17] set for every static build; an unknown path gets the home page with status 200, which the shell turns into "Page not found" with `noindex` (§8.1) | a `404-page` handler, which would break spec 01 §7.4's invariant and raise `static-deployment-changed`, or need the owner's yes for an exception |
| D05-33 | Guides are static HTML from restricted Markdown with `@fin/ui` islands for search and copy, without `packages/frame` | unstated |
| D05-34 | Lower-case Crockford in resource IDs; upper case refused in paths | unstated |
| D05-35 | Webhook endpoint deletion takes its deliveries; delivery snippets shown to the developer only | unstated |
| D05-36 | The `Event` resource keeps `created_at`; only the webhook body uses `timestamp` | renaming both |

---

## 17. Owner decisions this spec depends on

The owner decided [AP-01], [SA-18] and [SA-20] at their defaults at the Saturday sitting (21 Nov,
about 08:25: "defaults"). Each of the others applies its default if not answered
(DECISIONS "How to read it"):

| Decision | Default used here | Needed by |
|---|---|---|
| [AP-01] the path major | `/v4` | decided 21 Nov (the default) |
| [SA-18] keep `sk` and `rk` | kept | decided 21 Nov (the default) |
| [SA-20] roll overlap | now, 1 hour, 24 hours | decided 21 Nov (the default) |
| [BC-05] last used | kept, rounded to the minute | Saturday 18:00 |
| [AP-04] idempotency | as §3.4 | Sunday 08:00 |
| [AP-07], [BC-04] webhook changes, 15 tries | yes | Sunday 08:00 |
| [AP-08] Fin's own delivery | yes | Sunday 08:00 |
| [AP-16] `POST /v4/sandbox/reset` | yes | Sunday 08:00 |
| [UI-08] API words against screen words | yes | Sunday 08:00 |
| [MO-08], [MO-16] `amount`, the quote route | yes | Monday 08:00 |
| [AP-11], [AP-12] the reference exception (to `@fin/ui` and to the page policy), no docs board | yes, theme from tokens; the docs are not uploaded with `style-src 'unsafe-inline'` or `img-src data:` before the owner's yes (§8.11) | Monday 08:00 |
| [FD-10] the production docs domain | three registrable domains | Tuesday 24 Nov (error `type` URLs are permanent once served) |
| [FD-03], [SA-21], [AP-19] plain http, secret scanning, the deprecation notice | revoke; join; 12 months | production |
