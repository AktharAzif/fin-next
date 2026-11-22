# Runbook: rotate the static deploy token (staging)

The static deploy token (CR-20) can replace every staging page, so it is an interception credential
like a tunnel token ([FD-19], [FD-12]). It holds Workers Scripts Write on the staging account and
nothing else, lives only in the `staging-static` GitHub environment, and expires after 90 days. It
is minted when `staging-static` is created (after the owner is back); it never reaches the operator
machine and is never typed at the secure prompt. Until then, and whenever CI cannot run, the
operator machine uploads with a one-run token `pnpm fin static deploy` mints with CR-05 and revokes
after the run (`static-deploy.md`), so there is nothing to rotate on the operator machine.

Rotate before it expires, and at once if it may have leaked or a `static-deployment-changed` alert
shows an upload outside a deploy.

1. In Cloudflare, create an account-owned token with Workers Scripts Write on the staging account
   only, a 90-day expiry, named `fin-next-staging-static`.
2. Replace the `staging-static` environment secret `CF_STATIC_DEPLOY_TOKEN` (the owner's account).
3. Prove it: the next approved static deploy uploads, and the watcher's `static` check stays green.
   (A `--dry-run` does not use CR-20 and proves nothing about it.)
4. Delete the old token in Cloudflare.
5. Update `ops/credentials.json`'s `static-deploy-token` row.

If it leaked: delete it first; then check every static deployment with the watcher's `static` check
(a deployment whose asset manifest matches neither this release nor the previous one raises
`static-deployment-changed`); re-upload the last attested release (`static-deploy.md`, render and
upload, with the one-run token if CI cannot run); wake the owner.
