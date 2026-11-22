# Lines were lost on the way to Better Stack

Alert: `telemetry-gaps`.

## What it means

A process's transport recovered after failing to ship, and its `telemetry.recovered` line reports
lines lost (`linesLost` above zero) or a 402 among the failed statuses (a spending cap or quota
stopped ingest). Better Stack's record has a gap for that service; Railway's stdout copy may still
hold the lines (it is capped and has lost lines before).

## First check

1. The `statuses` on the line: 402 is the quota, 401 or 403 the token, 429 a rate limit, 5xx
   Better Stack's side.
2. Better Stack's usage page for the team, and its status page.

## Containment

1. A 402: raise or remove the spending cap so it cannot stop ingest (spec 01 §8.1), then confirm
   new lines arrive.
2. A token error: rotate the source token (`rotate-betterstack`) and deploy the service.
3. Note the gap's window in the incident, so triage does not read the gap as quiet.

## When to wake the owner

If ingest is stopped by a cap (402) or a token error for a security-relevant source (watcher,
connector, edge). Short 5xx gaps that recovered can wait.
