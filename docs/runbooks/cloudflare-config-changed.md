# Cloudflare configuration changed outside a run

Alert: `cloudflare-config-changed` (the watcher's `rules`, `zone` and `access` checks).

## What it means

A rule set's hash no longer equals the last registered `pnpm fin rules apply` (the ingress-proof
transforms, the redirect, the WAF rules, the rate rule, the configuration and cache rules), a zone
setting differs from spec 01 §7.6, or the Fin Admin Access application or its policy changed
(session, binding cookie, cookie flags, MFA, or the policy's hash). The `target` names the phase,
the setting or `access`; the `detail` the difference (`ruleset_hash_mismatch`,
`ruleset_unexpected`, `hash_unset`, `setting_missing`, `setting_mismatch`, `universal_ssl_off`,
`bot_fight_on`, `app_missing`, `app_domain`, `app_type`, `session_duration`, `binding_cookie`,
`http_only`, `same_site`, `launcher_visible`, `mfa_not_required`, `policy_missing`,
`policy_hash_mismatch`, `policy_everyone`, `api_error`, `api_forbidden`).

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
   off): revoke every Access session (`pnpm fin access revoke-sessions staging`) and review the
   staff audit log for the window.
3. Revoke the token or session of whoever made an unregistered change.

## When to wake the owner

At once for an Access change that widens access or turns MFA off, or an ingress-proof transform
change outside a run. A `hash_unset` right after a registered rules run is not an incident: fix it
by redeploying the watcher.
