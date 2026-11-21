# Runbook: rotate the email token (staging)

The email token (CR-08) lets `worker` send through Cloudflare Email Sending. It expires after 180
days at most and is IP-filtered to `worker`'s static egress (spec 01 §7.8, §9.3). Rotate before it
expires (the inventory's warning), when `worker`'s egress addresses change, and at once if the value
was exposed.

1. `node ops/fin/src/main.ts email token staging --rotate --dry-run`: the plan shows the new token,
   the variables on `worker`, and the old token's revocation last.
2. `node ops/fin/src/main.ts email token staging --rotate`: mints the new token with the current
   egress addresses, sets it sealed as `FIN_EMAIL_TOKEN` on `worker` (Railway redeploys it), then
   revokes the old token. If the run stops before the revocation, the old token still works and the
   new one is already in place: re-run the revocation by running the command again with `--rotate`.
   If the run stops after the mint but before the new token is set on `worker`, a plain re-run
   (without `--rotate`) sees it in the run log and replaces that token: its value is lost, so it is
   minted again, set, and the orphan revoked.
3. Check: the next `email-delivery-check` reaches the seed inbox; `email.send_failed` lines stop.
4. Update `ops/credentials.json`'s `email-token` row with the new dates.

If the value leaked, revoke the old token in Cloudflare first (sends fail until step 2 finishes),
then run step 2.
