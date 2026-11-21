# Runbook: `pnpm fin railway verify <env>` and `pnpm fin railway deploy <env>`

Railway staging is provisioned once by hand against spec 01 §6's checklist ([P-13]); these two
commands check it and deploy releases to it (spec 01 §6.8, §6.9; ARCHITECTURE §11.8). Both need
`FIN_OVERLAY_FILE` and `FIN_RAILWAY_TOKEN_FILE` (the staging project token, CR-04). `railway deploy`
also needs `gh`, signed in to GitHub with read access to this repository's Actions and attestations.

## `railway verify`

Read-only, registers no run. For every service it reports drift (`!`), and lists what it could not
read (`?`), which never counts as passing:

- every service of `ops/environments/staging.json` exists in the environment; a service the settings
  do not list is drift (`unknown`), and its domains and TCP proxies are checked like any other's;
- no public domain and no TCP proxy on any service (NB-07); no instance in another environment of
  the project (spec 01 §6.1: only the default environment, no PR environments); outside a
  registered run, no `FIN_BOOTSTRAP_DATABASE_URL` and no variable under any name that refers to the
  database template's variables (`${{postgres.…}}`, spec 01 §6.3). Variables are read unrendered,
  so a reference is never rendered into a value that carries the superuser password; only the
  names, and PORT's value, are kept;
- region, replicas, restart policy; app sleeping off; outbound IPv6 off; `PORT=8080`;
- the health check (`/readyz`, 60 s), overlap and draining, start command and cron;
- the image is set by digest from `ghcr.io/aktharazif/`, is the service's own image, and is the
  digest the registered deploys recorded for that service (every deploy records every service it
  rolled or kept, connectors included); and, for every service that serves (not `migrate` or a cron
  job), its newest deployment ended `SUCCESS` (`deployment`) and runs that digest (`digest`): the
  image a service is set to is only what its next deployment takes, so a deploy that crashed or a
  rollback in Railway's dashboard shows here;
- no secret-named variable (spec 01 §6.7) is readable: every one is sealed;
- static egress on exactly the services §6.5 lists, with the overlay's `staticEgress` addresses.

Listed as not checked, every time: memory limits, PITR and the deployment webhook; staged but
undeployed changes; image auto-updates, Railway's CDN and Edge Rules, hard usage limits; shared
variables holding a secret; each service's database login; that the no-token services hold no
`TUNNEL_TOKEN` and that no database template reference is set as a sealed variable (Railway never
returns a sealed variable); Config as Code and a repository source. Check those by hand. Also
listed: any read Railway refused (SP-03, SP-08), naming what it leaves unchecked (a refused
variables read leaves the superuser-reference check unchecked), any field Railway answered with no
value, the digest of a service no registered deploy in this machine's run log recorded, and the
image a newest deployment runs when Railway does not say (SP-03). Only a schema or authorisation
error counts as Railway refusing a read. Any other failure (no answer, a
429 or a 5xx after the retries, or a GraphQL error that is Railway's own) stops the command with
exit 69 instead: run it again.

```sh
node ops/fin/src/main.ts railway verify staging     # exit 0 no drift, 1 drift
```

## `railway deploy`

Download the release manifest first (the artefact `release-<sha>` of the release.yml run for the
commit), then:

```sh
node ops/fin/src/main.ts railway deploy staging --release <sha> --manifest release-manifest.json --dry-run
node ops/fin/src/main.ts railway deploy staging --release <sha> --manifest release-manifest.json --smoke
```

1. Checks that `ci.yml`'s `merge` job succeeded for exactly this commit, on a push to main (spec 07
   §2.3.4). No run, a run still going, no `merge` job, or any conclusion but `success` refuses the
   deploy (exit 77). Until P0-B's `merge` job exists in `ci.yml`, every deploy refuses here.
2. Verifies the release manifest's own attestation with `gh attestation verify`: the certificate
   identity is exactly `https://github.com/AktharAzif/fin-next/.github/workflows/release.yml@refs/heads/main`
   (the owner as GitHub writes it), the source commit is `--release`, the run was a `push`, and no
   self-hosted runner signed it. Only then are its digests trusted. Its minimum schema version is
   printed and recorded with the run and every step.
3. Refuses while any service, listed or not, has a public domain or a TCP proxy; while the project
   has a service the settings do not list or an instance in another environment; while a database
   template reference (under any name, `FIN_BOOTSTRAP_DATABASE_URL` included) stands outside a run;
   or while static egress differs from §6.5. Fix that by hand first (P-13), then deploy. A read
   Railway refuses that one of these checks needs refuses the deploy too: check by hand, then pass
   the matching flag, which the run records:
   - the static egress read: check §6.5 in Railway's dashboard, then `--accept-unchecked-egress`;
   - a variables read: check in the dashboard that no variable on the services named refers to
     `postgres` (§6.3), then `--accept-unchecked-variables`;
   - the instance settings read: check each service's health check (step 5), then
     `--accept-unchecked-settings`.
4. Refuses a partial release: migrations with no `fin-next-api` image, or a service the release
   builds no image for while it runs an earlier release's image (the manifest names every service's
   digest, ARCHITECTURE §11.7, so a rollback to it is whole). A service that has never run an image
   (payments, until its image exists) is kept, and `run.done` lists it under `notBuilt`.
5. Refuses to roll a service whose Railway health check is not the settings' (`/readyz`, 60 s, or
   none for `migrate`): Railway holds `SUCCESS` until `/readyz` passes, and `/readyz` fails below the
   release's minimum schema version, so that health check is what keeps a service from taking
   traffic ahead of its schema. A service the deploy does not roll (the standbys) is only reported
   by `railway verify`.
6. Verifies every image's attestation with the same identity (release.yml, a push to main, no
   self-hosted runner). An image need not be built by this commit: release.yml rebuilds only the
   images that changed, and the manifest bound to this commit (step 2) is what names each digest.
   Any failure refuses the deploy before a change.
7. Registers the run (the lock), `deploy.started`.
8. When the release manifest lists migrations: runs `migrate` with the new api image
   (`dist/main.js --migrate`), with `FIN_BOOTSTRAP_DATABASE_URL` set to the reference
   `${{postgres.DATABASE_URL}}` and `FIN_RUN_ID` for this run only (spec 01 §6.6 step 6; migrate gives
   `fin_owner` a password valid until the run's end and clears it). It reads migrate's log until
   `migrate.done` for this release (up to 15 minutes), and stops on `migrate.failed` or a failed
   deployment. Then it removes the reference, whether migrate passed or failed, and reads migrate's
   variables back: if the reference is still there, nothing rolls (exit 77). A signal (Ctrl-C,
   SIGTERM, a closed terminal) cuts the wait short, and the reference is removed before `run.done`;
   a signal that comes while the write setting the reference is still in flight (slow, or waiting
   out a 429) starts no `migrate`, and the removal waits for that write to settle first.
   If the removal fails, the reference stays, or the run is closed at once before it could (Ctrl-\,
   a later second Ctrl-C, the five-second deadline; the output says so), remove the variable from
   `migrate` by hand at once.
9. Rolls `payments`, `api`, `worker`, `edge`, `verify`, `admin`, `console`: image by digest, start
   command, the plain `FIN_SERVICE`, `FIN_ENVIRONMENT`, `FIN_RELEASE`, `FIN_DRAIN_SECONDS`, `PORT`,
   then a deploy, waiting up to 15 minutes for `SUCCESS` (step 5's health check).
10. Rolls `cloudflared-admin` and `cloudflared-public` unless they run the release's image now: set
    to it, with a newest deployment that ended `SUCCESS` on it. A connector whose newest deployment
    crashed, runs another image, or whose image Railway does not say, rolls. The standby `-b`
    services and `cloudflared-db` are never rolled here.
11. Checks again everything steps 3 and 5 refuse on, and that each service on the release reports
    its digest and (but for `migrate`, which runs to its end) a newest deployment that ended
    `SUCCESS`; with `--smoke`, fetches `/health` on the API host and `/api/health` on the console
    and verify hosts. `deploy.done` is written and `run.done` records the digest of every service on
    the release, kept connectors included, which `railway verify` then checks.

Not done here yet: reading the schema version through `api`'s private health (the operator machine
has no route into Railway's private network; `/readyz` enforces it per service, steps 5 and 9).

Then upload the static builds (`static-deploy.md`): a new page must never meet an old API, so the
upload checks that the services run this release at that moment, and that this deploy is the newest
registered one.

## If a deploy fails

The output names the step (`deploy stopped at <service>; on the new release: ...`) and
`deploy.failed` is written. Services already rolled stay on the new release; the rest keep the
previous one, which the API's N-1 rule keeps working (ARCHITECTURE §6.4). Fix the cause and run the
same command again: every service is set to the release's digest, so a re-run converges. To go
back, deploy the previous release's manifest the same way; `migrate` never runs backwards.

Wake the owner if a service shows a domain or a TCP proxy that nobody added in a registered run
(`railway-exposed.md`), if an attestation fails for a digest that came from `release.yml`, or if
`FIN_BOOTSTRAP_DATABASE_URL` or any other reference to the database template is found on a service
outside a run.
