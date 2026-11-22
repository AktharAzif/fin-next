# Step-up refusals and locks

Alerts: `step-up-failing` (notify only: `step_up.refused` with `reason` `digest` above
`@thresholds.step-up-failing` in 15 minutes, per service) and `step-up-locked` (notify only:
`step_up.locked` above `@thresholds.step-up-locked` in 15 minutes, per service).

## What it means

A credential, member, role or money action needs a step-up intent bound to the action and to the
request's fields (spec 02 §7). The server checks the intent again when the action runs.

- `step-up-failing`: intents refused with `reason: digest`, the request's bound fields not matching
  the digest the intent was made for. A few are a person changing a form after stepping up; many
  mean the client and the server bind different fields for an action (the route policy's `bind`
  list against what the page sends), so the action fails for everyone. A 5xx on the step-up
  ceremonies themselves is `5xx-rate-<service>`, `5xx-count-<service>` or the factor paths'
  `second-factor-step-failing`.
- `step-up-locked`: sessions ended by the fifth failed step-up (spec 02 §7.7). Many mean someone
  is guessing a factor inside sessions that are not theirs.

## First check

1. `step-up-failing`: the `realm` and `action` on the lines, and whether the count began with a
   release of the pages or of the API half. Compare the action's `bind` list in the route policy
   with the fields the page sends.
2. `step-up-locked`: the `realm` on the lines, then the people of those sessions from the audit
   log's step-up lock events (the `requestId`s lead to them). Many people at once, or one person
   many times, from browsers they do not use?

## Containment

1. A bind mismatch from a release: roll the pages or the service back (`static-deploy.md`,
   `railway-deploy.md`), then make the two sides agree in a reviewed change.
2. Locks that look like guessing: the sessions are already ended; revoke the person's other
   sessions and ask them to reset the factor if they did not make the attempts.
3. Close it when the count falls below the threshold; the incident recovers 15 minutes later.

## When to wake the owner

If locks come from many people at once, a staff session (`realm: staff`) was locked, or an action
stays refused for everyone after the rollback.
