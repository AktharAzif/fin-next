# Page-policy violation reports above their volume

Alert: `csp-reports` (notify only, above an hourly volume).

## What it means

The API halves' `/api/monitoring/csp` relays wrote more `csp.report` lines than the threshold in
an hour. A page broke its own Content-Security-Policy (a release added an inline style or a new
origin), or something is injecting script or frames. Reports are untrusted input, so the volume
alone never pages.

## First check

1. The `directive`, `blockedOrigin` and `app` on the lines, grouped by release.
2. Did the volume start with a release? Then it is almost certainly Fin's own page.

## Containment

1. Fin's own page: fix it in a reviewed change; never loosen the policy profile by hand.
2. An unknown blocked origin across many sessions: treat it as an injection attempt, check the
   static deployment (`static-deployment-changed`) and the watcher's last runs.

## When to wake the owner

If the blocked origin is not one Fin uses and the static deployment check also failed. A
release's own violations can wait for working hours.
