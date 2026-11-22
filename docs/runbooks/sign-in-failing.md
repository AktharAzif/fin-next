# Sign-in or the second factor is failing

Alerts: `sign-in-failing` and `second-factor-step-failing` (each pages on any
`auth.unhandled_error` line on its paths, one incident per service).

## What it means

The auth library answered 500 for an error no refusal names, and the realm wrote
`auth.unhandled_error` with its `authPath` and an `errorId` (beside `error.unexpected` with the same
`errorId`). The two alerts split the lines by `authPath`:

- `second-factor-step-failing`: the factor-step and enrolment paths (`/two-factor/*` and the
  passkey authenticate and register paths). People may not finish their second factor or add one.
- `sign-in-failing`: every other path, a line without an `authPath` included: the sign-in, code
  and session paths. People may not be able to sign in at all.

The host's own `request` line for `/api/auth/*` names no path, so a 5xx anywhere on the service is
also `5xx-rate-<service>` and `5xx-count-<service>`. A limiter that cannot reach its store is
`rate-limiter-failing`, a key no version opens `secret-unreadable`, and a refused commit
`audit-guard`; each has its own line and runbook.

## First check

1. The `service`, `realm`, `authPath` and `release` on the lines, and when they began.
2. The `errorId` in the service's Errors application: the error's name and where it was thrown.
3. Did a release of the API half, or of the auth library, go out just before? Is the database
   healthy (`database-unreachable`, `pool-exhausted`)?

## Containment

1. A release that brought it: roll the service back (`railway-deploy.md`).
2. The database: follow `database.md`.
3. Then fix the error in a reviewed change, with the test that reproduces it. Close it when no new
   line comes; the incident recovers 15 minutes after the last one.

## When to wake the owner

At once if people cannot sign in or finish their second factor for more than 10 minutes, or the
error names a secret, a session or a factor store.
