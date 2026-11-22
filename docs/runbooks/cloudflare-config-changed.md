# Cloudflare configuration changed outside a run

Alert: `cloudflare-config-changed` (the watcher's `rules`, `zone` and `access` checks).

## What it means

In a phase `rules apply` writes, the hash of fin-next's own rules (refs starting `fin_next_`: the
ingress-proof transforms, the response header rule, the redirect, the WAF rules, the rate rule,
the configuration and cache rules, the Free Managed Ruleset's rule) no longer equals the last
registered `pnpm fin rules apply`; a `fin_next_` rule appeared in a phase no registered run hashes
(`ruleset_unexpected`); a rule of another product names a fin-next host (`foreign_rule`); a zone
setting differs from spec 01 §7.6; the Fin Admin Access application or its policy changed
(session, binding cookie, cookie flags, MFA, or the policy's hash); or another Access application
covers the admin host or a path under it (`app_overlap`, target `admin`), which takes that path
over from Fin Admin's. The old product's own rules on the shared zone are not hashed, so its
changes do not raise this. The `target` names the phase, the setting, the application or the
host role; the `detail` the difference (`ruleset_hash_mismatch`, `ruleset_unexpected`,
`foreign_rule`, `hash_unset`, `setting_missing`, `setting_mismatch`, `universal_ssl_off`,
`bot_fight_on`, `app_missing`, `app_duplicate`, `app_overlap`, `app_domain`, `app_type`,
`session_duration`, `binding_cookie`, `http_only`, `same_site`, `launcher_visible`,
`mfa_not_required`, `policy_missing`, `policy_hash_mismatch`, `policy_everyone`, `api_error`,
`api_forbidden`). Each check, target and detail is an incident of its own, so a `hash_unset` or
`ruleset_hash_mismatch` that stands never hides a later `foreign_rule` or Access change: read
every open incident of this alert, not only the first.

## First check

1. Was a registered `pnpm fin rules apply` or `pnpm fin access apply` run just now? The watcher
   compares with the hashes it was deployed with, so after a registered rules run the watcher's
   settings must be redeployed (`pnpm fin watcher deploy staging`); `hash_unset` means that was
   never done.
2. Read Cloudflare's account audit log for the change and its author.

## Containment

1. Re-apply the reviewed state: `pnpm fin rules apply staging` or `pnpm fin access apply staging`,
   then redeploy the watcher's settings so its hashes match the new registered run.
2. An Access change that widened who can reach Fin Admin (`policy_everyone`, a new include, MFA
   off, an overlapping application): delete an overlapping application by hand after reading it
   (it is not fin-next's to re-apply), revoke every Access session (`pnpm fin access
   revoke-sessions staging`) and review the staff audit log for the window.
3. Revoke the token or session of whoever made an unregistered change.

## When to wake the owner

At once for an Access change that widens access or turns MFA off, an overlapping Access
application, a `foreign_rule`, or an ingress-proof transform change outside a run. A `hash_unset`
right after a registered rules run is not an incident: fix it by redeploying the watcher.
