# A request came from an untrusted peer

Alert: `ingress-untrusted-peer`.

## What it means

A web or API service received a request that did not come from one of its connector peers, or
came without the host's current ingress proof (`ingress.untrusted_peer`). It was refused with 403.
Something on Railway's private network called a service directly, or the ingress proofs and the
transform rules disagree.

## First check

1. The `reason` on the line: a peer address that is not a connector, or a missing or wrong proof.
2. Was an ingress-proof rotation half done (`rotate-ingress-proof`)? Then the rule and the
   services disagree for a moment.
3. Which service called: a redeploy that reused an address, or something that should not be there.

## Containment

1. A half-done rotation: finish it in order (services accept both values before the rule moves).
2. An unknown caller: find the calling service in Railway and stop it; check `privileged-login`
   and Railway's audit log for who deployed it.
3. If proofs may have leaked, rotate them with `--emergency`.

## When to wake the owner

At once if the caller is not a known Fin service, or the lines keep coming after a rotation
finished.
