# The database is unreachable or its pools are full

Alerts: `database-unreachable`, `pool-exhausted`.

## What it means

- `database-unreachable`: services report `database.pool_error`, or `dbOk` false on their
  `process.health` lines, for 2 minutes: Postgres is down for Fin, or the services' logins fail.
- `pool-exhausted`: requests wait for a database connection (`poolWaiting` above the threshold)
  for 5 minutes: long transactions hold connections, or pools are too small for the load.

## First check

1. Railway's Postgres state and metrics; whether one service or all report it (one service points
   at its login or grants, all at Postgres).
2. For pool waits: the probe's `longest_tx_s` and connection count by role.

## Containment

1. Postgres down: follow Railway's status; nothing to change at Fin's side. Post on the status
   page if the API is affected.
2. One service's login refused: check `grants-drift` and the service's `FIN_DB_USER`; a rotation
   half done (`rotate-db-login`) is the usual cause.
3. A long transaction: identify the holder in `pg_stat_activity` through a registered task and end
   it; fix the cause in a reviewed change.

## When to wake the owner

If Postgres is down for more than 10 minutes, or pools stay exhausted after the holder ended.
