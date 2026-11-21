# Spec 02: auth and roles (Saturday 21 Nov 2026, R6)

| | |
|---|---|
| Status | Build specification for Saturday's lanes L-SAT-01 to L-SAT-11, written on Saturday 21 Nov 2026 from ARCHITECTURE.md, DECISIONS.md, EXECUTION.md, spec 01 and the owner's decisions of 21 Nov. Builders build from this file alone |
| Part of | The fin-next plan (R13). It details EXECUTION §3 and ARCHITECTURE §7.1 to §7.7, §8 and the auth parts of §10, under the owner's later decisions as spec 01 §1 lists them (OD-1 to OD-6) |
| Requirements touched | R1, R2, R3, R4, R5, R6, R9, R10, R11, R12, R13, R14, R15, R16 (§0.2) |
| Lanes | L-SAT-01 to L-SAT-11 (§20), on top of Phase 0's P0-D, P0-E, P0-F and P0-G |
| Exit | §21: AC-SAT-01 to AC-SAT-24 (EXECUTION §3.6) and AC-SAT-25 to AC-SAT-48 (new here) |

**Public by design (R12).** This file names no credential, token, account, workspace, team or tunnel
ID, internal address, staff address or real person. Hosts are written `<app>.<zone>`; the staging
zone is `<staging-zone>`. Test addresses use `example.com`, `example.org` or `example.net` only.

---

## 0. How to read this spec

### 0.1 Precedence, IDs and placeholders

**Precedence.** The plan's one order (README §8.3) holds here. (1) The owner's decisions of 21 Nov
2026, which DECISIONS.md records and spec 01 §1 lists as OD-1 to OD-6. (2) DECISIONS.md, appendix C
included. (3) The specification that owns the area: this spec for sign-in in both realms, the second
factor, step-up, permissions and roles, organisations and teams, staff management and sessions; the
sibling that owns any other area (spec 05 for API keys' public conventions, webhooks and events);
and spec 08 for the cross-cutting rules of audit, security email, personal data, scrubbing, secrets
and observability. (4) ARCHITECTURE.md. (5) EXECUTION.md. A decision of this spec (S2-nn, §22)
binds where everything above it is silent. DECISIONS appendix C found none that changes a register
entry; if one is found later, the register holds until appendix C settles it. Where this spec
repeats a rule it names the section and keeps it short; where it differs from ARCHITECTURE or
EXECUTION, §1.3 says so. **UNVERIFIED** marks a library or platform behaviour that the named
spike or pin test confirms before work that depends on it merges.

| ID form | Meaning | Register |
|---|---|---|
| `[XX-nn]` | A decision | DECISIONS.md. Owner decisions due "before Saturday's start" apply their default from 09:00 unless answered |
| `OD-n` | An owner decision of 21 Nov 2026, by spec 01's short name; DECISIONS.md records each in its overnight table | spec 01 §1 |
| `S0-nn` | A decision spec 01 made | spec 01 §14 |
| `S2-nn` | A decision this spec makes where the plan is silent | §22; the steward copies each into DECISIONS.md in the plan's first follow-up pull request |
| `SF-nn` | A spec decision settled in the register before the first commit, folded or not adopted | DECISIONS appendix C |
| `IF-nn` | An interface this spec provides to, or needs from, other specs and Phase 0 | §20.6 |
| `AC-SAT-nn` | A Saturday acceptance criterion | 01 to 24 are EXECUTION §3.6's; 25 onwards are new here and follow EXECUTION's last number (§21) |
| `T-SAT-nn` | A test this spec requires | §19 |
| `L-SAT-nn`, `CUT-nn`, `NB-nn`, `EX-nn`, `CR-nn`, `RK-nn`, `H-nn` | Lanes, cut lines, never-cut rules, working rules, credentials, risks, hardening workstreams | EXECUTION.md |
| `PG-nn` | A production gate | EXECUTION §7.3. Production gates use `PG-` only; `G-` belongs to governance decisions |
| `SP-nn`, `FW-Cnn` | A spike; a framework condition | ARCHITECTURE §11.11 and §3.4, spec 01 §11 (SP-25, SP-26) |
| `F1` to `F23`, `F-<slug>` | A flow in ARCHITECTURE §2.3; a new flow for the Flow Atlas | §18.5 |

| Placeholder | Stands for |
|---|---|
| `<zone>` | The zone that holds the host in question. Under [FD-10] production puts Fin Admin on a registrable domain of its own, so `admin.<zone>` and `console.<zone>` need not share a zone |
| `<staging-zone>` | The staging zone ([FD-09]); every Saturday host lives here |
| `<team>`, `<aud>` | The Cloudflare Access team name and the application's audience tag, from the private overlay ([G-09]) |
| `<docs origin>` | `https://developer.<zone>`, the base of every problem `type` (spec 01 §4.4) |

**Words.** *Developer realm*: the Better Auth instance on the console. *Staff realm*: the one on Fin
Admin. *API half*: an app's Hono service on Railway, answering `<app>.<zone>/api/*` (spec 01 §0.1).
*Library endpoint*: a path Better Auth mounts under `/api/auth/`. *App route*: one of Fin's own JSON
routes under `/api/` (ARCHITECTURE §3.4). *Factor*: a passkey or an authenticator app (TOTP); backup
codes are a way to pass the factor step, not a factor. *Privileged*: holding, in any organisation, a
role with a permission marked P in §8.2 ([SA-05]). *Pending* staff: a staff member with no factor
yet ([SA-29]). *The inventory*: the record of the old product's screens and their exact copy, kept with
the design sources outside this repository ([UI-06]); the boards carry its wording, and where a board
and this spec disagree on a rule, this spec wins and L-SAT-10 updates the board.

### 0.2 Requirements this spec touches

| Req | What this spec gives it | Where |
|---|---|---|
| R1 | Auth written fresh from this spec ([G-04]); the never-cut rules NB-01 to NB-06; the production gates it feeds (PG-03, PG-05) | §1, §21 |
| R2 | The console and Fin Admin API halves, their realms and every table on Railway's Postgres | §2, §13 |
| R3 | Every code and security notice through `email.enqueue()` and Cloudflare Email Sending from `auth.<zone>`; invitations from `notify.<zone>` | §17 |
| R4 | The same-origin path through Cloudflare: static at the edge, `/api/*` through the tunnels, Access on Fin Admin; Cloudflare's headers trusted only from connector peers | §2 |
| R5 | One line per request and per job, the auth alert set, dashboard panels and monitors on Better Stack | §18 |
| R6 | Both realms; passkeys first; the mandatory second factor; step-up intents for adding or inviting someone; granular catalogues with prebuilt and custom roles; organisations, teams, invitations and staff | §3 to §12 |
| R9 | Every sign-in, session change, factor change, team, role, organisation and staff change audited in its transaction, with database guards on the critical tables, the sign-in tables of both realms included; the Audit log page and its entry points filtered to one object | §13.8, §15.2.1, §16 |
| R10 | Tier S review of every server path here, Saturday's attack profiles, the test-truth check | §20.4 |
| R11 | Receipts whose sessions stay within R11 and the effort floor gate every merge | §20.4 |
| R12 | Nothing private in code, tests, fixtures or this file; enrolment codes and secrets never leave their one screen | throughout |
| R13 | This spec is part of the plan in `docs/plan/` | this file |
| R14 | Screens from the "Fin Dashboard · new design" and "Fin Admin · new design" canvases, with the boards that R6 still needs | §15 |
| R15 | Node 26.13.1 only; Web Crypto and `node:crypto` for every ceremony, no native module | §3.1 |
| R16 | The API key format and the edge's key check (Saturday stretch), which Try it on Sandbox keys depends on | §12 |

R7 and R8 are Sunday's and Monday's; this spec only provides the interfaces they call (§20.6).

---

## 1. Scope

### 1.1 Must-have, deployed to staging by 23:59 (EXECUTION §3.1)

| # | Item | Sections |
|---|---|---|
| 1 | Two realms from one factory, each with its own secrets, `__Host-` cookies, passkey RP ID, schema and endpoint allowlist ([SA-01], [SA-09], [SA-10]) | §3, §4 |
| 2 | Developer sign-up with an 8-digit emailed code; sign-in with a passkey (button and autofill) or an emailed code; passkey and authenticator factors with 10 backup codes; one live code per purpose and 3 tries per code; sessions; sign out; sign out everywhere else; Account security | §5, §11 |
| 3 | The mandatory second factor: every staff session reaches only enrolment or the factor step until `aal2`; pending staff enrol only with the emailed code and an enrolment code; the last factor cannot be removed; privileged developers held at "Protect your account" with no "Skip" ([SA-04], [SA-05], [SA-29]) | §6 |
| 4 | Step-up intents on every credential, member, invitation, role, organisation, staff and kill-switch change; the 5-minute window for the old product's window step-ups ([SA-08], [BC-01]) | §7 |
| 5 | Organisations (create, switch, rename, delete; at most 10 as Super admin, [BC-06]), members, invitations, removal with credentials listed and rolled ([SA-33]), the outrank rule and the team-change lock ([SA-32]) | §9 |
| 6 | The 26 dashboard permissions with needs and step-up kinds; built-in Super admin and Admin; custom roles with the editor ([SA-11]) | §8 |
| 7 | Fin Admin: Access in front and checked on every `/api` request against the staff session; passkey-alone sign-in; the 26 staff permissions and prebuilt roles ([SA-12]); add staff with an intent and an enrolment code; change role; remove; the staff-change lock; the last Admin stays | §8.3, §10 |
| 8 | Audit of every auth event in its scope, in its transaction, with a test each; the database guard on identity and staff tables; address and device on every console and Fin Admin row ([BC-03]); the Audit log page | §13.8, §16 |
| 9 | Security emails through `email.enqueue()`, never dropped ([SA-41]) | §17 |
| 10 | Limits in Postgres, lockouts in logged tables ([DA-16]); sign-up velocity ([SA-40]); fail closed | §5.6 |
| 11 | Monitoring: one line per auth request and staff action; the alerts of §18.2 | §18 |
| 12 | The screens of §15.2 and §15.3 in their must-have states, each with a journey test | §15, §19.3 |

### 1.2 Stretch, in this order (EXECUTION §3.1), and where each goes under CUT-01

| # | Item | If it does not land | Sections |
|---|---|---|---|
| 1 | API keys and the edge's key check, only if L-SAT-02 is green at C3 (18:00) | Sunday 08:00 to 11:00 | §12 |
| 2 | Passwords, reset and new password ([SA-06]) | H-02 | §5.7 |
| 3 | Custom staff roles with AdminRoleEditor | Sunday's spill block | §8.4, §10.7 |
| 4 | The staff "Reset second factors" screen (the server route is must-have) | Sunday's spill block | §10.4 |
| 5 | Google sign-in in either realm | H-02 | §5.8 |

Sunday's spill block also takes AdminAccount, AdminRoles and AdminAudit (EXECUTION §4.5) and the
switches screen (S2-27). Developer account recovery ([SA-30]) is specified in §6.8 and built in
Sunday's spill block (S2-28).

### 1.3 What the owner's decisions of 21 Nov change in the plan's auth text

ARCHITECTURE.md and EXECUTION.md now carry the owner's decisions of 21 Nov (spec 01 §1): the
static files at Cloudflare and only `/api/*` through the tunnel (FW-C03, FW-C10, §5.2, §5.3),
the cookie lines of §7.12 with the session `Strict` and every other auth cookie `Lax`, the
origin gate with `X-Fin-App` (FW-C09), screens on the UI SDK ([UI-10]), the `console-api`
monitor (§10.6) and the invitation token kept out of every path. This spec builds the auth parts
on that text: the Access token on every `/api/*` request (§2.1, §2.2), the cookies (§2.4), the
origin gate (§2.3), the viewer request that sends a signed-out page to `/sign-in?next=` (§14.1),
the screens (§15.1), the monitors (§18.4) and the invitation (§9.3). One row remains, for the
record:

| Plan text | What applies now | Effect here |
|---|---|---|
| EXECUTION §1.4: specs in `docs/specs/<area>.md` (since corrected) | Every spec lives in `docs/plan/specs/`; no `docs/specs/` folder exists | This file; EXECUTION EX-08, P0-0 and the L-SPEC row, ARCHITECTURE §3.1's layout, spec 01's layout and DECISIONS CF-86 now say the same |

### 1.4 Out of scope here

KYC, hosted links and go-live (Sunday); money (Monday); the public API beyond `GET /v4/whoami`
(Sunday); webhook signing secrets (Sunday; §9.4 defines the hook they plug into); staff reveal
budgets and the second approver ([SA-39], Sunday); Turnstile ([FD-06], before production, if
approved). The forms that send email (`POST /api/sign-up`, the code requests) keep a slot for a
Turnstile token that is ignored until then.

---

## 2. Hosts, routing and the request path

### 2.1 Hosts

| Host | Static half | `/api/*` | Service | Realm | Passkey RP ID |
|---|---|---|---|---|---|
| `console.<zone>` | Workers route `console.<zone>/*` to the assets-only deployment `console` (spec 01 §7) | Zone route `console.<zone>/api/*` with no Worker; the proxied CNAME sends it to the public tunnel; ingress `hostname: console.<zone>`, `path: ^/api/` to `http://console.railway.internal:8080` | `console` | developer | `console.<zone>` |
| `admin.<zone>` | The same on the admin host, behind the Access application that covers the whole host | Through the admin tunnel; the connector requires a valid Access token (`originRequest.access.required`, `<team>`, `<aud>`) | `admin` | staff | `admin.<zone>` |

Each tunnel ends with `http_status:404`. `/healthz` and `/readyz` are never reachable from outside
(spec 01 §6.4). A request for `/api` without a trailing slash reaches the static SPA, which defines no
route under `/api`.

**The spike first** (SP-25, run as S-01 at EXECUTION §2.6's one slot, 09:15 to 09:45 on the
throwaway host `c1-spike.<staging-zone>`, with spec 01 §11's added checks; owner: the ops agent): the no-Worker
route falls through to the tunnel on a throwaway host. **If SP-25 fails**, the fallback is per-app API
hosts on the same site (`console-api.<zone>`, `admin-api.<zone>`), and §2.6 gives every setting that
changes. The code reads one mode from configuration, so the fallback is a settings change plus a
`_headers` change, never a code change (S2-01).

### 2.2 The API half's front door, in order

`packages/web-host` (P0-D) builds it; the realms plug into steps 7 and 8. Every answer carries
`Cache-Control: no-store`, `Fin-Release`, `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.

| Step | What | Refusal |
|---|---|---|
| 1 | Private health (`/healthz`, `/readyz`) for private callers only | `404` through a tunnel |
| 2 | Ingress: the TCP peer is a current replica of the service's own connector services and the host's `Fin-Ingress-Proof` matches; only then are `CF-*` headers trusted; `Host` equals the configured host; the URL is rebuilt from `FIN_PUBLIC_ORIGIN` (ARCHITECTURE §5.5) | `403 ingress.untrusted_peer`; `421` on a wrong host |
| 3 | Body limit 256 KB | `413` |
| 4 | **Fin Admin only:** a valid Access JWT in `Cf-Access-Jwt-Assertion` (§10.5) | `401 access_required` |
| 5 | The path starts with `/api/`; `GET /api/health` answers here | `404` |
| 6 | The origin gate on every method but GET, HEAD and OPTIONS (§2.3); on a GET that redeems a minted URL, the fetch-site guard instead (§2.3) | `403 invalid_origin` |
| 7 | `/api/auth/*`: the realm's exact allowlist (§4), then the realm's gate and step-up checks (§6, §7), then Better Auth | `404` for unlisted paths, before any limit is counted |
| 8 | App routes, each declared in the route policy with guard, permission, step-up kind, schema, organisation scope and audit events (FW-C07, §14.1) | as §14.1 |
| 9 | Anything else under `/api/` | `404` |

### 2.3 CSRF: the origin gate and what sits under it

The gate (spec 01 §4.4, OD-4) runs on every unsafe method, `/api/auth/*` included, and refuses with
`403`, problem `type <docs origin>/errors/invalid_origin`, and a `request` line with `outcome: refused`
and `reason: origin_gate.<code>`:

| Order | Check | Code |
|---|---|---|
| 1 | `Origin` present, not `null`, equal to `FIN_PUBLIC_ORIGIN` exactly | `origin_missing`, `origin_mismatch` |
| 2 | `Sec-Fetch-Site`, when present, is `same-origin` | `fetch_site` |
| 3 | `X-Fin-App` is `console` on the console and `admin` on Fin Admin | `app_header` |
| 4 | A body is `application/json`; a body-less POST carries no content type | `content_type` |

The only exemption is `GET /api/auth/callback/google`; `POST /api/auth/callback/*` is refused. Under
the gate: Better Auth's own origin and CSRF checks stay on ([SA-09]: `disableOriginCheck: false`,
`disableCSRFCheck: false` in every build, including tests); the session cookie is `Strict`; every
cookie is `__Host-`; GET never changes state (below). Redirect targets (`next` in the SPA, `callbackURL`,
`errorCallbackURL`, `newUserCallbackURL` for Google) must be a path that starts with exactly one `/`
and is in the app's route list, or an absolute URL on `FIN_PUBLIC_ORIGIN`; anything else is refused
(`400 invalid`).

**GETs** ([SA-44]). The gate skips GET, and a sibling page on the same site (every staging host shares
`<staging-zone>`) can make a GET that carries the `Strict` session cookie. So no GET writes an audit
row, spends a budget or uses up a step-up intent; whatever is audited or counted happens at a gated
POST. The one kind of GET that changes anything is the redeeming of a single-use URL that a gated POST
minted for this session (Fin Admin's document view, spec 03 §12.2): its policy entry declares
`fetchSite: "same-origin-or-none"`, and `Sec-Fetch-Site` must be present and `same-origin`, or `none`
for the URL opened directly in a tab; anything else is `403 invalid_origin` with code `fetch_site`.
The route-policy test (§14.1) fails on a GET that declares `audit`, a budget in `limits` or
`stepUp: "intent"`, and on a redeeming GET without `fetchSite`. Under the split-host fallback (§2.6)
a redeeming GET also accepts `same-site`, as the gate does.

### 2.4 Cookies

Every cookie is `__Host-` prefixed, `Secure`, `Path=/`, with no `Domain`, never `SameSite=None` and
never `Partitioned`. The session cookie is `Strict`; every other cookie is `Lax` (OD-4; research note
C3 §3.4). Nothing in the browser reads them: all are `HttpOnly`.

**Developer realm** (set by `console.<zone>`):

| Cookie | Set by | Max-Age | SameSite | Holds |
|---|---|---|---|---|
| `__Host-fin.session_token` | Better Auth | 86,400 (refreshed with the session) | Strict | the signed session token |
| `__Host-fin.better-auth-passkey` | the passkey plugin | 300 | Lax | the WebAuthn challenge reference |
| `__Host-fin.two_factor` | the two-factor plugin | 600 | Lax | the password sign-in challenge (only with passwords, §5.7) |
| `__Host-fin.state` | Better Auth | 300 | Lax | the OAuth state (only with Google, §5.8) |
| `__Host-fin.code_browser` | Fin | 86,400 | Lax | a random token binding an emailed code to the browser that asked (§5.2) |
| `__Host-fin.sign_up_browser` | Fin | 86,400 | Lax | a random token binding a sign-up request to its browser (§5.1) |
| `__Host-fin.known_browser` | Fin | 31,536,000 | Lax | a random token naming a browser the account has used (§5.5) |
| `__Host-fin.trusted_browser` | Fin | 2,592,000 | Lax | a random token for a trusted-browser row (§6.6) |
| `__Host-fin.invitation` | Fin | 86,400 | Lax | a signed invitation ID after the token was exchanged (§9.3) |

Never set: `__Host-fin.dont_remember` (no "remember me" exists), `__Host-fin.trust_device` (the
library's trust cookie is not used, [SA-31]), `__Host-fin.session_data` (the cookie cache is off).

**Staff realm** (set by `admin.<zone>`): `__Host-fin-admin.session_token` (Max-Age 3,600, refreshed,
Strict), `__Host-fin-admin.better-auth-passkey` (300, Lax), `__Host-fin-admin.code_browser` (600,
Lax), `__Host-fin-admin.state` (300, Lax, only once Google is enabled). Access sets its own
`CF_Authorization` (HttpOnly, `SameSite=Lax`) and the binding cookie `CF_Binding` ([FD-05]).

Fin's random tokens are 32 bytes from `crypto.getRandomValues`, base64url; the database stores only
their HMAC-SHA256 under `FIN_LIMIT_KEY_<n>` (ARCHITECTURE §7.8). The theme and sidebar choices live
in `localStorage`, not cookies (spec 01 §1.1).

### 2.5 What each app's `_headers` must carry for auth

P0-G and P0-D own the file and its renderer (spec 01 §7.4); auth needs these, checked by T-SAT-05:
`Permissions-Policy` allowing only `publickey-credentials-get=(self)` and
`publickey-credentials-create=(self)` (everything else denied); `connect-src 'self'` under the
same-origin shape; `Referrer-Policy: same-origin`; `form-action 'self'`; `frame-ancestors 'none'`;
`index.html` with `Cache-Control: no-cache`.

### 2.6 The split-host fallback (only if SP-25 fails)

| Setting | Same-origin (default) | Split host (fallback) |
|---|---|---|
| `FIN_PUBLIC_ORIGIN` (the page) | `https://console.<zone>` | `https://console.<zone>` |
| `FIN_API_ORIGIN` | unset (equals the page) | `https://console-api.<zone>` |
| Better Auth `baseURL` | `https://console.<zone>` | `https://console-api.<zone>` |
| `trustedOrigins` | `["https://console.<zone>"]`, set explicitly ([SA-43]); the resolved set is exactly that origin | `["https://console.<zone>"]`; the resolved set is that origin and the API host's (from `baseURL`) |
| Passkey `rpID`, `origin` | `console.<zone>`, `https://console.<zone>` | the same (the page host, never the API host) |
| CORS | none | exact `https://console.<zone>`, credentials, methods `GET, POST, PUT, PATCH, DELETE`, headers `content-type, x-fin-app, fin-organization, fin-step-up-intent, idempotency-key`, `Access-Control-Max-Age: 7200`, `Vary: Origin` |
| `Sec-Fetch-Site` in the gate | `same-origin` | `same-site` |
| Auth client `baseURL` | omitted (relative `/api/auth`) | `https://console-api.<zone>`, `credentials: "include"` |
| Redirect URLs sent by the client | relative paths | absolute `https://console.<zone>/...` |
| `_headers` `connect-src` | `'self'` | `'self' https://console-api.<zone>` |
| Fin Admin | the same host | one Access application with exactly `admin.<zone>` and `admin-api.<zone>` in `destinations`; `cors_headers` for `https://admin.<zone>` with credentials and `max_age: 7200` |

Both modes have unit tests (T-SAT-06); the journeys run in the chosen mode only. A service refuses to
start if `BETTER_AUTH_TRUSTED_ORIGINS` is set in either mode.

---

## 3. Better Auth: versions, plugins and configuration

### 3.1 Versions ([SA-02], EX-22; ARCHITECTURE §3.3)

| Package | Pin | Notes |
|---|---|---|
| `better-auth`, `@better-auth/core`, `@better-auth/passkey`, `@better-auth/drizzle-adapter` | 1.7.25 now; all four to 1.7.27 together on Monday 23 Nov after 10:53 UTC, in one dependency pull request gated by T-SAT-01 and T-SAT-02 | `overrides` pins `@better-auth/core` exactly, with a dated comment ([G-06]). Never `1.8.0-beta`. The identity lane reads the 1.7.26 and 1.7.27 release notes before its first merge; an advisory on a mounted plugin goes to the owner ([SA-27]) |
| `@better-auth/utils`, `better-call` | exactly what the pinned `better-auth` declares | moved with the group |
| `@simplewebauthn/browser` | 13.3.0 | the passkey plugin's peer; `@simplewebauthn/server` 13.3.2 arrives with the plugin |
| `hono` 4.13.19, `@hono/node-server` 2.1.9 (2.1.11 from 23 Nov), `zod` 4.6.7, `drizzle-orm` 0.45.4, `pg` 8.23.1 | | spec 01 §4.8 |
| Runtime | Node 26.13.1 | argon2id through `node:crypto` (`crypto.argon2`), TOTP and HMAC through `node:crypto`; no native module |

### 3.2 `createRealm()` (`packages/identity/src/realm.ts`)

One factory builds both instances with the same hardening ([SA-01]). It is called once per process
inside `main()`, never at module scope (ARCHITECTURE §1 principle 14).

```ts
type RealmName = "developer" | "staff";
interface RealmConfig {
  realm: RealmName;
  publicOrigin: string;            // FIN_PUBLIC_ORIGIN, validated https outside development
  apiOrigin?: string;              // FIN_API_ORIGIN, split-host fallback only (§2.6)
  rpId: string; rpName: string;    // "console.<zone>", "Fin" | "admin.<zone>", "Fin Admin"
  totpIssuer: string;              // "Fin" in production, "Fin (staging)" in staging (S2-02)
  secrets: { version: number; value: string }[]; // from BETTER_AUTH_SECRETS, newest first
  db: FinDatabase;                 // the process pool and unit of work (packages/db)
  clock: Clock;
  email: EmailEnqueue;             // email.enqueue() in the caller's transaction
  audit: RecordAudit;
  limits: LimitStore;              // atomic consume(), §5.6
  features: { passwords: boolean; google: boolean };
  environment: "development" | "test" | "staging" | "production";
}
interface Realm {
  handler(request: Request, context: RequestContext): Promise<Response>; // behind §4's allowlist
  api: AuthServerApi;              // the library's server API, for Fin's own routes
  policy: EndpointPolicy;          // §4
  sessionOf(request: Request): Promise<RealmSession | null>; // reads and refreshes; §11
}
```

`BETTER_AUTH_SECRETS` is `"<version>:<value>,<version>:<value>"`, newest first; the newest signs and
encrypts, older versions only decrypt; each value is at least 32 random bytes. The library option
name for versioned secrets is read from the installed source (SP-10, UNVERIFIED as a name); if the
installed version takes only one secret, the factory passes the newest and Fin's `reencrypt` task
(ARCHITECTURE §7.8) moves stored values before an old version is retired.

### 3.3 Options per realm

| Option | Developer realm | Staff realm |
|---|---|---|
| `appName` | `Fin` | `Fin Admin` |
| `baseURL` | `FIN_PUBLIC_ORIGIN` (a static setting, never from `Host`) | the same |
| `basePath` | `/api/auth` | `/api/auth` |
| `trustedOrigins` | `[FIN_PUBLIC_ORIGIN]`, set explicitly (`["https://console.<zone>"]`; split host: §2.6) | `[FIN_PUBLIC_ORIGIN]` (`["https://admin.<zone>"]`) |
| `telemetry.enabled` | `false` | `false` |
| `database` | `drizzleAdapter(db, { provider: "pg", schema, schemaName: "identity", transaction: true })` | `schemaName: "staff"` |
| `user.modelName` | `user` | `member` |
| `advanced.cookiePrefix` | `__Host-fin` | `__Host-fin-admin` |
| `advanced.useSecureCookies` | `false` (so no `__Secure-` lands in front of `__Host-`) | `false` |
| `advanced.defaultCookieAttributes` | `{ secure: true, httpOnly: true, sameSite: "lax", path: "/" }` | the same |
| `advanced.cookies.session_token.attributes` | `{ sameSite: "strict" }` | the same |
| `advanced.crossSubDomainCookies` | never set | never set |
| `advanced.disableOriginCheck`, `advanced.disableCSRFCheck` | `false`, `false` | `false`, `false` |
| `advanced.ipAddress` | `{ ipAddressHeaders: ["cf-connecting-ip"], ipv6Subnet: 48 }` (trusted only because step 2 of §2.2 drops the header on non-tunnel traffic) | the same |
| `advanced.database.generateId` | Fin's `newId` by model: `user` `usr`, `session` `ses`, `account` `acc`, `verification` `ver`, `passkey` `pky`, `twoFactor` `tfa` | `member` `stf`, `session` `sts`, `account` `acc`, `verification` `ver`, `passkey` `pky`, `twoFactor` `tfa` |
| `advanced.backgroundTasks.handler` | the process's `waitUntil` registry | the same |
| `session.expiresIn`, `session.updateAge` | 86,400 s, 600 s | 3,600 s, 300 s |
| `session.cookieCache` | `{ enabled: false }` | the same |
| `session.additionalFields` (all `input: false`) | `assurance`, `absoluteExpiresAt`, `createdVia`, `mailboxProvedAt`, `trustedBrowserId`, `stepUpFailures`, `currentOrganizationId` | `assurance`, `absoluteExpiresAt`, `createdVia`, `accessSub`, `enrolmentOpenUntil`, `stepUpFailures` |
| `user.additionalFields` (all `input: false`) | none | `roleKey`, `status`, `factorEnrolledAt`, `addedBy`, `lastSignedInAt`, `removedAt` |
| `rateLimit` | `{ enabled: true, window: 10, max: 100, customStorage: <Fin's atomic consume>, customRules: §5.6 }` | the same, staff rules |
| `emailAndPassword` | `features.passwords` (stretch): `{ enabled, minPasswordLength: 12, maxPasswordLength: 128, requireEmailVerification: true, autoSignIn: false, revokeSessionsOnPasswordReset: true, password: { hash, verify } }` with argon2id ([SA-07]) | `{ enabled: false }` |
| `socialProviders.google` | `features.google` (stretch): `{ prompt: "select_account", disableIdTokenSignIn: true }` | built, off until the Workspace client exists ([SA-15]) |
| `account.accountLinking` | `{ enabled: true, disableImplicitLinking: true, allowDifferentEmails: false }` | `{ enabled: false }` |
| `account.storeStateStrategy`, `account.skipStateCookieCheck` | `"database"`, `false` | the same |
| `verification.disableCleanup` | `true` (the worker's sweep deletes expired rows, §13.4) | `true` |
| `onAPIError` | `{ throw: true, errorURL: "<FIN_PUBLIC_ORIGIN>/sign-in" }` | the same |
| `logger` | `{ level: "warn", log: <Fin's scrubbing logger> }` | the same |
| `disabledPaths` | the realm's blocked list without parameters (§4), as a second layer behind the allowlist | the same |
| `hooks`, `databaseHooks` | §3.5 | §3.5 |

### 3.4 Plugins

| Plugin | Developer realm | Staff realm |
|---|---|---|
| `emailOTP` | `{ otpLength: 8, expiresIn: 900, allowedAttempts: 3, storeOTP: "hashed", disableSignUp: false, sendVerificationOnSignUp: false, overrideDefaultEmailVerification: true, sendVerificationOTP }` | `{ otpLength: 8, expiresIn: 600, allowedAttempts: 3, storeOTP: "hashed", disableSignUp: true, sendVerificationOTP }` |
| `passkey` (`@better-auth/passkey`) | `{ rpID: "console.<zone>", rpName: "Fin", origin: "https://console.<zone>", authenticatorSelection: { residentKey: "required", userVerification: "required" } }` | `{ rpID: "admin.<zone>", rpName: "Fin Admin", origin: "https://admin.<zone>", authenticatorSelection: { residentKey: "required", userVerification: "required" } }` |
| `twoFactor` | `{ issuer, allowPasswordless: true, skipVerificationOnEnable: false, totpOptions: { digits: 6, period: 30 }, backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" }, accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 3600 } }` | `{ issuer, allowPasswordless: true, skipVerificationOnEnable: false, totpOptions: { digits: 6, period: 30 }, accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 3600 } }`; backup codes are removed from every answer and never stored (S2-03) |

**Never mounted** in either realm: `organization`, `admin`, `magicLink`, `apiKey`, `sso`, `scim`,
`oidcProvider`, `@better-auth/oauth-provider`, `multiSession`, `phoneNumber`, `anonymous`,
`deviceAuthorization`, `bearer`, `jwt`, `username`, `oneTap`. Attestation stays `none` ([SA-03]).

### 3.5 Hooks Fin installs

| Hook | What it does |
|---|---|
| `hooks.before` | In this order: the realm's assurance gate for the path (§6.2, §6.4); the step-up rule for `step_up_self` paths (§7.6); Fin's own limits (§5.6); strips `trustDevice` and `rememberMe` from bodies, remembering `trustDevice` for §6.6; binds a code request to its browser (§5.2); on the staff realm, sends a code only to an eligible address and binds every sign-in to the Access identity (§10.5); refuses an account-creating code sign-in while the `signups` kill switch is on (§5.1) |
| `hooks.after` | Records proofs for every factor shown (passkey authentication or registration, a TOTP or backup code), raises the session to `aal2`, and marks a step-up intent proved (§7.4); writes the audit events of §16 for library actions that `databaseHooks` cannot see; queues the security emails of §17; on the staff realm, completes enrolment (§10.3) and removes `backupCodes` from `/two-factor/enable` answers |
| `databaseHooks.session.create.before` | Sets `assurance`, `createdVia`, `mailboxProvedAt` and `absoluteExpiresAt` (inherited when a passkey step-up replaces a session, §11.3) |
| `databaseHooks.session.update.before` | Never lets `expiresAt` pass `absoluteExpiresAt` |
| `databaseHooks.user.create.before` and `.after` | Developer: only a code sign-in may create a user; applies the browser's sign-up request (name, and password with §5.7) and writes `user.created` in the same transaction. Staff: refuses every creation (staff rows are made only by §10.2 and §10.6) |
| After-hooks on `/passkey/verify-registration`, `/passkey/delete-passkey`, `/two-factor/enable` (finished by `/two-factor/verify-totp`) and `/two-factor/disable` | Write `passkey.added`, `passkey.removed`, `two_factor.enabled`, `two_factor.disabled` (and the staff equivalents): the plugins' models have no `databaseHooks` (UNVERIFIED, SP-10) |

**Transactions** (S2-04). Every library endpoint that writes a sign-in table runs inside Fin's own
unit of work, so the guard of §13.8 never depends on when the library's hooks run. The API half opens
the request's transaction before it calls `realm.handler()` and binds it to the request
(`AsyncLocalStorage`); the realm's Drizzle adapter takes its connection from that binding. The
library's writes (users, sessions, accounts, verification rows, and the plugins' passkey and
two-factor rows), the `databaseHooks`, the after-hook's audit events and its `email.enqueue()` calls
therefore share one transaction, and the library's own `transaction: true` calls become savepoints
inside it (UNVERIFIED, SP-10). The unit of work commits after the handler returns and before any byte
of the answer is sent. When the commit fails (a guard refusal, `FA010`), the answer and its
`Set-Cookie` headers are discarded, the client gets `500 internal`, and `database.audit_guard` pages.
SP-10 proves, on the installed version, that every adapter write of a request goes through the
binding and that `hooks.after` runs before the handler returns. **If that cannot be made to hold for
an endpoint, the endpoint fails closed:** it moves to `blocked` in §4, and Fin writes its own app
route for the action over the library's server API inside the unit of work. No table ever leaves the
guard list for this reason. SP-10's finding is recorded in `docs/plan/spikes.md`.

### 3.6 Library behaviour pinned by tests (SP-10, T-SAT-02)

On every Better Auth version: the paths that create a session and the `ctx.path` each hook sees; that
the two-factor plugin challenges only `/sign-in/email`; that `/two-factor/verify-totp` with a
signed-in session returns the same session and keeps the account lockout; the cookie names above;
each realm's router path list (§4); whether a TOTP code is accepted twice in one step; that a passkey
challenge works once; what a backwards signature counter does; that every adapter write of a
request, the plugins' models included, goes through the request's unit of work and that `hooks.after`
runs before the handler returns (§3.5); the versioned-secrets option; that `emailOTP` with `disableSignUp: false`
creates a user only through `/sign-in/email-otp`. A changed pin fails CI and the identity lane
re-reads the installed source before the bump merges ([SA-35]).

Where SP-10 shows the library accepts a TOTP code twice in one 30-second step, Fin adds the check in
`packages/identity/src/totp-replay.ts`: it decrypts the stored secret with the library's exported
`symmetricDecrypt`, finds the matching step with Fin's own RFC 6238 code
(`packages/crypto/src/totp.ts`, `node:crypto` HMAC-SHA1, window plus or minus one step), and refuses a
step not greater than `identity.totp_step.last_step` (or `staff.totp_step`), across sign-in and
step-up together.

---

## 4. The endpoint allowlist ([SA-09])

### 4.1 Rules

- `packages/identity/src/endpoint-policy.ts` lists every path each realm's router mounts, each as
  `public`, `session`, `step_up_self`, `step_up_org` or `blocked`, with the assurance it may be reached
  at and its limit. Listing a path twice throws at start-up.
- Matching is exact, on the raw path after `/api/auth`, before the router and before any limit is
  counted (the library counts per path, so `/sign-in/%65mail` or `//sign-in/email` would otherwise get
  allowances of their own). The only parameter path is `/callback/:id`, reachable only as
  `/callback/google` and only when Google is enabled.
- Anything unlisted, and anything `blocked`, answers `404` with an empty body and writes
  `auth.endpoint_blocked` (`class: unlisted | blocked`, the realm, never the raw path).
- `step_up_org` is empty in both realms: organisations, members and roles are Fin's own app routes
  ([SA-10]), so no library endpoint changes them. A test asserts it stays empty.
- `session` is empty at launch (the old product's only entry was the organisation plugin's).
- T-SAT-01 enumerates the router's paths for each realm on the installed version and fails when the
  set differs from the policy, so an upgrade that mounts a new path fails CI until it is listed.
  Moving a path out of `blocked` needs the owner's approval (AGENTS.md, [SA-09]).
- The tables below are the expected sets for 1.7.25 (from the old product's endpoint policy, read
  21 Nov 2026, with the organisation plugin removed). T-SAT-01 is the truth: where the installed
  router differs, the identity lane lists the new paths as `blocked`, records them in the pull
  request, and asks the owner before unblocking any.

"Factor step" means a session at `aal1` whose person has a factor (§6.2); "hold" means a privileged
developer with no factor (§6.3); "pending" is a staff member with no factor (§6.5).

### 4.2 Developer realm

| Path | Class | Reachable at | Fin limit (§5.6) | Notes |
|---|---|---|---|---|
| `/get-session` | public | any | default | read only |
| `/sign-out` | public | any | default | body-less POST; writes `session.ended` |
| `/error` | public | any | default | the library's error page |
| `/email-otp/send-verification-otp` | public | no session needed | `code_send` | `type` must be `sign-in` (anything else `400 invalid`); same answer for every address |
| `/sign-in/email-otp` | public | no session needed | `code_sign_in` | creates an account for an unknown address only in the asking browser (§5.1, §5.2) |
| `/passkey/generate-authenticate-options` | public | any | `passkey_options` | |
| `/passkey/verify-authentication` | public | any | `passkey_options` | makes an `aal2` session; replaces the caller's session on a step-up (§11.3) |
| `/two-factor/verify-totp` | public | factor step, hold, working | `factor_code` | signed-in branch for the factor step, step-up and finishing set-up; challenge branch only with passwords |
| `/two-factor/verify-backup-code` | public | factor step, working | `factor_code` | |
| `/passkey/generate-register-options` | step_up_self | hold, working | `method_add` | first factor under the first-factor rule, later ones with an intent (§7.6) |
| `/passkey/verify-registration` | step_up_self | hold, working | `method_add` | |
| `/two-factor/enable` | step_up_self | hold, working | `method_add` | finished by `/two-factor/verify-totp` |
| `/two-factor/disable` | step_up_self | working | never limited | the last-factor rule (§6.7) |
| `/two-factor/generate-backup-codes` | step_up_self | working | `backup_codes` | |
| `/passkey/delete-passkey` | step_up_self | working | never limited | the last-factor rule |
| `/sign-in/email` | public with passwords, else blocked | no session needed | `password_sign_in` | §5.7 |
| `/email-otp/request-password-reset`, `/email-otp/reset-password` | public with passwords, else blocked | no session needed | `code_send`, `code_sign_in` | §5.7 |
| `/change-password` | step_up_self with passwords, else blocked | working | `method_add` | §5.7 |
| `/sign-in/social`, `/callback/:id` | public with Google, else blocked | no session needed | default | `callback/google` only (§5.8) |
| `/link-social`, `/unlink-account` | step_up_self with Google, else blocked | working | `method_add` | §5.8 |

**Blocked**, with the reason recorded beside each in the file: `/ok`; `/sign-up/email` and
`/email-otp/verify-email` (sign-up is Fin's own route, S2-05); `/email-otp/check-verification-otp`
(a code oracle); `/send-verification-email`, `/verify-email`, `/request-password-reset`,
`/reset-password`, `/reset-password/:token`, `/forget-password/email-otp` (link-based flows acting on
a GET, research note C3 §2.2); `/change-email`, `/email-otp/change-email`,
`/email-otp/request-email-change` ([SA-30]); `/delete-user`, `/delete-user/callback` (not offered);
`/update-user`, `/update-session` (Fin's own routes instead); `/verify-password` (a password oracle);
`/list-sessions`, `/list-accounts`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`
(Fin's own paged routes, §14.2); `/get-access-token`, `/refresh-token`, `/account-info` (no Google
token is handed out); `/two-factor/get-totp-uri` (reveals the secret after set-up);
`/two-factor/send-otp`, `/two-factor/verify-otp` (no email second factor); `/passkey/list-user-passkeys`,
`/passkey/update-passkey` (Fin's own routes).

### 4.3 Staff realm

| Path | Class | Reachable at | Fin limit | Notes |
|---|---|---|---|---|
| `/get-session` | public | any | default | |
| `/sign-out` | public | any | default | |
| `/email-otp/send-verification-otp` | public | no session needed | `staff_code_send` | `type: sign-in` only; sends only to an eligible address (§10.5); same answer always |
| `/sign-in/email-otp` | public | no session needed | `staff_code_sign_in` | `disableSignUp: true`; makes an `aal1` session that lives 10 minutes |
| `/passkey/generate-authenticate-options` | public | any | `passkey_options` | |
| `/passkey/verify-authentication` | public | any | `passkey_options` | `aal2` when the passkey's staff member equals the Access identity (§10.5) |
| `/two-factor/verify-totp` | public | factor step, pending (finishing set-up), working | `factor_code` | needs a session; the challenge branch is unreachable (no passwords) |
| `/passkey/generate-register-options`, `/passkey/verify-registration` | step_up_self | pending (inside the enrolment window), working (with an intent) | `method_add` | §10.3 |
| `/two-factor/enable` | step_up_self | pending outside production, working (with an intent) | `method_add` | refused for a pending member in production: the first factor is a passkey ([SA-04]) |
| `/two-factor/disable`, `/passkey/delete-passkey` | step_up_self | working | never limited | the last factor is never removed |
| `/sign-in/social`, `/callback/:id` | public once the Workspace client exists, else blocked | no session needed | default | §5.8 |

**Blocked:** everything blocked in §4.2, and also `/two-factor/generate-backup-codes`,
`/two-factor/verify-backup-code` (no backup codes for staff), `/sign-in/email`, `/sign-up/email`,
`/change-password`, `/email-otp/request-password-reset`, `/email-otp/reset-password` (no passwords),
`/link-social`, `/unlink-account`, `/error`.

---

## 5. Sign-in methods: passkeys first ([SA-03], [SA-06], [SA-15])

### 5.1 Developer sign-up

1. `/sign-up` posts `POST /api/sign-up` `{ name, email }` (and `password` once passwords land). The
   route checks the `signups` kill switch (open refusal `503 paused`, the same for every address),
   the name rule (`personName`, §8.6), the sign-up velocity limits per address and per network
   ([SA-40]) and the per-recipient email limits; then, in one transaction:
   - **unknown address:** inserts `identity.sign_up_request` (name, email, password hash, the
     browser's `sign_up_browser` token HMAC, the invitation from `__Host-fin.invitation` if any,
     24-hour life), sets `__Host-fin.sign_up_browser`, and asks the library to send a sign-in code
     (`api.sendVerificationOTP({ body: { email, type: "sign-in" } })`); `sendVerificationOTP` queues the
     `confirm-email` template because a live sign-up request exists for this browser;
   - **existing account:** queues `already-registered` (no code) to the address.

   The answer is always `202 { "status": "code_sent" }`. No user row exists until the mailbox is
   proved, so nobody can pre-register an address (S2-05).
2. `/verify-email` takes the 8-digit code and posts `/api/auth/sign-in/email-otp`. The library
   creates the user because the address is unknown; `databaseHooks.user.create.before` allows it only
   from this path, only in the browser whose `code_browser` token asked (§5.2), and only while the
   `signups` switch is off (a code from elsewhere fails as a wrong code would); `.after` applies the
   matching sign-up request (the name, and a credential account with the stored argon2id hash), marks
   it used and writes `user.created`. The session is `aal1` with `mailboxProvedAt = now`.
3. The SPA calls `POST /api/orgs/first` unless an invitation is waiting in the cookie (§5.9), then
   opens `/welcome/secure`.

A sign-in code asked for an unknown address on `/sign-in` also makes an account when it is entered in
the asking browser (the old product's behaviour, kept): such an account has no name until the person
adds one in Account security.

### 5.2 Emailed codes ([SA-35])

- 8 digits, 15 minutes for developers and 10 minutes for staff, stored hashed by the library, 3 tries.
- **One live code per address and purpose:** a new code supersedes the old one
  (`identity.email_code_request.superseded_at`), with one exception, so that a stranger who knows an
  address cannot keep cancelling its owner's code (S2-38). A browser is *known* for an address when
  it presents `__Host-fin.known_browser` naming a live `identity.known_browser` row of the account
  with that address, or the `__Host-fin.code_browser` token of the live request itself (the same
  browser asking again). A request from a browser that is not known never supersedes a live code that
  a known browser asked for: it is answered exactly as any other request (the same status and body),
  sends nothing, leaves the live code alone until it is used or expires (at most 15 minutes), and
  writes `auth.code_contested` (`reason: supersede_refused`). A request from an unknown browser still
  supersedes a live code that an unknown browser asked for. Each request records whether its browser was known
  (`browser_known`).
- **A reserved share for known browsers:** of the per-recipient allowance for code emails (§5.6, 5 per
  hour and 12 per day), requests from browsers that are not known may use at most 3 per hour and 8 per
  day; the rest is kept for known browsers. A request refused for want of that share is answered the
  same way and writes `auth.code_contested` (`reason: unknown_share_used`). Repeated contests for one
  account raise `sign-in-code-contested` (§18.2). A person with a passkey signs in without email
  whatever happens here. Staff codes are asked only by the Access identity that owns the address
  (§10.5), so this rule is the developer realm's.
- **Bound to the asking browser:** sending sets `__Host-fin.code_browser` and records its HMAC with
  the address's keyed hash. At `/sign-in/email-otp`, the asking browser has the code's 3 tries; any
  other browser shares one allowance of 3 tries per code, and a right code from another browser signs
  in only an account that already exists (it never creates one).
- **The sign-in link** carries the code in the fragment, `https://console.<zone>/sign-in/code#e=<email>&c=<code>`;
  the page removes the fragment with `history.replaceState`, keeps both values in memory only, and
  asks `POST /api/sign-in/code-link` `{ email }` whether this browser asked the live code for that
  address. The answer is `{ "asking": true }` only when the request's `__Host-fin.code_browser` token
  matches that live request; it says nothing about any other browser, address or account.
  - **In the asking browser** the page shows "Sign in to Fin / As {email}" and submits only when the
    person presses "Sign in" (never by itself, so mail scanners cannot use a code).
  - **In any other browser** (S2-39) the code from a link is never used with one press. The page
    shows the board's "opened in another browser" state: the code-entry form, empty, where the person
    types their own address and the code from the email; the address and code in the link are
    dropped. A link that someone made for their own account therefore cannot sign another person into
    it (login CSRF), and a right code typed there still signs in only an existing account (above).
- Templates are `sign-in-code`, `confirm-email` and `staff-sign-in-code` (§17); the outbox row that
  carried the code is deleted on send (ARCHITECTURE §9.4).

### 5.3 Passkeys

- `residentKey: "required"`, `userVerification: "required"`, attestation `none` ([SA-03]); a passkey
  authentication is a second factor by itself and makes an `aal2` session.
- **Sign-in:** the SignIn board's "Sign in with a passkey" button calls `signIn.passkey()`; on mount
  the page also starts conditional UI (`signIn.passkey({ autoFill: true })`) with the email field's
  `autocomplete="username webauthn"`. Choosing a saved passkey signs in at once.
- **Every enrolment and every step-up dialog leads with the passkey** when the browser supports
  WebAuthn and, for step-up, the person has one.
- A passkey's display name is Fin's device summary from the user agent ("Chrome on Mac"), at most 60
  characters, set by the after-hook; people cannot rename passkeys at launch.
- A challenge works once; a signature counter that goes backwards is refused and the person is told
  with `sign-in-methods-changed` (kind `passkey_refused`), as SP-10 pins.

### 5.4 Factor step, authenticator and backup codes

- **TOTP set-up** (Authenticator board, shared by `/welcome/authenticator` and Account security):
  `/two-factor/enable` returns the `otpauth://` URI once; the screen shows the key in groups of four
  for manual entry and, once the owner answers research note D3's Q5 (a QR encoder), a QR code
  (S2-06); `/two-factor/verify-totp` finishes it; the developer then sees the 10 backup codes once
  ("Copy codes", "Download .txt" as `fin-backup-codes.txt`, "I saved these codes somewhere safe").
- **The factor step** (`/sign-in/two-factor`, `/sign-in/backup-code`): an `aal1` session of a person
  with a factor reaches only the endpoints marked "factor step" in §4.2. A right code or passkey
  raises it to `aal2` (§6.1). The session lives 10 minutes at `aal1` (S2-07).
- **Lockout:** the library's account lockout (10 wrong codes, one hour) stays on; a signed-in session
  that sends 5 wrong codes at a step-up is ended (§7.7).

### 5.5 Known browsers and the new sign-in email

On every new working session, the after-hook reads `__Host-fin.known_browser`. If it names a live
`identity.known_browser` row of this person, `last_seen_at` moves; otherwise a row is made, the cookie
set, and `new-sign-in` is queued, unless this is the account's first sign-in. "Sign out everywhere
else" forgets every known browser but the current one.

### 5.6 Limits ([DA-16], ARCHITECTURE §7.5)

Counted in Postgres by the custom store's atomic `consume(key, { window, max })` (one statement on
`ops.rate_window`, `UNLOGGED`) and, for lockouts, pauses, per-code tries and step-up locks, in logged
tables (`ops.lockout`, `identity.email_code_request`, the session's `step_up_failures`). The limiter
fails closed: a store error refuses the request (`503 unavailable`) and writes `limits.store_failed`.
Keys hash addresses with `FIN_LIMIT_KEY_<n>`; IPv6 counts per /48. Numbers live in
`packages/identity/src/limits.ts`.

| Bucket | Limit |
|---|---|
| default (every library path) | 100 per 10 s per address |
| `code_send` | 6 per 10 minutes per address and per network |
| `code_sign_in`, `factor_code` | 12 per 10 minutes per network; 3 tries per code (§5.2) |
| `password_sign_in` (stretch) | 8 per 10 minutes; the per-address pause of §5.7 |
| `passkey_options` | 30 per minute per IPv4 address or IPv6 /48 |
| `method_add` | 10 per hour and 20 per day per person |
| `backup_codes` | 5 per hour and 10 per day per person |
| `sign_up` | per address and per network, with a lower allowance for networks that sign up often ([SA-40]); starting values 5 per hour per network and 3 per day per address |
| email of one kind to one address | 5 per hour and 12 per day; of the code emails, requests from browsers that are not known for the address may use at most 3 per hour and 8 per day (§5.2, S2-38); security notices fold into a digest past that and are never dropped ([SA-41], §17) |
| `staff_code_send` | 20 per hour per Access identity; codes to one address 5 per hour |
| `staff_code_sign_in` | 12 per 10 minutes per Access identity |
| `enrolment_code` | 5 wrong tries per staff member per hour, then the code is void (§10.3) |
| organisations made or deleted | 10 per hour and 20 per day per person; at most 10 as Super admin ([BC-06]) |
| organisation renames | 5 per hour and 20 per day per organisation |
| invitations | 30 per hour and 50 per day per organisation; 20 per day per inviter; 3 per day per organisation and address; 10 per day per address across organisations; at most 25 pending per organisation |
| giving more access (role changes upwards) | 20 per hour and 40 per day per person; taking access away is never limited |
| role edits (custom roles, both realms) | 30 per hour and 100 per day per person |
| step-up intents created | 30 per 10 minutes per session |

### 5.7 Passwords (stretch 2, [SA-06], [SA-07])

12 to 128 characters; common passwords refused (`packages/identity/src/common-passwords.ts`, a list
generated at build time from a public list, committed with its source named); argon2id through
`node:crypto` (m = 19,456 KiB, t = 2, p = 1, 32-byte tag, PHC strings) through
`emailAndPassword.password.{hash,verify}`, with at most two concurrent hashes per vCPU and `503` with
`Retry-After` past a short queue (ARCHITECTURE §3.5). A per-address pause after repeated wrong
passwords from browsers the account does not know (10 per network in 15 minutes, 15 per hour, 40 per
hour across all networks), with a once-a-day `password-paused` email. Reset by an emailed code
(`/email-otp/request-password-reset`, `/email-otp/reset-password`), same answer for every address,
every session ended, the authenticator lockout lifted. A password alone never enrols a first factor.
Password sign-in of a person with a factor goes through the library's own challenge
(`__Host-fin.two_factor`) to `/sign-in/two-factor`.

### 5.8 Google (stretch 5)

Developer realm: redirect only (`disableIdTokenSignIn: true`), `prompt: "select_account"`, verified
addresses only; linking only from Account security and only to the same address. The callback is
`https://console.<zone>/api/auth/callback/google`; a session made by Google proves the mailbox only
when Google verifies the account's own address this time. Under the Strict session cookie, a Google
sign-in in a browser that already has a session opens the person's first organisation (accepted,
research note C3 §3.4). Staff realm: an internal Workspace client, the `hd` claim checked, the
verified address on the staff list and equal to the Access identity; built, off until the client
exists (CR-12).

### 5.9 The first organisation (S2-08)

A person with no membership gets one organisation, as the old product did on the first visit:
`POST /api/orgs/first` (no step-up: the person has no factor yet and nothing to protect) creates it
with a default name built from the work email's domain or the first name, passed through the
organisation-name rule ("My organisation" when nothing usable can be built), and makes the person
its Super admin; it writes `organization.created` with `first: true`. It is refused when the person
already has a membership, and counts towards §5.6's organisation limits. The SPA calls it from the
frame when the viewer has no membership and no waiting invitation; after a declined invitation it
calls it then.

**Consequence of [SA-05]'s default:** a Super admin is privileged, so every developer who owns their
first organisation is held at "Protect your account" with no "Skip" straight after sign-up. Only an
invitee who joins in a role with no privileged permission, and owns no organisation, may skip. This is
recorded for the owner (§23).

---

## 6. Assurance and the mandatory second factor ([SA-04], [SA-05], [SA-29], [SA-31])

### 6.1 Assurance levels

| Created by | Assurance |
|---|---|
| `/passkey/verify-authentication` (user verification required) | `aal2` |
| `/two-factor/verify-totp` or `/two-factor/verify-backup-code` on the library's challenge (passwords) | `aal2` |
| `/sign-in/email-otp`, `/sign-in/email`, `/callback/google`, and a trusted-browser sign-in | `aal1` |

A factor shown later in the same session raises it to `aal2` and writes a proof row
(`identity.assurance` or `staff.assurance`: method and time): the signed-in TOTP or backup-code check
updates the same session; a passkey ceremony makes a new `aal2` session that replaces the old one
after the after-hook checks the passkey belongs to the session's person (§11.3). Registering a first
factor raises the session that registered it.

### 6.2 The developer gate

Evaluated by `packages/identity/src/gate.ts` on every request with a session (library endpoints in
the before-hook, app routes in `requirePerson` and `requireActor`), from one call to
`identity.person_gate(user_id)` (§13.6), never cached:

| State | When | What the session reaches | Viewer `gate` |
|---|---|---|---|
| `factor_step` | `aal1`, the person has a factor, and either the session is not a trusted-browser session or `person_gate` now reports `privileged_anywhere` or `production_member` (S2-40) | §4.2's "factor step" endpoints, `GET /api/viewer` (minimal answer) and sign-out. Everything else: `403 factor_step_required` | `factor_step` |
| `hold` | the person has no factor and is privileged in any organisation | enrolment endpoints under the first-factor rule, `GET /api/viewer`, `PUT /api/viewer/organization`, sign-out. Everything else: `403 second_factor_required` with `hold: true` | `protect_account` |
| `ok` | otherwise | everything their permissions allow; a step-up with no factor answers `403 second_factor_required` | `ok` |

The hold is evaluated against every organisation the person belongs to, so it applies at once when an
invitation to a privileged role is accepted or a role edit adds a privileged permission to a role they
hold ([SA-05]). ProtectAccount shows "Skip for now" only when `canSkipProtect` is true (state `ok`, no
factor). The trusted-browser exception is re-checked the same way on every request: a trusted-browser
session whose person has since become privileged anywhere, or a member of an organisation with
Production access, is at `factor_step` from its next request, whatever its row says (§6.6).

### 6.3 The first-factor rule

The first factor may be added only in a session that began within 15 minutes with a sign-in that
proved the mailbox: an emailed code, a sign-up confirmation, or Google verifying the account's own
address (`mailboxProvedAt` at least now minus 15 minutes). A password alone never can. Outside the
window: `403 fresh_session_required`, and the SPA shows "Sign in by email to add a second factor".
Every further factor needs an intent (§7.6), so a stolen session cannot enrol its own passkey and use
it as the proof for everything else.

### 6.4 The staff gate

Evaluated on every `/api/*` request of the admin API half, after the Access check of step 4:

| State | When | What the session reaches |
|---|---|---|
| no session | | sign-in endpoints and `GET /api/viewer` (which then returns the Access address, for the sign-in field) |
| `pending` | `aal1`, the member has no factor | `POST /api/enrolment/redeem`, `GET /api/viewer` (minimal), sign-out, and, inside the enrolment window only, `/passkey/generate-register-options`, `/passkey/verify-registration` and, outside production, `/two-factor/enable` with `/two-factor/verify-totp` |
| `factor_step` | `aal1`, the member has a factor | `/two-factor/verify-totp`, passkey authentication, `GET /api/viewer` (minimal), sign-out |
| `ok` | `aal2`, status `active`, the member's address equals the Access address | what the member's permissions allow |

Every other request at `aal1` is refused with `403 factor_step_required`; a pending member holds no
permission at all. `aal1` staff sessions live 10 minutes. The route policy marks exactly two Fin routes
reachable below `aal2` (`GET /api/viewer` and `POST /api/enrolment/redeem`); T-SAT-14 asserts the list.
No trusted browser and no backup codes for staff, ever ([SA-31], [SA-04]).

### 6.5 Enrolment codes ([SA-29])

- 16 characters of Crockford base32 in four groups of four (80 bits), made with
  `crypto.getRandomValues`, shown once to the Admin who added or reset the member (or, for the first
  Admin, on the operator's terminal by `pnpm fin task <env> staff-bootstrap`, §10.6), stored as its
  SHA-256 in `staff.enrolment_code`, alive 30 minutes, single use, bound to one member.
- Handed over out of band, never by email; no template may carry it (T-SAT-41 renders every template
  with a planted code and fails if it appears).
- The pending member signs in with the emailed code (an `aal1` session), enters the enrolment code on
  AdminSecondFactor (`POST /api/enrolment/redeem`), which opens a 10-minute enrolment window on that
  session (`enrolmentOpenUntil`), then registers the factor. Production allows only a passkey as the
  first factor.
- 5 wrong tries per member per hour void the live code; the Admin issues a new one (§10.4).
- When the first factor registers: the member becomes `active` with `factor_enrolled_at`, the session
  is raised to `aal2`, `staff.factor_enrolled` is written, and `staff-factor-enrolled` goes to every
  Admin.

### 6.6 Trusted browsers ([SA-31])

Offered on TwoFactor only when the person passes the authenticator check, holds no privileged role in
any organisation and belongs to no organisation with Production access (`live_status = 'approved'`).
Fin issues `__Host-fin.trusted_browser` and an `identity.trusted_browser` row (30 days); the library's
`trustDevice` is stripped. A later sign-in by code or password from that browser gives an `aal1`
working session (gate state `ok`) and never writes a proof, so every step-up still asks for the
factor. Eligibility is not checked only when the browser is offered: `gate.ts` re-checks it on every
request (§6.2), so a person who has since become privileged anywhere or joined an organisation with
Production access must show the factor before anything else. Rows are listed in Account security and
revoked on any factor change, a password reset, "sign out everywhere else", any role elevation, the
person's own removal, and whenever the person gains Production access (`revoked_reason`). Production
access is gained in two transactions, and each revokes: Sunday's go-live approval calls
`identity.revoke_trusted_browsers(org_id, 'production_access')` for every member of the approved
organisation (IF-09), and accepting an invitation to an organisation whose `live_status` is
`approved` revokes the person's rows. Each revoked row writes `browser.trust_revoked` with its
reason. Never for staff.

### 6.7 The last factor

Removing a factor (`/passkey/delete-passkey`, `/two-factor/disable`) that would leave none is refused
with `409 last_factor` ("Keep another way to sign in first.") for every staff member, and for a
developer who is privileged in any organisation. Removals are serialised per person (a row lock on the
person's row) and never limited.

### 6.8 Losing every factor ([SA-30], [SA-14])

**Developers** (specified here, built in Sunday's spill block, S2-28, S2-41): no self-service removal
by email, ever. An account is global: its factors protect every organisation the person belongs to,
and after a recovery the mailbox alone enrols the next factor (§6.3). A recovery is therefore scoped
to what the recovering organisation owns, and nobody in one organisation can strip the factors that
protect another.

| Path | Started by | Allowed when | Approval |
|---|---|---|---|
| Super admin | Another built-in Super admin of the organisation: `POST /api/team/members/:memberId/recover` with an intent (`member.recover`), §8.5's rules, inside the team-change lock | the target is a member of this organisation and of **no other** (live memberships, read inside the lock). Otherwise `409 recovery_needs_staff`, and only the staff path remains | none |
| Staff | A staff member holding `accounts.recover` (Admin-only), from Fin Admin with an intent and a recorded identity check (a reason code, never typed text), through `api`'s door (Fin Admin's route comes with Sunday's organisation screens) | always; the only path when the person belongs to more than one organisation or the organisation has no other Super admin | a second, different staff member holding `accounts.recover`, with an intent, once at least two active staff members hold it (the shape of spec 03's SD3-09). Without that approval the recovery never finishes |

- **The row.** `identity.recovery` (§13.2) records the path and, for the Super-admin path, the
  organisation, which a check constraint then requires (`NOT NULL`). One live recovery per person.
- **Notices.** At the start, `account-recovery-started` goes to the person, to the Super admins of the
  recovering organisation (Super-admin path), and to the Super admins of **every** organisation where
  the person holds a privileged role ([SA-05]'s sense), whichever path started it.
- **Who may cancel during the wait.** Any of those Super admins, from their own organisation
  (`POST /api/team/members/:memberId/recovery/cancel`, no step-up: it only stops a change); the
  person, by signing in with a factor and pressing Cancel on Account security's notice
  (`POST /api/account/recovery/cancel`, an `aal2` session); and any staff member holding
  `accounts.recover`. Each cancel writes `account.recovery_cancelled` with who cancelled.
- **The wait and the finish.** The wait is 72 hours from the start. The worker's duty
  `identity.finish_recoveries()` (every 5 minutes, §13.4) finishes a due recovery in one transaction,
  and first re-checks it: a Super-admin recovery whose person has since joined another organisation is
  cancelled instead (reason `scope_changed`), and a staff recovery that needed a second approver and
  has none lapses (reason `not_approved`); either way the people told at the start get
  `account-recovery-finished` with the outcome `cancelled`, and the person can ask again through the
  staff path. Finishing removes every factor and session of the person, writes
  `account.recovery_finished`, emails the same people `account-recovery-finished` with the outcome
  `finished`, and the person enrols again under §6.3.

These routes join the console's route policy (§14.1) and Fin Admin's when Sunday's spill block builds
them; §14.2 and §14.3 list only Saturday's routes.

**Staff:** §10.4.

---

## 7. Step-up: windows and intents ([SA-08], [BC-01], [SA-34])

### 7.1 The protocol

```
browser                                 API half                                   database
  | POST /api/team/invitations ------------> guard: session, membership, permission,
  |   Fin-Organization, Idempotency-Key       outrank and giving rules; then step-up
  |                                          no Fin-Step-Up-Intent header:
  |                                            insert ops.step_up_intent (5 minutes) -------->
  | <---- 403 step_up_required { intent_id, step_up_kind: "intent", methods, reason_key }
  | StepUp modal: passkey (or code) ceremony, with header Fin-Step-Up-Intent: sti_...
  | POST /api/auth/passkey/verify-authentication --> after-hook: proof row, intent proved ---->
  | re-send the original request once, same body, same Idempotency-Key,
  |   plus Fin-Step-Up-Intent: sti_... -------> recompute digest; consume the intent and do
  |                                             the action, its audit event and its email in
  |                                             one transaction ------------------------------->
  | <---- 201
```

The guard always checks the session, the membership, the permission, the outrank and giving rules
and the input **before** it asks for a factor, so nobody proves a factor for something they cannot do.
A dialog in the page is never the check.

### 7.2 The intent record and its digest

`ops.step_up_intent` (§13.4) holds: the realm, session, person, organisation (developer org-scoped
actions), action key (§7.6), `params_digest`, `reason_key`, `created_at`, `expires_at` (`created_at`
plus 5 minutes, from the database clock), `proved_at`, `proof_method`, `proof_id`, `consumed_at`,
`consumed_request_id`.

`params_digest` is SHA-256 over the RFC 8785 canonical JSON of
`{ "realm", "action", "org", "target", "params" }`, where `params` holds only the fields the route
policy binds (`bind: [...]`, §7.6), strings in Unicode NFC, addresses lower-cased, arrays of keys
sorted. The digest never includes a secret: a password or code in the body is never bound.
`packages/identity/src/step-up/digest.ts` implements the canonical JSON for plain objects, strings,
booleans, integers and arrays (no floats), with known-answer tests (T-SAT-07).

### 7.3 Windows

A window is a factor shown in this session within the last 5 minutes: a proof row younger than 5
minutes by the database clock. It opens reveals (Sunday's "Show details", documents, a full bank
number) and the old product's step-ups that mint or move nothing ([BC-01]): on Saturday, changing
one's name. With no fresh proof the route answers `403 step_up_required` with `step_up_kind: "window"`
and no intent; the modal runs the ceremony and `api()` re-sends. An intent ceremony also writes a proof
row, so it opens the window; a window never satisfies an intent.

### 7.4 Ceremonies

| Method | Calls | Header |
|---|---|---|
| Passkey | `/passkey/generate-authenticate-options`, then `/passkey/verify-authentication` | `Fin-Step-Up-Intent` on the verify call |
| Authenticator | `/two-factor/verify-totp` with the signed-in session | `Fin-Step-Up-Intent` |
| Backup code (developers only) | `/two-factor/verify-backup-code` with the signed-in session | `Fin-Step-Up-Intent` |

The after-hook, on success: writes the proof row; if the header names an intent of this session and
person that is unproved and unexpired, sets `proved_at`, `proof_method` and `proof_id`; writes
`step_up.passed` (or `staff.step_up_passed`) with the method and the intent. A passkey of another
person is refused (`step_up.failed`, reason `other_person`) and the new session it made is deleted
(AC-SAT-06). On a passkey step-up the intent moves to the replacement session in the same transaction
(§11.3).

### 7.5 Answers

| Situation | Answer |
|---|---|
| The action needs an intent or a window and the person has no factor | `403 second_factor_required` |
| No `Fin-Step-Up-Intent`, or a window is stale | `403 step_up_required` with `intent_id` (intents only), `step_up_kind`, `methods` (`passkey`, `authenticator`, `backup_code`), `reason_key`, `expires_at` |
| The header names an intent that is unproved, expired, used, of another session or person, of another action, or whose digest differs | `403 step_up_invalid` with `reason` (`unproved`, `expired`, `used`, `other_session`, `other_action`, `digest`); `step_up.refused` line. `api()` shows "That didn't work. Try again." and does not loop |
| Success | the action's own answer; the intent is consumed in the action's transaction (`UPDATE ... SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND proved_at IS NOT NULL AND expires_at > now() RETURNING id`), so two re-sends cannot both pass |

**The client** (`packages/frame/src/api/`, P0-G, with each app's modal): `api()` maps
`step_up_required` to the root StepUp modal for the named intent; after the proof it re-sends the same
request once with the intent and the same `Idempotency-Key`; `second_factor_required` opens "Add a
second factor first" (or, with `hold: true`, navigates to `/welcome/secure`); `factor_step_required`
navigates to `/sign-in/two-factor` (Fin Admin: `/sign-in/factor`); `fresh_session_required` opens
"Sign in by email to add a second factor". The auth client's `fetchOptions.customFetchImpl` runs the
same mapping for library endpoints.

### 7.6 Saturday's step-up actions

"Bind" is what the digest covers besides the realm, action, organisation and target. The reason line
is the StepUp board's "Use your second factor to {reason}." (§15.5).

| Action key | Route | Kind | Target | Bind | Permission |
|---|---|---|---|---|---|
| `account.name` | `PATCH /api/account/name` | window | the person | | (person) |
| `account.passkey_add` | `/passkey/generate-register-options` checks the intent and ties it to the library's one-time challenge; `/passkey/verify-registration` consumes it in the transaction that writes `passkey.added` (§3.5) | intent once a factor exists; the first-factor rule before | the person | | (person) |
| `account.passkey_remove` | `/passkey/delete-passkey` | intent | the passkey | `id` | (person) |
| `account.totp_enable` | `/two-factor/enable` | intent once a factor exists; the first-factor rule before | the person | | (person) |
| `account.totp_disable` | `/two-factor/disable` | intent | the person | | (person) |
| `account.backup_codes` | `/two-factor/generate-backup-codes` | intent | the person | | (person) |
| `account.session_revoke` | `POST /api/account/sessions/:sessionId/revoke` | intent | the session | | (person) |
| `account.sessions_revoke_others` | `POST /api/account/sessions/revoke-others` | intent | the person | | (person) |
| `account.trusted_browser_revoke` | `DELETE /api/account/trusted-browsers/:browserId` | intent | the row | | (person) |
| `account.password_change` (stretch) | `/change-password` | intent | the person | | (person) |
| `account.google_link`, `account.google_unlink` (stretch) | `/link-social`, `/unlink-account` | intent | the person | `provider` | (person) |
| `org.create` | `POST /api/orgs` | intent | | `name` | (person, with a factor) |
| `org.rename` | `PATCH /api/org` | intent | the organisation | `name` | `organization.update` |
| `org.delete` | `DELETE /api/org` | intent | the organisation | `confirmName` | `organization.delete` |
| `member.invite` | `POST /api/team/invitations` | intent | | `email`, `roleKey` | `member.invite` |
| `invitation.change` | `PATCH /api/team/invitations/:invitationId` | intent | the invitation | `roleKey` | `member.invite` |
| `invitation.resend` | `POST /api/team/invitations/:invitationId/resend` | intent | the invitation | | `member.invite` |
| `invitation.cancel` | `DELETE /api/team/invitations/:invitationId` | intent | the invitation | | `member.invite` |
| `invitation.accept` | `POST /api/invitation/accept` | intent when the person has a factor; none before | the invitation | | (person) |
| `member.role` | `PATCH /api/team/members/:memberId` | intent | the member | `roleKey`, `rollCredentials` | `member.role` |
| `member.remove` | `POST /api/team/members/:memberId/remove` | intent | the member | `rollCredentials` | `member.invite` |
| `role.create` | `POST /api/roles` | intent | | `name`, `description`, `permissions` | `role.manage` |
| `role.update` | `PUT /api/roles/:roleId` | intent | the role | `name`, `description`, `permissions`, `version` | `role.manage` |
| `role.delete` | `POST /api/roles/:roleId/delete` | intent | the role | `moveTo` | `role.manage` (and `member.role` to move people) |
| `member.recover` (Sunday spill) | `POST /api/team/members/:memberId/recover` | intent | the member | | built-in Super admin (§6.8) |
| `key.create`, `key.update`, `key.roll`, `key.revoke` (stretch) | §12 | intent | the key | §12.3 | `apiKey.sandbox` or `apiKey.live` |
| `staff.add` | `POST /api/staff` | intent | | `email`, `roleKey` | `staff.add` |
| `staff.role` | `PATCH /api/staff/:staffId` | intent | the member | `roleKey` | `staff.role` |
| `staff.remove` | `POST /api/staff/:staffId/remove` | intent | the member | | `staff.remove` |
| `staff.reset_factors` | `POST /api/staff/:staffId/reset-factors` | intent | the member | | `staff.reset_factors` |
| `staff.enrolment_code` | `POST /api/staff/:staffId/enrolment-code` | intent | the member | | `staff.add` |
| `accounts.recover`, `accounts.recover_approve` (Sunday spill) | Fin Admin's recovery routes (§6.8) | intent | the developer account; the recovery | `identityCheck` | `accounts.recover` |
| `staff.session_revoke`, `staff.sessions_revoke_others` | `POST /api/account/sessions/...` (admin host) | intent | | | (staff) |
| `staff.factor_add`, `staff.factor_remove` | the staff realm's `step_up_self` paths | intent | | as the developer ones | (staff) |
| `staffRole.create`, `staffRole.update`, `staffRole.delete` (stretch) | `POST /api/staff-roles`, `PUT /api/staff-roles/:roleId`, `POST /api/staff-roles/:roleId/delete` | intent | the role | as the developer ones | `staffRoles.manage` |
| `switch.set` | `POST /api/switches/:switchName` | intent | the switch | `state`, `reasonCode` | `switches.manage` |

Sunday's and Monday's specs add their actions to this catalogue (`packages/identity/src/step-up/actions/<area>.ts`,
one fragment per area) under the same rules (IF-03).

### 7.7 Wrong codes at a step-up

Each wrong code or passkey failure at a step-up increments the session's `step_up_failures`; the
fifth ends the session (`step_up.locked` or `staff.step_up_locked`, the `session-ended` email, and the
next request answers `401` with `reason: too_many_tries`, which the SPA shows as "You were signed out
after too many wrong tries."). A passing ceremony resets the count.

---

## 8. Permission catalogues and roles ([SA-11], [SA-12], [SA-16], [SA-32])

### 8.1 The engine (`packages/access`, browser-safe)

One engine, two catalogues. Checks are by permission, never by role, read with the session on every
request, so a permission taken from a role stops on the next request. A role Fin does not know allows
nothing.

```ts
type Realm = "dashboard" | "staff";
interface PermissionDef<P extends string> {
  key: P; group: string; label: string; description: string;
  needs: readonly P[];                        // direct needs; the closure is computed
  stepUp: "none" | "window" | "intent";       // the editor's hint; the route policy decides
  privileged: boolean;                        // [SA-05] (dashboard only)
  sandboxOnly: boolean;                       // the editor's "Sandbox" chip
}
interface Catalogue<P extends string> {
  realm: Realm;
  groups: readonly { key: string; label: string; permissions: readonly P[] }[]; // editor order
  permissions: Readonly<Record<P, PermissionDef<P>>>;
  builtIns: readonly { key: string; label: string; summary: string; holds: "all" | readonly P[] }[];
  topRoleKey: string;                         // "super_admin" | "admin"
  restricted: readonly P[];                   // no custom role may hold them
}
can(held: ReadonlySet<P>, key: P): boolean;
needsOf(cat, key): ReadonlySet<P>;                        // transitive closure
withNeeds(cat, perms): Set<P>;                            // the editor's auto-tick
dependentsOf(cat, key): ReadonlySet<P>;                   // the editor's untick cascade
missingNeed(cat, perms): { permission: P; needs: P }[];
permissionsOf(cat, role): ReadonlySet<P>;                 // built-in, or custom minus restricted
isPrivileged(cat, perms): boolean;
outranks(cat, targetPerms, actorPerms): boolean;          // the target holds something the actor lacks
givingProblem(cat, input: {
  actorRoleKey: string; actorPerms: ReadonlySet<P>;
  targetIsSelf: boolean; targetCurrentRole?: RoleRef; newRole: RoleRef | "gone" | "unknown";
}): GivingProblem | null;
validateRole(cat, draft: { name: string; description: string; permissions: readonly P[] },
             actorPerms: ReadonlySet<P>): RoleProblem[];
summary(cat, role): string;                               // the generated summary sentence
type GivingProblem = "unknown_role" | "gone" | "beyond" | "top_only" | "self" | "outranked" | "unchanged";
type RoleProblem = "name" | "description" | "empty" | "restricted" | "beyond" | "missing_need" | "reads_as_built_in";
```

Catalogue fragments live in `packages/access/src/catalogue/{dashboard,staff}/<area>.ts`; the
assembled catalogue is built and checked, never edited by hand. On Saturday L-SAT-01 writes every
fragment of both catalogues (they are fixed by [SA-11] and [SA-12]); ownership of the `customers`,
`simulator`, `money`, `webhooks`, `go-live` and staff onboarding and money fragments passes to the
area's lane at Sunday's and Monday's first merge (S2-09).

### 8.2 The dashboard catalogue (26 permissions)

Labels and descriptions carry the 20 Nov and round-2 wording ("Go to Production", "Production keys",
"your Production request", "Sandbox customers"); the RoleEditor board's text wins where it differs
([UI-02]). **P** marks privileged; "Restricted" marks Super-admin-only.

| Group | Key | Label | Description | Needs | Step-up | P | Sandbox | Restricted |
|---|---|---|---|---|---|---|---|---|
| Customers | `customers.read` | See customers | Their details, documents and history. | | window, to show details | | | |
| | `customers.create` | Add customers and send their links | Create a customer and send them a link to verify. | `customers.read` | window ([BC-01]) | | | |
| | `customers.restart` | Start a customer again | Clear what they sent and ask for it again. | `customers.read` | intent | | | |
| | `customers.delete` | Delete customers | Remove a customer and what they sent, for good. | `customers.read` | intent | | | |
| Simulator | `simulator.use` | Use the simulator | Approve, reject or ask for information on Sandbox customers. | `customers.read` | window, for deposits | | yes | |
| | `sandbox.reset` | Reset the Sandbox | Delete every Sandbox customer and start clean. | `simulator.use` | intent | | yes | |
| Money movement | `money.read` | See money movement | Virtual accounts, beneficiaries and transfers. | `customers.read` | window, to reveal a full number | | | |
| | `money.beneficiaries` | Add and remove beneficiaries | The bank accounts a customer can send money to. | `money.read` | intent | P | | |
| | `money.transfer` | Send money | Move a customer's USD to a beneficiary, and open virtual accounts. | `money.read` | intent, per transfer | P | | |
| | `money.simulate` | Simulate deposits | Add USD to a customer's balance in the Sandbox. | `money.read` | none | | yes | |
| Webhooks | `webhooks.read` | See endpoints and events | Endpoints, deliveries and the events Fin sent. | | none | | | |
| | `webhooks.manage` | Add, change and pause endpoints | Where Fin sends events, and which ones. | `webhooks.read` | intent to create, delete or change the URL; window to pause, resume or edit events | P | | |
| | `webhooks.roll_secret` | Roll signing secrets | Make a new secret. Fin signs with the old one too for a day. | `webhooks.read` | intent | P | | |
| | `webhooks.redeliver` | Redeliver events | Send an event to an endpoint again. | `webhooks.read` | window | | | |
| API keys | `apiKey.read` | See keys | Names, how each starts and when it was last used. | | none | | | |
| | `apiKey.sandbox` | Create, roll and revoke Sandbox keys | Keys that start fin_test_. | `apiKey.read` | intent | | | |
| | `apiKey.live` | Create, roll and revoke Production keys | Keys that start fin_live_. | `apiKey.read` | intent | P | | |
| Team | `member.read` | See the team | Who is here, their roles and invitations. | | none | | | |
| | `member.invite` | Invite and remove people | Send invitations and take people off the team. | `member.read` | intent | P | | |
| | `member.role` | Change people's roles | Give someone another role, never one that can do more than you. | `member.read` | intent | P | | |
| | `role.manage` | Create and change roles | Roles like this one, and what each allows. | `member.read` | intent | P | | |
| Audit log | `auditLog.read` | See the audit log | Who did what in this organisation, and when. | | none | | | |
| Organisation settings | `organization.update` | Rename the organisation | The name people see in invitations and emails. | | intent | P | | |
| | `organization.delete` | Delete the organisation | Close it and delete its data. | | intent | P | | yes |
| Go to Production | `golive.edit` | Fill in your Production request | Answers and documents, saved as you go. | | none | | | |
| | `golive.submit` | Send it to Fin | Send your finished Production request for Fin to review. | `golive.edit` | intent | P | | yes |

**Built-in roles** (immutable rows in code, [SA-11]; no other prebuilt dashboard role):

| Key | Label | Holds | Summary |
|---|---|---|---|
| `super_admin` | Super admin | all 26; the only role that may give `super_admin` | Everything, including deleting the organisation, sending the Production request and making Super admins. |
| `admin` | Admin | all but `organization.delete` and `golive.submit` | Everything except deleting the organisation, sending the Production request and making Super admins. |

A custom role's summary is its description, or `summary()`'s sentence built from its groups ("Can see
customers, keys and the team, manage webhooks and manage Sandbox keys. Can't change the team."; "Can't
do anything yet." for none). A key never does more than its maker's role when it is made (§12).

### 8.3 The Fin Admin catalogue (26 permissions)

Fin Admin copy may name Sumsub. **Admin-only** permissions: no custom staff role may hold them, and
only an Admin gives the Admin role ([SA-12]).

| Group | Key | Label | Description | Needs | Step-up | Admin-only |
|---|---|---|---|---|---|---|
| Production access requests | `golive.read` | See Production access requests | Requests, their answers and documents, and who acts next. | | none | |
| | `golive.decide` | Decide Production access requests | Approve, ask for changes or decline. | `golive.read` | intent; a second approver once a second staff member exists ([SA-39], Sunday) | |
| Customers | `customers.read` | See customers | Customers and their people, with personal details masked. | | none | |
| | `customers.reveal` | Show personal details | Unmask a customer's or person's details, within a budget. | `customers.read` | window | |
| | `documents.view` | View identity documents | Open identity documents from Sumsub, within a budget. | `customers.read` | window | |
| | `customers.decide` | Decide customers | Approve, unapprove and reject customers and people. | `customers.read` | intent ([SA-17]) | |
| Requests for information | `rfis.read` | See requests for information | Requests, answers and what is overdue. | `customers.read` | none | |
| | `rfis.manage` | Handle requests for information | Ask, change, accept, ask again and withdraw. | `rfis.read` | none | |
| Organisations | `organisations.read` | See organisations | Organisations, their members and their Production status. | | none | |
| | `organisations.pause` | Pause and restore Production access | Stop an organisation's Production keys, and turn them back on. | `organisations.read` | intent; restoring needs a second approver once a second staff member exists | |
| | `organisations.approvals` | Change customer approvals | Turn "Fin approves each customer" on or off. | `organisations.read` | intent | |
| Developer accounts | `accounts.recover` | Recover developer accounts | Reset a developer's second factors after an identity check. | `organisations.read` | intent | yes |
| Money | `money.read` | See money | Provider status, transfers and reconciliation breaks. | | none | |
| | `money.operate` | Operate money | Retry, close and resolve breaks. Never send a payout. | `money.read` | intent ([MO-13]) | |
| Operations | `switches.manage` | Use the kill switches | Stop or restart one kind of work at once. | | intent | |
| Audit | `audit.read` | See the audit log | Everything staff and the system did, newest first. | | none | |
| Settings | `forms.manage` | Manage forms | Edit, publish and archive request forms. | `rfis.read` | none | |
| | `reasons.manage` | Manage reasons | The preset reasons staff give. | | none | |
| | `templates.manage` | Manage message templates | What staff send to developers and customers. | | none | |
| | `views.manage` | Manage shared views | Save and delete views every member of staff sees. | | none | |
| Staff | `staff.read` | See staff | Who can use Fin Admin, their roles and when they last signed in. | | none | |
| | `staff.add` | Add staff | Add someone and give them an enrolment code. | `staff.read` | intent | |
| | `staff.remove` | Remove staff | Take someone out of Fin Admin at once. | `staff.read` | intent | |
| | `staff.role` | Change staff roles | Give someone another role. | `staff.read` | intent | yes |
| | `staff.reset_factors` | Reset second factors | Remove someone's passkeys and authenticator so they enrol again. | `staff.read` | intent | yes |
| | `staffRoles.manage` | Create and change staff roles | Roles like this one, and what each allows. | `staff.read` | intent | yes |

**Prebuilt staff roles** (immutable rows in code; custom staff roles may be added, §10.7):

| Key | Label | Holds | Summary |
|---|---|---|---|
| `viewer` | Viewer | every `*.read`: `golive.read`, `customers.read`, `rfis.read`, `organisations.read`, `money.read`, `audit.read`, `staff.read` | Sees everything in Fin Admin except personal details and documents, and changes nothing. |
| `compliance` | Compliance | Viewer, plus `customers.reveal`, `documents.view`, `customers.decide`, `rfis.manage`, `forms.manage`, `golive.decide`, `views.manage` | Reviews and decides customers and Production access requests, handles requests for information and forms, and sees personal details and documents. |
| `operator` | Operator | Compliance, plus `organisations.pause`, `organisations.approvals`, `switches.manage` | Does everything Compliance does, pauses and restores Production access, changes customer approvals and uses the kill switches. |
| `admin` | Admin | all 26 | Does everything, including staff, staff roles, reasons and message templates. |

### 8.4 Custom roles (both realms)

| Rule | Dashboard (`identity.role`) | Fin Admin (`staff.role`) |
|---|---|---|
| How many | at most 30 per organisation | at most 30 |
| Name | `roleName` (§8.6): 1 to 40 characters, at most 5 words, unique per organisation (case-insensitive), never a built-in's name or one that reads as one ("Super Admin", "Admins") | the same against the staff built-ins |
| Description | optional, at most 120 characters, `roleDescription` | the same |
| Permissions | at least one; never a restricted one; every need held (the editor ticks needs automatically; unticking removes what depends on it); never one the editor lacks | the same |
| Editing | `role.manage` with an intent; never a role held by anyone who outranks the editor, never a role the editor holds; optimistic `version` (a stale save is `409 conflict`) | `staffRoles.manage` with an intent, the same rules |
| Rate | 30 edits per hour and 100 per day per person | the same |
| Deletion | moves every holder and every pending invitation to a role the actor may give (`moveTo`), with `member.role` to move people | moves every holder to a role the actor may give |
| Effect | applies on each holder's next request; adding a privileged permission puts holders without a factor on hold (§6.2); holders get `role-permissions-changed` | holders and every Admin get `staff-role-permissions-changed` |

### 8.5 Who may act on whom ([SA-32])

In both engines, every check inside the team-change or staff-change lock (§9.5, §10.8), after the
actor's role and the target's role are read again:

| Rule | Refusal |
|---|---|
| Nobody gives a role holding a permission they lack | `403 giving_refused`, `problem: beyond` |
| Only the top role gives the top role (`super_admin`, staff `admin`) | `problem: top_only` |
| Nobody changes their own role, removes themselves or resets themselves | `problem: self` |
| An actor may change, remove or reset a person, or change or cancel an invitation, only when both the target's current role and the new one are within the actor's permissions | `403 outranked` |
| A role that no longer exists, or a key Fin does not know | `problem: gone`, `problem: unknown_role` |
| The same role again | `problem: unchanged` |
| The last holder of the top role cannot be removed or demoted | `409 last_top_role` |

Property tests over random role pairs (T-SAT-08) and an integration test with two concurrent
demotions (T-SAT-24) prove them (AC-SAT-01, AC-SAT-08).

### 8.6 Names (`packages/identity/src/names.ts`)

`personName` (at most 60 characters and 8 words), `organisationName` (50, 7), `roleName` (40, 5),
`roleDescription` (120): letters, numbers and simple punctuation; refuses invisible and bidirectional
control characters, web addresses and bare domains, runs of 7 or more digits, words that mix Latin,
Cyrillic and Greek letters, and "Fin" written in look-alike letters. Every refusal returns the field's
sentence from the inventory ("Use letters, numbers and simple punctuation, up to 60 characters and 8
words. No web addresses or phone numbers."). Typed names never appear in an email's subject, heading
or preview (§17).

### 8.7 What a role cannot open is hidden ([SA-16])

Navigation hides what a role cannot open (`packages/frame`'s trees filter by `can`). Actions a role
cannot take are drawn disabled with the reason ("Your role doesn't allow this. Ask someone who can
change roles."). The server refuses either way. This applies to Fin Admin too: the old product drew
Fin Admin's decision buttons for every role; fin-next disables them.

---

## 9. Organisations, team and invitations ([SA-10], [SA-32], [SA-33], [SA-34])

### 9.1 Organisations

| Action | Route | Rules |
|---|---|---|
| First organisation | `POST /api/orgs/first` | §5.9 |
| Create | `POST /api/orgs` `{ name }` | the person has a factor and an intent; at most 10 as Super admin ([BC-06]); §5.6's limits; the creator becomes `super_admin`; `organization.created`; the new organisation becomes the session's current one |
| Switch | `PUT /api/viewer/organization` `{ orgId }` | a membership is required; sets the session's `currentOrganizationId`; a log line, no audit row (navigation) |
| Rename | `PATCH /api/org` `{ name }` | `organization.update` and an intent; "That's already the organisation's name." refused as `problem: unchanged`; `organization.updated` |
| Delete | `DELETE /api/org` `{ confirmName }` | `organization.delete` and an intent; `confirmName` must equal the current name; refused with `409 approved_for_live` while `live_status` is `approved` ([BC-07] widens it on Sunday and Monday); in one transaction: `deleted_at` set, every key revoked (stretch), every pending invitation cancelled, every custom role and membership deleted, `organization.deleted`, a revocation-journal entry, and `organization-deleted` to every member. Rows that other areas keep follow [DA-12] (Monday) |

**Which organisation a request acts on** (S2-10): every organisation-scoped app route takes it from the
`Fin-Organization: org_...` header, never from the session. A missing header is `400
organization_required`; an organisation the person does not belong to (or a deleted one) is `404
not_found`, the same answer as an unknown ID. The session's `currentOrganizationId` only chooses what
the SPA opens on load. Sunday's and Monday's console routes (for example `/api/money/*`) follow the
same rule (IF-02).

### 9.2 Members

- `GET /api/team` lists members (name, address, role, second-factor chip from the person's factors,
  joined date), the "No access" rows (a membership whose role key is unknown), and invitations, with
  search (`q` over name and address) and paging (`page`, `size` up to 100).
- **Change role:** `member.role`, an intent, §8.5's rules; `member.role_changed`; the person and every
  Super admin get `member-role-changed`; invitations the demoted person sent that they can no longer
  give are withdrawn (`member.invitation_cancelled`, reason `inviter_demoted`); a demotion that takes
  away permissions behind credentials they made or saw follows §9.4.
- **Remove:** `member.invite`, an intent, §8.5's rules. [SA-11]'s catalogue gives inviting and
  removing one permission ("Invite and remove people"); splitting them is open item 15. In one
  transaction the membership is deleted,
  `member.removed` written, their outstanding invitations withdrawn (`inviter_removed`), the
  credentials of §9.4 handled, a revocation-journal entry written (ARCHITECTURE §8.5), and
  `member-removed` queued to the person and to the remaining Super admins and Admins. Their sessions
  stay (they may belong elsewhere); their access to this organisation ends on their next request.
- A person has at most one membership per organisation.

### 9.3 Invitations

| Step | Behaviour |
|---|---|
| Invite | `POST /api/team/invitations` `{ email, roleKey }`: `member.invite`, an intent, the giving rule, §5.6's limits; the address is lower-cased and at most 254 characters; an existing member is `409 already_member`; a pending invitation for the same address is cancelled (`member.invitation_cancelled`, reason `replaced`) and a new one made. The token is 32 random bytes (base64url); only its SHA-256 is stored; the invitation lives 7 days. `member.invited`; `invitation` queued from `notify.<zone>` |
| The link | `https://console.<zone>/invite#t=<token>`. The page reads the fragment, removes it from the address bar, and posts `POST /api/invitations/open` `{ token }` |
| Open | Public. A live token sets `__Host-fin.invitation` (the invitation ID, signed with the realm's newest secret, 1 day) and answers the display data: organisation name, inviter's name and address, the role's label, the invited address masked (`m•••@example.com`), the expiry and the state (`for_you`, `other_account`, `signed_out`). An unknown, expired, answered or cancelled token gets the same `404 invitation_unusable` answer |
| Sign up or sign in | The cookie survives the round trip; SignUp shows "The invitation is for {masked address}." The first organisation is not made while an invitation is waiting (§5.9) |
| Accept | `POST /api/invitations/:invitationId/accept`: a signed-in person whose account address equals the invitation's address exactly (every account's address is mailbox-proved, §5.1), the invitation pending and unexpired, the inviter still allowed to give the role (re-checked inside the team-change lock), an intent when the person has a factor; makes the membership, sets `accepted`, writes `member.joined`, queues `member-joined` to the inviter and every Super admin, and makes the organisation current; when the organisation's `live_status` is `approved`, revokes the person's trusted browsers in the same transaction (reason `production_access`, §6.6). A privileged role with no factor puts the person on hold (§6.2) |
| Decline | `POST /api/invitations/:invitationId/decline`, the same address rule; `member.invitation_declined` |
| Mine | `GET /api/invitations/mine` lists pending invitations for the signed-in person's address, for the frame's invitation notice; accept and decline work by ID for that address, no token needed |
| Change role | `PATCH /api/team/invitations/:invitationId` `{ roleKey }`: `member.invite`, an intent, the outrank rule on both roles; a new token; the old link stops working; `member.invitation_changed`; `invitation` queued again ([SA-34]) |
| Resend | `POST /api/team/invitations/:invitationId/resend`: an intent; a new token; `member.invitation_resent`; `invitation` queued again (counted in the invitation limits) |
| Cancel | `DELETE /api/team/invitations/:invitationId`: an intent, the outrank rule; `member.invitation_cancelled` (reason `cancelled`); no email |
| Expire | `status = expired` on read once `expires_at` passes, and by the identity sweep (§13.4); no event |

### 9.4 Credentials made or seen by someone who leaves ([SA-33])

`packages/orgs/src/credentials.ts` keeps a registry of credential sources:

```ts
interface CredentialSource {
  kind: "api_key" | "webhook_secret";
  list(tx, orgId: string, userId: string): Promise<{ id: string; label: string; made: boolean; seen: boolean }[]>;
  rollPermission(item: { id: string }): DashboardPermission; // apiKey.live, apiKey.sandbox or webhooks.roll_secret
  roll(tx, orgId: string, ids: string[], overlap: "now" | "1h", actor: Actor): Promise<void>;
}
```

API keys register on Saturday if stretch 1 lands (§12); webhook secrets register on Sunday. The Remove
and Change role dialogs read `GET /api/team/members/:memberId/credentials`; the request carries
`rollCredentials` (default `true`, bound in the intent's digest). Rolling happens in the same
transaction as the removal or demotion. **How fast** (S2-42): a credential is rolled at once
(`now`) only when the actor holds the permission that rolls it (`rollPermission`: `apiKey.live` for a
Production key, `apiKey.sandbox` for a Sandbox key, `webhooks.roll_secret` for a signing secret).
Otherwise it is rolled with a 1-hour overlap and flagged for the Super admins, who can roll it at
once from the API keys or webhooks page. So a role that may only invite and remove people cannot cut
an organisation's Production traffic off in one act, and the credential still stops working within
the hour. The remaining Super admins and Admins are emailed the list, saying which credentials were
rolled at once and which keep working for the hour. The API keys page flags any key whose maker no
longer holds the permissions behind its scopes, and any key rolled with an overlap because someone
left.

### 9.5 The team-change lock

Every team change (invite, change, resend, cancel, accept, decline, role change, removal, role create,
update and delete, rename, delete) starts its transaction with
`SELECT 1 FROM identity.organization WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, then re-reads the
actor's and the target's roles, then checks §8.5. Lock order: the organisation row, then member rows in
ID order. Two concurrent demotions of the last two Super admins therefore cannot both pass (T-SAT-24).

---

## 10. Staff management ([SA-04], [SA-12] to [SA-15], [SA-29], [SA-39])

### 10.1 Two acts, in a fixed order

Adding staff is two acts (ARCHITECTURE §5.10): (1) the operator adds the address to the Access
application's Allow list from the private overlay (`pnpm fin access sync <env>`, L-SAT-09); (2) an
Admin adds the member in Fin Admin with a role, an intent and an enrolment code. Removing is the
reverse: remove in Fin Admin first (sessions end at once), then `pnpm fin access sync <env>` and
`pnpm fin access revoke <env> <address>` to end their Access sessions. Until both lists agree,
`admin-access-drift` pages every hour (§10.9).

### 10.2 Staff routes and rules

| Action | Route | Rules |
|---|---|---|
| List | `GET /api/staff` | `staff.read`: address, role, status (`pending` shows "Hasn't signed in yet"), last sign-in, factor kinds; "You" on one's own row |
| Add | `POST /api/staff` `{ email, roleKey }` | `staff.add`, an intent, §8.5's rules (only an Admin gives Admin); the address lower-cased, at most 254 characters; an active or pending member is `409 already_staff`; a removed member's row is reactivated as `pending` (the same `stf_` ID); one live enrolment code is made. The answer carries `enrolmentCode` and `expiresAt`, once, with `Cache-Control: no-store`, never stored, never logged. `staff.member_added`, `staff.enrolment_code_issued`; `staff-access-changed` (kind `added`, no code) to the person and every Admin |
| Change role | `PATCH /api/staff/:staffId` `{ roleKey }` | `staff.role` (Admin-only), an intent, §8.5's rules; the target's sessions end; `staff.role_changed`; `staff-access-changed` (kind `role_changed`) to the person and every Admin |
| Remove | `POST /api/staff/:staffId/remove` | `staff.remove`, an intent, §8.5's rules; in one transaction: status `removed`, `removed_at`, every session, passkey, two-factor row and live enrolment code of the member deleted, `staff.member_removed`, a revocation-journal entry, `staff-access-changed` (kind `removed`) to the person and every Admin. The answer and the screen remind the Admin that the address leaves the Access list next |
| Reset second factors | `POST /api/staff/:staffId/reset-factors` | `staff.reset_factors` (Admin-only), an intent, §8.5's rules; every session, passkey and two-factor row deleted; status `pending`; a new enrolment code in the answer, once; `staff.factors_reset`, `staff.enrolment_code_issued`; `staff-factors-reset` to the person and every Admin ([SA-14]) |
| New enrolment code | `POST /api/staff/:staffId/enrolment-code` | `staff.add`, an intent, the member `pending`; voids the live code; a new one in the answer, once; `staff.enrolment_code_issued` |
| Redeem | `POST /api/enrolment/redeem` `{ code }` | the pending member's own `aal1` session; §6.5 |

A staff member who is also a developer has two separate accounts and passkeys under different RP IDs
([SA-28]).

### 10.3 Enrolment and the first factor

As §6.5. The order on AdminSecondFactor for a pending member: "Enter your enrolment code" (from the
Admin who added you), then "Add a passkey" (production) or "Add a passkey" or "Use an authenticator
app" (staging). The registration after-hook refuses a pending member whose session has no open
enrolment window, and in production refuses `/two-factor/enable` for a pending member. Removing the
last factor is refused (§6.7).

### 10.4 Losing every factor

A staff member who loses every factor is reset by an Admin (§10.2). The last Admin is reset by
`pnpm fin task <env> staff-bootstrap --reset <address> --reason <text>` (§10.6). There is no backup
code and no self-service path.

### 10.5 The Access check, eligibility and the same person

- **The JWT** (`packages/staff/src/access-jwt.ts`): `Cf-Access-Jwt-Assertion`, RS256 only, the key by
  `kid` from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (the issuer is built from
  `FIN_ACCESS_TEAM`, never read as a URL, [SA-38]); `iss` equals that origin; `aud` contains
  `FIN_ACCESS_AUD`; `exp` and `nbf` with 60 seconds of leeway;
  `type` is `app`; `email` present. Keys are cached for at most 5 minutes; an unknown `kid` refreshes
  at most once every 30 seconds; a fetch has a 5-second timeout and fails closed (`503
  access_unavailable`, `access.keys_unavailable`). Web Crypto only.
- **Eligibility for a code:** `/email-otp/send-verification-otp` sends only when the address is an
  `active` or `pending` member and equals the Access identity's address (case-insensitive). The answer
  is the same either way; an Access identity that is not on the staff table writes `staff.not_listed`
  (alert `admin-staff-refused`).
- **Passkey sign-in:** the after-hook compares the passkey's member with the Access identity; a
  mismatch deletes the new session, answers as a failed passkey, and writes `staff.access_mismatch`.
- **Every request with a staff session:** the member is `active` (or `pending` for the enrolment
  surface), the session's `accessSub` equals the JWT's `sub`, and the member's address equals the
  JWT's address. Otherwise the session is ended, the answer is `403 access_mismatch`, and
  `staff.access_mismatch` is written (alert `admin-access-mismatch`). `admin` forwards the raw JWT,
  the staff session reference and the proof on every door call; `api` validates all three again
  (F6, [SA-36]).
- **The Access session ending mid-use:** a `fetch` to `/api/*` gets Access's redirect; `api()` uses
  `redirect: "manual"` and reloads the page on an opaque redirect, and Access signs the person in
  again (FW-C08).

### 10.6 The first Admin (CR-11, S0-17)

`pnpm fin task staging staff-bootstrap` asks for the address at the secure prompt, makes the
enrolment code on the operator's machine and shows it there once, and passes only the address and the
code's SHA-256 to the `migrate` service's `--task staff-bootstrap` run. The task
(`apps/api/src/tasks/staff-bootstrap.ts`) calls `staff.bootstrap_admin(address, code_hash, reason)`, a
`SECURITY DEFINER` function owned by `fin_owner`, which: refuses while an active Admin exists unless
`--reset` names that Admin and a reason is given; inserts or reactivates the member as `pending` with
role `admin`; stores the code hash; writes `staff.bootstrapped` with actor `operator`, `via:
operator`. Its output is IDs only.

### 10.7 Custom staff roles (stretch 3)

`GET /api/staff-roles` and `GET /api/staff-roles/:roleKey` (`staff.read`) are must-have, so the Staff
page's Roles card and role picker list the four prebuilt roles. Creating, editing and deleting
(`POST /api/staff-roles`, `PUT /api/staff-roles/:roleId`, `POST /api/staff-roles/:roleId/delete`,
`staffRoles.manage`, intents) and the AdminRoleEditor are stretch 3, under §8.4's rules; the tables
exist from Saturday's first migration.

### 10.8 The staff-change lock and the last Admin

Every staff change starts with `SELECT 1 FROM staff.change_lock WHERE id = 1 FOR UPDATE`, then re-reads
the actor's and the target's roles. The last `active` member holding `admin` cannot be removed,
demoted or reset (`409 last_top_role`).

### 10.9 The Access drift check

Hourly, a worker duty (`apps/api/src/worker/staff/access-drift.ts`) reads the Access application's
Allow policy with a read-only token (`FIN_ACCESS_READ_TOKEN`, Access: Apps and Policies Read, on
`worker` only, S2-11) and compares its exact address list with the `active` and `pending` members
(`staff.access_list_view`). A difference writes `access.drift` with the two counts only (never an
address) and pages (`admin-access-drift`); the duty pings no heartbeat but has a success alert
(`duty-stalled-access-drift`).

---

## 11. Sessions

### 11.1 Lifetimes

| | Developer realm | Staff realm |
|---|---|---|
| Idle | 24 hours (`expiresIn` 86,400 s), refreshed at most every 10 minutes | 60 minutes (3,600 s), refreshed at most every 5 minutes |
| Absolute | 7 days from the first sign-in of the session's chain (`absoluteExpiresAt`) | 12 hours |
| At `aal1` before the factor step or enrolment finishes | 10 minutes absolute | 10 minutes absolute |
| Cookie cache | off: every request reads the session row, so a revocation is immediate | off |
| Trusted browser | 30 days, §6.6 | never |

### 11.2 Reading and refreshing

`realm.sessionOf(request)` calls the library's `getSession` with the request's headers and
`returnHeaders: true`, and the API half copies any `Set-Cookie` the refresh produces onto the answer
(SP-10 pins the option name). `databaseHooks.session.update.before` never moves `expiresAt` past
`absoluteExpiresAt`.

### 11.3 Replacement on a passkey step-up

A passkey ceremony makes a new session. When the request carried a live session of the same person,
the after-hook, in one transaction: copies `absoluteExpiresAt`, `currentOrganizationId` and
`trustedBrowserId` to the new session (so a step-up never lengthens a session's life, S2-12); moves the
named intent and the window's proof to it; deletes the old session; writes `step_up.passed` with
`replacedSessionId`. When the passkey belongs to someone else, the new session is deleted and the old
one kept (§7.4).

### 11.4 Ending sessions

| Event | Sessions ended |
|---|---|
| Sign out (`/sign-out`) | this session; `session.ended` (`reason: signed_out`) |
| "Sign out" on one row of Account security | that session; `session.revoked` |
| "Sign out everywhere else" | every other session of the person; trusted and known browsers but this one forgotten; `session.revoked_others` with the count; `sign-in-methods-changed` (kind `signed_out_everywhere`) |
| Five wrong codes at a step-up | this session; §7.7 |
| Password reset (stretch) | every session |
| Staff role change, removal or factor reset | every session of the target |
| Staff address no longer equal to the Access identity | this session (§10.5) |
| A restore of the database | every session (ARCHITECTURE §8.5) |

Sign-out ends with a full document load; a `pageshow` with `persisted` set re-checks the session
before anything is shown (FW-C14).

---

## 12. API keys (Saturday stretch 1, else Sunday 08:00 to 11:00)

Started by L-SAT-11 only if L-SAT-02 is green at C3 (AC-SAT-02 to AC-SAT-06). The format, storage,
edge check, scopes and lifecycle are ARCHITECTURE §7.7 with [SA-18] to [SA-21], [BC-05] and [MO-20];
this section fixes what the console and the tables need.

### 12.1 The key

`fin_<test|live>_<sk|rk>_` + a 10-character Crockford key ID + a 32-character base62 secret + a
6-character base62 CRC-32 checksum over the deployment's salt (`fin-stg-1` on staging) and everything
before it. Only an HMAC-SHA256 of the secret with `API_KEY_PEPPER_<n>` is stored. The secret is shown
once, in the create or roll answer, with `Cache-Control: no-store`; the answer is never stored by any
idempotency layer. Test fixtures make keys at run time; the repository never holds a key-shaped string
with a valid checksum (a CI check).

### 12.2 Who may make which key

A Sandbox key needs `apiKey.sandbox`; a Production key needs `apiKey.live`, and the organisation's
`live_status = 'approved'` (so none can be made on Saturday). A full-access (`sk`) key needs every
scope's permissions plus `webhooks.manage`, `webhooks.roll_secret` and `webhooks.redeliver`; a
restricted (`rk`) key needs the permissions behind each scope:

| Scope | Needs |
|---|---|
| `customers:read` | `customers.read` |
| `customers:write` | `customers.create`, `customers.restart`, `customers.delete` |
| `events:read` | `webhooks.read` |
| `money:read` | `money.read` |
| `money:write` | `money.transfer` |
| `beneficiaries:write` | `money.beneficiaries` |
| `sandbox:simulate` | `simulator.use` |
| `sandbox:deposit` | `money.simulate` |

An unknown scope needs every permission. A live key with a money scope must carry an address allowlist
([MO-20]).

### 12.3 Routes

| Route | Permission | Bind | Rules |
|---|---|---|---|
| `GET /api/keys?mode&page&size` | `apiKey.read` | | names, prefix and key ID, kind, scopes, expiry, last used (rounded to the minute), maker, flags (§9.4) |
| `POST /api/keys` `{ name, mode, kind, scopes, ipAllowlist, expiresIn }` | by mode | all fields | at most 50 working keys per organisation; `keyName` rule (at most 60 characters); up to 20 allowlist entries; expiry 30 days, 90 days, a year or never; `api_key.created`; a `keys.key_disclosure` row for the maker; `api-keys/key-changed` to every member, refusing the action if it cannot be queued ([SA-41]) |
| `PATCH /api/keys/:keyId` `{ name?, ipAllowlist?, expiresAt?, scopes? }` | by mode | the changed fields | scopes may only be removed and expiry only shortened (a key edit never grants more scope or life than the key had, [SA-34]); the allowlist may change; `api_key.updated`; `api-keys/key-changed` to every member (not for a name alone) |
| `POST /api/keys/:keyId/roll` `{ overlap: "now" \| "1h" \| "24h" }` | by mode | `overlap` | one overlap enum, `now`, `1h` or `24h`, used alike by the request and by `api_key.rolled`'s `overlap` (spec 05 §4.10; spec 08 open item 4); the old key keeps working until the earlier of the overlap's end and its own expiry ([SA-20]); `api_key.rolled`; `api-keys/key-changed` |
| `POST /api/keys/:keyId/revoke` | by mode | | immediate; `api_key.revoked` (`reason: member`, spec 05 §4.9); a revocation-journal entry; `api-keys/key-changed` |

The edge's key check, `GET /v4/whoami`, load shedding and the uniform `401 unauthenticated` are
ARCHITECTURE §7.7 and F1; `keys.touch_last_used()` writes "last used" after the response at most once a
minute per key ([BC-05]).

### 12.4 On the API keys page

The ApiKeys board's key drawer has a menu (state `drawerMenu`) whose "View in audit log" opens
`/audit-log?target=<key ID>`: the key's own events (§15.2.1), shown only with `auditLog.read`. A key
rolled with an overlap when someone left carries the flag of §9.4 in its row and its drawer.
`apps/console/e2e/sat/api-keys.spec.ts` (L-SAT-11) covers both.

---

## 13. Data model

### 13.1 Conventions

- ARCHITECTURE §6.1 and §6.2: schema `identity` for the developer realm and organisations, `staff` for
  the staff realm, `ops` for intents and limits; one owning service each (`console`, `admin`); IDs
  `<prefix>_<26 Crockford base32>` from `newId(prefix, clock)`; `created_at` and `updated_at` as
  `timestamptz NOT NULL DEFAULT now()`; addresses stored lower-cased with a `CHECK (email = lower(email))`.
- The library's tables are declared in Drizzle (`packages/db/src/schema/identity.ts`,
  `packages/db/src/schema/staff.ts`) with snake_case columns mapped to the library's fields; the
  columns below are the ones 1.7.25 is expected to need, and SP-10's pin test compares them with the
  installed plugins' schema.
- **New ID prefixes** for `packages/core/src/ids.ts` (P0-D's file; L-SAT-02 asks through the lane
  board, IF-01): `ver` (verification), `brw` (known browser), `emr` (emailed-code request), `sur`
  (sign-up request), `rcv` (account recovery). Already listed: `usr`, `ses`, `acc`, `pky`, `tfa`,
  `asr`, `org`, `mem`, `inv`, `rol`, `stf`, `sts`, `srl`, `sti`, `tbr`, `enc`.

### 13.2 Schema `identity`

**Library tables**

| Table | Columns |
|---|---|
| `identity.user` | `id` text PK (`usr_`); `name` text NOT NULL DEFAULT '' (`personName` or empty); `email` text NOT NULL UNIQUE (at most 254); `email_verified` boolean NOT NULL (always true, §5.1); `image` text NULL (unused); `two_factor_enabled` boolean NOT NULL DEFAULT false; `created_at`, `updated_at` |
| `identity.session` | `id` text PK (`ses_`); `user_id` FK `user` ON DELETE CASCADE; `token` text NOT NULL UNIQUE; `expires_at` timestamptz NOT NULL; `ip_address` text NULL; `user_agent` text NULL (at most 400); Fin's: `assurance` text NOT NULL CHECK IN (`aal1`, `aal2`); `absolute_expires_at` timestamptz NOT NULL; `created_via` text NOT NULL CHECK IN (`email_otp`, `passkey`, `two_factor`, `password`, `google`, `replacement`); `mailbox_proved_at` timestamptz NULL; `trusted_browser_id` FK `trusted_browser` ON DELETE SET NULL; `step_up_failures` smallint NOT NULL DEFAULT 0; `current_organization_id` FK `organization` ON DELETE SET NULL; `created_at`, `updated_at`; CHECK (`expires_at <= absolute_expires_at`), so no refresh can pass the absolute limit whoever writes the row. Indexes `(user_id)`, `(expires_at)` |
| `identity.account` | `id` text PK (`acc_`); `user_id` FK ON DELETE CASCADE; `account_id` text; `provider_id` text CHECK IN (`credential`, `google`); `access_token`, `refresh_token`, `id_token` text NULL; `access_token_expires_at`, `refresh_token_expires_at` timestamptz NULL; `scope` text NULL; `password` text NULL (PHC argon2id, `credential` rows only); `created_at`, `updated_at`; UNIQUE `(provider_id, account_id)` |
| `identity.verification` | `id` text PK (`ver_`); `identifier` text; `value` text (hashed codes); `expires_at`; `created_at`, `updated_at`; index `(identifier)` |
| `identity.passkey` | `id` text PK (`pky_`); `name` text; `public_key` text; `user_id` FK ON DELETE CASCADE; `credential_id` text UNIQUE; `counter` integer; `device_type` text; `backed_up` boolean; `transports` text NULL; `aaguid` text NULL; `created_at` |
| `identity.two_factor` | `id` text PK (`tfa_`); `secret` text (encrypted by the library); `backup_codes` text (encrypted); `user_id` FK UNIQUE ON DELETE CASCADE |

**Fin's tables**

| Table | Columns |
|---|---|
| `identity.assurance` (proofs) | `id` (`asr_`); `user_id`; `session_id` FK `session` ON DELETE CASCADE; `method` CHECK IN (`passkey`, `totp`, `backup_code`); `intent_id` text NULL; `created_at`. Index `(session_id, created_at DESC)` |
| `identity.totp_step` | `user_id` PK FK; `last_step` bigint; `updated_at` (only if SP-10 needs it, §3.6) |
| `identity.known_browser` | `id` (`brw_`); `user_id` FK ON DELETE CASCADE; `token_hash` bytea UNIQUE; `label` text (at most 60); `first_seen_at`, `last_seen_at`. Index `(user_id)` |
| `identity.trusted_browser` | `id` (`tbr_`); `user_id` FK ON DELETE CASCADE; `token_hash` bytea UNIQUE; `label`; `created_at`, `last_used_at`, `expires_at`; `revoked_at` NULL; `revoked_reason` NULL CHECK IN (`factor_changed`, `password_reset`, `signed_out_everywhere`, `role_elevated`, `production_access`, `by_person`, `removed`) |
| `identity.email_code_request` | `id` (`emr_`); `email_hash` bytea (HMAC with `FIN_LIMIT_KEY_<n>`); `purpose` CHECK IN (`sign_in`, `sign_up`, `password_reset`); `browser_hash` bytea; `browser_known` boolean NOT NULL (§5.2); `created_at`, `expires_at`; `browser_tries`, `other_tries` smallint NOT NULL DEFAULT 0; `superseded_at` NULL. Index `(email_hash, purpose, created_at DESC)` |
| `identity.sign_up_request` | `id` (`sur_`); `email`; `name`; `password_hash` NULL; `browser_hash` bytea; `invitation_id` NULL; `created_at`, `expires_at` (24 hours); `used_at` NULL. Index `(email, created_at DESC)` |
| `identity.organization` | `id` (`org_`); `name` (`organisationName`); `live_status` text NOT NULL DEFAULT `sandbox` (the values and their writer, `api`, are Sunday's spec; Saturday writes only the default); `created_by` (`usr_`); `created_at`, `updated_at`; `deleted_at` NULL |
| `identity.member` | `id` (`mem_`); `organization_id` FK; `user_id` FK ON DELETE RESTRICT; `role_key` text NOT NULL (`super_admin`, `admin` or a `rol_` ID); `invited_by` NULL; `created_at`, `updated_at`; UNIQUE `(organization_id, user_id)`; index `(user_id)` |
| `identity.invitation` | `id` (`inv_`); `organization_id` FK; `email`; `role_key`; `token_hash` bytea UNIQUE; `invited_by`; `created_at`, `expires_at` (7 days); `status` CHECK IN (`pending`, `accepted`, `declined`, `cancelled`, `expired`); `answered_at`, `answered_by` NULL; `cancel_reason` NULL CHECK IN (`cancelled`, `replaced`, `inviter_removed`, `inviter_demoted`, `role_deleted`, `organisation_deleted`). Partial UNIQUE `(organization_id, email) WHERE status = 'pending'`; partial index `(email) WHERE status = 'pending'` |
| `identity.role` | `id` (`rol_`); `organization_id` FK; `name`; `description` NOT NULL DEFAULT ''; `created_by`; `created_at`, `updated_at`; `version` integer NOT NULL DEFAULT 1; UNIQUE `(organization_id, lower(name))` |
| `identity.role_permission` | `role_id` FK `role` ON DELETE CASCADE; `permission` text; PK `(role_id, permission)` |
| `identity.privileged_permission` | `permission` text PK; seeded by migration with §8.2's P set; a test asserts it equals the catalogue's |
| `identity.recovery` (Sunday spill) | `id` (`rcv_`); `user_id`; `path` CHECK IN (`super_admin`, `staff`); `organization_id` NULL, with CHECK (`path <> 'super_admin' OR organization_id IS NOT NULL`); `started_by` (`user:usr_...` or `staff:stf_...`); `identity_check` NULL (a reason code), with CHECK (`path <> 'staff' OR identity_check IS NOT NULL`); `approval_required` boolean NOT NULL; `approved_by` (`stf_`) NULL, never the starter; `approved_at` NULL; `started_at`, `completes_at` (plus 72 hours); `cancelled_at`, `cancelled_by` NULL; `cancel_reason` NULL CHECK IN (`person`, `super_admin`, `staff`, `scope_changed`, `not_approved`); `finished_at` NULL. Partial UNIQUE `(user_id) WHERE cancelled_at IS NULL AND finished_at IS NULL` |

### 13.3 Schema `staff`

| Table | Columns |
|---|---|
| `staff.member` (the library's user model) | `id` (`stf_`); `name` NOT NULL DEFAULT ''; `email` UNIQUE; `email_verified` boolean NOT NULL DEFAULT true; `image` NULL; `two_factor_enabled` boolean NOT NULL DEFAULT false; Fin's: `role_key` text NOT NULL (`viewer`, `compliance`, `operator`, `admin` or an `srl_` ID); `status` CHECK IN (`pending`, `active`, `removed`); `factor_enrolled_at` NULL; `added_by` text NOT NULL (`stf_...` or `operator`); `last_signed_in_at` NULL; `removed_at` NULL; `created_at`, `updated_at` |
| `staff.session` | as `identity.session` with `user_id` holding the `stf_` ID; Fin's: `assurance`, `absolute_expires_at`, `created_via` CHECK IN (`email_otp`, `passkey`, `two_factor`, `google`, `replacement`), `access_sub` text NOT NULL, `enrolment_open_until` NULL, `step_up_failures` |
| `staff.account`, `staff.verification`, `staff.passkey`, `staff.two_factor` | as in `identity`; `staff.two_factor.backup_codes` is always an encrypted empty list; `staff.account` holds only Google rows, once enabled |
| `staff.assurance`, `staff.totp_step` | as in `identity` |
| `staff.enrolment_code` | `id` (`enc_`); `member_id` FK; `code_hash` bytea UNIQUE (SHA-256); `reason` CHECK IN (`added`, `reset`, `reissued`, `bootstrap`); `issued_by` (`stf_...` or `operator`); `issued_at`, `expires_at` (30 minutes); `redeemed_at`, `redeemed_session_id`, `voided_at` NULL; `failed_tries` smallint NOT NULL DEFAULT 0. Partial UNIQUE `(member_id) WHERE redeemed_at IS NULL AND voided_at IS NULL` |
| `staff.role` | `id` (`srl_`); `name`, UNIQUE `lower(name)`; `description`; `created_by`; `created_at`, `updated_at`; `version` |
| `staff.role_permission` | `role_id` FK ON DELETE CASCADE; `permission`; PK `(role_id, permission)` |
| `staff.change_lock` | `id` smallint PK CHECK (`id = 1`); one row, inserted by the migration |

### 13.4 Schema `ops` (this spec's tables)

| Table | Columns |
|---|---|
| `ops.step_up_intent` | `id` (`sti_`); `realm` CHECK IN (`developer`, `staff`); `session_id`; `principal_id` (`usr_` or `stf_`); `organization_id` NULL; `action`; `params_digest` bytea CHECK (`length = 32`); `reason_key`; `created_at`; `expires_at`; `proved_at`, `proof_method` CHECK IN (`passkey`, `totp`, `backup_code`), `proof_id` NULL; `consumed_at`, `consumed_request_id` NULL. Partial index `(session_id) WHERE consumed_at IS NULL`. No foreign key (two realms); swept after a day |
| `ops.rate_window` (UNLOGGED) | `key` text; `window_start` timestamptz; `count` integer; PK `(key, window_start)` (P0-E creates it if Phase 0 has; this spec adds the auth store over it) |
| `ops.lockout` (logged) | `key` text PK; `kind` text; `count` integer; `locked_until` timestamptz NULL; `updated_at` |

**Sweeps** (worker duties, hourly; `apps/api/src/worker/identity/sweep.ts` and `.../staff/sweep.ts`,
each a `job.run` line and a success alert): `identity.sweep()` and `staff.sweep()` delete verification
rows, sessions past `expires_at` or `absolute_expires_at`, sign-up and emailed-code requests 2 hours
after expiry, known browsers unseen for 400 days and trusted browsers past expiry; void enrolment codes
past expiry; mark pending invitations past `expires_at` as `expired`. `ops.sweep_step_up()` deletes
intents older than a day. `identity.finish_recoveries()` (Sunday spill, every 5 minutes) finishes,
cancels or lapses due recoveries as §6.8 says, each in its own transaction with its event. Each is a
`SECURITY DEFINER` function with `EXECUTE` for `fin_worker` only.

### 13.5 Schema `keys` (stretch 1)

`keys.api_key`: `id` text PK (the 10-character key ID); `organization_id`; `mode` CHECK IN (`test`,
`live`); `kind` CHECK IN (`sk`, `rk`); `name`; `scopes` text[]; `secret_hmac` bytea; `pepper_version`
smallint; `ip_allowlist` cidr[] (at most 20); `expires_at` NULL; `created_by` (`usr_`); `created_at`;
`last_used_at` NULL; `revoked_at`, `revoked_by`, `revoke_reason` NULL; `rolled_from` NULL;
`roll_ends_at` NULL. `keys.key_disclosure`: `key_id`, `user_id`, `shown_at`. `keys.key_lookup` is
ARCHITECTURE §7.7's view for the edge.

### 13.6 Views and functions for other services

`api` reads these through narrow grants to re-check what a console or Fin Admin door call asserts
([SA-36]); none exposes a token, secret or code.

| Object | Returns |
|---|---|
| `identity.person_gate(user_id)` (`SECURITY DEFINER`, `STABLE`) | `factor_count`, `privileged_anywhere` (a built-in `super_admin` or `admin` membership, or a custom role holding a permission in `identity.privileged_permission`), `production_member` (a membership in an organisation with `live_status = 'approved'`) |
| `identity.session_view` | `id`, `user_id`, `assurance`, `expires_at`, `absolute_expires_at`, `current_organization_id` |
| `identity.membership_view` | `member_id`, `organization_id`, `user_id`, `role_key`, for organisations not deleted |
| `identity.role_permission_view` | `role_id`, `organization_id`, `permission` |
| `identity.organization_view` | `id`, `name`, `live_status`, `deleted_at` |
| `identity.proof_view` | `session_id`, `user_id`, `method`, `created_at` |
| `staff.session_view`, `staff.member_view`, `staff.role_permission_view`, `staff.proof_view` | the staff equivalents (`member_view`: `id`, `email`, `role_key`, `status`) |
| `staff.access_list_view` | the lower-cased addresses of `active` and `pending` members, for the worker's drift check only |
| `staff.bootstrap_admin(address, code_hash, reason)` | §10.6 |
| `identity.revoke_trusted_browsers(org_id, reason)` (`SECURITY DEFINER`) | revokes the trusted-browser rows of every member of the organisation with the reason, one `browser.trust_revoked` per row, in the caller's transaction; Sunday's go-live approval calls it (§6.6, IF-09) |
| `identity.finish_recoveries()` (`SECURITY DEFINER`, Sunday spill) | §6.8, §13.4 |

### 13.7 Grants (fragments in `packages/db/roles/grants/`)

| Role | Grants from this spec |
|---|---|
| `fin_console` | every table in §13.2, except `UPDATE (live_status)` on `identity.organization`; `SELECT`, `INSERT`, `UPDATE` on `ops.step_up_intent`, `ops.rate_window`, `ops.lockout`; `audit.record()`, `email.enqueue()`; `keys.*` as ARCHITECTURE §6.3 (stretch) |
| `fin_admin` | every table in §13.3; the same `ops` grants; `audit.record()`, `email.enqueue()`; `ops.set_switch()` |
| `fin_api` | `SELECT` on §13.6's views; `EXECUTE` on `identity.person_gate`; `SELECT` on `ops.step_up_intent`; `UPDATE (live_status)` on `identity.organization` (Sunday); `EXECUTE` on `identity.revoke_trusted_browsers` (Sunday); `INSERT` and `UPDATE (approved_by, approved_at, cancelled_at, cancelled_by, cancel_reason)` on `identity.recovery` (Sunday spill, the staff path of §6.8) |
| `fin_worker` | `EXECUTE` on the three sweeps and on `identity.finish_recoveries()`; `SELECT` on `staff.access_list_view` |
| `fin_readonly` | the tables without `token`, `password`, `secret`, `backup_codes`, `value`, `token_hash`, `code_hash` or `secret_hmac` columns, through column grants |

Every forbidden statement fails with SQLSTATE 42501 in the per-role tests (T-SAT-20, AC-P0-11).
`email.enqueue()`'s allowlist lets `fin_console` send only §17's developer templates and `fin_admin`
only the staff ones; `audit.record()`'s allowlist lets each record only its own fragment's events
(ARCHITECTURE §6.3, §8.2).

### 13.8 Audit guards ([AU-02])

P0-E's deferred constraint trigger refuses a commit that changes a guarded row without an audit row in
the same transaction whose `target` or `refs` holds the row's key and whose event is one the row
accepts. Registrations (in `packages/db/src/guards/<area>.ts`, owned by the area's lane):

| Table | Operations | Key column | Accepted events |
|---|---|---|---|
| `identity.member` | INSERT, DELETE, UPDATE OF `role_key` | `id` | `member.joined`, `member.removed`, `member.role_changed`, `organization.created` (the creator) |
| `identity.member` | DELETE | `organization_id` | `organization.deleted` |
| `identity.invitation` | INSERT, UPDATE OF `role_key`, `status`, `token_hash` | `id` | the `member.invit*` events, `member.joined` |
| `identity.invitation` | UPDATE OF `status` | `organization_id` | `organization.deleted` |
| `identity.role` | INSERT, UPDATE, DELETE | `id` | `role.created`, `role.updated`, `role.deleted` |
| `identity.role` | DELETE | `organization_id` | `organization.deleted` |
| `identity.role_permission` | INSERT, DELETE | `role_id` | `role.created`, `role.updated`, `role.deleted`; a delete that cascades from a guarded `identity.role` delete is covered by that delete's check |
| `identity.organization` | INSERT, UPDATE OF `name`, `deleted_at` | `id` | `organization.created`, `organization.updated`, `organization.deleted` |
| `identity.assurance` | INSERT | `session_id` | `step_up.passed`, `session.created`, `passkey.added`, `two_factor.enabled` (a first factor raising the session) |
| `ops.step_up_intent` | UPDATE OF `proved_at`, `consumed_at` | `id` | `step_up.passed`, `staff.step_up_passed`, and any event carrying `stepUp.intentId` |
| `staff.member` | INSERT, UPDATE OF `role_key`, `status`, `factor_enrolled_at`, `removed_at` | `id` | `staff.member_added`, `staff.role_changed`, `staff.member_removed`, `staff.factors_reset`, `staff.factor_enrolled`, `staff.bootstrapped` |
| `staff.role`, `staff.role_permission` | INSERT, UPDATE, DELETE | `id`, `role_id` | `staff.role_created`, `staff.role_updated`, `staff.role_deleted`; cascaded permission deletes as for `identity.role_permission` |
| `staff.assurance` | INSERT | `session_id` | `staff.step_up_passed`, `staff.signed_in`, `staff.factor_enrolled`, `staff.factor_added` |
| `staff.enrolment_code` | INSERT, UPDATE OF `redeemed_at` | `id` | `staff.enrolment_code_issued`, `staff.enrolment_code_redeemed` |
| `keys.api_key` (stretch) | INSERT, UPDATE OF `scopes`, `ip_allowlist`, `expires_at`, `revoked_at`, `roll_ends_at` | `id` | the `api_key.*` events |
| `identity.recovery` (Sunday spill) | INSERT, UPDATE OF `approved_at`, `cancelled_at`, `finished_at` | `id` | `account.recovery_started`, `account.recovery_approved`, `account.recovery_cancelled`, `account.recovery_finished` |

**The sign-in tables** (S2-04). These rows are how a person signs in, so a write to them is guarded
like a write to a member, whichever login makes it. The key column is the person's `user_id` on the
method tables (accounts, passkeys, two-factor rows), so each accepted event carries the person's
`usr_` or `stf_` in `target` or `refs`; it is the row's own `id` on the user, session and
trusted-browser tables, whose events name that row (§16.1):

| Table | Operations | Key column | Accepted events |
|---|---|---|---|
| `identity.user` | INSERT | `id` | `user.created` |
| `identity.user` | UPDATE OF `two_factor_enabled` | `id` | `two_factor.enabled`, `two_factor.disabled`, `account.recovery_finished` |
| `identity.user` | UPDATE OF `email`, `email_verified` | `id` | none: always refused while email changes stay blocked ([SA-30]) |
| `identity.session` | INSERT | `id` | `session.created`, `sign_in.second_factor_required`, `step_up.passed` (a replacement; refs the new `ses_`), `step_up.failed` (another person's passkey; refs the deleted `ses_`) |
| `identity.session` | UPDATE OF `assurance` | `id` | `session.created`, `step_up.passed`, `passkey.added`, `two_factor.enabled` |
| `identity.session` | UPDATE OF `user_id`, `absolute_expires_at`, `mailbox_proved_at`, `created_via` | `id` | none: always refused |
| `identity.account` | INSERT, DELETE, UPDATE OF `password`, `provider_id`, `account_id` | `user_id` | `user.created`, `password.set`, `password.changed`, `password.reset`, `account.linked`, `account.unlinked` |
| `identity.passkey` | INSERT, DELETE | `user_id` | `passkey.added`, `passkey.removed`, `account.recovery_finished` |
| `identity.passkey` | UPDATE OF `public_key`, `credential_id` | `user_id` | none: always refused |
| `identity.two_factor` | INSERT, DELETE, UPDATE OF `secret`, `backup_codes` | `user_id` | `two_factor.setup_started`, `two_factor.enabled`, `two_factor.disabled`, `backup_codes.regenerated`, `backup_code.used`, `account.recovery_finished` |
| `identity.trusted_browser` | INSERT | `id` | `browser.trusted` |
| `identity.trusted_browser` | UPDATE OF `revoked_at` | `id` | `browser.trust_revoked` (one per row) |
| `identity.trusted_browser` | UPDATE OF `expires_at`, `token_hash` | `id` | none: always refused |
| `staff.member` | UPDATE OF `email` | `id` | none: always refused |
| `staff.member` | UPDATE OF `two_factor_enabled` | `id` | `staff.factor_added`, `staff.factor_enrolled`, `staff.factor_removed`, `staff.factors_reset`, `staff.member_removed` |
| `staff.session` | INSERT | `id` | `staff.signed_in`, `staff.second_factor_required`, `staff.step_up_passed` (refs the new `sts_`), `staff.step_up_failed`, `staff.sign_in_failed` (an Access mismatch; refs the deleted `sts_`) |
| `staff.session` | UPDATE OF `assurance`, `enrolment_open_until` | `id` | `staff.signed_in`, `staff.step_up_passed`, `staff.factor_enrolled`, `staff.enrolment_code_redeemed` |
| `staff.session` | UPDATE OF `user_id`, `absolute_expires_at`, `access_sub`, `created_via` | `id` | none: always refused |
| `staff.passkey` | INSERT, DELETE | `user_id` | `staff.factor_added`, `staff.factor_enrolled`, `staff.factor_removed`, `staff.factors_reset`, `staff.member_removed` |
| `staff.passkey` | UPDATE OF `public_key`, `credential_id` | `user_id` | none: always refused |
| `staff.two_factor` | INSERT, DELETE, UPDATE OF `secret` | `user_id` | `staff.factor_setup_started`, `staff.factor_added`, `staff.factor_enrolled`, `staff.factor_removed`, `staff.factors_reset`, `staff.member_removed` |
| `staff.account` | INSERT, DELETE, UPDATE | `user_id` | none until Google is enabled for staff, which adds its event (H-02) |

An `UPDATE OF user_id` on `account`, `passkey`, `two_factor` or `trusted_browser` in either realm is
always refused. Left unguarded, with the reason recorded beside each registration file: deletions of
sessions and trusted browsers (they only take access away); session `expires_at` (bounded by the
CHECK of §13.2) and `current_organization_id` (navigation); the passkey `counter` (the library's
regression rule, §5.3); known browsers (they only decide the new-sign-in email); verification and
emailed-code rows (a forged one leads at most to a sign-in through the normal path, which writes its
own guarded rows and events, ARCHITECTURE §7.9's stated limit).

An insert into members, roles, staff or proofs with no audit row is refused at commit and writes
`database.audit_guard`, which pages (AC-SAT-11). So is a write to a sign-in table with no event:
`fin_console` inserting a passkey row for any developer, or changing an address, fails at commit, and
the library's own paths pass because they run in Fin's unit of work with their events (§3.5). A leaked
console or admin login can therefore not add a sign-in method, mint a session or strip a factor
quietly (ARCHITECTURE §8.2, TM-L01).

### 13.9 Migrations

Hand-written SQL in `packages/db/migrations/<YYYYMMDDHHMMSS>_<area>_<what>.sql`, each with
`lock_timeout` and `statement_timeout`, expand only on Saturday (ARCHITECTURE §6.4):

| File (area, what) | Lane |
|---|---|
| `_identity_realm` (the library tables of §13.2) | L-SAT-02 |
| `_identity_fin` (proofs, browsers, code and sign-up requests, `privileged_permission`, `totp_step`) | L-SAT-02 |
| `_ops_step_up`, `_ops_limits` | L-SAT-02 |
| `_orgs_tables` (organisations, members, invitations, roles; schema `identity`) | L-SAT-03 |
| `_identity_views` (§13.6's identity objects and sweeps) | L-SAT-02, after `_orgs_tables` |
| `_staff_realm`, `_staff_fin` (§13.3, `bootstrap_admin`, the sweep, the views) | L-SAT-04 |
| `_identity_guards`, `_orgs_guards`, `_staff_guards` (§13.8 registrations) | the area's lane |
| `_keys_tables` (stretch) | L-SAT-11 |

---

## 14. App routes under `/api` on each app host

### 14.1 Conventions

- **Route policy** (FW-C07): every route is declared in `apps/<app>/src/server/policy/<area>.ts` with
  `method`, `path`, `guard` (`public`, `requirePerson`, `requireActor`, `requireStaff`), `permission`
  (or `anyOf`), `scope` (`person`, `organization`, `staff`), `stepUp` (`none`, `window`, `intent`),
  `action` and `bind` (§7.6), `assurance` (`aal2_or_working`, or `aal1_allowed` for the two staff
  routes of §6.4), `body` and `query` Zod schemas, `limits` and `audit` (the events it writes), and,
  on a GET that redeems a minted URL only, `fetchSite` (§2.3). A test walks the Hono app and fails on
  any route missing from the policy or without a schema, and on a GET that declares `audit`, a budget
  or an intent, or redeems a minted URL without `fetchSite` (§2.3); the per-route refusal tests are
  generated from it (AC-SAT-04, AC-SAT-13).
- **Guards:** `requirePerson(c, { stepUp })` in `packages/identity`; `requireActor(c, { permission,
  stepUp, action, bind })` in `packages/orgs` (the organisation from `Fin-Organization`, membership,
  the role's permissions read now, the gate of §6.2, then step-up); `requireStaff(c, { permission,
  stepUp, action, bind })` in `packages/staff`. Each returns the actor for `recordAudit`.
- **Errors** are problem documents (`application/problem+json`, spec 01 §4.4): `type
  <docs origin>/errors/<code>`, `title`, `status`, `code`, `request_id`, and the extensions named
  below. The codes live in `packages/app-contracts/src/errors/auth.ts` (L-SAT-02's fragment).

| Code | Status | Meaning | Extensions |
|---|---|---|---|
| `unauthenticated` | 401 | no live session | `reason` (`expired`, `too_many_tries`, `signed_out`) |
| `factor_step_required` | 403 | an `aal1` session of a person with a factor | `methods` |
| `second_factor_required` | 403 | no factor, and the action or the hold needs one | `hold` |
| `fresh_session_required` | 403 | the first-factor window has passed (§6.3) | |
| `step_up_required` | 403 | §7.5 | `intent_id`, `step_up_kind`, `methods`, `reason_key`, `expires_at` |
| `step_up_invalid` | 403 | §7.5 | `reason` |
| `forbidden` | 403 | the permission is missing, or the role is unknown | `permission` |
| `outranked` | 403 | §8.5 | |
| `giving_refused` | 403 | §8.5 | `problem` |
| `invalid_origin` | 403 | §2.3 | `reason` |
| `access_required`, `access_mismatch` | 401, 403 | §10.5 | |
| `not_found` | 404 | not found, or not visible to this person | |
| `invitation_unusable` | 404 | §9.3 | |
| `organization_required` | 400 | `Fin-Organization` missing on an organisation route | |
| `invalid` | 400 | a schema refusal | `fields` (`{ path, code }` only, never the value) |
| `conflict` | 409 | a stale `version`, or a concurrent change | |
| `last_top_role`, `last_factor`, `already_member`, `already_staff`, `approved_for_live`, `limit_reached`, `already_done` | 409 | as named | `limit` for `limit_reached`; `target_id` for `already_done` |
| `idempotency_key_reused` | 422 | the same `Idempotency-Key` with another body | |
| `rate_limited` | 429 | §5.6 | `retry_after` and the `Retry-After` header |
| `paused` | 503 | a kill switch (`signups`) | |
| `unavailable`, `access_unavailable` | 503 | a dependency is down | `retry_after` |
| `internal` | 500 | unexpected; reported to Better Stack with the `request_id` | |

Library endpoints answer the library's own error bodies (`{ code, message }`, upper-case codes such
as `INVALID_OTP`), except where Fin's before-hook refuses, which answers the table above.

- **Idempotency:** every unsafe app route accepts `Idempotency-Key` (a UUID). P0-D's store keeps, per
  session and key, the request's digest, status and target ID for 24 hours; a repeat with the same
  digest answers the stored status and target with `Idempotent-Replayed: true`, never a stored body;
  a different body is `422 idempotency_key_reused`. An answer that carried a secret (an enrolment
  code, a key's secret, backup codes) is never replayed: the repeat answers `409 already_done` with the
  target ID (S2-13).
- **Paging** on app lists: `page` (from 1) and `size` (25 by default, at most 100); answers carry
  `total` (capped at 10,000 with `totalCapped`).
- Every answer: `Cache-Control: no-store`. Every route has a body limit of 256 KB.

### 14.2 Console (`console.<zone>/api/`)

"Org" means the route takes `Fin-Organization` and `requireActor`.

| Method and path | Guard and scope | Permission | Step-up | Writes (§16) | Body or answer |
|---|---|---|---|---|---|
| `/api/auth/*` | the developer realm behind §4.2 | | §7.6 | §16.2 | the library's |
| `POST /api/sign-up` | public | | | none (a log line) | `{ name, email, password? }`; `202 { status: "code_sent" }` |
| `POST /api/sign-in/code-link` | public (reads `__Host-fin.code_browser`) | | | none (a log line) | `{ email }`; `200 { asking }`, §5.2; limit `code_sign_in`; the same answer for a registered and an unknown address |
| `GET /api/viewer` | person (any gate state) | | | | §14.4 |
| `PUT /api/viewer/organization` | person | a membership | | | `{ orgId }` |
| `POST /api/invitations/open` | public | | | | `{ token }`; §9.3 |
| `GET /api/invitation` | public (reads the cookie) | | | | the invitation in the cookie, with `state` |
| `GET /api/invitations/mine` | person | | | | pending invitations for the person's address |
| `POST /api/invitations/:invitationId/accept` | person | the address rule | intent with a factor | `member.joined` | |
| `POST /api/invitations/:invitationId/decline` | person | the address rule | | `member.invitation_declined` | |
| `GET /api/account/security` | person | | | | name, passkeys (first page), authenticator state, backup codes left, password set, Google linked, trusted browsers, the warning flag |
| `GET /api/account/passkeys`, `/api/account/sessions`, `/api/account/activity` | person | | | | paged; activity is the person-scope audit through `api` (§14.5) |
| `PATCH /api/account/name` | person | | window | `user.name_changed`, `member.name_changed` per membership | `{ name }` |
| `POST /api/account/sessions/:sessionId/revoke` | person | own session | intent | `session.revoked` | |
| `POST /api/account/sessions/revoke-others` | person | | intent | `session.revoked_others` | `{ revoked: n }` |
| `DELETE /api/account/trusted-browsers/:browserId` | person | own row | intent | `browser.trust_revoked` | |
| `GET /api/orgs` | person | | | | the person's organisations with their role labels, paged |
| `POST /api/orgs` | person with a factor | | intent | `organization.created` | `{ name }` |
| `POST /api/orgs/first` | person with no membership | | | `organization.created` | §5.9 |
| `GET /api/org` | org | a membership | | | profile, live status, your role |
| `PATCH /api/org` | org | `organization.update` | intent | `organization.updated` | `{ name }` |
| `DELETE /api/org` | org | `organization.delete` | intent | `organization.deleted` | `{ confirmName }` |
| `GET /api/team` | org | `member.read` | | | §9.2 |
| `GET /api/team/members/:memberId/credentials` | org | `member.invite` or `member.role` | | | §9.4 |
| `PATCH /api/team/members/:memberId` | org | `member.role` | intent | `member.role_changed` | `{ roleKey, rollCredentials }` |
| `POST /api/team/members/:memberId/remove` | org | `member.invite` | intent | `member.removed` | `{ rollCredentials }` |
| `POST /api/team/invitations` | org | `member.invite` | intent | `member.invited` | `{ email, roleKey }` |
| `PATCH /api/team/invitations/:invitationId` | org | `member.invite` | intent | `member.invitation_changed` | `{ roleKey }` |
| `POST /api/team/invitations/:invitationId/resend` | org | `member.invite` | intent | `member.invitation_resent` | |
| `DELETE /api/team/invitations/:invitationId` | org | `member.invite` | intent | `member.invitation_cancelled` | |
| `GET /api/roles`, `GET /api/roles/:roleKey` | org | `member.read` | | | built-ins and custom roles with holders and permission counts |
| `POST /api/roles` | org | `role.manage` | intent | `role.created` | `{ name, description, permissions }` |
| `PUT /api/roles/:roleId` | org | `role.manage` | intent | `role.updated` | `{ name, description, permissions, version }` |
| `POST /api/roles/:roleId/delete` | org | `role.manage` (and `member.role` when people move) | intent | `role.deleted`, `member.role_changed` per person moved | `{ moveTo }` |
| `GET /api/audit-log` | org | `auditLog.read` | | | §14.5; query `q`, `type`, `range` (`today`, `7d`, `30d` default, `90d`, `all`), `from`, `to`, `tz`, `page`, `size`, and the object filters of §15.2.1: `target` (one ID: `mem_`, `inv_`, `rol_`, `org_`, `usr_` or a key ID; the rows whose `target` or `refs` hold it) and `targetKind` (`role`: the rows whose target is a `rol_` ID); the answer adds `filterLabel` (the object's current label in this organisation, or `null`) |
| `GET`, `POST /api/keys`; `PATCH /api/keys/:keyId`; `POST .../roll`, `.../revoke` (stretch) | org | §12.3 | intent on writes | §16.5 | §12.3 |

### 14.3 Fin Admin (`admin.<zone>/api/`)

Every route sits behind the Access check (§2.2 step 4) and `requireStaff` unless marked.

| Method and path | Guard | Permission | Step-up | Writes | Body or answer |
|---|---|---|---|---|---|
| `/api/auth/*` | the staff realm behind §4.3 | | §7.6 | §16.4 | the library's |
| `GET /api/viewer` | any staff state (`aal1_allowed`) | | | | §14.4 |
| `POST /api/enrolment/redeem` | a pending member's `aal1` session (`aal1_allowed`) | | | `staff.enrolment_code_redeemed` | `{ code }` |
| `GET /api/account` | staff | | | | factors, sessions |
| `POST /api/account/sessions/:sessionId/revoke`, `POST /api/account/sessions/revoke-others` | staff | | intent | `staff.session_revoked`, `staff.signed_out_everywhere` | |
| `GET /api/staff` | staff | `staff.read` | | | §10.2 |
| `POST /api/staff` | staff | `staff.add` | intent | `staff.member_added`, `staff.enrolment_code_issued` | `{ email, roleKey }`; the code once |
| `PATCH /api/staff/:staffId` | staff | `staff.role` | intent | `staff.role_changed` | `{ roleKey }` |
| `POST /api/staff/:staffId/remove` | staff | `staff.remove` | intent | `staff.member_removed` | |
| `POST /api/staff/:staffId/reset-factors` | staff | `staff.reset_factors` | intent | `staff.factors_reset`, `staff.enrolment_code_issued` | the code once |
| `POST /api/staff/:staffId/enrolment-code` | staff | `staff.add` | intent | `staff.enrolment_code_issued` | the code once |
| `GET /api/staff-roles`, `GET /api/staff-roles/:roleKey` | staff | `staff.read` | | | the prebuilt and custom roles |
| `POST /api/staff-roles`, `PUT /api/staff-roles/:roleId`, `POST /api/staff-roles/:roleId/delete` (stretch) | staff | `staffRoles.manage` | intent | `staff.role_created`, `staff.role_updated`, `staff.role_deleted` | as the dashboard's |
| `GET /api/switches` | staff | `switches.manage` | | | each switch's state, who set it and when |
| `POST /api/switches/:switchName` | staff | `switches.manage` | intent | `switch.set` or `switch.cleared` | `{ state: "on" \| "off", reasonCode }`; calls `ops.set_switch()` (P0-E); `staff-switch-changed` to every Admin; a revocation-journal entry when set |
| `GET /api/audit` (Sunday spill screen) | staff | `audit.read` | | | the staff-scope audit through `api` (§14.5) |

### 14.4 The viewer

**Console** `GET /api/viewer` answers `401 unauthenticated` with no session. With one:

```ts
type ConsoleViewer =
  | { gate: "factor_step"; email: string; methods: ("passkey" | "authenticator" | "backup_code")[] }
  | {
      gate: "ok" | "protect_account";
      user: { id: string; name: string; email: string };
      assurance: "aal1" | "aal2";
      factors: { passkeys: number; authenticator: boolean; backupCodesLeft: number | null };
      canSkipProtect: boolean;           // §6.2
      canTrustBrowser: boolean;          // §6.6
      memberships: { orgId: string; name: string; roleKey: string; roleLabel: string;
                     roleKnown: boolean; liveStatus: string }[];
      currentOrgId: string | null;       // null: no membership (§5.9) or every role unknown (NoAccess)
      permissions: string[];             // in the current organisation
      invitations: { invitationId: string; orgName: string; roleLabel: string; expiresAt: string }[];
    };
```

**Fin Admin** `GET /api/viewer`: `{ state: "signed_out", accessEmail }`, `{ state: "pending", email }`,
`{ state: "factor_step", email, methods }`, or `{ state: "ok", staff: { id, email, roleKey,
roleLabel }, permissions, environment }`.

Both are in `packages/app-contracts/src/identity/viewer.ts` and `.../staff/viewer.ts`, with a contract
test per route.

### 14.5 Door calls to `api` (Saturday)

The audit log screens read `audit.event` only through `api`'s door ([SA-36], ARCHITECTURE §8.6). Each
operation is a row in the door matrix (`packages/server/src/doors/audit.ts`), signed by the caller's
`FIN_CALLER_KEY_<n>` ([SA-23]), and `api` re-checks the session, membership, permission and assurance
from §13.6's views:

| Caller | Operation | Checks in `api` | Returns |
|---|---|---|---|
| `console` | `audit.organisation_log` | live session at `ok`, membership, `auditLog.read` | the organisation-scope rows of §16.3 and §16.5 with the filters of §14.2, never provider names; `target` and `targetKind` are applied inside the organisation's own rows, so an ID from another organisation matches nothing and its label is never resolved |
| `console` | `audit.person_activity` | live session | the person-scope rows of §16.2 for that person |
| `admin` | `audit.staff_log` | the Access JWT, a live `aal2` staff session, `audit.read` | staff-scope rows (Sunday spill screen) |

Each row returns the event name, time, actor (resolved to the current display name and address), the
target and refs resolved to current labels where they still exist, the verification chip
(`passkey`, `totp`, `backup_code`, `session`, `email_otp`, `password`, `google`), the address and the
device summary ([BC-03]). The sentences are drawn in the client (`apps/console/src/client/audit/sentences.ts`)
from the inventory's wording.

---

## 15. Screens (R14)

### 15.1 Rules

- Built from the boards of the "Fin Dashboard · new design" and "Fin Admin · new design" canvases;
  round 2 of the design brief (20 Nov) wins over earlier boards ([UI-02]); the canvases are re-read
  once round 2 is published ([UI-06]); the owner's edge toggle (OD-6) applies to AppFrame and
  AdminFrame.
- Screens import controls only from `@fin/ui`, glyphs from `@fin/icons` and frames, route states and
  navigation from `packages/frame` (OD-5, research note D3 §2). Missing UI is composed only from
  design-system primitives and tokens and marked pending ([UI-03]).
- **Must-have states on Saturday:** default, loading (skeleton, never a page spinner), load failed,
  empty, no permission, step-up and refusal, plus every state with a security outcome. A board's other
  states go into the state manifest as pending and are finished in H-02 (PG-03 needs none pending).
- Every navigation and slow action shows progress; every failure shows a page or a message. Copy is
  the inventory's functional wording and the design system's framing; British spelling; never
  "project"; no advance notices ("this will ask for your second factor"): just ask.
- What a role cannot open is hidden, what it cannot do is disabled with the reason (§8.7).
- Each route has a `pendingComponent` drawing its own skeleton; the root sets `data-ready` on `<body>`
  once the first route resolves, and journeys wait for it (FW-C11, FW-C16).
- A change to a screen updates its board, including dark and phone, in the same piece of work
  ([G-07]); L-SAT-10 draws what code needs before the code merges.

### 15.2 Dashboard boards

| Board (frame title) | Route | Must-have states on Saturday | Calls | Journey |
|---|---|---|---|---|
| AppFrame (App frame) | every signed-in route | default, orgMenu, accountMenu, navigating, frameLoading, notFound, notAllowed, error, offline, collapsed, navOpen; the invitation notice; the sidebar's Audit log item only with `auditLog.read` | `GET /api/viewer`, `PUT /api/viewer/organization`, `GET /api/invitations/mine` | `frame.spec.ts` |
| Home (Home) | `/` | all 3 | the viewer | `frame.spec.ts` |
| SignIn (Sign in) | `/sign-in` (`?next=`, `?error=`) | start with the passkey button and autofill, passkey in progress, code sent, load error, the redirect messages; the password step only with passwords | the library's sign-in endpoints | `sign-in.spec.ts` |
| SignInCode (Sign in · check your email) | `/sign-in/code` | code entry, from the link in the asking browser (press to sign in), wrong code, expired, resend countdown (45 seconds), opened in another browser (the empty form: the person types their own address and the code, §5.2) | `POST /api/sign-in/code-link`, `/sign-in/email-otp`, `/email-otp/send-verification-otp` | `sign-in.spec.ts` |
| TwoFactor (Sign in · second factor) | `/sign-in/two-factor` (`?with=passkey`) | authenticator, passkey only, wrong code, locked, prompt used up, "Trust this browser for 30 days" only when `canTrustBrowser` | `/two-factor/verify-totp`, passkey authentication | `factor-step.spec.ts` |
| BackupCode (Sign in · backup code) | `/sign-in/backup-code` | entry, wrong, used up, none | `/two-factor/verify-backup-code` | `factor-step.spec.ts` |
| SignUp (Create your account) | `/sign-up` | form, invitation hint, code sent, name refused; never says whether an account exists; the password field only with passwords | `POST /api/sign-up` | `sign-up.spec.ts` |
| VerifyEmail (Confirm your email) | `/verify-email` | waiting, from the link, wrong code, expired, opened in another browser | `/sign-in/email-otp` | `sign-up.spec.ts` |
| ResetPassword, NewPassword | `/reset-password`, `/reset-password/new` | stretch 2 | §5.7 | `password.spec.ts` (stretch) |
| Invite (Invitation) | `/invite` (token in the fragment, S2-15) | for you, other account, signed out, declined, cannot use, confirm it's you, accepted | `POST /api/invitations/open`, `GET /api/invitation`, accept, decline | `invitation.spec.ts` |
| NoAccess (No access yet) | `/no-access` | one unknown role, several, none | the viewer | `frame.spec.ts` |
| ProtectAccount (Protect your account) | `/welcome/secure` | passkey first (Recommended), authenticator option, **held with no "Skip for now"**, may skip, the fresh-session dialog, confirmed elsewhere | passkey registration, `/two-factor/enable` | `sign-up.spec.ts`, `hold.spec.ts` |
| Authenticator (Set up your authenticator) | `/welcome/authenticator` | the key for manual entry (the QR code once D3's Q5 is answered), code, wrong code, backup codes shown once | `/two-factor/enable`, `/two-factor/verify-totp` | `factor-step.spec.ts` |
| StepUp (Confirm it's you) | a root dialog | every state: passkey, code, backup code, wrong code, paused, add a second factor first, sign in by email to add a second factor, signed out after too many tries | §7.4 | `step-up.spec.ts` |
| AccountSecurity (Account security) | `/account/security` | name with a window; sign-in methods (add a passkey, remove, authenticator on and off, backup codes regenerate) with intents; sessions with "Sign out" and "Sign out everywhere else"; trusted browsers (new card, §15.4); recent activity; the no-second-factor InlineAlert | §14.2 account routes | `account-security.spec.ts` |
| Organisation (Settings · Organisation) | `/settings/organisation` | profile with rename, your organisations with switch and create, delete with the typed name; read-only without `organization.update`; delete disabled for non-Super admins | §14.2 org routes | `organisation.spec.ts` |
| Team (Settings · Team) | `/settings/team` | members, search, invite, change role, remove (with what is rolled at once and what keeps working for the hour, §9.4), invitations with change, resend and delete, no access, refused, outranked; "See changes in the audit log" and the row menu's "View in audit log" (§15.2.1) | §14.2 team routes | `team.spec.ts` |
| Roles (Settings · Roles) | `/settings/roles` ([UI-07]; `/settings/team/roles` redirects) | built-in, your roles, empty, read-only notice, delete with move; "See changes in the audit log" (§15.2.1) | `GET /api/roles`, delete | `roles.spec.ts` |
| RoleEditor (Settings · Role) | `/settings/roles/$roleKey`, `/settings/roles/new`, `?from=` | create, edit, duplicate, built-in read-only, outranked, needs ticked, giving refused, saved, step-up; "View in audit log" in the editor's menu for a custom role (§15.2.1) | §14.2 role routes | `roles.spec.ts` |
| AuditLog (Audit log) | `/audit-log` ([UI-07]; `/settings/audit-log` redirects) | list by day, drawer, search, range menu, type pills, filtered to one object (`target`, `targetKind`), empty (three cases), no permission | `GET /api/audit-log` | `audit-log.spec.ts` |
| ApiKeys, ApiKeyCreate, ApiKeyActions | `/developers/keys` | stretch 1, else Sunday's spill block: list, create with the secret shown once, edit, roll, revoke, step-up, last used; the drawer menu's "View in audit log" (§12.4) | §12.3 | `api-keys.spec.ts` |

Settings has four tabs: Organisation · Go to Production · Team · Roles (round 2).

#### 15.2.1 Audit log entry points (round 2, S2-43)

Round 2 of the design brief moves the Audit log into the sidebar and adds entry points that open it
filtered to one object:

| Entry point | Board and state | Opens |
|---|---|---|
| "See changes in the audit log", a quiet link | Team, `members` | `/audit-log?type=team` |
| "See changes in the audit log", a quiet link | Roles, `list` | `/audit-log?type=team&targetKind=role` |
| "View in audit log" in a member's row menu | Team, `rowMenu` | `/audit-log?target=<mem_…>` |
| "View in audit log" in the editor's menu | RoleEditor, `edit`, custom roles only (a built-in role has no history of its own) | `/audit-log?target=<rol_…>` |
| "View in audit log" in a key's drawer menu | ApiKeys, `drawerMenu` (stretch 1, §12.4) | `/audit-log?target=<key ID>` |

Each is shown only with `auditLog.read` (hidden otherwise, §8.7). On AuditLog, `target` and
`targetKind` draw the board's `filtered` state: a filter chip naming the object (`filterLabel`, §14.2)
and the board's "Clear filters". A `target` that matches nothing in this organisation (unknown,
deleted, or another organisation's) shows the "No events match" empty state, never an error that
would say whether the object exists. The filters live in the URL, so Back returns to the page that
opened them.

### 15.3 Fin Admin boards

| Board (frame title) | Route | Must-have states | Calls | Journey |
|---|---|---|---|---|
| AdminFrame (Fin Admin · Frame) | every route | default, staffMenu (Your sign-in, Log out), the environment badge, loading, pageError, notFound; Staff in the Settings group; until Sunday's screens exist, `/` opens Staff | `GET /api/viewer` | `admin-frame.spec.ts` |
| AdminSignIn (Fin Admin · Sign in) | `/sign-in` (`?ended=1`) | address prefilled from Access, code, wrong code, expired, too many, not staff (the same answer as staff), signed out | `/email-otp/send-verification-otp`, `/sign-in/email-otp`, passkey authentication | `staff-sign-in.spec.ts` |
| AdminSecondFactor (Fin Admin · Second factor) | `/sign-in/factor` | passkey, authenticator, wrong code, too many tries; **no factor yet: the enrolment code step, then add a passkey (and, outside production, an authenticator)** | §6.4, `POST /api/enrolment/redeem` | `staff-enrolment.spec.ts` |
| AdminStepUp (Fin Admin · Confirm it's you) | a root dialog | all | §7.4 | `staff-step-up.spec.ts` |
| AdminStaff (Fin Admin · Staff) | `/staff` | list, add with an intent and the enrolment code shown once, change role, remove (with the Access reminder), new enrolment code, refused, outranked, failed; Roles card with the four prebuilt roles; controls disabled with the reason for roles without the permission; no emailed-code step ([SA-13]) | §14.3 staff routes | `staff-manage.spec.ts` |
| AdminAccount (Fin Admin · Your sign-in) | `/account` | Sunday's spill block: factors, add and remove with intents, sessions, sign out everywhere else | §14.3 account routes | Sunday |
| AdminRoles (new board) | `/staff/roles` (a Roles tab on Staff, S2-16) | Sunday's spill block: prebuilt and custom roles, read-only without `staffRoles.manage` | `GET /api/staff-roles` | Sunday |
| AdminRoleEditor (new board) | `/staff/roles/$roleKey` | stretch 3, else Sunday's spill block | §10.7 | Sunday |
| AdminAudit (Fin Admin · Audit log) | `/audit` | Sunday's spill block | `GET /api/audit` | Sunday |
| Switches (no board) | `/switches` | Sunday's spill block, a pending composition ([UI-03]); the route of §14.3 is must-have on Saturday | §14.3 | Sunday |

### 15.4 Board work for L-SAT-10 (in light, dark and phone)

| Board | Change |
|---|---|
| ProtectAccount | the held state without "Skip for now"; the line for a held person says why in plain words |
| AdminSecondFactor | "Enter your enrolment code" step for a pending member, before "Add a passkey" |
| AdminStaff | the enrolment code shown once (copy button, "Hand this code to {address} yourself. It works once, for 30 minutes."), replacing the emailed-code step; the role picker and the Roles card with Viewer, Compliance, Operator and Admin; "New enrolment code" and "Reset second factors" actions; disabled controls with the reason |
| AdminRoles, AdminRoleEditor | new, mirroring Roles and RoleEditor with the staff catalogue ([UI-04]) |
| StepUp, AdminStepUp | the reasons of §15.5 |
| Team | invitation rows with "Change role" and "Resend" ([SA-34]); the Remove and Change role dialogs listing the credentials to roll with "Roll them" on by default ([SA-33]) |
| AccountSecurity | a "Trusted browsers" card ([SA-31]) |
| Team, Roles, RoleEditor, ApiKeys, AuditLog | round 2's audit-log entry points in the states §15.2.1 names, and AuditLog's `filtered` state with the object chip; drawn where the published round 2 lacks them |
| SignInCode | the "opened in another browser" state as the empty form with the address typed by the person (§5.2) |
| Invite | the link form `/invite` (no ID in the path) |

### 15.5 StepUp reasons ("Use your second factor to {reason}.")

| Reason key | Reason |
|---|---|
| `account.name` | change your name |
| `account.passkey_add` | add a passkey |
| `account.passkey_remove` | remove the passkey "{name}" |
| `account.totp_enable` | set up an authenticator app |
| `account.totp_disable` | turn off your authenticator app |
| `account.backup_codes` | replace your backup codes |
| `account.session_revoke` | sign out {device} |
| `account.sessions_revoke_others` | sign out your other devices |
| `account.trusted_browser_revoke` | stop trusting {browser} |
| `invitation.accept` | accept this invitation |
| `org.create` | create an organisation |
| `org.rename` | rename {organisation} |
| `org.delete` | delete {organisation} |
| `member.invite` | invite {email} |
| `invitation.change` | change the invitation for {email} |
| `invitation.resend` | send the invitation to {email} again |
| `invitation.cancel` | delete the invitation for {email} |
| `member.role` | change {name}'s role to {role} |
| `member.remove` | remove {name} |
| `role.create`, `role.update`, `role.delete` | create the role {role}; save the role {role}; delete the role {role} |
| `member.recover` (Sunday spill) | start recovering {name}'s account |
| `key.create`, `key.roll`, `key.revoke`, `key.update` (stretch) | create an API key; roll the key; revoke the key; change the key |
| `staff.add` | add {email} to staff |
| `staff.role` | change {email}'s role to {role} |
| `staff.remove` | remove {email} from staff |
| `staff.reset_factors` | reset {email}'s second factors |
| `staff.enrolment_code` | make a new enrolment code for {email} |
| `accounts.recover`, `accounts.recover_approve` (Sunday spill) | start recovering this developer's account; approve recovering this developer's account |
| `staffRole.create`, `staffRole.update`, `staffRole.delete` | create, save or delete the staff role {role} |
| `switch.set` | turn {switch} on, or turn {switch} off |

The values in braces come from the page's own state, never from the server's answer.

---

## 16. Audit events (R9)

### 16.1 How events are written

- `recordAudit()` (`packages/audit`, P0-E) accepts only names in `AUDIT_EVENTS`, assembled from
  fragments: `packages/audit/src/events/identity.ts` (L-SAT-02), `orgs.ts` (L-SAT-03), `staff.ts`
  (L-SAT-04), `api-keys.ts` (L-SAT-11, spec 05 §4.10). Each entry has its category, scope and the
  login roles that may record it. The event names and fragment files are spec 08 §3.4's, and the
  template names and folders spec 08 §4.4's, the canonical lists (spec 08 D08-33); this section and
  §17 use them.
- **Actor** `{ kind, id }` with `kind` `user`, `staff`, `operator` or `system` here, plus `via`
  (`console`, `admin`, `job`, `operator`), and for a stepped-up action `stepUp: { kind, method,
  intentId }`. **Target** one ID; **refs** up to 32 more IDs (the `ref_ids` limit of `audit.record()`
and the guard's match, spec 08 D08-35). **Metadata** flat: IDs, statuses,
  codes, counts, role keys and permission keys before and after. Never a secret, code, token,
  password, name, email address or typed text ([AU-01], ARCHITECTURE §8.2): an address or a name
  shown on the audit log is resolved from the current row at read time (§14.5).
- An event written for a change to a sign-in table (§13.8) carries the person's `usr_` (or `stf_`)
  in `target` or `refs`; one that creates or deletes a session carries that `ses_` (or `sts_`).
- Every row made by a console or Fin Admin actor carries the client address (`CF-Connecting-IP`,
  tunnel traffic only) and a user agent of at most 400 characters ([BC-03]).
- The event is written in the same transaction as the change, so a rolled-back action leaves no row;
  library-driven events follow §3.5.
- Every event has a test that fails when it is not written (T-SAT-21 to T-SAT-23, AC-SAT-11).

### 16.2 Person scope (Account security, "Recent activity")

| Event | Category | Written when | Target | Metadata |
|---|---|---|---|---|
| `user.created` | security | a code sign-in creates the account | `usr_` | `method` (`email_otp`, `google`), `viaInvitation` |
| `user.name_changed` | security | `PATCH /api/account/name` | `usr_` | none (the name is not stored here, S2-17) |
| `session.created` | sign_in | a working session exists (`aal2`, or `aal1` with no factor or from a trusted browser) | `ses_` | `method`, `assurance`, `trustedBrowser` |
| `session.ended` | sign_in | sign-out, or the session ended by the system | `ses_` | `reason` (`signed_out`, `step_up_locked`, `password_reset`) |
| `session.revoked` | sign_in | the person signs out one other session | `ses_` | |
| `session.revoked_others` | sign_in | "Sign out everywhere else" | `usr_` | `count` |
| `sign_in.second_factor_required` | sign_in | an `aal1` session stops at the factor step | `ses_` | `methods` |
| `sign_in.failed` | sign_in | a wrong or expired code, or a failed passkey, for an existing account | `usr_` | `method`, `reason` (`wrong_code`, `expired`, `other_browser`, `passkey_failed`) |
| `sign_in.second_factor_failed` | sign_in | a wrong code at the factor step | `usr_` | `method` |
| `sign_in.locked` | sign_in | the authenticator lockout starts | `usr_` | `until` |
| `two_factor.setup_started` | security | `/two-factor/enable` | `usr_` | |
| `two_factor.enabled`, `two_factor.disabled` | security | set-up finished; turned off | `tfa_` | |
| `backup_codes.regenerated` | security | new codes made | `usr_` | |
| `backup_code.used` | security | a backup code passed | `usr_` | `remaining` |
| `passkey.added`, `passkey.removed` | security | registration; deletion | `pky_` | |
| `step_up.passed` | security | a ceremony passed | `ses_` | `method`, `kind` (`window`, `intent`), `action`, `intentId`, `replacedSessionId` |
| `step_up.failed` | security | a ceremony failed | `ses_` | `method`, `reason` (`wrong_code`, `other_person`, `passkey_failed`) |
| `step_up.locked` | security | the fifth wrong try | `ses_` | |
| `browser.trusted`, `browser.trust_revoked` | security | §6.6 | `tbr_` | `reason` on revocation |
| `password.set`, `password.changed`, `password.reset_requested`, `password.reset`, `password.reset_failed`, `password.paused` (stretch 2) | security | §5.7 | `usr_` | |
| `account.linked`, `account.unlinked` (stretch 5) | security | Google | `acc_` | `provider` |
| `account.recovery_started`, `account.recovery_approved`, `account.recovery_cancelled`, `account.recovery_finished` (Sunday spill) | security | §6.8 | `rcv_` (refs `usr_`, and `org_` on the Super-admin path) | `path` (`super_admin`, `staff`), `identityCheck` (a reason code, staff path), `approvalRequired`; on cancel `by` (`person`, `super_admin`, `staff`, `system`) and `reason`; on finish `passkeysRemoved`, `sessionsEnded` (counts) |

### 16.3 Organisation scope (the Audit log page)

| Event | Category | Written when | Target | Refs | Metadata |
|---|---|---|---|---|---|
| `organization.created` | organisation | create, or the first organisation | `org_` | `mem_` | `first` |
| `organization.updated` | organisation | rename | `org_` | | `fields: ["name"]` |
| `organization.deleted` | organisation | delete | `org_` | | `members`, `invitations`, `keysRevoked` (counts) |
| `member.invited` | team | invite | `inv_` | | `roleKey` |
| `member.invitation_changed` | team | change role, or a role deleted | `inv_` | | `fromRole`, `toRole`, `reason` (`edited`, `role_deleted`) |
| `member.invitation_resent` | team | resend | `inv_` | | |
| `member.invitation_cancelled` | team | cancel, replace, or withdrawal | `inv_` | | `reason` (§13.2) |
| `member.invitation_declined` | team | decline | `inv_` | `usr_` | |
| `member.joined` | team | accept | `mem_` | `inv_`, `usr_` | `roleKey` |
| `member.role_changed` | team | change role, or moved by a role deletion | `mem_` | `usr_` | `fromRole`, `toRole`, `reason` (`changed`, `role_deleted`) |
| `member.removed` | team | removal | `mem_` | `usr_` | `credentialsListed`, `credentialsRolled` |
| `member.signed_in` | team | a working session for a member (one per membership, in the session's transaction) | `mem_` | `ses_` | `method` |
| `member.second_factor_added`, `member.second_factor_removed` | team | the person's factor count moves between 0 and 1 (one per membership) | `mem_` | | |
| `member.name_changed` | team | the person changes their name (one per membership) | `mem_` | | |
| `role.created` | team | create | `rol_` | | `permissions` |
| `role.updated` | team | edit | `rol_` | | `added`, `removed`, `holders`, `renamed` |
| `role.deleted` | team | delete | `rol_` | | `movedTo`, `membersMoved`, `invitationsMoved` |

### 16.4 Staff scope (Fin Admin's Audit log)

| Event | Category | Written when | Target | Metadata |
|---|---|---|---|---|
| `staff.signed_in` | sign_in | a staff session reaches `aal2` | `sts_` | `method` |
| `staff.second_factor_required` | sign_in | an `aal1` staff session stops at the factor step, or at enrolment for a pending member | `sts_` | |
| `staff.signed_out` | sign_in | sign-out | `sts_` | |
| `staff.session_revoked`, `staff.signed_out_everywhere` | sign_in | §14.3 | `sts_`, `stf_` | `count` |
| `staff.sign_in_failed` | sign_in | a wrong code or failed passkey for a staff member | `stf_` | `method`, `reason` |
| `staff.step_up_passed`, `staff.step_up_failed`, `staff.step_up_locked` | security | as the developer ones | `sts_` | as §16.2 |
| `staff.factor_setup_started` | security | `/two-factor/enable` (an authenticator set-up begins) | `stf_` | `method` |
| `staff.factor_added`, `staff.factor_removed` | security | a further factor; removal | `pky_`, `tfa_` (refs `stf_`) | `method` |
| `staff.factor_enrolled` | security | the first factor of a pending member | `stf_` | `method`, refs `enc_` |
| `staff.enrolment_code_issued` | staff | add, reset, new code, bootstrap | `enc_` | `reason`, refs `stf_` |
| `staff.enrolment_code_redeemed` | staff | redeem | `enc_` | refs `stf_` |
| `staff.member_added` | staff | add | `stf_` | `roleKey`, `reactivated` |
| `staff.role_changed` | staff | change role, or moved by a staff role deletion | `stf_` | `fromRole`, `toRole`, `reason` |
| `staff.member_removed` | staff | removal | `stf_` | |
| `staff.factors_reset` | staff | reset | `stf_` | |
| `staff.role_created`, `staff.role_updated`, `staff.role_deleted` (stretch 3) | staff | §10.7 | `srl_` | as §16.3's role events |
| `staff.bootstrapped` | staff | §10.6 (actor `operator`) | `stf_` | `reset` |
| `switch.set`, `switch.cleared` | operations | `POST /api/switches/:switchName` | the switch name | `reasonCode` |

Failures that are not actions are log lines, not audit rows: `staff.access_mismatch`,
`staff.not_listed`, `staff.enrolment_refused`, `auth.endpoint_blocked` (§18.1).

### 16.5 API keys (stretch 1, organisation scope, category `api_keys`)

`api_key.created`, `api_key.updated`, `api_key.rolled`, `api_key.revoked` and `api_key.exposed`, in
the fragment `packages/audit/src/events/api-keys.ts` (L-SAT-11). Spec 05 §4.10 owns them and defines
their metadata, in snake_case (`key_id`, `mode`, `kind`, `scopes`, `expires_at`, `allowlist_count`,
`changed`, `new_key_id`, `overlap`, `shown_to`, `reason`, `source`). `api_key.revoked`'s `reason`
takes the values of the key's `revoked_reason` (spec 05 §4.9: `member`, `maker_removed`,
`sent_in_clear`, `leaked_public`, `organisation_deleted`); §12.3's Revoke writes `member`.

### 16.6 The revocation journal ([AU-04])

A write-once journal object (IDs and time only) is written by `packages/audit`'s journal API in the
same unit of work as: a member removed, a role lowered (a demotion, or permissions removed from a
role), an organisation deleted, every session of a person ended, a staff member removed or reset, a key
revoked, a kill switch set.

---

## 17. Security emails (R3, [AU-07], [SA-41])

### 17.1 Rules

- Queued with `email.enqueue()` in the action's own transaction (a failure to queue rolls the action
  back, so an action that mints a credential is refused when its notice cannot be queued); only the
  worker sends (ARCHITECTURE §9.4).
- Codes and security notices go from `account-security@auth.<zone>` with the code and security
  priorities; invitations go from `notify.<zone>` (EXECUTION §3.1 item 9). Every message has
  `Auto-Submitted: auto-generated` and a new `X-Entity-Ref-ID`; no `List-Unsubscribe`.
- Lean security layout, Fin's own words, at most one link, no image. Typed values (a person's,
  organisation's or role's name, a device label) appear only in labelled boxes in the body, never in a
  subject, heading or preview, escaped (§8.6).
- Per-recipient limits (§5.6). Past them a security notice folds into one digest that is still sent
  and is never dropped; a suppressed notice counts towards `security-email-unsent`. Notices of a
  member or role change bypass the per-kind limits ([SA-41]).
- Parameters are IDs plus the display values the template declares (`code`, `orgName`, `roleLabel`,
  `personName`, `device`, `time`, `count`); a row that carried a code is deleted on send.
- No template ever carries an enrolment code, a key secret, a backup code or a link token other than
  the invitation's (T-SAT-41).

### 17.2 Developer templates

| Template | Folder (owner) | Trigger | To |
|---|---|---|---|
| `sign-in-code` | `identity/` (L-SAT-02) | a code asked on sign-in | the address |
| `confirm-email` | `identity/` | sign-up for an unknown address | the address |
| `already-registered` | `identity/` | sign-up for an existing account | the address |
| `new-sign-in` | `identity/` | a working session from an unknown browser, not the first sign-in | the person |
| `sign-in-methods-changed` | `identity/` | kinds `passkey_added`, `passkey_removed`, `passkey_refused`, `authenticator_on`, `authenticator_off`, `backup_codes_regenerated`, `browser_trusted`, `signed_out_everywhere`; with passwords `password_changed`, `password_reset`; with Google `google_linked`, `google_unlinked` | the person |
| `account-locked` | `identity/` | the authenticator lockout starts (once a day) | the person |
| `session-ended` | `identity/` | five wrong tries at a step-up | the person |
| `password-paused`, `reset-password` (stretch 2) | `identity/` | §5.7 | the address's owner |
| `account-recovery-started`, `account-recovery-finished` (Sunday spill; the second with `outcome` `finished` or `cancelled`) | `identity/` | §6.8 | the person; the recovering organisation's Super admins; the Super admins of every organisation where the person holds a privileged role |
| `invitation` | `orgs/` (L-SAT-03), from `notify.<zone>` | invite, change role, resend | the invited address |
| `member-joined` | `orgs/` | accept | the inviter and every Super admin |
| `member-removed` | `orgs/` | removal | the person; and the remaining Super admins and Admins, with what was rolled at once and what keeps working for the hour (§9.4) |
| `member-role-changed` | `orgs/` | role change, or moved by a role deletion | the person and every Super admin |
| `role-permissions-changed` | `orgs/` | a custom role's permissions changed | the role's holders |
| `organization-deleted` | `orgs/` | deletion | every member |
| `key-changed` (stretch 1; one template for created, edited, rolled and revoked) | `api-keys/` (L-SAT-11) | §12.3; spec 05 §4.10 | every member |
| `key-exposed` (stretch 1) | `api-keys/` (L-SAT-11) | spec 05 §4.8, §4.10 | Super admins and Admins |

### 17.3 Staff templates (folder `staff/`, L-SAT-04)

| Template | Trigger | To |
|---|---|---|
| `staff-sign-in-code` | a code asked by an eligible address | the address |
| `staff-new-sign-in` | every staff sign-in that reaches `aal2` | the member |
| `staff-sign-in-methods-changed` | `passkey_added`, `passkey_removed`, `authenticator_on`, `authenticator_off`, `signed_out_everywhere` | the member |
| `staff-factor-enrolled` | a pending member's first factor | every Admin |
| `staff-access-changed` | `added`, `role_changed`, `removed` | the person and every Admin |
| `staff-factors-reset` | reset | the person and every Admin |
| `staff-role-permissions-changed` (stretch 3) | a custom staff role changed | its holders and every Admin |
| `staff-switch-changed` | a kill switch set or cleared | every Admin |

---

## 18. Monitoring (R5)

Every event name below is listed in the area's catalogue fragment (`ops/monitoring/catalog/{identity,orgs,staff,keys}.ts`)
with its kind and the alerts that watch it, or a written reason for none; `monitoring:check` fails
otherwise (ARCHITECTURE §10.11). Lines are scrubbed: IDs only, never an address, name, user agent,
code, token or query string.

### 18.1 Lines

**The `request` line** (ARCHITECTURE §10.2) on both API halves adds: `realm` (`developer`, `staff`);
`authPath` (the library path template for `/api/auth/*`, for example `/sign-in/email-otp`);
`assurance` (`none`, `aal1`, `aal2`); `gate` (`ok`, `factor_step`, `hold`, `pending`); `stepUp`
(`window`, `intent`) and `stepUpOutcome` (`required`, `passed`, `invalid`); `orgId`, `userId` or
`staffId`; `outcome` and a bounded `reason` (for example `origin_gate.app_header`,
`policy.blocked`, `gate.factor_step`, `step_up.digest`, `limits.code_send`).

**Event lines:**

| Event | Kind | Fields | Written by |
|---|---|---|---|
| `auth.endpoint_blocked` | security | `realm`, `class` (`unlisted`, `blocked`) | §4.1 |
| `auth.gate_refused` | security | `realm`, `state` | §6.2, §6.4 |
| `auth.code_contested` | security | `reason` (`supersede_refused`, `unknown_share_used`), `userId` when the account exists | §5.2 |
| `auth.secret_unreadable` | failure | `realm`, `kind` (`totp`, `backup_codes`, `cookie`) | a stored secret no configured version decrypts |
| `auth.unhandled_error` | failure | `realm`, `authPath`, `errorId` | beside `error.unexpected` |
| `step_up.refused` | security | `realm`, `action`, `reason` | §7.5 |
| `step_up.locked` | security | `realm` | §7.7 |
| `limits.refused` | info | `bucket` | §5.6 |
| `limits.store_failed` | failure | `bucket` | §5.6 |
| `staff.not_listed` | security | `reason` (`code_request`, `request`) | an Access identity not on the staff table reached the API |
| `staff.access_mismatch` | security | `staffId` | §10.5 |
| `staff.enrolment_refused` | security | `staffId`, `reason` (`wrong`, `expired`, `used`, `void`, `no_window`) | §6.5 |
| `staff.changed` | security | `kind` (`added`, `role_changed`, `removed`, `reset`) | §10.2 |
| `staff.enrolled` | security | `staffId`, `method` | §6.5 |
| `access.keys_unavailable` | failure | | §10.5 |
| `access.jwt_refused` | security | `reason` (`signature`, `iss`, `aud`, `expired`, `type`, `missing`) | §10.5 |
| `access.drift` | security | `accessCount`, `staffCount` | §10.9 |
| `job.run` for `identity.sweep`, `staff.sweep`, `step_up.sweep`, `staff.access_drift`, `identity.finish_recoveries` (Sunday spill) | unit | ARCHITECTURE §10.2 | the worker duties |
| `email.security_unsent` | failure | `template`, `reason` | §17.1 (L-SAT-05's line) |
| `audit.write_failed`, `database.audit_guard` | failure | P0-E's | §3.5, §13.8 |

### 18.2 Alerts

Fragments `ops/monitoring/{staging,production}/alerts/{identity,orgs,staff}.json` (owned by the area's
lane); each alert names `incident_cause`, `metadata.check`, `metadata.flow` and `metadata.runbook`, and
`docs/runbooks/<alert>.md` must exist. **P** pages in production; **N** notifies; staging always emails
the quiet policy. Thresholds live in the private overlay ([OB-13]).

| Alert | Sev | Fires on | First check | Fragment |
|---|---|---|---|---|
| `sign-in-failing` | P | the 5xx ratio on `/api/auth/*` sign-in paths, or successful sign-ins at zero while attempts continue | the last deploy; `auth.unhandled_error` lines | identity |
| `second-factor-step-failing` | P | 5xx on factor-step and enrolment paths | the same | identity |
| `step-up-failing` | N | 5xx on ceremonies or on intent consumption; `step_up.refused` with `reason: digest` above its threshold (a client and server binding drift) | the route policy's `bind` lists against the client | identity |
| `sign-in-failures-spike` | N | `sign_in.failed` above its threshold | Logpush for the spread of addresses | identity |
| `sign-in-code-contested` | N | `auth.code_contested` for one `userId` above its threshold | someone asking codes for that account from browsers it does not know; the networks in Logpush | identity |
| `step-up-locked` | N | `step_up.locked` above its threshold | the sessions' people | identity |
| `secret-unreadable` | P | `auth.secret_unreadable` | `BETTER_AUTH_SECRETS` versions on the service | identity |
| `rate-limiter-failing` | P | `limits.store_failed` (the limiter fails closed, so sign-ins are refused) | Postgres | identity |
| `auth-endpoint-unlisted` | N | `auth.endpoint_blocked` with `class: unlisted` above its threshold | a client or library change calling an unlisted path, or probing | identity |
| `csrf-refusals-jump` | N | `request` lines with `reason: origin_gate.*` above the pre-deploy baseline | `FIN_PUBLIC_ORIGIN` and the client's `X-Fin-App` | identity |
| `identity-sweep-stalled` | N | no successful `identity.sweep` or `step_up.sweep` run in 2 hours | the worker's scheduler lease | identity |
| `staff-sign-in-failures` | N | `staff.sign_in_failed` above its threshold (staging: 10 in 10 minutes, AC-SAT-21) | who, from the audit log | staff |
| `admin-staff-refused` | P | `staff.not_listed` | the Access list against the staff table | staff |
| `admin-without-second-factor` | P | any `request` line on `admin` with `actor: staff`, `assurance` not `aal2`, status below 400, on a route outside §6.4's list (must never happen) | the gate; roll back | staff |
| `admin-access-mismatch` | P | `staff.access_mismatch` | the staff session and Access identity involved | staff |
| `admin-access-drift` | P | `access.drift` | `pnpm fin access sync` and the staff list | staff |
| `admin-access-shape` | P | the watcher finds a Bypass or Service Auth policy on the admin host's Access application, an include other than the exact staff list, or another application on the admin host, path-scoped or not (§18.4) | Cloudflare's audit log for who changed Access; restore with `pnpm fin access sync` | staff |
| `access-keys-unavailable` | P | `access.keys_unavailable` | Cloudflare's status; the team name setting | staff |
| `staff-changed` | N | `staff.changed` (an out-of-band notice of every change) | whether the change was expected | staff |
| `staff-enrolled` | N | `staff.enrolled` | whether the enrolment was expected | staff |
| `staff-enrolment-refused` | N | `staff.enrolment_refused` above its threshold | someone guessing enrolment codes | staff |
| `duty-stalled-access-drift`, `staff-sweep-stalled` | N | no successful run in 2 hours | the worker | staff |
| `team-change-failing` | N | 5xx on team and role routes | the last deploy | orgs |
| `security-email-unsent` | P | `email.security_unsent` | the outbox and the email token (L-SAT-05's fragment) | email |
| `audit-not-written`, `audit-guard` | P | P0-E's | ARCHITECTURE §8 | audit |

Stretch alerts: `password-guessing-spread` (N, passwords), `google-sign-in-failing` (N, Google),
`bad-key-flood` and `key-sent-in-clear` (keys, ARCHITECTURE §10.8 group B).

### 18.3 Dashboard panels ("Fin Services", ARCHITECTURE §10.10; L-SAT-09)

Sign-in outcomes by realm and method; factor-step and step-up outcomes; gate refusals by state; origin
gate refusals by reason; blocked endpoints; limiter refusals by bucket; staff changes and enrolments;
Access drift; security emails by result and outbox age.

### 18.4 Monitors and the watcher (P0-F's monitor file, L-SAT-09's watcher; this spec needs)

These are spec 08 §7.6's monitors under D08-14: no monitor carries an Access service token, so none
can pass Access, and none is meant to (S2-35).

| Monitor | Check | Passes when |
|---|---|---|
| `console-sign-in` | `GET https://console.<zone>/sign-in` | 200 with the shell's keyword |
| `console-api-health` | `GET https://console.<zone>/api/health` | 200 JSON |
| `admin` | `GET https://admin.<zone>/`, no Access cookie | Access's own redirect to the team sign-in |
| `admin-api-health` | `GET https://admin.<zone>/api/health`, no Access cookie | Access's own refusal, as SP-25's check (d) records it. It **fails, and pages**, when the answer carries `Fin-Release` or the problem type `<docs origin>/errors/access_required`: only the admin API half sends those, so seeing one from outside proves that Access or the connector's check was bypassed |

The API half's `401 access_required` (§2.2 step 4) stays as defence in depth and is never expected
from outside. The admin API half's liveness comes from its `process.health` lines and
`no-logs-admin` (spec 08 §7.6), not from a monitor. The watcher (L-SAT-09, `ops/watcher/**`) also
reads the Access configuration every minute and pages (`admin-access-shape`, §18.2) unless the admin
host is covered by exactly one self-hosted application whose only destination is `admin.<zone>` with
no path, holding the one Allow policy of ARCHITECTURE §5.10, with no policy whose decision is Bypass
or Service Auth (`bypass`, `non_identity`) and no other application on the admin host, path-scoped or
not.

### 18.5 Flow Atlas entries ([G-07])

Updated: F3 (signing in to the console), F4 (an action that needs a fresh factor), F6 (a Fin Admin
request). New: `F-console-sign-up` (sign-up, the first organisation and the hold), `F-invitation`
(invite, open, accept), `F-staff-add-and-enrol` (Access list, add, enrolment code, first factor),
`F-team-removal` (removal with credentials rolled), `F-api-key` (stretch). Each alert above names its
flow. The entries are sent to the owner of `docs/flows/atlas.json` through the lane board, never edited
by two lanes at once.

---

## 19. Tests

Labels as EXECUTION: `[U]` unit (`*.test.ts`), `[I]` integration against Postgres 18 (`*.db.test.ts`),
`[C]` contract, `[E2E]` Playwright, `[STG]` staging. Every guard has a test that fails if the guard is
removed (the Saturday test-truth check, EXECUTION §3.4). Fixtures use `example.com`, `example.org` and
`example.net` addresses and make keys, codes and secrets at run time.

### 19.1 Unit and contract

| ID | File | Proves |
|---|---|---|
| T-SAT-01 [C] | `packages/identity/src/endpoint-policy.test.ts` | per realm, the router's path set equals the policy; unlisted, double-slash and encoded paths answer 404 before any limit is counted; `/change-email` and the staff backup-code paths answer 404; `step_up_org` is empty (AC-SAT-02) |
| T-SAT-02 [I] | `packages/identity/src/pins.db.test.ts` | every behaviour of §3.6 on the installed version, including that every adapter write of a request goes through the unit-of-work binding and that `hooks.after` runs before the handler returns |
| T-SAT-03 [U] | `packages/identity/src/config.test.ts` | §3.3 and §3.4 for both realms, as built by `createRealm()`; start-up refuses `BETTER_AUTH_TRUSTED_ORIGINS`, an http origin outside development, a secret shorter than 32 bytes; each realm's resolved trusted origins are exactly its `FIN_PUBLIC_ORIGIN` (with the API origin as well under the split host) |
| T-SAT-04 [I] | `apps/console/src/server/cookies.db.test.ts`, `apps/admin/src/server/cookies.db.test.ts` | every `Set-Cookie` across sign-up, codes, passkeys, TOTP, invitations and sign-out: `__Host-`, `Secure`, `HttpOnly`, `Path=/`, no `Domain`; the session `Strict`, every other `Lax`; §2.4's never-set cookies absent |
| T-SAT-05 [U] | `apps/console/src/server/headers.test.ts`, `apps/admin/src/server/headers.test.ts` | the rendered `_headers` carries §2.5 |
| T-SAT-06 [U] | `packages/identity/src/modes.test.ts` | both routing modes of §2.6: origins, `Sec-Fetch-Site`, CORS answers (exact origin, no reflection, `Vary: Origin`), redirect-URL rules |
| T-SAT-07 [U] | `packages/identity/src/step-up/digest.test.ts` | the canonical JSON and digest known answers; NFC and lower-casing; bound fields only |
| T-SAT-08 [U] | `packages/access/src/engine/giving.test.ts` | for seeded random role pairs in both catalogues: `givingProblem` refuses every role holding a permission the actor lacks, the top role from anyone else, any change to one's own role, and any target outside the actor's permissions (AC-SAT-01) |
| T-SAT-09 [U] | `packages/access/src/catalogue/catalogue.test.ts` | 26 permissions each; every need exists and the graph is acyclic; built-in and prebuilt role sets exactly as §8.2 and §8.3; restricted and Admin-only sets; every label and description present |
| T-SAT-10 [U] | `packages/identity/src/names.test.ts` | §8.6's rules, each refusal |
| T-SAT-11 [U] | `packages/staff/src/access-jwt.test.ts` | RS256 only; `iss`, `aud`, `exp`, `nbf` with leeway, `type`; an unknown `kid` refreshes at most once per 30 seconds; a key fetch timeout fails closed |
| T-SAT-12 [U] | `packages/staff/src/enrolment-codes.test.ts` | the format, hashing, one live code per member, expiry |
| T-SAT-13 [U] | `packages/crypto/src/totp.test.ts` (only if §3.6 needs it) | RFC 6238's known answers; the step window |
| T-SAT-14 [U] | `apps/admin/src/server/policy.test.ts` | exactly two Fin routes are `aal1_allowed` |
| T-SAT-15 [U] | `packages/email/src/templates/{identity,orgs,staff}/*.test.ts` | each template renders; headers within the allowlist; no typed value in a subject, heading or preview; each security template has a test |
| T-SAT-16 [U] | `packages/audit/src/events/auth-metadata.test.ts` | no event's metadata accepts an address, a name, a code or a token (planted values refused) |

### 19.2 Integration (Postgres 18)

| ID | File | Proves |
|---|---|---|
| T-SAT-20 [I] | `packages/db/roles/grants/{identity,orgs,staff,step-up,limits}.db.test.ts` | every forbidden statement of §13.7 fails with 42501; `fin_readonly` reads no secret column |
| T-SAT-21 [I] | `packages/identity/src/audit-events.db.test.ts` | each event of §16.2 is written by its action and only then; a rolled-back action leaves none; a meta-test fails when a fragment event has no case |
| T-SAT-22 [I] | `packages/orgs/src/audit-events.db.test.ts` | the same for §16.3 |
| T-SAT-23 [I] | `packages/staff/src/audit-events.db.test.ts` | the same for §16.4 |
| T-SAT-24 [I] | `packages/orgs/src/last-holder.db.test.ts`, `packages/staff/src/last-admin.db.test.ts` | two concurrent demotions or removals of the last two top-role holders: exactly one passes (AC-SAT-08) |
| T-SAT-25 [I] | `packages/orgs/src/invitations.db.test.ts` | §9.3: another address, an expired or used invitation, twice, unknown and expired the same answer, change and resend need intents and issue new tokens, an old token stops, a demoted inviter's invitations withdrawn (AC-SAT-07) |
| T-SAT-26 [I] | `packages/db/src/guards/{identity,orgs,staff}.db.test.ts` | each registration of §13.8: the guarded change without its event is refused at commit with `database.audit_guard`; with it, allowed; organisation deletion's bulk path allowed. The sign-in tables, as the service's own login: `fin_console` inserting an `identity.passkey` row with no event is refused at commit, and so are a `two_factor` row, a password, a session, a trusted browser, a raised `assurance` and a changed `user.email`; `fin_admin` likewise on the staff tables; each library path (sign-up, code sign-in, passkey and authenticator set-up, step-up, sign-out) commits with its event (AC-SAT-11, AC-SAT-43) |
| T-SAT-27 [I] | `packages/identity/src/assurance.db.test.ts` | §6.1: a code sign-in of a person with a factor is `aal1` and reaches only the factor step; a trusted-browser session is `aal1` and writes no proof; a passkey makes `aal2`; a factor shown later raises the session and writes a proof. §6.6: a trusted-browser session is at `factor_step` on its next request once its person becomes privileged anywhere or a member of an organisation with Production access; accepting an invitation to an approved organisation and `identity.revoke_trusted_browsers()` revoke the rows with reason `production_access`, one `browser.trust_revoked` each (AC-SAT-03, AC-SAT-46) |
| T-SAT-28 [I] | `packages/identity/src/gate.db.test.ts` | §6.2 and §6.7: an Admin of one organisation and a plain member of another is held in both; accepting a privileged invitation and a role edit adding a privileged permission both hold; removing the last factor is refused for a privileged developer (AC-SAT-05) |
| T-SAT-29 [I] | `packages/identity/src/sessions.db.test.ts` | idle and absolute limits; a refresh never passes the absolute limit; a passkey step-up keeps the absolute limit and moves the intent; an `aal1` session dies after 10 minutes |
| T-SAT-30 [I] | `apps/console/src/server/step-up.db.test.ts`, `apps/admin/src/server/step-up.db.test.ts` | generated from the route policy, for every intent action of §7.6: refused with no intent, an intent for another action, other parameters, a used, expired or other session's intent; passes once with a fresh one; a passkey of another person is refused; a window action passes within 5 minutes of a proof and not after; two concurrent re-sends with one intent make exactly one action (AC-SAT-06, AC-SAT-32) |
| T-SAT-31 [I] | `apps/console/src/server/policy.db.test.ts`, `apps/admin/src/server/policy.db.test.ts` | every route has a policy entry and schemas; each permission check refuses a role lacking it; every Fin Admin route but the two refuses `aal1` (AC-SAT-04, AC-SAT-13) |
| T-SAT-32 [I] | `packages/identity/src/same-answer.db.test.ts` | sign-up, a code request, a code-link check, an invitation open and a staff code request answer identically (status, body, headers but `Request-Id`) for a registered and an unknown address; a contested code request answers like any other (AC-SAT-09) |
| T-SAT-33 [I] | `packages/identity/src/limits.db.test.ts` | per-recipient limits hold under 20 concurrent requests; the limiter fails closed when the database refuses; a security notice past its limit folds into a digest that is sent; a restart keeps a paused address paused; a code request from a browser that is not known never supersedes a known browser's live code, and the unknown share (3 per hour, 8 per day) leaves the rest of the allowance to known browsers (AC-SAT-10, AC-SAT-44) |
| T-SAT-34 [I] | `packages/staff/src/realm.db.test.ts` | §6.4, §6.5, §10: a pending member cannot register a factor without a valid enrolment code, and a code works once; production refuses an authenticator as a first factor; staff `/two-factor/enable` answers carry no backup codes; a removed member cannot sign in by code or passkey and comes back pending with the same `stf_` ID; an Access identity that differs from the session's member is refused and logged as `staff.access_mismatch`; a trust cookie gives nothing (AC-SAT-04, AC-SAT-12) |
| T-SAT-35 [I] | `packages/orgs/src/organizations.db.test.ts` | the first organisation and its hold; at most 10 as Super admin; the `Fin-Organization` rules (missing 400, not a member and deleted both 404); deletion refused while approved |
| T-SAT-36 [I] | `packages/orgs/src/credentials.db.test.ts` | removal and demotion roll every listed credential of a fake source by default, in the same transaction, and email the remaining Super admins and Admins; at once only when the actor holds the credential's rolling permission, otherwise with a 1-hour overlap and the flag |
| T-SAT-37 [I] | `apps/api/src/doors/audit/audit.db.test.ts` | §14.5's operations re-check session, membership, permission and, for staff, the Access JWT; a call without them is refused with `api.outside_request`; `target` and `targetKind` match only the caller's organisation's rows, and another organisation's ID returns no rows and no label |
| T-SAT-38 [I] | `apps/api/src/worker/identity/sweep.db.test.ts`, `.../staff/access-drift.db.test.ts` | the sweeps delete what §13.4 says and nothing else; the drift check pages on a difference with counts only |
| T-SAT-39 [I] | `apps/api/src/tasks/staff-bootstrap.db.test.ts` | refuses while an active Admin exists unless `--reset` with a reason; writes `staff.bootstrapped` with actor `operator` |
| T-SAT-40 [I] | `packages/keys/src/keys.db.test.ts` (stretch) | the checksum per salt; scopes bounded by the maker's permissions; an edit never widens scopes or life; a roll's overlap never outlives the old key; revocation is immediate at the edge |
| T-SAT-41 [U] | `packages/email/src/no-secrets.test.ts` | rendering every template with a planted enrolment code, key secret and backup code never shows them |
| T-SAT-42 [I] (Sunday spill) | `packages/identity/src/recovery.db.test.ts` | §6.8: a Super admin cannot recover a person who belongs to another organisation (`409 recovery_needs_staff`), only one who belongs to theirs alone; the Super-admin path's row without an organisation is refused by the constraint; `account-recovery-started` reaches the Super admins of every organisation where the person is privileged, and any of them can cancel; a person who joins another organisation during the wait is not recovered (`scope_changed`); with two active staff holding `accounts.recover`, a staff recovery needs a different approver and lapses without one (`not_approved`); finishing removes every factor and session in one transaction with `account.recovery_finished` (AC-SAT-48) |

### 19.3 Journeys (Playwright 1.65.1)

Against the static builds served by `packages/testing`'s static host with the production `_headers`,
proxying `/api/` to the `test` images (spec 01 §4.7), with the email sink, the Access stand-in (a
signed JWT from a test key whose key set the stand-in serves; `test` target only, [SA-38]), the frozen
clock and the virtual authenticator. Every page has a `securitypolicyviolation` listener that fails the
test. Failure states are reached with `page.route` on named API routes. Passkey steps run on Chromium
(Playwright's virtual authenticator); the Firefox and WebKit projects run the same journeys through
code and authenticator paths (S2-25).

| ID | File | Journey |
|---|---|---|
| T-SAT-50 | `apps/console/e2e/sat/sign-up.spec.ts` | sign up with the code from the sink; the first organisation; ProtectAccount with no "Skip"; add a passkey; Home; the audit log shows the sign-up (AC-SAT-14) |
| T-SAT-51 | `apps/console/e2e/sat/sign-in.spec.ts` | sign out; sign in with the passkey button and with autofill; a code from the link, pressed to sign in, in the asking browser; the link opened in a second browser context shows the empty form, and signs in only once the person types their own address and the code; a link made for another account never signs that account in there with one press; a second context without the known-browser cookie asks a code for the same address and the first browser's code still signs in; the same screens for an unknown address (AC-SAT-14, AC-SAT-44, AC-SAT-45) |
| T-SAT-52 | `apps/console/e2e/sat/factor-step.spec.ts` | set up an authenticator and save backup codes; sign in with a code and the authenticator; with a backup code; a wrong code; the paused dialog (AC-SAT-14) |
| T-SAT-53 | `apps/console/e2e/sat/step-up.spec.ts` | an intent action opens StepUp; cancel changes nothing; passkey and code paths re-send once; five wrong codes sign the person out |
| T-SAT-54 | `apps/console/e2e/sat/team.spec.ts` | invite with an intent; the invitee accepts in a second browser context; change their role; remove them and see what was rolled; each step in the Audit log with its address and device; the member's row menu's "View in audit log" shows only that member's rows, and "See changes in the audit log" opens the Team type (AC-SAT-15, AC-SAT-47) |
| T-SAT-55 | `apps/console/e2e/sat/roles.spec.ts` | create a custom role with needs ticked; a role that gives more than the actor holds is refused; edit; delete with a move; "View in audit log" from the role editor and "See changes in the audit log" on Roles open the log filtered to roles (AC-SAT-15, AC-SAT-47) |
| T-SAT-56 | `apps/console/e2e/sat/read-only.spec.ts` | a member with a custom read-only role made in the test sees no Team or Roles controls and gets the no-permission page on direct navigation (AC-SAT-16) |
| T-SAT-57 | `apps/console/e2e/sat/account-security.spec.ts` | add and remove factors with intents, regenerate backup codes, sign out one session and everywhere else, revoke a trusted browser, own activity |
| T-SAT-58 | `apps/console/e2e/sat/organisation.spec.ts` | rename, create, switch, delete with the typed name |
| T-SAT-59 | `apps/console/e2e/sat/invitation.spec.ts` | open a link signed out, sign up, accept; another account's view; a used link's "can't be used" |
| T-SAT-60 | `apps/console/e2e/sat/hold.spec.ts` | a privileged person without a factor is held on every page until a factor exists; an invitee in a non-privileged role may skip |
| T-SAT-61 | `apps/console/e2e/sat/audit-log.spec.ts` | filters, range, drawer, the three empty states; the `target` and `targetKind` filters with the object chip and "Clear filters"; a role without `auditLog.read` sees no entry point; another organisation's ID shows "No events match" (AC-SAT-47) |
| T-SAT-62 | `apps/console/e2e/sat/frame.spec.ts` | the frame's must-have states; no page-policy violation on any Saturday page; an open drawer stops the page behind scrolling; the built HTML has no inline script (AC-SAT-18) |
| T-SAT-63 | `apps/console/e2e/sat/failure-states.spec.ts` | load failed, offline, `429` with its wait, `503 paused` on sign-up |
| T-SAT-64 | `apps/admin/e2e/sat/staff-sign-in.spec.ts` | sign in with a code; not staff gets the same screens; signed out after too many tries |
| T-SAT-65 | `apps/admin/e2e/sat/staff-enrolment.spec.ts` | forced enrolment with the enrolment code; the code works once (AC-SAT-17) |
| T-SAT-66 | `apps/admin/e2e/sat/staff-manage.spec.ts` | add a member with an intent and see the enrolment code once; the new member enrols with both codes; a Viewer sees the controls disabled and the server refuses them; change role; remove; sign in again with a passkey alone (AC-SAT-17) |
| T-SAT-67 | `apps/admin/e2e/sat/staff-step-up.spec.ts` | AdminStepUp on every intent action of the Staff page |

### 19.4 Staging checks

| ID | Check |
|---|---|
| T-SAT-70 [STG] | The release smoke signs in to the console with the read-only smoke account and opens the Audit log; the owner signs in to Fin Admin through Access, is held at the factor step until it is shown, and opens Staff (recorded) (AC-SAT-19) |
| T-SAT-71 [STG] | One sign-up delivers its code and the `new-sign-in` email to the seed inbox from `auth.<staging-zone>` with DKIM, SPF and DMARC passing (owner check, recorded) (AC-SAT-20) |
| T-SAT-72 [STG] | A drill sends 10 failed staff sign-ins; `staff-sign-in-failures` emails the staging policy (AC-SAT-21) |
| T-SAT-73 [STG] | SP-25's result recorded; on the same-origin shape a POST to `console.<staging-zone>/api/auth/sign-out` reaches the API half with no OPTIONS and no redirect |

---

## 20. Build lanes and file ownership

### 20.1 Lanes

EXECUTION §3.2's lanes, with every file named. A lane changes only its own paths (EX-01, §1.3);
fragments belong to the area's lane wherever they live; anything else goes through the lane board.

| Lane | Machine | Owns | Starts | Needs | Delivers | Tier |
|---|---|---|---|---|---|---|
| L-SAT-01 Permission engine | B | `packages/access/**` (root files, `src/engine/**`, and on Saturday every `src/catalogue/{dashboard,staff}/*.ts` fragment, S2-09) | 09:00 (this spec from 08:45) | the workspace (P0-4) | §8.1 to §8.5; T-SAT-08, T-SAT-09 | S |
| L-SAT-02 Identity realms | A | `packages/identity/**`; `packages/db/src/schema/{identity,ops-step-up,ops-limits}.ts`; migrations `*_identity_*`, `*_ops_step_up`, `*_ops_limits`; `packages/db/roles/grants/{identity,step-up,limits}.json`; `packages/db/src/guards/identity.ts`; `packages/audit/src/events/identity.ts`; `packages/email/src/templates/identity/**`; `packages/app-contracts/src/identity/**` and `src/errors/auth.ts`; `apps/api/src/worker/identity/**`; `ops/monitoring/catalog/identity.ts`; `ops/monitoring/{staging,production}/alerts/identity.json`; the runbooks of its alerts | 10:00 on interface stubs of `packages/db` and `packages/audit`; rebased on P0-E at 12:30 | P0-E; L-SAT-01; L-SAT-05's `email.enqueue()` | §3 to §7, §11; `createRealm()`, `requirePerson`, the gate, intents, windows, limits, names, trusted and known browsers; SP-10's pins; T-SAT-01 to T-SAT-07, T-SAT-10, T-SAT-13 (with P0-E, who owns `packages/crypto`), T-SAT-21, T-SAT-27 to T-SAT-30, T-SAT-32, T-SAT-33 | S |
| L-SAT-03 Organisations | B | `packages/orgs/**`; `packages/db/src/schema/orgs.ts`; migrations `*_orgs_*`; grants `orgs.json`; guards `orgs.ts`; `packages/audit/src/events/orgs.ts`; `packages/email/src/templates/orgs/**`; `packages/app-contracts/src/orgs/**`; `apps/api/src/doors/audit/**` and `packages/server/src/doors/audit.ts` (S2-34); monitoring `orgs`; its runbooks | 11:00 | L-SAT-01; L-SAT-02's `requirePerson` and intents; L-SAT-05 | §9; `requireActor`; §14.5's console door operations; T-SAT-22, T-SAT-24 (organisations), T-SAT-25, T-SAT-35 to T-SAT-37 | S |
| L-SAT-04 Staff | A | `packages/staff/**`; `packages/db/src/schema/staff.ts`; migrations `*_staff_*`; grants `staff.json`; guards `staff.ts`; `packages/audit/src/events/staff.ts`; `packages/email/src/templates/staff/**`; `packages/app-contracts/src/staff/**`; `apps/api/src/worker/staff/**`; `apps/api/src/tasks/staff-bootstrap.ts`; `apps/api/src/doors/staff-audit/**`; monitoring `staff`; its runbooks | 12:30 | L-SAT-02's factory; L-SAT-01 | §6.4, §6.5, §10; `requireStaff`; the Access check; the drift duty; the bootstrap task; T-SAT-11, T-SAT-12, T-SAT-23, T-SAT-24 (staff), T-SAT-34, T-SAT-38 (drift), T-SAT-39 | S |
| L-SAT-05 Email | B | `packages/email/**` except the area template folders; `apps/api/src/worker/email/**` | 10:00 | P0-E's outbox shell | the sender, `email.enqueue()`'s allowlists, priorities, digests and budgets; `security-email-unsent`; T-SAT-15's harness, T-SAT-41 | S |
| L-SAT-06 Console | A | `apps/console/**` except L-SAT-11's key paths | 12:30 on route stubs; screens after the CSP and kit check (12:15 to 13:00, research note D3 §9) | L-SAT-02, L-SAT-03, P0-G (`@fin/ui`, `packages/frame`, `api()`) | §14.2's routes and policy fragments; the StepUp modal; §15.2's screens; T-SAT-04, T-SAT-05, T-SAT-30, T-SAT-31 (console), T-SAT-50 to T-SAT-63 | S for `src/server/**`, N for `src/client/**` |
| L-SAT-07 Fin Admin | B | `apps/admin/**` | 13:30 | L-SAT-04, P0-G | §14.3's routes and policy fragments; the AdminStepUp modal; §15.3's Saturday screens; T-SAT-04, T-SAT-05, T-SAT-14, T-SAT-30, T-SAT-31 (Fin Admin), T-SAT-64 to T-SAT-67 | S, N as console |
| L-SAT-08 Test harness | A | `packages/testing/**`, `playwright.config.ts`, `e2e/fixtures/**` | 09:00 | P0-D | the canon seed with `example.*` addresses; the email-sink reader; the virtual-authenticator and TOTP helpers; the frozen clock; the Access stand-in; the static host (spec 01 §4.7); a seeded random generator for property tests (no new dependency) | S |
| L-SAT-09 Ops and monitoring | B | `ops/fin/**`, `ops/monitoring/**` except area fragments, `ops/watcher/**` | after P0-7 | | the Access application and `pnpm fin access sync` and `revoke`; `pnpm fin task <env> staff-bootstrap`'s local half (§10.6); `FIN_ACCESS_READ_TOKEN` on `worker` (S2-11); §18.3's panels and §18.4's monitors; staging deploys at C2, C3 and C4 | S |
| L-SAT-10 Design | canvas | the two canvases (outside the repository) | 08:30 | | §15.4, in light, dark and phone, before the code that needs it merges; from 18:00 the verify boards ([KY-09]) | n/a |
| L-SAT-11 API keys and the edge (stretch) | A | `packages/keys/**`; `apps/edge/**`; `apps/console/src/client/routes/developers/keys/**`; `apps/console/src/server/routes/keys.ts` and `src/server/policy/keys.ts`; `packages/db/src/schema/keys.ts`; migrations `*_keys_*`; grants `keys.json`; guards `keys.ts`; `packages/audit/src/events/api-keys.ts`; `packages/email/src/templates/api-keys/**`; monitoring `keys` | after C3, only if L-SAT-02 is green | L-SAT-02, L-SAT-03 | §12; T-SAT-40; `apps/console/e2e/sat/api-keys.spec.ts` | S |

Each app lane owns its own `e2e/sat/` journeys; L-SAT-08 owns only the shared fixtures.

### 20.2 Order

```
P0-4 workspace ─► L-SAT-01 engine (pure) ─► L-SAT-03 orgs ─────────► L-SAT-06 console API half and screens
                                 │              ▲                          ▲
P0-E db, audit ─► L-SAT-02 realms ┴──────────────┘──► L-SAT-04 staff ─► L-SAT-07 Fin Admin
                                 ▲
P0-E outbox ─► L-SAT-05 email ───┘ (security emails for 02, 03, 04)
P0-G ui, frame, api() ─► CSP and kit check (12:15 to 13:00) ─────────► 06, 07 screens
L-SAT-08 harness ──────────────────────────────────────────────────► every journey
SP-25 (09:15) ─► same-origin or split-host settings for 02, 06, 07
L-SAT-10 design ─► ProtectAccount, AdminSecondFactor, AdminStaff ─► 06, 07; AdminRoles and AdminRoleEditor ─► Sunday
C3 18:00: L-SAT-02 green (AC-SAT-02 to AC-SAT-06)? ─► L-SAT-11 API keys and the edge
```

### 20.3 Hand-offs

- P0-D's `apps/console/src/server/main.ts` and `apps/admin/src/server/main.ts`, and P0-G's client
  shells, pass to L-SAT-06 and L-SAT-07 when their last Phase 0 pull request merges (EX-07).
- The catalogue fragments of §8 pass from L-SAT-01 to Sunday's and Monday's lanes (S2-09).
- Each lane asks P0-D through the lane board for its ID prefixes (IF-01) and P0-E for `totp.ts` if
  SP-10 needs it.

### 20.4 Review gates (R10, R11)

Every lane but L-SAT-10 is tier S, except client-only screen code (N). `commit` reviews on every
push; the `pr` gate with the attack pass at each milestone, on Saturday's profiles (EXECUTION §1.7: a
member or staff user exceeding a granular role or acting on someone who outranks them; step-up bypass
with a used intent, an intent for another action, a proof from another session or a replayed ceremony;
a mailbox-only staff enrolment; account enumeration; session fixation and cookie scope; an unlisted
Better Auth endpoint; invitation hijack; giving more than one holds; removing the last admin; CSRF and
origin checks; a forged Access identity; a leaked service login writing a critical table). Extra
checks: the test-truth check on every guard in `packages/identity`, `access`, `orgs` and `staff`; the
endpoint-policy set reviewed against the installed Better Auth router by reading its source. Every
merge carries a signed receipt whose sessions are within R11 and [RV-06]'s floor (AC-SAT-22). The
nightly review at 01:00 Sunday is `all --cold` over everything merged.

### 20.5 Checkpoints and cut lines (EXECUTION §3.7)

- **C2 13:00:** Phase 0's exit. L-SAT-01 and L-SAT-05 have a merged first milestone; L-SAT-02 is on
  P0-E.
- **C3 18:00:** if L-SAT-02 has not merged with AC-SAT-02 to AC-SAT-06 green, CUT-01 applies (Google,
  passwords, the staff reset screen, custom staff roles and AdminRoleEditor, API keys move, in that
  order). Otherwise L-SAT-11 starts.
- **C4 22:00:** whatever is not on staging by 23:59 takes Sunday's 08:00 to 11:00 spill block. A
  feature that cannot meet the NB rules is hidden, not routed and refused by the server until it can
  (EX-25). Never cut: server-side permission checks, step-up intents, the mandatory second factor and
  enrolment codes, audit events with their tests and the database guard, scrubbing, and these
  journeys' Playwright tests.

### 20.6 Interfaces other specs rely on

| ID | Interface | Provided by | Used by |
|---|---|---|---|
| IF-01 | New ID prefixes (§13.1) in `packages/core/src/ids.ts` | P0-D, on L-SAT-02's request | everyone |
| IF-02 | Organisation scope from `Fin-Organization` on every organisation route, through `requireActor`; never the session's current organisation (S2-10) | L-SAT-03 | Sunday's console routes; Monday's `/api/money/*` |
| IF-03 | The step-up action catalogue, one fragment per area (`packages/identity/src/step-up/actions/<area>.ts`), with `bind` and `reason_key`; a transfer's intent binds its amount, currency, beneficiary and source ([SA-08]) | L-SAT-02 | Sunday, Monday |
| IF-04 | `requirePerson`, `requireActor`, `requireStaff` and the actor they return for `recordAudit` (`{ kind, id, via, stepUp }`) | L-SAT-02, -03, -04 | every app route |
| IF-05 | Windows: `hasFreshProof(session, clock)` for reveals; `identity.proof_view` and `staff.proof_view` for `api`'s door checks | L-SAT-02, -04 | Sunday's reveals |
| IF-06 | §13.6's views and `identity.person_gate()` | L-SAT-02, -03, -04 | `api`'s door checks ([SA-36]) |
| IF-07 | The `CredentialSource` registry (§9.4) | L-SAT-03 | API keys (§12), Sunday's webhook secrets |
| IF-08 | The staff catalogue's onboarding and money permissions with their step-up kinds (§8.3) | L-SAT-01 | Sunday's and Monday's Fin Admin routes |
| IF-09 | `identity.organization.live_status`: the column exists from Saturday; its values and its writer (`api`, a column grant) are Sunday's; the go-live approval transaction also calls `identity.revoke_trusted_browsers(org_id, 'production_access')` (§6.6) | L-SAT-03 creates it | Sunday's go-live, §6.6, §12.2 |
| IF-10 | From P0-D: the origin gate with `X-Fin-App`; the problem envelope; the app-route idempotency store (§14.1); door matrix fragments; the request line's fields | P0-D | this spec |
| IF-11 | From P0-E: guard registrations by table, operations, key column and accepted events, matching `target` or `refs`; `audit.record()`'s per-login allowlist; the revocation journal API; `email.enqueue()`; `ops.set_switch()` | P0-E | this spec |

---

## 21. Acceptance criteria

### 21.1 EXECUTION §3.6's criteria and the tests that prove them

| ID | Statement (short) | Tests |
|---|---|---|
| AC-SAT-01 [U] | Giving and outrank rules in both catalogues | T-SAT-08 |
| AC-SAT-02 [C] | Mounted paths equal the allowlist; odd spellings 404 before limits; `/change-email` and staff backup-code paths 404 | T-SAT-01 |
| AC-SAT-03 [I] | Code sign-in with a factor is `aal1` and reaches only the factor step; a trusted-browser session writes no proof | T-SAT-27 |
| AC-SAT-04 [I] | Every Fin Admin route refuses `aal1`; served `aal1` staff requests are zero; enrolment needs a valid code, used once | T-SAT-31, T-SAT-34, alert `admin-without-second-factor` |
| AC-SAT-05 [I] | The last factor stays for staff and privileged developers; an Admin elsewhere is held everywhere | T-SAT-28 |
| AC-SAT-06 [I] | Each step-up action refuses missing, mismatched, used, expired and other-session intents and passes once; another person's passkey is refused | T-SAT-30 |
| AC-SAT-07 [I] | Invitations bound to the address, 7 days, once; the same answer for unknown and expired; a role change takes an intent | T-SAT-25 |
| AC-SAT-08 [I] | The last Super admin and the last staff Admin stay, under concurrent demotions | T-SAT-24 |
| AC-SAT-09 [I] | Identical answers for registered and unknown addresses | T-SAT-32 |
| AC-SAT-10 [I] | Per-recipient limits under concurrency; fail closed; digests; a restart keeps pauses | T-SAT-33, T-SAT-15 |
| AC-SAT-11 [I] | Every auth event tested; rollbacks leave none; guarded inserts without audit refused; the chain verifies after the seed | T-SAT-21 to T-SAT-23, T-SAT-26 |
| AC-SAT-12 [I] | A differing Access identity refused and logged; a trust cookie gives staff nothing | T-SAT-34 |
| AC-SAT-13 [I] | Every permission check refuses a role lacking it, one test per route | T-SAT-31 |
| AC-SAT-14 [E2E] | Sign up, passkey, sign out, passkey sign-in; code plus TOTP; backup code | T-SAT-50 to T-SAT-52 |
| AC-SAT-15 [E2E] | Invite, accept in a second browser, change role, custom role, giving refused, remove with what was rolled, each in the Audit log with address and device | T-SAT-54, T-SAT-55 |
| AC-SAT-16 [E2E] | A custom read-only role sees no Team or Roles controls and the no-permission page | T-SAT-56 |
| AC-SAT-17 [E2E] | Fin Admin: code, forced enrolment with the enrolment code, add with an intent and the code once, the new member enrols, a Viewer refused, change role, remove, passkey-alone sign-in | T-SAT-64 to T-SAT-67 |
| AC-SAT-18 [E2E] | No page-policy violation; scroll stops behind a drawer; no inline script | T-SAT-62 |
| AC-SAT-19 [STG] | The release smoke and the owner's Fin Admin check; request lines with the release SHA | T-SAT-70 |
| AC-SAT-20 [STG] | Sign-up code and `new-sign-in` delivered with DKIM, SPF and DMARC passing | T-SAT-71 |
| AC-SAT-21 [STG] | Ten failed staff sign-ins notify the staging policy | T-SAT-72 |
| AC-SAT-22 [CI] | Every Saturday pull request merged with a signed receipt, the attack pass on its S files, sessions within R11 and the floor | the `gate` |
| AC-SAT-23 [U, E2E] | Every cookie `__Host-`, `Secure`, `HttpOnly`, `Path=/`, no `Domain`; `session_token` `Strict`, the rest `Lax`; each origin-gate refusal reason; a cross-site form POST and a sibling host's `fetch` refused in three engines; no OPTIONS on the console's own calls | T-SAT-03, T-SAT-04, T-SAT-06, P0-D's gate tests; spec 06's `@security` project |
| AC-SAT-24 [E2E] | The edge toggle in both frames: collapse and expand, focus, `aria-expanded`, remembered, hidden below 1280px, under a drawer's scrim, the specs' geometry; the rail's 24px brand mark | spec 06 AC-UI-09 |

### 21.2 New criteria

| ID | Statement |
|---|---|
| AC-SAT-25 [STG] | SP-25 passes on the staging zone, or the split-host fallback of §2.6 is chosen and recorded, before L-SAT-06's first ready pull request (T-SAT-73) |
| AC-SAT-26 [I] | Every cookie either realm sets matches §2.4 exactly (T-SAT-03, T-SAT-04) |
| AC-SAT-27 [I] | Every unsafe request to either API half, `/api/auth/*` included, without the exact `Origin`, a `same-origin` `Sec-Fetch-Site` when sent, the right `X-Fin-App` and a JSON body is refused with `invalid_origin`; the Google callback GET is the only exemption (T-SAT-06 and P0-D's gate tests) |
| AC-SAT-28 [I] | On Fin Admin, every `/api/*` request without a valid Access JWT is refused before any handler, `/api/auth/*` included; when the key set cannot be fetched the API half fails closed (T-SAT-11, T-SAT-34) |
| AC-SAT-29 [I] | A staff code is sent only for an active or pending member whose address equals the Access identity, and the answer is identical otherwise (T-SAT-32, T-SAT-34) |
| AC-SAT-30 [I] | A removed staff member cannot sign in by code or passkey; adding them again makes them pending with the same `stf_` ID (T-SAT-34) |
| AC-SAT-31 [I] | No session outlives its absolute limit through refreshes or a passkey step-up; an `aal1` session dies after 10 minutes (T-SAT-29) |
| AC-SAT-32 [I] | Two concurrent re-sends with the same intent: exactly one action happens (T-SAT-30) |
| AC-SAT-33 [I] | A newcomer gets a first organisation as Super admin and is held at "Protect your account" with no "Skip"; an invitee in a non-privileged role may skip (T-SAT-35, T-SAT-50, T-SAT-60) |
| AC-SAT-34 [I] | Organisation routes act only on the `Fin-Organization` header's organisation; a missing header is `400`; a non-member's or deleted organisation is `404` like an unknown ID (T-SAT-35) |
| AC-SAT-35 [I] | Removal and demotion roll the listed credentials by default in the same transaction, at once only when the actor holds the credential's rolling permission and otherwise with a 1-hour overlap and a flag, and email the remaining Super admins and Admins (T-SAT-36) |
| AC-SAT-36 [I] | The audit door operations re-check session, membership, permission and, for staff, the Access JWT (T-SAT-37) |
| AC-SAT-37 [CI] | `monitoring:check` passes with every event of §16 and §18.1 catalogued, every failure or security event alerted or reasoned, and every alert's runbook present |
| AC-SAT-38 [U] | No template ever shows an enrolment code, a key secret or a backup code (T-SAT-41) |
| AC-SAT-39 [I] | Every library-driven event of §3.5 is written in the same transaction as its row, through Fin's unit of work; an endpoint for which SP-10 shows that cannot hold is blocked and replaced by a Fin route, and no table leaves the guard list (T-SAT-02, T-SAT-21, T-SAT-26) |
| AC-SAT-40 [U] | Exactly `GET /api/viewer` and `POST /api/enrolment/redeem` are reachable below `aal2` on Fin Admin (T-SAT-14) |
| AC-SAT-41 [I] | Staff `/two-factor/enable` answers carry no backup codes; in a production configuration a pending member cannot enable an authenticator as the first factor (T-SAT-34) |
| AC-SAT-42 [CI] | The route policies list exactly §14.2's and §14.3's routes, each with schemas, and no other (T-SAT-31) |
| AC-SAT-43 [I] | A write to a sign-in table without its event (a passkey, an authenticator, a password, a session, a raised assurance, a trusted browser, a changed address; both realms) is refused at commit, as the service's own login (T-SAT-26) |
| AC-SAT-44 [I] | A code request from a browser that is not known for the address never supersedes a known browser's live code, and the unknown share leaves known browsers their allowance (T-SAT-33, T-SAT-51) |
| AC-SAT-45 [E2E] | A sign-in link opened outside the asking browser never signs in with one press; the person types their own address (T-SAT-51) |
| AC-SAT-46 [I] | A trusted-browser session is at the factor step from the request after its person becomes privileged or a member of an organisation with Production access; gaining Production access revokes the rows (T-SAT-27) |
| AC-SAT-47 [E2E] | Each audit-log entry point of §15.2.1 opens the log filtered to its object, only for roles with `auditLog.read` (T-SAT-54, T-SAT-55, T-SAT-61, `api-keys.spec.ts`) |
| AC-SAT-48 [I] (Sunday spill) | A recovery never removes the factors that protect an organisation other than the recovering one, and a staff recovery has a second approver once one can exist (T-SAT-42) |

---

## 22. Decisions this spec makes (S2-nn)

Each is the default builders follow; the steward adds them to DECISIONS.md, and the owner may
overturn any.

| ID | Decision | Why |
|---|---|---|
| S2-01 | One routing mode read from configuration (`FIN_API_ORIGIN` set or not) switches between same-origin and the split-host fallback; both modes are unit-tested | SP-25 can fail on the day; a code change then would cost hours |
| S2-02 | The TOTP issuer is "Fin" in production and "Fin (staging)" in staging | Authenticator apps must not mix the two |
| S2-03 | Staff backup codes are removed from `/two-factor/enable` answers and stored as an empty list, beside blocking the backup-code endpoints | [SA-04] says staff have none; the plugin makes them anyway |
| S2-04 | Every library endpoint that writes a sign-in table runs inside Fin's unit of work, so its rows and their events share one transaction, and the sign-in tables of both realms are guarded (§13.8). If SP-10 shows that cannot hold for an endpoint, that endpoint is blocked and Fin writes its own route; no table leaves the guard list | R9 and the important-actions rule name sign-in-method changes; a leaked console login must not add a passkey or mint a session quietly, and the library's hook timing must not decide that |
| S2-05 | Sign-up is Fin's `POST /api/sign-up` with a sign-up request row; no user row exists before the mailbox is proved; `/sign-up/email` and `/email-otp/verify-email` stay blocked | Removes pre-registration and one library surface |
| S2-06 | The Authenticator board shows the key for manual entry until research note D3's Q5 (a QR encoder) is answered | No new dependency without the owner's yes |
| S2-07 | A developer session at the factor step lives 10 minutes, like a staff one | A half-finished sign-in should not linger |
| S2-08 | A person with no membership gets a first organisation as Super admin (`POST /api/orgs/first`, no step-up), as in the old product | Keeps the old onboarding; with [SA-05] it makes the factor mandatory at sign-up for self-serve developers |
| S2-09 | On Saturday L-SAT-01 writes every catalogue fragment; ownership of each area's fragment passes to that area's lane at its first merge | The role editor needs all 26 permissions on Saturday |
| S2-10 | Organisation routes take the organisation from `Fin-Organization`, never from the session | The old product's cross-tab guard, made structural |
| S2-11 | The hourly Access drift check runs in the worker with a new read-only token `FIN_ACCESS_READ_TOKEN` (Access: Apps and Policies Read) | ARCHITECTURE §5.10 needs the Access list; §7.8 names no holder for it |
| S2-12 | A passkey step-up's replacement session keeps the old session's absolute expiry | A step-up must never lengthen a session |
| S2-13 | An idempotent replay never returns a body that carried a secret: `409 already_done` with the target ID | Secrets are shown once ([AP-04]'s rule, applied to app routes) |
| S2-14 | `ops.step_up_intent` is guarded on proving and consuming, not on insert | An unproved intent grants nothing; one audit row per prompt would be noise |
| S2-15 | The invitation token travels in the link's fragment, is exchanged for a host-only cookie, and never sits in a path; accepting by ID is allowed for the signed-in person whose address matches | No bearer value in a URL after its first use (ARCHITECTURE §1 principle 7) |
| S2-16 | AdminRoles is a Roles tab on Staff, at `/staff/roles` | Mirrors the dashboard's Team and Roles without a new sidebar item |
| S2-17 | `user.name_changed` stores no name; the audit sentence says "changed the name on the account" | Metadata never holds a name (ARCHITECTURE §8.2) |
| S2-18 | Removing a staff member keeps the row as `removed`; adding the address again reactivates the same `stf_` ID as pending | Keeps one identity in the staff audit trail |
| S2-19 | Deleting an organisation sets `deleted_at` and deletes its memberships, custom roles and pending invitations in one audited transaction | Other areas keep records under [DA-12] |
| S2-20 | A staff role change ends the target's sessions | Access changes take effect at once, as in the old product |
| S2-21 | Until Sunday's screens exist, Fin Admin's `/` opens Staff | Saturday has no other Fin Admin page |
| S2-22 | A sign-in code to an unknown address makes an account only in the asking browser and only while sign-ups are open | The old product's behaviour, kept under the kill switch |
| S2-23 | The staff realm's library user model is `staff.member` | One name for a staff member everywhere |
| S2-24 | An Access identity that is not on the staff table writes `staff.not_listed`, which pages as `admin-staff-refused` | The Access list and the staff table must agree |
| S2-25 | Passkey journeys run on Chromium's virtual authenticator; Firefox and WebKit run the code and authenticator paths | Playwright's virtual authenticator is Chromium-only |
| S2-26 | The error codes of §14.1, including `factor_step_required` and `fresh_session_required` | The plan names only `step_up_required` and `second_factor_required` |
| S2-27 | The kill-switch route is Saturday's; its screen is a pending composition in Sunday's spill block | EXECUTION lists the step-up on Saturday but no screen |
| S2-28 | Developer account recovery ([SA-30]) is specified here and built in Sunday's spill block; the recovering Super admin must hold the built-in Super admin role, within S2-41's scope | Neither day's list in EXECUTION schedules it; its 72-hour wait cannot be journey-tested on Saturday |
| S2-29 | Changing an invitation's role or resending it issues a new token; the old link stops working | A changed offer must not stay valid at its old terms |
| S2-30 | Passkeys get Fin's device summary as their name and cannot be renamed at launch | `/passkey/update-passkey` stays blocked |
| S2-31 | Guards check the session, membership, permission, outrank and input before asking for a factor | Nobody proves a factor for something they cannot do |
| S2-32 | At most 30 intents per session per 10 minutes | Bounds `ops.step_up_intent` |
| S2-33 | `identity.privileged_permission` holds §8.2's P set for `identity.person_gate()`, tested against the catalogue | The gate runs in SQL; the catalogue is code |
| S2-34 | L-SAT-03 owns the organisation and person audit door operations; L-SAT-04 the staff one | EXECUTION names no owner for `api`'s audit reads |
| S2-35 | `console-sign-in` and `console-api-health` check the static page and the API half apart; `admin` and `admin-api-health` expect Access's own refusal and fail on any answer from the admin API half; the watcher asserts the Access application's shape (`admin-access-shape`) | A static page proves nothing about the API half, and a monitor that passed Access would need a service token (spec 08 D08-14) |
| S2-36 | The organisation-scope mirrors `member.signed_in`, `member.second_factor_added` and `member.second_factor_removed` stay, one row per membership | The old audit log showed them; organisations see their members' security state |
| S2-37 | Staff mail goes from the main zone's `auth.` sending subdomain | One warmed reputation for codes ([EM-08]) |
| S2-38 | A code request from a browser that is not known for the address never supersedes a known browser's live code, and such browsers may use only part of the per-recipient allowance (3 per hour, 8 per day) | Otherwise anyone who knows an address can cancel its owner's code and use up the day's allowance, and the code is the only first factor for people without a passkey. A new browser of the owner's shares the smaller allowance with strangers; a known browser never does |
| S2-39 | A code from a sign-in link signs in with one press only in the browser that asked; elsewhere the person types their own address and the code | A link made for someone else's account would otherwise sign a person into it (login CSRF), where they might enter customer data or make keys |
| S2-40 | Trusted-browser eligibility is re-checked on every request, and gaining Production access revokes the rows | [SA-31] says never for those people; a check made only when the browser is offered let a row outlive the condition for up to 30 days |
| S2-41 | A Super admin may recover only a person who belongs to their organisation alone; every other recovery is the staff path with an identity check and, once two staff hold `accounts.recover`, a second approver; the Super admins of every organisation where the person is privileged are told and may cancel; the organisation is recorded | The account is global, so one organisation's Super admin could otherwise strip the factors that protect another, and the mailbox would then enrol the next one ([SA-05], R6) |
| S2-42 | A credential is rolled at once on a removal or demotion only when the actor holds the permission that rolls it; otherwise with a 1-hour overlap, flagged for a Super admin | [SA-33] still rolls everything, but a role meant only to invite and remove people must not be able to cut Production traffic off in one act |
| S2-43 | The audit-log entry points of round 2 open `/audit-log` with `target` or `targetKind`, filtered inside the organisation's rows | Round 2 asks for them; filtering in `api` keeps another organisation's objects unreachable |

---

## 23. Open items

| # | Item | For |
|---|---|---|
| 1 | With [SA-05]'s default and S2-08, every developer who owns their first organisation must add a factor at sign-up; "Skip for now" shows only for invitees in non-privileged roles. Confirm, or narrow [SA-05] | owner, before Saturday's start |
| 2 | SP-25's result decides between same-origin and the split-host fallback (§2.6) | ops agent, 09:15 to 09:45 (EXECUTION §2.6, S-01) |
| 3 | SP-10's pins on 1.7.25: that every adapter write of a request goes through Fin's unit of work and `hooks.after` runs before the handler returns (S2-04; an endpoint where it does not is blocked and replaced), the versioned-secrets option, TOTP reuse within a step, counter regression, `returnHeaders` on `getSession` | L-SAT-02, Saturday morning |
| 4 | `FIN_ACCESS_READ_TOKEN` is a new credential (S2-11): it needs a CR entry, a row in `ops/credentials.json` and a rotation runbook | owner, L-SAT-09 |
| 5 | Research note D3's Q5 (a QR encoder for the Authenticator board) | owner |
| 6 | The UI SDK on Saturday is beta.9 (research note D3 §3); OTPInput and Modal behaviour must be re-tested at the beta.13 move on Sunday | P0-G |
| 7 | The library stores the session token in clear in `identity.session.token`; only `fin_console` reads it, but [DA-15] should say whether dumps carry the table | owner, before production |
| 8 | Resolved: EXECUTION EX-08, P0-0 and L-SPEC now keep every spec in `docs/plan/specs/` | none |
| 9 | ARCHITECTURE writes `admin.<admin zone>`; this spec writes `admin.<zone>` for the host's own zone. Passkey RP IDs must be the final hosts before the first production passkey ([FD-10]) | owner, by Tuesday 24 Nov |
| 10 | Copy changes against the inventory: the name-change sentence loses the name (S2-17); invitation links change to `/invite`; Team gains "Change role" and "Resend" on invitations; ProtectAccount's held state has no "Skip" | L-SAT-10 |
| 11 | Spec 04 should send `Fin-Organization` on `/api/money/*` (IF-02) and add its intents through IF-03 | Monday's spec writer |
| 12 | P0-D must provide `X-Fin-App` in the origin gate, the app-route idempotency store and the problem envelope fields (IF-10); P0-E the guard registrations with `refs` and the journal API (IF-11) | P0-D, P0-E |
| 13 | `pnpm fin access sync` and `revoke`, and the staff-bootstrap task's local half, are new `ops/fin` commands (control paths) | L-SAT-09, owner approval |
| 14 | Developer account recovery (S2-28) and the switches screen (S2-27) are scheduled for Sunday's spill block, which is already full | steward at C1 Sunday |
| 15 | Split `member.invite` ("Invite and remove people", [SA-11]) into `member.invite` and a privileged `member.remove` with its own intent. Recommended: yes, for R6's granular roles (a role meant to add people should not be able to remove them). It changes the owner-approved catalogue to 27 permissions, the RoleEditor board, T-SAT-09, §7.6, §8.2, §9.2 and §14.2. Until answered, removal stays under `member.invite`, and S2-42 already takes the outage lever away | owner, before L-SAT-01's first merge |
| 16 | Spec 03's go-live approval transaction calls `identity.revoke_trusted_browsers(org_id, 'production_access')` (IF-09, §6.6), and spec 03's Fin Admin organisation screens carry the staff recovery routes of §6.8 | Sunday's spec writer |
