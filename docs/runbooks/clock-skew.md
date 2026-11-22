# A process's clock disagrees with the database

Alert: `clock-skew`.

## What it means

A process's `process.health` line reports `clockSkewMs` whose absolute value is above
`@thresholds.clock-skew` (the overlay's value, in milliseconds). Each minute the service's health
hook runs `SELECT clock_timestamp()` on a client of its own pool and compares the answer with its
own clock, read either side of the query and corrected by half the round trip. The value is the
process's clock less the database's: above zero when the process is ahead, below zero when it is
behind. It is `clock_timestamp()`, the moment the database evaluates the query, never `now()`, the
start of a transaction. Today the worker, the console and admin write it.

Codes, sessions, signed calls and audit timestamps all depend on agreeing clocks, so a large skew
can refuse good requests or accept stale ones.

## First check

1. Which replicas skew, and with which sign: one replica points at its host, every replica of
   every service at the database host or Railway's time service.
2. Whether the same replicas report `dbOk` false or slow database requests: a very slow round trip
   widens the measurement's error, and `clockSkewMs` is null when the query fails (that is
   `database-unreachable`, not this alert).
3. Railway's status page.

## Containment

1. One replica: redeploy the service so it lands on another host (`pnpm fin deploy staging`).
2. All services: raise it with Railway; signed calls outside their window will be refused
   (`caller-signature-invalid`), which fails closed.

## When to wake the owner

If the skew exceeds the signed-call window (callers start failing) or persists for more than 30
minutes. A brief skew that clears can wait.
