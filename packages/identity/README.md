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
  A password sign-in and a reset take turns on another slot of the same table, the address's
  password turn (`lockPasswordTurn()`), never its code lock, so no code request or try waits on a
  sign-in's password check.
- Known gap: the hourly sweep deletes expired sessions and verification rows, which the library
  also deletes when a browser presents one, so a `fin_worker` transaction left open after a sweep
  delays those requests until it ends or the console's `lock_timeout` refuses them. Closing it
  means the console never waits on a row the sweep may hold; it is listed for the pre-production
  review.
- The front door gives `context`: the request ID, `CF-Connecting-IP`, the user agent, the verified
  Access identity on Fin Admin, and `annotate` to add the auth fields to its own `request` line.

## Passwords (stretch 2, spec 02 §5.7)

Off unless `FIN_FEATURE_PASSWORDS=on`, and refused at start-up for the staff realm. With them on:

- argon2id through `node:crypto` (@fin/crypto: m = 19,456 KiB, t = 2, p = 1, a 32-byte tag, PHC
  strings), two hashes per vCPU at once and a short queue, past which `503 unavailable` with
  `Retry-After`; never more hashes than libuv's thread pool (`UV_THREADPOOL_SIZE`, read with the
  realm's settings) less two threads. A request that may hash (a password sign-in, reset or
  change, a sign-up with a password) is admitted before its unit of work opens and holds its
  client until the unit ends, also while it waits on another admitted request's rows, so the
  admitted ones (the slots plus the queue) never hold the database pool's last two clients and
  the rest are answered 503 at once (`hashSlots()` and `admit()` in `passwords/hasher.ts`, one
  hasher per process, passed as `RealmDeps.passwords` or made by the factory from the settings and
  the pool). A hash for a request that was not admitted fails closed, and no admitted request
  holds across its hash a row that requests never admitted wait on (a sign-up hashes before it
  takes its limits; the residuals are in `passwords/hasher.ts`);
- 12 to 128 characters and not common (`passwords/policy.ts`, which compares a password with the
  list NFKC-folded, lower-cased and without white space or invisible characters, and keeps it as
  typed); `src/common-passwords.ts` is generated by `scripts/common-passwords.mjs` from two pinned
  public lists, and `--check` proves it;
- `/sign-in/email` takes the address's password turn (`codes.ts`) without waiting, so it and a
  reset of the address take turns, and a sign-in that finds another of the address under way is
  answered 503 at once; it makes an `aal1` session that never proves the mailbox; a person with a
  factor is at the factor step in that session (the library's own challenge cookie is never set);
- wrong passwords from browsers the account does not know pause the address
  (`passwords/pause.ts`), kept in `ops.lockout` under the address's generation, alike for every
  address;
- reset by an emailed code (`/email-otp/request-password-reset`, `/email-otp/reset-password`),
  under §5.2's code rules with its own purpose, working only in the browser that asked; it waits
  for the address's password turn before its network's limit, takes the authenticator lockout
  before the sessions (as every factor code does, holding the lockout row from its before-hook),
  ends every session itself (one `session.ended` for each session its delete returned), forgets the
  known browsers but its own, revokes trusted browsers, lifts the lockouts and moves the address to
  its next generation; `resetCodeLink()` is the core of the console's
  `POST /api/reset-password/code-link`;
- `/change-password` takes the `account.password_change` intent;
- on the two-factor paths, where the library would ask a person with a password for it, Fin's own
  step-up stands in (`waivePasswordRecheck` in `passwords/flows.ts`).

## Layout

| Path | What |
|---|---|
| `src/realm.ts` | `createRealm()` and the library options per realm (§3.3, §3.4) |
| `src/endpoint-policy.ts` | the allowlist per realm (§4); its set test is T-SAT-01 |
| `src/hooks/` | `hooks.before`, `hooks.after` and `databaseHooks` (§3.5) |
| `src/gate.ts`, `src/step-up/` | the gate (§6) and intents, windows and the digest (§7) |
| `src/codes.ts`, `src/browsers.ts`, `src/limits.ts` | emailed codes, known and trusted browsers, limits |
| `src/passwords/`, `src/common-passwords.ts`, `scripts/` | passwords (stretch 2): hashing, the rule and its list, the pause, the flows |
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
