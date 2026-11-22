# A call outside the door matrix, or with a bad signature

Alerts: `outside-request` (`api.outside_request`) and `caller-signature-invalid`
(`caller.signature_invalid`).

## What it means

`api` or `payments` received a call for an operation the door matrix does not allow for the
caller, or a signed call whose signature failed (forged, stale, replayed, or for another
audience). Both were refused. Either a caller has a bug, a caller-key rotation is half done, or
something is probing the private services.

## First check

1. The `caller`, `route` and `operation` on the line.
2. Was a caller-key rotation running (`rotate-caller-keys`)? Callees accept `n+1` before callers
   sign with it; a wrong order produces these lines.
3. Did the last release add a call without its door matrix row?

## Containment

1. A rotation in the wrong order: put the old key back on the caller until every callee accepts
   the new one.
2. A missing matrix row: roll back the release; add the row through a reviewed change.
3. An unknown caller: treat its key as leaked and rotate with `--emergency`.

## When to wake the owner

At once if the caller is unknown or signatures fail with no rotation running. A matrix gap from a
release can wait for the rollback.
