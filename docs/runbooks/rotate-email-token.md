# Runbook: rotate the email token (staging)

The email token (CR-08) lets `worker` send through Cloudflare Email Sending. It expires after 180
days at most and is IP-filtered to `worker`'s static egress (spec 01 §7.8, §9.3). Rotate before it
expires (the inventory's warning), when `worker`'s egress addresses change, and at once if the value
was exposed.

1. `node ops/fin/src/main.ts email token staging --rotate --dry-run`: the plan shows the new token,
   the variables on `worker`, `~ update redeploy worker [FIN_EMAIL_TOKEN]` when `worker` has a
   deployment that may hold a token (its variables name `FIN_EMAIL_TOKEN`, or Cloudflare still
   lists an old one), and the old token's revocation last.
2. `node ops/fin/src/main.ts email token staging --rotate`: mints the new token with the current
   egress addresses and sets it sealed as `FIN_EMAIL_TOKEN` on `worker`, in a commit that starts no
   deployment, read back until it shows. Then it redeploys `worker` as a step of its own (the
   rotation, `pnpm-fin.md`: a `run.step` `redeploy worker` and a `rotation.redeployed` line), waits
   for `SUCCESS`, reads back again, and only then revokes the old token (ARCHITECTURE §4.9:
   Railway, then verify, then revoke). A `worker` with no deployment holds no token: nothing is
   deployed, and the old token is revoked once the write shows. Whether `worker` holds a token is
   read from `worker`, not from Cloudflare's list, so a token already revoked at Cloudflare still
   gets its redeploy.
   - If the redeploy or a read-back fails, the output says the rotation is not done: the old token
     still works and is not revoked, and the new one is set. Fix the cause, then run the command
     again with `--rotate` (it mints once more, redeploys, and revokes both older tokens).
   - If the run stops after the mint but before the new token is set on `worker`, a plain re-run
     (without `--rotate`) sees it in the run log and replaces that token: its value is lost, so it
     is minted again, set, `worker` redeployed, and the orphan revoked.
   - If `worker` is set to an image its newest deployment does not run, the redeploy is refused
     (it would roll that image): run `railway deploy` for the release staging runs first. When
     that deployment did not end `SUCCESS` (a `railway deploy` that failed at `worker`), or
     Railway does not say which image it runs (SP-03), the redeploy goes on only if `worker` is
     set to the digest the registered deploys recorded for it, and is refused otherwise, the same
     way. A `worker` whose newest deployment is `REMOVED` (taken down) holds no token: nothing is
     deployed, and the old token is revoked once the write shows.
3. Check: the next `email-delivery-check` reaches the seed inbox; `email.send_failed` lines stop.
4. Update `ops/credentials.json`'s `email-token` row with the new dates.

If the value leaked, revoke the old token in Cloudflare first (sends fail until step 2 has
redeployed `worker`), then run step 2. Cloudflare then lists no old token, but `worker`'s variables
still name `FIN_EMAIL_TOKEN`, so step 2 redeploys `worker` all the same.
