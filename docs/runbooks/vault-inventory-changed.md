# A locked vault object changed

Alert: `vault-inventory-changed` (the watcher's `vault` check, which joins the watcher with the
vault inventory token of CR-18).

## What it means

An object in a staging vault bucket (audit heads, run registrations, escrow, backups) was removed
or changed before its lock ended. The locks are what make those records trustworthy; a change
means the bucket's lock rules changed or someone with more than a writer token acted.

## First check

1. R2's bucket settings: lock rules and lifecycle rules for the bucket in the `target`.
2. The vault account's members and recent API tokens.

## Containment

1. Restore the lock rule through a registered run; never delete objects to make the inventory
   match.
2. Revoke any token that could administer the buckets and was not expected to exist.
3. Record which objects changed; the escrow and audit copies elsewhere decide what is lost.

## When to wake the owner

At once, always.
