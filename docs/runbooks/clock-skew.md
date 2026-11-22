# A process's clock disagrees with the database

Alert: `clock-skew`.

## What it means

A process's `process.health` line reports `clockSkewMs` (its clock against the database's
`now()`) above the threshold. Codes, sessions, signed calls and audit timestamps all depend on
agreeing clocks, so a large skew can refuse good requests or accept stale ones.

## First check

1. Which replicas skew: one replica points at its host, all of them at the database host or
   Railway's time service.
2. Railway's status page.

## Containment

1. One replica: redeploy the service so it lands on another host (`pnpm fin deploy staging`).
2. All services: raise it with Railway; signed calls outside their window will be refused
   (`caller-signature-invalid`), which fails closed.

## When to wake the owner

If the skew exceeds the signed-call window (callers start failing) or persists for more than 30
minutes. A brief skew that clears can wait.
