# GitHub settings changed

Alert: `github-settings-changed` (`pnpm fin github verify` ended with `run.done` `result=drift`).

## What it means

The repository's settings, the ruleset on `main`, or an environment (`staging`,
`staging-static`) differ from spec 01 §3.2 to §3.4. A weakened ruleset or environment lets
unreviewed code reach `main` or a deploy job.

## First check

1. The verify run's output (the setting names that differ, never values).
2. The owner's GitHub security log for who changed it and when.

## Containment

1. Restore the setting through the owner (control paths and repository settings are the owner's).
2. Re-review any merge or deploy since the change.

## When to wake the owner

Always: only the owner can restore repository settings. At once if the ruleset or an environment's
reviewers changed.
