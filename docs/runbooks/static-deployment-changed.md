# A static deployment or a Workers route changed

Alert: `static-deployment-changed` (the watcher's `routes` and `static` checks).

## What it means

The front door no longer matches spec 01 §7.4 and §7.5. Either the Workers routes on fin-next's
hosts differ from the exact list (a route added, removed, or pointing at another Worker, a Worker
attached to an `/api/*` route, or any other route, a wildcard included, that reaches a fin-next
host), or a static deployment is no longer assets only: it gained a script module, a fetch
handler, a binding, a cron schedule, a custom domain, a tail consumer, a `workers.dev` address or
a preview URL, or its compatibility date moved; or it serves a version its last registered upload
did not read back (target `<deployment>/version`: someone uploaded to it outside a registered
deploy, even a single throwaway file); or a `fin-next-` Worker that is neither a static deployment
nor the watcher appeared; or some Worker, the old product's included, is bound to a custom domain
on a fin-next host. Any of these can put code or other content in front of a sign-in page. The
`detail` names it (`route_missing`, `route_duplicate`, `route_unexpected`, `route_wrong_script`,
`has_modules`, `no_assets`, `has_handlers`, `has_bindings`, `has_schedules`, `has_custom_domain`,
`has_tail_consumers`, `workers_dev_on`, `previews_on`, `compatibility_date`,
`deployment_missing`, `version_changed`, `version_split`, `version_unknown`, `version_unset`,
`unexpected_script`, `custom_domain_on_host`, `api_error`, `api_forbidden`). The old product's
own Workers and routes on its own hosts are not reported.

## First check

1. Is a `deploy-static-staging` job or a registered `pnpm fin routes apply` running? A deploy
   rewrites the deployment's assets but never its shape, so a shape change is never expected. A
   `version_changed` right after a registered static deploy, before the watcher was redeployed
   with the new versions, is that deploy: redeploy the watcher (`pnpm fin watcher deploy
   staging`). `version_unset` means no registered static deploy has recorded the version yet.
2. Read Cloudflare's audit log for the deployment or route, and who changed it.

## Containment

1. Remove any route or Worker the release does not name: `pnpm fin routes apply staging`.
2. Re-upload the release's attested artefact by re-running the approved `deploy-static-staging`
   job for the current release.
3. Revoke and re-mint the static deploy token (CR-20), since it can upload a script.
4. Treat every credential typed into a changed page in the window as disclosed: end the affected
   sessions and note it in the incident.

## When to wake the owner

At once for any script, binding, handler, route, custom domain or version change outside a
registered run. A `deployment_missing` during the first upload of a new deployment, and a
`version_changed` explained by a registered deploy, can wait.
