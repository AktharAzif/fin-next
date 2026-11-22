# Runbook: `pnpm fin email domains <env>` and `pnpm fin email token <env>`

Cloudflare Email Sending for staging (spec 01 §7.8; R3; [EM-05], [EM-06], [EM-08]).

## `email domains`

1. Onboards the `auth.` and `notify.` sending subdomains (from the overlay's `emailSubdomains`) with
   `POST /zones/<zone>/email/sending/subdomains`, then sets `preview_enabled: false` and
   `drop_suppressed_recipients: false` on each with `PATCH .../subdomains/<tag>`.
2. Sets each subdomain's own DMARC record (`_dmarc.auth`, `_dmarc.notify`, from the overlay's
   `dmarc.records`) to `v=DMARC1; p=<policy>; rua=<dmarc.rua>`, with the overlay's policy (`p=none`).
   Without `dmarc.rua` (the aggregate report address) in the overlay, the DMARC changes are held and
   the records stay as Email Sending wrote them (`p=reject`, which is stricter).
3. Never writes the zone's own `_dmarc` (the guard refuses it whatever the overlay says) and never
   removes a sending domain.

```sh
export FIN_OVERLAY_FILE=<overlay> FIN_CF_TOKEN_FILE=<operator token file>
node ops/fin/src/main.ts email domains staging --dry-run
node ops/fin/src/main.ts email domains staging
```

## `email token`

Mints the account-owned token `fin-next-<env>-email` (CR-08) and sets it on `worker`:

- one permission group (Email Sending Write), on this account only;
- a client IP filter to `worker`'s static egress addresses (the overlay's `staticEgress.worker`, or
  read back from Railway when the overlay does not list `worker`); it is never minted without the
  filter. The writer ties the filter to the token's own service (the settings' `email.token.service`)
  and refuses an entry that is not one IPv4 address (`/32`) or, when the overlay lists
  `staticEgress.worker`, one that is not among `worker`'s addresses: another service's address (an
  `api` or connector address the overlay also lists) never passes. When the addresses are read back
  from Railway, single addresses pass the writer, and the command sends exactly the ones Railway
  answered;
- the permission group's ID is the one read from the account under that name;
- an expiry of 180 days (the settings refuse more, and the writer refuses a mint that would outlive
  180 days);
- set as `worker`'s sealed `FIN_EMAIL_TOKEN`, with the plain `FIN_EMAIL_ACCOUNT_ID` and
  `FIN_EMAIL_FROM` (`account-security@<auth subdomain>`), in a commit that starts no deployment,
  read back until it shows (`pnpm-fin.md`). The value is never printed. A first token is
  provisioning: `worker` takes it at its next deployment (`railway deploy`).

An existing token of that name is kept, unless it cannot be the one `worker` holds:

- a token that is no longer active (expired or disabled);
- a token that the last run of this command minted but never set on `worker` (the Railway write
  failed after the mint). Cloudflare shows a token's value only when it mints it, so that value is
  lost; the run log shows the run's `token create` step with no `variables` step after it.

Then the plan says why (`replaces it: ...`) and does what `--rotate` does: mints a new token, sets
it, redeploys `worker` when it has a deployment (it holds the old token), waits for `SUCCESS`, reads
back, and only then revokes the old ones. `--rotate` does the same on demand (see
`rotate-email-token.md`). Revocations are named by ordinal (`fin-next-<env>-email #1`), never by any
part of a token's ID.

```sh
export FIN_OVERLAY_FILE=<overlay> FIN_CF_TOKEN_FILE=<operator token file> FIN_RAILWAY_TOKEN_FILE=<railway token file>
node ops/fin/src/main.ts email token staging --dry-run
node ops/fin/src/main.ts email token staging
```

## Check it

- Both subdomains show preview and drop-suppressed off (the watcher's `email` check).
- The delivery check (`email-delivery-check`) reaches the seed inbox with DKIM, SPF and DMARC
  passing (AC-P0-10).
- A send with the token from any address outside `worker`'s egress is refused (S-03).
