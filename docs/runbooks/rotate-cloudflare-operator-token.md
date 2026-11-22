# Runbook: replace the Cloudflare operator token (staging)

The operator token (CR-05) is what `pnpm fin` uses for every Cloudflare change. It lives only as a
file on the operator's machine, readable by its owner only, named by `FIN_CF_TOKEN_FILE` per run;
it is never stored by Fin, never in CI, and never printed ([SA-22], spec 01 §7.10).

Its scope is ARCHITECTURE §5.12's list: Zone DNS, Zone Settings, the rule sets, Cloudflare Tunnel
Edit, Access apps and policies Edit, Email Sending, Workers Scripts Edit, Workers Routes Edit and
Account API Tokens (to mint the email, watcher and static-deploy tokens), with a short expiry. A
token broader than that is replaced by one that is not.

1. In Cloudflare, create an account-owned token with exactly that scope on the staging account, a
   short expiry, and the operator's address as a client IP filter where practical.
2. Write it to a new file (`chmod 600`), point `FIN_CF_TOKEN_FILE` at it, and run
   `node ops/fin/src/main.ts zone apply staging --dry-run` to prove it reads.
3. Delete the old token in Cloudflare, then delete its file.
4. Update `ops/credentials.json`'s `cloudflare-operator-token` row with the new expiry.

If the token leaked: delete it in Cloudflare first, then check the account's audit log for changes
outside a registered `pnpm fin` run, and wake the owner.
