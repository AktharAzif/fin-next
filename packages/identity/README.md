# @fin/identity

The developer and staff realms: Better Auth 1.7.25 with the passkey, two-factor and email-OTP
plugins, built by one factory with the same hardening (spec 02 §3 to §7 and §11, [SA-01]). Better
Auth proves who someone is; everything else here is Fin's own: the endpoint allowlist, the
mandatory-second-factor gate, step-up intents and windows, emailed codes bound to the asking
browser, known and trusted browsers, limits in Postgres, names, staff enrolment codes, audit events
and security notices.

## Using a realm

`createRealm()` is called once per process inside `main()`:

```ts
const settings = readRealmSettings("developer", process.env); // refuses a bad start
const db = createPgDatabase({ pool, clock, release, lines });
const realm = createRealm({ settings, db, clock, lines, docsOrigin });
// in the API half, after ingress and the origin gate:
app.all("/api/auth/*", (c) => realm.handler(c.req.raw, context));
```

- `realm.handler(request, context)` answers `/api/auth/*`: the exact allowlist first (404 with an
  empty body for anything unlisted or blocked, before any limit), then a GET that another site
  sent (`Sec-Fetch-Site` other than `same-origin` or `none`) gets `403 invalid_origin`, then one
  unit of work around the library, read in full and committed before a byte is sent.
- No GET counts a Fin budget or makes a step-up intent (§2.3). To add a further passkey, the client
  sends `POST /api/auth/passkey/verify-registration` with `{}` and no `Fin-Step-Up-Intent`, which
  answers `403 step_up_required` with the intent; after the StepUp ceremony it sends
  `GET /passkey/generate-register-options` (which only checks the intent) and then
  `POST /passkey/verify-registration` with the response, both with the header. The GET without
  the header answers `step_up_required` with no `intent_id`.
- `realm.run(context, fn)` runs a Fin route's work as part of a realm request (one unit of work,
  the request state bound); `requirePerson()` is the guard for person-scope routes, `signUp()` the
  core of `POST /api/sign-up`, `revokeSession()` and `revokeOtherSessions()` the cores of Account
  security's session routes, `issueEnrolmentCode()` and `redeemEnrolmentCode()` the staff routes'.
- "Sign out everywhere else" keeps this browser (§11.4): its route passes the browser's
  `__Host-fin.known_browser` and `__Host-fin.trusted_browser` tokens as `knownBrowserToken` and
  `trustedBrowserToken`, and `revokeOtherSessions()` keeps those rows and the trusted browser the
  current session came from, ending every other session.
- A factor shown at a step-up raises the session to `aal2` (§6.1), so a trusted-browser session
  that has shown its factor keeps working when an action it takes revokes its row.
- `signUp()` for an address that already has an account sends `already-registered` and no code,
  and records a codeless request for the browser in the code's place (`codeless` in
  `identity.email_code_request`): no code is right for it, it never supersedes a known browser's
  live code, and the browser's next steps answer as they would for an unknown address. A browser
  known for the account records none and leaves the live code as it was.
- Every code request, codeless request and code try for one address takes the address's lock
  (`lockAddress()`) before it reads the live requests, so overlapping requests leave one live code
  and one asking browser. The lock is a row lock on the address's slot in
  `identity.email_code_lock`: a fixed set of 65,536 rows, numbered by the first two bytes of the
  address's keyed hash, that holds nothing about any address and never grows. Only `fin_console`
  may lock it and no function another login may run touches it (the hourly sweep has nothing to
  delete there), never an advisory lock (any login may take one). Every path takes its locks in
  one order: sign-up's own limits (`sign_up_network`, then `sign_up_address`, which only sign-up
  takes), then the network's code limit, then the address's lock, then the address's code limits.
- Known gap: the hourly sweep deletes expired sessions and verification rows, which the library
  also deletes when a browser presents one, so a `fin_worker` transaction left open after a sweep
  delays those requests until it ends or the console's `lock_timeout` refuses them. Closing it
  means the console never waits on a row the sweep may hold; it is listed for the pre-production
  review.
- The front door gives `context`: the request ID, `CF-Connecting-IP`, the user agent, the verified
  Access identity on Fin Admin, and `annotate` to add the auth fields to its own `request` line.

## Google sign-in (stretch 5, spec 02 §5.8)

Off by default: with `FIN_FEATURE_GOOGLE` unset or `off`, `/sign-in/social`, `/callback/:id`,
`/link-social` and `/unlink-account` are blocked in the allowlist and answer 404. It is on only for
the developer realm, with `FIN_FEATURE_GOOGLE=on` and the console's OAuth client
(`FIN_GOOGLE_CLIENT_ID`, `FIN_GOOGLE_CLIENT_SECRET`, a sealed variable on `console`, CR-12),
registered with the redirect URI `<FIN_PUBLIC_ORIGIN>/api/auth/callback/google` exactly. The staff
realm has its own switch (below) and refuses to start with this one on. `FIN_GOOGLE_TEST_ISSUER`
points the provider at the fixture (packages/testing/src/oauth) and is refused outside development
and test.

- Fin's own provider (`src/google/provider.ts`, mounted by a plugin with no routes of its own):
  authorization code with PKCE (S256), a nonce the library keeps in the state, the exact redirect
  URI, `prompt=select_account`, redirect only. The callback's code exchange and the provider's key
  set are fetched before the request's unit of work opens, so no pooled client is held across them;
  the ID token is verified on node:crypto (RS256, issuer, audience, expiry, age, nonce, a verified
  address) before the library sees anything from it.
- A Google session is `aal1` (`createdVia: google`), at the factor step when the person has a
  factor, and proves the mailbox only when Google verified the account's own address. A person is
  made from a verified address while sign-ups are open and within the sign-up limits; an address
  that already has an account is never linked implicitly (`?error=account_not_linked`).
- Linking is `/link-social` from Account security with an `account.google_link` intent (bound to
  the provider), which rides the OAuth state's server context and is consumed in the callback's
  transaction with `account.linked`; only the same address links. `/unlink-account` takes an
  `account.google_unlink` intent bound to the account, only for the person's own Google row.
- No provider token is kept: the account row's token columns stay empty, and the library's update
  on a later sign-in is off.
- `auth.google_failed` (alert `google-sign-in-failing`) is written only for what Fin or the provider
  did: the token endpoint unreachable, failing or unreadable, Fin's own client refused, the keys
  unavailable, or an ID token that is not the provider's for this client now. Whatever a client can
  cause, including by changing its own authorization request on its way through the browser (the
  nonce, the scopes, the PKCE challenge, the redirect URI), is `auth.google_refused` with its
  reason; `src/google/flow.ts` decides which is which.

### The staff realm (`src/google/staff.ts`)

Off by default, behind its own switch: with `FIN_FEATURE_STAFF_GOOGLE` unset or `off`, the staff
realm's `/sign-in/social` and `/callback/:id` are blocked and answer 404. It is on with
`FIN_FEATURE_STAFF_GOOGLE=on`, the company Workspace's internal client for the staff host
(`FIN_GOOGLE_CLIENT_ID`, `FIN_GOOGLE_CLIENT_SECRET`, sealed on the staff API service, its redirect
URI `<FIN_PUBLIC_ORIGIN>/api/auth/callback/google` on the staff host) and the Workspace's domain in
`FIN_GOOGLE_HOSTED_DOMAIN`. The developer realm refuses to start with either staff setting, and the
staff realm with the developer realm's switch. `/link-social` and `/unlink-account` stay blocked.

- Google is at most a first factor: a staff Google session is the emailed code's `aal1` session
  (`createdVia: google`, 10 minutes, bound to the Access identity's `sub`), at the factor step for
  a member with a factor and at enrolment for a pending member, who still needs the enrolment code.
- Only a member: the verified address must be an `active` or `pending` member's and equal to the
  request's Access identity, and the ID token's `hd` must be the Workspace domain. Anything else
  goes back to `/sign-in?error=account_refused`, lined (`auth.google_refused`, and
  `staff.not_listed` or `staff.access_mismatch`), with `staff.sign_in_failed` for a listed member.
  No member is ever made from Google.
- No sign-in method row: `staff.account` stays empty (its guard refuses every write, spec 02
  §13.8), so the library's account linking is never used. The callback's before-hook checks the
  state as the library's callback does (`parseState`), makes the session through the library's
  adapter, sets the cookie and redirects, with `staff.second_factor_required` in the same unit.
- The API half checks the Access token on every request before the realm runs, the callback
  included, and the staff gate compares the session with it again on every later request.
- The round trip's own outcomes are lined as in the developer realm (`src/google/flow.ts`):
  `auth.google_failed` only for what Fin or the provider did, and whatever a client can cause
  through its own round trip `auth.google_refused` with its reason and a refused request line.

## Layout

| Path | What |
|---|---|
| `src/realm.ts` | `createRealm()` and the library options per realm (§3.3, §3.4) |
| `src/endpoint-policy.ts` | the allowlist per realm (§4); its set test is T-SAT-01 |
| `src/hooks/` | `hooks.before`, `hooks.after` and `databaseHooks` (§3.5) |
| `src/gate.ts`, `src/step-up/` | the gate (§6) and intents, windows and the digest (§7) |
| `src/codes.ts`, `src/browsers.ts`, `src/limits.ts` | emailed codes, known and trusted browsers, limits |
| `src/audit/`, `src/email/`, `src/monitoring.ts` | the event, template and line catalogues of this area |
| `src/ports/` | the adapters to packages/db, packages/audit and the outbox until they land |
| `migrations/` | the SQL the runner applies, in name order |
| `grants/` | the grant fragments the runner renders |
| `test/` | the Postgres 18 harness, the platform fixture and a software authenticator |

## Tests

`pnpm --filter @fin/identity test` runs the unit tests. `pnpm test:db` runs the integration tests
against `FIN_TEST_DATABASE_URL` (a Postgres 18 server whose role may create databases and roles):
the harness builds one template database from the fixture, the migrations and the grants, clones it
per file, and connects as each service's own login.
