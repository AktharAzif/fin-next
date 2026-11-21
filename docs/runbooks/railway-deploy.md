# Runbook: `pnpm fin railway verify <env>` and `pnpm fin railway deploy <env>`

Railway staging is provisioned once by hand against spec 01 §6's checklist ([P-13]); these two
commands check it and deploy releases to it (spec 01 §6.8, §6.9; ARCHITECTURE §11.8). Both need
`FIN_OVERLAY_FILE` and `FIN_RAILWAY_TOKEN_FILE` (the staging project token, CR-04).

## `railway verify`

Read-only, registers no run. For every service of `ops/environments/staging.json` it reports drift
(`!`), and lists what it could not read (`?`), which never counts as passing:

- exists in the environment; no public domain and no TCP proxy (NB-07);
- region, replicas, restart policy; app sleeping off; outbound IPv6 off;
- the health check (`/readyz`, 60 s), overlap and draining, start command and cron;
- the image is set by digest from `ghcr.io/aktharazif/`, is the service's own image, and is the
  digest the last registered `railway deploy` recorded;
- no secret-named variable (spec 01 §6.7) is readable: every one is sealed;
- static egress on exactly the services §6.5 lists, with the overlay's `staticEgress` addresses.

Memory limits, PITR and the deployment webhook have no read in Phase 0: check them by hand.

```sh
node ops/fin/src/main.ts railway verify staging     # exit 0 no drift, 1 drift
```

## `railway deploy`

```sh
node ops/fin/src/main.ts railway deploy staging --release <sha> --manifest release-manifest.json --dry-run
node ops/fin/src/main.ts railway deploy staging --release <sha> --manifest release-manifest.json --smoke
```

1. Refuses while any service has a public domain or a TCP proxy, or static egress differs from
   §6.5. Fix that by hand first (P-13), then deploy.
2. Verifies every image's attestation with `gh attestation verify` (built by `release.yml` from
   `refs/heads/main` of this repository). Any failure refuses the deploy before a change.
3. Registers the run (the lock), `deploy.started`.
4. When the release manifest lists migrations: runs `migrate` with the new api image
   (`dist/main.js --migrate`) and waits for its `migrate.done` line for this release.
5. Rolls `payments`, `api`, `worker`, `edge`, `verify`, `admin`, `console`: image by digest, start
   command, the plain `FIN_SERVICE`, `FIN_ENVIRONMENT`, `FIN_RELEASE`, `FIN_DRAIN_SECONDS`, `PORT`,
   then a deploy, waiting up to 15 minutes for `SUCCESS` (Railway's health check is `/readyz`).
6. Rolls `cloudflared-admin` and `cloudflared-public` only when their image changed. The standby
   `-b` services and `cloudflared-db` are never rolled here.
7. Checks again that nothing is exposed and that each rolled service reports its new digest; with
   `--smoke`, fetches `/health` on the API host and `/api/health` on the console and verify hosts.
   `deploy.done` and `run.done` record the running digests (which `railway verify` then checks).

Then upload the static builds (`static-deploy.md`): a new page must never meet an old API.

## If a deploy fails

The output names the step (`deploy stopped at <service>; on the new release: ...`) and
`deploy.failed` is written. Services already rolled stay on the new release; the rest keep the
previous one, which the API's N-1 rule keeps working (ARCHITECTURE §6.4). Fix the cause and run the
same command again: every service is set to the release's digest, so a re-run converges. To go
back, deploy the previous release's manifest the same way; `migrate` never runs backwards.

Wake the owner if a service shows a domain or a TCP proxy that nobody added in a registered run
(`railway-exposed.md`), or if an attestation fails for a digest that came from `release.yml`.
