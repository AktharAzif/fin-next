# Runbook: `pnpm fin static render`, `pnpm fin static deploy` and `tools/static-deploy`

The browser apps are served by assets-only Workers static assets deployments with no script
([FD-17]; spec 01 §7.4). Builds are environment-neutral; the deploy renders each build's `_headers`
and `env.json`, then uploads it through Cloudflare's API with Node built-ins only (BD-16: no
`wrangler`, so no install script), always after the Railway services have rolled (§6.9). Both
commands need `gh`, signed in to GitHub with read access to this repository's attestations.

## 0. Download the release

From the release.yml run for the commit, download, without unpacking:

- the release manifest (artefact `release-<sha>`, unpacked to `release-manifest.json`);
- each static artefact's zip as GitHub keeps it, into one directory, named
  `static-<key>-<sha>.zip` for `verify`, `selfie`, `admin`, `console` and `docs`
  (`gh api repos/AktharAzif/fin-next/actions/artifacts/<id>/zip > <archives>/static-<key>-<sha>.zip`,
  the `<id>` from `gh api repos/AktharAzif/fin-next/actions/runs/<run>/artifacts`). `gh run download`
  unpacks, which loses the bytes the attestation covers, so it is not used for these.

## 1. Render

```sh
node ops/fin/src/main.ts static render staging --release <sha> --manifest release-manifest.json --archives <archives> --out <rendered>
```

Before anything is written (spec 01 §6.9, static steps 1 and 2):

- the release manifest's attestation verifies: release.yml at main of this repository, a `push`, for
  this commit;
- each archive's SHA-256 is the manifest's `static.<key>.sha256`, and its own attestation verifies
  with the same identity, for this commit: release.yml builds every browser app each release and
  carries the previous release's assets in (ARCHITECTURE §11.7, FW-C13), so an artefact another
  commit built is not this release's;
- each archive is unpacked in memory from the verified bytes (plain files only: no link, no unsafe
  path, sizes and CRC-32s as recorded), and its files hash to the manifest's `assetManifestHash`;
- an archive that holds `_headers`, `env.json` or a source map is refused (exit 65);
- the renderer is packages/web-host's (`packages/web-host/src/static/render.ts`, P0-D); until it
  exists the command refuses (exit 78): there is no fallback renderer;
- the rendered files name only this environment's hosts, no public output names Fin Admin's host,
  and `env.json` carries this release and environment.

`<rendered>` must be new or empty; each `<rendered>/<key>/` gets the archive's files and the two
rendered files.

## 2. Upload

On the operator machine (BD-05), inside a registered run, with the operator token
(`FIN_CF_TOKEN_FILE`, CR-05). CR-20 never reaches the operator machine:

```sh
node ops/fin/src/main.ts static deploy staging --release <sha> --manifest release-manifest.json --dir <rendered> --dry-run
node ops/fin/src/main.ts static deploy staging --release <sha> --manifest release-manifest.json --dir <rendered>
```

Before any write, and so in the dry run too:

- `ci.yml`'s `merge` job succeeded for exactly this commit, on a push to main (spec 01 §6.9 step 2;
  release.yml is the pushed commit's own workflow, so the merge job is what says the commit was
  reviewed). Anything else refuses (exit 77);
- this machine's run log records a successful `railway deploy` of this release, so its services have
  rolled and a new page never meets an old API (S0-06). Without one the upload refuses (exit 77). To
  put an earlier release's pages back (a rollback, which takes the pages back before the services,
  spec 01 §6.9) when this machine's log does not record that release's Railway deploy, pass
  `--static-rollback`, which the run records; the merge job is still checked;
- the manifest's attestation verifies; every selected deployment's `apps/<app>/static.json` holds
  only the allowlisted keys; every rendered build hashes to the manifest's `assetManifestHash`;
  every `env.json` carries this release and environment and every `_headers` holds a
  Content-Security-Policy for `/*` and no CORS header; and both files equal, byte for byte, a fresh
  render of this release. Any problem refuses the whole run (exit 65), so no host moves.

The dry run proves the inputs and that CR-05 can read the token permission groups; it does not
prove the deployed state (that is the watcher's `static` check).

Then, in order:

1. `pnpm fin` mints a one-run token with CR-05: `fin-next-staging-static-run`, Workers Scripts Write
   on the staging account only, expiring within 60 minutes;
2. for each deployment, in the order verify, selfie, admin, console, docs: an upload session with
   every file's path, size and hash (only the files Cloudflare lacks are sent, with the session's own
   upload token); one script upload whose only part is `metadata` (`compatibility_date` and
   `assets: {jwt, config: {not_found_handling, html_handling, _headers}}`); `workers.dev` and previews
   off; the re-read (no module, no handler, no binding, assets present, `workers.dev` and previews
   off);
3. the one-run token is revoked when the run ends, whether the uploads passed or failed. If the
   revocation fails, the output says so: revoke `fin-next-staging-static-run` in Cloudflare by hand
   (it expires within the hour anyway).

A failure stops the run; the output says which host serves which release
(`static deploy stopped at <key> (it may serve either release); new release on: ...; previous
release still on: ...`). `deploy.static_step` per deployment and `deploy.static_done` are written as
lines.

From a CI job that holds the static deploy token alone (`staging-static`, CR-20, once it exists):

```sh
node tools/static-deploy/src/main.ts --env staging --release <sha> --manifest release-manifest.json --dir <rendered>
```

It verifies the manifest's attestation and checks every deployment the same way (all but the fresh
render, which `pnpm fin static render` in the same job did) before it reads the token. The merge job
and the Railway roll are not checked there: the job runs only after `deploy-staging` (which checks
the merge job) reached `rolled`, and CR-20 lives only in `staging-static`.

The first upload comes before `pnpm fin routes apply` (the routes need the deployments to exist).

## Check it

- `curl -sI https://<console host>/` shows the rendered headers; a deep link answers the app; one
  `/assets/` file answers `public, max-age=31536000, immutable`.
- The watcher's `static` check stays green (`static-deployment-changed.md`).

## Roll back

Render and upload the previous release's attested artefacts the same way, with the previous
release's manifest and `--release`; the previous release's `/assets/` are carried in every build
(FW-C13), so open tabs keep working. If this machine's run log does not record that release's
`railway deploy`, add `--static-rollback` (recorded in the run). Then take the services back by
deploying the previous release's manifest (`railway-deploy.md`, "If a deploy fails").
