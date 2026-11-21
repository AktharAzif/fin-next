# Runbook: `pnpm fin access apply <env>`

Builds Fin Admin's outer door (spec 01 §7.7; ARCHITECTURE §5.10; [FD-05]; EXECUTION §2.5 step 9):
one self-hosted Access application over the whole staff host, and one Allow policy. Nobody builds
either by hand.

## What it writes

- **The policy** `fin-next-<env>-staff`: decision allow; include exactly the overlay's
  `access.staff` addresses and its `access.allowDomains` email domains (the owner's staging decision
  of 21 Nov: the company domain with One-time PIN); no exclude, no require; never "Everyone".
- **The application** `fin-next-<env>-admin`: self-hosted on the staff host with no path (the whole
  host: the static files and `/api/` alike); session 8 hours; binding cookie on; HTTP-only cookie;
  `SameSite=Lax`; not in the App Launcher; only the account's One-time PIN login method; the policy
  above.

It never creates a login method: on an account another product shares, a new one would also appear
on that product's applications. If the account has no One-time PIN method (or more than one), the
command stops; the owner sets it in Zero Trust (CR-07). It also refuses when another application
already covers the staff host. Access's independent MFA is set by the owner in Zero Trust (CR-07).

## Staff changes

Adding someone: add the address to the overlay's `access.staff`, run this command (the plan shows
`~ update access-policy ... [include]`), then add them in Fin Admin. Removing someone: remove them in
Fin Admin first (their sessions end), then from the overlay, then run this command, then revoke their
Access sessions in Zero Trust ([SA-39]).

## Run it

```sh
export FIN_OVERLAY_FILE=<overlay> FIN_CF_TOKEN_FILE=<operator token file>
node ops/fin/src/main.ts access apply staging --dry-run
node ops/fin/src/main.ts access apply staging
```

## Check it

- `curl -sI https://<staff host>/` and `https://<staff host>/api/health` both answer 302 to the Access
  sign-in.
- The application's audience tag is printed masked as `<access-aud>`; the admin service and its
  connector read it from their settings (`FIN_ACCESS_AUD`).
