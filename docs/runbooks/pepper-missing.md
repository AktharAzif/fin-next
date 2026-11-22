# A key names a pepper the edge does not hold

Alert: `pepper-missing`.

## What it means

A key's stored hash is bound to a chain of peppers (`pepper_versions`, spec 05 §4.2), and the edge
holds the peppers as `API_KEY_PEPPER_<n>`. A `key.pepper_missing` line says a key named a pepper
the edge does not hold: the edge refuses that key with the same 401 as any refused key (`keyReason`
`pepper_missing` on the `request` line), so a developer's working key stops working. `keyId` on
the line names the key.

The usual cause is a pepper rotation done out of order (spec 08 §6.4's `api-key-pepper`): the
console and the worker hold a newer pepper the edge was not given, or a pepper was removed from
the edge before `keys.rehash` had moved every key off it.

## First check

1. Which `API_KEY_PEPPER_<n>` and `API_KEY_PEPPER_IN_USE` the edge holds against the console and
   the worker: compare the variable names only, never read or print a value.
2. The `keyId`s on the lines: one key, or every key made or re-hashed since a change.
3. The last release and the last change to the edge's variables.

## Containment

1. Give the edge the pepper it lacks, the same value the console and the worker hold, and redeploy
   the edge; the refused keys verify again at once.
2. A pepper removed too early: put it back on the edge, and remove it only once
   `keys-not-rehashed` is clear.
3. Never revoke the refused keys or change their stored hashes to clear the alert.

## When to wake the owner

At once: working keys are refused, and restoring a pepper is a secret only the owner sets.
