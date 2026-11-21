# Runbook: rotate the static deploy token (staging)

The static deploy token (CR-20) can replace every staging page, so it is an interception credential
like a tunnel token ([FD-19], [FD-12]). It holds Workers Scripts Write on the staging account and
nothing else, lives only in the `staging-static` GitHub environment (and, while staging deploys run
from the operator machine, as a file named by `FIN_CF_STATIC_TOKEN_FILE`), and expires after 90
days. Rotate before it expires, and at once if it may have leaked or a `static-deployment-changed`
alert shows an upload outside a deploy.

1. In Cloudflare, create an account-owned token with Workers Scripts Write on the staging account
   only, a 90-day expiry, named `fin-next-staging-static`.
2. Replace the `staging-static` environment secret `CF_STATIC_DEPLOY_TOKEN` (the owner's account),
   and the operator's token file if there is one (`chmod 600`).
3. Prove it: `node ops/fin/src/main.ts static deploy staging ... --dry-run` reads, and the next
   approved static deploy uploads.
4. Delete the old token in Cloudflare.
5. Update `ops/credentials.json`'s `static-deploy-token` row.

If it leaked: delete it first, then compare every static deployment with the release manifest (the
watcher's `static` check, or a `--dry-run` of the last release) and re-upload the last attested
release; wake the owner.
