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
  read back from Railway); it is never minted without the filter;
- an expiry of 180 days (the settings refuse more);
- set as `worker`'s sealed `FIN_EMAIL_TOKEN`, with the plain `FIN_EMAIL_ACCOUNT_ID` and
  `FIN_EMAIL_FROM` (`account-security@<auth subdomain>`). The value is never printed.

An existing token of that name is kept. `--rotate` mints a new one, sets it, and only then revokes
the old one (see `rotate-email-token.md`).

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
